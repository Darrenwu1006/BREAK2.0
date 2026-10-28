// 第四彈（HV-P04 / HV-D04 / HV-PR）Batch 1：既有 DSL 可直接表達的 44 張卡逐張行為測試＋官方判例（Q1844～Q1961）
import { describe, expect, it } from "vitest";
import { effParam, freeOptions } from "./engine";
import { deployCard } from "./effects";
import { deployNames, nameOf } from "./effect-helpers";
import { db, deckWith, drainCp, feed, grab, placeDeckTop, placeInDrop, placeOnStack, receiveTrack, seedStack, serveWith, setHandSize, setup, FILLER } from "./testkit";
import type { GameState, PlayerId } from "./types";
import cardsJson from "../../data/cards.json";
import effectsJson from "../../data/effects.json";
import { validateEffectDef } from "./dsl-schema";

const BATCH_1_IDS = [
  "HV-D04-005", "HV-D04-008", "HV-P04-006", "HV-P04-009", "HV-P04-013", "HV-P04-014",
  "HV-P04-018", "HV-P04-021", "HV-P04-023", "HV-P04-025", "HV-P04-028", "HV-P04-030",
  "HV-P04-034", "HV-P04-038", "HV-P04-041", "HV-P04-046", "HV-P04-049", "HV-P04-050",
  "HV-P04-051", "HV-P04-053", "HV-P04-054", "HV-P04-056", "HV-P04-060", "HV-P04-061",
  "HV-P04-065", "HV-P04-066", "HV-P04-067", "HV-P04-070", "HV-P04-072", "HV-P04-077",
  "HV-P04-079", "HV-P04-086", "HV-P04-089", "HV-P04-091", "HV-P04-092", "HV-P04-098",
  "HV-P04-101", "HV-PR-067", "HV-PR-068", "HV-PR-069", "HV-PR-070", "HV-PR-082",
  "HV-PR-083", "HV-PR-084",
] as const;

function placeInEventArea(s: GameState, p: PlayerId, cardId: string, exclude: number[] = []): number {
  const uid = grab(s, p, cardId, exclude);
  const ps = s.players[p];
  ps.hand.splice(ps.hand.indexOf(uid), 1);
  ps.eventArea.push(uid);
  return uid;
}

describe("第四彈 Batch 1：44 張 schema 與同步契約", () => {
  it.each(BATCH_1_IDS)("%s：已寫入 effects.json 並同步至 cards.json (effectStatus=dsl)", (id) => {
    const card = (cardsJson as { id: string; effectStatus: string }[]).find((c) => c.id === id);
    const effect = (effectsJson as Record<string, unknown>)[id];
    expect(card?.effectStatus).toBe("dsl");
    expect(effect).toBeTruthy();
    expect(validateEffectDef(effect, id)).toEqual([]);
  });
});

describe("第四彈 Batch 1：登場改名 Promo（HV-PR-067～070）", () => {
  const NAME_CHOICE_P04: [string, string[]][] = [
    ["HV-PR-067", ["田中 龍之介", "澤村 大地"]],
    ["HV-PR-068", ["宮 治", "角名 倫太郎"]],
    ["HV-PR-069", ["及川 徹", "金田一 勇太郎"]],
    ["HV-PR-070", ["青根 高伸", "二口 堅治"]],
  ];

  it.each(NAME_CHOICE_P04)("%s：登場時可選兩個卡名之一，選定後至回合結束有效", (id, names) => {
    const s = setup(deckWith(id), deckWith(FILLER), 0);
    const uid = grab(s, 0, id);
    expect(deployNames(db, s, uid)).toEqual(names);
    s.players[0].hand.splice(s.players[0].hand.indexOf(uid), 1);
    deployCard(db, s, 0, uid, "receive", { origin: "hand", nameChoice: names[1] });
    expect(nameOf(db, s, uid)).toBe(names[1]);
  });
});

