import type { Card } from "../data/types";
import type { ParamName } from "../engine/dsl";
import type { CardDb, PlayerId } from "../engine/types";
import type { ActionImpactStats, BenchmarkDeckInput, BenchmarkPolicyId, ConfidenceInterval, GutsSource, LostReason, MatchPlayerStats, OpSource, PointStats } from "./benchmark";
import { mirroredSeeds, runBenchmarkBatch } from "./benchmark";
import type { DeckAxis } from "./benchmark-fixtures";

export const DECK_ANALYZER_SCHEMA_VERSION = "m8-deck-analyzer-v1";

type Severity = "info" | "watch" | "risk";
type RoleArea = ParamName;
export type AnalyzerPreset = "custom" | "smoke" | "direction" | "formal" | "holdout";

const AREAS: RoleArea[] = ["serve", "block", "receive", "toss", "attack"];
const OP_SOURCES: OpSource[] = ["serve", "block", "attack"];
const GUTS_SOURCES: GutsSource[] = ["serve", "receive", "toss", "attack", "blockCenter"];
const HIGH_THRESHOLDS: Record<RoleArea, number> = { serve: 4, block: 3, receive: 4, toss: 2, attack: 4 };
const AREA_LABELS: Record<RoleArea, string> = {
  serve: "發球",
  block: "攔網",
  receive: "接球",
  toss: "舉球",
  attack: "攻擊",
};

export interface AnalyzeDeckConfig {
  db: CardDb;
  deck: BenchmarkDeckInput;
  opponents: readonly BenchmarkDeckInput[];
  policy: BenchmarkPolicyId;
  opponentPolicy: BenchmarkPolicyId;
  gamesPerSeat: number;
  seedStart: number;
  maxSteps?: number;
  preset?: AnalyzerPreset;
}

export interface CompareDeckConfig extends Omit<AnalyzeDeckConfig, "deck"> {
  baseDeck: BenchmarkDeckInput;
  candidateDeck: BenchmarkDeckInput;
}

export interface DeckStaticProfile {
  totalCards: number;
  uniqueCardCount: number;
  characterCount: number;
  eventCount: number;
  eventRatio: number;
  positionCounts: Record<string, number>;
  playableCounts: Record<RoleArea, number>;
  highParamCounts: Record<RoleArea, number>;
  averageParams: Record<RoleArea, number>;
  roleCoverageBuckets: number[];
  openingQuality: {
    serveStarterRate: number;
    receiveStarterRate: number;
    blockStarterRate: number;
    tossStarterRate: number;
    attackStarterRate: number;
    servingCoreRate: number;
    receivingCoreRate: number;
  };
  topRoleCards: Record<RoleArea, { id: string; name: string; count: number; value: number }[]>;
}

export interface AnalyzerMetrics {
  games: number;
  completed: number;
  winRate: number;
  winRate95: ConfidenceInterval;
  setWinRate: number;
  averageRalliesPerSet: number;
  averageOp: number;
  averageServeOp: number;
  averageBlockOp: number;
  averageAttackOp: number;
  burstRate: number;
  averageDp: number;
  receiveSuccessRate: number;
  blockSuccessRate: number;
  eventUsesPerMatch: number;
  eventEffectiveRate: number;
  eventDrawsPerMatch: number;
  eventPointModsPerMatch: number;
  eventDeploysPerMatch: number;
  skillUsesPerMatch: number;
  skillEffectiveRate: number;
  paidGutsPerMatch: number;
  gutsPaidBySourcePerMatch: Record<GutsSource, number>;
  emptyDrawsPerMatch: number;
  mulliganRate: number;
  noDeployLossRate: number;
  judgeFailLossRate: number;
}

export interface SeatAnalyzerSummary {
  seat: PlayerId;
  games: number;
  completed: number;
  wins: number;
  winRate: number;
  averageRalliesPerSet: number;
}

export interface DeckMatchupReport {
  opponent: string;
  opponentAxes: DeckAxis[];
  metrics: AnalyzerMetrics;
  targetLostReasons: Partial<Record<LostReason, number>>;
  opponentLostReasons: Partial<Record<LostReason, number>>;
  seats: [SeatAnalyzerSummary, SeatAnalyzerSummary];
  diagnosis: string[];
}

export interface AnalysisFinding {
  code: string;
  severity: Severity;
  label: string;
  detail: string;
  evidence: string;
}

export interface DeckAnalyzerReport {
  schemaVersion: typeof DECK_ANALYZER_SCHEMA_VERSION;
  generatedAt: string;
  config: {
    deck: string;
    deckAxes: DeckAxis[];
    opponents: string[];
    policy: BenchmarkPolicyId;
    opponentPolicy: BenchmarkPolicyId;
    gamesPerSeat: number;
    seedStart: number;
    maxSteps: number;
    preset: AnalyzerPreset;
  };
  staticProfile: DeckStaticProfile;
  aggregate: AnalyzerMetrics;
  matchups: DeckMatchupReport[];
  gameplan: string[];
  weaknesses: AnalysisFinding[];
  brickSources: AnalysisFinding[];
  recommendations: string[];
}

export interface DeckComparisonReport {
  baseDeck: string;
  candidateDeck: string;
  winRateDelta: number;
  setWinRateDelta: number;
  averageRalliesDelta: number;
  verdict: "candidate-better" | "base-better" | "too-close";
  notes: string[];
  matchupDeltas: { opponent: string; winRateDelta: number; setWinRateDelta: number }[];
}

