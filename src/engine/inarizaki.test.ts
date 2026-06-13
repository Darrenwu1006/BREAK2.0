// M3 續：稲荷崎技能卡逐張行為測試＋官方判例（Q 編號＝docs/RULINGS.md）
import { describe, it, expect } from "vitest";
import { applyDecision, blockDeployMax, createGame, effParam } from "./engine";
import type { GameState, PlayerId } from "./types";
import { db, deckWith, drainCp, feed, grab, placeInDrop, placeOnStack, seedStack, setup, serveWith, receiveTrack, FILLER } from "./testkit";

function placeInEventArea(s: GameState, p: PlayerId, cardId: string, exclude: number[] = []): number {
  const uid = grab(s, p, cardId, exclude);
  const ps = s.players[p];
  ps.hand.splice(ps.hand.indexOf(uid), 1);
  ps.eventArea.push(uid);
  return uid;
}

describe("稲荷崎：宮兄弟連動（D03 系）", () => {
  it("D03-001＋Q331/Q333：トス+1＋事件區任意位置回收「今日 何をする？」→手牌1張置底；0張時仍可+1", () => {
    let s = setup(deckWith("HV-D03-001", "HV-D03-013", "HV-D03-013", "HV-D03-006"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D03-006"); // 北 r5
    const eBottom = placeInEventArea(s, 0, "HV-D03-013");
    placeInEventArea(s, 0, "HV-D03-013", [eBottom]); // 事件區 [eBottom, eTop]
    seedStack(s, 0, "toss", 2);
    const atsumu = grab(s, 0, "HV-D03-001");
    s = feed(s, { type: "deploy-toss", uid: atsumu });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, atsumu, "toss")).toBe(2); // 1+1
    expect(s.pendingDecision?.type).toBe("effect-cards");
    expect(s.pendingDecision!.candidates!).toContain(eBottom); // Q331：不限頂牌
    s = feed(s, { type: "effect-cards", uids: [eBottom] });
    expect(s.players[0].hand).toContain(eBottom);
    // 「加えた場合」→ 手牌 1 張置底
    expect(s.pendingDecision?.type).toBe("effect-cards");
    const toBottom = s.pendingDecision!.candidates![0]!;
    const deckLen = s.players[0].deck.length;
    s = feed(s, { type: "effect-cards", uids: [toBottom] });
    expect(s.players[0].deck[s.players[0].deck.length - 1]).toBe(toBottom);
    expect(s.players[0].deck.length).toBe(deckLen + 1);

    // Q333：事件區無目標 → 仍可付 2 ガッツ只拿 +1
    let t = setup(deckWith("HV-D03-001", "HV-D03-006"), deckWith("HV-D01-002"), 1);
    t = serveWith(t, "HV-D01-002");
    t = receiveTrack(t, "HV-D03-006");
    seedStack(t, 0, "toss", 2);
    const a2 = grab(t, 0, "HV-D03-001");
    t = feed(t, { type: "deploy-toss", uid: a2 });
    t = feed(t, { type: "effect-confirm", accept: true });
    expect(effParam(db, t, a2, "toss")).toBe(2);
    expect(t.pendingDecision?.type).toBe("free"); // 沒有回收決策
  });

  it("D03-002＋Q334：トス＝宮兄弟（選名宮 侑）→ 手牌1張置底→アタック+2", () => {
    let s = setup(deckWith("HV-D03-002", "HV-P02-077", "HV-D03-006"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D03-006");
    const twins = grab(s, 0, "HV-P02-077");
    s = feed(s, { type: "deploy-toss", uid: twins, nameChoice: "宮 侑" }); // Q334
    s = feed(s, { type: "free", action: "pass" });
    const osamu = grab(s, 0, "HV-D03-002");
    s = feed(s, { type: "deploy-attack", uid: osamu });
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // 条件成立（選名後＝宮 侑）
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] }); // 置底
    expect(effParam(db, s, osamu, "attack")).toBe(4); // 2+2
  });

  it("D03-003＋Q337/Q338：置事件卡為 cost（技能不發動）→抽1＋▶選監看：對手托球登場−2（可為負）", () => {
    let s = setup(deckWith("HV-D03-003", "HV-D03-013"), deckWith("HV-D03-006", "HV-D02-010", "HV-D01-002"), 0);
    const atsumu = grab(s, 0, "HV-D03-003");
    grab(s, 0, "HV-D03-013"); // 手牌的事件卡（cost 用）
    s = feed(s, { type: "deploy-serve", uid: atsumu });
    expect(s.pendingDecision?.type).toBe("effect-confirm");
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    expect(s.players[0].eventArea.length).toBe(1); // 置於事件區、技能未發動（Q337：沒有抽1+トス+1）
    expect(s.pendingDecision?.type).toBe("effect-option"); // ▶ 二選一
    s = feed(s, { type: "effect-option", index: 1 }); // 監看
    s = feed(s, { type: "free", action: "pass" }); // OP=5
    s = receiveTrack(s, "HV-D03-006");
    const toss = grab(s, 1, "HV-D02-010"); // 手白 t1
    s = feed(s, { type: "deploy-toss", uid: toss });
    expect(effParam(db, s, toss, "toss")).toBe(-1); // Q338：1−2＝−1
  });

  it("D03-012／D03-013：指定區付ガッツ追加抽牌；トス宮侑→トス+1", () => {
    let s = setup(deckWith("HV-D03-012", "HV-D03-013", "HV-D03-006", "HV-D03-004", "HV-D03-005"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 4); // レシーブエリアの 4 ガッツ
    const kita = grab(s, 0, "HV-D03-006");
    s = feed(s, { type: "deploy-receive", uid: kita });
    const ev = grab(s, 0, "HV-D03-012");
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [kita] }); // 對象
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // レシーブエリアから4ガッツ
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, kita, "receive")).toBe(6); // 5+1
    expect(s.players[0].hand.length).toBe(h0 - 1 + 2); // play−1＋draw1＋draw1
    expect(s.players[0].receive.length).toBe(1); // 4 ガッツ付光，只剩北
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss");
    // D03-013：トス宮侑 → 抽1＋トス+1
    const atsumu = grab(s, 0, "HV-D03-004"); // vanilla 宮侑 t2
    s = feed(s, { type: "deploy-toss", uid: atsumu });
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-D03-013") });
    expect(effParam(db, s, atsumu, "toss")).toBe(3); // 2+1
  });
});

