// P03 伊達工業（HV-P03-009/063/064/097/098）技能逐張行為測試。
import { describe, it, expect } from "vitest";
import { applyDecision, effParam } from "./engine";
import { db, deckWith, grab, placeDeckTop, placeInDrop, seedStack, setup, serveWith, receiveTrack, FILLER } from "./testkit";
import type { GameState, Decision, PlayerId } from "./types";

function feed(s: GameState, d: Decision): GameState {
  return applyDecision(db, s, d);
}
function deploy(s: GameState, area: "toss" | "receive" | "attack", uid: number): GameState {
  return feed(s, { type: `deploy-${area}`, uid } as Decision);
}
function stuffEventArea(s: GameState, p: PlayerId, n: number): void {
  const ps = s.players[p];
  for (let i = 0; i < n; i++) {
    const u = grab(s, p, FILLER);
    ps.hand.splice(ps.hand.indexOf(u), 1);
    ps.eventArea.push(u);
  }
}
/** P0 發球、P1 接球轉攻、推進到 P0 攔網階段（回傳已在 block defense-choice 前）*/
function toBlockDefense(s: GameState): GameState {
  s = serveWith(s, "HV-D01-002"); // P0 OP=1
  s = receiveTrack(s, "HV-D01-008"); // P1 接球 → turnPlayer=1
  const toss = grab(s, 1, "HV-D01-002");
  s = deploy(s, "toss", toss);
  s = feed(s, { type: "free", action: "pass" });
  const atk = grab(s, 1, "HV-D01-010");
  s = deploy(s, "attack", atk);
  s = feed(s, { type: "free", action: "pass" });
  return s;
}

describe("伊達工業 P03", () => {
  it("P03-064 二口：棄伊達×2→ブロック+4＋『－されない』守衛（負向修正被忽略）", () => {
    let s = setup(deckWith("HV-P03-064", "HV-P01-054", "HV-P01-055", "HV-D01-002"), deckWith("HV-D01-008", "HV-D01-002", "HV-D01-010"), 0);
    s = toBlockDefense(s);
    grab(s, 0, "HV-P01-054"); // 伊達 1（手牌）
    grab(s, 0, "HV-P01-055"); // 伊達 2（手牌）
    s = feed(s, { type: "defense-choice", choice: "block" });
    const niguchi = grab(s, 0, "HV-P03-064");
    s = feed(s, { type: "deploy-block", uids: [niguchi], center: niguchi });
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 dropFromHand 伊達×2
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 2) });
    expect(effParam(db, s, niguchi, "block")).toBe(6); // 2+4
    // 模擬對手效果降低 ブロック −3 → 守衛應忽略
    s.modifiers.push({ target: niguchi, param: "block", amount: -3, source: niguchi });
    expect(effParam(db, s, niguchi, "block")).toBe(6); // －されない
    // 對照：正向修正仍適用
    s.modifiers.push({ target: niguchi, param: "block", amount: 1, source: niguchi });
    expect(effParam(db, s, niguchi, "block")).toBe(7);
  });

  it("P03-063 青根：デッキ頂が伊達キャラ→サーブ+3；非伊達→ボーナス無し", () => {
    // 伊達キャラを頂に
    let s = setup(deckWith("HV-P03-063", "HV-P01-054"), deckWith(FILLER), 0);
    placeDeckTop(s, 0, "HV-P01-054"); // 伊達 CHARACTER
    seedStack(s, 0, "serve", 0);
    const aone = grab(s, 0, "HV-P03-063");
    s = feed(s, { type: "deploy-serve", uid: aone });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, aone, "serve")).toBe(5); // 2+3

    // 非伊達頂 → 無 boost
    let t = setup(deckWith("HV-P03-063"), deckWith(FILLER), 0);
    placeDeckTop(t, 0, FILLER); // 烏野 → 不符
    const aone2 = grab(t, 0, "HV-P03-063");
    t = feed(t, { type: "deploy-serve", uid: aone2 });
    if (t.pendingDecision?.type === "effect-confirm") t = feed(t, { type: "effect-confirm", accept: true });
    expect(effParam(db, t, aone2, "serve")).toBe(2); // 基礎値
  });

  it("P03-009 黄金川：イベント≥6→トス+2＋相手ワンタッチ無効 restriction 登録", () => {
    let s = setup(deckWith("HV-P03-009", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER); // P0 → 托球階段
    stuffEventArea(s, 0, 6);
    seedStack(s, 0, "toss", 2);
    const kogane = grab(s, 0, "HV-P03-009");
    s = deploy(s, "toss", kogane);
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, kogane, "toss")).toBe(3); // 1+2
    expect(s.restrictions.some((r) => r.banOneTouch && r.player === 1)).toBe(true); // 相手(P1) ワンタッチ無効
  });
});

describe("伊達工業 P03：マネージャー／イベント", () => {
  it("P03-097 滑津：ドロップから名異なる伊達キャラ2枚回收（同名のみは不可 Q1537）", () => {
    let s = setup(deckWith("HV-P03-097", "HV-P01-054", "HV-P01-055", "HV-D01-002", "HV-D01-008"), deckWith("HV-D01-008", "HV-D01-002", "HV-D01-010"), 0);
    s = toBlockDefense(s); // P0 發球→P1 攻擊；P0 即將攔網
    const a = placeInDrop(s, 0, "HV-P01-054"); // 青根
    const b = placeInDrop(s, 0, "HV-P01-055"); // 二口（名異なる）
    s = feed(s, { type: "defense-choice", choice: "block" });
    const blocker = grab(s, 0, "HV-D01-008");
    s = feed(s, { type: "deploy-block", uids: [blocker], center: blocker });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    const ev = grab(s, 0, "HV-P03-097");
    s = feed(s, { type: "free", action: "event", uid: ev }); // [=ブロック] イベント
    expect(s.pendingDecision?.type).toBe("effect-cards");
    s = feed(s, { type: "effect-cards", uids: [a, b] }); // 2 枚名異なる
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    expect(s.players[0].hand).toContain(a);
    expect(s.players[0].hand).toContain(b);
  });

  it("P03-098 ブッ潰ス：全員伊達→抽1＋選択（ブロック+1）", () => {
    let s = setup(deckWith("HV-P01-055", "HV-P03-098"), deckWith(FILLER), 0);
    const server = grab(s, 0, "HV-P01-055"); // 伊達 server（場上唯一キャラ → 全員伊達）
    s = feed(s, { type: "deploy-serve", uid: server });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    const base = effParam(db, s, server, "block")!;
    const ev = grab(s, 0, "HV-P03-098");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.pendingDecision?.type).toBe("effect-option"); // ▶ 二選一
    s = feed(s, { type: "effect-option", index: 0 }); // ブロック+1
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [server] });
    expect(effParam(db, s, server, "block")).toBe(base + 1);
  });
});
