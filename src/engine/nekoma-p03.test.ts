// P03 音駒（HV-P03 + HV-PR）技能逐張行為測試。033 バックアタック 延後（核心引擎，見 WORKLOG）。
import { describe, it, expect } from "vitest";
import { effParam } from "./engine";
import { nameOf } from "./effects";
import { db, deckWith, grab, placeDeckTop, placeInDrop, seedStack, setup, serveWith, receiveTrack, setHandSize, FILLER } from "./testkit";

describe("音駒 P03：登場 gate（孤爪／夜久／灰羽／犬岡）", () => {
  it("P03-031 孤爪：2ガッツ(音駒S)→トス+2＋音駒/音駒中イベント検索", () => {
    let s = setup(deckWith("HV-P03-031", "HV-D02-001", "HV-D02-001", "HV-P03-090"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // P1 發球 OP=1
    s = receiveTrack(s, FILLER); // P0 接球 → 進托球階段（P0 為攻方）
    // 在 toss 下方鋪 2 張音駒-S 當ガッツ（孤爪 D02-001＝音駒 S）
    for (let i = 0; i < 2; i++) {
      const g = grab(s, 0, "HV-D02-001");
      const ps = s.players[0];
      ps.hand.splice(ps.hand.indexOf(g), 1);
      ps.toss.push(g);
    }
    placeDeckTop(s, 0, "HV-P03-090"); // 牌組頂＝音駒イベント（検索對象）
    const kenma = grab(s, 0, "HV-P03-031");
    s = feed_deploy(s, "toss", kenma);
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 2 ガッツ gate
    expect(effParam(db, s, kenma, "toss")).toBe(3); // 1+2（paidGutsAll 音駒S 成立）
    expect(s.pendingDecision?.type).toBe("effect-cards"); // lookTopTutor 候選
    expect(s.pendingDecision!.candidates!.length).toBeGreaterThan(0);
  });

  it("P03-035 夜久：3ガッツ→抽1＋レシーブ+2", () => {
    let s = setup(deckWith("HV-P03-035"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // OP=1
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" }); // 抽牌階段
    seedStack(s, 0, "receive", 3); // 鋪 3 ガッツ（無所属限定）
    const h0 = s.players[0].hand.length;
    const yaku = grab(s, 0, "HV-P03-035");
    s = feed_deploy(s, "receive", yaku);
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 3 ガッツ → 抽1＋receive+2
    expect(effParam(db, s, yaku, "receive")).toBe(7); // 5+2
    expect(s.players[0].hand.length).toBe(h0 + 1); // grab +1、deploy −1、draw +1
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss"); // 7 ≥ OP1 → 接球成功
  });

  it("P03-036 灰羽：OP≥4→ワンタッチ(2)（與 P01-060 同 contract）", () => {
    let s = setup(deckWith("HV-P03-036", "HV-D01-002", "HV-D01-008"), deckWith("HV-D01-008", "HV-D01-002", "HV-D01-010"), 0);
    s = serveWith(s, "HV-D01-002"); // P0 OP=1
    s = receiveTrack(s, "HV-D01-008"); // P1 接球 → turnPlayer=1
    const toss = grab(s, 1, "HV-D01-002");
    s = feed_deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-010"); // 東峰 a3
    s = feed_deploy(s, "attack", atk);
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 4, owner: 1 }); // 1+3
    s = feed(s, { type: "defense-choice", choice: "block" });
    const lev = grab(s, 0, "HV-P03-036");
    s = feed(s, { type: "deploy-block", uids: [lev], center: lev });
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // OP4≥4 gate
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.op).toMatchObject({ value: 2, owner: 1 }); // 4−2 ワンタッチ
    expect(s.phase).toBe("draw"); // 跳過攔網→自己抽牌
  });

  it("P03-038 犬岡：棄音駒1→ブロック+3、相手手札≤2 で さらに+2", () => {
    let s = setup(deckWith("HV-P03-038", "HV-D01-002", "HV-D02-002"), deckWith("HV-D01-002", "HV-D01-008", "HV-D01-010"), 0);
    s = serveWith(s, "HV-D01-002"); // P0 OP=1
    s = receiveTrack(s, "HV-D01-008"); // P1 接球 → turnPlayer=1
    const toss = grab(s, 1, "HV-D01-002");
    s = feed_deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-010");
    s = feed_deploy(s, "attack", atk);
    s = feed(s, { type: "free", action: "pass" });
    setHandSize(s, 1, 2); // 相手（P1，攻方）手札＝2
    grab(s, 0, "HV-D02-002"); // 確保 P0 手上有 1 張音駒可棄（黒尾）
    s = feed(s, { type: "defense-choice", choice: "block" });
    const inuoka = grab(s, 0, "HV-P03-038");
    s = feed(s, { type: "deploy-block", uids: [inuoka], center: inuoka });
    expect(s.pendingDecision?.type).toBe("effect-confirm");
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 dropFromHand(音駒)
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    expect(effParam(db, s, inuoka, "block")).toBe(7); // 2+3+2
  });
});

describe("音駒 P03：イベント（―俺達は血液だ／おれにバレー…）", () => {
  it("P03-089：ドロップから音駒キャラ1枚を手札に", () => {
    let s = setup(deckWith("HV-P03-089", "HV-D02-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" }); // 抽牌階段
    const dropped = placeInDrop(s, 0, "HV-D02-002"); // 黒尾（音駒キャラ）
    const ev = grab(s, 0, "HV-P03-089");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [dropped] });
    expect(s.players[0].hand).toContain(dropped);
  });

  it("P03-090：イベントエリアから「自身」以外のイベント1枚を回收", () => {
    let s = setup(deckWith("HV-P03-090", "HV-P03-089"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" }); // 抽牌階段
    const other = grab(s, 0, "HV-P03-089"); // 另一張音駒イベント
    const ps = s.players[0];
    ps.hand.splice(ps.hand.indexOf(other), 1);
    ps.eventArea.push(other);
    const ev = grab(s, 0, "HV-P03-090");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.pendingDecision?.type).toBe("effect-cards");
    expect(s.pendingDecision!.candidates).toContain(other);
    expect(s.pendingDecision!.candidates).not.toContain(ev); // 排除自身（「以外」）
    s = feed(s, { type: "effect-cards", uids: [other] });
    expect(s.players[0].hand).toContain(other);
  });
});

