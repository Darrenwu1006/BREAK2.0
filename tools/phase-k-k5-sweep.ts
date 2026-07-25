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

const CURRENT_ROOT_DELTA = 0.04;
const CURRENT_CONSERVATION_THRESHOLD = 0.85;

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

function argList(name: string, fallback: string): number[] {
  return stringArg(name, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item === "off" || item === "inf" || item === "Infinity" ? Number.POSITIVE_INFINITY : Number(item)))
    .filter((item) => Number.isFinite(item) || item === Number.POSITIVE_INFINITY);
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

function summarizeAttack(acc: QualityAcc) {
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
const outPath = stringArg("out", "data/ab/phase-k-k5-sweep-selected-v1.json");
const games = Math.max(1, Math.floor(numberArg("games", 1)));
const timeMs = Math.max(1, Math.floor(numberArg("time-ms", 500)));
const leafHorizon = Math.max(0, Math.floor(numberArg("leaf-horizon", 40)));
const seedStart = Math.floor(numberArg("seed-start", 14000));
const deltas = argList("deltas", "0.02,0.04,0.06");
const thresholds = argList("thresholds", "0.75,0.85,0.95");
const candidateModel = readValueModel(modelPath);
const start = Date.now();

const comboResults = [];

console.log(`Phase K K5 sweep — selected v1 candidate vs current H4/H5 @ ${timeMs}ms, leaf=${leafHorizon}`);
console.log(`Current fixed knobs: delta=${CURRENT_ROOT_DELTA}, conservation=${CURRENT_CONSERVATION_THRESHOLD}`);
console.log(`Grid: deltas=${deltas.join(",")} thresholds=${thresholds.map(String).join(",")} total=${deltas.length * thresholds.length}`);
console.log(`Structure per combo: ${MIRROR_DECKS.length} mirror decks x 2 seats x ${games} games = ${MIRROR_DECKS.length * 2 * games}`);

for (const delta of deltas) {
  for (const threshold of thresholds) {
    // [Claude 2026-07-24] 候選 B 塊 2：h4 用 live knobs（base）；被 sweep 的 delta／threshold 與候選 model 走 k2 per-policy override。
    const runContext: BenchmarkRunContext = {
      iterations: 1_000_000,
      timeLimitMs: timeMs,
      leafRolloutHorizon: leafHorizon,
      rootPressureTieBreakDelta: CURRENT_ROOT_DELTA,
      rootConservationWinRateThreshold: CURRENT_CONSERVATION_THRESHOLD,
    };
    const runContextByPolicy: Partial<Record<BenchmarkPolicyId, BenchmarkRunContext>> = {
      "is-mcts-k2": {
        valueModel: candidateModel,
        rootPressureTieBreakDelta: delta,
        rootConservationWinRateThreshold: threshold,
      },
    };

    let candidateWins = 0;
    let completed = 0;
    const candidateQuality = blankQualityAcc();
    const currentQuality = blankQualityAcc();
    const pairResults: Array<{ deck: string; wins: number; completed: number; ci: { low: number; high: number; p: number } }> = [];
    const diagnostics: SearchDecisionDiagnostics[] = [];
    const comboSeedStart = seedStart + comboResults.length * 10000;

    MIRROR_DECKS.forEach((deckName, deckIndex) => {
      let wins = 0;
      let done = 0;
      for (const seat of [0, 1] as const) {
        const policies = seat === 0 ? ["is-mcts-k2", "is-mcts-h4"] as const : ["is-mcts-h4", "is-mcts-k2"] as const;
        const report = runBenchmarkBatch({
          db: benchmarkDb,
          decks: [deck(deckName), deck(deckName)],
          policies,
          seeds: mirroredSeeds(comboSeedStart + deckIndex * 1000 + seat * 500, games),
          runContext,
          runContextByPolicy,
        });
        for (const match of report.matches) {
          diagnostics.push(...match.searchDiagnostics);
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
      pairResults.push({ deck: deckName, wins, completed: done, ci: wilson(wins, done) });
    });

    const candidatePlay = summarizeQuality(candidateQuality);
    const currentPlay = summarizeQuality(currentQuality);
    const candidateAttack = summarizeAttack(candidateQuality);
    const currentAttack = summarizeAttack(currentQuality);
    const ci = wilson(candidateWins, completed);
    const result = {
      delta,
      threshold,
      candidateWins,
      completed,
      ci,
      playQuality: {
        candidate: candidatePlay,
        current: currentPlay,
        deltas: {
          lowPointDeployRate: candidatePlay.lowPointDeployRate - currentPlay.lowPointDeployRate,
          defenseSkillNonUseRate: candidatePlay.defenseSkillNonUseRate - currentPlay.defenseSkillNonUseRate,
          defenseSkillFreeNonUseRate: candidatePlay.defenseSkillFreeNonUseRate - currentPlay.defenseSkillFreeNonUseRate,
          defenseSkillCostlyNonUseRate: candidatePlay.defenseSkillCostlyNonUseRate - currentPlay.defenseSkillCostlyNonUseRate,
          averageOpPressure: candidatePlay.averageOpPressure - currentPlay.averageOpPressure,
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
      gates: {
        strengthNoDegrade: ci.p >= 0.5,
        attackSuccessNoDegrade: candidateAttack.rate >= currentAttack.rate,
        m1Maintained: candidatePlay.lowPointDeployRate <= currentPlay.lowPointDeployRate,
        m2Maintained: candidatePlay.defenseSkillNonUseRate <= currentPlay.defenseSkillNonUseRate,
      },
      pairResults,
      searchDiagnostics: {
        "is-mcts-k2": summarizeDiagnostics(diagnostics.filter((item) => item.policy === "is-mcts-k2")),
        "is-mcts-h4": summarizeDiagnostics(diagnostics.filter((item) => item.policy === "is-mcts-h4")),
      },
    };
    comboResults.push(result);
    console.log(
      `delta=${delta} threshold=${threshold}: wins ${candidateWins}/${completed} ${pct(ci.p)}, attack ${pct(candidateAttack.rate)} vs ${pct(currentAttack.rate)}, ` +
        `M1 ${pct(candidatePlay.lowPointDeployRate)} vs ${pct(currentPlay.lowPointDeployRate)}, M2 ${pct(candidatePlay.defenseSkillNonUseRate)} vs ${pct(currentPlay.defenseSkillNonUseRate)} [${((Date.now() - start) / 1000).toFixed(0)}s]`,
    );
  }
}

const ranked = [...comboResults].sort((a, b) => {
  const aPass = Number(a.gates.strengthNoDegrade) + Number(a.gates.attackSuccessNoDegrade) + Number(a.gates.m1Maintained) + Number(a.gates.m2Maintained);
  const bPass = Number(b.gates.strengthNoDegrade) + Number(b.gates.attackSuccessNoDegrade) + Number(b.gates.m1Maintained) + Number(b.gates.m2Maintained);
  if (bPass !== aPass) return bPass - aPass;
  if (b.ci.p !== a.ci.p) return b.ci.p - a.ci.p;
  return b.attackSuccess.candidate.rate - a.attackSuccess.candidate.rate;
});

const output = {
  kind: "phase-k-k5-sweep",
  args: { modelPath, games, timeMs, leafHorizon, seedStart, deltas, thresholds, currentRootDelta: CURRENT_ROOT_DELTA, currentConservationThreshold: CURRENT_CONSERVATION_THRESHOLD },
  structure: { decks: MIRROR_DECKS, gamesPerCombo: MIRROR_DECKS.length * 2 * games },
  ranked: ranked.map((item) => ({
    delta: item.delta,
    threshold: item.threshold,
    candidateWinRate: item.ci.p,
    attackSuccessDelta: item.attackSuccess.deltas.rate,
    m1Delta: item.playQuality.deltas.lowPointDeployRate,
    m2Delta: item.playQuality.deltas.defenseSkillNonUseRate,
    gates: item.gates,
  })),
  results: comboResults,
  elapsedSeconds: (Date.now() - start) / 1000,
};

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), `${JSON.stringify(output, null, 2)}\n`);

console.log("Top combos:");
for (const item of ranked.slice(0, 5)) {
  console.log(
    `delta=${item.delta} threshold=${item.threshold}: wins ${pct(item.ci.p)}, attack delta ${pct(item.attackSuccess.deltas.rate)}, ` +
      `M1 delta ${pct(item.playQuality.deltas.lowPointDeployRate)}, M2 delta ${pct(item.playQuality.deltas.defenseSkillNonUseRate)}, gates=${JSON.stringify(item.gates)}`,
  );
}
console.log(`Report written: ${resolve(outPath)}`);
