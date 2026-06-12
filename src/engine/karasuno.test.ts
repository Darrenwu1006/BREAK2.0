// M3：烏野牌組（decks/烏野/）技能卡逐張行為測試＋官方判例（測試名含 Q 編號＝docs/RULINGS.md）
import { describe, it, expect } from "vitest";
import { blockDeployMax, canChooseBlock, deployableUids, effParam } from "./engine";
import type { GameState, PlayerId } from "./types";
import { db, deckWith, drainCp, feed, grab, placeDeckTop, placeInDrop, placeOnStack, seedStack, setHandSize, setup, serveWith, receiveTrack, FILLER } from "./testkit";

/** 把卡直接放進事件區（構造 Q294 計數情境） */
function placeInEventArea(s: GameState, p: PlayerId, cardId: string, exclude: number[] = []): number {
  const uid = grab(s, p, cardId, exclude);
  const ps = s.players[p];
  ps.hand.splice(ps.hand.indexOf(uid), 1);
  ps.eventArea.push(uid);
  return uid;
}

describe("烏野：登場被動（gate 自身強化系）", () => {
  it("D01-005／D01-002／D01-001：付ガッツ→抽牌/參數強化，修正進入 OP/DP", () => {
    let s = setup(deckWith("HV-D01-005", "HV-D01-002", "HV-D01-001"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002"); // P1 OP=1
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    // 西谷 D01-005：3ガッツ→抽1＋レシーブ+2
    seedStack(s, 0, "receive", 3);
    const noya = grab(s, 0, "HV-D01-005");
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "deploy-receive", uid: noya });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].hand.length).toBe(h0); // −1登場 +1抽
    expect(effParam(db, s, noya, "receive")).toBe(7); // 5+2
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss");
    // 影山 D01-002：2ガッツ→トス+2
    seedStack(s, 0, "toss", 2);
    const kageyama = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, kageyama, "toss")).toBe(3); // 1+2
    s = feed(s, { type: "free", action: "pass" });
    // 日向 D01-001：2ガッツ→アタック+2
    seedStack(s, 0, "attack", 2);
    const hinata = grab(s, 0, "HV-D01-001");
    s = feed(s, { type: "deploy-attack", uid: hinata });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, hinata, "attack")).toBe(4); // 2+2
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 7, owner: 0 }); // 3+4：修正層 → OP †6-10-1
  });

  it("D01-007：手牌棄 1 →レシーブ+3（「～すれば使える」分歧 †7-7-3）", () => {
    let s = setup(deckWith("HV-D01-007"), deckWith("HV-D01-004"), 1);
    s = serveWith(s, "HV-D01-004"); // 山口 serve5
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const ennoshita = grab(s, 0, "HV-D01-007"); // r2
    s = feed(s, { type: "deploy-receive", uid: ennoshita });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 選要棄的手牌
    s = feed(s, { type: "effect-cards", uids: [s.pendingDecision!.candidates![0]!] });
    expect(effParam(db, s, ennoshita, "receive")).toBe(5); // 2+3
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss"); // DP5 ≥ OP5 成功
  });

  it("Q214：HV-P01-015 牌組 0 張抽不到牌，トス+1 仍執行（可能な限り †0-2-5-5）", () => {
    let s = setup(deckWith("HV-P01-015", "HV-D01-008"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    seedStack(s, 0, "toss", 2);
    const suga = grab(s, 0, "HV-P01-015");
    {
      const ps = s.players[0]; // 牌組清空（搬到棄牌區，不破壞 40 張不變量）
      ps.drop.push(...ps.deck.splice(0));
    }
    s = feed(s, { type: "deploy-toss", uid: suga });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, suga, "toss")).toBe(2); // 1+1，抽牌失敗不影響
  });
});

