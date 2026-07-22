import { applyDecision, deployableUids, effParam, freeOptions } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { heuristicAiDecision, isImmediateOneTouchBlocker } from "./heuristic";
import type { HeuristicV2ProfileId } from "./heuristic";
import {
  decisionLabel,
  determinizeHiddenState,
  enumerateCandidates,
  inferKnownDecks,
  type CoachActionEstimate,
  type CoachReport,
} from "./coach";
import { evaluatePressureScore, evaluateShapedStateValue, explainValue, handDeployablePower, type ValueModel } from "./rollout-value";
import type { KnownDecks } from "./remaining-pool";
import { pickDeployName } from "./util";

/**
 * [Claude 2026-06-23] Phase G — SO-ISMCTS（單觀察者資訊集 Monte-Carlo 樹搜尋）。
 *
 * 定位（見 docs/M8_PHASE_G_ISMCTS_SPEC.md）：修正 PIMC 的兩個結構弱點——
 *   W1 strategy fusion（逐 determinization 獨立解再平均＝高估隱藏資訊價值）：
 *       本演算法以「資訊集級統計」消解——同一 action 序列跨 world 共享 visits/valueSum。
 *   W2 1-ply＋被動 heuristic 對手：以樹內多步前瞻＋對手節點 decoupled minimize-root-value（樹內對抗）取代。
 *
 * 四個不可省的正確性要點（違反就不是 SO-ISMCTS）：
 *   1. 每 iteration 一次 root determinize（determinization 吸收所有隨機性，不需 chance 節點）。
 *   2. 資訊集級統計：節點 key＝從 root 到此的 action 序列（edge＝JSON.stringify(decision)）。
 *   3. availability-based UCB：探索項分子用「該 action 在此節點被合法過的次數」，非 node.visits。
 *   4. 對手節點 exploit 取 (1 − mean)＝minimize root value（樹內對抗）。
 *
 * leaf evaluation＝方案 A：純 `evaluateStateValue`（Phase F S1 凍結 logistic，AUC 0.81），不另跑 rollout。
 * 公平性：所有 world 由 `determinizeHiddenState` 抽樣（canonical sort + 從 knownDecks 多重集重建），
 *   不依賴對手隱藏區真實排列；leaf eval 只讀公開 scalar。詳見 ismcts.test.ts 的 leakage hard gate。
 */

export interface IsmctsOptions {
  perspectivePlayer?: PlayerId;
  knownDecks?: readonly [readonly string[], readonly string[]];
  /** 無 deadline 時的硬迭代上限（測試用，確保 determinism）。 */
  iterations?: number;
  /** wall-clock 預算（上線/benchmark 用，與 PIMC 同時間基準 A/B）。 */
  timeLimitMs?: number;
  /** UCB 探索常數，預設 √2。 */
  explorationC?: number;
  /** 每節點候選寬度（沿用 PIMC 的 8）。 */
  candidateLimit?: number;
  /** enumerate fallback 用的 heuristic profile（也是 leaf 方案 B 的 rollout policy）。 */
  rolloutPolicy?: HeuristicV2ProfileId;
  /**
   * [Claude 2026-06-23] leaf evaluation 方案切換：
   *   0（預設＝方案 A）：leaf 純 evaluateStateValue。
   *   >0（方案 B）：leaf 先跑 heuristic rollout 到此 horizon（或終局）再 V——注入 PIMC 式多步前瞻，
   *   解「淺樹 leaf-V≈當前盤面、無法區分候選」的弱點。每 iteration 更貴，故為 G3 條件項。
   */
  leafRolloutHorizon?: number;
  /**
   * [Codex 2026-06-29] Phase H H2：leaf value 加入極小的公開壓制力 shaping。
   * 預設 0（off），待行為閘＋強度守門閘 A/B PASS 後才可 default-on。
   */
  pressureShapingEpsilon?: number;
  /** [Codex 2026-06-30] Phase H H3：benchmark-only 候選 value model，不傳則沿用 live model。 */
  valueModel?: ValueModel;
  /**
   * [Codex 2026-07-01] Phase H H4：root 最終選手 tie-break。
   * 預設 0.04（live SO default-on）；benchmark baseline 會顯式傳 0 以保留舊 SO 對照。
   * >0 時，只在候選 winRate 距 robust best 不超過此 delta 時，用公開壓制力／攻擊點數品質打破平手。
   */
  rootPressureTieBreakDelta?: number;
  /**
   * [Codex 2026-07-01] Phase H H4：root tie-break 的拖球候選改看「拖球＋後續最佳攻擊」組合品質。
   * 預設 true（live SO default-on）；只在 rootPressureTieBreakDelta 開啟時生效。
   */
  rootPairQualityTieBreak?: boolean;
  /**
   * [Claude 2026-07-02] Phase H H5 v2：certainty-conditioned 資源節省 tie-break。**已 default-on**
   * （見 DEFAULT_ROOT_CONSERVATION_WIN_RATE_THRESHOLD，[使用者 2026-07-02] 拍板上線）。H4 的 tie-break
   * 方向固定「近似平手→偏高壓制力」，這是修「該打滿卻沒打滿（放水）」的正解；但當 robust best 的
   * winRate 已達 ≥ 此門檻（贏面已近乎確定，非只是分不出高低），同一個「偏壓制力」方向會反過來逼出
   * 「贏定了還硬用不需要的強牌」——用真實構造盤面驗證過（rich 該升級用強牌 vs poor 用弱牌就夠贏，SO
   * 在 poor 側 0/5 全錯，見 WORKLOG 2026-07-01「在乾淨場景上實測 SO/MO」）。
   *
   * **v1（僅比 rootDecisionPressureScore 整條複合分數、套用到所有決策類型）已於 2026-07-02 40 場
   * ship-gate no-go 兩輪**（threshold 0.85/0.95 皆敗）。根因＝該複合分數混了防守/手牌等無關維度，且對
   * deploy-toss(pairAware) 反轉方向在數學上等同「刻意選較差的拖攻配對」。**v2 把作用範圍限縮到唯一
   * 語意清楚、也是單元測試唯一驗證過的情境：deploy-attack 本身的 attack 點數花費**——達門檻時只在
   * deploy-attack 的「近似平手」候選集裡改選「攻擊點數花最少」者，其餘決策類型（deploy-toss／
   * deploy-serve／deploy-receive／deploy-block／effect-confirm 等）一律回退 H4 原行為，不受影響。
   * 未達門檻（贏面仍有不確定性）同樣維持 H4 原方向。確定性訊號來自 MCTS 自身跨 determinize 樣本聚合
   * 出的 winRate，不是外部硬規則——這是「靠搜尋自己的信心分辨確定性」而非硬性規定省牌。只在
   * rootPressureTieBreakDelta 開啟時生效。**v2 兩輪獨立 40 場 mirror A/B（通用原型池 57.5%、使用者
   * 指定常用牌組 55.0%，合併 80 場 56.2%／95% CI 45.3–66.6%）**驗證通過使用者評估、正式上線。詳見
   * WORKLOG 2026-07-02、`docs/M8_PHASE_H_PLAY_QUALITY_SPEC.md` §7.3。
   */
  rootConservationWinRateThreshold?: number;
  /**
   * [Codex 2026-07-03] Phase J J4b：robust child 的 visits 領先已大到剩餘 iteration
   * 全給 second-best 也追不上時，提前收斂。預設開啟；測試/診斷可關閉做 A/B。
   */
  enableConvergenceEarlyStop?: boolean;
  /**
   * [Claude 2026-07-22] Fix B+：防守 effect-confirm 改「評估效果」（Guts 成本＋手牌攻擊潛力）而非「開技能動作」。
   * 預設 true（live default-on）；benchmark baseline 傳 false 保留舊 flat ±0.05 行為做 A/B。
   */
  defenseSkillEffectScoring?: boolean;
  /**
   * [Claude 2026-07-22] Fix D（D1）：defense-choice 生存優先 tie-break（能通過當前 OP 的 lane 不被壓力反轉）。
   * 預設 true（live default-on）；benchmark baseline 傳 false 保留舊行為做 A/B。
   */
  defenseChoiceSurvivalTieBreak?: boolean;
  /**
   * [Claude 2026-06-23] 對手節點模型（G2 診斷後新增）：
   *   "heuristic"（預設）：對手節點 = 環境，直接套用 heuristic 決策、不建樹分支。
   *     ＝資訊集樹只在「我方多步決策」上展開，對手/隱藏由 determinize＋heuristic 模擬。
   *     對「固定 heuristic 對手池」是正解：消 strategy fusion（W1）＋我方多步前瞻，
   *     不引入 adversarial 的過度悲觀（實測 adversarial 會誤判「主動 Lost ≥ 正常打」）。
   *   "adversarial"：對手節點用 decoupled minimize-root-value（樹內對抗）。
   *     僅當對手本身會搜尋/對抗時才正確；對固定 heuristic 對手有害（見 WORKLOG 2026-06-23 G2 診斷）。
   */
  opponentModel?: "heuristic" | "adversarial";
  seed?: number;
}

