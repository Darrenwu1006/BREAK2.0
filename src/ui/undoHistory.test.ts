import { describe, expect, it } from "vitest";
import type { GameState, PlayerId, PlayerState } from "../engine/types";
import { popUndoSnapshot, pushPlayerUndoSnapshot, pushUndoSnapshot, type UndoHistory } from "./undoHistory";

function player(hand: number[] = []): PlayerState {
  return {
    deck: [],
    hand,
    setArea: [],
    drop: [],
    eventArea: [],
    serve: [],
    blockCenter: [],
    blockSides: [],
    receive: [],
    toss: [],
    attack: [],
  };
}

function state(label: string, pendingPlayer: PlayerId = 0, hand: number[] = []): GameState {
  return {
    phase: "serve",
    pendingDecision: { player: pendingPlayer, type: "free" },
    players: [player(hand), player()],
    log: [{ player: null, text: label, setNo: 1, turnNo: 1 }],
  } as unknown as GameState;
}

describe("undo history helpers", () => {
  it("restores snapshots in LIFO order", () => {
    const s1 = state("first");
    const s2 = state("second");
    let stack = pushUndoSnapshot([], s1);
    stack = pushUndoSnapshot(stack, s2);

    const popped2 = popUndoSnapshot(stack);
    expect(popped2.snapshot?.log.at(-1)?.text).toBe("second");

    const popped1 = popUndoSnapshot(popped2.stack);
    expect(popped1.snapshot?.log.at(-1)?.text).toBe("first");
    expect(popped1.stack).toHaveLength(0);
  });

  it("keeps only the configured maximum number of snapshots", () => {
    let stack: UndoHistory = [];
    for (let i = 0; i < 12; i++) stack = pushUndoSnapshot(stack, state(String(i)), 10);

    expect(stack).toHaveLength(10);
    expect(stack[0]?.log.at(-1)?.text).toBe("2");
    expect(stack[9]?.log.at(-1)?.text).toBe("11");
  });

  it("clones snapshots so later state mutations do not leak into history", () => {
    const original = state("before", 0, [1]);
    const stack = pushUndoSnapshot([], original);
    original.players[0].hand.push(2);

    const { snapshot } = popUndoSnapshot(stack);
    expect(snapshot?.players[0].hand).toEqual([1]);
  });

  it("records only the configured player's decisions", () => {
    let stack = pushPlayerUndoSnapshot([], state("ai", 1), 0);
    expect(stack).toHaveLength(0);

    stack = pushPlayerUndoSnapshot(stack, state("human", 0), 0);
    expect(stack).toHaveLength(1);
    expect(stack[0]?.log.at(-1)?.text).toBe("human");
  });
});
