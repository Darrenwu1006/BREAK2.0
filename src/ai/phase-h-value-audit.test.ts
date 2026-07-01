import { describe, expect, it } from "vitest";
import { benchmarkDb } from "./benchmark-fixtures";
import { createFreeAttackGateState } from "./phase-h-gate-control";
import { analyzeGateValuePair, summarizeGateValuePairs } from "./phase-h-value-audit";

describe("M8 Phase H value audit", () => {
  it("records a gate-positive accept/decline value pair for HV-P01-043 free +5", () => {
    const state = createFreeAttackGateState(benchmarkDb, 940);
    const pair = analyzeGateValuePair(benchmarkDb, state, "synthetic:free-attack-gate");

    expect(pair).not.toBeNull();
    expect(pair!.player).toBe(0);
    expect(pair!.acceptLabel).not.toBe(pair!.declineLabel);
    expect(pair!.pressureDelta).toBeGreaterThan(0);
  });

  it("summarizes whether leaf value agrees with gate-positive pressure deltas", () => {
    const state = createFreeAttackGateState(benchmarkDb, 940);
    const pair = analyzeGateValuePair(benchmarkDb, state, "synthetic:free-attack-gate");
    const summary = summarizeGateValuePairs(pair ? [pair] : []);

    expect(summary.totalPairs).toBe(1);
    expect(summary.valueCorrect + summary.valueTied + summary.valueWrong).toBe(summary.totalPairs);
    expect(summary.averagePressureDelta).toBeGreaterThan(0);
  });
});
