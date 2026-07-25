// [Claude 2026-07-24] 候選 B：benchmark policy 從「id union + if-chain + 全域旋鈕」變成值。
// 每個 policy＝一筆宣告式資料（PolicyDef）：engine ＋ 身份旗標（epsilon/deltas/pairQuality/fixes/valueCut…）。
// 「這次跑批用多少預算、注入哪個候選 value model」不屬 policy 身份——由 BenchmarkRunContext 參數傳入。
// benchmarkPolicyDecision 因此變成「查表 → build options → switch(engine)」單一路徑，無任何 policy id 字串比對。
//
// 塊 1（本次）：僅把 dispatch 改成查表＋純 builder；benchmark.ts 暫以 shim 從既有全域組出 runCtx，行為不變。
// 塊 2：runCtx 顯式串過 config→match→decision、遷移工具、移除全域，並收掉 k2* 雙欄（見下方 TODO 標記）。

import type { PlayerId } from "../engine/types";
import type { HeuristicV2ProfileId } from "./heuristic";
import { HEURISTIC_V2_PROFILES } from "./heuristic";
import type { IsmctsOptions } from "./ismcts";
import type { PimcCoachOptions } from "./coach";
import type { MoIsmctsOptions } from "./mo-ismcts";
import type { ValueModel } from "./rollout-value";

export type BenchmarkPolicyId =
  | "random"
  | "heuristic-v1"
  | "pimc"
  | "pimc-v2"
  | "is-mcts"
  | "is-mcts-h2"
  | "is-mcts-h2b"
  | "is-mcts-h2c"
  | "is-mcts-h3"
  | "is-mcts-h4"
  | "is-mcts-k2"
  | "is-mcts-nofix"
  | "mo-ismcts"
  | "mo-ismcts-h3"
  | HeuristicV2ProfileId;

export type PolicyEngine = "random" | "heuristic-v1" | "heuristic-v2" | "pimc" | "ismcts" | "mo-ismcts";

/** ismcts／mo 系的身份旗標——決定「這個 policy 是什麼」，與預算無關。 */
export interface IsmctsIdentity {
  /** H2：leaf value 加入公開壓制力 shaping（epsilon 值由 runCtx 帶入）。 */
  pressureShaping?: boolean;
  /** H2B/H2C/H4/K2/nofix：root 最終選手 tie-break（delta 值由 runCtx 帶入；delta=0＝關）。 */
  rootPressureTieBreak?: boolean;
  /** H2C/H4/K2/nofix：root tie-break 的拖球候選改看配對品質。 */
  rootPairQualityTieBreak?: boolean;
  /** 除 nofix 外皆 on：防守 effect-confirm 評分（Fix B+）＋ defense-choice 生存 tie-break（Fix D1）。 */
  fixes?: boolean;
}

export interface PolicyDef {
  engine: PolicyEngine;
  /** heuristic-v2 固定 profile。 */
  heuristicProfile?: HeuristicV2ProfileId;
  /** heuristic-v2-personality：執行期由 deckAxes 推 profile。 */
  profileFromDeckAxes?: boolean;
  /** ismcts/mo：是否吃 runCtx 注入的候選 value model（不傳＝沿用 live model）。 */
  needsValueModel?: boolean;
  /** ismcts/mo 身份旗標。 */
  ismcts?: IsmctsIdentity;
  /** pimc-v2：載 S1 EV cut（horizon 值由 runCtx 帶入）。 */
  pimcValueCut?: boolean;
}

/**
 * 每次跑批決定的預算＋注入模型——不屬 policy 身份，per-policy 由 config 的 override map 帶入。
 * deltas/epsilon/threshold 屬 policy 身份（見 PolicyDef.ismcts），但其「數值」仍由此帶入，
 * 使 sweep 類工具能覆寫；is-mcts base（rootPressureTieBreak=false）不受 delta 值影響（一律 0）。
 * [Claude 2026-07-24] 塊 2：k2 雙欄已收掉——k2 與 h4 結構相同，差異全靠 per-policy 注入的 valueModel/delta/threshold。
 */
export interface BenchmarkRunContext {
  // ismcts／mo 預算
  iterations?: number;
  explorationC?: number;
  leafRolloutHorizon?: number;
  // 共用預算
  timeLimitMs?: number;
  candidateLimit?: number;
  // pimc 預算
  sampleCount?: number;
  rolloutMaxSteps?: number;
  valueCutHorizon?: number;
  // 身份旗標的數值（有 live 預設，sweep 工具可覆寫）
  pressureShapingEpsilon?: number;
  rootPressureTieBreakDelta?: number;
  rootConservationWinRateThreshold?: number;
  // 執行期注入的候選 value model
  valueModel?: ValueModel;
}

// heuristic-v2 系：不手寫，由既有 HEURISTIC_V2_PROFILES 生成。personality 走 profileFromDeckAxes，其餘吃固定 profile。
const heuristicV2ProfileEntries = Object.fromEntries(
  (Object.keys(HEURISTIC_V2_PROFILES) as HeuristicV2ProfileId[]).map((id): [HeuristicV2ProfileId, PolicyDef] => [
    id,
    id === "heuristic-v2-personality"
      ? { engine: "heuristic-v2", profileFromDeckAxes: true }
      : { engine: "heuristic-v2", heuristicProfile: id },
  ]),
) as Record<HeuristicV2ProfileId, PolicyDef>;

