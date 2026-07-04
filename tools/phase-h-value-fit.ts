import { applyDecision, createGame } from "../src/engine/engine";
import type { Decision, GameState, PlayerId } from "../src/engine/types";
import { heuristicAiDecision, heuristicProfileForDeckAxes } from "../src/ai/heuristic";
import { benchmarkDb, findBenchmarkDeck } from "../src/ai/benchmark-fixtures";
import {
  benchmarkPolicyDecision,
  configureIsmctsBenchmark,
  type BenchmarkPolicyId,
} from "../src/ai/benchmark";
import { evaluatePressureScore, extractValueFeatures, VALUE_FEATURE_NAMES } from "../src/ai/rollout-value";
import { fitPhaseHValueModel, scorePhaseHValueModel, type PhaseHGatePairRow, type PhaseHOutcomeRow } from "../src/ai/phase-h-value-fit";
import { createFreeAttackGateState } from "../src/ai/phase-h-gate-control";
import { auditReplaySession, summarizeGateValuePairs } from "../src/ai/phase-h-value-audit";
import type { ReplaySession } from "../src/ui/replayHistory";
import type { KnownDecks } from "../src/ai/remaining-pool";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import type { ValueFeatureName } from "../src/ai/rollout-value";

const DECKS = [
  "烏野-預組",
  "音駒-預組",
  "青葉城西-二彈改",
  "白鳥沢-白鳥沢_20260604_優勝",
  "稲荷崎-稲荷崎_堆墓改角名",
  "梟谷-梟谷_20260507_優勝",
  "伊達工業-攔網軸改",
  "烏野-日影攻擊軸",
];

type BenchmarkDeck = ReturnType<typeof findBenchmarkDeck>;
type HeuristicProfile = ReturnType<typeof heuristicProfileForDeckAxes>;
type DeckPairMode = "cross-archetype" | "same-deck";
type OutcomePolicyId = BenchmarkPolicyId | "mixed-k0";

interface OutcomeSourceConfig {
  outcomePolicy: OutcomePolicyId;
  deckPairMode?: DeckPairMode;
  seedStart: number;
  sampleEvery: number;
  maxSteps: number;
  mirror: boolean;
  iterations: number;
  timeMs: number;
  leafHorizon: number;
  candidateLimit: number;
  decks: string[];
  engine: string;
  valueFeatureNames: string[];
}

interface CachedOutcomeRow extends PhaseHOutcomeRow {
  gameIndex: number;
}

interface OutcomeCacheGame {
  gameIndex: number;
  seed: number;
  decks: [string, string];
  outcomePolicy?: BenchmarkPolicyId;
  status: "complete" | "skipped";
  winner: PlayerId | null;
  rowCount: number;
  reason?: string;
}

interface OutcomeRowCache {
  schemaVersion: 1;
  kind: "phase-h-outcome-rows";
  config: OutcomeSourceConfig;
  rows: CachedOutcomeRow[];
  games: OutcomeCacheGame[];
  updatedAt: string;
}

interface OutcomeRowSplit {
  trainRows: CachedOutcomeRow[];
  holdoutRows: CachedOutcomeRow[];
  trainGames: number[];
  holdoutGames: number[];
}

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

