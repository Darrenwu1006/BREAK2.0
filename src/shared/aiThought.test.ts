import { describe, expect, it } from "vitest";
import type { Decision, PendingDecision } from "../engine/types";
import {
  AI_THOUGHT_MAX_CANDIDATES,
  AI_THOUGHT_MAX_FACTORS,
  AI_THOUGHT_SCHEMA_VERSION,
  clampAiThoughtRecord,
  isAiThoughtRecord,
  isKeyDecision,
  type AiThoughtRecord,
} from "./aiThought";

const ALL_DECISION_TYPES: readonly Decision["type"][] = [
  "serve-rights",
  "mulligan",
  "deploy-serve",
  "deploy-block",
  "deploy-receive",
  "deploy-toss",
  "deploy-attack",
  "defense-choice",
  "free",
  "resolve-pending",
  "effect-confirm",
  "effect-cards",
  "effect-option",
  "pick-set-card",
];

function makeMinimalRecord(overrides: Partial<AiThoughtRecord> = {}): AiThoughtRecord {
  return {
    schemaVersion: AI_THOUGHT_SCHEMA_VERSION,
    engine: "heuristic",
    isKeyDecision: false,
    pendingType: "free",
    chosenLabel: "自由步驟 Pass",
    completedSamples: 0,
    topCandidates: [],
    valueFactors: [],
    dialogue: {
      safe: "",
      spoiler: "",
    },
    ...overrides,
  };
}

function makeFullRecord(overrides: Partial<AiThoughtRecord> = {}): AiThoughtRecord {
  return {
    schemaVersion: AI_THOUGHT_SCHEMA_VERSION,
    engine: "strong",
    isKeyDecision: true,
    pendingType: "free",
    chosenLabel: "自由步驟 Pass",
    chosenWinRate: 0.58,
    completedSamples: 200,
    tieBreakReason: "pressure-tiebreak",
    topCandidates: [
      { label: "自由步驟 Pass", decisionType: "free", winRate: 0.58, sampleCount: 120, isChosen: true },
      { label: "使用事件 繋げ", decisionType: "free", winRate: 0.54, sampleCount: 80, isChosen: false },
    ],
    valueFactors: [
      { feature: "oppGutsThreat", label: "對面 Guts 威脅", contribution: 0.24, direction: "helps" },
      { feature: "myHandDefEventCount", label: "保留防禦事件", contribution: 0.15, direction: "helps" },
      { feature: "dpExcess", label: "溢點接球", contribution: -0.08, direction: "hurts" },
    ],
    belief: {
      knownOppHandCardIds: ["HV-P04-001"],
      reducedTags: ["matchpoint-high-receive"],
      oppGuts: 6,
      oppRemainingHighReceive: 2.5,
      oppRemainingDefEvent: 1.75,
    },
    dialogue: {
      safe: "這球接得住，先別急著交牌。對面 Guts 越堆越多，得留一手防後面大招。",
      spoiler: "已經接得住，先扣著防禦事件不交（Pass 58% ＞ 開事件 54%）。",
    },
    ...overrides,
  };
}

describe("aiThought constants", () => {
  it("defines expected schema version and clamp limits", () => {
    expect(AI_THOUGHT_SCHEMA_VERSION).toBe("ai-thought-v1");
    expect(AI_THOUGHT_MAX_CANDIDATES).toBe(3);
    expect(AI_THOUGHT_MAX_FACTORS).toBe(3);
  });
});

