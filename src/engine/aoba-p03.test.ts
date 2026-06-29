// P03 青葉城西（HV-P03-005/006/007 + HV-PR-061）技能逐張行為測試。
import { describe, it, expect } from "vitest";
import { applyDecision, effParam } from "./engine";
import { nameOf } from "./effects";
import { db, deckWith, grab, seedStack, setup, serveWith, receiveTrack, FILLER } from "./testkit";
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

describe("青葉城西 P03", () => {
  it("P03-005 金田一：イベント≥4＋2ガッツ→アタック+2＆相手登場毎−2 watcher 登録", () => {
    let s = setup(deckWith("HV-P03-005", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER); // P0 接球 → 托球階段
    const toss = grab(s, 0, "HV-D01-002");
    s = deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    stuffEventArea(s, 0, 4); // イベントエリア＝4
    seedStack(s, 0, "attack", 2); // 2 ガッツ
    const kane = grab(s, 0, "HV-P03-005");
    s = deploy(s, "attack", kane);
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 2 ガッツ
    expect(effParam(db, s, kane, "attack")).toBe(4); // 2+2
    expect(s.watchers.length).toBeGreaterThan(0); // 「相手登場毎−2」watcher 已註冊
  });

  it("P03-005：イベント<4 ではボーナス無し（gate 不成立）", () => {
    let s = setup(deckWith("HV-P03-005", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    const toss = grab(s, 0, "HV-D01-002");
    s = deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    stuffEventArea(s, 0, 3); // 僅 3 → 不足
    seedStack(s, 0, "attack", 2);
    const kane = grab(s, 0, "HV-P03-005");
    s = deploy(s, "attack", kane);
    // gate 條件不成立 → 無 effect-confirm，直接可 pass
    expect(effParam(db, s, kane, "attack")).toBe(2); // 基礎值不變
  });

  it("P03-006 金田一：OP≥4→ワンタッチ(2)（與 036/P01-060 同 contract）", () => {
    let s = setup(deckWith("HV-P03-006", "HV-D01-002", "HV-D01-008"), deckWith("HV-D01-008", "HV-D01-002", "HV-D01-010"), 0);
    s = serveWith(s, "HV-D01-002"); // P0 OP=1
    s = receiveTrack(s, "HV-D01-008"); // P1 接球 → turnPlayer=1
    const toss = grab(s, 1, "HV-D01-002");
    s = deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-010");
    s = deploy(s, "attack", atk);
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 4, owner: 1 });
    s = feed(s, { type: "defense-choice", choice: "block" });
    const kane = grab(s, 0, "HV-P03-006");
    s = feed(s, { type: "deploy-block", uids: [kane], center: kane });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.op).toMatchObject({ value: 2, owner: 1 }); // 4−2
    expect(s.phase).toBe("draw");
  });

  it("P03-007 国見：全員青葉＋イベント≥6→抽1＋レシーブ+3", () => {
    let s = setup(deckWith("HV-P03-007"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // OP=1
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" }); // 抽牌
    stuffEventArea(s, 0, 6); // ≥6
    seedStack(s, 0, "receive", 3);
    const h0 = s.players[0].hand.length;
    const kunimi = grab(s, 0, "HV-P03-007"); // 青葉城西 WS receive5
    s = deploy(s, "receive", kunimi);
    s = feed(s, { type: "effect-confirm", accept: true }); // 全員青葉（場上僅國見）＋≥4→抽1，≥6→receive+3
    expect(effParam(db, s, kunimi, "receive")).toBe(8); // 5+3
    expect(s.players[0].hand.length).toBe(h0 + 1); // grab+1 deploy−1 draw+1
  });

  it("PR-061 国見・五色：以選定名登場", () => {
    let s = setup(deckWith("HV-D01-002", "HV-PR-061"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    const toss = grab(s, 0, "HV-D01-002");
    s = deploy(s, "toss", toss);
    s = feed(s, { type: "free", action: "pass" });
    const dual = grab(s, 0, "HV-PR-061");
    expect(() => feed(s, { type: "deploy-attack", uid: dual, nameChoice: "牛島 若利" })).toThrow();
    s = feed(s, { type: "deploy-attack", uid: dual, nameChoice: "五色 工" });
    expect(nameOf(db, s, dual)).toBe("五色 工");
  });
});
