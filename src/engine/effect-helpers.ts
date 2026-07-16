// 效果系統共用查詢工具（拆分自 effects.ts）[Claude 2026-07-16]
// 責任：唯讀查詢與小工具（卡名/參數/場上狀態/時點）。不觸發佇列、不含規則裁定。
// 依賴方向：effect-helpers → (types, dsl, data)；上層單向引用。

import type { Card } from "../data/types";
import type { CourtArea, EffectDef, ParamName, PhaseIcon } from "./dsl";
import type { CardDb, GameEvent, GameState, PlayerId } from "./types";

export const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);
const logSuppressedStates = new WeakSet<GameState>();

export function suppressLogsForState(state: GameState): void {
  logSuppressedStates.add(state);
}

export function cardOf(db: CardDb, state: GameState, uid: number): Card {
  const c = db.get(state.cards[uid]!);
  if (!c) throw new Error(`unknown card uid=${uid}`);
  return c;
}

export const topChara = (stack: number[]): number | null => (stack.length ? stack[stack.length - 1]! : null);

export function log(state: GameState, player: PlayerId | null, text: string, event?: GameEvent): void {
  if (logSuppressedStates.has(state)) return;
  state.log.push({ setNo: state.setNo, turnNo: state.turnNo, player, text, ...(event ? { event } : {}) });
}

export function removeFromHand(state: GameState, p: PlayerId, uid: number): void {
  const i = state.players[p].hand.indexOf(uid);
  if (i < 0) throw new Error(`uid ${uid} not in hand`);
  state.players[p].hand.splice(i, 1);
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
  // 「－されない」守衛：存在 noDecrease modifier 時，忽略該 param 的負向（非 set）修正（†P03-064；Q1514 僅保護本人）
  const guarded = state.modifiers.some((m) => m.kind === "noDecrease" && m.target === uid && m.param === p);
  let v = base;
  for (const m of state.modifiers) {
    if (m.target !== uid || m.param !== p) continue;
    if (m.kind === "noDecrease") continue; // 守衛本身不是數值修正
    if (m.kind === "set") v = m.amount; // 固定（後續修正依解決順序再疊加 †0-2-12）
    else if (!(guarded && m.amount < 0)) v += m.amount;
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

/** dropFromEventArea コストの候選判定（所属＋[=サーブ]等でプレイできる＝playTimingAny；P03-039） */
export function matchEventAreaFilter(db: CardDb, state: GameState, uid: number, filter?: { affiliation?: string; playTimingAny?: PhaseIcon[] }): boolean {
  if (!filter) return true;
  if (filter.affiliation && !cardOf(db, state, uid).affiliations.includes(filter.affiliation)) return false;
  if (filter.playTimingAny && !eventTimingsOf(db, state, uid).some((t) => filter.playTimingAny!.includes(t))) return false;
  return true;
}

/** 072/073 型置換：登場時必須選卡名 */
export function deployNames(db: CardDb, state: GameState, uid: number): string[] | null {
  const def = effectDefOf(db, state, uid);
  const s = def?.skills.find((s) => s.kind === "deployNameChoice");
  return s && s.kind === "deployNameChoice" ? s.names : null;
}



/** 自分のコート全ガッツ（gutsAny cost 用；Q315） */
export function allGutsOf(state: GameState, p: PlayerId): number[] {
  const ps = state.players[p];
  return [...ps.serve.slice(0, -1), ...ps.receive.slice(0, -1), ...ps.toss.slice(0, -1), ...ps.attack.slice(0, -1), ...ps.blockCenter.slice(0, -1)];
}

/** 別々の所属のキャラ N 人（†7-1-5：每人抽一個所属，求最大相異數；人數少，直接回溯） */
export function maxDistinctAffiliations(lists: string[][]): number {
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