describe("isKeyDecision", () => {
  it("always returns false for serve-rights and pick-set-card", () => {
    expect(isKeyDecision({ pendingType: "serve-rights", decision: { type: "serve-rights", take: true }, legalCandidateCount: 2 })).toBe(false);
    expect(isKeyDecision({ pendingType: "pick-set-card", decision: { type: "pick-set-card", index: 0 }, legalCandidateCount: 3 })).toBe(false);
  });

  it("returns false whenever legalCandidateCount <= 1 across all decision types", () => {
    for (const pendingType of ALL_DECISION_TYPES) {
      expect(isKeyDecision({ pendingType, legalCandidateCount: 0 })).toBe(false);
      expect(isKeyDecision({ pendingType, legalCandidateCount: 1 })).toBe(false);
    }
    expect(isKeyDecision({
      pendingType: "free",
      decision: { type: "free", action: "event", uid: 5 },
      legalCandidateCount: 1,
      freeActionableCount: 1,
    })).toBe(false);
    expect(isKeyDecision({
      pendingType: "resolve-pending",
      legalCandidateCount: 1,
      pendingDecision: { player: 0, type: "resolve-pending", candidates: [1, 2] },
    })).toBe(false);
  });

  it("evaluates free decisions accurately for pass vs active event/skill/lost", () => {
    expect(isKeyDecision({
      pendingType: "free",
      decision: { type: "free", action: "event", uid: 12 },
      legalCandidateCount: 2,
    })).toBe(true);
    expect(isKeyDecision({
      pendingType: "free",
      decision: { type: "free", action: "skill", uid: 13, skillIndex: 0 },
      legalCandidateCount: 2,
    })).toBe(true);
    expect(isKeyDecision({
      pendingType: "free",
      decision: { type: "free", action: "lost" },
      legalCandidateCount: 2,
    })).toBe(true);

    // 無可宣告技能／事件時，即使 legalCandidateCount === 2（pass + lost），pass 仍屬過場步
    expect(isKeyDecision({
      pendingType: "free",
      decision: { type: "free", action: "pass" },
      legalCandidateCount: 2,
      freeActionableCount: 0,
    })).toBe(false);

    // 有可宣告技能／事件卻主動選擇 pass，屬於關鍵保留決策
    expect(isKeyDecision({
      pendingType: "free",
      decision: { type: "free", action: "pass" },
      legalCandidateCount: 2,
      freeActionableCount: 1,
    })).toBe(true);

    // 未傳 freeActionableCount 時退回 legalCandidateCount >= 2，再無則 false
    expect(isKeyDecision({
      pendingType: "free",
      decision: { type: "free", action: "pass" },
      legalCandidateCount: 2,
    })).toBe(true);
    expect(isKeyDecision({
      pendingType: "free",
      decision: { type: "free", action: "pass" },
    })).toBe(false);
    expect(isKeyDecision({ pendingType: "free" })).toBe(false);
  });

  it("evaluates resolve-pending preferring pendingDecision.candidates", () => {
    const single: PendingDecision = { player: 1, type: "resolve-pending", candidates: [10] };
    const multi: PendingDecision = { player: 1, type: "resolve-pending", candidates: [10, 20] };

    expect(isKeyDecision({ pendingType: "resolve-pending", pendingDecision: single, legalCandidateCount: 2 })).toBe(false);
    expect(isKeyDecision({ pendingType: "resolve-pending", pendingDecision: multi })).toBe(true);
    expect(isKeyDecision({ pendingType: "resolve-pending", legalCandidateCount: 2 })).toBe(true);
    expect(isKeyDecision({ pendingType: "resolve-pending" })).toBe(false);
  });

  it("evaluates effect-option preferring pendingDecision.options", () => {
    const single: PendingDecision = { player: 1, type: "effect-option", options: ["OP +1"] };
    const multi: PendingDecision = { player: 1, type: "effect-option", options: ["OP +1", "DP +1"] };

    expect(isKeyDecision({ pendingType: "effect-option", pendingDecision: single, legalCandidateCount: 2 })).toBe(false);
    expect(isKeyDecision({ pendingType: "effect-option", pendingDecision: multi })).toBe(true);
    expect(isKeyDecision({ pendingType: "effect-option", legalCandidateCount: 2 })).toBe(true);
    expect(isKeyDecision({ pendingType: "effect-option" })).toBe(false);
  });

  it("evaluates effect-cards for empty, max=0, forced exact-count, and optional/branching choices", () => {
    expect(isKeyDecision({
      pendingType: "effect-cards",
      pendingDecision: { player: 1, type: "effect-cards", candidates: [], min: 0, max: 1 },
    })).toBe(false);
    expect(isKeyDecision({
      pendingType: "effect-cards",
      pendingDecision: { player: 1, type: "effect-cards", candidates: [1, 2], min: 0, max: 0 },
    })).toBe(false);
    expect(isKeyDecision({
      pendingType: "effect-cards",
      pendingDecision: { player: 1, type: "effect-cards", candidates: [1], min: 1, max: 1 },
    })).toBe(false);
    expect(isKeyDecision({
      pendingType: "effect-cards",
      pendingDecision: { player: 1, type: "effect-cards", candidates: [1, 2], min: 2, max: 2 },
    })).toBe(false);
    expect(isKeyDecision({
      pendingType: "effect-cards",
      pendingDecision: { player: 1, type: "effect-cards", candidates: [1, 2], min: 2 },
    })).toBe(false);

    // 2 選 1 或 1 選 0..1 或多選皆為關鍵分支
    expect(isKeyDecision({
      pendingType: "effect-cards",
      pendingDecision: { player: 1, type: "effect-cards", candidates: [1, 2], min: 1, max: 1 },
    })).toBe(true);
    expect(isKeyDecision({
      pendingType: "effect-cards",
      pendingDecision: { player: 1, type: "effect-cards", candidates: [1], min: 0, max: 1 },
    })).toBe(true);
    expect(isKeyDecision({
      pendingType: "effect-cards",
      pendingDecision: { player: 1, type: "effect-cards", candidates: [1, 2, 3], min: 1, max: 2 },
    })).toBe(true);

    // 未提供 pendingDecision.candidates 時
    expect(isKeyDecision({ pendingType: "effect-cards", legalCandidateCount: 2 })).toBe(true);
    expect(isKeyDecision({ pendingType: "effect-cards" })).toBe(true);
    expect(isKeyDecision({ pendingType: "effect-cards", pendingDecision: null, legalCandidateCount: 1 })).toBe(false);
  });

  it("evaluates effect-confirm, mulligan, defense-choice, and deploy-block", () => {
    for (const pendingType of ["effect-confirm", "mulligan", "defense-choice", "deploy-block"] as const) {
      expect(isKeyDecision({ pendingType, legalCandidateCount: 1 })).toBe(false);
      expect(isKeyDecision({ pendingType, legalCandidateCount: 2 })).toBe(true);
      expect(isKeyDecision({ pendingType })).toBe(true);
    }
  });

  it("evaluates deploy-serve, deploy-receive, deploy-toss, and deploy-attack", () => {
    for (const pendingType of ["deploy-serve", "deploy-receive", "deploy-toss", "deploy-attack"] as const) {
      expect(isKeyDecision({ pendingType, legalCandidateCount: 0 })).toBe(false);
      expect(isKeyDecision({ pendingType, legalCandidateCount: 1 })).toBe(false);
      expect(isKeyDecision({ pendingType, legalCandidateCount: 2 })).toBe(true);
      expect(isKeyDecision({ pendingType, legalCandidateCount: 4 })).toBe(true);
      expect(isKeyDecision({ pendingType })).toBe(true);
    }
  });
});