describe("烏野：P01-002／P01-003（登場限制系）", () => {
  it("Q199/Q200：HV-P01-002 アタック+4＋禁止「元々のレシーブP≥6」登場（元々の＝卡面值）", () => {
    let s = setup(deckWith("HV-P01-002", "HV-D01-008", "HV-D01-009"), deckWith("HV-P01-011", "HV-D01-008"), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const toss = grab(s, 0, "HV-D01-009");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    seedStack(s, 0, "attack", 3);
    const hinata = grab(s, 0, "HV-P01-002"); // a1
    s = feed(s, { type: "deploy-attack", uid: hinata });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, hinata, "attack")).toBe(5); // 1+4
    s = feed(s, { type: "free", action: "pass" });
    // P1 接球：西谷 P01-011（元々r6）被禁，澤村（r5）可登場（Q200：之後再強化不受限）
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    grab(s, 1, "HV-P01-011"); // 確保兩張都在手牌再驗證
    grab(s, 1, "HV-D01-008");
    const legal = deployableUids(db, s, 1, "receive");
    expect(legal.some((u) => s.cards[u] === "HV-P01-011")).toBe(false);
    expect(legal.some((u) => s.cards[u] === "HV-D01-008")).toBe(true);
  });

  it("Q201/Q203/Q204：HV-P01-003 登場後手牌≤3 才可用；次の相手ターン攔網最多 2 人", () => {
    let s = setup(deckWith("HV-P01-003", "HV-D01-002", "HV-D01-008"), deckWith("HV-D01-008", "HV-D01-002", "HV-D01-004", "HV-D01-009"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    const kageyama = grab(s, 0, "HV-D01-002"); // トスキャラ＝影山（条件）
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const hinata = grab(s, 0, "HV-P01-003");
    setHandSize(s, 0, 4, [hinata]); // 登場後手牌 3 枚（Q203：登場後計算）
    s = feed(s, { type: "deploy-attack", uid: hinata });
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // 条件成立 → 可使用
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, hinata, "attack")).toBe(4); // 2+2
    s = feed(s, { type: "free", action: "pass" });
    // Q204：P1 攔網最多 2 人
    s = feed(s, { type: "defense-choice", choice: "block" });
    expect(blockDeployMax(s, 1)).toBe(2);
    const b1 = grab(s, 1, "HV-D01-008");
    const b2 = grab(s, 1, "HV-D01-004");
    const b3 = grab(s, 1, "HV-D01-009");
    expect(() => feed(s, { type: "deploy-block", uids: [b1, b2, b3], center: b1 })).toThrow(/最多/);
    s = feed(s, { type: "deploy-block", uids: [b1, b2], center: b2 }); // 2 人 OK
    expect(s.players[1].blockSides.length).toBe(1);
  });

  it("Q202：HV-P01-003 由「オープン攻撃」從棄牌區登場 → 非手牌登場，技能不可用", () => {
    let s = setup(deckWith("HV-P01-078", "HV-P01-003", "HV-D01-002", "HV-D01-008", "HV-D01-010"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    const kageyama = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const asahi = grab(s, 0, "HV-D01-010"); // 東峰（vanilla）先登場攻擊
    s = feed(s, { type: "deploy-attack", uid: asahi });
    placeInDrop(s, 0, "HV-P01-003"); // 棄牌區的日向 P01-003
    const open = grab(s, 0, "HV-P01-078");
    setHandSize(s, 0, 3, [open]); // 手牌條件即使滿足……
    s = feed(s, { type: "free", action: "event", uid: open }); // 抽2→棄1→登場日向
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 1) });
    // ……Q202：deployedFromHand 不成立 → 沒有 gate 確認，直接回到自由步驟
    expect(s.pendingDecision?.type).toBe("free");
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "block" });
    expect(blockDeployMax(s, 1)).toBe(3); // 限制未發生
  });
});

