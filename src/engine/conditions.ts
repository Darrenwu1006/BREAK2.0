// 篩選與條件（拆分自 effects.ts）[Claude 2026-07-16]
// 責任：CharaFilter/Condition/Cost 的判定與費用展開（matchFilter/evalCond/costPayable/costOps/isSkillInvalid）。
// 依賴方向：conditions → effect-helpers → (types, dsl)。

import { centerBlockNegated } from "./deploy-legality";
import type { CharaFilter, Condition, Cost, CourtArea, ParamName } from "./dsl";
import type { CardDb, GameState, PlayerId, RtAction } from "./types";
import { allGutsOf, baseParam, cardOf, charaAreaOf, charasOf, effParam, effectDefOf, eventTimingsOf, gutsFor, matchEventAreaFilter, maxDistinctAffiliations, nameOf, normName, other, playTimingsOf, topChara } from "./effect-helpers";

export function matchFilter(db: CardDb, state: GameState, uid: number, f: CharaFilter, area?: CourtArea | null): boolean {
  const c = cardOf(db, state, uid);
  if (f.names && !f.names.map(normName).includes(nameOf(db, state, uid))) return false;
  if (f.affiliation && !c.affiliations.includes(f.affiliation)) return false;
  if (f.position && !c.positions.includes(f.position)) return false;
  if (f.positionsAny && !f.positionsAny.some((x) => c.positions.includes(x))) return false;
  if (f.gradesAny && !f.gradesAny.some((g) => c.grades.includes(g))) return false;
  if (f.area && (area == null || !f.area.includes(area))) return false;
  if (f.baseParamMax) {
    const b = baseParam(db, state, uid, f.baseParamMax.param);
    if (b === null || b > f.baseParamMax.value) return false;
  }
  if (f.baseParamEq) {
    const b = baseParam(db, state, uid, f.baseParamEq.param);
    if (b !== f.baseParamEq.value) return false;
  }
  if (f.notNames && f.notNames.map(normName).includes(nameOf(db, state, uid))) return false;
  if (f.effParamMin) {
    const v = paramForFilter(db, state, uid, f.effParamMin.param);
    if (v === null || v < f.effParamMin.value) return false;
  }
  if (f.effParamEq) {
    const v = paramForFilter(db, state, uid, f.effParamEq.param);
    if (v !== f.effParamEq.value) return false;
  }
  if (f.skillless && effectDefOf(db, state, uid)) return false;
  if (f.blockRole) {
    const isCenter = state.players.some((ps) => topChara(ps.blockCenter) === uid);
    const isSide = state.players.some((ps) => ps.blockSides.includes(uid));
    if (f.blockRole === "center" ? !isCenter : !isSide) return false;
  }
  return true;
}

/** filter 用的目前參數值（センターブロッカー無視中＝參照不可 Q373/Q457 → null） */
function paramForFilter(db: CardDb, state: GameState, uid: number, p: ParamName): number | null {
  if (p === "block") {
    for (const pid of [0, 1] as const) if (centerBlockNegated(state, pid, uid)) return null;
  }
  return effParam(db, state, uid, p);
}


