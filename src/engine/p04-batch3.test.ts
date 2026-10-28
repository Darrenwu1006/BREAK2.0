// 第四彈（HV-P04）Batch 3：最後 4 張特殊機制技能卡（HV-P04-011/043/085/100）行為測試＋官方 Q&A 判例覆蓋＋全卡池 0 todo 完成度契約 [Gemini 2026-10-28]
import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import effectsJson from "../../data/effects.json";
import type { Card } from "../data/types";
import type { EffectDef } from "./dsl";
import { validateEffectDef } from "./dsl-schema";
import { canDeployTo, effParam, freeOptions } from "./engine";
import {
  db,
  deckWith,
  feed,
  FILLER,
  grab,
  placeDeckTop,
  placeOnStack,
  receiveTrack,
  serveWith,
  setup,
} from "./testkit";

const BATCH3_IDS = [
  "HV-P04-011",
  "HV-P04-043",
  "HV-P04-085",
  "HV-P04-100",
] as const;

const cards = cardsJson as Card[];
const effects = effectsJson as Record<string, EffectDef>;

describe("第四彈 Batch 3：4 張特殊機制卡 schema 與全卡池 0 todo 完成度契約", () => {
  it("Batch 3 剛好涵蓋 4 張卡", () => {
    expect(BATCH3_IDS).toHaveLength(4);
  });

  for (const id of BATCH3_IDS) {
    it(`${id}：已寫入 effects.json 並同步至 cards.json (effectStatus=dsl)`, () => {
      const def = effects[id];
      expect(def, `${id} 應存在於 data/effects.json`).toBeDefined();
      expect(validateEffectDef(def, id)).toEqual([]);
      const card = cards.find((c) => c.id === id);
      expect(card, `${id} 應存在於 data/cards.json`).toBeDefined();
      expect(card!.effectStatus).toBe("dsl");
      expect(card!.effect).toEqual(def);
    });
  }

  it("全卡池完成度：cards.json 已無任何 effectStatus='todo' 的卡片（358 張 dsl）", () => {
    const todos = cards.filter((c) => c.effectStatus === "todo");
    expect(todos.map((c) => c.id)).toEqual([]);
    const dsls = cards.filter((c) => c.effectStatus === "dsl");
    expect(dsls.length).toBe(358);
  });
});

