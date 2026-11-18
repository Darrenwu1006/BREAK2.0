// M5 Heuristic v2：合法性仍交給引擎，AI 只負責「哪個合法選擇比較像好選擇」。
// 核心取向：
// - 起手換牌看先後手與角色覆蓋，不固定不換。
// - 自由步驟先估技能/事件淨收益，不再有招就亂開。
// - effect 子決策用同一套卡片價值排序，成本選便宜、收益選關鍵。
// - 防守仍以活下來為第一優先，但把機會成本納入攔網/接球選擇。
import type { Card } from "../data/types";
import type { Action, CharaFilter, Condition, Cost, CourtArea, EffectDef, ParamName, PhaseIcon, SkillDef } from "../engine/dsl";
import type { Awaiting, CardDb, Decision, GameState, PendingItem, PlayerId } from "../engine/types";
import { autoPickCards, blockDeployMax, canChooseBlock, charasOf, deployableUids, deployNames, effParam, freeOptions, nameOf, normName, topChara } from "../engine/engine";
import { isSkillInvalid } from "../engine/conditions";
import { pickDeployName } from "./util";

type Area = CourtArea;
type CandidateOrder = "low" | "high";

export type HeuristicStrategyProfileId = "neutral" | "serve" | "block" | "burst" | "defense" | "hybrid";
export type HeuristicV2ProfileId =
  | "heuristic-v2"
  | "heuristic-v2-safe"
  | "heuristic-v2-aggressive"
  | "heuristic-v2-serve"
  | "heuristic-v2-block"
  | "heuristic-v2-burst"
  | "heuristic-v2-defense"
  | "heuristic-v2-hybrid"
  | "heuristic-v2-personality";

export interface HeuristicV2Weights {
  id: HeuristicV2ProfileId;
  strategy: HeuristicStrategyProfileId;
  futureEventValue: number;
  futureServeValue: number;
  futureBlockValue: number;
  futureDefenseValue: number;
  futureAttackValue: number;
  coverageValue: number;
  setupEventValue: number;
  mulliganWeakDelta: number;
  mulliganReturnDelta: number;
  blockSideCost: number;
  blockExcessCost: number;
  receiveFutureCost: number;
  deployFuturePenalty: number;
  skillValue: number;
  actionValue: number;
  costValue: number;
  drawValue: number;
  deckRisk: number;
  freeActionThreshold: number;
  gateAcceptThreshold: number;
  defenseBias: number;
  blockChoiceBias: number;
  blockTimingValue: number;
  blockActionValue: number;
  blockSideFutureCost: number;
  blockCenterFutureCost: number;
  blockDeployCountCost: number;
}

type BaseProfileId = "heuristic-v2" | "heuristic-v2-safe" | "heuristic-v2-aggressive";

const BASE_HEURISTIC_V2_PROFILES: Record<BaseProfileId, HeuristicV2Weights> = {
  "heuristic-v2": {
    id: "heuristic-v2",
    strategy: "neutral",
    futureEventValue: 1,
    futureServeValue: 1,
    futureBlockValue: 1,
    futureDefenseValue: 1,
    futureAttackValue: 1,
    coverageValue: 1,
    setupEventValue: 1,
    mulliganWeakDelta: 0,
    mulliganReturnDelta: 0,
    blockSideCost: 1,
    blockExcessCost: 1,
    receiveFutureCost: 1,
    deployFuturePenalty: 1,
    skillValue: 1,
    actionValue: 1,
    costValue: 1,
    drawValue: 1,
    deckRisk: 1,
    freeActionThreshold: 1.15,
    gateAcceptThreshold: 0.7,
    defenseBias: 1,
    blockChoiceBias: 0,
    blockTimingValue: 1,
    blockActionValue: 0,
    blockSideFutureCost: 1,
    blockCenterFutureCost: 1,
    blockDeployCountCost: 1,
  },
  "heuristic-v2-safe": {
    id: "heuristic-v2-safe",
    strategy: "neutral",
    futureEventValue: 0.92,
    futureServeValue: 0.92,
    futureBlockValue: 1.08,
    futureDefenseValue: 1.18,
    futureAttackValue: 0.9,
    coverageValue: 1.08,
    setupEventValue: 0.95,
    mulliganWeakDelta: 0.25,
    mulliganReturnDelta: 1,
    blockSideCost: 1.18,
    blockExcessCost: 1.2,
    receiveFutureCost: 1.35,
    deployFuturePenalty: 1.18,
    skillValue: 0.95,
    actionValue: 0.95,
    costValue: 1.18,
    drawValue: 0.95,
    deckRisk: 1.25,
    freeActionThreshold: 1.35,
    gateAcceptThreshold: 0.9,
    defenseBias: 1.2,
    blockChoiceBias: 0,
    blockTimingValue: 1.05,
    blockActionValue: 0,
    blockSideFutureCost: 1,
    blockCenterFutureCost: 1,
    blockDeployCountCost: 1,
  },
  "heuristic-v2-aggressive": {
    id: "heuristic-v2-aggressive",
    strategy: "neutral",
    futureEventValue: 1.15,
    futureServeValue: 1.14,
    futureBlockValue: 0.95,
    futureDefenseValue: 0.9,
    futureAttackValue: 1.2,
    coverageValue: 0.94,
    setupEventValue: 1.12,
    mulliganWeakDelta: -0.2,
    mulliganReturnDelta: -1,
    blockSideCost: 0.88,
    blockExcessCost: 0.82,
    receiveFutureCost: 0.9,
    deployFuturePenalty: 0.78,
    skillValue: 1.18,
    actionValue: 1.16,
    costValue: 0.86,
    drawValue: 1.05,
    deckRisk: 0.85,
    freeActionThreshold: 0.85,
    gateAcceptThreshold: 0.45,
    defenseBias: 0.9,
    blockChoiceBias: 0,
    blockTimingValue: 0.95,
    blockActionValue: 0,
    blockSideFutureCost: 1,
    blockCenterFutureCost: 1,
    blockDeployCountCost: 1,
  },
};

function strategyProfile(id: HeuristicV2ProfileId, strategy: HeuristicStrategyProfileId, patch: Partial<HeuristicV2Weights>): HeuristicV2Weights {
  return { ...BASE_HEURISTIC_V2_PROFILES["heuristic-v2"], ...patch, id, strategy };
}

export const HEURISTIC_V2_PROFILES: Record<HeuristicV2ProfileId, HeuristicV2Weights> = {
  ...BASE_HEURISTIC_V2_PROFILES,
  "heuristic-v2-serve": strategyProfile("heuristic-v2-serve", "serve", {
    futureServeValue: 1.35,
    futureAttackValue: 1.08,
    setupEventValue: 1.08,
    deployFuturePenalty: 0.9,
    freeActionThreshold: 1,
    gateAcceptThreshold: 0.6,
  }),
  "heuristic-v2-block": strategyProfile("heuristic-v2-block", "block", {
    futureServeValue: 0.9,
    futureBlockValue: 1.65,
    futureDefenseValue: 0.95,
    futureAttackValue: 0.92,
    setupEventValue: 1.12,
    blockSideCost: 0.55,
    blockExcessCost: 0.75,
    deployFuturePenalty: 0.9,
    skillValue: 1.12,
    actionValue: 1.02,
    costValue: 0.92,
    freeActionThreshold: 0.95,
    gateAcceptThreshold: 0.45,
    defenseBias: 1.08,
    blockChoiceBias: 6,
    blockTimingValue: 1.45,
    blockActionValue: 1.6,
    blockSideFutureCost: 0.45,
    blockCenterFutureCost: 1.35,
    blockDeployCountCost: 0.55,
  }),
  "heuristic-v2-burst": strategyProfile("heuristic-v2-burst", "burst", {
    futureEventValue: 1.1,
    futureAttackValue: 1.35,
    setupEventValue: 1.12,
    deployFuturePenalty: 0.85,
    freeActionThreshold: 0.95,
    gateAcceptThreshold: 0.55,
  }),
  "heuristic-v2-defense": strategyProfile("heuristic-v2-defense", "defense", {
    futureBlockValue: 1.18,
    futureDefenseValue: 1.35,
    coverageValue: 1.1,
    blockChoiceBias: 1.2,
    defenseBias: 1.25,
    freeActionThreshold: 1.15,
  }),
  "heuristic-v2-hybrid": strategyProfile("heuristic-v2-hybrid", "hybrid", {
    futureEventValue: 1.02,
    futureServeValue: 1.05,
    futureBlockValue: 1.05,
    futureDefenseValue: 1.08,
    futureAttackValue: 1.08,
    coverageValue: 1.12,
  }),
  "heuristic-v2-personality": strategyProfile("heuristic-v2-personality", "hybrid", {
    futureEventValue: 1.02,
    futureServeValue: 1.05,
    futureBlockValue: 1.05,
    futureDefenseValue: 1.08,
    futureAttackValue: 1.08,
    coverageValue: 1.12,
  }),
};

function profileOf(profile: HeuristicV2ProfileId | HeuristicV2Weights = "heuristic-v2"): HeuristicV2Weights {
  return typeof profile === "string" ? HEURISTIC_V2_PROFILES[profile] : profile;
}

export function isHeuristicV2ProfileId(id: string): id is HeuristicV2ProfileId {
  return id in HEURISTIC_V2_PROFILES;
}

export function heuristicProfileForDeckAxes(axes: readonly string[] | undefined): HeuristicV2ProfileId {
  const set = new Set(axes ?? []);
  if (set.has("block")) return "heuristic-v2-block";
  if (set.has("serve")) return "heuristic-v2-serve";
  if (set.has("burst")) return "heuristic-v2-burst";
  if (set.has("defense")) return "heuristic-v2-defense";
  return "heuristic-v2-hybrid";
}

export function heuristicProfileForDeckText(text: string): HeuristicV2ProfileId {
  if (/攔網|ブロック|block/i.test(text)) return "heuristic-v2-block";
  if (/發球|サーブ|serve/i.test(text)) return "heuristic-v2-serve";
  if (/爆發|攻擊|快攻|burst|attack/i.test(text)) return "heuristic-v2-burst";
  if (/防守|接球|垃圾場|defense|receive/i.test(text)) return "heuristic-v2-defense";
  return "heuristic-v2-hybrid";
}

const AREAS: Area[] = ["serve", "block", "receive", "toss", "attack"];
const PHASE_PARAM: Partial<Record<GameState["phase"], ParamName>> = {
  serve: "serve",
  block: "block",
  receive: "receive",
  toss: "toss",
  attack: "attack",
};
const TIMING_LABEL: Record<ParamName, string> = {
  serve: "發球",
  block: "攔網",
  receive: "接球",
  toss: "舉球",
  attack: "攻擊",
};
const PHASE_TIMING_LABEL: Record<string, string> = { ...TIMING_LABEL, draw: "抽牌" };

