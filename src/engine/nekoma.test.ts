// M3 續：音駒預組（HV-D02）技能卡逐張行為測試＋官方判例（Q 編號＝docs/RULINGS.md）
import { describe, it, expect } from "vitest";
import { applyDecision, blockDeployMax, createGame, effParam } from "./engine";
import { db, deckWith, drainCp, feed, grab, placeDeckTop, placeOnStack, seedStack, setup, serveWith, receiveTrack } from "./testkit";

describe("音駒：登場被動（gate 系）", () => {
  it("D02-001＋Q192：孤爪 2ガッツ→トス+1＋次の相手ターン、アタック登場毎に−2（可為負）", () => {
    let s = setup(deckWith("HV-D02-001", "HV-D02-005", "HV-D02-006"), deckWith("HV-D02-005", "HV-D02-005", "HV-D02-010", "HV-D01-002"), 1);
    s = serveWith(s, "HV-D02-005"); // P1 海 serve1
    s = receiveTrack(s, "HV-D02-005"); // P0 海 r5
    seedStack(s, 0, "toss", 2);
    const kenma = grab(s, 0, "HV-D02-001");
    s = feed(s, { type: "deploy-toss", uid: kenma });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, kenma, "toss")).toBe(2); // 1+1
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 0, "HV-D02-006"); // 山本 a3
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 5, owner: 0 }); // 2+3
    // P1 接球軸：攻擊登場 → −2
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const rcv = grab(s, 1, "HV-D02-005");
    s = feed(s, { type: "deploy-receive", uid: rcv }); // 海 r5 ≥ 5 成功
    s = feed(s, { type: "free", action: "pass" });
    const toss = grab(s, 1, "HV-D02-010"); // 手白 t1
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const kage = grab(s, 1, "HV-D01-002"); // 影山 a1
    s = feed(s, { type: "deploy-attack", uid: kage });
    expect(effParam(db, s, kage, "attack")).toBe(-1); // Q192：1−2＝−1
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 0, owner: 1 }); // 1＋(−1)
  });

  it("D02-003／D02-009：夜久 棄1→レシーブ+2；芝山 2ガッツ→抽1", () => {
    let s = setup(deckWith("HV-D02-003"), deckWith("HV-D01-004"), 1);
    s = serveWith(s, "HV-D01-004"); // 山口 serve5
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const yaku = grab(s, 0, "HV-D02-003"); // r5
    s = feed(s, { type: "deploy-receive", uid: yaku });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 1) });
    expect(effParam(db, s, yaku, "receive")).toBe(7); // 5+2 ≥ 5
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss");

    // 芝山（獨立局）
    let t = setup(deckWith("HV-D02-009"), deckWith("HV-D01-002"), 1);
    t = serveWith(t, "HV-D01-002");
    t = feed(t, { type: "defense-choice", choice: "receive" });
    t = feed(t, { type: "free", action: "pass" });
    seedStack(t, 0, "receive", 2);
    const shibayama = grab(t, 0, "HV-D02-009");
    const h0 = t.players[0].hand.length;
    t = feed(t, { type: "deploy-receive", uid: shibayama });
    t = feed(t, { type: "effect-confirm", accept: true });
    expect(t.players[0].hand.length).toBe(h0); // −1登場 +1抽
  });
});

