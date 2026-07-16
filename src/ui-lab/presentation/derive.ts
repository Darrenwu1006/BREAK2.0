// M9-P0 演出事件導出：applyDecision 前後的 state diff＋引擎 log 的結構化 GameEvent → 演出指令流。
// 純函式、只讀狀態。log delta 是「有序主幹」（spine），卡片移動由 zone diff 偵測後以啟發式
// 錨定插入主幹——排序啟發式是本檔內部事務，改進不動契約（消費者只看陣列順序）。
// [Claude 2026-07-10] P0 已知簡化：深層效果鏈（一批多技能）的效果移動統一錨在第一個技能宣言後；
// 效果中途公開的卡（公開牌組頂→手牌）不另發 reveal 事件——M9b 需要時再加 card-revealed。

import { nameOf } from "../../engine/engine";
import type { CardDb, Decision, GameState } from "../../engine/types";
import type { CardMovedEvent, MoveReason, PresentationEvent, Visibility, ZoneId, ZoneRef } from "./events";

const STACK_ZONES = ["serve", "blockCenter", "receive", "toss", "attack"] as const;
type StackZone = (typeof STACK_ZONES)[number];

const COURT_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>([...STACK_ZONES, "blockSide"]);

function isStack(zone: ZoneId): zone is StackZone {
  return (STACK_ZONES as readonly string[]).includes(zone);
}

/** 全卡 uid → 所在區域（疊放區含 depth） */
function zoneRefsOf(state: GameState): Map<number, ZoneRef> {
  const out = new Map<number, ZoneRef>();
  for (const player of [0, 1] as const) {
    const ps = state.players[player];
    for (const uid of ps.deck) out.set(uid, { player, zone: "deck" });
    for (const uid of ps.hand) out.set(uid, { player, zone: "hand" });
    for (const uid of ps.setArea) out.set(uid, { player, zone: "setArea" });
    for (const uid of ps.drop) out.set(uid, { player, zone: "drop" });
    for (const uid of ps.eventArea) out.set(uid, { player, zone: "eventArea" });
    for (const uid of ps.blockSides) out.set(uid, { player, zone: "blockSide" });
    for (const zone of STACK_ZONES) ps[zone].forEach((uid, depth) => out.set(uid, { player, zone, depth }));
  }
  return out;
}

/** 可見度＝目的地區域的公開性（觀者視角的翻面判斷屬 renderer） */
function visibilityOf(to: ZoneRef): Visibility {
  if (to.zone === "hand") return "owner";
  if (to.zone === "deck" || to.zone === "setArea") return "hidden";
  return "public";
}

function wasTopOf(state: GameState, uid: number, ref: ZoneRef): boolean {
  if (!isStack(ref.zone)) return false;
  const stack = state.players[ref.player][ref.zone];
  return stack.length > 0 && stack[stack.length - 1] === uid;
}

function classifyReason(before: GameState, uid: number, from: ZoneRef, to: ZoneRef): MoveReason {
  if (COURT_ZONES.has(to.zone) && (from.zone === "hand" || from.zone === "drop" || from.zone === "deck")) return "deploy";
  if (from.zone === "deck" && to.zone === "hand") return "draw";
  if (from.zone === "hand" && to.zone === "deck") return "mulligan";
  if (from.zone === "setArea" && to.zone === "hand") return "set-pick";
  if (from.zone === "deck" && to.zone === "setArea") return "set-place";
  if (to.zone === "drop") {
    // 從疊放區「非頂層」進棄牌＝付ガッツ；其餘（cost 棄手牌、側邊攔網手清理…）＝棄牌
    if (isStack(from.zone) && !wasTopOf(before, uid, from)) return "pay-guts";
    return "drop";
  }
  return "effect";
}

/** 決策直接指定的登場 uid（deploy-block 依 center 優先排序） */
function deployUidsOf(decision: Decision): number[] {
  switch (decision.type) {
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack":
      return decision.uid !== null ? [decision.uid] : [];
    case "deploy-block":
      return decision.uids === null ? [] : [decision.center, ...decision.uids.filter((u) => u !== decision.center)];
    default:
      return [];
  }
}

