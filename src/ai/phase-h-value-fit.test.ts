import { describe, expect, it } from "vitest";
import { VALUE_FEATURE_DIM, VALUE_FEATURE_NAMES } from "./rollout-value";
import { fitPhaseHValueModel } from "./phase-h-value-fit";

function blank(): number[] {
  return new Array(VALUE_FEATURE_DIM).fill(0);
}

describe("M8 Phase H pairwise value fit", () => {
  it("learns to rank gate-positive accept features above decline features", () => {
    const attackPoint = VALUE_FEATURE_NAMES.indexOf("attackPointDiff");
    const accept = blank();
    const decline = blank();
    accept[attackPoint] = 5;

    const { model, metrics } = fitPhaseHValueModel(
      [
        { x: blank(), y: 0 },
        { x: accept, y: 1 },
      ],
      [{ positiveX: accept, negativeX: decline }],
      { epochs: 500, pairWeight: 8, lr: 0.4 },
    );

    expect(metrics.pairAccuracy).toBe(1);
    expect(model.weights[attackPoint]).toBeGreaterThan(0);
  });

  it("can omit a collinear feature while preserving model dimensionality", () => {
    const attackPoint = VALUE_FEATURE_NAMES.indexOf("attackPointDiff");
    const attackLine = VALUE_FEATURE_NAMES.indexOf("attackLinePointDiff");
    const accept = blank();
    const decline = blank();
    accept[attackPoint] = 5;
    accept[attackLine] = 5;

    const { model } = fitPhaseHValueModel(
      [{ x: accept, y: 1 }, { x: decline, y: 0 }],
      [{ positiveX: accept, negativeX: decline }],
      { epochs: 300, pairWeight: 4, omittedFeatures: ["attackPointDiff"] },
    );

    expect(model.weights).toHaveLength(VALUE_FEATURE_DIM);
    expect(model.weights[attackPoint]).toBe(0);
    expect(model.weights[attackLine]).toBeGreaterThan(0);
  });

  it("can enforce non-negative signs for selected point features", () => {
    const defensePoint = VALUE_FEATURE_NAMES.indexOf("defensePointDiff");
    const highDefenseLoses = blank();
    const lowDefenseWins = blank();
    highDefenseLoses[defensePoint] = 5;

    const { model } = fitPhaseHValueModel(
      [{ x: highDefenseLoses, y: 0 }, { x: lowDefenseWins, y: 1 }],
      [],
      { epochs: 300, nonNegativeFeatures: ["defensePointDiff"] },
    );

    expect(model.weights[defensePoint]).toBeGreaterThanOrEqual(0);
  });
});
