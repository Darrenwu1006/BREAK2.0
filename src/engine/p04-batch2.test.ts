// 第四彈（HV-P04 / HV-D04 / HV-PR）Batch 2：共用 DSL 擴充後的 46 張卡逐張行為測試＋官方判例（Q1842～Q1957）
import { describe, expect, it } from "vitest";
import { canDeployTo, effParam } from "./engine";
import { topChara } from "./effect-helpers";
import { db, deckWith, drainCp, feed, grab, placeDeckTop, placeInDrop, placeOnStack, receiveTrack, seedStack, serveWith, setHandSize, setup, FILLER } from "./testkit";
import type { GameState, PlayerId } from "./types";
import cardsJson from "../../data/cards.json";
import effectsJson from "../../data/effects.json";
import { validateEffectDef } from "./dsl-schema";

const BATCH_2_IDS = [
  "HV-D04-001", "HV-D04-002", "HV-D04-012", "HV-D04-013", "HV-P04-001", "HV-P04-002",
  "HV-P04-004", "HV-P04-005", "HV-P04-007", "HV-P04-016", "HV-P04-020", "HV-P04-022",
  "HV-P04-031", "HV-P04-032", "HV-P04-037", "HV-P04-039", "HV-P04-044", "HV-P04-045",
  "HV-P04-048", "HV-P04-055", "HV-P04-057", "HV-P04-058", "HV-P04-062", "HV-P04-063",
  "HV-P04-064", "HV-P04-068", "HV-P04-073", "HV-P04-074", "HV-P04-076", "HV-P04-078",
  "HV-P04-080", "HV-P04-082", "HV-P04-083", "HV-P04-084", "HV-P04-087", "HV-P04-088",
  "HV-P04-090", "HV-P04-093", "HV-P04-094", "HV-P04-095", "HV-P04-096", "HV-P04-097",
  "HV-P04-099", "HV-PR-078", "HV-PR-080", "HV-PR-081",
] as const;

function placeInEventArea(s: GameState, p: PlayerId, cardId: string, exclude: number[] = []): number {
  const uid = grab(s, p, cardId, exclude);
  const ps = s.players[p];
  ps.hand.splice(ps.hand.indexOf(uid), 1);
  ps.eventArea.push(uid);
  return uid;
}

describe("第四彈 Batch 2：46 張 schema 與同步契約", () => {
  it.each(BATCH_2_IDS)("%s：已寫入 effects.json 並同步至 cards.json (effectStatus=dsl)", (id) => {
    const card = (cardsJson as { id: string; effectStatus: string }[]).find((c) => c.id === id);
    const effect = (effectsJson as Record<string, unknown>)[id];
    expect(card?.effectStatus).toBe("dsl");
    expect(effect).toBeTruthy();
    expect(validateEffectDef(effect, id)).toEqual([]);
  });
});

