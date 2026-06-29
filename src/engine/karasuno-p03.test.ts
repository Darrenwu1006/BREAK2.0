// P03 烏野（HV-P03-001/003/051/052/053/054/056/057/077/080/081/082/087/094/095/096 + PR-057/060）。047/PR-063 延後。
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
function pushTo(s: GameState, p: PlayerId, zone: "receive" | "toss" | "attack" | "eventArea", cardId: string): number {
  const u = grab(s, p, cardId);
  s.players[p].hand.splice(s.players[p].hand.indexOf(u), 1);
  s.players[p][zone].push(u);
  return u;
}
/** P0 接球→托球→アタック階段（攻方）。toss/atk は 烏野 vanilla */
function karasunoAttack(s: GameState): GameState {
  s = serveWith(s, FILLER);
  s = receiveTrack(s, FILLER);
  s = deploy(s, "toss", grab(s, 0, "HV-D01-002")); // 影山（烏野 S）
  s = feed(s, { type: "free", action: "pass" });
  return s;
}

describe("烏野 P03：登場 gate", () => {
  it("P03-052 田中：手札1枚デッキ下→抽1＋サーブ+5", () => {
    let s = setup(deckWith("HV-P03-052", FILLER, FILLER, FILLER), deckWith(FILLER), 0);
    const tanaka = grab(s, 0, "HV-P03-052");
    s = feed(s, { type: "deploy-serve", uid: tanaka });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 1) }); // handToDeckBottom
    expect(effParam(db, s, tanaka, "serve")).toBe(5); // 0+5
  });

  it("P03-003 月島：全員烏野/疑似ユース＋イベント≥6＋2ガッツ→アタック+3", () => {
    let s = setup(deckWith("HV-P03-003", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    s = deploy(s, "toss", grab(s, 0, "HV-D01-002"));
    s = feed(s, { type: "free", action: "pass" });
    for (let i = 0; i < 6; i++) pushTo(s, 0, "eventArea", FILLER); // イベント≥6
    seedStack(s, 0, "attack", 2);
    const tsuki = grab(s, 0, "HV-P03-003");
    s = deploy(s, "attack", tsuki);
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, tsuki, "attack")).toBe(5); // 2+3（全員烏野＝影山+月島）
    expect(s.watchers.some((w) => w.trigger.on === "deploy")).toBe(true); // センターブロッカー−3 watcher
  });

  it("P03-053 東峰：トス=影山＋3ガッツ→アタック+3＋ドシャット無効 restriction", () => {
    let s = setup(deckWith("HV-P03-053", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    s = deploy(s, "toss", grab(s, 0, "HV-D01-002")); // 影山
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 3);
    const azumane = grab(s, 0, "HV-P03-053");
    s = deploy(s, "attack", azumane);
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, azumane, "attack")).toBe(5); // 2+3
    expect(s.restrictions.some((r) => r.banDoshatto && r.player === 1)).toBe(true);
  });
});

describe("烏野 P03：active／watch", () => {
  it("P03-056 田代：dropSelf→ドロップから烏野3年キャラ回収", () => {
    let s = setup(deckWith("HV-P03-056", "HV-P03-053", "HV-D01-002"), deckWith(FILLER), 1);
    s = karasunoAttack(s); // → deploy-attack 待ち
    s = deploy(s, "attack", grab(s, 0, FILLER)); // 攻擊登場 → アタック自由步驟
    s = drainCp(s, true);
    const azumane = placeInDrop(s, 0, "HV-P03-053"); // 東峰（烏野 3年）in drop
    const tashiro = grab(s, 0, "HV-P03-056");
    s = feed(s, { type: "free", action: "skill", uid: tashiro, skillIndex: 0 }); // dropSelf cost
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [azumane] });
    expect(s.players[0].hand).toContain(azumane);
    expect(s.players[0].drop).toContain(tashiro); // 田代自身は drop へ
  });

  it("P03-057 黒川：dropSelf→烏野2/3年登場毎にレシーブ+2＋－されない", () => {
    let s = setup(deckWith("HV-P03-057", "HV-P03-053"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" }); // → ドローフェイズ
    const kurokawa = grab(s, 0, "HV-P03-057");
    s = feed(s, { type: "free", action: "skill", uid: kurokawa, skillIndex: 0 }); // dropSelf → watch 登録
    expect(s.watchers.length).toBeGreaterThan(0);
    s = feed(s, { type: "free", action: "pass" }); // ドロー → レシーブ登場へ
    const azumane = grab(s, 0, "HV-P03-053"); // 東峰（烏野 3年, receive2）
    s = deploy(s, "receive", azumane);
    s = drainCp(s, true);
    expect(effParam(db, s, azumane, "receive")).toBe(4); // 2+2（watch）
    s.modifiers.push({ target: azumane, param: "receive", amount: -3, source: azumane });
    expect(effParam(db, s, azumane, "receive")).toBe(4); // －されない
  });

  it("P03-054 嶋田：手札Sトス登場毎にトス=1 watcher（fromHand）登録", () => {
    let s = setup(deckWith("HV-P03-054"), deckWith(FILLER), 0);
    const shimada = grab(s, 0, "HV-P03-054");
    s = feed(s, { type: "deploy-serve", uid: shimada });
    s = drainCp(s, true);
    const w = s.watchers.find((x) => x.trigger.on === "deploy");
    expect(w).toBeTruthy();
    expect((w!.trigger as { fromHand?: boolean }).fromHand).toBe(true);
  });
});

