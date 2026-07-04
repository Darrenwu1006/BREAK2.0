import type { ValueModel } from "./rollout-value";
import { VALUE_FEATURE_DIM, VALUE_FEATURE_NAMES, type ValueFeatureName } from "./rollout-value";

export interface PhaseHOutcomeRow {
  x: number[];
  y: number;
}

export interface PhaseHGatePairRow {
  positiveX: number[];
  negativeX: number[];
  weight?: number;
}

export interface PhaseHValueFitOptions {
  epochs?: number;
  lr?: number;
  l2?: number;
  pairWeight?: number;
  omittedFeatures?: readonly ValueFeatureName[];
  nonNegativeFeatures?: readonly ValueFeatureName[];
  provenance?: string;
}

export interface PhaseHValueFitMetrics {
  outcomeCount: number;
  pairCount: number;
  logloss: number;
  accuracy: number;
  auc: number;
  pairAccuracy: number;
  averagePairMargin: number;
}

export interface PhaseHValueFitResult {
  model: ValueModel;
  metrics: PhaseHValueFitMetrics;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function computeAuc(scored: { p: number; y: number }[]): number {
  const sorted = scored.slice().sort((a, b) => a.p - b.p);
  let rankSum = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j]!.p === sorted[i]!.p) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (sorted[k]!.y === 1) rankSum += avgRank;
    i = j;
  }
  const nPos = scored.reduce((sum, row) => sum + row.y, 0);
  const nNeg = scored.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export function rawPhaseHValueScore(model: ValueModel, x: readonly number[]): number {
  let z = model.bias;
  for (let i = 0; i < VALUE_FEATURE_DIM; i++) z += (model.weights[i] ?? 0) * (x[i] ?? 0);
  return z;
}

function assertDim(rows: readonly PhaseHOutcomeRow[], pairs: readonly PhaseHGatePairRow[]): void {
  const badOutcome = rows.find((row) => row.x.length !== VALUE_FEATURE_DIM);
  if (badOutcome) throw new Error(`outcome row feature dim ${badOutcome.x.length} != ${VALUE_FEATURE_DIM}`);
  const badPair = pairs.find((pair) => pair.positiveX.length !== VALUE_FEATURE_DIM || pair.negativeX.length !== VALUE_FEATURE_DIM);
  if (badPair) throw new Error(`pair row feature dim must equal ${VALUE_FEATURE_DIM}`);
}