describe("第四彈 Batch 3：同時多発位置差攻撃・フェイント条件分岐・双方任意ドロー", () => {
  it("HV-P04-011 菅原 孝支（Q1862/Q1863/Q1864）：手牌登場 Li/WS 雙位置『西谷・東峰』(Q1862) 可觸發；付 3 種不同卡名非菅原烏野 Guts 攻擊+3 (Q1863)；付 2 張同名『日向 翔陽』Guts 攻擊+1 (Q1864)", () => {
    // 1. Q1862 + Q1863：登場 HV-PR-038 西谷・東峰（Li/WS，基礎 attack 2），從場上付「日向 翔陽」「影山 飛雄」「月島 蛍」3 張 Guts（排除同名「菅原 孝支」）→ 攻擊+3
    let s = setup(
      deckWith("HV-P04-011", "HV-D01-009", "HV-PR-038", "HV-D01-001", "HV-D01-002", "HV-D01-003", "HV-D01-008"),
      deckWith(FILLER),
      1,
    );
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const gHina = placeOnStack(s, 0, "toss", "HV-D01-001"); // 日向 翔陽
    const gKage = placeOnStack(s, 0, "toss", "HV-D01-002"); // 影山 飛雄
    const gTsuki = placeOnStack(s, 0, "toss", "HV-D01-003"); // 月島 蛍
    const gSuga = placeOnStack(s, 0, "toss", "HV-D01-009"); // 同名「菅原 孝支」Guts（不可選 Q1863）
    const suga = grab(s, 0, "HV-P04-011");
    s = feed(s, { type: "deploy-toss", uid: suga });
    s = feed(s, { type: "free", action: "pass" });
    const noyaAsahi = grab(s, 0, "HV-PR-038"); // 西谷・東峰（Li/WS，雙卡名）
    s = feed(s, { type: "deploy-attack", uid: noyaAsahi, nameChoice: "東峰 旭" });
    s = feed(s, { type: "effect-confirm", accept: true }); // 同時多発位置差攻撃〈烏野〉(3)
    // 候選不含同名菅原 Guts
    expect(s.pendingDecision?.candidates).not.toContain(gSuga);
    s = feed(s, { type: "effect-cards", uids: [gHina, gKage, gTsuki] }); // 付 3 種不同卡名
    expect(effParam(db, s, noyaAsahi, "attack")).toBe(6); // 3 + 3

    // 2. Q1864：付 2 張同名「日向 翔陽」Guts → 種類數為 1 → 攻擊+1
    let s2 = setup(
      deckWith("HV-P04-011", "HV-P01-001", "HV-D01-001", "HV-D01-001", "HV-D01-008"),
      deckWith(FILLER),
      1,
    );
    s2 = serveWith(s2, FILLER);
    s2 = receiveTrack(s2, "HV-D01-008");
    const h1 = placeOnStack(s2, 0, "toss", "HV-D01-001");
    const h2 = placeOnStack(s2, 0, "toss", "HV-D01-001");
    const suga2 = grab(s2, 0, "HV-P04-011");
    s2 = feed(s2, { type: "deploy-toss", uid: suga2 });
    s2 = feed(s2, { type: "free", action: "pass" });
    const atkHina = grab(s2, 0, "HV-P01-001"); // 基礎 attack 2 (vanilla)
    s2 = feed(s2, { type: "deploy-attack", uid: atkHina });
    s2 = feed(s2, { type: "effect-confirm", accept: true });
    s2 = feed(s2, { type: "effect-cards", uids: [h1, h2] }); // 付 2 張同名日向
    expect(effParam(db, s2, atkHina, "attack")).toBe(3); // 2 + 1
  });

  it("HV-P04-043 東山 勝道（Q1892）：棄牌組頂最多 3 張，事件卡剛好 1 張時フェイント(4)，2 張以上時僅執行フェイント(7)", () => {
    // 1. 棄 2 張事件卡（Q1892：僅執行フェイント(7)，回合結束 OP=7）
    let s = setup(
      deckWith("HV-P04-043", "HV-P04-045", "HV-P04-093", "HV-P04-094", "HV-D01-009"),
      deckWith("HV-D01-003", FILLER),
      1,
    );
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const r = grab(s, 0, "HV-P04-045");
    s = feed(s, { type: "deploy-receive", uid: r });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const t = grab(s, 0, "HV-D01-009");
    s = feed(s, { type: "deploy-toss", uid: t });
    s = feed(s, { type: "free", action: "pass" });
    const ev1 = placeDeckTop(s, 0, "HV-P04-093");
    const ev2 = placeDeckTop(s, 0, "HV-P04-094");
    const higashiyama = grab(s, 0, "HV-P04-043");
    s = feed(s, { type: "deploy-attack", uid: higashiyama });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-option", index: 2 }); // 棄 2 張事件卡
    // 僅註冊 1 個 turnEnd watcher（フェイント(7)）
    const watchers = s.watchers.filter((w) => w.source === higashiyama && w.trigger.on === "turnEnd");
    expect(watchers).toHaveLength(1);
    s = feed(s, { type: "free", action: "pass" }); // 回合結束結算フェイント(7)
    expect(s.op).toEqual({ value: 7, owner: 0, source: "attack" });
    const oppBlocker = grab(s, 1, "HV-D01-003");
    expect(canDeployTo(db, s, 1, oppBlocker, "block")).toBe(false);

    // 2. 棄 1 張事件卡 → フェイント(4)，回合結束 OP=4
    let s2 = setup(
      deckWith("HV-P04-043", "HV-P04-045", "HV-P04-093", "HV-D01-009"),
      deckWith(FILLER),
      1,
    );
    s2 = serveWith(s2, FILLER);
    s2 = feed(s2, { type: "defense-choice", choice: "receive" });
    s2 = feed(s2, { type: "free", action: "pass" });
    const r2 = grab(s2, 0, "HV-P04-045");
    s2 = feed(s2, { type: "deploy-receive", uid: r2 });
    if (s2.pendingDecision?.type === "effect-confirm") s2 = feed(s2, { type: "effect-confirm", accept: false });
    s2 = feed(s2, { type: "free", action: "pass" });
    const t2 = grab(s2, 0, "HV-D01-009");
    s2 = feed(s2, { type: "deploy-toss", uid: t2 });
    s2 = feed(s2, { type: "free", action: "pass" });
    const onlyEv = placeDeckTop(s2, 0, "HV-P04-093");
    const higa2 = grab(s2, 0, "HV-P04-043");
    s2 = feed(s2, { type: "deploy-attack", uid: higa2 });
    s2 = feed(s2, { type: "effect-confirm", accept: true });
    s2 = feed(s2, { type: "effect-option", index: 1 }); // 棄 1 張事件卡
    s2 = feed(s2, { type: "free", action: "pass" });
    expect(s2.op).toEqual({ value: 4, owner: 0, source: "attack" });
  });

  it("HV-P04-085 溝口 貞幸：抽牌或接球階段查看牌組頂 3 張，檢索最多 1 張青葉城西卡入手，其餘置於牌組底", () => {
    let s = setup(deckWith("HV-P04-085", "HV-D04-001"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" }); // 進入抽牌階段自由步驟
    const oikawa = placeDeckTop(s, 0, "HV-D04-001");
    placeDeckTop(s, 0, FILLER); // 供規則抽牌抽走
    const mizoguchi = grab(s, 0, "HV-P04-085");
    s = feed(s, { type: "free", action: "event", uid: mizoguchi });
    s = feed(s, { type: "effect-cards", uids: [oikawa] });
    expect(s.players[0].hand).toContain(oikawa);
  });

  it("HV-P04-100 勝てよ…! 俺達の分も!!!（Q1947/Q1948/Q1949/Q1950）：雙方各自決定是否抽 2 張（Q1948/Q1949），結算後自己在該抽牌階段無法再將卡加入手牌（Q1947），牌組 1 張以下仍可發動（Q1950）", () => {
    let s = setup(deckWith("HV-P04-100", "HV-P04-085", "HV-D04-001"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const katte = grab(s, 0, "HV-P04-100");
    const mizoguchi = grab(s, 0, "HV-P04-085");
    const p0HandBefore = s.players[0].hand.length - 1; // 扣掉打出的 katte
    const p1HandBefore = s.players[1].hand.length;
    s = feed(s, { type: "free", action: "event", uid: katte });
    // 1. 先由自己（player 0）決定是否抽 2 張（Q1948/Q1949）
    expect(s.pendingDecision?.type).toBe("effect-confirm");
    expect(s.pendingDecision?.player).toBe(0);
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].hand.length).toBe(p0HandBefore + 2);
    // 2. 再由對手（player 1）自己決定是否抽 2 張（Q1948/Q1949）
    expect(s.pendingDecision?.type).toBe("effect-confirm");
    expect(s.pendingDecision?.player).toBe(1);
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[1].hand.length).toBe(p1HandBefore + 2);
    // 3. Q1947：本抽牌階段中，自己無法再將卡加入手牌（打出 P04-085 檢索也不會出現候選）
    placeDeckTop(s, 0, "HV-D04-001");
    const handAfterKatte = s.players[0].hand.length - 1; // 扣掉 mizoguchi
    s = feed(s, { type: "free", action: "event", uid: mizoguchi });
    expect(s.players[0].hand.length).toBe(handAfterKatte); // 因 banDrawPhaseHandAdd 無法加入手牌
    // 4. Q1950：任一方牌組 <= 1 張時仍可 play
    let s2 = setup(deckWith("HV-P04-100"), deckWith(FILLER), 1);
    s2 = serveWith(s2, FILLER);
    s2 = feed(s2, { type: "defense-choice", choice: "receive" });
    const katte2 = grab(s2, 0, "HV-P04-100");
    s2.players[0].deck = s2.players[0].deck.slice(0, 1);
    expect(freeOptions(db, s2).events.some((e) => e.uid === katte2)).toBe(true);
  });
});
