import { describe, expect, it } from "vitest";
import type { GameState, PlayerState } from "../engine/types";
import { canUseInPlaceEffectSelection, visibleEffectSelectionUids } from "./selection";

function player(overrides: Partial<PlayerState> = {}): PlayerState {
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
    ...overrides,
  };
}

function state(p0: Partial<PlayerState>, p1: Partial<PlayerState> = {}): GameState {
  return { players: [player(p0), player(p1)] } as unknown as GameState;
}

describe("effect card in-place selection helpers", () => {
  it("allows candidates that are all in the active player's hand", () => {
    const s = state({ hand: [1, 2, 3] });
    expect(canUseInPlaceEffectSelection(s, 0, [1, 3])).toBe(true);
  });

  it("allows mixed hand and visible board candidates", () => {
    const s = state({ hand: [1], attack: [10], blockSides: [11] }, { receive: [20] });
    expect([...visibleEffectSelectionUids(s, 0)].sort((a, b) => a - b)).toEqual([1, 10, 11, 20]);
    expect(canUseInPlaceEffectSelection(s, 0, [1, 10, 20])).toBe(true);
  });

  it("falls back when a candidate is hidden under a stack", () => {
    const s = state({ receive: [30, 31] });
    expect(canUseInPlaceEffectSelection(s, 0, [30, 31])).toBe(false);
    expect(canUseInPlaceEffectSelection(s, 0, [31])).toBe(true);
  });

  it("falls back for hidden non-board zones", () => {
    const s = state({ hand: [1], drop: [40], eventArea: [41], deck: [42] });
    expect(canUseInPlaceEffectSelection(s, 0, [1, 40])).toBe(false);
    expect(canUseInPlaceEffectSelection(s, 0, [41])).toBe(false);
    expect(canUseInPlaceEffectSelection(s, 0, [42])).toBe(false);
  });
});
