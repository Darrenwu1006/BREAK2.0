import { applyDecision, deployableUids, effParam } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { heuristicAiDecision } from "./heuristic";
import type { HeuristicV2ProfileId } from "./heuristic";
import {
  decisionLabel,
  determinizeHiddenState,
  enumerateCandidates,
  inferKnownDecks,
  type CoachActionEstimate,
  type CoachReport,
} from "./coach";
import { evaluatePressureScore, evaluateShapedStateValue } from "./rollout-value";
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
  /**
   * [Codex 2026-06-29] Phase H H2B：root 最終選手 tie-break。
   * 0（預設＝off）；>0 時，只在候選 winRate 距 robust best 不超過此 delta 時，
   * 用公開壓制力／攻擊點數品質打破平手。
   */
  rootPressureTieBreakDelta?: number;
  /**
   * [Codex 2026-06-29] Phase H H2C：root tie-break 的拖球候選改看「拖球＋後續最佳攻擊」組合品質。
   * 只在 rootPressureTieBreakDelta 開啟時生效；用於避免把攻擊高的牌誤放到拖球區。
   */
  rootPairQualityTieBreak?: boolean;
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
const ROOT_TIE_BREAK_MIN_VISIT_RATIO = 0.5;
/** 每 iteration 換 world 的 seed 間距（大質數，避免抽樣相關）。 */
const SEED_STRIDE = 1000003;

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
): number {
  if (cur.phase === "gameOver") return cur.winner === perspective ? 1 : 0;
  if (horizon <= 0) return clamp01(evaluateShapedStateValue(db, cur, perspective, pressureShapingEpsilon));
  let s = cur;
  for (let step = 0; step < horizon; step++) {
    if (s.phase === "gameOver") return s.winner === perspective ? 1 : 0;
    if (!s.pendingDecision) break;
    try {
      s = applyDecision(db, s, heuristicAiDecision(db, s, rolloutPolicy));
    } catch {
      break;
    }
  }
  if (s.phase === "gameOver") return s.winner === perspective ? 1 : 0;
  return clamp01(evaluateShapedStateValue(db, s, perspective, pressureShapingEpsilon));
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

export function rootDecisionPressureScore(
  db: CardDb,
  state: GameState,
  decision: Decision,
  perspective: PlayerId,
  options: { pairAware?: boolean } = {},
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
    score += decision.accept ? 0.05 : -0.05;
  }
  return score;
}

function chooseRootTieBreakBest(
  db: CardDb,
  state: GameState,
  recommendations: CoachActionEstimate[],
  perspective: PlayerId,
  winRateDelta: number,
  pairAware: boolean,
): CoachActionEstimate | null {
  if (winRateDelta <= 0 || recommendations.length <= 1) return null;
  const robustBest = recommendations[0]!;
  const minVisits = Math.max(1, Math.floor(robustBest.sampleCount * ROOT_TIE_BREAK_MIN_VISIT_RATIO));
  const close = recommendations.filter(
    (item) => item.sampleCount >= minVisits && Math.abs(item.winRate - robustBest.winRate) <= winRateDelta,
  );
  if (close.length <= 1) return null;
  return close
    .map((item) => ({ item, pressure: rootDecisionPressureScore(db, state, item.decision, perspective, { pairAware }) }))
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
        cur = applyDecision(db, cur, heuristicAiDecision(db, cur, rolloutPolicy));
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
      cur = applyDecision(db, cur, chosen.decision);
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
    cur = applyDecision(db, cur, bestDecision);
    path.push({ node, key: bestKey });
    node = node.children.get(bestKey)!;
  }

  // ---- Leaf evaluation（方案 A＝純 V；方案 B＝淺 rollout 後 V）----
  const value = leafEval(db, cur, perspective, rolloutPolicy, leafRolloutHorizon, pressureShapingEpsilon);

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
  const rootPressureTieBreakDelta = Math.max(0, options.rootPressureTieBreakDelta ?? 0);
  const rootPairQualityTieBreak = options.rootPairQualityTieBreak ?? false;
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

  const root = newNode();
  let completed = 0;
  let timedOut = false;
  for (let iter = 0; iter < iterationCap; iter++) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const world = determinizeHiddenState(state, perspective, knownDecks, baseSeed + iter * SEED_STRIDE);
    iterate(db, root, world, perspective, explorationC, candidateLimit, rolloutPolicy, leafRolloutHorizon, opponentModel, pressureShapingEpsilon);
    completed++;
  }

  // root 子節點 → 候選估計，依 visits（robust child）排序、tie-break mean → confidence。
  const recommendations: CoachActionEstimate[] = [];
  // 用真實盤面（root state）的合法集列舉決策物件，對應 root 已建的子節點 key。
  const rootLegal = legalEntries(db, state, candidateLimit, rolloutPolicy);
  const legalByKey = new Map(rootLegal.map((entry) => [entry.key, entry.decision] as const));
  for (const [key, child] of root.children) {
    const decision = legalByKey.get(key);
    if (!decision) continue; // 只在真實盤面合法的子節點才報（root 的 legal 應與真實盤面一致）
    recommendations.push(estimateFromChild(db, state, decision, child));
  }
  recommendations.sort(
    (a, b) => b.sampleCount - a.sampleCount || b.winRate - a.winRate || b.confidence - a.confidence,
  );

  const tieBreakBest = chooseRootTieBreakBest(db, state, recommendations, perspective, rootPressureTieBreakDelta, rootPairQualityTieBreak);
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
  };
}

export const __ismctsTest = {
  newNode,
  iterate,
  confidenceFromRate,
};