describe("烏野：P01-006／P01-008／P01-010（檢索與監看系）", () => {
  it("Q205/Q207/Q302/Q303：HV-P01-006 檢索＋本回合日向登場每次+2；蓋牌失去修正；オープン攻撃連動", () => {
    let s = setup(deckWith("HV-P01-006", "HV-D01-001", "HV-D01-001", "HV-P01-078", "HV-D01-008"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    const hinataTop = placeDeckTop(s, 0, "HV-D01-001"); // 檢索目標
    seedStack(s, 0, "toss", 2);
    const kageyama = grab(s, 0, "HV-P01-006");
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    s = feed(s, { type: "effect-confirm", accept: true }); // 2ガッツ
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 公開＝日向 → 要加入手牌嗎
    s = feed(s, { type: "effect-cards", uids: [hinataTop] });
    expect(s.players[0].hand).toContain(hinataTop);
    s = feed(s, { type: "free", action: "pass" });
    // 攻擊登場日向（手牌）→ 監看 +2
    s = feed(s, { type: "deploy-attack", uid: hinataTop });
    s = drainCp(s); // 監看遲發＋日向自身被動（gate 無ガッツ自動跳過）
    expect(effParam(db, s, hinataTop, "attack")).toBe(4); // 2+2
    // オープン攻撃：抽2棄1→棄牌區日向登場（蓋住第一隻）→ 監看再+2＋本卡+1
    const hinataDrop = placeInDrop(s, 0, "HV-D01-001");
    const open = grab(s, 0, "HV-P01-078");
    s = feed(s, { type: "free", action: "event", uid: open });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 1) }); // 棄 1（Q301 強制）
    s = drainCp(s); // 監看遲發＋落下日向自身被動（gate ガッツ不足自動跳過）
    expect(s.players[0].attack[s.players[0].attack.length - 1]).toBe(hinataDrop); // Q303：強制登場
    expect(s.modifiers.filter((m) => m.target === hinataTop)).toEqual([]); // Q207：被蓋者失去 +2
    expect(effParam(db, s, hinataDrop, "attack")).toBe(5); // 2 +2(監看 Q205) +1(オープン攻撃)
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 6, owner: 0 }); // トス1＋アタック5
  });

  it("Q208：HV-P01-008 山口在場 →「以下の2つ」全部執行（ブロック+2＋ドシャット監看）", () => {
    let s = setup(deckWith("HV-P01-008", "HV-D01-004", "HV-D01-002"), deckWith("HV-D01-008", "HV-D01-010", "HV-D01-002"), 0);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    const toss = grab(s, 1, "HV-D01-010");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-002");
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" }); // OP=1
    s = feed(s, { type: "defense-choice", choice: "block" });
    placeOnStack(s, 0, "serve", "HV-D01-004"); // コートに山口（serve 區キャラ；卡名全形空白→正規化比對）
    seedStack(s, 0, "blockCenter", 2);
    const tsukki = grab(s, 0, "HV-P01-008");
    s = feed(s, { type: "deploy-block", uids: [tsukki], center: tsukki });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, tsukki, "block")).toBe(4); // ▶1：2+2
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 6, owner: 0 }); // ▶2：攔網成功→ドシャット(6)
  });

  it("Q210/Q211：HV-P01-010 強制公開；對手トスキャラ登場→トス−2（可為負 †2-7-3）", () => {
    let s = setup(deckWith("HV-P01-010"), deckWith("HV-D01-008", "HV-D01-010", "HV-D01-006"), 0);
    const revealed = placeDeckTop(s, 0, FILLER); // 牌組頂＝田中（烏野）→ 監看註冊
    const yamaguchi = grab(s, 0, "HV-P01-010");
    s = feed(s, { type: "deploy-serve", uid: yamaguchi });
    // 被動無 gate：強制公開（Q210），不需任何決策
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "free" });
    expect(s.players[0].deck[s.players[0].deck.length - 1]).toBe(revealed); // 公開後置底
    s = feed(s, { type: "free", action: "pass" }); // OP=2
    s = receiveTrack(s, "HV-D01-008");
    const asahi = grab(s, 1, "HV-D01-010"); // 東峰 t0
    s = feed(s, { type: "deploy-toss", uid: asahi });
    expect(effParam(db, s, asahi, "toss")).toBe(-2); // Q211：0−2＝−2
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, FILLER); // 田中 a3
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 1, owner: 1 }); // −2+3
  });
});

