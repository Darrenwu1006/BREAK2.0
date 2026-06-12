import { describe, it, expect } from "vitest";
import { createGame, applyDecision, canChooseBlock, deployableUids } from "./engine";
import { randomAiDecision } from "../ai/random";
import type { CardDb, Decision, GameState, PlayerId } from "./types";
import type { Card } from "../data/types";
import cardsJson from "../../data/cards.json";
import deckKarasuno from "../../data/decks/烏野-預組.json";
import deckNekoma from "../../data/decks/音駒-預組.json";

// ---------- 合成香草卡 ----------

function mkChar(id: string, name: string, p: { s?: number | null; b?: number | null; r?: number | null; t?: number | null; a?: number | null }): Card {
  return {
    id, type: "CHARACTER", nameJa: name, affiliations: ["測試"], positions: [], grades: [],
    params: {
      serve: p.s === undefined ? 0 : p.s,
      block: p.b === undefined ? 0 : p.b,
      receive: p.r === undefined ? 0 : p.r,
      toss: p.t === undefined ? 0 : p.t,
      attack: p.a === undefined ? 0 : p.a,
    },
    timing: [], skillJa: null, skillZh: null, skillZhStatus: "none", notes: null,
    printings: [{ rarity: "N", image: null }], effect: null, effectStatus: "vanilla",
  };
}

const ACE = mkChar("T-ACE", "エース", { s: 4, b: 2, r: 3, t: 2, a: 4 });
const LIB = mkChar("T-LIB", "リベロ", { s: null, b: null, r: 5, t: 1, a: null }); // 發球/攔網/攻擊「－」
const WALL = mkChar("T-WALL", "ブロッカー", { s: 1, b: 3, r: 1, t: 0, a: 1 });
const SETTER = mkChar("T-SET", "セッター", { s: 2, b: 1, r: 1, t: 4, a: 1 });
const WEAK = mkChar("T-WEAK", "ルーキー", { s: 1, b: 1, r: 1, t: 1, a: 1 });

const testDb: CardDb = new Map([ACE, LIB, WALL, SETTER, WEAK].map((c) => [c.id, c]));
const uniformDeck = (id: string) => Array(40).fill(id) as string[];

/** 推進輔助：依 pendingDecision 餵入決策 */
function feed(db: CardDb, s: GameState, d: Decision): GameState {
  return applyDecision(db, s, d);
}

/** 跳過建局（P0 拿發球權、雙方不換牌）→ 停在 P0 的 deploy-serve */
function setupGame(db: CardDb, deckA: string[], deckB: string[], seed = 42): GameState {
  let s = createGame(db, { seed, decks: [deckA, deckB] });
  const decider = s.pendingDecision!.player;
  s = feed(db, s, { type: "serve-rights", take: decider === 0 });
  s = feed(db, s, { type: "mulligan", returnUids: [] });
  s = feed(db, s, { type: "mulligan", returnUids: [] });
  return s;
}

/** 不變量：每位玩家全領域實體卡恆為 40 張且 uid 不重複 */
function checkInvariants(s: GameState): void {
  for (const ps of s.players) {
    const all = [...ps.deck, ...ps.hand, ...ps.setArea, ...ps.drop, ...ps.eventArea, ...ps.serve, ...ps.blockCenter, ...ps.blockSides, ...ps.receive, ...ps.toss, ...ps.attack];
    expect(all.length).toBe(40);
    expect(new Set(all).size).toBe(40);
  }
}

// ---------- 測試 ----------

