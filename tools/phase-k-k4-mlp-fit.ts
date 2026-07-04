import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { rawPhaseHValueScore } from "../src/ai/phase-h-value-fit";
import {
  phaseKMlpCalibratedLogit,
  phaseKMlpProbability,
  phaseKMlpRawLogit,
  phaseKSigmoid,
  type PhaseKMlpValueModel,
} from "../src/ai/phase-k-mlp-value";
import { VALUE_FEATURE_DIM, VALUE_FEATURE_NAMES, type ValueModel } from "../src/ai/rollout-value";

interface CachedOutcomeRow {
  gameIndex: number;
  sampleIndex?: number;
  x: number[];
  y: number;
}

interface OutcomeRowCache {
  schemaVersion: 1;
  kind: "phase-h-outcome-rows";
  config: { valueFeatureNames: string[]; [key: string]: unknown };
  rows: CachedOutcomeRow[];
  games: { gameIndex: number; status: string }[];
}

interface SplitRows {
  trainRows: CachedOutcomeRow[];
  calibrationRows: CachedOutcomeRow[];
  holdoutRows: CachedOutcomeRow[];
  trainGames: number[];
  calibrationGames: number[];
  holdoutGames: number[];
}

interface PreparedRows {
  xs: Float64Array;
  ys: Float64Array;
  rows: CachedOutcomeRow[];
}

interface RowPair {
  positive: number;
  negative: number;
}

interface Metrics {
  outcomeCount: number;
  logloss: number;
  accuracy: number;
  auc: number;
  ece: number;
  withinGamePair: {
    pairCount: number;
    pairAccuracy: number;
    tiedPairs: number;
    averagePairMargin: number;
  };
}

interface TrainableMlp {
  input: number;
  hidden1: number;
  hidden2: number;
  w1: Float64Array;
  b1: Float64Array;
  w2: Float64Array;
  b2: Float64Array;
  w3: Float64Array;
  b3: number;
}

interface MlpGrad {
  w1: Float64Array;
  b1: Float64Array;
  w2: Float64Array;
  b2: Float64Array;
  w3: Float64Array;
  b3: number;
}

interface AdamState {
  mw1: Float64Array;
  vw1: Float64Array;
  mb1: Float64Array;
  vb1: Float64Array;
  mw2: Float64Array;
  vw2: Float64Array;
  mb2: Float64Array;
  vb2: Float64Array;
  mw3: Float64Array;
  vw3: Float64Array;
  mb3: number;
  vb3: number;
}

interface TrainCandidate {
  seed: number;
  pairWeight: number;
  lr: number;
  l2: number;
  epochs: number;
}

interface CandidateResult {
  candidate: TrainCandidate;
  model: PhaseKMlpValueModel;
  trainMetrics: Metrics;
  calibrationMetrics: Metrics;
  holdoutMetrics: Metrics;
  platt: { a: number; b: number; calibrationRows: number };
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

function parseNumList(name: string, fallback: number[]): number[] {
  const raw = argValue(name, "");
  if (!raw) return fallback;
  const values = raw.split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v));
  return values.length > 0 ? values : fallback;
}

function seededRnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function readCache(path: string): OutcomeRowCache {
  const cache = JSON.parse(readFileSync(path, "utf8")) as OutcomeRowCache;
  if (cache.schemaVersion !== 1 || cache.kind !== "phase-h-outcome-rows") throw new Error(`unsupported row cache ${path}`);
  const names = cache.config.valueFeatureNames;
  if (names.length !== VALUE_FEATURE_NAMES.length) throw new Error(`row cache feature dim ${names.length} != ${VALUE_FEATURE_NAMES.length}`);
  for (let i = 0; i < names.length; i++) {
    if (names[i] !== VALUE_FEATURE_NAMES[i]) throw new Error(`row cache feature ${i} mismatch: ${names[i]} != ${VALUE_FEATURE_NAMES[i]}`);
  }
  const ordinalByGame = new Map<number, number>();
  cache.rows = cache.rows.map((row) => {
    if (row.x.length !== VALUE_FEATURE_DIM) throw new Error(`row feature dim ${row.x.length} != ${VALUE_FEATURE_DIM}`);
    const ordinal = ordinalByGame.get(row.gameIndex) ?? 0;
    ordinalByGame.set(row.gameIndex, ordinal + 1);
    return { ...row, sampleIndex: typeof row.sampleIndex === "number" ? row.sampleIndex : Math.floor(ordinal / 2) };
  });
  return cache;
}