describe("烏野：P01-013（アクティブ型）／PR 系", () => {
  it("Q212/Q213：HV-P01-013 接球階段自由步驟、〔手札からドロップ〕為 cost", () => {
    let s = setup(deckWith("HV-P01-013", "HV-D01-006"), deckWith("HV-D01-008"), 1);
    s = serveWith(s, "HV-D01-008"); // 澤村 serve3
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const chikara = grab(s, 0, "HV-P01-013");
    const receiver = grab(s, 0, FILLER); // 田中 r2
    s = feed(s, { type: "deploy-receive", uid: receiver });
    s = feed(s, { type: "free", action: "skill", uid: chikara, skillIndex: 0 });
    expect(s.players[0].drop).toContain(chikara); // cost：自身進棄牌
    expect(effParam(db, s, receiver, "receive")).toBe(4); // 2+2
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss"); // DP4 ≥ OP3 成功
  });

  it("HV-PR-001：「日向 翔陽」の上に登場 → 任一參數+1（選擇參數）", () => {
    let s = setup(deckWith("HV-PR-001", "HV-P01-001", "HV-D01-008", "HV-D01-009"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    placeOnStack(s, 0, "attack", "HV-P01-001"); // 既存の日向（vanilla）
    const suga = grab(s, 0, "HV-D01-009");
    s = feed(s, { type: "deploy-toss", uid: suga });
    s = feed(s, { type: "free", action: "pass" });
    const pr = grab(s, 0, "HV-PR-001");
    s = feed(s, { type: "deploy-attack", uid: pr }); // 蓋在日向上 → 觸發
    expect(s.pendingDecision?.type).toBe("effect-option");
    const idx = s.pendingDecision!.options!.findIndex((o) => o.includes("攻擊"));
    s = feed(s, { type: "effect-option", index: idx });
    expect(effParam(db, s, pr, "attack")).toBe(3); // 2+1
  });

  it("HV-PR-004／HV-PR-003：2ガッツ→抽1；手牌棄1→アタック+2", () => {
    let s = setup(deckWith("HV-PR-004", "HV-PR-003", "HV-D01-008"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    seedStack(s, 0, "toss", 2);
    const pr4 = grab(s, 0, "HV-PR-004");
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "deploy-toss", uid: pr4 });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].hand.length).toBe(h0); // −1登場+1抽
    s = feed(s, { type: "free", action: "pass" });
    const pr3 = grab(s, 0, "HV-PR-003");
    s = feed(s, { type: "deploy-attack", uid: pr3 });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: s.pendingDecision.candidates!.slice(0, 1) });
    expect(effParam(db, s, pr3, "attack")).toBe(4); // 2+2
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 5, owner: 0 }); // PR-004 t1 + 4
  });
});

describe("烏野：072／073 置換（登場改名）", () => {
  it("Q285：兩張 072 選不同卡名可一起攔網登場", () => {
    let s = setup(deckWith("HV-P01-072", "HV-P01-072"), deckWith("HV-D01-008", "HV-D01-010", "HV-D01-002"), 0);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const toss = grab(s, 1, "HV-D01-010");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-002");
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "block" });
    const a = grab(s, 0, "HV-P01-072");
    const b = grab(s, 0, "HV-P01-072", [a]);
    // 同名（兩張都選日向）→ 拒絕
    expect(() => feed(s, { type: "deploy-block", uids: [a, b], center: a, nameChoices: { [a]: "日向 翔陽", [b]: "日向 翔陽" } })).toThrow(/同名/);
    s = feed(s, { type: "deploy-block", uids: [a, b], center: a, nameChoices: { [a]: "日向 翔陽", [b]: "孤爪 研磨" } });
    expect(s.players[0].blockSides.length).toBe(1);
    expect(s.nameOverrides[a]).toBe("日向 翔陽");
    expect(s.nameOverrides[b]).toBe("孤爪 研磨");
  });

  it("Q279/Q215：トスキャラ同名禁止以選定名判定；072 當トス＝烏野のS（P01-016 条件成立）", () => {
    let s = setup(deckWith("HV-P01-072", "HV-P01-016", "HV-D01-008", "HV-P01-017"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    placeOnStack(s, 0, "receive", "HV-P01-017"); // 接球キャラ＝孤爪 研磨（蓋住澤村構造同名情境）
    const dual = grab(s, 0, "HV-P01-072");
    // Q279 類推：接球=孤爪 → トス不能以「孤爪 研磨」登場
    expect(() => feed(s, { type: "deploy-toss", uid: dual, nameChoice: "孤爪 研磨" })).toThrow(/登場/);
    s = feed(s, { type: "deploy-toss", uid: dual, nameChoice: "日向 翔陽" });
    s = feed(s, { type: "free", action: "pass" });
    // Q215：トス＝072（烏野・S）→ P01-016 条件成立（gate 出現）
    seedStack(s, 0, "attack", 4);
    const asahi = grab(s, 0, "HV-P01-016");
    s = feed(s, { type: "deploy-attack", uid: asahi });
    expect(s.pendingDecision?.type).toBe("effect-confirm");
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, asahi, "attack")).toBe(5); // 3+2
  });

  it("Q280：HV-P01-006 公開到「日向・孤爪」→ 卡名不同，不能加入手牌", () => {
    let s = setup(deckWith("HV-P01-006", "HV-P01-072", "HV-D01-008"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    const dualTop = placeDeckTop(s, 0, "HV-P01-072");
    seedStack(s, 0, "toss", 2);
    const kageyama = grab(s, 0, "HV-P01-006");
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    s = feed(s, { type: "effect-confirm", accept: true });
    // 公開的是「日向・孤爪」≠「日向 翔陽」→ 不出現 tutor 決策，直接置底
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "free" });
    expect(s.players[0].deck[s.players[0].deck.length - 1]).toBe(dualTop);
  });
});