export function derivePresentationEvents(db: CardDb, before: GameState, decision: Decision, after: GameState): PresentationEvent[] {
  const logDelta = after.log.slice(before.log.length);

  // ---- 卡片移動偵測（zone diff；同 player+zone 內的重排不是移動）----
  const beforeRefs = zoneRefsOf(before);
  const afterRefs = zoneRefsOf(after);
  const rawMoves: CardMovedEvent[] = [];
  for (const [uid, to] of afterRefs) {
    const from = beforeRefs.get(uid);
    if (!from || (from.player === to.player && from.zone === to.zone)) continue;
    const reason = classifyReason(before, uid, from, to);
    rawMoves.push({
      kind: "card-moved",
      uid,
      cardId: after.cards[uid]!,
      from,
      to,
      visibility: visibilityOf(to),
      reason,
      ...(decision.type === "mulligan" && reason === "draw" ? { motion: "mulligan-deal" as const } : {}),
    });
  }
  // ガッツ下沉：原疊頂仍在同疊但不再是頂（登場疊上時發生）
  const sinks = new Map<string, CardMovedEvent>();
  for (const player of [0, 1] as const) {
    for (const zone of STACK_ZONES) {
      const b = before.players[player][zone];
      if (b.length === 0) continue;
      const top = b[b.length - 1]!;
      const a = after.players[player][zone];
      const ai = a.indexOf(top);
      if (ai >= 0 && ai !== a.length - 1) {
        sinks.set(`${player}:${zone}`, {
          kind: "card-moved",
          uid: top,
          cardId: after.cards[top]!,
          from: { player, zone, depth: b.length - 1 },
          to: { player, zone, depth: ai },
          visibility: "public",
          reason: "guts",
        });
      }
    }
  }

  // ---- 分桶（依主幹錨點決定插入位置）----
  const spineHasSetWon = logDelta.some((e) => e.event?.kind === "set-won" || e.event?.kind === "match-won");
  const spineHasSkill = logDelta.some((e) => e.event?.kind === "skill-used" || e.event?.kind === "event-card" || e.event?.kind === "skill-resolved");
  const spineHasGutsPaid = logDelta.some((e) => e.event?.kind === "pay-guts");
  const spineJudgeFailed = logDelta.some((e) => e.event?.kind === "judge" && !e.event.success);
  const decisionUids = deployUidsOf(decision);

  const buckets = {
    decision: [] as CardMovedEvent[], // 決策直接造成：登場/換牌/取 Set 卡
    pre: [] as CardMovedEvent[], // 主幹前：抽牌、Set 卡配置、無錨點的效果移動
    effect: [] as CardMovedEvent[], // 錨=第一個技能宣言/事件卡之後
    afterGuts: [] as CardMovedEvent[], // 錨=第一個 guts-paid 之後
    afterJudgeFail: [] as CardMovedEvent[], // 錨=判定失敗之後（側邊攔網手清理）
    afterSetWon: [] as CardMovedEvent[], // 錨=set-won 之後（インターバル補牌）
    end: [] as CardMovedEvent[], // 主幹後（階段終了清理）
  };
  for (const m of rawMoves) {
    switch (m.reason) {
      case "deploy":
        (decisionUids.includes(m.uid) ? buckets.decision : spineHasSkill ? buckets.effect : buckets.pre).push(m);
        break;
      case "mulligan":
      case "set-pick":
        buckets.decision.push(m);
        break;
      case "draw":
        (spineHasSetWon ? buckets.afterSetWon : spineHasSkill ? buckets.effect : buckets.pre).push(m);
        break;
      case "pay-guts":
        (spineHasGutsPaid ? buckets.afterGuts : buckets.pre).push(m);
        break;
      case "drop":
        (spineHasSkill ? buckets.effect : spineJudgeFailed ? buckets.afterJudgeFail : buckets.end).push(m);
        break;
      case "set-place":
        buckets.pre.push(m);
        break;
      default:
        (spineHasSkill ? buckets.effect : buckets.pre).push(m);
    }
  }
  // deploy-block 多張登場依決策順序（center 先）
  if (decisionUids.length > 1) buckets.decision.sort((a, b) => decisionUids.indexOf(a.uid) - decisionUids.indexOf(b.uid));

  // ---- 組裝 ----
  const out: PresentationEvent[] = [];
  /** 發移動事件；若目的疊放區有待發的下沉，緊跟其後（新卡疊上、舊頂沉為ガッツ） */
  const emitMove = (m: CardMovedEvent): void => {
    out.push(m);
    if (isStack(m.to.zone)) {
      const key = `${m.to.player}:${m.to.zone}`;
      const sink = sinks.get(key);
      if (sink) {
        out.push(sink);
        sinks.delete(key);
      }
    }
  };
  const flush = (arr: CardMovedEvent[]): void => {
    for (const m of arr) emitMove(m);
    arr.length = 0;
  };
  /** 技能/事件宣言的本體移動（打出的事件卡→事件區、dropSelf cost…）優先於其效果移動 */
  const flushEffectFor = (uid: number): void => {
    const idx = buckets.effect.findIndex((m) => m.uid === uid);
    if (idx >= 0) emitMove(buckets.effect.splice(idx, 1)[0]!);
  };

  if (decision.type === "defense-choice") {
    out.push({ kind: "defense-chosen", player: before.pendingDecision?.player ?? before.turnPlayer, choice: decision.choice });
  }
  if (decision.type === "mulligan") {
    const returned = buckets.decision.splice(0).filter((move) => move.reason === "mulligan");
    if (returned.length > 0) {
      out.push({ kind: "card-group-moved", moves: returned, reason: "mulligan-return" });
      out.push({ kind: "deck-shuffled", player: before.pendingDecision?.player ?? before.turnPlayer });
    }
  } else {
    flush(buckets.decision);
  }
  flush(buckets.pre);

  // ---- 主幹：log delta 依序（turn 邊界＋結構化 GameEvent）----
  let curSet = before.setNo;
  let curTurn = before.turnNo;
  for (const entry of logDelta) {
    if (entry.setNo !== curSet || entry.turnNo !== curTurn) {
      curSet = entry.setNo;
      curTurn = entry.turnNo;
      if (entry.turnNo >= 1) {
        out.push({ kind: "turn-started", player: entry.player ?? after.turnPlayer, setNo: entry.setNo, turnNo: entry.turnNo, turnKind: entry.turnNo === 1 ? "serve" : "normal" });
      }
    }
    const e = entry.event;
    if (!e) continue;
    switch (e.kind) {
      case "op-calc":
        out.push({ kind: "op-revealed", player: e.player, source: e.source, value: e.value });
        break;
      case "attack-op":
        out.push({ kind: "op-revealed", player: e.player, source: "attack", value: e.value });
        break;
      case "dp-calc":
        out.push({ kind: "dp-revealed", player: e.player, source: e.source, value: e.value });
        break;
      case "judge":
        out.push({ kind: "judge-revealed", defense: e.defense, defender: e.defender, opValue: e.opValue, dpValue: e.dpValue, success: e.success });
        if (!e.success) flush(buckets.afterJudgeFail);
        break;
      case "pay-guts":
        out.push({ kind: "guts-paid", player: e.player, count: e.count });
        flush(buckets.afterGuts);
        break;
      case "set-won":
        out.push({ kind: "lost-declared", player: e.loser });
        out.push({ kind: "set-won", winner: e.winner, loser: e.loser, setNo: e.setNo, loserSetRemaining: e.loserSetRemaining });
        flush(buckets.afterSetWon);
        break;
      case "match-won":
        out.push({ kind: "lost-declared", player: e.loser });
        out.push({ kind: "match-won", winner: e.winner, loser: e.loser });
        break;
      case "skill-used":
        out.push({ kind: "skill-declared", player: e.player, uid: e.uid, name: nameOf(db, after, e.uid) });
        flushEffectFor(e.uid);
        flush(buckets.effect);
        break;
      case "skill-resolved":
        // A waiting effect becoming eligible is not the same as the player
        // declaring/accepting it. Keep its emphasis/effect motions, but do not
        // announce a false "skill activated" banner.
        flushEffectFor(e.uid);
        flush(buckets.effect);
        break;
      case "event-card":
        out.push({ kind: "event-played", player: e.player, uid: e.uid, name: nameOf(db, after, e.uid) });
        flushEffectFor(e.uid);
        flush(buckets.effect);
        break;
    }
  }

  // ---- 收尾：安全 flush（無錨點殘留一律補在主幹後）＋下一決策標點 ----
  flush(buckets.effect);
  flush(buckets.afterGuts);
  flush(buckets.afterJudgeFail);
  flush(buckets.afterSetWon);
  flush(buckets.end);
  for (const sink of sinks.values()) out.push(sink);

  const pd = after.pendingDecision;
  if (pd) out.push({ kind: "decision-requested", player: pd.player, decisionType: pd.type, ...(pd.prompt ? { prompt: pd.prompt } : {}) });
  return out;
}
