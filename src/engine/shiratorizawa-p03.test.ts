// P03 白鳥沢（HV-P03-011/013/014/067/069/071/072/099）。079 延後（兩段檢索需 bespoke flow，見 WORKLOG）。
import { describe, it, expect } from "vitest";
import { applyDecision, effParam } from "./engine";
import { db, deckWith, grab, placeDeckTop, placeInDrop, placeOnStack, seedStack, setup, serveWith, receiveTrack, FILLER } from "./testkit";
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

describe("白鳥沢 P03：ボール拾い／active", () => {
  // 全員疑似ユースの攻擊階段を作る：国見(受)→由良(托)→月島(攻) すべて疑似ユース
  function gijiAttackPhase(s: GameState): GameState {
    s = serveWith(s, FILLER); // P1 OP=1
    s = receiveTrack(s, "HV-P03-008"); // P0 国見（疑似ユース r5）接球 → 托球階段
    const toss = grab(s, 0, "HV-P03-015"); // 由良（疑似ユース S）
    s = deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 0, "HV-P03-004"); // 月島（疑似ユース）攻擊
    s = deploy(s, "attack", atk);
    return s;
  }

  it("P03-013 寒河江：ボール拾い cost→全員疑似ユースなら頂2公開→キャラ1まで", () => {
    let s = setup(deckWith("HV-P03-013", "HV-P03-008", "HV-P03-015", "HV-P03-004", "HV-P02-046"), deckWith(FILLER), 1);
    s = gijiAttackPhase(s);
    placeDeckTop(s, 0, "HV-P02-046"); // 牌組頂＝白鳥沢キャラ（檢索對象）
    const balls = grab(s, 0, "HV-P03-013");
    s = feed(s, { type: "free", action: "skill", uid: balls, skillIndex: 0 });
    expect(s.players[0].eventArea).toContain(balls); // placeSelfInEventArea cost
    expect(s.pendingDecision?.type).toBe("effect-cards"); // lookTopTutor
    expect(s.pendingDecision!.candidates!.length).toBeGreaterThan(0);
  });

  it("P03-014 赤倉：頂3公開→イベントすべて手札（addAll）", () => {
    let s = setup(deckWith("HV-P03-014", "HV-P03-008", "HV-P03-015", "HV-P03-004", "HV-P01-080", "HV-P02-100"), deckWith(FILLER), 1);
    s = gijiAttackPhase(s);
    placeDeckTop(s, 0, "HV-P01-080"); // 猫又（EVENT）
    placeDeckTop(s, 0, "HV-P02-100"); // 灰羽アリサ（EVENT）→ 頂2張は事件
    const balls = grab(s, 0, "HV-P03-014");
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "free", action: "skill", uid: balls, skillIndex: 0 });
    expect(s.pendingDecision?.type).not.toBe("effect-cards"); // addAll：無選擇
    expect(s.players[0].hand.some((u) => s.cards[u] === "HV-P01-080")).toBe(true);
    expect(s.players[0].hand.some((u) => s.cards[u] === "HV-P02-100")).toBe(true);
    expect(s.players[0].hand.length).toBe(h0 - 1 + 2); // balls 置入事件區 −1、事件 2 枚 +2
  });
});