function splitRows(rows: readonly CachedOutcomeRow[], holdoutEvery: number, holdoutOffset: number, calibrationOffset: number): SplitRows {
  const normalizedHoldout = ((holdoutOffset % holdoutEvery) + holdoutEvery) % holdoutEvery;
  const normalizedCalibration = ((calibrationOffset % holdoutEvery) + holdoutEvery) % holdoutEvery;
  if (normalizedCalibration === normalizedHoldout) throw new Error("calibration offset must differ from holdout offset");
  const trainRows: CachedOutcomeRow[] = [];
  const calibrationRows: CachedOutcomeRow[] = [];
  const holdoutRows: CachedOutcomeRow[] = [];
  const trainGames = new Set<number>();
  const calibrationGames = new Set<number>();
  const holdoutGames = new Set<number>();
  for (const row of rows) {
    const bucket = row.gameIndex % holdoutEvery;
    if (bucket === normalizedHoldout) {
      holdoutRows.push(row);
      holdoutGames.add(row.gameIndex);
    } else if (bucket === normalizedCalibration) {
      calibrationRows.push(row);
      calibrationGames.add(row.gameIndex);
    } else {
      trainRows.push(row);
      trainGames.add(row.gameIndex);
    }
  }
  return {
    trainRows,
    calibrationRows,
    holdoutRows,
    trainGames: [...trainGames].sort((a, b) => a - b),
    calibrationGames: [...calibrationGames].sort((a, b) => a - b),
    holdoutGames: [...holdoutGames].sort((a, b) => a - b),
  };
}

function normalizer(rows: readonly CachedOutcomeRow[]) {
  const mean = new Array(VALUE_FEATURE_DIM).fill(0);
  const std = new Array(VALUE_FEATURE_DIM).fill(0);
  for (const row of rows) for (let j = 0; j < VALUE_FEATURE_DIM; j++) mean[j] += row.x[j]!;
  for (let j = 0; j < VALUE_FEATURE_DIM; j++) mean[j] /= Math.max(1, rows.length);
  for (const row of rows) for (let j = 0; j < VALUE_FEATURE_DIM; j++) std[j] += (row.x[j]! - mean[j]!) ** 2;
  for (let j = 0; j < VALUE_FEATURE_DIM; j++) std[j] = Math.sqrt(std[j]! / Math.max(1, rows.length)) || 1;
  return { mean, std };
}

function prepareRows(rows: readonly CachedOutcomeRow[], norm: { mean: number[]; std: number[] }): PreparedRows {
  const xs = new Float64Array(rows.length * VALUE_FEATURE_DIM);
  const ys = new Float64Array(rows.length);
  rows.forEach((row, i) => {
    ys[i] = row.y;
    for (let j = 0; j < VALUE_FEATURE_DIM; j++) xs[i * VALUE_FEATURE_DIM + j] = (row.x[j]! - norm.mean[j]!) / norm.std[j]!;
  });
  return { xs, ys, rows: [...rows] };
}

function buildPairs(rows: readonly CachedOutcomeRow[]): RowPair[] {
  const groups = new Map<string, { positive?: number; negative?: number }>();
  rows.forEach((row, index) => {
    const key = `${row.gameIndex}:${row.sampleIndex ?? 0}`;
    const group = groups.get(key) ?? {};
    if (row.y === 1) group.positive = index;
    else group.negative = index;
    groups.set(key, group);
  });
  return [...groups.values()]
    .filter((group): group is { positive: number; negative: number } => group.positive !== undefined && group.negative !== undefined)
    .map((group) => ({ positive: group.positive, negative: group.negative }));
}

