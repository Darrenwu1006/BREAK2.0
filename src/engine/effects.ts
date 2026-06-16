// 效果系統（M3）：DSL 解釋器、修正層、チェックプロセス待機佇列、遲發監看、登場限制
// 依賴方向：engine.ts → effects.ts → (types, dsl)。共用小工具放這裡，engine 引用。
// 語義依據 RULES_SPEC 第 6/8 節與官方判例（rulings.test.ts 以 Q 編號驗證）。

import type { Card } from "../data/types";
import type { Action, Condition, Cost, CourtArea, CharaFilter, EffectDef, ParamName, PhaseIcon, SkillDef, Target } from "./dsl";
import type { Awaiting, CardDb, EffectCtx, GameEvent, GameState, PendingItem, PlayerId, RtAction, Watcher } from "./types";
import { nextRandom } from "./rng";

// ---------- 共用工具 ----------

export const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);

export function cardOf(db: CardDb, state: GameState, uid: number): Card {
  const c = db.get(state.cards[uid]!);
  if (!c) throw new Error(`unknown card uid=${uid}`);
  return c;
}

export const topChara = (stack: number[]): number | null => (stack.length ? stack[stack.length - 1]! : null);

export function log(state: GameState, player: PlayerId | null, text: string, event?: GameEvent): void {
  state.log.push({ setNo: state.setNo, turnNo: state.turnNo, player, text, ...(event ? { event } : {}) });
}

export function removeFromHand(state: GameState, p: PlayerId, uid: number): void {
  const i = state.players[p].hand.indexOf(uid);
  if (i < 0) throw new Error(`uid ${uid} not in hand`);
  state.players[p].hand.splice(i, 1);
}

/** 抽 N 張（牌組不足時抽到沒有為止 †0-2-5-5） */
export function drawCards(state: GameState, p: PlayerId, n: number): number {
  const ps = state.players[p];
  let drawn = 0;
  while (drawn < n && ps.deck.length > 0) {
    ps.hand.push(ps.deck.shift()!);
    drawn++;
  }
  if (drawn > 0) fireHandAdds(state, p, drawn, "draw");
  return drawn;
}

/** 卡名正規化（官網全形/半形空白混用：「山口　忠」vs「山口 忠」） */
export const normName = (s: string): string => s.replace(/　/g, " ").replace(/\s+/g, " ").trim();

/** 目前卡名（072/073 登場改名生效中則用選定名） */
export function nameOf(db: CardDb, state: GameState, uid: number): string {
  return normName(state.nameOverrides[uid] ?? cardOf(db, state, uid).nameJa);
}

export function effectDefOf(db: CardDb, state: GameState, uid: number): EffectDef | null {
  return (cardOf(db, state, uid).effect as EffectDef | null) ?? null;
}

/** 元々のパラメータ（卡面值；null＝「－」） */
export function baseParam(db: CardDb, state: GameState, uid: number, p: ParamName): number | null {
  const c = cardOf(db, state, uid);
  return c.type === "CHARACTER" && c.params ? c.params[p] : null;
}

/** 修正後參數（修正層 †6-10-1；「－」不受加減 †1-3-2-1；可為負 †2-7-3） */
export function effParam(db: CardDb, state: GameState, uid: number, p: ParamName): number | null {
  const base = baseParam(db, state, uid, p);
  if (base === null) return null;
  let v = base;
  for (const m of state.modifiers) {
    if (m.target !== uid || m.param !== p) continue;
    if (m.kind === "set") v = m.amount; // 固定（後續修正依解決順序再疊加 †0-2-12）
    else v += m.amount;
  }
  return v;
}

/** 玩家所有キャラ（各區頂牌＋サイドブロッカー）†1-2-14 */
export function charasOf(state: GameState, p: PlayerId): { uid: number; area: CourtArea }[] {
  const ps = state.players[p];
  const out: { uid: number; area: CourtArea }[] = [];
  for (const area of ["serve", "receive", "toss", "attack"] as const) {
    const u = topChara(ps[area]);
    if (u !== null) out.push({ uid: u, area });
  }
  const c = topChara(ps.blockCenter);
  if (c !== null) out.push({ uid: c, area: "block" });
  for (const u of ps.blockSides) out.push({ uid: u, area: "block" });
  return out;
}

/** uid 是否為 p 的キャラ，回傳所在區（不是則 null） */
export function charaAreaOf(state: GameState, p: PlayerId, uid: number): CourtArea | null {
  for (const c of charasOf(state, p)) if (c.uid === uid) return c.area;
  return null;
}

/** 對象不再是キャラ時，套用中的修正失效（†6-10-3）；072/073 型改名同時還原（Q226） */
export function purgeModifiers(state: GameState, uid: number): void {
  state.modifiers = state.modifiers.filter((m) => m.target !== uid);
  delete state.nameOverrides[uid];
}

/** 技能來源可付的ガッツ（ブロックエリア＝センターブロッカー下；其餘＝來源卡下）†1-4-8 */
export function gutsFor(state: GameState, p: PlayerId, sourceUid: number): number[] {
  const ps = state.players[p];
  const area = charaAreaOf(state, p, sourceUid);
  if (area === null) return [];
  if (area === "block") return ps.blockCenter.slice(0, -1);
  const stack = ps[area];
  const i = stack.indexOf(sourceUid);
  return i >= 0 ? stack.slice(0, i) : [];
}

const TIMING_MAP: Record<string, PhaseIcon> = {
  發球: "serve",
  攔網: "block",
  抽牌: "draw",
  接球: "receive",
  舉球: "toss",
  攻擊: "attack",
};

/** 事件卡可 play 的 phase（card.timing 中文 → PhaseIcon）†2-12 */
export function playTimingsOf(card: Card): PhaseIcon[] {
  return card.timing.map((t) => TIMING_MAP[t]).filter((t): t is PhaseIcon => !!t);
}

/** 新卡可能只在 skillJa icon 留有時機；effect.phaseIcons 可補足 card.timing 缺漏。 */
export function eventTimingsOf(db: CardDb, state: GameState, uid: number): PhaseIcon[] {
  const card = cardOf(db, state, uid);
  const skill = effectDefOf(db, state, uid)?.skills.find((s) => s.kind === "event");
  return skill?.kind === "event" && skill.phaseIcons?.length ? skill.phaseIcons : playTimingsOf(card);
}