export const POLICIES: Record<BenchmarkPolicyId, PolicyDef> = {
  random: { engine: "random" },
  "heuristic-v1": { engine: "heuristic-v1" },
  pimc: { engine: "pimc" },
  "pimc-v2": { engine: "pimc", pimcValueCut: true },
  "is-mcts": { engine: "ismcts", ismcts: { fixes: true } },
  "is-mcts-h2": { engine: "ismcts", ismcts: { pressureShaping: true, fixes: true } },
  "is-mcts-h2b": { engine: "ismcts", ismcts: { rootPressureTieBreak: true, fixes: true } },
  "is-mcts-h2c": { engine: "ismcts", ismcts: { rootPressureTieBreak: true, rootPairQualityTieBreak: true, fixes: true } },
  "is-mcts-h3": { engine: "ismcts", needsValueModel: true, ismcts: { fixes: true } },
  "is-mcts-h4": { engine: "ismcts", needsValueModel: true, ismcts: { rootPressureTieBreak: true, rootPairQualityTieBreak: true, fixes: true } },
  // [Claude 2026-07-24] 塊 2：k2 與 h4 結構相同（差異全在 per-policy 注入的 model/delta/threshold），不再有 k2Tuning 旗標。
  "is-mcts-k2": { engine: "ismcts", needsValueModel: true, ismcts: { rootPressureTieBreak: true, rootPairQualityTieBreak: true, fixes: true } },
  "is-mcts-nofix": { engine: "ismcts", needsValueModel: true, ismcts: { rootPressureTieBreak: true, rootPairQualityTieBreak: true, fixes: false } },
  "mo-ismcts": { engine: "mo-ismcts" },
  "mo-ismcts-h3": { engine: "mo-ismcts", needsValueModel: true },
  ...heuristicV2ProfileEntries,
};

/**
 * 預算與旗標數值的預設值（原 DEFAULT_PIMC/ISMCTS_BENCHMARK_CONFIG 合併）。
 * 呼叫端只需覆寫要改的欄位（通常 timeLimitMs／iterations／sampleCount），其餘用此預設。
 */
export const DEFAULT_BENCHMARK_RUN_CONTEXT: Required<Omit<BenchmarkRunContext, "timeLimitMs" | "valueModel">> = {
  iterations: 1_000_000,
  explorationC: Math.SQRT2,
  leafRolloutHorizon: 40,
  candidateLimit: 8,
  sampleCount: 8,
  rolloutMaxSteps: 600,
  valueCutHorizon: 40,
  pressureShapingEpsilon: 0.05,
  rootPressureTieBreakDelta: 0.04,
  rootConservationWinRateThreshold: 0.85,
};

/** base ＋ per-policy override map → 該 policy 的完整 runCtx（預設補齊）。 */
export function resolveRunContext(
  policy: BenchmarkPolicyId,
  base?: BenchmarkRunContext,
  byPolicy?: Partial<Record<BenchmarkPolicyId, BenchmarkRunContext>>,
): BenchmarkRunContext {
  return { ...DEFAULT_BENCHMARK_RUN_CONTEXT, ...base, ...byPolicy?.[policy] };
}

export interface PolicyBuildCommon {
  perspectivePlayer: PlayerId;
  knownDecks?: readonly [readonly string[], readonly string[]];
  rolloutPolicy?: HeuristicV2ProfileId;
}

export function buildIsmctsOptions(def: PolicyDef, ctx: BenchmarkRunContext, common: PolicyBuildCommon): IsmctsOptions {
  const id = def.ismcts ?? {};
  return {
    perspectivePlayer: common.perspectivePlayer,
    knownDecks: common.knownDecks,
    iterations: ctx.iterations,
    timeLimitMs: ctx.timeLimitMs,
    explorationC: ctx.explorationC,
    candidateLimit: ctx.candidateLimit,
    leafRolloutHorizon: ctx.leafRolloutHorizon,
    pressureShapingEpsilon: id.pressureShaping ? ctx.pressureShapingEpsilon ?? 0 : 0,
    rootPressureTieBreakDelta: id.rootPressureTieBreak ? ctx.rootPressureTieBreakDelta : 0,
    rootPairQualityTieBreak: !!id.rootPairQualityTieBreak,
    rootConservationWinRateThreshold: ctx.rootConservationWinRateThreshold,
    valueModel: def.needsValueModel ? ctx.valueModel : undefined,
    defenseSkillEffectScoring: !!id.fixes,
    defenseChoiceSurvivalTieBreak: !!id.fixes,
    rolloutPolicy: common.rolloutPolicy,
  };
}

export function buildPimcOptions(def: PolicyDef, ctx: BenchmarkRunContext, common: PolicyBuildCommon): PimcCoachOptions {
  return {
    perspectivePlayer: common.perspectivePlayer,
    knownDecks: common.knownDecks,
    sampleCount: ctx.sampleCount,
    rolloutMaxSteps: ctx.rolloutMaxSteps,
    candidateLimit: ctx.candidateLimit,
    timeLimitMs: ctx.timeLimitMs,
    rolloutPolicy: common.rolloutPolicy,
    valueCutHorizon: def.pimcValueCut ? ctx.valueCutHorizon : undefined,
  };
}

export function buildMoOptions(def: PolicyDef, ctx: BenchmarkRunContext, common: PolicyBuildCommon): MoIsmctsOptions {
  return {
    perspectivePlayer: common.perspectivePlayer,
    knownDecks: common.knownDecks,
    iterations: ctx.iterations,
    timeLimitMs: ctx.timeLimitMs,
    explorationC: ctx.explorationC,
    candidateLimit: ctx.candidateLimit,
    leafRolloutHorizon: ctx.leafRolloutHorizon,
    rolloutPolicy: common.rolloutPolicy,
    valueModel: def.needsValueModel ? ctx.valueModel : undefined,
  };
}
