import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { applyDecision, createGame, freeOptions } from "../src/engine/engine";
import type { CardDb, Decision, GameState, LogEntry, PlayerId } from "../src/engine/types";
import { benchmarkDb, findBenchmarkDeck } from "../src/ai/benchmark-fixtures";
import { createIsmctsReport } from "../src/ai/ismcts";
import { decisionLabel, determinizeHiddenState, enumerateCandidates, inferKnownDecks } from "../src/ai/coach";
import { heuristicAiDecision } from "../src/ai/heuristic";
import { estimateThinkBudgetMs } from "../src/ai/think-budget";
import type { ReplaySession } from "../src/ui/replayHistory";

const CALIBRATED_TARGET_IPS = 2800;
const AI_PACE_MS = 900;
const AI_WORKER_DELAY_MS = 180;

interface ProfileArgs {
  timeMs: number;
  samples: number;
  microIters: number;
  leafHorizon: number;
  candidateLimit: number;
}

interface ScenarioConfig {
  label: string;
  deckA: string;
  deckB: string;
  seed: number;
  decisionsToApply: number;
  includeInMedian?: boolean;
}

interface ScenarioState extends ScenarioConfig {
  state: GameState;
  knownDecks: [string[], string[]];
  actualDecisionsApplied: number;
  note?: string;
}

