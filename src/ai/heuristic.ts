// M5 Heuristic v2：合法性仍交給引擎，AI 只負責「哪個合法選擇比較像好選擇」。
// 核心取向：
// - 起手換牌看先後手與角色覆蓋，不固定不換。
// - 自由步驟先估技能/事件淨收益，不再有招就亂開。
// - effect 子決策用同一套卡片價值排序，成本選便宜、收益選關鍵。
// - 防守仍以活下來為第一優先，但把機會成本納入攔網/接球選擇。
import type { Card } from "../data/types";
import type { Action, CharaFilter, Condition, Cost, CourtArea, EffectDef, ParamName, SkillDef } from "../engine/dsl";
import type { Awaiting, CardDb, Decision, GameState, PendingItem, PlayerId } from "../engine/types";
import { blockDeployMax, canChooseBlock, charasOf, deployableUids, effParam, freeOptions } from "../engine/engine";
import { autoPickCards } from "../engine/effects";
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
  return card.timing.some((x) => x.includes(TIMING_LABEL[param]));
}

function phaseTimingMatches(card: Card, phase: string): boolean {
  const label = PHASE_TIMING_LABEL[phase];
  return !!label && card.timing.some((x) => x.includes(label));
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

function chooseMulligan(db: CardDb, state: GameState, p: PlayerId, weights: HeuristicV2Weights): number[] {
  const serving = p === state.servingPlayer;
  const hand = state.players[p].hand;
  const scored = hand
    .map((uid) => ({ uid, score: setupCardValue(db, state, p, uid, serving, weights), card: cardOf(db, state, uid) }))
    .sort((a, b) => a.score - b.score);

  const hasPrimary = scored.some((x) => {
    if (x.card.type !== "CHARACTER") return false;
    return serving ? (x.card.params?.serve ?? 0) >= 4 : (x.card.params?.receive ?? 0) >= 4;
  });
  const hasAttackLine = scored.some((x) => x.card.type === "CHARACTER" && (x.card.params?.attack ?? 0) >= 2);
  const hasToss = scored.some((x) => x.card.type === "CHARACTER" && (x.card.params?.toss ?? 0) > 0);
  const weakThreshold = (serving ? 4.2 : 4.6) + weights.mulliganWeakDelta;
  const baseMaxReturns = hasPrimary && (serving || hasAttackLine || hasToss) ? 2 : 3;
  const maxReturns = Math.max(1, Math.min(4, baseMaxReturns + weights.mulliganReturnDelta));
  const keepAtLeast = 3;
  const returns: number[] = [];

  for (const item of scored) {
    if (returns.length >= maxReturns || hand.length - returns.length <= keepAtLeast) break;
    const pms = item.card.params;
    const primaryValue = serving ? pms?.serve ?? 0 : pms?.receive ?? 0;
    const isUsefulEvent = item.card.type === "EVENT" && item.score >= weakThreshold + 0.6;
    if (item.score < weakThreshold && primaryValue < 3 && !isUsefulEvent) returns.push(item.uid);
  }

  if (!hasPrimary && returns.length < maxReturns) {
    for (const item of scored) {
      if (returns.includes(item.uid) || hand.length - returns.length <= keepAtLeast) continue;
      const primaryValue = serving ? item.card.params?.serve ?? 0 : item.card.params?.receive ?? 0;
      if (primaryValue < 3) returns.push(item.uid);
      if (returns.length >= maxReturns) break;
    }
  }
  return returns;
}

function nameForBlock(db: CardDb, state: GameState, p: PlayerId, uid: number, used: Set<string>): string | null {
  const choice = pickDeployName(db, state, p, uid, "block", used);
  const name = choice ?? cardOf(db, state, uid).nameJa;
  const key = name.trim().toLowerCase();
  return used.has(key) ? null : name;
}

interface BlockPlan {
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

function bestBlockPlan(db: CardDb, state: GameState, p: PlayerId, minDp: number, weights: HeuristicV2Weights): BlockPlan | null {
  const maxN = Math.min(3, blockDeployMax(state, p));
  if (maxN <= 0) return null;
  const pool = deployableUids(db, state, p, "block")
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
      return cs.length > 0 && cs.every((x) => cardOf(db, state, x.uid).affiliations.includes(cond.affiliation));
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
  return actionsScore(db, state, p, aw.then, weights) - costsScore(aw.costs, weights);
}

function cardSortValue(db: CardDb, state: GameState, p: PlayerId, uid: number, purpose: string, weights: HeuristicV2Weights): number {
  if (purpose === "target") {
    const aw = state.effectCtx?.awaiting;
    const param = aw?.kind === "cards" && aw.param && aw.param !== "choose" ? aw.param : currentNeed(state) ?? "attack";
    const amount = aw?.kind === "cards" ? aw.amount ?? 1 : 1;
    return effParamOf(db, state, uid, param as ParamName) * Math.sign(amount) + futureCardValue(db, state, p, uid, weights) * 0.15;
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
  const targetCount = Math.min(aw.max, Math.max(aw.min, sorted.filter((uid) => cardSortValue(db, state, p, uid, aw.purpose, weights) > 1.1).length));
  return takeSorted(sorted, targetCount);
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
      const plan = bestBlockPlan(db, state, p, incomingOp(state, p), weights);
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
