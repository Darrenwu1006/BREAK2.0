// [Claude 2026-07-24] 候選 B 塊 1：policy registry ＋ builder 單元測試。
// 把「每個 policy → 產出的 options」逐條鎖死——這是舊 if-chain 過去無法被獨立驗證的映射。
import { describe, expect, it } from "vitest";
import {
  POLICIES,
  buildIsmctsOptions,
  buildMoOptions,
  buildPimcOptions,
  resolveRunContext,
  type BenchmarkPolicyId,
  type BenchmarkRunContext,
  type PolicyBuildCommon,
} from "./benchmark-policies";
import type { ValueModel } from "./rollout-value";

const MODEL_A = { id: "model-a" } as unknown as ValueModel;
const MODEL_B = { id: "model-b" } as unknown as ValueModel;

const ctx: BenchmarkRunContext = {
  iterations: 111,
  timeLimitMs: 222,
  explorationC: 1.5,
  candidateLimit: 6,
  leafRolloutHorizon: 40,
  sampleCount: 4,
  rolloutMaxSteps: 1400,
  valueCutHorizon: 40,
  pressureShapingEpsilon: 0.05,
  rootPressureTieBreakDelta: 0.04,
  rootConservationWinRateThreshold: 0.85,
  valueModel: MODEL_A,
};

const common: PolicyBuildCommon = { perspectivePlayer: 1, rolloutPolicy: "heuristic-v2" };

const ism = (id: BenchmarkPolicyId) => buildIsmctsOptions(POLICIES[id], ctx, common);

describe("policy registry — ismcts 系身份映射", () => {
  it("is-mcts base：無 tie-break／無 valueModel／fixes 開", () => {
    expect(ism("is-mcts")).toMatchObject({
      pressureShapingEpsilon: 0,
      rootPressureTieBreakDelta: 0,
      rootPairQualityTieBreak: false,
      rootConservationWinRateThreshold: 0.85,
      valueModel: undefined,
      defenseSkillEffectScoring: true,
      defenseChoiceSurvivalTieBreak: true,
      iterations: 111,
      timeLimitMs: 222,
      candidateLimit: 6,
    });
  });

  it("is-mcts-h2：只開 pressure shaping epsilon", () => {
    expect(ism("is-mcts-h2")).toMatchObject({ pressureShapingEpsilon: 0.05, rootPressureTieBreakDelta: 0 });
  });

  it("is-mcts-h2b：開 tie-break delta，pair 不開", () => {
    expect(ism("is-mcts-h2b")).toMatchObject({ rootPressureTieBreakDelta: 0.04, rootPairQualityTieBreak: false, pressureShapingEpsilon: 0 });
  });

  it("is-mcts-h2c：tie-break delta ＋ pair quality", () => {
    expect(ism("is-mcts-h2c")).toMatchObject({ rootPressureTieBreakDelta: 0.04, rootPairQualityTieBreak: true, valueModel: undefined });
  });

  it("is-mcts-h3：只吃 valueModel，無 tie-break", () => {
    expect(ism("is-mcts-h3")).toMatchObject({ valueModel: MODEL_A, rootPressureTieBreakDelta: 0, rootPairQualityTieBreak: false });
  });

  it("is-mcts-h4：valueModel ＋ tie-break ＋ pair", () => {
    expect(ism("is-mcts-h4")).toMatchObject({ valueModel: MODEL_A, rootPressureTieBreakDelta: 0.04, rootPairQualityTieBreak: true, defenseSkillEffectScoring: true });
  });

  it("is-mcts-k2：結構同 h4，差異全靠 per-policy 注入（override map 只作用於 k2）", () => {
    const base: BenchmarkRunContext = { rootPressureTieBreakDelta: 0.04, valueModel: MODEL_A };
    const byPolicy = { "is-mcts-k2": { valueModel: MODEL_B, rootPressureTieBreakDelta: 0.09 } };
    const k2 = buildIsmctsOptions(POLICIES["is-mcts-k2"], resolveRunContext("is-mcts-k2", base, byPolicy), common);
    expect(k2).toMatchObject({ valueModel: MODEL_B, rootPressureTieBreakDelta: 0.09, rootPairQualityTieBreak: true });
    // 同一 base／byPolicy 下 h4 不受 k2 override 影響，仍拿 base 的 model 與 delta。
    const h4 = buildIsmctsOptions(POLICIES["is-mcts-h4"], resolveRunContext("is-mcts-h4", base, byPolicy), common);
    expect(h4).toMatchObject({ valueModel: MODEL_A, rootPressureTieBreakDelta: 0.04 });
  });

  it("is-mcts-nofix：fixes 兩旗標關（A/B baseline），其餘同 h4", () => {
    expect(ism("is-mcts-nofix")).toMatchObject({
      defenseSkillEffectScoring: false,
      defenseChoiceSurvivalTieBreak: false,
      rootPressureTieBreakDelta: 0.04,
      rootPairQualityTieBreak: true,
      valueModel: MODEL_A,
    });
  });
});

describe("policy registry — pimc／mo／heuristic", () => {
  it("pimc：無 EV cut；pimc-v2：吃 valueCutHorizon", () => {
    expect(buildPimcOptions(POLICIES["pimc"], ctx, common)).toMatchObject({ valueCutHorizon: undefined, sampleCount: 4, rolloutMaxSteps: 1400 });
    expect(buildPimcOptions(POLICIES["pimc-v2"], ctx, common)).toMatchObject({ valueCutHorizon: 40 });
  });

  it("mo-ismcts：無 valueModel；mo-ismcts-h3：吃 valueModel", () => {
    expect(buildMoOptions(POLICIES["mo-ismcts"], ctx, common)).toMatchObject({ valueModel: undefined, iterations: 111 });
    expect(buildMoOptions(POLICIES["mo-ismcts-h3"], ctx, common)).toMatchObject({ valueModel: MODEL_A });
  });

  it("heuristic-v2 固定 profile 由 HEURISTIC_V2_PROFILES 生成；personality 走 deckAxes", () => {
    expect(POLICIES["heuristic-v2-serve"]).toEqual({ engine: "heuristic-v2", heuristicProfile: "heuristic-v2-serve" });
    expect(POLICIES["heuristic-v2-personality"]).toEqual({ engine: "heuristic-v2", profileFromDeckAxes: true });
  });

  it("random／heuristic-v1 各一筆", () => {
    expect(POLICIES["random"]).toEqual({ engine: "random" });
    expect(POLICIES["heuristic-v1"]).toEqual({ engine: "heuristic-v1" });
  });
});

describe("policy registry — 完整性", () => {
  it("每個 BenchmarkPolicyId 都有 def（無漏）", () => {
    const ids: BenchmarkPolicyId[] = [
      "random", "heuristic-v1", "pimc", "pimc-v2",
      "is-mcts", "is-mcts-h2", "is-mcts-h2b", "is-mcts-h2c", "is-mcts-h3", "is-mcts-h4", "is-mcts-k2", "is-mcts-nofix",
      "mo-ismcts", "mo-ismcts-h3",
      "heuristic-v2", "heuristic-v2-safe", "heuristic-v2-aggressive", "heuristic-v2-serve",
      "heuristic-v2-block", "heuristic-v2-burst", "heuristic-v2-defense", "heuristic-v2-hybrid", "heuristic-v2-personality",
    ];
    for (const id of ids) {
      expect(POLICIES[id], id).toBeDefined();
      expect(POLICIES[id].engine, id).toBeTruthy();
    }
  });
});
