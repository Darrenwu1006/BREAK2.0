// AI 對戰測試：啟發式 AI 應穩定贏過隨機 AI（雙方輪流先後手、固定種子可重現）
import { describe, it, expect } from "vitest";
import { createGame, applyDecision } from "../engine/engine";
import type { CardDb, GameState, PlayerId } from "../engine/types";
import type { Card } from "../data/types";
import { heuristicAiDecision } from "./heuristic";
import { randomAiDecision } from "./random";
import cardsJson from "../../data/cards.json";
import deckKarasuno from "../../data/decks/烏野-預組.json";
import deckNekoma from "../../data/decks/音駒-預組.json";

const db: CardDb = new Map((cardsJson as Card[]).map((c) => [c.id, c]));
const expand = (d: { cards: { id: string; count: number }[] }) => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

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
