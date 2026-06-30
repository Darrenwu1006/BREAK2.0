import { applyDecision, createGame, deployableUids, effParam, freeOptions } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { heuristicAiDecision, heuristicProfileForDeckAxes, isHeuristicV2ProfileId } from "./heuristic";
import type { HeuristicV2ProfileId } from "./heuristic";
import { heuristicV1AiDecision } from "./heuristic-v1";
import { randomAiDecision } from "./random";
import { createPimcCoachReport } from "./coach";
import { createIsmctsReport } from "./ismcts";
import type { DeckAxis } from "./benchmark-fixtures";

// [Claude 2026-06-22] Phase F PIMC benchmark policy：pimc＝現況基準（無 EV cut）；
// pimc-v2＝S1（EV cut@valueCutHorizon），已 A/B PASS、default-on。兩者共用同一 sample budget，方便同預算 A/B。
// [Claude 2026-06-23] Phase G：is-mcts＝SO-ISMCTS。成本單位是 iteration（≠ PIMC sample），故 A/B 一律同 wall-clock。
export type BenchmarkPolicyId = "random" | "heuristic-v1" | "pimc" | "pimc-v2" | "is-mcts" | "is-mcts-h2" | "is-mcts-h2b" | "is-mcts-h2c" | HeuristicV2ProfileId;

// [Claude 2026-06-22] Phase F 第一槓桿：把 PIMC 搜尋接成 benchmark policy，量化「PIMC vs heuristic」強度。
// sample budget 是強度/速度的旋鈕（屬「模型能力」gate），先給保守可跑的初探預設，CLI 可覆寫。
export interface PimcBenchmarkConfig {
  sampleCount: number;
  rolloutMaxSteps: number;
  candidateLimit: number;
  timeLimitMs?: number;
  /** [Claude 2026-06-22] S1：pimc-v2 的 EV cut horizon（rollout 步數）。只作用於 pimc-v2，pimc 不受影響。 */
  valueCutHorizon: number;
}

const DEFAULT_PIMC_BENCHMARK_CONFIG: PimcBenchmarkConfig = {
  sampleCount: 8,
  rolloutMaxSteps: 600,
  candidateLimit: 8,
  valueCutHorizon: 40, // [Claude 2026-06-23] horizon sweep 取最強（與 UI 一致）
};

let pimcBenchmarkConfig: PimcBenchmarkConfig = { ...DEFAULT_PIMC_BENCHMARK_CONFIG };

export function configurePimcBenchmark(patch: Partial<PimcBenchmarkConfig>): void {
  pimcBenchmarkConfig = { ...pimcBenchmarkConfig, ...patch };
}

export function getPimcBenchmarkConfig(): PimcBenchmarkConfig {
  return { ...pimcBenchmarkConfig };
}

// [Claude 2026-06-23] Phase G：IS-MCTS benchmark 旋鈕。iterations＝無 deadline 時硬上限；
// 同 wall-clock A/B 時設 timeLimitMs（與 pimc-v2 同值）。leafRolloutHorizon 保留給 G3 方案 B，G1 忽略（leaf＝純 V）。
export interface IsmctsBenchmarkConfig {
  iterations: number;
  timeLimitMs?: number;
  explorationC: number;
  candidateLimit: number;
  /** [G3 保留] 方案 B：leaf 淺 rollout horizon。G1＝0（純 evaluateStateValue）。 */
  leafRolloutHorizon: number;
  /** [Codex 2026-06-29] Phase H H2：is-mcts-h2 公開壓制力 shaping 強度。 */
  pressureShapingEpsilon: number;
  /** [Codex 2026-06-29] Phase H H2B/H2C：root tie-break winRate delta。 */
  rootPressureTieBreakDelta: number;
}

const DEFAULT_ISMCTS_BENCHMARK_CONFIG: IsmctsBenchmarkConfig = {
  // [Claude 2026-06-23] 同 wall-clock A/B 由 timeLimitMs 綁定預算；iterations 設高當安全上限，
  // 否則（如 800）會在 ~0.5s 就達上限、浪費剩餘 think budget → 對 is-mcts 不公平。
  iterations: 1_000_000,
  explorationC: Math.SQRT2,
  candidateLimit: 8,
  // [Claude 2026-06-23] G2 診斷後預設＝40（方案 B，對齊 PIMC horizon）：純 V leaf（=0）淺樹下區分力不足、
  // 對手模型預設＝heuristic（createIsmctsReport 預設）——adversarial 對固定 heuristic 對手有害。
  leafRolloutHorizon: 40,
  pressureShapingEpsilon: 0.05,
  rootPressureTieBreakDelta: 0.03,
};

let ismctsBenchmarkConfig: IsmctsBenchmarkConfig = { ...DEFAULT_ISMCTS_BENCHMARK_CONFIG };

export function configureIsmctsBenchmark(patch: Partial<IsmctsBenchmarkConfig>): void {
  ismctsBenchmarkConfig = { ...ismctsBenchmarkConfig, ...patch };
}

