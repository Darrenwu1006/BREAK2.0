// M9a CP4 擺位測試：全卡有位、視角正背面、merge 合成視圖。

import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import karasunoDeck from "../../../data/decks/烏野-預組.json";
import nekomaDeck from "../../../data/decks/音駒-預組.json";
import { heuristicAiDecision } from "../../ai/heuristic";
import type { Card } from "../../data/types";
import { applyDecision, createGame } from "../../engine/engine";
import type { CardDb, GameState } from "../../engine/types";
import { computePlacements, mergePlacements } from "./placements";

interface DeckJson {
  cards: { id: string; count: number }[];
}
const expand = (d: DeckJson): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

const db: CardDb = new Map((cardsJson as unknown as Card[]).map((c) => [c.id, c]));
const schools: [string, string] = ["烏野", "音駒"];

function midGame(): GameState {
  let s = createGame(db, { seed: 20260710, decks: [expand(karasunoDeck as DeckJson), expand(nekomaDeck as DeckJson)] });
  for (let i = 0; i < 60 && s.pendingDecision; i++) s = applyDecision(db, s, heuristicAiDecision(db, s));
  return s;
}

describe("computePlacements", () => {
  it("非牌堆藏牌外的所有 uid 都有擺位；牌組卡不單獨擺（厚度疊表現）", () => {
    const s = midGame();
    const { cards, piles } = computePlacements(db, s, schools);
    for (const player of [0, 1] as const) {
      const ps = s.players[player];
      const placedZones = [ps.hand, ps.setArea, ps.serve, ps.receive, ps.toss, ps.attack, ps.blockCenter, ps.blockSides].flat();
      for (const uid of placedZones) expect(cards.has(uid), `uid ${uid} 應有擺位`).toBe(true);
      for (const uid of ps.deck) expect(cards.has(uid)).toBe(false);
      expect(piles.find((p) => p.key === `deck${player}`)?.count).toBe(ps.deck.length);
    }
  });

  it("視角：P0 手牌正面、P1 手牌背面；Set 區一律背面", () => {
    const s = midGame();
    const { cards } = computePlacements(db, s, schools);
    for (const uid of s.players[0].hand) expect(cards.get(uid)!.faceUp).toBe(true);
    for (const uid of s.players[1].hand) expect(cards.get(uid)!.faceUp).toBe(false);
    for (const player of [0, 1] as const) for (const uid of s.players[player].setArea) expect(cards.get(uid)!.faceUp).toBe(false);
  });

  it("mergePlacements：只有 movedUids 取 target 擺位，其餘維持 base", () => {
    const before = midGame();
    const after = applyDecision(db, before, heuristicAiDecision(db, before));
    const base = computePlacements(db, before, schools);
    const target = computePlacements(db, after, schools);
    const moved = new Set([before.players[0].hand[0]!]);
    const merged = mergePlacements(base, target, moved);
    for (const [uid, p] of merged.cards) {
      expect(p).toBe(moved.has(uid) ? (target.cards.get(uid) ?? base.cards.get(uid)) : base.cards.get(uid));
    }
    expect(mergePlacements(base, target, new Set())).toBe(base);
  });
});
