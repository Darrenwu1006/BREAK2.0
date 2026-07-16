import process from "node:process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { benchmarkDb, benchmarkDecks, findBenchmarkDeck } from "./benchmark-fixtures";
import type { BatchReport, BenchmarkPolicyId, MatrixMode, MatrixReport } from "./benchmark";
import { configureIsmctsBenchmark, configurePimcBenchmark, mirroredSeeds, runBenchmarkBatch, runBenchmarkMatrix } from "./benchmark";
import { createBenchmarkReportEnvelope } from "./benchmark-report";
import { isHeuristicV2ProfileId } from "./heuristic";
import type { ValueModel } from "./rollout-value";

const DEFAULTS = {
  deckA: "烏野-預組",
  deckB: "音駒-音駒-三彈官方",
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
  if (raw === "random" || raw === "heuristic-v1" || raw === "pimc" || raw === "pimc-v2" || raw === "is-mcts" || raw === "is-mcts-h2" || raw === "is-mcts-h2b" || raw === "is-mcts-h2c" || raw === "is-mcts-h3" || raw === "is-mcts-h4" || raw === "is-mcts-k2" || raw === "mo-ismcts" || raw === "mo-ismcts-h3" || isHeuristicV2ProfileId(raw)) return raw;
  throw new Error(`--${name} 只支援 random、heuristic-v1、pimc、pimc-v2、is-mcts、is-mcts-h2、is-mcts-h2b、is-mcts-h2c、is-mcts-h3、is-mcts-h4、is-mcts-k2、mo-ismcts、mo-ismcts-h3、heuristic-v2、heuristic-v2-safe、heuristic-v2-aggressive、heuristic-v2-personality 或 heuristic-v2-<axis>`);
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

function readValueModel(path: string | undefined): ValueModel | undefined {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const model = isValueModel(parsed)
    ? parsed
    : isObject(parsed) && isValueModel(parsed.model)
      ? parsed.model
      : undefined;
  if (!model) throw new Error(`--value-model-file 不是可用的 ValueModel JSON: ${path}`);
  return model;
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

function formatPlayQuality(label: string, quality: BatchReport["summary"]["playQualityByPlayer"][number]): string {
  return `${label}: M-Throw1 ${formatPercent(quality.lowPointDeployRate)} (${quality.lowPointDeploys}/${quality.lowPointDeployOpportunities}, avg deficit ${quality.averageLowPointDeficit.toFixed(2)}), ` +
    `M-Throw2 ${formatPercent(quality.defenseSkillNonUseRate)} (${quality.defenseSkillNonUses}/${quality.defenseSkillOpportunities}), ` +
    `M2-free ${formatPercent(quality.defenseSkillFreeNonUseRate)} (${quality.defenseSkillFreeNonUses}/${quality.defenseSkillFreeOpportunities}), ` +
    `M2-costly ${formatPercent(quality.defenseSkillCostlyNonUseRate)} (${quality.defenseSkillCostlyNonUses}/${quality.defenseSkillCostlyOpportunities}), ` +
    `M-Throw3 OP ${quality.averageOpPressure.toFixed(2)} (${quality.opPressureSamples} samples)`;
}

function formatSearchDiagnostics(summary: BatchReport["summary"]["searchDiagnosticsByPolicy"]): string[] {
  return Object.entries(summary).map(([policy, item]) => {
    const path = item.averagePathLength === null ? "n/a" : item.averagePathLength.toFixed(2);
    const agreement =
      item.decisionAgreementRate === null
        ? "n/a"
        : `${formatPercent(item.decisionAgreementRate)} (${item.comparedDecisions} decisions vs ${item.agreementPolicy ?? "baseline"})`;
    const ambiguous =
      item.ambiguousProjectionRate === null
        ? "n/a"
        : `${formatPercent(item.ambiguousProjectionRate)} (avg bucket ${item.averageOpponentProjectionBucketSize?.toFixed(2) ?? "n/a"})`;
    return `${policy}: decisions=${item.decisions}, avg iterations=${item.averageCompletedIterations.toFixed(1)}, timeout=${formatPercent(item.timeoutRate)}, entropy=${item.averageRootVisitEntropy.toFixed(2)}, top2 gap=${item.averageTopTwoVisitGap.toFixed(2)}, avg path=${path}, ambiguous projection=${ambiguous}, SO agreement=${agreement}`;
  });
}

function formatCardFocus(summary: BatchReport["summary"]["cardFocus"]): string[] {
  if (!summary) return [];
  const p0 = summary.players[0];
  const nameChoices = Object.entries(p0.nameChoices)
    .map(([name, count]) => `${name}=${count}`)
    .join(", ") || "none";
  const byArea = Object.entries(p0.deployByArea)
    .filter(([, count]) => count > 0)
    .map(([area, count]) => `${area}=${count}`)
    .join(", ") || "none";
  const legal = Object.entries(p0.legalByArea)
    .filter(([, count]) => count > 0)
    .map(([area, count]) => `${area}=${count}`)
    .join(", ") || "none";
  const avgToss = p0.averageTossPoint === null ? "n/a" : p0.averageTossPoint.toFixed(2);
  const avgDeficit = p0.averageTossDeficit === null ? "n/a" : p0.averageTossDeficit.toFixed(2);
  return [
    `Focus ${summary.cardId} P0: deploys=${p0.deployCount}, byArea=${byArea}, nameChoices=${nameChoices}`,
    `Focus ${summary.cardId} P0: handDecisionCount=${p0.handDecisionCount}, legalByArea=${legal}, toss=${p0.tossDeployCount}, tossLowPoint=${p0.tossLowPointCount}, avgToss=${avgToss}, avgTossDeficit=${avgDeficit}`,
  ];
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
  if ([policyA, policyB].some((p) => p === "is-mcts" || p === "is-mcts-h2" || p === "is-mcts-h2b" || p === "is-mcts-h2c" || p === "is-mcts-h3" || p === "is-mcts-h4" || p === "is-mcts-k2" || p === "mo-ismcts" || p === "mo-ismcts-h3")) {
    configureIsmctsBenchmark({
      ...(argValue("ismcts-iters") !== undefined ? { iterations: numberArg("ismcts-iters", 800) } : {}),
      ...(argValue("ismcts-candidates") !== undefined ? { candidateLimit: numberArg("ismcts-candidates", 8) } : {}),
      ...(argValue("ismcts-c") !== undefined ? { explorationC: numberArg("ismcts-c", Math.SQRT2) } : {}),
      ...(argValue("ismcts-leaf-horizon") !== undefined ? { leafRolloutHorizon: numberArg("ismcts-leaf-horizon", 0) } : {}),
      ...(argValue("ismcts-pressure-epsilon") !== undefined ? { pressureShapingEpsilon: numberArg("ismcts-pressure-epsilon", 0) } : {}),
      ...(argValue("ismcts-root-tiebreak-delta") !== undefined ? { rootPressureTieBreakDelta: numberArg("ismcts-root-tiebreak-delta", 0) } : {}),
      ...(argValue("ismcts-root-conservation-threshold") !== undefined ? { rootConservationWinRateThreshold: numberArg("ismcts-root-conservation-threshold", 0) } : {}),
      ...(argValue("k2-root-tiebreak-delta") !== undefined ? { k2RootPressureTieBreakDelta: numberArg("k2-root-tiebreak-delta", 0) } : {}),
      ...(argValue("k2-root-conservation-threshold") !== undefined ? { k2RootConservationWinRateThreshold: numberArg("k2-root-conservation-threshold", 0) } : {}),
      ...(argValue("value-model-file") !== undefined
        ? [policyA, policyB].some((p) => p === "is-mcts-k2")
          ? { k2ValueModel: readValueModel(argValue("value-model-file")) }
          : { valueModel: readValueModel(argValue("value-model-file")) }
        : {}),
      ...(sharedTimeMs !== undefined ? { timeLimitMs: sharedTimeMs } : {}),
      ...(argValue("ismcts-time-ms") !== undefined ? { timeLimitMs: numberArg("ismcts-time-ms", 0) } : {}),
    });
  }
  const seedStart = numberArg("seed-start", DEFAULTS.seedStart);
  const games = numberArg("games", DEFAULTS.games);
  const maxSteps = numberArg("max-steps", DEFAULTS.maxSteps);
  const focusCardId = argValue("focus-card");
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
    console.log("Phase H play quality:");
    console.log(formatPlayQuality("P0", report.summary.playQualityByPlayer[0]));
    console.log(formatPlayQuality("P1", report.summary.playQualityByPlayer[1]));
    const searchDiagnostics = formatSearchDiagnostics(report.summary.searchDiagnosticsByPolicy);
    if (searchDiagnostics.length > 0) {
      console.log("Search diagnostics:");
      for (const line of searchDiagnostics) console.log(line);
    }
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
    focusCardId,
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
  console.log("Phase H play quality:");
  console.log(formatPlayQuality("P0", summary.playQualityByPlayer[0]));
  console.log(formatPlayQuality("P1", summary.playQualityByPlayer[1]));
  const cardFocus = formatCardFocus(summary.cardFocus);
  if (cardFocus.length > 0) {
    console.log("Card focus:");
    for (const line of cardFocus) console.log(line);
  }
  const searchDiagnostics = formatSearchDiagnostics(summary.searchDiagnosticsByPolicy);
  if (searchDiagnostics.length > 0) {
    console.log("Search diagnostics:");
    for (const line of searchDiagnostics) console.log(line);
  }

  const failed = report.matches.filter((match) => match.outcome !== "complete");
  if (failed.length > 0) {
    console.log("Failures:");
    for (const match of failed) console.log(`- seed ${match.seed}: ${match.outcome} ${match.error ?? ""}`);
  }
  writeReport(outPath, "batch", report);
}

run();
