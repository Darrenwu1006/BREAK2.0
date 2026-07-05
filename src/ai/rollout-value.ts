import { effParam } from "../engine/engine";
import type { CardDb, GameState, PlayerId, PlayerState } from "../engine/types";
import {
  opponentRemainingHighAttackExpected,
  opponentRemainingHighBlockExpected,
  ownRemainingHighAttackExpected,
  type KnownDecks,
} from "./remaining-pool";

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
  // [Codex 2026-06-30] Phase H H-W2/W3：補公開場面有效點數，避免 leaf 只看「張數」看不到攻防品質。
  "attackPointDiff", // 我 − 對手 攻擊區頂端有效攻擊點數
  "attackLinePointDiff", // 我 − 對手 托球+攻擊線有效點數
  "defensePointDiff", // 我 − 對手 接球+攔網有效防守點數
  // [Codex 2026-07-04] Phase K K1：手牌品質、剩餘資源、資源經濟與少量非線性／交互特徵。
  "myHandBestAttack", // 自己手牌最高攻擊點數（自己手牌內容合法可讀）
  "myHandBestBlock", // 自己手牌最高攔網點數
  "myHandBestReceive", // 自己手牌最高接球點數
  "myHandDeployablePower", // 自己手牌角色卡可用點數總和的粗估
  "myHandEventCount", // 自己手牌事件卡張數
  "oppRemainingHighAttackRate", // 對手未見卡池高攻率 × 對手 hand+deck 張數
  "oppRemainingHighBlockRate", // 對手未見卡池高攔率 × 對手 hand+deck 張數
  "myRemainingHighAttackCount", // 自己手牌實值 + 自己牌庫期望高攻存量
  "gutsTotalDiff", // 雙方場上 Guts 總數差
  "overkillMargin", // OP-DP 勝出餘裕，依 perspective 簽名且 capped
  "setLifeLeadOne", // Set 殘量領先 1
  "setLifeLeadTwoPlus", // Set 殘量領先 2+
  "setLifeDiffProgress", // Set 殘量差 × 已完成 Set 數
  "attackLineVsOppDefensePotential", // 攻線差 × 對手防守潛力
] as const;

export type ValueFeatureName = (typeof VALUE_FEATURE_NAMES)[number];
export const VALUE_FEATURE_DIM = VALUE_FEATURE_NAMES.length;

export const VALUE_FEATURE_LABELS: Record<ValueFeatureName, string> = {
  setLifeDiff: "Set 殘量差",
  opSigned: "攻擊壓力",
  dpSigned: "防守壓力",
  handDiff: "手牌差",
  deckDiff: "牌庫差",
  serving: "發球權",
  turnMine: "行動權",
  attackDiff: "攻擊線張數",
  blockDiff: "攔網張數",
  courtDiff: "場上張數",
  dropDiff: "棄牌資源",
  eventDiff: "事件佈局",
  attackPointDiff: "攻擊點數差",
  attackLinePointDiff: "攻擊線點數差",
  defensePointDiff: "防守點數差",
  myHandBestAttack: "手牌最高攻擊",
  myHandBestBlock: "手牌最高攔網",
  myHandBestReceive: "手牌最高接球",
  myHandDeployablePower: "手牌登場火力",
  myHandEventCount: "手牌事件量",
  oppRemainingHighAttackRate: "對手高攻存量",
  oppRemainingHighBlockRate: "對手高攔存量",
  myRemainingHighAttackCount: "我方高攻存量",
  gutsTotalDiff: "Guts 資源差",
  overkillMargin: "攻防餘裕",
  setLifeLeadOne: "Set 領先一分",
  setLifeLeadTwoPlus: "Set 領先兩分以上",
  setLifeDiffProgress: "比分進程",
  attackLineVsOppDefensePotential: "攻線對防守潛力",
};

function top(stack: readonly number[]): number | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}

function topParam(db: CardDb | undefined, state: GameState, player: PlayerState, area: "block" | "receive" | "toss" | "attack"): number {
  if (!db) return 0;
  if (area === "block") {
    const center = top(player.blockCenter);
    const centerValue = center === null ? 0 : effParam(db, state, center, "block") ?? 0;
    const sideValue = player.blockSides.reduce((sum, uid) => sum + (effParam(db, state, uid, "block") ?? 0), 0);
    return centerValue + sideValue;
  }
  const uid = top(player[area]);
  return uid === null ? 0 : effParam(db, state, uid, area) ?? 0;
}

