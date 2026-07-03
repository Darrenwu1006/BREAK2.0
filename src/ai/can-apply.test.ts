import { describe, expect, it } from "vitest";
import { applyDecision, createGame } from "../engine/engine";
import type { Decision, GameState } from "../engine/types";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import { canApplyDecision, enumerateCandidates } from "./coach";
import { heuristicAiDecision } from "./heuristic";

const PAIRS = [
  ["烏野-預組", "音駒-預組", 901],
  ["梟谷-高爆發軸", "白鳥沢-最強白鳥沢", 902],
  ["伊達工業-攔網軸改", "青葉城西-二彈改", 903],
  ["稲荷崎-六名軸", "梟谷-高爆發軸", 904],
] as const;

function collectStates(maxSteps = 110): GameState[] {
  const states: GameState[] = [];
  for (const [deckAName, deckBName, seed] of PAIRS) {
    const deckA = findBenchmarkDeck(deckAName);
    const deckB = findBenchmarkDeck(deckBName);
    let state = createGame(benchmarkDb, { seed, decks: [deckA.ids, deckB.ids] });
    for (let step = 0; step < maxSteps && state.phase !== "gameOver"; step++) {
      if (state.pendingDecision) states.push(structuredClone(state) as GameState);
      if (!state.pendingDecision) break;
      state = applyDecision(benchmarkDb, state, heuristicAiDecision(benchmarkDb, state, "heuristic-v2"));
    }
  }
  return states;
}

function candidateSamples(state: GameState): Decision[] {
  const pending = state.pendingDecision;
  if (!pending) return [];
  const p = pending.player;
  const fallback = heuristicAiDecision(benchmarkDb, state, "heuristic-v2");
  const samples: Decision[] = [fallback, ...enumerateCandidates(benchmarkDb, state, 12, fallback)];

  switch (pending.type) {
    case "serve-rights":
      samples.push({ type: "serve-rights", take: true }, { type: "serve-rights", take: false });
      break;
    case "mulligan": {
      const first = state.players[p].hand[0];
      samples.push({ type: "mulligan", returnUids: [] });
      if (first !== undefined) samples.push({ type: "mulligan", returnUids: [first] }, { type: "mulligan", returnUids: [first, first] });
      samples.push({ type: "mulligan", returnUids: [-900001] });
      break;
    }
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack": {
      const type = pending.type;
      const first = state.players[p].hand[0];
      samples.push({ type, uid: null } as Decision, { type, uid: -900002 } as Decision);
      if (first !== undefined) samples.push({ type, uid: first, nameChoice: "__invalid_name__" } as Decision);
      break;
    }
    case "deploy-block": {
      const first = state.players[p].hand[0];
      samples.push({ type: "deploy-block", uids: null });
      if (first !== undefined) {
        samples.push(
          { type: "deploy-block", uids: [first], center: first },
          { type: "deploy-block", uids: [first], center: -900003 },
          { type: "deploy-block", uids: [first, first], center: first },
        );
      }
      break;
    }
    case "defense-choice":
      samples.push({ type: "defense-choice", choice: "receive" }, { type: "defense-choice", choice: "block" });
      break;
    case "free":
      samples.push({ type: "free", action: "pass" }, { type: "free", action: "lost" }, { type: "free", action: "event", uid: -900004 }, { type: "free", action: "skill", uid: -900005, skillIndex: 0 });
      break;
    case "resolve-pending":
      for (const id of pending.candidates ?? []) samples.push({ type: "resolve-pending", id });
      samples.push({ type: "resolve-pending", id: -900006 });
      break;
    case "effect-confirm":
      samples.push({ type: "effect-confirm", accept: true }, { type: "effect-confirm", accept: false });
      break;
    case "effect-cards": {
      const c = pending.candidates ?? [];
      samples.push({ type: "effect-cards", uids: [] }, { type: "effect-cards", uids: [-900007] });
      if (c[0] !== undefined) samples.push({ type: "effect-cards", uids: [c[0]] }, { type: "effect-cards", uids: [c[0], c[0]] });
      break;
    }
    case "effect-option":
      samples.push({ type: "effect-option", index: 0 }, { type: "effect-option", index: -1 }, { type: "effect-option", index: pending.options?.length ?? 0 });
      break;
    case "pick-set-card":
      samples.push({ type: "pick-set-card", index: 0 }, { type: "pick-set-card", index: -1 }, { type: "pick-set-card", index: state.players[p].setArea.length });
      break;
  }

  samples.push({ type: "free", action: "pass" });
  return samples;
}

function applyAccepts(state: GameState, decision: Decision): boolean {
  try {
    applyDecision(benchmarkDb, state, decision, { execMode: "search" });
    return true;
  } catch {
    return false;
  }
}

describe("Phase J J3 canApplyDecision", () => {
  it("matches applyDecision throw behavior across fuzzed real-game states", () => {
    const states = collectStates();
    expect(states.length).toBeGreaterThan(150);

    let comparisons = 0;
    const pendingTypes = new Set<string>();
    for (const state of states) {
      pendingTypes.add(state.pendingDecision!.type);
      for (const decision of candidateSamples(state)) {
        const expected = applyAccepts(state, decision);
        expect(canApplyDecision(benchmarkDb, state, decision), `${state.pendingDecision!.type} ${JSON.stringify(decision)}`).toBe(expected);
        comparisons++;
      }
    }

    expect(comparisons).toBeGreaterThan(500);
    expect(pendingTypes.size).toBeGreaterThan(5);
  });
});
