import { applyDecision, blockDeployMax, canChooseBlock, deployableUids, freeOptions } from "../engine/engine";
import { autoPickCards } from "../engine/effects";
import type { CardDb, Decision, GameState, PlayerId, PlayerState } from "../engine/types";
import type { CourtArea } from "../engine/dsl";
import { heuristicAiDecision } from "./heuristic";
import type { HeuristicV2ProfileId } from "./heuristic";
import { seededRnd } from "./benchmark";
import { pickDeployName } from "./util";
import { evaluateGameplanState, evaluateGameplanTransition, resolveGameplanProfile, type GameplanStateReport, type GameplanTransitionReport } from "./gameplan";

type ZoneName = keyof PlayerState;
type DeployArea = "serve" | "receive" | "toss" | "attack";

export interface PimcCoachOptions {
  perspectivePlayer?: PlayerId;
  knownDecks?: readonly [readonly string[], readonly string[]];
  sampleCount?: number;
  seed?: number;
  rolloutMaxSteps?: number;
  timeLimitMs?: number;
  candidateLimit?: number;
  rolloutPolicy?: HeuristicV2ProfileId;
  gameplanDeckLabels?: readonly [string, string];
}

export interface CoachActionEstimate {
  decision: Decision;
  label: string;
  winRate: number;
  confidence: number;
  sampleCount: number;
  wins: number;
  errors: number;
  maxSteps: number;
  principalLine: string[];
  explanation: string;
  gameplan?: GameplanTransitionReport;
}

export interface CoachReport {
  kind: "pimc-coach-v1";
  perspectivePlayer: PlayerId;
  actingPlayer: PlayerId;
  pendingType: Decision["type"];
  rolloutPolicy: HeuristicV2ProfileId;
  requestedSamplesPerAction: number;
  completedSamples: number;
  timedOut: boolean;
  fallbackDecision: Decision;
  bestAction: CoachActionEstimate;
  recommendations: CoachActionEstimate[];
  gameplan?: GameplanStateReport;
}

interface MutableStats {
  decision: Decision;
  label: string;
  wins: number;
  samples: number;
  errors: number;
  maxSteps: number;
  principalLine: string[];
  gameplan?: GameplanTransitionReport;
}

interface RolloutResult {
  outcome: "complete" | "error" | "max-steps";
  winner: PlayerId | null;
  line: string[];
}

