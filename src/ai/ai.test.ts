// AI 對戰測試：啟發式 AI 應穩定贏過隨機 AI（雙方輪流先後手、固定種子可重現）
import { describe, it, expect } from "vitest";
import { createGame, applyDecision } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import type { Card } from "../data/types";
import { heuristicAiDecision, heuristicProfileForDeckAxes, isImmediateOneTouchBlocker } from "./heuristic";
import { enumerateCandidates, type CoachActionEstimate } from "./coach";
import { __ismctsTest } from "./ismcts";
import { randomAiDecision } from "./random";
import cardsJson from "../../data/cards.json";

const db: CardDb = new Map((cardsJson as Card[]).map((c) => [c.id, c]));
type DeckFixture = { cards: { id: string; count: number }[] };
const deckModules = import.meta.glob<DeckFixture>("../../data/decks/*.json", { eager: true, import: "default" });
const allDecks: { name: string; deck: DeckFixture }[] = Object.entries(deckModules)
  .map(([path, deck]) => ({ name: path.split("/").at(-1)!.replace(/\.json$/, ""), deck }))
  .sort((a, b) => a.name.localeCompare(b.name));
const fixture = (name: string): DeckFixture => {
  const found = allDecks.find((item) => item.name === name)?.deck;
  if (!found) throw new Error(`找不到現存測試牌組：${name}`);
  return found;
};
const deckKarasuno = fixture("烏野-預組");
const deckNekoma = fixture("音駒-音駒-三彈官方");
const expand = (d: DeckFixture) => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);
const fillerDeck = Array(40).fill("HV-D01-006") as string[];

function seededRnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x9e3779b9;
    let t = Math.imul(s ^ (s >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

/** heuristicPlayer 用啟發式，另一方用隨機；回傳贏家 */
function playOut(seed: number, heuristicPlayer: PlayerId): PlayerId {
  const rnd = seededRnd(seed * 7 + 1);
  let s: GameState = createGame(db, { seed, decks: [expand(deckKarasuno), expand(deckNekoma)] });
  for (let i = 0; i < 5000; i++) {
    if (s.phase === "gameOver") return s.winner!;
    const p = s.pendingDecision!.player;
    const d = p === heuristicPlayer ? heuristicAiDecision(db, s) : randomAiDecision(db, s, rnd);
    s = applyDecision(db, s, d);
  }
  throw new Error("5000 步內未分出勝負");
}

function uidOf(s: GameState, p: PlayerId, id: string, used: number[] = []): number {
  const ps = s.players[p];
  const zones = [ps.hand, ps.deck, ps.setArea, ps.drop, ps.eventArea, ps.serve, ps.blockCenter, ps.blockSides, ps.receive, ps.toss, ps.attack];
  for (const zone of zones) {
    const uid = zone.find((u) => s.cards[u] === id && !used.includes(u));
    if (uid !== undefined) return uid;
  }
  throw new Error(`${id} not found`);
}

function removeEverywhere(s: GameState, p: PlayerId, uid: number): void {
  const ps = s.players[p];
  for (const zone of [ps.hand, ps.deck, ps.setArea, ps.drop, ps.eventArea, ps.serve, ps.blockCenter, ps.blockSides, ps.receive, ps.toss, ps.attack]) {
    const i = zone.indexOf(uid);
    if (i >= 0) zone.splice(i, 1);
  }
}

function setHand(s: GameState, p: PlayerId, ids: string[]): number[] {
  const used: number[] = [];
  const uids = ids.map((id) => {
    const uid = uidOf(s, p, id, used);
    used.push(uid);
    return uid;
  });
  for (const uid of uids) removeEverywhere(s, p, uid);
  s.players[p].hand = [...uids];
  return uids;
}

function mulliganState(serving: PlayerId, handIds: string[]): { state: GameState; uids: number[] } {
  const deck = [...handIds, ...Array(40 - handIds.length).fill("HV-D01-006")];
  let s = createGame(db, { seed: 4, decks: serving === 0 ? [deck, fillerDeck] : [fillerDeck, deck], skipDeckValidation: true });
  s = applyDecision(db, s, { type: "serve-rights", take: s.pendingDecision!.player === serving });
  const uids = setHand(s, serving, handIds);
  s.pendingDecision = { player: serving, type: "mulligan" };
  return { state: s, uids };
}

function bareState(handIds: string[] = ["HV-D01-006"]): GameState {
  const deck = [...handIds, ...Array(40 - handIds.length).fill("HV-D01-006")];
  let s = createGame(db, { seed: 9, decks: [deck, fillerDeck], skipDeckValidation: true });
  s = applyDecision(db, s, { type: "serve-rights", take: s.pendingDecision!.player === 0 });
  setHand(s, 0, handIds);
  s.pendingDecision = null;
  return s;
}

function assertPlayerHas40UniqueCards(s: GameState, p: PlayerId): void {
  const ps = s.players[p];
  const zones = [ps.deck, ps.hand, ps.setArea, ps.drop, ps.eventArea, ps.serve, ps.blockCenter, ps.blockSides, ps.receive, ps.toss, ps.attack];
  const all = zones.flat();
  expect(all.length).toBe(40);
  expect(new Set(all).size).toBe(40);
}

describe("啟發式 AI vs 隨機 AI", () => {
  it("10 場（先後手各半）啟發式至少贏 7 場", () => {
    let wins = 0;
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      const hp = (i % 2) as PlayerId;
      const winner = playOut(100 + i, hp);
      if (winner === hp) wins++;
      results.push(`seed${100 + i} 啟發式P${hp} → ${winner === hp ? "勝" : "敗"}`);
    }
    expect(wins, results.join("; ")).toBeGreaterThanOrEqual(7);
  });
});

describe("M5 Heuristic v2 決策品質", () => {
  it("起手換牌會保留先攻高發球、退掉低覆蓋角色", () => {
    const { state, uids } = mulliganState(0, ["HV-D01-004", "HV-P02-011", "HV-P02-011", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    const d = heuristicAiDecision(db, state);
    if (d.type !== "mulligan") throw new Error(`expected mulligan, got ${d.type}`);
    expect(d.returnUids).toContain(uids[1]);
    expect(d.returnUids).not.toContain(uids[0]);
  });

  it("接發球方起手會保留高接球角色", () => {
    const { state, uids } = mulliganState(1, ["HV-D01-005", "HV-P02-011", "HV-P02-011", "HV-P01-033", "HV-D01-006", "HV-D01-006"]);
    const d = heuristicAiDecision(db, state);
    if (d.type !== "mulligan") throw new Error(`expected mulligan, got ${d.type}`);
    expect(d.returnUids).toContain(uids[1]);
    expect(d.returnUids).not.toContain(uids[0]);
  });

  it("自由步驟不會在條件不成立時亂打事件，條件成立才使用", () => {
    const noTarget = bareState(["HV-P01-087", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    noTarget.phase = "serve";
    noTarget.turnPlayer = 0;
    noTarget.pendingDecision = { player: 0, type: "free" };
    expect(heuristicAiDecision(db, noTarget)).toEqual({ type: "free", action: "pass" });

    const withTarget = bareState(["HV-P01-087", "HV-P01-033", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    const oikawa = uidOf(withTarget, 0, "HV-P01-033");
    removeEverywhere(withTarget, 0, oikawa);
    withTarget.players[0].serve.push(oikawa);
    withTarget.phase = "serve";
    withTarget.turnPlayer = 0;
    withTarget.pendingDecision = { player: 0, type: "free" };
    const d = heuristicAiDecision(db, withTarget);
    expect(d).toMatchObject({ type: "free", action: "event" });
  });

  it("gate confirm 會拒絕高成本低收益，也會接受抽牌", () => {
    const s = bareState(["HV-D01-006"]);
    const source = s.players[0].hand[0]!;
    s.pendingDecision = { player: 0, type: "effect-confirm" };
    s.effectCtx = {
      player: 0,
      source,
      frames: [],
      lastTarget: null,
      triggerUid: null,
      turn1: false,
      anyExecuted: false,
      awaiting: { kind: "confirm", what: "gate", costs: [{ type: "millDeck", count: 8 }], then: [], prompt: "test" },
      desc: "test",
    };
    expect(heuristicAiDecision(db, s)).toEqual({ type: "effect-confirm", accept: false });

    s.effectCtx.awaiting = { kind: "confirm", what: "draw", then: [], count: 2, prompt: "draw" };
    expect(heuristicAiDecision(db, s)).toEqual({ type: "effect-confirm", accept: true });
  });

  it("effect-cards 成本選低價值手牌，不棄關鍵接球員", () => {
    const s = bareState(["HV-D01-005", "HV-P02-011", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    const nishinoya = uidOf(s, 0, "HV-D01-005");
    const low = uidOf(s, 0, "HV-P02-011");
    s.pendingDecision = { player: 0, type: "effect-cards", candidates: [nishinoya, low], min: 1, max: 1 };
    s.effectCtx = {
      player: 0,
      source: s.players[0].hand[0]!,
      frames: [],
      lastTarget: null,
      triggerUid: null,
      turn1: false,
      anyExecuted: false,
      awaiting: { kind: "cards", purpose: "dropHand", candidates: [nishinoya, low], min: 1, max: 1, prompt: "drop" },
      desc: "test",
    };
    expect(heuristicAiDecision(db, s)).toEqual({ type: "effect-cards", uids: [low] });
  });

  it("effect-option 會依目前 phase 選擇較相關的參數", () => {
    const s = bareState(["HV-D01-001"]);
    const hinata = s.players[0].hand[0]!;
    s.phase = "attack";
    s.pendingDecision = { player: 0, type: "effect-option", options: ["receive", "attack"] };
    s.effectCtx = {
      player: 0,
      source: hinata,
      frames: [],
      lastTarget: null,
      triggerUid: null,
      turn1: false,
      anyExecuted: false,
      awaiting: { kind: "option", purpose: "param", targetUid: hinata, amount: 1, options: ["receive", "attack"], prompt: "param" },
      desc: "test",
    };
    expect(heuristicAiDecision(db, s)).toEqual({ type: "effect-option", index: 1 });
  });

  it("攔網時把高未來價值角色留在 center，低價值角色放 side", () => {
    const s = bareState(["HV-D01-004", "HV-P02-011", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    const yamaguchi = uidOf(s, 0, "HV-D01-004");
    s.turnPlayer = 0;
    s.op = { owner: 1, value: 5, source: "attack" };
    s.pendingDecision = { player: 0, type: "deploy-block" };
    const d = heuristicAiDecision(db, s);
    if (d.type !== "deploy-block") throw new Error(`expected deploy-block, got ${d.type}`);
    expect(d.uids).not.toBeNull();
    if (d.uids) expect(d.center).toBe(yamaguchi);
  });

  it("One Touch 路線只登場來源卡於中央，不為湊 DP 多消耗一張手牌", () => {
    const s = bareState(["HV-P02-049", "HV-P03-072", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    const tendo = uidOf(s, 0, "HV-P02-049");
    s.turnPlayer = 0;
    s.phase = "block";
    s.op = { owner: 1, value: 7, source: "attack" };
    s.pendingDecision = { player: 0, type: "deploy-block" };

    const decision = heuristicAiDecision(db, s);
    expect(decision).toEqual({ type: "deploy-block", uids: [tendo], center: tendo, nameChoices: {} });

    let resolved = applyDecision(db, s, decision);
    expect(resolved.pendingDecision?.type).toBe("effect-confirm");
    resolved = applyDecision(db, resolved, heuristicAiDecision(db, resolved));
    expect(resolved.phase).toBe("draw");
    expect(resolved.players[0].hand).toHaveLength(6);
    expect(resolved.players[0].blockCenter).toContain(tendo);
    expect(resolved.players[0].drop).not.toContain(tendo);
  });

  it("One Touch 單張中央會優先進入搜尋候選，近似勝率時壓過雙張消耗", () => {
    const s = bareState(["HV-P02-049", "HV-P03-072", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    const tendo = uidOf(s, 0, "HV-P02-049");
    const semi = uidOf(s, 0, "HV-P03-072");
    s.turnPlayer = 0;
    s.phase = "block";
    s.op = { owner: 1, value: 7, source: "attack" };
    s.pendingDecision = { player: 0, type: "deploy-block" };
    const lean: Decision = { type: "deploy-block", uids: [tendo], center: tendo, nameChoices: {} };
    const wasteful: Decision = { type: "deploy-block", uids: [tendo, semi], center: semi, nameChoices: {} };

    expect(enumerateCandidates(db, s, 3, wasteful)[0]).toEqual(lean);

    const estimate = (decision: Decision, winRate: number, sampleCount: number): CoachActionEstimate => ({
      decision,
      label: "test",
      winRate,
      confidence: 0.6,
      sampleCount,
      wins: Math.round(winRate * sampleCount),
      errors: 0,
      maxSteps: 0,
      principalLine: [],
      explanation: "test",
    });
    const selected = __ismctsTest.chooseRootTieBreakBest(
      db,
      s,
      [estimate(wasteful, 0.6, 100), estimate(lean, 0.58, 80)],
      0,
      0.04,
      false,
    );
    expect(selected?.decision).toEqual(lean);
  });

  it("終局候選（不登場／Lost）不參與 root pressure tie-break；robust best 為終局時保留資源保全", () => {
    // [Claude 2026-07-19] AI 提前 Lost 窄修的回歸測試（診斷見 reports/26：Match 10 比賽點
    // Lost 0% 被壓力 tie-break 反轉壓過福永 3.99%）。
    const s = bareState(["HV-P02-045", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    const receiver = uidOf(s, 0, "HV-P02-045"); // 接球 5，能過 OP2 判定
    s.turnPlayer = 0;
    s.phase = "receive";
    s.sub = 0;
    s.op = { owner: 1, value: 2, source: "serve" };
    s.pendingDecision = { player: 0, type: "deploy-receive" };
    const deploy: Decision = { type: "deploy-receive", uid: receiver };
    const giveUp: Decision = { type: "deploy-receive", uid: null }; // 不登場＝立即宣告 Lost

    expect(__ismctsTest.decisionImmediatelyLosesSetOrMatch(db, s, giveUp, 0)).toBe(true);
    expect(__ismctsTest.decisionImmediatelyLosesSetOrMatch(db, s, deploy, 0)).toBe(false);

    const estimate = (decision: Decision, winRate: number, sampleCount: number): CoachActionEstimate => ({
      decision,
      label: "test",
      winRate,
      confidence: 0.6,
      sampleCount,
      wins: Math.round(winRate * sampleCount),
      errors: 0,
      maxSteps: 0,
      principalLine: [],
      explanation: "test",
    });
    // robust best＝合法接球、不登場在 4pp 內：終局候選被剔除後只剩單一候選 → tie-break 必須
    // 棄權（回傳 null＝維持 robust best），不得讓 Lost 因保留手牌的壓力分數被反轉成首選。
    const whenLegalIsBest = __ismctsTest.chooseRootTieBreakBest(
      db,
      s,
      [estimate(deploy, 0.05, 100), estimate(giveUp, 0.04, 90)],
      0,
      0.04,
      false,
    );
    expect(whenLegalIsBest).toBeNull();
    // robust best 本身就是終局（MCTS 判定所有路線等價失敗）：保留原壓力 tie-break（資源保全）。
    const whenGiveUpIsBest = __ismctsTest.chooseRootTieBreakBest(
      db,
      s,
      [estimate(giveUp, 0.03, 100), estimate(deploy, 0.05, 90)],
      0,
      0.04,
      false,
    );
    expect(whenGiveUpIsBest).not.toBeNull();
  });

  it("One Touch 被禁止或 OP 條件未成立時，不套用單張節約路線", () => {
    const s = bareState(["HV-P02-049", "HV-P03-072", "HV-D01-006", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    const tendo = uidOf(s, 0, "HV-P02-049");
    s.turnPlayer = 0;
    s.phase = "block";
    s.op = { owner: 1, value: 7, source: "attack" };
    s.pendingDecision = { player: 0, type: "deploy-block" };
    s.restrictions.push({ player: 0, banOneTouch: true, setNo: s.setNo, activeTurn: s.turnNo, desc: "test" });

    expect(isImmediateOneTouchBlocker(db, s, 0, tendo)).toBe(false);

    s.restrictions = [];
    s.op = { owner: 1, value: 3, source: "attack" };
    expect(isImmediateOneTouchBlocker(db, s, 0, tendo)).toBe(false);
  });

  it("攔網軸 profile 會在接球可行時仍優先考慮可過判定的攔網", () => {
    const s = bareState(["HV-P02-045", "HV-P02-039", "HV-P02-044", "HV-D01-006", "HV-D01-006", "HV-D01-006"]);
    s.turnPlayer = 0;
    s.op = { owner: 1, value: 5, source: "attack" };
    s.pendingDecision = { player: 0, type: "defense-choice" };

    expect(heuristicAiDecision(db, s)).toEqual({ type: "defense-choice", choice: "receive" });
    expect(heuristicAiDecision(db, s, heuristicProfileForDeckAxes(["block", "defense"]))).toEqual({ type: "defense-choice", choice: "block" });
  });

  it("攔網軸 profile 會提高攔網相關效果的使用意願", () => {
    const s = bareState(["HV-D01-006"]);
    const source = s.players[0].hand[0]!;
    s.pendingDecision = { player: 0, type: "effect-confirm" };
    s.effectCtx = {
      player: 0,
      source,
      frames: [],
      lastTarget: null,
      triggerUid: null,
      turn1: false,
      anyExecuted: false,
      awaiting: {
        kind: "confirm",
        what: "gate",
        costs: [{ type: "placeEventFromHand" }],
        then: [{ op: "moveSelfToBlockSide" }],
        prompt: "block side",
      },
      desc: "test",
    };

    expect(heuristicAiDecision(db, s)).toEqual({ type: "effect-confirm", accept: false });
    expect(heuristicAiDecision(db, s, "heuristic-v2-block")).toEqual({ type: "effect-confirm", accept: true });
  });

  it("會接受零成本且直接提高當前攻擊點數的 gate", () => {
    const s = bareState(["HV-P01-043", "HV-P01-050", "HV-P01-046"]);
    const source = s.players[0].hand[0]!;
    removeEverywhere(s, 0, source);
    s.players[0].attack = [source];
    s.phase = "attack";
    s.pendingDecision = { player: 0, type: "effect-confirm" };
    s.effectCtx = {
      player: 0,
      source,
      frames: [],
      lastTarget: null,
      triggerUid: null,
      turn1: false,
      anyExecuted: false,
      awaiting: {
        kind: "confirm",
        what: "gate",
        costs: [],
        then: [{ op: "addParam", target: "self", param: "attack", amount: 5 }],
        prompt: "use free attack buff",
      },
      desc: "木兎 光太郎 的登場技能",
    };

    expect(heuristicAiDecision(db, s, "heuristic-v2-burst")).toEqual({ type: "effect-confirm", accept: true });
  });

  it("現存牌組皆可用 heuristic v2 跑完整場且維持 40 張不變量", () => {
    for (let i = 0; i < allDecks.length; i++) {
      const a = allDecks[i]!;
      const b = allDecks[(i + 1) % allDecks.length]!;
      let s: GameState = createGame(db, { seed: 700 + i, decks: [expand(a.deck), expand(b.deck)] });
      for (let step = 0; step < 5000 && s.phase !== "gameOver"; step++) {
        s = applyDecision(db, s, heuristicAiDecision(db, s));
      }
      expect(s.winner, `${a.name} vs ${b.name}`).not.toBeNull();
      assertPlayerHas40UniqueCards(s, 0);
      assertPlayerHas40UniqueCards(s, 1);
    }
  });
});
