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

export type LostSetCause = "no-deploy" | "judge-fail" | "voluntary" | "unknown";

/** 玩家失去一個 Set（含敗北）的歸因：哪一步、什麼原因、當下 OP/DP。 */
export interface LostSetAttribution {
  setNo: number;
  entryIndex: number;
  turnNo: number;
  phase: ReplayEntry["phase"];
  matchPoint: boolean;
  cause: LostSetCause;
  detail: string;
  opAtLoss?: number;
  dpAtLoss?: number;
}

export interface LostSetSummary {
  total: number;
  byCause: Record<LostSetCause, number>;
  attributions: LostSetAttribution[];
}

export interface ReplayReviewReport {
  startedAt: string;
  seed: number;
  deckLabels: [string, string];
  player: PlayerId;
  analytics: ReplayAnalytics;
  setReviews: ReplaySetReview[];
  lostSets: LostSetSummary;
  gameplan?: ReplayGameplanReview;
}

const LOST_SET_CAUSE_LABEL: Record<LostSetCause, string> = {
  "no-deploy": "未能登場",
  "judge-fail": "判定失敗",
  voluntary: "主動放棄",
  unknown: "原因不明",
};

export function lostSetCauseLabel(cause: LostSetCause): string {
  return LOST_SET_CAUSE_LABEL[cause];
}

/** 從失球該 entry 的 log 文字判讀失 Set 原因；judge 行可解析出 OP/DP。 */
function classifyLostSet(logTexts: readonly string[]): { cause: LostSetCause; detail: string; opAtLoss?: number; dpAtLoss?: number } {
  let judge: { op: number; dp: number } | undefined;
  let hasNoDeploy = false;
  let hasVoluntary = false;
  for (const text of logTexts) {
    if (text.includes("未登場角色")) hasNoDeploy = true;
    if (text.includes("主動宣告 Lost")) hasVoluntary = true;
    const m = /判定：DP\s*(\d+)\s*vs\s*OP\s*(\d+)\s*→\s*失敗/.exec(text);
    if (m) judge = { dp: Number(m[1]), op: Number(m[2]) }; // 取最後一次失敗判定
  }
  if (hasNoDeploy) return { cause: "no-deploy", detail: "未能登場角色，被迫宣告 Lost（該區無法防守）" };
  if (judge) return { cause: "judge-fail", detail: `判定失敗：DP ${judge.dp} 擋不住 OP ${judge.op}`, opAtLoss: judge.op, dpAtLoss: judge.dp };
  if (hasVoluntary) return { cause: "voluntary", detail: "主動宣告 Lost（放棄此球）" };
  return { cause: "unknown", detail: "失球原因無法從紀錄判讀" };
}

function buildLostSetSummary(session: ReplaySession, player: PlayerId): LostSetSummary {
  const byCause: Record<LostSetCause, number> = { "no-deploy": 0, "judge-fail": 0, voluntary: 0, unknown: 0 };
  const attributions: LostSetAttribution[] = [];
  for (const entry of session.entries) {
    const logs = replayEntryLogs(entry);
    const lossEvent = logs.find(
      (log) => (log.event?.kind === "set-won" || log.event?.kind === "match-won") && log.event.loser === player,
    )?.event;
    if (!lossEvent || (lossEvent.kind !== "set-won" && lossEvent.kind !== "match-won")) continue;
    const classification = classifyLostSet(logs.map((log) => log.text));
    byCause[classification.cause]++;
    attributions.push({
      setNo: lossEvent.setNo,
      entryIndex: entry.index,
      turnNo: entry.turnNo,
      phase: entry.phase,
      matchPoint: lossEvent.kind === "match-won",
      cause: classification.cause,
      detail: classification.detail,
      opAtLoss: classification.opAtLoss,
      dpAtLoss: classification.dpAtLoss,
    });
  }
  return { total: attributions.length, byCause, attributions };
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
    lostSets: buildLostSetSummary(session, player),
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