function other(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

function cardOf(db: CardDb, state: GameState, uid: number): Card {
  return db.get(state.cards[uid]!)!;
}

function effectOf(card: Card): EffectDef | null {
  const effect = card.effect as EffectDef | null;
  return effect && Array.isArray(effect.skills) ? effect : null;
}

function skillOf(card: Card, index: number): SkillDef | null {
  return effectOf(card)?.skills[index] ?? null;
}

function directlyGrantsOneTouch(db: CardDb, state: GameState, p: PlayerId, action: Action): boolean {
  if (action.op === "keyword") return action.name === "ワンタッチ";
  if (action.op !== "gate" || (action.costs?.length ?? 0) > 0 || conditionWeight(db, state, p, action.cond) !== 1) return false;
  return action.then.some((child) => child.op === "keyword" && child.name === "ワンタッチ");
}

/**
 * 當前登場後可無條件立即解決 One Touch 的攔網手。
 *
 * 刻意排除鷲尾 P01-051 這類「棄牌組頂後再判定所屬」的機率路線：
 * 快速 AI 不能把不確定觸發當成必定跳過攔網判定。
 */
export function isImmediateOneTouchBlocker(db: CardDb, state: GameState, p: PlayerId, uid: number): boolean {
  if (isSkillInvalid(db, state, p, uid)) return false;
  if (
    state.restrictions.some(
      (restriction) =>
        restriction.player === p &&
        restriction.banOneTouch &&
        restriction.setNo === state.setNo &&
        restriction.activeTurn === state.turnNo,
    )
  ) return false;
  const effect = effectOf(cardOf(db, state, uid));
  return !!effect?.skills.some(
    (skill) =>
      skill.kind === "passive" &&
      skill.trigger.on === "deploy" &&
      (!skill.areaIcons || skill.areaIcons.includes("block")) &&
      "actions" in skill &&
      skill.actions.some((action) => directlyGrantsOneTouch(db, state, p, action)),
  );
}

function paramOf(db: CardDb, state: GameState, uid: number, area: Area): number {
  return cardOf(db, state, uid).params?.[area] ?? 0;
}

function effParamOf(db: CardDb, state: GameState, uid: number, area: Area): number {
  return effParam(db, state, uid, area) ?? paramOf(db, state, uid, area);
}

function currentNeed(state: GameState): ParamName | null {
  return PHASE_PARAM[state.phase] ?? null;
}

/** 對手打過來的 OP 值（不存在時視為 0）。 */
function incomingOp(state: GameState, me: PlayerId): number {
  return state.op && state.op.owner !== me ? state.op.value : 0;
}

function deckRisk(state: GameState, p: PlayerId, weights: HeuristicV2Weights): number {
  const left = state.players[p].deck.length;
  if (left <= 4) return 1.4 * weights.deckRisk;
  if (left <= 8) return 0.7 * weights.deckRisk;
  return 0;
}

function phaseParamDemand(state: GameState, p: PlayerId, param: ParamName, weights: HeuristicV2Weights): number {
  const need = currentNeed(state);
  const bias = param === "receive" || param === "block" ? weights.defenseBias : 1;
  if (need === param) {
    if ((param === "receive" || param === "block") && incomingOp(state, p) >= 4) return 3.2 * bias;
    return 2.4 * bias;
  }
  if (state.phase === "start" && (param === "receive" || param === "block")) return 1.9 * bias;
  if (state.phase === "toss" && param === "attack") return 1.6;
  if (state.phase === "receive" && param === "toss") return 1.25;
  return 0.75 * bias;
}

function timingMatches(card: Card, param: ParamName): boolean {
  if (card.timing.some((x) => x.includes(TIMING_LABEL[param]))) return true;
  const eff = effectOf(card);
  if (!eff) return false;
  return eff.skills.some((s) => {
    if ("phaseIcons" in s && s.phaseIcons?.includes(param)) return true;
    if ("areaIcons" in s && s.areaIcons?.includes(param)) return true;
    return false;
  });
}

function phaseTimingMatches(card: Card, phase: string): boolean {
  const label = PHASE_TIMING_LABEL[phase];
  if (label && card.timing.some((x) => x.includes(label))) return true;
  const eff = effectOf(card);
  if (!eff) return false;
  return eff.skills.some((s) => "phaseIcons" in s && s.phaseIcons?.includes(phase as PhaseIcon));
}

function skillBonus(card: Card, weights: HeuristicV2Weights, param?: ParamName): number {
  if (card.effectStatus === "vanilla" || card.effectStatus === "todo") return 0;
  let bonus = card.effectStatus === "script" ? 0.9 : 0.55;
  if (param && timingMatches(card, param)) bonus += 0.55 * (param === "block" ? weights.blockTimingValue : 1);
  if (card.skillJa?.includes("[=ターン1]")) bonus += 0.25;
  return bonus * weights.skillValue;
}

/** 卡片留在手牌中的未來價值；成本/棄牌時挑低分，檢索/回收時挑高分。 */
function futureCardValue(db: CardDb, state: GameState, p: PlayerId, uid: number, weights: HeuristicV2Weights): number {
  const card = cardOf(db, state, uid);
  if (card.type === "EVENT") {
    const phase = currentNeed(state);
    const timing = phase && timingMatches(card, phase) ? 1.4 : 0;
    return (3.1 + timing + skillBonus(card, weights)) * weights.futureEventValue;
  }
  if (!card.params) return 0;
  const serve = card.params.serve ?? 0;
  const receive = card.params.receive ?? 0;
  const toss = card.params.toss ?? 0;
  const attack = card.params.attack ?? 0;
  const block = card.params.block ?? 0;
  const coverage = AREAS.filter((a) => card.params?.[a] !== null && (card.params?.[a] ?? 0) > 0).length * 0.35 * weights.coverageValue;
  const pressure = incomingOp(state, p) >= 4 ? (receive * 0.25 + block * 0.18) * weights.defenseBias : 0;
  return (
    serve * 0.7 * weights.futureServeValue +
    receive * 1.05 * weights.futureDefenseValue +
    toss * 0.8 +
    attack * 0.95 * weights.futureAttackValue +
    block * 0.85 * weights.futureBlockValue +
    coverage +
    pressure +
    skillBonus(card, weights)
  );
}

function setupCardValue(db: CardDb, state: GameState, p: PlayerId, uid: number, serving: boolean, weights: HeuristicV2Weights): number {
  const card = cardOf(db, state, uid);
  if (card.type === "EVENT") {
    const usefulEarly = serving
      ? timingMatches(card, "serve") || timingMatches(card, "attack")
      : timingMatches(card, "receive") || timingMatches(card, "block") || timingMatches(card, "toss");
    return (usefulEarly ? 5.2 + skillBonus(card, weights) : 2.6 + skillBonus(card, weights) * 0.5) * weights.setupEventValue;
  }
  const pms = card.params;
  if (!pms) return 0;
  const serve = pms.serve ?? 0;
  const receive = pms.receive ?? 0;
  const toss = pms.toss ?? 0;
  const attack = pms.attack ?? 0;
  const block = pms.block ?? 0;
  const coverage = AREAS.filter((a) => pms[a] !== null && (pms[a] ?? 0) > 0).length * 0.45 * weights.coverageValue;
  const role = serving
    ? serve * 2.2 * weights.futureServeValue + attack * 1.35 * weights.futureAttackValue + receive * 1.1 * weights.futureDefenseValue + block * 0.8 * weights.futureBlockValue + toss * 0.75
    : receive * 2.25 * weights.futureDefenseValue + block * 1.25 * weights.futureBlockValue + attack * 1.15 * weights.futureAttackValue + toss * 1.0 + serve * 0.65 * weights.futureServeValue;
  return role + coverage + skillBonus(card, weights, serving ? "serve" : "receive");
}

function candidateNamesForUid(db: CardDb, state: GameState, uid: number): string[] {
  const names = deployNames(db, state, uid);
  if (names && names.length > 0) return names.map(normName);
  return [normName(cardOf(db, state, uid).nameJa)];
}

function canPairNames(namesA: readonly string[], namesB: readonly string[]): boolean {
  for (const a of namesA) {
    for (const b of namesB) {
      if (a !== b) return true;
    }
  }
  return false;
}

function actionsContainOp(actions: readonly Action[] | undefined, ops: ReadonlySet<Action["op"]>, includeIf = true): boolean {
  for (const act of actions ?? []) {
    if (ops.has(act.op)) return true;
    if (act.op === "gate" && actionsContainOp(act.then, ops, includeIf)) return true;
    if (includeIf && act.op === "if" && actionsContainOp(act.then, ops, includeIf)) return true;
    if (act.op === "chooseOne" && act.options.some((o) => actionsContainOp(o.actions, ops, includeIf))) return true;
  }
  return false;
}

const TUTOR_OPS: ReadonlySet<Action["op"]> = new Set(["lookTopTutor", "revealTopTutor", "lookTopTwoPick"]);
const DRAW_OPS: ReadonlySet<Action["op"]> = new Set(["draw", "drawToHandSize"]);
const DROP_DEPEND_OPS: ReadonlySet<Action["op"]> = new Set(["dropToHand", "deployFromDrop", "dropToGuts", "dropToEventArea"]);
const CUMULATIVE_RETURN_EV = [0, 10.5, 20.7, 30.3, 38.5, 45.0, 49.0] as const;

function hasAttackDeployBoost(card: Card): boolean {
  const eff = effectOf(card);
  if (!eff) return false;
  return eff.skills.some(
    (s) =>
      s.kind === "passive" &&
      s.trigger.on === "deploy" &&
      s.areaIcons?.includes("attack") &&
      actionsContainOp(s.actions, new Set(["addParam", "setParam"])),
  );
}

function classifyOpeningEvent(card: Card, serving: boolean): "tutor" | "early-draw-defense" | "dead" | "other" {
  const eff = effectOf(card);
  if (!eff) return "other";
  const playableEarly =
    phaseTimingMatches(card, "draw") ||
    timingMatches(card, "receive") ||
    timingMatches(card, "block") ||
    (serving && timingMatches(card, "serve"));

  const hasTutor = eff.skills.some((s) => "actions" in s && actionsContainOp(s.actions, TUTOR_OPS));
  if (hasTutor && playableEarly) return "tutor";

  const hasDraw = eff.skills.some((s) => "actions" in s && actionsContainOp(s.actions, DRAW_OPS));
  const hasDropDepend = eff.skills.some((s) => "actions" in s && actionsContainOp(s.actions, DROP_DEPEND_OPS));
  if (hasDropDepend && !hasDraw && !hasTutor) return "dead";

  if (hasDraw && playableEarly) return "early-draw-defense";
  return "other";
}

interface MulliganCharaInfo {
  uid: number;
  card: Card;
  names: string[];
  primaryName: string;
  s: number;
  b: number;
  r: number;
  t: number;
  a: number;
  isLowVanillaAttacker: boolean;
}

/**
 * [Gemini 2026-11-17] Phase M1：評估起手保留子集 `keptUids`（搭配換掉 `hand.length - keptUids.length` 張牌的補位期望）之組合價值。
 * - 先接球追求「接 (R>=4) + 舉 (T>=1) + 異名攻 (A>=2)」三件套；先發球兼顧強發球手 (S>=4) 與防反三件套。
 * - 對同名重複角色施加冗餘懲罰，並在缺件時果斷換掉多餘同位置卡與卡手事件（最多可換 4～5 張）。
 */
export function scoreMulliganHand(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  keptUids: readonly number[],
  profile: HeuristicV2ProfileId | HeuristicV2Weights = "heuristic-v2",
): number {
  const weights = profileOf(profile);
  const hand = state.players[p].hand;
  const serving = p === state.servingPlayer;
  const returnCount = Math.max(0, hand.length - keptUids.length);
  const drawEv = 10.0 - weights.mulliganReturnDelta * 0.35 + weights.mulliganWeakDelta * 0.5;

  const charas: MulliganCharaInfo[] = [];
  const events: Card[] = [];

  for (const uid of keptUids) {
    const card = cardOf(db, state, uid);
    if (card.type === "CHARACTER" && card.params) {
      const s = card.params.serve ?? 0;
      const b = card.params.block ?? 0;
      const r = card.params.receive ?? 0;
      const t = card.params.toss ?? 0;
      const a = card.params.attack ?? 0;
      const isLowVanillaAttacker =
        a === 2 && r < 4 && s < 4 && b < 3 && t === 0 && (card.effectStatus === "vanilla" || card.effectStatus === "todo");
      charas.push({
        uid,
        card,
        names: candidateNamesForUid(db, state, uid),
        primaryName: normName(card.nameJa),
        s,
        b,
        r,
        t,
        a,
        isLowVanillaAttacker,
      });
    } else if (card.type === "EVENT") {
      events.push(card);
    }
  }

  const rCandidates: (MulliganCharaInfo | null)[] = [null, ...charas.filter((c) => c.r >= 4)];
  const tCandidates: (MulliganCharaInfo | null)[] = [null, ...charas.filter((c) => c.t >= 1)];
  const aCandidates: (MulliganCharaInfo | null)[] = [null, ...charas.filter((c) => c.a >= 2 && !c.isLowVanillaAttacker)];

  let bestChainScore = -Infinity;
  let bestAssignment: {
    uR: MulliganCharaInfo | null;
    uT: MulliganCharaInfo | null;
    uA: MulliganCharaInfo | null;
    rolesFilled: number;
  } = { uR: null, uT: null, uA: null, rolesFilled: 0 };

  for (const uR of rCandidates) {
    for (const uT of tCandidates) {
      if (uR && uT && (uR.uid === uT.uid || !canPairNames(uR.names, uT.names))) continue;
      for (const uA of aCandidates) {
        if (uA && ((uR && uA.uid === uR.uid) || (uT && uA.uid === uT.uid))) continue;
        if (uT && uA && !canPairNames(uT.names, uA.names)) continue;
        // 註：規則僅限制 トス≠レシーブ 與 アタック≠トス，レシーブ與アタック可為同名不同張卡（如 R5 岩泉 → T2 及川 → A3 岩泉）；
        // 若異名則給予微幅加成以保留場上彈性。
        const distinctRA = !uR || !uA || canPairNames(uR.names, uA.names);

        let score = 0;
        let rolesFilled = 0;
        if (uR) {
          rolesFilled++;
          score +=
            14.2 +
            (uR.r - 4) * 2.4 * weights.futureDefenseValue +
            skillBonus(uR.card, weights, "receive") * 1.1 +
            (uR.b >= 3 ? 0.8 * weights.futureBlockValue : 0) +
            (serving && uR.s >= 4 ? 1.5 * weights.futureServeValue : 0);
        }
        if (uT) {
          rolesFilled++;
          const isTrueSetter =
            uT.card.positions.includes("S") || uT.t >= 2 || timingMatches(uT.card, "toss") || uT.r >= 3;
          score +=
            (isTrueSetter ? 16.6 : 12.2) +
            (uT.t - 1) * 2.8 +
            (uT.card.positions.includes("S") ? 1.8 : 0) +
            skillBonus(uT.card, weights, "toss") * 1.4 +
            (serving && uT.s >= 4 ? 1.8 * weights.futureServeValue : 0);
        }
        if (uA) {
          rolesFilled++;
          score +=
            14.0 +
            (uA.a - 2) * 2.6 * weights.futureAttackValue +
            skillBonus(uA.card, weights, "attack") * 1.3 +
            (serving && uA.s >= 4 ? 1.5 * weights.futureServeValue : 0) +
            (uA.r >= 4 ? 1.0 * weights.futureDefenseValue : 0);
        }

        if (distinctRA && uR && uA) score += 0.6;

        if (rolesFilled === 3) {
          score += 20.0 + (uR!.r >= 5 ? 1.5 : 0) + (uT!.t + uA!.a >= 4 ? 1.5 : 0);
        } else if (rolesFilled === 2) {
          score += 6.5;
        } else if (rolesFilled === 1) {
          score += 1.5;
        }

        if (score > bestChainScore) {
          bestChainScore = score;
          bestAssignment = { uR, uT, uA, rolesFilled };
        }
      }
    }
  }

  const { uR, uT, uA, rolesFilled } = bestAssignment;
  const assignedUids = new Set<number>();
  const nameCounts = new Map<string, number>();
  for (const assigned of [uR, uT, uA]) {
    if (assigned) {
      assignedUids.add(assigned.uid);
      nameCounts.set(assigned.primaryName, (nameCounts.get(assigned.primaryName) ?? 0) + 1);
    }
  }

  let totalScore = bestChainScore + returnCount * drawEv;
  if (keptUids.length === 0) totalScore -= 2.5;

  // 先發球時，優先確保 1 張強發球手 (S >= 4)
  if (serving) {
    const assignedHasServe4 = (uR && uR.s >= 4) || (uT && uT.s >= 4) || (uA && uA.s >= 4);
    const serveCandidates = charas
      .filter(
        (c) =>
          !assignedUids.has(c.uid) &&
          !nameCounts.has(c.primaryName) &&
          (c.s >= 4 || (c.s >= 3 && timingMatches(c.card, "serve"))),
      )
      .sort((a, b) => b.s + skillBonus(b.card, weights, "serve") - (a.s + skillBonus(a.card, weights, "serve")));
    const bestS = serveCandidates[0];
    if (bestS && (!assignedHasServe4 || rolesFilled === 3)) {
      assignedUids.add(bestS.uid);
      nameCounts.set(bestS.primaryName, (nameCounts.get(bestS.primaryName) ?? 0) + 1);
      totalScore +=
        (assignedHasServe4 ? 12.0 : 13.8) +
        Math.max(0, bestS.s - 4) * 1.8 * weights.futureServeValue +
        skillBonus(bestS.card, weights, "serve") * 1.2;
    }
  }

  // 評估其餘未指派角色
  let keptComboAttacker = false;
  for (const c of charas) {
    if (assignedUids.has(c.uid)) continue;
    const prevCount = nameCounts.get(c.primaryName) ?? 0;
    nameCounts.set(c.primaryName, prevCount + 1);

    if (rolesFilled < 3) {
      // 若缺攻擊手但手上有與舉球手連動的低基數強攻手（如木葉 T1 + 猿杙 A1+4），保留 1 張保底進攻線，其餘換掉找正編 A>=2
      if (
        !keptComboAttacker &&
        prevCount === 0 &&
        uA === null &&
        uT !== null &&
        hasAttackDeployBoost(c.card)
      ) {
        keptComboAttacker = true;
        totalScore += 10.3;
      } else {
        // 尚未湊齊 R+T+A 三件套時：所有同名重複與多餘同位置角色一律換掉，最大化補齊三件套的抽牌數
        totalScore += prevCount > 0 ? 1.5 : 5.2;
      }
    } else {
      // 已湊齊 R+T+A 三件套時：
      // 1. 淘汰第 3 張同名、第 2 張同名舉球手、第 2 張純自由球員／低覆蓋同名卡、以及低效香草卡
      const isDupSetter = uT !== null && c.primaryName === uT.primaryName;
      const isPureSecondSetter = c.t >= 1 && c.r < 3 && c.a < 2 && c.b < 3 && c.s < 4;
      const isPureReceiverOrLowDup =
        prevCount > 0 &&
        (c.card.params?.serve === null ||
          (c.a === 0 && c.b === 0) ||
          (c.r <= 4 && c.a <= 2 && c.b <= 2 && c.s <= 2));
      if (prevCount >= 2 || isDupSetter || isPureSecondSetter || isPureReceiverOrLowDup || c.isLowVanillaAttacker) {
        totalScore += 2.0;
      } else {
        const singleVal = setupCardValue(db, state, p, c.uid, serving, weights);
        const hasGoodRole =
          c.r >= 3 || c.b >= 3 || c.a >= 2 || c.s >= 4 || hasAttackDeployBoost(c.card) || c.card.effectStatus !== "vanilla";
        totalScore += hasGoodRole && singleVal >= 5.0 ? 10.6 + Math.min(1.8, singleVal * 0.1) : 5.5;
      }
    }
  }

  // 評估事件卡（缺件時優先換牌抽角色以補齊三件套；僅在已齊備或先接只缺 1 環時留 1 張檢索／防守抽濾事件）
  let keptGoodEvent = false;
  const seenEventNames = new Set<string>();
  for (const ev of events) {
    const evName = normName(ev.nameJa);
    if (seenEventNames.has(evName) || keptGoodEvent) {
      totalScore += 2.0;
      continue;
    }
    seenEventNames.add(evName);
    const kind = classifyOpeningEvent(ev, serving);
    if (kind === "dead") {
      totalScore += 1.5;
    } else if (kind === "tutor") {
      if (rolesFilled === 3 || (!serving && rolesFilled === 2)) {
        keptGoodEvent = true;
        totalScore += 10.9 * weights.setupEventValue;
      } else {
        totalScore += 6.8;
      }
    } else if (kind === "early-draw-defense") {
      if (rolesFilled === 3) {
        keptGoodEvent = true;
        totalScore += 10.5 * weights.setupEventValue;
      } else {
        totalScore += 6.0;
      }
    } else {
      totalScore += rolesFilled === 3 && serving && timingMatches(ev, "serve") ? 10.3 * weights.setupEventValue : 2.5;
    }
  }

  // 微量位置偏好：同名卡優先保留在手牌前段（使回傳的 returnUids 穩定挑後段重複卡）
  for (let i = 0; i < hand.length; i++) {
    if (keptUids.includes(hand[i]!)) {
      totalScore += (hand.length - i) * 0.001;
    }
  }

  return totalScore;
}

function chooseMulligan(db: CardDb, state: GameState, p: PlayerId, weights: HeuristicV2Weights): number[] {
  const hand = state.players[p].hand;
  const n = hand.length;
  let bestScore = -Infinity;
  let bestReturns: number[] = [];

  const totalMasks = 1 << n;
  for (let mask = 0; mask < totalMasks; mask++) {
    const keptUids: number[] = [];
    const returnUids: number[] = [];
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0) keptUids.push(hand[i]!);
      else returnUids.push(hand[i]!);
    }
    const score = scoreMulliganHand(db, state, p, keptUids, weights);
    if (score > bestScore) {
      bestScore = score;
      bestReturns = returnUids;
    }
  }

  return bestReturns;
}