describe("clampAiThoughtRecord", () => {
  it("clamps topCandidates and valueFactors to max 3 and locks schemaVersion without mutating input", () => {
    const input: AiThoughtRecord = {
      ...makeFullRecord({
        topCandidates: [
          { label: "c1", decisionType: "free", winRate: 0.7, sampleCount: 50, isChosen: true },
          { label: "c2", decisionType: "free", winRate: 0.6, sampleCount: 30, isChosen: false },
          { label: "c3", decisionType: "free", winRate: 0.5, sampleCount: 20, isChosen: false },
          { label: "c4", decisionType: "free", winRate: 0.4, sampleCount: 10, isChosen: false },
        ],
        valueFactors: [
          { feature: "f1", label: "F1", contribution: 0.4, direction: "helps" },
          { feature: "f2", label: "F2", contribution: 0.3, direction: "helps" },
          { feature: "f3", label: "F3", contribution: -0.2, direction: "hurts" },
          { feature: "f4", label: "F4", contribution: 0, direction: "neutral" },
        ],
      }),
      schemaVersion: "tampered" as AiThoughtRecord["schemaVersion"],
    };

    const clamped = clampAiThoughtRecord(input);

    expect(clamped.schemaVersion).toBe(AI_THOUGHT_SCHEMA_VERSION);
    expect(clamped.topCandidates).toHaveLength(AI_THOUGHT_MAX_CANDIDATES);
    expect(clamped.topCandidates.map((c) => c.label)).toEqual(["c1", "c2", "c3"]);
    expect(clamped.valueFactors).toHaveLength(AI_THOUGHT_MAX_FACTORS);
    expect(clamped.valueFactors.map((f) => f.feature)).toEqual(["f1", "f2", "f3"]);

    // 確認未 mutate 原物件與原陣列
    expect(input.schemaVersion).toBe("tampered");
    expect(input.topCandidates).toHaveLength(4);
    expect(input.valueFactors).toHaveLength(4);

    // 確認深拷貝：修改 clamped 內部物件與陣列不會影響 input
    clamped.topCandidates[0]!.label = "mutated";
    clamped.valueFactors[0]!.feature = "mutated";
    clamped.dialogue.safe = "mutated";
    clamped.belief!.knownOppHandCardIds.push("HV-P04-999");
    clamped.belief!.reducedTags.push("extra-tag");

    expect(input.topCandidates[0]!.label).toBe("c1");
    expect(input.valueFactors[0]!.feature).toBe("f1");
    expect(input.dialogue.safe).not.toBe("mutated");
    expect(input.belief!.knownOppHandCardIds).toEqual(["HV-P04-001"]);
    expect(input.belief!.reducedTags).toEqual(["matchpoint-high-receive"]);
  });

  it("preserves omitted optional fields without introducing undefined properties", () => {
    const minimal = makeMinimalRecord();
    const clamped = clampAiThoughtRecord(minimal);

    expect(clamped).toEqual(minimal);
    expect("chosenWinRate" in clamped).toBe(false);
    expect("tieBreakReason" in clamped).toBe(false);
    expect("belief" in clamped).toBe(false);
  });
});