const DEFAULT_ITERATIONS = 800;
const DEFAULT_EXPLORATION_C = Math.SQRT2;
const DEFAULT_CANDIDATE_LIMIT = 8;
const DEFAULT_ROOT_PRESSURE_TIE_BREAK_DELTA = 0.04;
const DEFAULT_ROOT_PAIR_QUALITY_TIE_BREAK = true;
/**
 * [Claude 2026-07-02] Phase H H5 v2 live default（[使用者 2026-07-02] 拍板上線）。
 * 兩輪 40 場獨立 mirror A/B（通用 5 原型池 57.5%／使用者 5 副常用牌組池 55.0%）合併 80 場＝
 * candidate 45/80＝56.2%（95% Wilson CI 45.3%–66.6%）。嚴格說 CI 下界未過 50%，但兩輪獨立複製一致、
 * 與 v1（40 場兩輪皆全面下滑，37.5%／40.0%）模式完全相反、根因機制已確認（限縮只作用於
 * deploy-attack），判斷已足夠降低不確定性，使用者拍板上線。詳見 WORKLOG 2026-07-02。
 */
const DEFAULT_ROOT_CONSERVATION_WIN_RATE_THRESHOLD = 0.85;
const ROOT_TIE_BREAK_MIN_VISIT_RATIO = 0.5;
/** 每 iteration 換 world 的 seed 間距（大質數，避免抽樣相關）。 */
const SEED_STRIDE = 1000003;
/**
 * [Claude 2026-07-22] Fix B+：防守技能確認改「評估效果」而非「開技能動作」的權重。
 * 量級刻意對齊舊 flat bonus（0.05）並 clamp 在壓力分數 [-0.1,0.1] 的 gradient 帶內，
 * 只在 root close-set tie-break 生效，不翻轉明確勝負判斷。實際係數待 40 場級 A/B 校準。
 */
const DEFENSE_SKILL_GUTS_COST_WEIGHT = 0.02; // 每 1 點 Guts 成本的扣分（evaluatePressureScore 完全不計 Guts）
const DEFENSE_SKILL_HAND_GAIN_WEIGHT = 0.004; // 每 1 點手牌可用攻擊潛力增益的加分（補手牌湊攻擊鏈）
const DEFENSE_SKILL_EFFECT_CLAMP = 0.08; // 效果分數上下限
/** [Claude 2026-07-22] Fix D（D1）：defense-choice 生存 playout 的步數上限（防呆，正常 2~4 步就結算）。 */
const DEFENSE_SURVIVAL_MAX_STEPS = 16;