export interface DeckAnalyzerComparisonReport {
  schemaVersion: typeof DECK_ANALYZER_SCHEMA_VERSION;
  generatedAt: string;
  base: DeckAnalyzerReport;
  candidate: DeckAnalyzerReport;
  comparison: DeckComparisonReport;
}

const DEFAULT_MAX_STEPS = 5000;

function wilson(successes: number, total: number): ConfidenceInterval {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

function blankAreaRecord(): Record<RoleArea, number> {
  return { serve: 0, block: 0, receive: 0, toss: 0, attack: 0 };
}

function cardName(card: Card): string {
  return card.nameZh || card.nameJa;
}

function cardOrThrow(db: CardDb, id: string): Card {
  const card = db.get(id);
  if (!card) throw new Error(`找不到卡片 ${id}`);
  return card;
}

function cardCounts(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function probNoSuccess(deckSize: number, successCount: number, draws: number): number {
  if (successCount <= 0) return 1;
  if (successCount >= deckSize) return 0;
  let value = 1;
  for (let i = 0; i < draws; i++) value *= (deckSize - successCount - i) / (deckSize - i);
  return Math.max(0, Math.min(1, value));
}

function probAtLeastOne(deckSize: number, successCount: number, draws: number): number {
  return 1 - probNoSuccess(deckSize, successCount, draws);
}

function probAtLeastBoth(deckSize: number, aCount: number, bCount: number, overlap: number, draws: number): number {
  const union = aCount + bCount - overlap;
  return Math.max(0, Math.min(1, 1 - probNoSuccess(deckSize, aCount, draws) - probNoSuccess(deckSize, bCount, draws) + probNoSuccess(deckSize, union, draws)));
}

function analyzeStaticProfile(db: CardDb, deck: BenchmarkDeckInput): DeckStaticProfile {
  const counts = cardCounts(deck.ids);
  const playableCounts = blankAreaRecord();
  const highParamCounts = blankAreaRecord();
  const paramTotals = blankAreaRecord();
  const positionCounts: Record<string, number> = {};
  const topRoleCards: DeckStaticProfile["topRoleCards"] = { serve: [], block: [], receive: [], toss: [], attack: [] };
  const coverageBuckets = [0, 0, 0, 0, 0, 0];
  let characterCount = 0;
  let eventCount = 0;

  for (const id of deck.ids) {
    const card = cardOrThrow(db, id);
    if (card.type === "EVENT") {
      eventCount++;
      continue;
    }
    characterCount++;
    for (const pos of card.positions) positionCounts[pos] = (positionCounts[pos] ?? 0) + 1;
    const coverage = AREAS.filter((area) => card.params?.[area] !== null && card.params?.[area] !== undefined).length;
    coverageBuckets[coverage] = (coverageBuckets[coverage] ?? 0) + 1;
    for (const area of AREAS) {
      const value = card.params?.[area];
      if (value === null || value === undefined) continue;
      playableCounts[area]++;
      paramTotals[area] += value;
      if (value >= HIGH_THRESHOLDS[area]) highParamCounts[area]++;
    }
  }

  for (const [id, count] of counts) {
    const card = cardOrThrow(db, id);
    if (!card.params) continue;
    for (const area of AREAS) {
      const value = card.params[area];
      if (value === null) continue;
      topRoleCards[area].push({ id, name: cardName(card), count, value });
    }
  }
  for (const area of AREAS) {
    topRoleCards[area].sort((a, b) => b.value - a.value || b.count - a.count || a.name.localeCompare(b.name));
    topRoleCards[area] = topRoleCards[area].slice(0, 5);
  }

  const deckSize = deck.ids.length;
  const serveStarter = deck.ids.filter((id) => (cardOrThrow(db, id).params?.serve ?? -Infinity) >= HIGH_THRESHOLDS.serve).length;
  const receiveStarter = deck.ids.filter((id) => (cardOrThrow(db, id).params?.receive ?? -Infinity) >= HIGH_THRESHOLDS.receive).length;
  const blockStarter = deck.ids.filter((id) => (cardOrThrow(db, id).params?.block ?? -Infinity) >= HIGH_THRESHOLDS.block).length;
  const defenseStarter = deck.ids.filter((id) => {
    const params = cardOrThrow(db, id).params;
    return (params?.receive ?? -Infinity) >= HIGH_THRESHOLDS.receive || (params?.block ?? -Infinity) >= HIGH_THRESHOLDS.block;
  }).length;
  const tossStarter = deck.ids.filter((id) => (cardOrThrow(db, id).params?.toss ?? -Infinity) >= HIGH_THRESHOLDS.toss).length;
  const attackStarter = deck.ids.filter((id) => (cardOrThrow(db, id).params?.attack ?? -Infinity) >= HIGH_THRESHOLDS.attack).length;
  const serveAttackOverlap = deck.ids.filter((id) => {
    const params = cardOrThrow(db, id).params;
    return (params?.serve ?? -Infinity) >= HIGH_THRESHOLDS.serve && (params?.attack ?? -Infinity) >= HIGH_THRESHOLDS.attack;
  }).length;
  const defenseTossOverlap = deck.ids.filter((id) => {
    const params = cardOrThrow(db, id).params;
    const defense = (params?.receive ?? -Infinity) >= HIGH_THRESHOLDS.receive || (params?.block ?? -Infinity) >= HIGH_THRESHOLDS.block;
    return defense && (params?.toss ?? -Infinity) >= HIGH_THRESHOLDS.toss;
  }).length;

  const averageParams = blankAreaRecord();
  for (const area of AREAS) averageParams[area] = playableCounts[area] === 0 ? 0 : paramTotals[area] / playableCounts[area];

  return {
    totalCards: deck.ids.length,
    uniqueCardCount: counts.size,
    characterCount,
    eventCount,
    eventRatio: deck.ids.length === 0 ? 0 : eventCount / deck.ids.length,
    positionCounts,
    playableCounts,
    highParamCounts,
    averageParams,
    roleCoverageBuckets: coverageBuckets,
    openingQuality: {
      serveStarterRate: probAtLeastOne(deckSize, serveStarter, 6),
      receiveStarterRate: probAtLeastOne(deckSize, receiveStarter, 6),
      blockStarterRate: probAtLeastOne(deckSize, blockStarter, 6),
      tossStarterRate: probAtLeastOne(deckSize, tossStarter, 6),
      attackStarterRate: probAtLeastOne(deckSize, attackStarter, 6),
      servingCoreRate: probAtLeastBoth(deckSize, serveStarter, attackStarter, serveAttackOverlap, 6),
      receivingCoreRate: probAtLeastBoth(deckSize, defenseStarter, tossStarter, defenseTossOverlap, 6),
    },
    topRoleCards,
  };
}

function blankPointStats(): PointStats {
  return { count: 0, total: 0, max: 0, highCount: 0 };
}

function blankActionImpactStats(): ActionImpactStats {
  return { uses: 0, effectiveUses: 0, impactCount: 0, pointMods: 0, draws: 0, handAdds: 0, deploys: 0, paidGuts: 0 };
}

function blankPlayerStats(): MatchPlayerStats {
  return {
    mulligans: 0,
    mulliganReturned: 0,
    deployments: { serve: 0, block: 0, receive: 0, toss: 0, attack: 0 },
    blockDeployCards: 0,
    freeEvents: 0,
    freeSkills: 0,
    paidGuts: 0,
    drawEvents: 0,
    deckEmptyDraws: 0,
    op: blankPointStats(),
    attackOp: blankPointStats(),
    opBySource: { serve: blankPointStats(), block: blankPointStats(), attack: blankPointStats() },
    dp: blankPointStats(),
    defense: {
      receive: { attempts: 0, successes: 0, failures: 0 },
      block: { attempts: 0, successes: 0, failures: 0 },
      unknown: { attempts: 0, successes: 0, failures: 0 },
    },
    playQuality: {
      lowPointDeploy: {
        toss: { opportunities: 0, lowPointChoices: 0, totalDeficit: 0, maxDeficit: 0 },
        attack: { opportunities: 0, lowPointChoices: 0, totalDeficit: 0, maxDeficit: 0 },
      },
      defenseSkillNonUse: { opportunities: 0, nonUses: 0 },
    },
    actionImpact: { event: blankActionImpactStats(), skill: blankActionImpactStats() },
    gutsPaidBySource: { serve: 0, receive: 0, toss: 0, attack: 0, blockCenter: 0 },
  };
}

function mergePoint(target: PointStats, source: PointStats): void {
  target.count += source.count;
  target.total += source.total;
  target.max = Math.max(target.max, source.max);
  target.highCount += source.highCount;
}

function mergePlayerStats(target: MatchPlayerStats, source: MatchPlayerStats): void {
  target.mulligans += source.mulligans;
  target.mulliganReturned += source.mulliganReturned;
  target.blockDeployCards += source.blockDeployCards;
  target.freeEvents += source.freeEvents;
  target.freeSkills += source.freeSkills;
  target.paidGuts += source.paidGuts;
  target.drawEvents += source.drawEvents;
  target.deckEmptyDraws += source.deckEmptyDraws;
  for (const area of AREAS) target.deployments[area] += source.deployments[area];
  mergePoint(target.op, source.op);
  mergePoint(target.attackOp, source.attackOp);
  for (const opSource of OP_SOURCES) mergePoint(target.opBySource[opSource], source.opBySource[opSource]);
  mergePoint(target.dp, source.dp);
  for (const route of ["receive", "block", "unknown"] as const) {
    target.defense[route].attempts += source.defense[route].attempts;
    target.defense[route].successes += source.defense[route].successes;
    target.defense[route].failures += source.defense[route].failures;
  }
  for (const area of ["toss", "attack"] as const) {
    target.playQuality.lowPointDeploy[area].opportunities += source.playQuality.lowPointDeploy[area].opportunities;
    target.playQuality.lowPointDeploy[area].lowPointChoices += source.playQuality.lowPointDeploy[area].lowPointChoices;
    target.playQuality.lowPointDeploy[area].totalDeficit += source.playQuality.lowPointDeploy[area].totalDeficit;
    target.playQuality.lowPointDeploy[area].maxDeficit = Math.max(target.playQuality.lowPointDeploy[area].maxDeficit, source.playQuality.lowPointDeploy[area].maxDeficit);
  }
  target.playQuality.defenseSkillNonUse.opportunities += source.playQuality.defenseSkillNonUse.opportunities;
  target.playQuality.defenseSkillNonUse.nonUses += source.playQuality.defenseSkillNonUse.nonUses;
  for (const kind of ["event", "skill"] as const) {
    target.actionImpact[kind].uses += source.actionImpact[kind].uses;
    target.actionImpact[kind].effectiveUses += source.actionImpact[kind].effectiveUses;
    target.actionImpact[kind].impactCount += source.actionImpact[kind].impactCount;
    target.actionImpact[kind].pointMods += source.actionImpact[kind].pointMods;
    target.actionImpact[kind].draws += source.actionImpact[kind].draws;
    target.actionImpact[kind].handAdds += source.actionImpact[kind].handAdds;
    target.actionImpact[kind].deploys += source.actionImpact[kind].deploys;
    target.actionImpact[kind].paidGuts += source.actionImpact[kind].paidGuts;
  }
  for (const sourceArea of GUTS_SOURCES) target.gutsPaidBySource[sourceArea] += source.gutsPaidBySource[sourceArea];
}

function addReason(target: Partial<Record<LostReason, number>>, source: Partial<Record<LostReason, number>>): void {
  for (const [reason, count] of Object.entries(source) as [LostReason, number][]) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

function topReason(reasons: Partial<Record<LostReason, number>>): [LostReason, number] | null {
  const entries = Object.entries(reasons) as [LostReason, number][];
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b[1] - a[1])[0]!;
}

function pointAverage(stats: PointStats): number {
  return stats.count === 0 ? 0 : stats.total / stats.count;
}

function rate(successes: number, total: number): number {
  return total === 0 ? 0 : successes / total;
}

function sumReasons(reasons: Partial<Record<LostReason, number>>): number {
  return Object.values(reasons).reduce((sum, count) => sum + count, 0);
}

interface MatchupAccum {
  games: number;
  completed: number;
  wins: number;
  setWins: number;
  setLosses: number;
  rallyTotal: number;
  setTotal: number;
  targetStats: MatchPlayerStats;
  targetLostReasons: Partial<Record<LostReason, number>>;
  opponentLostReasons: Partial<Record<LostReason, number>>;
}

function blankAccum(): MatchupAccum {
  return {
    games: 0,
    completed: 0,
    wins: 0,
    setWins: 0,
    setLosses: 0,
    rallyTotal: 0,
    setTotal: 0,
    targetStats: blankPlayerStats(),
    targetLostReasons: {},
    opponentLostReasons: {},
  };
}

function absorbBatch(accum: MatchupAccum, report: ReturnType<typeof runBenchmarkBatch>, targetPlayer: PlayerId): SeatAnalyzerSummary {
  let wins = 0;
  let completed = 0;
  let rallyTotal = 0;
  let setTotal = 0;

  for (const match of report.matches) {
    accum.games++;
    if (match.outcome === "complete") {
      accum.completed++;
      completed++;
      if (match.winner === targetPlayer) {
        accum.wins++;
        wins++;
      }
    }
    for (const set of match.setResults) {
      setTotal++;
      accum.setTotal++;
      rallyTotal += set.rallies;
      accum.rallyTotal += set.rallies;
      if (set.winner === targetPlayer) accum.setWins++;
      if (set.loser === targetPlayer) accum.setLosses++;
    }
    mergePlayerStats(accum.targetStats, match.stats.players[targetPlayer]);
    addReason(accum.targetLostReasons, match.lostReasonsByPlayer[targetPlayer]);
    addReason(accum.opponentLostReasons, match.lostReasonsByPlayer[targetPlayer === 0 ? 1 : 0]);
  }

  return {
    seat: targetPlayer,
    games: report.matches.length,
    completed,
    wins,
    winRate: rate(wins, completed),
    averageRalliesPerSet: setTotal === 0 ? 0 : rallyTotal / setTotal,
  };
}

function metricsFromAccum(accum: MatchupAccum): AnalyzerMetrics {
  const stats = accum.targetStats;
  const targetLosses = sumReasons(accum.targetLostReasons);
  const receive = stats.defense.receive;
  const block = stats.defense.block;
  const eventImpact = stats.actionImpact.event;
  const skillImpact = stats.actionImpact.skill;
  return {
    games: accum.games,
    completed: accum.completed,
    winRate: rate(accum.wins, accum.completed),
    winRate95: wilson(accum.wins, accum.completed),
    setWinRate: rate(accum.setWins, accum.setWins + accum.setLosses),
    averageRalliesPerSet: accum.setTotal === 0 ? 0 : accum.rallyTotal / accum.setTotal,
    averageOp: pointAverage(stats.op),
    averageServeOp: pointAverage(stats.opBySource.serve),
    averageBlockOp: pointAverage(stats.opBySource.block),
    averageAttackOp: pointAverage(stats.attackOp),
    burstRate: rate(stats.attackOp.highCount, stats.attackOp.count),
    averageDp: pointAverage(stats.dp),
    receiveSuccessRate: rate(receive.successes, receive.attempts),
    blockSuccessRate: rate(block.successes, block.attempts),
    eventUsesPerMatch: rate(stats.freeEvents, accum.completed),
    eventEffectiveRate: rate(eventImpact.effectiveUses, eventImpact.uses),
    eventDrawsPerMatch: rate(eventImpact.draws, accum.completed),
    eventPointModsPerMatch: rate(eventImpact.pointMods, accum.completed),
    eventDeploysPerMatch: rate(eventImpact.deploys, accum.completed),
    skillUsesPerMatch: rate(stats.freeSkills, accum.completed),
    skillEffectiveRate: rate(skillImpact.effectiveUses, skillImpact.uses),
    paidGutsPerMatch: rate(stats.paidGuts, accum.completed),
    gutsPaidBySourcePerMatch: {
      serve: rate(stats.gutsPaidBySource.serve, accum.completed),
      receive: rate(stats.gutsPaidBySource.receive, accum.completed),
      toss: rate(stats.gutsPaidBySource.toss, accum.completed),
      attack: rate(stats.gutsPaidBySource.attack, accum.completed),
      blockCenter: rate(stats.gutsPaidBySource.blockCenter, accum.completed),
    },
    emptyDrawsPerMatch: rate(stats.deckEmptyDraws, accum.completed),
    mulliganRate: rate(stats.mulligans, accum.completed * 2),
    noDeployLossRate: rate(accum.targetLostReasons["no-deploy"] ?? 0, targetLosses),
    judgeFailLossRate: rate(accum.targetLostReasons["judge-fail"] ?? 0, targetLosses),
  };
}

function mergeAccum(target: MatchupAccum, source: MatchupAccum): void {
  target.games += source.games;
  target.completed += source.completed;
  target.wins += source.wins;
  target.setWins += source.setWins;
  target.setLosses += source.setLosses;
  target.rallyTotal += source.rallyTotal;
  target.setTotal += source.setTotal;
  mergePlayerStats(target.targetStats, source.targetStats);
  addReason(target.targetLostReasons, source.targetLostReasons);
  addReason(target.opponentLostReasons, source.opponentLostReasons);
}

function summarizeMatchup(config: AnalyzeDeckConfig, opponent: BenchmarkDeckInput, pairIndex: number): DeckMatchupReport {
  const games = Math.max(1, config.gamesPerSeat);
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
  const firstSeed = config.seedStart + pairIndex * games * 2;
  const secondSeed = firstSeed + games;
  const accum = blankAccum();
  const asP0 = runBenchmarkBatch({
    db: config.db,
    decks: [config.deck, opponent],
    policies: [config.policy, config.opponentPolicy],
    seeds: mirroredSeeds(firstSeed, games),
    maxSteps,
  });
  const seat0 = absorbBatch(accum, asP0, 0);
  const asP1 = runBenchmarkBatch({
    db: config.db,
    decks: [opponent, config.deck],
    policies: [config.opponentPolicy, config.policy],
    seeds: mirroredSeeds(secondSeed, games),
    maxSteps,
  });
  const seat1 = absorbBatch(accum, asP1, 1);
  const metrics = metricsFromAccum(accum);

  return {
    opponent: opponent.name,
    opponentAxes: opponent.axes ?? [],
    metrics,
    targetLostReasons: accum.targetLostReasons,
    opponentLostReasons: accum.opponentLostReasons,
    seats: [seat0, seat1],
    diagnosis: matchupDiagnosis(opponent, metrics, accum.targetLostReasons),
  };
}

function finding(code: string, severity: Severity, label: string, detail: string, evidence: string): AnalysisFinding {
  return { code, severity, label, detail, evidence };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const LOST_REASON_LABELS: Record<LostReason, string> = {
  "judge-fail": "OP / DP 判定失敗",
  "no-deploy": "未能登場而 Lost",
  voluntary: "主動宣告 Lost",
  effect: "效果造成 Lost",
  unknown: "原因未明",
};

const GUTS_SOURCE_LABELS: Record<GutsSource, string> = {
  serve: "發球區",
  receive: "接球區",
  toss: "托球區",
  attack: "攻擊區",
  blockCenter: "中央攔網",
};

function formatGutsSourceEvidence(sources: Record<GutsSource, number>): string {
  return Object.entries(sources)
    .filter(([, value]) => value > 0)
    .map(([source, value]) => `${GUTS_SOURCE_LABELS[source as GutsSource]}:${value.toFixed(2)}`)
    .join(", ");
}

function matchupDiagnosis(opponent: BenchmarkDeckInput, metrics: AnalyzerMetrics, targetLostReasons: Partial<Record<LostReason, number>>): string[] {
  const lines: string[] = [];
  if (metrics.winRate < 0.4) lines.push(`對 ${opponent.name} 明顯吃虧，勝率 ${percent(metrics.winRate)}，應優先檢查這個對局是卡在登場、判定，還是資源支付。`);
  else if (metrics.winRate > 0.6) lines.push(`對 ${opponent.name} 目前有優勢，勝率 ${percent(metrics.winRate)}，可用作調整後的保留基準。`);
  else lines.push(`對 ${opponent.name} 接近五五開，勝率 ${percent(metrics.winRate)}，需要更多場次或 holdout seed 判斷。`);

  const reason = topReason(targetLostReasons);
  if (reason) {
    const [name, count] = reason;
    lines.push(`主要失 Set 來源是「${LOST_REASON_LABELS[name]}」（${count} 次），這是優先調整方向。`);
  }

  const axes = opponent.axes?.join("/") || "未標記";
  if (opponent.axes?.includes("serve") && metrics.receiveSuccessRate < 0.7) lines.push(`對手含發球軸（${axes}），接球成功率 ${percent(metrics.receiveSuccessRate)} 偏低。`);
  if (opponent.axes?.includes("block") && metrics.averageAttackOp < 4) lines.push(`對手含攔網軸（${axes}），平均攻擊 OP ${metrics.averageAttackOp.toFixed(2)}，突破壓力不足。`);
  if (metrics.eventUsesPerMatch > 0 && metrics.eventEffectiveRate < 0.5) lines.push(`事件有打出，但只有 ${percent(metrics.eventEffectiveRate)} 轉成抽牌、加點或登場等實質效果，需檢查使用時機或成本。`);
  if (metrics.paidGutsPerMatch >= 3) lines.push(`每場平均支付 ${metrics.paidGutsPerMatch.toFixed(2)} Guts，注意是否把後續需要登場的區域資源先付掉。`);
  return lines;
}

function inferGameplan(deck: BenchmarkDeckInput, profile: DeckStaticProfile, metrics: AnalyzerMetrics): string[] {
  const axes = deck.axes ?? [];
  const lines: string[] = [];
  if (axes.includes("block") || axes.includes("defense")) {
    lines.push(`主要計畫偏防守：用 ${AREA_LABELS.receive}/${AREA_LABELS.block} 覆蓋延長 rally，讓對手在判定或登場資源上失誤。`);
  }
  if (axes.includes("serve")) lines.push(`有發球壓力取向：高發球起手率 ${percent(profile.openingQuality.serveStarterRate)}，目標是先用發球或前段節奏逼對手接球失敗。`);
  if (axes.includes("burst")) lines.push(`有爆發取向：平均攻擊 OP ${metrics.averageAttackOp.toFixed(2)}，高攻擊 OP 比例 ${percent(metrics.burstRate)}，適合尋找托攻線成形後的突破回合。`);
  if (axes.includes("hybrid") || lines.length === 0) lines.push(`混合型 gameplan：五區覆蓋較平均，重點是維持起手角色線與事件/技能的節奏，不把單一區域資源過早耗光。`);
  lines.push(`目前模擬整體勝率 ${percent(metrics.winRate)}，Set 取得率 ${percent(metrics.setWinRate)}，平均每 Set ${metrics.averageRalliesPerSet.toFixed(2)} 次 rally。`);
  return lines;
}

function inferFindings(profile: DeckStaticProfile, metrics: AnalyzerMetrics): { weaknesses: AnalysisFinding[]; brickSources: AnalysisFinding[]; recommendations: string[] } {
  const weaknesses: AnalysisFinding[] = [];
  const brickSources: AnalysisFinding[] = [];
  const recommendations: string[] = [];

  if (metrics.winRate < 0.45) {
    weaknesses.push(finding("low-win-rate", "risk", "整體勝率偏低", "目前對固定對手池的期望值不足，應先找出是無法登場、判定不過，還是資源支付太重。", `Match勝率=${percent(metrics.winRate)}`));
  } else if (metrics.winRate < 0.52) {
    weaknesses.push(finding("thin-edge", "watch", "勝率優勢不明顯", "目前結果接近五五開，後續比較 A/B 版本時需要更多場次確認。", `Match勝率=${percent(metrics.winRate)}`));
  }

  if (metrics.noDeployLossRate >= 0.2) {
    const item = finding("no-deploy-loss", "risk", "未能登場而 Lost", "Lost 有明顯比例來自該階段沒有可登場角色，優先檢查角色密度與發球/接球/托球/攻擊區域覆蓋。", `失Set中未能登場比例=${percent(metrics.noDeployLossRate)}`);
    weaknesses.push(item);
    brickSources.push(item);
    recommendations.push("提高低點但可登場角色的密度，或降低過度依賴單一卡名/位置的比例。");
  }
  if (metrics.judgeFailLossRate >= 0.6) {
    const item = finding("judge-fail-loss", "watch", "判定失敗偏多", "主要 Lost 來自 DP/OP 判定不過，表示點數線或效果增幅還不穩。", `失Set中判定失敗比例=${percent(metrics.judgeFailLossRate)}`);
    weaknesses.push(item);
    brickSources.push(item);
  }

  for (const area of AREAS) {
    if (profile.playableCounts[area] < 8) {
      const item = finding(`${area}-coverage-low`, "risk", `${AREA_LABELS[area]}可登場角色偏少`, `${AREA_LABELS[area]}可登場角色少於 8 張，遇到手牌偏移時容易在該階段無法登場。`, `${AREA_LABELS[area]}可登場=${profile.playableCounts[area]}/40`);
      brickSources.push(item);
      recommendations.push(`補強 ${AREA_LABELS[area]} 可登場角色，先以穩定上場為優先。`);
    }
  }

  if (profile.eventCount >= 8 && profile.characterCount <= 32) {
    brickSources.push(finding("event-density-high", "watch", "事件密度接近上限", "事件卡已達或接近 8 張上限，若角色線偏薄會放大卡手。", `事件=${profile.eventCount}, 角色=${profile.characterCount}`));
  }
  if (profile.openingQuality.servingCoreRate < 0.7) {
    brickSources.push(finding("serving-open-low", "watch", "先攻起手線偏薄", "同時摸到高發球與基本攻擊線的機率偏低。", `先攻核心起手率=${percent(profile.openingQuality.servingCoreRate)}`));
  }
  if (profile.openingQuality.receivingCoreRate < 0.7) {
    brickSources.push(finding("receiving-open-low", "watch", "後攻起手線偏薄", "同時摸到防守點與舉球線的機率偏低。", `後攻核心起手率=${percent(profile.openingQuality.receivingCoreRate)}`));
  }
  if (metrics.receiveSuccessRate > 0 && metrics.receiveSuccessRate < 0.55) {
    weaknesses.push(finding("receive-rate-low", "risk", "接球成功率偏低", "接球路線判定不穩，對發球/攻擊壓力牌組會吃虧。", `接球判定成功=${percent(metrics.receiveSuccessRate)}`));
  }
  if (metrics.blockSuccessRate > 0 && metrics.blockSuccessRate < 0.5) {
    weaknesses.push(finding("block-rate-low", "watch", "攔網成功率偏低", "攔網投入後未能穩定換回成功判定，可能需要更高 block 點或更少資源的攔網方案。", `攔網判定成功=${percent(metrics.blockSuccessRate)}`));
  }
  if (metrics.emptyDrawsPerMatch > 0) {
    weaknesses.push(finding("deck-empty-draw", "watch", "牌組耗竭訊號", "模擬中出現牌組空抽，長 rally 或抽牌效果可能讓資源風險上升。", `平均空抽=${metrics.emptyDrawsPerMatch.toFixed(2)} 次/場`));
  }
  if (metrics.paidGutsPerMatch >= 3) {
    const sourceText = formatGutsSourceEvidence(metrics.gutsPaidBySourcePerMatch);
    weaknesses.push(finding("guts-demand-high", "watch", "Guts 需求偏高", "技能成本使用頻率高，會壓縮場面資源；需確認支付來源是否吃到關鍵區域。", `支付Guts=${metrics.paidGutsPerMatch.toFixed(2)}/場${sourceText ? `, 來源=${sourceText}` : ""}`));
  }
  if (metrics.eventUsesPerMatch >= 1 && metrics.eventEffectiveRate < 0.5) {
    weaknesses.push(finding("event-low-impact", "watch", "事件打出後的實質效果偏少", "事件有被使用，但較少轉化為抽牌、點數修正或登場等可觀察效果。", `事件實質效果=${percent(metrics.eventEffectiveRate)}, 事件使用=${metrics.eventUsesPerMatch.toFixed(2)} 次/場`));
    recommendations.push("檢查事件卡是否常在低收益時機被打出；若是構築問題，優先比較少 1-2 張事件的版本。");
  }
  if (metrics.skillUsesPerMatch >= 1 && metrics.skillEffectiveRate < 0.5) {
    weaknesses.push(finding("skill-low-impact", "watch", "技能宣言後的實質效果偏少", "技能有被使用，但較少轉化為抽牌、點數修正或登場等可觀察效果。", `技能實質效果=${percent(metrics.skillEffectiveRate)}, 技能宣言=${metrics.skillUsesPerMatch.toFixed(2)} 次/場`));
  }

  if (recommendations.length === 0) recommendations.push("目前未出現單一明顯卡手來源；下一步可用 A/B test 微調 2-4 張卡，觀察勝率與失 Set 原因是否穩定改善。");
  return { weaknesses, brickSources, recommendations: [...new Set(recommendations)] };
}

function weightedMetric(matchups: DeckMatchupReport[], pick: (matchup: DeckMatchupReport) => number, weight: (matchup: DeckMatchupReport) => number): number {
  const totalWeight = matchups.reduce((sum, matchup) => sum + weight(matchup), 0);
  if (totalWeight === 0) return 0;
  return matchups.reduce((sum, matchup) => sum + pick(matchup) * weight(matchup), 0) / totalWeight;
}

function aggregateMetricsFromMatchups(matchups: DeckMatchupReport[]): AnalyzerMetrics {
  const games = matchups.reduce((sum, matchup) => sum + matchup.metrics.games, 0);
  const completed = matchups.reduce((sum, matchup) => sum + matchup.metrics.completed, 0);
  const wins = Math.round(matchups.reduce((sum, matchup) => sum + matchup.metrics.winRate * matchup.metrics.completed, 0));
  const targetLosses = matchups.reduce((sum, matchup) => sum + sumReasons(matchup.targetLostReasons), 0);
  const opponentLosses = matchups.reduce((sum, matchup) => sum + sumReasons(matchup.opponentLostReasons), 0);
  const setTotal = targetLosses + opponentLosses;
  const noDeployLosses = matchups.reduce((sum, matchup) => sum + (matchup.targetLostReasons["no-deploy"] ?? 0), 0);
  const judgeFailLosses = matchups.reduce((sum, matchup) => sum + (matchup.targetLostReasons["judge-fail"] ?? 0), 0);
  return {
    games,
    completed,
    winRate: rate(wins, completed),
    winRate95: wilson(wins, completed),
    setWinRate: rate(opponentLosses, setTotal),
    averageRalliesPerSet: weightedMetric(matchups, (matchup) => matchup.metrics.averageRalliesPerSet, (matchup) => sumReasons(matchup.targetLostReasons) + sumReasons(matchup.opponentLostReasons)),
    averageOp: weightedMetric(matchups, (matchup) => matchup.metrics.averageOp, (matchup) => matchup.metrics.completed),
    averageServeOp: weightedMetric(matchups, (matchup) => matchup.metrics.averageServeOp, (matchup) => matchup.metrics.completed),
    averageBlockOp: weightedMetric(matchups, (matchup) => matchup.metrics.averageBlockOp, (matchup) => matchup.metrics.completed),
    averageAttackOp: weightedMetric(matchups, (matchup) => matchup.metrics.averageAttackOp, (matchup) => matchup.metrics.completed),
    burstRate: weightedMetric(matchups, (matchup) => matchup.metrics.burstRate, (matchup) => matchup.metrics.completed),
    averageDp: weightedMetric(matchups, (matchup) => matchup.metrics.averageDp, (matchup) => matchup.metrics.completed),
    receiveSuccessRate: weightedMetric(matchups, (matchup) => matchup.metrics.receiveSuccessRate, (matchup) => matchup.metrics.completed),
    blockSuccessRate: weightedMetric(matchups, (matchup) => matchup.metrics.blockSuccessRate, (matchup) => matchup.metrics.completed),
    eventUsesPerMatch: weightedMetric(matchups, (matchup) => matchup.metrics.eventUsesPerMatch, (matchup) => matchup.metrics.completed),
    eventEffectiveRate: weightedMetric(matchups, (matchup) => matchup.metrics.eventEffectiveRate, (matchup) => matchup.metrics.completed),
    eventDrawsPerMatch: weightedMetric(matchups, (matchup) => matchup.metrics.eventDrawsPerMatch, (matchup) => matchup.metrics.completed),
    eventPointModsPerMatch: weightedMetric(matchups, (matchup) => matchup.metrics.eventPointModsPerMatch, (matchup) => matchup.metrics.completed),
    eventDeploysPerMatch: weightedMetric(matchups, (matchup) => matchup.metrics.eventDeploysPerMatch, (matchup) => matchup.metrics.completed),
    skillUsesPerMatch: weightedMetric(matchups, (matchup) => matchup.metrics.skillUsesPerMatch, (matchup) => matchup.metrics.completed),
    skillEffectiveRate: weightedMetric(matchups, (matchup) => matchup.metrics.skillEffectiveRate, (matchup) => matchup.metrics.completed),
    paidGutsPerMatch: weightedMetric(matchups, (matchup) => matchup.metrics.paidGutsPerMatch, (matchup) => matchup.metrics.completed),
    gutsPaidBySourcePerMatch: {
      serve: weightedMetric(matchups, (matchup) => matchup.metrics.gutsPaidBySourcePerMatch.serve, (matchup) => matchup.metrics.completed),
      receive: weightedMetric(matchups, (matchup) => matchup.metrics.gutsPaidBySourcePerMatch.receive, (matchup) => matchup.metrics.completed),
      toss: weightedMetric(matchups, (matchup) => matchup.metrics.gutsPaidBySourcePerMatch.toss, (matchup) => matchup.metrics.completed),
      attack: weightedMetric(matchups, (matchup) => matchup.metrics.gutsPaidBySourcePerMatch.attack, (matchup) => matchup.metrics.completed),
      blockCenter: weightedMetric(matchups, (matchup) => matchup.metrics.gutsPaidBySourcePerMatch.blockCenter, (matchup) => matchup.metrics.completed),
    },
    emptyDrawsPerMatch: weightedMetric(matchups, (matchup) => matchup.metrics.emptyDrawsPerMatch, (matchup) => matchup.metrics.completed),
    mulliganRate: weightedMetric(matchups, (matchup) => matchup.metrics.mulliganRate, (matchup) => matchup.metrics.completed),
    noDeployLossRate: rate(noDeployLosses, targetLosses),
    judgeFailLossRate: rate(judgeFailLosses, targetLosses),
  };
}

export function runDeckAnalyzer(config: AnalyzeDeckConfig, generatedAt = new Date().toISOString()): DeckAnalyzerReport {
  if (config.opponents.length === 0) throw new Error("Deck Analyzer 至少需要一個對手牌組");
  const profile = analyzeStaticProfile(config.db, config.deck);
  const matchups = config.opponents.map((opponent, index) => summarizeMatchup(config, opponent, index));
  const aggregate = aggregateMetricsFromMatchups(matchups);
  const inferred = inferFindings(profile, aggregate);

  return {
    schemaVersion: DECK_ANALYZER_SCHEMA_VERSION,
    generatedAt,
    config: {
      deck: config.deck.name,
      deckAxes: config.deck.axes ?? [],
      opponents: config.opponents.map((opponent) => opponent.name),
      policy: config.policy,
      opponentPolicy: config.opponentPolicy,
      gamesPerSeat: config.gamesPerSeat,
      seedStart: config.seedStart,
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
      preset: config.preset ?? "custom",
    },
    staticProfile: profile,
    aggregate,
    matchups,
    gameplan: inferGameplan(config.deck, profile, aggregate),
    weaknesses: inferred.weaknesses,
    brickSources: inferred.brickSources,
    recommendations: inferred.recommendations,
  };
}

export function compareDeckAnalyzerReports(base: DeckAnalyzerReport, candidate: DeckAnalyzerReport): DeckComparisonReport {
  const winRateDelta = candidate.aggregate.winRate - base.aggregate.winRate;
  const setWinRateDelta = candidate.aggregate.setWinRate - base.aggregate.setWinRate;
  const averageRalliesDelta = candidate.aggregate.averageRalliesPerSet - base.aggregate.averageRalliesPerSet;
  const matchupDeltas = candidate.matchups.map((candidateMatchup) => {
    const baseMatchup = base.matchups.find((matchup) => matchup.opponent === candidateMatchup.opponent);
    return {
      opponent: candidateMatchup.opponent,
      winRateDelta: candidateMatchup.metrics.winRate - (baseMatchup?.metrics.winRate ?? 0),
      setWinRateDelta: candidateMatchup.metrics.setWinRate - (baseMatchup?.metrics.setWinRate ?? 0),
    };
  });
  const verdict: DeckComparisonReport["verdict"] = Math.abs(winRateDelta) < 0.03 ? "too-close" : winRateDelta > 0 ? "candidate-better" : "base-better";
  const notes = [
    `勝率差 ${winRateDelta >= 0 ? "+" : ""}${percent(winRateDelta)}`,
    `Set 取得率差 ${setWinRateDelta >= 0 ? "+" : ""}${percent(setWinRateDelta)}`,
  ];
  if (verdict === "too-close") notes.push("差距小於 3%，建議增加 games 或改用 holdout seeds 再確認。");
  return {
    baseDeck: base.config.deck,
    candidateDeck: candidate.config.deck,
    winRateDelta,
    setWinRateDelta,
    averageRalliesDelta,
    verdict,
    notes,
    matchupDeltas,
  };
}

export function runDeckAnalyzerComparison(config: CompareDeckConfig, generatedAt = new Date().toISOString()): DeckAnalyzerComparisonReport {
  const base = runDeckAnalyzer({ ...config, deck: config.baseDeck }, generatedAt);
  const candidate = runDeckAnalyzer({ ...config, deck: config.candidateDeck }, generatedAt);
  return {
    schemaVersion: DECK_ANALYZER_SCHEMA_VERSION,
    generatedAt,
    base,
    candidate,
    comparison: compareDeckAnalyzerReports(base, candidate),
  };
}
