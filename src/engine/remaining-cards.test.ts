// M3 長尾卡：依 docs/M3_REMAINING_94_PLAN.md 分批補完。
import { describe, expect, it } from "vitest";
import { blockDeployMax, effParam } from "./engine";
import { deployCard, deployNames, nameOf } from "./effects";
import { db, deckWith, feed, grab, receiveTrack, seedStack, setHandSize, setup, serveWith, FILLER } from "./testkit";
import type { GameState, PlayerId } from "./types";
import cardsJson from "../../data/cards.json";
import effectsJson from "../../data/effects.json";
import { validateEffectDef } from "./dsl-schema";

const REMAINING_IDS = [
  "HV-P01-018", "HV-P01-019", "HV-P01-025", "HV-P01-028", "HV-P01-032", "HV-P01-034", "HV-P01-037",
  "HV-P01-057", "HV-P01-066", "HV-P01-080", "HV-P01-081", "HV-P01-083", "HV-P01-092", "HV-P01-093",
  "HV-P02-001", "HV-P02-002", "HV-P02-004", "HV-P02-005", "HV-P02-006", "HV-P02-007", "HV-P02-010",
  "HV-P02-011", "HV-P02-012", "HV-P02-014", "HV-P02-021", "HV-P02-025", "HV-P02-029", "HV-P02-031",
  "HV-P02-036", "HV-P02-051", "HV-P02-060", "HV-P02-061", "HV-P02-062", "HV-P02-064", "HV-P02-066",
  "HV-P02-070", "HV-P02-071", "HV-P02-073", "HV-P02-074", "HV-P02-076", "HV-P02-078", "HV-P02-079",
  "HV-P02-080", "HV-P02-081", "HV-P02-082", "HV-P02-083", "HV-P02-084", "HV-P02-086", "HV-P02-088",
  "HV-P02-092", "HV-P02-094", "HV-P02-095", "HV-P02-098", "HV-P02-099", "HV-P02-100",
  "HV-PR-009", "HV-PR-012", "HV-PR-013", "HV-PR-014", "HV-PR-015", "HV-PR-016", "HV-PR-017", "HV-PR-018",
  "HV-PR-023", "HV-PR-024", "HV-PR-026", "HV-PR-027", "HV-PR-028", "HV-PR-029", "HV-PR-030", "HV-PR-031",
  "HV-PR-036", "HV-PR-037", "HV-PR-038", "HV-PR-039", "HV-PR-040", "HV-PR-041", "HV-PR-042", "HV-PR-044",
  "HV-PR-045", "HV-PR-046", "HV-PR-047", "HV-PR-048", "HV-PR-049", "HV-PR-050", "HV-PR-051", "HV-PR-052",
  "HVBP-001", "HVBP-002", "HVBP-003", "HVBP-004", "HVBP-009", "HVBP-013", "HVBP-014",
] as const;

describe("剩餘 94 張完成條件", () => {
  it("所有有技能文字的卡都已有 DSL，且不再留下 todo", () => {
    const cards = cardsJson as { id: string; skillJa: string | null; effectStatus: string }[];
    const skilled = cards.filter((card) => card.skillJa?.trim().length);
    expect(cards.filter((card) => card.effectStatus === "todo")).toEqual([]);
    expect(skilled).toHaveLength(192);
    expect(skilled.every((card) => card.effectStatus === "dsl" && card.id in effectsJson)).toBe(true);
  });

  it.each(REMAINING_IDS)("%s：有非空且通過 schema 的效果定義", (id) => {
    const card = (cardsJson as { id: string; effectStatus: string }[]).find((item) => item.id === id);
    const effect = (effectsJson as Record<string, unknown>)[id];
    expect(card?.effectStatus).toBe("dsl");
    expect(effect).toBeTruthy();
    expect(validateEffectDef(effect, id)).toEqual([]);
  });
});

function placeInEventArea(s: GameState, p: PlayerId, cardId: string, exclude: number[] = []): number {
  const uid = grab(s, p, cardId, exclude);
  const ps = s.players[p];
  ps.hand.splice(ps.hand.indexOf(uid), 1);
  ps.eventArea.push(uid);
  return uid;
}

