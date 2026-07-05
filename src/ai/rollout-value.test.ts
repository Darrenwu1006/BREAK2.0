import { describe, expect, it } from "vitest";
import type { GameState, PlayerId } from "../engine/types";
import { benchmarkDb } from "./benchmark-fixtures";
import { evaluatePressureScore, evaluateStateValue, explainValue, extractValueFeatures, ROLLOUT_VALUE_MODEL, shapeStateValue, valueLogit, VALUE_FEATURE_DIM, VALUE_FEATURE_NAMES } from "./rollout-value";
import type { KnownDecks } from "./remaining-pool";

// [Claude 2026-06-22] S1a：價值函數只讀公開 scalar，用最小 fixture 聚焦特徵→值映射與公平性。
function fake(patch: {
  s0?: number; s1?: number; h0?: number; h1?: number; d0?: number; d1?: number;
  op?: { value: number; owner: PlayerId } | null;
  dp?: { value: number; owner: PlayerId } | null;
  serving?: PlayerId; turn?: PlayerId;
  // 對手隱藏區「內容」（測 leakage：內容不得影響 V）
  oppHand?: number[]; oppDeck?: number[]; oppSet?: number[];
}): GameState {
  const arr = (n: number | undefined, fill = 0) => new Array(n ?? 0).fill(fill);
  const court = { serve: [], blockCenter: [], blockSides: [], receive: [], toss: [], attack: [], drop: [], eventArea: [] };
  return {
    players: [
      { ...court, setArea: arr(patch.s0), hand: arr(patch.h0), deck: arr(patch.d0) },
      {
        ...court,
        setArea: patch.oppSet ?? arr(patch.s1),
        hand: patch.oppHand ?? arr(patch.h1),
        deck: patch.oppDeck ?? arr(patch.d1),
      },
    ],
    op: patch.op ?? null,
    dp: patch.dp ?? null,
    servingPlayer: patch.serving ?? 0,
    turnPlayer: patch.turn ?? 0,
  } as unknown as GameState;
}

function pointState(attackUid: number, attackCardId: string): GameState {
  const court = { serve: [], blockCenter: [], blockSides: [], receive: [], toss: [], attack: [], drop: [], eventArea: [] };
  return {
    players: [
      { ...court, attack: [attackUid], setArea: [10], hand: [], deck: [] },
      { ...court, setArea: [20], hand: [], deck: [] },
    ],
    cards: { [attackUid]: attackCardId },
    modifiers: [],
    op: null,
    dp: null,
    servingPlayer: 0,
    turnPlayer: 0,
  } as unknown as GameState;
}

function k1LeakageState(hidden: { hand: string[]; deck: string[]; setArea: string[] }): { state: GameState; knownDecks: KnownDecks } {
  const court = { serve: [], blockCenter: [], blockSides: [], receive: [], toss: [], attack: [], drop: [], eventArea: [] };
  const cards: Record<number, string> = {
    1: "HV-D01-006", // own high attack hand
    2: "HV-D01-011", // own event hand
    3: "HV-P01-043", // own public drop
    10: hidden.hand[0]!,
    11: hidden.hand[1]!,
    12: hidden.deck[0]!,
    13: hidden.deck[1]!,
    14: hidden.setArea[0]!,
    15: "HV-D01-006", // opponent public drop
  };
  return {
    knownDecks: [
      ["HV-D01-006", "HV-D01-011", "HV-P01-043", "HV-D01-006", "HV-P01-043"],
      ["HV-D01-006", "HV-D01-006", "HV-P01-043", "HV-D01-011", "HV-P03-020", "HV-P01-043"],
    ],
    state: {
      players: [
        { ...court, hand: [1, 2], deck: [20, 21], setArea: [22], drop: [3], attack: [1] },
        { ...court, hand: [10, 11], deck: [12, 13], setArea: [14], drop: [15] },
      ],
      cards,
      modifiers: [],
      setNo: 3,
      op: { value: 5, owner: 0 as PlayerId, source: "attack" },
      dp: { value: 3, owner: 1 as PlayerId, source: "receive" },
      servingPlayer: 0,
      turnPlayer: 0,
    } as unknown as GameState,
  };
}