interface IsmctsNode {
  /** edgeKey → 子節點。edgeKey＝JSON.stringify(decision)（資訊集級 key）。 */
  children: Map<string, IsmctsNode>;
  /** edgeKey → 該 action 在此節點「被合法（可用）」過的 iteration 累計（availability-UCB 分子）。 */
  availability: Map<string, number>;
  /** 此節點「進入邊」的累計訪問與 root-perspective value 總和（統計掛在子節點上）。 */
  visits: number;
  valueSum: number;
}

function newNode(): IsmctsNode {
  return { children: new Map(), availability: new Map(), visits: 0, valueSum: 0 };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 與 coach.confidenceFrom 同式，但直接吃勝率 p（IS-MCTS 的 value 連續，不另算 wins）。 */
function confidenceFromRate(samples: number, p: number): number {
  if (samples <= 0) return 0;
  const z = 1.96;
  const denom = 1 + (z * z) / samples;
  const center = p + (z * z) / (2 * samples);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * samples)) / samples);
  const low = Math.max(0, (center - margin) / denom);
  const high = Math.min(1, (center + margin) / denom);
  const widthScore = 1 - (high - low);
  const sampleScore = Math.sqrt(samples / (samples + 12));
  return clamp01(widthScore * sampleScore);
}

/**
 * decoupled、availability-based、root-perspective UCB（本演算法正確性核心）。
 * - mean 永遠是 root-perspective 勝率；對手節點 exploit 取 (1 − mean)＝樹內對抗（minimize root value）。
 * - 探索項分子用 `availability`（該 action 在此節點被合法過的次數），**不是** node.visits——
 *   因為不同 world 的合法集是不同子集，用 node.visits 會系統性高/低估「只在部分 world 合法」的 action。
 */
export function ucbScore(
  childVisits: number,
  childValueSum: number,
  availability: number,
  isMyNode: boolean,
  explorationC: number,
): number {
  const mean = childValueSum / childVisits;
  const exploit = isMyNode ? mean : 1 - mean;
  const explore = explorationC * Math.sqrt(Math.log(Math.max(1, availability)) / childVisits);
  return exploit + explore;
}

/**
 * Leaf evaluation：方案 A（horizon=0）＝純 V；方案 B（horizon>0）＝先 heuristic rollout 到 horizon／終局再 V。
 * 方案 B 注入多步前瞻，補足淺樹下 leaf-V 區分力不足（PIMC 靠 40 步 rollout 才有的訊號）。
 */
function leafEval(
  db: CardDb,
  cur: GameState,
  perspective: PlayerId,
  rolloutPolicy: HeuristicV2ProfileId,
  horizon: number,
  pressureShapingEpsilon: number,
  valueModel: ValueModel | undefined,
  knownDecks: KnownDecks | undefined,
): number {
  if (cur.phase === "gameOver") return cur.winner === perspective ? 1 : 0;
  if (horizon <= 0) return clamp01(evaluateShapedStateValue(db, cur, perspective, pressureShapingEpsilon, valueModel, knownDecks));
  let s = cur;
  for (let step = 0; step < horizon; step++) {
    if (s.phase === "gameOver") return s.winner === perspective ? 1 : 0;
    if (!s.pendingDecision) break;
    try {
      s = applyDecision(db, s, heuristicAiDecision(db, s, rolloutPolicy), { execMode: "search" });
    } catch {
      break;
    }
  }
  if (s.phase === "gameOver") return s.winner === perspective ? 1 : 0;
  return clamp01(evaluateShapedStateValue(db, s, perspective, pressureShapingEpsilon, valueModel, knownDecks));
}

interface LegalEntry {
  key: string;
  decision: Decision;
}

/** 列舉當前 world 的合法決策（重用 PIMC 的 enumerateCandidates，含 fallback 優先＋排序）。 */
function legalEntries(
  db: CardDb,
  cur: GameState,
  candidateLimit: number,
  rolloutPolicy: HeuristicV2ProfileId,
): LegalEntry[] {
  const fallback = heuristicAiDecision(db, cur, rolloutPolicy);
  const decisions = enumerateCandidates(db, cur, candidateLimit, fallback);
  return decisions.map((decision) => ({ key: JSON.stringify(decision), decision }));
}

function decisionWithDefaultNameChoice(db: CardDb, state: GameState, decision: Decision): Decision {
  const pd = state.pendingDecision;
  if (!pd) return decision;
  const p = pd.player as PlayerId;
  switch (decision.type) {
    case "deploy-serve":
      if (decision.uid === null || decision.nameChoice !== undefined) return decision;
      return { ...decision, nameChoice: pickDeployName(db, state, p, decision.uid, "serve") };
    case "deploy-receive":
      if (decision.uid === null || decision.nameChoice !== undefined) return decision;
      return { ...decision, nameChoice: pickDeployName(db, state, p, decision.uid, "receive") };
    case "deploy-toss":
      if (decision.uid === null || decision.nameChoice !== undefined) return decision;
      return { ...decision, nameChoice: pickDeployName(db, state, p, decision.uid, "toss") };
    case "deploy-attack":
      if (decision.uid === null || decision.nameChoice !== undefined) return decision;
      return { ...decision, nameChoice: pickDeployName(db, state, p, decision.uid, "attack") };
    default:
      return decision;
  }
}

function bestAttackPointAfterToss(db: CardDb, state: GameState, perspective: PlayerId, uid: number, nameChoice?: string): number {
  try {
    const afterToss = applyDecision(db, state, { type: "deploy-toss", uid, nameChoice });
    const legalAttacks = deployableUids(db, afterToss, perspective, "attack");
    if (legalAttacks.length === 0) return 0;
    return Math.max(...legalAttacks.map((attackUid) => effParam(db, afterToss, attackUid, "attack") ?? 0));
  } catch {
    return -Infinity;
  }
}