function nameForBlock(db: CardDb, state: GameState, p: PlayerId, uid: number, used: Set<string>): string | null {
  const choice = pickDeployName(db, state, p, uid, "block", used);
  const name = choice ?? cardOf(db, state, uid).nameJa;
  const key = name.trim().toLowerCase();
  return used.has(key) ? null : name;
}

export interface BlockPlan {
  uids: number[];
  center: number;
  nameChoices: Record<number, string>;
  dp: number;
  cost: number;
}

function blockPlanCost(db: CardDb, state: GameState, p: PlayerId, uids: number[], center: number, op: number, weights: HeuristicV2Weights): number {
  const excess = Math.max(0, uids.reduce((sum, uid) => sum + paramOf(db, state, uid, "block"), 0) - op);
  const sideCost = uids.filter((uid) => uid !== center).reduce((sum, uid) => sum + futureCardValue(db, state, p, uid, weights), 0);
  const centerCost = futureCardValue(db, state, p, center, weights) * 0.15 * weights.blockCenterFutureCost;
  return sideCost * weights.blockSideCost * weights.blockSideFutureCost + centerCost + excess * 0.45 * weights.blockExcessCost + uids.length * 0.35 * weights.blockDeployCountCost;
}

export function bestBlockPlan(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  minDp: number,
  profile: HeuristicV2ProfileId | HeuristicV2Weights = "heuristic-v2",
): BlockPlan | null {
  const weights = profileOf(profile);
  const maxN = Math.min(3, blockDeployMax(state, p));
  if (maxN <= 0) return null;
  const deployable = deployableUids(db, state, p, "block");
  const oneTouch = deployable
    .filter((uid) => isImmediateOneTouchBlocker(db, state, p, uid))
    .sort((a, b) => futureCardValue(db, state, p, b, weights) - futureCardValue(db, state, p, a, weights))[0];
  if (oneTouch !== undefined) {
    const name = nameForBlock(db, state, p, oneTouch, new Set());
    if (name) {
      const nameChoices = name !== cardOf(db, state, oneTouch).nameJa ? { [oneTouch]: name } : {};
      return {
        uids: [oneTouch],
        center: oneTouch,
        nameChoices,
        dp: paramOf(db, state, oneTouch, "block"),
        cost: blockPlanCost(db, state, p, [oneTouch], oneTouch, minDp, weights),
      };
    }
  }
  const pool = deployable
    .slice()
    .sort((a, b) => paramOf(db, state, b, "block") - paramOf(db, state, a, "block"))
    .slice(0, 8);
  let best: BlockPlan | null = null;

  const visit = (start: number, chosen: number[], used: Set<string>, nameChoices: Record<number, string>) => {
    if (chosen.length > 0) {
      const dp = chosen.reduce((sum, uid) => sum + paramOf(db, state, uid, "block"), 0);
      if (dp >= minDp) {
        const center = chosen.reduce((a, b) => (futureCardValue(db, state, p, a, weights) >= futureCardValue(db, state, p, b, weights) ? a : b));
        const cost = blockPlanCost(db, state, p, chosen, center, minDp, weights);
        if (!best || cost < best.cost) best = { uids: [...chosen], center, nameChoices: { ...nameChoices }, dp, cost };
      }
    }
    if (chosen.length >= maxN) return;
    for (let i = start; i < pool.length; i++) {
      const uid = pool[i]!;
      const name = nameForBlock(db, state, p, uid, used);
      if (!name) continue;
      const key = name.trim().toLowerCase();
      used.add(key);
      chosen.push(uid);
      const nextChoices = { ...nameChoices };
      if (name !== cardOf(db, state, uid).nameJa) nextChoices[uid] = name;
      visit(i + 1, chosen, used, nextChoices);
      chosen.pop();
      used.delete(key);
    }
  };

  visit(0, [], new Set(), {});
  return best;
}

