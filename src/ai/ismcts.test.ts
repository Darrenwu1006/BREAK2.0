import { describe, expect, it } from "vitest";
import { applyDecision, createGame, deployableUids, effParam } from "../engine/engine";
import type { GameState } from "../engine/types";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import { createIsmctsReport, rootDecisionPressureScore, ucbScore } from "./ismcts";

// [Claude 2026-06-23] Phase G G1：SO-ISMCTS 核心四測（leakage hard gate／determinism／合法性／availability-UCB）。
// 鏡像 coach.test.ts 的 leakage 模式；以固定 iterations（非 timeLimitMs）保證 determinism。

function setupServeDecision(): { state: GameState; decks: readonly [readonly string[], readonly string[]] } {
  const deckA = findBenchmarkDeck("烏野-預組");
  const deckB = findBenchmarkDeck("音駒-預組");
  let state = createGame(benchmarkDb, { seed: 710, decks: [deckA.ids, deckB.ids] });
  state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
  expect(state.pendingDecision).toMatchObject({ player: 0, type: "deploy-serve" });
  return { state, decks: [deckA.ids, deckB.ids] };
}

const baseOptions = (seed: number) =>
  ({ perspectivePlayer: 0 as const, seed, iterations: 120, candidateLimit: 6 });

describe("M8 Phase G SO-ISMCTS", () => {
  it("輸出 ismcts-coach-v1 報告，bestAction 合法、winRate/confidence∈[0,1]、有候選", () => {
    const { state, decks } = setupServeDecision();
    const report = createIsmctsReport(benchmarkDb, state, { ...baseOptions(810), knownDecks: decks });

    expect(report.kind).toBe("ismcts-coach-v1");
    expect(report.perspectivePlayer).toBe(0);
    expect(report.actingPlayer).toBe(0);
    expect(report.pendingType).toBe("deploy-serve");
    expect(report.recommendations.length).toBeGreaterThan(1);
    expect(report.bestAction.winRate).toBeGreaterThanOrEqual(0);
    expect(report.bestAction.winRate).toBeLessThanOrEqual(1);
    expect(report.bestAction.confidence).toBeGreaterThanOrEqual(0);
    expect(report.bestAction.confidence).toBeLessThanOrEqual(1);
    expect(report.bestAction.sampleCount).toBeGreaterThan(0);
    // 合法性 + root 我方視角約束：bestAction 對真實盤面可套用、不 throw。
    expect(() => applyDecision(benchmarkDb, state, report.bestAction.decision)).not.toThrow();
  });

  it("determinism：同 seed 同 options → recommendations 完全一致", () => {
    const { state, decks } = setupServeDecision();
    const opts = { ...baseOptions(811), knownDecks: decks };
    const first = createIsmctsReport(benchmarkDb, state, opts);
    const second = createIsmctsReport(benchmarkDb, state, opts);
    expect(second.recommendations).toEqual(first.recommendations);
    expect(second.bestAction).toEqual(first.bestAction);
  });

  it("leakage hard gate：翻轉對手隱藏區（hand/setArea/deck）→ recommendations 不變", () => {
    const { state, decks } = setupServeDecision();
    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[1].hand.reverse();
    hiddenChanged.players[1].setArea.reverse();
    hiddenChanged.players[1].deck.reverse();
    const opts = { ...baseOptions(812), knownDecks: decks };
    expect(createIsmctsReport(benchmarkDb, hiddenChanged, opts).recommendations).toEqual(
      createIsmctsReport(benchmarkDb, state, opts).recommendations,
    );
  });

  it("Phase H pressure shaping 開啟時仍維持 determinism 與 leakage hard gate", () => {
    const { state, decks } = setupServeDecision();
    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[1].hand.reverse();
    hiddenChanged.players[1].setArea.reverse();
    hiddenChanged.players[1].deck.reverse();
    const opts = { ...baseOptions(813), knownDecks: decks, pressureShapingEpsilon: 0.05 };
    const first = createIsmctsReport(benchmarkDb, state, opts);
    const second = createIsmctsReport(benchmarkDb, state, opts);
    expect(second.recommendations).toEqual(first.recommendations);
    expect(createIsmctsReport(benchmarkDb, hiddenChanged, opts).recommendations).toEqual(first.recommendations);
  });

  it("Phase H root tie-break score 會偏好更高攻擊點的登場", () => {
    const deckA = findBenchmarkDeck("青葉城西-第三彈測試");
    const deckB = findBenchmarkDeck("青葉城西-第三彈測試");
    let state = createGame(benchmarkDb, { seed: 814, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state.turnPlayer = 0;
    state.phase = "attack";
    state.pendingDecision = { player: 0, type: "deploy-attack" };
    const options = deployableUids(benchmarkDb, state, 0, "attack")
      .map((uid) => ({ uid, value: effParam(benchmarkDb, state, uid, "attack") ?? 0 }))
      .sort((a, b) => a.value - b.value);
    const low = options[0]!;
    const high = options[options.length - 1]!;
    expect(high.value - low.value).toBeGreaterThanOrEqual(2);

    expect(rootDecisionPressureScore(benchmarkDb, state, { type: "deploy-attack", uid: high.uid }, 0)).toBeGreaterThan(
      rootDecisionPressureScore(benchmarkDb, state, { type: "deploy-attack", uid: low.uid }, 0),
    );
  });

  it("Phase H root pair tie-break 會把拖球與後續攻擊一起看", () => {
    const deckA = findBenchmarkDeck("青葉城西-第三彈測試");
    const deckB = findBenchmarkDeck("青葉城西-第三彈測試");
    let state = createGame(benchmarkDb, { seed: 815, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state.turnPlayer = 0;
    state.phase = "attack";
    state.pendingDecision = { player: 0, type: "deploy-toss" };

    const setterUid = state.players[0].hand[0]!;
    const dualThreatUid = state.players[0].hand[1]!;
    state.players[0].hand = [setterUid, dualThreatUid];
    state.cards[setterUid] = "HV-P01-033"; // 及川 徹：拖球 1 / 攻擊 0
    state.cards[dualThreatUid] = "HV-P02-018"; // 宮 侑：拖球 2 / 攻擊 3

    const betterDecision = { type: "deploy-toss", uid: setterUid } as const;
    const worseDecision = { type: "deploy-toss", uid: dualThreatUid } as const;
    const betterPair = (effParam(benchmarkDb, state, setterUid, "toss") ?? 0) + (effParam(benchmarkDb, state, dualThreatUid, "attack") ?? 0);
    const worsePair = (effParam(benchmarkDb, state, dualThreatUid, "toss") ?? 0) + (effParam(benchmarkDb, state, setterUid, "attack") ?? 0);

    const nonPairDelta =
      rootDecisionPressureScore(benchmarkDb, state, betterDecision, 0) -
      rootDecisionPressureScore(benchmarkDb, state, worseDecision, 0);
    const pairDelta =
      rootDecisionPressureScore(benchmarkDb, state, betterDecision, 0, { pairAware: true }) -
      rootDecisionPressureScore(benchmarkDb, state, worseDecision, 0, { pairAware: true });

    expect(effParam(benchmarkDb, state, setterUid, "toss") ?? 0).toBeLessThan(effParam(benchmarkDb, state, dualThreatUid, "toss") ?? 0);
    expect(betterPair).toBeGreaterThanOrEqual(worsePair + 2);
    expect(pairDelta).toBeGreaterThan(nonPairDelta);
  });

  it("availability-UCB：探索項分子用 availability，非 node.visits（防實作回歸到錯分母）", () => {
    // child：visits=4、mean=.5；availability=9（該 action 只在部分 world 合法 → availability < 假想 node.visits）。
    const c = Math.SQRT2;
    const expected = 0.5 + c * Math.sqrt(Math.log(9) / 4);
    expect(ucbScore(4, 2, 9, true, c)).toBeCloseTo(expected, 12);
    // 若誤用較大的 node.visits（例如 25）當分子，分數會不同 → 守住「分子＝availability」。
    const wrongWithNodeVisits = 0.5 + c * Math.sqrt(Math.log(25) / 4);
    expect(ucbScore(4, 2, 9, true, c)).not.toBeCloseTo(wrongWithNodeVisits, 6);
    // 對手節點 exploit 取 (1 − mean)＝樹內對抗。
    expect(ucbScore(4, 2, 9, false, c)).toBeCloseTo(1 - 0.5 + c * Math.sqrt(Math.log(9) / 4), 12);
  });
});
