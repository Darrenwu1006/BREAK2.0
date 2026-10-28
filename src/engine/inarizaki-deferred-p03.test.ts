// P03 稲荷崎 延後3張（039 宮侑／086 プレーは大分／091 俺のサーブの邪魔すんなや）。
import { describe, it, expect } from "vitest";
import { applyDecision, effParam } from "./engine";
import { fireSelfDroppedFromEvent } from "./effects";
import { topChara } from "./effect-helpers";
import { db, deckWith, grab, setup, serveWith, receiveTrack, drainCp, FILLER } from "./testkit";
import type { GameState, Decision, PlayerId } from "./types";

function feed(s: GameState, d: Decision): GameState {
  return applyDecision(db, s, d);
}
function deploy(s: GameState, area: "toss" | "receive" | "attack", uid: number): GameState {
  return feed(s, { type: `deploy-${area}`, uid } as Decision);
}
function pushTo(s: GameState, p: PlayerId, zone: "eventArea", cardId: string): number {
  const u = grab(s, p, cardId);
  s.players[p].hand.splice(s.players[p].hand.indexOf(u), 1);
  s.players[p][zone].push(u);
  return u;
}

describe("稲荷崎 延後 P03", () => {
  it("P03-086 プレーは大分：Sトス=2＋デッキ下→[=アタック]のみイベント回収", () => {
    let s = setup(deckWith("HV-P03-086", "HV-D01-002", "HV-P01-078"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER); // P0 → 托球
    const kage = grab(s, 0, "HV-D01-002"); // 影山（S）
    s = deploy(s, "toss", kage);
    s = drainCp(s, false);
    const opn = pushTo(s, 0, "eventArea", "HV-P01-078"); // オープン攻撃（[=アタック]のみ）
    const ev = grab(s, 0, "HV-P03-086");
    s = feed(s, { type: "free", action: "event", uid: ev });
    // setParam（Sトス=影山）→ 自動、その後 gate（デッキ下）
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [kage] });
    expect(effParam(db, s, kage, "toss")).toBe(2); // トス=2（固定）
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // gate（このカードをデッキ下）
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [opn] }); // 回収
    expect(s.players[0].deck[s.players[0].deck.length - 1]).toBe(ev); // 086 はデッキ底
    expect(s.players[0].hand).toContain(opn); // オープン攻撃 回收
  });

  it("P03-091 俺のサーブ：サーブ=宮侑→サーブ6＋self-dropped watcher 登録", () => {
    let s = setup(deckWith("HV-D03-001", "HV-P03-091"), deckWith(FILLER), 0);
    const miya = grab(s, 0, "HV-D03-001"); // 宮 侑（S）サーブ
    s = feed(s, { type: "deploy-serve", uid: miya });
    s = drainCp(s, false);
    const ev = grab(s, 0, "HV-P03-091");
    s = feed(s, { type: "free", action: "event", uid: ev }); // 抽1＋サーブ=6＋watch
    expect(effParam(db, s, miya, "serve")).toBe(6);
    const w = s.watchers.find((x) => x.trigger.on === "selfDroppedFromEvent");
    expect(w).toBeTruthy();
    expect(w!.source).toBe(ev); // 監看源＝091 自身
  });

  it("self-dropped watcher 觸發：fireSelfDroppedFromEvent → 抽1（直接機構檢証）", () => {
    let s = setup(deckWith("HV-D03-001", "HV-P03-091"), deckWith(FILLER), 0);
    const miya = grab(s, 0, "HV-D03-001");
    s = feed(s, { type: "deploy-serve", uid: miya });
    s = drainCp(s, false);
    const ev = grab(s, 0, "HV-P03-091");
    s = feed(s, { type: "free", action: "event", uid: ev }); // watcher 登録
    const h0 = s.players[0].hand.length;
    // 091 をイベントエリア→ドロップ＋fire（dropFromEventArea 經路と同じ呼び出し）
    s.players[0].eventArea.splice(s.players[0].eventArea.indexOf(ev), 1);
    s.players[0].drop.push(ev);
    fireSelfDroppedFromEvent(s, 0, ev); // delayed 抽1 を enqueue
    s = feed(s, { type: "free", action: "pass" }); // エンジンループで pendingQueue 解決 → 抽1
    expect(s.players[0].hand.length).toBeGreaterThan(h0); // ドロップ→抽1
  });

  it("Q1799：宮侑每次觸發只能支付2枚/+1；兩次play可各付一次", () => {
    let s = setup(deckWith("HV-P03-039", "HV-P02-086", "HV-P02-086", "HV-P03-091", "HV-P03-091", "HV-P03-091"), deckWith(FILLER), 0);
    const miya = grab(s, 0, "HV-P03-039");
    s = feed(s, { type: "deploy-serve", uid: miya });
    s = drainCp(s, false);
    for (let i = 0; i < 3; i++) pushTo(s, 0, "eventArea", "HV-P03-091");
    for (let play = 1; play <= 2; play++) {
      s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P02-086") });
      expect(s.pendingDecision?.type).toBe("effect-confirm");
      s = feed(s, { type: "effect-confirm", accept: true });
      expect(s.pendingDecision?.type).toBe("effect-cards");
      expect(s.pendingDecision?.min).toBe(2);
      expect(s.pendingDecision?.max).toBe(2);
      const paid = s.pendingDecision!.candidates!.slice(0, 2);
      s = feed(s, { type: "effect-cards", uids: paid });
      expect(s.pendingDecision?.type).toBe("free"); // 第一次仍有2張可支付，但不能再開第二個gate。
      expect(effParam(db, s, miya, "serve")).toBe(3 + play);
      expect(paid.every((uid) => s.players[0].drop.includes(uid))).toBe(true);
      expect(s.players[0].eventArea).toHaveLength(3 - play);
    }
  });

  it("Q1799：宮侑可拒絕付款，且不足2張時不出現gate", () => {
    for (const count of [0, 1]) {
      let s = setup(deckWith("HV-P03-039", "HV-P02-086", "HV-P03-091"), deckWith(FILLER), 0);
      const miya = grab(s, 0, "HV-P03-039");
      s = feed(s, { type: "deploy-serve", uid: miya });
      if (count) pushTo(s, 0, "eventArea", "HV-P03-091");
      s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P02-086") });
      if (count) {
        expect(s.pendingDecision?.type).toBe("effect-confirm");
        s = feed(s, { type: "effect-confirm", accept: false });
      }
      expect(s.pendingDecision?.type).toBe("free");
      expect(effParam(db, s, miya, "serve")).toBe(3);
      expect(s.players[0].eventArea).toHaveLength(count + 1);
    }
  });
});
