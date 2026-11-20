import type { Decision, PendingDecision } from "../engine/types";

export const AI_THOUGHT_SCHEMA_VERSION = "ai-thought-v1" as const;
export type AiThoughtSchemaVersion = typeof AI_THOUGHT_SCHEMA_VERSION;
export type AiThoughtEngine = "strong" | "heuristic";
export type AiThoughtFactorDirection = "helps" | "hurts" | "neutral";

export const AI_THOUGHT_MAX_CANDIDATES = 3;
export const AI_THOUGHT_MAX_FACTORS = 3;

export interface AiThoughtCandidate {
  label: string;
  decisionType: Decision["type"];
  winRate: number;
  sampleCount: number;
  isChosen: boolean;
}

export interface AiThoughtFactor {
  feature: string;
  label: string;
  contribution: number;
  direction: AiThoughtFactorDirection;
}

export interface AiBeliefSnapshot {
  knownOppHandCardIds: string[];
  reducedTags: string[];
  oppGuts: number;
  oppRemainingHighReceive: number;
  oppRemainingDefEvent: number;
}

export interface AiThoughtDialogue {
  safe: string;
  spoiler: string;
}

export interface AiThoughtRecord {
  schemaVersion: AiThoughtSchemaVersion;
  engine: AiThoughtEngine;
  isKeyDecision: boolean;
  pendingType: Decision["type"];
  chosenLabel: string;
  chosenWinRate?: number;
  completedSamples: number;
  tieBreakReason?: string;
  topCandidates: AiThoughtCandidate[];
  valueFactors: AiThoughtFactor[];
  belief?: AiBeliefSnapshot;
  dialogue: AiThoughtDialogue;
}

export interface KeyDecisionContext {
  pendingType: Decision["type"];
  decision?: Decision;
  legalCandidateCount?: number;
  freeActionableCount?: number;
  pendingDecision?: PendingDecision | null;
}

const VALID_DECISION_TYPE_MAP: Record<Decision["type"], true> = {
  "serve-rights": true,
  mulligan: true,
  "deploy-serve": true,
  "deploy-block": true,
  "deploy-receive": true,
  "deploy-toss": true,
  "deploy-attack": true,
  "defense-choice": true,
  free: true,
  "resolve-pending": true,
  "effect-confirm": true,
  "effect-cards": true,
  "effect-option": true,
  "pick-set-card": true,
};

const VALID_DECISION_TYPES = new Set<string>(Object.keys(VALID_DECISION_TYPE_MAP));

/**
 * 判斷當前決策點是否屬於會更新 2D 對話框的「關鍵決策步」。
 * 過場步（首發權、撿 Set、唯一選項、無事件/技能可宣告之自動 free:pass 等）回傳 false。
 */
export function isKeyDecision(ctx: KeyDecisionContext): boolean {
  if (ctx.pendingType === "serve-rights" || ctx.pendingType === "pick-set-card") {
    return false;
  }
  if (ctx.legalCandidateCount !== undefined && ctx.legalCandidateCount <= 1) {
    return false;
  }

  switch (ctx.pendingType) {
    case "free": {
      if (ctx.decision?.type === "free" && ctx.decision.action !== "pass") {
        return true;
      }
      if (ctx.freeActionableCount !== undefined) {
        return ctx.freeActionableCount >= 1;
      }
      if (ctx.legalCandidateCount !== undefined) {
        return ctx.legalCandidateCount >= 2;
      }
      return false;
    }

    case "resolve-pending": {
      if (ctx.pendingDecision?.candidates !== undefined) {
        return ctx.pendingDecision.candidates.length >= 2;
      }
      return ctx.legalCandidateCount !== undefined ? ctx.legalCandidateCount >= 2 : false;
    }

    case "effect-option": {
      if (ctx.pendingDecision?.options !== undefined) {
        return ctx.pendingDecision.options.length >= 2;
      }
      return ctx.legalCandidateCount !== undefined ? ctx.legalCandidateCount >= 2 : false;
    }

    case "effect-cards": {
      if (ctx.pendingDecision?.candidates !== undefined) {
        const n = ctx.pendingDecision.candidates.length;
        const min = Math.max(0, ctx.pendingDecision.min ?? 0);
        const max = Math.max(0, ctx.pendingDecision.max ?? n);
        if (n === 0 || max === 0 || (min >= max && n <= min)) {
          return false;
        }
        return true;
      }
      return ctx.legalCandidateCount !== undefined ? ctx.legalCandidateCount >= 2 : true;
    }

    case "effect-confirm":
    case "mulligan":
    case "defense-choice":
    case "deploy-block":
      return true;

    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack":
      return ctx.legalCandidateCount !== undefined ? ctx.legalCandidateCount >= 2 : true;

    default: {
      const _exhaustive: never = ctx.pendingType;
      void _exhaustive;
      return false;
    }
  }
}

