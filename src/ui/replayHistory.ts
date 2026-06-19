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

export type ReplayGutsSource = "serve" | "receive" | "toss" | "attack" | "blockCenter";

export interface ReplayPointStats {
  count: number;
  total: number;
  average: number;
  max: number;
  highCount: number;
}

export interface ReplayAnalytics {
  totalDecisions: number;
  playerDecisions: number;
  aiDecisions: number;
  setWins: [number, number];
  payGuts: [number, number];
  payGutsBySource: [Record<ReplayGutsSource, number>, Record<ReplayGutsSource, number>];
  op: [ReplayPointStats, ReplayPointStats];
  dp: [ReplayPointStats, ReplayPointStats];
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

function blankPointStats(): ReplayPointStats {
  return { count: 0, total: 0, average: 0, max: 0, highCount: 0 };
}

function blankGutsSourceStats(): Record<ReplayGutsSource, number> {
  return { serve: 0, receive: 0, toss: 0, attack: 0, blockCenter: 0 };
}

function addPoint(stats: ReplayPointStats, value: number): void {
  stats.count++;
  stats.total += value;
  stats.average = stats.total / stats.count;
  stats.max = Math.max(stats.max, value);
  if (value >= 6) stats.highCount++;
}

function pointValue(text: string, label: "OP" | "DP"): number | null {
  const match = text.match(new RegExp(`${label} 算出\\s*[=＝]\\s*(-?\\d+)`));
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function summarizeReplaySession(session: ReplaySession): ReplayAnalytics {
  const analytics: ReplayAnalytics = {
    totalDecisions: session.entries.length,
    playerDecisions: 0,
    aiDecisions: 0,
    setWins: [0, 0],
    payGuts: [0, 0],
    payGutsBySource: [blankGutsSourceStats(), blankGutsSourceStats()],
    op: [blankPointStats(), blankPointStats()],
    dp: [blankPointStats(), blankPointStats()],
    opSources: { serve: 0, block: 0, attack: 0 },
    matchWinner: null,
  };
  for (const entry of session.entries) {
    if (entry.source === "ai") analytics.aiDecisions++;
    else analytics.playerDecisions++;
    for (const log of replayEntryLogs(entry)) {
      const event = log.event;
      if (event) {
        if (event.kind === "set-won") analytics.setWins[event.winner]++;
        else if (event.kind === "match-won") analytics.matchWinner = event.winner;
        else if (event.kind === "pay-guts") {
          analytics.payGuts[event.player] += event.count;
          for (const [source, count] of Object.entries(event.sources) as [ReplayGutsSource, number][]) {
            analytics.payGutsBySource[event.player][source] += count;
          }
        } else if (event.kind === "op-calc") {
          analytics.opSources[event.source]++;
          addPoint(analytics.op[event.player], event.value);
        } else if (event.kind === "attack-op") {
          analytics.opSources.attack++;
          addPoint(analytics.op[event.player], event.value);
        }
      }
      const dp = pointValue(log.text, "DP");
      if (dp !== null && log.player !== null) addPoint(analytics.dp[log.player], dp);
    }
  }
  return analytics;
}
