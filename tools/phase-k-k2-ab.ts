import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { numberArg, stringArg } from "../src/shared/argv";
import { dirname, resolve } from "node:path";
import { benchmarkDb, findBenchmarkDeck } from "../src/ai/benchmark-fixtures";
import {
  mirroredSeeds,
  runBenchmarkBatch,
  type BenchmarkDeckInput,
  type BenchmarkPolicyId,
  type BenchmarkRunContext,
  type MatchResult,
  type PlayQualitySummary,
  type SearchDecisionDiagnostics,
} from "../src/ai/benchmark";
import type { ValueModel } from "../src/ai/rollout-value";

const MIRROR_DECKS = [
  "烏野-預組",
  "音駒-預組",
  "梟谷-高爆發軸",
  "白鳥沢-最強白鳥沢",
  "青葉城西-二彈改",
];

interface QualityAcc {
  lowPointDeployOpportunities: number;
  lowPointDeploys: number;
  lowPointDeficit: number;
  defenseSkillOpportunities: number;
  defenseSkillNonUses: number;
  defenseSkillFreeOpportunities: number;
  defenseSkillFreeNonUses: number;
  defenseSkillCostlyOpportunities: number;
  defenseSkillCostlyNonUses: number;
  opCount: number;
  opTotal: number;
  attackAttempts: number;
  attackSuccesses: number;
  attackOpTotal: number;
}

function isObject(value: unknown): value is { model?: unknown } {
  return typeof value === "object" && value !== null;
}

function isValueModel(value: unknown): value is ValueModel {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ValueModel).weights) &&
    typeof (value as ValueModel).bias === "number"
  );
}

function readValueModel(path: string): ValueModel {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const model = isValueModel(parsed)
    ? parsed
    : isObject(parsed) && isValueModel(parsed.model)
      ? parsed.model
      : undefined;
  if (!model) throw new Error(`not a ValueModel artifact: ${path}`);
  return model;
}

function deck(name: string): BenchmarkDeckInput {
  const d = findBenchmarkDeck(name);
  return { name: d.name, ids: d.ids, axes: d.axes };
}

