import { describe, expect, it } from "vitest";
import type { GameState, PlayerId } from "../engine/types";
import { benchmarkDb } from "./benchmark-fixtures";
import { evaluatePressureScore, evaluateStateValue, extractValueFeatures, ROLLOUT_VALUE_MODEL, shapeStateValue, VALUE_FEATURE_DIM } from "./rollout-value";

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

describe("rollout-value 價值函數", () => {
  it("特徵向量長度固定", () => {
    expect(extractValueFeatures(fake({ s0: 2, s1: 2 }), 0)).toHaveLength(VALUE_FEATURE_DIM);
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

  it("Phase H 壓制力分數不讀對手隱藏內容", () => {
    const base = fake({ s0: 1, s1: 1, h0: 5, h1: 4, d0: 24, d1: 25, op: { value: 5, owner: 0 as PlayerId }, oppHand: [9, 8, 7, 6], oppDeck: [1, 2, 3], oppSet: [11, 12] });
    const flipped = fake({ s0: 1, s1: 1, h0: 5, h1: 4, d0: 24, d1: 25, op: { value: 5, owner: 0 as PlayerId }, oppHand: [6, 7, 8, 9], oppDeck: [3, 2, 1], oppSet: [12, 11] });
    expect(evaluatePressureScore(benchmarkDb, flipped, 0)).toBe(evaluatePressureScore(benchmarkDb, base, 0));
  });

  it("Phase H shaping 不翻轉明確勝率差", () => {
    const epsilon = 0.05;
    const higherWinLowPressure = shapeStateValue(0.96, -0.1, epsilon);
    const lowerWinHighPressure = shapeStateValue(0.95, 0.1, epsilon);
    expect(higherWinLowPressure).toBeGreaterThanOrEqual(lowerWinHighPressure);
  });
});