describe("rollout-value 價值函數", () => {
  it("特徵向量長度固定", () => {
    expect(extractValueFeatures(fake({ s0: 2, s1: 2 }), 0)).toHaveLength(VALUE_FEATURE_DIM);
  });

  it("live model 使用 Phase K selected v1 29 維係數與 default-on provenance", () => {
    expect(ROLLOUT_VALUE_MODEL.weights).toHaveLength(VALUE_FEATURE_DIM);
    expect(ROLLOUT_VALUE_MODEL.provenance).toContain("Phase K default-on selected v1");
    expect(ROLLOUT_VALUE_MODEL.provenance).toContain("strength 91/160=56.9%");
    expect(ROLLOUT_VALUE_MODEL.provenance).toContain("M2-free 0/7");
    expect(ROLLOUT_VALUE_MODEL.provenance).toContain("rootPressureTieBreakDelta=0.04");
    expect(ROLLOUT_VALUE_MODEL.provenance).toContain("rootConservationWinRateThreshold=0.85");
  });

  it("V 永遠落在 [0,1]", () => {
    for (const p of [{ s0: 2, s1: 0 }, { s0: 0, s1: 2 }, { s0: 1, s1: 1, op: { value: 7, owner: 0 as PlayerId } }]) {
      const v = evaluateStateValue(fake(p), 0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("Set 殘量越領先，V 越高（主項單調）", () => {
    const behind = evaluateStateValue(fake({ s0: 0, s1: 2 }), 0);
    const even = evaluateStateValue(fake({ s0: 1, s1: 1 }), 0);
    const ahead = evaluateStateValue(fake({ s0: 2, s1: 0 }), 0);
    expect(even).toBeGreaterThan(behind);
    expect(ahead).toBeGreaterThan(even);
    expect(ROLLOUT_VALUE_MODEL.weights[0]).toBeGreaterThan(0); // setLifeDiff 權重為正
  });

  it("雙視角互補：同盤面 V(me) 與 V(opp) 一升一降", () => {
    const s = fake({ s0: 2, s1: 0 });
    expect(evaluateStateValue(s, 0)).toBeGreaterThan(evaluateStateValue(s, 1));
  });

  it("不洩漏對手隱藏資訊：翻轉對手手牌/牌庫/Set 內容，V 不變", () => {
    const base = fake({ s0: 1, s1: 2, h0: 5, h1: 4, d0: 30, d1: 28, oppHand: [9, 8, 7, 6], oppDeck: [1, 2, 3], oppSet: [11, 12] });
    const flipped = fake({ s0: 1, s1: 2, h0: 5, h1: 4, d0: 30, d1: 28, oppHand: [6, 7, 8, 9], oppDeck: [3, 2, 1], oppSet: [12, 11] });
    expect(evaluateStateValue(flipped, 0)).toBe(evaluateStateValue(base, 0));
  });

  it("Phase H 點數特徵會看見攻擊區有效攻擊點數", () => {
    const attackPoint = VALUE_FEATURE_NAMES.indexOf("attackPointDiff");
    const attackLine = VALUE_FEATURE_NAMES.indexOf("attackLinePointDiff");
    const low = extractValueFeatures(pointState(1, "HV-P01-043"), 0, benchmarkDb);
    const high = extractValueFeatures(pointState(2, "HV-D01-006"), 0, benchmarkDb);
    expect(high[attackPoint]).toBeGreaterThan(low[attackPoint]!);
    expect(high[attackLine]).toBeGreaterThan(low[attackLine]!);
  });

  it("Phase H 壓制力分數不讀對手隱藏內容", () => {
    const base = fake({ s0: 1, s1: 1, h0: 5, h1: 4, d0: 24, d1: 25, op: { value: 5, owner: 0 as PlayerId }, oppHand: [9, 8, 7, 6], oppDeck: [1, 2, 3], oppSet: [11, 12] });
    const flipped = fake({ s0: 1, s1: 1, h0: 5, h1: 4, d0: 24, d1: 25, op: { value: 5, owner: 0 as PlayerId }, oppHand: [6, 7, 8, 9], oppDeck: [3, 2, 1], oppSet: [12, 11] });
    expect(evaluatePressureScore(benchmarkDb, flipped, 0)).toBe(evaluatePressureScore(benchmarkDb, base, 0));
  });

  it("Phase K K1 新特徵逐一不讀對手 hidden hand/deck/set 內容", () => {
    const base = k1LeakageState({
      hand: ["HV-P01-043", "HV-D01-011"],
      deck: ["HV-D01-006", "HV-P03-020"],
      setArea: ["HV-P01-043"],
    });
    const flipped = k1LeakageState({
      hand: ["HV-D01-006", "HV-P03-020"],
      deck: ["HV-P01-043", "HV-D01-011"],
      setArea: ["HV-P01-043"],
    });
    const baseFeatures = extractValueFeatures(base.state, 0 as PlayerId, benchmarkDb, { knownDecks: base.knownDecks });
    const flippedFeatures = extractValueFeatures(flipped.state, 0 as PlayerId, benchmarkDb, { knownDecks: flipped.knownDecks });

    for (let index = 15; index < VALUE_FEATURE_NAMES.length; index++) {
      expect(flippedFeatures[index], VALUE_FEATURE_NAMES[index]).toBe(baseFeatures[index]);
    }
  });

  it("explainValue 的貢獻總和與 evaluateStateValue 數學一致", () => {
    const { state, knownDecks } = k1LeakageState({
      hand: ["HV-P01-043", "HV-D01-011"],
      deck: ["HV-D01-006", "HV-P03-020"],
      setArea: ["HV-P01-043"],
    });
    const explanation = explainValue(state, 0 as PlayerId, ROLLOUT_VALUE_MODEL, benchmarkDb, knownDecks);
    const contributionSum = explanation.terms.reduce((sum, term) => sum + term.contribution, explanation.bias);
    expect(explanation.terms).toHaveLength(VALUE_FEATURE_DIM);
    expect(contributionSum).toBeCloseTo(explanation.logit, 12);
    expect(explanation.logit).toBeCloseTo(valueLogit(state, 0 as PlayerId, ROLLOUT_VALUE_MODEL, benchmarkDb, knownDecks), 12);
    expect(explanation.probability).toBeCloseTo(evaluateStateValue(state, 0 as PlayerId, ROLLOUT_VALUE_MODEL, benchmarkDb, knownDecks), 12);
    for (let i = 1; i < explanation.terms.length; i++) {
      expect(Math.abs(explanation.terms[i - 1]!.contribution)).toBeGreaterThanOrEqual(Math.abs(explanation.terms[i]!.contribution));
    }
  });

  it("Phase H shaping 不翻轉明確勝率差", () => {
    const epsilon = 0.05;
    const higherWinLowPressure = shapeStateValue(0.96, -0.1, epsilon);
    const lowerWinHighPressure = shapeStateValue(0.95, 0.1, epsilon);
    expect(higherWinLowPressure).toBeGreaterThanOrEqual(lowerWinHighPressure);
  });
});
