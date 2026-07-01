import { describe, expect, it } from "vitest";
import { benchmarkDb } from "./benchmark-fixtures";
import { createFreeAttackGateState, runPhaseHFreeAttackGateControl } from "./phase-h-gate-control";
import { enumerateCandidates } from "./coach";
import { heuristicAiDecision } from "./heuristic";
import { rootDecisionPressureScore } from "./ismcts";

describe("M8 Phase H gate control", () => {
  it("HV-P01-043 controlled scenario exposes accept/decline and heuristic accepts the free +5 gate", () => {
    const state = createFreeAttackGateState(benchmarkDb, 940);
    const fallback = heuristicAiDecision(benchmarkDb, state, "heuristic-v2-burst");
    const candidates = enumerateCandidates(benchmarkDb, state, 4, fallback).filter((decision) => decision.type === "effect-confirm");

    expect(candidates).toEqual(
      expect.arrayContaining([
        { type: "effect-confirm", accept: true },
        { type: "effect-confirm", accept: false },
      ]),
    );
    expect(fallback).toEqual({ type: "effect-confirm", accept: true });
    expect(rootDecisionPressureScore(benchmarkDb, state, { type: "effect-confirm", accept: true }, 0)).toBeGreaterThan(
      rootDecisionPressureScore(benchmarkDb, state, { type: "effect-confirm", accept: false }, 0),
    );
  });

  it("control report records whether SO root chooses accept for the free +5 gate", () => {
    const report = runPhaseHFreeAttackGateControl(benchmarkDb, { iterations: 24, leafRolloutHorizon: 0 });
    expect(report.beforeAttackPoint).toBe(0);
    expect(report.acceptAttackPoint).toBe(5);
    expect(report.declineAttackPoint).toBe(0);
    expect(report.results.map((item) => item.policy)).toEqual(["heuristic-v2-burst", "is-mcts", "is-mcts-root-pressure"]);
    expect(report.results[0]!.accept).toBe(true);
    expect(report.results[1]!.recommendations.length).toBeGreaterThan(0);
  });
});
