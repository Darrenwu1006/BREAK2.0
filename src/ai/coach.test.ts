import { describe, expect, it } from "vitest";
import { applyDecision, createGame } from "../engine/engine";
import type { GameState } from "../engine/types";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import { createPimcCoachReport } from "./coach";

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

describe("M8 Phase A PIMC coach", () => {
  it("會針對合法行動輸出 winRate、confidence、principalLine 與 explanation", () => {
    const { state, decks } = setupServeDecision();
    const report = createPimcCoachReport(benchmarkDb, state, {
      perspectivePlayer: 0,
      knownDecks: decks,
      seed: 810,
      sampleCount: 2,
      candidateLimit: 4,
      rolloutMaxSteps: 2000,
    });

    expect(report.kind).toBe("pimc-coach-v1");
    expect(report.pendingType).toBe("deploy-serve");
    expect(report.recommendations.length).toBeGreaterThan(1);
    expect(report.bestAction.winRate).toBeGreaterThanOrEqual(0);
    expect(report.bestAction.winRate).toBeLessThanOrEqual(1);
    expect(report.bestAction.confidence).toBeGreaterThanOrEqual(0);
    expect(report.bestAction.confidence).toBeLessThanOrEqual(1);
    expect(report.bestAction.sampleCount).toBeGreaterThan(0);
    expect(report.bestAction.explanation.length).toBeGreaterThan(10);
    expect(report.bestAction.principalLine.length).toBeGreaterThan(0);
  });

  it("同 seed 的結果可重現", () => {
    const { state, decks } = setupServeDecision();
    const options = {
      perspectivePlayer: 0,
      knownDecks: decks,
      seed: 811,
      sampleCount: 2,
      candidateLimit: 4,
      rolloutMaxSteps: 2000,
    } as const;

    const first = createPimcCoachReport(benchmarkDb, state, options);
    const second = createPimcCoachReport(benchmarkDb, state, options);

    expect(second.recommendations).toEqual(first.recommendations);
    expect(second.bestAction).toEqual(first.bestAction);
  });

  it("不會因對手真實隱藏手牌、Set、牌庫順序改變而改變建議", () => {
    const { state, decks } = setupServeDecision();
    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[1].hand.reverse();
    hiddenChanged.players[1].setArea.reverse();
    hiddenChanged.players[1].deck.reverse();

    const options = {
      perspectivePlayer: 0,
      knownDecks: decks,
      seed: 812,
      sampleCount: 2,
      candidateLimit: 4,
      rolloutMaxSteps: 2000,
    } as const;

    expect(createPimcCoachReport(benchmarkDb, hiddenChanged, options).recommendations).toEqual(
      createPimcCoachReport(benchmarkDb, state, options).recommendations,
    );
  });

  it("timeout 時仍回傳 heuristic fallback 與候選建議外殼", () => {
    const { state, decks } = setupServeDecision();
    const report = createPimcCoachReport(benchmarkDb, state, {
      perspectivePlayer: 0,
      knownDecks: decks,
      seed: 813,
      sampleCount: 8,
      candidateLimit: 4,
      rolloutMaxSteps: 2000,
      timeLimitMs: 0,
    });

    expect(report.timedOut).toBe(true);
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.bestAction.decision).toEqual(report.fallbackDecision);
    expect(report.bestAction.sampleCount).toBe(0);
  });

  it("會在命中的牌組上附加 gameplan 主軸評估", () => {
    const deckA = findBenchmarkDeck("稲荷崎-稲荷崎_堆墓改角名");
    const deckB = findBenchmarkDeck("音駒-音駒-二口干擾");
    let state = createGame(benchmarkDb, { seed: 1919, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });

    const report = createPimcCoachReport(benchmarkDb, state, {
      perspectivePlayer: 0,
      knownDecks: [deckA.ids, deckB.ids],
      gameplanDeckLabels: [deckA.name, deckB.name],
      seed: 1920,
      sampleCount: 1,
      candidateLimit: 3,
      rolloutMaxSteps: 400,
    });

    expect(report.gameplan?.profileId).toBe("inarizaki-dump-suna-v1");
    expect(report.bestAction.gameplan?.profileId).toBe("inarizaki-dump-suna-v1");
    expect(report.recommendations.some((item) => item.gameplan)).toBe(true);
  });
});

