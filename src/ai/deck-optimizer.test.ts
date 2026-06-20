import { describe, expect, it } from "vitest";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import type { AnalyzerMetrics, DeckAnalyzerComparisonReport } from "./deck-analyzer";
import {
  DECK_OPTIMIZER_PROPOSAL_SCHEMA_VERSION,
  DECK_OPTIMIZER_VERSION,
  attachDeckOptimizerEvaluation,
  attachDeckOptimizerValidationMatrix,
  assertValidDeckOptimizerProposal,
  autoLockCoreCards,
  buildDeckOptimizerValidationMatrix,
  buildDeckOptimizerChanges,
  CARD_POOL_HEURISTIC_NOTE,
  createDeckOptimizerCandidateProposal,
  createDeckOptimizerProposalScaffold,
  deckOptimizerCardCounts,
  deckOptimizerCardsFromIds,
  deckOptimizerEventCount,
  deckOptimizerTotalCards,
  deckSchools,
  resolveOptimizerCardPool,
  scoreDeckOptimizerComparison,
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

function metrics(overrides: Partial<AnalyzerMetrics> = {}): AnalyzerMetrics {
  return {
    games: 4,
    completed: 4,
    winRate: 0.5,
    winRate95: { low: 0.25, high: 0.75 },
    setWinRate: 0.5,
    averageRalliesPerSet: 2,
    averageOp: 3,
    averageServeOp: 3,
    averageBlockOp: 2,
    averageAttackOp: 4,
    burstRate: 0.2,
    averageDp: 4,
    receiveSuccessRate: 0.5,
    blockSuccessRate: 0.5,
    eventUsesPerMatch: 1,
    eventEffectiveRate: 0.3,
    eventDrawsPerMatch: 0,
    eventPointModsPerMatch: 0,
    eventDeploysPerMatch: 0,
    skillUsesPerMatch: 1,
    skillEffectiveRate: 0.3,
    paidGutsPerMatch: 1,
    gutsPaidBySourcePerMatch: { serve: 0, receive: 0, toss: 0, attack: 0, blockCenter: 0 },
    emptyDrawsPerMatch: 0,
    mulliganRate: 0,
    noDeployLossRate: 0.2,
    judgeFailLossRate: 0.2,
    ...overrides,
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

  it("[C3d] --allow 整校會把該校全部卡納入跨校候選並標記", () => {
    const allowed = resolveOptimizerCardPool(benchmarkDb, aobaDeck.ids, { allowSchools: ["音駒"] });
    const poolSet = new Set(allowed.poolIds);
    const nekomaIds = [...benchmarkDb]
      .filter(([, card]) => (card.affiliations ?? []).includes("音駒"))
      .map(([id]) => id);

    expect(nekomaIds.length).toBeGreaterThan(0);
    for (const id of nekomaIds) expect(poolSet.has(id)).toBe(true);
    // 整校允許的跨校卡都應標記，且不含青葉城西本校卡。
    expect(allowed.crossSchoolAllowed.length).toBeGreaterThan(0);
    expect(new Set(allowed.crossSchoolAllowed)).toEqual(new Set(nekomaIds));
  });

  it("[C3d] banned 優先於 allowSchools", () => {
    const nekomaId = [...benchmarkDb].find(([, card]) => (card.affiliations ?? []).includes("音駒"))?.[0];
    expect(nekomaId).toBeDefined();
    const allowed = resolveOptimizerCardPool(benchmarkDb, aobaDeck.ids, {
      allowSchools: ["音駒"],
      banned: [nekomaId!],
    });
    expect(new Set(allowed.poolIds).has(nekomaId!)).toBe(false);
    expect(allowed.crossSchoolAllowed).not.toContain(nekomaId!);
  });

  it("[C3d] 卡池標註說明同校只是預設啟發、非合法性限制", () => {
    expect(CARD_POOL_HEURISTIC_NOTE).toContain("非合法性限制");
    expect(CARD_POOL_HEURISTIC_NOTE).toContain("--allow");
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

describe("M8 deck optimizer C1-3b candidate generator", () => {
  const aobaDeck = findBenchmarkDeck("青葉城西-二彈改");

  it("在候選卡池與核心鎖定下產生小幅 candidate deck", () => {
    const lockedCards = autoLockCoreCards(benchmarkDb, aobaDeck.ids);
    const proposal = createDeckOptimizerCandidateProposal({
      db: benchmarkDb,
      sourceDeck: aobaDeck,
      cardPool: resolveOptimizerCardPool(benchmarkDb, aobaDeck.ids),
      constraints: { lockedCards },
      objectiveProfile: "preserve-current",
      maxReplacements: 2,
      evaluationConfig: {
        opponents: ["音駒-預組"],
        policy: "heuristic-v2",
        opponentPolicy: "heuristic-v2",
        preset: "smoke",
      },
      generatedAt: "2026-06-18T00:00:00.000Z",
    });
    const candidateCounts = deckOptimizerCardCounts(proposal.candidateDeckCards);

    expect(proposal.status).toBe("draft");
    expect(deckOptimizerTotalCards(proposal.candidateDeckCards)).toBe(40);
    expect(deckOptimizerEventCount(benchmarkDb, proposal.candidateDeckCards)).toBeLessThanOrEqual(8);
    expect(proposal.changes.reduce((sum, change) => sum + Math.max(0, change.delta), 0)).toBeLessThanOrEqual(2);
    for (const locked of lockedCards) expect(candidateCounts.get(locked.id) ?? 0).toBeGreaterThanOrEqual(locked.minCount);
    expect(validateDeckOptimizerProposal(benchmarkDb, proposal).ok).toBe(true);
  });

  it("banned card 原本在牌組中時，candidate generator 會優先移除", () => {
    const proposal = createDeckOptimizerCandidateProposal({
      db: benchmarkDb,
      sourceDeck: aobaDeck,
      cardPool: resolveOptimizerCardPool(benchmarkDb, aobaDeck.ids, { banned: ["HV-P01-086"] }),
      constraints: { lockedCards: autoLockCoreCards(benchmarkDb, aobaDeck.ids), bannedCards: ["HV-P01-086"] },
      objectiveProfile: "preserve-current",
      maxReplacements: 1,
      evaluationConfig: {
        opponents: ["音駒-預組"],
        policy: "heuristic-v2",
        opponentPolicy: "heuristic-v2",
        preset: "smoke",
      },
    });

    expect(deckOptimizerCardCounts(proposal.candidateDeckCards).get("HV-P01-086") ?? 0).toBe(0);
    expect(validateDeckOptimizerProposal(benchmarkDb, proposal).ok).toBe(true);
  });
});

describe("M8 deck optimizer C1-4 evaluation scoring", () => {
  it("把 Deck Analyzer comparison 轉成 proposal deltas、score 與狀態", () => {
    const proposal = proposalWith(applyDeltas(sourceDeckCards, { "HV-P02-017": 1, "HV-P02-085": -1 }));
    const report = {
      base: { aggregate: metrics({ winRate: 0.45, setWinRate: 0.48, noDeployLossRate: 0.2, judgeFailLossRate: 0.3, paidGutsPerMatch: 2, eventEffectiveRate: 0.3 }) },
      candidate: { aggregate: metrics({ winRate: 0.55, setWinRate: 0.52, noDeployLossRate: 0.1, judgeFailLossRate: 0.2, paidGutsPerMatch: 1.5, eventEffectiveRate: 0.4 }) },
      comparison: { notes: ["勝率差 +10.0%"], verdict: "candidate-better" },
    } as DeckAnalyzerComparisonReport;
    const scored = scoreDeckOptimizerComparison(report, proposal);
    const evaluated = attachDeckOptimizerEvaluation(proposal, report);

    expect(scored.deltas.matchWinRateDelta).toBeCloseTo(0.1);
    expect(scored.deltas.noDeployLossDelta).toBeCloseTo(0.1);
    expect(scored.score!.value).toBeGreaterThan(0);
    expect(scored.status).toBe("candidate");
    expect(evaluated.baselineMetrics).not.toBeNull();
    expect(evaluated.candidateMetrics).not.toBeNull();
    expect(evaluated.rationale.some((line) => line.includes("C1-4 evaluation"))).toBe(true);
  });
});

describe("M8 deck optimizer C2 validation matrix", () => {
  function comparison(base: AnalyzerMetrics, candidate: AnalyzerMetrics, note = "勝率差 +0.0%"): DeckAnalyzerComparisonReport {
    return {
      base: { aggregate: base },
      candidate: { aggregate: candidate },
      comparison: { notes: [note], verdict: "too-close" },
    } as DeckAnalyzerComparisonReport;
  }

  it("formal 與 holdout 站得住時才標 validated", () => {
    const proposal = proposalWith(applyDeltas(sourceDeckCards, { "HV-P02-017": 1, "HV-P02-085": -1 }));
    const matrix = buildDeckOptimizerValidationMatrix(proposal, [
      {
        label: "formal",
        preset: "formal",
        gamesPerSeat: 20,
        seedStart: 3200,
        report: comparison(metrics({ winRate: 0.5, setWinRate: 0.5 }), metrics({ winRate: 0.58, setWinRate: 0.54 }), "formal improved"),
      },
      {
        label: "holdout",
        preset: "holdout",
        gamesPerSeat: 10,
        seedStart: 9000,
        report: comparison(metrics({ winRate: 0.5, setWinRate: 0.5 }), metrics({ winRate: 0.53, setWinRate: 0.52 }), "holdout stable"),
      },
    ], "2026-06-18T00:00:00.000Z");
    const attached = attachDeckOptimizerValidationMatrix(proposal, [
      {
        label: "formal",
        preset: "formal",
        gamesPerSeat: 20,
        seedStart: 3200,
        report: comparison(metrics({ winRate: 0.5, setWinRate: 0.5 }), metrics({ winRate: 0.58, setWinRate: 0.54 }), "formal improved"),
      },
      {
        label: "holdout",
        preset: "holdout",
        gamesPerSeat: 10,
        seedStart: 9000,
        report: comparison(metrics({ winRate: 0.5, setWinRate: 0.5 }), metrics({ winRate: 0.53, setWinRate: 0.52 }), "holdout stable"),
      },
    ]);

    expect(matrix.verdict).toBe("validated");
    expect(matrix.runs).toHaveLength(2);
    expect(attached.status).toBe("validated");
    expect(attached.validation?.strategy).toBe("formal-holdout-v1");
  });

  it("holdout 明顯回落時標 rejected", () => {
    const proposal = proposalWith(applyDeltas(sourceDeckCards, { "HV-P02-017": 1, "HV-P02-085": -1 }));
    const attached = attachDeckOptimizerValidationMatrix(proposal, [
      {
        label: "formal",
        preset: "formal",
        gamesPerSeat: 20,
        seedStart: 3200,
        report: comparison(metrics({ winRate: 0.5 }), metrics({ winRate: 0.56 }), "formal improved"),
      },
      {
        label: "holdout",
        preset: "holdout",
        gamesPerSeat: 10,
        seedStart: 9000,
        report: comparison(metrics({ winRate: 0.5 }), metrics({ winRate: 0.42 }), "holdout dropped"),
      },
    ]);

    expect(attached.validation?.verdict).toBe("rejected");
    expect(attached.status).toBe("rejected");
    expect(attached.risks.some((line) => line.includes("C2"))).toBe(true);
  });
});