function argNum(name: string, fallback: number): number {
  const value = Number(argValue(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function seededRnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function parsePolicy(value: string): OutcomePolicyId {
  if (value === "mixed-k0") return value;
  const allowed = new Set<BenchmarkPolicyId>([
    "heuristic-v2-personality",
    "is-mcts",
    "is-mcts-h4",
    "mo-ismcts",
  ]);
  if (!allowed.has(value as BenchmarkPolicyId)) {
    throw new Error(`unsupported --outcome-policy ${value}; use heuristic-v2-personality, is-mcts, is-mcts-h4, mo-ismcts, or mixed-k0`);
  }
  return value as BenchmarkPolicyId;
}

function parseDeckPairMode(value: string): DeckPairMode {
  if (value === "cross-archetype" || value === "same-deck") return value;
  throw new Error(`unsupported --deck-pair-mode ${value}; use cross-archetype or same-deck`);
}

function deckPairFor(game: number, mirror: boolean, mode: DeckPairMode) {
  const pairIndex = mirror ? Math.floor(game / 2) : game;
  const deckA = findBenchmarkDeck(DECKS[pairIndex % DECKS.length]!);
  if (mode === "same-deck") return [deckA, deckA] as const;
  const deckB = findBenchmarkDeck(DECKS[(pairIndex * 3 + 1) % DECKS.length]!);
  if (!mirror || game % 2 === 0) return [deckA, deckB] as const;
  return [deckB, deckA] as const;
}

function selfPlayDecision(policy: BenchmarkPolicyId, state: GameState, profiles: readonly [HeuristicProfile, HeuristicProfile], decks: readonly [BenchmarkDeck, BenchmarkDeck], seed: number): Decision {
  const player = state.pendingDecision!.player as PlayerId;
  if (policy === "heuristic-v2-personality") return heuristicAiDecision(benchmarkDb, state, profiles[player]);
  return benchmarkPolicyDecision(
    policy,
    benchmarkDb,
    state,
    [seededRnd(seed * 3 + 11), seededRnd(seed * 5 + 17)],
    [decks[0].axes, decks[1].axes],
    [decks[0].ids, decks[1].ids],
  );
}

function outcomePolicyForGame(config: OutcomeSourceConfig, gameIndex: number): BenchmarkPolicyId {
  if (config.outcomePolicy !== "mixed-k0") return config.outcomePolicy;
  return gameIndex % 2 === 0 ? "heuristic-v2-personality" : "is-mcts-h4";
}

function collectOutcomeRowsForGame(gameIndex: number, config: OutcomeSourceConfig): { rows: CachedOutcomeRow[]; meta: OutcomeCacheGame } {
  const deckPairMode = config.deckPairMode ?? "cross-archetype";
  const [deckA, deckB] = deckPairFor(gameIndex, config.mirror, deckPairMode);
  const seed = config.seedStart + gameIndex;
  const deckNames: [string, string] = [deckA.name, deckB.name];
  const policy = outcomePolicyForGame(config, gameIndex);
  if (deckA.name === deckB.name && deckPairMode !== "same-deck") {
    return {
      rows: [],
      meta: { gameIndex, seed, decks: deckNames, outcomePolicy: policy, status: "skipped", winner: null, rowCount: 0, reason: "same-deck" },
    };
  }
  const profiles: [HeuristicProfile, HeuristicProfile] = [
    heuristicProfileForDeckAxes(deckA.axes),
    heuristicProfileForDeckAxes(deckB.axes),
  ];
  const knownDecks: KnownDecks = [deckA.ids, deckB.ids];
  let state = createGame(benchmarkDb, { seed, decks: [deckA.ids, deckB.ids] });
  const snapshots: { x0: number[]; x1: number[] }[] = [];
  let ok = true;
  let reason = "";
  for (let step = 0; state.phase !== "gameOver" && state.pendingDecision; step++) {
    if (step >= config.maxSteps) {
      ok = false;
      reason = "max-steps";
      break;
    }
    if (step % config.sampleEvery === 0) {
      snapshots.push({
        x0: extractValueFeatures(state, 0 as PlayerId, benchmarkDb, { knownDecks }),
        x1: extractValueFeatures(state, 1 as PlayerId, benchmarkDb, { knownDecks }),
      });
    }
    try {
      state = applyDecision(benchmarkDb, state, selfPlayDecision(policy, state, profiles, [deckA, deckB], seed));
    } catch (error) {
      ok = false;
      reason = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  if (!ok || state.winner === null) {
    return {
      rows: [],
      meta: { gameIndex, seed, decks: deckNames, outcomePolicy: policy, status: "skipped", winner: null, rowCount: 0, reason: reason || "incomplete" },
    };
  }
  const rows: CachedOutcomeRow[] = [];
  for (const snap of snapshots) {
    rows.push({ gameIndex, x: snap.x0, y: state.winner === 0 ? 1 : 0 });
    rows.push({ gameIndex, x: snap.x1, y: state.winner === 1 ? 1 : 0 });
  }
  return {
    rows,
    meta: { gameIndex, seed, decks: deckNames, outcomePolicy: policy, status: "complete", winner: state.winner, rowCount: rows.length },
  };
}

function collectOutcomeRows(games: number, config: OutcomeSourceConfig): CachedOutcomeRow[] {
  const rows: CachedOutcomeRow[] = [];
  for (let g = 0; g < games; g++) {
    rows.push(...collectOutcomeRowsForGame(g, config).rows);
  }
  return rows;
}

function stripCachedRow(row: CachedOutcomeRow): PhaseHOutcomeRow {
  return { x: row.x, y: row.y };
}

function normalizedCacheConfig(config: OutcomeSourceConfig): OutcomeSourceConfig {
  return {
    outcomePolicy: config.outcomePolicy,
    deckPairMode: config.deckPairMode ?? "cross-archetype",
    seedStart: config.seedStart,
    sampleEvery: config.sampleEvery,
    maxSteps: config.maxSteps,
    mirror: config.mirror,
    iterations: config.iterations,
    timeMs: config.timeMs,
    leafHorizon: config.leafHorizon,
    candidateLimit: config.candidateLimit,
    decks: config.decks,
    engine: config.engine,
    valueFeatureNames: config.valueFeatureNames,
  };
}

function configWithoutFeatureNames(config: OutcomeSourceConfig): Omit<OutcomeSourceConfig, "valueFeatureNames"> {
  const { valueFeatureNames: _valueFeatureNames, ...rest } = normalizedCacheConfig(config);
  return rest;
}

function featureNamesArePrefix(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length <= expected.length && actual.every((name, index) => name === expected[index]);
}

function cacheConfigMatches(actual: OutcomeSourceConfig, expected: OutcomeSourceConfig): boolean {
  return (
    JSON.stringify(configWithoutFeatureNames(actual)) === JSON.stringify(configWithoutFeatureNames(expected)) &&
    featureNamesArePrefix(actual.valueFeatureNames, expected.valueFeatureNames)
  );
}

function normalizeCachedFeatureDim(cache: OutcomeRowCache, config: OutcomeSourceConfig, path: string): OutcomeRowCache {
  const actualNames = cache.config.valueFeatureNames;
  const expectedNames = config.valueFeatureNames;
  if (actualNames.length === expectedNames.length) return cache;
  if (!featureNamesArePrefix(actualNames, expectedNames)) {
    throw new Error(`row cache ${path} has incompatible feature names`);
  }
  console.log(
    `row cache ${path} uses legacy feature dim ${actualNames.length}; padding cached rows to ${expectedNames.length}`,
  );
  const paddedRows = cache.rows.map((row) => {
    if (row.x.length === expectedNames.length) return row;
    if (row.x.length !== actualNames.length) {
      throw new Error(`row cache ${path} row feature dim ${row.x.length} does not match cache feature dim ${actualNames.length}`);
    }
    return { ...row, x: [...row.x, ...new Array(expectedNames.length - actualNames.length).fill(0)] };
  });
  return {
    ...cache,
    config,
    rows: paddedRows,
  };
}

function readOutcomeCache(path: string, config: OutcomeSourceConfig): OutcomeRowCache {
  if (!existsSync(path)) {
    return {
      schemaVersion: 1,
      kind: "phase-h-outcome-rows",
      config,
      rows: [],
      games: [],
      updatedAt: new Date().toISOString(),
    };
  }
  const cache = JSON.parse(readFileSync(path, "utf8")) as OutcomeRowCache;
  if (cache.schemaVersion !== 1 || cache.kind !== "phase-h-outcome-rows") {
    throw new Error(`row cache ${path} has unsupported schema`);
  }
  if (!cacheConfigMatches(cache.config, config)) {
    throw new Error(
      `row cache ${path} was produced with different outcome-source config; use a new --row-cache path for this run`,
    );
  }
  return normalizeCachedFeatureDim(cache, config, path);
}

function writeOutcomeCache(path: string, cache: OutcomeRowCache): void {
  mkdirSync(dirname(path), { recursive: true });
  cache.updatedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
}

function collectOutcomeRowsWithCache(games: number, config: OutcomeSourceConfig, path: string): CachedOutcomeRow[] {
  const cache = readOutcomeCache(path, config);
  const completed = new Set(cache.games.map((game) => game.gameIndex));
  const cachedGamesInScope = cache.games.filter((game) => game.gameIndex < games).length;
  console.log(`rowCache=${path} cachedGames=${cachedGamesInScope}/${games} cachedRows=${cache.rows.filter((row) => row.gameIndex < games).length}`);
  for (let g = 0; g < games; g++) {
    if (completed.has(g)) continue;
    const { rows, meta } = collectOutcomeRowsForGame(g, config);
    cache.games.push(meta);
    cache.rows.push(...rows);
    writeOutcomeCache(path, cache);
    console.log(`cached game ${g + 1}/${games}: ${meta.status}, rows=${meta.rowCount}${meta.reason ? `, reason=${meta.reason}` : ""}`);
  }
  return cache.rows
    .filter((row) => row.gameIndex < games)
    .sort((a, b) => a.gameIndex - b.gameIndex);
}

function splitOutcomeRowsByGame(rows: readonly CachedOutcomeRow[], holdoutEvery: number, holdoutOffset: number): OutcomeRowSplit {
  const normalizedOffset = holdoutEvery > 0 ? ((holdoutOffset % holdoutEvery) + holdoutEvery) % holdoutEvery : 0;
  const trainRows: CachedOutcomeRow[] = [];
  const holdoutRows: CachedOutcomeRow[] = [];
  const trainGames = new Set<number>();
  const holdoutGames = new Set<number>();
  for (const row of rows) {
    const isHoldout = holdoutEvery > 1 && row.gameIndex % holdoutEvery === normalizedOffset;
    if (isHoldout) {
      holdoutRows.push(row);
      holdoutGames.add(row.gameIndex);
    } else {
      trainRows.push(row);
      trainGames.add(row.gameIndex);
    }
  }
  return {
    trainRows,
    holdoutRows,
    trainGames: [...trainGames].sort((a, b) => a - b),
    holdoutGames: [...holdoutGames].sort((a, b) => a - b),
  };
}

function omittedFeatures(): ValueFeatureName[] {
  return featureListArg("omit-feature");
}

function nonNegativeFeatures(): ValueFeatureName[] {
  return featureListArg("nonnegative-feature");
}

function featureListArg(name: string): ValueFeatureName[] {
  const values = argValue(name, "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of values) {
    if (!(VALUE_FEATURE_NAMES as readonly string[]).includes(value)) throw new Error(`unknown feature for --${name}: ${value}`);
  }
  return values as ValueFeatureName[];
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function replayFiles(): string[] {
  const file = argValue("file", "");
  if (file) return [file];
  const dir = argValue("dir", join("data", "replays"));
  if (!existsSync(dir)) return [];
  const limit = argNum("limit", 80);
  const files = readdirSync(dir)
    .filter((candidate) => candidate.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((candidate) => join(dir, candidate));
  return limit > 0 ? files.slice(-limit) : files;
}

function readReplay(file: string): ReplaySession | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ReplaySession;
  } catch (error) {
    console.warn(`Skip unreadable replay ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function isGateConfirmState(state: GameState): boolean {
  return state.pendingDecision?.type === "effect-confirm" && state.effectCtx?.awaiting?.kind === "confirm" && state.effectCtx.awaiting.what === "gate";
}

function gatePairFromState(state: GameState, minPressureDelta: number, knownDecks?: KnownDecks): PhaseHGatePairRow | null {
  if (!isGateConfirmState(state)) return null;
  try {
    const player = state.pendingDecision!.player as PlayerId;
    const accept = applyDecision(benchmarkDb, state, { type: "effect-confirm", accept: true });
    const decline = applyDecision(benchmarkDb, state, { type: "effect-confirm", accept: false });
    const pressureDelta =
      evaluatePressureScore(benchmarkDb, accept, player) -
      evaluatePressureScore(benchmarkDb, decline, player);
    if (pressureDelta <= minPressureDelta) return null;
    const acceptX = extractValueFeatures(accept, player, benchmarkDb, { knownDecks });
    const declineX = extractValueFeatures(decline, player, benchmarkDb, { knownDecks });
    return { positiveX: acceptX, negativeX: declineX };
  } catch {
    return null;
  }
}

function collectGatePairs(sessions: readonly ReplaySession[], includeSynthetic: boolean): PhaseHGatePairRow[] {
  const pairs: PhaseHGatePairRow[] = [];
  const minPressureDelta = argNum("min-pressure-delta", 0);
  if (includeSynthetic) {
    const synthetic = gatePairFromState(createFreeAttackGateState(benchmarkDb, argNum("seed", 940)), minPressureDelta);
    if (synthetic) pairs.push({ ...synthetic, weight: argNum("synthetic-weight", 8) });
  }
  for (const session of sessions) {
    const knownDecks: KnownDecks = [session.decks[0].cardIds, session.decks[1].cardIds];
    for (const entry of session.entries) {
      const pair = gatePairFromState(entry.before, minPressureDelta, knownDecks);
      if (pair) pairs.push(pair);
    }
  }
  return pairs;
}

function auditSessions(sessions: readonly ReplaySession[], files: readonly string[], model: ReturnType<typeof fitPhaseHValueModel>["model"]) {
  return sessions.flatMap((session, index) => auditReplaySession(benchmarkDb, session, files[index] ?? `replay-${index}`, { model }).pairs);
}

const games = argNum("games", 400);
const seedStart = argNum("seed-start", 5000);
const sampleEvery = argNum("sample-every", 4);
const maxSteps = argNum("max-steps", 4000);
const outcomePolicy = parsePolicy(argValue("outcome-policy", "heuristic-v2-personality"));
const deckPairMode = parseDeckPairMode(argValue("deck-pair-mode", "cross-archetype"));
const timeMs = argNum("time-ms", 0);
const iterations = argNum("iterations", 64);
const leafHorizon = argNum("leaf-horizon", outcomePolicy === "mo-ismcts" ? 0 : 40);
const candidateLimit = argNum("candidate-limit", 4);
const engineVersion = `breaktcg@${packageVersion()}`;
const mirror = !hasFlag("no-mirror");
const rowCache = argValue("row-cache", "");
const outcomeConfig: OutcomeSourceConfig = {
  outcomePolicy,
  deckPairMode,
  seedStart,
  sampleEvery,
  maxSteps,
  mirror,
  iterations,
  timeMs,
  leafHorizon,
  candidateLimit,
  decks: DECKS,
  engine: engineVersion,
  valueFeatureNames: [...VALUE_FEATURE_NAMES],
};
configureIsmctsBenchmark({
  iterations,
  timeLimitMs: timeMs > 0 ? timeMs : undefined,
  leafRolloutHorizon: leafHorizon,
  candidateLimit,
});
const files = replayFiles();
const sessions = files.map(readReplay).filter((session): session is ReplaySession => session !== null);
const omitted = omittedFeatures();
const nonNegative = nonNegativeFeatures();
const minOutcomeRows = argNum("min-outcome-rows", 100);
const skipGatePairs = hasFlag("no-gate-pairs");
const holdoutEvery = Math.max(0, Math.floor(argNum("holdout-every", 0)));
const holdoutOffset = Math.floor(argNum("holdout-offset", Math.max(0, holdoutEvery - 1)));

console.log(
  `Phase-H-Value-Fit: outcome policy=${outcomePolicy}, deckPairMode=${deckPairMode}, games=${games}, replayFiles=${files.length}, ` +
    `iterations=${iterations}, timeMs=${timeMs}, leaf=${leafHorizon}, candidateLimit=${candidateLimit}`,
);
if (rowCache) console.log(`using row cache: ${rowCache}`);
if (omitted.length > 0) console.log(`omittedFeatures=${omitted.join(",")}`);
if (nonNegative.length > 0) console.log(`nonNegativeFeatures=${nonNegative.join(",")}`);
const outcomeRows = rowCache
  ? collectOutcomeRowsWithCache(games, outcomeConfig, rowCache)
  : collectOutcomeRows(games, outcomeConfig);
const split = splitOutcomeRowsByGame(outcomeRows, holdoutEvery, holdoutOffset);
const trainOutcomeRows = split.trainRows.map(stripCachedRow);
const holdoutOutcomeRows = split.holdoutRows.map(stripCachedRow);
const gatePairs = skipGatePairs ? [] : collectGatePairs(sessions, !hasFlag("no-synthetic"));
console.log(
  `outcomeRows=${outcomeRows.length}, trainRows=${trainOutcomeRows.length}, holdoutRows=${holdoutOutcomeRows.length}, ` +
    `holdoutGames=${split.holdoutGames.length}, gatePairs=${gatePairs.length}`,
);
if (outcomeRows.length < minOutcomeRows) throw new Error(`outcome rows too few: ${outcomeRows.length} < ${minOutcomeRows}`);
if (trainOutcomeRows.length === 0) throw new Error("train outcome rows too few: 0");
if (gatePairs.length === 0 && !hasFlag("allow-no-gate-pairs") && !skipGatePairs) throw new Error("gate pairs too few");

const fitLabel = outcomePolicy === "mixed-k0" ? "Phase K K1 candidate fit" : "Phase H candidate fit";
const result = fitPhaseHValueModel(trainOutcomeRows, gatePairs, {
  epochs: argNum("epochs", 4000),
  lr: argNum("lr", 0.5),
  l2: argNum("l2", 1e-4),
  pairWeight: argNum("pair-weight", 4),
  omittedFeatures: omitted,
  nonNegativeFeatures: nonNegative,
  provenance:
    `${fitLabel} outcomePolicy=${outcomePolicy} outcomeGames=${games} ` +
    `deckPairMode=${deckPairMode} seedStart=${seedStart} outcomeRows=${outcomeRows.length} trainRows=${trainOutcomeRows.length} ` +
    `holdoutRows=${holdoutOutcomeRows.length} holdoutEvery=${holdoutEvery} holdoutOffset=${holdoutOffset} decks=${DECKS.join("|")} ` +
    `search(iter=${iterations},timeMs=${timeMs},leaf=${leafHorizon},candidate=${candidateLimit}) ` +
    `rowCache=${rowCache || "none"} ` +
    `gatePairs=${gatePairs.length} pairWeight=${argNum("pair-weight", 4)} ` +
    `omitted=${omitted.join("|") || "none"} nonNegative=${nonNegative.join("|") || "none"} ` +
    `engine=${engineVersion} [Codex 2026-07-04]`,
});
const { model, metrics } = result;
const holdoutMetrics = holdoutOutcomeRows.length > 0 ? scorePhaseHValueModel(model, holdoutOutcomeRows, []) : null;
console.log(
  `train metrics: logloss=${metrics.logloss.toFixed(4)} acc=${(metrics.accuracy * 100).toFixed(1)}% ` +
    `auc=${metrics.auc.toFixed(4)} pairAcc=${(metrics.pairAccuracy * 100).toFixed(1)}% ` +
    `avgPairMargin=${metrics.averagePairMargin.toFixed(4)}`,
);
if (holdoutMetrics) {
  console.log(
    `holdout metrics: logloss=${holdoutMetrics.logloss.toFixed(4)} acc=${(holdoutMetrics.accuracy * 100).toFixed(1)}% ` +
      `auc=${holdoutMetrics.auc.toFixed(4)}`,
  );
}
console.log("\nfeatures: " + VALUE_FEATURE_NAMES.join(", "));
console.log("\nCandidate ValueModel:");
console.log(`  weights: [${model.weights.map((value) => value.toFixed(4)).join(", ")}],`);
console.log(`  bias: ${model.bias.toFixed(4)},`);
console.log(`  provenance: "${model.provenance}",`);

const audited = auditSessions(sessions, files, model);
const auditSummary = summarizeGateValuePairs(audited);
console.log(
  `\naudit with candidate model: pairs=${auditSummary.totalPairs}, valueCorrect=${auditSummary.valueCorrect}, ` +
    `valueTied=${auditSummary.valueTied}, valueWrong=${auditSummary.valueWrong}, ` +
    `avgValueDelta=${auditSummary.averageValueDelta.toFixed(4)}`,
);

const out = argValue("out", "");
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({
    metrics,
    trainMetrics: metrics,
    holdoutMetrics,
    model,
    auditSummary,
    holdout: {
      every: holdoutEvery,
      offset: holdoutEvery > 0 ? ((holdoutOffset % holdoutEvery) + holdoutEvery) % holdoutEvery : null,
      trainGames: split.trainGames.length,
      holdoutGames: split.holdoutGames.length,
      trainRows: trainOutcomeRows.length,
      holdoutRows: holdoutOutcomeRows.length,
    },
    config: {
      outcomePolicy,
      deckPairMode,
      games,
      seedStart,
      sampleEvery,
      maxSteps,
      mirror,
      iterations,
      timeMs,
      leafHorizon,
      candidateLimit,
      rowCache: rowCache || null,
      holdoutEvery,
      holdoutOffset,
      omittedFeatures: omitted,
      nonNegativeFeatures: nonNegative,
      decks: DECKS,
      engine: engineVersion,
    },
  }, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}