interface NextSetCoreProtection {
  protectedUids: Set<number>;
  protectedNames: Set<string>;
  rolesFilled: number;
  hasSetter: boolean;
}

function findNextSetCoreProtection(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  weights: HeuristicV2Weights,
): NextSetCoreProtection {
  const hand = state.players[p].hand;
  const charas: MulliganCharaInfo[] = [];
  const nameTotalCounts = new Map<string, number>();

  for (const uid of hand) {
    const card = cardOf(db, state, uid);
    if (card.type === "CHARACTER" && card.params) {
      const s = card.params.serve ?? 0;
      const b = card.params.block ?? 0;
      const r = card.params.receive ?? 0;
      const t = card.params.toss ?? 0;
      const a = card.params.attack ?? 0;
      const isLowVanillaAttacker =
        a === 2 && r < 4 && s < 4 && b < 3 && t === 0 && (card.effectStatus === "vanilla" || card.effectStatus === "todo");
      const primaryName = normName(card.nameJa);
      nameTotalCounts.set(primaryName, (nameTotalCounts.get(primaryName) ?? 0) + 1);
      charas.push({
        uid,
        card,
        names: candidateNamesForUid(db, state, uid),
        primaryName,
        s,
        b,
        r,
        t,
        a,
        isLowVanillaAttacker,
      });
    }
  }

  const rCandidates: (MulliganCharaInfo | null)[] = [null, ...charas.filter((c) => c.r >= 4)];
  const tCandidates: (MulliganCharaInfo | null)[] = [null, ...charas.filter((c) => c.t >= 1)];
  const aCandidates: (MulliganCharaInfo | null)[] = [
    null,
    ...charas.filter((c) => (c.a >= 2 || hasAttackDeployBoost(c.card)) && !c.isLowVanillaAttacker),
  ];

  let bestScore = -Infinity;
  let bestAssignment: {
    uR: MulliganCharaInfo | null;
    uT: MulliganCharaInfo | null;
    uA: MulliganCharaInfo | null;
    rolesFilled: number;
  } = { uR: null, uT: null, uA: null, rolesFilled: 0 };

  for (const uR of rCandidates) {
    for (const uT of tCandidates) {
      if (uR && uT && (uR.uid === uT.uid || !canPairNames(uR.names, uT.names))) continue;
      for (const uA of aCandidates) {
        if (uA && ((uR && uA.uid === uR.uid) || (uT && uA.uid === uT.uid))) continue;
        if (uT && uA && !canPairNames(uT.names, uA.names)) continue;
        const distinctRA = !uR || !uA || canPairNames(uR.names, uA.names);

        let score = 0;
        let rolesFilled = 0;
        if (uR) {
          rolesFilled++;
          score +=
            14.2 +
            (uR.r - 4) * 2.5 * weights.futureDefenseValue +
            skillBonus(uR.card, weights, "receive") * 1.1 +
            (uR.b >= 3 ? 0.8 * weights.futureBlockValue : 0);
        }
        if (uT) {
          rolesFilled++;
          const isTrueSetter =
            uT.card.positions.includes("S") || uT.t >= 2 || timingMatches(uT.card, "toss") || uT.r >= 3;
          score +=
            (isTrueSetter ? 16.6 : 12.2) +
            (uT.t - 1) * 2.8 +
            (uT.card.positions.includes("S") ? 1.8 : 0) +
            skillBonus(uT.card, weights, "toss") * 1.4;
        }
        if (uA) {
          rolesFilled++;
          const effAtk = hasAttackDeployBoost(uA.card) ? Math.max(uA.a, 3) : uA.a;
          score +=
            14.0 +
            (effAtk - 2) * 2.6 * weights.futureAttackValue +
            skillBonus(uA.card, weights, "attack") * 1.3 +
            (uA.r >= 4 ? 1.0 * weights.futureDefenseValue : 0);
        }
        if (distinctRA && uR && uA) score += 0.6;
        if (rolesFilled === 3) score += 20.0;
        else if (rolesFilled === 2) score += 6.5;
        else if (rolesFilled === 1) score += 1.5;

        if (score > bestScore) {
          bestScore = score;
          bestAssignment = { uR, uT, uA, rolesFilled };
        }
      }
    }
  }

  const protectedUids = new Set<number>();
  const protectedNames = new Set<string>();
  for (const assigned of [bestAssignment.uR, bestAssignment.uT, bestAssignment.uA]) {
    if (assigned) {
      protectedUids.add(assigned.uid);
      protectedNames.add(assigned.primaryName);
    }
  }

  // 若無正編 A>=2 攻擊手，保護 1 張低基數連動強攻手或 A>=2 香草卡避免斷攻
  if (!bestAssignment.uA) {
    const fallbackAtk = charas
      .filter((c) => !protectedUids.has(c.uid) && (c.a >= 2 || hasAttackDeployBoost(c.card)))
      .sort((a, b) => b.a - a.a)[0];
    if (fallbackAtk) {
      protectedUids.add(fallbackAtk.uid);
      protectedNames.add(fallbackAtk.primaryName);
    }
  }

  for (const c of charas) {
    if (protectedUids.has(c.uid)) continue;
    // 保護立即 One Touch 攔網手與手牌發動技能卡（如茂庭 PR、山本 PR 後排攻擊等 [=手札] 技能卡）
    const hasHandSkill =
      c.card.skillJa?.includes("[=手札]") ||
      effectOf(c.card)?.skills.some((s) => "areaIcons" in s && s.areaIcons?.includes("hand"));
    if (isImmediateOneTouchBlocker(db, state, p, c.uid) || hasHandSkill) {
      protectedUids.add(c.uid);
      protectedNames.add(c.primaryName);
      continue;
    }
    // 保護非同名重複的高接球主力 (R >= 5)
    if (c.r >= 5 && !protectedNames.has(c.primaryName)) {
      protectedUids.add(c.uid);
      protectedNames.add(c.primaryName);
      continue;
    }
    // 當手牌僅 5 張且已湊齊三件套時，若第 4、5 張為非同名重複的高價值攻守兼備主力 (R>=4 且 A>=3 或 B>=3 或 T>=1)，予以保護（改走接球抽 1）
    if (
      hand.length <= 5 &&
      bestAssignment.rolesFilled === 3 &&
      !protectedNames.has(c.primaryName) &&
      (nameTotalCounts.get(c.primaryName) ?? 0) === 1 &&
      c.r >= 4 &&
      (c.a >= 3 || c.b >= 3 || c.t >= 1)
    ) {
      protectedUids.add(c.uid);
      protectedNames.add(c.primaryName);
    }
  }

  return {
    protectedUids,
    protectedNames,
    rolesFilled: bestAssignment.rolesFilled,
    hasSetter: bestAssignment.uT !== null,
  };
}

