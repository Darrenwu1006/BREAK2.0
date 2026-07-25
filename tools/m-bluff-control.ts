import process from "node:process";
import { stringArg } from "../src/shared/argv";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { benchmarkDb } from "../src/ai/benchmark-fixtures";
import {
  runMBluffDropHandControl,
  runMBluffPublicPostureCalibratedControl,
  runMBluffPublicPostureCalibratedSweep,
  runMBluffPublicPostureChoiceControl,
  runMBluffPublicPostureControl,
  runMBluffResourceTempoCalibratedControl,
  runMBluffResourceTempoCalibratedSweep,
  runMBluffResourceTempoControl,
  runMBluffResourceTempoSweep,
} from "../src/ai/m-bluff-control";

const iterations = Number(stringArg("iterations", "80"));
const leafRolloutHorizon = Number(stringArg("leaf-horizon", "4"));
const calibrationHorizon = Number(stringArg("calibration-horizon", "12"));
const scenario = stringArg("scenario", "drop-hand");
const sweep = process.argv.includes("--sweep");
const seeds = Number(stringArg("seeds", "5"));
const outPath = stringArg("out", "");
const defaultSeed =
  scenario === "choice-rate-v2"
    ? "980"
    : scenario === "resource-tempo-v2"
      ? "970"
      : scenario === "resource-tempo"
        ? "960"
        : scenario === "choice-rate"
          ? "950"
          : scenario === "public-posture"
            ? "940"
            : "930";
const seed = Number(stringArg("seed", defaultSeed));
const report =
  scenario === "choice-rate-v2" && sweep
    ? runMBluffPublicPostureCalibratedSweep(benchmarkDb, { seedStart: seed, seeds, iterations, leafRolloutHorizon, calibrationHorizon })
    : scenario === "choice-rate-v2"
    ? runMBluffPublicPostureCalibratedControl(benchmarkDb, { seed, iterations, leafRolloutHorizon, calibrationHorizon })
    : scenario === "resource-tempo-v2" && sweep
    ? runMBluffResourceTempoCalibratedSweep(benchmarkDb, { seedStart: seed, seeds, iterations, leafRolloutHorizon, calibrationHorizon })
    : scenario === "resource-tempo-v2"
    ? runMBluffResourceTempoCalibratedControl(benchmarkDb, { seed, iterations, leafRolloutHorizon, calibrationHorizon })
    : scenario === "resource-tempo" && sweep
    ? runMBluffResourceTempoSweep(benchmarkDb, { seedStart: seed, seeds, iterations, leafRolloutHorizon })
    : scenario === "resource-tempo"
    ? runMBluffResourceTempoControl(benchmarkDb, { seed, iterations, leafRolloutHorizon })
    : scenario === "choice-rate"
    ? runMBluffPublicPostureChoiceControl(benchmarkDb, { seed, iterations, leafRolloutHorizon })
    : scenario === "public-posture"
    ? runMBluffPublicPostureControl(benchmarkDb, { seed, iterations })
    : runMBluffDropHandControl(benchmarkDb, { seed, iterations });

