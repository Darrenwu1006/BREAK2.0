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
});