export function getIsmctsBenchmarkConfig(): IsmctsBenchmarkConfig {
  return { ...ismctsBenchmarkConfig };
}
export type MatchOutcome = "complete" | "error" | "max-steps";
export type MatrixMode = "ring" | "all-vs-all";
export type LostReason = "judge-fail" | "no-deploy" | "voluntary" | "effect" | "unknown";

export interface BenchmarkDeckInput {
  name: string;
  ids: string[];
  axes?: DeckAxis[];
}

export interface MatchConfig {
  db: CardDb;
  decks: readonly [BenchmarkDeckInput, BenchmarkDeckInput];
  policies: readonly [BenchmarkPolicyId, BenchmarkPolicyId];
  seed: number;
  maxSteps?: number;
}

export interface PlayerInvariant {
  player: PlayerId;
  totalCards: number;
  uniqueCards: number;
  expectedCards: number;
  ok: boolean;
}

export interface MatchResult {
  seed: number;
  decks: [string, string];
  policies: [BenchmarkPolicyId, BenchmarkPolicyId];
  outcome: MatchOutcome;
  winner: PlayerId | null;
  winnerPolicy: BenchmarkPolicyId | null;
  steps: number;
  setNo: number;
  turnNo: number;
  setResults: SetResult[];
  averageRalliesPerSet: number;
  lostBy: [number, number];
  lostReasonsByPlayer: [Partial<Record<LostReason, number>>, Partial<Record<LostReason, number>>];
  stats: MatchStats;
  invariants: [PlayerInvariant, PlayerInvariant];
  error?: string;
  logTail: string[];
}

export interface SetResult {
  setNo: number;
  winner: PlayerId;
  loser: PlayerId;
  lostReason: LostReason;
  rallies: number;
  logIndex: number;
}

export type DeployArea = "serve" | "block" | "receive" | "toss" | "attack";
export type DefenseRoute = "receive" | "block" | "unknown";
export type OpSource = "serve" | "block" | "attack";
export type GutsSource = "serve" | "receive" | "toss" | "attack" | "blockCenter";

export interface PointStats {
  count: number;
  total: number;
  max: number;
  highCount: number;
}

export interface DefenseStats {
  attempts: number;
  successes: number;
  failures: number;
}

export interface LowPointDeployStats {
  opportunities: number;
  lowPointChoices: number;
  totalDeficit: number;
  maxDeficit: number;
}

export interface DefenseSkillNonUseStats {
  opportunities: number;
  nonUses: number;
}

export interface PlayQualityStats {
  lowPointDeploy: Record<"toss" | "attack", LowPointDeployStats>;
  defenseSkillNonUse: DefenseSkillNonUseStats;
}

export interface ActionImpactStats {
  uses: number;
  effectiveUses: number;
  impactCount: number;
  pointMods: number;
  draws: number;
  handAdds: number;
  deploys: number;
  paidGuts: number;
}

export interface MatchPlayerStats {
  mulligans: number;
  mulliganReturned: number;
  deployments: Record<DeployArea, number>;
  blockDeployCards: number;
  freeEvents: number;
  freeSkills: number;
  paidGuts: number;
  drawEvents: number;
  deckEmptyDraws: number;
  op: PointStats;
  attackOp: PointStats;
  opBySource: Record<OpSource, PointStats>;
  dp: PointStats;
  defense: Record<DefenseRoute, DefenseStats>;
  playQuality: PlayQualityStats;
  actionImpact: Record<"event" | "skill", ActionImpactStats>;
  gutsPaidBySource: Record<GutsSource, number>;
}

export interface MatchStats {
  players: [MatchPlayerStats, MatchPlayerStats];
}

export interface BatchConfig {
  db: CardDb;
  decks: readonly [BenchmarkDeckInput, BenchmarkDeckInput];
  policies: readonly [BenchmarkPolicyId, BenchmarkPolicyId];
  seeds: number[];
  maxSteps?: number;
}

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export interface BatchSummary {
  total: number;
  completed: number;
  errored: number;
  maxSteps: number;
  winsByPlayer: [number, number];
  winsByPolicy: Partial<Record<BenchmarkPolicyId, number>>;
  player0WinRate: number;
  player0WinRate95: ConfidenceInterval;
  averageSteps: number;
  averageSetNo: number;
  averageRalliesPerSet: number;
  setWinsByPlayer: [number, number];
  setWinsByReason: Partial<Record<LostReason, number>>;
  lostReasons: Partial<Record<LostReason, number>>;
  playQualityByPlayer: [PlayQualitySummary, PlayQualitySummary];
}

export interface PlayQualitySummary {
  lowPointDeployOpportunities: number;
  lowPointDeploys: number;
  lowPointDeployRate: number;
  averageLowPointDeficit: number;
  defenseSkillOpportunities: number;
  defenseSkillNonUses: number;
  defenseSkillNonUseRate: number;
  averageOpPressure: number;
  opPressureSamples: number;
}

