/**
 * [Claude 2026-06-23] Phase G A/B 驅動器（單進程，聚合 Wilson CI）。
 *
 * 用法：
 *   npx vite-node tools/ab-ismcts.ts -- --games 20 --time-ms 3000 --leaf-horizon 40 [--policy is-mcts|mo-ismcts] [--opp pimc-v2|heuristic-v2] [--mirror]
 *
 * 兩種結構：
 * - 預設（cross-matchup）：4 對戰 deckA vs deckB × P0/P1 換座位 × games 局。座位互換已平衡牌組強度「偏差」，
 *   但**克制關係仍以變異形式稀釋模型訊號**（很多勝負由牌組克制決定，非 policy）。
 * - --mirror（[使用者 2026-06-23] 建議）：**同一套牌組兩邊互打** × P0/P1 換座位 × 跨多套牌組。
 *   消掉牌組強度差與克制（baseline 天生 50%）→ 偏離 50% 純粹是模型實力差，訊噪比更高。
 *   仍換座位（抵先手偏差）、跨多套牌組（原型覆蓋率）。
 */
import process from "node:process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { benchmarkDb, findBenchmarkDeck } from "../src/ai/benchmark-fixtures";
import {
  configureIsmctsBenchmark,
  configurePimcBenchmark,
  runBenchmarkBatch,
  mirroredSeeds,
  type BenchmarkDeckInput,
  type BenchmarkPolicyId,
  type MatchResult,
  type SearchDecisionDiagnostics,
} from "../src/ai/benchmark";
import type { ValueModel } from "../src/ai/rollout-value";

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  return fallback;
}

const games = Number(argValue("games", "20"));
const timeMs = Number(argValue("time-ms", "300"));
const policy = argValue("policy", "is-mcts") as BenchmarkPolicyId;
const opp = argValue("opp", "pimc-v2") as BenchmarkPolicyId;
const leafHorizon = Number(argValue("leaf-horizon", "40"));
const rootTiebreakDelta = Number(argValue("root-tiebreak-delta", argValue("ismcts-root-tiebreak-delta", "0.03")));
const valueModelPath = argValue("value-model-file", "");
const outPath = argValue("out", "");
const mirror = process.argv.includes("--mirror");

// cross-matchup：4 對戰，軸線多樣（hybrid/defense/serve/block/burst 都涵蓋）。
const MATCHUPS: [string, string][] = [
  ["烏野-預組", "音駒-預組"],
  ["白鳥沢-最強白鳥沢", "青葉城西-二彈改"],
  ["稲荷崎-稲荷崎_堆墓改角名", "梟谷-高爆發軸"],
  ["烏野-山月攔網軸", "白鳥沢-白板軸"],
];

// mirror：5 套不同原型的牌組，各自對自己互打（消牌組強度＋克制，純測 policy）。
const MIRROR_DECKS = [
  "烏野-預組", // hybrid
  "音駒-預組", // defense
  "梟谷-高爆發軸", // burst
  "白鳥沢-最強白鳥沢", // defense/hybrid
  "青葉城西-二彈改", // serve/hybrid
];

// units＝要跑的對戰單位（[deckP0source, deckP1source]）。mirror 模式下兩邊同牌組。
const units: [string, string][] = mirror ? MIRROR_DECKS.map((d) => [d, d] as [string, string]) : MATCHUPS;

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

function avg(items: readonly number[]): number {
  return items.length === 0 ? 0 : items.reduce((sum, item) => sum + item, 0) / items.length;
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
  if (!model) throw new Error(`--value-model-file 不是可用的 ValueModel JSON: ${path}`);
  return model;
}

function summarizeDiagnostics(items: readonly SearchDecisionDiagnostics[]) {
  const byPolicy = new Map<BenchmarkPolicyId, SearchDecisionDiagnostics[]>();
  for (const item of items) {
    const bucket = byPolicy.get(item.policy) ?? [];
    bucket.push(item);
    byPolicy.set(item.policy, bucket);
  }
  return [...byPolicy.entries()].map(([id, bucket]) => {
    const projection = bucket.filter((item) => item.opponentProjectionBucketSize !== null);
    return {
      policy: id,
      decisions: bucket.length,
      averageCompletedIterations: avg(bucket.map((item) => item.completedIterations)),
      timeoutRate: avg(bucket.map((item) => (item.timedOut ? 1 : 0))),
      averageRootVisitEntropy: avg(bucket.map((item) => item.rootVisitEntropy)),
      averageTopTwoVisitGap: avg(bucket.map((item) => item.topTwoVisitGap)),
      projectionComparedDecisions: projection.length,
      ambiguousProjectionRate: projection.length === 0 ? null : avg(projection.map((item) => (item.opponentProjectionCollapsed ? 1 : 0))),
      averageOpponentProjectionBucketSize:
        projection.length === 0 ? null : avg(projection.map((item) => item.opponentProjectionBucketSize ?? 0)),
    };
  });
}

