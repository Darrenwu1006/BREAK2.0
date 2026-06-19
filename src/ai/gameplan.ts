import profilesJson from "../../data/gameplans/profiles.json";
import type { Card } from "../data/types";
import type { CardDb, GameState, PlayerId, PlayerState, Watcher } from "../engine/types";

type ZoneKey = "serve" | "block" | "blockCenter" | "blockSides" | "receive" | "toss" | "attack";
type ObjectiveType = "uniqueDropNames" | "keyCardZone" | "resourceReady" | "opponentHandPressure" | "activeWatcher";

export interface GameplanDeckMatcher {
  labelIncludes?: string[];
  requiredCards?: string[];
}

export interface GameplanStageLabel {
  minScore: number;
  label: string;
}

export interface GameplanKeyCard {
  id: string;
  label: string;
}

export interface GameplanObjective {
  id: string;
  type: ObjectiveType;
  label: string;
  weight: number;
  threshold?: number;
  affiliation?: string;
  cardIds?: string[];
  zones?: ZoneKey[];
  trigger?: string;
}

export interface GameplanProfile {
  id: string;
  enabled: boolean;
  displayName: string;
  deckMatchers: GameplanDeckMatcher[];
  stageLabels: GameplanStageLabel[];
  keyCards: GameplanKeyCard[];
  objectives: GameplanObjective[];
}

export interface GameplanProfileFile {
  schemaVersion: "m8-gameplan-profiles-v1";
  profiles: GameplanProfile[];
}

export interface GameplanObjectiveResult {
  id: string;
  label: string;
  type: ObjectiveType;
  value: number;
  threshold: number;
  complete: boolean;
  score: number;
  weight: number;
}

export type GameplanTone = "progress" | "neutral" | "drift" | "risk";

export interface GameplanStateReport {
  profileId: string;
  displayName: string;
  stage: string;
  progressScore: number;
  badges: string[];
  risks: string[];
  objectives: GameplanObjectiveResult[];
}

export interface GameplanTransitionReport extends GameplanStateReport {
  delta: number;
  tone: GameplanTone;
}

const GAMEPLAN_FILE = profilesJson as GameplanProfileFile;
const VALID_OBJECTIVES = new Set<ObjectiveType>([
  "uniqueDropNames",
  "keyCardZone",
  "resourceReady",
  "opponentHandPressure",
  "activeWatcher",
]);

