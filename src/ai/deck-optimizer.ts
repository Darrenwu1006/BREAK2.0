import type { CardDb } from "../engine/types";
import type { AnalyzerMetrics, AnalyzerPreset, DeckAnalyzerComparisonReport } from "./deck-analyzer";
import type { BenchmarkDeckInput, BenchmarkPolicyId } from "./benchmark";

export const DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION = "m8-deck-optimizer-proposal-v1";
export const DECK_OPTIMIZER_VERSION = "m8-c1-4-candidate-evaluator";

export type DeckOptimizerObjectiveProfile = "serve" | "block" | "burst" | "defense" | "hybrid" | "preserve-current";
export type DeckOptimizerProposalStatus = "draft" | "candidate" | "validated" | "rejected";

export interface DeckOptimizerCardCount {
  id: string;
  count: number;
  printing?: string;
}

export interface DeckOptimizerLockedCard {
  id: string;
  minCount: number;
}

export interface DeckOptimizerConstraints {
  lockedCards?: readonly DeckOptimizerLockedCard[];
  bannedCards?: readonly string[];
  maxEvents?: number;
  deckSize?: number;
}

export interface DeckOptimizerEvaluationConfig {
  opponents: readonly string[];
  policy: BenchmarkPolicyId;
  opponentPolicy: BenchmarkPolicyId;
  preset: AnalyzerPreset;
  gamesPerSeat?: number;
  seedStart?: number;
  maxSteps?: number;
}

export interface DeckOptimizerChange {
  cardId: string;
  cardName: string;
  before: number;
  after: number;
  delta: number;
  reason: string;
}

export interface DeckOptimizerDeltas {
  matchWinRateDelta?: number;
  setWinRateDelta?: number;
  noDeployLossDelta?: number;
  judgeFailLossDelta?: number;
  paidGutsDelta?: number;
  eventEffectiveRateDelta?: number;
}

export interface DeckOptimizerScore {
  value: number;
  components: Record<string, number>;
}

export interface DeckOptimizerProposal {
  schemaVersion: typeof DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION;
  generatedAt: string;
  optimizerVersion: string;
  sourceDeck: string;
  sourceDeckCards: readonly DeckOptimizerCardCount[];
  candidateDeckCards: readonly DeckOptimizerCardCount[];
  changes: readonly DeckOptimizerChange[];
  lockedCards: readonly DeckOptimizerLockedCard[];
  bannedCards: readonly string[];
  cardPool?: DeckOptimizerCardPoolSnapshot;
  generationConfig?: DeckOptimizerGenerationConfig;
  validation?: DeckOptimizerValidationMatrix;
  objectiveProfile?: DeckOptimizerObjectiveProfile;
  evaluationConfig: DeckOptimizerEvaluationConfig;
  baselineMetrics: AnalyzerMetrics | null;
  candidateMetrics: AnalyzerMetrics | null;
  deltas: DeckOptimizerDeltas;
  score: DeckOptimizerScore | null;
  rationale: readonly string[];
  risks: readonly string[];
  status: DeckOptimizerProposalStatus;
}

export interface CreateDeckOptimizerProposalScaffoldConfig {
  db: CardDb;
  sourceDeck: BenchmarkDeckInput;
  constraints?: DeckOptimizerConstraints;
  evaluationConfig: DeckOptimizerEvaluationConfig;
  objectiveProfile?: DeckOptimizerObjectiveProfile;
  generatedAt?: string;
  extraRationale?: readonly string[];
  cardPool?: OptimizerCardPool;
  generationConfig?: DeckOptimizerGenerationConfig;
}

export interface CreateDeckOptimizerCandidateProposalConfig extends CreateDeckOptimizerProposalScaffoldConfig {
  cardPool: OptimizerCardPool;
  maxReplacements?: number;
}

export interface DeckOptimizerCardPoolSnapshot {
  schools: readonly string[];
  poolIds: readonly string[];
  crossSchoolAllowed: readonly string[];
}

export interface DeckOptimizerGenerationConfig {
  strategy: "none" | "static-coverage-v1";
  maxReplacements?: number;
  autoLock?: boolean;
  allow?: readonly string[];
  allowSchools?: readonly string[];
  unlock?: readonly string[];
}

export interface DeckOptimizerGeneratedCandidate {
  candidateDeckCards: readonly DeckOptimizerCardCount[];
  changes: readonly DeckOptimizerChange[];
  rationale: readonly string[];
  risks: readonly string[];
}