/** 072/073 型置換：登場時必須選卡名 */
export function deployNames(db: CardDb, state: GameState, uid: number): string[] | null {
  const def = effectDefOf(db, state, uid);
  const s = def?.skills.find((s) => s.kind === "deployNameChoice");
  return s && s.kind === "deployNameChoice" ? s.names : null;
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

// ---------- 登場限制 †Q191/Q204 ----------

function restrictionsFor(state: GameState, p: PlayerId, area: CourtArea) {
  return state.restrictions.filter((r) => r.player === p && r.area === area && r.setNo === state.setNo && r.activeTurn === state.turnNo);
}

/** 「スキルでカードを手札に加えられない」生效中（P01-035；Q239~241 含技能/事件抽牌） */
export function banHandAddActive(state: GameState, p: PlayerId): boolean {
  return state.restrictions.some((r) => r.player === p && r.banHandAdd && r.setNo === state.setNo && r.activeTurn === state.turnNo);
}

/** センターブロッカーのブロックP無視中？（Q372~374；P02-027） */
export function centerBlockNegated(state: GameState, p: PlayerId, uid: number): boolean {
  if (topChara(state.players[p].blockCenter) !== uid) return false;
  return state.restrictions.some((r) => r.player === p && r.negateCenterBlock && r.setNo === state.setNo && r.activeTurn === state.turnNo);
}

/** 自分のコート全ガッツ（gutsAny cost 用；Q315） */
function allGutsOf(state: GameState, p: PlayerId): number[] {
  const ps = state.players[p];
  return [...ps.serve.slice(0, -1), ...ps.receive.slice(0, -1), ...ps.toss.slice(0, -1), ...ps.attack.slice(0, -1), ...ps.blockCenter.slice(0, -1)];
}

/** 非抽牌入手 → handAddByEffect 監看觸發（每張一次 Q317；引く以外 Q321） */
function fireHandAdds(state: GameState, actor: PlayerId, count: number, mode: "draw" | "effect" = "effect"): void {
  if (state.phase === "interval") return;
  for (const w of state.watchers) {
    if ((w.trigger.on !== "handAdd" && (w.trigger.on !== "handAddByEffect" || mode === "draw")) || !watcherActive(state, w)) continue;
    if (actor !== other(w.player)) continue; // trigger.player 固定 "opponent"
    for (let k = 0; k < count; k++) {
      if (w.remainingTriggers !== undefined && w.remainingTriggers <= 0) break;
      enqueue(state, { player: w.player, source: w.source, kind: "delayed", actions: w.actions, desc: w.desc });
      if (w.remainingTriggers !== undefined) w.remainingTriggers--;
    }
  }
}

/** 攔網「還可登場」人數（無限制＝3）；maxCount 是 turn 累計上限（Q191/Q196/Q204）。
 *  origin "hand"＝登場步驟視角（fromHandOnly 限制計入 Q：P02-020）；"effect"＝效果登場視角（fromHandOnly 不適用） */
export function blockDeployMax(state: GameState, p: PlayerId, origin: "hand" | "effect" = "hand"): number {
  let remain = 3 - state.blockDeployedThisTurn[p];
  for (const r of restrictionsFor(state, p, "block")) {
    if (r.maxCount === undefined) continue;
    if (r.fromHandOnly) {
      if (origin === "hand") remain = Math.min(remain, r.maxCount - state.blockHandDeploysThisTurn[p]);
    } else {
      remain = Math.min(remain, r.maxCount - state.blockDeployedThisTurn[p]);
    }
  }
  return Math.max(0, remain);
}

/**
 * 單卡可否登場到指定區（參數「－」†1-3-2-2、登場限制、同名禁止 †1-4-5-4-1）。
 * chosenName＝072/073 的選名（未選時以任一可行名判斷）；效果登場（deployFromDrop）也走這裡。
 */
export function canDeployTo(db: CardDb, state: GameState, p: PlayerId, uid: number, area: CourtArea, chosenName?: string, origin: "hand" | "effect" = "hand"): boolean {
  const c = cardOf(db, state, uid);
  if (c.type !== "CHARACTER" || !c.params || c.params[area] === null) return false;
  for (const r of restrictionsFor(state, p, area)) {
    if (r.fromHandOnly && origin !== "hand") continue; // 「手札から」限定（P01-084/P02-097）
    if (r.maxCount === 0) return false;
    if (r.banBaseParamMin) {
      const b = baseParam(db, state, uid, r.banBaseParamMin.param);
      if (b !== null && b >= r.banBaseParamMin.value) return false;
    }
    if (r.banPositions && r.banPositions.some((x) => c.positions.includes(x))) return false;
  }
  // 同名禁止：トス≠レシーブ、アタック≠トス（攔網同名於 deploy-block 整批驗證）
  let banned: string | null = null;
  const ps = state.players[p];
  if (area === "toss") {
    const r = topChara(ps.receive);
    banned = r !== null ? nameOf(db, state, r) : null;
  } else if (area === "attack") {
    const t = topChara(ps.toss);
    banned = t !== null ? nameOf(db, state, t) : null;
  }
  if (banned !== null) {
    const names = deployNames(db, state, uid);
    if (chosenName !== undefined) {
      if (normName(chosenName) === banned) return false;
    } else if (names) {
      if (names.every((n) => normName(n) === banned)) return false; // 兩個名字都撞名才不可（Q279）
    } else if (normName(c.nameJa) === banned) return false;
  }
  return true;
}

// ---------- 篩選與條件 ----------

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

/** 別々の所属のキャラ N 人（†7-1-5：每人抽一個所属，求最大相異數；人數少，直接回溯） */
function maxDistinctAffiliations(lists: string[][]): number {
  let best = 0;
  const used = new Set<string>();
  const dfs = (i: number, count: number) => {
    if (count + (lists.length - i) <= best) return;
    if (i === lists.length) {
      best = Math.max(best, count);
      return;
    }
    for (const a of lists[i]!) {
      if (!used.has(a)) {
        used.add(a);
        dfs(i + 1, count + 1);
        used.delete(a);
      }
    }
    dfs(i + 1, count); // 此人不貢獻新所屬
  };
  dfs(0, 0);
  return best;
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
      return cs.length > 0 && cs.every((c) => cardOf(db, state, c.uid).affiliations.includes(cond.affiliation)); // Q404：0 人不成立
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

function costPayable(db: CardDb, state: GameState, p: PlayerId, sourceUid: number, costs: Cost[]): boolean {
  for (const c of costs) {
    if (c.type === "guts" && gutsFor(state, p, sourceUid).length < c.count) return false;
    if (c.type === "gutsAny" && allGutsOf(state, p).length < c.count) return false;
    if (c.type === "dropFromHand") {
      const cands = c.filter ? state.players[p].hand.filter((u) => matchFilter(db, state, u, c.filter!)) : state.players[p].hand;
      if (cands.length < c.count) return false;
    }
    if (c.type === "dropSelf" && !state.players[p].hand.includes(sourceUid)) return false;
    if (c.type === "handToDeckBottom" && state.players[p].hand.length < c.count) return false;
    if (c.type === "placeEventFromHand" && !state.players[p].hand.some((u) => {
      const card = cardOf(db, state, u);
      return card.type === "EVENT" && (!c.filter?.affiliation || card.affiliations.includes(c.filter.affiliation));
    })) return false;
    if (c.type === "gutsFrom") {
      let n = 0;
      for (const area of c.areas) {
        const stack = area === "block" ? state.players[p].blockCenter : state.players[p][area];
        n += Math.max(0, stack.length - 1);
      }
      if (n < c.count) return false;
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

function costOps(costs: Cost[]): RtAction[] {
  const out: RtAction[] = [];
  for (const c of costs) {
    if (c.type === "guts") out.push({ op: "_payGuts", count: c.count });
    else if (c.type === "gutsAny") out.push({ op: "_payGutsAny", count: c.count });
    else if (c.type === "dropFromHand") out.push({ op: "_dropHandCost", count: c.count, filter: c.filter });
    else if (c.type === "handToDeckBottom") out.push({ op: "handToDeckBottom", count: c.count });
    else if (c.type === "placeEventFromHand") out.push({ op: "_placeEventCost", filter: c.filter });
    else if (c.type === "gutsFrom") out.push({ op: "_payGutsFrom", areas: c.areas, count: c.count });
    else if (c.type === "millDeck") out.push({ op: "_millCost", count: c.count });
    else if (c.type === "dropChara") out.push({ op: "_dropCharaCost", area: c.area, filter: c.filter });
    else if (c.type === "dropSelfFromCourt") out.push({ op: "_dropSelfCourt" });
    else if (c.type === "selfToDeckBottom") out.push({ op: "_selfToDeckBottom" });
    else if (c.type === "moveOpponentEventCost") out.push({ op: "_moveOpponentEventCost", filter: c.filter, destination: c.destination });
    // dropSelf 於宣言當下執行（useSkill）；tilt 無遊戲狀態（Q375）
  }
  return out;
}

// ---------- 觸發與待機佇列 ----------

function watcherActive(state: GameState, w: Watcher): boolean {
  return w.setNo === state.setNo && state.turnNo >= w.turnMin && state.turnNo <= w.turnMax;
}

function enqueue(state: GameState, item: Omit<PendingItem, "id">): void {
  state.pendingQueue.push({ ...item, id: state.nextId++ });
}

function enqueueEventPlayed(db: CardDb, state: GameState, actor: PlayerId, eventUid: number): void {
  for (const owner of [0, 1] as const) {
    for (const source of charasOf(state, owner)) {
      const def = effectDefOf(db, state, source.uid);
      def?.skills.forEach((skill, i) => {
        if (skill.kind !== "passive" || skill.trigger.on !== "eventPlayed") return;
        const expected = skill.trigger.player === "self" ? owner : other(owner);
        if (actor !== expected) return;
        const f = skill.trigger.filter;
        if (f) {
          const card = cardOf(db, state, eventUid);
          if (f.names && !f.names.map(normName).includes(nameOf(db, state, eventUid))) return;
          if (f.affiliation && !card.affiliations.includes(f.affiliation)) return;
        }
        enqueue(state, { player: owner, source: source.uid, kind: "passive", skillIndex: i, triggerUid: eventUid, desc: `${nameOf(db, state, source.uid)} 的事件觸發技能` });
      });
    }
  }
}

/**
 * 登場（共用：手牌登場與效果登場）。處理改名置換（Q284：登場前適用）、疊放蓋牌（†8-3，
 * 被蓋者修正失效 Q207）、登場觸發（自身 [=登場] 被動 †6-6-2-3＋monitoring watchers）。
 */
export function deployCard(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  uid: number,
  area: CourtArea,
  opts: { origin: "hand" | "other"; nameChoice?: string; blockSide?: boolean; byCard?: string },
): void {
  if (opts.nameChoice !== undefined) {
    state.nameOverrides[uid] = normName(opts.nameChoice);
    log(state, p, `${cardOf(db, state, uid).nameJa} 以「${opts.nameChoice}」之名登場`);
  }
  const ps = state.players[p];
  if (area === "block") {
    state.blockDeployedThisTurn[p]++;
    if (opts.origin === "hand") state.blockHandDeploysThisTurn[p]++;
  }
  let coveredUid: number | null = null;
  if (area === "block" && opts.blockSide) {
    ps.blockSides.push(uid);
  } else {
    const stack = area === "block" ? ps.blockCenter : ps[area];
    coveredUid = topChara(stack);
    if (coveredUid !== null) purgeModifiers(state, coveredUid); // 被蓋者非キャラ化 †6-10-3
    stack.push(uid);
    if (coveredUid !== null) {
      // 被蓋者的「上に登場した時」技能（ガッツ狀態下有效 †1-2-15-2-1；P01-047）
      const dc = effectDefOf(db, state, coveredUid);
      dc?.skills.forEach((sk, i) => {
        if (sk.kind !== "passive" || sk.trigger.on !== "covered") return;
        if (sk.trigger.area && !sk.trigger.area.includes(area)) return;
        if (sk.trigger.by && !matchFilter(db, state, uid, sk.trigger.by, area)) return;
        enqueue(state, { player: p, source: coveredUid!, kind: "passive", skillIndex: i, triggerUid: uid, desc: `${nameOf(db, state, coveredUid!)} 的技能（被蓋觸發）` });
      });
    }
  }
  // 自身的 [=登場] 被動（含效果登場 †6-6-2-3；エリアアイコン須符合 †1-3-7）
  const def = effectDefOf(db, state, uid);
  if (def) {
    def.skills.forEach((s, i) => {
      if (s.kind !== "passive" || s.trigger.on !== "deploy") return;
      if (s.areaIcons && !s.areaIcons.includes(area) && !s.areaIcons.includes("court")) return;
      if (s.trigger.overNames) {
        if (coveredUid === null) return;
        if (!s.trigger.overNames.map(normName).includes(nameOf(db, state, coveredUid))) return;
      }
      enqueue(state, { player: p, source: uid, kind: "passive", skillIndex: i, origin: opts.origin, byCard: opts.byCard, desc: `${nameOf(db, state, uid)} 的登場技能` });
    });
  }
  // 場上其他卡的「自分のキャラが登場した時」被動（D02-004 灰羽型）
  for (const c of charasOf(state, p)) {
    if (c.uid === uid) continue;
    const d2 = effectDefOf(db, state, c.uid);
    if (!d2) continue;
    d2.skills.forEach((s, i) => {
      if (s.kind !== "passive" || s.trigger.on !== "allyDeploy") return;
      if (s.trigger.area && !s.trigger.area.includes(area)) return;
      enqueue(state, { player: p, source: c.uid, kind: "passive", skillIndex: i, triggerUid: uid, origin: opts.origin, desc: `${nameOf(db, state, c.uid)} 的技能` });
    });
  }
  // 監看中的遲發（P01-006/010/079、Aパス、ブロックアウト…）
  for (const w of state.watchers) {
    if (w.trigger.on !== "deploy" || !watcherActive(state, w)) continue;
    const expect = w.trigger.player === "self" ? w.player : other(w.player);
    if (p !== expect) continue;
    if (w.trigger.area && !w.trigger.area.includes(area)) continue;
    if (w.trigger.filter && !matchFilter(db, state, uid, w.trigger.filter, area)) continue;
    if (w.remainingTriggers !== undefined && w.remainingTriggers <= 0) continue;
    enqueue(state, { player: w.player, source: w.source, kind: "delayed", actions: w.actions, triggerUid: uid, desc: w.desc });
    if (w.remainingTriggers !== undefined) w.remainingTriggers--;
  }
}

/** ジャッジ成功（block）→ blockSuccess 監看待機（†5-15 ②CP 於消滅前） */
export function onBlockSuccess(db: CardDb, state: GameState): void {
  for (const w of state.watchers) {
    if (w.trigger.on !== "blockSuccess" || !watcherActive(state, w)) continue;
    if (w.player !== state.turnPlayer) continue;
    enqueue(state, { player: w.player, source: w.source, kind: "delayed", actions: w.actions, desc: w.desc });
  }
}

/** エンドフェイズ①：「ターン終了時」監看進入待機（每 turn 至多一次 †5-12-2①）。回傳新增數。 */
export function enqueueTurnEnd(state: GameState): number {
  let n = 0;
  for (const w of state.watchers) {
    if (w.trigger.on !== "turnEnd" || !watcherActive(state, w)) continue;
    if (w.firedTurn === state.turnNo) continue;
    w.firedTurn = state.turnNo;
    enqueue(state, { player: w.player, source: w.source, kind: "delayed", actions: w.actions, desc: w.desc });
    n++;
  }
  return n;
}

/** Lost 宣告：turn 即時終了（†1-4-9-5）→「ターン中」期限的限制/ターン1/改名失效（Q324），
 *  再讓「相手がロストした時」監看進入待機（†5-20-3②）。回傳新增待機數。 */
export function onLostDeclared(db: CardDb, state: GameState, loser: PlayerId): number {
  state.restrictions = state.restrictions.filter((r) => !(r.setNo === state.setNo && r.activeTurn === state.turnNo));
  state.turn1 = [];
  state.nameOverrides = {};
  state.modifiers = [];
  let n = 0;
  for (const w of state.watchers) {
    if (w.trigger.on !== "opponentLost" || !watcherActive(state, w)) continue;
    if (loser !== other(w.player)) continue;
    enqueue(state, { player: w.player, source: w.source, kind: "delayed", actions: w.actions, desc: w.desc });
    n++;
  }
  return n;
}

/** クリンナップ †5-19＋turn 期限到期的狀態清理 */
export function cleanupTurn(state: GameState): void {
  state.blockDeployedThisTurn = [0, 0];
  state.blockHandDeploysThisTurn = [0, 0];
  state.modifiers = [];
  state.nameOverrides = {};
  state.turn1 = [];
  state.watchers = state.watchers.filter((w) => w.setNo === state.setNo && w.turnMax > state.turnNo);
  state.restrictions = state.restrictions.filter((r) => r.setNo === state.setNo && r.activeTurn > state.turnNo);
}

/** ロストセット③④：Set 中的繼續效果/待機全部消滅 †5-20 */
export function clearSetScoped(state: GameState): void {
  state.blockDeployedThisTurn = [0, 0];
  state.blockHandDeploysThisTurn = [0, 0];
  state.modifiers = [];
  state.nameOverrides = {};
  state.turn1 = [];
  state.watchers = [];
  state.restrictions = [];
  state.pendingQueue = [];
  state.effectCtx = null;
  state.judgeSuccess = null;
}

/** 待機項目是否仍可解決（†6-6-3：移入非公開領域/無效化/區域 icon 不再滿足 → 不解決） */
function pendingValid(db: CardDb, state: GameState, item: PendingItem): boolean {
  if (item.kind === "delayed") return true; // 已發生的效果指示獨立於發生源 †6-3-1
  const def = effectDefOf(db, state, item.source);
  const skill = def?.skills[item.skillIndex!];
  if (!skill || skill.kind !== "passive") return false;
  if (isSkillInvalid(db, state, item.player, item.source)) return false;
  if (
    state.restrictions.some((r) => r.player === item.player && r.banOneTouch && r.setNo === state.setNo && r.activeTurn === state.turnNo) &&
    JSON.stringify(skill).includes('"ワンタッチ"')
  )
    return false; // Q356：任意 N 的ワンタッチ皆無效
  if (skill.trigger.on === "covered") {
    // ガッツ狀態下有效（†1-2-15-2-1）：仍在コート疊放區即可
    const ps = state.players[item.player];
    return [ps.serve, ps.receive, ps.toss, ps.attack, ps.blockCenter].some((st) => st.includes(item.source));
  }
  const area = charaAreaOf(state, item.player, item.source);
  if (area === null) return false; // 已離場/被蓋
  if (skill.areaIcons && !skill.areaIcons.includes("court") && !skill.areaIcons.includes(area)) return false;
  return true;
}

/**
 * チェックプロセス †5-4：清掉失效待機後，turn player 優先逐一解決。
 * 回傳 "started"（已建立 effectCtx）/"decision"（需玩家選順序）/"empty"。
 */
export function processQueue(db: CardDb, state: GameState): "started" | "decision" | "empty" {
  state.pendingQueue = state.pendingQueue.filter((it) => pendingValid(db, state, it));
  if (state.pendingQueue.length === 0) return "empty";
  const tp = state.turnPlayer;
  const chooser = state.pendingQueue.some((it) => it.player === tp) ? tp : other(tp);
  const mine = state.pendingQueue.filter((it) => it.player === chooser);
  if (mine.length === 1) {
    startPendingItem(db, state, mine[0]!.id);
    return "started";
  }
  state.pendingDecision = {
    player: chooser,
    type: "resolve-pending",
    prompt: "選擇先解決的待機技能",
    candidates: mine.map((it) => it.id),
  };
  return "decision";
}

export function startPendingItem(db: CardDb, state: GameState, id: number): void {
  const i = state.pendingQueue.findIndex((it) => it.id === id);
  if (i < 0) throw new Error(`待機項目 ${id} 不存在`);
  const item = state.pendingQueue.splice(i, 1)[0]!;
  if (!pendingValid(db, state, item)) return; // 解決前失效 → 待機取消 †6-6-1③
  if (item.kind === "passive") {
    const skill = effectDefOf(db, state, item.source)!.skills[item.skillIndex!]! as Extract<SkillDef, { kind: "passive" }>;
    state.effectCtx = {
      player: item.player,
      source: item.source,
      frames: [{ actions: [...skill.actions], pc: 0 }],
      lastTarget: null,
      triggerUid: item.triggerUid ?? null,
      origin: item.origin,
      byCard: item.byCard,
      turn1: !!skill.turn1,
      anyExecuted: false,
      awaiting: null,
      desc: item.desc,
    };
  } else {
    state.effectCtx = {
      player: item.player,
      source: item.source,
      frames: [{ actions: [...item.actions!], pc: 0 }],
      lastTarget: null,
      triggerUid: item.triggerUid ?? null,
      turn1: false,
      anyExecuted: false,
      awaiting: null,
      desc: item.desc,
    };
  }
  log(state, item.player, `解決：${item.desc}`);
}

// ---------- 自由步驟選項 †5-14 ----------

export interface FreeOption {
  uid: number;
  skillIndex: number;
  label: string;
}

const PHASES6: GameState["phase"][] = ["serve", "block", "draw", "receive", "toss", "attack"];

/** 效果解決後狀況可能改變？（†6-7-1①「狀況完全不變則不可宣言」的保守近似） */
function couldChange(db: CardDb, state: GameState, p: PlayerId, source: number, actions: Action[]): boolean {
  for (const a of actions) {
    if (a.op === "draw") {
      if (state.players[p].deck.length > 0) return true;
    } else if (a.op === "addParam") {
      if (typeof a.target === "object" && a.target.choose) {
        const who = a.target.player === "opponent" ? other(p) : p;
        if (charasOf(state, who).some((c) => matchFilter(db, state, c.uid, a.target as CharaFilter, c.area))) return true;
      } else return true;
    } else return true; // 其他 op 一律視為可改變
  }
  return false;
}

/** turn player 在自由步驟可用的主動技能與事件卡 */
export function freeOptions(db: CardDb, state: GameState): { skills: FreeOption[]; events: { uid: number; label: string }[] } {
  const p = state.turnPlayer;
  const phase = state.phase as PhaseIcon;
  const skills: FreeOption[] = [];
  const events: { uid: number; label: string }[] = [];
  if (!PHASES6.includes(state.phase)) return { skills, events };

  const tryActive = (uid: number, inHand: boolean, area: CourtArea | null) => {
    const def = effectDefOf(db, state, uid);
    if (!def) return;
    def.skills.forEach((s, i) => {
      if (s.kind !== "active") return;
      if (!s.phaseIcons.includes(phase)) return;
      const okArea = s.areaIcons.some((ic) => (ic === "hand" ? inHand : ic === "court" ? area !== null : ic === area));
      if (!okArea) return;
      if (isSkillInvalid(db, state, p, uid)) return;
      if (
        s.phaseIcons.includes("receive") &&
        s.areaIcons.includes("hand") &&
        state.restrictions.some((r) => r.player === p && r.banHandReceiveActive && r.setNo === state.setNo && r.activeTurn === state.turnNo)
      )
        return; // Q357：[=レシーブフェイズ][=手札] 技能無效
      if (s.costs && !costPayable(db, state, p, uid, s.costs)) return;
      const pseudo = { player: p, source: uid, lastTarget: null };
      if (s.cond && !s.cond.every((c) => evalCond(db, state, pseudo, c))) return;
      if (!couldChange(db, state, p, uid, s.actions)) return;
      skills.push({ uid, skillIndex: i, label: `${nameOf(db, state, uid)} 的技能` });
    });
  };
  for (const c of charasOf(state, p)) tryActive(c.uid, false, c.area);
  for (const uid of state.players[p].hand) tryActive(uid, true, null);

  for (const uid of state.players[p].hand) {
    const c = cardOf(db, state, uid);
    if (c.type !== "EVENT") continue;
    if (!eventTimingsOf(db, state, uid).includes(phase)) continue;
    if (!effectDefOf(db, state, uid)?.skills.some((s) => s.kind === "event")) continue; // 未實裝 DSL 的事件卡＝暫不可打
    if (state.restrictions.some((r) => r.player === p && r.banEventTimings?.some((t) => eventTimingsOf(db, state, uid).includes(t)) && r.setNo === state.setNo && r.activeTurn === state.turnNo)) continue;
    events.push({ uid, label: `打出 ${nameOf(db, state, uid)}` }); // ターン1 無效時仍可 play（Q300）
  }
  return { skills, events };
}

/** 宣言使用アクティブ型技能 †6-7（cost 同時執行） */
export function useSkill(db: CardDb, state: GameState, uid: number, skillIndex: number): void {
  const opts = freeOptions(db, state);
  if (!opts.skills.some((s) => s.uid === uid && s.skillIndex === skillIndex)) throw new Error("該技能目前不可使用");
  const p = state.turnPlayer;
  const skill = effectDefOf(db, state, uid)!.skills[skillIndex]! as Extract<SkillDef, { kind: "active" }>;
  log(state, p, `使用 ${nameOf(db, state, uid)} 的技能`);
  if (skill.costs?.some((c) => c.type === "dropSelf")) {
    removeFromHand(state, p, uid);
    state.players[p].drop.push(uid);
    log(state, p, `棄掉 ${nameOf(db, state, uid)}（cost）`);
  }
  state.effectCtx = {
    player: p,
    source: uid,
    frames: [{ actions: [...costOps(skill.costs ?? []), ...skill.actions], pc: 0 }],
    lastTarget: null,
    triggerUid: null,
    turn1: !!skill.turn1,
    anyExecuted: true, // cost 已付＝有變化
    awaiting: null,
    desc: `${nameOf(db, state, uid)} 的技能`,
  };
}

/** プレイ事件卡 †6-8：手札→イベントエリア→使用宣言→解決 */
export function playEvent(db: CardDb, state: GameState, uid: number): void {
  const opts = freeOptions(db, state);
  if (!opts.events.some((e) => e.uid === uid)) throw new Error("該事件卡目前不可打出");
  const p = state.turnPlayer;
  removeFromHand(state, p, uid);
  state.players[p].eventArea.push(uid);
  log(state, p, `打出事件卡 ${nameOf(db, state, uid)}`);
  if (isSkillInvalid(db, state, p, uid)) {
    log(state, p, `${nameOf(db, state, uid)} 的技能已被ターン1無效化，不發生效果`);
    enqueueEventPlayed(db, state, p, uid);
    return; // Q300
  }
  const skill = effectDefOf(db, state, uid)?.skills.find((s) => s.kind === "event") as Extract<SkillDef, { kind: "event" }> | undefined;
  if (!skill) {
    enqueueEventPlayed(db, state, p, uid);
    return;
  }
  state.effectCtx = {
    player: p,
    source: uid,
    frames: [{ actions: [...skill.actions], pc: 0 }],
    lastTarget: null,
    triggerUid: null,
    eventSource: true,
    turn1: !!skill.turn1,
    anyExecuted: false,
    awaiting: null,
    desc: `${nameOf(db, state, uid)} 的效果`,
  };
}

// ---------- 效果解釋器 ----------

function applyMod(db: CardDb, state: GameState, ctx: EffectCtx, targetUid: number, param: ParamName, amount: number): void {
  if (baseParam(db, state, targetUid, param) === null) return; // 「－」不受加減 †1-3-2-1
  for (const pid of [0, 1] as const) {
    if (param === "block" && centerBlockNegated(state, pid, targetUid)) return; // ブロックP無いものとして扱う（Q373）
  }
  state.modifiers.push({ target: targetUid, param, amount, source: ctx.source });
  ctx.anyExecuted = true;
  const v = effParam(db, state, targetUid, param);
  log(state, ctx.player, `${nameOf(db, state, targetUid)} 的${paramLabel(param)}${amount >= 0 ? "+" : ""}${amount}（→${v}）`);
}

function applySetMod(db: CardDb, state: GameState, ctx: EffectCtx, targetUid: number, param: ParamName, value: number): void {
  if (baseParam(db, state, targetUid, param) === null) return; // 「－」不受變更 †1-3-2-1
  for (const pid of [0, 1] as const) if (param === "block" && centerBlockNegated(state, pid, targetUid)) return;
  state.modifiers.push({ target: targetUid, param, amount: value, kind: "set", source: ctx.source });
  ctx.anyExecuted = true;
  log(state, ctx.player, `${nameOf(db, state, targetUid)} 的${paramLabel(param)}變為 ${effParam(db, state, targetUid, param)}`);
}

const PARAM_LABELS: Record<ParamName, string> = { serve: "發球點數", block: "攔網點數", receive: "接球點數", toss: "托球點數", attack: "攻擊點數" };
const paramLabel = (p: ParamName): string => PARAM_LABELS[p];

function pushFrame(ctx: EffectCtx, actions: RtAction[]): void {
  if (actions.length) ctx.frames.push({ actions, pc: 0 });
}

// ---------- 特例腳本 registry（安全網 2）----------

/** script 可讀的唯讀 context（含 db/state 與發生源資訊）。共用 effects.ts 匯出的查詢 helper（charasOf/nameOf/effParam…），不直接改 state。 */
export interface ScriptApi {
  db: CardDb;
  state: GameState;
  player: PlayerId;
  source: number;
  lastTarget: number | null;
  triggerUid: number | null;
}

/** 特例腳本：讀 ScriptApi → 回傳一串 DSL Action（塞回解釋器執行）。
 *  id 命名建議 `card.<卡號>.<skill序>`。可變物件，測試可注入。 */
export const SCRIPTS: Record<string, (api: ScriptApi) => Action[]> = {
  "card.HV-P01-066.condition": ({ db, state, player, source }) => {
    const allKamomedai = charasOf(state, player).length > 0
      && charasOf(state, player).every((c) => cardOf(db, state, c.uid).affiliations.includes("鴎台"));
    const fourAffiliations = maxDistinctAffiliations(charasOf(state, player).map((c) => cardOf(db, state, c.uid).affiliations)) >= 4;
    if (!allKamomedai && !fourAffiliations) return [];
    return [{
      op: "gate",
      costs: [{ type: "guts", count: 3 }],
      then: [
        { op: "addParam", target: "self", param: "attack", amount: 3 },
        { op: "moveOpponentEvent", count: 2, upTo: true, destination: "drop" },
        { op: "if", cond: [{ type: "eventAreaCount", player: "opponent", max: 2 }], then: [{ op: "addParam", target: "self", param: "attack", amount: 1 }] },
      ],
    }];
  },
  "card.HV-P02-004.covered-karasuno": ({ db, state, player, source }) => {
    const area = charaAreaOf(state, player, source);
    if (area === null || area === "block") return [];
    const stack = state.players[player][area];
    const i = stack.indexOf(source);
    const covered = i > 0 ? stack[i - 1] : undefined;
    if (covered === undefined || !cardOf(db, state, covered).affiliations.includes("烏野")) return [];
    return [{
      op: "opponentMayPlaceEvent",
      else: [{ op: "watch", trigger: { on: "handAdd", player: "opponent" }, duration: "nextOpponentTurn", actions: [{ op: "draw", count: 1 }] }],
    }];
  },
  "card.HV-P02-079.choose-guts-area": ({ state, player }) => {
    const areas = [...new Set(charasOf(state, player).map((c) => c.area))];
    if (!areas.length) return [];
    return [{
      op: "chooseOne",
      optional: true,
      options: areas.map((area) => ({
        label: `${area}區`,
        actions: [{ op: "handToGuts", area, filter: { affiliation: "烏野" }, upTo: 1 }],
      })),
    }];
  },
};

/** 展開關鍵字 †9 */
function keywordActions(state: GameState, name: string, n: number): Action[] {
  switch (name) {
    case "ドシャット": // †9-2：ターン終了時、自分の OP は N になる
      return [{ op: "watch", trigger: { on: "turnEnd" }, duration: "thisTurn", actions: [{ op: "setOwnOp", value: n }] }];
    case "ワンタッチ": // †9-3：相手アタック OP −N、跳過ブロックフェイズ→自分のドローフェイズ
      return [{ op: "addOpponentOp", amount: -n }, { op: "skipToPhase", phase: "draw" }];
    case "フェイント": // †9-4：ターン終了時 OP=N＋次の相手ターン禁攔網登場
      return [
        {
          op: "watch",
          trigger: { on: "turnEnd" },
          duration: "thisTurn",
          actions: [{ op: "setOwnOp", value: n }, { op: "restrict", restriction: { area: "block", maxCount: 0 }, duration: "nextOpponentTurn" }],
        },
      ];
    case "ブロックアウト": // †9-5：次の相手ターン中、元々ブロックP≦N の攔網登場 → 相手 Lost
      return [
        {
          op: "watch",
          trigger: { on: "deploy", player: "opponent", area: ["block"], filter: { baseParamMax: { param: "block", value: n } } },
          duration: "nextOpponentTurn",
          actions: [{ op: "lostOpponent" }],
        },
      ];
    case "Aパス": // †9-7：このターン中、トスキャラ登場時トスP+N
      return [
        {
          op: "watch",
          trigger: { on: "deploy", player: "self", area: ["toss"] },
          duration: "thisTurn",
          actions: [{ op: "addParam", target: "trigger", param: "toss", amount: n }],
        },
      ];
    case "ツーアタック": // †9-8：アタック OP 算出＝N、跳過トスフェイズ→自分のエンドフェイズ、次の相手ターン禁攔網
      return [
        { op: "calcAttackOpAs", value: n },
        { op: "skipToPhase", phase: "end" },
        { op: "restrict", restriction: { area: "block", maxCount: 0 }, duration: "nextOpponentTurn" },
      ];
    default:
      log(state, null, `（未實裝關鍵字 ${name}）`);
      return [];
  }
}

function resolveTargetUid(ctx: EffectCtx, t: Target): number | null {
  if (t === "self") return ctx.source;
  if (t === "target") return ctx.lastTarget;
  if (t === "trigger") return ctx.triggerUid;
  return null;
}

/** 跳過進行 †8-6（サイドブロッカー進棄牌 †8-6-6；該 phase 待機消滅 †6-6-3） */
function skipToPhase(state: GameState, phase: "draw" | "end"): void {
  if (state.phase === "block") {
    const ps = state.players[state.turnPlayer];
    ps.drop.push(...ps.blockSides);
    ps.blockSides = [];
  }
  state.pendingQueue = [];
  state.phase = phase;
  state.sub = 0;
  log(state, state.turnPlayer, phase === "draw" ? "跳過攔網階段→自己的抽牌階段" : "跳過托球階段→自己的回合終了");
}

/** 推進效果解決，直到需要輸入（設定 ctx.awaiting）或完成（ctx 清除） */
export function stepEffect(db: CardDb, state: GameState): void {
  const ctx = state.effectCtx;
  if (!ctx || ctx.awaiting) return;
  while (ctx.frames.length) {
    const frame = ctx.frames[ctx.frames.length - 1]!;
    if (frame.pc >= frame.actions.length) {
      ctx.frames.pop();
      continue;
    }
    const a = frame.actions[frame.pc++]!;
    execAction(db, state, ctx, a);
    if (ctx.awaiting) return;
    if (!state.effectCtx) return; // lostOpponent 等中斷
  }
  finishEffect(db, state);
}

function finishEffect(db: CardDb, state: GameState): void {
  const ctx = state.effectCtx;
  if (!ctx) return;
  if (ctx.turn1 && ctx.anyExecuted) {
    const n = nameOf(db, state, ctx.source);
    state.turn1.push({ player: ctx.player, name: n, setNo: state.setNo, turnNo: state.turnNo });
    log(state, ctx.player, `［ターン1］本回合中「${n}」的技能全部無效`);
  }
  const eventSource = ctx.eventSource;
  const eventPlayer = ctx.player;
  const eventUid = ctx.source;
  state.effectCtx = null;
  if (eventSource) enqueueEventPlayed(db, state, eventPlayer, eventUid);
}

function execAction(db: CardDb, state: GameState, ctx: EffectCtx, a: RtAction): void {
  const p = ctx.player;
  const ps = state.players[p];
  switch (a.op) {
    case "draw": {
      if (banHandAddActive(state, p)) {
        log(state, p, "「手札に加えられない」生效中，無法抽牌"); // Q241
        break;
      }
      if (a.upTo) {
        ctx.awaiting = { kind: "confirm", what: "draw", then: [], count: a.count, prompt: `要抽 ${a.count} 張卡嗎？（「まで」可不抽）` };
        break;
      }
      const n = drawCards(state, p, a.count);
      if (n > 0) ctx.anyExecuted = true;
      log(state, p, n ? `抽 ${n} 張卡` : "牌組已空，無法抽牌");
      break;
    }
    case "drawToHandSize": {
      if (banHandAddActive(state, p)) {
        log(state, p, "「手札に加えられない」生效中，無法抽牌");
        break;
      }
      const need = a.size - ps.hand.length;
      if (need <= 0) break; // 已是該狀態 → 不執行（†0-2-5-3）
      const n = drawCards(state, p, need);
      if (n > 0) ctx.anyExecuted = true;
      log(state, p, `抽 ${n} 張卡（補到 ${a.size} 張）`);
      break;
    }
    case "dropToHand": {
      if (banHandAddActive(state, p)) {
        log(state, p, "「手札に加えられない」生效中，無法回收");
        break;
      }
      const cands = ps.drop.filter((u) => {
        const c = cardOf(db, state, u);
        if (a.cardType && c.type !== a.cardType) return false;
        return matchFilter(db, state, u, a.filter);
      });
      if (cands.length === 0) break;
      const min = a.upTo ? 0 : Math.min(a.count, cands.length);
      ctx.awaiting = { kind: "cards", purpose: "dropToHand", candidates: cands, min, max: a.count, prompt: `從棄牌區選擇要加入手牌的卡${a.upTo ? "（可選 0 張）" : ""}` };
      break;
    }
    case "forceDrop": {
      const opp = other(p);
      const oh = state.players[opp].hand;
      if (oh.length === 0) break;
      const n = Math.min(a.count, oh.length);
      if (oh.length === n) {
        for (const uid of [...oh]) {
          removeFromHand(state, opp, uid);
          state.players[opp].drop.push(uid);
        }
        ctx.anyExecuted = true;
        log(state, opp, `棄 ${n} 張手牌（對手效果）`);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "forceDrop", candidates: [...oh], min: n, max: n, chooser: opp, prompt: `選擇要棄掉的 ${n} 張手牌（對手的效果）` };
      }
      break;
    }
    case "addParam": {
      if (typeof a.target === "object" && a.target.choose) {
        const who = a.target.player === "opponent" ? other(p) : p;
        const cands = charasOf(state, who).filter((c) => matchFilter(db, state, c.uid, a.target as CharaFilter, c.area)).map((c) => c.uid);
        if (cands.length === 0) break; // 選不出合法對象 → 該部分不執行 †0-2-5-5
        if (cands.length === 1) {
          ctx.lastTarget = cands[0]!;
          afterTargetChosen(db, state, ctx, cands[0]!, a.param, a.amount);
        } else {
          ctx.awaiting = { kind: "cards", purpose: "target", candidates: cands, min: 1, max: 1, param: a.param, amount: a.amount, prompt: `選擇對象（${paramHint(a.param)}${a.amount >= 0 ? "+" : ""}${a.amount}）` };
        }
      } else {
        const uid = resolveTargetUid(ctx, a.target);
        if (uid === null) break;
        afterTargetChosen(db, state, ctx, uid, a.param, a.amount);
      }
      break;
    }
    case "if": {
      if (a.cond.every((c) => evalCond(db, state, ctx, c))) pushFrame(ctx, [...a.then]);
      break;
    }
    case "gate": {
      if (a.cond && !a.cond.every((c) => evalCond(db, state, ctx, c))) {
        if (a.else) pushFrame(ctx, [...a.else]);
        break;
      }
      const costs = a.costs ?? [];
      if (!costPayable(db, state, p, ctx.source, costs)) {
        if (a.else) pushFrame(ctx, [...a.else]);
        break;
      }
      const costText = costs.map((c) => (c.type === "guts" ? `付 ${c.count} Guts` : c.type === "dropFromHand" ? `棄 ${c.count} 張手牌` : "棄掉此卡")).join("、");
      ctx.awaiting = { kind: "confirm", what: "gate", costs, then: a.then, else: a.else, prompt: costText ? `要${costText}使用技能嗎？` : "要使用技能嗎？" };
      break;
    }
    case "revealTopTutor": {
      if (ps.deck.length === 0) break; // Q206：無法公開的部分跳過
      const uid = ps.deck[0]!;
      ctx.anyExecuted = true;
      log(state, p, `公開牌組頂：${nameOf(db, state, uid)}`);
      if (!banHandAddActive(state, p) && a.names.map(normName).includes(nameOf(db, state, uid))) {
        ctx.awaiting = { kind: "cards", purpose: "tutor", candidates: [uid], min: 0, max: a.upTo, looked: [uid], prompt: `要把 ${nameOf(db, state, uid)} 加入手牌嗎？（不加則置於牌組底）` };
      } else {
        ps.deck.push(ps.deck.shift()!); // 不符 → 牌組底（Q280：以目前卡名比對）
        log(state, p, "公開的卡置於牌組底");
      }
      break;
    }
    case "lookTopTutor": {
      const n = Math.min(a.count, ps.deck.length); // 不足時看到沒有為止（Q197）
      if (n === 0) break;
      const looked = ps.deck.slice(0, n);
      ctx.anyExecuted = true;
      log(state, p, `查看牌組頂 ${n} 張`);
      const cands = banHandAddActive(state, p)
        ? []
        : looked.filter((uid) => {
            if (a.cardType && cardOf(db, state, uid).type !== a.cardType) return false;
            if (a.names && !a.names.map(normName).includes(nameOf(db, state, uid))) return false;
            if (a.affiliation && !cardOf(db, state, uid).affiliations.includes(a.affiliation)) return false;
            return true;
          });
      if (cands.length === 0) {
        for (const uid of looked) {
          ps.deck.splice(ps.deck.indexOf(uid), 1);
          ps.deck.push(uid);
        }
        log(state, p, "查看的卡置於牌組底");
      } else {
        ctx.awaiting = { kind: "cards", purpose: "tutor", candidates: cands, min: 0, max: a.upTo, looked, prompt: "選擇要公開加入手牌的卡（其餘置於牌組底）" };
      }
      break;
    }
    case "chooseOne": {
      const labels = a.options.map((o) => o.label);
      const branches = a.options.map((o) => o.actions);
      if (a.optional) {
        labels.push("不使用");
        branches.push([]);
      }
      ctx.awaiting = { kind: "option", purpose: "chooseOne", labels, branches, prompt: "選擇一項使用" };
      break;
    }
    case "moveSelfToBlockSide": {
      const area = charaAreaOf(state, p, ctx.source);
      if (area === null || area === "block") break; // 不是キャラ或已在攔網區 → 不執行
      const blockers = charasOf(state, p).filter((c) => c.area === "block");
      if (blockers.length >= 3) break; // 補足文：已 3 人
      if (blockers.some((c) => nameOf(db, state, c.uid) === nameOf(db, state, ctx.source))) break; // 補足文：同名 blocker 已在
      if (blockDeployMax(state, p, "effect") < 1) {
        log(state, p, `${nameOf(db, state, ctx.source)} 因登場限制無法移動到攔網區`); // Q196：cost 已付仍不移動
        break;
      }
      const stack = ps[area];
      stack.splice(stack.indexOf(ctx.source), 1); // ガッツ留在原區、效果保留（†1-2-15-3／†3-1-5-1）
      deployCard(db, state, p, ctx.source, "block", { origin: "other", blockSide: true });
      ctx.anyExecuted = true;
      log(state, p, `${nameOf(db, state, ctx.source)} 移動到攔網區（サイドブロッカー）`);
      break;
    }
    case "revealTopCheck": {
      if (ps.deck.length === 0) break;
      const uid = ps.deck.shift()!;
      ctx.anyExecuted = true;
      const c = cardOf(db, state, uid);
      log(state, p, `公開牌組頂：${c.nameJa}，置於牌組底`); // Q210：強制公開
      ps.deck.push(uid);
      const absent = !a.match.affiliationAbsentFromCourt || !charasOf(state, p).some((x) =>
        cardOf(db, state, x.uid).affiliations.some((aff) => c.affiliations.includes(aff)));
      if ((!a.match.affiliation || c.affiliations.includes(a.match.affiliation)) && absent) pushFrame(ctx, [...a.then]);
      break;
    }
    case "millTop": {
      if (ps.deck.length === 0) break;
      ctx.awaiting = { kind: "confirm", what: "mill", then: a.then ?? [], costs: [], prompt: `要把牌組頂 ${a.upTo} 張置入棄牌區嗎？` };
      // 完成邏輯在 applyEffectDecision（需要 milledMatch 資訊 → 暫存於 frame 不可行，重查 action）
      ctx.frames[ctx.frames.length - 1]!.pc--; // 停在本 action，由決策側重新執行
      break;
    }
    case "dropFromHand": {
      const n = Math.min(a.count, ps.hand.length);
      if (n === 0) break; // 可能な限り †0-2-5-5（Q301：有手牌就必須棄）
      if (ps.hand.length === n) {
        for (const uid of [...ps.hand]) {
          removeFromHand(state, p, uid);
          ps.drop.push(uid);
        }
        ctx.anyExecuted = true;
        log(state, p, `棄 ${n} 張手牌`);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "dropHand", candidates: [...ps.hand], min: n, max: n, prompt: `棄 ${n} 張手牌` };
      }
      break;
    }
    case "deployFromDrop": {
      if (a.side && (ps.blockSides.length >= 2 || blockDeployMax(state, p, "effect") < 1)) break; // Q398：側邊已滿不解決
      const cands = ps.drop.filter((uid) => {
        const c = cardOf(db, state, uid);
        return c.type === "CHARACTER" && matchFilter(db, state, uid, a.filter) && canDeployTo(db, state, p, uid, a.area, undefined, "effect");
      });
      if (cands.length === 0) break;
      if (cands.length === 1) {
        completeDeployFromDrop(db, state, ctx, cands[0]!, a.area, a.then ?? [], a.side);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "deployFromDrop", candidates: cands, min: 1, max: 1, area: a.area, then: [...(a.then ?? []), ...(a.side ? [{ op: "__side" } as unknown as Action] : [])], prompt: "選擇從棄牌區登場的卡" }; // Q303：強制
      }
      break;
    }
    case "moveCharaToHand": {
      if (banHandAddActive(state, p)) {
        log(state, p, "「手札に加えられない」生效中");
        break;
      }
      const cands = a.from === "court"
        ? charasOf(state, p).filter((c) => matchFilter(db, state, c.uid, a.filter, c.area)).map((c) => c.uid)
        : (() => {
            const top = topChara(ps[a.from === "block" ? "blockCenter" : a.from]);
            return top !== null && matchFilter(db, state, top, a.filter, a.from) ? [top] : [];
          })();
      if (cands.length === 0) break;
      ctx.awaiting = { kind: "cards", purpose: "moveToHand", candidates: cands, min: 0, max: a.upTo, prompt: `要把 ${nameOf(db, state, cands[0]!)} 加入手牌嗎？（可選 0 張）` }; // Q306：まで可選 0
      break;
    }
    case "gutsToHand": {
      if (banHandAddActive(state, p)) {
        log(state, p, "「手札に加えられない」生效中");
        break;
      }
      const pairOk = (x: number, y: number): boolean => {
        const cx = cardOf(db, state, x);
        const cy = cardOf(db, state, y);
        if (a.affiliation && (!cx.affiliations.includes(a.affiliation) || !cy.affiliations.includes(a.affiliation))) return false;
        if (a.sameAffiliation && !cx.affiliations.some((z) => cy.affiliations.includes(z))) return false;
        if (a.distinctNames && nameOf(db, state, x) === nameOf(db, state, y)) return false; // Q224/Q226：以目前卡名比對
        return true;
      };
      const cands: number[] = [];
      for (const area of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
        const guts = ps[area].slice(0, -1);
        let ok = false;
        for (let i = 0; i < guts.length && !ok; i++)
          for (let j = i + 1; j < guts.length && !ok; j++) if (pairOk(guts[i]!, guts[j]!)) ok = true;
        if (ok) cands.push(...guts.filter((u) => !a.affiliation || cardOf(db, state, u).affiliations.includes(a.affiliation)));
      }
      if (cands.length === 0) break; // Q297：湊不齊整段不執行
      ctx.awaiting = { kind: "cards", purpose: "gutsToHand", candidates: cands, min: a.count, max: a.count, prompt: `從同一區選 ${a.count} 張 Guts 加入手牌${a.distinctNames ? "（卡名須相異）" : ""}` };
      break;
    }
    case "eventAreaToHand": {
      if (banHandAddActive(state, p)) {
        log(state, p, "「手札に加えられない」生效中");
        break;
      }
      const cands = ps.eventArea.filter((u) => {
        if (!a.filter) return true;
        const c = cardOf(db, state, u);
        if (a.filter.names && !a.filter.names.map(normName).includes(nameOf(db, state, u))) return false;
        if (a.filter.affiliation && !c.affiliations.includes(a.filter.affiliation)) return false;
        return true;
      }); // 不限頂牌（Q331/Q368）
      if (cands.length === 0) break;
      const min = a.upTo ? 0 : Math.min(a.count, cands.length);
      ctx.awaiting = { kind: "cards", purpose: "eventToHand", candidates: cands, min, max: a.count, then: a.then, prompt: `從事件區選擇要加入手牌的卡${a.upTo ? "（可選 0 張）" : ""}` };
      break;
    }
    case "handToDeckBottom": {
      const n = Math.min(a.count, ps.hand.length);
      if (n === 0) break;
      if (ps.hand.length === n) {
        for (const uid of [...ps.hand]) {
          removeFromHand(state, p, uid);
          ps.deck.push(uid);
        }
        ctx.anyExecuted = true;
        log(state, p, `${n} 張手牌置於牌組底`);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "handToBottom", candidates: [...ps.hand], min: n, max: n, prompt: `選擇 ${n} 張手牌置於牌組底` };
      }
      break;
    }
    case "handToDeckTop": {
      const n = Math.min(a.count, ps.hand.length);
      if (n === 0) break;
      ctx.awaiting = { kind: "cards", purpose: "handToTop", candidates: [...ps.hand], min: n, max: n, prompt: `選擇 ${n} 張手牌置於牌組頂` };
      break;
    }
    case "deployFromGuts": {
      const pool = a.fromArea
        ? (a.fromArea === "block" ? ps.blockCenter : ps[a.fromArea]).slice(0, -1)
        : allGutsOf(state, p);
      const cands = pool.filter((u) => {
        const c = cardOf(db, state, u);
        return c.type === "CHARACTER" && matchFilter(db, state, u, a.filter) && canDeployTo(db, state, p, u, a.area, undefined, "effect");
      });
      if (cands.length === 0) break;
      const min = Math.min(a.min ?? 0, cands.length);
      ctx.awaiting = { kind: "cards", purpose: "deployFromGuts", candidates: cands, min, max: a.upTo, area: a.area, then: a.then, prompt: `選擇要從ガッツ登場到${a.area}的卡${min ? "" : "（可選 0 張）"}` };
      break;
    }
    case "setParam": {
      const uid = typeof a.target === "object" && a.target.choose
        ? null
        : resolveTargetUid(ctx, a.target as "self" | "target" | "trigger");
      if (typeof a.target === "object" && a.target.choose) {
        const who = a.target.player === "opponent" ? other(p) : p;
        const cands = charasOf(state, who).filter((c) => matchFilter(db, state, c.uid, a.target as CharaFilter, c.area)).map((c) => c.uid);
        if (cands.length === 0) break;
        if (cands.length === 1) {
          applySetMod(db, state, ctx, cands[0]!, a.param, a.value);
        } else {
          ctx.awaiting = { kind: "cards", purpose: "target", candidates: cands, min: 1, max: 1, param: a.param, amount: a.value, then: [{ op: "__setMarker" } as unknown as Action], prompt: `選擇對象（${paramLabel(a.param)}→${a.value}）` };
        }
      } else if (uid !== null) {
        applySetMod(db, state, ctx, uid, a.param, a.value);
      }
      break;
    }
    case "setParamToBase": {
      const apply = (uid: number) => {
        const value = baseParam(db, state, uid, a.param);
        if (value !== null) applySetMod(db, state, ctx, uid, a.param, value);
      };
      if (typeof a.target === "object" && a.target.choose) {
        const who = a.target.player === "opponent" ? other(p) : p;
        const cands = charasOf(state, who).filter((c) => matchFilter(db, state, c.uid, a.target as CharaFilter, c.area)).map((c) => c.uid);
        if (cands.length === 1) apply(cands[0]!);
        else if (cands.length > 1) ctx.awaiting = { kind: "cards", purpose: "target", candidates: cands, min: 1, max: 1, param: a.param, then: [{ op: "__baseMarker" } as unknown as Action], prompt: `選擇要恢復原本${paramLabel(a.param)}的角色` };
      } else {
        const uid = resolveTargetUid(ctx, a.target as "self" | "target" | "trigger");
        if (uid !== null) apply(uid);
      }
      break;
    }
    case "millTopAll": {
      const n = Math.min(a.count, ps.deck.length);
      const milled: number[] = [];
      for (let k = 0; k < n; k++) {
        const uid = ps.deck.shift()!;
        ps.drop.push(uid);
        milled.push(uid);
      }
      if (n > 0) {
        ctx.anyExecuted = true;
        log(state, p, `牌組頂 ${n} 張置入棄牌區`);
      }
      // Q395：0 枚→不成立；Q396：可能な限り棄到沒有為止、全部符合即成立
      if ((!a.requireFull || milled.length === a.count) && a.match && a.then && milled.length > 0 && milled.every((u) => cardOf(db, state, u).affiliations.includes(a.match!.affiliation))) pushFrame(ctx, [...a.then]);
      break;
    }
    case "dropOpponentGuts": {
      const opp = other(p);
      const stack = a.area === "block" ? state.players[opp].blockCenter : state.players[opp][a.area];
      const guts = stack.slice(0, -1);
      if (guts.length === 0) break;
      ctx.awaiting = { kind: "cards", purpose: "dropOppGuts", candidates: guts, min: 0, max: a.upTo, prompt: `選擇要棄掉的對手 ${a.area} 區 Guts（最多 ${a.upTo} 張；Q400 由你選）` };
      break;
    }
    case "coinFlip": {
      const heads = nextRandom(state) < 0.5;
      ctx.anyExecuted = true;
      log(state, p, `擲硬幣：${heads ? "正面" : "反面"}`);
      pushFrame(ctx, heads ? [...a.heads] : [...a.tails]);
      break;
    }
    case "moveGutsToArea": {
      const cands = allGutsOf(state, p).filter((u) => matchFilter(db, state, u, a.filter)); // Q405：任意區
      if (cands.length === 0) break;
      ctx.awaiting = { kind: "cards", purpose: "moveGuts", candidates: cands, min: 0, max: a.upTo, area: a.area, prompt: `選擇要移到${a.area}區當 Guts 的卡（可選 0 張）` };
      break;
    }
    case "watch": {
      const w: Watcher = {
        id: state.nextId++,
        player: p,
        source: ctx.source,
        trigger: a.trigger,
        actions: a.actions,
        setNo: state.setNo,
        turnMin: a.duration === "thisTurn" ? state.turnNo : state.turnNo + 1,
        turnMax: a.duration === "thisTurn" ? state.turnNo : state.turnNo + 1,
        remainingTriggers: a.maxTriggers,
        desc: `${nameOf(db, state, ctx.source)} 的遲發效果`,
      };
      state.watchers.push(w);
      ctx.anyExecuted = true;
      break;
    }
    case "restrict": {
      const target = a.player === "self" ? p : other(p);
      state.restrictions.push({
        player: target,
        area: a.restriction.area,
        maxCount: a.restriction.maxCount,
        banBaseParamMin: a.restriction.banBaseParamMin,
        banHandAdd: a.restriction.banHandAdd,
        fromHandOnly: a.restriction.fromHandOnly,
        negateCenterBlock: a.restriction.negateCenterBlock,
        banOneTouch: a.restriction.banOneTouch,
        banHandReceiveActive: a.restriction.banHandReceiveActive,
        banPositions: a.restriction.banPositions,
        disableSkills: a.restriction.disableSkills,
        banEventTimings: a.restriction.banEventTimings,
        preventOpDecrease: a.restriction.preventOpDecrease,
        blockFailIfDpMax: a.restriction.blockFailIfDpMax,
        setNo: state.setNo,
        activeTurn: a.duration === "thisTurn" ? state.turnNo : state.turnNo + 1,
        desc: `${nameOf(db, state, ctx.source)} 的限制`,
      });
      ctx.anyExecuted = true;
      log(state, p, "對手下回合的登場受到限制");
      break;
    }
    case "keyword": {
      log(state, p, `［${a.name}${a.n !== undefined ? `(${a.n})` : ""}］`);
      ctx.anyExecuted = true;
      pushFrame(ctx, keywordActions(state, a.name, a.n ?? 0));
      break;
    }
    case "setOwnOp": {
      if (state.op && state.op.owner === p) state.op.value = a.value;
      else state.op = { value: a.value, owner: p, source: state.op?.owner === p ? state.op.source : "block" };
      ctx.anyExecuted = true;
      log(state, p, `自己的 OP 變為 ${a.value}`);
      break;
    }
    case "addOpponentOp": {
      if (state.op && state.op.owner !== p && state.op.source === "attack") {
        if (a.amount < 0 && state.restrictions.some((r) => r.player === state.op!.owner && r.preventOpDecrease && r.setNo === state.setNo && r.activeTurn === state.turnNo)) {
          log(state, p, "對手 OP 受效果保護，無法減少");
          break;
        }
        state.op.value += a.amount;
        ctx.anyExecuted = true;
        log(state, p, `對手的 OP ${a.amount >= 0 ? "+" : ""}${a.amount}（→${state.op.value}）`);
      }
      break;
    }
    case "shuffleHandIntoDeck": {
      const who = a.player === "self" ? p : other(p);
      const target = state.players[who];
      target.deck.push(...target.hand.splice(0));
      for (let i = target.deck.length - 1; i > 0; i--) {
        const j = Math.floor(nextRandom(state) * (i + 1));
        [target.deck[i], target.deck[j]] = [target.deck[j]!, target.deck[i]!];
      }
      const n = drawCards(state, who, a.draw);
      ctx.anyExecuted = true;
      log(state, who, `手牌洗回牌組後抽 ${n} 張`);
      break;
    }
    case "moveOpponentEvent": {
      const opp = other(p);
      const cands = state.players[opp].eventArea.filter((u) => {
        const card = cardOf(db, state, u);
        return (!a.filter?.names || a.filter.names.map(normName).includes(nameOf(db, state, u)))
          && (!a.filter?.affiliation || card.affiliations.includes(a.filter.affiliation));
      });
      if (!cands.length) break;
      const min = a.upTo ? 0 : Math.min(a.count, cands.length);
      ctx.awaiting = { kind: "cards", purpose: "moveOpponentEvent", candidates: cands, min, max: Math.min(a.count, cands.length), destination: a.destination, prompt: "選擇要移動的對手事件卡" };
      break;
    }
    case "handToGuts": {
      const dest = a.area === "block" ? ps.blockCenter : ps[a.area];
      if (topChara(dest) === null) break;
      const cands = ps.hand.filter((u) => cardOf(db, state, u).type === "CHARACTER" && (!a.filter || matchFilter(db, state, u, a.filter)));
      if (!cands.length) break;
      ctx.awaiting = { kind: "cards", purpose: "handToGuts", candidates: cands, min: 0, max: Math.min(a.upTo, cands.length), area: a.area, prompt: `選擇要放到${a.area}區作為 Guts 的手牌` };
      break;
    }
    case "gutsToHandAny": {
      if (banHandAddActive(state, p)) break;
      const cands = allGutsOf(state, p).filter((u) => !a.filter || matchFilter(db, state, u, a.filter));
      if (!cands.length) break;
      ctx.awaiting = { kind: "cards", purpose: "gutsToHandAny", candidates: cands, min: 0, max: Math.min(a.upTo, cands.length), prompt: "選擇要加入手牌的 Guts" };
      break;
    }
    case "dropTarget": {
      const uid = resolveTargetUid(ctx, a.target);
      if (uid === null) break;
      const owner = charaAreaOf(state, p, uid) !== null ? p : charaAreaOf(state, other(p), uid) !== null ? other(p) : null;
      if (owner === null) break;
      const ownerState = state.players[owner];
      for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
        const i = ownerState[key].indexOf(uid);
        if (i >= 0) ownerState[key].splice(i, 1);
      }
      const side = ownerState.blockSides.indexOf(uid);
      if (side >= 0) ownerState.blockSides.splice(side, 1);
      purgeModifiers(state, uid);
      ownerState.drop.push(uid);
      ctx.anyExecuted = true;
      log(state, owner, `${nameOf(db, state, uid)} 進入棄牌區`);
      break;
    }
    case "opponentMayPlaceEvent": {
      const opp = other(p);
      const cands = state.players[opp].hand.filter((u) => cardOf(db, state, u).type === "EVENT");
      if (!cands.length) {
        pushFrame(ctx, [...a.else]);
        break;
      }
      ctx.awaiting = { kind: "cards", purpose: "placeEventOpponent", chooser: opp, candidates: cands, min: 0, max: 1, then: a.else, prompt: "可從手牌將 1 張事件卡放到事件區；不放則執行後續效果" };
      break;
    }
    case "skipToPhase": {
      ctx.anyExecuted = true;
      skipToPhase(state, a.phase);
      break;
    }
    case "calcAttackOpAs": {
      state.op = { value: a.value, owner: p, source: "attack" };
      ctx.anyExecuted = true;
      log(state, p, `攻擊 OP 算出＝${a.value}`);
      break;
    }
    case "lostOpponent": {
      ctx.anyExecuted = true;
      state.lostRequest = other(p);
      finishEffect(db, state); // 中斷剩餘指示
      break;
    }
    case "script": {
      // 安全網 2：特例腳本逃生口。script 讀 state 後回傳 Action[] 塞回解釋器（不直接改 state）。
      const fn = SCRIPTS[a.id];
      if (!fn) throw new Error(`未知 script id "${a.id}"`);
      const produced = fn({ db, state, player: p, source: ctx.source, lastTarget: ctx.lastTarget, triggerUid: ctx.triggerUid });
      pushFrame(ctx, produced); // 產生的 actions 執行時自然設 anyExecuted
      break;
    }
    case "_payGuts": {
      const guts = gutsFor(state, p, ctx.source);
      if (guts.length < a.count) throw new Error("Guts 不足（宣言驗證應已擋下）");
      if (guts.length === a.count) {
        payGuts(db, state, ctx, guts);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "guts", candidates: guts, min: a.count, max: a.count, prompt: `選擇要支付的 ${a.count} 張 Guts` };
      }
      break;
    }
    case "_payGutsAny": {
      const guts = allGutsOf(state, p);
      if (guts.length < a.count) throw new Error("Guts 不足（宣言驗證應已擋下）");
      if (guts.length === a.count) {
        payGuts(db, state, ctx, guts);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "guts", candidates: guts, min: a.count, max: a.count, prompt: `從自己的場上選擇要支付的 ${a.count} 張 Guts` };
      }
      break;
    }
    case "_payGutsFrom": {
      const guts: number[] = [];
      for (const area of a.areas) {
        const stack = area === "block" ? ps.blockCenter : ps[area];
        guts.push(...stack.slice(0, -1));
      }
      if (guts.length < a.count) throw new Error("Guts 不足（宣言驗證應已擋下）");
      if (guts.length === a.count) {
        payGuts(db, state, ctx, guts);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "guts", candidates: guts, min: a.count, max: a.count, prompt: `從${a.areas.join("/")}選擇要支付的 ${a.count} 張 Guts（合計 Q251）` };
      }
      break;
    }
    case "_millCost": {
      const milled: number[] = [];
      for (let k = 0; k < a.count && ps.deck.length > 0; k++) {
        const uid = ps.deck.shift()!;
        ps.drop.push(uid);
        milled.push(uid);
        log(state, p, `牌組頂 ${cardOf(db, state, uid).nameJa} 置入棄牌區（cost）`);
      }
      ctx.milled = [...(ctx.milled ?? []), ...milled];
      ctx.anyExecuted = true;
      break;
    }
    case "_dropCharaCost": {
      const cands = charasOf(state, p).filter((x) => x.area === a.area && (!a.filter || matchFilter(db, state, x.uid, a.filter, x.area))).map((x) => x.uid);
      if (cands.length === 0) throw new Error("無可棄的キャラ（宣言驗證應已擋下）");
      if (cands.length === 1) {
        dropChara(db, state, ctx, cands[0]!);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "dropChara", candidates: cands, min: 1, max: 1, prompt: "選擇要棄掉的キャラ（cost）" };
      }
      break;
    }
    case "_placeEventCost": {
      const cands = ps.hand.filter((u) => {
        const card = cardOf(db, state, u);
        return card.type === "EVENT" && (!a.filter?.affiliation || card.affiliations.includes(a.filter.affiliation));
      });
      if (cands.length === 0) throw new Error("手牌無事件卡（宣言驗證應已擋下）");
      if (cands.length === 1) {
        removeFromHand(state, p, cands[0]!);
        ps.eventArea.push(cands[0]!);
        ctx.anyExecuted = true;
        log(state, p, `${nameOf(db, state, cands[0]!)} 置於事件區（cost；技能不發動 Q337）`);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "placeEvent", candidates: cands, min: 1, max: 1, prompt: "選擇 1 張事件卡置於事件區（技能不發動）" };
      }
      break;
    }
    case "_dropSelfCourt": {
      const stacks = ["serve", "receive", "toss", "attack", "blockCenter"] as const;
      for (const key of stacks) {
        const i = ps[key].indexOf(ctx.source);
        if (i >= 0) {
          ps[key].splice(i, 1);
          break;
        }
      }
      const j = ps.blockSides.indexOf(ctx.source);
      if (j >= 0) ps.blockSides.splice(j, 1);
      purgeModifiers(state, ctx.source);
      ps.drop.push(ctx.source);
      ctx.anyExecuted = true;
      log(state, p, `${nameOf(db, state, ctx.source)} 進入棄牌區（cost）`);
      break;
    }
    case "_selfToDeckBottom": {
      const stacks = ["serve", "receive", "toss", "attack", "blockCenter"] as const;
      for (const key of stacks) {
        const i = ps[key].indexOf(ctx.source);
        if (i >= 0) {
          ps[key].splice(i, 1);
          break;
        }
      }
      const j = ps.blockSides.indexOf(ctx.source);
      if (j >= 0) ps.blockSides.splice(j, 1);
      purgeModifiers(state, ctx.source);
      ps.deck.push(ctx.source);
      ctx.anyExecuted = true;
      log(state, p, `${nameOf(db, state, ctx.source)} 置於牌組底（cost）`);
      break;
    }
    case "_dropHandCost": {
      const cands = a.filter ? ps.hand.filter((u) => matchFilter(db, state, u, a.filter!)) : [...ps.hand];
      if (cands.length < a.count) throw new Error("手牌不足（宣言驗證應已擋下）");
      if (cands.length === a.count) {
        for (const uid of cands) {
          removeFromHand(state, p, uid);
          ps.drop.push(uid);
        }
        ctx.anyExecuted = true;
        log(state, p, `棄 ${a.count} 張手牌（cost）`);
      } else {
        ctx.awaiting = { kind: "cards", purpose: "dropHand", candidates: cands, min: a.count, max: a.count, prompt: `選擇要棄掉的 ${a.count} 張手牌（cost）` };
      }
      break;
    }
    case "_moveOpponentEventCost": {
      const opp = other(p);
      const cands = state.players[opp].eventArea.filter((u) => {
        const card = cardOf(db, state, u);
        return (!a.filter?.names || a.filter.names.map(normName).includes(nameOf(db, state, u)))
          && (!a.filter?.affiliation || card.affiliations.includes(a.filter.affiliation));
      });
      if (!cands.length) throw new Error("對手事件區沒有可支付的卡");
      if (cands.length === 1) {
        state.players[opp].eventArea.splice(state.players[opp].eventArea.indexOf(cands[0]!), 1);
        state.players[opp].deck.push(cands[0]!);
        ctx.anyExecuted = true;
      } else {
        ctx.awaiting = { kind: "cards", purpose: "moveOpponentEventCost", candidates: cands, min: 1, max: 1, destination: a.destination, prompt: "選擇要移到牌組底的對手事件卡（cost）" };
      }
      break;
    }
  }
}