function initModel(seed: number): TrainableMlp {
  const input = VALUE_FEATURE_DIM;
  const hidden1 = 32;
  const hidden2 = 16;
  const rnd = seededRnd(seed);
  const init = (fanIn: number) => (rnd() * 2 - 1) * Math.sqrt(2 / fanIn);
  const model: TrainableMlp = {
    input,
    hidden1,
    hidden2,
    w1: new Float64Array(input * hidden1),
    b1: new Float64Array(hidden1),
    w2: new Float64Array(hidden1 * hidden2),
    b2: new Float64Array(hidden2),
    w3: new Float64Array(hidden2),
    b3: 0,
  };
  for (let i = 0; i < model.w1.length; i++) model.w1[i] = init(input);
  for (let i = 0; i < model.w2.length; i++) model.w2[i] = init(hidden1);
  for (let i = 0; i < model.w3.length; i++) model.w3[i] = init(hidden2);
  return model;
}

function zeroGrad(model: TrainableMlp): MlpGrad {
  return {
    w1: new Float64Array(model.w1.length),
    b1: new Float64Array(model.b1.length),
    w2: new Float64Array(model.w2.length),
    b2: new Float64Array(model.b2.length),
    w3: new Float64Array(model.w3.length),
    b3: 0,
  };
}

function zeroAdam(model: TrainableMlp): AdamState {
  return {
    mw1: new Float64Array(model.w1.length),
    vw1: new Float64Array(model.w1.length),
    mb1: new Float64Array(model.b1.length),
    vb1: new Float64Array(model.b1.length),
    mw2: new Float64Array(model.w2.length),
    vw2: new Float64Array(model.w2.length),
    mb2: new Float64Array(model.b2.length),
    vb2: new Float64Array(model.b2.length),
    mw3: new Float64Array(model.w3.length),
    vw3: new Float64Array(model.w3.length),
    mb3: 0,
    vb3: 0,
  };
}

function rawForwardPrepared(model: TrainableMlp, xs: Float64Array, rowIndex: number): number {
  const h1 = new Float64Array(model.hidden1);
  const h2 = new Float64Array(model.hidden2);
  const base = rowIndex * model.input;
  for (let j = 0; j < model.hidden1; j++) {
    let z = model.b1[j]!;
    for (let i = 0; i < model.input; i++) z += xs[base + i]! * model.w1[i * model.hidden1 + j]!;
    h1[j] = z > 0 ? z : 0;
  }
  for (let k = 0; k < model.hidden2; k++) {
    let z = model.b2[k]!;
    for (let j = 0; j < model.hidden1; j++) z += h1[j]! * model.w2[j * model.hidden2 + k]!;
    h2[k] = z > 0 ? z : 0;
  }
  let out = model.b3;
  for (let k = 0; k < model.hidden2; k++) out += h2[k]! * model.w3[k]!;
  return out;
}

function accumulateGrad(model: TrainableMlp, grad: MlpGrad, xs: Float64Array, rowIndex: number, dOut: number): void {
  const z1 = new Float64Array(model.hidden1);
  const h1 = new Float64Array(model.hidden1);
  const z2 = new Float64Array(model.hidden2);
  const h2 = new Float64Array(model.hidden2);
  const base = rowIndex * model.input;
  for (let j = 0; j < model.hidden1; j++) {
    let z = model.b1[j]!;
    for (let i = 0; i < model.input; i++) z += xs[base + i]! * model.w1[i * model.hidden1 + j]!;
    z1[j] = z;
    h1[j] = z > 0 ? z : 0;
  }
  for (let k = 0; k < model.hidden2; k++) {
    let z = model.b2[k]!;
    for (let j = 0; j < model.hidden1; j++) z += h1[j]! * model.w2[j * model.hidden2 + k]!;
    z2[k] = z;
    h2[k] = z > 0 ? z : 0;
  }

  const dh2 = new Float64Array(model.hidden2);
  for (let k = 0; k < model.hidden2; k++) {
    grad.w3[k] = (grad.w3[k] ?? 0) + dOut * h2[k]!;
    dh2[k] = dOut * model.w3[k]!;
  }
  grad.b3 += dOut;

  const dh1 = new Float64Array(model.hidden1);
  for (let k = 0; k < model.hidden2; k++) {
    const dz2 = z2[k]! > 0 ? dh2[k]! : 0;
    grad.b2[k] = (grad.b2[k] ?? 0) + dz2;
    for (let j = 0; j < model.hidden1; j++) {
      const index = j * model.hidden2 + k;
      grad.w2[index] = (grad.w2[index] ?? 0) + dz2 * h1[j]!;
      dh1[j] = (dh1[j] ?? 0) + dz2 * model.w2[index]!;
    }
  }

  for (let j = 0; j < model.hidden1; j++) {
    const dz1 = z1[j]! > 0 ? dh1[j]! : 0;
    grad.b1[j] = (grad.b1[j] ?? 0) + dz1;
    for (let i = 0; i < model.input; i++) {
      const index = i * model.hidden1 + j;
      grad.w1[index] = (grad.w1[index] ?? 0) + dz1 * xs[base + i]!;
    }
  }
}

