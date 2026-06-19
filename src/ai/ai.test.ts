// AI 對戰測試：啟發式 AI 應穩定贏過隨機 AI（雙方輪流先後手、固定種子可重現）
import { describe, it, expect } from "vitest";
import { createGame, applyDecision } from "../engine/engine";
import type { CardDb, GameState, PlayerId } from "../engine/types";
import type { Card } from "../data/types";
import { heuristicAiDecision, heuristicProfileForDeckAxes } from "./heuristic";
import { randomAiDecision } from "./random";
import cardsJson from "../../data/cards.json";
import deckAoba2 from "../../data/decks/青葉城西-二彈改.json";
import deckAobaFast from "../../data/decks/青葉城西-快攻軸.json";
import deckDateBlock from "../../data/decks/伊達工業-攔網軸.json";
import deckDateBlock2 from "../../data/decks/伊達工業-攔網軸改.json";
import deckFukurodani2 from "../../data/decks/梟谷-爆發軸二.json";
import deckFukurodaniHigh from "../../data/decks/梟谷-高爆發軸.json";
import deckGarbage from "../../data/decks/混合學校-垃圾場.json";
import deckInarizaki6 from "../../data/decks/稲荷崎-六名軸.json";
import deckInarizakiPrecon from "../../data/decks/稲荷崎-預組.json";
import deckKarasunoAttack from "../../data/decks/烏野-日影攻擊軸.json";
import deckKarasunoBlock from "../../data/decks/烏野-山月攔網軸.json";
import deckKarasuno from "../../data/decks/烏野-預組.json";
import deckNekoma from "../../data/decks/音駒-預組.json";
import deckShiratorizawa from "../../data/decks/白鳥沢-白板軸.json";

const db: CardDb = new Map((cardsJson as Card[]).map((c) => [c.id, c]));
const expand = (d: { cards: { id: string; count: number }[] }) => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);
const fillerDeck = Array(40).fill("HV-D01-006") as string[];

const allDecks: { name: string; deck: { cards: { id: string; count: number }[] } }[] = [
  { name: "青葉城西-二彈改", deck: deckAoba2 },
  { name: "青葉城西-快攻軸", deck: deckAobaFast },
  { name: "伊達工業-攔網軸", deck: deckDateBlock },
  { name: "伊達工業-攔網軸改", deck: deckDateBlock2 },
  { name: "梟谷-爆發軸二", deck: deckFukurodani2 },
  { name: "梟谷-高爆發軸", deck: deckFukurodaniHigh },
  { name: "混合學校-垃圾場", deck: deckGarbage },
  { name: "稲荷崎-六名軸", deck: deckInarizaki6 },
  { name: "稲荷崎-預組", deck: deckInarizakiPrecon },
  { name: "烏野-日影攻擊軸", deck: deckKarasunoAttack },
  { name: "烏野-山月攔網軸", deck: deckKarasunoBlock },
  { name: "烏野-預組", deck: deckKarasuno },
  { name: "音駒-預組", deck: deckNekoma },
  { name: "白鳥沢-白板軸", deck: deckShiratorizawa },
];

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

  it("14 副牌組皆可用 heuristic v2 跑完整場且維持 40 張不變量", () => {
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