const DEFAULT_SAMPLE_COUNT = 8;
const DEFAULT_ROLLOUT_MAX_STEPS = 1200;
const DEFAULT_CANDIDATE_LIMIT = 10;
const HIDDEN_FOR_SELF: ZoneName[] = ["deck", "setArea"];
const HIDDEN_FOR_OTHER: ZoneName[] = ["deck", "hand", "setArea"];
const ALL_ZONES: ZoneName[] = [
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

function other(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function cardName(db: CardDb, state: GameState, uid: number): string {
  const id = state.cards[uid];
  return id ? db.get(id)?.nameZh || db.get(id)?.nameJa || id : `uid ${uid}`;
}

function cardParam(db: CardDb, state: GameState, uid: number, area: CourtArea): number {
  const id = state.cards[uid];
  return id ? db.get(id)?.params?.[area] ?? 0 : 0;
}

function playerZoneUids(state: GameState, p: PlayerId, zones: readonly ZoneName[] = ALL_ZONES): number[] {
  const ps = state.players[p];
  return zones.flatMap((zone) => ps[zone]);
}

function inferKnownDecks(state: GameState): [string[], string[]] {
  return [0, 1].map((p) => playerZoneUids(state, p as PlayerId).map((uid) => state.cards[uid]!)) as [string[], string[]];
}

function hiddenZonesForPlayer(p: PlayerId, perspective: PlayerId): ZoneName[] {
  if (p === perspective) return HIDDEN_FOR_SELF;
  return HIDDEN_FOR_OTHER;
}

function visibleCardIds(state: GameState, p: PlayerId, hiddenZones: readonly ZoneName[]): string[] {
  const hidden = new Set<ZoneName>(hiddenZones);
  return ALL_ZONES
    .filter((zone) => !hidden.has(zone))
    .flatMap((zone) => state.players[p][zone])
    .map((uid) => state.cards[uid]!)
    .filter(Boolean);
}

function multisetMinus(pool: readonly string[], remove: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of remove) counts.set(id, (counts.get(id) ?? 0) + 1);
  const result: string[] = [];
  for (const id of pool) {
    const count = counts.get(id) ?? 0;
    if (count > 0) counts.set(id, count - 1);
    else result.push(id);
  }
  return result;
}

function shuffleCopy<T>(items: readonly T[], rnd: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function determinizeHiddenState(
  state: GameState,
  perspective: PlayerId,
  knownDecks: readonly [readonly string[], readonly string[]],
  seed: number,
): GameState {
  const copy = structuredClone(state) as GameState;
  copy.rngState = (seed >>> 0) || 1;

  for (const p of [0, 1] as const) {
    const hiddenZones = hiddenZonesForPlayer(p, perspective);
    const hiddenUids = hiddenZones.flatMap((zone) => copy.players[p][zone]);
    for (const zone of hiddenZones) copy.players[p][zone] = [...copy.players[p][zone]].sort((a, b) => a - b);
    const canonicalHiddenUids = hiddenZones.flatMap((zone) => copy.players[p][zone]);
    const visible = visibleCardIds(copy, p, hiddenZones);
    const inferredHiddenIds = hiddenUids.map((uid) => state.cards[uid]!).filter(Boolean);
    const poolFromDeck = multisetMinus(knownDecks[p], visible);
    const pool = poolFromDeck.length === canonicalHiddenUids.length ? poolFromDeck : inferredHiddenIds;
    const shuffled = shuffleCopy(pool, seededRnd(seed + p * 101 + 17));
    canonicalHiddenUids.forEach((uid, index) => {
      const cardId = shuffled[index];
      if (cardId) copy.cards[uid] = cardId;
    });
  }

  return copy;
}

function uniqueDecisions(decisions: Decision[]): Decision[] {
  const seen = new Set<string>();
  const result: Decision[] = [];
  for (const decision of decisions) {
    const key = JSON.stringify(decision);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(decision);
  }
  return result;
}

function isApplicable(db: CardDb, state: GameState, decision: Decision): boolean {
  try {
    applyDecision(db, state, decision);
    return true;
  } catch {
    return false;
  }
}

function deployDecision(db: CardDb, state: GameState, p: PlayerId, area: DeployArea, uid: number | null): Decision {
  const type = `deploy-${area}` as const;
  if (uid === null) return { type, uid: null } as Decision;
  return { type, uid, nameChoice: pickDeployName(db, state, p, uid, area) } as Decision;
}

function blockNameChoices(db: CardDb, state: GameState, p: PlayerId, uids: readonly number[]): Record<number, string> | null {
  const used = new Set<string>();
  const choices: Record<number, string> = {};
  for (const uid of uids) {
    const choice = pickDeployName(db, state, p, uid, "block", used);
    const name = choice ?? db.get(state.cards[uid]!)?.nameJa;
    if (!name) return null;
    const key = name.trim().toLowerCase();
    if (used.has(key)) return null;
    used.add(key);
    if (choice !== undefined) choices[uid] = choice;
  }
  return choices;
}

function combinations<T>(items: readonly T[], size: number, limit: number): T[][] {
  const result: T[][] = [];
  const visit = (start: number, chosen: T[]) => {
    if (result.length >= limit) return;
    if (chosen.length === size) {
      result.push([...chosen]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      chosen.push(items[i]!);
      visit(i + 1, chosen);
      chosen.pop();
      if (result.length >= limit) return;
    }
  };
  visit(0, []);
  return result;
}

function enumerateEffectCardChoices(db: CardDb, state: GameState, heuristic: Decision): Decision[] {
  const pd = state.pendingDecision;
  if (pd?.type !== "effect-cards") return [heuristic];
  const candidates = pd.candidates ?? [];
  const min = pd.min ?? 0;
  const max = Math.min(pd.max ?? candidates.length, candidates.length);
  const decisions: Decision[] = [heuristic, { type: "effect-cards", uids: autoPickCards(db, state) }];
  if (min === 0) decisions.push({ type: "effect-cards", uids: [] });
  if (max <= 0) return decisions;
  const pool = candidates.slice(0, 10);
  const start = Math.max(1, min);
  const end = Math.min(max, Math.max(start, min >= 4 ? min : 3));
  for (let size = start; size <= end; size++) {
    for (const combo of combinations(pool, size, 18)) decisions.push({ type: "effect-cards", uids: combo });
  }
  return decisions;
}

function enumerateCandidates(db: CardDb, state: GameState, limit: number, fallback: Decision): Decision[] {
  const pd = state.pendingDecision;
  if (!pd) throw new Error("沒有待決策");
  const p = pd.player as PlayerId;
  const decisions: Decision[] = [fallback];

  switch (pd.type) {
    case "serve-rights":
      decisions.push({ type: "serve-rights", take: true }, { type: "serve-rights", take: false });
      break;
    case "mulligan":
      decisions.push({ type: "mulligan", returnUids: [] });
      for (let size = 1; size <= state.players[p].hand.length; size++) {
        for (const combo of combinations(state.players[p].hand, size, 80)) {
          decisions.push({ type: "mulligan", returnUids: combo });
        }
      }
      break;
    case "defense-choice":
      decisions.push({ type: "defense-choice", choice: "receive" });
      if (canChooseBlock(state)) decisions.push({ type: "defense-choice", choice: "block" });
      break;
    case "free": {
      const fo = freeOptions(db, state);
      decisions.push({ type: "free", action: "pass" }, { type: "free", action: "lost" });
      for (const event of fo.events) decisions.push({ type: "free", action: "event", uid: event.uid });
      for (const skill of fo.skills) decisions.push({ type: "free", action: "skill", uid: skill.uid, skillIndex: skill.skillIndex });
      break;
    }
    case "resolve-pending":
      for (const id of pd.candidates ?? []) decisions.push({ type: "resolve-pending", id });
      break;
    case "effect-confirm":
      decisions.push({ type: "effect-confirm", accept: true }, { type: "effect-confirm", accept: false });
      break;
    case "effect-cards":
      decisions.push(...enumerateEffectCardChoices(db, state, fallback));
      break;
    case "effect-option":
      for (let index = 0; index < (pd.options?.length ?? 0); index++) decisions.push({ type: "effect-option", index });
      break;
    case "pick-set-card":
      for (let index = 0; index < state.players[p].setArea.length; index++) decisions.push({ type: "pick-set-card", index });
      break;
    case "deploy-block": {
      const opts = deployableUids(db, state, p, "block")
        .slice()
        .sort((a, b) => cardParam(db, state, b, "block") - cardParam(db, state, a, "block"))
        .slice(0, 7);
      decisions.push({ type: "deploy-block", uids: null });
      const maxN = Math.min(3, blockDeployMax(state, p));
      for (let size = 1; size <= maxN; size++) {
        for (const combo of combinations(opts, size, 12)) {
          const nameChoices = blockNameChoices(db, state, p, combo);
          if (!nameChoices) continue;
          for (const center of combo) decisions.push({ type: "deploy-block", uids: combo, center, nameChoices });
        }
      }
      break;
    }
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack": {
      const area = pd.type.slice("deploy-".length) as DeployArea;
      const opts = deployableUids(db, state, p, area)
        .slice()
        .sort((a, b) => cardParam(db, state, b, area) - cardParam(db, state, a, area))
        .slice(0, 8);
      decisions.push(deployDecision(db, state, p, area, null));
      for (const uid of opts) decisions.push(deployDecision(db, state, p, area, uid));
      break;
    }
  }

  const legal = uniqueDecisions(decisions).filter((decision) => isApplicable(db, state, decision));
  return legal.slice(0, Math.max(1, limit));
}

function decisionLabel(db: CardDb, state: GameState, decision: Decision): string {
  switch (decision.type) {
    case "serve-rights":
      return decision.take ? "取得首次發球權" : "讓出首次發球權";
    case "mulligan":
      return decision.returnUids.length ? `換掉 ${decision.returnUids.map((uid) => cardName(db, state, uid)).join("、")}` : "不換牌";
    case "defense-choice":
      return decision.choice === "block" ? "選擇攔網" : "選擇接球";
    case "free":
      if (decision.action === "pass") return "自由步驟 Pass";
      if (decision.action === "lost") return "主動 Lost";
      return decision.action === "event" ? `使用事件 ${cardName(db, state, decision.uid)}` : `使用技能 ${cardName(db, state, decision.uid)}`;
    case "resolve-pending":
      return `解決待機效果 #${decision.id}`;
    case "effect-confirm":
      return decision.accept ? "接受效果 / 付款" : "拒絕效果";
    case "effect-cards":
      return decision.uids.length ? `選 ${decision.uids.map((uid) => cardName(db, state, uid)).join("、")}` : "不選卡";
    case "effect-option":
      return `選項：${state.pendingDecision?.options?.[decision.index] ?? decision.index}`;
    case "pick-set-card":
      return `拿取 Set 卡 #${decision.index + 1}`;
    case "deploy-block":
      return decision.uids === null
        ? "不登場攔網"
        : `攔網 ${decision.uids.map((uid) => cardName(db, state, uid)).join("、")}`;
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack":
      return decision.uid === null ? "不登場角色" : `登場 ${cardName(db, state, decision.uid)}`;
  }
}

function explanationFor(decision: Decision, winRate: number, confidence: number): string {
  const lead = confidence >= 0.55 ? "目前樣本較穩定" : "目前樣本仍偏少";
  const rate = `${Math.round(winRate * 100)}%`;
  switch (decision.type) {
    case "defense-choice":
    case "deploy-receive":
    case "deploy-block":
      return `${lead}，估計勝率 ${rate}；此選項主要在防 Lost 與控制本回合 DP 風險。`;
    case "deploy-serve":
    case "deploy-attack":
    case "deploy-toss":
      return `${lead}，估計勝率 ${rate}；此選項主要在提高本回合 OP/攻擊線壓力。`;
    case "free":
      return `${lead}，估計勝率 ${rate}；此選項評估技能/事件的即時收益與後續資源消耗。`;
    case "effect-confirm":
    case "effect-cards":
    case "effect-option":
    case "resolve-pending":
      return `${lead}，估計勝率 ${rate}；此選項在效果解決中平衡收益、成本與後續手牌價值。`;
    case "mulligan":
      return `${lead}，估計勝率 ${rate}；此選項用完整三局 rollout 檢查起手穩定度。`;
    default:
      return `${lead}，估計勝率 ${rate}；此選項以贏下完整三局為目標評估。`;
  }
}

function confidenceFrom(samples: number, wins: number): number {
  if (samples <= 0) return 0;
  const p = wins / samples;
  const z = 1.96;
  const denom = 1 + (z * z) / samples;
  const center = p + (z * z) / (2 * samples);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * samples)) / samples);
  const low = Math.max(0, (center - margin) / denom);
  const high = Math.min(1, (center + margin) / denom);
  const widthScore = 1 - (high - low);
  const sampleScore = Math.sqrt(samples / (samples + 12));
  return clamp01(widthScore * sampleScore);
}

