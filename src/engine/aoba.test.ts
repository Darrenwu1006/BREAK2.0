// M3 續：青葉城西技能卡逐張行為測試＋官方判例（Q 編號＝docs/RULINGS.md）
import { describe, it, expect } from "vitest";
import { applyDecision, createGame, effParam } from "./engine";
import { db, deckWith, feed, grab, placeDeckTop, placeInDrop, placeOnStack, seedStack, setHandSize, setup, serveWith, receiveTrack, FILLER } from "./testkit";

describe("青葉城西：登場被動", () => {
  it("P01-033＋Q238：棄青葉城西手牌→任一參數+1；對手手牌≥4→對手棄1（對手自選）", () => {
    let s = setup(deckWith("HV-P01-033", "HV-P01-038", "HV-P01-040"), deckWith("HV-D01-002"), 0);
    const oikawa = grab(s, 0, "HV-P01-033");
    grab(s, 0, "HV-P01-038"); // 確保手上有青葉城西卡可棄
    s = feed(s, { type: "deploy-serve", uid: oikawa });
    expect(s.pendingDecision?.type).toBe("effect-confirm");
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") {
      // cost：只能棄青葉城西的卡（候選已過濾）
      for (const u of s.pendingDecision.candidates!) expect(db.get(s.cards[u]!)!.affiliations).toContain("青葉城西");
      s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    }
    expect(s.pendingDecision?.type).toBe("effect-option"); // Q238：選任一參數
    const idx = s.pendingDecision!.options!.findIndex((o) => o.includes("發球"));
    s = feed(s, { type: "effect-option", index: idx });
    expect(effParam(db, s, oikawa, "serve")).toBe(6); // 5+1
    // 對手手牌 6 ≥ 4 → 對手棄 1（決策者＝對手）
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "effect-cards" });
    const h1 = s.players[1].hand.length;
    s = feed(s, { type: "effect-cards", uids: [s.pendingDecision!.candidates![0]!] });
    expect(s.players[1].hand.length).toBe(h1 - 1);
  });

  it("P01-035＋Q240/Q241：對手手牌≤4→次回合「手札に加えられない」（檢索置底、事件抽牌無效）", () => {
    let s = setup(deckWith("HV-P01-035", "HV-P01-038", "HV-P01-040", "HV-D01-008"), deckWith("HV-P01-006", "HV-D01-001", "HV-D01-012", "HV-P01-011", "HV-D01-009", "HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    const toss = grab(s, 0, "HV-P01-040"); // 矢巾（青葉城西）
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const iwaizumi = grab(s, 0, "HV-P01-035");
    grab(s, 0, "HV-P01-038"); // 可棄的青葉城西卡
    s = feed(s, { type: "deploy-attack", uid: iwaizumi });
    setHandSize(s, 1, 4); // 条件：相手の手札が4枚以下
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    expect(effParam(db, s, iwaizumi, "attack")).toBe(4); // 2+2
    s = feed(s, { type: "free", action: "pass" });
    // P1 回合：接球軸
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" }); // ドローステップ＝規則處理，不受禁（正常抽）
    s = feed(s, { type: "deploy-receive", uid: grab(s, 1, "HV-P01-011") }); // 西谷 r6 ≥ OP6
    s = feed(s, { type: "free", action: "pass" });
    // Q240：P01-006 檢索 → 公開的日向不能加入手牌、直接置底
    const hinataTop = placeDeckTop(s, 1, "HV-D01-001");
    seedStack(s, 1, "toss", 2);
    const kageyama = grab(s, 1, "HV-P01-006");
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.pendingDecision?.type).not.toBe("effect-cards"); // 無 tutor 決策（被禁）
    expect(s.players[1].hand).not.toContain(hinataTop);
    expect(s.players[1].deck[s.players[1].deck.length - 1]).toBe(hinataTop); // 置底（Q240）
    s = feed(s, { type: "free", action: "pass" });
    // Q241：事件卡抽牌也被禁
    const atk = grab(s, 1, "HV-D01-009"); // 菅原 a3（≠影山名）
    s = feed(s, { type: "deploy-attack", uid: atk });
    const ev = grab(s, 1, "HV-D01-012"); // ブロード攻撃：抽1＋烏野+1
    const h1 = s.players[1].hand.length;
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    expect(s.players[1].hand.length).toBe(h1 - 1); // 只少 play 的那張，抽不到（Q241）
  });

  it("P01-039＋Q246：相手OP≥6→棄青→接球+1；自分のキャラ全員青葉城西（單人也成立）→抽1", () => {
    let s = setup(deckWith("HV-P01-039", "HV-P01-038"), deckWith("HV-D01-004"), 1);
    s = serveWith(s, "HV-D01-004"); // 山口 serve5
    s.op!.value = 6; // 構造：相手 OP=6（cond min6）
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const watari = grab(s, 0, "HV-P01-039"); // 渡 r5
    grab(s, 0, "HV-P01-038");
    s = feed(s, { type: "deploy-receive", uid: watari });
    expect(s.pendingDecision?.type).toBe("effect-confirm");
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    expect(effParam(db, s, watari, "receive")).toBe(6); // 5+1
    expect(s.players[0].hand.length).toBe(h0 - 1 + 1); // 棄1（cost）＋抽1（Q246：單人也算全員青葉城西）
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss"); // DP6 ≥ OP6 成功
  });

  it("P02-057＋Q410／P02-058：對手手牌≤3→接球+7；手牌補到3張", () => {
    let s = setup(deckWith("HV-P02-057"), deckWith("HV-D01-004"), 1);
    s = serveWith(s, "HV-D01-004"); // serve5
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "receive", 3);
    setHandSize(s, 1, 3); // Q410：使用技能時點判定
    const iwa = grab(s, 0, "HV-P02-057"); // r1
    s = feed(s, { type: "deploy-receive", uid: iwa });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, iwa, "receive")).toBe(8); // 1+7 ≥ 5
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss");

    // P02-058：手札が3枚になるように引く
    let t = setup(deckWith("HV-P02-058"), deckWith("HV-D01-002"), 1);
    t = serveWith(t, "HV-D01-002");
    t = feed(t, { type: "defense-choice", choice: "receive" });
    t = feed(t, { type: "free", action: "pass" });
    seedStack(t, 0, "receive", 2);
    const kunimi = grab(t, 0, "HV-P02-058");
    setHandSize(t, 0, 2, [kunimi]); // 登場後手牌 1
    t = feed(t, { type: "deploy-receive", uid: kunimi });
    t = feed(t, { type: "effect-confirm", accept: true });
    expect(t.players[0].hand.length).toBe(3); // 補到 3
  });

  it("P02-056＋Q409：3ガッツ→トス+2＋剛付掉的岩泉可從棄牌區回收；PR-025：トス及川→攻擊+2＋對手棄1", () => {
    let s = setup(deckWith("HV-P02-056", "HV-PR-008", "HV-PR-025", "HV-PR-007", "HV-D01-008"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    // 托球區構造：[filler×2, 岩泉PR-008]，及川登場後付 3 ガッツ（含岩泉）
    seedStack(s, 0, "toss", 2);
    placeOnStack(s, 0, "toss", "HV-PR-008");
    const oikawa = grab(s, 0, "HV-P02-056");
    s = feed(s, { type: "deploy-toss", uid: oikawa });
    s = feed(s, { type: "effect-confirm", accept: true }); // 3ガッツ（恰好 3 → 自動支付，岩泉進棄牌）
    expect(effParam(db, s, oikawa, "toss")).toBe(3); // 1+2
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 回收岩泉（まで→可 0；Q409 含剛付的）
    const iwaUid = s.pendingDecision!.candidates![0]!;
    expect(s.cards[iwaUid]).toBe("HV-PR-008");
    s = feed(s, { type: "effect-cards", uids: [iwaUid] });
    expect(s.players[0].hand).toContain(iwaUid);
    s = feed(s, { type: "free", action: "pass" });
    // PR-025 京谷：トスキャラ＝及川 ✓ → 3ガッツ→攻擊+2；對手手牌≥3→棄1
    seedStack(s, 0, "attack", 3);
    const kyotani = grab(s, 0, "HV-PR-025");
    s = feed(s, { type: "deploy-attack", uid: kyotani });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, kyotani, "attack")).toBe(4); // 2+2
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "effect-cards" }); // 對手自選棄牌
    const h1 = s.players[1].hand.length;
    s = feed(s, { type: "effect-cards", uids: [s.pendingDecision!.candidates![0]!] });
    expect(s.players[1].hand.length).toBe(h1 - 1);
  });
});

