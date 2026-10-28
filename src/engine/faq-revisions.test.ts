// [Codex 2026-10-27] 五筆非純重編FAQ：真正經過引擎決策的回歸情境。
import { describe, expect, it } from "vitest";
import { freeOptions } from "./effects";
import { isSkillInvalid } from "./conditions";
import { effParam, nameOf } from "./effect-helpers";
import { validateEffectDef } from "./dsl-schema";
import { db, deckWith, feed, grab, placeDeckTop, placeInDrop, placeOnStack, seedStack, setup, serveWith, FILLER } from "./testkit";

function aoneReceiveFree() {
  let s = setup(deckWith("HV-P03-063", "HV-P01-054"), deckWith("HV-P01-075", "HV-P03-094"), 0);
  const aone = grab(s, 0, "HV-P03-063");
  placeDeckTop(s, 0, "HV-P01-054");
  s = feed(s, { type: "deploy-serve", uid: aone });
  expect(effParam(db, s, aone, "serve")).toBe(5);
  expect(s.restrictions.some((r) => r.negateEventTimings?.includes("attack"))).toBe(true);
  s = feed(s, { type: "free", action: "pass" });
  s = feed(s, { type: "defense-choice", choice: "receive" });
  s = feed(s, { type: "free", action: "pass" });
  const receiver = grab(s, 1, FILLER);
  s = feed(s, { type: "deploy-receive", uid: receiver });
  const event = grab(s, 1, "HV-P01-075"); // 接球/攻擊雙時機：接球時也受青根限制。
  return { s, receiver, event };
}