function hasDropRecoverySynergy(db: CardDb, state: GameState, p: PlayerId): boolean {
  const ps = state.players[p];
  const visibleUids = [
    ...ps.hand,
    ...ps.eventArea,
    ...charasOf(state, p).map((c) => c.uid),
  ];
  for (const uid of visibleUids) {
    const eff = effectOf(cardOf(db, state, uid));
    if (eff?.skills.some((s) => "actions" in s && actionsContainOp(s.actions, DROP_DEPEND_OPS))) {
      return true;
    }
  }
  return false;
}

/**
 * [Gemini 2026-11-18] Phase M2：評估手牌中的角色 `uid` 在必敗防守局是否適合透過攔網登場濾除（換取 Interval 補牌＋留 Guts／堆棄牌）。
 * - 正分（> 0）：代表值得濾除的同名冗餘卡、下局先接球用不到的低接球／次要角色、或跨 Set 墓地／Guts 預備卡。
 * - 負分（<= 0）：代表下個 Set 的接舉攻核心主力或唯一防守強卡，嚴禁當廢牌消耗。
 */
export function cyclingCandidateScore(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  uid: number,
  profile: HeuristicV2ProfileId | HeuristicV2Weights = "heuristic-v2",
): number {
  const weights = profileOf(profile);
  if (state.players[p].setArea.length === 0) return -100;
  const deployable = deployableUids(db, state, p, "block");
  if (!deployable.includes(uid)) return -100;

  const { protectedUids, protectedNames, rolesFilled, hasSetter } = findNextSetCoreProtection(db, state, p, weights);
  if (protectedUids.has(uid)) return -100;

  const card = cardOf(db, state, uid);
  if (card.type !== "CHARACTER" || !card.params || card.params.block === null) return -100;

  const hand = state.players[p].hand;
  const pName = normName(card.nameJa);
  let sameNameCount = 0;
  for (const u of hand) {
    if (normName(cardOf(db, state, u).nameJa) === pName) sameNameCount++;
  }

  const isDupName = protectedNames.has(pName) || sameNameCount >= 2;
  const r = card.params.receive ?? 0;
  const t = card.params.toss ?? 0;
  const a = card.params.attack ?? 0;

  // 高接球主力 (R >= 5)、非同名的攻守兼備主攻手 (R >= 3 且 A >= 3)、或 5 張手牌以內的非同名主力攻擊/舉球手，絕不當作廢牌消耗
  if (r >= 5) return -100;
  if (!isDupName && r >= 3 && a >= 3) return -100;
  if (!isDupName && hand.length <= 5 && (a >= 3 || hasAttackDeployBoost(card) || t >= 2)) return -100;

  let score = 0;
  if (isDupName) {
    score += 6.8 + Math.max(0, sameNameCount - 2) * 1.6;
  }
  if (t >= 1 && hasSetter) {
    score += 4.2;
  }
  if (card.effectStatus === "vanilla" || card.effectStatus === "todo") {
    score += 3.2;
  }
  if (rolesFilled < 3) {
    // 尚缺下個 Set 的接／舉／攻組件時，積極濾除未受保護的次要卡以最大化 Interval 補牌找齊三件套的機率
    if (r <= 3) score += 4.8 + (3 - r) * 0.6;
    else if (r === 4) score += 3.5;
  } else {
    // 已齊備下個 Set 的 R+T+A 三件套時：只濾除同名重複、低接球 (R<=2) 或低攻擊次要卡 (R=3, A<=2)
    if (r <= 2) {
      score += 4.2 + (2 - r) * 0.6;
    } else if (r === 3 && a <= 2) {
      score += 3.2;
    }
  }
  if (state.players[p].blockCenter.length === 0 && score > 0) {
    score += 0.8;
  }
  if (hasDropRecoverySynergy(db, state, p) && score > 0) {
    score += 1.2;
  }

  const fVal = futureCardValue(db, state, p, uid, weights);
  score -= fVal * 0.35;

  return score;
}

/**
 * [Gemini 2026-11-18] Phase M2：當確定無法守住當前攻擊 OP（接球與攔網皆無法過線）且非賽末點時，
 * 規劃登場 1～2 張可濾廢牌／同名冗餘卡進行戰術性攔網濾牌（使手牌降至 < 6 張以在 Interval 免費補新牌，並留中央 Guts／側邊進棄牌區）。
 */
export function bestTacticalLostBlockPlan(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  minDp: number,
  profile: HeuristicV2ProfileId | HeuristicV2Weights = "heuristic-v2",
): BlockPlan | null {
  const weights = profileOf(profile);
  // 對手 OP <= 5 時，選接球進 draw 階段抽 1 張有相當機率直接抽到 R>=OP 守住本局，故僅在 minDp >= 6（或已在 block 階段且必敗）時啟動必敗濾牌
  if (minDp <= 0) return null;
  if (state.phase !== "block" && minDp < 6) return null;
  // 賽末點禁區：Set 區剩 0 張時絕不走必敗濾牌
  if (state.players[p].setArea.length === 0) return null;
  const hand = state.players[p].hand;
  // 手牌 <= 4 張時，選接球抽 1 張後仍 <= 5 張，Interval 一樣能補滿 6 張，不需犧牲手牌攔網
  if (hand.length < 5) return null;
  const maxN = Math.min(2, blockDeployMax(state, p));
  if (maxN <= 0) return null;

  // 生存優先鐵則：只要攔網或接球有存活路線，絕不觸發戰術性必敗濾牌
  if (bestBlockPlan(db, state, p, minDp, weights) !== null) return null;
  if (state.phase !== "block" && chooseDeployUid(db, state, p, "receive", weights) !== null) return null;

  // 若手牌中的角色卡總數 <= 3 張（其餘為事件卡），不犧牲僅存的角色卡去攔網濾牌
  const charaCount = hand.filter((u) => cardOf(db, state, u).type === "CHARACTER").length;
  if (charaCount <= 3) return null;

  const { rolesFilled } = findNextSetCoreProtection(db, state, p, weights);
  const deployable = deployableUids(db, state, p, "block");
  const candidates = deployable
    .map((uid) => ({ uid, cycleScore: cyclingCandidateScore(db, state, p, uid, weights) }))
    .filter((x) => x.cycleScore > 0)
    .sort((a, b) => b.cycleScore - a.cycleScore);

  if (candidates.length === 0) return null;

  const dropSynergy = hasDropRecoverySynergy(db, state, p);
  let bestPlan: BlockPlan | null = null;
  let bestUtility = -Infinity;

  // 評估單張濾牌 (k = 1)
  for (const c1 of candidates) {
    if (hand.length - 1 >= 6) continue; // 確保登場後手牌 < 6 能觸發 Interval 補牌
    // 當手牌為 6 張時，單張攔網濾牌 (Interval 補 1) 與接球抽 1 的抽牌數相同，僅在該卡確屬高優先廢牌／同名卡或缺件時採用
    if (hand.length === 6 && c1.cycleScore < 2.2 && rolesFilled === 3) continue;
    const used = new Set<string>();
    const name1 = nameForBlock(db, state, p, c1.uid, used);
    if (!name1) continue;
    const dp = paramOf(db, state, c1.uid, "block");
    if (dp >= minDp) continue;
    const nameChoices: Record<number, string> = {};
    if (name1 !== cardOf(db, state, c1.uid).nameJa) nameChoices[c1.uid] = name1;
    const intervalDraws = Math.max(0, 6 - (hand.length - 1));
    // 手牌 5 張時，單張放中央攔網既能讓 Interval 補 2 張（比接球多看 1 張），又不會把第 2 張送進棄牌區耗損牌庫
    const fiveCardSingleBonus = hand.length === 5 ? 3.5 : 0;
    const utility = c1.cycleScore + intervalDraws * 2.5 + 1.5 + fiveCardSingleBonus;
    if (utility > bestUtility) {
      bestUtility = utility;
      bestPlan = {
        uids: [c1.uid],
        center: c1.uid,
        nameChoices,
        dp,
        cost: -utility,
      };
    }
  }

  // 評估雙張濾牌 (k = 2)
  if (maxN >= 2 && candidates.length >= 2) {
    const secondMinScore = hand.length >= 6 ? 1.2 : 4.2;
    for (let i = 0; i < candidates.length; i++) {
      const c1 = candidates[i]!;
      for (let j = i + 1; j < candidates.length; j++) {
        const c2 = candidates[j]!;
        if (c2.cycleScore < secondMinScore) continue;
        if (hand.length - 2 >= 6) continue;
        const used = new Set<string>();
        const name1 = nameForBlock(db, state, p, c1.uid, used);
        if (!name1) continue;
        used.add(name1.trim().toLowerCase());
        const name2 = nameForBlock(db, state, p, c2.uid, used);
        if (!name2) continue;
        const dp = paramOf(db, state, c1.uid, "block") + paramOf(db, state, c2.uid, "block");
        if (dp >= minDp) continue;

        const nameChoices: Record<number, string> = {};
        if (name1 !== cardOf(db, state, c1.uid).nameJa) nameChoices[c1.uid] = name1;
        if (name2 !== cardOf(db, state, c2.uid).nameJa) nameChoices[c2.uid] = name2;

        // 決定誰放中央（留作下局 Guts）、誰放側邊（結束進棄牌區）
        const f1 = futureCardValue(db, state, p, c1.uid, weights);
        const f2 = futureCardValue(db, state, p, c2.uid, weights);
        let center = c1.uid;
        if (dropSynergy) {
          // 有墓地回收需求時，優先把三年級或回收目標送去 side（棄牌區），另一張留 center 當 Guts
          const g1 = cardOf(db, state, c1.uid).grades.some((g) => g.includes("3")) ? 1 : 0;
          const g2 = cardOf(db, state, c2.uid).grades.some((g) => g.includes("3")) ? 1 : 0;
          if (g1 !== g2) center = g1 > g2 ? c2.uid : c1.uid;
          else center = f1 >= f2 ? c1.uid : c2.uid;
        } else {
          center = f1 >= f2 ? c1.uid : c2.uid;
        }

        const intervalDraws = Math.max(0, 6 - (hand.length - 2));
        const utility = c1.cycleScore + c2.cycleScore + intervalDraws * 2.5 + (dropSynergy ? 2.0 : 0.8);
        if (utility > bestUtility) {
          bestUtility = utility;
          bestPlan = {
            uids: [c1.uid, c2.uid],
            center,
            nameChoices,
            dp,
            cost: -utility,
          };
        }
      }
    }
  }

  return bestPlan;
}