function tossAttackPairPoint(db: CardDb, state: GameState, perspective: PlayerId, uid: number, nameChoice?: string): number {
  const tossPoint = effParam(db, state, uid, "toss") ?? 0;
  const attackPoint = bestAttackPointAfterToss(db, state, perspective, uid, nameChoice);
  return Number.isFinite(attackPoint) ? tossPoint + attackPoint : -Infinity;
}

function bestLegalTossAttackPairPoint(db: CardDb, state: GameState, perspective: PlayerId): number {
  const legal = deployableUids(db, state, perspective, "toss");
  const values = legal
    .map((uid) => tossAttackPairPoint(db, state, perspective, uid, pickDeployName(db, state, perspective, uid, "toss")))
    .filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : 0;
}

/**
 * [Claude 2026-07-22] 是否處於「我方正在防守對手 OP」的決策點（block/receive phase、檯面 OP 屬對手）。
 * 與 benchmark.ts isDefensiveFreeStep 同語意；此處自帶一份避免跨模組相依。
 */
function isDefensiveDecisionStep(state: GameState, perspective: PlayerId): boolean {
  return (state.phase === "block" || state.phase === "receive") && !!state.op && state.op.owner !== perspective;
}

/** [Claude 2026-07-22] Fix B+：讀取當前 gate 宣告的 Guts 成本（靜態，不受效果子決策 pause 影響）。 */
function gateDeclaredGutsCost(state: GameState): number {
  const aw = state.effectCtx?.awaiting;
  if (!aw || aw.kind !== "confirm" || aw.what !== "gate" || !aw.costs) return 0;
  let guts = 0;
  for (const cost of aw.costs) {
    if (cost.type === "guts" || cost.type === "gutsAny" || cost.type === "gutsFrom") guts += cost.count;
  }
  return guts;
}

/**
 * [Claude 2026-07-22] Fix B+：防守技能確認的「效果」評分（取代舊的「開技能動作」flat bonus）。
 * evaluatePressureScore 本體已含手牌張數（抽牌↑補手牌、丟牌↓耗手牌），這裡只補它摸不到的兩維：
 *   ① Guts 成本（壓力分數完全不計 Guts）→ 付 Guts 換防守要有代價。
 *   ② 手牌可用攻擊潛力增益（抽到能打的牌）→ 補手牌湊攻擊鏈給正分。
 * 回傳＝「接受相對拒絕的淨效果分數」依 decision.accept 簽名；benefit>0 代表接受值得。
 * 「丟牌未來回收」屬多步策略，交給 MCTS 搜尋、不寫進 tie-break（[使用者 2026-07-22] 定案）。
 */
function defensiveConfirmEffectScore(
  db: CardDb,
  state: GameState,
  decision: Extract<Decision, { type: "effect-confirm" }>,
  perspective: PlayerId,
): number {
  const gutsCost = gateDeclaredGutsCost(state);
  let handGain = 0;
  try {
    const acceptState = applyDecision(db, state, { type: "effect-confirm", accept: true });
    const declineState = applyDecision(db, state, { type: "effect-confirm", accept: false });
    handGain =
      handDeployablePower(db, acceptState, acceptState.players[perspective]) -
      handDeployablePower(db, declineState, declineState.players[perspective]);
  } catch {
    handGain = 0;
  }
  const rawBenefit = handGain * DEFENSE_SKILL_HAND_GAIN_WEIGHT - gutsCost * DEFENSE_SKILL_GUTS_COST_WEIGHT;
  const benefit = Math.max(-DEFENSE_SKILL_EFFECT_CLAMP, Math.min(DEFENSE_SKILL_EFFECT_CLAMP, rawBenefit));
  return decision.accept ? benefit : -benefit;
}

export function rootDecisionPressureScore(
  db: CardDb,
  state: GameState,
  decision: Decision,
  perspective: PlayerId,
  options: { pairAware?: boolean; defenseSkillEffectScoring?: boolean } = {},
): number {
  let score = 0;
  try {
    const next = applyDecision(db, state, decisionWithDefaultNameChoice(db, state, decision));
    score += evaluatePressureScore(db, next, perspective);
  } catch {
    return -Infinity;
  }

  const pd = state.pendingDecision;
  if (!pd || pd.player !== perspective) return score;
  if (decision.type === "deploy-toss" && options.pairAware) {
    const legal = deployableUids(db, state, perspective, "toss");
    if (legal.length > 1) {
      const best = bestLegalTossAttackPairPoint(db, state, perspective);
      const chosen =
        decision.uid === null
          ? 0
          : tossAttackPairPoint(
              db,
              state,
              perspective,
              decision.uid,
              decision.nameChoice ?? pickDeployName(db, state, perspective, decision.uid, "toss"),
            );
      if (Number.isFinite(best) && Number.isFinite(chosen)) score += (chosen - best) / 10;
    }
  } else if (decision.type === "deploy-toss" || decision.type === "deploy-attack") {
    const area = decision.type === "deploy-toss" ? "toss" : "attack";
    const legal = deployableUids(db, state, perspective, area);
    if (legal.length > 1) {
      const best = Math.max(...legal.map((uid) => effParam(db, state, uid, area) ?? 0));
      const chosen = decision.uid === null ? 0 : effParam(db, state, decision.uid, area) ?? 0;
      score += (chosen - best) / 10;
    }
  }
  if (decision.type === "effect-confirm" && state.effectCtx?.desc.includes("技能")) {
    // [Claude 2026-07-22] Fix B+（診斷見 reports/27 §B、WORKLOG 2026-07-21）：舊的固定 ±0.05 評的是
    // 「開不開技能」這個動作，而非技能效果，導致基礎 DP 已足夠時仍付費過度加防（4pp close-set 內被
    // 0.10 差反轉）。防守決策點改用效果評分（Guts 成本＋手牌攻擊潛力）；攻擊側維持原積極性行為。
    if (options.defenseSkillEffectScoring !== false && isDefensiveDecisionStep(state, perspective)) {
      score += defensiveConfirmEffectScore(db, state, decision, perspective);
    } else {
      score += decision.accept ? 0.05 : -0.05;
    }
  }
  return score;
}