describe("第四彈 Batch 2：青葉城西（HV-D04-001/002/012/013、HV-P04-016/020/022/031/087/088）", () => {
  it("HV-D04-001 及川 徹（Q1842/Q1843）：付 2 張青葉城西 Guts → 任選 1 項參數+2（可選非所在區參數）", () => {
    let s = setup(deckWith("HV-D04-001", "HV-D04-002", "HV-D04-010"), deckWith(FILLER), 0);
    placeOnStack(s, 0, "serve", "HV-D04-002");
    placeOnStack(s, 0, "serve", "HV-D04-010");
    const oikawa = grab(s, 0, "HV-D04-001");
    s = feed(s, { type: "deploy-serve", uid: oikawa });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-option", index: 1 }); // block (Q1843)
    expect(effParam(db, s, oikawa, "block")).toBe(3); // 1+2
  });

  it("HV-D04-002 岩泉 一：托球為及川時付 2 Guts → 攻擊+3；自己 Set 少於對手時再+1", () => {
    let s = setup(deckWith("HV-D04-002", "HV-D04-001", "HV-D04-010"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D04-010");
    const oikawa = grab(s, 0, "HV-D04-001");
    s = feed(s, { type: "deploy-toss", uid: oikawa });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 2);
    // 減少 0 號玩家的 Set 使其少於對手（1 vs 2）
    s.players[0].drop.push(s.players[0].setArea.pop()!);
    const iwa = grab(s, 0, "HV-D04-002");
    s = feed(s, { type: "deploy-attack", uid: iwa });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, iwa, "attack")).toBe(5); // 1+3+1
  });

  it("HV-D04-012 …残念ながら―― お前は決めるに決まっている（Q1846/Q1847/Q1848）：青城角色參數+1、攻擊階段抽1、同名事件第 2 張可打出但無效", () => {
    let s = setup(deckWith("HV-D04-012", "HV-D04-012", "HV-D04-001", "HV-D04-002", "HV-D04-010"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D04-010");
    const oikawa = grab(s, 0, "HV-D04-001");
    s = feed(s, { type: "deploy-toss", uid: oikawa });
    s = feed(s, { type: "free", action: "pass" });
    const iwa = grab(s, 0, "HV-D04-002");
    s = feed(s, { type: "deploy-attack", uid: iwa });
    const ev1 = grab(s, 0, "HV-D04-012");
    const ev2 = grab(s, 0, "HV-D04-012", [ev1]);
    const handBefore = s.players[0].hand.length;
    s = feed(s, { type: "free", action: "event", uid: ev1 });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [iwa] });
    if (s.pendingDecision?.type === "effect-option") s = feed(s, { type: "effect-option", index: 4 }); // attack
    expect(effParam(db, s, iwa, "attack")).toBe(2); // 1+1
    expect(s.players[0].hand.length).toBe(handBefore); // -1(打出) + 1(抽牌)
    // Q1847：同回合可打出第 2 張同名事件，但技能無效
    s = feed(s, { type: "free", action: "event", uid: ev2 });
    expect(s.players[0].eventArea).toContain(ev2);
    expect(effParam(db, s, iwa, "attack")).toBe(2);
  });

  it("HV-D04-013 さすがお前らしっかりしすぎて主将悲しい!!（Q1849/Q1850）：公開牌組頂最多 1 張；青城事件卡時既入手又抽 1 張", () => {
    let s = setup(deckWith("HV-D04-013", "HV-D04-012", "HV-D04-010"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const kunimi = grab(s, 0, "HV-D04-010");
    s = feed(s, { type: "deploy-receive", uid: kunimi });
    const topEv = placeDeckTop(s, 0, "HV-D04-012"); // 青葉城西のイベントカード（Q1850）
    const ev = grab(s, 0, "HV-D04-013");
    const handBefore = s.players[0].hand.length;
    s = feed(s, { type: "free", action: "event", uid: ev });
    s = feed(s, { type: "effect-confirm", accept: true }); // 公開牌組頂
    s = feed(s, { type: "effect-cards", uids: [topEv] }); // 強制加入手牌（不可空選）
    expect(s.players[0].hand).toContain(topEv);
    expect(s.players[0].hand.length).toBe(handBefore + 1); // -1(ev) +1(topEv) +1(draw)
  });

  it("HV-P04-016 及川 徹（Q1869/Q1870/Q1871/Q1872/Q1873/Q1874）：手牌登場基礎攻擊 3 的攻擊手時，托球區及川付 2 Guts → 從任意區 Guts 登場岩泉 一並將攻擊設為 4", () => {
    let s = setup(deckWith("HV-P04-016", "HV-D04-010", "HV-D04-010", "HV-P04-031", "HV-D04-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D04-010");
    seedStack(s, 0, "toss", 2);
    // Q1872：任意區 Guts 的岩泉 一皆可登場（放在發球區 Guts）
    const gutsIwa = placeOnStack(s, 0, "serve", "HV-D04-002");
    placeOnStack(s, 0, "serve", "HV-D04-010"); // 蓋住使 gutsIwa 成為 Guts
    const oikawa = grab(s, 0, "HV-P04-016");
    s = feed(s, { type: "deploy-toss", uid: oikawa });
    s = feed(s, { type: "free", action: "pass" });
    const onda = grab(s, 0, "HV-P04-031"); // 基礎攻擊 3
    s = feed(s, { type: "deploy-attack", uid: onda });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [gutsIwa] });
    expect(topChara(s.players[0].attack)).toBe(gutsIwa);
    expect(effParam(db, s, gutsIwa, "attack")).toBe(4);
  });

  it("HV-P04-020 岩泉 一（Q1875/Q1876）：付 3 Guts 攻擊+4，攻擊達 8 以上時下回合對手攔網限 1 人且手牌接球主動技無效", () => {
    let s = setup(deckWith("HV-P04-020", "HV-D04-012", "HV-D04-010", "HV-D04-001"), deckWith("HV-P04-072", FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D04-010");
    const oikawa = grab(s, 0, "HV-D04-001");
    s = feed(s, { type: "deploy-toss", uid: oikawa });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 3);
    const iwa = grab(s, 0, "HV-P04-020"); // 基礎攻擊 1，先給 +3 修正使其付 3 Guts 後達 8
    s.modifiers.push({ target: iwa, param: "attack", amount: 3, source: iwa });
    s = feed(s, { type: "deploy-attack", uid: iwa });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, iwa, "attack")).toBe(8);
    expect(s.restrictions.some((r) => r.player === 1 && r.area === "block" && r.maxCount === 1 && r.banHandReceiveActive)).toBe(true);
  });

  it("HV-P04-022 金田一 勇太郎（Q1878/Q1879）：攔網區金田一在手牌登場基礎攻擊 3 的攻擊手時，棄 1 張青城手牌 → 自身移至攻擊區登場且攻擊+3", () => {
    let s = setup(deckWith("HV-P04-022", "HV-P04-031", "HV-D04-010", "HV-D04-010", "HV-D04-001"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D04-010");
    const oikawa = grab(s, 0, "HV-D04-001");
    s = feed(s, { type: "deploy-toss", uid: oikawa });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const kindaichi = placeOnStack(s, 0, "blockCenter", "HV-P04-022");
    const costAoba = grab(s, 0, "HV-D04-010");
    const onda = grab(s, 0, "HV-P04-031");
    setHandSize(s, 0, 2, [onda, costAoba]);
    s = feed(s, { type: "deploy-attack", uid: onda });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(topChara(s.players[0].attack)).toBe(kindaichi);
    expect(effParam(db, s, kindaichi, "attack")).toBe(4); // 1+3
  });

  it("HV-P04-031 温田 兼生（Q1882/Q1883）：對手事件區有 5 張以上［攔網/抽牌/接球］事件時，抽牌階段棄自身回收事件區 1 張青城卡", () => {
    let s = setup(deckWith("HV-P04-031", "HV-D04-013"), deckWith("HV-D04-013", "HV-D04-013", "HV-D04-013", "HV-D04-013", "HV-D04-013", FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const excl: number[] = [];
    for (let i = 0; i < 5; i++) excl.push(placeInEventArea(s, 1, "HV-D04-013", excl));
    const myEv = placeInEventArea(s, 0, "HV-D04-013");
    const onda = grab(s, 0, "HV-P04-031");
    s = feed(s, { type: "free", action: "skill", uid: onda, skillIndex: 0 });
    s = feed(s, { type: "effect-cards", uids: [myEv] });
    expect(s.players[0].hand).toContain(myEv);
  });

  it("HV-P04-087 あ、キタ サーブトスいいかんじ（Q1933）：發球階段從棄牌區登場及川 徹，並封鎖對手下回合抽牌階段一切手牌增加（含接球抽牌）", () => {
    let s = setup(deckWith("HV-P04-087", "HV-D04-001", "HV-D04-001"), deckWith(FILLER), 0);
    const serveOikawa = grab(s, 0, "HV-D04-001");
    s = feed(s, { type: "deploy-serve", uid: serveOikawa });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    const dropOikawa = placeInDrop(s, 0, "HV-D04-001");
    const ev = grab(s, 0, "HV-P04-087");
    s = feed(s, { type: "free", action: "event", uid: ev });
    s = feed(s, { type: "effect-option", index: 0 }); // サーブフェイズ分岐
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    expect(topChara(s.players[0].serve)).toBe(dropOikawa);
    s = feed(s, { type: "free", action: "pass" }); // 進入對手回合
    const oppHandBefore = s.players[1].hand.length;
    s = feed(s, { type: "defense-choice", choice: "receive" }); // 對手進入 draw phase
    expect(s.players[1].hand.length).toBe(oppHandBefore); // Q1933：不能接球抽牌
  });

  it("HV-P04-088 ドンピシャ!!!（Q1934/Q1935）：抽1＋青城攻擊手攻擊+1；攻擊手自身攻擊達 8 以上時下回合對手每次登場接球手皆接球-1", () => {
    let s = setup(deckWith("HV-P04-088", "HV-P04-020", "HV-D04-010", "HV-D04-001"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D04-010");
    const oikawa = grab(s, 0, "HV-D04-001");
    s = feed(s, { type: "deploy-toss", uid: oikawa });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const iwa = grab(s, 0, "HV-P04-020"); // 基礎 1，先給 +6 使其 +1 後達 8
    s.modifiers.push({ target: iwa, param: "attack", amount: 6, source: iwa });
    s = feed(s, { type: "deploy-attack", uid: iwa });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    const ev = grab(s, 0, "HV-P04-088");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(effParam(db, s, iwa, "attack")).toBe(8);
    expect(s.watchers.some((w) => w.source === ev && w.trigger.on === "deploy")).toBe(true);
  });
});

describe("第四彈 Batch 2：烏野・町内会（HV-P04-001/002/004/005/007/078/080/082/083/084、HV-PR-078/080）", () => {
  it("HV-P04-002 影山 飛雄 ＆ HV-P04-001 日向 翔陽（Q1851/Q1852/Q1853/Q1854）：手牌登場日向觸發影山付トス/アタック各 2 Guts 蘇生棄牌區日向（含剛付掉的 Guts Q1853），蘇生的 P04-001 滿足「影山 飛雄のスキルで登場」攻擊+3", () => {
    let s = setup(deckWith("HV-P04-001", "HV-P04-002", "HV-P01-001", "HV-P01-001", "HV-D01-008", "HV-D01-008", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    seedStack(s, 0, "toss", 2);
    const kageyama = grab(s, 0, "HV-P04-002");
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    s = feed(s, { type: "free", action: "pass" });
    // 把 P04-001 放在攻擊區當 Guts（Q1853：付掉後可立刻蘇生）
    const p04Hinata = placeOnStack(s, 0, "attack", "HV-P04-001");
    placeOnStack(s, 0, "attack", "HV-P01-001");
    const handHinata = grab(s, 0, "HV-P01-001");
    const k1 = grab(s, 0, "HV-D01-008");
    const k2 = grab(s, 0, "HV-D01-008", [k1]);
    setHandSize(s, 0, 3, [handHinata, k1, k2]);
    s = feed(s, { type: "deploy-attack", uid: handHinata }); // 手牌登場日向
    s = feed(s, { type: "effect-confirm", accept: true }); // 影山技能
    s = feed(s, { type: "effect-cards", uids: [p04Hinata] }); // 選 P04-001 登場
    // P04-001 登場技能進入待機
    s = feed(s, { type: "effect-confirm", accept: true }); // P04-001 棄 2 張烏野手牌
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 2) });
    }
    expect(topChara(s.players[0].attack)).toBe(p04Hinata);
    expect(effParam(db, s, p04Hinata, "attack")).toBe(7); // 基礎 2 + 影山賦予 2 + 自身技能 3
  });

  it("HV-P04-004 山口 忠（Q1855）：下回合對手從手牌登場 Li 接球手時接球-1（效果登場不受影響）", () => {
    let s = setup(deckWith("HV-P04-004"), deckWith("HV-P04-005", FILLER), 0);
    s = serveWith(s, "HV-P04-004");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const noya = grab(s, 1, "HV-P04-005"); // Li, 基礎 receive 5
    s = feed(s, { type: "deploy-receive", uid: noya });
    expect(effParam(db, s, noya, "receive")).toBe(4); // 5-1
  });

  it("HV-P04-005 西谷 夕（Q1856）：蓋在烏野 S 的角色（含雙所屬雙位置 HV-P01-072）上登場時，付 2 Guts → 托球+3", () => {
    let s = setup(deckWith("HV-P04-005", "HV-P01-072", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    seedStack(s, 0, "toss", 1);
    placeOnStack(s, 0, "toss", "HV-P01-072"); // 烏野/音駒, MB/S（Q1856）
    const noya = grab(s, 0, "HV-P04-005");
    s = feed(s, { type: "deploy-toss", uid: noya });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, noya, "toss")).toBe(3); // 0+3
  });

  it("HV-P04-007 縁下 力（Q1857/Q1858）：付 3 張不同卡名的烏野 Guts → 接球+三張基礎攔網點數總和", () => {
    let s = setup(deckWith("HV-P04-007", "HV-D01-003", "HV-D01-006", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    placeOnStack(s, 0, "receive", "HV-D01-003"); // 月島 block=3
    placeOnStack(s, 0, "receive", "HV-D01-006"); // 田中 block=2
    placeOnStack(s, 0, "receive", "HV-D01-008"); // 澤村 block=1
    const ennoshita = grab(s, 0, "HV-P04-007");
    s = feed(s, { type: "deploy-receive", uid: ennoshita });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, ennoshita, "receive")).toBe(6); // 0 + (3+2+1)
  });

  it("HV-P04-078 嶋田 誠（Q1917）：事件區有 4 張「おっさんも本気出しちゃうんだぜ」時抽 1 張並禁止對手下回合登場基礎接球 4 以上的接球手", () => {
    let s = setup(deckWith("HV-P04-078", "HV-P04-101", "HV-P04-101", "HV-P04-101", "HV-P04-101"), deckWith("HV-D01-008", FILLER), 0);
    const excl: number[] = [];
    for (let i = 0; i < 4; i++) excl.push(placeInEventArea(s, 0, "HV-P04-101", excl));
    const shimada = grab(s, 0, "HV-P04-078");
    s = feed(s, { type: "deploy-serve", uid: shimada });
    s = feed(s, { type: "free", action: "pass" });
    const daichi = grab(s, 1, "HV-D01-008"); // 基礎 receive 4
    expect(canDeployTo(db, s, 1, daichi, "receive")).toBe(false);
  });

  it("HV-P04-080 内沢 英紀（Q1919/Q1920）：付 2 Guts 托球+2，查看牌組頂 3 張檢索「おっさんも本気出しちゃうんだぜ」", () => {
    let s = setup(deckWith("HV-P04-080", "HV-P04-101", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    seedStack(s, 0, "toss", 2);
    const ossan = placeDeckTop(s, 0, "HV-P04-101");
    const uchisawa = grab(s, 0, "HV-P04-080");
    s = feed(s, { type: "deploy-toss", uid: uchisawa });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [ossan] });
    expect(effParam(db, s, uchisawa, "toss")).toBe(2);
    expect(s.players[0].hand).toContain(ossan);
  });

  it("HV-P04-082 …これで スタートラインだ…!!（Q1921）：托球影山＋攻擊日向時攻擊+1；下回合對手 Lost 時先從棄牌區將影山放托球 Guts、日向回收手牌再進入 Interval", () => {
    let s = setup(deckWith("HV-P04-082", "HV-D01-001", "HV-D01-001", "HV-D01-002", "HV-D01-002", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const kageyama = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    s = feed(s, { type: "free", action: "pass" });
    const hinata = grab(s, 0, "HV-D01-001");
    s = feed(s, { type: "deploy-attack", uid: hinata });
    const dropKage = placeInDrop(s, 0, "HV-D01-002");
    const dropHina = placeInDrop(s, 0, "HV-D01-001");
    const ev = grab(s, 0, "HV-P04-082");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [hinata] });
    expect(effParam(db, s, hinata, "attack")).toBe(3); // 2+1
    s = feed(s, { type: "free", action: "pass" }); // 對手回合
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "lost" }); // 對手宣告 Lost（Q1921）
    s = feed(s, { type: "effect-cards", uids: [dropKage] });
    s = feed(s, { type: "effect-cards", uids: [dropHina] });
    expect(s.players[0].toss).toContain(dropKage);
    expect(s.players[0].hand).toContain(dropHina);
  });

  it("HV-P04-083 戦術的ワンポイントツーセッター!!!（Q1922～Q1929）：托球影山回手，並可從手牌登場菅原 孝支且托球變為 3", () => {
    let s = setup(deckWith("HV-P04-083", "HV-D01-002", "HV-D01-009", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const kage = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: kage });
    const suga = grab(s, 0, "HV-D01-009");
    const ev = grab(s, 0, "HV-P04-083");
    s = feed(s, { type: "free", action: "event", uid: ev });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [suga] });
    expect(s.players[0].hand).toContain(kage);
    expect(topChara(s.players[0].toss)).toBe(suga);
    expect(effParam(db, s, suga, "toss")).toBe(3);
  });

  it("HV-P04-084 負けねえよ 俺達は（Q1930/Q1931）：事件區 5 張以下時抽 1＋烏野 3 年接球+1；棄牌區烏野角色滿 8 種再抽 1＋任選參數+2", () => {
    const eightKarasuno = [
      "HV-D01-001", "HV-D01-002", "HV-D01-003", "HV-D01-004",
      "HV-D01-005", "HV-D01-006", "HV-D01-007", "HV-D01-009",
    ];
    let s = setup(deckWith("HV-P04-084", "HV-D01-008", ...eightKarasuno), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const daichi = grab(s, 0, "HV-D01-008");
    s = feed(s, { type: "deploy-receive", uid: daichi });
    for (const id of eightKarasuno) placeInDrop(s, 0, id);
    const ev = grab(s, 0, "HV-P04-084");
    s = feed(s, { type: "free", action: "event", uid: ev });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-option") s = feed(s, { type: "effect-option", index: 2 }); // receive +2
    expect(effParam(db, s, daichi, "receive")).toBe(8); // 5+1+2
  });

  it("HV-PR-078 挑戦者たち：手牌剛好 4 張時從場上回收最多 1 張 1 年級 Guts", () => {
    let s = setup(deckWith("HV-PR-078", "HV-D01-001"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const g1 = placeOnStack(s, 0, "serve", "HV-D01-001"); // 1年
    placeOnStack(s, 0, "serve", FILLER);
    const ev = grab(s, 0, "HV-PR-078");
    setHandSize(s, 0, 5, [ev]); // 打出後手牌剛好 4 張
    s = feed(s, { type: "free", action: "event", uid: ev });
    s = feed(s, { type: "effect-cards", uids: [g1] });
    expect(s.players[0].hand).toContain(g1);
  });

  it("HV-PR-080 日向 翔陽（Q1956）：托球影山時可選付 2 或 3 張「日向 翔陽」Guts → 攻擊+3 再+X（付 3 張時+6）", () => {
    let s = setup(deckWith("HV-PR-080", "HV-D01-001", "HV-D01-001", "HV-D01-001", "HV-D01-002", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const kage = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: kage });
    s = feed(s, { type: "free", action: "pass" });
    const h1 = placeOnStack(s, 0, "attack", "HV-D01-001");
    const h2 = placeOnStack(s, 0, "attack", "HV-D01-001");
    const h3 = placeOnStack(s, 0, "attack", "HV-D01-001");
    const prHinata = grab(s, 0, "HV-PR-080");
    s = feed(s, { type: "deploy-attack", uid: prHinata });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [h1, h2, h3] }); // 選付 3 張（Q1956）
    expect(effParam(db, s, prHinata, "attack")).toBe(6); // 0 + 3 + 3
  });
});