describe("音駒：D02-004 灰羽リエーフ（攻擊區→サイドブロッカー移動）", () => {
  /** 構造到 P0 攔網回合、攻擊區有灰羽（帶 2 ガッツ）的局面 */
  function toLevBlockTurn(extraA: string[] = []) {
    let s = setup(deckWith("HV-D02-004", "HV-D02-002", "HV-D02-005", ...extraA), deckWith("HV-D02-005", "HV-D02-010", "HV-D01-002"), 0);
    s = serveWith(s, "HV-D02-005"); // P0 海 serve1
    s = receiveTrack(s, "HV-D02-005"); // P1 海 r5
    let toss = grab(s, 1, "HV-D02-010");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-002"); // 影山 a1 → OP=2
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    // P0 攔網回合：攻擊區構造 [ガッツ×2, 灰羽]
    s = feed(s, { type: "defense-choice", choice: "block" });
    seedStack(s, 0, "attack", 2);
    const lev = placeOnStack(s, 0, "attack", "HV-D02-004");
    return { s, lev };
  }

  it("Q195：我方攔網登場觸發→付攻擊區 2ガッツ→灰羽移動為サイドブロッカー（DP 合計）", () => {
    let { s, lev } = toLevBlockTurn();
    const kuroo = grab(s, 0, "HV-D02-002"); // 黒尾 b3 當中央
    expect(s.players[0].attack.length).toBe(3); // ガッツ2＋灰羽
    s = feed(s, { type: "deploy-block", uids: [kuroo], center: kuroo });
    // CP：黒尾自身被動＋灰羽 allyDeploy 兩個待機 → 任選順序解決；黒尾 gate 無ガッツ自動跳過、灰羽 gate 接受
    s = drainCp(s, true);
    expect(s.players[0].attack.length).toBe(0); // 2ガッツ→棄牌（Q195 從攻擊區付）＋灰羽移走 → 攻擊區清空
    expect(s.players[0].blockSides).toContain(lev);
    s = feed(s, { type: "free", action: "pass" });
    // DP＝黒尾3＋灰羽2＝5 ≥ OP2 → 攔網成功（自分のブロック OP=0、輪到對手）；側邊灰羽於攔網終了進棄牌 †5-7-2⑦
    expect(s.op).toMatchObject({ value: 0, owner: 0, source: "block" });
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "defense-choice" });
    expect(s.players[0].drop).toContain(lev);
  });

  it("Q196：登場限制（上限1）下 cost 照付但灰羽不移動", () => {
    let { s, lev } = toLevBlockTurn();
    s.restrictions.push({ player: 0, area: "block", maxCount: 1, setNo: s.setNo, activeTurn: s.turnNo, desc: "測試限制（ブロード攻撃）" });
    const kuroo = grab(s, 0, "HV-D02-002");
    const gutsBefore = s.players[0].attack.length; // ガッツ2＋灰羽=3
    s = feed(s, { type: "deploy-block", uids: [kuroo], center: kuroo }); // 用掉唯一額度
    s = drainCp(s, true);
    expect(s.players[0].attack.length).toBe(gutsBefore - 2); // ガッツ照付（Q196）
    expect(s.players[0].attack[s.players[0].attack.length - 1]).toBe(lev); // 但灰羽留在攻擊區
    expect(s.players[0].blockSides).toEqual([]);
  });
});