function updateArray(param: Float64Array, grad: Float64Array, m: Float64Array, v: Float64Array, lr: number, l2: number, norm: number, t: number): void {
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  for (let i = 0; i < param.length; i++) {
    const g = grad[i]! / norm + l2 * param[i]!;
    m[i] = beta1 * m[i]! + (1 - beta1) * g;
    v[i] = beta2 * v[i]! + (1 - beta2) * g * g;
    const mh = m[i]! / (1 - beta1 ** t);
    const vh = v[i]! / (1 - beta2 ** t);
    param[i] = (param[i] ?? 0) - lr * mh / (Math.sqrt(vh) + eps);
  }
}

function updateScalar(param: number, grad: number, m: number, v: number, lr: number, norm: number, t: number) {
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  const g = grad / norm;
  const nextM = beta1 * m + (1 - beta1) * g;
  const nextV = beta2 * v + (1 - beta2) * g * g;
  const mh = nextM / (1 - beta1 ** t);
  const vh = nextV / (1 - beta2 ** t);
  return { value: param - lr * mh / (Math.sqrt(vh) + eps), m: nextM, v: nextV };
}

function trainMlp(rows: PreparedRows, pairs: readonly RowPair[], candidate: TrainCandidate): TrainableMlp {
  const model = initModel(candidate.seed);
  const adam = zeroAdam(model);
  for (let epoch = 1; epoch <= candidate.epochs; epoch++) {
    const grad = zeroGrad(model);
    let norm = rows.rows.length + candidate.pairWeight * pairs.length;
    norm = Math.max(1, norm);
    for (let i = 0; i < rows.rows.length; i++) {
      const logit = rawForwardPrepared(model, rows.xs, i);
      accumulateGrad(model, grad, rows.xs, i, phaseKSigmoid(logit) - rows.ys[i]!);
    }
    if (candidate.pairWeight > 0) {
      for (const pair of pairs) {
        const pos = rawForwardPrepared(model, rows.xs, pair.positive);
        const neg = rawForwardPrepared(model, rows.xs, pair.negative);
        const err = (phaseKSigmoid(pos - neg) - 1) * candidate.pairWeight;
        accumulateGrad(model, grad, rows.xs, pair.positive, err);
        accumulateGrad(model, grad, rows.xs, pair.negative, -err);
      }
    }
    updateArray(model.w1, grad.w1, adam.mw1, adam.vw1, candidate.lr, candidate.l2, norm, epoch);
    updateArray(model.b1, grad.b1, adam.mb1, adam.vb1, candidate.lr, 0, norm, epoch);
    updateArray(model.w2, grad.w2, adam.mw2, adam.vw2, candidate.lr, candidate.l2, norm, epoch);
    updateArray(model.b2, grad.b2, adam.mb2, adam.vb2, candidate.lr, 0, norm, epoch);
    updateArray(model.w3, grad.w3, adam.mw3, adam.vw3, candidate.lr, candidate.l2, norm, epoch);
    const b3 = updateScalar(model.b3, grad.b3, adam.mb3, adam.vb3, candidate.lr, norm, epoch);
    model.b3 = b3.value;
    adam.mb3 = b3.m;
    adam.vb3 = b3.v;
  }
  return model;
}

