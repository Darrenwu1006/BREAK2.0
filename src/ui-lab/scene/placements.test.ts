// M9a CP4 擺位測試：全卡有位、視角正背面、merge 合成視圖。

import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import karasunoDeck from "../../../data/decks/烏野-預組.json";
import nekomaDeck from "../../../data/decks/音駒-預組.json";
import { heuristicAiDecision } from "../../ai/heuristic";
import type { Card } from "../../data/types";
import { applyDecision, createGame } from "../../engine/engine";
import type { CardDb, GameState } from "../../engine/types";
import { blockSideAnchor, CARD_T, setAreaAnchor, SLOT_H, SLOT_W, zoneAnchor } from "./layout";
import { computePlacements, HAND_COS, HAND_SIN, HAND_SPAN, mergePlacements } from "./placements";

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

  /** LP0 不破圖不變量（對任意手牌張數都必須成立——CP5d 的洞就是少牌時 rotY 差過大） */
  function assertHandNoClip(s: GameState): void {
    const { cards } = computePlacements(db, s, schools);
    const hand = s.players[0].hand.map((uid) => cards.get(uid)!);
    // 平行平面族：全部 rotY=0、rotX 相同（rotZ 是卡面內滾轉、不改平面朝向）
    for (const p of hand) {
      expect(p.rotation[1], "手牌 rotY 必須為 0（平行平面保證）").toBe(0);
      expect(p.rotation[0]).toBe(hand[0]!.rotation[0]);
    }
    // x 左到右遞增、整體寬度收在固定範圍內
    for (let i = 1; i < hand.length; i++) expect(hand[i]!.position[0]).toBeGreaterThan(hand[i - 1]!.position[0]);
    if (hand.length > 1) expect(hand[hand.length - 1]!.position[0] - hand[0]!.position[0]).toBeLessThanOrEqual(HAND_SPAN + 1e-6);
    // 相鄰卡沿卡面法線 n̂=(0,cosθ,sinθ) 的間距必須大於卡厚（右卡恆在左卡上方）
    for (let i = 1; i < hand.length; i++) {
      const dy = hand[i]!.position[1] - hand[i - 1]!.position[1];
      const dz = hand[i]!.position[2] - hand[i - 1]!.position[2];
      const sep = dy * HAND_COS + dz * HAND_SIN;
      expect(sep, `相鄰手牌 ${i - 1}/${i} 法線間距`).toBeGreaterThan(CARD_T);
    }
    // hover/highlight 位移必須是卡面內移動（沿法線分量 ≈ 0）——平行性在互動中也不破
    for (const p of hand) {
      for (const off of [p.hoverOffset, p.highlightOffset]) {
        expect(off, "手牌必須帶安全位移").toBeDefined();
        const n = off![1] * HAND_COS + off![2] * HAND_SIN;
        expect(Math.abs(n), "hover/highlight 位移的法線分量").toBeLessThan(1e-9);
      }
    }
  }

  it("P0 手牌：Pocket 淺弧＋固定範圍填滿＋平行平面不破圖不變量", () => {
    const s = midGame();
    assertHandNoClip(s);
    const { cards } = computePlacements(db, s, schools);
    const hand = s.players[0].hand.map((uid) => cards.get(uid)!);
    // 淺弧：中間比兩端高；外側牌帶面內滾轉角（左正右負）
    const mid = Math.floor((hand.length - 1) / 2);
    expect(hand[mid]!.position[1]).toBeGreaterThan(hand[0]!.position[1]);
    expect(hand[0]!.rotation[2]).toBeGreaterThan(0);
    expect(hand[hand.length - 1]!.rotation[2]).toBeLessThan(0);
  });

  it("P0 手牌少（2/3/4 張）時同樣不破圖——CP5d 迴歸案例", () => {
    const s = midGame();
    for (const keep of [4, 3, 2]) {
      const ps = s.players[0];
      while (ps.hand.length > keep) ps.deck.push(ps.hand.pop()!);
      assertHandNoClip(s);
    }
  });

  it("P1 蓋牌扇：相鄰層距 > 卡厚（平放卡 rotY＝面內滾轉，只需層距）", () => {
    const s = midGame();
    const { cards } = computePlacements(db, s, schools);
    const hand = s.players[1].hand.map((uid) => cards.get(uid)!);
    for (let i = 1; i < hand.length; i++) {
      expect(hand[i]!.position[1] - hand[i - 1]!.position[1], `P1 手牌 ${i - 1}/${i} 層距`).toBeGreaterThan(CARD_T);
      expect(hand[i]!.rotation[0]).toBe(0);
    }
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
