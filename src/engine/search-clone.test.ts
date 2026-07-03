import { describe, expect, it } from "vitest";
import { benchmarkDb, findBenchmarkDeck } from "../ai/benchmark-fixtures";
import { determinizeHiddenState, inferKnownDecks } from "../ai/coach";
import { heuristicAiDecision } from "../ai/heuristic";
import { applyDecision, createGame } from "./engine";
import { cloneStateForSearch } from "./search-clone";
import type { GameState, PlayerId, PlayerState } from "./types";

type PlayerZone = keyof PlayerState;

const PLAYER_ZONES: readonly PlayerZone[] = [
  "deck",
  "hand",
  "setArea",
  "drop",
  "eventArea",
  "serve",
  "blockCenter",
  "blockSides",
  "receive",
  "toss",
  "attack",
];

const FUZZ_PAIRS = [
  ["烏野-預組", "音駒-預組", 801],
  ["梟谷-高爆發軸", "白鳥沢-最強白鳥沢", 802],
  ["伊達工業-攔網軸改", "青葉城西-二彈改", 803],
] as const;

function collectFuzzStates(maxSteps = 80): GameState[] {
  const states: GameState[] = [];
  for (const [deckAName, deckBName, seed] of FUZZ_PAIRS) {
    const deckA = findBenchmarkDeck(deckAName);
    const deckB = findBenchmarkDeck(deckBName);
    let state = createGame(benchmarkDb, { seed, decks: [deckA.ids, deckB.ids] });
    for (let step = 0; step < maxSteps && state.phase !== "gameOver"; step++) {
      states.push(structuredClone(state) as GameState);
      if (!state.pendingDecision) break;
      state = applyDecision(benchmarkDb, state, heuristicAiDecision(benchmarkDb, state, "heuristic-v2"));
    }
  }
  return states;
}

function expectedSearchClone(state: GameState): GameState {
  return structuredClone({ ...state, log: [] }) as GameState;
}

function stableJson(state: GameState): string {
  return JSON.stringify(state);
}

function mutateDeepState(state: GameState, seed: number): void {
  const player = (seed % 2) as PlayerId;
  const zone = PLAYER_ZONES[seed % PLAYER_ZONES.length]!;
  const uid = -100000 - seed;

  state.players[player][zone].push(uid);
  state.cards[uid] = `J2-MUTATION-${seed}`;
  state.nameOverrides[uid] = `mutation-${seed}`;
  state.modifiers.push({ target: uid, param: "attack", amount: (seed % 5) + 1, source: uid });
  state.blockDeployedThisTurn[player] += 1;
  state.blockHandDeploysThisTurn[player] += 1;
  if (state.op) state.op.value += 1;
  else state.op = { value: 1, owner: player, source: "attack" };
  if (state.pendingDecision) {
    state.pendingDecision = { ...state.pendingDecision, prompt: `${state.pendingDecision.prompt ?? ""} mutation-${seed}` };
  }
  state.log.push({ setNo: state.setNo, turnNo: state.turnNo, player, text: `mutation-${seed}` });
}

describe("Phase J J2 search clone fuzz", () => {
  it("keeps cloneStateForSearch structurally equivalent to no-log structuredClone", () => {
    const states = collectFuzzStates();
    expect(states.length).toBeGreaterThan(100);

    states.forEach((state, index) => {
      const clone = cloneStateForSearch(state);
      const expected = expectedSearchClone(state);

      expect(clone, `state ${index}`).toEqual(expected);
      expect(Object.keys(clone).sort(), `state ${index} keys`).toEqual(Object.keys(state).sort());
      expect(clone.log, `state ${index} search log`).toHaveLength(0);
      expect(clone.players[0].hand, `state ${index} p0 hand ref`).not.toBe(state.players[0].hand);
      expect(clone.players[1].deck, `state ${index} p1 deck ref`).not.toBe(state.players[1].deck);
    });
  });

  it("isolates nested mutations between source and search clone", () => {
    const states = collectFuzzStates(60);
    expect(states.length).toBeGreaterThan(80);

    states.forEach((state, index) => {
      const source = structuredClone(state) as GameState;
      const clone = cloneStateForSearch(source);
      const sourceBefore = stableJson(source);

      mutateDeepState(clone, index);
      const cloneAfterMutation = stableJson(clone);
      expect(stableJson(source), `clone mutation leaked into source at state ${index}`).toBe(sourceBefore);

      mutateDeepState(source, index + 1000);
      expect(stableJson(clone), `source mutation leaked into clone at state ${index}`).toBe(cloneAfterMutation);
    });
  });

  it("determinizeHiddenState drops old log history without mutating the source state", () => {
    const states = collectFuzzStates().filter((state) => state.log.length > 20 && state.pendingDecision);
    expect(states.length).toBeGreaterThan(20);

    states.slice(0, 30).forEach((state, index) => {
      const before = stableJson(state);
      const knownDecks = inferKnownDecks(state);
      const determinized = determinizeHiddenState(state, state.pendingDecision!.player as PlayerId, knownDecks, 9000 + index);

      expect(stableJson(state), `determinize mutated source at state ${index}`).toBe(before);
      expect(determinized.log, `determinize old log at state ${index}`).toHaveLength(0);
      determinized.log.push({ setNo: determinized.setNo, turnNo: determinized.turnNo, player: null, text: "determinize mutation" });
      expect(state.log.length, `determinize log alias at state ${index}`).toBeGreaterThan(20);
      expect(state.log.some((entry) => entry.text === "determinize mutation"), `determinize log leaked at state ${index}`).toBe(false);
    });
  });
});