function logLine(entry: GameState["log"][number]): string {
  const player = entry.player === null ? "-" : `P${entry.player}`;
  return `S${entry.setNo}T${entry.turnNo} ${player} ${entry.text}`;
}

function rollout(
  db: CardDb,
  state: GameState,
  decision: Decision,
  perspective: PlayerId,
  policy: HeuristicV2ProfileId,
  maxSteps: number,
): RolloutResult {
  let current: GameState;
  const baseLogLength = state.log.length;
  try {
    current = applyDecision(db, state, decision);
  } catch (error) {
    return { outcome: "error", winner: null, line: [error instanceof Error ? error.message : String(error)] };
  }

  for (let step = 0; step < maxSteps; step++) {
    if (current.phase === "gameOver") {
      return {
        outcome: "complete",
        winner: current.winner,
        line: current.log.slice(baseLogLength, baseLogLength + 6).map(logLine),
      };
    }
    if (!current.pendingDecision) return { outcome: "error", winner: null, line: ["遊戲未結束但沒有 pendingDecision"] };
    try {
      current = applyDecision(db, current, heuristicAiDecision(db, current, policy));
    } catch (error) {
      return { outcome: "error", winner: null, line: [error instanceof Error ? error.message : String(error)] };
    }
  }
  return { outcome: "max-steps", winner: null, line: current.log.slice(-6).map(logLine) };
}