export interface DeckOptimizerValidationMatrixRunInput {
  label: "formal" | "holdout";
  preset: AnalyzerPreset;
  gamesPerSeat: number;
  seedStart: number;
  report: DeckAnalyzerComparisonReport;
}

export interface DeckOptimizerValidationMatrixRun {
  label: "formal" | "holdout";
  preset: AnalyzerPreset;
  gamesPerSeat: number;
  seedStart: number;
  status: DeckOptimizerProposalStatus;
  deltas: DeckOptimizerDeltas;
  score: DeckOptimizerScore;
  notes: readonly string[];
}

export interface DeckOptimizerValidationMatrix {
  strategy: "formal-holdout-v1";
  generatedAt: string;
  verdict: "validated" | "rejected" | "needs-review";
  runs: readonly DeckOptimizerValidationMatrixRun[];
  rationale: readonly string[];
}

interface CandidateStep {
  removeId: string;
  addId: string;
  reason: string;
}

export type DeckOptimizerValidationCode =
  | "schema-version"
  | "deck-size"
  | "event-limit"
  | "unknown-card"
  | "invalid-count"
  | "locked-card"
  | "banned-card"
  | "change-mismatch";

export interface DeckOptimizerValidationIssue {
  code: DeckOptimizerValidationCode;
  message: string;
  cardId?: string;
  expected?: number | string;
  actual?: number | string;
}

export interface DeckOptimizerValidationResult {
  ok: boolean;
  issues: DeckOptimizerValidationIssue[];
}

const DEFAULT_DECK_SIZE = 40;
const DEFAULT_MAX_EVENTS = 8;
const DEFAULT_MAX_REPLACEMENTS = 2;
const MAX_REPLACEMENTS_CAP = 4;
const OPTIMIZER_AREAS = ["serve", "block", "receive", "toss", "attack"] as const;

type OptimizerArea = typeof OPTIMIZER_AREAS[number];

function displayName(db: CardDb, id: string): string {
  const card = db.get(id);
  return card?.nameZh || card?.nameJa || id;
}

function issue(input: DeckOptimizerValidationIssue): DeckOptimizerValidationIssue {
  return input;
}

export function deckOptimizerCardCounts(cards: readonly DeckOptimizerCardCount[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of cards) counts.set(entry.id, (counts.get(entry.id) ?? 0) + entry.count);
  return counts;
}

export function deckOptimizerCardsFromIds(ids: readonly string[]): DeckOptimizerCardCount[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id));
}

export function deckOptimizerIdsFromCards(cards: readonly DeckOptimizerCardCount[]): string[] {
  return cards.flatMap((entry) => Array(entry.count).fill(entry.id) as string[]);
}

export function deckOptimizerTotalCards(cards: readonly DeckOptimizerCardCount[]): number {
  return cards.reduce((sum, entry) => sum + entry.count, 0);
}

export function deckOptimizerEventCount(db: CardDb, cards: readonly DeckOptimizerCardCount[]): number {
  return cards.reduce((sum, entry) => sum + (db.get(entry.id)?.type === "EVENT" ? entry.count : 0), 0);
}

const DEFAULT_AUTO_LOCK_MIN_COUNT = 4;

export interface OptimizerCardPool {
  schools: string[];
  poolIds: string[];
  crossSchoolAllowed: string[];
}

export interface ResolveCardPoolOptions {
  allow?: readonly string[];
  /** 整校納入候選：列出的所屬（學校）名稱，其全部卡片都進候選卡池。混校構築常見，故開放整校允許。 */
  allowSchools?: readonly string[];
  banned?: readonly string[];
  schools?: readonly string[];
}

/**
 * [Codex 2026-06-20] C3d 卡池標註：同校卡池只是 optimizer 的「預設搜尋啟發」，用來縮小候選空間，
 * 不是遊戲合法性限制。本作組卡自由、混校構築常見；除非技能文字明確綁定所屬，否則跨校候選完全合法，
 * 可用 --allow（單卡或整校）納入。
 */
export const CARD_POOL_HEURISTIC_NOTE =
  "同校卡池僅為預設搜尋啟發，非合法性限制；混校構築合法，跨校候選請用 --allow（可指定單卡或整校）。";

export interface AutoLockOptions {
  minCount?: number;
  unlock?: readonly string[];
  explicit?: readonly DeckOptimizerLockedCard[];
}