function wilson(successes: number, total: number): { low: number; high: number; p: number } {
  if (total === 0) return { low: 0, high: 0, p: 0 };
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return { low: Math.max(0, (center - margin) / denom), high: Math.min(1, (center + margin) / denom), p };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function blankQualityAcc(): QualityAcc {
  return {
    lowPointDeployOpportunities: 0,
    lowPointDeploys: 0,
    lowPointDeficit: 0,
    defenseSkillOpportunities: 0,
    defenseSkillNonUses: 0,
    defenseSkillFreeOpportunities: 0,
    defenseSkillFreeNonUses: 0,
    defenseSkillCostlyOpportunities: 0,
    defenseSkillCostlyNonUses: 0,
    opCount: 0,
    opTotal: 0,
    attackAttempts: 0,
    attackSuccesses: 0,
    attackOpTotal: 0,
  };
}

function addQuality(acc: QualityAcc, match: MatchResult, player: 0 | 1): void {
  const stats = match.stats.players[player];
  const play = stats.playQuality;
  acc.lowPointDeployOpportunities += play.lowPointDeploy.toss.opportunities + play.lowPointDeploy.attack.opportunities;
  acc.lowPointDeploys += play.lowPointDeploy.toss.lowPointChoices + play.lowPointDeploy.attack.lowPointChoices;
  acc.lowPointDeficit += play.lowPointDeploy.toss.totalDeficit + play.lowPointDeploy.attack.totalDeficit;
  acc.defenseSkillOpportunities += play.defenseSkillNonUse.opportunities;
  acc.defenseSkillNonUses += play.defenseSkillNonUse.nonUses;
  acc.defenseSkillFreeOpportunities += play.defenseSkillNonUse.byCost.free.opportunities;
  acc.defenseSkillFreeNonUses += play.defenseSkillNonUse.byCost.free.nonUses;
  acc.defenseSkillCostlyOpportunities += play.defenseSkillNonUse.byCost.costly.opportunities;
  acc.defenseSkillCostlyNonUses += play.defenseSkillNonUse.byCost.costly.nonUses;
  acc.opCount += stats.op.count;
  acc.opTotal += stats.op.total;
  acc.attackAttempts += stats.attackSuccess.attempts;
  acc.attackSuccesses += stats.attackSuccess.successes;
  acc.attackOpTotal += stats.attackSuccess.opTotal;
}

function summarizeQuality(acc: QualityAcc): PlayQualitySummary {
  return {
    lowPointDeployOpportunities: acc.lowPointDeployOpportunities,
    lowPointDeploys: acc.lowPointDeploys,
    lowPointDeployRate: acc.lowPointDeployOpportunities === 0 ? 0 : acc.lowPointDeploys / acc.lowPointDeployOpportunities,
    averageLowPointDeficit: acc.lowPointDeploys === 0 ? 0 : acc.lowPointDeficit / acc.lowPointDeploys,
    defenseSkillOpportunities: acc.defenseSkillOpportunities,
    defenseSkillNonUses: acc.defenseSkillNonUses,
    defenseSkillNonUseRate: acc.defenseSkillOpportunities === 0 ? 0 : acc.defenseSkillNonUses / acc.defenseSkillOpportunities,
    defenseSkillFreeOpportunities: acc.defenseSkillFreeOpportunities,
    defenseSkillFreeNonUses: acc.defenseSkillFreeNonUses,
    defenseSkillFreeNonUseRate: acc.defenseSkillFreeOpportunities === 0 ? 0 : acc.defenseSkillFreeNonUses / acc.defenseSkillFreeOpportunities,
    defenseSkillCostlyOpportunities: acc.defenseSkillCostlyOpportunities,
    defenseSkillCostlyNonUses: acc.defenseSkillCostlyNonUses,
    defenseSkillCostlyNonUseRate: acc.defenseSkillCostlyOpportunities === 0 ? 0 : acc.defenseSkillCostlyNonUses / acc.defenseSkillCostlyOpportunities,
    averageOpPressure: acc.opCount === 0 ? 0 : acc.opTotal / acc.opCount,
    opPressureSamples: acc.opCount,
  };
}

function summarizeAttackSuccess(acc: QualityAcc) {
  return {
    attempts: acc.attackAttempts,
    successes: acc.attackSuccesses,
    rate: acc.attackAttempts === 0 ? 0 : acc.attackSuccesses / acc.attackAttempts,
    averageOp: acc.attackAttempts === 0 ? 0 : acc.attackOpTotal / acc.attackAttempts,
  };
}

function avg(items: readonly number[]): number {
  return items.length === 0 ? 0 : items.reduce((sum, item) => sum + item, 0) / items.length;
}

function summarizeDiagnostics(items: readonly SearchDecisionDiagnostics[]) {
  return {
    decisions: items.length,
    averageCompletedIterations: avg(items.map((item) => item.completedIterations)),
    timeoutRate: avg(items.map((item) => (item.timedOut ? 1 : 0))),
    averageRootVisitEntropy: avg(items.map((item) => item.rootVisitEntropy)),
    averageTopTwoVisitGap: avg(items.map((item) => item.topTwoVisitGap)),
  };
}

const modelPath = stringArg("value-model-file", "data/ab/phase-k-k15-selected-v1-fit-holdout-g2000-i16.json");
const outPath = stringArg("out", "data/ab/phase-k-k2-selected-v1-vs-current-h4-mirror-g40.json");
const games = Math.max(1, Math.floor(numberArg("games", 4)));
const timeMs = Math.max(1, Math.floor(numberArg("time-ms", 500)));
const leafHorizon = Math.max(0, Math.floor(numberArg("leaf-horizon", 40)));
const seedStart = Math.floor(numberArg("seed-start", 12000));
const rootTiebreakDelta = numberArg("root-tiebreak-delta", 0.04);
const rootConservationThreshold = numberArg("root-conservation-threshold", 0.85);
const k2RootTiebreakDelta = numberArg("k2-root-tiebreak-delta", rootTiebreakDelta);
const k2RootConservationThreshold = numberArg("k2-root-conservation-threshold", rootConservationThreshold);
const candidateModel = readValueModel(modelPath);

// [Claude 2026-07-24] 候選 B 塊 2：h4 用 live model（base valueModel 不設）；k2 的候選 model／delta／threshold 走 per-policy override。
const runContext: BenchmarkRunContext = {
  iterations: 1_000_000,
  timeLimitMs: timeMs,
  leafRolloutHorizon: leafHorizon,
  rootPressureTieBreakDelta: rootTiebreakDelta,
  rootConservationWinRateThreshold: rootConservationThreshold,
};
const runContextByPolicy: Partial<Record<BenchmarkPolicyId, BenchmarkRunContext>> = {
  "is-mcts-k2": {
    valueModel: candidateModel,
    rootPressureTieBreakDelta: k2RootTiebreakDelta,
    rootConservationWinRateThreshold: k2RootConservationThreshold,
  },
};

let candidateWins = 0;
let completed = 0;
const candidateQuality = blankQualityAcc();
const currentQuality = blankQualityAcc();
const pairResults: Array<{ deck: string; wins: number; completed: number; ci: { low: number; high: number; p: number } }> = [];
const allDiagnostics: SearchDecisionDiagnostics[] = [];
const start = Date.now();

console.log(`Phase K K2 A/B — is-mcts-k2(selected v1) vs is-mcts-h4(current) @ ${timeMs}ms, leaf=${leafHorizon}`);
console.log(`Structure: ${MIRROR_DECKS.length} mirror decks × 2 seats × ${games} games = ${MIRROR_DECKS.length * 2 * games}`);

MIRROR_DECKS.forEach((deckName, index) => {
  let wins = 0;
  let done = 0;
  for (const seat of [0, 1] as const) {
    const policies = seat === 0 ? ["is-mcts-k2", "is-mcts-h4"] as const : ["is-mcts-h4", "is-mcts-k2"] as const;
    const report = runBenchmarkBatch({
      db: benchmarkDb,
      decks: [deck(deckName), deck(deckName)],
      policies,
      seeds: mirroredSeeds(seedStart + index * 1000 + seat * 500, games),
      runContext,
      runContextByPolicy,
    });
    for (const match of report.matches) {
      allDiagnostics.push(...match.searchDiagnostics);
      const candidateSeat = seat === 0 ? 0 : 1;
      addQuality(candidateSeat === 0 ? candidateQuality : currentQuality, match, 0);
      addQuality(candidateSeat === 1 ? candidateQuality : currentQuality, match, 1);
      if (match.outcome !== "complete" || match.winner === null) continue;
      done++;
      if (match.winner === candidateSeat) wins++;
    }
  }
  candidateWins += wins;
  completed += done;
  const ci = wilson(wins, done);
  pairResults.push({ deck: deckName, wins, completed: done, ci });
  console.log(`${deckName}: candidate ${wins}/${done} = ${pct(ci.p)} [${((Date.now() - start) / 1000).toFixed(0)}s]`);
});

const ci = wilson(candidateWins, completed);
const candidateSummary = summarizeQuality(candidateQuality);
const currentSummary = summarizeQuality(currentQuality);
const candidateAttack = summarizeAttackSuccess(candidateQuality);
const currentAttack = summarizeAttackSuccess(currentQuality);
const diagnosticsByPolicy = {
  "is-mcts-k2": summarizeDiagnostics(allDiagnostics.filter((item) => item.policy === "is-mcts-k2")),
  "is-mcts-h4": summarizeDiagnostics(allDiagnostics.filter((item) => item.policy === "is-mcts-h4")),
};
const result = {
  kind: "phase-k-k2-selected-v1-ab",
  args: { modelPath, games, timeMs, leafHorizon, seedStart, rootTiebreakDelta, rootConservationThreshold, k2RootTiebreakDelta, k2RootConservationThreshold },
  structure: { decks: MIRROR_DECKS, totalGames: MIRROR_DECKS.length * 2 * games },
  combined: { candidateWins, completed, ci },
  playQuality: {
    candidate: candidateSummary,
    current: currentSummary,
    deltas: {
      lowPointDeployRate: candidateSummary.lowPointDeployRate - currentSummary.lowPointDeployRate,
      defenseSkillNonUseRate: candidateSummary.defenseSkillNonUseRate - currentSummary.defenseSkillNonUseRate,
      defenseSkillFreeNonUseRate: candidateSummary.defenseSkillFreeNonUseRate - currentSummary.defenseSkillFreeNonUseRate,
      defenseSkillCostlyNonUseRate: candidateSummary.defenseSkillCostlyNonUseRate - currentSummary.defenseSkillCostlyNonUseRate,
      averageOpPressure: candidateSummary.averageOpPressure - currentSummary.averageOpPressure,
    },
  },
  attackSuccess: {
    candidate: candidateAttack,
    current: currentAttack,
    deltas: {
      rate: candidateAttack.rate - currentAttack.rate,
      averageOp: candidateAttack.averageOp - currentAttack.averageOp,
    },
  },
  pairResults,
  searchDiagnostics: diagnosticsByPolicy,
  elapsedSeconds: (Date.now() - start) / 1000,
};

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), `${JSON.stringify(result, null, 2)}\n`);
console.log(`COMBINED: candidate ${candidateWins}/${completed} = ${pct(ci.p)}  95% CI ${pct(ci.low)}-${pct(ci.high)}`);
console.log(
  `M-Throw candidate: M1 ${pct(candidateSummary.lowPointDeployRate)} (${candidateSummary.lowPointDeploys}/${candidateSummary.lowPointDeployOpportunities}), ` +
    `M2 ${pct(candidateSummary.defenseSkillNonUseRate)} (${candidateSummary.defenseSkillNonUses}/${candidateSummary.defenseSkillOpportunities}), ` +
    `M2-free ${pct(candidateSummary.defenseSkillFreeNonUseRate)} (${candidateSummary.defenseSkillFreeNonUses}/${candidateSummary.defenseSkillFreeOpportunities}), ` +
    `M2-costly ${pct(candidateSummary.defenseSkillCostlyNonUseRate)} (${candidateSummary.defenseSkillCostlyNonUses}/${candidateSummary.defenseSkillCostlyOpportunities}), ` +
    `M3 OP ${candidateSummary.averageOpPressure.toFixed(2)} (${candidateSummary.opPressureSamples})`,
);
console.log(
  `M-Throw current:   M1 ${pct(currentSummary.lowPointDeployRate)} (${currentSummary.lowPointDeploys}/${currentSummary.lowPointDeployOpportunities}), ` +
    `M2 ${pct(currentSummary.defenseSkillNonUseRate)} (${currentSummary.defenseSkillNonUses}/${currentSummary.defenseSkillOpportunities}), ` +
    `M2-free ${pct(currentSummary.defenseSkillFreeNonUseRate)} (${currentSummary.defenseSkillFreeNonUses}/${currentSummary.defenseSkillFreeOpportunities}), ` +
    `M2-costly ${pct(currentSummary.defenseSkillCostlyNonUseRate)} (${currentSummary.defenseSkillCostlyNonUses}/${currentSummary.defenseSkillCostlyOpportunities}), ` +
    `M3 OP ${currentSummary.averageOpPressure.toFixed(2)} (${currentSummary.opPressureSamples})`,
);
console.log(`Attack success candidate: ${pct(candidateAttack.rate)} (${candidateAttack.successes}/${candidateAttack.attempts}), avg attack OP ${candidateAttack.averageOp.toFixed(2)}`);
console.log(`Attack success current:   ${pct(currentAttack.rate)} (${currentAttack.successes}/${currentAttack.attempts}), avg attack OP ${currentAttack.averageOp.toFixed(2)}`);
console.log(`Report written: ${resolve(outPath)}`);
