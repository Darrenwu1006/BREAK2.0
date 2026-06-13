// M3 續：梟谷技能卡逐張行為測試＋官方判例（Q 編號＝docs/RULINGS.md）
import { describe, it, expect } from "vitest";
import { applyDecision, createGame, effParam } from "./engine";
import { db, deckWith, feed, grab, placeDeckTop, placeOnStack, seedStack, setup, serveWith, receiveTrack, FILLER } from "./testkit";

describe("梟谷：登場被動", () => {
  it("P01-043＋Q249/Q250：手札登場＋全員梟谷＋攻擊區ガッツ奇數→アタック+5", () => {
    let s = setup(deckWith("HV-P01-043", "HV-P01-050", "HV-P01-046"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-P01-050"); // 小見 r6（梟谷）
    const akaashi = grab(s, 0, "HV-P01-046"); // vanilla 赤葦 t2（梟谷）
    s = feed(s, { type: "deploy-toss", uid: akaashi });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 1); // ガッツ 1＝奇數（Q250：使用時點）
    const bokuto = grab(s, 0, "HV-P01-043"); // a0
    s = feed(s, { type: "deploy-attack", uid: bokuto });
    expect(s.pendingDecision?.type).toBe("effect-confirm");
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, bokuto, "attack")).toBe(5); // 0+5
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 7, owner: 0 }); // 2+5
  });

  it("P01-045＋Q251/Q252：トス＋アタック合計4ガッツ（任意組合）；剛付的木兎可回收", () => {
    let s = setup(deckWith("HV-P01-045", "HV-P01-044", "HV-P01-050"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-P01-050");
    // 托球區 [filler, 木兎]（赤葦蓋上後＝2 ガッツ）＋攻擊區 3 ガッツ → 合計 5 選 4
    seedStack(s, 0, "toss", 1);
    const bokutoGuts = placeOnStack(s, 0, "toss", "HV-P01-044");
    seedStack(s, 0, "attack", 3);
    placeOnStack(s, 0, "attack", FILLER); // 頂牌＝キャラ，下面 3 張才是ガッツ
    const akaashi = grab(s, 0, "HV-P01-045"); // t1
    s = feed(s, { type: "deploy-toss", uid: akaashi });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 5 選 4（Q251 任意組合）
    expect(s.pendingDecision!.candidates!.length).toBe(5);
    const pay = [bokutoGuts, ...s.pendingDecision!.candidates!.filter((u) => u !== bokutoGuts).slice(0, 3)];
    s = feed(s, { type: "effect-cards", uids: pay });
    expect(effParam(db, s, akaashi, "toss")).toBe(3); // 1+2
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 回收木兎（Q252：剛付的）
    expect(s.pendingDecision!.candidates!).toContain(bokutoGuts);
    s = feed(s, { type: "effect-cards", uids: [bokutoGuts] });
    expect(s.players[0].hand).toContain(bokutoGuts);
  });

  it("P01-047＋Q253：被梟谷キャラ蓋上（ガッツ狀態觸發 †1-2-15-2-1）→棄1→そのキャラ+1；與新卡技能任選順序", () => {
    let s = setup(deckWith("HV-P01-047", "HV-P01-043", "HV-P01-050", "HV-P01-046"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-P01-050");
    const akaashi = grab(s, 0, "HV-P01-046");
    s = feed(s, { type: "deploy-toss", uid: akaashi });
    s = feed(s, { type: "free", action: "pass" });
    placeOnStack(s, 0, "attack", "HV-P01-047"); // 既存アタックキャラ＝木葉
    const bokuto = grab(s, 0, "HV-P01-043");
    s = feed(s, { type: "deploy-attack", uid: bokuto }); // 蓋上 → 兩個待機（Q253 任選順序）
    expect(s.pendingDecision?.type).toBe("resolve-pending");
    expect(s.pendingDecision!.candidates!.length).toBe(2);
    // 先解決木葉（被蓋觸發）
    const konoha = s.players[0].attack[s.players[0].attack.length - 2]!;
    const konohaItem = s.pendingQueue.find((it) => it.source === konoha)!;
    s = feed(s, { type: "resolve-pending", id: konohaItem.id });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    expect(effParam(db, s, bokuto, "attack")).toBe(1); // 0+1（そのキャラ＝木兎）
    // 再解決木兎自身（ガッツ：木葉＋… 攻擊區 guts=1 奇數 ✓）
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, bokuto, "attack")).toBe(6); // +5
  });

  it("P01-051＋Q255/Q257：OP≥4＋デッキ頂棄1（梟谷）→ワンタッチ(3)；跳過後未解決技能消滅", () => {
    let s = setup(deckWith("HV-P01-051", "HV-D01-003", "HV-P01-044", "HV-P01-050"), deckWith("HV-D01-008", "HV-D01-009", "HV-D01-006"), 0);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    let toss = grab(s, 1, "HV-D01-009"); // 菅原 t2
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-006"); // 田中 a3 → OP=5 ≥4
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "block" });
    placeDeckTop(s, 0, "HV-P01-044"); // 頂＝木兎（梟谷）→ ワンタッチ成立
    const washio = grab(s, 0, "HV-P01-051");
    const tsukki = grab(s, 0, "HV-D01-003"); // 第二攔網者（有技能、待機後將被跳過消滅 Q257）
    s = feed(s, { type: "deploy-block", uids: [washio, tsukki], center: washio });
    // 兩個待機 → 先解決鷲尾
    expect(s.pendingDecision?.type).toBe("resolve-pending");
    const washioItem = s.pendingQueue.find((it) => it.source === washio)!;
    s = feed(s, { type: "resolve-pending", id: washioItem.id });
    s = feed(s, { type: "effect-confirm", accept: true });
    // ワンタッチ(3)：OP 5−3=2、跳過攔網→自分のドローフェイズ（Q255 有抽牌）；月島的待機消滅（Q257）
    expect(s.phase).toBe("draw");
    expect(s.turnPlayer).toBe(0);
    expect(s.op).toMatchObject({ value: 2, owner: 1, source: "attack" });
    expect(s.pendingQueue.length).toBe(0); // Q257
    s = feed(s, { type: "free", action: "pass" });
    const rcv = grab(s, 0, "HV-P01-050"); // r6 ≥ 2
    s = feed(s, { type: "deploy-receive", uid: rcv });
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss");
  });
});

