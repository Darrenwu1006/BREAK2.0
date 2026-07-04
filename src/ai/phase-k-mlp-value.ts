import { VALUE_FEATURE_DIM, VALUE_FEATURE_NAMES } from "./rollout-value";

export interface PhaseKMlpNormalizer {
  mean: number[];
  std: number[];
}

export interface PhaseKMlpWeights {
  inputHidden1: number[];
  hidden1Bias: number[];
  hidden1Hidden2: number[];
  hidden2Bias: number[];
  hidden2Output: number[];
  outputBias: number;
}

export interface PhaseKPlattCalibration {
  a: number;
  b: number;
  rows: number;
  eceBins: number;
}

export interface PhaseKMlpValueModel {
  architecture: {
    input: number;
    hidden1: number;
    hidden2: number;
    output: 1;
    activation: "relu";
  };
  featureNames: string[];
  normalizer: PhaseKMlpNormalizer;
  weights: PhaseKMlpWeights;
  platt: PhaseKPlattCalibration;
  provenance: string;
}

export function phaseKSigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function assertPhaseKMlpShape(model: PhaseKMlpValueModel): void {
  const { input, hidden1, hidden2, output } = model.architecture;
  if (output !== 1) throw new Error(`unsupported Phase K MLP output dim ${output}`);
  if (input !== VALUE_FEATURE_DIM) throw new Error(`Phase K MLP input dim ${input} != ${VALUE_FEATURE_DIM}`);
  if (model.featureNames.length !== VALUE_FEATURE_DIM) throw new Error("Phase K MLP feature names length mismatch");
  for (let i = 0; i < VALUE_FEATURE_DIM; i++) {
    if (model.featureNames[i] !== VALUE_FEATURE_NAMES[i]) throw new Error(`Phase K MLP feature ${i} mismatch`);
  }
  if (model.normalizer.mean.length !== input || model.normalizer.std.length !== input) {
    throw new Error("Phase K MLP normalizer shape mismatch");
  }
  if (model.weights.inputHidden1.length !== input * hidden1) throw new Error("Phase K MLP inputHidden1 shape mismatch");
  if (model.weights.hidden1Bias.length !== hidden1) throw new Error("Phase K MLP hidden1Bias shape mismatch");
  if (model.weights.hidden1Hidden2.length !== hidden1 * hidden2) throw new Error("Phase K MLP hidden1Hidden2 shape mismatch");
  if (model.weights.hidden2Bias.length !== hidden2) throw new Error("Phase K MLP hidden2Bias shape mismatch");
  if (model.weights.hidden2Output.length !== hidden2) throw new Error("Phase K MLP hidden2Output shape mismatch");
}

export function phaseKMlpRawLogit(model: PhaseKMlpValueModel, x: readonly number[]): number {
  assertPhaseKMlpShape(model);
  const { input, hidden1, hidden2 } = model.architecture;
  const w = model.weights;
  const h1 = new Float64Array(hidden1);
  const h2 = new Float64Array(hidden2);

  for (let j = 0; j < hidden1; j++) {
    let z = w.hidden1Bias[j] ?? 0;
    for (let i = 0; i < input; i++) {
      const std = model.normalizer.std[i] || 1;
      const v = ((x[i] ?? 0) - (model.normalizer.mean[i] ?? 0)) / std;
      z += v * (w.inputHidden1[i * hidden1 + j] ?? 0);
    }
    h1[j] = z > 0 ? z : 0;
  }

  for (let k = 0; k < hidden2; k++) {
    let z = w.hidden2Bias[k] ?? 0;
    for (let j = 0; j < hidden1; j++) z += h1[j]! * (w.hidden1Hidden2[j * hidden2 + k] ?? 0);
    h2[k] = z > 0 ? z : 0;
  }

  let out = w.outputBias;
  for (let k = 0; k < hidden2; k++) out += h2[k]! * (w.hidden2Output[k] ?? 0);
  return out;
}

export function phaseKMlpCalibratedLogit(model: PhaseKMlpValueModel, x: readonly number[]): number {
  return model.platt.a * phaseKMlpRawLogit(model, x) + model.platt.b;
}

export function phaseKMlpProbability(model: PhaseKMlpValueModel, x: readonly number[]): number {
  return phaseKSigmoid(phaseKMlpCalibratedLogit(model, x));
}