describe("第四彈 Batch 1：烏野・疑似ユース・町内会", () => {
  it("HV-P04-006 田中 龍之介：對手場上有 2 年級角色時付 2 Guts → 攻擊+3", () => {
    let s = setup(deckWith("HV-P04-006", "HV-D01-008", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // FILLER = D01-006 田中（2年）在對手發球區
    s = receiveTrack(s, "HV-D01-008");
    const toss = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 2);
    const tanaka = grab(s, 0, "HV-P04-006");
    s = feed(s, { type: "deploy-attack", uid: tanaka });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, tanaka, "attack")).toBe(5); // 2+3
  });

  it("HV-P04-009 澤村 大地（Q1859/Q1860/Q1861）：棄手牌 2 張烏野 → 抽1＋接球+2；棄牌後烏野角色滿 8 種再+1 並 Aパス(1)", () => {
    const eightKarasuno = [
      "HV-D01-001", "HV-D01-002", "HV-D01-003", "HV-D01-004",
      "HV-D01-005", "HV-D01-006", "HV-D01-007", "HV-D01-009",
    ];
    let s = setup(deckWith("HV-P04-009", ...eightKarasuno, "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    // 先放 6 種到棄牌區，另外 2 種留在手牌當 cost（Q1861：棄牌後才檢查 8 種）
    for (const id of eightKarasuno.slice(0, 6)) placeInDrop(s, 0, id);
    const cost1 = grab(s, 0, eightKarasuno[6]!);
    const cost2 = grab(s, 0, eightKarasuno[7]!);
    const daichi = grab(s, 0, "HV-P04-009");
    setHandSize(s, 0, 3, [cost1, cost2, daichi]);
    s = feed(s, { type: "deploy-receive", uid: daichi });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [cost1, cost2] });
    }
    expect(effParam(db, s, daichi, "receive")).toBe(7); // 4+2+1
    s = feed(s, { type: "free", action: "pass" }); // 進入托球階段
    const kageyama = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    s = drainCp(s, true);
    expect(effParam(db, s, kageyama, "toss")).toBe(2); // 1 + Aパス(1)
  });

  it("HV-P04-013 東峰 旭（Q1865/Q1866/Q1867/Q1868）：棄 1 張烏野 → 攻擊+2；棄牌區 8 種烏野角色時下回合對手中央攔網手技能無效", () => {
    const eightKarasuno = [
      "HV-D01-001", "HV-D01-002", "HV-D01-003", "HV-D01-004",
      "HV-D01-005", "HV-D01-006", "HV-D01-007", "HV-D01-008",
    ];
    let s = setup(deckWith("HV-P04-013", ...eightKarasuno, "HV-D01-008", "HV-D01-009"), deckWith("HV-P03-036", FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    for (const id of eightKarasuno.slice(0, 7)) placeInDrop(s, 0, id);
    const costUid = grab(s, 0, eightKarasuno[7]!);
    const suga = grab(s, 0, "HV-D01-009");
    s = feed(s, { type: "deploy-toss", uid: suga });
    s = feed(s, { type: "free", action: "pass" });
    const asahi = grab(s, 0, "HV-P04-013");
    setHandSize(s, 0, 2, [asahi, costUid]);
    s = feed(s, { type: "deploy-attack", uid: asahi });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, asahi, "attack")).toBe(4); // 2+2
    s = feed(s, { type: "free", action: "pass" }); // OP = 1 + 4 = 5
    s = feed(s, { type: "defense-choice", choice: "block" });
    const lev = grab(s, 1, "HV-P03-036"); // ワンタッチ(2) 攔網手
    s = feed(s, { type: "deploy-block", uids: [lev], center: lev });
    // Q1868：中央攔網手技能無效，不跳出ワンタッチ confirm，直接進自由步驟
    expect(s.pendingDecision?.type).toBe("free");
    expect(s.op?.value).toBe(6);
  });

  it("HV-P04-014 道宮 結：棄 1 張烏野 → 從接球區 Guts 登場澤村 大地並接球+1", () => {
    let s = setup(deckWith("HV-P04-014", "HV-D01-008", "HV-D01-006"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const daichiGuts = placeOnStack(s, 0, "receive", "HV-D01-008"); // base receive 4 (+1 own deploy skill)
    const costCard = grab(s, 0, "HV-D01-006");
    const michimiya = grab(s, 0, "HV-P04-014");
    setHandSize(s, 0, 2, [michimiya, costCard]);
    s = feed(s, { type: "deploy-receive", uid: michimiya });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [daichiGuts] });
    }
    expect(s.players[0].receive[s.players[0].receive.length - 1]).toBe(daichiGuts);
    expect(effParam(db, s, daichiGuts, "receive")).toBe(6); // 4 + 1 (道宮) + 1 (D01-008 自身登場技能)
  });

  it("HV-P04-072 日向 翔陽（Q1911/Q1912）：接球階段從手牌棄自身 → 疑似ユース接球+2，並將棄牌區日向以外的疑似ユース角色置底", () => {
    let s = setup(deckWith("HV-P04-072", "HV-P03-003", "HV-P03-007", "HV-P03-001"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const kunimi = grab(s, 0, "HV-P03-007"); // 疑似ユース r5
    s = feed(s, { type: "deploy-receive", uid: kunimi });
    const tsukkiDrop = placeInDrop(s, 0, "HV-P03-003"); // 月島（疑似ユースキャラ）
    const hinataDrop = placeInDrop(s, 0, "HV-P03-001"); // 日向（同名應排除）
    const hinataHand = grab(s, 0, "HV-P04-072");
    s = feed(s, { type: "free", action: "skill", uid: hinataHand, skillIndex: 0 });
    expect(effParam(db, s, kunimi, "receive")).toBe(7); // 5+2
    expect(s.pendingDecision?.type).toBe("effect-cards");
    expect(s.pendingDecision!.candidates).toContain(tsukkiDrop);
    expect(s.pendingDecision!.candidates).not.toContain(hinataDrop);
    s = feed(s, { type: "effect-cards", uids: [tsukkiDrop] });
    expect(s.players[0].deck[s.players[0].deck.length - 1]).toBe(tsukkiDrop);
  });

  it("HV-P04-079 滝ノ上 祐輔（Q1918）＆ HV-P04-101 おっさんも本気出しちゃうんだぜ（Q1951/Q1952）：町内会全體條件與事件區 4 張同名加值", () => {
    let s = setup(
      deckWith("HV-P04-079", "HV-P04-101", "HV-P04-101", "HV-P04-101", "HV-P04-101"),
      deckWith(FILLER),
      1,
    );
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const e1 = placeInEventArea(s, 0, "HV-P04-101");
    const e2 = placeInEventArea(s, 0, "HV-P04-101", [e1]);
    const e3 = placeInEventArea(s, 0, "HV-P04-101", [e1, e2]);
    const evPlay = grab(s, 0, "HV-P04-101", [e1, e2, e3]);
    seedStack(s, 0, "receive", 3);
    const takinoue = grab(s, 0, "HV-P04-079");
    s = feed(s, { type: "deploy-receive", uid: takinoue });
    // 打出第 4 張 おっさんも本気出しちゃうんだぜ（Q1952：計入自身共 4 張）
    s = feed(s, { type: "effect-confirm", accept: true }); // 先解決滝ノ上登場 gate（此時事件區 3 張 → +3）
    if (s.pendingDecision?.type === "effect-option") {
      s = feed(s, { type: "effect-option", index: 0 }); // Q1918：可選 serve 等非當前區參數
    }
    expect(effParam(db, s, takinoue, "serve")).toBe(4); // 1+3
    s = feed(s, { type: "free", action: "event", uid: evPlay });
    expect(effParam(db, s, takinoue, "receive")).toBe(4); // 3+1
    expect(effParam(db, s, takinoue, "attack")).toBe(3); // 2+1（事件區含自身滿 4 張）
  });
});