describe("音駒 P03：置換登場（黒尾・山本／灰羽・木兎）", () => {
  it("PR-058 黒尾・山本：以選定名登場，非候選名拋錯", () => {
    let s = setup(deckWith("HV-D01-002", "HV-PR-058"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // P1 發球
    s = receiveTrack(s, FILLER); // P0 接球 → 托球階段
    const toss = grab(s, 0, "HV-D01-002"); // 影山 S（無ガッツ→技能自動跳過）
    s = feed_deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const dual = grab(s, 0, "HV-PR-058");
    expect(() => feed(s, { type: "deploy-attack", uid: dual, nameChoice: "孤爪 研磨" })).toThrow();
    s = feed(s, { type: "deploy-attack", uid: dual, nameChoice: "山本 猛虎" });
    expect(nameOf(db, s, dual)).toBe("山本 猛虎");
  });

  it("PR-062 灰羽・木兎：以選定名登場", () => {
    let s = setup(deckWith("HV-D01-002", "HV-PR-062"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    const toss = grab(s, 0, "HV-D01-002");
    s = feed_deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const dual = grab(s, 0, "HV-PR-062");
    s = feed(s, { type: "deploy-attack", uid: dual, nameChoice: "木兎 光太郎" });
    expect(nameOf(db, s, dual)).toBe("木兎 光太郎");
  });
});

// --- local helpers ---
import { applyDecision } from "./engine";
import type { GameState, Decision } from "./types";
function feed(s: GameState, d: Decision): GameState {
  return applyDecision(db, s, d);
}
function feed_deploy(s: GameState, area: "toss" | "receive" | "attack", uid: number): GameState {
  return feed(s, { type: `deploy-${area}`, uid } as Decision);
}