describe("烏野：事件卡", () => {
  it("Q190：D01-011 先+1 再判定「4以下」→ 東峰 r4+1=5 不再加", () => {
    let s = setup(deckWith("HV-D01-011", "HV-D01-010"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const asahi = grab(s, 0, "HV-D01-010"); // r4
    const ev = grab(s, 0, "HV-D01-011");
    s = feed(s, { type: "deploy-receive", uid: asahi });
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(effParam(db, s, asahi, "receive")).toBe(5); // 4+1 → 5 > 4 → 不再 +1（Q190）
  });

  it("D01-012：トス影山＋アタック日向 → 次の相手ターン攔網最多 1 人", () => {
    let s = setup(deckWith("HV-D01-012", "HV-D01-002", "HV-D01-001", "HV-D01-008"), deckWith("HV-D01-008", "HV-D01-004"), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const kageyama = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: kageyama });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const hinata = grab(s, 0, "HV-D01-001");
    s = feed(s, { type: "deploy-attack", uid: hinata });
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    const ev = grab(s, 0, "HV-D01-012");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [hinata] }); // 烏野キャラ1人 attack+1
    expect(effParam(db, s, hinata, "attack")).toBe(3); // 2+1
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "defense-choice", choice: "block" });
    expect(blockDeployMax(s, 1)).toBe(1);
  });

  it("Q294：P01-074 對手事件區 [=ドロー]/[=レシーブ] 可打出的卡 ≥5 張 → 追加+2", () => {
    let s = setup(deckWith("HV-P01-074", "HV-D01-002", "HV-D01-008", "HV-D01-009"), deckWith("HV-P01-076", "HV-P01-077", "HV-P01-077", "HV-D01-011", "HV-D01-011"), 1);
    s = serveWith(s, FILLER);
    // 構造對手事件區 5 張（抽牌×1＋接球×4）
    const e1 = placeInEventArea(s, 1, "HV-P01-076");
    const e2 = placeInEventArea(s, 1, "HV-P01-077");
    const e3 = placeInEventArea(s, 1, "HV-P01-077", [e2]);
    const e4 = placeInEventArea(s, 1, "HV-D01-011");
    placeInEventArea(s, 1, "HV-D01-011", [e4]);
    void e1; void e3;
    s = receiveTrack(s, "HV-D01-008");
    const suga = grab(s, 0, "HV-D01-009");
    s = feed(s, { type: "deploy-toss", uid: suga });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 0, FILLER);
    s = feed(s, { type: "deploy-attack", uid: atk });
    const ev = grab(s, 0, "HV-P01-074");
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [atk] });
    expect(effParam(db, s, atk, "attack")).toBe(6); // 3+1+2
  });

  it("Q295：P01-075 攻擊階段為トスキャラ+1 → OP 反映；非接球階段不抽牌", () => {
    let s = setup(deckWith("HV-P01-075", "HV-D01-008", "HV-D01-009"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    const suga = grab(s, 0, "HV-D01-009"); // t2
    s = feed(s, { type: "deploy-toss", uid: suga });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 0, FILLER); // a3
    s = feed(s, { type: "deploy-attack", uid: atk });
    const ev = grab(s, 0, "HV-P01-075");
    const h0 = s.players[0].hand.length;
    s = feed(s, { type: "free", action: "event", uid: ev });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [suga] }); // 對象＝菅原
    if (s.pendingDecision?.type === "effect-option") {
      const idx = s.pendingDecision.options!.findIndex((o) => o.includes("托球"));
      s = feed(s, { type: "effect-option", index: idx });
    }
    expect(effParam(db, s, suga, "toss")).toBe(3);
    expect(s.players[0].hand.length).toBe(h0 - 1); // 只少打出的那張，沒抽牌
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 6, owner: 0 }); // (2+1)+3（Q295）
  });

  it("Q297/Q298：P01-076 play 後手牌≤4 即可用；同一區同所属ガッツ2枚→手牌", () => {
    let s = setup(deckWith("HV-P01-076", "HV-D01-004"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    // 構造：serve 區 [田中,田中,山口] → 山口為キャラ、兩張田中（烏野）為ガッツ
    seedStack(s, 0, "serve", 2);
    placeOnStack(s, 0, "serve", "HV-D01-004");
    const ev = grab(s, 0, "HV-P01-076");
    setHandSize(s, 0, 5, [ev]); // play 後 4 枚 → 條件成立（Q298）
    s = feed(s, { type: "free", action: "event", uid: ev }); // draw phase（[=ドロー]）
    expect(s.pendingDecision?.type).toBe("effect-cards");
    const guts = s.players[0].serve.slice(0, 2);
    s = feed(s, { type: "effect-cards", uids: guts });
    expect(s.players[0].hand.length).toBe(6); // 4+2
    expect(s.players[0].serve.length).toBe(1); // 只剩山口
  });

  it("Q305/Q306：P01-079 月島對象→山口回手＋次ターン接球−2；DP −1 < OP 0 → 接球失敗", () => {
    let s = setup(deckWith("HV-P01-079", "HV-D01-003", "HV-D01-004", "HV-D01-002"), deckWith("HV-D01-008", "HV-D01-010", "HV-D01-002", "HV-P01-002"), 0);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008");
    const toss = grab(s, 1, "HV-D01-010");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-002");
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" }); // P1 OP=1
    s = feed(s, { type: "defense-choice", choice: "block" });
    placeOnStack(s, 0, "serve", "HV-D01-004"); // サーブ區キャラ＝山口
    seedStack(s, 0, "blockCenter", 1);
    const tsukki = grab(s, 0, "HV-D01-003"); // 月島 b3
    s = feed(s, { type: "deploy-block", uids: [tsukki], center: tsukki });
    s = feed(s, { type: "effect-confirm", accept: true }); // 月島 D01-003：OP≤4 → 1ガッツ抽1
    const ev = grab(s, 0, "HV-P01-079");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(effParam(db, s, tsukki, "block")).toBe(4); // 3+1
    expect(s.pendingDecision?.type).toBe("effect-cards"); // 山口を手札に（まで→可 0；Q306）
    const yamaguchi = s.pendingDecision!.candidates![0]!;
    s = feed(s, { type: "effect-cards", uids: [yamaguchi] });
    expect(s.players[0].hand).toContain(yamaguchi);
    s = feed(s, { type: "free", action: "pass" });
    // 攔網成功（DP4 ≥ OP1）→ P0 攔網 OP=0；P1 接球：r1 日向 −2 → −1 < 0 → 失敗（Q305）
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "defense-choice" });
    expect(canChooseBlock(s)).toBe(false);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const weak = grab(s, 1, "HV-P01-002"); // 元々r1
    s = feed(s, { type: "deploy-receive", uid: weak });
    expect(effParam(db, s, weak, "receive")).toBe(-1);
    s = feed(s, { type: "free", action: "pass" });
    expect(s.lostBy).toBe(1);
  });
});