export interface ValueFeatureContext {
  knownDecks?: KnownDecks;
}

function cardParam(db: CardDb | undefined, state: GameState, uid: number, area: "block" | "receive" | "toss" | "attack" | "serve"): number {
  if (!db) return 0;
  const id = state.cards[uid];
  const value = id ? db.get(id)?.params?.[area] : null;
  return typeof value === "number" ? value : 0;
}

function handBestParam(db: CardDb | undefined, state: GameState, player: PlayerState, area: "block" | "receive" | "attack"): number {
  return player.hand.reduce((best, uid) => Math.max(best, cardParam(db, state, uid, area)), 0);
}

function handDeployablePower(db: CardDb | undefined, state: GameState, player: PlayerState): number {
  if (!db) return 0;
  return player.hand.reduce((sum, uid) => {
    const id = state.cards[uid];
    const params = id ? db.get(id)?.params : null;
    if (!params) return sum;
    const best = Math.max(
      params.serve ?? 0,
      params.block ?? 0,
      params.receive ?? 0,
      params.toss ?? 0,
      params.attack ?? 0,
    );
    return sum + best;
  }, 0);
}

function handEventCount(db: CardDb | undefined, state: GameState, player: PlayerState): number {
  if (!db) return 0;
  return player.hand.reduce((count, uid) => {
    const id = state.cards[uid];
    return count + (id && db.get(id)?.type === "EVENT" ? 1 : 0);
  }, 0);
}

function stackGuts(stack: readonly number[]): number {
  return Math.max(0, stack.length - 1);
}

function playerGutsTotal(player: PlayerState): number {
  return stackGuts(player.serve) + stackGuts(player.blockCenter) + stackGuts(player.receive) + stackGuts(player.toss) + stackGuts(player.attack);
}

function signedOverkillMargin(state: GameState, perspective: PlayerId): number {
  if (!state.op || !state.dp) return 0;
  const margin = Math.min(3, Math.max(0, state.op.value - state.dp.value));
  if (state.op.owner === perspective) return margin;
  return -margin;
}