function areaValue(db: CardDb, id: string, area: OptimizerArea): number {
  const value = db.get(id)?.params?.[area];
  return typeof value === "number" ? value : 0;
}

function isPlayable(db: CardDb, id: string, area: OptimizerArea): boolean {
  return db.get(id)?.params?.[area] !== null && db.get(id)?.params?.[area] !== undefined;
}

function countByArea(db: CardDb, cards: readonly DeckOptimizerCardCount[]): Record<OptimizerArea, number> {
  const counts = { serve: 0, block: 0, receive: 0, toss: 0, attack: 0 };
  for (const entry of cards) {
    for (const area of OPTIMIZER_AREAS) {
      if (isPlayable(db, entry.id, area)) counts[area] += entry.count;
    }
  }
  return counts;
}

function objectiveWeights(objective: DeckOptimizerObjectiveProfile | undefined, cards: readonly DeckOptimizerCardCount[], db: CardDb): Record<OptimizerArea, number> {
  const base: Record<OptimizerArea, number> = objective === "serve"
    ? { serve: 2.4, block: 0.9, receive: 1.0, toss: 0.8, attack: 1.3 }
    : objective === "block"
      ? { serve: 0.8, block: 2.5, receive: 1.3, toss: 0.8, attack: 1.0 }
      : objective === "burst"
        ? { serve: 1.0, block: 0.8, receive: 0.9, toss: 1.4, attack: 2.5 }
        : objective === "defense"
          ? { serve: 0.8, block: 1.5, receive: 2.5, toss: 1.0, attack: 0.9 }
          : objective === "hybrid"
            ? { serve: 1.2, block: 1.2, receive: 1.4, toss: 1.2, attack: 1.4 }
            : { serve: 1.1, block: 1.1, receive: 1.2, toss: 1.1, attack: 1.2 };

  const areaCounts = countByArea(db, cards);
  for (const area of OPTIMIZER_AREAS) {
    if (areaCounts[area] < 8) base[area] += 1.1;
    else if (areaCounts[area] < 10) base[area] += 0.45;
  }
  return base;
}

function cardRoleScore(db: CardDb, id: string, weights: Record<OptimizerArea, number>): number {
  const card = db.get(id);
  if (!card) return -Infinity;
  if (card.type === "EVENT") return card.effectStatus === "dsl" || card.effectStatus === "script" ? 0.7 : 0.25;
  let score = 0;
  for (const area of OPTIMIZER_AREAS) {
    const value = areaValue(db, id, area);
    if (value > 0) score += value * weights[area];
  }
  if (card.effectStatus === "dsl" || card.effectStatus === "script") score += 0.55;
  return score;
}

function clampReplacementCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_REPLACEMENTS;
  if (!Number.isInteger(value) || value <= 0) throw new Error("--max-replacements 必須是正整數");
  return Math.min(value, MAX_REPLACEMENTS_CAP);
}