function other(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cardOf(db: CardDb, state: GameState, uid: number): Card | null {
  const id = state.cards[uid];
  return id ? db.get(id) ?? null : null;
}

function cardIdOf(state: GameState, uid: number): string | null {
  return state.cards[uid] ?? null;
}

function zoneUids(playerState: PlayerState, zone: ZoneKey): number[] {
  if (zone === "block") return [...playerState.blockCenter, ...playerState.blockSides];
  return [...playerState[zone]];
}

function fieldStacks(playerState: PlayerState): number[][] {
  return [playerState.serve, playerState.blockCenter, playerState.receive, playerState.toss, playerState.attack];
}

function gutsCount(playerState: PlayerState): number {
  return fieldStacks(playerState).reduce((sum, stack) => sum + Math.max(0, stack.length - 1), 0);
}

function objectiveThreshold(objective: GameplanObjective): number {
  if (objective.type === "keyCardZone" || objective.type === "activeWatcher" || objective.type === "opponentHandPressure") return 1;
  return Math.max(1, objective.threshold ?? 1);
}

function objectiveValue(db: CardDb, state: GameState, player: PlayerId, objective: GameplanObjective): number {
  const ps = state.players[player];
  switch (objective.type) {
    case "uniqueDropNames": {
      const names = new Set<string>();
      for (const uid of ps.drop) {
        const card = cardOf(db, state, uid);
        if (!card || card.type !== "CHARACTER") continue;
        if (objective.affiliation && !card.affiliations.includes(objective.affiliation)) continue;
        names.add(card.nameJa);
      }
      return names.size;
    }
    case "keyCardZone": {
      const cards = new Set(objective.cardIds ?? []);
      const zones: ZoneKey[] = objective.zones?.length ? objective.zones : ["serve", "receive", "toss", "attack", "block"];
      for (const zone of zones) {
        for (const uid of zoneUids(ps, zone)) {
          const cardId = cardIdOf(state, uid);
          if (cardId && cards.has(cardId)) return 1;
        }
      }
      return 0;
    }
    case "resourceReady":
      return gutsCount(ps);
    case "opponentHandPressure":
      return state.players[other(player)].hand.length <= Math.max(1, objective.threshold ?? 1) ? 1 : 0;
    case "activeWatcher":
      return state.watchers.some((watcher) => watcherMatches(state, watcher, player, objective)) ? 1 : 0;
  }
}

function watcherMatches(state: GameState, watcher: Watcher, player: PlayerId, objective: GameplanObjective): boolean {
  if (watcher.player !== player) return false;
  if (objective.trigger && watcher.trigger.on !== objective.trigger) return false;
  const cardId = cardIdOf(state, watcher.source);
  return !!cardId && (objective.cardIds ?? []).includes(cardId);
}

function scoreObjective(value: number, threshold: number, weight: number): number {
  return clamp(value / threshold, 0, 1) * weight;
}

function stageFor(profile: GameplanProfile, score: number): string {
  const stages = [...profile.stageLabels].sort((a, b) => a.minScore - b.minScore);
  let label = stages[0]?.label ?? "未標記階段";
  for (const stage of stages) {
    if (score >= stage.minScore) label = stage.label;
  }
  return label;
}

function risksFor(db: CardDb, state: GameState, player: PlayerId, profile: GameplanProfile, results: GameplanObjectiveResult[]): string[] {
  const risks: string[] = [];
  const resource = results.find((item) => item.type === "resourceReady");
  if (resource && !resource.complete && results.some((item) => item.type === "uniqueDropNames" && item.value >= Math.max(3, item.threshold - 2))) {
    risks.push(`${resource.label}不足：目前 ${resource.value}/${resource.threshold}`);
  }
  if (profile.id === "aoba-johsai-p02-control-v1") {
    const ps = state.players[player];
    const hasOmotta = ps.hand.some((uid) => cardIdOf(state, uid) === "HV-P01-087");
    const oikawaOnline = results.some((item) => item.id === "oikawa-online" && item.complete);
    if (hasOmotta && !oikawaOnline) risks.push("俺も思った☆ 在手，但及川尚未站在發球/托球線");
  }
  if (profile.id === "inarizaki-dump-suna-v1") {
    const unlocked = results.some((item) => item.id === "inarizaki-six-names" && item.complete);
    const keyIds = new Set(["HV-P02-017", "HV-P02-027", "HV-P02-024"]);
    const strandedKeyCards = state.players[player].drop
      .map((uid) => cardIdOf(state, uid))
      .filter((id): id is string => !!id && keyIds.has(id));
    if (!unlocked && strandedKeyCards.length >= 2 && gutsCount(state.players[player]) < 3) {
      risks.push("核心卡已進棄牌區，但回收用 Guts 尚不足");
    }
  }
  return [...new Set(risks)];
}

function badgesForTransition(before: GameplanStateReport, after: GameplanStateReport): string[] {
  const badges: string[] = [];
  for (const next of after.objectives) {
    const prev = before.objectives.find((item) => item.id === next.id);
    if (!prev) continue;
    if (!prev.complete && next.complete) {
      badges.push(`${next.label}達成`);
    } else if (next.value > prev.value) {
      const delta = next.value - prev.value;
      badges.push(`${next.label} +${delta}`);
    }
  }
  return [...new Set(badges)];
}

function toneFor(delta: number, badges: string[], risks: string[]): GameplanTone {
  if (risks.length > 0 && delta < 5 && badges.length === 0) return "risk";
  if (delta >= 5 || badges.length > 0) return "progress";
  if (delta <= -5) return "drift";
  return "neutral";
}

function recoveredKeyCardsFromDrop(db: CardDb, before: GameState, after: GameState, player: PlayerId, profile: GameplanProfile): string[] {
  if (profile.id !== "inarizaki-dump-suna-v1") return [];
  const keyLabels = new Map(profile.keyCards.map((card) => [card.id, card.label]));
  const beforeDrop = before.players[player].drop;
  const afterDrop = new Set(after.players[player].drop);
  const afterHand = new Set(after.players[player].hand);
  const recovered: string[] = [];
  for (const uid of beforeDrop) {
    if (afterDrop.has(uid) || !afterHand.has(uid)) continue;
    const id = cardIdOf(before, uid) ?? cardIdOf(after, uid);
    const label = id ? keyLabels.get(id) : undefined;
    const card = id ? db.get(id) ?? null : null;
    if (label) recovered.push(`${label}回收循環`);
    else if (card?.type === "CHARACTER" && card.affiliations.includes("稲荷崎")) recovered.push(`${card.nameJa}回收循環`);
  }
  return [...new Set(recovered)];
}

export function gameplanProfiles(): GameplanProfile[] {
  return GAMEPLAN_FILE.profiles;
}

export function validateGameplanProfiles(file: GameplanProfileFile = GAMEPLAN_FILE): string[] {
  const errors: string[] = [];
  if (file.schemaVersion !== "m8-gameplan-profiles-v1") errors.push("schemaVersion 必須是 m8-gameplan-profiles-v1");
  const ids = new Set<string>();
  for (const profile of file.profiles) {
    if (!profile.id) errors.push("profile 缺少 id");
    if (ids.has(profile.id)) errors.push(`profile id 重複：${profile.id}`);
    ids.add(profile.id);
    if (!profile.displayName) errors.push(`${profile.id} 缺少 displayName`);
    if (!profile.deckMatchers.length) errors.push(`${profile.id} 缺少 deckMatchers`);
    for (const objective of profile.objectives) {
      if (!VALID_OBJECTIVES.has(objective.type)) errors.push(`${profile.id}/${objective.id} objective type 不合法：${objective.type}`);
      if (objective.weight <= 0) errors.push(`${profile.id}/${objective.id} weight 必須大於 0`);
      if ((objective.type === "uniqueDropNames" || objective.type === "resourceReady" || objective.type === "opponentHandPressure") && !objective.threshold) {
        errors.push(`${profile.id}/${objective.id} 缺少 threshold`);
      }
      if ((objective.type === "keyCardZone" || objective.type === "activeWatcher") && !(objective.cardIds?.length)) {
        errors.push(`${profile.id}/${objective.id} 缺少 cardIds`);
      }
    }
  }
  return errors;
}

export function resolveGameplanProfile(deckLabel: string, cardIds: readonly string[]): GameplanProfile | null {
  const cardSet = new Set(cardIds);
  for (const profile of GAMEPLAN_FILE.profiles) {
    if (!profile.enabled) continue;
    for (const matcher of profile.deckMatchers) {
      const labelOk = !matcher.labelIncludes?.length || matcher.labelIncludes.every((part) => deckLabel.includes(part));
      const cardsOk = !matcher.requiredCards?.length || matcher.requiredCards.every((id) => cardSet.has(id));
      if (labelOk && cardsOk) return profile;
    }
  }
  return null;
}

export function evaluateGameplanState(db: CardDb, state: GameState, player: PlayerId, profile: GameplanProfile): GameplanStateReport {
  const objectives = profile.objectives.map((objective) => {
    const threshold = objectiveThreshold(objective);
    const value = objectiveValue(db, state, player, objective);
    return {
      id: objective.id,
      label: objective.label,
      type: objective.type,
      value,
      threshold,
      complete: value >= threshold,
      score: scoreObjective(value, threshold, objective.weight),
      weight: objective.weight,
    } satisfies GameplanObjectiveResult;
  });
  const maxScore = objectives.reduce((sum, item) => sum + item.weight, 0) || 1;
  const progressScore = Math.round((objectives.reduce((sum, item) => sum + item.score, 0) / maxScore) * 100);
  const badges = objectives.filter((item) => item.complete).map((item) => `${item.label}達成`);
  const report = {
    profileId: profile.id,
    displayName: profile.displayName,
    stage: stageFor(profile, progressScore),
    progressScore,
    badges,
    risks: [],
    objectives,
  };
  return { ...report, risks: risksFor(db, state, player, profile, objectives) };
}

export function evaluateGameplanTransition(
  db: CardDb,
  before: GameState,
  after: GameState,
  player: PlayerId,
  profile: GameplanProfile,
): GameplanTransitionReport {
  const beforeReport = evaluateGameplanState(db, before, player, profile);
  const afterReport = evaluateGameplanState(db, after, player, profile);
  const delta = afterReport.progressScore - beforeReport.progressScore;
  const badges = [...new Set([...badgesForTransition(beforeReport, afterReport), ...recoveredKeyCardsFromDrop(db, before, after, player, profile)])];
  const risks = [...new Set([...afterReport.risks])];
  return {
    ...afterReport,
    delta,
    badges,
    risks,
    tone: toneFor(delta, badges, risks),
  };
}