function estimateFromStats(stats: MutableStats): CoachActionEstimate {
  const winRate = stats.samples === 0 ? 0 : stats.wins / stats.samples;
  const confidence = confidenceFrom(stats.samples, stats.wins);
  return {
    decision: stats.decision,
    label: stats.label,
    winRate,
    confidence,
    sampleCount: stats.samples,
    wins: stats.wins,
    errors: stats.errors,
    maxSteps: stats.maxSteps,
    principalLine: stats.principalLine,
    explanation: explanationFor(stats.decision, winRate, confidence),
    gameplan: stats.gameplan,
  };
}

export function createPimcCoachReport(db: CardDb, state: GameState, options: PimcCoachOptions = {}): CoachReport {
  const pd = state.pendingDecision;
  if (!pd) throw new Error("沒有待決策，無法產生 Coach 建議");
  const actingPlayer = pd.player as PlayerId;
  const perspective = options.perspectivePlayer ?? actingPlayer;
  if (perspective !== actingPlayer) {
    throw new Error("PIMC Coach v1 只支援目前決策玩家的視角");
  }
  const knownDecks = options.knownDecks ?? inferKnownDecks(state);
  const sampleCount = Math.max(0, Math.floor(options.sampleCount ?? DEFAULT_SAMPLE_COUNT));
  const rolloutPolicy = options.rolloutPolicy ?? "heuristic-v2";
  const rolloutMaxSteps = options.rolloutMaxSteps ?? DEFAULT_ROLLOUT_MAX_STEPS;
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const seed = options.seed ?? state.rngState ?? 1;
  const deadline = options.timeLimitMs === undefined ? Infinity : Date.now() + Math.max(0, options.timeLimitMs);
  const fallbackDecision = heuristicAiDecision(db, state, rolloutPolicy);
  const candidates = enumerateCandidates(db, state, candidateLimit, fallbackDecision);
  const stats: MutableStats[] = candidates.map((decision) => ({
    decision,
    label: decisionLabel(db, state, decision),
    wins: 0,
    samples: 0,
    errors: 0,
    maxSteps: 0,
    principalLine: [],
  }));
  const gameplanProfile = resolveGameplanProfile(options.gameplanDeckLabels?.[perspective] ?? "", knownDecks[perspective] ?? []);
  const gameplan = gameplanProfile ? evaluateGameplanState(db, state, perspective, gameplanProfile) : undefined;
  if (gameplanProfile) {
    for (const item of stats) {
      try {
        const after = applyDecision(db, state, item.decision);
        item.gameplan = evaluateGameplanTransition(db, state, after, perspective, gameplanProfile);
      } catch {
        // Candidate gameplan is supplemental; PIMC scoring remains the source for win-rate.
      }
    }
  }

  let timedOut = false;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    for (let candidateIndex = 0; candidateIndex < stats.length; candidateIndex++) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      const item = stats[candidateIndex]!;
      const sampleSeed = seed + sampleIndex * 1009 + candidateIndex * 7919 + 23;
      const sampledState = determinizeHiddenState(state, perspective, knownDecks, sampleSeed);
      const result = rollout(db, sampledState, item.decision, perspective, rolloutPolicy, rolloutMaxSteps);
      if (result.outcome === "complete") {
        item.samples++;
        if (result.winner === perspective) item.wins++;
        if (item.principalLine.length === 0) item.principalLine = result.line;
      } else if (result.outcome === "max-steps") {
        item.maxSteps++;
        if (item.principalLine.length === 0) item.principalLine = result.line;
      } else {
        item.errors++;
        if (item.principalLine.length === 0) item.principalLine = result.line;
      }
    }
    if (timedOut) break;
  }

  const recommendations = stats
    .map(estimateFromStats)
    .sort((a, b) => b.winRate - a.winRate || b.confidence - a.confidence || b.sampleCount - a.sampleCount);
  const bestAction = recommendations[0] ?? estimateFromStats({
    decision: fallbackDecision,
    label: decisionLabel(db, state, fallbackDecision),
    wins: 0,
    samples: 0,
    errors: 0,
    maxSteps: 0,
    principalLine: [],
    gameplan: gameplanProfile
      ? (() => {
          try {
            return evaluateGameplanTransition(db, state, applyDecision(db, state, fallbackDecision), perspective, gameplanProfile);
          } catch {
            return undefined;
          }
        })()
      : undefined,
  });

  return {
    kind: "pimc-coach-v1",
    perspectivePlayer: perspective,
    actingPlayer,
    pendingType: pd.type,
    rolloutPolicy,
    requestedSamplesPerAction: sampleCount,
    completedSamples: recommendations.reduce((sum, item) => sum + item.sampleCount, 0),
    timedOut,
    fallbackDecision,
    bestAction,
    recommendations,
    gameplan,
  };
}

export const __coachTest = {
  determinizeHiddenState,
  enumerateCandidates,
};