/**
 * [Claude 2026-07-19] 終局判定：這一手套用後是否「立即」輸掉 Set（宣告 Lost／不登場／注定失敗的
 * 防守判定）或整場比賽。applyDecision 失敗視同終局（與 rootDecisionPressureScore 的 -Infinity 同語意）。
 */
function decisionImmediatelyLosesSetOrMatch(
  db: CardDb,
  state: GameState,
  decision: Decision,
  perspective: PlayerId,
): boolean {
  try {
    const next = applyDecision(db, state, decisionWithDefaultNameChoice(db, state, decision));
    if (next.winner !== null) return next.winner !== perspective;
    if (next.lostBy === perspective && state.lostBy !== perspective) return true;
    return next.players[perspective].setArea.length < state.players[perspective].setArea.length;
  } catch {
    return true;
  }
}

/**
 * [Claude 2026-07-22] Fix D（D1，診斷見 reports/27 §D、WORKLOG 2026-07-21）：這條 defense-choice lane
 * 是否「能通過當前這次 OP 判定」。單步 decisionImmediatelyLosesSetOrMatch 看不到「選了接球 lane、兩步後
 * 才不登場 Lost」；此處用 heuristic 把該 lane 打到判定結算為止，直接看有沒有守下這球。
 *   FAILED ⟺ playout 中 lostBy 變成 perspective（judge 失敗會 declareLost）或直接被判負。
 *   PASSED ⟺ 未失分且離開防守 phase（block/receive/draw）＝這球守住了。
 * playout 用 heuristic（reports/27 實測 heuristic 在該盤面正確選攔網）；若 lane 其實守不住只會回 false
 * ＝不啟動 D1、退回原行為，不會惡化。
 */
function defenseChoiceSurvivesCurrentOp(
  db: CardDb,
  state: GameState,
  decision: Decision,
  perspective: PlayerId,
  rolloutPolicy?: HeuristicV2ProfileId,
): boolean {
  if (decision.type !== "defense-choice") return true;
  if (!state.op || state.op.owner === perspective) return true; // 無來襲 OP → 不適用
  const baseSetLen = state.players[perspective].setArea.length;
  try {
    let s = applyDecision(db, state, decision);
    for (let step = 0; step < DEFENSE_SURVIVAL_MAX_STEPS; step++) {
      if (s.winner !== null) return s.winner === perspective;
      if (s.lostBy === perspective) return false;
      if (s.players[perspective].setArea.length < baseSetLen) return false;
      // 已離開這次防守（judge 結算後 op 消滅、phase 前進）且未失分 → 守住了。
      if (s.phase !== "block" && s.phase !== "receive" && s.phase !== "draw") return true;
      const pd = s.pendingDecision;
      if (!pd) break;
      const next = heuristicAiDecision(db, s, rolloutPolicy);
      s = applyDecision(db, s, decisionWithDefaultNameChoice(db, s, next));
    }
  } catch {
    return false;
  }
  return false;
}