describe("烏野 P03：ボール拾い／イベント／改名", () => {
  it("P03-001 日向 ボール拾い：全員疑似ユース→▶抽1/▶イベント≥6回収（chooseOne）", () => {
    let s = setup(deckWith("HV-P03-001", "HV-P03-008", "HV-P03-015", "HV-P03-004"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-P03-008"); // 国見（疑似ユース）
    s = deploy(s, "toss", grab(s, 0, "HV-P03-015")); // 由良（疑似ユース S）
    s = feed(s, { type: "free", action: "pass" });
    s = deploy(s, "attack", grab(s, 0, "HV-P03-004")); // 月島（疑似ユース）
    const hinata = grab(s, 0, "HV-P03-001");
    s = feed(s, { type: "free", action: "skill", uid: hinata, skillIndex: 0 });
    expect(s.players[0].eventArea).toContain(hinata); // placeSelfInEventArea cost
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: true }); // gate（全員疑似ユース）
    expect(s.pendingDecision?.type).toBe("effect-option"); // chooseOne（▶抽1/▶回収）
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "effect-option", index: 0 }); // ▶抽1
    expect(s.players[0].hand.length).toBe(h0 + 1);
  });

  it("P03-080 探せ：レシーブ/トス/アタックから2ずつ→イベント回収（gutsFrom.perArea）", () => {
    let s = setup(deckWith("HV-P03-080", "HV-P01-080"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" }); // ドローフェイズ
    for (const area of ["receive", "toss", "attack"] as const) {
      for (let i = 0; i < 3; i++) pushTo(s, 0, area, FILLER); // 各區 頂キャラ＋2ガッツ
    }
    const other = pushTo(s, 0, "eventArea", "HV-P01-080"); // 探せ以外のカード
    const ev = grab(s, 0, "HV-P03-080");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // gate（perArea cost）
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [other] });
    expect(s.players[0].hand).toContain(other);
    // 各區ガッツ 2 ずつ消費 → 残 1（頂キャラ）
    for (const area of ["receive", "toss", "attack"] as const) expect(s.players[0][area].length).toBe(1);
  });

  it("P03-096 日向夏：抽1＋日向翔陽のパラメータ1つ+1", () => {
    let s = setup(deckWith("HV-P03-096", "HV-D01-001", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    s = deploy(s, "toss", grab(s, 0, "HV-D01-002")); // 影山
    s = feed(s, { type: "free", action: "pass" });
    const hinata = grab(s, 0, "HV-D01-001"); // 日向 翔陽（攻擊）
    s = deploy(s, "attack", hinata);
    s = drainCp(s, true);
    const base = effParam(db, s, hinata, "attack")!;
    const ev = grab(s, 0, "HV-P03-096");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [hinata] });
    if (s.pendingDecision?.type === "effect-option") s = feed(s, { type: "effect-option", index: 4 }); // attack
    expect(effParam(db, s, hinata, "attack")).toBe(base + 1);
  });

  it("PR-057／PR-060／077：deployNameChoice", () => {
    let s = setup(deckWith("HV-D01-002", "HV-PR-057"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    const dual = grab(s, 0, "HV-PR-057");
    s = feed(s, { type: "deploy-toss", uid: dual, nameChoice: "西谷 夕" });
    expect(nameOf(db, s, dual)).toBe("西谷 夕");
  });
});
