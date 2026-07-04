import { describe, expect, it } from "vitest";
import type { GameState, PlayerId, PlayerState } from "../engine/types";
import { benchmarkDb } from "./benchmark-fixtures";
import {
  opponentRemainingHighAttackExpected,
  ownRemainingHighAttackExpected,
  remainingPoolForPlayer,
  visibleCardIdsForRemaining,
  type KnownDecks,
} from "./remaining-pool";

const HIGH_ATTACK = "HV-D01-006"; // attack 3, block 2
const LOW_ATTACK = "HV-P01-043"; // attack 0, block 1
const EVENT = "HV-D01-011";

function blankPlayer(patch: Partial<PlayerState> = {}): PlayerState {
  return {
    deck: [],
    hand: [],
    setArea: [],
    drop: [],
    eventArea: [],
    serve: [],
    blockCenter: [],
    blockSides: [],
    receive: [],
    toss: [],
    attack: [],
    ...patch,
  };
}

function state(players: [PlayerState, PlayerState], cards: Record<number, string>): GameState {
  return {
    cards,
    players,
    setNo: 1,
    turnNo: 1,
    turnPlayer: 0,
    servingPlayer: 0,
    op: null,
    dp: null,
  } as unknown as GameState;
}

describe("remaining-pool", () => {
  it("subtracts only visible cards from the public deck multiset", () => {
    const s = state(
      [
        blankPlayer(),
        blankPlayer({ hand: [1], deck: [2, 3], setArea: [4], drop: [5] }),
      ],
      {
        1: LOW_ATTACK,
        2: HIGH_ATTACK,
        3: EVENT,
        4: HIGH_ATTACK,
        5: HIGH_ATTACK,
      },
    );
    const knownDecks: KnownDecks = [[], [HIGH_ATTACK, HIGH_ATTACK, LOW_ATTACK, EVENT]];

    expect(visibleCardIdsForRemaining(s, 1 as PlayerId, 0 as PlayerId)).toEqual([HIGH_ATTACK]);
    const pool = remainingPoolForPlayer(benchmarkDb, s, 1 as PlayerId, 0 as PlayerId, knownDecks);

    expect(pool.ids).toEqual([HIGH_ATTACK, LOW_ATTACK, EVENT]);
    expect(opponentRemainingHighAttackExpected(benchmarkDb, s, 0 as PlayerId, knownDecks)).toBeCloseTo(1);
  });

  it("does not change when opponent hand/deck/set hidden contents are flipped", () => {
    const knownDecks: KnownDecks = [[], [HIGH_ATTACK, HIGH_ATTACK, LOW_ATTACK, EVENT]];
    const base = state(
      [
        blankPlayer(),
        blankPlayer({ hand: [1], deck: [2, 3], setArea: [4], drop: [5] }),
      ],
      { 1: LOW_ATTACK, 2: HIGH_ATTACK, 3: EVENT, 4: HIGH_ATTACK, 5: HIGH_ATTACK },
    );
    const flipped = state(
      [
        blankPlayer(),
        blankPlayer({ hand: [4], deck: [3, 2], setArea: [1], drop: [5] }),
      ],
      { 1: LOW_ATTACK, 2: HIGH_ATTACK, 3: EVENT, 4: HIGH_ATTACK, 5: HIGH_ATTACK },
    );

    expect(opponentRemainingHighAttackExpected(benchmarkDb, flipped, 0 as PlayerId, knownDecks)).toBe(
      opponentRemainingHighAttackExpected(benchmarkDb, base, 0 as PlayerId, knownDecks),
    );
  });

  it("counts own hand exactly and own deck from expected remaining pool", () => {
    const knownDecks: KnownDecks = [[HIGH_ATTACK, HIGH_ATTACK, LOW_ATTACK, LOW_ATTACK], []];
    const s = state(
      [
        blankPlayer({ hand: [1], deck: [2, 3], setArea: [4], drop: [5] }),
        blankPlayer(),
      ],
      { 1: HIGH_ATTACK, 2: HIGH_ATTACK, 3: LOW_ATTACK, 4: LOW_ATTACK, 5: LOW_ATTACK },
    );

    expect(ownRemainingHighAttackExpected(benchmarkDb, s, 0 as PlayerId, knownDecks)).toBeCloseTo(2);
  });
});