describe("第四彈 Batch 1：青葉城西（D04 / P04）", () => {
  it("HV-D04-005 金田一 勇太郎（Q1844/Q1845）：對手 OP≤2 時登場 → ドシャット(6)", () => {
    let s = setup(deckWith("HV-D04-005"), deckWith(FILLER), 0);
    s.phase = "block";
    s.sub = 0;
    s.turnPlayer = 0;
    s.op = { value: 2, owner: 1, source: "attack" };
    s.pendingDecision = { type: "deploy-block", player: 0 };
    const kindaichi = grab(s, 0, "HV-D04-005");
    s = feed(s, { type: "deploy-block", uids: [kindaichi], center: kindaichi });
    expect(s.watchers.some((w) => w.trigger.on === "turnEnd")).toBe(true);
  });

  it("HV-D04-008 渡 親治 ＆ HV-P04-025 花巻 貴大（Q1881）：Guts 支付抽牌/加值與全員青城 Aパス(1)", () => {
    let s = setup(deckWith("HV-D04-008", "HV-P04-025", "HV-P04-028"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 4);
    const watari = grab(s, 0, "HV-D04-008");
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "deploy-receive", uid: watari });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, watari, "receive")).toBe(7); // 5+2
    expect(s.players[0].hand.length).toBe(h0); // deploy -1 + draw 1

    // 測 P04-025 花巻（全員青城 → 3 Guts → receive+3 & Aパス(1)）
    let t = setup(deckWith("HV-P04-025", "HV-P04-028"), deckWith(FILLER), 1);
    t = serveWith(t, FILLER);
    t = feed(t, { type: "defense-choice", choice: "receive" });
    t = feed(t, { type: "free", action: "pass" });
    seedStack(t, 0, "receive", 3);
    const hanamaki = grab(t, 0, "HV-P04-025");
    t = feed(t, { type: "deploy-receive", uid: hanamaki });
    t = feed(t, { type: "effect-confirm", accept: true });
    expect(effParam(db, t, hanamaki, "receive")).toBe(7); // 4+3
  });

  it("HV-P04-018 及川 徹：發球付 2 Guts → 發球+1，對手手牌≥4 時強制棄 1 張", () => {
    let s = setup(deckWith("HV-P04-018"), deckWith(FILLER), 0);
    seedStack(s, 0, "serve", 2);
    setHandSize(s, 1, 4);
    const oikawa = grab(s, 0, "HV-P04-018");
    s = feed(s, { type: "deploy-serve", uid: oikawa });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    }
    expect(effParam(db, s, oikawa, "serve")).toBe(6); // 5+1
    expect(s.players[1].hand.length).toBe(3);
  });

  it("HV-P04-021 岩泉 一（Q1877）、HV-P04-028 矢巾 秀、HV-P04-030 京谷 賢太郎：托球連動與疊放不被降點", () => {
    let s = setup(deckWith("HV-P04-021", "HV-P04-028", "HV-P04-030", "HV-D04-008", "HV-P04-025"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D04-008");
    seedStack(s, 0, "toss", 2);
    const yahaba = grab(s, 0, "HV-P04-028");
    s = feed(s, { type: "deploy-toss", uid: yahaba });
    s = feed(s, { type: "free", action: "pass" });
    // 先鋪 1 張 Guts，再把 P04-021 岩泉放在攻擊區頂（共 2 張供京谷疊上後支付 2 Guts）
    seedStack(s, 0, "attack", 1);
    placeOnStack(s, 0, "attack", "HV-P04-021");
    const costAoba = grab(s, 0, "HV-P04-025");
    const kyotani = grab(s, 0, "HV-P04-030");
    setHandSize(s, 0, 2, [kyotani, costAoba]);
    s = feed(s, { type: "deploy-attack", uid: kyotani });
    s = drainCp(s, true);
    expect(effParam(db, s, kyotani, "attack")).toBe(5); // 1+4
    expect(effParam(db, s, yahaba, "toss")).toBe(3); // 1+2
    // P04-021 被蓋觸發：京谷獲得 noDecrease 守衛
    s.modifiers.push({ target: kyotani, param: "attack", amount: -3, source: kyotani });
    expect(effParam(db, s, kyotani, "attack")).toBe(5);
  });

  it("HV-P04-023 松川 一静（Q1880）、HV-P04-086、HV-P04-089：放置事件 cost、抽牌回收京谷、3 年級棄牌加值", () => {
    let s = setup(deckWith("HV-P04-023", "HV-P04-086", "HV-P04-089", "HV-P04-025", "HV-P04-030", "HV-P04-018"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    // Draw phase: play P04-086
    const kyotaniDrop = placeInDrop(s, 0, "HV-P04-030");
    const ev86 = grab(s, 0, "HV-P04-086");
    setHandSize(s, 0, 3, [ev86]);
    s = feed(s, { type: "free", action: "event", uid: ev86 });
    s = feed(s, { type: "effect-confirm", accept: true }); // 抽 1 張（手牌變 3 張 ≤ 4）
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [kyotaniDrop] });
    }
    expect(s.players[0].hand).toContain(kyotaniDrop);
    s = feed(s, { type: "free", action: "pass" });

    // Receive phase: deploy Hanamaki (3年) then play P04-089
    const hanamaki = grab(s, 0, "HV-P04-025");
    const oikawaCost = grab(s, 0, "HV-P04-018");
    const ev89 = grab(s, 0, "HV-P04-089");
    setHandSize(s, 0, 3, [hanamaki, oikawaCost, ev89]);
    s = feed(s, { type: "deploy-receive", uid: hanamaki });
    s = drainCp(s, false);
    s = feed(s, { type: "free", action: "event", uid: ev89 });
    s = feed(s, { type: "effect-confirm", accept: true }); // 棄青城 3 年級角色卡
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [oikawaCost] });
    }
    expect(effParam(db, s, hanamaki, "receive")).toBe(7); // 4+1+2

    // P04-023 松川（Q1880：從手牌放青城事件到事件區 → 抽1＋攔網+3，被放的事件不發動技能）
    let b = setup(deckWith("HV-P04-023", "HV-P04-086"), deckWith(FILLER), 0);
    b.phase = "block";
    b.sub = 0;
    b.turnPlayer = 0;
    b.op = { value: 4, owner: 1, source: "attack" };
    b.pendingDecision = { type: "deploy-block", player: 0 };
    const evCost = grab(b, 0, "HV-P04-086");
    const matsukawa = grab(b, 0, "HV-P04-023");
    setHandSize(b, 0, 2, [matsukawa, evCost]);
    b = feed(b, { type: "deploy-block", uids: [matsukawa], center: matsukawa });
    b = feed(b, { type: "effect-confirm", accept: true });
    expect(effParam(db, b, matsukawa, "block")).toBe(5); // 2+3
    expect(b.players[0].eventArea).toContain(evCost);
  });
});