/** 抽取價值函數特徵向量（順序對齊 VALUE_FEATURE_NAMES）。只讀公開 scalar。 */
export function extractValueFeatures(state: GameState, perspective: PlayerId, db?: CardDb, context: ValueFeatureContext = {}): number[] {
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
  const mineAttack = topParam(db, state, mine, "attack");
  const theirAttack = topParam(db, state, their, "attack");
  const mineAttackLine = topParam(db, state, mine, "toss") + mineAttack;
  const theirAttackLine = topParam(db, state, their, "toss") + theirAttack;
  const mineDefense = topParam(db, state, mine, "receive") + topParam(db, state, mine, "block");
  const theirDefense = topParam(db, state, their, "receive") + topParam(db, state, their, "block");
  const setLifeDiff = mine.setArea.length - their.setArea.length;
  const attackPointDiff = mineAttack - theirAttack;
  const attackLinePointDiff = mineAttackLine - theirAttackLine;
  const defensePointDiff = mineDefense - theirDefense;
  const oppRemainingHighAttack = db ? opponentRemainingHighAttackExpected(db, state, me, context.knownDecks) : 0;
  const oppRemainingHighBlock = db ? opponentRemainingHighBlockExpected(db, state, me, context.knownDecks) : 0;
  const myRemainingHighAttack = db ? ownRemainingHighAttackExpected(db, state, me, context.knownDecks) : 0;
  const completedSets = Math.max(0, (state.setNo ?? 1) - 1);
  const oppDefensePotential = theirDefense + oppRemainingHighBlock;

  return [
    setLifeDiff,
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
    attackPointDiff,
    attackLinePointDiff,
    defensePointDiff,
    handBestParam(db, state, mine, "attack"),
    handBestParam(db, state, mine, "block"),
    handBestParam(db, state, mine, "receive"),
    handDeployablePower(db, state, mine),
    handEventCount(db, state, mine),
    oppRemainingHighAttack,
    oppRemainingHighBlock,
    myRemainingHighAttack,
    playerGutsTotal(mine) - playerGutsTotal(their),
    signedOverkillMargin(state, me),
    setLifeDiff === 1 ? 1 : 0,
    setLifeDiff >= 2 ? 1 : 0,
    setLifeDiff * completedSets,
    attackLinePointDiff * oppDefensePotential,
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
 * [Codex 2026-07-05] Phase K default-on selected v1 係數（29 維）。
 * H4/H5 行為參數（rootPressureTieBreakDelta=0.04、rootConservationWinRateThreshold=0.85）另在 IS-MCTS 保持不動。
 */
export const ROLLOUT_VALUE_MODEL: ValueModel = {
  weights: [
    1.0792904515664883,
    0.10125110367845033,
    0,
    0.12845235855358444,
    -0.02109804724880147,
    -0.13481758380063316,
    0.10064361394120208,
    0.1580467920340516,
    0.3299436108005369,
    -0.0696573514192975,
    0.026916631267495057,
    -0.06491096486945418,
    -0.07549608081834222,
    0.08946038511873473,
    -0.044363709074465844,
    0,
    0,
    0,
    0,
    0,
    -0.08651622401556772,
    -0.02746377458189579,
    0.10639185166360375,
    -0.0020727394014032545,
    0,
    0,
    0,
    0,
    0,
  ],
  bias: 0.15702473665271066,
  provenance:
    "Phase K default-on selected v1: 29-dim omit A+D fit from data/ab/phase-k-k15-selected-v1-fit-holdout-g2000-i16.json (outcomeGames=2000, rows=97458, trainRows=78054, holdoutRows=19404, holdoutEvery=5, auc=0.7539, logloss=0.5841). Merge evidence approved by orchestrator 5f51c71 / WORKLOG 2026-07-05: strength 91/160=56.9% [49.1-64.3], attack success pooled -3.7pp watch, M2-free 0/7 + unit tests, M1 improvement, M3/M2-costly accepted as user resource economy. H4/H5 params unchanged: rootPressureTieBreakDelta=0.04, rootConservationWinRateThreshold=0.85. [Codex 2026-07-05]",
};

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
  knownDecks?: KnownDecks,
): number {
  const winProb = evaluateStateValue(state, perspective, model, db, knownDecks);
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

export interface ValueExplanationTerm {
  feature: ValueFeatureName;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  direction: "helps" | "hurts" | "neutral";
}

export interface ValueExplanation {
  perspectivePlayer: PlayerId;
  probability: number;
  logit: number;
  bias: number;
  provenance: string;
  terms: ValueExplanationTerm[];
}

export function valueLogit(
  state: GameState,
  perspective: PlayerId,
  model: ValueModel = ROLLOUT_VALUE_MODEL,
  db?: CardDb,
  knownDecks?: KnownDecks,
): number {
  const features = extractValueFeatures(state, perspective, db, { knownDecks });
  let z = model.bias;
  for (let i = 0; i < features.length; i++) z += features[i]! * (model.weights[i] ?? 0);
  return z;
}

export function explainValue(
  state: GameState,
  perspective: PlayerId,
  model: ValueModel = ROLLOUT_VALUE_MODEL,
  db?: CardDb,
  knownDecks?: KnownDecks,
): ValueExplanation {
  const features = extractValueFeatures(state, perspective, db, { knownDecks });
  const terms = VALUE_FEATURE_NAMES.map((feature, index): ValueExplanationTerm => {
    const value = features[index] ?? 0;
    const weight = model.weights[index] ?? 0;
    const contribution = value * weight;
    return {
      feature,
      label: VALUE_FEATURE_LABELS[feature],
      value,
      weight,
      contribution,
      direction: contribution > 0 ? "helps" : contribution < 0 ? "hurts" : "neutral",
    };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const logit = model.bias + terms.reduce((sum, term) => sum + term.contribution, 0);
  return {
    perspectivePlayer: perspective,
    probability: sigmoid(logit),
    logit,
    bias: model.bias,
    provenance: model.provenance,
    terms,
  };
}

/** V(state, perspective) ∈ [0,1]＝估計 perspective 最終獲勝機率。 */
export function evaluateStateValue(
  state: GameState,
  perspective: PlayerId,
  model: ValueModel = ROLLOUT_VALUE_MODEL,
  db?: CardDb,
  knownDecks?: KnownDecks,
): number {
  return sigmoid(valueLogit(state, perspective, model, db, knownDecks));
}
