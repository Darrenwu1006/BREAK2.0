import type { GameState, PlayerId } from "../engine/types";

/**
 * [Claude 2026-06-22] Phase F 第二槓桿 S1a：rollout 終局 EV cut 用的狀態價值函數。
 *
 * `evaluateStateValue(state, perspective)` ∈ [0,1] ＝ 從該（非終局）盤面估計 perspective 最終獲勝機率，
 * 供 S1b 在 rollout 打到 horizon 仍未終局時截斷取值（取代「丟棄／硬打到終局」）。
 *
 * 公平性鐵則：feature 只能讀「perspective 視角可見的公開 scalar」——
 * set 殘量（setArea **長度**，內容隱藏）、檯面 OP/DP、自己/對手 hand 與 deck 的**張數**、發球/行動權、進程。
 * 不得讀對手手牌內容、Set 內容、牌庫順序等隱藏未知資訊（翻轉對手隱藏區 → feature 不變、V 不變）。
 *
 * 係數由 `rollout-value-fit.ts` 對「heuristic 自對弈的 (features, 最終 winner)」做 logistic regression 擬合後凍結。
 */

export const VALUE_FEATURE_NAMES = [
  "setLifeDiff", // 我 − 對手 的 Set 殘量（主項，最接近終局）
  "opSigned", // 檯面 OP：owner 是我 → +value，是對手 → −value
  "dpSigned", // 檯面 DP：同上
  "handDiff", // 我 − 對手 手牌張數
  "deckDiff", // 我 − 對手 牌庫張數
  "serving", // 本 set 發球權在我 → +1，否則 −1
  "turnMine", // 當前行動權在我 → +1，否則 −1
] as const;

export type ValueFeatureName = (typeof VALUE_FEATURE_NAMES)[number];
export const VALUE_FEATURE_DIM = VALUE_FEATURE_NAMES.length;

/** 抽取價值函數特徵向量（順序對齊 VALUE_FEATURE_NAMES）。只讀公開 scalar。 */
export function extractValueFeatures(state: GameState, perspective: PlayerId): number[] {
  const me = perspective;
  const opp = (perspective === 0 ? 1 : 0) as PlayerId;
  const mine = state.players[me];
  const their = state.players[opp];

  const op = state.op;
  const dp = state.dp;
  const opSigned = op ? (op.owner === me ? op.value : -op.value) : 0;
  const dpSigned = dp ? (dp.owner === me ? dp.value : -dp.value) : 0;

  return [
    mine.setArea.length - their.setArea.length,
    opSigned,
    dpSigned,
    mine.hand.length - their.hand.length,
    mine.deck.length - their.deck.length,
    state.servingPlayer === me ? 1 : -1,
    state.turnPlayer === me ? 1 : -1,
  ];
}

export interface ValueModel {
  /** 與 VALUE_FEATURE_NAMES 同長同序的權重（作用於 raw 特徵）。 */
  weights: number[];
  bias: number;
  /** 擬合來源紀錄（局數、樣本數、log-loss、accuracy、AUC），供稽核。 */
  provenance: string;
}

/**
 * [Claude 2026-06-22] 凍結係數。由 `npm run fit:rollout-value -- --games 400 --sample-every 4` 擬合產生並貼回。
 * setLifeDiff 主導（1.23，正向）、handDiff 次之（0.24）皆符合直覺；AUC 0.78＝對中局勝負有實質鑑別力。
 * 重擬合請更新本區塊與 provenance。
 */
export const ROLLOUT_VALUE_MODEL: ValueModel = {
  weights: [1.2334, 0.1152, 0.0595, 0.2438, 0.1187, -0.0718, 0.0302],
  bias: 0.0,
  provenance: "fit games=400 samples=32664 logloss=0.5553 acc=69.4% auc=0.7817 [Claude 2026-06-22]",
};

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** V(state, perspective) ∈ [0,1]＝估計 perspective 最終獲勝機率。 */
export function evaluateStateValue(
  state: GameState,
  perspective: PlayerId,
  model: ValueModel = ROLLOUT_VALUE_MODEL,
): number {
  const features = extractValueFeatures(state, perspective);
  let z = model.bias;
  for (let i = 0; i < features.length; i++) z += features[i]! * (model.weights[i] ?? 0);
  return sigmoid(z);
}