const paramHint = (p: ParamName | "choose"): string => (p === "choose" ? "任一參數" : paramLabel(p));

function afterTargetChosen(db: CardDb, state: GameState, ctx: EffectCtx, uid: number, param: ParamName | "choose", amount: number): void {
  ctx.lastTarget = uid;
  if (param === "choose") {
    const c = cardOf(db, state, uid);
    const options = (["serve", "block", "receive", "toss", "attack"] as const).filter((pn) => c.params && c.params[pn] !== null);
    if (options.length === 0) return;
    if (options.length === 1) {
      applyMod(db, state, ctx, uid, options[0]!, amount);
    } else {
      ctx.awaiting = { kind: "option", purpose: "param", targetUid: uid, amount, options, prompt: `選擇 ${nameOf(db, state, uid)} 要修正的參數（${amount >= 0 ? "+" : ""}${amount}）` };
    }
  } else {
    applyMod(db, state, ctx, uid, param, amount);
  }
}

function payGuts(db: CardDb, state: GameState, ctx: EffectCtx, uids: number[]): void {
  const ps = state.players[ctx.player];
  for (const uid of uids) {
    for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
      const i = ps[key].indexOf(uid);
      if (i >= 0) {
        ps[key].splice(i, 1);
        break;
      }
    }
    ps.drop.push(uid);
  }
  ctx.paidGuts = [...(ctx.paidGuts ?? []), ...uids];
  ctx.anyExecuted = true;
  log(state, ctx.player, `支付 ${uids.length} Guts`);
}

