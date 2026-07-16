// M9-P0 驗收：代表性決策（登場/攔網/技能/得分/Set 結束）的演出事件序列斷言（spec §1.2）。
import { describe, expect, it } from "vitest";
import { applyDecision, createGame } from "../../engine/engine";
import { db, deckWith, feed, FILLER, grab, placeOnStack, setup } from "../../engine/testkit";
import type { Decision, GameState } from "../../engine/types";
import { heuristicAiDecision } from "../../ai/heuristic";
import { derivePresentationEvents } from "./derive";
import type { CardMovedEvent, PresentationEvent } from "./events";

function step(s: GameState, d: Decision): { s: GameState; ev: PresentationEvent[] } {
  const next = feed(s, d);
  return { s: next, ev: derivePresentationEvents(db, s, d, next) };
}
const kinds = (ev: PresentationEvent[]): string[] => ev.map((e) => e.kind);
const moves = (ev: PresentationEvent[]): CardMovedEvent[] => ev.filter((e): e is CardMovedEvent => e.kind === "card-moved");

describe("derivePresentationEvents — 代表性決策序列", () => {
  it("登場：deploy-serve → card-moved(deploy) → decision-requested(free)", () => {
    const s = setup(deckWith(FILLER), deckWith(FILLER), 0);
    const uid = grab(s, 0, FILLER);
    const r = step(s, { type: "deploy-serve", uid });
    expect(kinds(r.ev)).toEqual(["card-moved", "decision-requested"]);
    expect(r.ev[0]).toMatchObject({
      uid,
      reason: "deploy",
      visibility: "public",
      from: { player: 0, zone: "hand" },
      to: { player: 0, zone: "serve", depth: 0 },
    });
    expect(r.ev[1]).toMatchObject({ decisionType: "free", player: 0 });
  });

  it("發球 OP 揭示＋對手回合開始：free pass → op-revealed → turn-started → decision-requested", () => {
    let s = setup(deckWith(FILLER), deckWith(FILLER), 0);
    s = feed(s, { type: "deploy-serve", uid: grab(s, 0, FILLER) });
    const r = step(s, { type: "free", action: "pass" });
    expect(kinds(r.ev)).toEqual(["op-revealed", "turn-started", "decision-requested"]);
    expect(r.ev[0]).toMatchObject({ player: 0, source: "serve" });
    expect(r.ev[1]).toMatchObject({ player: 1, setNo: 1, turnNo: 2, turnKind: "normal" });
    expect(r.ev[2]).toMatchObject({ decisionType: "defense-choice", player: 1 });
  });

  it("防守選擇＋抽牌：defense-choice receive → defense-chosen → card-moved(draw) → decision-requested", () => {
    let s = setup(deckWith(FILLER), deckWith(FILLER), 0);
    s = feed(s, { type: "deploy-serve", uid: grab(s, 0, FILLER) });
    s = feed(s, { type: "free", action: "pass" });
    const r = step(s, { type: "defense-choice", choice: "receive" });
    expect(kinds(r.ev)).toEqual(["defense-chosen", "card-moved", "decision-requested"]);
    expect(r.ev[0]).toMatchObject({ player: 1, choice: "receive" });
    expect(r.ev[1]).toMatchObject({ reason: "draw", visibility: "owner", from: { player: 1, zone: "deck" }, to: { player: 1, zone: "hand" } });
  });

  it("接球判定：DP/OP 揭示三拍（dp-revealed → judge-revealed 成功）", () => {
    let s = setup(deckWith(FILLER), deckWith(FILLER), 0);
    s = feed(s, { type: "deploy-serve", uid: grab(s, 0, FILLER) }); // 田中 serve=1
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" }); // draw phase 自由步驟
    s = feed(s, { type: "deploy-receive", uid: grab(s, 1, FILLER) }); // 田中 receive=2
    const r = step(s, { type: "free", action: "pass" });
    expect(kinds(r.ev)).toEqual(["dp-revealed", "judge-revealed", "decision-requested"]);
    expect(r.ev[0]).toMatchObject({ player: 1, source: "receive", value: 2 });
    expect(r.ev[1]).toMatchObject({ defense: "receive", defender: 1, opValue: 1, dpValue: 2, success: true });
    expect(r.ev[2]).toMatchObject({ decisionType: "deploy-toss", player: 1 });
  });

  it("ガッツ下沉：疊上登場 → 舊頂緊跟著沉為ガッツ", () => {
    // 同名禁止（†1-4-5-4-1）：托球區兩張要用不同名卡（菅原→宮侑）
    let s = setup(deckWith(FILLER), deckWith("HV-D01-009", "HV-D03-004"), 0);
    s = feed(s, { type: "deploy-serve", uid: grab(s, 0, FILLER) });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-receive", uid: grab(s, 1, FILLER) });
    s = feed(s, { type: "free", action: "pass" }); // → toss phase
    const buried = placeOnStack(s, 1, "toss", "HV-D01-009"); // 菅原：預先疊一張當既存頂
    const uid = grab(s, 1, "HV-D03-004"); // 宮侑（toss 2）
    const r = step(s, { type: "deploy-toss", uid });
    expect(kinds(r.ev)).toEqual(["card-moved", "card-moved", "decision-requested"]);
    expect(r.ev[0]).toMatchObject({ uid, reason: "deploy", to: { zone: "toss", depth: 1 } });
    expect(r.ev[1]).toMatchObject({ uid: buried, reason: "guts", from: { zone: "toss", depth: 0 }, to: { zone: "toss", depth: 0 } });
  });

  it("得分／Set 結束：不登場攔網 → lost-declared → set-won → インターバル補牌 → 取 Set 卡", () => {
    // 同名禁止：接球/托球/攻擊各用不同名卡（田中→菅原→東峰）
    let s = setup(deckWith(FILLER), deckWith("HV-D01-009", "HV-D01-010"), 0);
    s = feed(s, { type: "deploy-serve", uid: grab(s, 0, FILLER) });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-receive", uid: grab(s, 1, FILLER) });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-toss", uid: grab(s, 1, "HV-D01-009") }); // 菅原
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-attack", uid: grab(s, 1, "HV-D01-010") }); // 東峰
    s = feed(s, { type: "free", action: "pass" }); // attack OP 揭示 → P0 回合
    s = feed(s, { type: "defense-choice", choice: "block" });
    const r = step(s, { type: "deploy-block", uids: null }); // 不登場 → Lost
    const ks = kinds(r.ev);
    expect(ks[0]).toBe("lost-declared");
    expect(ks[1]).toBe("set-won");
    expect(r.ev[0]).toMatchObject({ player: 0 });
    expect(r.ev[1]).toMatchObject({ winner: 1, loser: 0, setNo: 1, loserSetRemaining: 1 });
    // set-won 之後全是インターバル補牌，最後是取 Set 卡決策
    const tail = r.ev.slice(2);
    expect(tail.length).toBeGreaterThan(1);
    for (const e of tail.slice(0, -1)) expect(e).toMatchObject({ kind: "card-moved", reason: "draw" });
    expect(tail[tail.length - 1]).toMatchObject({ kind: "decision-requested", decisionType: "pick-set-card", player: 0 });

    // 取 Set 卡 → 新 Set 發球回合
    const r2 = step(r.s, { type: "pick-set-card", index: 0 });
    expect(kinds(r2.ev)).toEqual(["card-moved", "turn-started", "decision-requested"]);
    expect(r2.ev[0]).toMatchObject({ reason: "set-pick", visibility: "owner", from: { player: 0, zone: "setArea" }, to: { player: 0, zone: "hand" } });
    expect(r2.ev[1]).toMatchObject({ setNo: 2, turnNo: 1, turnKind: "serve", player: 1 });
    expect(r2.ev[2]).toMatchObject({ decisionType: "deploy-serve", player: 1 });
  });

  it("技能宣言：free skill → skill-declared → cost 移動緊跟其後", () => {
    let s = setup(deckWith("HV-P03-057"), deckWith(FILLER), 1); // 黒川：dropSelf cost
    s = feed(s, { type: "deploy-serve", uid: grab(s, 1, FILLER) });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "receive" }); // P0 → draw phase
    const kurokawa = grab(s, 0, "HV-P03-057");
    const r = step(s, { type: "free", action: "skill", uid: kurokawa, skillIndex: 0 });
    expect(kinds(r.ev)).toEqual(["skill-declared", "card-moved", "decision-requested"]);
    expect(r.ev[0]).toMatchObject({ player: 0, uid: kurokawa });
    expect(r.ev[1]).toMatchObject({ uid: kurokawa, reason: "drop", from: { player: 0, zone: "hand" }, to: { player: 0, zone: "drop" } });
  });

  it("待機效果進入結算 skill-resolved 不冒充玩家宣告 skill-declared", () => {
    const before = setup(deckWith(FILLER), deckWith(FILLER), 0);
    const uid = grab(before, 0, FILLER);
    const after = structuredClone(before);
    after.log.push({
      setNo: after.setNo,
      turnNo: after.turnNo,
      player: 0,
      text: "待機效果開始結算",
      event: { kind: "skill-resolved", player: 0, uid },
    });
    const events = derivePresentationEvents(db, before, { type: "deploy-serve", uid: null }, after);
    expect(events.some((event) => event.kind === "skill-declared")).toBe(false);
  });

  it("換牌：serve-rights 發 12 張 → mulligan 換 2 張 → Set 卡配置＋發球回合開始", () => {
    let s = createGame(db, { seed: 7, decks: [deckWith(FILLER), deckWith(FILLER)], skipDeckValidation: true });
    const decider = s.pendingDecision!.player;
    const r = step(s, { type: "serve-rights", take: true });
    expect(kinds(r.ev)).toEqual([...Array(12).fill("card-moved"), "decision-requested"]);
    for (const m of moves(r.ev)) expect(m).toMatchObject({ reason: "draw", visibility: "owner" });
    expect(r.ev[12]).toMatchObject({ decisionType: "mulligan", player: decider });

    const hand = r.s.players[decider].hand;
    const r2 = step(r.s, { type: "mulligan", returnUids: [hand[0]!, hand[1]!] });
    expect(kinds(r2.ev).slice(0, 4)).toEqual(["card-group-moved", "deck-shuffled", "card-moved", "card-moved"]);
    const returned = r2.ev[0]!;
    expect(returned).toMatchObject({ kind: "card-group-moved", reason: "mulligan-return" });
    if (returned.kind !== "card-group-moved") throw new Error("expected card-group-moved");
    expect(returned.moves.map((m) => m.reason)).toEqual(["mulligan", "mulligan"]);
    expect(returned.moves.map((m) => m.visibility)).toEqual(["hidden", "hidden"]);
    const ms = moves(r2.ev);
    expect(ms.map((m) => m.reason)).toEqual(["draw", "draw"]);
    expect(ms.map((m) => m.motion)).toEqual(["mulligan-deal", "mulligan-deal"]);
    expect(r2.ev[r2.ev.length - 1]).toMatchObject({ kind: "decision-requested", decisionType: "mulligan" });

    const r3 = step(r2.s, { type: "mulligan", returnUids: [] });
    expect(kinds(r3.ev)).toEqual(["card-moved", "card-moved", "card-moved", "card-moved", "turn-started", "decision-requested"]);
    for (const m of moves(r3.ev)) expect(m).toMatchObject({ reason: "set-place", visibility: "hidden" });
    expect(r3.ev[4]).toMatchObject({ setNo: 1, turnNo: 1, turnKind: "serve" });
    expect(r3.ev[5]).toMatchObject({ decisionType: "deploy-serve" });
  });

  it("整場 smoke：heuristic 對局全程 derive 不炸、每批結尾必為 decision-requested（終局＝match-won）", () => {
    let s = createGame(db, { seed: 123, decks: [deckWith(FILLER), deckWith(FILLER)], skipDeckValidation: true });
    let batches = 0;
    for (let i = 0; i < 5000 && s.phase !== "gameOver"; i++) {
      const d = heuristicAiDecision(db, s);
      const next = applyDecision(db, s, d);
      const ev = derivePresentationEvents(db, s, d, next);
      batches++;
      if (next.phase === "gameOver") {
        expect(ev.some((e) => e.kind === "match-won")).toBe(true);
      } else {
        expect(ev.length).toBeGreaterThan(0);
        expect(ev[ev.length - 1]!.kind).toBe("decision-requested");
      }
      s = next;
    }
    expect(s.phase).toBe("gameOver");
    expect(batches).toBeGreaterThan(20);
  });
});
