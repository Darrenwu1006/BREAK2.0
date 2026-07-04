import { describe, expect, it } from "vitest";
import {
  phaseKMlpCalibratedLogit,
  phaseKMlpProbability,
  phaseKMlpRawLogit,
  phaseKSigmoid,
  type PhaseKMlpValueModel,
} from "./phase-k-mlp-value";
import { VALUE_FEATURE_DIM, VALUE_FEATURE_NAMES } from "./rollout-value";

function model(): PhaseKMlpValueModel {
  const input = VALUE_FEATURE_DIM;
  const hidden1 = 32;
  const hidden2 = 16;
  const inputHidden1 = new Array(input * hidden1).fill(0);
  const hidden1Hidden2 = new Array(hidden1 * hidden2).fill(0);
  const hidden2Output = new Array(hidden2).fill(0);
  inputHidden1[0] = 1;
  hidden1Hidden2[0] = 1;
  hidden2Output[0] = 1;
  return {
    architecture: { input, hidden1, hidden2, output: 1, activation: "relu" },
    featureNames: [...VALUE_FEATURE_NAMES],
    normalizer: { mean: new Array(input).fill(0), std: new Array(input).fill(1) },
    weights: {
      inputHidden1,
      hidden1Bias: new Array(hidden1).fill(0),
      hidden1Hidden2,
      hidden2Bias: new Array(hidden2).fill(0),
      hidden2Output,
      outputBias: 0,
    },
    platt: { a: 2, b: -1, rows: 10, eceBins: 10 },
    provenance: "test",
  };
}

describe("phase K MLP value forward", () => {
  it("runs 29->32->16->1 ReLU forward and Platt calibration", () => {
    const m = model();
    const x = new Array(VALUE_FEATURE_DIM).fill(0);
    x[0] = 3;
    expect(phaseKMlpRawLogit(m, x)).toBe(3);
    expect(phaseKMlpCalibratedLogit(m, x)).toBe(5);
    expect(phaseKMlpProbability(m, x)).toBeCloseTo(phaseKSigmoid(5), 12);
  });

  it("keeps negative first feature behind the ReLU gate", () => {
    const m = model();
    const x = new Array(VALUE_FEATURE_DIM).fill(0);
    x[0] = -3;
    expect(phaseKMlpRawLogit(m, x)).toBe(0);
    expect(phaseKMlpCalibratedLogit(m, x)).toBe(-1);
  });
});

