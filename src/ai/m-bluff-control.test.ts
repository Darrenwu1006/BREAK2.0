import { describe, expect, it } from "vitest";
import { applyDecision } from "../engine/engine";
import { benchmarkDb } from "./benchmark-fixtures";
import { createDropHandPrivateChoiceState, runMBluffDropHandControl } from "./m-bluff-control";

describe("M8 Phase I M-Bluff controlled scenarios", () => {
  it("dropHand 私有選擇會在對手視角塌縮成同一 bucket，且 SO/MO 皆回合法決策", () => {
    const state = createDropHandPrivateChoiceState(benchmarkDb);
    const report = runMBluffDropHandControl(benchmarkDb, { iterations: 12 });

    expect(report.scenario).toBe("drop-hand-private-choice");
    expect(report.candidateLabels.length).toBeGreaterThanOrEqual(3);
    expect(report.opponentBuckets).toHaveLength(1);
    expect(report.opponentBuckets[0]!.labels.length).toBeGreaterThanOrEqual(3);

    for (const result of report.results) {
      expect(result.opponentBucketSize).toBeGreaterThanOrEqual(3);
      expect(result.privateDiscardCost).not.toBeNull();
      expect(() => applyDecision(benchmarkDb, state, result.bestDecision)).not.toThrow();
    }
  });
});
