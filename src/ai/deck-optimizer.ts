import type { CardDb } from "../engine/types";
import type { AnalyzerMetrics, AnalyzerPreset } from "./deck-analyzer";
import type { BenchmarkDeckInput, BenchmarkPolicyId } from "./benchmark";

export const DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION = "m8-deck-optimizer-proposal-v1";
export const DECK_OPTIMIZER_VERSION = "m8-c1-3a-pool-autolock";

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
  banned?: readonly string[];
}

export interface AutoLockOptions {
  minCount?: number;
  unlock?: readonly string[];
  explicit?: readonly DeckOptimizerLockedCard[];
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
  const schools = deckSchools(db, deckIds);
  const schoolSet = new Set(schools);
  const inDeck = new Set(deckIds);
  const allow = new Set(options.allow ?? []);
  const banned = new Set(options.banned ?? []);
  const poolIds: string[] = [];
  const crossSchoolAllowed: string[] = [];

  for (const [id, card] of db) {
    if (banned.has(id)) continue;
    const sameSchool = (card.affiliations ?? []).some((affiliation) => schoolSet.has(affiliation));
    if (inDeck.has(id) || sameSchool || allow.has(id)) poolIds.push(id);
    if (allow.has(id) && !sameSchool && !inDeck.has(id)) crossSchoolAllowed.push(id);
  }

  return {
    schools,
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