function chooseRootTieBreakBest(
  db: CardDb,
  state: GameState,
  recommendations: CoachActionEstimate[],
  perspective: PlayerId,
  winRateDelta: number,
  pairAware: boolean,
  conservationWinRateThreshold?: number,
  rolloutPolicy?: HeuristicV2ProfileId,
  defenseChoiceSurvivalTieBreak: boolean = true,
  defenseSkillEffectScoring: boolean = true,
): CoachActionEstimate | null {
  if (winRateDelta <= 0 || recommendations.length <= 1) return null;
  const robustBest = recommendations[0]!;
  const minVisits = Math.max(1, Math.floor(robustBest.sampleCount * ROOT_TIE_BREAK_MIN_VISIT_RATIO));
  let close = recommendations.filter(
    (item) => item.sampleCount >= minVisits && Math.abs(item.winRate - robustBest.winRate) <= winRateDelta,
  );
  if (close.length <= 1) return null;
  // [Claude 2026-07-19] AI 提前 Lost 窄修（診斷見 reports/26 與 WORKLOG 2026-07-19）：資源壓力分數會因
  // Lost／不登場保留手牌而偏高，曾把勝率落後的終局候選反轉成首選（Match 10 比賽點 Lost 0% 壓過福永
  // 3.99%）。邊界依報告定案：robust best 為非終局時，「立即輸掉 Set 或比賽」的候選不參與 tie-break；
  // robust best 本身就是終局（所有非終局候選等價失敗，或 MCTS 主動放 Set）時，完整保留原資源保全行為。
  if (!decisionImmediatelyLosesSetOrMatch(db, state, robustBest.decision, perspective)) {
    close = close.filter(
      (item) => item === robustBest || !decisionImmediatelyLosesSetOrMatch(db, state, item.decision, perspective),
    );
    if (close.length <= 1) return null;
  }
  // [Claude 2026-07-22] Fix D（D1）：defense-choice 生存優先。close-set 內若同時存在「能通過當前 OP 判定」
  // 與「不能通過」的 defense-choice lane，收斂到能生存的 lane——避免接球 lane 因抽牌 handDiff↑ 讓壓力
  // 分數反轉、選到兩步後才不登場 Lost 的放棄型防守（reports/27 §D 決勝局）。全員都守不住＝真的守不住
  // 這球，維持原行為（尊重 MCTS 放 Set／資源保全）。
  if (defenseChoiceSurvivalTieBreak && close.some((item) => item.decision.type === "defense-choice")) {
    const survivors = close.filter((item) =>
      defenseChoiceSurvivesCurrentOp(db, state, item.decision, perspective, rolloutPolicy),
    );
    if (survivors.length >= 1 && survivors.length < close.length) {
      close = survivors;
      // 唯一生存者：直接回傳促成它上位；不可回 null，否則會退回可能是放棄型的 robustBest。
      if (close.length <= 1) return close[0]!;
    }
  }
  const isOneTouchDeployment = (item: CoachActionEstimate): boolean =>
    item.decision.type === "deploy-block" &&
    item.decision.uids !== null &&
    item.decision.uids.some((uid) => isImmediateOneTouchBlocker(db, state, perspective, uid));
  // [Codex 2026-07-17] 若 robust best 是 One Touch 路線，近似勝率候選先比手牌成本。
  // 多張方案仍可保留，但必須超出 root delta（live 預設 4%）才能壓過單張方案。
  if (isOneTouchDeployment(robustBest)) {
    const oneTouchClose = close.filter(isOneTouchDeployment);
    if (oneTouchClose.length > 1) {
      return oneTouchClose
        .slice()
        .sort((a, b) => {
          const aDecision = a.decision as Extract<Decision, { type: "deploy-block" }>;
          const bDecision = b.decision as Extract<Decision, { type: "deploy-block" }>;
          const countDelta = (aDecision.uids?.length ?? Infinity) - (bDecision.uids?.length ?? Infinity);
          if (countDelta !== 0) return countDelta;
          const aCenterIsSource = aDecision.uids !== null && isImmediateOneTouchBlocker(db, state, perspective, aDecision.center) ? 1 : 0;
          const bCenterIsSource = bDecision.uids !== null && isImmediateOneTouchBlocker(db, state, perspective, bDecision.center) ? 1 : 0;
          return bCenterIsSource - aCenterIsSource || b.sampleCount - a.sampleCount || b.winRate - a.winRate;
        })[0]!;
    }
  }
  // [Claude 2026-07-02] Phase H H5 v2：贏面已近乎確定（robust best winRate 達門檻）時，「近似平手」的
  // deploy-attack 候選集裡改偏「用最少攻擊點數就夠贏」，把多餘資源留給未來——但**只對 deploy-attack
  // 生效**，且只比「這手實際花的攻擊點數」這一個乾淨維度，不碰 rootDecisionPressureScore。
  //
  // v1（ship-gate 40 場 x2 輪皆 no-go，見 WORKLOG 2026-07-02）錯在把整條 rootDecisionPressureScore
  // 複合分數（混了 opSigned／attackLineDiff／defensePressure／resourcePressure，還有 pairAware 的拖攻
  // 配對品質項）整條反轉、套用到**所有**決策類型——對 deploy-toss(pairAware) 而言，反轉配對品質項在
  // 數學上等同「刻意選較差的拖攻配對」；對 deploy-serve/receive/block/effect-confirm 等其他決策類型，
  // 「偏好較差的壓制力/局面」根本沒有「省資源」的語意，純粹是雜訊甚至傷害。v2 把作用範圍限縮到唯一
  // 語意清楚、也是單元測試唯一驗證過的情境：deploy-attack 本身的 attack 點數花費。
  const conservationActive =
    conservationWinRateThreshold !== undefined && robustBest.winRate >= conservationWinRateThreshold;
  if (conservationActive) {
    const attackClose = close.filter((item) => item.decision.type === "deploy-attack");
    if (attackClose.length > 1) {
      return attackClose
        .map((item) => ({
          item,
          spent: item.decision.type === "deploy-attack" && item.decision.uid !== null ? effParam(db, state, item.decision.uid, "attack") ?? 0 : 0,
        }))
        .sort((a, b) => a.spent - b.spent || b.item.sampleCount - a.item.sampleCount || b.item.winRate - a.item.winRate)[0]!.item;
    }
    // 非 deploy-attack（或只有 1 個可比候選）：conservation 不適用，回退 H4 原行為。
  }
  return close
    .map((item) => ({ item, pressure: rootDecisionPressureScore(db, state, item.decision, perspective, { pairAware, defenseSkillEffectScoring }) }))
    .sort((a, b) => b.pressure - a.pressure || b.item.sampleCount - a.item.sampleCount || b.item.winRate - a.item.winRate)[0]!.item;
}

/**
 * 一次 iteration：在 `world` 內跑 selection→expansion→leaf eval→backup，回傳 root-perspective value。
 */