describe("白鳥沢 P03：登場 gate／watch", () => {
  it("P03-069 白布：2ガッツ→抽1＋トス+1", () => {
    let s = setup(deckWith("HV-P03-069"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER); // P0 → 托球
    seedStack(s, 0, "toss", 2);
    const shirabu = grab(s, 0, "HV-P03-069");
    s = deploy(s, "toss", shirabu);
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, shirabu, "toss")).toBe(2); // 1+1
  });

  it("P03-067 牛島：2ガッツ→receive+4（相手アタック不在→OP−2分歧は不発）", () => {
    let s = setup(deckWith("HV-P03-067"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // OP=1
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 2);
    const ushi = grab(s, 0, "HV-P03-067");
    s = deploy(s, "receive", ushi);
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 2 ガッツ
    // 内側 gate（相手アタックキャラ元々≤1）：發球防守時相手にアタックキャラ無し → cond 不成立 → スキップ
    expect(effParam(db, s, ushi, "receive")).toBe(6); // 2+4
  });

  it("P03-072 瀬見：白鳥沢キャラの上に登場→サーブ+3（overAffiliation）；非白鳥沢上では不発", () => {
    // 白鳥沢キャラの上に登場
    let s = setup(deckWith("HV-P03-072", "HV-P02-046"), deckWith(FILLER), 0);
    placeOnStack(s, 0, "serve", "HV-P02-046"); // 既存サーブキャラ＝牛島（白鳥沢）
    const semi = grab(s, 0, "HV-P03-072");
    s = feed(s, { type: "deploy-serve", uid: semi }); // 牛島の上に登場
    expect(effParam(db, s, semi, "serve")).toBe(6); // 3+3（overAffiliation 成立）

    // 非白鳥沢の上 → 不発
    let t = setup(deckWith("HV-P03-072"), deckWith(FILLER), 0);
    placeOnStack(t, 0, "serve", FILLER); // 烏野フィラーの上
    const semi2 = grab(t, 0, "HV-P03-072");
    t = feed(t, { type: "deploy-serve", uid: semi2 });
    expect(effParam(db, t, semi2, "serve")).toBe(3); // 基礎値（不発）
  });

  it("P03-099 …何をやっている：牛島なら相手イベント区キャラ全ドロップ＋2枚以上で さらに+1（script）", () => {
    let s = setup(deckWith("HV-P01-056", "HV-P03-099", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER); // P0 → 托球
    const toss = grab(s, 0, "HV-D01-002");
    s = deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const ushi = grab(s, 0, "HV-P01-056"); // 牛島（白鳥沢 attacker）
    s = deploy(s, "attack", ushi);
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    // 對手事件區放 2 張角色卡（FILLER＝CHARACTER）
    const opp = s.players[1];
    for (let i = 0; i < 2; i++) {
      const u = grab(s, 1, FILLER);
      opp.hand.splice(opp.hand.indexOf(u), 1);
      opp.eventArea.push(u);
    }
    const before = opp.eventArea.length;
    const baseAtk = effParam(db, s, ushi, "attack")!;
    const ev = grab(s, 0, "HV-P03-099");
    s = feed(s, { type: "free", action: "event", uid: ev });
    // addParam 攻擊キャラ（唯一白鳥沢 attacker）→ 自動套用；牛島 → 全ドロップ
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice() });
    expect(s.players[1].eventArea.length).toBe(before - 2); // 角色全ドロップ
    expect(effParam(db, s, ushi, "attack")).toBe(baseAtk + 1 + 1); // +1（基本）＋+1（2枚以上）
  });
});

describe("白鳥沢 P03：五色／山形", () => {
  it("P03-011 五色：全員白鳥沢＋イベント≥4→dropSelf→自drop登場 receive＋receive+4", () => {
    let s = setup(deckWith("HV-P03-011", "HV-P02-052"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // OP=1
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const recv = grab(s, 0, "HV-P02-052"); // 大平（白鳥沢）接球キャラ
    s = deploy(s, "receive", recv);
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    stuffEventArea(s, 0, 4);
    const gosiki = grab(s, 0, "HV-P03-011");
    s = feed(s, { type: "free", action: "skill", uid: gosiki, skillIndex: 0 });
    expect(effParam(db, s, gosiki, "receive")).toBe(7); // 自drop登場 receive、3+4
  });

  it("P03-071 山形：Set合計≤1で3ガッツ→receive+2＋drop白鳥沢3年（山形以外）回收", () => {
    let s = setup(deckWith("HV-P03-071", "HV-P01-057"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // OP=1
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s.players[0].setArea = []; // Set 合計 0 ≤ 1（建構条件）
    s.players[1].setArea = [];
    const tenma = placeInDrop(s, 0, "HV-P01-057"); // 天童（白鳥沢 3年）
    seedStack(s, 0, "receive", 3);
    const yama = grab(s, 0, "HV-P03-071");
    s = deploy(s, "receive", yama);
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 3 ガッツ
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [tenma] });
    expect(effParam(db, s, yama, "receive")).toBe(7); // 5+2
    expect(s.players[0].hand).toContain(tenma); // 天童 回收
  });
});