describe("稲荷崎：P02 強化系", () => {
  it("P01-065＋Q271：對手事件區 [=トス]/[=アタック] 卡 ≥5（雙 icon 計1張）→接球+6", () => {
    let s = setup(deckWith("HV-P01-065"), deckWith("HV-D03-013", "HV-D03-013", "HV-D03-013", "HV-D03-013", "HV-D03-013", "HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    // 對手事件區 5 張 D03-013（[=トス][=アタック]雙 icon 各計 1 張＝5 張 Q271）
    const placed: number[] = [];
    for (let i = 0; i < 5; i++) placed.push(placeInEventArea(s, 1, "HV-D03-013", placed));
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const kita = grab(s, 0, "HV-P01-065"); // r2
    s = feed(s, { type: "deploy-receive", uid: kita });
    expect(effParam(db, s, kita, "receive")).toBe(8); // 2+6（無 gate，強制）
  });

  it("P02-017＋Q359/Q361/Q363：付3ガッツ後判定棄牌區6種稲荷崎卡名；剛付的ガッツ算數、可回收 WS/MB", () => {
    let s = setup(deckWith("HV-P02-017", "HV-D03-006", "HV-D03-006", "HV-D03-005", "HV-D03-007", "HV-D03-008", "HV-D03-009", "HV-D03-010"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D03-006"); // 北（之後北也會在場上）
    // 棄牌區構造 5 種稲荷崎キャラ名；第 6 種（大耳）作為托球區ガッツ付出後才湊滿（Q361/Q363）
    for (const id of ["HV-D03-005", "HV-D03-007", "HV-D03-008", "HV-D03-009"]) placeInDrop(s, 0, id);
    placeInDrop(s, 0, "HV-D03-006"); // 北（第 5 種；場上那張是另一實體）
    seedStack(s, 0, "toss", 2);
    placeOnStack(s, 0, "toss", "HV-D03-010"); // 大耳（第 6 種）＝ガッツ頂、宮侑蓋上後成為ガッツ
    const atsumu = grab(s, 0, "HV-P02-017");
    s = feed(s, { type: "deploy-toss", uid: atsumu });
    s = feed(s, { type: "effect-confirm", accept: true }); // 3ガッツ（恰好3 自動付：filler×2＋大耳→棄牌區）
    expect(effParam(db, s, atsumu, "toss")).toBe(3); // 1+2（条件在付ガッツ後成立 Q361）
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 回收 WS/MB
    expect(s.pendingDecision!.candidates!.some((u) => s.cards[u] === "HV-D03-010")).toBe(true); // Q363：剛付的大耳（MB）可回收
    s = feed(s, { type: "effect-cards", uids: [s.pendingDecision!.candidates![0]!] });
  });

  it("P02-027＋Q372：斜め＝無狀態 cost；次の相手ターン中央攔網者ブロックP無視（DP 不加算）", () => {
    let s = setup(deckWith("HV-P02-027", "HV-D03-004", "HV-D03-006", "HV-D03-006", "HV-D03-005", "HV-D03-007", "HV-D03-008", "HV-D03-009", "HV-D03-010"), deckWith("HV-D01-004", "HV-D01-008", "HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D03-006");
    for (const id of ["HV-D03-005", "HV-D03-007", "HV-D03-008", "HV-D03-009", "HV-D03-010"]) placeInDrop(s, 0, id);
    placeInDrop(s, 0, "HV-D03-006"); // 6 種稲荷崎キャラ名
    const toss = grab(s, 0, "HV-D03-004");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const suna = grab(s, 0, "HV-P02-027");
    s = feed(s, { type: "deploy-attack", uid: suna });
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // tilt 恆可付（Q375）
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, suna, "attack")).toBe(4); // 2+2
    s = feed(s, { type: "free", action: "pass" }); // OP = 2+4 = 6
    // P1 攔網：中央山口 b3＋側邊澤村 b1 → DP 只算 1（Q372）
    s = feed(s, { type: "defense-choice", choice: "block" });
    const center = grab(s, 1, "HV-D01-004");
    const side = grab(s, 1, "HV-D01-008");
    s = feed(s, { type: "deploy-block", uids: [center, side], center });
    s = feed(s, { type: "free", action: "pass" });
    const judgeLog = s.log.map((l) => l.text).filter((t) => t.startsWith("DP 算出"));
    expect(judgeLog[judgeLog.length - 1]).toBe("DP 算出 = 1"); // 山口3 無視＋澤村1
    expect(s.lostBy).toBe(1); // 1 < 6 → 攔網失敗
  });

  it("P02-089：宮侑/宮治/宮兄弟各1回收；加滿3張→棄1", () => {
    let s = setup(deckWith("HV-P02-089", "HV-D03-004", "HV-D03-005", "HV-P02-077"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const a = placeInDrop(s, 0, "HV-D03-004");
    const o = placeInDrop(s, 0, "HV-D03-005");
    const t = placeInDrop(s, 0, "HV-P02-077");
    const ev = grab(s, 0, "HV-P02-089");
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "free", action: "event", uid: ev }); // [=ドロー]
    s = feed(s, { type: "effect-cards", uids: [a] });
    s = feed(s, { type: "effect-cards", uids: [o] });
    s = feed(s, { type: "effect-cards", uids: [t] });
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 加了3張 → 棄1
    s = feed(s, { type: "effect-cards", uids: [s.pendingDecision!.candidates![0]!] });
    expect(s.players[0].hand.length).toBe(h0 - 1 + 3 - 1);
  });
});

describe("稲荷崎：どん ぴしゃり連鎖（P02-087→016/020）", () => {
  it("Q356/Q357 前置：ガッツ雙子登場＋「どんぴしゃり登場」追加效果＋手札から限制／ワンタッチ無效", () => {
    let s = setup(
      deckWith("HV-P02-087", "HV-P01-063", "HV-P02-022", "HV-P02-016", "HV-P02-020", "HV-D03-006"),
      deckWith("HV-P01-060", "HV-D01-004", "HV-D01-008", "HV-D01-002"),
      1,
    );
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D03-006");
    // 托球：vanilla 宮侑；攻擊：vanilla 宮治；雙方堆下藏著 P02 版雙子＋足夠ガッツ
    seedStack(s, 0, "toss", 2);
    {
      const uid = grab(s, 0, "HV-P02-016");
      const ps = s.players[0];
      ps.hand.splice(ps.hand.indexOf(uid), 1);
      ps.toss.push(uid); // 將成為ガッツ
    }
    const atsumuV = grab(s, 0, "HV-P01-063");
    s = feed(s, { type: "deploy-toss", uid: atsumuV });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 2);
    {
      const uid = grab(s, 0, "HV-P02-020");
      const ps = s.players[0];
      ps.hand.splice(ps.hand.indexOf(uid), 1);
      ps.attack.push(uid);
    }
    const osamuV = grab(s, 0, "HV-P02-022");
    s = feed(s, { type: "deploy-attack", uid: osamuV });
    // 攻擊自由步驟：どんぴしゃり
    const ev = grab(s, 0, "HV-P02-087");
    s = feed(s, { type: "free", action: "event", uid: ev });
    // ▶ガッツの宮侑→トス登場
    expect(s.pendingDecision?.type).toBe("effect-cards");
    const miyaA = s.pendingDecision!.candidates!.find((u) => s.cards[u] === "HV-P02-016")!;
    s = feed(s, { type: "effect-cards", uids: [miyaA] });
    // ▶ガッツの宮治→アタック登場
    expect(s.pendingDecision?.type).toBe("effect-cards");
    const miyaO = s.pendingDecision!.candidates!.find((u) => s.cards[u] === "HV-P02-020")!;
    s = feed(s, { type: "effect-cards", uids: [miyaO] });
    // ▶稲荷崎キャラ1人のパラメータ1つ+1 → 對象選新宮侑、參數選トス
    expect(s.pendingDecision?.type).toBe("effect-cards");
    s = feed(s, { type: "effect-cards", uids: [miyaA] });
    expect(s.pendingDecision?.type).toBe("effect-option");
    const idx = s.pendingDecision!.options!.findIndex((o) => o.includes("托球"));
    s = feed(s, { type: "effect-option", index: idx });
    // CP：兩個 [=登場] 被動（016/020）任選順序，gate 各 3 ガッツ（恰好3 自動付）
    s = drainCp(s, true);
    expect(effParam(db, s, miyaA, "toss")).toBe(4); // 1 +1(▶3) +2(自身)
    expect(effParam(db, s, miyaO, "attack")).toBe(6); // 2 +3 +1(どんぴしゃり登場追加)
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 10, owner: 0 }); // 4+6
    // P1 回合：手札から攔網最多 2（fromHandOnly）；效果登場視角不受限
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "defense-choice" });
    expect(blockDeployMax(s, 1, "hand")).toBe(2);
    expect(blockDeployMax(s, 1, "effect")).toBe(3);
    // Q356：百沢（ワンタッチ）登場 → 技能無效（沒有 gate 確認）
    s = feed(s, { type: "defense-choice", choice: "block" });
    const momo = grab(s, 1, "HV-P01-060");
    const yama = grab(s, 1, "HV-D01-004");
    s = feed(s, { type: "deploy-block", uids: [momo, yama], center: yama });
    expect(s.pendingDecision?.type).toBe("free"); // 百沢的ワンタッチ被無效化（Q356），無確認決策
  });
});

describe("完成定義：稲荷崎牌組技能全生效的完整對局", () => {
  it("稲荷崎六名軸 vs 稲荷崎預組：啟發式 AI 對打完整場", async () => {
    const { heuristicAiDecision } = await import("../ai/heuristic");
    const deckA = (await import("../../data/decks/稲荷崎-六名軸.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    const deckB = (await import("../../data/decks/稲荷崎-預組.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    for (const seed of [3, 13]) {
      let s = createGame(db, { seed, decks: [deckA, deckB] as [string[], string[]] });
      for (let i = 0; i < 5000 && s.phase !== "gameOver"; i++) s = applyDecision(db, s, heuristicAiDecision(db, s));
      expect(s.phase).toBe("gameOver");
      for (const ps of s.players) {
        const all = [...ps.deck, ...ps.hand, ...ps.setArea, ...ps.drop, ...ps.eventArea, ...ps.serve, ...ps.blockCenter, ...ps.blockSides, ...ps.receive, ...ps.toss, ...ps.attack];
        expect(all.length).toBe(40);
        expect(new Set(all).size).toBe(40);
      }
    }
  });
});