describe("建局與遊戲前手順 †4-2", () => {
  it("發球權選擇→換牌→Set卡2張→發球登場決策", () => {
    const s = setupGame(testDb, uniformDeck("T-ACE"), uniformDeck("T-WEAK"));
    expect(s.phase).toBe("serve");
    expect(s.pendingDecision).toEqual({ player: 0, type: "deploy-serve" });
    for (const ps of s.players) {
      expect(ps.hand.length).toBe(6);
      expect(ps.setArea.length).toBe(2);
      expect(ps.deck.length).toBe(32);
    }
    checkInvariants(s);
  });

  it("放棄發球權：對方成為發球玩家", () => {
    let s = createGame(testDb, { seed: 7, decks: [uniformDeck("T-ACE"), uniformDeck("T-WEAK")] });
    const decider = s.pendingDecision!.player;
    s = feed(testDb, s, { type: "serve-rights", take: false });
    expect(s.servingPlayer).toBe(decider === 0 ? 1 : 0);
  });

  it("換牌：放回 N 張洗勻補滿 6 †4-2-1-4", () => {
    let s = createGame(testDb, { seed: 1, decks: [uniformDeck("T-ACE"), uniformDeck("T-WEAK")] });
    const decider = s.pendingDecision!.player;
    s = feed(testDb, s, { type: "serve-rights", take: decider === 0 });
    const hand = [...s.players[0].hand];
    s = feed(testDb, s, { type: "mulligan", returnUids: hand.slice(0, 3) });
    expect(s.players[0].hand.length).toBe(6);
    checkInvariants(s);
  });

  it("構築驗證：40 張", () => {
    expect(() => createGame(testDb, { seed: 1, decks: [Array(39).fill("T-ACE"), uniformDeck("T-WEAK")] })).toThrow(/40/);
  });
});

describe("發球回合 †5-5 與接球軸 †5-8~11", () => {
  it("發球 OP=發球角色サーブP；接球成功後托球/攻擊有同名限制，攻擊 OP=トスP+アタックP", () => {
    // P0: ACE(serve4)。P1: 手牌混 LIB/SETTER/ACE → 接球軸
    const deckB = [...Array(20).fill("T-LIB"), ...Array(10).fill("T-SET"), ...Array(10).fill("T-ACE")];
    let s = setupGame(testDb, uniformDeck("T-ACE"), deckB, 5);
    const p0serve = s.players[0].hand[0]!;
    s = feed(testDb, s, { type: "deploy-serve", uid: p0serve });
    expect(s.pendingDecision).toEqual({ player: 0, type: "free" });
    s = feed(testDb, s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 4, owner: 0, source: "serve" }); // ACE serve=4
    // P1 turn：選接球
    expect(s.pendingDecision).toEqual({ player: 1, type: "defense-choice" });
    s = feed(testDb, s, { type: "defense-choice", choice: "receive" });
    // draw phase：抽1 → 手牌7
    expect(s.players[1].hand.length).toBe(7);
    s = feed(testDb, s, { type: "free", action: "pass" });
    // 接球：LIB receive=5 ≥ 4 → 成功
    const lib = s.players[1].hand.find((u) => s.cards[u] === "T-LIB")!;
    s = feed(testDb, s, { type: "deploy-receive", uid: lib });
    s = feed(testDb, s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss"); // 判定成功
    expect(s.op).toBeNull(); // ジャッジ後 OP/DP 消滅 †5-15
    // 托球：不可與接球角色同名 → LIB 不在合法清單
    const tossable = deployableUids(testDb, s, 1, "toss");
    expect(tossable.some((u) => s.cards[u] === "T-LIB")).toBe(false);
    const setter = s.players[1].hand.find((u) => s.cards[u] === "T-SET")!;
    s = feed(testDb, s, { type: "deploy-toss", uid: setter });
    s = feed(testDb, s, { type: "free", action: "pass" });
    // 攻擊：不可與托球角色同名 → SETTER 排除
    const attackable = deployableUids(testDb, s, 1, "attack");
    expect(attackable.some((u) => s.cards[u] === "T-SET")).toBe(false);
    const ace = s.players[1].hand.find((u) => s.cards[u] === "T-ACE")!;
    s = feed(testDb, s, { type: "deploy-attack", uid: ace });
    s = feed(testDb, s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 4 + 4, owner: 1, source: "attack" }); // toss4 + attack4
    expect(s.pendingDecision).toEqual({ player: 0, type: "defense-choice" });
    checkInvariants(s);
  });

  it("「－」參數不可登場 †1-3-2-2：LIB 不能發球", () => {
    const s = setupGame(testDb, uniformDeck("T-LIB"), uniformDeck("T-WEAK"), 3);
    expect(deployableUids(testDb, s, 0, "serve")).toEqual([]);
    expect(() => feed(testDb, s, { type: "deploy-serve", uid: s.players[0].hand[0]! })).toThrow();
  });

  it("接球失敗 → Lost → 進入インターバル", () => {
    // P0 ACE serve4 vs P1 WEAK receive1
    let s = setupGame(testDb, uniformDeck("T-ACE"), uniformDeck("T-WEAK"), 9);
    s = feed(testDb, s, { type: "deploy-serve", uid: s.players[0].hand[0]! });
    s = feed(testDb, s, { type: "free", action: "pass" });
    s = feed(testDb, s, { type: "defense-choice", choice: "receive" });
    s = feed(testDb, s, { type: "free", action: "pass" });
    s = feed(testDb, s, { type: "deploy-receive", uid: s.players[1].hand[0]! });
    s = feed(testDb, s, { type: "free", action: "pass" });
    // DP1 < OP4 → P1 Lost → interval：補手牌後等 P1 撿 Set 卡
    expect(s.phase).toBe("interval");
    expect(s.pendingDecision).toEqual({ player: 1, type: "pick-set-card" });
    expect(s.players[0].hand.length).toBe(6);
    expect(s.players[1].hand.length).toBe(6);
    s = feed(testDb, s, { type: "pick-set-card", index: 0 });
    // 下一 Set：P0（未 Lost）擁有發球權
    expect(s.setNo).toBe(2);
    expect(s.servingPlayer).toBe(0);
    expect(s.players[1].setArea.length).toBe(1);
    expect(s.players[1].hand.length).toBe(7);
    expect(s.phase).toBe("serve");
    checkInvariants(s);
  });
});