export function fitPhaseHValueModel(
  rows: readonly PhaseHOutcomeRow[],
  pairs: readonly PhaseHGatePairRow[],
  options: PhaseHValueFitOptions = {},
): PhaseHValueFitResult {
  assertDim(rows, pairs);
  if (rows.length === 0 && pairs.length === 0) throw new Error("no training rows");
  const dim = VALUE_FEATURE_DIM;
  const epochs = options.epochs ?? 4000;
  const lr = options.lr ?? 0.5;
  const l2 = options.l2 ?? 1e-4;
  const pairWeight = options.pairWeight ?? 1;
  const omitted = new Set(options.omittedFeatures ?? []);
  const nonNegative = new Set(options.nonNegativeFeatures ?? []);
  const active = VALUE_FEATURE_NAMES.map((name) => !omitted.has(name));
  const constrainedNonNegative = VALUE_FEATURE_NAMES.map((name) => nonNegative.has(name));

  const allX = [
    ...rows.map((row) => row.x),
    ...pairs.flatMap((pair) => [pair.positiveX, pair.negativeX]),
  ];
  const mean = new Array(dim).fill(0);
  const std = new Array(dim).fill(0);
  for (const x of allX) for (let j = 0; j < dim; j++) if (active[j]) mean[j] += x[j]!;
  for (let j = 0; j < dim; j++) mean[j] = active[j] ? mean[j] / allX.length : 0;
  for (const x of allX) for (let j = 0; j < dim; j++) if (active[j]) std[j] += (x[j]! - mean[j]) ** 2;
  for (let j = 0; j < dim; j++) std[j] = active[j] ? Math.sqrt(std[j] / allX.length) || 1 : 1;

  const zRows = rows.map((row) => ({ z: row.x.map((v, j) => (v - mean[j]) / std[j]), y: row.y }));
  const zPairs = pairs.map((pair) => ({
    positive: pair.positiveX.map((v, j) => (v - mean[j]) / std[j]),
    negative: pair.negativeX.map((v, j) => (v - mean[j]) / std[j]),
    weight: pair.weight ?? 1,
  }));
  const w = new Array(dim).fill(0);
  let b = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Array(dim).fill(0);
    let gb = 0;
    let norm = rows.length;
    for (const row of zRows) {
      let s = b;
      for (let j = 0; j < dim; j++) if (active[j]) s += w[j] * row.z[j]!;
      const err = sigmoid(s) - row.y;
      for (let j = 0; j < dim; j++) if (active[j]) gw[j] += err * row.z[j]!;
      gb += err;
    }
    for (const pair of zPairs) {
      let margin = 0;
      for (let j = 0; j < dim; j++) if (active[j]) margin += w[j] * (pair.positive[j]! - pair.negative[j]!);
      const err = sigmoid(margin) - 1;
      const scale = pairWeight * pair.weight;
      norm += scale;
      for (let j = 0; j < dim; j++) if (active[j]) gw[j] += scale * err * (pair.positive[j]! - pair.negative[j]!);
    }
    norm = Math.max(1, norm);
    for (let j = 0; j < dim; j++) {
      if (!active[j]) {
        w[j] = 0;
        continue;
      }
      w[j] -= lr * (gw[j] / norm + l2 * w[j]);
      if (constrainedNonNegative[j] && w[j] < 0) w[j] = 0;
    }
    b -= lr * (gb / norm);
  }

  const wRaw = w.map((wj, j) => active[j] ? wj / std[j] : 0);
  let bRaw = b;
  for (let j = 0; j < dim; j++) if (active[j]) bRaw -= (w[j] * mean[j]) / std[j];
  const model: ValueModel = {
    weights: wRaw,
    bias: bRaw,
    provenance: options.provenance ?? "Phase H pairwise gate-positive fit candidate [Codex 2026-06-30]",
  };

  return {
    model,
    metrics: scorePhaseHValueModel(model, rows, pairs),
  };
}

export function scorePhaseHValueModel(
  model: ValueModel,
  rows: readonly PhaseHOutcomeRow[],
  pairs: readonly PhaseHGatePairRow[] = [],
): PhaseHValueFitMetrics {
  assertDim(rows, pairs);
  let logloss = 0;
  let correct = 0;
  const scored: { p: number; y: number }[] = [];
  for (const row of rows) {
    const p = sigmoid(rawPhaseHValueScore(model, row.x));
    logloss += -(row.y * Math.log(p + 1e-12) + (1 - row.y) * Math.log(1 - p + 1e-12));
    if ((p >= 0.5 ? 1 : 0) === row.y) correct++;
    scored.push({ p, y: row.y });
  }
  const pairMargins = pairs.map((pair) => rawPhaseHValueScore(model, pair.positiveX) - rawPhaseHValueScore(model, pair.negativeX));
  return {
    outcomeCount: rows.length,
    pairCount: pairs.length,
    logloss: rows.length === 0 ? 0 : logloss / rows.length,
    accuracy: rows.length === 0 ? 0 : correct / rows.length,
    auc: rows.length === 0 ? 0.5 : computeAuc(scored),
    pairAccuracy: pairMargins.length === 0 ? 0 : pairMargins.filter((margin) => margin > 0).length / pairMargins.length,
    averagePairMargin: pairMargins.length === 0 ? 0 : pairMargins.reduce((sum, margin) => sum + margin, 0) / pairMargins.length,
  };
}