function iterate(
  db: CardDb,
  root: IsmctsNode,
  world: GameState,
  perspective: PlayerId,
  explorationC: number,
  candidateLimit: number,
  rolloutPolicy: HeuristicV2ProfileId,
  leafRolloutHorizon: number,
  opponentModel: "heuristic" | "adversarial",
  pressureShapingEpsilon: number,
  valueModel: ValueModel | undefined,
  knownDecks: KnownDecks | undefined,
): number {
  let node = root;
  let cur = world;
  const path: Array<{ node: IsmctsNode; key: string }> = [];

  // ---- Selection + Expansion（合併迴圈：fully-expanded 就 UCB 選，否則展開一個未展開合法 action）----
  while (cur.phase !== "gameOver") {
    if (!cur.pendingDecision) break;
    // opponentModel="heuristic"：對手節點＝環境，直接套 heuristic、不建樹分支（樹只在我方決策展開）。
    if (cur.pendingDecision.player !== perspective && opponentModel === "heuristic") {
      try {
        cur = applyDecision(db, cur, heuristicAiDecision(db, cur, rolloutPolicy), { execMode: "search" });
      } catch {
        break;
      }
      continue;
    }
    const legal = legalEntries(db, cur, candidateLimit, rolloutPolicy);
    if (legal.length === 0) break; // 理論上 enumerate 至少回 fallback；保險

    // availability：所有「此 world 合法」的 action +1（availability-UCB 的分子來源）。
    for (const entry of legal) {
      node.availability.set(entry.key, (node.availability.get(entry.key) ?? 0) + 1);
    }

    const unexpanded = legal.filter((entry) => !node.children.has(entry.key));
    if (unexpanded.length > 0) {
      // ---- Expansion：取第一個未展開者（move-ordered＝enumerate 回傳序）----
      const chosen = unexpanded[0]!;
      const child = newNode();
      node.children.set(chosen.key, child);
      cur = applyDecision(db, cur, chosen.decision, { execMode: "search" });
      path.push({ node, key: chosen.key });
      node = child;
      break;
    }

    // ---- Selection：對 legal 全展開 → UCB（availability-based、對手節點 minimize root value）----
    const isMyNode = cur.pendingDecision?.player === perspective;
    let bestKey = legal[0]!.key;
    let bestDecision = legal[0]!.decision;
    let bestScore = -Infinity;
    for (const entry of legal) {
      const child = node.children.get(entry.key)!;
      const avail = node.availability.get(entry.key) ?? 1;
      const score = ucbScore(child.visits, child.valueSum, avail, isMyNode, explorationC);
      if (score > bestScore) {
        bestScore = score;
        bestKey = entry.key;
        bestDecision = entry.decision;
      }
    }
    cur = applyDecision(db, cur, bestDecision, { execMode: "search" });
    path.push({ node, key: bestKey });
    node = node.children.get(bestKey)!;
  }

  // ---- Leaf evaluation（方案 A＝純 V；方案 B＝淺 rollout 後 V）----
  const value = leafEval(db, cur, perspective, rolloutPolicy, leafRolloutHorizon, pressureShapingEpsilon, valueModel, knownDecks);

  // ---- Backup（統計掛在子節點：path 上每條 edge 的目標節點）----
  for (const step of path) {
    const child = step.node.children.get(step.key)!;
    child.visits++;
    child.valueSum += value;
  }
  return value;
}

function estimateFromChild(
  db: CardDb,
  state: GameState,
  decision: Decision,
  child: IsmctsNode,
): CoachActionEstimate {
  const winRate = child.visits === 0 ? 0 : child.valueSum / child.visits;
  const confidence = confidenceFromRate(child.visits, winRate);
  return {
    decision,
    label: decisionLabel(db, state, decision),
    winRate,
    confidence,
    sampleCount: child.visits,
    wins: Math.round(winRate * child.visits),
    errors: 0,
    maxSteps: 0,
    principalLine: [],
    explanation: `IS-MCTS：${child.visits} 次樹內訪問，估計勝率 ${Math.round(winRate * 100)}%（資訊集級統計，已消 PIMC 的策略融合高估）。`,
  };
}

function fallbackEstimate(db: CardDb, state: GameState, decision: Decision): CoachActionEstimate {
  return {
    decision,
    label: decisionLabel(db, state, decision),
    winRate: 0,
    confidence: 0,
    sampleCount: 0,
    wins: 0,
    errors: 0,
    maxSteps: 0,
    principalLine: [],
    explanation: "IS-MCTS：未完成任何 iteration，回傳 heuristic fallback。",
  };
}

function directEstimate(db: CardDb, state: GameState, decision: Decision, reason: string): CoachActionEstimate {
  return {
    decision,
    label: decisionLabel(db, state, decision),
    winRate: 0,
    confidence: 0,
    sampleCount: 0,
    wins: 0,
    errors: 0,
    maxSteps: 0,
    principalLine: [],
    explanation: `IS-MCTS：${reason}，依 Phase J J4 直接出手，未啟動搜尋。`,
  };
}

function directRootDecision(db: CardDb, state: GameState, rootLegal: readonly LegalEntry[]): { decision: Decision; reason: string } | null {
  if (rootLegal.length === 1) return { decision: rootLegal[0]!.decision, reason: "root 僅 1 個合法候選" };
  const pd = state.pendingDecision;
  if (pd?.type !== "free") return null;
  const opts = freeOptions(db, state);
  if (opts.skills.length > 0 || opts.events.length > 0) return null;
  const pass = rootLegal.find((entry) => entry.decision.type === "free" && entry.decision.action === "pass");
  return pass ? { decision: pass.decision, reason: "自由步驟無可宣告技能/事件，保留 Pass 節奏" } : null;
}

function estimatedRemainingIterations(iterationCap: number, completed: number, deadline: number, startedAt: number): number {
  const remainingByCap = Math.max(0, iterationCap - completed);
  if (!Number.isFinite(deadline)) return remainingByCap;
  if (completed <= 0) return remainingByCap;
  const now = Date.now();
  const remainingMs = Math.max(0, deadline - now);
  const elapsedMs = Math.max(1, now - startedAt);
  const projectedByTime = Math.floor((completed / elapsedMs) * remainingMs);
  return Math.min(remainingByCap, Math.max(0, projectedByTime));
}

function shouldStopForRootConvergence(root: IsmctsNode, rootLegal: readonly LegalEntry[], remainingIterations: number): boolean {
  if (rootLegal.length <= 1) return true;
  const visits = rootLegal
    .map((entry) => root.children.get(entry.key)?.visits ?? 0)
    .sort((a, b) => b - a);
  const best = visits[0] ?? 0;
  const second = visits[1] ?? 0;
  return best > second + Math.max(0, remainingIterations);
}

/**
 * SO-ISMCTS 主入口。刻意回 `CoachReport`，讓 coach-worker／benchmark／UI 取 `bestAction.decision` 零改動重用。
 */