function dropChara(db: CardDb, state: GameState, ctx: EffectCtx, uid: number): void {
  const ps = state.players[ctx.player];
  for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
    const i = ps[key].indexOf(uid);
    if (i >= 0) {
      ps[key].splice(i, 1);
      break;
    }
  }
  const j = ps.blockSides.indexOf(uid);
  if (j >= 0) ps.blockSides.splice(j, 1);
  purgeModifiers(state, uid);
  ps.drop.push(uid);
  ctx.anyExecuted = true;
  log(state, ctx.player, `${nameOf(db, state, uid)} 進入棄牌區（cost）`);
}

function completeDeployFromDrop(db: CardDb, state: GameState, ctx: EffectCtx, uid: number, area: CourtArea, then: Action[], side?: boolean): void {
  const ps = state.players[ctx.player];
  const i = ps.drop.indexOf(uid);
  if (i < 0) throw new Error("卡片不在棄牌區");
  ps.drop.splice(i, 1);
  deployCard(db, state, ctx.player, uid, area, { origin: "other", blockSide: side });
  log(state, ctx.player, `${nameOf(db, state, uid)} 從棄牌區登場 → ${area}`);
  ctx.lastTarget = uid;
  ctx.anyExecuted = true;
  pushFrame(ctx, [...then]);
}