describe("第四彈 Batch 1：角川・条善寺・和久谷南", () => {
  it("HV-P04-034 古牧 譲（Q1886/Q1887/Q1888）、HV-P04-038 温川 良明（Q1889）、HV-P04-091、HV-P04-092：百沢連動", () => {
    let s = setup(deckWith("HV-P04-034", "HV-P04-038", "HV-P04-033", "HV-P04-091", "HV-P04-092"), deckWith(FILLER), 0);
    s.phase = "block";
    s.sub = 0;
    s.turnPlayer = 0;
    s.op = { value: 5, owner: 1, source: "attack" };
    s.pendingDecision = { type: "deploy-block", player: 0 };
    // 先在接球區放温川（2 Guts），托球區放古牧（2 Guts）
    seedStack(s, 0, "receive", 2);
    const nurukawa = placeOnStack(s, 0, "receive", "HV-P04-038");
    seedStack(s, 0, "toss", 2);
    const komaki = placeOnStack(s, 0, "toss", "HV-P04-034");
    const hyakuzawa = grab(s, 0, "HV-P04-033"); // 百沢 block 3
    s = feed(s, { type: "deploy-block", uids: [hyakuzawa], center: hyakuzawa });
    // 解決古牧與温川的 allyDeploy
    for (let i = 0; i < 20 && s.pendingDecision && s.pendingDecision.type !== "free"; i++) {
      if (s.pendingDecision.type === "resolve-pending") {
        s = feed(s, { type: "resolve-pending", id: s.pendingDecision.candidates![0]! });
      } else if (s.pendingDecision.type === "effect-confirm") {
        s = feed(s, { type: "effect-confirm", accept: true });
      } else if (s.pendingDecision.type === "effect-option") {
        s = feed(s, { type: "effect-option", index: 1 }); // block +2
      } else if (s.pendingDecision.type === "effect-cards") {
        s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
      } else {
        break;
      }
    }
    expect(s.players[0].blockSides).toContain(nurukawa); // 温川移動為側邊攔網手
    expect(effParam(db, s, hyakuzawa, "block")).toBe(7); // 3 + 古牧2 + 温川2
    expect(s.players[0].toss).toEqual([komaki]); // Q1888：古牧從托球區付 2 Guts
    expect(s.players[0].receive).toEqual([]); // Q1889：温川從接球區付 2 Guts 並移往攔網區

    // 打出 P04-092 なんつーか… 単純っスね
    const ev92 = grab(s, 0, "HV-P04-092");
    s = feed(s, { type: "free", action: "event", uid: ev92 });
    if (s.pendingDecision?.type === "effect-option") {
      s = feed(s, { type: "effect-option", index: 1 }); // block +1
    }
    expect(effParam(db, s, hyakuzawa, "block")).toBe(8);
  });

  it("HV-P04-091 それが俺達の「勝つスタイル」です：角川 2 年級接球+1，攻擊角色為百沢時抽 1 再+1", () => {
    let s = setup(deckWith("HV-P04-091", "HV-P04-038", "HV-P04-033"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    placeOnStack(s, 0, "attack", "HV-P04-033"); // 百沢在攻擊區
    const nurukawa = grab(s, 0, "HV-P04-038"); // 角川 2年 r4
    s = feed(s, { type: "deploy-receive", uid: nurukawa });
    const ev91 = grab(s, 0, "HV-P04-091");
    s = feed(s, { type: "free", action: "event", uid: ev91 });
    expect(effParam(db, s, nurukawa, "receive")).toBe(6); // 4+1+1
  });

  it("HV-P04-041 母畑 和馬 ＆ HV-P04-051 鳴子 哲平：OP≥4 ワンタッチ(2) 與牌組頂棄和久谷南 ワンタッチ(3)", () => {
    let s = setup(deckWith("HV-P04-041"), deckWith(FILLER), 0);
    s.phase = "block";
    s.sub = 0;
    s.turnPlayer = 0;
    s.op = { value: 4, owner: 1, source: "attack" };
    s.pendingDecision = { type: "deploy-block", player: 0 };
    const bobata = grab(s, 0, "HV-P04-041");
    s = feed(s, { type: "deploy-block", uids: [bobata], center: bobata });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.op?.value).toBe(2);
    expect(s.phase).toBe("draw");

    let t = setup(deckWith("HV-P04-051", "HV-P04-049"), deckWith(FILLER), 0);
    t.phase = "block";
    t.sub = 0;
    t.turnPlayer = 0;
    t.op = { value: 5, owner: 1, source: "attack" };
    t.pendingDecision = { type: "deploy-block", player: 0 };
    placeDeckTop(t, 0, "HV-P04-049"); // 牌組頂和久谷南
    const naruko = grab(t, 0, "HV-P04-051");
    t = feed(t, { type: "deploy-block", uids: [naruko], center: naruko });
    t = feed(t, { type: "effect-confirm", accept: true });
    expect(t.op?.value).toBe(2); // 5 - 3
    expect(t.phase).toBe("draw");
  });

  it("HV-P04-046 中島 猛（Q1893）、HV-P04-049 白石 優希、HV-P04-050 花山 一雅（Q1896）、HV-P04-098（Q1945）：和久谷南連動", () => {
    let s = setup(deckWith("HV-P04-046", "HV-P04-049", "HV-P04-050", "HV-P04-051", "HV-P04-097", "HV-P04-098"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 3);
    const shiraishi = grab(s, 0, "HV-P04-049");
    s = feed(s, { type: "deploy-receive", uid: shiraishi });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, shiraishi, "receive")).toBe(7); // 5+2

    // 打出 P04-098 選②將接球點數設為 6
    const ev98 = grab(s, 0, "HV-P04-098");
    s = feed(s, { type: "free", action: "event", uid: ev98 });
    s = feed(s, { type: "effect-option", index: 1 });
    expect(effParam(db, s, shiraishi, "receive")).toBe(6);
    s = feed(s, { type: "free", action: "pass" });

    // Toss phase: 花山 3 Guts（其中含和久谷南角色 → Q1896 可直接回收剛支付的 Guts）
    const wakuGuts = placeOnStack(s, 0, "toss", "HV-P04-051");
    seedStack(s, 0, "toss", 2);
    const hanayama = grab(s, 0, "HV-P04-050");
    s = feed(s, { type: "deploy-toss", uid: hanayama });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") {
      expect(s.pendingDecision.candidates).toContain(wakuGuts); // Q1896
      s = feed(s, { type: "effect-cards", uids: [wakuGuts] });
    }
    expect(effParam(db, s, hanayama, "toss")).toBe(2); // 1+1
    expect(s.players[0].hand).toContain(wakuGuts);
    s = feed(s, { type: "free", action: "pass" });

    // Attack phase: 中島 3 Guts（全員和久谷南 → 攻擊+1、ブロックアウト(2)、抽1、回收事件區 P04-097）
    const ev97 = placeInEventArea(s, 0, "HV-P04-097");
    seedStack(s, 0, "attack", 3);
    const nakashima = grab(s, 0, "HV-P04-046");
    s = feed(s, { type: "deploy-attack", uid: nakashima });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [ev97] });
    }
    expect(effParam(db, s, nakashima, "attack")).toBe(3); // 2+1
    expect(s.players[0].hand).toContain(ev97);
  });
});

