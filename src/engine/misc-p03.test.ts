// P03 其餘小校（016 角川／023 鴎台／026 井闥山／030 森然／061 梟谷／073 森然／075 椿原／078 条善寺／084 全日本／085 鴎台／088 音駒中）。083 延後。
import { describe, it, expect } from "vitest";
import { applyDecision, effParam } from "./engine";
import { db, deckWith, grab, placeDeckTop, placeInDrop, placeOnStack, seedStack, setup, serveWith, receiveTrack, drainCp, FILLER } from "./testkit";
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
/** P0 發球→P1 攻擊→P0 攔網直前 */
function toBlockDefense(s: GameState): GameState {
  s = serveWith(s, "HV-D01-002");
  s = receiveTrack(s, "HV-D01-008");
  s = deploy(s, "toss", grab(s, 1, "HV-D01-002"));
  s = feed(s, { type: "free", action: "pass" });
  s = deploy(s, "attack", grab(s, 1, "HV-D01-010"));
  s = feed(s, { type: "free", action: "pass" });
  return s;
}

describe("其餘小校 P03：登場 gate", () => {
  it("P03-026 佐久早：イベントからユース1ドロップ（cost）→ブロック+2", () => {
    let s = setup(deckWith("HV-P03-026", "HV-P03-085", "HV-D01-002", "HV-D01-008"), deckWith("HV-D01-008", "HV-D01-002", "HV-D01-010"), 0);
    s = toBlockDefense(s);
    pushTo(s, 0, "eventArea", "HV-P03-085"); // ユースのカード（事件區）
    s = feed(s, { type: "defense-choice", choice: "block" });
    const sakusa = grab(s, 0, "HV-P03-026");
    s = feed(s, { type: "deploy-block", uids: [sakusa], center: sakusa });
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 dropFromEventArea
    expect(effParam(db, s, sakusa, "block")).toBe(4); // 2+2
    expect(s.players[0].drop.some((u) => s.cards[u] === "HV-P03-085")).toBe(true); // イベント→drop
  });

  it("P03-061 木兎：手札から木兎1ドロップ→抽1＋パラメータ1つ+3", () => {
    let s = setup(deckWith("HV-P03-061", "HV-P01-044"), deckWith(FILLER), 0);
    grab(s, 0, "HV-P01-044"); // 木兎 光太郎（cost 用、手札へ）
    const bokuto = grab(s, 0, "HV-P03-061");
    s = feed(s, { type: "deploy-serve", uid: bokuto });
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 dropFromHand 木兎
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 1) });
    if (s.pendingDecision?.type === "effect-option") s = feed(s, { type: "effect-option", index: 0 }); // serve
    expect(effParam(db, s, bokuto, "serve")).toBe(5); // 2+3
  });

  it("P03-075 寺泊：トス=越後栄＋3ガッツ→パラメータ1つ+3", () => {
    let s = setup(deckWith("HV-P03-075", "HV-P01-069"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    s = deploy(s, "toss", grab(s, 0, "HV-P01-069")); // 越後 栄（托球）
    s = drainCp(s, false);
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 3);
    const teradomari = grab(s, 0, "HV-P03-075");
    s = deploy(s, "attack", teradomari);
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-option") s = feed(s, { type: "effect-option", index: 4 }); // attack
    expect(effParam(db, s, teradomari, "attack")).toBe(5); // 2+3
  });

  it("P03-073 小鹿野：各區2ガッツずつ→アタック+5＋相手ブロックスキル無効 restriction", () => {
    let s = setup(deckWith("HV-P03-073", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    s = deploy(s, "toss", grab(s, 0, "HV-D01-002"));
    s = feed(s, { type: "free", action: "pass" });
    for (const area of ["receive", "toss", "attack"] as const) seedStack(s, 0, area, 2);
    const ojika = grab(s, 0, "HV-P03-073");
    s = deploy(s, "attack", ojika);
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, ojika, "attack")).toBe(5); // 0+5
    expect(s.restrictions.some((r) => r.disableSkills && r.player === 1)).toBe(true);
  });
});