function chooseDeployUid(db: CardDb, state: GameState, p: PlayerId, area: Exclude<Area, "block">, weights: HeuristicV2Weights): number | null {
  const opts = deployableUids(db, state, p, area);
  if (!opts.length) return null;
  const op = incomingOp(state, p);
  if (area === "receive") {
    const enough = opts.filter((uid) => paramOf(db, state, uid, "receive") >= op);
    if (!enough.length) return null;
    return enough.reduce((best, uid) => {
      const bestCost = (paramOf(db, state, best, "receive") - op) * 1.2 + futureCardValue(db, state, p, best, weights) * 0.18 * weights.receiveFutureCost;
      const cost = (paramOf(db, state, uid, "receive") - op) * 1.2 + futureCardValue(db, state, p, uid, weights) * 0.18 * weights.receiveFutureCost;
      return cost < bestCost ? uid : best;
    });
  }

  if (area === "toss") {
    // [Claude 2026-06-23] 反擊托球聯合最佳化：OP = 托值 + 攻值，所以托球該選的不是「自己托值最高」，
    // 而是「站托後攻擊格還能放的最佳合法攻擊」加起來最大者（同名禁止：攻≠托）。
    // 修掉舊版托/攻各自獨立貪心會少打 OP 的盲點（見 reports/15）。OP 為主鍵，平手再用技能/少燒未來價值收尾。
    const attackPool = deployableUids(db, state, p, "attack");
    const nameJa = (uid: number) => cardOf(db, state, uid).nameJa;
    return opts.reduce((best, uid) => {
      const jointOp = (u: number) => {
        const tossVal = paramOf(db, state, u, "toss");
        let bestAtk = 0;
        for (const a of attackPool) {
          if (a === u || nameJa(a) === nameJa(u)) continue; // 同一張或同名不可同時站托+攻
          const atk = paramOf(db, state, a, "attack");
          if (atk > bestAtk) bestAtk = atk;
        }
        return tossVal + bestAtk;
      };
      const key = (u: number) =>
        jointOp(u) * 100 +
        skillBonus(cardOf(db, state, u), weights, "toss") * 1.4 -
        futureCardValue(db, state, p, u, weights) * 0.08 * weights.deployFuturePenalty;
      return key(uid) > key(best) ? uid : best;
    });
  }

  const areaWeight: Record<Exclude<Area, "block">, number> = { serve: 5.0, receive: 4.0, toss: 4.3, attack: 5.2 };
  return opts.reduce((best, uid) => {
    const score = paramOf(db, state, uid, area) * areaWeight[area] + skillBonus(cardOf(db, state, uid), weights, area) * 1.4 - futureCardValue(db, state, p, uid, weights) * 0.08 * weights.deployFuturePenalty;
    const bestScore = paramOf(db, state, best, area) * areaWeight[area] + skillBonus(cardOf(db, state, best), weights, area) * 1.4 - futureCardValue(db, state, p, best, weights) * 0.08 * weights.deployFuturePenalty;
    return score > bestScore ? uid : best;
  });
}

function matchFilter(db: CardDb, state: GameState, uid: number, area: CourtArea | null, filter: CharaFilter): boolean {
  const c = cardOf(db, state, uid);
  if (filter.names && !filter.names.includes(c.nameJa)) return false;
  if (filter.notNames?.includes(c.nameJa)) return false;
  if (filter.affiliation && !c.affiliations.includes(filter.affiliation)) return false;
  if (filter.position && !c.positions.includes(filter.position)) return false;
  if (filter.positionsAny && !filter.positionsAny.some((x) => c.positions.includes(x))) return false;
  if (filter.gradesAny && !filter.gradesAny.some((x) => c.grades.includes(x))) return false;
  if (filter.area && (!area || !filter.area.includes(area))) return false;
  if (filter.baseParamMax && (c.params?.[filter.baseParamMax.param] ?? -Infinity) > filter.baseParamMax.value) return false;
  if (filter.baseParamEq && (c.params?.[filter.baseParamEq.param] ?? -Infinity) !== filter.baseParamEq.value) return false;
  if (filter.effParamMin && effParamOf(db, state, uid, filter.effParamMin.param) < filter.effParamMin.value) return false;
  if (filter.effParamEq && effParamOf(db, state, uid, filter.effParamEq.param) !== filter.effParamEq.value) return false;
  return true;
}

function evalCondition(db: CardDb, state: GameState, p: PlayerId, cond: Condition): boolean | null {
  switch (cond.type) {
    case "phaseIs":
      return state.phase === cond.phase;
    case "opponentOp": {
      if (!state.op || state.op.owner === p) return false;
      if (cond.min !== undefined && state.op.value < cond.min) return false;
      if (cond.max !== undefined && state.op.value > cond.max) return false;
      if (cond.source && !cond.source.includes(state.op.source as "serve" | "block" | "attack")) return false;
      return true;
    }
    case "handMin": {
      const who = cond.player === "opponent" ? other(p) : p;
      return state.players[who].hand.length >= cond.count;
    }
    case "handMax": {
      const who = cond.player === "opponent" ? other(p) : p;
      return state.players[who].hand.length <= cond.count;
    }
    case "chara": {
      const who = cond.player === "opponent" ? other(p) : p;
      const count = charasOf(state, who).filter((x) => matchFilter(db, state, x.uid, x.area, cond.filter)).length;
      return count >= (cond.minCount ?? 1);
    }
    case "allCharas": {
      const cs = charasOf(state, p);
      if (cs.length === 0) return false;
      const affs = cond.affiliationsAny ?? (cond.affiliation ? [cond.affiliation] : []);
      return affs.some((aff) => cs.every((x) => cardOf(db, state, x.uid).affiliations.includes(aff)));
    }
    case "eventAreaCount": {
      const who = cond.player === "opponent" ? other(p) : p;
      const count = state.players[who].eventArea.filter((uid) => {
        const c = cardOf(db, state, uid);
        if (cond.name && c.nameJa !== cond.name) return false;
        if (cond.affiliation && !c.affiliations.includes(cond.affiliation)) return false;
        if (cond.playTimingAny && !cond.playTimingAny.some((x) => phaseTimingMatches(c, x))) return false;
        return true;
      }).length;
      if (cond.min !== undefined && count < cond.min) return false;
      if (cond.max !== undefined && count > cond.max) return false;
      return true;
    }
    case "setTotalMax":
      return state.players[0].setArea.length + state.players[1].setArea.length <= cond.count;
    default:
      return null;
  }
}

function conditionWeight(db: CardDb, state: GameState, p: PlayerId, conds: Condition[] | undefined): number {
  if (!conds?.length) return 1;
  let unknown = false;
  for (const cond of conds) {
    const result = evalCondition(db, state, p, cond);
    if (result === false) return 0;
    if (result === null) unknown = true;
  }
  return unknown ? 0.65 : 1;
}

function costScore(cost: Cost, weights: HeuristicV2Weights): number {
  let base: number;
  switch (cost.type) {
    case "guts":
      base = cost.count * 1.25;
      break;
    case "gutsAny":
    case "gutsFrom":
      base = cost.count * 1.05;
      break;
    case "dropFromHand":
      base = cost.count * 2.4;
      break;
    case "handToDeckBottom":
      base = cost.count * 1.0;
      break;
    case "placeEventFromHand":
      base = 1.2;
      break;
    case "millDeck":
      base = cost.count * 0.85;
      break;
    case "dropChara":
      base = 4.2;
      break;
    case "dropSelf":
    case "dropSelfFromCourt":
      base = 3.2;
      break;
    case "selfToDeckBottom":
      base = 2.4;
      break;
    case "moveOpponentEventCost":
      base = -1.6;
      break;
    case "tilt":
      base = 0.15;
      break;
    default:
      base = 1;
      break;
  }
  return base > 0 ? base * weights.costValue : base;
}

function costsScore(costs: Cost[] | undefined, weights: HeuristicV2Weights): number {
  return (costs ?? []).reduce((sum, cost) => sum + costScore(cost, weights), 0);
}

function blockActionBonus(action: Action, weights: HeuristicV2Weights): number {
  if (weights.blockActionValue <= 0) return 0;
  let bonus = 0;
  switch (action.op) {
    case "keyword":
      if (action.name === "ドシャット") bonus += 2.4 + (action.n ?? 0) * 0.25;
      if (action.name === "ワンタッチ") bonus += 2.0 + (action.n ?? 0) * 0.2;
      if (action.name === "ブロックアウト") bonus += 1.2 + (action.n ?? 0) * 0.15;
      break;
    case "watch":
      if (action.trigger.on === "blockSuccess") bonus += 2.4;
      if (action.trigger.on === "deploy" && action.trigger.area?.includes("block")) bonus += 1.5;
      bonus += (action.actions ?? []).reduce((sum, child) => sum + blockActionBonus(child, weights) * 0.35, 0);
      break;
    case "restrict":
      if (action.restriction.area === "block" || action.restriction.blockFailIfDpMax || action.restriction.negateCenterBlock || action.restriction.banOneTouch) bonus += 1.8;
      break;
    case "deployFromDrop":
    case "deployFromGuts":
      if (action.area === "block") bonus += 1.8;
      break;
    case "moveSelfToBlockSide":
      bonus += 1.7;
      break;
    case "addParam":
    case "setParam":
      if (action.param === "block") bonus += 1.4;
      break;
    case "chooseOne":
      bonus += Math.max(0, ...action.options.map((option) => (option.actions ?? []).reduce((sum, child) => sum + blockActionBonus(child, weights), 0))) * 0.4;
      break;
    case "gate":
      bonus += (action.then ?? []).reduce((sum, child) => sum + blockActionBonus(child, weights), 0) * 0.45;
      break;
    case "if":
      bonus += (action.then ?? []).reduce((sum, child) => sum + blockActionBonus(child, weights), 0) * 0.35;
      break;
    default:
      break;
  }
  return bonus * weights.blockActionValue;
}

