import { describe, expect, it } from "vitest";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import {
  DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION,
  DECK_OPTIMIZER_VERSION,
  assertValidDeckOptimizerProposal,
  autoLockCoreCards,
  buildDeckOptimizerChanges,
  createDeckOptimizerProposalScaffold,
  deckOptimizerCardsFromIds,
  deckSchools,
  resolveOptimizerCardPool,
  validateDeckConstraints,
  validateDeckOptimizerProposal,
} from "./deck-optimizer";
import type { DeckOptimizerCardCount, DeckOptimizerProposal } from "./deck-optimizer";

function applyDeltas(cards: readonly DeckOptimizerCardCount[], deltas: Record<string, number>): DeckOptimizerCardCount[] {
  const counts = new Map(cards.map((entry) => [entry.id, entry.count]));
  for (const [id, delta] of Object.entries(deltas)) counts.set(id, (counts.get(id) ?? 0) + delta);
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function proposalWith(candidateDeckCards: DeckOptimizerCardCount[], changes = buildDeckOptimizerChanges(benchmarkDb, sourceDeckCards, candidateDeckCards)): DeckOptimizerProposal {
  return {
    schemaVersion: DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION,
    generatedAt: "2026-06-18T00:00:00.000Z",
    optimizerVersion: DECK_OPTIMIZER_VERSION,
    sourceDeck: "稻荷崎-0612測試",
    sourceDeckCards,
    candidateDeckCards,
    changes,
    lockedCards: [{ id: "HV-P02-017", minCount: 4 }],
    bannedCards: ["HV-D01-001"],
    objectiveProfile: "preserve-current",
    evaluationConfig: {
      opponents: ["音駒-預組"],
      policy: "heuristic-v2",
      opponentPolicy: "heuristic-v2",
      preset: "direction",
    },
    baselineMetrics: null,
    candidateMetrics: null,
    deltas: {},
    score: null,
    rationale: [],
    risks: [],
    status: "draft",
  };
}

const sourceDeck = findBenchmarkDeck("稻荷崎-0612測試");
const sourceDeckCards = deckOptimizerCardsFromIds(sourceDeck.ids);

describe("M8 deck optimizer C1-1 validator", () => {
  it("接受不修改原牌組的 proposal scaffold", () => {
    const proposal = proposalWith(sourceDeckCards, []);

    expect(validateDeckOptimizerProposal(benchmarkDb, proposal).ok).toBe(true);
    expect(() => assertValidDeckOptimizerProposal(benchmarkDb, proposal)).not.toThrow();
  });

  it("拒絕不是 40 張的候選牌組", () => {
    const candidate = applyDeltas(sourceDeckCards, { "HV-P02-085": -1 });
    const result = validateDeckConstraints(benchmarkDb, candidate);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("deck-size");
  });

  it("拒絕事件卡超過 8 張", () => {
    const candidate = [
      { id: "HV-P02-085", count: 9 },
      { id: "HV-P02-017", count: 31 },
    ];
    const result = validateDeckConstraints(benchmarkDb, candidate);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("event-limit");
  });

  it("拒絕不存在的卡片", () => {
    const candidate = [
      { id: "HV-NOPE-001", count: 1 },
      { id: "HV-P02-017", count: 39 },
    ];
    const result = validateDeckConstraints(benchmarkDb, candidate);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("unknown-card");
  });

  it("拒絕移除 locked core card", () => {
    const candidate = applyDeltas(sourceDeckCards, { "HV-P02-017": -1, "HV-P02-085": 1 });
    const proposal = proposalWith(candidate);
    const result = validateDeckOptimizerProposal(benchmarkDb, proposal);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("locked-card");
  });

  it("拒絕加入 banned card", () => {
    const candidate = applyDeltas(sourceDeckCards, { "HV-D01-001": 1, "HV-P02-085": -1 });
    const proposal = proposalWith(candidate);
    const result = validateDeckOptimizerProposal(benchmarkDb, proposal);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("banned-card");
  });

  it("要求 changes 完整反映 source 與 candidate 的張數差異", () => {
    const candidate = applyDeltas(sourceDeckCards, { "HV-P02-017": 1, "HV-P02-085": -1 });
    const proposal = proposalWith(candidate, []);
    const result = validateDeckOptimizerProposal(benchmarkDb, proposal);

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("change-mismatch");
  });

  it("產生可追溯的換入換出差異", () => {
    const candidate = applyDeltas(sourceDeckCards, { "HV-P02-017": 1, "HV-P02-085": -1 });
    const changes = buildDeckOptimizerChanges(benchmarkDb, sourceDeckCards, candidate, "test replacement");

    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ cardId: "HV-P02-017", before: 4, after: 5, delta: 1, reason: "test replacement" }),
      expect.objectContaining({ cardId: "HV-P02-085", before: 3, after: 2, delta: -1, reason: "test replacement" }),
    ]));
  });
});