export interface BatchReport {
  config: {
    decks: [string, string];
    deckCards: [string[], string[]];
    deckAxes: [DeckAxis[], DeckAxis[]];
    policies: [BenchmarkPolicyId, BenchmarkPolicyId];
    seeds: number[];
    maxSteps: number;
  };
  summary: BatchSummary;
  matches: MatchResult[];
}

export interface MatrixPairReport extends BatchReport {
  pairIndex: number;
  axes: [DeckAxis[], DeckAxis[]];
}

export interface MatrixConfig {
  db: CardDb;
  decks: readonly BenchmarkDeckInput[];
  policies: readonly [BenchmarkPolicyId, BenchmarkPolicyId];
  seedStart: number;
  gamesPerPair: number;
  maxSteps?: number;
  mode?: MatrixMode;
}

export interface MatrixSummary {
  pairs: number;
  totalGames: number;
  completed: number;
  errored: number;
  maxSteps: number;
  winsByPolicy: Partial<Record<BenchmarkPolicyId, number>>;
  winsByDeck: Record<string, number>;
  winsByAxis: Partial<Record<DeckAxis, number>>;
  averageRalliesPerSet: number;
  setWinsByReason: Partial<Record<LostReason, number>>;
  lostReasons: Partial<Record<LostReason, number>>;
  playQualityByPlayer: [PlayQualitySummary, PlayQualitySummary];
}

export interface MatrixReport {
  config: {
    mode: MatrixMode;
    policies: [BenchmarkPolicyId, BenchmarkPolicyId];
    seedStart: number;
    gamesPerPair: number;
    maxSteps: number;
  };
  summary: MatrixSummary;
  pairs: MatrixPairReport[];
}

const DEFAULT_MAX_STEPS = 5000;