function actionScore(db: CardDb, state: GameState, p: PlayerId, action: Action, weights: HeuristicV2Weights): number {
  let base: number;
  switch (action.op) {
    case "draw":
      return Math.max(0, action.count * 1.8 * weights.drawValue - deckRisk(state, p, weights) - (action.upTo ? 0.15 : 0));
    case "drawToHandSize":
      return Math.max(0, action.size - state.players[p].hand.length) * 1.8 * weights.drawValue;
    case "dropToHand":
    case "eventAreaToHand":
      base = action.count * 2.1;
      break;
    case "gutsToHandAny":
      base = action.upTo * 2.1;
      break;
    case "gutsToHand":
      base = action.count * 1.8;
      break;
    case "forceDrop":
      base = action.count * 2.45;
      break;
    case "addParam":
      base = action.amount * phaseParamDemand(state, p, action.param === "choose" ? currentNeed(state) ?? "attack" : action.param, weights);
      break;
    case "setParam":
      base = Math.max(0, action.value) * phaseParamDemand(state, p, action.param, weights);
      break;
    case "setParamToBase":
      base = 1.3;
      break;
    case "addOpponentOp":
      base = action.amount < 0 ? -action.amount * 2.6 : action.amount * -1.8;
      break;
    case "setOwnOp":
    case "calcAttackOpAs":
      base = action.value * 1.6;
      break;
    case "lostOpponent":
      base = 9;
      break;
    case "restrict": {
      const r = action.restriction;
      base = 2.4 + (r.maxCount === 0 ? 2.4 : 0) + (r.blockFailIfDpMax ? 2.8 : 0) + (r.preventOpDecrease ? 1.3 : 0) + (r.banHandAdd ? 1.6 : 0);
      break;
    }
    case "watch":
      base = 1.6 + actionsScore(db, state, p, action.actions, weights) * 0.35;
      break;
    case "gate": {
      const weight = conditionWeight(db, state, p, action.cond);
      const thenScore = actionsScore(db, state, p, action.then, weights) - costsScore(action.costs, weights);
      const elseScore = actionsScore(db, state, p, action.else ?? [], weights);
      base = Math.max(elseScore, weight * thenScore);
      break;
    }
    case "if":
      base = conditionWeight(db, state, p, action.cond) * actionsScore(db, state, p, action.then, weights);
      break;
    case "chooseOne":
      return Math.max(action.optional ? 0 : -Infinity, ...action.options.map((o) => actionsScore(db, state, p, o.actions, weights)));
    case "revealTopTutor":
    case "lookTopTutor":
      base = action.upTo * 1.9;
      break;
    case "deployFromDrop":
    case "deployFromGuts":
      base = Math.max(1, phaseParamDemand(state, p, action.area, weights) * 1.4) + actionsScore(db, state, p, action.then ?? [], weights);
      break;
    case "moveCharaToHand":
      base = action.upTo * 1.7;
      break;
    case "dropOpponentGuts":
      base = action.upTo * 1.65;
      break;
    case "moveOpponentEvent":
      base = (action.count ?? action.upTo ?? 1) * 1.8;
      break;
    case "handToGuts":
    case "moveGutsToArea":
      base = action.upTo * 0.8;
      break;
    case "dropTarget":
      base = 2.2;
      break;
    case "opponentMayPlaceEvent":
      base = actionsScore(db, state, p, action.else, weights) * 0.55;
      break;
    case "keyword":
      if (action.name === "ワンタッチ") base = 3 + (action.n ?? 0) * 2;
      else if (action.name === "ドシャット") base = 4 + (action.n ?? 0) * 1.5;
      else if (action.name === "フェイント" || action.name === "ツーアタック") base = 4 + (action.n ?? 0) * 1.4;
      else if (action.name === "ブロックアウト") base = 5 + (action.n ?? 0);
      else if (action.name === "Aパス") base = 2.5 + (action.n ?? 0);
      else base = 0.4;
      break;
    case "millTop":
      base = (actionsScore(db, state, p, action.then ?? [], weights) + (action.milledMatch ? 1.1 : 0)) - action.upTo * (0.45 + deckRisk(state, p, weights) * 0.2);
      break;
    case "millTopAll":
      base = actionsScore(db, state, p, action.then ?? [], weights) - action.count * 0.45;
      break;
    case "dropFromHand":
      base = -action.count * 1.8;
      break;
    case "handToDeckBottom":
    case "handToDeckTop":
      base = -action.count * 0.7;
      break;
    case "shuffleHandIntoDeck":
      base = action.player === "opponent" ? 2.2 : -1.4;
      break;
    case "coinFlip":
      base = (actionsScore(db, state, p, action.heads, weights) + actionsScore(db, state, p, action.tails, weights)) / 2;
      break;
    case "moveSelfToBlockSide":
      base = 1.1;
      break;
    case "revealTopCheck":
      base = actionsScore(db, state, p, action.then, weights) * 0.65;
      break;
    case "script":
      base = 1.5;
      break;
    case "skipToPhase":
      base = action.phase === "end" ? 2.5 : 1.5;
      break;
    default:
      base = 0.8;
      break;
  }
  const weightedBase = base > 0 ? base * weights.actionValue : base;
  return weightedBase + blockActionBonus(action, weights);
}

function actionsScore(db: CardDb, state: GameState, p: PlayerId, actions: Action[] | undefined, weights: HeuristicV2Weights): number {
  return (actions ?? []).reduce((sum, action) => sum + actionScore(db, state, p, action, weights), 0);
}

function currentBlockDp(db: CardDb, state: GameState, p: PlayerId): number {
  const ps = state.players[p];
  const centerTop = topChara(ps.blockCenter);
  const negated = state.restrictions.some(
    (r) => r.player === p && r.negateCenterBlock && r.setNo === state.setNo && r.activeTurn === state.turnNo,
  );
  const centerVal = centerTop !== null && !negated ? effParamOf(db, state, centerTop, "block") : 0;
  const sideVal = ps.blockSides.reduce((sum, u) => sum + effParamOf(db, state, u, "block"), 0);
  return centerVal + sideVal;
}

function maxBlockGainFromActions(actions: readonly Action[] | undefined): number {
  let gain = 0;
  for (const action of actions ?? []) {
    switch (action.op) {
      case "addParam":
        if ((action.param === "block" || action.param === "choose") && action.amount > 0) gain += action.amount;
        break;
      case "setParam":
        if (action.param === "block" && action.value > 0) gain += action.value;
        break;
      case "addOpponentOp":
        if (action.amount < 0) gain += -action.amount;
        break;
      case "deployFromDrop":
      case "deployFromGuts":
        if (action.area === "block") gain += 4 + maxBlockGainFromActions(action.then);
        break;
      case "keyword":
        if (action.name === "ワンタッチ" || action.name === "ドシャット") gain += 99;
        break;
      case "lostOpponent":
        gain += 99;
        break;
      case "gate":
        gain += Math.max(maxBlockGainFromActions(action.then), maxBlockGainFromActions(action.else));
        break;
      case "if":
        gain += maxBlockGainFromActions(action.then);
        break;
      case "chooseOne":
        gain += Math.max(0, ...action.options.map((o) => maxBlockGainFromActions(o.actions)));
        break;
      default:
        break;
    }
  }
  return gain;
}

function freeSkillScore(db: CardDb, state: GameState, p: PlayerId, uid: number, skillIndex: number, weights: HeuristicV2Weights): number {
  const skill = skillOf(cardOf(db, state, uid), skillIndex);
  if (!skill || skill.kind !== "active") return -Infinity;
  return actionsScore(db, state, p, skill.actions, weights) - costsScore(skill.costs, weights) - 0.35;
}

function freeEventScore(db: CardDb, state: GameState, p: PlayerId, uid: number, weights: HeuristicV2Weights): number {
  const skill = effectOf(cardOf(db, state, uid))?.skills.find((s): s is Extract<SkillDef, { kind: "event" }> => s.kind === "event");
  if (!skill) return -Infinity;
  return actionsScore(db, state, p, skill.actions, weights) - 0.45;
}

function chooseFreeAction(db: CardDb, state: GameState, p: PlayerId, weights: HeuristicV2Weights): Decision {
  const fo = freeOptions(db, state);
  // [Gemini 2026-11-18] Phase M2：當處於必敗攔網（即使開盡所有可用攔網技能/事件仍 DP < OP，且無 One Touch / ドシャット）時，
  // 直接 pass 讓判定自然失敗進入 Interval 補牌，不白花 Guts 與事件卡去救必敗的球。
  if (state.phase === "block") {
    const op = incomingOp(state, p);
    const dp = currentBlockDp(db, state, p);
    if (op > 0 && dp < op) {
      let maxGain = 0;
      for (const e of fo.events) {
        const skill = effectOf(cardOf(db, state, e.uid))?.skills.find((s): s is Extract<SkillDef, { kind: "event" }> => s.kind === "event");
        if (skill) maxGain += maxBlockGainFromActions(skill.actions);
      }
      for (const s of fo.skills) {
        const skill = skillOf(cardOf(db, state, s.uid), s.skillIndex);
        if (skill && "actions" in skill) maxGain += maxBlockGainFromActions(skill.actions);
      }
      if (dp + maxGain < op) {
        return { type: "free", action: "pass" };
      }
    }
  }
  const eventChoices = fo.events.map((e) => ({ type: "event" as const, uid: e.uid, score: freeEventScore(db, state, p, e.uid, weights) }));
  const skillChoices = fo.skills.map((s) => ({ type: "skill" as const, uid: s.uid, skillIndex: s.skillIndex, score: freeSkillScore(db, state, p, s.uid, s.skillIndex, weights) }));
  const best = [...eventChoices, ...skillChoices].sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < weights.freeActionThreshold) return { type: "free", action: "pass" };
  if (best.type === "event") return { type: "free", action: "event", uid: best.uid };
  return { type: "free", action: "skill", uid: best.uid, skillIndex: best.skillIndex };
}

function gateAcceptScore(db: CardDb, state: GameState, p: PlayerId, aw: Extract<Awaiting, { kind: "confirm" }>, weights: HeuristicV2Weights): number {
  if (aw.what === "draw") return (aw.count ?? 1) * 1.8 * weights.drawValue - deckRisk(state, p, weights);
  if (aw.what === "mill") return actionsScore(db, state, p, aw.then, weights) - 1.2 * weights.costValue;
  if (state.phase === "block" && (aw.costs?.length ?? 0) > 0 && aw.then.length > 0 && aw.then.every((a) => a.op === "addParam")) {
    const op = incomingOp(state, p);
    const dp = currentBlockDp(db, state, p);
    if (op > 0 && dp < op) {
      const gain = maxBlockGainFromActions(aw.then);
      if (dp + gain < op) return -Infinity;
    }
  }
  const immediatePointGain = immediatePointGainScore(state, aw.then, weights);
  return actionsScore(db, state, p, aw.then, weights) + immediatePointGain - costsScore(aw.costs, weights);
}

function immediatePointGainScore(state: GameState, actions: Action[] | undefined, weights: HeuristicV2Weights): number {
  const ctx = state.effectCtx;
  if (!ctx) return 0;
  let score = 0;
  const visit = (items: Action[] | undefined) => {
    for (const action of items ?? []) {
      switch (action.op) {
        case "addParam": {
          if (action.amount <= 0) break;
          const param = action.param === "choose" ? currentNeed(state) : action.param;
          if (!param) break;
          let targetUid: number | null = null;
          if (action.target === "self") targetUid = ctx.source;
          else if (action.target === "target") targetUid = ctx.lastTarget;
          else if (action.target === "trigger") targetUid = ctx.triggerUid;
          if (targetUid !== null && paramContributorAt(state, targetUid, param)) {
            const demand = phaseParamDemand(state, ctx.player, param, weights);
            score += action.amount * Math.max(1.8, demand);
          }
          break;
        }
        case "if":
          visit(action.then);
          break;
        case "gate":
          visit(action.then);
          break;
        case "chooseOne":
          score += Math.max(0, ...action.options.map((option) => immediatePointGainScore(state, option.actions, weights)));
          break;
        case "watch":
          score += immediatePointGainScore(state, action.actions, weights) * 0.25;
          break;
        default:
          break;
      }
    }
  };
  visit(actions);
  return score;
}

