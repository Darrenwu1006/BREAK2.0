import type { DeckMeta } from "./gameTypes";
import type { Decision, GameEvent, GameState, LogEntry, Phase, PlayerId } from "../engine/types";

export type ReplayDecisionSource = "player" | "ai";

export interface ReplayDeckSnapshot {
  label: string;
  cardIds: string[];
}

export interface ReplayEntry {
  index: number;
  player: PlayerId;
  source: ReplayDecisionSource;
  phase: Phase;
  setNo: number;
  turnNo: number;
  pendingType: Decision["type"];
  decision: Decision;
  before: GameState;
  after: GameState;
  logStart: number;
  logEnd: number;
}

export interface ReplaySession {
  startedAt: string;
  seed: number;
  decks: [ReplayDeckSnapshot, ReplayDeckSnapshot];
  initialState: GameState;
  entries: ReplayEntry[];
}

export interface ReplayAnalytics {
  totalDecisions: number;
  playerDecisions: number;
  aiDecisions: number;
  setWins: [number, number];
  payGuts: [number, number];
  opSources: Record<"serve" | "block" | "attack", number>;
  matchWinner: PlayerId | null;
}

export function createReplaySession(
  initialState: GameState,
  decks: [string[], string[]],
  deckMeta: [DeckMeta, DeckMeta],
  startedAt = new Date().toISOString(),
  seed = initialState.rngState,
): ReplaySession {
  return {
    startedAt,
    seed,
    decks: [
      { label: `${deckMeta[0].school}-${deckMeta[0].name}`, cardIds: [...decks[0]] },
      { label: `${deckMeta[1].school}-${deckMeta[1].name}`, cardIds: [...decks[1]] },
    ],
    initialState: structuredClone(initialState) as GameState,
    entries: [],
  };
}

export function appendReplayEntry(
  session: ReplaySession,
  before: GameState,
  decision: Decision,
  after: GameState,
  source: ReplayDecisionSource,
): ReplaySession {
  const pending = before.pendingDecision;
  if (!pending) return session;
  return {
    ...session,
    entries: [
      ...session.entries,
      {
        index: session.entries.length,
        player: pending.player,
        source,
        phase: before.phase,
        setNo: before.setNo,
        turnNo: before.turnNo,
        pendingType: pending.type,
        decision: structuredClone(decision) as Decision,
        before: structuredClone(before) as GameState,
        after: structuredClone(after) as GameState,
        logStart: before.log.length,
        logEnd: after.log.length,
      },
    ],
  };
}

export function truncateReplaySession(session: ReplaySession, entryCount: number): ReplaySession {
  if (entryCount >= session.entries.length) return session;
  return { ...session, entries: session.entries.slice(0, Math.max(0, entryCount)) };
}

export function stateAtReplayStep(session: ReplaySession, stepIndex: number): GameState {
  if (stepIndex <= 0) return structuredClone(session.initialState) as GameState;
  const entry = session.entries[Math.min(stepIndex, session.entries.length) - 1];
  return structuredClone(entry?.after ?? session.initialState) as GameState;
}

export function replayEntryLogs(entry: ReplayEntry): LogEntry[] {
  return entry.after.log.slice(entry.logStart, entry.logEnd);
}

function eventFromEntry(entry: ReplayEntry, predicate: (event: GameEvent) => boolean): GameEvent | null {
  for (const log of replayEntryLogs(entry)) {
    if (log.event && predicate(log.event)) return log.event;
  }
  return null;
}

export function isKeyReplayEntry(entry: ReplayEntry): boolean {
  if (entry.source === "player") return true;
  return eventFromEntry(entry, (event) => event.kind === "set-won" || event.kind === "match-won") !== null;
}

export function keyReplayEntries(session: ReplaySession): ReplayEntry[] {
  return session.entries.filter(isKeyReplayEntry);
}

export function summarizeReplaySession(session: ReplaySession): ReplayAnalytics {
  const analytics: ReplayAnalytics = {
    totalDecisions: session.entries.length,
    playerDecisions: 0,
    aiDecisions: 0,
    setWins: [0, 0],
    payGuts: [0, 0],
    opSources: { serve: 0, block: 0, attack: 0 },
    matchWinner: null,
  };
  for (const entry of session.entries) {
    if (entry.source === "ai") analytics.aiDecisions++;
    else analytics.playerDecisions++;
    for (const log of replayEntryLogs(entry)) {
      const event = log.event;
      if (!event) continue;
      if (event.kind === "set-won") analytics.setWins[event.winner]++;
      else if (event.kind === "match-won") analytics.matchWinner = event.winner;
      else if (event.kind === "pay-guts") analytics.payGuts[event.player] += event.count;
      else if (event.kind === "op-calc") analytics.opSources[event.source]++;
      else if (event.kind === "attack-op") analytics.opSources.attack++;
    }
  }
  return analytics;
}