function freezeModel(model: TrainableMlp, norm: { mean: number[]; std: number[] }, platt: { a: number; b: number; rows: number }, provenance: string): PhaseKMlpValueModel {
  return {
    architecture: { input: model.input, hidden1: model.hidden1, hidden2: model.hidden2, output: 1, activation: "relu" },
    featureNames: [...VALUE_FEATURE_NAMES],
    normalizer: { mean: norm.mean, std: norm.std },
    weights: {
      inputHidden1: [...model.w1],
      hidden1Bias: [...model.b1],
      hidden1Hidden2: [...model.w2],
      hidden2Bias: [...model.b2],
      hidden2Output: [...model.w3],
      outputBias: model.b3,
    },
    platt: { a: platt.a, b: platt.b, rows: platt.rows, eceBins: 10 },
    provenance,
  };
}

function fitPlatt(rawLogits: readonly number[], labels: readonly number[]): { a: number; b: number } {
  let a = 1;
  let b = 0;
  const lr = 0.05;
  const l2 = 1e-4;
  for (let epoch = 0; epoch < 1200; epoch++) {
    let ga = 0;
    let gb = 0;
    for (let i = 0; i < rawLogits.length; i++) {
      const z = a * rawLogits[i]! + b;
      const err = phaseKSigmoid(z) - labels[i]!;
      ga += err * rawLogits[i]!;
      gb += err;
    }
    const norm = Math.max(1, rawLogits.length);
    a -= lr * (ga / norm + l2 * (a - 1));
    b -= lr * (gb / norm);
  }
  return { a, b };
}

function computeAuc(scored: { score: number; y: number }[]): number {
  const sorted = scored.slice().sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j]!.score === sorted[i]!.score) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (sorted[k]!.y === 1) rankSum += avgRank;
    i = j;
  }
  const pos = scored.reduce((sum, row) => sum + row.y, 0);
  const neg = scored.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

function computeEce(scored: { p: number; y: number }[], bins = 10): number {
  const bucket = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const row of scored) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(row.p * bins)));
    bucket[index]!.n++;
    bucket[index]!.conf += row.p;
    bucket[index]!.acc += row.y;
  }
  return bucket.reduce((ece, bin) => {
    if (bin.n === 0) return ece;
    return ece + (bin.n / scored.length) * Math.abs(bin.acc / bin.n - bin.conf / bin.n);
  }, 0);
}

function scoreRows(rows: readonly CachedOutcomeRow[], scoreFn: (x: readonly number[]) => number, probFn: (x: readonly number[]) => number): Metrics {
  let logloss = 0;
  let correct = 0;
  const scored: { score: number; p: number; y: number }[] = [];
  for (const row of rows) {
    const score = scoreFn(row.x);
    const p = Math.max(1e-12, Math.min(1 - 1e-12, probFn(row.x)));
    logloss += -(row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p));
    if ((p >= 0.5 ? 1 : 0) === row.y) correct++;
    scored.push({ score, p, y: row.y });
  }
  const byKey = new Map<string, { pos?: number; neg?: number }>();
  for (const row of rows) {
    const key = `${row.gameIndex}:${row.sampleIndex ?? 0}`;
    const group = byKey.get(key) ?? {};
    if (row.y === 1) group.pos = scoreFn(row.x);
    else group.neg = scoreFn(row.x);
    byKey.set(key, group);
  }
  let pairCount = 0;
  let pairCorrect = 0;
  let tiedPairs = 0;
  let marginSum = 0;
  for (const group of byKey.values()) {
    if (group.pos === undefined || group.neg === undefined) continue;
    const margin = group.pos - group.neg;
    pairCount++;
    marginSum += margin;
    if (margin > 0) pairCorrect++;
    else if (margin === 0) tiedPairs++;
  }
  return {
    outcomeCount: rows.length,
    logloss: rows.length === 0 ? 0 : logloss / rows.length,
    accuracy: rows.length === 0 ? 0 : correct / rows.length,
    auc: rows.length === 0 ? 0.5 : computeAuc(scored),
    ece: rows.length === 0 ? 0 : computeEce(scored, 10),
    withinGamePair: {
      pairCount,
      pairAccuracy: pairCount === 0 ? 0 : pairCorrect / pairCount,
      tiedPairs,
      averagePairMargin: pairCount === 0 ? 0 : marginSum / pairCount,
    },
  };
}