export function createIsmctsReport(db: CardDb, state: GameState, options: IsmctsOptions = {}): CoachReport {
  const pd = state.pendingDecision;
  if (!pd) throw new Error("沒有待決策，無法產生 IS-MCTS 建議");
  const actingPlayer = pd.player as PlayerId;
  const perspective = options.perspectivePlayer ?? actingPlayer;
  if (perspective !== actingPlayer) {
    throw new Error("SO-ISMCTS 只支援目前決策玩家的視角");
  }

  const knownDecks = options.knownDecks ?? inferKnownDecks(state);
  const explorationC = options.explorationC ?? DEFAULT_EXPLORATION_C;
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const rolloutPolicy = options.rolloutPolicy ?? "heuristic-v2";
  const leafRolloutHorizon = Math.max(0, Math.floor(options.leafRolloutHorizon ?? 0));
  const opponentModel = options.opponentModel ?? "heuristic";
  const pressureShapingEpsilon = Math.max(0, options.pressureShapingEpsilon ?? 0);
  const valueModel = options.valueModel;
  const rootPressureTieBreakDelta = Math.max(0, options.rootPressureTieBreakDelta ?? DEFAULT_ROOT_PRESSURE_TIE_BREAK_DELTA);
  const rootPairQualityTieBreak = options.rootPairQualityTieBreak ?? DEFAULT_ROOT_PAIR_QUALITY_TIE_BREAK;
  const rootConservationWinRateThreshold = options.rootConservationWinRateThreshold ?? DEFAULT_ROOT_CONSERVATION_WIN_RATE_THRESHOLD;
  const defenseSkillEffectScoring = options.defenseSkillEffectScoring ?? true;
  const defenseChoiceSurvivalTieBreak = options.defenseChoiceSurvivalTieBreak ?? true;
  const enableConvergenceEarlyStop = options.enableConvergenceEarlyStop ?? true;
  const baseSeed = options.seed ?? state.rngState ?? 1;
  // [Claude 2026-06-23] iterations 顯式給＝用它；否則有 timeLimitMs 就讓「時間」綁定（高上限當安全網）、
  // 沒 timeLimitMs 才退回固定 DEFAULT_ITERATIONS（純迭代模式，測試用）。避免 800 上限在 ~0.5s 就吃掉 think budget。
  const iterationCap =
    options.iterations !== undefined
      ? Math.max(0, Math.floor(options.iterations))
      : options.timeLimitMs !== undefined
        ? 1_000_000
        : DEFAULT_ITERATIONS;
  const deadline = options.timeLimitMs === undefined ? Infinity : Date.now() + Math.max(0, options.timeLimitMs);
  const fallbackDecision = heuristicAiDecision(db, state, rolloutPolicy);
  const rootLegal = legalEntries(db, state, candidateLimit, rolloutPolicy);
  const direct = directRootDecision(db, state, rootLegal);
  if (direct) {
    const bestAction = directEstimate(db, state, direct.decision, direct.reason);
    return {
      kind: "ismcts-coach-v1",
      perspectivePlayer: perspective,
      actingPlayer,
      pendingType: pd.type,
      rolloutPolicy,
      requestedSamplesPerAction: iterationCap,
      completedSamples: 0,
      timedOut: false,
      fallbackDecision,
      bestAction,
      recommendations: [bestAction],
      valueExplanation: explainValue(state, perspective, undefined, db, knownDecks),
    };
  }

  const root = newNode();
  let completed = 0;
  let timedOut = false;
  const startedAt = Date.now();
  for (let iter = 0; iter < iterationCap; iter++) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const world = determinizeHiddenState(state, perspective, knownDecks, baseSeed + iter * SEED_STRIDE);
    iterate(
      db,
      root,
      world,
      perspective,
      explorationC,
      candidateLimit,
      rolloutPolicy,
      leafRolloutHorizon,
      opponentModel,
      pressureShapingEpsilon,
      valueModel,
      knownDecks,
    );
    completed++;
    if (
      enableConvergenceEarlyStop &&
      shouldStopForRootConvergence(root, rootLegal, estimatedRemainingIterations(iterationCap, completed, deadline, startedAt))
    ) {
      break;
    }
  }

  // root 子節點 → 候選估計，依 visits（robust child）排序、tie-break mean → confidence。
  const recommendations: CoachActionEstimate[] = [];
  // 用真實盤面（root state）的合法集列舉決策物件，對應 root 已建的子節點 key。
  const legalByKey = new Map(rootLegal.map((entry) => [entry.key, entry.decision] as const));
  for (const [key, child] of root.children) {
    const decision = legalByKey.get(key);
    if (!decision) continue; // 只在真實盤面合法的子節點才報（root 的 legal 應與真實盤面一致）
    recommendations.push(estimateFromChild(db, state, decision, child));
  }
  recommendations.sort(
    (a, b) => b.sampleCount - a.sampleCount || b.winRate - a.winRate || b.confidence - a.confidence,
  );

  const tieBreakBest = chooseRootTieBreakBest(
    db,
    state,
    recommendations,
    perspective,
    rootPressureTieBreakDelta,
    rootPairQualityTieBreak,
    rootConservationWinRateThreshold,
    rolloutPolicy,
    defenseChoiceSurvivalTieBreak,
    defenseSkillEffectScoring,
  );
  if (tieBreakBest) {
    const index = recommendations.indexOf(tieBreakBest);
    if (index > 0) {
      recommendations.splice(index, 1);
      recommendations.unshift(tieBreakBest);
    }
  }
  const bestAction = recommendations[0] ?? fallbackEstimate(db, state, fallbackDecision);

  return {
    kind: "ismcts-coach-v1",
    perspectivePlayer: perspective,
    actingPlayer,
    pendingType: pd.type,
    rolloutPolicy,
    requestedSamplesPerAction: iterationCap,
    completedSamples: completed,
    timedOut,
    fallbackDecision,
    bestAction,
    recommendations,
    valueExplanation: explainValue(state, perspective, undefined, db, knownDecks),
  };
}

export const __ismctsTest = {
  newNode,
  iterate,
  chooseRootTieBreakBest,
  decisionImmediatelyLosesSetOrMatch,
  defenseChoiceSurvivesCurrentOp,
  defensiveConfirmEffectScore,
  gateDeclaredGutsCost,
  shouldStopForRootConvergence,
  confidenceFromRate,
};