describe("第四彈 Batch 1：音駒・伊達工業・白鳥沢・梟谷・稲荷崎・ユース", () => {
  it("HV-P04-054 夜久 衛輔（Q1897）、HV-P04-056 海 信行、HV-P04-053 黒尾 鉄朗：音駒接托攻三連", () => {
    let s = setup(deckWith("HV-P04-054", "HV-P04-056", "HV-P04-053"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // 對手發球 OP = 1 ≤ 3
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const yaku = grab(s, 0, "HV-P04-054");
    s = feed(s, { type: "deploy-receive", uid: yaku });
    expect(s.watchers.some((w) => w.trigger.on === "deploy")).toBe(true); // Aパス(1)
    s = feed(s, { type: "free", action: "pass" });

    // Q1897 反例：若對手 OP 來源為 block，夜久不發動 Aパス
    let b = setup(deckWith("HV-P04-054"), deckWith(FILLER), 0);
    b.phase = "receive";
    b.sub = 0;
    b.turnPlayer = 0;
    b.op = { value: 2, owner: 1, source: "block" };
    b.pendingDecision = { type: "deploy-receive", player: 0 };
    const yakuBlock = grab(b, 0, "HV-P04-054");
    b = feed(b, { type: "deploy-receive", uid: yakuBlock });
    expect(b.watchers.length).toBe(0);

    // 回到 s：登場海 信行（受夜久 Aパス +1 → toss=2），再登場黒尾觸發海與黒尾自身
    seedStack(s, 0, "toss", 2);
    const kai = grab(s, 0, "HV-P04-056");
    s = feed(s, { type: "deploy-toss", uid: kai });
    s = drainCp(s, true);
    expect(effParam(db, s, kai, "toss")).toBe(2); // 1 + Aパス(1)
    s = feed(s, { type: "free", action: "pass" });

    seedStack(s, 0, "attack", 2);
    const kuroo = grab(s, 0, "HV-P04-053");
    s = feed(s, { type: "deploy-attack", uid: kuroo });
    for (let i = 0; i < 20 && s.pendingDecision && s.pendingDecision.type !== "free"; i++) {
      if (s.pendingDecision.type === "resolve-pending") {
        s = feed(s, { type: "resolve-pending", id: s.pendingDecision.candidates![0]! });
      } else if (s.pendingDecision.type === "effect-confirm") {
        s = feed(s, { type: "effect-confirm", accept: true });
      } else if (s.pendingDecision.type === "effect-cards") {
        s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
      } else {
        break;
      }
    }
    expect(effParam(db, s, kai, "toss")).toBe(3); // 2+1
    expect(effParam(db, s, kuroo, "attack")).toBe(5); // 2+3（接球夜久＋托球海）
  });

  it("HV-PR-082 山本 猛虎（Q1958/Q1959/Q1960）＆ HV-PR-084：手牌バックアタック(5) 與技能登場山本額外+1", () => {
    let s = setup(deckWith("HV-PR-082", "HV-PR-084", "HV-D02-007", "HV-D02-001", "HV-D02-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D02-008");
    const kenma = grab(s, 0, "HV-D02-001");
    s = feed(s, { type: "deploy-toss", uid: kenma });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 3); // 攻擊區 3 Guts 供 PR-082 支付
    const baseA3 = grab(s, 0, "HV-D02-007"); // 福永 招平（音駒 vanilla base attack 3）
    s = feed(s, { type: "deploy-attack", uid: baseA3 });
    const pr82 = grab(s, 0, "HV-PR-082");
    const pr84 = grab(s, 0, "HV-PR-084");
    expect(freeOptions(db, s).skills.some((sk) => sk.uid === pr82)).toBe(true);
    s = feed(s, { type: "free", action: "skill", uid: pr82, skillIndex: 0 });
    expect(s.players[0].attack[s.players[0].attack.length - 1]).toBe(pr82);
    expect(effParam(db, s, pr82, "attack")).toBe(5); // Q1958：バックアタック(5)

    // 打出 PR-084：山本剛剛由技能（バックアタック）登場 → +1 再 +1 = 7
    s = feed(s, { type: "free", action: "event", uid: pr84 });
    expect(effParam(db, s, pr82, "attack")).toBe(7);
  });

  it("HV-PR-083 青根 高伸（Q1961）：從手牌將伊達工業事件放入事件區 → 攔網+3 並於攔網成功時 ドシャット(6)", () => {
    let s = setup(deckWith("HV-PR-083", "HV-P03-097"), deckWith(FILLER), 0);
    s.phase = "block";
    s.sub = 0;
    s.turnPlayer = 0;
    s.op = { value: 4, owner: 1, source: "attack" };
    s.pendingDecision = { type: "deploy-block", player: 0 };
    const dateEv = grab(s, 0, "HV-P03-097");
    const aone = grab(s, 0, "HV-PR-083");
    setHandSize(s, 0, 2, [aone, dateEv]);
    s = feed(s, { type: "deploy-block", uids: [aone], center: aone });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, aone, "block")).toBe(5); // 2+3
    expect(s.watchers.some((w) => w.trigger.on === "blockSuccess")).toBe(true);
  });

  it("HV-P04-060 牛島 若利 ＆ HV-P04-061 天童 覚：白鳥沢棄牌＋2 Guts 連動", () => {
    let s = setup(deckWith("HV-P04-060", "HV-P04-061", "HV-P02-052", "HV-P03-071", "HV-P03-067"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-P02-052"); // 大平 獅音
    const drop3rd = placeInDrop(s, 0, "HV-P03-071"); // 白鳥沢 3年
    seedStack(s, 0, "toss", 2);
    const cost1 = grab(s, 0, "HV-P03-067");
    const tendo = grab(s, 0, "HV-P04-061");
    setHandSize(s, 0, 2, [tendo, cost1]); // 只留天童與 1 張 cost1，讓棄牌 cost 自動選 cost1
    s = feed(s, { type: "deploy-toss", uid: tendo });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [drop3rd] });
    }
    expect(effParam(db, s, tendo, "toss")).toBe(2); // 1+1
    expect(s.players[0].hand).toContain(drop3rd);
    s = feed(s, { type: "free", action: "pass" });

    const ushijima = grab(s, 0, "HV-P04-060");
    setHandSize(s, 0, 2, [ushijima, drop3rd]);
    seedStack(s, 0, "attack", 2);
    s = feed(s, { type: "deploy-attack", uid: ushijima });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, ushijima, "attack")).toBe(6); // 2+2+2（大平＋天童在場）
  });

  it("HV-P04-065 猿杙 大和、HV-P04-066 小見 春樹、HV-P04-067 鷲尾 辰生：梟谷 3 年級系列", () => {
    // 鷲尾發球：棄梟谷3年＋1 Guts → 抽2＋發球+3
    let s = setup(deckWith("HV-P04-067", "HV-P04-065"), deckWith(FILLER), 0);
    seedStack(s, 0, "serve", 1);
    const costFukuro = grab(s, 0, "HV-P04-065");
    const washio = grab(s, 0, "HV-P04-067");
    setHandSize(s, 0, 2, [washio, costFukuro]);
    s = feed(s, { type: "deploy-serve", uid: washio });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, washio, "serve")).toBe(5); // 2+3
    expect(s.players[0].hand.length).toBe(2); // 棄1 抽2

    // 小見接球＋猿杙攻擊（托球木葉）
    let t = setup(deckWith("HV-P04-066", "HV-P04-065", "HV-P01-048", "HV-P04-067"), deckWith(FILLER), 1);
    t = serveWith(t, FILLER);
    t = feed(t, { type: "defense-choice", choice: "receive" });
    t = feed(t, { type: "free", action: "pass" });
    seedStack(t, 0, "receive", 2);
    const washioCost = grab(t, 0, "HV-P04-067");
    const komi = grab(t, 0, "HV-P04-066");
    setHandSize(t, 0, 2, [komi, washioCost]); // 只留小見與 1 張梟谷3年 washioCost
    t = feed(t, { type: "deploy-receive", uid: komi });
    t = feed(t, { type: "effect-confirm", accept: true });
    while (t.pendingDecision?.type === "effect-cards") {
      t = feed(t, { type: "effect-cards", uids: [t.pendingDecision.candidates![0]!] });
    }
    expect(effParam(db, t, komi, "receive")).toBe(6); // 5+1
    t = feed(t, { type: "free", action: "pass" });
    const konoha = grab(t, 0, "HV-P01-048");
    t = feed(t, { type: "deploy-toss", uid: konoha });
    t = drainCp(t, false);
    t = feed(t, { type: "free", action: "pass" });
    const sarukui = grab(t, 0, "HV-P04-065");
    setHandSize(t, 0, 2, [sarukui, washioCost]);
    t = feed(t, { type: "deploy-attack", uid: sarukui });
    t = feed(t, { type: "effect-confirm", accept: true });
    expect(effParam(db, t, sarukui, "attack")).toBe(5); // 1+4
  });

  it("HV-P04-070 北 信介 ＆ HV-P04-077 佐久早 聖臣：稲荷崎全體防降點與ユース放事件+3", () => {
    let s = setup(deckWith("HV-P04-070", "HV-D03-001", "HV-D03-002", "HV-D03-012", "HV-D03-013", "HV-P03-091"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    placeInEventArea(s, 0, "HV-D03-012");
    placeInEventArea(s, 0, "HV-D03-013");
    placeInEventArea(s, 0, "HV-P03-091");
    const atsumu = placeOnStack(s, 0, "toss", "HV-D03-001"); // 場上另一名稲荷崎角色
    const dropCost = grab(s, 0, "HV-D03-002");
    const kita = grab(s, 0, "HV-P04-070");
    setHandSize(s, 0, 2, [kita, dropCost]);
    s = feed(s, { type: "deploy-receive", uid: kita });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, kita, "receive")).toBe(7); // 5+2
    // 對北與宮侑分別施加負向修正，均應被 P04-070 守衛忽略
    s.modifiers.push({ target: kita, param: "receive", amount: -3, source: kita });
    s.modifiers.push({ target: atsumu, param: "toss", amount: -2, source: kita });
    expect(effParam(db, s, kita, "receive")).toBe(7);
    expect(effParam(db, s, atsumu, "toss")).toBe(1);

    // P04-077 佐久早：從手牌放ユース事件 → 抽1＋1項參數+3
    let y = setup(deckWith("HV-P04-077", "HV-P03-083"), deckWith(FILLER), 1);
    y = serveWith(y, FILLER);
    y = feed(y, { type: "defense-choice", choice: "receive" });
    y = feed(y, { type: "free", action: "pass" });
    const youthEv = grab(y, 0, "HV-P03-083");
    const sakusa = grab(y, 0, "HV-P04-077");
    setHandSize(y, 0, 2, [sakusa, youthEv]);
    y = feed(y, { type: "deploy-receive", uid: sakusa });
    y = feed(y, { type: "effect-confirm", accept: true });
    if (y.pendingDecision?.type === "effect-option") {
      y = feed(y, { type: "effect-option", index: 2 }); // serve=0, block=1, receive=2
    }
    expect(effParam(db, y, sakusa, "receive")).toBe(7); // 4+3
  });
});
