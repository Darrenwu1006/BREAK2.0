// M9a CP4 擺位測試：全卡有位、視角正背面、merge 合成視圖。

import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import karasunoDeck from "../../../data/decks/烏野-預組.json";
import nekomaDeck from "../../../data/decks/音駒-預組.json";
import { heuristicAiDecision } from "../../ai/heuristic";
import type { Card } from "../../data/types";
import { applyDecision, createGame } from "../../engine/engine";
import type { CardDb, GameState } from "../../engine/types";
import { blockSideAnchor, setAreaAnchor, SLOT_H, SLOT_W, zoneAnchor } from "./layout";
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

  it("P0 手牌是 Pocket 式淺弧扇形，並以極小景深級距維持右卡在上", () => {
    const s = midGame();
    const { cards } = computePlacements(db, s, schools);
    const hand = s.players[0].hand.map((uid) => cards.get(uid)!);
    for (let i = 1; i < hand.length; i++) {
      expect(hand[i]!.position[0]).toBeGreaterThan(hand[i - 1]!.position[0]);
      expect(hand[i]!.position[2]).toBeGreaterThan(hand[i - 1]!.position[2]);
    }
    expect(hand[Math.floor((hand.length - 1) / 2)]!.position[1]).toBeGreaterThan(hand[0]!.position[1]);
    expect(hand[Math.ceil((hand.length - 1) / 2)]!.position[1]).toBeGreaterThan(hand[hand.length - 1]!.position[1]);
    expect(hand[0]!.rotation[2]).toBeGreaterThan(0);
    expect(hand[hand.length - 1]!.rotation[2]).toBeLessThan(0);
  });

  it("P0 場上卡槽保留完整間距；接球/托球/攻擊列在 Set 卡列下方", () => {
    const anchors = [
      zoneAnchor(0, "blockCenter"),
      blockSideAnchor(0, 0),
      blockSideAnchor(0, 1),
      zoneAnchor(0, "receive"),
      zoneAnchor(0, "toss"),
      zoneAnchor(0, "attack"),
      zoneAnchor(0, "serve"),
      zoneAnchor(0, "eventArea"),
      setAreaAnchor(0, 0),
      setAreaAnchor(0, 1),
      zoneAnchor(0, "deck"),
      zoneAnchor(0, "drop"),
    ];
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const a = anchors[i]!;
        const b = anchors[j]!;
        expect(Math.abs(a.x - b.x) >= SLOT_W || Math.abs(a.z - b.z) >= SLOT_H, `slot ${i}/${j} 不應重疊`).toBe(true);
      }
    }
    expect(zoneAnchor(0, "receive").z).toBeGreaterThan(setAreaAnchor(0, 1).z);
    expect(zoneAnchor(0, "toss").z).toBeGreaterThan(zoneAnchor(0, "blockCenter").z);
    expect(zoneAnchor(0, "attack").z).toBeGreaterThan(zoneAnchor(0, "blockCenter").z);
    expect(setAreaAnchor(0, 0).z).toBe(setAreaAnchor(0, 1).z);
    expect(setAreaAnchor(0, 0).x).not.toBe(setAreaAnchor(0, 1).x);
    expect(setAreaAnchor(0, 0).z - SLOT_H / 2).toBeGreaterThan(0);
    expect(Math.abs(setAreaAnchor(1, 0).z) - SLOT_H / 2).toBeGreaterThan(0);
    expect(zoneAnchor(0, "serve").z).toBeLessThan(zoneAnchor(0, "hand").z);
    expect(zoneAnchor(0, "eventArea").z).toBeLessThan(zoneAnchor(0, "hand").z);
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