describe("攔網軸 †5-7 與攔網選擇限制（rules_sheet）", () => {
  /**
   * P0 發球（選發球點最低的卡，確保 P1 接得起來）→ P1 走接球軸打出攻擊 → P0 選擇攔網。
   * P1 的接球/托球/攻擊各取第一張合法卡（牌組需含兩種以上卡名以通過同名限制）。
   */
  function toBlockChoiceAfterAttack(db: CardDb, s: GameState): GameState {
    const serves = deployableUids(db, s, 0, "serve");
    const lowestServe = serves.reduce((a, b) =>
      (db.get(s.cards[a]!)!.params!.serve ?? 99) <= (db.get(s.cards[b]!)!.params!.serve ?? 99) ? a : b,
    );
    let st = feed(db, s, { type: "deploy-serve", uid: lowestServe });
    st = feed(db, st, { type: "free", action: "pass" });
    st = feed(db, st, { type: "defense-choice", choice: "receive" });
    st = feed(db, st, { type: "free", action: "pass" }); // draw phase
    for (const area of ["receive", "toss", "attack"] as const) {
      st = feed(db, st, { type: `deploy-${area}`, uid: deployableUids(db, st, 1, area)[0]! } as Decision);
      st = feed(db, st, { type: "free", action: "pass" });
    }
    expect(st.pendingDecision).toEqual({ player: 0, type: "defense-choice" });
    expect(st.op?.source).toBe("attack");
    return feed(db, st, { type: "defense-choice", choice: "block" });
  }

  it("對手的『發球』不能選攔網", () => {
    let s = setupGame(testDb, uniformDeck("T-ACE"), uniformDeck("T-WEAK"), 11);
    s = feed(testDb, s, { type: "deploy-serve", uid: deployableUids(testDb, s, 0, "serve")[0]! });
    s = feed(testDb, s, { type: "free", action: "pass" });
    expect(s.pendingDecision).toEqual({ player: 1, type: "defense-choice" });
    expect(s.op?.source).toBe("serve");
    expect(canChooseBlock(s)).toBe(false);
    expect(() => feed(testDb, s, { type: "defense-choice", choice: "block" })).toThrow(/不能選擇攔網/);
  });

  it("對手『攻擊』後可攔網：DP=合計、同名禁止、成功後 OP=0、側邊者進棄牌區、攔網回球不能再攔", () => {
    // P0：WALL/ACE 混（攔網 DP=5）；P1：WEAK/SETTER 混（攻擊 OP 最大 4+1=5 ≤ 5）
    const deckA = [...Array(20).fill("T-WALL"), ...Array(20).fill("T-ACE")];
    const deckB = [...Array(20).fill("T-WEAK"), ...Array(20).fill("T-SET")];
    let s = setupGame(testDb, deckA, deckB, 13);
    s = toBlockChoiceAfterAttack(testDb, s);
    expect(s.pendingDecision).toEqual({ player: 0, type: "deploy-block" });
    const wall = s.players[0].hand.find((u) => s.cards[u] === "T-WALL")!;
    const wall2 = s.players[0].hand.filter((u) => s.cards[u] === "T-WALL")[1];
    const ace = s.players[0].hand.find((u) => s.cards[u] === "T-ACE")!;
    if (wall2) {
      expect(() => feed(testDb, s, { type: "deploy-block", uids: [wall, wall2], center: wall })).toThrow(/同名/);
    }
    s = feed(testDb, s, { type: "deploy-block", uids: [wall, ace], center: wall });
    s = feed(testDb, s, { type: "free", action: "pass" });
    // DP = 3+2 = 5 ≥ 2 成功 → OP=0(block) → 側邊 ACE 進棄牌區 → P1 回合
    expect(s.op).toMatchObject({ value: 0, owner: 0, source: "block" });
    expect(s.players[0].drop).toContain(ace);
    expect(s.players[0].blockCenter[0]).toBe(wall);
    expect(s.players[0].blockSides.length).toBe(0);
    // P1 面對攔網回球：不能再選攔網
    expect(s.pendingDecision).toEqual({ player: 1, type: "defense-choice" });
    expect(canChooseBlock(s)).toBe(false);
    expect(() => feed(testDb, s, { type: "defense-choice", choice: "block" })).toThrow(/不能選擇攔網/);
    checkInvariants(s);
  });

  it("攔網失敗（DP < OP）→ Lost", () => {
    // P0：WEAK（block1）；P1：WEAK/SETTER 混（攻擊 OP 至少 2 > 1）
    const deckB = [...Array(20).fill("T-WEAK"), ...Array(20).fill("T-SET")];
    let s = setupGame(testDb, uniformDeck("T-WEAK"), deckB, 17);
    s = toBlockChoiceAfterAttack(testDb, s);
    const b = s.players[0].hand[0]!;
    s = feed(testDb, s, { type: "deploy-block", uids: [b], center: b });
    s = feed(testDb, s, { type: "free", action: "pass" });
    expect(s.phase).toBe("interval");
    expect(s.lostBy).toBe(0);
  });
});

