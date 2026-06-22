import type { GameState } from "../engine/types";

/**
 * [Claude 2026-06-22] Phase F：自適應思考預算。
 * 使用者要求——強敵 AI 預設想 3 秒，遇關鍵／複雜盤面自動加到 10 秒（瑣碎決策不浪費玩家時間，難局才多想）。
 * 用 GameState 直接可得的訊號估「這手有多需要深思」：①決策型別複雜度 ②場上 OP/DP 壓力 ③比賽進程（越後面的 set 越接近決勝）。
 * 輸出給 PIMC 當 `timeLimitMs`。設計成多數手落在 3–5 秒，只有「最複雜＋高壓＋決勝局」才逼近 10 秒。
 */
export interface ThinkBudgetOptions {
  /** 瑣碎盤面的下限（預設 3000ms） */
  minMs?: number;
  /** 關鍵／複雜盤面的上限（預設 10000ms） */
  maxMs?: number;
}

const DEFAULT_MIN_MS = 3000;
const DEFAULT_MAX_MS = 10000;

// 決策型別的「複雜度基礎權重」0..1：要評估的分支越多／影響越大者越高。
// 刻意壓低，讓壓力與比賽進程才是把關鍵盤面推上去的主力 → 多數手維持接近下限。
const TYPE_WEIGHT: Partial<Record<GameState["pendingDecision"] extends null ? never : string, number>> = {
  "deploy-block": 0.4, // 多選 uids + center，分支最多
  "effect-cards": 0.4, // 選卡組合多
  "free": 0.35, // skill/event/pass/lost，主動權關鍵
  "deploy-attack": 0.3,
  "effect-option": 0.3,
  "deploy-serve": 0.3,
  "defense-choice": 0.3,
  "deploy-receive": 0.25,
  "deploy-toss": 0.25,
  "pick-set-card": 0.25,
  "resolve-pending": 0.2,
  "effect-confirm": 0.15,
  "mulligan": 0.15,
  "serve-rights": 0, // 瑣碎
};

export function estimateThinkBudgetMs(state: GameState, options: ThinkBudgetOptions = {}): number {
  const minMs = options.minMs ?? DEFAULT_MIN_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const pd = state.pendingDecision;
  if (!pd) return minMs;

  let weight = TYPE_WEIGHT[pd.type] ?? 0.25;

  // 場上 OP/DP 越高＝越接近得失分，這手越關鍵（最多 +0.4）。
  const pressure = Math.max(state.op?.value ?? 0, state.dp?.value ?? 0);
  weight += Math.min(1, pressure / 7) * 0.4;

  // 比賽進程：越後面的 set 越接近決勝，值得多想（最多 +0.4）。
  if (state.setNo >= 3) weight += 0.2;
  if (state.setNo >= 5) weight += 0.2;

  weight = Math.min(1, Math.max(0, weight));
  return Math.round(minMs + (maxMs - minMs) * weight);
}