// ---------- 效果決策套用 ----------

export function pendingDecisionForAwaiting(state: GameState): void {
  const ctx = state.effectCtx;
  if (!ctx?.awaiting) return;
  const aw = ctx.awaiting;
  if (aw.kind === "confirm") {
    state.pendingDecision = { player: ctx.player, type: "effect-confirm", prompt: aw.prompt };
  } else if (aw.kind === "cards") {
    state.pendingDecision = { player: aw.chooser ?? ctx.player, type: "effect-cards", prompt: aw.prompt, candidates: aw.candidates, min: aw.min, max: aw.max };
  } else if (aw.purpose === "param") {
    state.pendingDecision = { player: ctx.player, type: "effect-option", prompt: aw.prompt, options: aw.options.map(paramLabel) };
  } else {
    state.pendingDecision = { player: ctx.player, type: "effect-option", prompt: aw.prompt, options: aw.labels };
  }
}

export function applyEffectDecision(db: CardDb, state: GameState, decision: { type: string; [k: string]: unknown }): void {
  const ctx = state.effectCtx;
  if (!ctx?.awaiting) throw new Error("目前沒有效果決策待輸入");
  const aw = ctx.awaiting;

  if (decision.type === "effect-confirm") {
    if (aw.kind !== "confirm") throw new Error("決策型別不符");
    const accept = decision["accept"] as boolean;
    ctx.awaiting = null;
    if (aw.what === "gate") {
      if (accept) pushFrame(ctx, [...costOps(aw.costs ?? []), ...aw.then]);
      else {
        log(state, ctx.player, "選擇不使用技能");
        if (aw.else) pushFrame(ctx, [...aw.else]);
      }
    } else if (aw.what === "draw") {
      if (accept) {
        const n = drawCards(state, ctx.player, aw.count ?? 1);
        if (n > 0) ctx.anyExecuted = true;
        log(state, ctx.player, n ? `抽 ${n} 張卡` : "牌組已空，無法抽牌");
      } else {
        log(state, ctx.player, "選擇不抽牌");
      }
    } else {
      // mill：pc 已回退停在 millTop action，這裡直接完成它
      const frame = ctx.frames[ctx.frames.length - 1]!;
      const act = frame.actions[frame.pc]! as Extract<Action, { op: "millTop" }>;
      frame.pc++;
      if (accept) {
        const ps = state.players[ctx.player];
        const uid = ps.deck.shift();
        if (uid !== undefined) {
          ps.drop.push(uid);
          ctx.anyExecuted = true;
          const c = cardOf(db, state, uid);
          log(state, ctx.player, `牌組頂 ${c.nameJa} 置入棄牌區`);
          const m = act.milledMatch;
          const matched = !m || ((!m.affiliation || c.affiliations.includes(m.affiliation)) && (!m.cardType || c.type === m.cardType));
          if (matched && act.then) pushFrame(ctx, [...act.then]);
        }
      }
    }
    return;
  }

  if (decision.type === "effect-cards") {
    if (aw.kind !== "cards") throw new Error("決策型別不符");
    const uids = decision["uids"] as number[];
    if (uids.length < aw.min || uids.length > aw.max) throw new Error(`須選 ${aw.min}~${aw.max} 張`);
    if (uids.some((u) => !aw.candidates.includes(u)) || new Set(uids).size !== uids.length) throw new Error("選擇了無效的卡");
    const ps = state.players[ctx.player];
    ctx.awaiting = null;
    switch (aw.purpose) {
      case "target":
        if (uids.length === 1) {
          if (aw.then?.some((x) => (x as { op?: string }).op === "__setMarker")) {
            ctx.lastTarget = uids[0]!;
            applySetMod(db, state, ctx, uids[0]!, aw.param as ParamName, aw.amount!);
          } else if (aw.then?.some((x) => (x as { op?: string }).op === "__baseMarker")) {
            ctx.lastTarget = uids[0]!;
            const value = baseParam(db, state, uids[0]!, aw.param as ParamName);
            if (value !== null) applySetMod(db, state, ctx, uids[0]!, aw.param as ParamName, value);
          } else {
            afterTargetChosen(db, state, ctx, uids[0]!, aw.param!, aw.amount!);
          }
        }
        break;
      case "guts":
        payGuts(db, state, ctx, uids);
        break;
      case "dropHand":
        for (const uid of uids) {
          removeFromHand(state, ctx.player, uid);
          ps.drop.push(uid);
        }
        if (uids.length) {
          ctx.anyExecuted = true;
          log(state, ctx.player, `棄 ${uids.length} 張手牌`);
        }
        break;
      case "tutor": {
        for (const uid of aw.looked ?? aw.candidates) {
          const i = ps.deck.indexOf(uid);
          if (i < 0) continue;
          ps.deck.splice(i, 1);
          if (uids.includes(uid)) {
            ps.hand.push(uid);
            ctx.anyExecuted = true;
            log(state, ctx.player, `${nameOf(db, state, uid)} 加入手牌`);
          } else {
            ps.deck.push(uid);
            log(state, ctx.player, "看過的卡置於牌組底");
          }
        }
        ctx.addedToHand = (ctx.addedToHand ?? 0) + uids.length;
        fireHandAdds(state, ctx.player, uids.length); // 非抽牌入手（Q321）
        break;
      }
      case "moveToHand": {
        for (const uid of uids) {
          for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
            const i = ps[key].indexOf(uid);
            if (i >= 0) {
              ps[key].splice(i, 1);
              break;
            }
          }
          const side = ps.blockSides.indexOf(uid);
          if (side >= 0) ps.blockSides.splice(side, 1);
          purgeModifiers(state, uid); // 離開コート → 效果洗掉 †8-4-3
          ps.hand.push(uid);
          ctx.anyExecuted = true;
          log(state, ctx.player, `${nameOf(db, state, uid)} 回到手牌`);
        }
        fireHandAdds(state, ctx.player, uids.length);
        ctx.addedToHand = (ctx.addedToHand ?? 0) + uids.length;
        break;
      }
      case "gutsToHand": {
        if (uids.length) {
          // 驗證：同一區、共通所属（†7-1-5）
          const areaOf = (uid: number): string | null => {
            for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) if (ps[key].slice(0, -1).includes(uid)) return key;
            return null;
          };
          const areas = new Set(uids.map(areaOf));
          if (areas.size !== 1 || areas.has(null)) throw new Error("必須從同一區的 Guts 中選擇");
          const names = uids.map((u) => nameOf(db, state, u));
          if (new Set(names).size !== names.length) {
            const shared = uids.map((u) => cardOf(db, state, u).affiliations).reduce((acc, cur) => acc.filter((x) => cur.includes(x)));
            if (shared.length === 0) throw new Error("所選 Guts 沒有共通所属");
          }
          for (const uid of uids) {
            for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
              const i = ps[key].indexOf(uid);
              if (i >= 0) {
                ps[key].splice(i, 1);
                break;
              }
            }
            ps.hand.push(uid);
          }
          ctx.anyExecuted = true;
          log(state, ctx.player, `${uids.length} 張 Guts 加入手牌`);
          fireHandAdds(state, ctx.player, uids.length);
        }
        break;
      }
      case "dropToHand": {
        for (const uid of uids) {
          const i = ps.drop.indexOf(uid);
          if (i < 0) throw new Error("卡片不在棄牌區");
          ps.drop.splice(i, 1);
          ps.hand.push(uid);
          ctx.anyExecuted = true;
          log(state, ctx.player, `${nameOf(db, state, uid)} 從棄牌區加入手牌`);
        }
        ctx.addedToHand = (ctx.addedToHand ?? 0) + uids.length;
        fireHandAdds(state, ctx.player, uids.length);
        break;
      }
      case "eventToHand": {
        for (const uid of uids) {
          const i = ps.eventArea.indexOf(uid);
          if (i < 0) throw new Error("卡片不在事件區");
          ps.eventArea.splice(i, 1);
          ps.hand.push(uid);
          ctx.anyExecuted = true;
          log(state, ctx.player, `${nameOf(db, state, uid)} 從事件區加入手牌`);
        }
        if (uids.length) {
          ctx.addedToHand = (ctx.addedToHand ?? 0) + uids.length;
          fireHandAdds(state, ctx.player, uids.length);
          if (aw.then) pushFrame(ctx, [...aw.then]); // 「加えた場合」（D03-001）
        }
        break;
      }
      case "handToBottom": {
        for (const uid of uids) {
          removeFromHand(state, ctx.player, uid);
          ps.deck.push(uid);
        }
        if (uids.length) {
          ctx.anyExecuted = true;
          log(state, ctx.player, `${uids.length} 張手牌置於牌組底`);
        }
        break;
      }
      case "handToTop": {
        for (const uid of [...uids].reverse()) {
          removeFromHand(state, ctx.player, uid);
          ps.deck.unshift(uid);
        }
        if (uids.length) ctx.anyExecuted = true;
        break;
      }
      case "gutsToHandAny": {
        for (const uid of uids) {
          for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
            const i = ps[key].indexOf(uid);
            if (i >= 0) ps[key].splice(i, 1);
          }
          ps.hand.push(uid);
        }
        if (uids.length) {
          ctx.anyExecuted = true;
          ctx.addedToHand = (ctx.addedToHand ?? 0) + uids.length;
          fireHandAdds(state, ctx.player, uids.length);
        }
        break;
      }
      case "handToGuts": {
        const dest = aw.area === "block" ? ps.blockCenter : ps[aw.area!];
        for (const uid of uids) {
          removeFromHand(state, ctx.player, uid);
          dest.unshift(uid);
        }
        if (uids.length) ctx.anyExecuted = true;
        break;
      }
      case "moveOpponentEvent":
      case "moveOpponentEventCost": {
        const opp = other(ctx.player);
        const os = state.players[opp];
        for (const uid of uids) {
          os.eventArea.splice(os.eventArea.indexOf(uid), 1);
          if (aw.destination === "deckBottom") os.deck.push(uid);
          else os.drop.push(uid);
        }
        if (uids.length) ctx.anyExecuted = true;
        break;
      }
      case "placeEventOpponent": {
        const opp = other(ctx.player);
        if (uids.length) {
          removeFromHand(state, opp, uids[0]!);
          state.players[opp].eventArea.push(uids[0]!);
          ctx.anyExecuted = true;
        } else if (aw.then) pushFrame(ctx, [...aw.then]);
        break;
      }
      case "placeEvent": {
        for (const uid of uids) {
          removeFromHand(state, ctx.player, uid);
          ps.eventArea.push(uid);
          ctx.anyExecuted = true;
          log(state, ctx.player, `${nameOf(db, state, uid)} 置於事件區（cost；技能不發動 Q337）`);
        }
        break;
      }
      case "dropOppGuts": {
        const opp = other(ctx.player);
        const os = state.players[opp];
        for (const uid of uids) {
          for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
            const i = os[key].indexOf(uid);
            if (i >= 0) {
              os[key].splice(i, 1);
              break;
            }
          }
          os.drop.push(uid);
          ctx.anyExecuted = true;
        }
        if (uids.length) log(state, ctx.player, `棄掉對手 ${uids.length} 張 Guts`);
        break;
      }
      case "moveGuts": {
        for (const uid of uids) {
          for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
            const i = ps[key].indexOf(uid);
            if (i >= 0) {
              ps[key].splice(i, 1);
              break;
            }
          }
          const dest = aw.area === "block" ? ps.blockCenter : ps[aw.area!];
          dest.unshift(uid); // 插入底部＝ガッツ（順序 Master 自由 †1-2-15）
          ctx.anyExecuted = true;
          log(state, ctx.player, `${nameOf(db, state, uid)} 移到 ${aw.area} 區當 Guts`);
        }
        break;
      }
      case "deployFromGuts": {
        for (const uid of uids) {
          for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
            const i = ps[key].indexOf(uid);
            if (i >= 0) {
              ps[key].splice(i, 1);
              break;
            }
          }
          deployCard(db, state, ctx.player, uid, aw.area!, { origin: "other", byCard: nameOf(db, state, ctx.source) });
          ctx.anyExecuted = true;
          ctx.lastTarget = uid;
          log(state, ctx.player, `${nameOf(db, state, uid)} 從ガッツ登場 → ${aw.area}`);
        }
        if (uids.length && aw.then) pushFrame(ctx, [...aw.then]);
        break;
      }
      case "dropChara": {
        for (const uid of uids) dropChara(db, state, ctx, uid);
        break;
      }
      case "forceDrop": {
        const opp = other(ctx.player);
        for (const uid of uids) {
          removeFromHand(state, opp, uid);
          state.players[opp].drop.push(uid);
        }
        if (uids.length) {
          ctx.anyExecuted = true;
          log(state, opp, `棄 ${uids.length} 張手牌（對手效果）`);
        }
        break;
      }
      case "deployFromDrop": {
        const side = aw.then?.some((x) => (x as { op?: string }).op === "__side");
        const rest = (aw.then ?? []).filter((x) => (x as { op?: string }).op !== "__side");
        if (uids.length === 1) completeDeployFromDrop(db, state, ctx, uids[0]!, aw.area!, rest, side);
        break;
      }
    }
    return;
  }

  if (decision.type === "effect-option") {
    if (aw.kind !== "option") throw new Error("決策型別不符");
    const idx = decision["index"] as number;
    if (aw.purpose === "param") {
      if (idx < 0 || idx >= aw.options.length) throw new Error("無效的選項");
      ctx.awaiting = null;
      applyMod(db, state, ctx, aw.targetUid, aw.options[idx]!, aw.amount);
    } else {
      if (idx < 0 || idx >= aw.labels.length) throw new Error("無效的選項");
      ctx.awaiting = null;
      log(state, ctx.player, `選擇：${aw.labels[idx]}`);
      pushFrame(ctx, [...aw.branches[idx]!]);
    }
    return;
  }

  throw new Error(`未知的效果決策 ${decision.type}`);
}

