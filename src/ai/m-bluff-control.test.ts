import { describe, expect, it } from "vitest";
import { applyDecision } from "../engine/engine";
import { determinizeHiddenState } from "./coach";
import { benchmarkDb } from "./benchmark-fixtures";
import { extractValueFeatures, VALUE_FEATURE_NAMES } from "./rollout-value";
import {
  createDropHandPrivateChoiceState,
  createPublicPostureChoiceStates,
  createPublicPosturePrivateBackingStates,
  createResourceTempoDefensePressureStates,
  runMBluffDropHandControl,
  runMBluffPublicPostureCalibratedControl,
  runMBluffPublicPostureCalibratedSweep,
  runMBluffPublicPostureChoiceControl,
  runMBluffPublicPostureControl,
  runMBluffResourceTempoCalibratedControl,
  runMBluffResourceTempoCalibratedSweep,
  runMBluffResourceTempoControl,
  runMBluffResourceTempoSweep,
} from "./m-bluff-control";

describe("M8 Phase I M-Bluff controlled scenarios", () => {
  it("dropHand 私有選擇會在對手視角塌縮成同一 bucket，且 SO/MO 皆回合法決策", () => {
    const state = createDropHandPrivateChoiceState(benchmarkDb);
    const report = runMBluffDropHandControl(benchmarkDb, { iterations: 12 });

    expect(report.scenario).toBe("drop-hand-private-choice");
    expect(report.candidateLabels.length).toBeGreaterThanOrEqual(3);
    expect(report.opponentBuckets).toHaveLength(1);
    expect(report.opponentBuckets[0]!.labels.length).toBeGreaterThanOrEqual(3);

    for (const result of report.results) {
      expect(result.opponentBucketSize).toBeGreaterThanOrEqual(3);
      expect(result.privateDiscardCost).not.toBeNull();
      expect(() => applyDecision(benchmarkDb, state, result.bestDecision)).not.toThrow();
    }
  });

  it("public posture paired states 不會因 P0 隱藏 backing 強弱而改變 P1 防守策略", () => {
    const { strong, weak } = createPublicPosturePrivateBackingStates(benchmarkDb);
    const report = runMBluffPublicPostureControl(benchmarkDb, { iterations: 12 });

    expect(report.scenario).toBe("public-posture-private-backing");
    expect(report.publicPosture).toContain("OP=5");
    expect(report.hiddenBacking.strongLabel).not.toBe(report.hiddenBacking.weakLabel);

    for (const result of report.results) {
      expect(result.sameChoiceAcrossHiddenBacking, result.policy).toBe(true);
      expect(() => applyDecision(benchmarkDb, strong, result.strongBestDecision)).not.toThrow();
      expect(() => applyDecision(benchmarkDb, weak, result.weakBestDecision)).not.toThrow();
    }
  });

  it("public posture choice-rate proxy 會回傳強弱 backing paired states 的合法托球決策", () => {
    const { strong, weak } = createPublicPostureChoiceStates(benchmarkDb);
    const report = runMBluffPublicPostureChoiceControl(benchmarkDb, { iterations: 12, leafRolloutHorizon: 2 });

    expect(report.scenario).toBe("public-posture-choice-rate");
    expect(report.publicStrongPosture).not.toBe(report.publicHonestPosture);
    expect(report.hiddenBacking.strongLabel).not.toBe(report.hiddenBacking.weakLabel);
    expect(report.leafRolloutHorizon).toBe(2);

    for (const result of report.results) {
      expect(typeof result.strongChoosesPublicStrong, result.policy).toBe("boolean");
      expect(typeof result.weakChoosesPublicStrong, result.policy).toBe("boolean");
      expect([-1, 0, 1]).toContain(result.bluffChoiceLift);
      expect(() => applyDecision(benchmarkDb, strong, result.strongBestDecision)).not.toThrow();
      expect(() => applyDecision(benchmarkDb, weak, result.weakBestDecision)).not.toThrow();
    }
  });

  it("public posture v2 會輸出校準後的 weak backing 公開姿態 ground truth", () => {
    const { strong, weak } = createPublicPostureChoiceStates(benchmarkDb, 980);
    const report = runMBluffPublicPostureCalibratedControl(benchmarkDb, { seed: 980, iterations: 12, leafRolloutHorizon: 2, calibrationHorizon: 4 });

    expect(report.scenario).toBe("public-posture-choice-rate-v2");
    expect(report.groundTruth.strongScores.length).toBeGreaterThan(0);
    expect(report.groundTruth.weakScores.length).toBeGreaterThan(0);
    expect(typeof report.incentiveCompatible).toBe("boolean");

    for (const result of report.results) {
      expect(result.strongValueGapToGroundTruth === null || result.strongValueGapToGroundTruth >= 0).toBe(true);
      expect(result.weakValueGapToGroundTruth === null || result.weakValueGapToGroundTruth >= 0).toBe(true);
      expect(result.matchesWeakGroundTruthChoice === null || typeof result.matchesWeakGroundTruthChoice === "boolean").toBe(true);
      expect(() => applyDecision(benchmarkDb, strong, result.strongBestDecision)).not.toThrow();
      expect(() => applyDecision(benchmarkDb, weak, result.weakBestDecision)).not.toThrow();
    }
  });

  it("public posture v2 sweep 會聚合 weak backing 方向命中率", () => {
    const report = runMBluffPublicPostureCalibratedSweep(benchmarkDb, {
      seedStart: 980,
      seeds: 2,
      iterations: 12,
      leafRolloutHorizon: 2,
      calibrationHorizon: 4,
    });

    expect(report.scenario).toBe("public-posture-choice-rate-v2-sweep");
    expect(report.reports).toHaveLength(2);
    expect(report.summaries).toHaveLength(2);

    for (const summary of report.summaries) {
      expect(summary.incentiveCompatibleRate).toBeGreaterThanOrEqual(0);
      expect(summary.incentiveCompatibleRate).toBeLessThanOrEqual(1);
      if (summary.weakDirectionMatchRate !== null) {
        expect(summary.weakDirectionMatchRate).toBeGreaterThanOrEqual(0);
        expect(summary.weakDirectionMatchRate).toBeLessThanOrEqual(1);
      }
    }
  });

  it("resource-tempo proxy 會回傳對手公開資源量 paired states 的合法攻擊決策", () => {
    const { rich, poor } = createResourceTempoDefensePressureStates(benchmarkDb);
    const report = runMBluffResourceTempoControl(benchmarkDb, { iterations: 12, leafRolloutHorizon: 2 });

    expect(report.scenario).toBe("resource-tempo-defense-pressure");
    expect(report.publicAttackChoices.length).toBeGreaterThanOrEqual(3);
    expect(report.opponentPublicResources.richHandCount).toBeGreaterThan(report.opponentPublicResources.poorHandCount);
    expect(report.leafRolloutHorizon).toBe(2);

    for (const result of report.results) {
      expect(typeof result.richChoosesMaxAttack, result.policy).toBe("boolean");
      expect(typeof result.poorChoosesMaxAttack, result.policy).toBe("boolean");
      expect(result.attackPointDelta).toBe(result.richAttackPoint === null || result.poorAttackPoint === null ? null : result.poorAttackPoint - result.richAttackPoint);
      expect([-1, 0, 1]).toContain(result.conservativeLiftWhenRich);
      expect(() => applyDecision(benchmarkDb, rich, result.richBestDecision)).not.toThrow();
      expect(() => applyDecision(benchmarkDb, poor, result.poorBestDecision)).not.toThrow();
    }
  });

  it("resource-tempo sweep 會聚合方向性 attackPointDelta 指標", () => {
    const report = runMBluffResourceTempoSweep(benchmarkDb, { seedStart: 960, seeds: 2, iterations: 12, leafRolloutHorizon: 2 });

    expect(report.scenario).toBe("resource-tempo-defense-pressure-sweep");
    expect(report.reports).toHaveLength(2);
    expect(report.summaries).toHaveLength(2);
    expect(report.iterations).toBe(12);

    for (const summary of report.summaries) {
      expect(summary.seeds).toBe(2);
      expect(summary.averageRichCompletedIterations).toBeGreaterThan(0);
      expect(summary.averagePoorCompletedIterations).toBeGreaterThan(0);
      if (summary.averageAttackPointDelta !== null) {
        expect(Number.isFinite(summary.averageAttackPointDelta)).toBe(true);
      }
      if (summary.positiveDeltaRate !== null) {
        expect(summary.positiveDeltaRate).toBeGreaterThanOrEqual(0);
        expect(summary.positiveDeltaRate).toBeLessThanOrEqual(1);
      }
    }
  });

  it("resource-tempo v2 會輸出校準後的 ground-truth 方向與合法決策", () => {
    const { rich, poor } = createResourceTempoDefensePressureStates(benchmarkDb, 970);
    const report = runMBluffResourceTempoCalibratedControl(benchmarkDb, { seed: 970, iterations: 12, leafRolloutHorizon: 2, calibrationHorizon: 4 });

    expect(report.scenario).toBe("resource-tempo-defense-pressure-v2");
    expect(report.groundTruth.richScores.length).toBeGreaterThan(0);
    expect(report.groundTruth.poorScores.length).toBeGreaterThan(0);
    expect(report.groundTruth.attackPointDelta).toBe(
      report.groundTruth.richBestAttackPoint === null || report.groundTruth.poorBestAttackPoint === null
        ? null
        : report.groundTruth.poorBestAttackPoint - report.groundTruth.richBestAttackPoint,
    );
    expect(typeof report.incentiveCompatible).toBe("boolean");

    for (const result of report.results) {
      expect(result.richValueGapToGroundTruth === null || result.richValueGapToGroundTruth >= 0).toBe(true);
      expect(result.poorValueGapToGroundTruth === null || result.poorValueGapToGroundTruth >= 0).toBe(true);
      expect(result.matchesGroundTruthDirection === null || typeof result.matchesGroundTruthDirection === "boolean").toBe(true);
      expect(() => applyDecision(benchmarkDb, rich, result.richBestDecision)).not.toThrow();
      expect(() => applyDecision(benchmarkDb, poor, result.poorBestDecision)).not.toThrow();
    }
  });

  it("resource-tempo v2 sweep 會聚合誘因相容率與方向命中率", () => {
    const report = runMBluffResourceTempoCalibratedSweep(benchmarkDb, {
      seedStart: 970,
      seeds: 2,
      iterations: 12,
      leafRolloutHorizon: 2,
      calibrationHorizon: 4,
    });

    expect(report.scenario).toBe("resource-tempo-defense-pressure-v2-sweep");
    expect(report.reports).toHaveLength(2);
    expect(report.summaries).toHaveLength(2);

    for (const summary of report.summaries) {
      expect(summary.incentiveCompatibleRate).toBeGreaterThanOrEqual(0);
      expect(summary.incentiveCompatibleRate).toBeLessThanOrEqual(1);
      if (summary.directionMatchRate !== null) {
        expect(summary.directionMatchRate).toBeGreaterThanOrEqual(0);
        expect(summary.directionMatchRate).toBeLessThanOrEqual(1);
      }
      if (summary.averageGroundTruthAttackPointDelta !== null) {
        expect(Number.isFinite(summary.averageGroundTruthAttackPointDelta)).toBe(true);
      }
    }
  });

  it("resource-tempo 的對手公開手牌張數不會在 MO determinization 中被塌縮", () => {
    const { rich, poor, knownDecks } = createResourceTempoDefensePressureStates(benchmarkDb, 970);
    const richWorld = determinizeHiddenState(rich, 0, knownDecks, 1234);
    const poorWorld = determinizeHiddenState(poor, 0, knownDecks, 1234);
    const handDiffIndex = VALUE_FEATURE_NAMES.indexOf("handDiff");

    expect(rich.players[1].hand).toHaveLength(6);
    expect(poor.players[1].hand).toHaveLength(1);
    expect(richWorld.players[1].hand).toHaveLength(6);
    expect(poorWorld.players[1].hand).toHaveLength(1);
    expect(extractValueFeatures(richWorld, 0, benchmarkDb)[handDiffIndex]).toBeLessThan(
      extractValueFeatures(poorWorld, 0, benchmarkDb)[handDiffIndex]!,
    );
  });
});