// [Claude 2026-06-22] Phase F 第二槓桿 S2：Sequential Halving 樣本配置。
describe("M8 Phase F S2 Sequential Halving 配置", () => {
  const baseOptions = (seed: number) =>
    ({ perspectivePlayer: 0, seed, sampleCount: 4, candidateLimit: 8, rolloutMaxSteps: 2000 }) as const;

  it("不傳 allocation 等同 uniform（重構不改現況行為）", () => {
    const { state, decks } = setupServeDecision();
    const omitted = createPimcCoachReport(benchmarkDb, state, { ...baseOptions(900), knownDecks: decks });
    const explicit = createPimcCoachReport(benchmarkDb, state, { ...baseOptions(900), knownDecks: decks, allocation: "uniform" });
    expect(explicit.recommendations).toEqual(omitted.recommendations);
  });

  it("sequential-halving 同 seed 可重現", () => {
    const { state, decks } = setupServeDecision();
    const opts = { ...baseOptions(901), knownDecks: decks, allocation: "sequential-halving" } as const;
    const first = createPimcCoachReport(benchmarkDb, state, opts);
    const second = createPimcCoachReport(benchmarkDb, state, opts);
    expect(second.recommendations).toEqual(first.recommendations);
    expect(second.bestAction).toEqual(first.bestAction);
  });

  it("sequential-halving 不洩漏對手隱藏資訊（leakage 不退化）", () => {
    const { state, decks } = setupServeDecision();
    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[1].hand.reverse();
    hiddenChanged.players[1].setArea.reverse();
    hiddenChanged.players[1].deck.reverse();
    const opts = { ...baseOptions(902), knownDecks: decks, allocation: "sequential-halving" } as const;
    expect(createPimcCoachReport(benchmarkDb, hiddenChanged, opts).recommendations).toEqual(
      createPimcCoachReport(benchmarkDb, state, opts).recommendations,
    );
  });

  it("把同等總預算集中到競爭候選：總抽樣數守恆、且分配非均勻", () => {
    const { state, decks } = setupServeDecision();
    const report = createPimcCoachReport(benchmarkDb, state, {
      ...baseOptions(903),
      knownDecks: decks,
      allocation: "sequential-halving",
    });
    expect(report.recommendations.length).toBeGreaterThan(1);
    const n = report.recommendations.length;
    const totals = report.recommendations.map((r) => r.sampleCount + r.maxSteps + r.errors);
    const sum = totals.reduce((a, b) => a + b, 0);
    // 總預算＝sampleCount × 候選數，與 uniform 相同（殘額灑回最終存活者後剛好填滿）。
    expect(sum).toBe(4 * n);
    // 非均勻：存活到最後的候選拿到的樣本，比早被淘汰者多。
    expect(Math.max(...totals)).toBeGreaterThan(Math.min(...totals));
    // bestAction 仍為合法決策。
    expect(() => applyDecision(benchmarkDb, state, report.bestAction.decision)).not.toThrow();
    // 關鍵：bestAction＝SH 收斂到的高樣本 arm，不可是低樣本幸運候選（守住 raw-argmax bug 回歸）。
    const bestTotal = report.bestAction.sampleCount + report.bestAction.maxSteps + report.bestAction.errors;
    expect(bestTotal).toBe(Math.max(...totals));
  });
});

// [Claude 2026-06-22] Phase F 第二槓桿 S1：rollout 終局 EV cut。
describe("M8 Phase F S1 EV cut（valueCutHorizon）", () => {
  const baseOptions = (seed: number) =>
    ({ perspectivePlayer: 0, seed, sampleCount: 3, candidateLimit: 5, rolloutMaxSteps: 2000 }) as const;

  it("不傳 valueCutHorizon 等同現況（rollout 打到終局）", () => {
    const { state, decks } = setupServeDecision();
    const omitted = createPimcCoachReport(benchmarkDb, state, { ...baseOptions(950), knownDecks: decks });
    // 顯式給超大 horizon（> rolloutMaxSteps）也等同關閉。
    const huge = createPimcCoachReport(benchmarkDb, state, { ...baseOptions(950), knownDecks: decks, valueCutHorizon: 99999 });
    expect(huge.recommendations).toEqual(omitted.recommendations);
  });

  it("EV cut 開啟時：winRate∈[0,1]、樣本有效累計、bestAction 合法、同 seed 可重現", () => {
    const { state, decks } = setupServeDecision();
    const opts = { ...baseOptions(951), knownDecks: decks, valueCutHorizon: 12 } as const;
    const report = createPimcCoachReport(benchmarkDb, state, opts);
    expect(report.bestAction.winRate).toBeGreaterThanOrEqual(0);
    expect(report.bestAction.winRate).toBeLessThanOrEqual(1);
    expect(report.bestAction.sampleCount).toBeGreaterThan(0); // value-cut 也算有效樣本
    expect(() => applyDecision(benchmarkDb, state, report.bestAction.decision)).not.toThrow();
    expect(createPimcCoachReport(benchmarkDb, state, opts).recommendations).toEqual(report.recommendations);
  });

  it("EV cut 不洩漏對手隱藏資訊（leakage 不退化）", () => {
    const { state, decks } = setupServeDecision();
    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[1].hand.reverse();
    hiddenChanged.players[1].setArea.reverse();
    hiddenChanged.players[1].deck.reverse();
    const opts = { ...baseOptions(952), knownDecks: decks, valueCutHorizon: 12 } as const;
    expect(createPimcCoachReport(benchmarkDb, hiddenChanged, opts).recommendations).toEqual(
      createPimcCoachReport(benchmarkDb, state, opts).recommendations,
    );
  });
});