describe("梟谷：事件卡", () => {
  it("P01-089＋Q323：看頂3→梟谷1枚まで（可選不加→全部置底）", () => {
    let s = setup(deckWith("HV-P01-089", "HV-P01-044"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const bokuto = placeDeckTop(s, 0, "HV-P01-044"); // 看的 3 張中有梟谷
    const ev = grab(s, 0, "HV-P01-089");
    const deckLen = s.players[0].deck.length;
    s = feed(s, { type: "free", action: "event", uid: ev }); // [=ドロー]
    expect(s.pendingDecision?.type).toBe("effect-cards");
    expect(s.pendingDecision!.candidates!).toContain(bokuto);
    s = feed(s, { type: "effect-cards", uids: [] }); // Q323：選擇不加
    expect(s.players[0].hand).not.toContain(bokuto);
    expect(s.players[0].deck.length).toBe(deckLen); // 全部回牌組（置底）
    expect(s.players[0].deck.slice(-3)).toContain(bokuto);
  });

  it("P01-090＋Q324：全員梟谷→次の相手ターン、相手ロスト時→手牌補到7（Lost 時點不屬於任何回合）", () => {
    let s = setup(deckWith("HV-P01-090", "HV-P01-050", "HV-P01-046", "HV-P01-044"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-P01-050");
    const akaashi = grab(s, 0, "HV-P01-046");
    s = feed(s, { type: "deploy-toss", uid: akaashi });
    s = feed(s, { type: "free", action: "pass" });
    const bokuto = grab(s, 0, "HV-P01-044"); // a3
    s = feed(s, { type: "deploy-attack", uid: bokuto });
    const ev = grab(s, 0, "HV-P01-090");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [bokuto] }); // 攻擊+1
    expect(effParam(db, s, bokuto, "attack")).toBe(4);
    s = feed(s, { type: "free", action: "pass" }); // OP = 2+4 = 6
    // P1：不登場接球 → Lost → 監看觸發 → P0 補到 7
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-receive", uid: null });
    expect(s.lostBy).toBe(1);
    expect(s.players[0].hand.length).toBe(7); // Q324：lostSet 步驟②解決
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "pick-set-card" });
  });

  it("P01-091＋Q325：接球回合棄殘留的梟谷ブロックキャラ→相手アタックOP−1（0→−1）", () => {
    let s = setup(deckWith("HV-P01-091", "HV-P01-044", "HV-P01-050"), deckWith("HV-D01-008", "HV-D01-010", "HV-D01-005"), 0);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    let toss = grab(s, 1, "HV-D01-010"); // 東峰 t0
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-005"); // 西谷 a0 → OP=0
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 0, owner: 1, source: "attack" });
    // P0 接球回合：中央攔網位殘留木兎（前回合構造）→ [=レシーブ] 事件
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const bokuto = placeOnStack(s, 0, "blockCenter", "HV-P01-044"); // 殘留的梟谷ブロックキャラ
    const rcv = grab(s, 0, "HV-P01-050"); // 小見 r6
    s = feed(s, { type: "deploy-receive", uid: rcv });
    const ev = grab(s, 0, "HV-P01-091");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [rcv] }); // 接球+1 對象
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // 棄攔網者使える？
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].drop).toContain(bokuto); // cost：木兎進棄牌
    expect(s.op).toMatchObject({ value: -1, owner: 1 }); // Q325：0−1＝−1
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss"); // DP 7 ≥ −1 → 接球成功
  });
});

describe("完成定義：梟谷牌組技能全生效的完整對局", () => {
  it("梟谷高爆發軸 vs 梟谷爆發軸二：啟發式 AI 對打完整場", async () => {
    const { heuristicAiDecision } = await import("../ai/heuristic");
    const deckA = (await import("../../data/decks/梟谷-高爆發軸.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    const deckB = (await import("../../data/decks/梟谷-爆發軸二.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    for (const seed of [9, 27]) {
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
