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

function deckRisk(state: GameState, p: PlayerId): number {
  const left = state.players[p].deck.length;
  if (left <= 4) return 1.4;
  if (left <= 8) return 0.7;
  return 0;
}

function phaseParamDemand(state: GameState, p: PlayerId, param: ParamName): number {
  const need = currentNeed(state);
  if (need === param) {
    if ((param === "receive" || param === "block") && incomingOp(state, p) >= 4) return 3.2;
    return 2.4;
  }
  if (state.phase === "start" && (param === "receive" || param === "block")) return 1.9;
  if (state.phase === "toss" && param === "attack") return 1.6;
  if (state.phase === "receive" && param === "toss") return 1.25;
  return 0.75;
}

function timingMatches(card: Card, param: ParamName): boolean {
  return card.timing.some((x) => x.includes(TIMING_LABEL[param]));
}

function phaseTimingMatches(card: Card, phase: string): boolean {
  const label = PHASE_TIMING_LABEL[phase];
  return !!label && card.timing.some((x) => x.includes(label));
}

function skillBonus(card: Card, param?: ParamName): number {
  if (card.effectStatus === "vanilla" || card.effectStatus === "todo") return 0;
  let bonus = card.effectStatus === "script" ? 0.9 : 0.55;
  if (param && timingMatches(card, param)) bonus += 0.55;
  if (card.skillJa?.includes("[=ターン1]")) bonus += 0.25;
  return bonus;
}

/** 卡片留在手牌中的未來價值；成本/棄牌時挑低分，檢索/回收時挑高分。 */
function futureCardValue(db: CardDb, state: GameState, p: PlayerId, uid: number): number {
  const card = cardOf(db, state, uid);
  if (card.type === "EVENT") {
    const phase = currentNeed(state);
    const timing = phase && timingMatches(card, phase) ? 1.4 : 0;
    return 3.1 + timing + skillBonus(card);
  }
  if (!card.params) return 0;
  const serve = card.params.serve ?? 0;
  const receive = card.params.receive ?? 0;
  const toss = card.params.toss ?? 0;
  const attack = card.params.attack ?? 0;
  const block = card.params.block ?? 0;
  const coverage = AREAS.filter((a) => card.params?.[a] !== null && (card.params?.[a] ?? 0) > 0).length * 0.35;
  const pressure = incomingOp(state, p) >= 4 ? receive * 0.25 + block * 0.18 : 0;
  return serve * 0.7 + receive * 1.05 + toss * 0.8 + attack * 0.95 + block * 0.85 + coverage + pressure + skillBonus(card);
}

function setupCardValue(db: CardDb, state: GameState, p: PlayerId, uid: number, serving: boolean): number {
  const card = cardOf(db, state, uid);
  if (card.type === "EVENT") {
    const usefulEarly = serving
      ? timingMatches(card, "serve") || timingMatches(card, "attack")
      : timingMatches(card, "receive") || timingMatches(card, "block") || timingMatches(card, "toss");
    return usefulEarly ? 5.2 + skillBonus(card) : 2.6 + skillBonus(card) * 0.5;
  }
  const pms = card.params;
  if (!pms) return 0;
  const serve = pms.serve ?? 0;
  const receive = pms.receive ?? 0;
  const toss = pms.toss ?? 0;
  const attack = pms.attack ?? 0;
  const block = pms.block ?? 0;
  const coverage = AREAS.filter((a) => pms[a] !== null && (pms[a] ?? 0) > 0).length * 0.45;
  const role = serving
    ? serve * 2.2 + attack * 1.35 + receive * 1.1 + block * 0.8 + toss * 0.75
    : receive * 2.25 + block * 1.25 + attack * 1.15 + toss * 1.0 + serve * 0.65;
  return role + coverage + skillBonus(card, serving ? "serve" : "receive");
}

