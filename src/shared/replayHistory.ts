import type { DeckMeta } from "./deckMeta";
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

/**
 * Set 結束時由玩家記下的「當下意圖」。這些值是待賽後驗證的主觀假說，
 * 不等同於系統對決策正確性的判定。
 */
export type ReplaySetFeedbackTag =
  | "push-for-set"
  | "save-for-next-set"
  | "build-resources"
  | "test-line"
  | "gamble-key-piece"
  | "suspected-mistake"
  | "forced-line"
  | "review-request";

export type ReplaySetFeedbackChoice = ReplaySetFeedbackTag | "skipped";

export interface ReplaySetFeedback {
  setNo: number;
  /** 產生 set-won／match-won 的 replay entry；Undo 截斷 future 時據此同步移除。 */
  anchorEntryIndex: number;
  choice: ReplaySetFeedbackChoice;
  note?: string;
}

export interface ReplaySetResult {
  setNo: number;
  anchorEntryIndex: number;
  winner: PlayerId;
  loser: PlayerId;
  kind: "set" | "match";
}

export interface ReplaySession {
  startedAt: string;
  seed: number;
  decks: [ReplayDeckSnapshot, ReplayDeckSnapshot];
  initialState: GameState;
  entries: ReplayEntry[];
  /** 可選欄位以維持舊 Replay 向後相容；新對局固定初始化為空陣列。 */
  setFeedback?: ReplaySetFeedback[];
  /** 單人練習曾回退並另走新分支；戰報可據此辨識非原始線性對局。 */
  rewound?: boolean;
  rewindCount?: number;
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
    setFeedback: [],
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
  const safeCount = Math.max(0, entryCount);
  return {
    ...session,
    entries: session.entries.slice(0, safeCount),
    ...(session.setFeedback
      ? { setFeedback: session.setFeedback.filter((feedback) => feedback.anchorEntryIndex < safeCount) }
      : {}),
  };
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

export function replaySetResults(session: ReplaySession): ReplaySetResult[] {
  const results: ReplaySetResult[] = [];
  for (const entry of session.entries) {
    const event = eventFromEntry(entry, (candidate) => candidate.kind === "set-won" || candidate.kind === "match-won");
    if (!event || (event.kind !== "set-won" && event.kind !== "match-won")) continue;
    results.push({
      setNo: event.setNo,
      anchorEntryIndex: entry.index,
      winner: event.winner,
      loser: event.loser,
      kind: event.kind === "match-won" ? "match" : "set",
    });
  }
  return results;
}

/** 回傳最早一個尚未回答／略過的 Set，確保不會跨過漏填的 Set。 */
export function pendingReplaySetFeedback(session: ReplaySession): ReplaySetResult | null {
  const answered = new Set((session.setFeedback ?? []).map((feedback) => feedback.anchorEntryIndex));
  return replaySetResults(session).find((result) => !answered.has(result.anchorEntryIndex)) ?? null;
}

/**
 * 原始 Set 回饋一旦寫入便不覆寫；賽後補充會使用未來的獨立欄位，
 * 避免把當下意圖與事後理解混在一起。
 */
export function appendReplaySetFeedback(
  session: ReplaySession,
  input: ReplaySetFeedback,
): ReplaySession {
  const targetExists = replaySetResults(session).some(
    (result) => result.setNo === input.setNo && result.anchorEntryIndex === input.anchorEntryIndex,
  );
  if (!targetExists) return session;
  if ((session.setFeedback ?? []).some((feedback) => feedback.anchorEntryIndex === input.anchorEntryIndex)) return session;
  const note = input.note?.trim();
  return {
    ...session,
    setFeedback: [
      ...(session.setFeedback ?? []),
      {
        setNo: input.setNo,
        anchorEntryIndex: input.anchorEntryIndex,
        choice: input.choice,
        ...(input.choice !== "skipped" && note ? { note } : {}),
      },
    ],
  };
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
        else if (event.kind === "match-won") {
          analytics.matchWinner = event.winner;
          // 致勝 Set 只發 match-won、不發 set-won；補計入勝方 Set 數，避免比數漏算（例：3:2 顯示成 2:2）
          analytics.setWins[event.winner]++;
        }
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
