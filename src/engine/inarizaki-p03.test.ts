// P03 稲荷崎（HV-P03-021/041/044/045/046/092/093 + HV-PR-059）。039/086/091 延後（見 WORKLOG）。
import { describe, it, expect } from "vitest";
import { applyDecision, effParam } from "./engine";
import { nameOf } from "./effects";
import { db, deckWith, grab, placeInDrop, seedStack, setup, serveWith, receiveTrack, drainCp, FILLER } from "./testkit";
import type { GameState, Decision, PlayerId } from "./types";

function feed(s: GameState, d: Decision): GameState {
  return applyDecision(db, s, d);
}
function deploy(s: GameState, area: "toss" | "receive" | "attack", uid: number): GameState {
  return feed(s, { type: `deploy-${area}`, uid } as Decision);
}

describe("稲荷崎 P03：登場 gate", () => {
  it("P03-046 赤木：相手サーブOP≥6→レシーブ+2", () => {
    let s = setup(deckWith("HV-P03-046"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s.op = { value: 6, owner: 1, source: "serve" }; // 相手サーブOP6 を構造
    const akagi = grab(s, 0, "HV-P03-046");
    s = deploy(s, "receive", akagi);
    s = drainCp(s, true);
    expect(effParam(db, s, akagi, "receive")).toBe(7); // 5+2（CP で受け+2 → judge 前）
  });

  it("P03-046 赤木：相手サーブOP≤2→抽1", () => {
    let s = setup(deckWith("HV-P03-046"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s.op = { value: 1, owner: 1, source: "serve" }; // ≤2
    const hPre = s.players[0].hand.length;
    const akagi = grab(s, 0, "HV-P03-046");
    s = deploy(s, "receive", akagi);
    s = drainCp(s, true);
    expect(s.players[0].hand.length).toBe(hPre + 1); // grab+1 deploy−1 抽+1
  });

  it("P03-045 尾白：手札稲荷崎1ドロップ→パラメータ1つ+2", () => {
    let s = setup(deckWith("HV-P03-045", "HV-D03-001"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    grab(s, 0, "HV-D03-001"); // 手札に稲荷崎
    const oshiro = grab(s, 0, "HV-P03-045");
    s = deploy(s, "receive", oshiro);
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 dropFromHand 稲荷崎
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 1) });
    if (s.pendingDecision?.type === "effect-option") s = feed(s, { type: "effect-option", index: 2 }); // receive
    expect(effParam(db, s, oshiro, "receive")).toBe(6); // 4+2
  });

  it("P03-021 宮侑：3ガッツ→トス+2＋ユースイベント回收→棄1", () => {
    let s = setup(deckWith("HV-P03-021", "HV-P03-086"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER); // P0 → 托球
    placeInDrop(s, 0, "HV-P03-086"); // ユースイベント在 drop
    seedStack(s, 0, "toss", 3);
    const atsumu = grab(s, 0, "HV-P03-021");
    s = deploy(s, "toss", atsumu);
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 3 ガッツ
    const reco = s.pendingDecision?.candidates?.find((u) => s.cards[u] === "HV-P03-086");
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: reco ? [reco] : [] }); // 回收 086
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 1) }); // 棄 1
    expect(effParam(db, s, atsumu, "toss")).toBe(3); // 1+2
    expect(s.players[0].hand.some((u) => s.cards[u] === "HV-P03-086")).toBe(true); // 086 回收
  });
});

describe("稲荷崎 P03：041 スキル登場守衛／092 ドシャット無効", () => {
  it("preventParamDecrease all：全パラメータの負向修正を無視（041 の守衛機構）", () => {
    // 041 の preventParamDecrease(param:"all") が積む noDecrease 守衛を effParam 側で直接検証
    let s = setup(deckWith(FILLER), deckWith(FILLER), 0);
    const u = grab(s, 0, FILLER); // 田中 serve1/block2/receive2/toss1/attack3
    for (const pr of ["serve", "block", "receive", "toss", "attack"] as const) s.modifiers.push({ target: u, param: pr, amount: 0, kind: "noDecrease", source: u });
    s.modifiers.push({ target: u, param: "attack", amount: -5, source: u }); // 負向 → 無視
    s.modifiers.push({ target: u, param: "block", amount: -1, source: u }); // 負向 → 無視
    s.modifiers.push({ target: u, param: "attack", amount: 2, source: u }); // 正向 → 適用
    expect(effParam(db, s, u, "attack")).toBe(3 + 2); // 基礎3、−5無視、+2適用
    expect(effParam(db, s, u, "block")).toBe(2); // 基礎2、−1無視
  });

  it("P03-041：手札から登場（origin hand）ではボーナス無し", () => {
    let s = setup(deckWith("HV-P03-041", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    const toss = grab(s, 0, "HV-D01-002");
    s = deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const miyaharu = grab(s, 0, "HV-P03-041");
    s = deploy(s, "attack", miyaharu); // 通常登場（origin hand）
    s = drainCp(s, true);
    expect(effParam(db, s, miyaharu, "attack")).toBe(2); // deployedBySkill 不成立 → 基礎値
  });

  it("P03-092 あんたブロック上手だよ：相手ドシャット/ワンタッチ無効 restriction 登録", () => {
    let s = setup(deckWith("HV-P03-092", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    const toss = grab(s, 0, "HV-D01-002");
    s = deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 0, FILLER);
    s = deploy(s, "attack", atk);
    const ev = grab(s, 0, "HV-P03-092");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    expect(s.restrictions.some((r) => r.banDoshatto && r.player === 1)).toBe(true);
    expect(s.restrictions.some((r) => r.banOneTouch && r.player === 1)).toBe(true);
  });
});

describe("稲荷崎 P03：093 北信介登場／PR-059", () => {
  it("P03-093 絶望の継続や：▶レシーブ区ガッツの北信介を登場", () => {
    let s = setup(deckWith("HV-P03-093", "HV-D03-006"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const recv = grab(s, 0, FILLER); // 受けキャラ
    s = deploy(s, "receive", recv);
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    // 北信介を receive 区のガッツ（受けキャラの下）に仕込む
    const kita = grab(s, 0, "HV-D03-006");
    s.players[0].hand.splice(s.players[0].hand.indexOf(kita), 1);
    s.players[0].receive.unshift(kita); // 底＝ガッツ層
    const ev = grab(s, 0, "HV-P03-093");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.pendingDecision?.type).toBe("effect-option"); // ▶ 二選一
    s = feed(s, { type: "effect-option", index: 1 }); // ▶北信介登場
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [kita] });
    // 北信介が receive 頂（キャラ）に
    expect(s.players[0].receive[s.players[0].receive.length - 1]).toBe(kita);
  });

  it("PR-059 宮・古森：以選定名登場", () => {
    let s = setup(deckWith("HV-D01-002", "HV-PR-059"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    const toss = grab(s, 0, "HV-PR-059");
    s = feed(s, { type: "deploy-toss", uid: toss, nameChoice: "宮 侑" });
    expect(nameOf(db, s, toss)).toBe("宮 侑");
  });
});
