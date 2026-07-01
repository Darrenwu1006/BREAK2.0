import { describe, expect, it } from "vitest";
import { applyDecision, createGame } from "../engine/engine";
import type { Decision, GameState } from "../engine/types";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import { createMoIsmctsReport, observableProjection } from "./mo-ismcts";

function parsedProjection(decision: Decision, actor: 0 | 1, viewer: 0 | 1, before: GameState): unknown {
  return JSON.parse(observableProjection(decision, { actor, viewer, before }));
}

function hasForbiddenPrivateKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenPrivateKey);
  return Object.entries(value).some(
    ([key, child]) => key === "uid" || key === "uids" || key === "returnUids" || key === "index" || hasForbiddenPrivateKey(child),
  );
}

function baseState(): GameState {
  const deckA = findBenchmarkDeck("烏野-預組");
  const deckB = findBenchmarkDeck("音駒-預組");
  let state = createGame(benchmarkDb, { seed: 310, decks: [deckA.ids, deckB.ids] });
  state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
  return state;
}

function setupServeDecision(): { state: GameState; decks: readonly [readonly string[], readonly string[]] } {
  const deckA = findBenchmarkDeck("烏野-預組");
  const deckB = findBenchmarkDeck("音駒-預組");
  const state = baseState();
  expect(state.pendingDecision).toMatchObject({ player: 0, type: "deploy-serve" });
  return { state, decks: [deckA.ids, deckB.ids] };
}

describe("M8 Phase I I1a observableProjection", () => {
  it("mulligan 對手視角只看換牌張數，不看具體 hand uid", () => {
    const state = baseState();
    const [a, b] = state.players[0].hand;
    if (a === undefined || b === undefined) throw new Error("expected opening hand");

    const first = parsedProjection({ type: "mulligan", returnUids: [a] }, 0, 1, state);
    const second = parsedProjection({ type: "mulligan", returnUids: [b] }, 0, 1, state);
    const self = parsedProjection({ type: "mulligan", returnUids: [a] }, 0, 0, state);

    expect(first).toEqual(second);
    expect(first).toEqual({ type: "mulligan", count: 1 });
    expect(self).toEqual({ type: "mulligan", returnUids: [a] });
  });

  it("公開登場對手視角保留 cardId 但不含 raw uid", () => {
    const state = baseState();
    const uid = state.players[0].hand[0]!;
    const key = parsedProjection({ type: "deploy-attack", uid }, 0, 1, state);

    expect(key).toEqual({ type: "deploy-attack", card: { cardId: state.cards[uid] } });
    expect(hasForbiddenPrivateKey(key)).toBe(false);
  });

  it("攔網公開投影保留 center/side 姿態但不含 raw uid", () => {
    const state = baseState();
    const [center, side] = state.players[0].hand;
    if (center === undefined || side === undefined) throw new Error("expected opening hand");

    const key = parsedProjection({ type: "deploy-block", uids: [center, side], center }, 0, 1, state);

    expect(key).toEqual({
      type: "deploy-block",
      cards: [
        { cardId: state.cards[center], role: "center" },
        { cardId: state.cards[side], role: "side" },
      ],
    });
    expect(hasForbiddenPrivateKey(key)).toBe(false);
  });

  it("effect-cards 對手視角只保留 purpose 與張數，不洩漏私有選擇", () => {
    const state = baseState();
    const secret = state.players[0].hand[0]!;
    state.effectCtx = {
      player: 0,
      source: secret,
      frames: [],
      lastTarget: null,
      triggerUid: null,
      turn1: false,
      anyExecuted: false,
      awaiting: { kind: "cards", purpose: "dropHand", candidates: state.players[0].hand.slice(0, 2), min: 1, max: 1, prompt: "棄 1 張手牌" },
      desc: "測試技能",
    };

    const key = parsedProjection({ type: "effect-cards", uids: [secret] }, 0, 1, state);

    expect(key).toEqual({ type: "effect-cards", purpose: "dropHand", count: 1 });
    expect(JSON.stringify(key)).not.toContain(state.cards[secret]!);
    expect(hasForbiddenPrivateKey(key)).toBe(false);
  });

  it("pick-set-card 對手視角不透露 Set index", () => {
    const state = baseState();
    const key = parsedProjection({ type: "pick-set-card", index: 0 }, 0, 1, state);

    expect(key).toEqual({ type: "pick-set-card", count: 1 });
    expect(hasForbiddenPrivateKey(key)).toBe(false);
  });
});

describe("M8 Phase I I1b MO-ISMCTS core", () => {
  const baseOptions = (seed: number) =>
    ({ perspectivePlayer: 0 as const, seed, iterations: 16, candidateLimit: 6, leafRolloutHorizon: 0 });

  it("輸出 mo-ismcts-coach-v1 報告，bestAction 合法且有候選", () => {
    const { state, decks } = setupServeDecision();
    const report = createMoIsmctsReport(benchmarkDb, state, { ...baseOptions(910), knownDecks: decks });

    expect(report.kind).toBe("mo-ismcts-coach-v1");
    expect(report.perspectivePlayer).toBe(0);
    expect(report.actingPlayer).toBe(0);
    expect(report.pendingType).toBe("deploy-serve");
    expect(report.completedSamples).toBe(16);
    expect(report.recommendations.length).toBeGreaterThan(1);
    expect(report.bestAction.sampleCount).toBeGreaterThan(0);
    expect(report.bestAction.winRate).toBeGreaterThanOrEqual(0);
    expect(report.bestAction.winRate).toBeLessThanOrEqual(1);
    expect(() => applyDecision(benchmarkDb, state, report.bestAction.decision)).not.toThrow();
  });

  it("determinism：同 seed 同 options → recommendations 完全一致", () => {
    const { state, decks } = setupServeDecision();
    const opts = { ...baseOptions(911), knownDecks: decks };
    const first = createMoIsmctsReport(benchmarkDb, state, opts);
    const second = createMoIsmctsReport(benchmarkDb, state, opts);

    expect(second.recommendations).toEqual(first.recommendations);
    expect(second.bestAction).toEqual(first.bestAction);
  });

  it("leakage hard gate：翻轉對手隱藏區 → recommendations 不變", () => {
    const { state, decks } = setupServeDecision();
    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[1].hand.reverse();
    hiddenChanged.players[1].setArea.reverse();
    hiddenChanged.players[1].deck.reverse();
    const opts = { ...baseOptions(912), knownDecks: decks };

    expect(createMoIsmctsReport(benchmarkDb, hiddenChanged, opts).recommendations).toEqual(
      createMoIsmctsReport(benchmarkDb, state, opts).recommendations,
    );
  });
});