function scoreMlp(model: PhaseKMlpValueModel, rows: readonly CachedOutcomeRow[]): Metrics {
  return scoreRows(rows, (x) => phaseKMlpCalibratedLogit(model, x), (x) => phaseKMlpProbability(model, x));
}

function scoreValueModel(model: ValueModel, rows: readonly CachedOutcomeRow[]): Metrics {
  return scoreRows(rows, (x) => rawPhaseHValueScore(model, x), (x) => phaseKSigmoid(rawPhaseHValueScore(model, x)));
}

function evaluateCandidate(
  split: SplitRows,
  preparedTrain: PreparedRows,
  trainPairs: RowPair[],
  norm: { mean: number[]; std: number[] },
  candidate: TrainCandidate,
  provenance: string,
): CandidateResult {
  const trainable = trainMlp(preparedTrain, trainPairs, candidate);
  const calibrationPrepared = prepareRows(split.calibrationRows, norm);
  const rawLogits = split.calibrationRows.map((_row, index) => rawForwardPrepared(trainable, calibrationPrepared.xs, index));
  const labels = split.calibrationRows.map((row) => row.y);
  const platt = fitPlatt(rawLogits, labels);
  const model = freezeModel(trainable, norm, { ...platt, rows: split.calibrationRows.length }, provenance);
  return {
    candidate,
    model,
    trainMetrics: scoreMlp(model, split.trainRows),
    calibrationMetrics: scoreMlp(model, split.calibrationRows),
    holdoutMetrics: scoreMlp(model, split.holdoutRows),
    platt: { a: platt.a, b: platt.b, calibrationRows: split.calibrationRows.length },
  };
}

function candidateGrid(): TrainCandidate[] {
  const seeds = parseNumList("train-seeds", [4101, 4102]);
  const pairWeights = parseNumList("pair-weights", [0, 0.5]);
  const lr = argNum("lr", 0.003);
  const l2 = argNum("l2", 1e-4);
  const epochs = Math.max(1, Math.floor(argNum("epochs", 180)));
  return seeds.flatMap((seed) => pairWeights.map((pairWeight) => ({ seed, pairWeight, lr, l2, epochs })));
}

const rowCachePath = argValue("row-cache", "data/ab/phase-k-k15-outcome-rows-feature-v1-mixed-h4-heur-g2000-i16.json");
const selectedPath = argValue("selected-v1", "data/ab/phase-k-k15-selected-v1-fit-holdout-g2000-i16.json");
const outPath = argValue("out", "data/ab/phase-k-k4-mlp-fit-holdout-g2000-i16.json");
const games = Math.floor(argNum("games", 2000));
const holdoutEvery = Math.max(2, Math.floor(argNum("holdout-every", 5)));
const holdoutOffset = Math.floor(argNum("holdout-offset", 4));
const calibrationOffset = Math.floor(argNum("calibration-offset", 3));
const cache = readCache(rowCachePath);
const rows = cache.rows.filter((row) => row.gameIndex < games);
const split = splitRows(rows, holdoutEvery, holdoutOffset, calibrationOffset);
const norm = normalizer(split.trainRows);
const preparedTrain = prepareRows(split.trainRows, norm);
const trainPairs = buildPairs(split.trainRows);
const selectedPayload = JSON.parse(readFileSync(selectedPath, "utf8")) as { model: ValueModel };
if (!selectedPayload.model) throw new Error(`missing selected v1 model in ${selectedPath}`);

console.log(
  `Phase-K-K4-MLP: rows=${rows.length}, trainRows=${split.trainRows.length}, calibrationRows=${split.calibrationRows.length}, ` +
    `holdoutRows=${split.holdoutRows.length}, trainPairs=${trainPairs.length}, candidates=${candidateGrid().length}`,
);
const provenanceBase =
  `Phase K K4 MLP 29->32->16->1 rowCache=${rowCachePath} rows=${rows.length} ` +
  `trainRows=${split.trainRows.length} calibrationRows=${split.calibrationRows.length} holdoutRows=${split.holdoutRows.length} ` +
  `holdoutEvery=${holdoutEvery} holdoutOffset=${holdoutOffset} calibrationOffset=${calibrationOffset} [Codex 2026-07-04]`;