const NAME_CHOICE_CARDS: [string, string[]][] = [
  ["HV-P02-078", ["澤村 大地", "黒尾 鉄朗"]],
  ["HV-PR-009", ["及川 徹", "岩泉 一"]],
  ["HV-PR-012", ["日向 翔陽", "影山 飛雄"]],
  ["HV-PR-013", ["木兎 光太郎", "赤葦 京治"]],
  ["HV-PR-014", ["孤爪 研磨", "黒尾 鉄朗"]],
  ["HV-PR-015", ["及川 徹", "岩泉 一"]],
  ["HV-PR-016", ["月島 蛍", "山口 忠"]],
  ["HV-PR-017", ["金田一 勇太郎", "国見 英"]],
  ["HV-PR-018", ["牛島 若利", "五色 工"]],
  ["HV-PR-036", ["宮 侑", "宮 治"]],
  ["HV-PR-038", ["西谷 夕", "東峰 旭"]],
  ["HV-PR-039", ["青根 高伸", "二口 堅治"]],
  ["HV-PR-040", ["宮 侑", "宮 治"]],
  ["HV-PR-041", ["影山 飛雄", "菅原 孝支"]],
  ["HV-PR-042", ["白布 賢二郎", "瀬見 英太"]],
];

describe("剩餘 94 張 Batch 1：登場改名", () => {
  it.each(NAME_CHOICE_CARDS)("%s：登場前提供兩個名稱，登場後套用選定名", (id, names) => {
    const s = setup(deckWith(id), deckWith(FILLER), 0);
    const uid = grab(s, 0, id);
    expect(deployNames(db, s, uid)).toEqual(names);
    s.players[0].hand.splice(s.players[0].hand.indexOf(uid), 1);
    deployCard(db, s, 0, uid, "serve", { origin: "hand", nameChoice: names[0] });
    expect(nameOf(db, s, uid)).toBe(names[0]);
  });
});

function reachAttack(cardId: string) {
  let s = setup(deckWith(cardId, "HV-D01-008", "HV-D01-009"), deckWith(FILLER), 1);
  s = serveWith(s, FILLER);
  s = receiveTrack(s, "HV-D01-008");
  s = feed(s, { type: "deploy-toss", uid: grab(s, 0, "HV-D01-009") });
  s = feed(s, { type: "free", action: "pass" });
  return s;
}