describe("第四彈 Batch 2：角川・条善寺・和久谷南（HV-P04-032/037/039/044/045/048/090/093/094/095/096/097）", () => {
  it("HV-P04-032 百沢 雄大（Q1884/Q1885）：全員角川時從攔網與攻擊區付 3 張無技能「百沢 雄大」Guts → 攻擊+5 再+2", () => {
    let s = setup(deckWith("HV-P04-032", "HV-P04-033", "HV-P04-033", "HV-P04-033", "HV-P04-038", "HV-P04-038", "HV-P04-035"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-P04-038");
    const toss = grab(s, 0, "HV-P04-035");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    placeOnStack(s, 0, "blockCenter", "HV-P04-033"); // 無技能百沢
    placeOnStack(s, 0, "blockCenter", "HV-P04-038"); // 頂端角川キャラ
    placeOnStack(s, 0, "attack", "HV-P04-033");
    placeOnStack(s, 0, "attack", "HV-P04-033");
    const hyaku = grab(s, 0, "HV-P04-032");
    s = feed(s, { type: "deploy-attack", uid: hyaku });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, hyaku, "attack")).toBe(7); // 0+5+2
  });

  it("HV-P04-037 馬門 英治：攔網登場棄 1 張角川手牌 → 回收棄牌區百沢＋ワンタッチ(2)＋本回合禁止接球區登場百沢", () => {
    let s = setup(deckWith("HV-P04-037", "HV-P04-033", "HV-P04-038"), deckWith(FILLER), 1);
    s.turnPlayer = 0;
    s.phase = "block";
    s.sub = 0;
    s.op = { value: 6, owner: 1, source: "attack" };
    s.pendingDecision = { player: 0, type: "deploy-block" };
    const dropHyaku = placeInDrop(s, 0, "HV-P04-033");
    const costKakugawa = grab(s, 0, "HV-P04-038");
    const makado = grab(s, 0, "HV-P04-037");
    setHandSize(s, 0, 2, [makado, costKakugawa]);
    s = feed(s, { type: "deploy-block", uids: [makado], center: makado });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [dropHyaku] });
    expect(s.players[0].hand).toContain(dropHyaku);
    expect(s.op?.value).toBe(4); // 6 - 2 (ワンタッチ)
    expect(canDeployTo(db, s, 0, dropHyaku, "receive")).toBe(false);
  });

  it("HV-P04-039 照島 遊児（Q1890/Q1891）＆ HV-P04-045 土湯 新：牌組頂最多 3 張置入棄牌區，依其中事件卡張數獲得加成", () => {
    let s = setup(deckWith("HV-P04-039", "HV-P04-045", "HV-D04-012", "HV-P04-093", "HV-P04-094", "HV-P04-095", "HV-P04-096", "HV-D01-009"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const e1 = placeDeckTop(s, 0, "HV-D04-012"); // 非条善寺事件也算（Q1890）
    const e2 = placeDeckTop(s, 0, "HV-P04-093");
    const tsuchiyu = grab(s, 0, "HV-P04-045");
    s = feed(s, { type: "deploy-receive", uid: tsuchiyu });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-option", index: 2 }); // 選棄 2 張
    expect(effParam(db, s, tsuchiyu, "receive")).toBe(7); // 5+2
    s = feed(s, { type: "free", action: "pass" });
    const toss = grab(s, 0, "HV-D01-009");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const m1 = placeDeckTop(s, 0, "HV-P04-094");
    const m2 = placeDeckTop(s, 0, "HV-P04-095");
    const m3 = placeDeckTop(s, 0, "HV-P04-096");
    const terushima = grab(s, 0, "HV-P04-039");
    s = feed(s, { type: "deploy-attack", uid: terushima });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-option", index: 3 }); // 3 張事件 → +2+2+4 = +8
    expect(effParam(db, s, terushima, "attack")).toBe(10); // 2+8
  });

  it("HV-P04-044 沼尻 凛太郎：從接球/托球/攻擊各付 2 Guts → 接球+2，從事件區或棄牌區回收 1 張条善寺事件後棄 1 張手牌", () => {
    let s = setup(deckWith("HV-P04-044", "HV-P04-093"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 2);
    seedStack(s, 0, "toss", 3);
    seedStack(s, 0, "attack", 3);
    const jEv = placeInEventArea(s, 0, "HV-P04-093");
    const numajiri = grab(s, 0, "HV-P04-044");
    s = feed(s, { type: "deploy-receive", uid: numajiri });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [jEv] });
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    }
    expect(effParam(db, s, numajiri, "receive")).toBe(6); // 4+2
  });

  it("HV-P04-048 川渡 瞬己（Q1894/Q1895）：被川渡以外的和久谷南角色蓋住時，下回合對手每登場 1 名基礎攔網 3 以上的攔網手就抽 1 張", () => {
    let s = setup(deckWith("HV-P04-048", "HV-P04-046", "HV-D01-008", "HV-D01-002"), deckWith("HV-D01-003", "HV-P04-033", FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const toss = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    placeOnStack(s, 0, "attack", "HV-P04-048");
    const nakashima = grab(s, 0, "HV-P04-046");
    s = feed(s, { type: "deploy-attack", uid: nakashima });
    s = drainCp(s, false);
    s = feed(s, { type: "free", action: "pass" }); // 對手回合
    s = feed(s, { type: "defense-choice", choice: "block" });
    const b1 = grab(s, 1, "HV-D01-003"); // 月島 block 3
    const b2 = grab(s, 1, "HV-P04-033"); // 百沢 block 3
    const handBefore = s.players[0].hand.length;
    s = feed(s, { type: "deploy-block", uids: [b1, b2], center: b1 });
    s = drainCp(s, false);
    expect(s.players[0].hand.length).toBe(handBefore + 2); // Q1894：2 人登場抽 2 張
  });

  it("HV-P04-090 ―上から…！（Q1936）：抽 1 張；攻擊手為百沢 雄大時同時註冊對手下回合攔網-1 與接球-1", () => {
    let s = setup(deckWith("HV-P04-090", "HV-P04-033", "HV-D01-008", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const toss = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const hyaku = grab(s, 0, "HV-P04-033");
    s = feed(s, { type: "deploy-attack", uid: hyaku });
    const ev = grab(s, 0, "HV-P04-090");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.watchers.filter((w) => w.source === ev)).toHaveLength(2);
  });

  it("HV-P04-093 三咲 華（Q1937/Q1938/Q1939）＆ HV-P04-094 栗林 るな ＆ HV-P04-095 「遊ぶには」「まず〝遊び場″が必要」", () => {
    let s = setup(deckWith("HV-P04-093", "HV-P04-094", "HV-P04-094", "HV-P04-095", "HV-P04-045", "HV-P04-039"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const tsuchiyu = grab(s, 0, "HV-P04-045");
    s = feed(s, { type: "deploy-receive", uid: tsuchiyu });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    // 打出 P04-094 栗林 るな
    const ravel = grab(s, 0, "HV-P04-094");
    s = feed(s, { type: "free", action: "event", uid: ravel });
    s = feed(s, { type: "effect-confirm", accept: true }); // 洗牌
    expect(effParam(db, s, tsuchiyu, "receive")).toBe(6); // 5+1
    // 打出 P04-095
    const topEv = placeDeckTop(s, 0, "HV-P04-094");
    const asobi = grab(s, 0, "HV-P04-095");
    s = feed(s, { type: "free", action: "event", uid: asobi });
    s = feed(s, { type: "effect-option", index: 0 }); // receive +1
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-option", index: 1 });
    expect(effParam(db, s, tsuchiyu, "receive")).toBe(8); // 6+1+1
    // 打出 P04-093 三咲 華（場上與棄牌區皆条善寺 → 事件區含自身與棄牌區全部洗回牌組 Q1937）
    s.players[0].drop = [topEv];
    const misaki = grab(s, 0, "HV-P04-093");
    s = feed(s, { type: "free", action: "event", uid: misaki });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].eventArea).toHaveLength(0);
    expect(s.players[0].drop).toHaveLength(0);
  });

  it("HV-P04-096 中島ファミリー（Q1940/Q1941/Q1942）＆ HV-P04-097 かつての \"小さな巨人\"に（Q1943/Q1944）", () => {
    let s = setup(deckWith("HV-P04-096", "HV-P04-097", "HV-P04-046", "HV-P04-046", "HV-P04-048", "HV-P04-052"), deckWith("HV-P04-055", FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const targetCard = placeDeckTop(s, 0, "HV-P04-046");
    placeDeckTop(s, 0, "HV-P04-048"); // 供 draw 抽走
    const fam = grab(s, 0, "HV-P04-096");
    s = feed(s, { type: "free", action: "event", uid: fam });
    s = feed(s, { type: "effect-cards", uids: [targetCard] });
    expect(s.players[0].hand).toContain(targetCard);
    // [Codex 2026-10-28] 完成卡文要求的任意置底排序，再繼續回合。
    while (s.effectCtx?.awaiting?.kind === "cards" && s.effectCtx.awaiting.purpose === "tutorBottom") {
      s = feed(s, { type: "effect-cards", uids: [s.effectCtx.awaiting.candidates[0]!] });
    }
    s = feed(s, { type: "free", action: "pass" });
    const r = grab(s, 0, "HV-P04-052");
    s = feed(s, { type: "deploy-receive", uid: r });
    s = feed(s, { type: "free", action: "pass" });
    // 托球階段登場和久谷南角色，再進攻擊階段登場中島 猛
    const t = grab(s, 0, "HV-P04-048");
    s = feed(s, { type: "deploy-toss", uid: t });
    s = feed(s, { type: "free", action: "pass" });
    const nakashima = grab(s, 0, "HV-P04-046");
    s = feed(s, { type: "deploy-attack", uid: nakashima });
    if (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    const katute = grab(s, 0, "HV-P04-097");
    s = feed(s, { type: "free", action: "event", uid: katute });
    s = feed(s, { type: "free", action: "pass" }); // 對手回合
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const yaku = grab(s, 1, "HV-P04-055"); // 基礎 receive 5
    s = feed(s, { type: "deploy-receive", uid: yaku });
    s = drainCp(s, false);
    expect(effParam(db, s, yaku, "receive")).toBe(2); // 5 - 2 - 1
  });
});

describe("第四彈 Batch 2：音駒・伊達工・白鳥沢・梟谷・稲荷崎・ユース（HV-P04-055/057/058/062/063/064/068/073/074/076/099、HV-PR-081）", () => {
  it("HV-P04-055 夜久 衛輔（Q1898）：付 2 Guts 接球+1，查看牌組頂 3 張檢索黒尾或海", () => {
    let s = setup(deckWith("HV-P04-055", "HV-P01-021"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 2);
    const kuroo = placeDeckTop(s, 0, "HV-P01-021");
    const yaku = grab(s, 0, "HV-P04-055");
    s = feed(s, { type: "deploy-receive", uid: yaku });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [kuroo] });
    expect(effParam(db, s, yaku, "receive")).toBe(6); // 5+1
    expect(s.players[0].hand).toContain(kuroo);
  });

  it("HV-P04-058 茂庭 要 ＆ HV-P04-057 鎌先 靖志（Q1899/Q1900/Q1901/Q1902）：無側邊攔網手時茂庭棄 2 張伊達工手牌蘇生鎌先與笹谷當側邊攔網手；鎌先付 3 張伊達工 Guts 攔網成功時ドシャット(8)", () => {
    let s = setup(deckWith("HV-P04-058", "HV-P04-057", "HV-P04-059", "HV-P01-055", "HV-P01-055", "HV-P01-055", "HV-P01-055", "HV-P01-055"), deckWith(FILLER), 1);
    s.turnPlayer = 0;
    s.phase = "block";
    s.sub = 0;
    s.op = { value: 5, owner: 1, source: "attack" };
    s.pendingDecision = { player: 0, type: "deploy-block" };
    // 先在中央攔網區放 3 張伊達工 Guts 供鎌先支付
    for (let i = 0; i < 3; i++) placeOnStack(s, 0, "blockCenter", "HV-P01-055");
    const dropKama = placeInDrop(s, 0, "HV-P04-057");
    const dropSasa = placeInDrop(s, 0, "HV-P04-059");
    const c1 = grab(s, 0, "HV-P01-055");
    const c2 = grab(s, 0, "HV-P01-055", [c1]);
    const moniwa = grab(s, 0, "HV-P04-058");
    setHandSize(s, 0, 3, [moniwa, c1, c2]);
    s = feed(s, { type: "deploy-block", uids: [moniwa], center: moniwa });
    s = feed(s, { type: "effect-confirm", accept: true }); // 茂庭技能（手牌剛好 2 張伊達工自動付代價）
    s = feed(s, { type: "effect-cards", uids: [dropKama] });
    s = feed(s, { type: "effect-cards", uids: [dropSasa] });
    expect(s.players[0].blockSides).toEqual([dropKama, dropSasa]);
    // 鎌先被茂庭技能登場，發動登場技能
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "free", action: "pass" }); // 攔網成功（2+3+3=8 >= 5）→ 觸發ドシャット(8) → 回合結束 OP=8
    expect(s.op).toEqual({ value: 8, owner: 0, source: "block" });
  });

  it("HV-P04-062 大平 獅音（Q1903/Q1904）：棄 1 張白鳥沢手牌＋付 2 Guts → 接球+2，棄牌組頂 2 張並從中回收最多 1 張白鳥沢 3 年級卡", () => {
    let s = setup(deckWith("HV-P04-062", "HV-P01-056", "HV-P01-056"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 2);
    const ushijima = placeDeckTop(s, 0, "HV-P01-056"); // 白鳥沢 3年
    const costShira = grab(s, 0, "HV-P01-056", [ushijima]);
    const ohira = grab(s, 0, "HV-P04-062");
    setHandSize(s, 0, 2, [ohira, costShira]);
    s = feed(s, { type: "deploy-receive", uid: ohira });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [ushijima] });
    expect(effParam(db, s, ohira, "receive")).toBe(7); // 5+2
    expect(s.players[0].hand).toContain(ushijima);
  });

  it("HV-P04-063 木兎 光太郎（Q1905）＆ HV-P04-064 木葉 秋紀（Q1906/Q1907/Q1908/Q1909）", () => {
    let s = setup(deckWith("HV-P04-063", "HV-P04-063", "HV-P04-064", "HV-P04-064", "HV-P01-046", "HV-P01-046", "HV-P01-051", "HV-P01-051", "HV-P01-051", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    seedStack(s, 0, "toss", 2);
    const atkGuts = placeOnStack(s, 0, "attack", "HV-P01-046"); // 赤葦 Guts
    placeOnStack(s, 0, "attack", "HV-P01-051"); // 鷲尾 Guts
    placeOnStack(s, 0, "attack", "HV-P04-063"); // 頂端キャラ
    const handWashio = grab(s, 0, "HV-P01-051");
    const konoha = grab(s, 0, "HV-P04-064");
    s = feed(s, { type: "deploy-toss", uid: konoha });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [handWashio] }); // 手牌選鷲尾
    s = feed(s, { type: "effect-cards", uids: [atkGuts] }); // 攻擊區 Guts 選赤葦互換
    expect(effParam(db, s, konoha, "toss")).toBe(2); // 1+1
    expect(s.players[0].hand).toContain(atkGuts);
    expect(s.players[0].attack).toContain(handWashio);
    // 測試 P04-063 木兎：攻擊區放 3 張不同卡名的非木兎梟谷 Guts（赤葦、木葉、鷲尾）
    s.players[0].attack = [];
    placeOnStack(s, 0, "attack", "HV-P01-046");
    placeOnStack(s, 0, "attack", "HV-P04-064");
    placeOnStack(s, 0, "attack", "HV-P01-051");
    s = feed(s, { type: "free", action: "pass" });
    const bokuto = grab(s, 0, "HV-P04-063");
    s = feed(s, { type: "deploy-attack", uid: bokuto });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, bokuto, "attack")).toBe(7); // 0+7
  });

  it("HV-P04-068 宮 侑（Q1910）＆ HV-P04-099 この位置 頃合い この角度（Q1946）", () => {
    let s = setup(deckWith("HV-P04-068", "HV-P04-068", "HV-P04-068", "HV-P04-099", "HV-P02-087", "HV-P04-070"), deckWith("HV-D01-002", FILLER), 0);
    placeOnStack(s, 0, "serve", "HV-P04-068"); // 底層宮 侑
    const atsumu = grab(s, 0, "HV-P04-068");
    s = feed(s, { type: "deploy-serve", uid: atsumu });
    expect(s.watchers.some((w) => w.source === atsumu && w.trigger.on === "deploy")).toBe(true);
    // 測試 P04-099：托球區有宮 侑時打出
    s.phase = "toss";
    s.sub = 1;
    const tossAtsumu = placeOnStack(s, 0, "toss", "HV-P04-068");
    const don = placeDeckTop(s, 0, "HV-P02-087");
    placeDeckTop(s, 0, "HV-P04-070");
    const ev = grab(s, 0, "HV-P04-099");
    s = feed(s, { type: "free", action: "event", uid: ev });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [don] });
    expect(effParam(db, s, tossAtsumu, "toss")).toBe(2); // 1+1
    expect(s.players[0].hand).toContain(don);
  });

  it("HV-P04-073 黄金川 貫至：事件區 4 張以上時付 1 Guts → 攔網+2 並棄對手場上最多 3 張「国見 英」Guts", () => {
    let s = setup(deckWith("HV-P04-073", "HV-D04-012", "HV-D04-012", "HV-D04-012", "HV-D04-012"), deckWith("HV-D04-010", "HV-D04-010", FILLER), 1);
    s.turnPlayer = 0;
    s.phase = "block";
    s.sub = 0;
    s.op = { value: 4, owner: 1, source: "attack" };
    s.pendingDecision = { player: 0, type: "deploy-block" };
    const excl: number[] = [];
    for (let i = 0; i < 4; i++) excl.push(placeInEventArea(s, 0, "HV-D04-012", excl));
    seedStack(s, 0, "blockCenter", 1);
    const oppK1 = placeOnStack(s, 1, "receive", "HV-D04-010");
    const oppK2 = placeOnStack(s, 1, "attack", "HV-D04-010");
    placeOnStack(s, 1, "receive", FILLER);
    placeOnStack(s, 1, "attack", FILLER);
    const kogane = grab(s, 0, "HV-P04-073");
    s = feed(s, { type: "deploy-block", uids: [kogane], center: kogane });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [oppK1, oppK2] });
    expect(effParam(db, s, kogane, "block")).toBe(4); // 2+2
    expect(s.players[1].drop).toContain(oppK1);
    expect(s.players[1].drop).toContain(oppK2);
  });

  it("HV-P04-074 五色 工（Q1913/Q1914）：將手牌 1 張ボール拾い角色卡置入事件區（技能不發動）→ 抽 1＋任選參數+2", () => {
    let s = setup(deckWith("HV-P04-074", "HV-P03-001"), deckWith(FILLER), 0);
    const ballBoy = grab(s, 0, "HV-P03-001");
    const goshiki = grab(s, 0, "HV-P04-074");
    setHandSize(s, 0, 2, [goshiki, ballBoy]);
    s = feed(s, { type: "deploy-serve", uid: goshiki });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-option", index: 0 }); // serve +2
    expect(s.players[0].eventArea).toContain(ballBoy);
    expect(effParam(db, s, goshiki, "serve")).toBe(5); // 3+2
  });

  it("HV-P04-076 星海 光来（Q1915/Q1916）＆ HV-PR-081 佐久早 聖臣（Q1957）", () => {
    let s = setup(deckWith("HV-P04-076", "HV-PR-081", "HV-P04-077", "HV-P03-022", "HV-P03-022", "HV-P03-083", "HV-P03-083"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-P04-077"); // 千鹿谷 栄吉（ユース MB, receive 3, vanilla）
    // 托球區放 2 張ユース S Guts（HV-P03-022 宮 侑）
    placeOnStack(s, 0, "toss", "HV-P03-022");
    placeOnStack(s, 0, "toss", "HV-P03-022");
    const dropYouthEv = placeInDrop(s, 0, "HV-P03-083");
    const hoshiumi = grab(s, 0, "HV-P04-076");
    s = feed(s, { type: "deploy-toss", uid: hoshiumi });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [dropYouthEv] });
    expect(effParam(db, s, hoshiumi, "toss")).toBe(2); // 1+1
    expect(s.players[0].eventArea).toContain(dropYouthEv); // Q1916：置入事件區不發動技能
    // 接著進入攻擊階段登場 HV-PR-081 佐久早 聖臣，從事件區棄 2 張ユース事件卡（Q1957）
    const ev2 = placeInEventArea(s, 0, "HV-P03-083", [dropYouthEv]);
    s = feed(s, { type: "free", action: "pass" });
    const sakusa = grab(s, 0, "HV-PR-081");
    s = feed(s, { type: "deploy-attack", uid: sakusa });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [dropYouthEv, ev2] }); // 棄 2 張
    s = feed(s, { type: "effect-option", index: 4 }); // attack +2
    expect(effParam(db, s, sakusa, "attack")).toBe(5); // 2 + 2 + 1
    expect(s.watchers.some((w) => w.source === sakusa && w.trigger.on === "deploy")).toBe(true); // ブロックアウト(2)
  });
});
