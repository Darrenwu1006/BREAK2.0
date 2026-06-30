import { effParam } from "../engine/engine";
import type { CardDb, GameState, PlayerId, PlayerState } from "../engine/types";

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
  // [Claude 2026-06-23] S1a 擴充：場上發展（皆公開、用各區疊放張數，不讀隱藏內容）
  "attackDiff", // 我 − 對手 攻擊線張數（最直接連到得分）
  "blockDiff", // 我 − 對手 攔網（center+sides）張數（防守佈署）
  "courtDiff", // 我 − 對手 場上總在場張數（serve/receive/toss/attack/block 合計）
  "dropDiff", // 我 − 對手 棄牌區張數（資源消耗）
  "eventDiff", // 我 − 對手 事件區張數（持續性佈局）
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

  const blockCount = (p: typeof mine) => p.blockCenter.length + p.blockSides.length;
  const courtCount = (p: typeof mine) =>
    p.serve.length + p.receive.length + p.toss.length + p.attack.length + blockCount(p);

  return [
    mine.setArea.length - their.setArea.length,
    opSigned,
    dpSigned,
    mine.hand.length - their.hand.length,
    mine.deck.length - their.deck.length,
    state.servingPlayer === me ? 1 : -1,
    state.turnPlayer === me ? 1 : -1,
    mine.attack.length - their.attack.length,
    blockCount(mine) - blockCount(their),
    courtCount(mine) - courtCount(their),
    mine.drop.length - their.drop.length,
    mine.eventArea.length - their.eventArea.length,
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
 * [Claude 2026-06-23] 凍結係數。由 `npm run fit:rollout-value -- --games 400 --sample-every 4` 擬合產生並貼回。
 * setLifeDiff 主導（1.06，正向），blockDiff（0.38，攔網佈署）與 handDiff（0.19）次之，皆符合直覺；
 * 加入場上發展特徵後 AUC 0.78→0.81、acc 69.4%→71.8%。重擬合請更新本區塊與 provenance。
 */
export const ROLLOUT_VALUE_MODEL: ValueModel = {
  weights: [1.0557, 0.1429, 0.0147, 0.1874, 0.0332, 0.0257, 0.0976, 0.1196, 0.3760, -0.1203, -0.0728, 0.1256],
  bias: 0.0,
  provenance: "fit games=400 samples=32664 logloss=0.5297 acc=71.8% auc=0.8061 [Claude 2026-06-23]",
};

function top(stack: readonly number[]): number | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}

function topParam(db: CardDb, state: GameState, player: PlayerState, area: "block" | "receive" | "toss" | "attack"): number {
  if (area === "block") {
    const center = top(player.blockCenter);
    const centerValue = center === null ? 0 : effParam(db, state, center, "block") ?? 0;
    const sideValue = player.blockSides.reduce((sum, uid) => sum + (effParam(db, state, uid, "block") ?? 0), 0);
    return centerValue + sideValue;
  }
  const uid = top(player[area]);
  return uid === null ? 0 : effParam(db, state, uid, area) ?? 0;
}

/**
 * Phase H objective shaping 用的公開壓制力分數。
 * 回傳範圍刻意壓到約 [-0.1, 0.1]，讓 epsilon 只做 tie-break gradient，不翻轉明確勝負判斷。
 */
export function evaluatePressureScore(db: CardDb, state: GameState, perspective: PlayerId): number {
  const me = perspective;
  const opp = (perspective === 0 ? 1 : 0) as PlayerId;
  const mine = state.players[me];
  const their = state.players[opp];
  const opSigned = state.op ? (state.op.owner === me ? state.op.value : -state.op.value) : 0;
  const attackLineDiff =
    topParam(db, state, mine, "toss") +
    topParam(db, state, mine, "attack") -
    topParam(db, state, their, "toss") -
    topParam(db, state, their, "attack");
  const defensePressure =
    topParam(db, state, their, "receive") +
    topParam(db, state, their, "block") -
    topParam(db, state, mine, "receive") -
    topParam(db, state, mine, "block");
  const resourcePressure = mine.hand.length - their.hand.length;
  const raw = opSigned * 0.75 + attackLineDiff * 0.6 - defensePressure * 0.25 + resourcePressure * 0.15;
  return Math.tanh(raw / 10) * 0.1;
}

export function shapeStateValue(winProb: number, pressureScore: number, epsilon: number): number {
  return Math.max(0, Math.min(1, winProb + epsilon * pressureScore));
}

export function evaluateShapedStateValue(
  db: CardDb,
  state: GameState,
  perspective: PlayerId,
  epsilon: number,
  model: ValueModel = ROLLOUT_VALUE_MODEL,
): number {
  const winProb = evaluateStateValue(state, perspective, model);
  if (epsilon <= 0) return winProb;
  return shapeStateValue(winProb, evaluatePressureScore(db, state, perspective), epsilon);
}

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