console.log(`M-Bluff-Control: ${report.scenario}`);
console.log(report.description);
if (report.scenario === "resource-tempo-defense-pressure-sweep") {
  console.log(`Seeds: ${report.seedStart}..${report.seedStart + report.seeds - 1}`);
  console.log(`Iterations: ${report.iterations}, leaf rollout horizon: ${report.leafRolloutHorizon}`);
  console.log("Resource-tempo sweep summary:");
  for (const item of report.summaries) {
    console.log(
      `- ${item.policy}: avgDelta=${item.averageAttackPointDelta?.toFixed(2) ?? "n/a"}, ` +
        `positiveDelta=${item.positiveDeltaRate === null ? "n/a" : `${(item.positiveDeltaRate * 100).toFixed(1)}%`}, ` +
        `richAttack=${item.averageRichAttackPoint?.toFixed(2) ?? "n/a"}, poorAttack=${item.averagePoorAttackPoint?.toFixed(2) ?? "n/a"}, ` +
        `iterations=${item.averageRichCompletedIterations.toFixed(1)}/${item.averagePoorCompletedIterations.toFixed(1)}, ` +
        `timeout=${(item.timeoutRate * 100).toFixed(1)}%`,
    );
  }
} else if (report.scenario === "resource-tempo-defense-pressure-v2-sweep") {
  console.log(`Seeds: ${report.seedStart}..${report.seedStart + report.seeds - 1}`);
  console.log(`Iterations: ${report.iterations}, leaf rollout horizon: ${report.leafRolloutHorizon}, calibration horizon: ${report.calibrationHorizon}`);
  console.log("Resource-tempo v2 calibrated sweep summary:");
  for (const item of report.summaries) {
    console.log(
      `- ${item.policy}: incentive=${(item.incentiveCompatibleRate * 100).toFixed(1)}%, ` +
        `gtDelta=${item.averageGroundTruthAttackPointDelta?.toFixed(2) ?? "n/a"}, ` +
        `avgDelta=${item.averageAttackPointDelta?.toFixed(2) ?? "n/a"}, ` +
        `match=${item.directionMatchRate === null ? "n/a" : `${(item.directionMatchRate * 100).toFixed(1)}%`}, ` +
        `positive=${item.positiveDeltaRate === null ? "n/a" : `${(item.positiveDeltaRate * 100).toFixed(1)}%`}, ` +
        `gap=${item.averageRichValueGapToGroundTruth?.toFixed(3) ?? "n/a"}/${item.averagePoorValueGapToGroundTruth?.toFixed(3) ?? "n/a"}, ` +
        `iterations=${item.averageRichCompletedIterations.toFixed(1)}/${item.averagePoorCompletedIterations.toFixed(1)}, ` +
        `timeout=${(item.timeoutRate * 100).toFixed(1)}%`,
    );
  }
} else if (report.scenario === "public-posture-choice-rate-v2-sweep") {
  console.log(`Seeds: ${report.seedStart}..${report.seedStart + report.seeds - 1}`);
  console.log(`Iterations: ${report.iterations}, leaf rollout horizon: ${report.leafRolloutHorizon}, calibration horizon: ${report.calibrationHorizon}`);
  console.log("Choice-rate v2 calibrated sweep summary:");
  for (const item of report.summaries) {
    console.log(
      `- ${item.policy}: incentive=${(item.incentiveCompatibleRate * 100).toFixed(1)}%, ` +
        `gtBluff=${item.weakGroundTruthBluffRate === null ? "n/a" : `${(item.weakGroundTruthBluffRate * 100).toFixed(1)}%`}, ` +
        `weakPublicStrong=${(item.weakPublicStrongRate * 100).toFixed(1)}%, ` +
        `match=${item.weakDirectionMatchRate === null ? "n/a" : `${(item.weakDirectionMatchRate * 100).toFixed(1)}%`}, ` +
        `weakLift=${item.averageWeakPublicStrongValueLift?.toFixed(3) ?? "n/a"}, ` +
        `gap=${item.averageStrongValueGapToGroundTruth?.toFixed(3) ?? "n/a"}/${item.averageWeakValueGapToGroundTruth?.toFixed(3) ?? "n/a"}, ` +
        `iterations=${item.averageStrongCompletedIterations.toFixed(1)}/${item.averageWeakCompletedIterations.toFixed(1)}, ` +
        `timeout=${(item.timeoutRate * 100).toFixed(1)}%`,
    );
  }
} else if (report.scenario === "drop-hand-private-choice") {
  console.log(`Candidates: ${report.candidateLabels.join(" / ")}`);
  console.log("Opponent projection buckets:");
  for (const [index, bucket] of report.opponentBuckets.entries()) {
    console.log(`- bucket ${index + 1}: ${bucket.labels.length} private choices -> ${bucket.labels.join(" / ")}`);
  }
  console.log("Policy choices:");
  for (const item of report.results) {
    console.log(
      `- ${item.policy}: ${item.bestLabel}, private discard cost=${item.privateDiscardCost ?? "n/a"}, ` +
        `bucket size=${item.opponentBucketSize}, iterations=${item.completedIterations}, timeout=${item.timedOut}`,
    );
  }
} else if (report.scenario === "public-posture-private-backing") {
  console.log(`Public posture: ${report.publicPosture}`);
  console.log(`Hidden backing: strong=${report.hiddenBacking.strongLabel}, weak=${report.hiddenBacking.weakLabel}`);
  console.log("Paired-state policy choices:");
  for (const item of report.results) {
    console.log(
      `- ${item.policy}: strong=${item.strongBestLabel}, weak=${item.weakBestLabel}, ` +
        `same=${item.sameChoiceAcrossHiddenBacking}, iterations=${item.strongCompletedIterations}/${item.weakCompletedIterations}, ` +
        `timeout=${item.strongTimedOut}/${item.weakTimedOut}`,
    );
  }
} else if (report.scenario === "public-posture-choice-rate") {
  console.log(`Public strong posture: ${report.publicStrongPosture}`);
  console.log(`Public honest posture: ${report.publicHonestPosture}`);
  console.log(`Hidden backing: strong=${report.hiddenBacking.strongLabel}, weak=${report.hiddenBacking.weakLabel}`);
  console.log(`Leaf rollout horizon: ${report.leafRolloutHorizon}`);
  console.log("Choice-rate proxy:");
  for (const item of report.results) {
    console.log(
      `- ${item.policy}: strong=${item.strongBestLabel} (publicStrong=${item.strongChoosesPublicStrong}), ` +
        `weak=${item.weakBestLabel} (publicStrong=${item.weakChoosesPublicStrong}), ` +
        `lift=${item.bluffChoiceLift}, iterations=${item.strongCompletedIterations}/${item.weakCompletedIterations}, ` +
      `timeout=${item.strongTimedOut}/${item.weakTimedOut}`,
    );
  }
} else if (report.scenario === "public-posture-choice-rate-v2") {
  console.log(`Public strong posture: ${report.publicStrongPosture}`);
  console.log(`Public honest posture: ${report.publicHonestPosture}`);
  console.log(`Hidden backing: strong=${report.hiddenBacking.strongLabel}, weak=${report.hiddenBacking.weakLabel}`);
  console.log(`Leaf rollout horizon: ${report.leafRolloutHorizon}, calibration horizon: ${report.calibrationHorizon}`);
  console.log(
    `Ground truth: strong=${report.groundTruth.strongBestLabel} (publicStrong=${report.groundTruth.strongChoosesPublicStrong ?? "n/a"}), ` +
      `weak=${report.groundTruth.weakBestLabel} (publicStrong=${report.groundTruth.weakChoosesPublicStrong ?? "n/a"}), ` +
      `weakLift=${report.groundTruth.weakPublicStrongValueLift?.toFixed(3) ?? "n/a"}, incentive=${report.incentiveCompatible}`,
  );
  console.log("Choice-rate v2 calibrated proxy:");
  for (const item of report.results) {
    console.log(
      `- ${item.policy}: strong=${item.strongBestLabel} (publicStrong=${item.strongChoosesPublicStrong}, gap=${item.strongValueGapToGroundTruth?.toFixed(3) ?? "n/a"}), ` +
        `weak=${item.weakBestLabel} (publicStrong=${item.weakChoosesPublicStrong}, gap=${item.weakValueGapToGroundTruth?.toFixed(3) ?? "n/a"}), ` +
        `matchWeakGroundTruth=${item.matchesWeakGroundTruthChoice ?? "n/a"}, lift=${item.bluffChoiceLift}, ` +
        `iterations=${item.strongCompletedIterations}/${item.weakCompletedIterations}, timeout=${item.strongTimedOut}/${item.weakTimedOut}`,
    );
  }
} else if (report.scenario === "resource-tempo-defense-pressure") {
  console.log(`Attack choices: ${report.publicAttackChoices.join(" / ")}`);
  console.log(`Opponent public resources: rich hand=${report.opponentPublicResources.richHandCount}, poor hand=${report.opponentPublicResources.poorHandCount}`);
  console.log(`Leaf rollout horizon: ${report.leafRolloutHorizon}`);
  console.log("Resource-tempo proxy:");
  for (const item of report.results) {
    console.log(
      `- ${item.policy}: rich=${item.richBestLabel} (attack=${item.richAttackPoint ?? "n/a"}, max=${item.richChoosesMaxAttack}, noDeploy=${item.richNoDeploy}), ` +
        `poor=${item.poorBestLabel} (attack=${item.poorAttackPoint ?? "n/a"}, max=${item.poorChoosesMaxAttack}, noDeploy=${item.poorNoDeploy}), ` +
        `attackDelta=${item.attackPointDelta ?? "n/a"}, ` +
        `conservativeLiftWhenRich=${item.conservativeLiftWhenRich}, iterations=${item.richCompletedIterations}/${item.poorCompletedIterations}, ` +
        `timeout=${item.richTimedOut}/${item.poorTimedOut}`,
    );
  }
} else {
  console.log(`Attack choices: ${report.publicAttackChoices.join(" / ")}`);
  console.log(`Opponent public resources: rich hand=${report.opponentPublicResources.richHandCount}, poor hand=${report.opponentPublicResources.poorHandCount}`);
  console.log(`Leaf rollout horizon: ${report.leafRolloutHorizon}, calibration horizon: ${report.calibrationHorizon}`);
  console.log(
    `Ground truth: rich=${report.groundTruth.richBestLabel} (attack=${report.groundTruth.richBestAttackPoint ?? "n/a"}), ` +
      `poor=${report.groundTruth.poorBestLabel} (attack=${report.groundTruth.poorBestAttackPoint ?? "n/a"}), ` +
      `gtDelta=${report.groundTruth.attackPointDelta ?? "n/a"}, incentive=${report.incentiveCompatible}`,
  );
  console.log("Resource-tempo v2 calibrated proxy:");
  for (const item of report.results) {
    console.log(
      `- ${item.policy}: rich=${item.richBestLabel} (attack=${item.richAttackPoint ?? "n/a"}, gap=${item.richValueGapToGroundTruth?.toFixed(3) ?? "n/a"}), ` +
        `poor=${item.poorBestLabel} (attack=${item.poorAttackPoint ?? "n/a"}, gap=${item.poorValueGapToGroundTruth?.toFixed(3) ?? "n/a"}), ` +
        `attackDelta=${item.attackPointDelta ?? "n/a"}, matchGroundTruth=${item.matchesGroundTruthDirection ?? "n/a"}, ` +
        `iterations=${item.richCompletedIterations}/${item.poorCompletedIterations}, timeout=${item.richTimedOut}/${item.poorTimedOut}`,
    );
  }
}

if (outPath) {
  const abs = resolve(outPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Report written: ${abs}`);
}