interface TimedSample {
  elapsedMs: number;
  completedIterations: number;
  timedOut: boolean;
}

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseArgs(): ProfileArgs {
  return {
    timeMs: Number(argValue("time-ms", "250")),
    samples: Number(argValue("samples", "3")),
    microIters: Number(argValue("micro-iters", "200")),
    leafHorizon: Number(argValue("leaf-horizon", "40")),
    candidateLimit: Number(argValue("candidate-limit", "8")),
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "n/a";
  return `${fmt((part / whole) * 100, 1)}%`;
}

function profileLoop(iterations: number, fn: (index: number) => void): number {
  for (let i = 0; i < Math.min(10, iterations); i++) fn(i);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  return (performance.now() - start) / iterations;
}

function fallbackDecision(db: CardDb, state: GameState): Decision {
  return heuristicAiDecision(db, state, "heuristic-v2");
}

function buildScenario(config: ScenarioConfig): ScenarioState {
  const deckA = findBenchmarkDeck(config.deckA);
  const deckB = findBenchmarkDeck(config.deckB);
  let state = createGame(benchmarkDb, { seed: config.seed, decks: [deckA.ids, deckB.ids] });
  let lastDecisionState = state;
  let lastDecisionStep = 0;
  let actualDecisionsApplied = 0;
  for (; actualDecisionsApplied < config.decisionsToApply; actualDecisionsApplied++) {
    if (state.phase === "gameOver" || !state.pendingDecision) break;
    lastDecisionState = state;
    lastDecisionStep = actualDecisionsApplied;
    state = applyDecision(benchmarkDb, state, fallbackDecision(benchmarkDb, state));
  }
  if (!state.pendingDecision && lastDecisionState.pendingDecision) {
    state = lastDecisionState;
    actualDecisionsApplied = lastDecisionStep;
  }
  if (!state.pendingDecision) throw new Error(`Scenario ${config.label} did not stop on a decision point`);
  return {
    ...config,
    state,
    knownDecks: [deckA.ids, deckB.ids],
    actualDecisionsApplied,
  };
}

function buildTrivialFreeScenario(): ScenarioState {
  const config: ScenarioConfig = {
    label: "trivial/free-pass-only",
    deckA: "烏野-預組",
    deckB: "音駒-預組",
    seed: 740,
    decisionsToApply: 0,
    includeInMedian: false,
  };
  const deckA = findBenchmarkDeck(config.deckA);
  const deckB = findBenchmarkDeck(config.deckB);
  let state = createGame(benchmarkDb, { seed: config.seed, decks: [deckA.ids, deckB.ids] });
  let actualDecisionsApplied = 0;
  for (; actualDecisionsApplied < 160; actualDecisionsApplied++) {
    if (state.phase === "gameOver" || !state.pendingDecision) break;
    if (state.pendingDecision.type === "free") {
      const opts = freeOptions(benchmarkDb, state);
      if (opts.skills.length === 0 && opts.events.length === 0) break;
    }
    state = applyDecision(benchmarkDb, state, fallbackDecision(benchmarkDb, state));
  }
  if (state.pendingDecision?.type !== "free") throw new Error("trivial/free-pass-only did not find a free step");
  const opts = freeOptions(benchmarkDb, state);
  if (opts.skills.length > 0 || opts.events.length > 0) throw new Error("trivial/free-pass-only still has active free options");
  return {
    ...config,
    state,
    knownDecks: [deckA.ids, deckB.ids],
    actualDecisionsApplied,
  };
}

function loadDeepLateReplayScenario(): ScenarioState | null {
  const dir = join(process.cwd(), "data", "replays");
  if (!existsSync(dir)) return null;
  let best:
    | {
        file: string;
        entryIndex: number;
        state: GameState;
        knownDecks: [string[], string[]];
        seed: number;
        labels: [string, string];
      }
    | null = null;

  for (const file of readdirSync(dir).filter((item) => item.endsWith(".json"))) {
    try {
      const session = JSON.parse(readFileSync(join(dir, file), "utf8")) as ReplaySession;
      for (const entry of session.entries ?? []) {
        if (!entry.before?.pendingDecision) continue;
        if ((entry.before.log?.length ?? 0) <= (best?.state.log.length ?? -1)) continue;
        best = {
          file,
          entryIndex: entry.index,
          state: entry.before,
          knownDecks: [session.decks[0]?.cardIds ?? [], session.decks[1]?.cardIds ?? []],
          seed: session.seed,
          labels: [session.decks[0]?.label ?? "replay-p0", session.decks[1]?.label ?? "replay-p1"],
        };
      }
    } catch {
      // Ignore old or partial replay files; this profile only needs one high-log representative.
    }
  }

  if (!best) return null;
  return {
    label: "deep-late/replay-observer",
    deckA: best.labels[0],
    deckB: best.labels[1],
    seed: best.seed,
    decisionsToApply: best.entryIndex,
    includeInMedian: false,
    state: best.state,
    knownDecks: best.knownDecks,
    actualDecisionsApplied: best.entryIndex,
    note: `${best.file}#${best.entryIndex}`,
  };
}

function withLogLength(state: GameState, length: number): GameState {
  const copy = structuredClone(state) as GameState;
  const template: LogEntry = {
    setNo: state.setNo,
    turnNo: state.turnNo,
    player: 0,
    text: "profile synthetic log entry for clone/applyDecision timing",
  };
  copy.log = Array.from({ length }, () => ({ ...template }));
  return copy;
}

function timeSearch(scenario: ScenarioState, args: ProfileArgs): TimedSample[] {
  return Array.from({ length: args.samples }, (_, index) => {
    const start = performance.now();
    const report = createIsmctsReport(benchmarkDb, scenario.state, {
      perspectivePlayer: scenario.state.pendingDecision!.player as PlayerId,
      knownDecks: scenario.knownDecks,
      timeLimitMs: args.timeMs,
      leafRolloutHorizon: args.leafHorizon,
      candidateLimit: args.candidateLimit,
      seed: scenario.seed + index * 1009,
    });
    return {
      elapsedMs: performance.now() - start,
      completedIterations: report.completedSamples,
      timedOut: report.timedOut,
    };
  });
}

function timeScenarioMicro(scenario: ScenarioState, args: ProfileArgs) {
  const state = scenario.state;
  const noLogState = structuredClone(state) as GameState;
  noLogState.log = [];
  const knownDecks = inferKnownDecks(state);
  const perspective = state.pendingDecision!.player as PlayerId;
  const fallback = fallbackDecision(benchmarkDb, state);
  const candidates = enumerateCandidates(benchmarkDb, state, args.candidateLimit, fallback);

  const cloneAvgMs = profileLoop(args.microIters, () => {
    structuredClone(state);
  });
  const cloneNoLogAvgMs = profileLoop(args.microIters, () => {
    structuredClone(noLogState);
  });
  const applyAvgMs = profileLoop(args.microIters, () => {
    applyDecision(benchmarkDb, state, fallback);
  });
  const determinizeAvgMs = profileLoop(args.microIters, (index) => {
    determinizeHiddenState(state, perspective, knownDecks, scenario.seed + index);
  });
  const heuristicAvgMs = profileLoop(args.microIters, () => {
    fallbackDecision(benchmarkDb, state);
  });
  const enumerateAvgMs = profileLoop(Math.max(20, Math.floor(args.microIters / 4)), () => {
    enumerateCandidates(benchmarkDb, state, args.candidateLimit, fallback);
  });
  const stringifyAvgMs = profileLoop(args.microIters, () => {
    for (const candidate of candidates) JSON.stringify(candidate);
  });

  return {
    cloneAvgMs,
    cloneNoLogAvgMs,
    applyAvgMs,
    determinizeAvgMs,
    heuristicAvgMs,
    enumerateAvgMs,
    stringifyAvgMs,
    candidateCount: candidates.length,
    fallbackLabel: decisionLabel(benchmarkDb, state, fallback),
  };
}

function timeLogCurve(state: GameState, args: ProfileArgs) {
  const fallback = fallbackDecision(benchmarkDb, state);
  return [0, 100, 500, 1000, 2000, 5000].map((logLength) => {
    const sample = withLogLength(state, logLength);
    const cloneAvgMs = profileLoop(args.microIters, () => {
      structuredClone(sample);
    });
    const applyAvgMs = profileLoop(args.microIters, () => {
      applyDecision(benchmarkDb, sample, fallback);
    });
    return { logLength, cloneAvgMs, applyAvgMs };
  });
}

function timeTrivialLatency(scenario: ScenarioState, args: ProfileArgs) {
  const samples = Array.from({ length: args.samples }, (_, index) => {
    const start = performance.now();
    const report = createIsmctsReport(benchmarkDb, scenario.state, {
      perspectivePlayer: scenario.state.pendingDecision!.player as PlayerId,
      knownDecks: scenario.knownDecks,
      timeLimitMs: estimateThinkBudgetMs(scenario.state),
      leafRolloutHorizon: args.leafHorizon,
      candidateLimit: args.candidateLimit,
      seed: scenario.seed + index * 1009,
    });
    const elapsedMs = performance.now() - start;
    return {
      elapsedMs,
      liveWaitMs: Math.max(AI_PACE_MS, AI_WORKER_DELAY_MS + elapsedMs),
      completedIterations: report.completedSamples,
      recommendationCount: report.recommendations.length,
      bestLabel: report.bestAction.label,
    };
  });
  return {
    samples,
    budgetMs: estimateThinkBudgetMs(scenario.state),
    medianElapsedMs: median(samples.map((sample) => sample.elapsedMs)),
    p50LiveWaitMs: median(samples.map((sample) => sample.liveWaitMs)),
  };
}

const args = parseArgs();
const configs: ScenarioConfig[] = [
  { label: "early/serve", deckA: "烏野-預組", deckB: "音駒-預組", seed: 710, decisionsToApply: 3 },
  { label: "mid/rally", deckA: "烏野-預組", deckB: "音駒-預組", seed: 711, decisionsToApply: 24 },
  { label: "late/log-heavy", deckA: "烏野-預組", deckB: "音駒-預組", seed: 712, decisionsToApply: 64 },
  { label: "early/burst", deckA: "梟谷-高爆發軸", deckB: "白鳥沢-最強白鳥沢", seed: 720, decisionsToApply: 3 },
  { label: "mid/burst", deckA: "梟谷-高爆發軸", deckB: "白鳥沢-最強白鳥沢", seed: 721, decisionsToApply: 24 },
  { label: "late/burst", deckA: "梟谷-高爆發軸", deckB: "白鳥沢-最強白鳥沢", seed: 722, decisionsToApply: 64 },
  { label: "early/block", deckA: "伊達工業-攔網軸改", deckB: "青葉城西-二彈改", seed: 730, decisionsToApply: 3 },
  { label: "mid/block", deckA: "伊達工業-攔網軸改", deckB: "青葉城西-二彈改", seed: 731, decisionsToApply: 24 },
  { label: "late/block", deckA: "伊達工業-攔網軸改", deckB: "青葉城西-二彈改", seed: 732, decisionsToApply: 64 },
];

const replayScenario = loadDeepLateReplayScenario();
const scenarios = replayScenario ? [...configs.map(buildScenario), replayScenario] : configs.map(buildScenario);
const searchRows = scenarios.map((scenario) => {
  const samples = timeSearch(scenario, args);
  const iterations = samples.map((sample) => sample.completedIterations);
  const elapsed = samples.map((sample) => sample.elapsedMs);
  const ips = samples.map((sample) => sample.completedIterations / (sample.elapsedMs / 1000));
  return {
    scenario,
    samples,
    meanIterations: mean(iterations),
    medianIterations: median(iterations),
    meanElapsedMs: mean(elapsed),
    iterationsPerSec: mean(ips),
    timeoutRate: mean(samples.map((sample) => (sample.timedOut ? 1 : 0))),
  };
});

const microRows = scenarios.map((scenario) => ({ scenario, timings: timeScenarioMicro(scenario, args) }));
const representative = scenarios[Math.min(4, scenarios.length - 1)]!;
const logCurve = timeLogCurve(representative.state, args);
const trivialScenario = buildTrivialFreeScenario();
const trivialLatency = timeTrivialLatency(trivialScenario, args);

const medianRows = searchRows.filter((row) => row.scenario.includeInMedian !== false && row.meanIterations > 0);
const allIps = medianRows.map((row) => row.iterationsPerSec);
const baselineIps = median(allIps);

console.log("# M8 Phase J Search Profile");
console.log("");
console.log(
  `Args: timeMs=${args.timeMs}, samples=${args.samples}, microIters=${args.microIters}, leafHorizon=${args.leafHorizon}, candidateLimit=${args.candidateLimit}`,
);
console.log("");
console.log("## ISMCTS wall-clock baseline");
console.log("| scenario | phase | pending | log | decisions | median pool | mean iters | iters/sec | timeout |");
console.log("|---|---:|---|---:|---:|---|---:|---:|---:|");
for (const row of searchRows) {
  const s = row.scenario.state;
  const label = row.scenario.note ? `${row.scenario.label} (${row.scenario.note})` : row.scenario.label;
  console.log(
    `| ${label} | ${s.phase}/${s.sub} | ${s.pendingDecision?.type ?? "none"} | ${s.log.length} | ${row.scenario.actualDecisionsApplied} | ${row.scenario.includeInMedian === false ? "no" : "yes"} | ${fmt(row.meanIterations, 1)} | ${fmt(row.iterationsPerSec, 1)} | ${pct(row.timeoutRate, 1)} |`,
  );
}
console.log("");
console.log(`Median throughput (searched decisions only): ${fmt(baselineIps, 1)} iterations/sec`);
console.log(`Phase J calibrated target: >=${fmt(CALIBRATED_TARGET_IPS, 0)} iterations/sec`);
console.log("");
console.log("## J4 trivial hand latency");
console.log(
  `Scenario: ${trivialScenario.label}, budget=${trivialLatency.budgetMs}ms, best="${trivialLatency.samples[0]?.bestLabel ?? "n/a"}", completedIterations median=${fmt(median(trivialLatency.samples.map((sample) => sample.completedIterations)), 1)}`,
);
console.log(`Raw report p50: ${fmt(trivialLatency.medianElapsedMs, 2)}ms`);
console.log(`Estimated live p50 with ${AI_PACE_MS}ms AI pace: ${fmt(trivialLatency.p50LiveWaitMs, 2)}ms`);
console.log("");
console.log("## Micro timings");
console.log("| scenario | candidates | clone ms | clone no-log ms | applyDecision ms | determinize ms | heuristic ms | enumerate/isApplicable ms | JSON keys ms |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of microRows) {
  const t = row.timings;
  console.log(
    `| ${row.scenario.label} | ${t.candidateCount} | ${fmt(t.cloneAvgMs, 4)} | ${fmt(t.cloneNoLogAvgMs, 4)} | ${fmt(t.applyAvgMs, 4)} | ${fmt(t.determinizeAvgMs, 4)} | ${fmt(t.heuristicAvgMs, 4)} | ${fmt(t.enumerateAvgMs, 4)} | ${fmt(t.stringifyAvgMs, 4)} |`,
  );
}
console.log("");
console.log(`Representative log curve scenario: ${representative.label}`);
console.log("| log entries | clone ms | applyDecision ms |");
console.log("|---:|---:|---:|");
for (const row of logCurve) {
  console.log(`| ${row.logLength} | ${fmt(row.cloneAvgMs, 4)} | ${fmt(row.applyAvgMs, 4)} |`);
}
