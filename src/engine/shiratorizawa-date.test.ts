// M3 收尾：白鳥沢／伊達工業／混合（音駒P01）技能測試＋官方判例（Q 編號＝docs/RULINGS.md）
import { describe, it, expect } from "vitest";
import { applyDecision, createGame, deployableUids, effParam } from "./engine";
import { db, deckWith, drainCp, feed, grab, placeDeckTop, placeInDrop, placeOnStack, seedStack, setup, serveWith, receiveTrack, FILLER } from "./testkit";

describe("混合（音駒 P01）", () => {
  it("P01-082＋Q311：+1 後滿足「5以上」→ 設為 7（修正層 set 依解決順序）", () => {
    let s = setup(deckWith("HV-P01-082", "HV-D01-011", "HV-D02-007"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const fukunaga = grab(s, 0, "HV-D02-007"); // 福永（音駒）r4
    s = feed(s, { type: "deploy-receive", uid: fukunaga });
    // 先 D01-011：+1 → 5（≤4 不成立 → 不再加）
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-D01-011") });
    expect(effParam(db, s, fukunaga, "receive")).toBe(5);
    // 再 P01-082 ▶2：5以上 → 設為 7（Q311）
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P01-082") });
    expect(s.pendingDecision?.type).toBe("effect-option");
    s = feed(s, { type: "effect-option", index: 1 });
    expect(effParam(db, s, fukunaga, "receive")).toBe(7);
  });

  it("P01-021＋Q224：攻擊+3＋同一區「名異なる音駒のガッツ2枚」回收（單張區不成立）", () => {
    let s = setup(deckWith("HV-P01-021", "HV-D02-005", "HV-D02-006", "HV-D02-007"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D02-005"); // 海 r5（音駒）
    // 接球區構造：[山本, 福永]＝兩張名異なる音駒ガッツ（海 蓋上後）；攻擊區 3 ガッツ供 cost
    {
      const ps = s.players[0];
      const a = grab(s, 0, "HV-D02-006");
      ps.hand.splice(ps.hand.indexOf(a), 1);
      ps.receive.unshift(a);
      const b = grab(s, 0, "HV-D02-007");
      ps.hand.splice(ps.hand.indexOf(b), 1);
      ps.receive.unshift(b);
    }
    const toss = grab(s, 0, FILLER); // 田中 t1
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 3);
    const kuroo = grab(s, 0, "HV-P01-021");
    s = feed(s, { type: "deploy-attack", uid: kuroo });
    s = feed(s, { type: "effect-confirm", accept: true }); // 3ガッツ自動付
    expect(effParam(db, s, kuroo, "attack")).toBe(4); // 1+3
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 名異なる音駒 2 枚
    const pair = s.pendingDecision!.candidates!.filter((u) => ["HV-D02-006", "HV-D02-007"].includes(s.cards[u]!));
    expect(pair.length).toBe(2);
    s = feed(s, { type: "effect-cards", uids: pair });
    expect(s.players[0].hand).toEqual(expect.arrayContaining(pair));
  });

  it("P01-023＋Q228：レシーブキャラ被音駒キャラ蓋上→棄自身（ガッツ）→新キャラ+2", () => {
    let s = setup(deckWith("HV-P01-023", "HV-D02-005"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const yaku = placeOnStack(s, 0, "receive", "HV-P01-023"); // 既存レシーブキャラ＝夜久
    const kai = grab(s, 0, "HV-D02-005"); // 海（音駒、非夜久）
    s = feed(s, { type: "deploy-receive", uid: kai });
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // 被蓋觸發（†1-2-15-2-1）
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].drop).toContain(yaku); // cost：自身（ガッツ）→棄牌
    expect(effParam(db, s, kai, "receive")).toBe(7); // 5+2
  });

  it("P01-084＋Q314：トス孤爪→次の相手ターン、手札から MB のアタックキャラ登場不可", () => {
    let s = setup(deckWith("HV-P01-084", "HV-P01-017", "HV-D02-005"), deckWith("HV-D01-001", "HV-D01-006", "HV-P01-011", "HV-D01-009", "HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D02-005");
    const kenma = grab(s, 0, "HV-P01-017"); // 孤爪（vanilla）t2
    s = feed(s, { type: "deploy-toss", uid: kenma });
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P01-084") });
    expect(effParam(db, s, kenma, "toss")).toBe(3); // 2+1
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 0, FILLER);
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    // P1 接球軸到攻擊：MB（日向 D01-001）不可登場、WS（田中）可
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-receive", uid: grab(s, 1, "HV-P01-011") }); // 西谷 r6 ≥ OP6
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-toss", uid: grab(s, 1, "HV-D01-009") }); // 菅原（D01-002 已用於發球）
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    grab(s, 1, "HV-D01-001"); // MB
    grab(s, 1, "HV-D01-006"); // WS
    const legal = deployableUids(db, s, 1, "attack");
    expect(legal.some((u) => s.cards[u] === "HV-D01-001")).toBe(false); // Q314：MB 禁止
    expect(legal.some((u) => s.cards[u] === "HV-D01-006")).toBe(true);
  });
});

describe("伊達工業", () => {
  it("P02-039＋Q393：トス伊達S→次の相手ターン、DP≤6 でブロック失敗（追加失敗條件 †5-15-3）", () => {
    let s = setup(deckWith("HV-P02-039", "HV-P02-040", "HV-D02-005"), deckWith("HV-D01-004", "HV-D01-008"), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D02-005");
    const koganegawa = grab(s, 0, "HV-P02-040"); // 黄金川（伊達S）t1
    s = feed(s, { type: "deploy-toss", uid: koganegawa });
    s = feed(s, { type: "free", action: "pass" });
    const futakuchi = grab(s, 0, "HV-P02-039"); // a1
    s = feed(s, { type: "deploy-attack", uid: futakuchi }); // 強制被動（無 gate）→ 限制成立
    s = feed(s, { type: "free", action: "pass" }); // OP = 1+1 = 2
    // P1 攔網：山口 b3＋澤村 b1 → DP4 ≥ OP2 但 ≤6 → 失敗（Q393 判定時點）
    s = feed(s, { type: "defense-choice", choice: "block" });
    const c1 = grab(s, 1, "HV-D01-004");
    const c2 = grab(s, 1, "HV-D01-008");
    s = feed(s, { type: "deploy-block", uids: [c1, c2], center: c1 });
    s = feed(s, { type: "free", action: "pass" });
    expect(s.lostBy).toBe(1);
  });

  it("P02-041＋Q396/Q397：棄自身→デッキ頂3全伊達→棄牌區のスキルなし伊達をサイドブロッカー登場", () => {
    let s = setup(deckWith("HV-P02-041", "HV-P02-044", "HV-P02-045", "HV-P02-040", "HV-P02-043"), deckWith("HV-D01-009", "HV-D01-006", "HV-D01-002"), 0);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-006"); // P1 接球
    s = feed(s, { type: "deploy-toss", uid: grab(s, 1, "HV-D01-009") });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-attack", uid: grab(s, 1, "HV-D01-002") });
    s = feed(s, { type: "free", action: "pass" }); // P1 攻擊 OP
    s = feed(s, { type: "defense-choice", choice: "block" });
    const center = grab(s, 0, "HV-P02-043"); // 茂庭 b3（中央）
    s = feed(s, { type: "deploy-block", uids: [center], center });
    // 自由步驟：作並（[=ブロックフェイズ][=手札]）；牌組頂構造 3 張伊達（含 vanilla 笹谷/小原）
    placeDeckTop(s, 0, "HV-P02-040");
    placeDeckTop(s, 0, "HV-P02-045");
    const sasaya = placeDeckTop(s, 0, "HV-P02-044"); // 笹谷（vanilla＝スキルなし）
    const sakunami = grab(s, 0, "HV-P02-041");
    s = feed(s, { type: "free", action: "skill", uid: sakunami, skillIndex: 0 });
    expect(s.players[0].drop).toContain(sakunami); // cost：自身
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 棄的 3 張全伊達 → 選スキルなし伊達（Q397 含剛棄的）
    expect(s.pendingDecision!.candidates!).toContain(sasaya);
    s = feed(s, { type: "effect-cards", uids: [sasaya] });
    expect(s.players[0].blockSides).toContain(sasaya);
    s = feed(s, { type: "free", action: "pass" });
    const dpLog = s.log.map((l) => l.text).filter((t) => t.startsWith("DP 算出"));
    expect(dpLog[dpLog.length - 1]).toBe("DP 算出 = 6"); // 茂庭3＋笹谷3
  });

  it("P02-037：手札からサイドブロッカー登場→自身デッキ底→棄牌區の青根を side 登場＋ブロックP=3（set）", () => {
    let s = setup(deckWith("HV-P02-037", "HV-P01-054", "HV-P02-043", "HV-D02-005"), deckWith("HV-D01-009", "HV-D01-006", "HV-D01-002"), 0);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-006");
    s = feed(s, { type: "deploy-toss", uid: grab(s, 1, "HV-D01-009") });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-attack", uid: grab(s, 1, "HV-D01-002") });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "block" });
    const aoneInDrop = placeInDrop(s, 0, "HV-P01-054"); // 棄牌區的青根（base b2）
    const center = grab(s, 0, "HV-P02-043");
    const aone = grab(s, 0, "HV-P02-037");
    s = feed(s, { type: "deploy-block", uids: [center, aone], center }); // 青根＝side
    s = drainCp(s, true); // 青根 gate（cond 成立）→ 自身デッキ底 → 棄牌區青根 side 登場＋set 3；新青根的 P01-054 gate 無ガッツ自動跳過
    expect(s.players[0].deck[s.players[0].deck.length - 1]).toBe(aone); // 自身置底
    expect(s.players[0].blockSides).toContain(aoneInDrop);
    expect(effParam(db, s, aoneInDrop, "block")).toBe(3); // set 3（base 2）
  });
});

describe("白鳥沢", () => {
  it("P02-050＋Q404/Q405：全員白鳥沢＋2ガッツ全S→トス+2＋任意區の白鳥沢ガッツ1枚をアタックエリアのガッツに", () => {
    let s = setup(deckWith("HV-P02-050", "HV-P02-052", "HV-P02-052", "HV-P01-017", "HV-P01-017"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002"); // P1 發球 serve1
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    // 接球區 [大平2(將成白鳥沢ガッツ), 大平1(キャラ)]；托球區 [孤爪, 孤爪]（S ガッツ供 cost）
    const ohira2 = placeOnStack(s, 0, "receive", "HV-P02-052");
    const ohira1 = grab(s, 0, "HV-P02-052", [ohira2]);
    s = feed(s, { type: "deploy-receive", uid: ohira1 }); // 蓋住大平2 → 大平2 成ガッツ（白鳥沢）
    s = feed(s, { type: "free", action: "pass" }); // 大平 r5 ≥ 1 成功
    {
      const ps = s.players[0];
      for (let i = 0; i < 2; i++) {
        const k = grab(s, 0, "HV-P01-017", ps.toss);
        ps.hand.splice(ps.hand.indexOf(k), 1);
        ps.toss.push(k); // 孤爪（S）→ 白布蓋上後成ガッツ
      }
    }
    const shirabu = grab(s, 0, "HV-P02-050");
    s = feed(s, { type: "deploy-toss", uid: shirabu });
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // allCharas 白鳥沢 ✓（接球大平＋托球白布）
    s = feed(s, { type: "effect-confirm", accept: true }); // 2ガッツ（恰好2＝孤爪×2 自動付、全 S）
    expect(effParam(db, s, shirabu, "toss")).toBe(3); // 1+2
    expect(s.pendingDecision?.type).toBe("effect-cards"); // paidGutsAll S ✓ → 移動白鳥沢ガッツ（Q405 任意區）
    expect(s.pendingDecision!.candidates!).toContain(ohira2);
    s = feed(s, { type: "effect-cards", uids: [ohira2] });
    expect(s.players[0].attack[0]).toBe(ohira2); // 進攻擊區底＝ガッツ
  });

  it("P02-048：擲硬幣→正面 block+4／反面 自分のデッキ3枚ドロップ（Q401 可能な限り）", () => {
    let s = setup(deckWith("HV-P02-048", "HV-D02-005"), deckWith("HV-D01-008", "HV-D01-009", "HV-D01-006", "HV-D01-002"), 0);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    s = feed(s, { type: "deploy-toss", uid: grab(s, 1, "HV-D01-009") });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-attack", uid: grab(s, 1, "HV-D01-006") });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "block" });
    const tendou = grab(s, 0, "HV-P02-048"); // b2
    const deckBefore = s.players[0].deck.length;
    s = feed(s, { type: "deploy-block", uids: [tendou], center: tendou });
    s = feed(s, { type: "effect-confirm", accept: true }); // 投げれば使える
    const heads = effParam(db, s, tendou, "block") === 6;
    const tails = s.players[0].deck.length === deckBefore - 3;
    expect(heads || tails).toBe(true); // 兩種結果擇一（內嵌 RNG）
    expect(s.log.some((l) => l.text.startsWith("擲硬幣"))).toBe(true);
  });
});

describe("完成定義：白鳥沢／伊達工業／混合 完整對局", () => {
  it("白鳥沢白板軸 vs 伊達攔網軸；伊達攔網軸改 vs 混合垃圾場", async () => {
    const { heuristicAiDecision } = await import("../ai/heuristic");
    const load = async (name: string) => ((await import(`../../data/decks/${name}.json`)) as { default: { cards: { id: string; count: number }[] } }).default.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);
    const pairs: [string, string][] = [
      ["白鳥沢-白板軸", "伊達工業-攔網軸"],
      ["伊達工業-攔網軸改", "混合學校-垃圾場"],
    ];
    for (const [a, b] of pairs) {
      const deckA = await load(a);
      const deckB = await load(b);
      for (const seed of [8, 23]) {
        let s = createGame(db, { seed, decks: [deckA, deckB] as [string[], string[]] });
        for (let i = 0; i < 5000 && s.phase !== "gameOver"; i++) s = applyDecision(db, s, heuristicAiDecision(db, s));
        expect(s.phase).toBe("gameOver");
        for (const ps of s.players) {
          const all = [...ps.deck, ...ps.hand, ...ps.setArea, ...ps.drop, ...ps.eventArea, ...ps.serve, ...ps.blockCenter, ...ps.blockSides, ...ps.receive, ...ps.toss, ...ps.attack];
          expect(all.length).toBe(40);
          expect(new Set(all).size).toBe(40);
        }
      }
    }
  });
});