function sortCards(cards: Map<string, number>): DeckOptimizerCardCount[] {
  return [...cards.entries()]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function replacementCopyCount(steps: readonly CandidateStep[]): number {
  return steps.length;
}

function replacementDeltaCount(changes: readonly DeckOptimizerChange[]): number {
  return changes.reduce((sum, change) => sum + Math.max(0, change.delta), 0);
}

/** 牌組出現過的所有所屬（學校）。用來界定「同校」候選卡池。 */
export function deckSchools(db: CardDb, deckIds: readonly string[]): string[] {
  const schools = new Set<string>();
  for (const id of new Set(deckIds)) {
    for (const affiliation of db.get(id)?.affiliations ?? []) schools.add(affiliation);
  }
  return [...schools].sort((a, b) => a.localeCompare(b));
}

/**
 * 解析候選卡池：預設同校卡 + 牌組已使用卡；`allow` 明確允許跨校候選；`banned` 直接排除。
 * proposal-only 邊界：此函式只決定「可考慮換入哪些卡」，不產生候選、不寫回牌組。
 */
export function resolveOptimizerCardPool(
  db: CardDb,
  deckIds: readonly string[],
  options: ResolveCardPoolOptions = {},
): OptimizerCardPool {
  const schools = options.schools ?? deckSchools(db, deckIds);
  const schoolSet = new Set(schools);
  const inDeck = new Set(deckIds);
  const allow = new Set(options.allow ?? []);
  const allowSchools = new Set(options.allowSchools ?? []);
  const banned = new Set(options.banned ?? []);
  const poolIds: string[] = [];
  const crossSchoolAllowed: string[] = [];

  for (const [id, card] of db) {
    if (banned.has(id)) continue;
    const affiliations = card.affiliations ?? [];
    const sameSchool = affiliations.some((affiliation) => schoolSet.has(affiliation));
    const allowedBySchool = affiliations.some((affiliation) => allowSchools.has(affiliation));
    const allowed = allow.has(id) || allowedBySchool;
    if (inDeck.has(id) || sameSchool || allowed) poolIds.push(id);
    if (allowed && !sameSchool && !inDeck.has(id)) crossSchoolAllowed.push(id);
  }

  return {
    schools: [...schoolSet].sort((a, b) => a.localeCompare(b)),
    poolIds: poolIds.sort((a, b) => a.localeCompare(b)),
    crossSchoolAllowed: crossSchoolAllowed.sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * 自動鎖定核心卡：張數 >= `minCount`（預設 4）的卡視為牌組骨幹，鎖定最低保留張數 ceil(count/2)，
 * 避免 optimizer 把 deck identity 一次抽乾。`unlock` 可解除自動鎖定；`explicit`（CLI --locked）優先覆蓋。
 */
export function autoLockCoreCards(
  db: CardDb,
  deckIds: readonly string[],
  options: AutoLockOptions = {},
): DeckOptimizerLockedCard[] {
  const threshold = options.minCount ?? DEFAULT_AUTO_LOCK_MIN_COUNT;
  const unlock = new Set(options.unlock ?? []);
  const counts = new Map<string, number>();
  for (const id of deckIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  const locks = new Map<string, number>();
  for (const [id, count] of counts) {
    if (unlock.has(id)) continue;
    if (count >= threshold) locks.set(id, Math.max(1, Math.ceil(count / 2)));
  }
  for (const explicit of options.explicit ?? []) locks.set(explicit.id, explicit.minCount);

  return [...locks.entries()]
    .map(([id, minCount]) => ({ id, minCount }))
    .sort((a, b) => displayName(db, a.id).localeCompare(displayName(db, b.id)) || a.id.localeCompare(b.id));
}

export function generateDeckOptimizerCandidate(
  db: CardDb,
  sourceDeckCards: readonly DeckOptimizerCardCount[],
  cardPool: OptimizerCardPool,
  constraints: DeckOptimizerConstraints = {},
  objectiveProfile: DeckOptimizerObjectiveProfile = "preserve-current",
  maxReplacementsInput?: number,
): DeckOptimizerGeneratedCandidate {
  const maxReplacements = clampReplacementCount(maxReplacementsInput);
  const banned = new Set(constraints.bannedCards ?? []);
  const locked = new Map((constraints.lockedCards ?? []).map((entry) => [entry.id, entry.minCount]));
  const candidate = deckOptimizerCardCounts(sourceDeckCards);
  const poolIds = [...new Set(cardPool.poolIds)].filter((id) => !banned.has(id) && db.has(id));
  const steps: CandidateStep[] = [];
  const rationale: string[] = [];
  const risks: string[] = [];

  for (let step = 0; step < maxReplacements; step++) {
    const currentCards = sortCards(candidate);
    const weights = objectiveWeights(objectiveProfile, currentCards, db);
    const eventCount = deckOptimizerEventCount(db, currentCards);
    const removable = [...candidate.entries()]
      .filter(([, count]) => count > 0)
      .map(([id, count]) => {
        const card = db.get(id);
        const minCount = locked.get(id) ?? 0;
        if (count <= minCount) return null;
        const isBanned = banned.has(id);
        const overLimitEvent = card?.type === "EVENT" && eventCount >= (constraints.maxEvents ?? DEFAULT_MAX_EVENTS);
        const duplicatePressure = Math.max(0, count - 3) * 0.75;
        const roleValue = cardRoleScore(db, id, weights);
        const eventPenalty = card?.type === "EVENT" ? 1.2 : 0;
        const score = (isBanned ? 1000 : 0) + (overLimitEvent ? 3 : 0) + duplicatePressure + eventPenalty - roleValue * 0.18;
        return { id, score, count };
      })
      .filter((entry): entry is { id: string; score: number; count: number } => !!entry)
      .sort((a, b) => b.score - a.score || b.count - a.count || a.id.localeCompare(b.id));

    if (removable.length === 0) break;
    const remove = removable[0]!;
    candidate.set(remove.id, (candidate.get(remove.id) ?? 0) - 1);
    const afterCutCards = sortCards(candidate);
    const afterCutEventCount = deckOptimizerEventCount(db, afterCutCards);
    const afterCutWeights = objectiveWeights(objectiveProfile, afterCutCards, db);
    const addable = poolIds
      .map((id) => {
        const card = db.get(id);
        if (!card) return null;
        const currentCount = candidate.get(id) ?? 0;
        if (banned.has(id)) return null;
        if (card.type === "EVENT" && afterCutEventCount >= (constraints.maxEvents ?? DEFAULT_MAX_EVENTS)) return null;
        const newCardBonus = currentCount === 0 ? 0.5 : 0;
        const countPenalty = Math.max(0, currentCount - 2) * 0.45;
        const score = cardRoleScore(db, id, afterCutWeights) + newCardBonus - countPenalty;
        return { id, score, currentCount };
      })
      .filter((entry): entry is { id: string; score: number; currentCount: number } => !!entry)
      .sort((a, b) => b.score - a.score || a.currentCount - b.currentCount || a.id.localeCompare(b.id));

    const add = addable.find((entry) => entry.id !== remove.id);
    if (!add) {
      candidate.set(remove.id, (candidate.get(remove.id) ?? 0) + 1);
      break;
    }
    candidate.set(add.id, (candidate.get(add.id) ?? 0) + 1);
    steps.push({
      removeId: remove.id,
      addId: add.id,
      reason: `${displayName(db, remove.id)} -1 / ${displayName(db, add.id)} +1：以 ${objectiveProfile} 目標補強靜態角色覆蓋`,
    });
  }

  const candidateDeckCards = sortCards(candidate);
  const changes = buildDeckOptimizerChanges(db, sourceDeckCards, candidateDeckCards, "static coverage v1");
  const result = validateDeckConstraints(db, candidateDeckCards, constraints);
  if (!result.ok) throw new Error(result.issues.map((entry) => entry.message).join("; "));
  if (changes.length === 0) risks.push("靜態候選生成器沒有找到合法且值得替換的 1 張卡，proposal 維持原始牌組。");
  else {
    rationale.push(`C1-3b static coverage v1：完成 ${replacementCopyCount(steps)} 張小幅替換，尚未視為正式調牌結論。`);
    rationale.push(...steps.map((entry) => entry.reason));
  }
  risks.push("C1-3b 只看靜態牌組覆蓋與事件上限；仍需 C1-4 / C2 用對局模擬確認。");

  return {
    candidateDeckCards,
    changes,
    rationale,
    risks,
  };
}

export function buildDeckOptimizerChanges(
  db: CardDb,
  sourceDeckCards: readonly DeckOptimizerCardCount[],
  candidateDeckCards: readonly DeckOptimizerCardCount[],
  reason = "count changed",
): DeckOptimizerChange[] {
  const source = deckOptimizerCardCounts(sourceDeckCards);
  const candidate = deckOptimizerCardCounts(candidateDeckCards);
  const ids = [...new Set([...source.keys(), ...candidate.keys()])].sort((a, b) => displayName(db, a).localeCompare(displayName(db, b)) || a.localeCompare(b));
  return ids.flatMap((cardId) => {
    const before = source.get(cardId) ?? 0;
    const after = candidate.get(cardId) ?? 0;
    if (before === after) return [];
    return [{ cardId, cardName: displayName(db, cardId), before, after, delta: after - before, reason }];
  });
}

export function validateDeckConstraints(
  db: CardDb,
  cards: readonly DeckOptimizerCardCount[],
  constraints: DeckOptimizerConstraints = {},
): DeckOptimizerValidationResult {
  const deckSize = constraints.deckSize ?? DEFAULT_DECK_SIZE;
  const maxEvents = constraints.maxEvents ?? DEFAULT_MAX_EVENTS;
  const issues: DeckOptimizerValidationIssue[] = [];
  const counts = deckOptimizerCardCounts(cards);

  for (const entry of cards) {
    if (!Number.isInteger(entry.count) || entry.count < 0) {
      issues.push(issue({
        code: "invalid-count",
        cardId: entry.id,
        message: `${entry.id} 的張數必須是非負整數`,
        actual: entry.count,
      }));
    }
    if (entry.count > 0 && !db.has(entry.id)) {
      issues.push(issue({
        code: "unknown-card",
        cardId: entry.id,
        message: `牌組引用了不存在的卡片 ${entry.id}`,
      }));
    }
  }

  const total = deckOptimizerTotalCards(cards);
  if (total !== deckSize) {
    issues.push(issue({
      code: "deck-size",
      message: `候選牌組必須正好 ${deckSize} 張`,
      expected: deckSize,
      actual: total,
    }));
  }

  const events = deckOptimizerEventCount(db, cards);
  if (events > maxEvents) {
    issues.push(issue({
      code: "event-limit",
      message: `事件卡不可超過 ${maxEvents} 張`,
      expected: maxEvents,
      actual: events,
    }));
  }

  for (const locked of constraints.lockedCards ?? []) {
    const actual = counts.get(locked.id) ?? 0;
    if (actual < locked.minCount) {
      issues.push(issue({
        code: "locked-card",
        cardId: locked.id,
        message: `${displayName(db, locked.id)} 是鎖定核心卡，至少需保留 ${locked.minCount} 張`,
        expected: locked.minCount,
        actual,
      }));
    }
  }

  for (const bannedId of constraints.bannedCards ?? []) {
    const actual = counts.get(bannedId) ?? 0;
    if (actual > 0) {
      issues.push(issue({
        code: "banned-card",
        cardId: bannedId,
        message: `${displayName(db, bannedId)} 被列為不可加入卡`,
        expected: 0,
        actual,
      }));
    }
  }

  return { ok: issues.length === 0, issues };
}

function changeKey(change: DeckOptimizerChange): string {
  return `${change.cardId}:${change.before}:${change.after}:${change.delta}`;
}

export function validateDeckOptimizerProposal(db: CardDb, proposal: DeckOptimizerProposal): DeckOptimizerValidationResult {
  const issues: DeckOptimizerValidationIssue[] = [];
  if (proposal.schemaVersion !== DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION) {
    issues.push(issue({
      code: "schema-version",
      message: `proposal schemaVersion 必須是 ${DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION}`,
      expected: DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION,
      actual: proposal.schemaVersion,
    }));
  }

  issues.push(...validateDeckConstraints(db, proposal.sourceDeckCards).issues);
  issues.push(...validateDeckConstraints(db, proposal.candidateDeckCards, {
    lockedCards: proposal.lockedCards,
    bannedCards: proposal.bannedCards,
  }).issues);

  const expectedChanges = buildDeckOptimizerChanges(db, proposal.sourceDeckCards, proposal.candidateDeckCards);
  const expectedKeys = new Set(expectedChanges.map(changeKey));
  const actualKeys = new Set(proposal.changes.map(changeKey));
  const missing = [...expectedKeys].filter((key) => !actualKeys.has(key));
  const extra = [...actualKeys].filter((key) => !expectedKeys.has(key));
  if (missing.length > 0 || extra.length > 0) {
    issues.push(issue({
      code: "change-mismatch",
      message: "proposal changes 必須完整反映 sourceDeckCards 與 candidateDeckCards 的張數差異",
      expected: missing.join(", ") || "no missing changes",
      actual: extra.join(", ") || "no extra changes",
    }));
  }

  return { ok: issues.length === 0, issues };
}

export function assertValidDeckOptimizerProposal(db: CardDb, proposal: DeckOptimizerProposal): void {
  const result = validateDeckOptimizerProposal(db, proposal);
  if (!result.ok) throw new Error(result.issues.map((entry) => entry.message).join("; "));
}

function snapshotCardPool(cardPool: OptimizerCardPool | undefined): DeckOptimizerCardPoolSnapshot | undefined {
  if (!cardPool) return undefined;
  return {
    schools: [...cardPool.schools],
    poolIds: [...cardPool.poolIds],
    crossSchoolAllowed: [...cardPool.crossSchoolAllowed],
  };
}

export function createDeckOptimizerProposalScaffold(config: CreateDeckOptimizerProposalScaffoldConfig): DeckOptimizerProposal {
  const sourceDeckCards = deckOptimizerCardsFromIds(config.sourceDeck.ids);
  const lockedCards = [...(config.constraints?.lockedCards ?? [])];
  const bannedCards = [...(config.constraints?.bannedCards ?? [])];
  const proposal: DeckOptimizerProposal = {
    schemaVersion: DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION,
    generatedAt: config.generatedAt ?? new Date().toISOString(),
    optimizerVersion: DECK_OPTIMIZER_VERSION,
    sourceDeck: config.sourceDeck.name,
    sourceDeckCards,
    candidateDeckCards: sourceDeckCards,
    changes: [],
    lockedCards,
    bannedCards,
    cardPool: snapshotCardPool(config.cardPool),
    generationConfig: config.generationConfig,
    objectiveProfile: config.objectiveProfile ?? "preserve-current",
    evaluationConfig: config.evaluationConfig,
    baselineMetrics: null,
    candidateMetrics: null,
    deltas: {},
    score: null,
    rationale: [
      "C1-3a scaffold only: 候選牌組暫時維持原始牌組，尚未產生自動換卡。",
      ...(config.extraRationale ?? []),
    ],
    risks: [
      "尚未跑 Phase B benchmark，也尚未計算勝率或穩定度差異；不可把此 draft 視為正式調牌建議。",
    ],
    status: "draft",
  };
  assertValidDeckOptimizerProposal(config.db, proposal);
  return proposal;
}

export function createDeckOptimizerCandidateProposal(config: CreateDeckOptimizerCandidateProposalConfig): DeckOptimizerProposal {
  const sourceDeckCards = deckOptimizerCardsFromIds(config.sourceDeck.ids);
  const lockedCards = [...(config.constraints?.lockedCards ?? [])];
  const bannedCards = [...(config.constraints?.bannedCards ?? [])];
  const generated = generateDeckOptimizerCandidate(
    config.db,
    sourceDeckCards,
    config.cardPool,
    { ...config.constraints, lockedCards, bannedCards },
    config.objectiveProfile ?? "preserve-current",
    config.maxReplacements,
  );
  const proposal: DeckOptimizerProposal = {
    schemaVersion: DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION,
    generatedAt: config.generatedAt ?? new Date().toISOString(),
    optimizerVersion: DECK_OPTIMIZER_VERSION,
    sourceDeck: config.sourceDeck.name,
    sourceDeckCards,
    candidateDeckCards: generated.candidateDeckCards,
    changes: generated.changes,
    lockedCards,
    bannedCards,
    cardPool: snapshotCardPool(config.cardPool),
    generationConfig: {
      ...config.generationConfig,
      strategy: "static-coverage-v1",
      maxReplacements: clampReplacementCount(config.maxReplacements),
    },
    objectiveProfile: config.objectiveProfile ?? "preserve-current",
    evaluationConfig: config.evaluationConfig,
    baselineMetrics: null,
    candidateMetrics: null,
    deltas: {},
    score: null,
    rationale: [...generated.rationale, ...(config.extraRationale ?? [])],
    risks: generated.risks,
    status: "draft",
  };
  assertValidDeckOptimizerProposal(config.db, proposal);
  return proposal;
}

export function scoreDeckOptimizerComparison(report: DeckAnalyzerComparisonReport, proposal: DeckOptimizerProposal): Pick<DeckOptimizerProposal, "baselineMetrics" | "candidateMetrics" | "deltas" | "score" | "status"> {
  const baseline = report.base.aggregate;
  const candidate = report.candidate.aggregate;
  const deltas: DeckOptimizerDeltas = {
    matchWinRateDelta: candidate.winRate - baseline.winRate,
    setWinRateDelta: candidate.setWinRate - baseline.setWinRate,
    noDeployLossDelta: baseline.noDeployLossRate - candidate.noDeployLossRate,
    judgeFailLossDelta: baseline.judgeFailLossRate - candidate.judgeFailLossRate,
    paidGutsDelta: baseline.paidGutsPerMatch - candidate.paidGutsPerMatch,
    eventEffectiveRateDelta: candidate.eventEffectiveRate - baseline.eventEffectiveRate,
  };
  const changedCopies = replacementDeltaCount(proposal.changes);
  const deckIdentityPenalty = changedCopies * 0.35;
  const sampleUncertaintyPenalty = ((baseline.winRate95.high - baseline.winRate95.low) + (candidate.winRate95.high - candidate.winRate95.low)) * 0.5;
  const components = {
    matchWinRate: 40 * (deltas.matchWinRateDelta ?? 0),
    setWinRate: 20 * (deltas.setWinRateDelta ?? 0),
    noDeployLossImprovement: 18 * (deltas.noDeployLossDelta ?? 0),
    judgeFailLossImprovement: 10 * (deltas.judgeFailLossDelta ?? 0),
    paidGutsReduction: 4 * (deltas.paidGutsDelta ?? 0),
    eventEffectiveRate: 6 * (deltas.eventEffectiveRateDelta ?? 0),
    deckIdentityPenalty: -deckIdentityPenalty,
    sampleUncertaintyPenalty: -sampleUncertaintyPenalty,
  };
  const value = Object.values(components).reduce((sum, item) => sum + item, 0);
  const status: DeckOptimizerProposalStatus = value > 0.35 && (deltas.matchWinRateDelta ?? 0) >= -0.02
    ? "candidate"
    : value < -0.35
      ? "rejected"
      : "draft";
  return {
    baselineMetrics: baseline,
    candidateMetrics: candidate,
    deltas,
    score: { value, components },
    status,
  };
}

export function attachDeckOptimizerEvaluation(proposal: DeckOptimizerProposal, report: DeckAnalyzerComparisonReport): DeckOptimizerProposal {
  const evaluation = scoreDeckOptimizerComparison(report, proposal);
  return {
    ...proposal,
    ...evaluation,
    rationale: [
      ...proposal.rationale,
      `C1-4 evaluation：${report.comparison.notes.join("；")}；score=${evaluation.score?.value.toFixed(2) ?? "n/a"}。`,
    ],
    risks: [
      ...proposal.risks,
      report.comparison.verdict === "too-close" ? "本次樣本差距太小，建議用 formal 或 holdout preset 複測。" : "本次評估仍可能受 seed 與 heuristic 對手池影響，不能視為唯一構築真理。",
    ],
  };
}

export function buildDeckOptimizerValidationMatrix(
  proposal: DeckOptimizerProposal,
  runs: readonly DeckOptimizerValidationMatrixRunInput[],
  generatedAt = new Date().toISOString(),
): DeckOptimizerValidationMatrix {
  const scoredRuns: DeckOptimizerValidationMatrixRun[] = runs.map((run) => {
    const scored = scoreDeckOptimizerComparison(run.report, proposal);
    return {
      label: run.label,
      preset: run.preset,
      gamesPerSeat: run.gamesPerSeat,
      seedStart: run.seedStart,
      status: scored.status,
      deltas: scored.deltas,
      score: scored.score!,
      notes: run.report.comparison.notes,
    };
  });
  const hardRejected = scoredRuns.some((run) => run.status === "rejected" || (run.deltas.matchWinRateDelta ?? 0) < -0.03 || run.score.value < -0.35);
  const hasPositiveSignal = scoredRuns.some((run) => run.status === "candidate" || run.score.value > 0.35);
  const holdout = scoredRuns.find((run) => run.label === "holdout");
  const holdoutStable = !holdout || ((holdout.deltas.matchWinRateDelta ?? 0) >= -0.02 && holdout.score.value >= -0.35);
  const verdict: DeckOptimizerValidationMatrix["verdict"] = hardRejected
    ? "rejected"
    : hasPositiveSignal && holdoutStable
      ? "validated"
      : "needs-review";
  const rationale = [
    `C2 formal/holdout validation：${scoredRuns.map((run) => `${run.label}=${run.status} score=${run.score.value.toFixed(2)}`).join("；")}。`,
    verdict === "validated"
      ? "formal 與 holdout 沒有明顯回落，proposal 可進入 validated 候選。"
      : verdict === "rejected"
        ? "至少一組驗證明顯回落，proposal 不建議採用。"
        : "formal/holdout 沒有足夠一致訊號，建議增加樣本或調整候選。 後續不要把 needs-review 當成 validated。",
  ];
  return {
    strategy: "formal-holdout-v1",
    generatedAt,
    verdict,
    runs: scoredRuns,
    rationale,
  };
}

export function attachDeckOptimizerValidationMatrix(
  proposal: DeckOptimizerProposal,
  runs: readonly DeckOptimizerValidationMatrixRunInput[],
  generatedAt = new Date().toISOString(),
): DeckOptimizerProposal {
  const validation = buildDeckOptimizerValidationMatrix(proposal, runs, generatedAt);
  const status: DeckOptimizerProposalStatus = validation.verdict === "validated"
    ? "validated"
    : validation.verdict === "rejected"
      ? "rejected"
      : proposal.status;
  return {
    ...proposal,
    validation,
    status,
    rationale: [...proposal.rationale, ...validation.rationale],
    risks: validation.verdict === "validated"
      ? [...proposal.risks, "validated 只代表通過目前 formal/holdout 對手池；若卡池策略或對手池改變仍需重跑。"]
      : [...proposal.risks, "C2 未通過 validated，請不要直接採用此構築。"],
  };
}
