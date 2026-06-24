import process from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { benchmarkDb, benchmarkDecks, findBenchmarkDeck } from "./benchmark-fixtures";
import type { BatchReport, BenchmarkPolicyId, MatrixMode, MatrixReport } from "./benchmark";
import { configureIsmctsBenchmark, configurePimcBenchmark, mirroredSeeds, runBenchmarkBatch, runBenchmarkMatrix } from "./benchmark";
import { createBenchmarkReportEnvelope } from "./benchmark-report";
import { isHeuristicV2ProfileId } from "./heuristic";

const DEFAULTS = {
  deckA: "烏野-預組",
  deckB: "音駒-預組",
  policyA: "heuristic-v2" as BenchmarkPolicyId,
  policyB: "random" as BenchmarkPolicyId,
  seedStart: 100,
  games: 10,
  maxSteps: 5000,
};

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} 必須是數字`);
  return value;
}

function policyArg(name: string, fallback: BenchmarkPolicyId): BenchmarkPolicyId {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  if (raw === "random" || raw === "heuristic-v1" || raw === "pimc" || raw === "pimc-v2" || raw === "is-mcts" || isHeuristicV2ProfileId(raw)) return raw;
  throw new Error(`--${name} 只支援 random、heuristic-v1、pimc、pimc-v2、is-mcts、heuristic-v2、heuristic-v2-safe、heuristic-v2-aggressive、heuristic-v2-personality 或 heuristic-v2-<axis>`);
}

function matrixModeArg(): MatrixMode | null {
  const raw = argValue("matrix");
  if (raw === undefined) return null;
  if (raw === "ring" || raw === "all-vs-all") return raw;
  throw new Error("--matrix 只支援 ring 或 all-vs-all");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printDecks(): void {
  for (const deck of benchmarkDecks) {
    console.log(`${deck.name} (${deck.ids.length} 張, axes=${deck.axes.join("/")})`);
  }
}

function writeReport(path: string | undefined, kind: "batch" | "matrix", report: BatchReport | MatrixReport, quiet = false): void {
  if (!path) return;
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const payload = createBenchmarkReportEnvelope(kind, report, process.argv.slice(2));
  writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (!quiet) console.log(`Report written: ${abs}`);
}

function run(): void {
  if (hasFlag("list-decks")) {
    printDecks();
    return;
  }

  const deckA = findBenchmarkDeck(argValue("deck-a") ?? DEFAULTS.deckA);
  const deckB = findBenchmarkDeck(argValue("deck-b") ?? DEFAULTS.deckB);
  const policyA = policyArg("policy-a", DEFAULTS.policyA);
  const policyB = policyArg("policy-b", DEFAULTS.policyB);
  // [Claude 2026-06-22] Phase F：PIMC policy 的 sample budget 旋鈕（強度↔速度）。預設保守，可覆寫。
  // [Claude 2026-06-23] Phase G：--time-ms 同時套用到 pimc 與 ismcts（同 wall-clock A/B 的便捷旋鈕）。
  const sharedTimeMs = argValue("time-ms") !== undefined ? numberArg("time-ms", 0) : undefined;
  if ([policyA, policyB].some((p) => p === "pimc" || p === "pimc-v2")) {
    configurePimcBenchmark({
      ...(argValue("pimc-samples") !== undefined ? { sampleCount: numberArg("pimc-samples", 8) } : {}),
      ...(argValue("pimc-rollout-steps") !== undefined ? { rolloutMaxSteps: numberArg("pimc-rollout-steps", 600) } : {}),
      ...(argValue("pimc-candidates") !== undefined ? { candidateLimit: numberArg("pimc-candidates", 8) } : {}),
      ...(sharedTimeMs !== undefined ? { timeLimitMs: sharedTimeMs } : {}),
      ...(argValue("pimc-time-ms") !== undefined ? { timeLimitMs: numberArg("pimc-time-ms", 0) } : {}),
      ...(argValue("pimc-value-cut") !== undefined ? { valueCutHorizon: numberArg("pimc-value-cut", 30) } : {}),
    });
  }
  // [Claude 2026-06-23] Phase G：IS-MCTS 旋鈕（iterations／同 wall-clock 的 time-ms／UCB c／候選寬度）。
  if ([policyA, policyB].some((p) => p === "is-mcts")) {
    configureIsmctsBenchmark({
      ...(argValue("ismcts-iters") !== undefined ? { iterations: numberArg("ismcts-iters", 800) } : {}),
      ...(argValue("ismcts-candidates") !== undefined ? { candidateLimit: numberArg("ismcts-candidates", 8) } : {}),
      ...(argValue("ismcts-c") !== undefined ? { explorationC: numberArg("ismcts-c", Math.SQRT2) } : {}),
      ...(argValue("ismcts-leaf-horizon") !== undefined ? { leafRolloutHorizon: numberArg("ismcts-leaf-horizon", 0) } : {}),
      ...(sharedTimeMs !== undefined ? { timeLimitMs: sharedTimeMs } : {}),
      ...(argValue("ismcts-time-ms") !== undefined ? { timeLimitMs: numberArg("ismcts-time-ms", 0) } : {}),
    });
  }
  const seedStart = numberArg("seed-start", DEFAULTS.seedStart);
  const games = numberArg("games", DEFAULTS.games);
  const maxSteps = numberArg("max-steps", DEFAULTS.maxSteps);
  const matrixMode = matrixModeArg();
  const outPath = argValue("out");
  const seeds = mirroredSeeds(seedStart, games);

  if (matrixMode) {
    const report = runBenchmarkMatrix({
      db: benchmarkDb,
      decks: benchmarkDecks,
      policies: [policyA, policyB],
      seedStart,
      gamesPerPair: games,
      maxSteps,
      mode: matrixMode,
    });

    if (hasFlag("json")) {
      console.log(JSON.stringify(report, null, 2));
      writeReport(outPath, "matrix", report, true);
      return;
    }

    console.log("M8 Phase 0 Matrix Benchmark");
    console.log(`Mode: ${matrixMode}, pairs=${report.summary.pairs}, games/pair=${games}`);
    console.log(`Policies: P0 ${policyA} vs P1 ${policyB}`);
    console.log(`Completed: ${report.summary.completed}/${report.summary.totalGames}, errors=${report.summary.errored}, maxSteps=${report.summary.maxSteps}`);
    console.log(`Policy wins: ${Object.entries(report.summary.winsByPolicy).map(([policy, wins]) => `${policy}=${wins}`).join(", ") || "none"}`);
    console.log(`Axis wins: ${Object.entries(report.summary.winsByAxis).map(([axis, wins]) => `${axis}=${wins}`).join(", ") || "none"}`);
    console.log(`Average rallies/set: ${report.summary.averageRalliesPerSet.toFixed(2)}`);
    console.log(`Set win methods: ${Object.entries(report.summary.setWinsByReason).map(([reason, count]) => `${reason}=${count}`).join(", ") || "none"}`);
    console.log(`Lost reasons: ${Object.entries(report.summary.lostReasons).map(([reason, count]) => `${reason}=${count}`).join(", ") || "none"}`);
    const failedPairs = report.pairs.filter((pair) => pair.summary.errored > 0 || pair.summary.maxSteps > 0);
    if (failedPairs.length > 0) {
      console.log("Failed pairs:");
      for (const pair of failedPairs) {
        console.log(`- #${pair.pairIndex} ${pair.config.decks[0]} vs ${pair.config.decks[1]}: errors=${pair.summary.errored}, maxSteps=${pair.summary.maxSteps}`);
      }
    }
    writeReport(outPath, "matrix", report);
    return;
  }

  const report = runBenchmarkBatch({
    db: benchmarkDb,
    decks: [deckA, deckB],
    policies: [policyA, policyB],
    seeds,
    maxSteps,
  });

  if (hasFlag("json")) {
    console.log(JSON.stringify(report, null, 2));
    writeReport(outPath, "batch", report, true);
    return;
  }

  const { summary } = report;
  console.log("M8 Phase 0A Benchmark");
  console.log(`Decks: P0 ${deckA.name} vs P1 ${deckB.name}`);
  console.log(`Policies: P0 ${policyA} vs P1 ${policyB}`);
  console.log(`Seeds: ${seeds[0]}..${seeds[seeds.length - 1]} (${seeds.length} games)`);
  console.log(`Completed: ${summary.completed}/${summary.total}, errors=${summary.errored}, maxSteps=${summary.maxSteps}`);
  console.log(`Wins: P0 ${summary.winsByPlayer[0]} / P1 ${summary.winsByPlayer[1]}`);
  console.log(
    `P0 win rate: ${formatPercent(summary.player0WinRate)} ` +
      `(95% CI ${formatPercent(summary.player0WinRate95.low)}-${formatPercent(summary.player0WinRate95.high)})`,
  );
  console.log(`Average steps: ${summary.averageSteps.toFixed(1)}, average final set: ${summary.averageSetNo.toFixed(2)}`);
  console.log(`Average rallies/set: ${summary.averageRalliesPerSet.toFixed(2)}`);
  console.log(`Set win methods: ${Object.entries(summary.setWinsByReason).map(([reason, count]) => `${reason}=${count}`).join(", ") || "none"}`);

  const failed = report.matches.filter((match) => match.outcome !== "complete");
  if (failed.length > 0) {
    console.log("Failures:");
    for (const match of failed) console.log(`- seed ${match.seed}: ${match.outcome} ${match.error ?? ""}`);
  }
  writeReport(outPath, "batch", report);
}

run();
