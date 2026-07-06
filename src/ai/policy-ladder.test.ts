import { describe, expect, it } from "vitest";
import {
  computeLadderRatings,
  DEFAULT_LADDER_CONFIG,
  ladderOrder,
  ladderPolicySnapshots,
  runPolicyLadder,
  summarizeLadderPairs,
  type LadderMatchRecord,
  type LadderPolicyId,
} from "./policy-ladder";

function match(policyA: LadderPolicyId, policyB: LadderPolicyId, winnerPolicy: LadderPolicyId, seed: number): LadderMatchRecord {
  return {
    policyA,
    policyB,
    deck: "test-deck",
    seat: 0,
    seed,
    outcome: "complete",
    winnerPolicy,
    steps: 10,
  };
}

describe("policy ladder", () => {
  it("anchors heuristic-v2 at 1500 and orders deterministic pair evidence", () => {
    const policies: LadderPolicyId[] = ["random", "heuristic-v1", "heuristic-v2"];
    const matches = [
      match("heuristic-v2", "random", "heuristic-v2", 1),
      match("heuristic-v2", "random", "heuristic-v2", 2),
      match("heuristic-v1", "random", "heuristic-v1", 3),
      match("heuristic-v2", "heuristic-v1", "heuristic-v2", 4),
    ];
    const ratings = computeLadderRatings(policies, policies, matches);

    expect(ratings.find((rating) => rating.id === "heuristic-v2")?.elo).toBe(1500);
    expect(ladderOrder(ratings, policies)).toEqual(["heuristic-v2", "heuristic-v1", "random"]);
  });

  it("keeps old base order stable when a new non-base policy is added", () => {
    const basePolicies: LadderPolicyId[] = ["random", "heuristic-v1", "heuristic-v2"];
    const matches = [
      match("heuristic-v2", "heuristic-v1", "heuristic-v2", 1),
      match("heuristic-v1", "random", "heuristic-v1", 2),
      match("heuristic-v2", "so-k-v1", "so-k-v1", 3),
      match("heuristic-v1", "so-k-v1", "so-k-v1", 4),
      match("random", "so-k-v1", "so-k-v1", 5),
    ];
    const before = computeLadderRatings(basePolicies, basePolicies, matches);
    const after = computeLadderRatings([...basePolicies, "so-k-v1"], basePolicies, matches);

    expect(ladderOrder(after, basePolicies)).toEqual(ladderOrder(before, basePolicies));
    expect(after.find((rating) => rating.id === "so-k-v1")?.baseFrozen).toBe(false);
  });

  it("summarizes pair wins independent of seat order", () => {
    const summary = summarizeLadderPairs([
      match("random", "heuristic-v2", "heuristic-v2", 1),
      match("heuristic-v2", "random", "random", 2),
    ]);

    expect(summary).toEqual([{ policyA: "heuristic-v2", policyB: "random", completed: 2, winsA: 1, winsB: 1 }]);
  });

  it("records frozen policy snapshots for H4/H5 and selected v1", () => {
    const snapshots = ladderPolicySnapshots(DEFAULT_LADDER_CONFIG);

    expect(snapshots.find((policy) => policy.id === "so-h4h5")?.options.valueModel).toBe("phase-h-h3-15d");
    expect(snapshots.find((policy) => policy.id === "so-k-v1")?.options.valueModel).toBe("phase-k-selected-v1-29d");
  });

  it("small ladder run is reproducible with the same seeds", () => {
    const config = {
      ...DEFAULT_LADDER_CONFIG,
      policies: ["random", "heuristic-v1"] as LadderPolicyId[],
      basePolicies: ["random", "heuristic-v1"] as LadderPolicyId[],
      anchorPolicy: "heuristic-v1" as LadderPolicyId,
      mirrorDecks: ["烏野-預組"],
      gamesPerSeat: 1,
      seedStart: 21000,
      maxSteps: 5000,
    };

    const first = runPolicyLadder(config);
    const second = runPolicyLadder(config);

    expect(first.matches).toEqual(second.matches);
    expect(first.ratings).toEqual(second.ratings);
    expect(first.incrementalCheck.pass).toBe(true);
  });
});