describe("完成定義：烏野牌組技能全生效的完整對局", () => {
  it("烏野日影攻擊軸 vs 烏野山月攔網軸：啟發式 AI 對打完整場（效果決策全程合法）", async () => {
    const { heuristicAiDecision } = await import("../ai/heuristic");
    const deckA = (await import("../../data/decks/烏野-日影攻擊軸.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    const deckB = (await import("../../data/decks/烏野-山月攔網軸.json")).default.cards.flatMap((c: { id: string; count: number }) => Array(c.count).fill(c.id));
    for (const seed of [11, 22, 33]) {
      let s = (await import("./engine")).createGame(db, { seed, decks: [deckA, deckB] as [string[], string[]] });
      let effectDecisions = 0;
      for (let i = 0; i < 5000 && s.phase !== "gameOver"; i++) {
        if (["effect-confirm", "effect-cards", "effect-option", "resolve-pending"].includes(s.pendingDecision!.type)) effectDecisions++;
        s = feed(s, heuristicAiDecision(db, s));
      }
      expect(s.phase).toBe("gameOver");
      expect(s.winner).not.toBeNull();
      expect(effectDecisions).toBeGreaterThan(0); // 技能確實在對局中生效
      for (const ps of s.players) {
        const all = [...ps.deck, ...ps.hand, ...ps.setArea, ...ps.drop, ...ps.eventArea, ...ps.serve, ...ps.blockCenter, ...ps.blockSides, ...ps.receive, ...ps.toss, ...ps.attack];
        expect(all.length).toBe(40);
        expect(new Set(all).size).toBe(40);
      }
    }
  });
});
