import { describe, expect, it } from "vitest";
import type { Decision, GameState, PlayerId, PlayerState } from "../engine/types";
import { appendReplayEntry, createReplaySession, keyReplayEntries, stateAtReplayStep, summarizeReplaySession, truncateReplaySession } from "./replayHistory";
import type { DeckMeta } from "./gameTypes";

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

function state(label: string, pendingPlayer: PlayerId = 0, turnNo = 1): GameState {
  return {
    rngState: 123,
    phase: "serve",
    setNo: 1,
    turnNo,
    pendingDecision: { player: pendingPlayer, type: "free" },
    players: [player([1]), player([2])],
    log: [{ player: null, text: label, setNo: 1, turnNo }],
  } as unknown as GameState;
}

function withLog(base: GameState, label: string, log: GameState["log"][number]): GameState {
  return {
    ...base,
    log: [
      ...base.log,
      { ...log, text: label },
    ],
  } as GameState;
}

const deckMeta: [DeckMeta, DeckMeta] = [
  { school: "烏野", name: "測試", total: 40, implementedCount: 40, unimplementedCount: 0 },
  { school: "音駒", name: "測試", total: 40, implementedCount: 40, unimplementedCount: 0 },
];

const decks: [string[], string[]] = [
  ["HV-D01-001"],
  ["HV-D02-001"],
];

describe("replay history helpers", () => {
  it("creates a replay session with initial seed and deck labels", () => {
    const initial = state("initial");
    const session = createReplaySession(initial, decks, deckMeta, "2026-06-19T00:00:00.000Z");

    expect(session.seed).toBe(123);
    expect(session.startedAt).toBe("2026-06-19T00:00:00.000Z");
    expect(session.decks[0].label).toBe("烏野-測試");
    expect(session.initialState.log[0]?.text).toBe("initial");
  });

  it("appends cloned before and after states for a decision", () => {
    const before = state("before", 0, 2);
    const after = state("after", 1, 3);
    const decision: Decision = { type: "free", action: "pass" };
    const session = appendReplayEntry(createReplaySession(before, decks, deckMeta), before, decision, after, "player");

    before.log[0]!.text = "mutated";
    after.log[0]!.text = "mutated";

    expect(session.entries).toHaveLength(1);
    expect(session.entries[0]?.index).toBe(0);
    expect(session.entries[0]?.source).toBe("player");
    expect(session.entries[0]?.player).toBe(0);
    expect(session.entries[0]?.pendingType).toBe("free");
    expect(session.entries[0]?.before.log[0]?.text).toBe("before");
    expect(session.entries[0]?.after.log[0]?.text).toBe("after");
  });

  it("truncates entries when undo rewinds a decision", () => {
    const initial = state("initial");
    const decision: Decision = { type: "free", action: "pass" };
    const one = appendReplayEntry(createReplaySession(initial, decks, deckMeta), initial, decision, state("one"), "player");
    const two = appendReplayEntry(one, state("one"), decision, state("two"), "ai");

    const truncated = truncateReplaySession(two, 1);

    expect(truncated.entries).toHaveLength(1);
    expect(truncated.entries[0]?.after.log[0]?.text).toBe("one");
  });

  it("returns initial state or the state after a requested replay step", () => {
    const initial = state("initial");
    const decision: Decision = { type: "free", action: "pass" };
    const session = appendReplayEntry(createReplaySession(initial, decks, deckMeta), initial, decision, state("after"), "player");

    expect(stateAtReplayStep(session, 0).log[0]?.text).toBe("initial");
    expect(stateAtReplayStep(session, 1).log[0]?.text).toBe("after");
  });

  it("summarizes replay decisions and game events", () => {
    const initial = state("initial");
    const pass: Decision = { type: "free", action: "pass" };
    const humanAfter = withLog(state("after-human"), "OP 算出", {
      player: 0,
      setNo: 1,
      turnNo: 1,
      text: "OP 算出",
      event: { kind: "op-calc", player: 0, source: "serve", value: 3 },
    });
    const aiAfter = withLog(state("after-ai"), "支付 Guts", {
      player: 1,
      setNo: 1,
      turnNo: 1,
      text: "支付 Guts",
      event: { kind: "pay-guts", player: 1, count: 2, sources: { receive: 2 } },
    });
    const setAfter = withLog(state("after-set"), "宣告 Lost", {
      player: 0,
      setNo: 1,
      turnNo: 1,
      text: "宣告 Lost",
      event: { kind: "set-won", winner: 1, loser: 0, setNo: 1, loserSetRemaining: 1 },
    });

    const one = appendReplayEntry(createReplaySession(initial, decks, deckMeta), initial, pass, humanAfter, "player");
    const two = appendReplayEntry(one, state("ai-before", 1), pass, aiAfter, "ai");
    const three = appendReplayEntry(two, state("set-before", 1), pass, setAfter, "ai");
    const summary = summarizeReplaySession(three);

    expect(summary.totalDecisions).toBe(3);
    expect(summary.playerDecisions).toBe(1);
    expect(summary.aiDecisions).toBe(2);
    expect(summary.opSources.serve).toBe(1);
    expect(summary.payGuts[1]).toBe(2);
    expect(summary.setWins[1]).toBe(1);
    expect(keyReplayEntries(three).map((entry) => entry.index)).toEqual([0, 2]);
  });
});
