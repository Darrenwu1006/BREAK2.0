import { describe, expect, it } from "vitest";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import { DECK_ANALYZER_SCHEMA_VERSION, runDeckAnalyzer, runDeckAnalyzerComparison } from "./deck-analyzer";

describe("M8 deck analyzer", () => {
  it("輸出牌組靜態結構、對局彙整與可讀分析", () => {
    const report = runDeckAnalyzer({
      db: benchmarkDb,
      deck: findBenchmarkDeck("烏野-預組"),
      opponents: [findBenchmarkDeck("音駒-預組")],
      policy: "heuristic-v2",
      opponentPolicy: "random",
      gamesPerSeat: 1,
      seedStart: 1300,
      maxSteps: 5000,
    }, "2026-06-18T00:00:00.000Z");

    expect(report.schemaVersion).toBe(DECK_ANALYZER_SCHEMA_VERSION);
    expect(report.generatedAt).toBe("2026-06-18T00:00:00.000Z");
    expect(report.config.deck).toBe("烏野-預組");
    expect(report.config.preset).toBe("custom");
    expect(report.staticProfile.totalCards).toBe(40);
    expect(report.staticProfile.characterCount + report.staticProfile.eventCount).toBe(40);
    expect(report.staticProfile.playableCounts.serve).toBeGreaterThan(0);
    expect(report.staticProfile.openingQuality.servingCoreRate).toBeGreaterThanOrEqual(0);
    expect(report.staticProfile.openingQuality.servingCoreRate).toBeLessThanOrEqual(1);
    expect(report.matchups).toHaveLength(1);
    expect(report.aggregate.games).toBe(2);
    expect(report.aggregate.completed).toBe(2);
    expect(report.aggregate.winRate).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.winRate).toBeLessThanOrEqual(1);
    expect(report.aggregate.averageServeOp).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.averageBlockOp).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.eventEffectiveRate).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.eventEffectiveRate).toBeLessThanOrEqual(1);
    expect(report.aggregate.skillEffectiveRate).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.skillEffectiveRate).toBeLessThanOrEqual(1);
    expect(report.aggregate.gutsPaidBySourcePerMatch.attack).toBeGreaterThanOrEqual(0);
    expect(report.matchups[0]!.diagnosis.length).toBeGreaterThan(0);
    expect(report.gameplan.length).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it("支援 holdout preset 標記，讓同牌組可用保留 seed 池複測", () => {
    const report = runDeckAnalyzer({
      db: benchmarkDb,
      deck: findBenchmarkDeck("烏野-預組"),
      opponents: [findBenchmarkDeck("音駒-預組")],
      policy: "heuristic-v2",
      opponentPolicy: "heuristic-v2",
      gamesPerSeat: 1,
      seedStart: 9000,
      maxSteps: 5000,
      preset: "holdout",
    }, "2026-06-18T00:00:00.000Z");

    expect(report.config.preset).toBe("holdout");
    expect(report.config.seedStart).toBe(9000);
    expect(report.matchups[0]!.diagnosis.length).toBeGreaterThan(0);
  });

  it("同一組 seed 重跑會得到相同分析數字", () => {
    const config = {
      db: benchmarkDb,
      deck: findBenchmarkDeck("烏野-預組"),
      opponents: [findBenchmarkDeck("音駒-預組"), findBenchmarkDeck("青葉城西-快攻軸")],
      policy: "heuristic-v2" as const,
      opponentPolicy: "heuristic-v2" as const,
      gamesPerSeat: 1,
      seedStart: 1320,
      maxSteps: 5000,
    };

    const first = runDeckAnalyzer(config, "2026-06-18T00:00:00.000Z");
    const second = runDeckAnalyzer(config, "2026-06-18T00:00:00.000Z");

    expect(second.aggregate).toEqual(first.aggregate);
    expect(second.matchups.map((matchup) => matchup.metrics)).toEqual(first.matchups.map((matchup) => matchup.metrics));
    expect(second.brickSources).toEqual(first.brickSources);
  });

  it("支援同對手池的 A/B deck version 比較", () => {
    const report = runDeckAnalyzerComparison({
      db: benchmarkDb,
      baseDeck: findBenchmarkDeck("伊達工業-攔網軸"),
      candidateDeck: findBenchmarkDeck("伊達工業-攔網軸改"),
      opponents: [findBenchmarkDeck("烏野-預組")],
      policy: "heuristic-v2",
      opponentPolicy: "heuristic-v2",
      gamesPerSeat: 1,
      seedStart: 1340,
      maxSteps: 5000,
    }, "2026-06-18T00:00:00.000Z");

    expect(report.schemaVersion).toBe(DECK_ANALYZER_SCHEMA_VERSION);
    expect(report.base.config.deck).toBe("伊達工業-攔網軸");
    expect(report.candidate.config.deck).toBe("伊達工業-攔網軸改");
    expect(report.comparison.baseDeck).toBe("伊達工業-攔網軸");
    expect(report.comparison.candidateDeck).toBe("伊達工業-攔網軸改");
    expect(["candidate-better", "base-better", "too-close"]).toContain(report.comparison.verdict);
    expect(report.comparison.matchupDeltas).toHaveLength(1);
  });
});