/** 回傳截斷並深拷貝陣列之新 AiThoughtRecord（不 mutate 原物件）。 */
export function clampAiThoughtRecord(record: AiThoughtRecord): AiThoughtRecord {
  const clamped: AiThoughtRecord = {
    schemaVersion: AI_THOUGHT_SCHEMA_VERSION,
    engine: record.engine,
    isKeyDecision: record.isKeyDecision,
    pendingType: record.pendingType,
    chosenLabel: record.chosenLabel,
    completedSamples: record.completedSamples,
    topCandidates: record.topCandidates
      .slice(0, AI_THOUGHT_MAX_CANDIDATES)
      .map((candidate) => ({ ...candidate })),
    valueFactors: record.valueFactors
      .slice(0, AI_THOUGHT_MAX_FACTORS)
      .map((factor) => ({ ...factor })),
    dialogue: {
      safe: record.dialogue.safe,
      spoiler: record.dialogue.spoiler,
    },
  };

  if (record.chosenWinRate !== undefined) {
    clamped.chosenWinRate = record.chosenWinRate;
  }
  if (record.tieBreakReason !== undefined) {
    clamped.tieBreakReason = record.tieBreakReason;
  }
  if (record.belief !== undefined) {
    clamped.belief = {
      knownOppHandCardIds: [...record.belief.knownOppHandCardIds],
      reducedTags: [...record.belief.reducedTags],
      oppGuts: record.belief.oppGuts,
      oppRemainingHighReceive: record.belief.oppRemainingHighReceive,
      oppRemainingDefEvent: record.belief.oppRemainingDefEvent,
    };
  }

  return clamped;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDecisionType(value: unknown): value is Decision["type"] {
  return typeof value === "string" && VALID_DECISION_TYPES.has(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAiThoughtCandidate(value: unknown): value is AiThoughtCandidate {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.label === "string" &&
    isDecisionType(value.decisionType) &&
    isFiniteNumber(value.winRate) &&
    isNonNegativeInteger(value.sampleCount) &&
    typeof value.isChosen === "boolean"
  );
}

function isAiThoughtFactor(value: unknown): value is AiThoughtFactor {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.feature === "string" &&
    typeof value.label === "string" &&
    isFiniteNumber(value.contribution) &&
    (value.direction === "helps" || value.direction === "hurts" || value.direction === "neutral")
  );
}

function isAiBeliefSnapshot(value: unknown): value is AiBeliefSnapshot {
  if (!isPlainRecord(value)) return false;
  return (
    isStringArray(value.knownOppHandCardIds) &&
    isStringArray(value.reducedTags) &&
    isNonNegativeFiniteNumber(value.oppGuts) &&
    isNonNegativeFiniteNumber(value.oppRemainingHighReceive) &&
    isNonNegativeFiniteNumber(value.oppRemainingDefEvent)
  );
}

function isAiThoughtDialogue(value: unknown): value is AiThoughtDialogue {
  if (!isPlainRecord(value)) return false;
  return typeof value.safe === "string" && typeof value.spoiler === "string";
}

/** Runtime 型別守衛：驗證未知資料是否為合法 AiThoughtRecord。 */
export function isAiThoughtRecord(value: unknown): value is AiThoughtRecord {
  if (!isPlainRecord(value)) return false;
  if (value.schemaVersion !== AI_THOUGHT_SCHEMA_VERSION) return false;
  if (value.engine !== "strong" && value.engine !== "heuristic") return false;
  if (typeof value.isKeyDecision !== "boolean") return false;
  if (!isDecisionType(value.pendingType)) return false;
  if (typeof value.chosenLabel !== "string") return false;
  if (value.chosenWinRate !== undefined && !isFiniteNumber(value.chosenWinRate)) return false;
  if (!isNonNegativeInteger(value.completedSamples)) return false;
  if (value.tieBreakReason !== undefined && typeof value.tieBreakReason !== "string") return false;
  if (!Array.isArray(value.topCandidates) || !value.topCandidates.every(isAiThoughtCandidate)) return false;
  if (!Array.isArray(value.valueFactors) || !value.valueFactors.every(isAiThoughtFactor)) return false;
  if (value.belief !== undefined && !isAiBeliefSnapshot(value.belief)) return false;
  if (!isAiThoughtDialogue(value.dialogue)) return false;
  return true;
}