const results: CandidateResult[] = [];
for (const candidate of candidateGrid()) {
  console.log(`candidate seed=${candidate.seed} pairWeight=${candidate.pairWeight} epochs=${candidate.epochs} lr=${candidate.lr} l2=${candidate.l2}`);
  const result = evaluateCandidate(
    split,
    preparedTrain,
    trainPairs,
    norm,
    candidate,
    `${provenanceBase} seed=${candidate.seed} pairWeight=${candidate.pairWeight} epochs=${candidate.epochs} lr=${candidate.lr} l2=${candidate.l2}`,
  );
  results.push(result);
  console.log(
    `  holdout pairAcc=${(result.holdoutMetrics.withinGamePair.pairAccuracy * 100).toFixed(2)}% ` +
      `auc=${result.holdoutMetrics.auc.toFixed(4)} ece=${result.holdoutMetrics.ece.toFixed(4)} ` +
      `platt(a=${result.platt.a.toFixed(3)},b=${result.platt.b.toFixed(3)})`,
  );
}

results.sort(
  (a, b) =>
    b.holdoutMetrics.withinGamePair.pairAccuracy - a.holdoutMetrics.withinGamePair.pairAccuracy ||
    b.holdoutMetrics.auc - a.holdoutMetrics.auc ||
    a.holdoutMetrics.ece - b.holdoutMetrics.ece,
);
const best = results[0]!;
const selectedMetrics = {
  train: scoreValueModel(selectedPayload.model, split.trainRows),
  calibration: scoreValueModel(selectedPayload.model, split.calibrationRows),
  holdout: scoreValueModel(selectedPayload.model, split.holdoutRows),
};

const output = {
  schemaVersion: 1,
  kind: "phase-k-k4-mlp-fit",
  rowCachePath,
  selectedV1Path: selectedPath,
  split: {
    games,
    holdoutEvery,
    holdoutOffset: ((holdoutOffset % holdoutEvery) + holdoutEvery) % holdoutEvery,
    calibrationOffset: ((calibrationOffset % holdoutEvery) + holdoutEvery) % holdoutEvery,
    trainGames: split.trainGames.length,
    calibrationGames: split.calibrationGames.length,
    holdoutGames: split.holdoutGames.length,
    trainRows: split.trainRows.length,
    calibrationRows: split.calibrationRows.length,
    holdoutRows: split.holdoutRows.length,
    trainPairs: trainPairs.length,
    holdoutPairs: buildPairs(split.holdoutRows).length,
  },
  selection: {
    primaryMetric: "holdoutWithinGamePairAccuracy",
    selectedIndex: results.indexOf(best),
    selectedCandidate: best.candidate,
    baselineSelectedV1HoldoutPairAccuracy: selectedMetrics.holdout.withinGamePair.pairAccuracy,
  },
  model: best.model,
  metrics: {
    train: best.trainMetrics,
    calibration: best.calibrationMetrics,
    holdout: best.holdoutMetrics,
  },
  comparison: {
    selectedV1: selectedMetrics,
    deltas: {
      holdoutPairAcc: best.holdoutMetrics.withinGamePair.pairAccuracy - selectedMetrics.holdout.withinGamePair.pairAccuracy,
      holdoutAuc: best.holdoutMetrics.auc - selectedMetrics.holdout.auc,
      holdoutEce: best.holdoutMetrics.ece - selectedMetrics.holdout.ece,
    },
  },
  candidates: results.map((result) => ({
    candidate: result.candidate,
    platt: result.platt,
    trainMetrics: result.trainMetrics,
    calibrationMetrics: result.calibrationMetrics,
    holdoutMetrics: result.holdoutMetrics,
  })),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      outPath,
      selectedCandidate: best.candidate,
      holdout: best.holdoutMetrics,
      selectedV1Holdout: selectedMetrics.holdout,
      deltas: output.comparison.deltas,
    },
    null,
    2,
  ),
);