describe("isAiThoughtRecord", () => {
  it("accepts minimal and full valid records across all 14 pendingTypes", () => {
    expect(isAiThoughtRecord(makeMinimalRecord())).toBe(true);
    expect(isAiThoughtRecord(makeFullRecord())).toBe(true);

    for (const pendingType of ALL_DECISION_TYPES) {
      expect(isAiThoughtRecord(makeMinimalRecord({ pendingType }))).toBe(true);
    }
  });

  it("rejects non-objects, arrays, and invalid top-level fields", () => {
    expect(isAiThoughtRecord(null)).toBe(false);
    expect(isAiThoughtRecord(undefined)).toBe(false);
    expect(isAiThoughtRecord("ai-thought-v1")).toBe(false);
    expect(isAiThoughtRecord(42)).toBe(false);
    expect(isAiThoughtRecord([])).toBe(false);

    expect(isAiThoughtRecord({ ...makeMinimalRecord(), schemaVersion: "ai-thought-v2" })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), engine: "random" })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), isKeyDecision: "true" })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), pendingType: "unknown-step" })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), pendingType: "toString" })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), chosenLabel: 123 })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), chosenWinRate: Number.NaN })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), chosenWinRate: Infinity })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), chosenWinRate: null })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), completedSamples: -1 })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), completedSamples: 1.5 })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), completedSamples: Number.NaN })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), completedSamples: Infinity })).toBe(false);
    expect(isAiThoughtRecord({ ...makeMinimalRecord(), tieBreakReason: 99 })).toBe(false);
  });

  it("rejects invalid candidates, factors, belief, and dialogue", () => {
    const full = makeFullRecord();

    expect(isAiThoughtRecord({ ...full, topCandidates: "not-array" })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      topCandidates: [{ ...full.topCandidates[0]!, decisionType: "bad-type" }],
    })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      topCandidates: [{ ...full.topCandidates[0]!, winRate: Infinity }],
    })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      topCandidates: [{ ...full.topCandidates[0]!, sampleCount: -2 }],
    })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      topCandidates: [{ ...full.topCandidates[0]!, sampleCount: 2.5 }],
    })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      topCandidates: [{ ...full.topCandidates[0]!, isChosen: "yes" }],
    })).toBe(false);

    expect(isAiThoughtRecord({ ...full, valueFactors: null })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      valueFactors: [{ ...full.valueFactors[0]!, direction: "bad" }],
    })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      valueFactors: [{ ...full.valueFactors[0]!, contribution: Number.NaN }],
    })).toBe(false);

    expect(isAiThoughtRecord({ ...full, belief: null })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      belief: { ...full.belief!, knownOppHandCardIds: [123] },
    })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      belief: { ...full.belief!, reducedTags: [null] },
    })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      belief: { ...full.belief!, oppGuts: -1 },
    })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      belief: { ...full.belief!, oppRemainingHighReceive: Number.NaN },
    })).toBe(false);
    expect(isAiThoughtRecord({
      ...full,
      belief: { ...full.belief!, oppRemainingDefEvent: Infinity },
    })).toBe(false);

    expect(isAiThoughtRecord({ ...full, dialogue: null })).toBe(false);
    expect(isAiThoughtRecord({ ...full, dialogue: { safe: "ok" } })).toBe(false);
    expect(isAiThoughtRecord({ ...full, dialogue: { safe: 1, spoiler: "ok" } })).toBe(false);
  });
});