const usesIsmctsFamily = (p: BenchmarkPolicyId) =>
  p === "is-mcts" || p === "is-mcts-h2" || p === "is-mcts-h2b" || p === "is-mcts-h2c" || p === "is-mcts-h3" || p === "is-mcts-h4" || p === "mo-ismcts" || p === "mo-ismcts-h3";
const usesPimcFamily = (p: BenchmarkPolicyId) => p === "pimc-v2" || p === "pimc";

interface QualityAcc {
  lowPointDeployOpportunities: number;
  lowPointDeploys: number;
  lowPointDeficit: number;
  defenseSkillOpportunities: number;
  defenseSkillNonUses: number;
  opCount: number;
  opTotal: number;
}

function blankQualityAcc(): QualityAcc {
  return {
    lowPointDeployOpportunities: 0,
    lowPointDeploys: 0,
    lowPointDeficit: 0,
    defenseSkillOpportunities: 0,
    defenseSkillNonUses: 0,
    opCount: 0,
    opTotal: 0,
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
  acc.opCount += stats.op.count;
  acc.opTotal += stats.op.total;
}

function summarizeQuality(acc: QualityAcc) {
  return {
    lowPointDeployOpportunities: acc.lowPointDeployOpportunities,
    lowPointDeploys: acc.lowPointDeploys,
    lowPointDeployRate: acc.lowPointDeployOpportunities === 0 ? 0 : acc.lowPointDeploys / acc.lowPointDeployOpportunities,
    averageLowPointDeficit: acc.lowPointDeploys === 0 ? 0 : acc.lowPointDeficit / acc.lowPointDeploys,
    defenseSkillOpportunities: acc.defenseSkillOpportunities,
    defenseSkillNonUses: acc.defenseSkillNonUses,
    defenseSkillNonUseRate: acc.defenseSkillOpportunities === 0 ? 0 : acc.defenseSkillNonUses / acc.defenseSkillOpportunities,
    averageOpPressure: acc.opCount === 0 ? 0 : acc.opTotal / acc.opCount,
    opPressureSamples: acc.opCount,
  };
}

function formatQuality(label: string, acc: QualityAcc): string {
  const summary = summarizeQuality(acc);
  return `${label}: M-Throw1 ${pct(summary.lowPointDeployRate)} (${summary.lowPointDeploys}/${summary.lowPointDeployOpportunities}, avg deficit ${summary.averageLowPointDeficit.toFixed(2)}), ` +
    `M-Throw2 ${pct(summary.defenseSkillNonUseRate)} (${summary.defenseSkillNonUses}/${summary.defenseSkillOpportunities}), ` +
    `M-Throw3 OP ${summary.averageOpPressure.toFixed(2)} (${summary.opPressureSamples} samples)`;
}

// 同 wall-clock：搜尋 policy 與對手都吃同一個 timeLimitMs。
if (usesIsmctsFamily(policy) || usesIsmctsFamily(opp)) {
  configureIsmctsBenchmark({
    timeLimitMs: timeMs,
    leafRolloutHorizon: leafHorizon,
    rootPressureTieBreakDelta: rootTiebreakDelta,
    ...(valueModelPath ? { valueModel: readValueModel(valueModelPath) } : {}),
  });
}
if (usesPimcFamily(policy) || usesPimcFamily(opp)) configurePimcBenchmark({ timeLimitMs: timeMs });

console.log(`Phase I A/B — ${policy}(leaf=${leafHorizon}) vs ${opp} @ same wall-clock ${timeMs}ms${mirror ? "  [MIRROR 同牌組]" : ""}`);
if (usesIsmctsFamily(policy) || usesIsmctsFamily(opp)) {
  console.log(`ISMCTS knobs: root-tiebreak-delta=${rootTiebreakDelta}${valueModelPath ? `, value-model=${valueModelPath}` : ""}`);
}
console.log(`Structure: ${units.length} ${mirror ? "decks(mirror)" : "matchups"} × 2 seatings × ${games} games = ${units.length * 2 * games} total`);
console.log("");

let policyWins = 0;
let completed = 0;
const startTime = Date.now();
const pairResults: Array<{ index: number; label: string; wins: number; completed: number; ci: { low: number; high: number; p: number } }> = [];
const allSearchDiagnostics: SearchDecisionDiagnostics[] = [];
const policyQuality = blankQualityAcc();
const oppQuality = blankQualityAcc();

units.forEach(([a, b], mi) => {
  let pairWins = 0;
  let pairDone = 0;
  // 兩個座位：target policy 先坐 P0，再坐 P1（policy 與 deck 同步交換）。mirror 下 a===b＝兩邊同牌組、僅換座位抵先手。
  for (const seat of [0, 1] as const) {
    const policies: [BenchmarkPolicyId, BenchmarkPolicyId] = seat === 0 ? [policy, opp] : [opp, policy];
    const decks: [BenchmarkDeckInput, BenchmarkDeckInput] = seat === 0 ? [deck(a), deck(b)] : [deck(b), deck(a)];
    const seedStart = 1000 + mi * 1000 + seat * 500;
    const report = runBenchmarkBatch({
      db: benchmarkDb,
      decks,
      policies,
      seeds: mirroredSeeds(seedStart, games),
    });
    for (const m of report.matches) allSearchDiagnostics.push(...m.searchDiagnostics);
    for (const m of report.matches) {
      const policySeat = seat === 0 ? 0 : 1;
      addQuality(policySeat === 0 ? policyQuality : oppQuality, m, 0);
      addQuality(policySeat === 1 ? policyQuality : oppQuality, m, 1);
      if (m.outcome !== "complete" || m.winner === null) continue;
      pairDone++;
      if (m.winner === policySeat) pairWins++;
    }
  }
  policyWins += pairWins;
  completed += pairDone;
  const ci = wilson(pairWins, pairDone);
  const label = mirror ? `${a} (mirror)` : `${a} vs ${b}`;
  pairResults.push({ index: mi, label, wins: pairWins, completed: pairDone, ci });
  console.log(`m${mi} ${label}: ${policy} ${pairWins}/${pairDone} (${pct(ci.p)})  [${((Date.now() - startTime) / 1000).toFixed(0)}s]`);
});

const ci = wilson(policyWins, completed);
const diagnostics = summarizeDiagnostics(allSearchDiagnostics);
console.log("");
console.log(`COMBINED: ${policy} ${policyWins}/${completed} = ${pct(ci.p)}  95% CI ${pct(ci.low)}-${pct(ci.high)}`);
console.log("Phase H play quality:");
console.log(formatQuality(policy, policyQuality));
console.log(formatQuality(opp, oppQuality));
console.log(
  opp === "pimc-v2" || opp === "is-mcts"
    ? `GO/NO-GO (CI low > 50%): ${ci.low > 0.5 ? "PASS ✅" : "FAIL ❌"}`
    : `non-regression vs ${opp}: ${pct(ci.p)} (現況 ~88% 區間)`,
);
if (diagnostics.length > 0) {
  console.log("Search diagnostics:");
  for (const item of diagnostics) {
    const ambiguous =
      item.ambiguousProjectionRate === null
        ? "n/a"
        : `${pct(item.ambiguousProjectionRate)} (avg bucket ${item.averageOpponentProjectionBucketSize?.toFixed(2) ?? "n/a"})`;
    console.log(
      `${item.policy}: decisions=${item.decisions}, avg iterations=${item.averageCompletedIterations.toFixed(1)}, timeout=${pct(item.timeoutRate)}, entropy=${item.averageRootVisitEntropy.toFixed(2)}, top2 gap=${item.averageTopTwoVisitGap.toFixed(2)}, ambiguous projection=${ambiguous}`,
    );
  }
}
console.log(`Total wall-clock: ${((Date.now() - startTime) / 1000).toFixed(0)}s`);

if (outPath) {
  const abs = resolve(outPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    `${JSON.stringify(
      {
        kind: "phase-i-ab-ismcts",
        args: { policy, opp, games, timeMs, leafHorizon, mirror, rootTiebreakDelta, valueModelPath: valueModelPath || null },
        structure: { units: units.length, totalGames: units.length * 2 * games },
        combined: { wins: policyWins, completed, ci },
        playQuality: {
          [policy]: summarizeQuality(policyQuality),
          [opp]: summarizeQuality(oppQuality),
        },
        pairResults,
        searchDiagnostics: diagnostics,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Report written: ${abs}`);
}