describe("修訂FAQ行為回歸", () => {
  it("Q1814：青根無效雙時機事件技能，但事件仍可play；不加點、不抽牌", () => {
    let { s, receiver, event } = aoneReceiveFree();
    const beforeHand = s.players[1].hand.length;
    const beforeDeck = [...s.players[1].deck];
    const beforeReceive = effParam(db, s, receiver, "receive");
    expect(freeOptions(db, s).events.some((option) => option.uid === event)).toBe(true);
    expect(isSkillInvalid(db, s, 1, event)).toBe(true);
    s = feed(s, { type: "free", action: "event", uid: event });
    expect(s.pendingDecision?.type).toBe("free");
    expect(s.players[1].eventArea).toContain(event);
    expect(s.players[1].hand).toHaveLength(beforeHand - 1);
    expect(s.players[1].deck).toEqual(beforeDeck);
    expect(effParam(db, s, receiver, "receive")).toBe(beforeReceive);
  });

  it("Q1814：限制只作用於對手、指定事件時機與下一個回合，跨Set失效", () => {
    const { s, event } = aoneReceiveFree();
    const drawOnly = grab(s, 1, "HV-P03-094");
    expect(isSkillInvalid(db, s, 1, drawOnly)).toBe(false);
    expect(isSkillInvalid(db, s, 0, event)).toBe(false);
    let expired = structuredClone(s);
    expired.turnNo++;
    expect(isSkillInvalid(db, expired, 1, event)).toBe(false);
    const beforeDeck = expired.players[1].deck.length;
    const receiver = expired.players[1].receive.at(-1)!;
    const beforeReceive = effParam(db, expired, receiver, "receive")!;
    expired = feed(expired, { type: "free", action: "event", uid: event });
    if (expired.pendingDecision?.type === "effect-cards") expired = feed(expired, { type: "effect-cards", uids: [receiver] });
    if (expired.pendingDecision?.type === "effect-option") {
      const receiveOption = expired.pendingDecision.options!.findIndex((option) => option.includes("レシーブ") || option.includes("接球"));
      expect(receiveOption).toBeGreaterThanOrEqual(0);
      expired = feed(expired, { type: "effect-option", index: receiveOption });
    }
    expect(effParam(db, expired, receiver, "receive")).toBe(beforeReceive + 1);
    expect(expired.players[1].deck).toHaveLength(beforeDeck - 1);
    const nextSet = structuredClone(s);
    nextSet.setNo++;
    expect(isSkillInvalid(db, nextSet, 1, event)).toBe(false);
  });

  it("Q1814：明確禁止play仍優先；技能無效不會讓非法時機可play", () => {
    const { s, event } = aoneReceiveFree();
    const drawOnly = grab(s, 1, "HV-P03-094");
    expect(freeOptions(db, s).events.some((option) => option.uid === drawOnly)).toBe(false);
    expect(() => feed(s, { type: "free", action: "event", uid: drawOnly })).toThrow(/不可打出/);
    s.restrictions.push({ player: 1, banEventTimings: ["attack"], setNo: s.setNo, activeTurn: s.turnNo, desc: "禁止play對照" });
    expect(freeOptions(db, s).events.some((option) => option.uid === event)).toBe(false);
    expect(() => feed(s, { type: "free", action: "event", uid: event })).toThrow(/不可打出/);
  });

  it("Q1806：田代只能在攻擊階段使用，接球階段不可宣告且不付cost", () => {
    let s = setup(deckWith("HV-P03-056", "HV-P03-053"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-receive", uid: grab(s, 0, FILLER) });
    placeInDrop(s, 0, "HV-P03-053");
    const tashiro = grab(s, 0, "HV-P03-056");
    expect(freeOptions(db, s).skills.some((option) => option.uid === tashiro)).toBe(false);
    expect(() => feed(s, { type: "free", action: "skill", uid: tashiro, skillIndex: 0 })).toThrow();
    expect(s.players[0].hand).toContain(tashiro);
  });

  it("Q1816：山形可回收剛支付的白鳥沢3年Guts，不能選烏野或同名山形", () => {
    let s = setup(deckWith("HV-P03-071", "HV-P03-071", "HV-P01-057"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s.players[0].deck.push(...s.players[0].setArea.splice(0));
    s.players[1].deck.push(...s.players[1].setArea.splice(0, 1)); // Set合計1
    seedStack(s, 0, "receive", 2);
    const tendo = placeOnStack(s, 0, "receive", "HV-P01-057");
    const yama = grab(s, 0, "HV-P03-071");
    const otherYama = grab(s, 0, "HV-P03-071", [yama]);
    s.players[0].hand.splice(s.players[0].hand.indexOf(otherYama), 1);
    s.players[0].drop.push(otherYama);
    const paid = [...s.players[0].receive];
    s = feed(s, { type: "deploy-receive", uid: yama });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards" && s.pendingDecision.candidates?.includes(tendo) && s.pendingDecision.min === 3) {
      s = feed(s, { type: "effect-cards", uids: paid });
    }
    expect(s.pendingDecision?.type).toBe("effect-cards");
    expect(s.pendingDecision?.candidates).toEqual([tendo]);
    s = feed(s, { type: "effect-cards", uids: [tendo] });
    expect(s.players[0].hand).toContain(tendo);
    expect(s.players[0].drop).toContain(otherYama);
    expect(effParam(db, s, yama, "receive")).toBe(7);
  });

  it("Q1837：清水同名ターン1無效仍可play，留在事件區且不抽牌不加點", () => {
    let s = setup(deckWith("HV-P01-075", "HV-P03-094"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const usedShimizu = grab(s, 0, "HV-P03-094");
    const event = placeDeckTop(s, 0, "HV-P01-075");
    s = feed(s, { type: "free", action: "event", uid: usedShimizu });
    expect(s.pendingDecision?.type).toBe("effect-cards");
    s = feed(s, { type: "effect-cards", uids: [event] });
    // [Codex 2026-10-28] 先完成看過卡片的任意置底順序。
    while (s.effectCtx?.awaiting?.kind === "cards" && s.effectCtx.awaiting.purpose === "tutorBottom") {
      s = feed(s, { type: "effect-cards", uids: [s.effectCtx.awaiting.candidates[0]!] });
    }
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [usedShimizu] });
    expect(s.turn1.some((item) => item.name === nameOf(db, s, usedShimizu))).toBe(true);
    expect(s.players[0].hand).toContain(event);
    s = feed(s, { type: "free", action: "pass" });
    const receiver = grab(s, 0, FILLER);
    s = feed(s, { type: "deploy-receive", uid: receiver });
    const deck = [...s.players[0].deck];
    const receive = effParam(db, s, receiver, "receive");
    expect(freeOptions(db, s).events.some((option) => option.uid === event)).toBe(true);
    s = feed(s, { type: "free", action: "event", uid: event });
    expect(s.players[0].eventArea).toContain(event);
    expect(s.players[0].deck).toEqual(deck);
    expect(effParam(db, s, receiver, "receive")).toBe(receive);
    expect(s.pendingDecision?.type).toBe("free");
  });

  it("事件技能無效schema拒絕未知或空時機", () => {
    for (const timings of [["unknown"], [], "attack"]) {
      expect(validateEffectDef({ skills: [{ kind: "event", actions: [{ op: "restrict", restriction: { negateEventTimings: timings }, duration: "thisTurn" }] }] }, "test")).not.toEqual([]);
    }
  });
});