describe("青葉城西：事件卡", () => {
  it("P01-085＋Q315：合計8ガッツ（跨區任選）→此回合青葉城西登場每次任一參數+1", () => {
    let s = setup(deckWith("HV-P01-085", "HV-P01-038"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    // 構造跨區 9 ガッツ（各區 3 ガッツ＋1 頂牌）→ 選 8（Q315 任意組合）
    for (const area of ["serve", "receive", "toss"] as const) {
      seedStack(s, 0, area, 3);
      placeOnStack(s, 0, area, FILLER); // 頂牌＝キャラ，下面 3 張才是ガッツ
    }
    const ev = grab(s, 0, "HV-P01-085");
    s = feed(s, { type: "free", action: "event", uid: ev }); // [=ドロー]
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // gate：8ガッツ払えば
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 9 中選 8
    expect(s.pendingDecision!.candidates!.length).toBe(9);
    s = feed(s, { type: "effect-cards", uids: s.pendingDecision!.candidates!.slice(0, 8) });
    s = feed(s, { type: "free", action: "pass" });
    // 接球登場花巻（青葉城西）→ 監看 → 任一參數+1
    const hanamaki = grab(s, 0, "HV-P01-038"); // r5
    s = feed(s, { type: "deploy-receive", uid: hanamaki });
    expect(s.pendingDecision?.type).toBe("effect-option");
    const idx = s.pendingDecision!.options!.findIndex((o) => o.includes("接球"));
    s = feed(s, { type: "effect-option", index: idx });
    expect(effParam(db, s, hanamaki, "receive")).toBe(6); // 5+1
  });

  it("P01-086：從棄牌區回收青葉城西角色卡（強制1）", () => {
    let s = setup(deckWith("HV-P01-086", "HV-P01-038"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const target = placeInDrop(s, 0, "HV-P01-038");
    const ev = grab(s, 0, "HV-P01-086");
    s = feed(s, { type: "free", action: "event", uid: ev }); // [=ドロー]
    expect(s.pendingDecision).toMatchObject({ type: "effect-cards", min: 1 }); // 強制 1
    s = feed(s, { type: "effect-cards", uids: [target] });
    expect(s.players[0].hand).toContain(target);
  });

  it("P01-087＋Q317/Q319：及川在サーブ→監看「引く以外の入手」每張觸發對手棄1；無及川→可 play 無效果", () => {
    let s = setup(deckWith("HV-P01-033", "HV-P01-087", "HV-P01-087"), deckWith("HV-P01-006", "HV-D01-001", "HV-D01-008", "HV-D01-002"), 0);
    const oikawa = grab(s, 0, "HV-P01-033");
    s = feed(s, { type: "deploy-serve", uid: oikawa });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false }); // 跳過及川自身 gate
    // 自由步驟（[=サーブ]）：play 087 → cond サーブキャラ及川 ✓
    const ev = grab(s, 0, "HV-P01-087");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(effParam(db, s, oikawa, "toss")).toBe(2); // 及川 t1+1（draw1＋toss+1）
    s = feed(s, { type: "free", action: "pass" });
    // P1 接球軸：用 P01-006 檢索加 1 張入手（引く以外）→ 觸發 → P1 棄 1
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-receive", uid: grab(s, 1, "HV-D01-008") });
    s = feed(s, { type: "free", action: "pass" });
    const hinataTop = placeDeckTop(s, 1, "HV-D01-001");
    seedStack(s, 1, "toss", 2);
    s = feed(s, { type: "deploy-toss", uid: grab(s, 1, "HV-P01-006") });
    s = feed(s, { type: "effect-confirm", accept: true });
    const h1 = s.players[1].hand.length;
    s = feed(s, { type: "effect-cards", uids: [hinataTop] }); // 加入手牌 → 監看觸發
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "effect-cards" }); // 對手（P1）自選棄 1（Q317 每張一次）
    s = feed(s, { type: "effect-cards", uids: [s.pendingDecision!.candidates![0]!] });
    expect(s.players[1].hand.length).toBe(h1 + 1 - 1);

    // Q319：及川不在 → 仍可 play、無效果
    let t = setup(deckWith("HV-P01-087", "HV-D01-008"), deckWith("HV-D01-002"), 0);
    const server = grab(t, 0, "HV-D01-008"); // 澤村（非及川）
    t = feed(t, { type: "deploy-serve", uid: server });
    const ev2 = grab(t, 0, "HV-P01-087");
    const h0 = t.players[0].hand.length;
    t = feed(t, { type: "free", action: "event", uid: ev2 });
    expect(t.pendingDecision).toMatchObject({ player: 0, type: "free" }); // 直接回自由步驟
    expect(t.players[0].hand.length).toBe(h0 - 1); // 無 draw、無效果
    expect(t.players[0].eventArea.length).toBe(1);
  });

  it("P01-088：「1枚まで引く」可選不抽；手牌≤3 追加+1", () => {
    let s = setup(deckWith("HV-P01-088", "HV-P01-038"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const hanamaki = grab(s, 0, "HV-P01-038");
    const ev = grab(s, 0, "HV-P01-088");
    s = feed(s, { type: "deploy-receive", uid: hanamaki });
    setHandSize(s, 0, 3, [ev]); // play 後 2 → 追加條件成立
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // 要抽嗎（まで）
    s = feed(s, { type: "effect-confirm", accept: false }); // 選不抽
    expect(effParam(db, s, hanamaki, "receive")).toBe(7); // 5+1+1（手牌3以下）
  });
});

describe("完成定義：青葉城西牌組技能全生效的完整對局", () => {
  it("青葉城西二彈改 vs 青葉城西快攻軸：啟發式 AI 對打完整場", async () => {
    const { heuristicAiDecision } = await import("../ai/heuristic");
    const deckA = (await import("../../data/decks/青葉城西-二彈改.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    const deckB = (await import("../../data/decks/青葉城西-快攻軸.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    for (const seed of [5, 17]) {
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
