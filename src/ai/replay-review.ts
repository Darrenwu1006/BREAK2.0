import type { CardDb, GameState, PlayerId } from "../engine/types";
import { replayEntryLogs, summarizeReplaySession, type ReplayAnalytics, type ReplayEntry, type ReplaySession } from "../ui/replayHistory";
import {
  evaluateGameplanState,
  evaluateGameplanTransition,
  resolveGameplanProfile,
  type GameplanObjectiveResult,
  type GameplanStateReport,
  type GameplanTone,
} from "./gameplan";

export interface ReplaySetReview {
  setNo: number;
  winner: PlayerId | null;
  lastTurnNo: number;
  lastEntryIndex: number;
  deckCount: number;
  handCount: number;
  dropCount: number;
  gameplanStage?: string;
  gameplanProgressScore?: number;
  objectives?: ReplayObjectiveSnapshot[];
}

export interface ReplayObjectiveSnapshot {
  id: string;
  label: string;
  value: number;
  threshold: number;
  complete: boolean;
}

export interface ReplayGameplanCheckpoint {
  entryIndex: number;
  setNo: number;
  turnNo: number;
  phase: ReplayEntry["phase"];
  source: ReplayEntry["source"];
  actingPlayer: PlayerId;
  pendingType: ReplayEntry["pendingType"];
  tone: GameplanTone;
  delta: number;
  beforeScore: number;
  afterScore: number;
  stage: string;
  badges: string[];
  risks: string[];
  objectiveChanges: ReplayObjectiveChange[];
  logLines: string[];
}

export interface ReplayObjectiveChange {
  id: string;
  label: string;
  before: number;
  after: number;
  threshold: number;
}

export interface ReplayGameplanReview {
  profileId: string;
  displayName: string;
  final: GameplanStateReport;
  checkpoints: ReplayGameplanCheckpoint[];
}

export interface ReplayReviewReport {
  startedAt: string;
  seed: number;
  deckLabels: [string, string];
  player: PlayerId;
  analytics: ReplayAnalytics;
  setReviews: ReplaySetReview[];
  gameplan?: ReplayGameplanReview;
}

export interface ReplayReviewOptions {
  player?: PlayerId;
  includeNeutralObjectiveChanges?: boolean;
}

function objectiveSnapshot(objective: GameplanObjectiveResult): ReplayObjectiveSnapshot {
  return {
    id: objective.id,
    label: objective.label,
    value: objective.value,
    threshold: objective.threshold,
    complete: objective.complete,
  };
}

function objectiveChanges(before: GameplanStateReport, after: GameplanStateReport): ReplayObjectiveChange[] {
  const changes: ReplayObjectiveChange[] = [];
  for (const next of after.objectives) {
    const prev = before.objectives.find((item) => item.id === next.id);
    if (!prev || prev.value === next.value) continue;
    changes.push({
      id: next.id,
      label: next.label,
      before: prev.value,
      after: next.value,
      threshold: next.threshold,
    });
  }
  return changes;
}

function setWinnerFromLogs(entries: readonly ReplayEntry[], setNo: number): PlayerId | null {
  for (const entry of entries) {
    for (const log of replayEntryLogs(entry)) {
      if (log.event?.kind === "set-won" && log.event.setNo === setNo) return log.event.winner;
      if (log.event?.kind === "match-won" && log.event.setNo === setNo) return log.event.winner;
    }
  }
  return null;
}

function maxSetNo(session: ReplaySession): number {
  return session.entries.reduce((max, entry) => Math.max(max, entry.setNo), session.initialState.setNo);
}

function finalStateForSet(session: ReplaySession, setNo: number): { state: GameState; entry: ReplayEntry | null } {
  const entries = session.entries.filter((entry) => entry.setNo === setNo);
  const entry = entries.at(-1) ?? null;
  return { state: entry?.after ?? session.initialState, entry };
}

function shouldKeepCheckpoint(
  transition: ReturnType<typeof evaluateGameplanTransition>,
  changes: readonly ReplayObjectiveChange[],
  before: GameplanStateReport,
  includeNeutralObjectiveChanges: boolean,
): boolean {
  const newRisks = transition.risks.filter((risk) => !before.risks.includes(risk));
  const meaningfulChanges = changes.filter((change) => change.before < change.threshold || change.after < change.threshold);
  const unlockBadge = transition.badges.some((badge) => badge.includes("達成") || badge.includes("回收循環"));
  if (transition.tone === "risk" || transition.tone === "drift") return true;
  if (transition.delta !== 0 || unlockBadge || newRisks.length > 0) return true;
  if (transition.tone === "progress" && meaningfulChanges.length > 0) return true;
  return includeNeutralObjectiveChanges && meaningfulChanges.length > 0;
}

export function createReplayReviewReport(db: CardDb, session: ReplaySession, options: ReplayReviewOptions = {}): ReplayReviewReport {
  const player = options.player ?? 0;
  const analytics = summarizeReplaySession(session);
  const deckLabels: [string, string] = [session.decks[0].label, session.decks[1].label];
  const profile = resolveGameplanProfile(session.decks[player].label, session.decks[player].cardIds);
  const finalState = session.entries.at(-1)?.after ?? session.initialState;
  const finalGameplan = profile ? evaluateGameplanState(db, finalState, player, profile) : undefined;

  const setReviews: ReplaySetReview[] = [];
  for (let setNo = 1; setNo <= maxSetNo(session); setNo++) {
    const { state, entry } = finalStateForSet(session, setNo);
    const gameplan = profile ? evaluateGameplanState(db, state, player, profile) : undefined;
    setReviews.push({
      setNo,
      winner: setWinnerFromLogs(session.entries, setNo),
      lastTurnNo: entry?.turnNo ?? state.turnNo,
      lastEntryIndex: entry?.index ?? -1,
      deckCount: state.players[player].deck.length,
      handCount: state.players[player].hand.length,
      dropCount: state.players[player].drop.length,
      gameplanStage: gameplan?.stage,
      gameplanProgressScore: gameplan?.progressScore,
      objectives: gameplan?.objectives.map(objectiveSnapshot),
    });
  }

  const checkpoints: ReplayGameplanCheckpoint[] = [];
  if (profile) {
    for (const entry of session.entries) {
      const before = evaluateGameplanState(db, entry.before, player, profile);
      const transition = evaluateGameplanTransition(db, entry.before, entry.after, player, profile);
      const changes = objectiveChanges(before, transition);
      if (!shouldKeepCheckpoint(transition, changes, before, options.includeNeutralObjectiveChanges ?? true)) continue;
      checkpoints.push({
        entryIndex: entry.index,
        setNo: entry.setNo,
        turnNo: entry.turnNo,
        phase: entry.phase,
        source: entry.source,
        actingPlayer: entry.player,
        pendingType: entry.pendingType,
        tone: transition.tone,
        delta: transition.delta,
        beforeScore: before.progressScore,
        afterScore: transition.progressScore,
        stage: transition.stage,
        badges: transition.badges,
        risks: transition.risks.filter((risk) => !before.risks.includes(risk)),
        objectiveChanges: changes,
        logLines: replayEntryLogs(entry).map((log) => log.text),
      });
    }
  }

  return {
    startedAt: session.startedAt,
    seed: session.seed,
    deckLabels,
    player,
    analytics,
    setReviews,
    gameplan:
      profile && finalGameplan
        ? {
            profileId: profile.id,
            displayName: profile.displayName,
            final: finalGameplan,
            checkpoints,
          }
        : undefined,
  };
}
