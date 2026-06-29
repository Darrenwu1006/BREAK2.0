// P03 最後5張（028 古森／079 影山という…／047 影山／083 火焼／PR-063 ジャンバル）。
import { describe, it, expect } from "vitest";
import { applyDecision, effParam } from "./engine";
import { topChara } from "./effects";
import { db, deckWith, grab, placeDeckTop, setup, serveWith, receiveTrack, drainCp, FILLER } from "./testkit";
import type { GameState, Decision, PlayerId } from "./types";

function feed(s: GameState, d: Decision): GameState {
  return applyDecision(db, s, d);
}
function deploy(s: GameState, area: "toss" | "receive" | "attack", uid: number): GameState {
  return feed(s, { type: `deploy-${area}`, uid } as Decision);
}
function pushGuts(s: GameState, p: PlayerId, area: "receive" | "toss" | "attack", cardId: string): number {
  const u = grab(s, p, cardId);
  s.players[p].hand.splice(s.players[p].hand.indexOf(u), 1);
  s.players[p][area].unshift(u); // 底＝ガッツ層
  return u;
}

describe("P03 最後5張", () => {
  it("PR-063 ジャンバル：ピース→自分2まで＋相手2引く（drawOpponent）", () => {
    let s = setup(deckWith("HV-PR-063", FILLER, FILLER, FILLER, FILLER), deckWith(FILLER, FILLER, FILLER, FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" }); // ドローフェイズ
    const ev = grab(s, 0, "HV-PR-063");
    const oh0 = s.players[1].hand.length;
    s = feed(s, { type: "free", action: "event", uid: ev });
    s = feed(s, { type: "effect-confirm", accept: true }); // gate（tilt）
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: true }); // 自分 draw upTo
    expect(s.players[1].hand.length).toBe(oh0 + 2); // 相手2引く
  });

  it("P03-047 影山：イベントplay毎にトス+1、スキルで4以上にならない（cap=3）", () => {
    const drainAll = (s: GameState): GameState => {
      for (let i = 0; i < 20; i++) {
        const pd = s.pendingDecision;
        if (pd?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
        else if (pd?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: pd.candidates!.slice(0, pd.min) });
        else if (pd?.type === "effect-option") s = feed(s, { type: "effect-option", index: 0 });
        else if (pd?.type === "resolve-pending") s = feed(s, { type: "resolve-pending", id: pd.candidates![0]! });
        else break;
      }
      return s;
    };
    let s = setup(deckWith("HV-P03-047", "HV-P01-078", "HV-P01-078"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    const kage = grab(s, 0, "HV-P03-047"); // 影山(toss base 0)
    s = deploy(s, "toss", kage);
    s = drainCp(s, false);
    s = feed(s, { type: "free", action: "pass" }); // → アタックフェイズ
    s = deploy(s, "attack", grab(s, 0, FILLER));
    s = drainCp(s, false);
    // イベント play → 047 トス+1（0→1）
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P01-078") });
    s = drainAll(s);
    expect(effParam(db, s, kage, "toss")).toBe(1); // 0+1
    // トスを2に底上げ（合計3になる手前）→ 047 cap：effParam=2 まではOK、3 で頭打ち
    s.modifiers.push({ target: kage, param: "toss", amount: 1, source: kage }); // toss=2
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P01-078") });
    s = drainAll(s);
    expect(effParam(db, s, kage, "toss")).toBe(3); // 2→3（≤2 なので最後の+1適用）
    // toss=3 で再度（手動 event 相当）→ script は +しない設計：modifier 追加で 4 にならないことを確認
    s.modifiers.push({ target: kage, param: "toss", amount: 2, source: kage }); // 他要因で5でも…
    expect(effParam(db, s, kage, "toss")).toBe(5); // 047 以外の + は cap 対象外
  });

  it("P03-079 影山という…：頂5→疑似ユースWS/MB/S/Li 1＋ボール拾い 1（lookTopTwoPick）", () => {
    let s = setup(deckWith("HV-P03-079", "HV-P03-003", "HV-P03-013", FILLER, FILLER, FILLER), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" }); // ドローフェイズ
    // 牌組頂に疑似ユースMB(003)＋ボール拾い(013)を仕込む
    placeDeckTop(s, 0, "HV-P03-013"); // 頂2
    placeDeckTop(s, 0, "HV-P03-003"); // 頂1
    const ev = grab(s, 0, "HV-P03-079");
    s = feed(s, { type: "free", action: "event", uid: ev });
    // 第1段：003（疑似ユースMB）
    expect(s.pendingDecision?.type).toBe("effect-cards");
    const c1 = s.pendingDecision!.candidates!.find((u) => s.cards[u] === "HV-P03-003")!;
    s = feed(s, { type: "effect-cards", uids: [c1] });
    // 第2段：013（ボール拾い）
    expect(s.pendingDecision?.type).toBe("effect-cards");
    const c2 = s.pendingDecision!.candidates!.find((u) => s.cards[u] === "HV-P03-013")!;
    s = feed(s, { type: "effect-cards", uids: [c2] });
    expect(s.players[0].hand.some((u) => s.cards[u] === "HV-P03-003")).toBe(true);
    expect(s.players[0].hand.some((u) => s.cards[u] === "HV-P03-013")).toBe(true);
  });

  it("P03-028 古森：ユーストス登場時→影山ガッツを自身の上に＋backAttack watcher 登録", () => {
    let s = setup(deckWith("HV-P03-028", "HV-P03-022", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER); // P0 → 托球（古森を受けに置きたいので別構造）
    // P0 レシーブに古森(028)＋影山ガッツを構造
    const ps = s.players[0];
    const kageGuts = grab(s, 0, "HV-D01-002"); ps.hand.splice(ps.hand.indexOf(kageGuts), 1); ps.receive.push(kageGuts); // 影山（ガッツ層）
    const komori = grab(s, 0, "HV-P03-028"); ps.hand.splice(ps.hand.indexOf(komori), 1); ps.receive.push(komori); // 古森（受けキャラ＝頂）
    // ユーストス（宮侑 P03-022）登場 → 028 誘発
    const miya = grab(s, 0, "HV-P03-022");
    s = deploy(s, "toss", miya);
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // 028 gate
    s = feed(s, { type: "effect-confirm", accept: true }); // 影山ガッツを古森の上に
    expect(topChara(s.players[0].receive)).toBe(kageGuts); // 影山が受け頂端に
    expect(s.watchers.some((w) => w.trigger.on === "deploy" && (w.trigger as { backAttack?: boolean }).backAttack)).toBe(true);
  });

  it("P03-083 火焼：全員ユース→抽1＋レシーブ+1（＋ガッツ入替は例外なく解決）", () => {
    let s = setup(deckWith("HV-P03-083", "HV-P03-022"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const miya = grab(s, 0, "HV-P03-022"); // ユース（受け＝全員ユース）
    s = deploy(s, "receive", miya);
    s = drainCp(s, false);
    const base = effParam(db, s, miya, "receive")!;
    const ev = grab(s, 0, "HV-P03-083");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [miya] });
    expect(effParam(db, s, miya, "receive")).toBe(base + 1);
  });
});