/**
 * uid 是否「站在能讓 param 進入計分的位置」＝buff/debuff 到它身上才會改變 OP/DP（engine.ts calcOp/calcDp）。
 * 例：attack 只算攻擊區頂端攻擊手；toss 只算托球區頂端；block 算攔網中央頂端＋側翼。
 * 加在舉球/攔網區角色的 attack 修正＝白費（calcOp 不讀）→ 這判斷讓 AI 不再亂加。
 */
function paramContributorAt(state: GameState, uid: number, param: ParamName): boolean {
  for (const ps of state.players) {
    if (param === "block") {
      if (ps.blockSides.includes(uid) || topChara(ps.blockCenter) === uid) return true;
    } else if (topChara(ps[param]) === uid) {
      return true;
    }
  }
  return false;
}
const POSITIONAL_TARGET_BONUS = 100; // 位置貢獻權重，遠大於點數差(0~9)與 futureValue，確保壓過非貢獻位置

function cardSortValue(db: CardDb, state: GameState, p: PlayerId, uid: number, purpose: string, weights: HeuristicV2Weights): number {
  if (purpose === "target") {
    const aw = state.effectCtx?.awaiting;
    const param = aw?.kind === "cards" && aw.param && aw.param !== "choose" ? aw.param : currentNeed(state) ?? "attack";
    const amount = aw?.kind === "cards" ? aw.amount ?? 1 : 1;
    // 位置貢獻優先：只有站在「該 param 會被計分」的位置，修正才有意義（買/減皆然）。
    const positional = paramContributorAt(state, uid, param as ParamName) ? POSITIONAL_TARGET_BONUS : 0;
    return positional + effParamOf(db, state, uid, param as ParamName) * Math.sign(amount) + futureCardValue(db, state, p, uid, weights) * 0.15;
  }
  if (purpose === "deployFromDrop" || purpose === "deployFromGuts") {
    const aw = state.effectCtx?.awaiting;
    const area = aw?.kind === "cards" && aw.area ? aw.area : currentNeed(state) ?? "attack";
    return paramOf(db, state, uid, area) * 2.4 + futureCardValue(db, state, p, uid, weights) * 0.3;
  }
  if (purpose === "dropOppGuts" || purpose === "moveOpponentEvent" || purpose === "moveOpponentEventCost") {
    return futureCardValue(db, state, other(p), uid, weights);
  }
  return futureCardValue(db, state, p, uid, weights);
}

function takeSorted<T>(items: T[], count: number): T[] {
  return count <= 0 ? [] : items.slice(0, count);
}

function chooseByValue(db: CardDb, state: GameState, p: PlayerId, aw: Extract<Awaiting, { kind: "cards" }>, order: CandidateOrder, weights: HeuristicV2Weights): number[] {
  const sorted = aw.candidates
    .slice()
    .sort((a, b) => (order === "high" ? cardSortValue(db, state, p, b, aw.purpose, weights) - cardSortValue(db, state, p, a, aw.purpose, weights) : cardSortValue(db, state, p, a, aw.purpose, weights) - cardSortValue(db, state, p, b, aw.purpose, weights)));
  const pool: number[] = [];
  if (aw.distinctNames) {
    const usedNames = new Set<string>();
    for (const uid of sorted) {
      const n = nameOf(db, state, uid);
      if (usedNames.has(n)) continue;
      usedNames.add(n);
      pool.push(uid);
    }
  } else {
    pool.push(...sorted);
  }
  const targetCount = Math.min(aw.max, Math.max(aw.min, pool.filter((uid) => cardSortValue(db, state, p, uid, aw.purpose, weights) > 1.1).length));
  return takeSorted(pool, targetCount);
}

function chooseEffectCards(db: CardDb, state: GameState, weights: HeuristicV2Weights): number[] {
  const ctx = state.effectCtx;
  const aw = ctx?.awaiting;
  if (!ctx || !aw || aw.kind !== "cards") return autoPickCards(db, state);
  const p = (aw.chooser ?? ctx.player) as PlayerId;
  if (!aw.candidates.length || aw.max === 0) return [];

  switch (aw.purpose) {
    case "guts":
    case "dropHand":
    case "handToBottom":
    case "handToTop":
    case "handToGuts":
    case "placeEvent":
    case "dropChara":
      return chooseByValue(db, state, p, aw, "low", weights).slice(0, Math.max(aw.min, Math.min(aw.max, aw.min || 1)));
    case "forceDrop":
      return chooseByValue(db, state, p, aw, "low", weights).slice(0, aw.max);
    case "tutor":
    case "moveToHand":
    case "dropToHand":
    case "eventToHand":
    case "gutsToHandAny":
    case "deployFromDrop":
    case "deployFromGuts":
      return chooseByValue(db, state, ctx.player, aw, "high", weights);
    case "gutsToHand":
      return autoPickCards(db, state);
    case "target":
    case "dropOppGuts":
    case "moveOpponentEvent":
    case "moveOpponentEventCost":
    case "moveGuts":
      return chooseByValue(db, state, ctx.player, aw, "high", weights);
    case "placeEventOpponent": {
      const low = chooseByValue(db, state, p, aw, "low", weights);
      const cheapest = low[0];
      return cheapest !== undefined && futureCardValue(db, state, p, cheapest, weights) < 4 ? [cheapest] : [];
    }
    default:
      return autoPickCards(db, state);
  }
}

function chooseEffectOption(db: CardDb, state: GameState, weights: HeuristicV2Weights): number {
  const ctx = state.effectCtx;
  const aw = ctx?.awaiting;
  if (!ctx || !aw || aw.kind !== "option") return 0;
  // [Codex 2026-10-28] 維持原 autoPickCards 的上限張數保底，不讀未公開的牌組卡。
  if (aw.purpose === "millCost") return aw.labels.length - 1;
  if (aw.purpose === "param") {
    let bestIndex = 0;
    let bestScore = -Infinity;
    aw.options.forEach((param, index) => {
      const score = phaseParamDemand(state, ctx.player, param, weights) + effParamOf(db, state, aw.targetUid, param) * 0.2;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  let bestIndex = 0;
  let bestScore = -Infinity;
  aw.labels.forEach((label, index) => {
    const branch = aw.branches[index];
    const score = branch ? actionsScore(db, state, ctx.player, branch, weights) : label.includes("不使用") ? 0 : -0.1;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function pendingItemScore(db: CardDb, state: GameState, p: PlayerId, item: PendingItem, weights: HeuristicV2Weights): number {
  if (item.actions) return actionsScore(db, state, p, item.actions, weights) + (item.player === p ? 0.8 : -0.2);
  const card = cardOf(db, state, item.source);
  const skill = item.skillIndex !== undefined ? skillOf(card, item.skillIndex) : null;
  if (skill && "actions" in skill) return actionsScore(db, state, p, skill.actions, weights) + (item.player === p ? 0.8 : -0.2);
  return item.player === p ? 0.5 : 0;
}

function choosePending(db: CardDb, state: GameState, p: PlayerId, candidates: number[], weights: HeuristicV2Weights): number {
  const items = candidates
    .map((id) => state.pendingQueue.find((x) => x.id === id))
    .filter((x): x is PendingItem => !!x)
    .map((item) => ({ item, score: pendingItemScore(db, state, p, item, weights) }));
  const best = items.sort((a, b) => b.score - a.score)[0]?.item.id;
  return best ?? candidates[0]!;
}

export function heuristicAiDecision(db: CardDb, state: GameState, profile: HeuristicV2ProfileId | HeuristicV2Weights = "heuristic-v2"): Decision {
  const weights = profileOf(profile);
  const pd = state.pendingDecision;
  if (!pd) throw new Error("沒有待決策");
  const p = pd.player as PlayerId;

  switch (pd.type) {
    case "serve-rights":
      return { type: "serve-rights", take: true };

    case "mulligan":
      return { type: "mulligan", returnUids: chooseMulligan(db, state, p, weights) };

    case "defense-choice": {
      const op = incomingOp(state, p);
      const receiveUid = chooseDeployUid(db, state, p, "receive", weights);
      const receiveCost = receiveUid === null ? Infinity : futureCardValue(db, state, p, receiveUid, weights) * 0.18 * weights.receiveFutureCost + Math.max(0, paramOf(db, state, receiveUid, "receive") - op) * 0.8;
      const block = canChooseBlock(state) ? bestBlockPlan(db, state, p, op, weights) : null;
      const blockCost = block ? block.cost - weights.blockChoiceBias : Infinity;
      if (receiveUid !== null && (!block || receiveCost <= blockCost + 1.5)) return { type: "defense-choice", choice: "receive" };
      if (block) return { type: "defense-choice", choice: "block" };
      if (canChooseBlock(state) && bestTacticalLostBlockPlan(db, state, p, op, weights)) {
        return { type: "defense-choice", choice: "block" };
      }
      return { type: "defense-choice", choice: "receive" };
    }

    case "deploy-serve": {
      const uid = chooseDeployUid(db, state, p, "serve", weights);
      return { type: "deploy-serve", uid, nameChoice: uid === null ? undefined : pickDeployName(db, state, p, uid, "serve") };
    }

    case "deploy-receive": {
      const uid = chooseDeployUid(db, state, p, "receive", weights);
      return { type: "deploy-receive", uid, nameChoice: uid === null ? undefined : pickDeployName(db, state, p, uid, "receive") };
    }

    case "deploy-toss":
    case "deploy-attack": {
      const area = pd.type.slice("deploy-".length) as "toss" | "attack";
      const uid = chooseDeployUid(db, state, p, area, weights);
      return { type: pd.type, uid, nameChoice: uid === null ? undefined : pickDeployName(db, state, p, uid, area) } as Decision;
    }

    case "deploy-block": {
      const op = incomingOp(state, p);
      const plan = bestBlockPlan(db, state, p, op, weights) ?? bestTacticalLostBlockPlan(db, state, p, op, weights);
      if (!plan) return { type: "deploy-block", uids: null };
      return { type: "deploy-block", uids: plan.uids, center: plan.center, nameChoices: plan.nameChoices };
    }

    case "free":
      return chooseFreeAction(db, state, p, weights);

    case "pick-set-card":
      return { type: "pick-set-card", index: 0 };

    case "resolve-pending":
      return { type: "resolve-pending", id: choosePending(db, state, p, pd.candidates ?? [], weights) };

    case "effect-confirm": {
      const aw = state.effectCtx?.awaiting;
      const accept = aw?.kind === "confirm" ? gateAcceptScore(db, state, p, aw, weights) >= weights.gateAcceptThreshold : true;
      return { type: "effect-confirm", accept };
    }

    case "effect-cards":
      return { type: "effect-cards", uids: chooseEffectCards(db, state, weights) };

    case "effect-option":
      return { type: "effect-option", index: chooseEffectOption(db, state, weights) };

    default:
      throw new Error(`啟發式 AI 未支援的決策型別 ${pd.type}`);
  }
}