export function seededRnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x9e3779b9;
    let t = Math.imul(s ^ (s >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

function other(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

export function benchmarkPolicyDecision(
  policy: BenchmarkPolicyId,
  db: CardDb,
  state: GameState,
  randomByPlayer: [() => number, () => number],
  deckAxesByPlayer: readonly [readonly DeckAxis[], readonly DeckAxis[]] = [[], []],
  knownDecksByPlayer?: readonly [readonly string[], readonly string[]],
): Decision {
  const pending = state.pendingDecision;
  if (!pending) throw new Error("目前沒有待決策，benchmark 無法推進");
  const player = pending.player as PlayerId;
  if (policy === "pimc" || policy === "pimc-v2") {
    const rolloutPolicy = heuristicProfileForDeckAxes(deckAxesByPlayer[player]);
    const report = createPimcCoachReport(db, state, {
      perspectivePlayer: player,
      // 牌組身份在遊戲中是公開資訊，傳入真實 knownDecks 讓 determinize 從牌組重建對手未知牌、
      // 不依賴對手現有隱藏區的排列（否則翻轉對手手牌會改變抽樣路徑）。
      knownDecks: knownDecksByPlayer,
      sampleCount: pimcBenchmarkConfig.sampleCount,
      rolloutMaxSteps: pimcBenchmarkConfig.rolloutMaxSteps,
      candidateLimit: pimcBenchmarkConfig.candidateLimit,
      timeLimitMs: pimcBenchmarkConfig.timeLimitMs,
      rolloutPolicy,
      // pimc-v2＝載 S1 EV cut；pimc＝現況（打到終局）。
      valueCutHorizon: policy === "pimc-v2" ? pimcBenchmarkConfig.valueCutHorizon : undefined,
    });
    return report.bestAction.decision;
  }
  if (policy === "is-mcts" || policy === "is-mcts-h2" || policy === "is-mcts-h2b" || policy === "is-mcts-h2c") {
    const rolloutPolicy = heuristicProfileForDeckAxes(deckAxesByPlayer[player]);
    const report = createIsmctsReport(db, state, {
      perspectivePlayer: player,
      // 牌組身份公開：傳真實 knownDecks，讓 determinize 從牌組重建對手未知牌（不依賴隱藏排列）。
      knownDecks: knownDecksByPlayer,
      iterations: ismctsBenchmarkConfig.iterations,
      timeLimitMs: ismctsBenchmarkConfig.timeLimitMs,
      explorationC: ismctsBenchmarkConfig.explorationC,
      candidateLimit: ismctsBenchmarkConfig.candidateLimit,
      leafRolloutHorizon: ismctsBenchmarkConfig.leafRolloutHorizon,
      pressureShapingEpsilon: policy === "is-mcts-h2" ? ismctsBenchmarkConfig.pressureShapingEpsilon : 0,
      rootPressureTieBreakDelta: policy === "is-mcts-h2b" || policy === "is-mcts-h2c" ? ismctsBenchmarkConfig.rootPressureTieBreakDelta : 0,
      rootPairQualityTieBreak: policy === "is-mcts-h2c",
      rolloutPolicy,
    });
    return report.bestAction.decision;
  }
  if (policy === "heuristic-v2-personality") return heuristicAiDecision(db, state, heuristicProfileForDeckAxes(deckAxesByPlayer[player]));
  if (isHeuristicV2ProfileId(policy)) return heuristicAiDecision(db, state, policy);
  if (policy === "heuristic-v1") return heuristicV1AiDecision(db, state);
  return randomAiDecision(db, state, randomByPlayer[player]);
}

function collectPlayerUids(state: GameState, p: PlayerId): number[] {
  const ps = state.players[p];
  return [
    ...ps.deck,
    ...ps.hand,
    ...ps.setArea,
    ...ps.drop,
    ...ps.eventArea,
    ...ps.serve,
    ...ps.blockCenter,
    ...ps.blockSides,
    ...ps.receive,
    ...ps.toss,
    ...ps.attack,
  ];
}

function playerInvariant(state: GameState, p: PlayerId, expectedCards: number): PlayerInvariant {
  const uids = collectPlayerUids(state, p);
  const uniqueCards = new Set(uids).size;
  return {
    player: p,
    totalCards: uids.length,
    uniqueCards,
    expectedCards,
    ok: uids.length === expectedCards && uniqueCards === expectedCards,
  };
}

function classifyLostReason(state: GameState, logIndex: number): LostReason {
  const entry = state.log[logIndex];
  if (!entry || entry.player === null) return "unknown";
  const recent = state.log.slice(Math.max(0, logIndex - 4), logIndex).filter((candidate) => candidate.player === entry.player);
  if (recent.some((candidate) => candidate.text.includes("主動宣告 Lost"))) return "voluntary";
  if (recent.some((candidate) => candidate.text.includes("未登場角色"))) return "no-deploy";
  if (recent.some((candidate) => candidate.text.includes("判定") && candidate.text.includes("失敗"))) return "judge-fail";
  if (recent.some((candidate) => candidate.text.includes("效果") || candidate.text.includes("ブロックアウト"))) return "effect";
  return "unknown";
}

function collectLostStats(state: GameState): {
  lostBy: [number, number];
  lostReasonsByPlayer: [Partial<Record<LostReason, number>>, Partial<Record<LostReason, number>>];
  setResults: SetResult[];
} {
  const counts: [number, number] = [0, 0];
  const reasons: [Partial<Record<LostReason, number>>, Partial<Record<LostReason, number>>] = [{}, {}];
  const setResults: SetResult[] = [];
  for (let index = 0; index < state.log.length; index++) {
    const entry = state.log[index]!;
    if (!entry.text.includes("宣告 Lost") || entry.player === null) continue;
    counts[entry.player]++;
    const reason = classifyLostReason(state, index);
    reasons[entry.player][reason] = (reasons[entry.player][reason] ?? 0) + 1;
    setResults.push({
      setNo: entry.setNo,
      winner: other(entry.player),
      loser: entry.player,
      lostReason: reason,
      rallies: Math.max(1, entry.turnNo),
      logIndex: index,
    });
  }
  return { lostBy: counts, lostReasonsByPlayer: reasons, setResults };
}

function averageRallies(setResults: SetResult[]): number {
  if (setResults.length === 0) return 0;
  return setResults.reduce((sum, result) => sum + result.rallies, 0) / setResults.length;
}

function blankPointStats(): PointStats {
  return { count: 0, total: 0, max: 0, highCount: 0 };
}

function blankDefenseStats(): DefenseStats {
  return { attempts: 0, successes: 0, failures: 0 };
}

function blankLowPointDeployStats(): LowPointDeployStats {
  return { opportunities: 0, lowPointChoices: 0, totalDeficit: 0, maxDeficit: 0 };
}

function blankDefenseSkillNonUseStats(): DefenseSkillNonUseStats {
  return { opportunities: 0, nonUses: 0 };
}

function blankPlayQualityStats(): PlayQualityStats {
  return {
    lowPointDeploy: { toss: blankLowPointDeployStats(), attack: blankLowPointDeployStats() },
    defenseSkillNonUse: blankDefenseSkillNonUseStats(),
  };
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
    defense: { receive: blankDefenseStats(), block: blankDefenseStats(), unknown: blankDefenseStats() },
    playQuality: blankPlayQualityStats(),
    actionImpact: { event: blankActionImpactStats(), skill: blankActionImpactStats() },
    gutsPaidBySource: { serve: 0, receive: 0, toss: 0, attack: 0, blockCenter: 0 },
  };
}

function addLowPointDeployStats(target: LowPointDeployStats, source: LowPointDeployStats): void {
  target.opportunities += source.opportunities;
  target.lowPointChoices += source.lowPointChoices;
  target.totalDeficit += source.totalDeficit;
  target.maxDeficit = Math.max(target.maxDeficit, source.maxDeficit);
}

function addDefenseSkillNonUseStats(target: DefenseSkillNonUseStats, source: DefenseSkillNonUseStats): void {
  target.opportunities += source.opportunities;
  target.nonUses += source.nonUses;
}

function addPlayQualityStats(target: PlayQualityStats, source: PlayQualityStats): void {
  addLowPointDeployStats(target.lowPointDeploy.toss, source.lowPointDeploy.toss);
  addLowPointDeployStats(target.lowPointDeploy.attack, source.lowPointDeploy.attack);
  addDefenseSkillNonUseStats(target.defenseSkillNonUse, source.defenseSkillNonUse);
}

function copyPlayQualityStats(source: PlayQualityStats): PlayQualityStats {
  const copy = blankPlayQualityStats();
  addPlayQualityStats(copy, source);
  return copy;
}

function firstNumber(text: string): number {
  const match = text.match(/-?\d+/);
  return match ? Number(match[0]) : 0;
}

function pointValue(text: string, label: "OP" | "DP"): number | null {
  const match = text.match(new RegExp(`${label} 算出\\s*[=＝]\\s*(-?\\d+)`));
  return match?.[1] === undefined ? null : Number(match[1]);
}

function addPoint(stats: PointStats, value: number): void {
  stats.count++;
  stats.total += value;
  stats.max = Math.max(stats.max, value);
  if (value >= 6) stats.highCount++;
}

function addDefense(stats: DefenseStats, success: boolean): void {
  stats.attempts++;
  if (success) stats.successes++;
  else stats.failures++;
}

type ActiveAction = { kind: "event" | "skill"; impacted: boolean } | null;

function markActionImpact(stats: MatchPlayerStats, active: ActiveAction, field: keyof Omit<ActionImpactStats, "uses" | "effectiveUses" | "impactCount" | "paidGuts">, amount = 1): ActiveAction {
  if (!active) return active;
  const impact = stats.actionImpact[active.kind];
  impact.impactCount += amount;
  impact[field] += amount;
  if (!active.impacted) {
    impact.effectiveUses++;
    return { ...active, impacted: true };
  }
  return active;
}

function effectivePoint(db: CardDb, state: GameState, uid: number, area: "toss" | "attack"): number {
  return effParam(db, state, uid, area) ?? 0;
}

function recordLowPointDeploy(db: CardDb, state: GameState, player: PlayerId, area: "toss" | "attack", uid: number | null, stats: LowPointDeployStats): void {
  if (uid === null) return;
  const legal = deployableUids(db, state, player, area);
  if (legal.length <= 1) return;
  const chosen = effectivePoint(db, state, uid, area);
  const best = Math.max(...legal.map((candidate) => effectivePoint(db, state, candidate, area)));
  const deficit = best - chosen;
  stats.opportunities++;
  if (deficit >= 2) {
    stats.lowPointChoices++;
    stats.totalDeficit += deficit;
    stats.maxDeficit = Math.max(stats.maxDeficit, deficit);
  }
}

function isDefensiveFreeStep(state: GameState, player: PlayerId): boolean {
  return (state.phase === "block" || state.phase === "receive") && !!state.op && state.op.owner !== player;
}

export function recordPlayQualityDecision(db: CardDb, state: GameState, decision: Decision, stats: PlayQualityStats): void {
  const pending = state.pendingDecision;
  if (!pending) return;
  const player = pending.player as PlayerId;
  if (decision.type === "deploy-toss" || decision.type === "deploy-attack") {
    const area = decision.type === "deploy-toss" ? "toss" : "attack";
    recordLowPointDeploy(db, state, player, area, decision.uid, stats.lowPointDeploy[area]);
    return;
  }
  if (decision.type === "free" && isDefensiveFreeStep(state, player)) {
    const availableSkills = freeOptions(db, state).skills.length;
    if (availableSkills === 0) return;
    stats.defenseSkillNonUse.opportunities++;
    if (decision.action !== "skill") stats.defenseSkillNonUse.nonUses++;
    return;
  }
  if (decision.type === "effect-confirm" && isDefensiveFreeStep(state, player) && state.effectCtx?.desc.includes("技能")) {
    stats.defenseSkillNonUse.opportunities++;
    if (!decision.accept) stats.defenseSkillNonUse.nonUses++;
  }
}

export function collectMatchStats(state: GameState, playQuality?: readonly [PlayQualityStats, PlayQualityStats]): MatchStats {
  const players: [MatchPlayerStats, MatchPlayerStats] = [blankPlayerStats(), blankPlayerStats()];
  if (playQuality) {
    players[0].playQuality = copyPlayQualityStats(playQuality[0]);
    players[1].playQuality = copyPlayQualityStats(playQuality[1]);
  }
  const currentRoute: [DefenseRoute, DefenseRoute] = ["unknown", "unknown"];
  const activeAction: [ActiveAction, ActiveAction] = [null, null];

  for (const entry of state.log) {
    if (entry.player === null) continue;
    const p = entry.player;
    const stats = players[p];
    const text = entry.text;

    if (text.startsWith("── ")) activeAction[p] = null;
    if (text.startsWith("換牌 ")) {
      stats.mulligans++;
      stats.mulliganReturned += firstNumber(text);
    }
    if (text.startsWith("打出事件卡 ")) {
      stats.freeEvents++;
      stats.actionImpact.event.uses++;
      activeAction[p] = { kind: "event", impacted: false };
    }
    if (text.startsWith("使用 ") && text.includes(" 的技能")) {
      stats.freeSkills++;
      stats.actionImpact.skill.uses++;
      activeAction[p] = { kind: "skill", impacted: false };
    }
    if (text.startsWith("支付 ") && text.includes(" Guts")) {
      const paid = firstNumber(text);
      stats.paidGuts += paid;
      if (activeAction[p]) stats.actionImpact[activeAction[p]!.kind].paidGuts += paid;
    }
    if (entry.event?.kind === "pay-guts") {
      for (const [source, count] of Object.entries(entry.event.sources) as [GutsSource, number][]) {
        stats.gutsPaidBySource[source] += count;
      }
    }
    if (text.includes("牌組已空，無法抽牌")) stats.deckEmptyDraws++;
    else if (text.includes("抽")) {
      const drawCount = Math.max(1, firstNumber(text));
      stats.drawEvents += drawCount;
      if (!text.startsWith("接球抽牌")) activeAction[p] = markActionImpact(stats, activeAction[p], "draws", drawCount);
    }
    if (text.includes("加入手牌") || text.includes("回到手牌") || text.includes("回收")) activeAction[p] = markActionImpact(stats, activeAction[p], "handAdds");

    const deployMatch = text.match(/→ (serve|receive|toss|attack)$/);
    if (deployMatch?.[1]) {
      stats.deployments[deployMatch[1] as DeployArea]++;
      if (text.includes("從") || text.includes("移動") || text.includes("登場 →")) activeAction[p] = markActionImpact(stats, activeAction[p], "deploys");
      else activeAction[p] = null;
    }
    const blockMatch = text.match(/^攔網登場 (.+)（中央=/);
    if (blockMatch?.[1]) {
      stats.deployments.block++;
      stats.blockDeployCards += blockMatch[1].split("、").filter(Boolean).length;
      activeAction[p] = null;
    }

    if (text === "選擇接球") currentRoute[p] = "receive";
    if (text === "選擇攔網") currentRoute[p] = "block";
    if (text.includes(" 的") && (text.includes("+") || text.includes("變為"))) activeAction[p] = markActionImpact(stats, activeAction[p], "pointMods");

    const op = pointValue(text, "OP");
    if (op !== null) {
      const source: OpSource | null = entry.event?.kind === "attack-op" ? "attack" : entry.event?.kind === "op-calc" ? entry.event.source : text.startsWith("攻擊 OP 算出") ? "attack" : null;
      addPoint(stats.op, op);
      if (source) addPoint(stats.opBySource[source], op);
      if (source === "attack") addPoint(stats.attackOp, op);
    }
    const dp = pointValue(text, "DP");
    if (dp !== null) addPoint(stats.dp, dp);

    if (text.startsWith("判定：")) {
      addDefense(stats.defense[currentRoute[p]], text.includes("成功"));
    }
  }

  return { players };
}

function logTail(state: GameState, count = 8): string[] {
  return state.log.slice(-count).map((entry) => {
    const player = entry.player === null ? "-" : `P${entry.player}`;
    return `S${entry.setNo}T${entry.turnNo} ${player} ${entry.text}`;
  });
}

function resultFromState(config: MatchConfig, state: GameState, outcome: MatchOutcome, steps: number, error?: string, playQuality?: readonly [PlayQualityStats, PlayQualityStats]): MatchResult {
  const winner = state.winner;
  const winnerPolicy = winner === null ? null : config.policies[winner];
  const lost = collectLostStats(state);
  return {
    seed: config.seed,
    decks: [config.decks[0].name, config.decks[1].name],
    policies: [config.policies[0], config.policies[1]],
    outcome,
    winner,
    winnerPolicy,
    steps,
    setNo: state.setNo,
    turnNo: state.turnNo,
    setResults: lost.setResults,
    averageRalliesPerSet: averageRallies(lost.setResults),
    lostBy: lost.lostBy,
    lostReasonsByPlayer: lost.lostReasonsByPlayer,
    stats: collectMatchStats(state, playQuality),
    invariants: [
      playerInvariant(state, 0, config.decks[0].ids.length),
      playerInvariant(state, 1, config.decks[1].ids.length),
    ],
    error,
    logTail: logTail(state),
  };
}

export function playBenchmarkMatch(config: MatchConfig): MatchResult {
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
  const randomByPlayer: [() => number, () => number] = [
    seededRnd(config.seed * 3 + 11),
    seededRnd(config.seed * 5 + 17),
  ];
  const playQuality: [PlayQualityStats, PlayQualityStats] = [blankPlayQualityStats(), blankPlayQualityStats()];

  let state: GameState;
  try {
    state = createGame(config.db, {
      seed: config.seed,
      decks: [config.decks[0].ids, config.decks[1].ids],
    });
  } catch (error) {
    const fallback = createGame(config.db, {
      seed: config.seed,
      decks: [config.decks[0].ids, config.decks[1].ids],
      skipDeckValidation: true,
    });
    return resultFromState(config, fallback, "error", 0, error instanceof Error ? error.message : String(error), playQuality);
  }

  for (let step = 0; step < maxSteps; step++) {
    if (state.phase === "gameOver") return resultFromState(config, state, "complete", step, undefined, playQuality);
    const pending = state.pendingDecision;
    if (!pending) return resultFromState(config, state, "error", step, "遊戲未結束但沒有 pendingDecision", playQuality);

    try {
      const player = pending.player as PlayerId;
      const decision = benchmarkPolicyDecision(config.policies[player], config.db, state, randomByPlayer, [config.decks[0].axes ?? [], config.decks[1].axes ?? []], [config.decks[0].ids, config.decks[1].ids]);
      recordPlayQualityDecision(config.db, state, decision, playQuality[player]);
      state = applyDecision(config.db, state, decision);
    } catch (error) {
      return resultFromState(config, state, "error", step, error instanceof Error ? error.message : String(error), playQuality);
    }
  }

  return resultFromState(config, state, "max-steps", maxSteps, `超過 maxSteps=${maxSteps}`, playQuality);
}

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

function summarizePlayQuality(matches: MatchResult[], player: PlayerId): PlayQualitySummary {
  const quality = blankPlayQualityStats();
  const op = blankPointStats();
  for (const match of matches) {
    const stats = match.stats.players[player];
    addPlayQualityStats(quality, stats.playQuality);
    op.count += stats.op.count;
    op.total += stats.op.total;
    op.max = Math.max(op.max, stats.op.max);
    op.highCount += stats.op.highCount;
  }
  const lowPointDeployOpportunities = quality.lowPointDeploy.toss.opportunities + quality.lowPointDeploy.attack.opportunities;
  const lowPointDeploys = quality.lowPointDeploy.toss.lowPointChoices + quality.lowPointDeploy.attack.lowPointChoices;
  const totalDeficit = quality.lowPointDeploy.toss.totalDeficit + quality.lowPointDeploy.attack.totalDeficit;
  const defenseSkillOpportunities = quality.defenseSkillNonUse.opportunities;
  const defenseSkillNonUses = quality.defenseSkillNonUse.nonUses;
  return {
    lowPointDeployOpportunities,
    lowPointDeploys,
    lowPointDeployRate: lowPointDeployOpportunities === 0 ? 0 : lowPointDeploys / lowPointDeployOpportunities,
    averageLowPointDeficit: lowPointDeploys === 0 ? 0 : totalDeficit / lowPointDeploys,
    defenseSkillOpportunities,
    defenseSkillNonUses,
    defenseSkillNonUseRate: defenseSkillOpportunities === 0 ? 0 : defenseSkillNonUses / defenseSkillOpportunities,
    averageOpPressure: op.count === 0 ? 0 : op.total / op.count,
    opPressureSamples: op.count,
  };
}

export function summarizeMatches(matches: MatchResult[]): BatchSummary {
  const completedMatches = matches.filter((match) => match.outcome === "complete");
  const winsByPlayer: [number, number] = [
    completedMatches.filter((match) => match.winner === 0).length,
    completedMatches.filter((match) => match.winner === 1).length,
  ];
  const winsByPolicy: Partial<Record<BenchmarkPolicyId, number>> = {};
  for (const match of completedMatches) {
    if (!match.winnerPolicy) continue;
    winsByPolicy[match.winnerPolicy] = (winsByPolicy[match.winnerPolicy] ?? 0) + 1;
  }
  const completed = completedMatches.length;
  const stepSum = completedMatches.reduce((sum, match) => sum + match.steps, 0);
  const setSum = completedMatches.reduce((sum, match) => sum + match.setNo, 0);
  const setResults = matches.flatMap((match) => match.setResults);
  const lostReasons: Partial<Record<LostReason, number>> = {};
  const setWinsByPlayer: [number, number] = [0, 0];
  const setWinsByReason: Partial<Record<LostReason, number>> = {};
  for (const result of setResults) {
    setWinsByPlayer[result.winner]++;
    setWinsByReason[result.lostReason] = (setWinsByReason[result.lostReason] ?? 0) + 1;
  }
  for (const match of matches) {
    for (const byPlayer of match.lostReasonsByPlayer) {
      for (const [reason, count] of Object.entries(byPlayer) as [LostReason, number][]) {
        lostReasons[reason] = (lostReasons[reason] ?? 0) + count;
      }
    }
  }
  return {
    total: matches.length,
    completed,
    errored: matches.filter((match) => match.outcome === "error").length,
    maxSteps: matches.filter((match) => match.outcome === "max-steps").length,
    winsByPlayer,
    winsByPolicy,
    player0WinRate: completed === 0 ? 0 : winsByPlayer[0] / completed,
    player0WinRate95: wilson(winsByPlayer[0], completed),
    averageSteps: completed === 0 ? 0 : stepSum / completed,
    averageSetNo: completed === 0 ? 0 : setSum / completed,
    averageRalliesPerSet: averageRallies(setResults),
    setWinsByPlayer,
    setWinsByReason,
    lostReasons,
    playQualityByPlayer: [summarizePlayQuality(matches, 0), summarizePlayQuality(matches, 1)],
  };
}

export function runBenchmarkBatch(config: BatchConfig): BatchReport {
  const matches = config.seeds.map((seed) => playBenchmarkMatch({ ...config, seed }));
  return {
    config: {
      decks: [config.decks[0].name, config.decks[1].name],
      deckCards: [[...config.decks[0].ids], [...config.decks[1].ids]],
      deckAxes: [config.decks[0].axes ?? [], config.decks[1].axes ?? []],
      policies: [config.policies[0], config.policies[1]],
      seeds: [...config.seeds],
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    },
    summary: summarizeMatches(matches),
    matches,
  };
}

export function mirroredSeeds(start: number, games: number): number[] {
  return Array.from({ length: games }, (_, index) => start + index);
}

function matrixPairs(decks: readonly BenchmarkDeckInput[], mode: MatrixMode): [BenchmarkDeckInput, BenchmarkDeckInput][] {
  if (decks.length < 2) throw new Error("matrix benchmark 至少需要兩副牌組");
  if (mode === "ring") return decks.map((deck, index) => [deck, decks[(index + 1) % decks.length]!]);
  const pairs: [BenchmarkDeckInput, BenchmarkDeckInput][] = [];
  for (let i = 0; i < decks.length; i++) {
    for (let j = 0; j < decks.length; j++) {
      if (i === j) continue;
      pairs.push([decks[i]!, decks[j]!]);
    }
  }
  return pairs;
}

function addCount<T extends string>(record: Partial<Record<T, number>>, key: T, amount = 1): void {
  record[key] = (record[key] ?? 0) + amount;
}

export function runBenchmarkMatrix(config: MatrixConfig): MatrixReport {
  const mode = config.mode ?? "ring";
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
  const pairs = matrixPairs(config.decks, mode).map((pair, pairIndex): MatrixPairReport => {
    const seedStart = config.seedStart + pairIndex * config.gamesPerPair;
    const report = runBenchmarkBatch({
      db: config.db,
      decks: pair,
      policies: config.policies,
      seeds: mirroredSeeds(seedStart, config.gamesPerPair),
      maxSteps,
    });
    return {
      ...report,
      pairIndex,
      axes: [pair[0].axes ?? [], pair[1].axes ?? []],
    };
  });

  const winsByPolicy: Partial<Record<BenchmarkPolicyId, number>> = {};
  const winsByDeck: Record<string, number> = {};
  const winsByAxis: Partial<Record<DeckAxis, number>> = {};
  const lostReasons: Partial<Record<LostReason, number>> = {};
  const setWinsByReason: Partial<Record<LostReason, number>> = {};
  let totalGames = 0;
  let completed = 0;
  let errored = 0;
  let maxStepsCount = 0;
  let rallyTotal = 0;
  let setTotal = 0;
  const playQualityMatches: [MatchResult[], MatchResult[]] = [[], []];

  for (const pair of pairs) {
    totalGames += pair.summary.total;
    completed += pair.summary.completed;
    errored += pair.summary.errored;
    maxStepsCount += pair.summary.maxSteps;
    rallyTotal += pair.summary.averageRalliesPerSet * pair.summary.setWinsByPlayer.reduce((sum, count) => sum + count, 0);
    setTotal += pair.summary.setWinsByPlayer.reduce((sum, count) => sum + count, 0);
    for (const [policy, wins] of Object.entries(pair.summary.winsByPolicy) as [BenchmarkPolicyId, number][]) {
      addCount(winsByPolicy, policy, wins);
    }
    for (const [reason, count] of Object.entries(pair.summary.lostReasons) as [LostReason, number][]) {
      addCount(lostReasons, reason, count);
    }
    for (const [reason, count] of Object.entries(pair.summary.setWinsByReason) as [LostReason, number][]) {
      addCount(setWinsByReason, reason, count);
    }
    for (const match of pair.matches) {
      playQualityMatches[0].push(match);
      playQualityMatches[1].push(match);
      if (match.outcome !== "complete" || match.winner === null) continue;
      const winnerDeck = match.decks[match.winner]!;
      winsByDeck[winnerDeck] = (winsByDeck[winnerDeck] ?? 0) + 1;
      for (const axis of pair.axes[match.winner]) addCount(winsByAxis, axis);
    }
  }

  return {
    config: {
      mode,
      policies: [config.policies[0], config.policies[1]],
      seedStart: config.seedStart,
      gamesPerPair: config.gamesPerPair,
      maxSteps,
    },
    summary: {
      pairs: pairs.length,
      totalGames,
      completed,
      errored,
      maxSteps: maxStepsCount,
      winsByPolicy,
      winsByDeck,
      winsByAxis,
      averageRalliesPerSet: setTotal === 0 ? 0 : rallyTotal / setTotal,
      setWinsByReason,
      lostReasons,
      playQualityByPlayer: [summarizePlayQuality(playQualityMatches[0], 0), summarizePlayQuality(playQualityMatches[1], 1)],
    },
    pairs,
  };
}

export function swapPlayers(config: BatchConfig): BatchConfig {
  return {
    ...config,
    decks: [config.decks[1], config.decks[0]],
    policies: [config.policies[1], config.policies[0]],
  };
}

export function opponentOf(player: PlayerId): PlayerId {
  return other(player);
}