describe("其餘小校 P03：イベント", () => {
  it("P03-085 ドンッ：ユース1人アタック+1；星海なら3ガッツ→更に+2", () => {
    let s = setup(deckWith("HV-P03-085", "HV-D01-002", "HV-P03-023"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    s = deploy(s, "toss", grab(s, 0, "HV-D01-002"));
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 3); // ガッツを先に仕込む（星海の下へ）
    const hoshiumi = grab(s, 0, "HV-P03-023"); // 星海（ユース）攻擊
    s = deploy(s, "attack", hoshiumi);
    s = drainCp(s, true);
    const ev = grab(s, 0, "HV-P03-085");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, hoshiumi, "attack")).toBe(1 + 1 + 2); // 基礎1＋1＋2
  });

  it("P03-088 山本・灰羽：手札≤4→名異なる音駒ガッツ2回収→ドロップ音駒キャラをデッキ下（dropToDeckBottom）", () => {
    let s = setup(deckWith("HV-P03-088", "HV-D02-001", "HV-D02-002", "HV-D02-003"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" }); // ドローフェイズ
    // レシーブ区に名異なる音駒ガッツ2枚＋頂キャラ
    pushTo(s, 0, "receive", "HV-D02-001"); // 孤爪（ガッツ）
    pushTo(s, 0, "receive", "HV-D02-002"); // 黒尾（ガッツ、名異）
    pushTo(s, 0, "receive", FILLER); // 頂キャラ
    const kageInDrop = placeInDrop(s, 0, "HV-D02-003"); // 音駒キャラ（drop）
    while (s.players[0].hand.length > 4) s.players[0].deck.push(s.players[0].hand.pop()!); // 手札≤4
    const ev = grab(s, 0, "HV-P03-088");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 2) }); // gutsToHand 2
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [kageInDrop] }); // dropToDeckBottom
    expect(s.players[0].deck[s.players[0].deck.length - 1]).toBe(kageInDrop); // 牌組底
  });
});

describe("其餘小校 P03：全員ユース系", () => {
  it("P03-084 雲雀田：全員ユース→抽1＋レシーブ+1＋イベント≤2で更に+1", () => {
    let s = setup(deckWith("HV-P03-084", "HV-P03-023"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" }); // ドロー
    const star = grab(s, 0, "HV-P03-023"); // 星海（ユース）受け＝全員ユース
    s = deploy(s, "receive", star);
    s = drainCp(s, false); // 星海 gate（event 無→skip）
    const ev = grab(s, 0, "HV-P03-084");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [star] });
    expect(effParam(db, s, star, "receive")).toBe(5); // 3+1+1（イベント≤2）
  });

  it("P03-023 星海：全員ユース＋イベントからユース1ドロップ→パラメータ1つ+3", () => {
    let s = setup(deckWith("HV-P03-023", "HV-P03-021", "HV-P03-085"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    pushTo(s, 0, "toss", "HV-P03-021"); // 宮侑（ユース）＝全員ユース成立用
    pushTo(s, 0, "eventArea", "HV-P03-085"); // ユースイベント（cost）
    const hoshiumi = grab(s, 0, "HV-P03-023");
    s = deploy(s, "receive", hoshiumi);
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 dropFromEventArea ユース
    if (s.pendingDecision?.type === "effect-option") s = feed(s, { type: "effect-option", index: 2 }); // receive
    expect(effParam(db, s, hoshiumi, "receive")).toBe(6); // 3+3
  });

  it("P03-078 穴原：頂3→条善寺/疑似ユースキャラ回收（affiliationsAny）", () => {
    let s = setup(deckWith("HV-P03-078", "HV-P03-005"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" }); // ドローフェイズ
    placeDeckTop(s, 0, "HV-P03-005"); // 金田一（疑似ユース キャラ）頂へ
    const ev = grab(s, 0, "HV-P03-078");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.pendingDecision?.type).toBe("effect-cards"); // lookTopTutor 候選
    s = feed(s, { type: "effect-cards", uids: s.pendingDecision!.candidates!.slice(0, 1) });
    expect(s.players[0].hand.some((u) => s.cards[u] === "HV-P03-005")).toBe(true);
  });

  it("P03-030 千鹿谷：全員ユース＋相手OP≥8→ブロック終了→ドローフェイズ", () => {
    // P0 のサーブも ユース（星海）にして「全員ユース」を成立させる
    let s = setup(deckWith("HV-P03-030", "HV-P03-023", "HV-D01-008"), deckWith("HV-D01-008", "HV-D01-002", "HV-D01-010"), 0);
    s = serveWith(s, "HV-P03-023"); // P0 星海（ユース）サーブ
    s = receiveTrack(s, "HV-D01-008");
    s = deploy(s, "toss", grab(s, 1, "HV-D01-002"));
    s = feed(s, { type: "free", action: "pass" });
    s = deploy(s, "attack", grab(s, 1, "HV-D01-010"));
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "block" });
    s.op = { value: 8, owner: 1, source: "attack" }; // 相手OP≥8 を構造（passive 評估前に）
    const chikaya = grab(s, 0, "HV-P03-030"); // 森然/ユース
    s = feed(s, { type: "deploy-block", uids: [chikaya], center: chikaya });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.phase).toBe("draw"); // skipToPhase
    expect(s.turnPlayer).toBe(0); // 自分のドローフェイズ
  });
});