describe("M8 deck optimizer C1-2 proposal scaffold", () => {
  it("從 benchmark deck 建立不改牌的 draft proposal", () => {
    const proposal = createDeckOptimizerProposalScaffold({
      db: benchmarkDb,
      sourceDeck,
      constraints: {
        lockedCards: [{ id: "HV-P02-017", minCount: 4 }],
        bannedCards: ["HV-D01-001"],
      },
      objectiveProfile: "preserve-current",
      evaluationConfig: {
        opponents: ["音駒-預組"],
        policy: "heuristic-v2",
        opponentPolicy: "heuristic-v2",
        preset: "direction",
        gamesPerSeat: 4,
        seedStart: 2200,
        maxSteps: 5000,
      },
      generatedAt: "2026-06-18T00:00:00.000Z",
    });

    expect(proposal.status).toBe("draft");
    expect(proposal.optimizerVersion).toBe(DECK_OPTIMIZER_VERSION);
    expect(proposal.changes).toEqual([]);
    expect(proposal.sourceDeckCards).toEqual(proposal.candidateDeckCards);
    expect(proposal.rationale.length).toBeGreaterThan(0);
    expect(validateDeckOptimizerProposal(benchmarkDb, proposal).ok).toBe(true);
  });

  it("若 banned card 已在原始牌組中，scaffold 會拒絕輸出", () => {
    expect(() => createDeckOptimizerProposalScaffold({
      db: benchmarkDb,
      sourceDeck,
      constraints: { bannedCards: ["HV-P02-017"] },
      evaluationConfig: {
        opponents: ["音駒-預組"],
        policy: "heuristic-v2",
        opponentPolicy: "heuristic-v2",
        preset: "direction",
      },
    })).toThrow(/不可加入卡/);
  });
});

describe("M8 deck optimizer C1-3a card pool", () => {
  const aobaDeck = findBenchmarkDeck("青葉城西-二彈改");

  it("由牌組卡片推得所屬學校", () => {
    expect(deckSchools(benchmarkDb, aobaDeck.ids)).toContain("青葉城西");
  });

  it("候選卡池涵蓋牌組已用卡與同校卡，並排除 banned", () => {
    const pool = resolveOptimizerCardPool(benchmarkDb, aobaDeck.ids, { banned: ["HV-P01-033"] });
    const poolSet = new Set(pool.poolIds);

    expect(pool.schools).toContain("青葉城西");
    expect(poolSet.has("HV-P01-035")).toBe(true); // 同校角色仍在池內
    expect(poolSet.has("HV-P01-033")).toBe(false); // banned 被排除，即使原本在牌組
    expect(pool.crossSchoolAllowed).toEqual([]);
  });

  it("--allow 才會把跨校卡納入候選池並標記", () => {
    const base = resolveOptimizerCardPool(benchmarkDb, aobaDeck.ids);
    expect(new Set(base.poolIds).has("HV-D01-001")).toBe(false); // 預設不跨校

    const allowed = resolveOptimizerCardPool(benchmarkDb, aobaDeck.ids, { allow: ["HV-D01-001"] });
    expect(new Set(allowed.poolIds).has("HV-D01-001")).toBe(true);
    expect(allowed.crossSchoolAllowed).toEqual(["HV-D01-001"]);
  });
});

describe("M8 deck optimizer C1-3a auto-lock", () => {
  const aobaDeck = findBenchmarkDeck("青葉城西-二彈改");

  it("把張數 >= 4 的核心卡鎖定在 ceil(count/2)，低張數卡不鎖", () => {
    const locks = new Map(autoLockCoreCards(benchmarkDb, aobaDeck.ids).map((entry) => [entry.id, entry.minCount]));

    expect(locks.get("HV-P01-033")).toBe(5); // 9 張 → 5
    expect(locks.get("HV-P01-035")).toBe(3); // 6 張 → 3
    expect(locks.get("HV-P01-039")).toBe(3); // 6 張 → 3
    expect(locks.get("HV-P01-041")).toBe(2); // 4 張 → 2
    expect(locks.get("HV-P01-087")).toBe(3); // 5 張事件 → 3
    expect(locks.has("HV-P01-042")).toBe(false); // 2 張，不鎖
  });

  it("--unlock 可解除自動鎖定", () => {
    const locks = new Map(autoLockCoreCards(benchmarkDb, aobaDeck.ids, { unlock: ["HV-P01-033"] }).map((entry) => [entry.id, entry.minCount]));
    expect(locks.has("HV-P01-033")).toBe(false);
    expect(locks.get("HV-P01-035")).toBe(3); // 其他核心卡仍鎖
  });

  it("--locked 明確指定會覆蓋自動鎖定，並可鎖低張數卡", () => {
    const locks = new Map(autoLockCoreCards(benchmarkDb, aobaDeck.ids, {
      explicit: [{ id: "HV-P01-033", minCount: 9 }, { id: "HV-P01-042", minCount: 2 }],
    }).map((entry) => [entry.id, entry.minCount]));

    expect(locks.get("HV-P01-033")).toBe(9); // explicit 覆蓋 auto 的 5
    expect(locks.get("HV-P01-042")).toBe(2); // 低張數卡也能被明確鎖定
  });
});
