// [Claude 2026-07-09] Phase M（バボカ「試合中の思考」③）：對手期望最大值原語。
//
// 出處：note.com/8p_vbc「比賽中的思考方式」第 3 點——出手前要估對手下一次 Rally 的
// 「平均最大值」，再回頭問自己接不接得住（第 4 點）。這支模組把該估計做成純函數，
// 供賽後復盤（replay-review）與日後 coach 即時警示重用。
//
// 刻意的模型選擇（＝文章的「平均最大值」而非「極端值」）：
//   1. 只用卡面基礎 params（不跑 effParam）。フェイント/ワンタッチ 等效果加成屬文章明說
//      「不要去想的極端狀況」，估計器不納入 → 得到的是「合理常見的最大輸出」。
//   2. 候選池 = 該區場上頂端角色（已登場、可續用）∪ 手牌角色。忽略 Guts/登場合法性等
//      細節，取「他這一手能擺出的上限」，與 coach.decisionOpPressure 的精神一致。
//   3. 攻擊線同名禁止（攻≠托，engine 規則），且同一張卡不可同時當托與攻。
//   4. params 欄位為 null＝該區「－」不可登場（†1-3-2-1），與 0 不同 → 跳過該 slot。
//
// 防守成功判定沿用 engine.judgeCompare：防守方 DP ≥ 攻方 OP 即成功。

import type { Card, CharacterParams } from "../data/types";
import type { CardDb, GameState, PlayerId, PlayerState } from "../engine/types";

type AttackSlot = "toss" | "attack";
type DefenseSlot = "receive";

/** 攻擊線期望最大值：對手/我方下一次 Rally 能擺出的最大 托值+攻值（同名禁止）。 */
export interface MaxAttackEstimate {
  /** toss param + attack param 的最大合法組合；無可用攻擊線時為 0。 */
  op: number;
  tossUid: number | null;
  attackUid: number | null;
  tossName: string | null;
  attackName: string | null;
}

/** 接球防守期望最大值：單一接球手能提供的最大 DP。 */
export interface MaxReceiveEstimate {
  /** 最佳接球手的 receive param；無可用接球手時為 0。 */
  dp: number;
  receiverUid: number | null;
  receiverName: string | null;
}

interface Candidate {
  uid: number;
  name: string;
  param: number;
}

function cardOf(db: CardDb, state: GameState, uid: number): Card | null {
  const id = state.cards[uid];
  return id ? db.get(id) ?? null : null;
}

/** stack 頂端（最後一張）＝該區在場角色（Guts 疊在底下）；空 stack 回 null。 */
function fieldTopUid(stack: readonly number[]): number | null {
  return stack.length ? stack[stack.length - 1]! : null;
}

function paramOf(params: CharacterParams | null, slot: AttackSlot | DefenseSlot): number | null {
  if (!params) return null;
  const value = params[slot];
  return typeof value === "number" ? value : null;
}

/**
 * 蒐集某 slot 的候選角色：場上該區頂端 + 手牌全部角色，取有該 slot 參數（非 null）者。
 * 同一 uid 只計一次（場上頂端若也在候選集不會重複，因手牌與場上互斥）。
 */
function slotCandidates(db: CardDb, state: GameState, ps: PlayerState, fieldStack: readonly number[], slot: AttackSlot | DefenseSlot): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<number>();
  const consider = (uid: number | null): void => {
    if (uid === null || seen.has(uid)) return;
    const card = cardOf(db, state, uid);
    if (!card || card.type !== "CHARACTER") return;
    const param = paramOf(card.params, slot);
    if (param === null) return;
    seen.add(uid);
    out.push({ uid, name: card.nameJa, param });
  };
  consider(fieldTopUid(fieldStack));
  for (const uid of ps.hand) consider(uid);
  return out;
}

/**
 * 攻擊線期望最大 OP：在 toss/attack 候選集中，找同名禁止且非同卡的 (托, 攻) 組合，
 * 使 托值+攻值 最大。無可用組合（例如手上無攻擊手）回 op:0。
 */
export function estimateMaxAttackOP(db: CardDb, state: GameState, player: PlayerId): MaxAttackEstimate {
  const ps = state.players[player];
  const tossers = slotCandidates(db, state, ps, ps.toss, "toss").sort((a, b) => b.param - a.param);
  const attackers = slotCandidates(db, state, ps, ps.attack, "attack").sort((a, b) => b.param - a.param);

  let best: MaxAttackEstimate = { op: 0, tossUid: null, attackUid: null, tossName: null, attackName: null };
  for (const toss of tossers) {
    // attackers 已排序：第一個與此 toss 合法（不同卡、不同名）的 attacker 即此 toss 的最佳解。
    for (const attack of attackers) {
      if (attack.uid === toss.uid || attack.name === toss.name) continue;
      const op = toss.param + attack.param;
      if (op > best.op) best = { op, tossUid: toss.uid, attackUid: attack.uid, tossName: toss.name, attackName: attack.name };
      break;
    }
  }

  // 只有攻擊手、無合法托（例如僅一張角色）：仍可純攻上場（托值 0）。
  if (best.op === 0 && attackers.length > 0) {
    const attack = attackers[0]!;
    best = { op: attack.param, tossUid: null, attackUid: attack.uid, tossName: null, attackName: attack.name };
  }
  return best;
}

/** 接球防守期望最大 DP：候選接球手中最大 receive param（單一接球位）。 */
export function estimateMaxReceiveDP(db: CardDb, state: GameState, player: PlayerId): MaxReceiveEstimate {
  const ps = state.players[player];
  const receivers = slotCandidates(db, state, ps, ps.receive, "receive").sort((a, b) => b.param - a.param);
  const best = receivers[0];
  return best
    ? { dp: best.param, receiverUid: best.uid, receiverName: best.name }
    : { dp: 0, receiverUid: null, receiverName: null };
}

/** 防守成功判定（沿用 engine.judgeCompare）：DP ≥ OP 即接得住。 */
export function defenseHolds(dp: number, op: number): boolean {
  return dp >= op;
}