function chooseMulligan(db: CardDb, state: GameState, p: PlayerId): number[] {
  const serving = p === state.servingPlayer;
  const hand = state.players[p].hand;
  const scored = hand
    .map((uid) => ({ uid, score: setupCardValue(db, state, p, uid, serving), card: cardOf(db, state, uid) }))
    .sort((a, b) => a.score - b.score);

  const hasPrimary = scored.some((x) => {
    if (x.card.type !== "CHARACTER") return false;
    return serving ? (x.card.params?.serve ?? 0) >= 4 : (x.card.params?.receive ?? 0) >= 4;
  });
  const hasAttackLine = scored.some((x) => x.card.type === "CHARACTER" && (x.card.params?.attack ?? 0) >= 2);
  const hasToss = scored.some((x) => x.card.type === "CHARACTER" && (x.card.params?.toss ?? 0) > 0);
  const weakThreshold = serving ? 4.2 : 4.6;
  const maxReturns = hasPrimary && (serving || hasAttackLine || hasToss) ? 2 : 3;
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

function blockPlanCost(db: CardDb, state: GameState, p: PlayerId, uids: number[], center: number, op: number): number {
  const excess = Math.max(0, uids.reduce((sum, uid) => sum + paramOf(db, state, uid, "block"), 0) - op);
  const sideCost = uids.filter((uid) => uid !== center).reduce((sum, uid) => sum + futureCardValue(db, state, p, uid), 0);
  const centerCost = futureCardValue(db, state, p, center) * 0.15;
  return sideCost + centerCost + excess * 0.45 + uids.length * 0.35;
}

function bestBlockPlan(db: CardDb, state: GameState, p: PlayerId, minDp: number): BlockPlan | null {
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
        const center = chosen.reduce((a, b) => (futureCardValue(db, state, p, a) >= futureCardValue(db, state, p, b) ? a : b));
        const cost = blockPlanCost(db, state, p, chosen, center, minDp);
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

function chooseDeployUid(db: CardDb, state: GameState, p: PlayerId, area: Exclude<Area, "block">): number | null {
  const opts = deployableUids(db, state, p, area);
  if (!opts.length) return null;
  const op = incomingOp(state, p);
  if (area === "receive") {
    const enough = opts.filter((uid) => paramOf(db, state, uid, "receive") >= op);
    if (!enough.length) return null;
    return enough.reduce((best, uid) => {
      const bestCost = (paramOf(db, state, best, "receive") - op) * 1.2 + futureCardValue(db, state, p, best) * 0.18;
      const cost = (paramOf(db, state, uid, "receive") - op) * 1.2 + futureCardValue(db, state, p, uid) * 0.18;
      return cost < bestCost ? uid : best;
    });
  }

  const areaWeight: Record<Exclude<Area, "block">, number> = { serve: 5.0, receive: 4.0, toss: 4.3, attack: 5.2 };
  return opts.reduce((best, uid) => {
    const score = paramOf(db, state, uid, area) * areaWeight[area] + skillBonus(cardOf(db, state, uid), area) * 1.4 - futureCardValue(db, state, p, uid) * 0.08;
    const bestScore = paramOf(db, state, best, area) * areaWeight[area] + skillBonus(cardOf(db, state, best), area) * 1.4 - futureCardValue(db, state, p, best) * 0.08;
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

function costScore(cost: Cost): number {
  switch (cost.type) {
    case "guts":
      return cost.count * 1.25;
    case "gutsAny":
    case "gutsFrom":
      return cost.count * 1.05;
    case "dropFromHand":
      return cost.count * 2.4;
    case "handToDeckBottom":
      return cost.count * 1.0;
    case "placeEventFromHand":
      return 1.2;
    case "millDeck":
      return cost.count * 0.85;
    case "dropChara":
      return 4.2;
    case "dropSelf":
    case "dropSelfFromCourt":
      return 3.2;
    case "selfToDeckBottom":
      return 2.4;
    case "moveOpponentEventCost":
      return -1.6;
    case "tilt":
      return 0.15;
    default:
      return 1;
  }
}

function costsScore(costs: Cost[] | undefined): number {
  return (costs ?? []).reduce((sum, cost) => sum + costScore(cost), 0);
}

function actionScore(db: CardDb, state: GameState, p: PlayerId, action: Action): number {
  switch (action.op) {
    case "draw":
      return Math.max(0, action.count * 1.8 - deckRisk(state, p) - (action.upTo ? 0.15 : 0));
    case "drawToHandSize":
      return Math.max(0, action.size - state.players[p].hand.length) * 1.8;
    case "dropToHand":
    case "eventAreaToHand":
      return action.count * 2.1;
    case "gutsToHandAny":
      return action.upTo * 2.1;
    case "gutsToHand":
      return action.count * 1.8;
    case "forceDrop":
      return action.count * 2.45;
    case "addParam":
      return action.amount * phaseParamDemand(state, p, action.param === "choose" ? currentNeed(state) ?? "attack" : action.param);
    case "setParam":
      return Math.max(0, action.value) * phaseParamDemand(state, p, action.param);
    case "setParamToBase":
      return 1.3;
    case "addOpponentOp":
      return action.amount < 0 ? -action.amount * 2.6 : action.amount * -1.8;
    case "setOwnOp":
    case "calcAttackOpAs":
      return action.value * 1.6;
    case "lostOpponent":
      return 9;
    case "restrict": {
      const r = action.restriction;
      return 2.4 + (r.maxCount === 0 ? 2.4 : 0) + (r.blockFailIfDpMax ? 2.8 : 0) + (r.preventOpDecrease ? 1.3 : 0) + (r.banHandAdd ? 1.6 : 0);
    }
    case "watch":
      return 1.6 + actionsScore(db, state, p, action.actions) * 0.35;
    case "gate": {
      const weight = conditionWeight(db, state, p, action.cond);
      const thenScore = actionsScore(db, state, p, action.then) - costsScore(action.costs);
      const elseScore = actionsScore(db, state, p, action.else ?? []);
      return Math.max(elseScore, weight * thenScore);
    }
    case "if":
      return conditionWeight(db, state, p, action.cond) * actionsScore(db, state, p, action.then);
    case "chooseOne":
      return Math.max(action.optional ? 0 : -Infinity, ...action.options.map((o) => actionsScore(db, state, p, o.actions)));
    case "revealTopTutor":
    case "lookTopTutor":
      return action.upTo * 1.9;
    case "deployFromDrop":
    case "deployFromGuts":
      return Math.max(1, phaseParamDemand(state, p, action.area) * 1.4) + actionsScore(db, state, p, action.then ?? []);
    case "moveCharaToHand":
      return action.upTo * 1.7;
    case "dropOpponentGuts":
      return action.upTo * 1.65;
    case "moveOpponentEvent":
      return (action.count ?? action.upTo ?? 1) * 1.8;
    case "handToGuts":
    case "moveGutsToArea":
      return action.upTo * 0.8;
    case "dropTarget":
      return 2.2;
    case "opponentMayPlaceEvent":
      return actionsScore(db, state, p, action.else) * 0.55;
    case "keyword":
      if (action.name === "ワンタッチ") return 3 + (action.n ?? 0) * 2;
      if (action.name === "ドシャット") return 4 + (action.n ?? 0) * 1.5;
      if (action.name === "フェイント" || action.name === "ツーアタック") return 4 + (action.n ?? 0) * 1.4;
      if (action.name === "ブロックアウト") return 5 + (action.n ?? 0);
      if (action.name === "Aパス") return 2.5 + (action.n ?? 0);
      return 0.4;
    case "millTop":
      return (actionsScore(db, state, p, action.then ?? []) + (action.milledMatch ? 1.1 : 0)) - action.upTo * (0.45 + deckRisk(state, p) * 0.2);
    case "millTopAll":
      return actionsScore(db, state, p, action.then ?? []) - action.count * 0.45;
    case "dropFromHand":
      return -action.count * 1.8;
    case "handToDeckBottom":
    case "handToDeckTop":
      return -action.count * 0.7;
    case "shuffleHandIntoDeck":
      return action.player === "opponent" ? 2.2 : -1.4;
    case "coinFlip":
      return (actionsScore(db, state, p, action.heads) + actionsScore(db, state, p, action.tails)) / 2;
    case "moveSelfToBlockSide":
      return 1.1;
    case "revealTopCheck":
      return actionsScore(db, state, p, action.then) * 0.65;
    case "script":
      return 1.5;
    case "skipToPhase":
      return action.phase === "end" ? 2.5 : 1.5;
    default:
      return 0.8;
  }
}

function actionsScore(db: CardDb, state: GameState, p: PlayerId, actions: Action[] | undefined): number {
  return (actions ?? []).reduce((sum, action) => sum + actionScore(db, state, p, action), 0);
}

function freeSkillScore(db: CardDb, state: GameState, p: PlayerId, uid: number, skillIndex: number): number {
  const skill = skillOf(cardOf(db, state, uid), skillIndex);
  if (!skill || skill.kind !== "active") return -Infinity;
  return actionsScore(db, state, p, skill.actions) - costsScore(skill.costs) - 0.35;
}

function freeEventScore(db: CardDb, state: GameState, p: PlayerId, uid: number): number {
  const skill = effectOf(cardOf(db, state, uid))?.skills.find((s): s is Extract<SkillDef, { kind: "event" }> => s.kind === "event");
  if (!skill) return -Infinity;
  return actionsScore(db, state, p, skill.actions) - 0.45;
}

function chooseFreeAction(db: CardDb, state: GameState, p: PlayerId): Decision {
  const fo = freeOptions(db, state);
  const eventChoices = fo.events.map((e) => ({ type: "event" as const, uid: e.uid, score: freeEventScore(db, state, p, e.uid) }));
  const skillChoices = fo.skills.map((s) => ({ type: "skill" as const, uid: s.uid, skillIndex: s.skillIndex, score: freeSkillScore(db, state, p, s.uid, s.skillIndex) }));
  const best = [...eventChoices, ...skillChoices].sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 1.15) return { type: "free", action: "pass" };
  if (best.type === "event") return { type: "free", action: "event", uid: best.uid };
  return { type: "free", action: "skill", uid: best.uid, skillIndex: best.skillIndex };
}

function gateAcceptScore(db: CardDb, state: GameState, p: PlayerId, aw: Extract<Awaiting, { kind: "confirm" }>): number {
  if (aw.what === "draw") return (aw.count ?? 1) * 1.8 - deckRisk(state, p);
  if (aw.what === "mill") return actionsScore(db, state, p, aw.then) - 1.2;
  return actionsScore(db, state, p, aw.then) - costsScore(aw.costs);
}

function cardSortValue(db: CardDb, state: GameState, p: PlayerId, uid: number, purpose: string): number {
  if (purpose === "target") {
    const aw = state.effectCtx?.awaiting;
    const param = aw?.kind === "cards" && aw.param && aw.param !== "choose" ? aw.param : currentNeed(state) ?? "attack";
    const amount = aw?.kind === "cards" ? aw.amount ?? 1 : 1;
    return effParamOf(db, state, uid, param as ParamName) * Math.sign(amount) + futureCardValue(db, state, p, uid) * 0.15;
  }
  if (purpose === "deployFromDrop" || purpose === "deployFromGuts") {
    const aw = state.effectCtx?.awaiting;
    const area = aw?.kind === "cards" && aw.area ? aw.area : currentNeed(state) ?? "attack";
    return paramOf(db, state, uid, area) * 2.4 + futureCardValue(db, state, p, uid) * 0.3;
  }
  if (purpose === "dropOppGuts" || purpose === "moveOpponentEvent" || purpose === "moveOpponentEventCost") {
    return futureCardValue(db, state, other(p), uid);
  }
  return futureCardValue(db, state, p, uid);
}

function takeSorted<T>(items: T[], count: number): T[] {
  return count <= 0 ? [] : items.slice(0, count);
}

function chooseByValue(db: CardDb, state: GameState, p: PlayerId, aw: Extract<Awaiting, { kind: "cards" }>, order: CandidateOrder): number[] {
  const sorted = aw.candidates
    .slice()
    .sort((a, b) => (order === "high" ? cardSortValue(db, state, p, b, aw.purpose) - cardSortValue(db, state, p, a, aw.purpose) : cardSortValue(db, state, p, a, aw.purpose) - cardSortValue(db, state, p, b, aw.purpose)));
  const targetCount = Math.min(aw.max, Math.max(aw.min, sorted.filter((uid) => cardSortValue(db, state, p, uid, aw.purpose) > 1.1).length));
  return takeSorted(sorted, targetCount);
}

function chooseEffectCards(db: CardDb, state: GameState): number[] {
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
      return chooseByValue(db, state, p, aw, "low").slice(0, Math.max(aw.min, Math.min(aw.max, aw.min || 1)));
    case "forceDrop":
      return chooseByValue(db, state, p, aw, "low").slice(0, aw.max);
    case "tutor":
    case "moveToHand":
    case "dropToHand":
    case "eventToHand":
    case "gutsToHandAny":
    case "deployFromDrop":
    case "deployFromGuts":
      return chooseByValue(db, state, ctx.player, aw, "high");
    case "gutsToHand":
      return autoPickCards(db, state);
    case "target":
    case "dropOppGuts":
    case "moveOpponentEvent":
    case "moveOpponentEventCost":
    case "moveGuts":
      return chooseByValue(db, state, ctx.player, aw, "high");
    case "placeEventOpponent": {
      const low = chooseByValue(db, state, p, aw, "low");
      const cheapest = low[0];
      return cheapest !== undefined && futureCardValue(db, state, p, cheapest) < 4 ? [cheapest] : [];
    }
    default:
      return autoPickCards(db, state);
  }
}

function chooseEffectOption(db: CardDb, state: GameState): number {
  const ctx = state.effectCtx;
  const aw = ctx?.awaiting;
  if (!ctx || !aw || aw.kind !== "option") return 0;
  if (aw.purpose === "param") {
    let bestIndex = 0;
    let bestScore = -Infinity;
    aw.options.forEach((param, index) => {
      const score = phaseParamDemand(state, ctx.player, param) + effParamOf(db, state, aw.targetUid, param) * 0.2;
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
    const score = branch ? actionsScore(db, state, ctx.player, branch) : label.includes("不使用") ? 0 : -0.1;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function pendingItemScore(db: CardDb, state: GameState, p: PlayerId, item: PendingItem): number {
  if (item.actions) return actionsScore(db, state, p, item.actions) + (item.player === p ? 0.8 : -0.2);
  const card = cardOf(db, state, item.source);
  const skill = item.skillIndex !== undefined ? skillOf(card, item.skillIndex) : null;
  if (skill && "actions" in skill) return actionsScore(db, state, p, skill.actions) + (item.player === p ? 0.8 : -0.2);
  return item.player === p ? 0.5 : 0;
}

function choosePending(db: CardDb, state: GameState, p: PlayerId, candidates: number[]): number {
  const items = candidates
    .map((id) => state.pendingQueue.find((x) => x.id === id))
    .filter((x): x is PendingItem => !!x)
    .map((item) => ({ item, score: pendingItemScore(db, state, p, item) }));
  const best = items.sort((a, b) => b.score - a.score)[0]?.item.id;
  return best ?? candidates[0]!;
}

export function heuristicAiDecision(db: CardDb, state: GameState): Decision {
  const pd = state.pendingDecision;
  if (!pd) throw new Error("沒有待決策");
  const p = pd.player as PlayerId;

  switch (pd.type) {
    case "serve-rights":
      return { type: "serve-rights", take: true };

    case "mulligan":
      return { type: "mulligan", returnUids: chooseMulligan(db, state, p) };

    case "defense-choice": {
      const op = incomingOp(state, p);
      const receiveUid = chooseDeployUid(db, state, p, "receive");
      const receiveCost = receiveUid === null ? Infinity : futureCardValue(db, state, p, receiveUid) * 0.18 + Math.max(0, paramOf(db, state, receiveUid, "receive") - op) * 0.8;
      const block = canChooseBlock(state) ? bestBlockPlan(db, state, p, op) : null;
      if (receiveUid !== null && (!block || receiveCost <= block.cost + 1.5)) return { type: "defense-choice", choice: "receive" };
      if (block) return { type: "defense-choice", choice: "block" };
      return { type: "defense-choice", choice: "receive" };
    }

    case "deploy-serve": {
      const uid = chooseDeployUid(db, state, p, "serve");
      return { type: "deploy-serve", uid, nameChoice: uid === null ? undefined : pickDeployName(db, state, p, uid, "serve") };
    }

    case "deploy-receive": {
      const uid = chooseDeployUid(db, state, p, "receive");
      return { type: "deploy-receive", uid, nameChoice: uid === null ? undefined : pickDeployName(db, state, p, uid, "receive") };
    }

    case "deploy-toss":
    case "deploy-attack": {
      const area = pd.type.slice("deploy-".length) as "toss" | "attack";
      const uid = chooseDeployUid(db, state, p, area);
      return { type: pd.type, uid, nameChoice: uid === null ? undefined : pickDeployName(db, state, p, uid, area) } as Decision;
    }

    case "deploy-block": {
      const plan = bestBlockPlan(db, state, p, incomingOp(state, p));
      if (!plan) return { type: "deploy-block", uids: null };
      return { type: "deploy-block", uids: plan.uids, center: plan.center, nameChoices: plan.nameChoices };
    }

    case "free":
      return chooseFreeAction(db, state, p);

    case "pick-set-card":
      return { type: "pick-set-card", index: 0 };

    case "resolve-pending":
      return { type: "resolve-pending", id: choosePending(db, state, p, pd.candidates ?? []) };

    case "effect-confirm": {
      const aw = state.effectCtx?.awaiting;
      const accept = aw?.kind === "confirm" ? gateAcceptScore(db, state, p, aw) >= 0.7 : true;
      return { type: "effect-confirm", accept };
    }

    case "effect-cards":
      return { type: "effect-cards", uids: chooseEffectCards(db, state) };

    case "effect-option":
      return { type: "effect-option", index: chooseEffectOption(db, state) };

    default:
      throw new Error(`啟發式 AI 未支援的決策型別 ${pd.type}`);
  }
}