export function evalCond(db: CardDb, state: GameState, ctx: { player: PlayerId; source: number; origin?: "hand" | "other"; lastTarget: number | null; triggerUid?: number | null }, cond: Condition): boolean {
  const p = ctx.player;
  switch (cond.type) {
    case "opponentOp": {
      const op = state.op;
      if (!op || op.owner === p) return false;
      if (cond.source && !cond.source.includes(op.source as "serve" | "block" | "attack")) return false;
      if (cond.max !== undefined && op.value > cond.max) return false;
      if (cond.min !== undefined && op.value < cond.min) return false;
      return true;
    }
    case "selfArea": {
      const a = charaAreaOf(state, p, ctx.source);
      return a !== null && cond.area.includes(a);
    }
    case "handMax":
      return state.players[cond.player === "opponent" ? other(p) : p].hand.length <= cond.count;
    case "handMin":
      return state.players[cond.player === "opponent" ? other(p) : p].hand.length >= cond.count;
    case "setTotalMax":
      return state.players[0].setArea.length + state.players[1].setArea.length <= cond.count;
    case "deployedFromHand":
      return ctx.origin === "hand";
    case "deployedBySkill":
      return ctx.origin === "other"; // 效果登場（手札からの通常登場以外）
    case "deployedByCard":
      return (ctx as { byCard?: string }).byCard === normName(cond.name);
    case "dropDistinctNames": {
      const names = new Set<string>();
      for (const uid of state.players[p].drop) {
        const c = cardOf(db, state, uid);
        if (c.type !== "CHARACTER" || !c.affiliations.includes(cond.affiliation)) continue; // Q360 限キャラカード
        names.add(normName(c.nameJa));
      }
      return names.size >= cond.min;
    }
    case "addedThisSkill":
      return ((ctx as { addedToHand?: number }).addedToHand ?? 0) >= cond.min;
    case "gutsParity": {
      const stack = cond.area === "block" ? state.players[p].blockCenter : state.players[p][cond.area];
      const n = Math.max(0, stack.length - 1);
      return cond.parity === "odd" ? n % 2 === 1 : n % 2 === 0;
    }
    case "milledIs": {
      const milled = (ctx as { milled?: number[] }).milled;
      if (!milled?.length) return false;
      return cardOf(db, state, milled[milled.length - 1]!).affiliations.includes(cond.affiliation);
    }
    case "selfIsSideBlocker":
      return state.players[p].blockSides.includes(ctx.source);
    case "paidGutsAll": {
      const paid = (ctx as { paidGuts?: number[] }).paidGuts;
      if (!paid?.length) return false;
      return paid.every((u) => matchFilter(db, state, u, cond.filter));
    }
    case "chara": {
      const who = cond.player === "opponent" ? other(p) : p;
      const n = charasOf(state, who).filter((c) => matchFilter(db, state, c.uid, cond.filter, c.area)).length;
      return n >= (cond.minCount ?? 1);
    }
    case "allCharas": {
      const cs = charasOf(state, p);
      if (cs.length === 0) return false; // Q404：0 人不成立
      const affs = cond.affiliationsAny ?? (cond.affiliation ? [cond.affiliation] : []);
      // 「すべてがXかすべてがY」＝存在 aff 使全員具該所属（非「全員∈{X,Y}」）
      return affs.some((aff) => cs.every((c) => cardOf(db, state, c.uid).affiliations.includes(aff)));
    }
    case "distinctAffiliationCharas":
      return maxDistinctAffiliations(charasOf(state, p).map((c) => cardOf(db, state, c.uid).affiliations)) >= cond.min;
    case "eventAreaCount": {
      const who = cond.player === "opponent" ? other(p) : p;
      let n = 0;
      for (const uid of state.players[who].eventArea) {
        const c = cardOf(db, state, uid);
        if (cond.name && nameOf(db, state, uid) !== normName(cond.name)) continue;
        if (cond.affiliation && !c.affiliations.includes(cond.affiliation)) continue;
        if (cond.playTimingAny && !eventTimingsOf(db, state, uid).some((t) => cond.playTimingAny!.includes(t))) continue;
        n++; // 每張卡計 1 次（Q294）
      }
      if (cond.min !== undefined && n < cond.min) return false;
      if (cond.max !== undefined && n > cond.max) return false;
      return true;
    }
    case "phaseIs":
      return state.phase === cond.phase;
    case "targetIs":
      return ctx.lastTarget !== null && matchFilter(db, state, ctx.lastTarget, cond.filter, charaAreaOf(state, p, ctx.lastTarget));
    case "triggerIs":
      return ctx.triggerUid != null && matchFilter(db, state, ctx.triggerUid, cond.filter, charaAreaOf(state, p, ctx.triggerUid));
    case "targetParam": {
      if (ctx.lastTarget === null) return false;
      const v = effParam(db, state, ctx.lastTarget, cond.param);
      if (v === null) return false;
      if (cond.max !== undefined && v > cond.max) return false;
      if (cond.min !== undefined && v < cond.min) return false;
      return true;
    }
  }
}