/**
 * 為目前的 effect-cards 決策算出一組合法選擇（AI/模擬共用的保底邏輯）。
 * 取卡類（tutor/moveToHand）取上限（進手牌通常有利）；gutsToHand 找同區共通所属的組合。
 */
export function autoPickCards(db: CardDb, state: GameState): number[] {
  const aw = state.effectCtx?.awaiting;
  if (!aw || aw.kind !== "cards") throw new Error("目前不是 effect-cards 決策");
  if (aw.purpose === "gutsToHand") {
    const ps = state.players[state.effectCtx!.player];
    for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
      const guts = ps[key].slice(0, -1).filter((u) => aw.candidates.includes(u));
      for (let i = 0; i < guts.length; i++)
        for (let j = i + 1; j < guts.length; j++)
          if (cardOf(db, state, guts[i]!).affiliations.some((x) => cardOf(db, state, guts[j]!).affiliations.includes(x)))
            return [guts[i]!, guts[j]!];
    }
    return [];
  }
  if (aw.purpose === "tutor" || aw.purpose === "moveToHand" || aw.purpose === "dropToHand" || aw.purpose === "eventToHand" || aw.purpose === "deployFromGuts") return aw.candidates.slice(0, aw.max);
  return aw.candidates.slice(0, aw.min);
}