describe("勝負 †0-1-3", () => {
  it("Set 區 0 張時宣告 Lost → 立即敗北", () => {
    let s = setupGame(testDb, uniformDeck("T-ACE"), uniformDeck("T-WEAK"), 21);
    // P1 連續輸 3 個 set（每次發球階段 P0 發球 → P1 接球失敗）
    for (let set = 1; set <= 3; set++) {
      s = feed(testDb, s, { type: "deploy-serve", uid: deployableUids(testDb, s, 0, "serve")[0]! });
      s = feed(testDb, s, { type: "free", action: "pass" });
      s = feed(testDb, s, { type: "defense-choice", choice: "receive" });
      s = feed(testDb, s, { type: "free", action: "pass" });
      s = feed(testDb, s, { type: "deploy-receive", uid: deployableUids(testDb, s, 1, "receive")[0]! });
      s = feed(testDb, s, { type: "free", action: "pass" });
      if (set < 3) {
        expect(s.phase).toBe("interval");
        s = feed(testDb, s, { type: "pick-set-card", index: 0 });
      }
    }
    expect(s.phase).toBe("gameOver");
    expect(s.winner).toBe(0);
    checkInvariants(s);
  });
});

describe("隨機整場模擬（真實牌組煙霧測試）", () => {
  const realDb: CardDb = new Map((cardsJson as Card[]).map((c) => [c.id, c]));
  const expandDeck = (d: { cards: { id: string; count: number }[] }) => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

  function randomPlay(seed: number): GameState {
    let rngState = { rngState: seed };
    const rnd = () => { // 測試端自己的亂數（與引擎內部互不干擾）
      let t = (rngState.rngState += 0x9e3779b9);
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
      return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
    };
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;

    let s = createGame(realDb, { seed, decks: [expandDeck(deckKarasuno), expandDeck(deckNekoma)] });
    void pick;
    for (let i = 0; i < 5000; i++) {
      if (s.phase === "gameOver") return s;
      // M3 起改用正式的隨機 AI（src/ai/random.ts）＝引擎決策契約的維護實作，涵蓋效果決策
      s = applyDecision(realDb, s, randomAiDecision(realDb, s, rnd));
      checkInvariants(s);
    }
    throw new Error("5000 步內未分出勝負");
  }

  it("多個種子下隨機對局都能正常結束且不變量恆成立", () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const s = randomPlay(seed);
      expect(s.winner === 0 || s.winner === 1).toBe(true);
    }
  });
});