export function costPayable(db: CardDb, state: GameState, p: PlayerId, sourceUid: number, costs: Cost[]): boolean {
  for (const c of costs) {
    if (c.type === "guts" && gutsFor(state, p, sourceUid).length < c.count) return false;
    if (c.type === "gutsAny" && allGutsOf(state, p).length < c.count) return false;
    if (c.type === "dropFromHand") {
      const cands = c.filter ? state.players[p].hand.filter((u) => matchFilter(db, state, u, c.filter!)) : state.players[p].hand;
      if (cands.length < c.count) return false;
    }
    if (c.type === "dropSelf" && !state.players[p].hand.includes(sourceUid)) return false;
    if (c.type === "placeSelfInEventArea" && !state.players[p].hand.includes(sourceUid)) return false;
    if (c.type === "placeSelfOnDeckBottom" && !state.players[p].eventArea.includes(sourceUid)) return false;
    if (c.type === "placeGutsOnSelf") {
      const area = charaAreaOf(state, p, sourceUid);
      if (area === null) return false;
      const stack = area === "block" ? state.players[p].blockCenter : state.players[p][area];
      const guts = stack.slice(0, -1); // 頂端（發生源）以外
      if (!guts.some((u) => !c.filter.names || c.filter.names.map(normName).includes(nameOf(db, state, u)))) return false;
    }
    if (c.type === "dropFromEventArea") {
      const cands = state.players[p].eventArea.filter((u) => matchEventAreaFilter(db, state, u, c.filter));
      if (cands.length < c.count) return false;
    }
    if (c.type === "handToDeckBottom" && state.players[p].hand.length < c.count) return false;
    if (c.type === "placeEventFromHand" && !state.players[p].hand.some((u) => {
      const card = cardOf(db, state, u);
      return card.type === "EVENT" && (!c.filter?.affiliation || card.affiliations.includes(c.filter.affiliation));
    })) return false;
    if (c.type === "gutsFrom") {
      if (c.perArea) {
        // 各エリアから count ずつ → 各區のガッツが count 以上必須
        for (const area of c.areas) {
          const stack = area === "block" ? state.players[p].blockCenter : state.players[p][area];
          if (Math.max(0, stack.length - 1) < c.count) return false;
        }
      } else {
        let n = 0;
        for (const area of c.areas) {
          const stack = area === "block" ? state.players[p].blockCenter : state.players[p][area];
          n += Math.max(0, stack.length - 1);
        }
        if (n < c.count) return false;
      }
    }
    if (c.type === "millDeck" && state.players[p].deck.length < c.count) return false;
    if (c.type === "dropChara" && !charasOf(state, p).some((x) => x.area === c.area && (!c.filter || matchFilter(db, state, x.uid, c.filter, x.area)))) return false;
    if (c.type === "dropSelfFromCourt") {
      const ps = state.players[p];
      if (![ps.serve, ps.receive, ps.toss, ps.attack, ps.blockCenter].some((st) => st.includes(sourceUid)) && !ps.blockSides.includes(sourceUid)) return false;
    }
    if (c.type === "selfToDeckBottom" && charaAreaOf(state, p, sourceUid) === null) return false;
    if (c.type === "moveOpponentEventCost") {
      const oppEvents = state.players[other(p)].eventArea;
      if (!oppEvents.some((u) => {
        const card = cardOf(db, state, u);
        return (!c.filter?.names || c.filter.names.map(normName).includes(nameOf(db, state, u)))
          && (!c.filter?.affiliation || card.affiliations.includes(c.filter.affiliation));
      })) return false;
    }
    // tilt：純物理動作，恆可付（Q375）
  }
  return true;
}

export function costOps(costs: Cost[]): RtAction[] {
  const out: RtAction[] = [];
  for (const c of costs) {
    if (c.type === "guts") out.push({ op: "_payGuts", count: c.count });
    else if (c.type === "gutsAny") out.push({ op: "_payGutsAny", count: c.count });
    else if (c.type === "dropFromHand") out.push({ op: "_dropHandCost", count: c.count, filter: c.filter });
    else if (c.type === "dropFromEventArea") out.push({ op: "_dropEventAreaCost", count: c.count, filter: c.filter });
    else if (c.type === "placeSelfOnDeckBottom") out.push({ op: "_placeSelfOnDeckBottomCost" });
    else if (c.type === "placeGutsOnSelf") out.push({ op: "_placeGutsOnSelfCost", filter: c.filter });
    else if (c.type === "handToDeckBottom") out.push({ op: "handToDeckBottom", count: c.count });
    else if (c.type === "placeEventFromHand") out.push({ op: "_placeEventCost", filter: c.filter });
    else if (c.type === "gutsFrom") out.push({ op: "_payGutsFrom", areas: c.areas, count: c.count, perArea: c.perArea });
    else if (c.type === "millDeck") out.push({ op: "_millCost", count: c.count });
    else if (c.type === "dropChara") out.push({ op: "_dropCharaCost", area: c.area, filter: c.filter });
    else if (c.type === "dropSelfFromCourt") out.push({ op: "_dropSelfCourt" });
    else if (c.type === "selfToDeckBottom") out.push({ op: "_selfToDeckBottom" });
    else if (c.type === "moveOpponentEventCost") out.push({ op: "_moveOpponentEventCost", filter: c.filter, destination: c.destination });
    // dropSelf 於宣言當下執行（useSkill）；tilt 無遊戲狀態（Q375）
  }
  return out;
}


/** ターン1：該 turn 中同卡名的自己的卡技能無效（†9-6-4） */
export function isSkillInvalid(db: CardDb, state: GameState, p: PlayerId, uid: number): boolean {
  const n = nameOf(db, state, uid);
  if (state.turn1.some((t) => t.player === p && t.name === n && t.setNo === state.setNo && t.turnNo === state.turnNo)) return true;
  const area = charaAreaOf(state, p, uid);
  return state.restrictions.some((r) =>
    r.player === p && r.disableSkills && r.setNo === state.setNo && r.activeTurn === state.turnNo
    && matchFilter(db, state, uid, r.disableSkills, area));
}