describe("剩餘 94 張 Batch 1：HVBP 基礎技能", () => {
  it.each(["HVBP-001", "HVBP-002"])("%s：棄 1 手牌後攻擊 +2", (id) => {
    let s = reachAttack(id);
    const uid = grab(s, 0, id);
    s = feed(s, { type: "deploy-attack", uid });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    }
    expect(effParam(db, s, uid, "attack")).toBe(4);
  });

  it.each(["HVBP-003", "HVBP-004"])("%s：支付 2 Guts 後抽 1", (id) => {
    let s = setup(deckWith(id, "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    seedStack(s, 0, "toss", 2);
    const uid = grab(s, 0, id);
    const handBefore = s.players[0].hand.length;
    s = feed(s, { type: "deploy-toss", uid });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].hand.length).toBe(handBefore);
  });

  it("HVBP-009：支付 2 Guts，可選接球 +1", () => {
    let s = setup(deckWith("HVBP-009"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 2);
    const uid = grab(s, 0, "HVBP-009");
    s = feed(s, { type: "deploy-receive", uid });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-option", index: 0 });
    expect(effParam(db, s, uid, "receive")).toBe(4);
  });

  it("HVBP-013：影山托球＋日向攻擊時，下回合攔網最多 2 人", () => {
    let s = setup(deckWith("HVBP-013", "HV-D01-008", "HV-D01-002", "HV-D01-001"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    s = feed(s, { type: "deploy-toss", uid: grab(s, 0, "HV-D01-002") });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const hinata = grab(s, 0, "HV-D01-001");
    s = feed(s, { type: "deploy-attack", uid: hinata });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HVBP-013") });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [hinata] });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "block" });
    expect(blockDeployMax(s, 1)).toBe(2);
  });

  it("HVBP-014：接球 +1，事件離手後手牌 3 張以下則抽 1", () => {
    let s = setup(deckWith("HVBP-014", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const receiver = grab(s, 0, "HV-D01-008");
    s = feed(s, { type: "deploy-receive", uid: receiver });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    const event = grab(s, 0, "HVBP-014");
    setHandSize(s, 0, 3, [event]);
    s = feed(s, { type: "free", action: "event", uid: event });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [receiver] });
    expect(effParam(db, s, receiver, "receive")).toBe(6);
    expect(s.players[0].hand.length).toBe(3);
  });
});

describe("剩餘 94 張 Batch 2A：HV-P01 現有 DSL", () => {
  it("P01-018＋Q216~218：支付 3 Guts，托球 +1；全員音駒時可回收事件", () => {
    let s = setup(deckWith("HV-P01-018", "HV-D02-005", "HVBP-014"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D02-005");
    const event = placeInEventArea(s, 0, "HVBP-014");
    seedStack(s, 0, "toss", 3);
    const uid = grab(s, 0, "HV-P01-018");
    s = feed(s, { type: "deploy-toss", uid });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [event] });
    expect(effParam(db, s, uid, "toss")).toBe(2);
    expect(s.players[0].hand).toContain(event);
  });

  it("P01-019／P01-028＋Q219~223/Q231~232：Guts 灰羽強制登場並觸發被蓋技能", () => {
    let s = setup(deckWith("HV-P01-019", "HV-P01-025", "HV-P01-028", "HV-D02-005", "HV-D02-006"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D02-005");
    seedStack(s, 0, "toss", 2);
    const kenma = grab(s, 0, "HV-P01-019");
    s = feed(s, { type: "deploy-toss", uid: kenma });
    s = feed(s, { type: "free", action: "pass" });
    const lev = grab(s, 0, "HV-P01-025");
    s.players[0].hand.splice(s.players[0].hand.indexOf(lev), 1);
    s.players[0].attack.push(lev); // 攻擊區 Guts
    grab(s, 0, "HV-D02-006"); // 山本技能的音駒棄牌 cost
    const yamamoto = grab(s, 0, "HV-P01-028"); // 原攻擊 P=3
    s = feed(s, { type: "deploy-attack", uid: yamamoto });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.pendingDecision).toMatchObject({ type: "effect-cards", min: 1 });
    s = feed(s, { type: "effect-cards", uids: [lev] });
    // 灰羽自身登場技能與被蓋的山本技能同時待機；先解山本。
    if (s.pendingDecision?.type === "resolve-pending") {
      const item = s.pendingQueue.find((x) => x.source === yamamoto);
      if (item) s = feed(s, { type: "resolve-pending", id: item.id });
    }
    if (s.pendingDecision?.type === "effect-confirm") {
      s = feed(s, { type: "effect-confirm", accept: true });
      if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    }
    expect(s.players[0].attack[s.players[0].attack.length - 1]).toBe(lev);
    expect(effParam(db, s, lev, "attack")).toBe(5); // 2 + 2（研磨）+1（山本）
  });

  it("P01-057＋Q262~265：攔網登場後註冊下回合非抽牌入手監看", () => {
    let s = setup(deckWith("HV-P01-057"), deckWith("HV-D02-005", "HV-D02-001", "HV-D02-006"), 0);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D02-005");
    s = feed(s, { type: "deploy-toss", uid: grab(s, 1, "HV-D02-001") });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-attack", uid: grab(s, 1, "HV-D02-006") });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "block" });
    const uid = grab(s, 0, "HV-P01-057");
    s = feed(s, { type: "deploy-block", uids: [uid], center: uid });
    expect(s.watchers.some((w) => w.source === uid && w.trigger.on === "handAddByEffect")).toBe(true);
  });

  it("P01-080＋Q309：對手事件區 5 張具有托球／攻擊時機時，接球合計 +3", () => {
    let s = setup(deckWith("HV-P01-080", "HV-D02-005"), deckWith("HVBP-013", "HV-P01-081", "HV-P01-083", "HV-D01-012", "HV-P02-088"), 1);
    s = serveWith(s, FILLER);
    for (const id of ["HVBP-013", "HV-P01-081", "HV-P01-083", "HV-D01-012", "HV-P02-088"]) placeInEventArea(s, 1, id);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const receiver = grab(s, 0, "HV-D02-005");
    s = feed(s, { type: "deploy-receive", uid: receiver });
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P01-080") });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [receiver] });
    expect(effParam(db, s, receiver, "receive")).toBe(8);
  });

  it("P01-081：全員音駒，接球區支付 3 Guts 後攻擊合計 +2", () => {
    let s = setup(deckWith("HV-P01-081", "HV-D02-005", "HV-D02-001", "HV-D02-006"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 3);
    s = feed(s, { type: "deploy-receive", uid: grab(s, 0, "HV-D02-005") });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-toss", uid: grab(s, 0, "HV-D02-001") });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const attacker = grab(s, 0, "HV-D02-006");
    s = feed(s, { type: "deploy-attack", uid: attacker });
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P01-081") });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [attacker] });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, attacker, "attack")).toBe(5);
  });

  it("P01-083＋Q312：全員音駒，Court 合計支付 6 Guts 後攻擊 +3", () => {
    let s = setup(deckWith("HV-P01-083", "HV-D02-005", "HV-D02-001", "HV-D02-006"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 3);
    s = feed(s, { type: "deploy-receive", uid: grab(s, 0, "HV-D02-005") });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "toss", 3);
    s = feed(s, { type: "deploy-toss", uid: grab(s, 0, "HV-D02-001") });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const attacker = grab(s, 0, "HV-D02-006");
    s = feed(s, { type: "deploy-attack", uid: attacker });
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P01-083") });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards" && s.pendingDecision.min === 6) {
      s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 6) });
    }
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [attacker] });
    expect(effParam(db, s, attacker, "attack")).toBe(6);
  });
});