describe("音駒：事件卡", () => {
  it("D02-011：抽1＋▶選一使用（黒尾ブロッカー block+1）", () => {
    let s = setup(deckWith("HV-D02-002", "HV-D02-011", "HV-D02-005"), deckWith("HV-D02-005", "HV-D02-010", "HV-D01-002"), 0);
    s = serveWith(s, "HV-D02-005");
    s = receiveTrack(s, "HV-D02-005");
    const toss = grab(s, 1, "HV-D02-010");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-002");
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" }); // OP=2
    s = feed(s, { type: "defense-choice", choice: "block" });
    const kuroo = grab(s, 0, "HV-D02-002");
    s = feed(s, { type: "deploy-block", uids: [kuroo], center: kuroo });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false }); // 黒尾自身 gate 跳過
    const ev = grab(s, 0, "HV-D02-011");
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.players[0].hand.length).toBe(h0); // −1 play +1 draw
    expect(s.pendingDecision?.type).toBe("effect-option");
    expect(s.pendingDecision!.options!.length).toBe(3); // ▶×2＋不使用
    s = feed(s, { type: "effect-option", index: 0 }); // 黒尾 block+1（對象唯一→自動）
    expect(effParam(db, s, kuroo, "block")).toBe(4); // 3+1
    s = feed(s, { type: "free", action: "pass" });
    // DP4 ≥ OP2 → 攔網成功 → 自分のブロック OP=0、輪到對手
    expect(s.op).toMatchObject({ value: 0, owner: 0, source: "block" });
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "defense-choice" });
  });

  it("D02-012＋Q197/Q198：抽1→看頂3（不足看到沒有為止）→灰羽/犬岡擇一加入手牌、其餘置底", () => {
    let s = setup(deckWith("HV-D02-012", "HV-D02-004", "HV-D02-008", "HV-D02-005"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    // draw phase 自由步驟（[=ドロー]）：構造牌組頂＝[抽掉的卡, 灰羽, 犬岡, filler]
    const inuoka = placeDeckTop(s, 0, "HV-D02-008");
    const lev = placeDeckTop(s, 0, "HV-D02-004");
    // 注意：進入 draw phase 時已抽 1（牌組頂被拿走），所以在 free step 構造的頂 3 張就是看的 3 張
    const ev = grab(s, 0, "HV-D02-012");
    const deckLen = s.players[0].deck.length;
    s = feed(s, { type: "free", action: "event", uid: ev }); // 抽1（拿走灰羽上面那張…不，灰羽就在頂→抽走灰羽？）
    // → 設計修正：play 時先抽 1（抽走 lev），再看 3。重新驗證實際行為：
    expect(s.pendingDecision?.type).toBe("effect-cards");
    const cands = s.pendingDecision!.candidates!;
    expect(cands).toContain(inuoka); // 犬岡在看的 3 張中
    expect(cands).not.toContain(lev); // 灰羽被先抽走進手牌（draw 1 在看牌之前）
    expect(s.players[0].hand).toContain(lev);
    // Q198：upTo 1 → 選 2 張要拒絕（此情境只有犬岡 1 張候選，驗 max=1）
    expect(s.pendingDecision!.max).toBe(1);
    s = feed(s, { type: "effect-cards", uids: [inuoka] });
    expect(s.players[0].hand).toContain(inuoka);
    expect(s.players[0].deck.length).toBe(deckLen - 2); // 抽1＋取1；看過未取的回到牌組
    // 看過未取的 2 張置底
    const bottom2 = s.players[0].deck.slice(-2);
    expect(bottom2.every((u) => !s.players[0].hand.includes(u))).toBe(true);

    // Q197：牌組只剩 3 → 抽 1 後看 2
    let t = setup(deckWith("HV-D02-012", "HV-D02-004", "HV-D02-008"), deckWith("HV-D01-002"), 1);
    t = serveWith(t, "HV-D01-002");
    t = feed(t, { type: "defense-choice", choice: "receive" });
    const ev2 = grab(t, 0, "HV-D02-012");
    const lev2 = placeDeckTop(t, 0, "HV-D02-004");
    {
      const ps = t.players[0]; // 牌組縮到 3 張（其餘搬棄牌區）
      while (ps.deck.length > 3) ps.drop.push(ps.deck.splice(1, 1)[0]!);
    }
    t = feed(t, { type: "free", action: "event", uid: ev2 });
    // 抽 1（lev2 進手牌）→ 剩 2 → 看 2（Q197）
    expect(t.players[0].hand).toContain(lev2);
    if (t.pendingDecision?.type === "effect-cards") {
      expect(t.pendingDecision.candidates!.length).toBeLessThanOrEqual(2);
      t = feed(t, { type: "effect-cards", uids: [] });
    }
    expect(t.players[0].deck.length).toBe(2);
  });
});

describe("完成定義：音駒預組技能全生效的完整對局", () => {
  it("音駒預組 vs 烏野預組：啟發式 AI 對打完整場", async () => {
    const { heuristicAiDecision } = await import("../ai/heuristic");
    const deckA = (await import("../../data/decks/音駒-預組.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    const deckB = (await import("../../data/decks/烏野-預組.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    for (const seed of [7, 21]) {
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
