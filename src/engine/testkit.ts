// 測試共用：真實卡 DB＋情境構造 helpers（effects.test.ts / karasuno.test.ts 共用）
// 原則：情境構造直接搬移 uid（不經決策），引擎決策一律走 applyDecision 正常驗證路徑。
import { expect } from "vitest";
import { applyDecision, createGame } from "./engine";
import type { CardDb, Decision, GameState, PlayerId } from "./types";
import type { Card } from "../data/types";
import cardsJson from "../../data/cards.json";

export const db: CardDb = new Map((cardsJson as unknown as Card[]).map((c) => [c.id, c]));

export const FILLER = "HV-D01-006"; // 田中 龍之介（烏野 vanilla 1/2/2/1/3）

/** 牌組：指定卡＋filler 補滿 40 */
export const deckWith = (...ids: string[]): string[] => [...ids, ...Array(40 - ids.length).fill(FILLER)];

export function feed(s: GameState, d: Decision): GameState {
  return applyDecision(db, s, d);
}

/** 建局並通過遊戲前手順；serving 指定發球方 */
export function setup(deckA: string[], deckB: string[], serving: PlayerId, seed = 42): GameState {
  let s = createGame(db, { seed, decks: [deckA, deckB], skipDeckValidation: true });
  const decider = s.pendingDecision!.player;
  s = feed(s, { type: "serve-rights", take: decider === serving });
  s = feed(s, { type: "mulligan", returnUids: [] });
  s = feed(s, { type: "mulligan", returnUids: [] });
  return s;
}

/** 從牌組/Set區（或手牌）拿指定卡號到手牌，回傳 uid；exclude 排除已取用的同名卡 */
export function grab(s: GameState, p: PlayerId, cardId: string, exclude: number[] = []): number {
  const ps = s.players[p];
  const inHand = ps.hand.find((u) => s.cards[u] === cardId && !exclude.includes(u));
  if (inHand !== undefined) return inHand;
  for (const zone of [ps.deck, ps.setArea]) {
    const i = zone.findIndex((u) => s.cards[u] === cardId && !exclude.includes(u));
    if (i >= 0) {
      const uid = zone.splice(i, 1)[0]!;
      if (zone === ps.setArea) {
        // Set 區抽走一張會破壞勝負條件數量 → 從牌組補一張 filler 回去
        const j = ps.deck.findIndex((u) => s.cards[u] === FILLER);
        if (j >= 0) ps.setArea.push(ps.deck.splice(j, 1)[0]!);
      }
      ps.hand.push(uid);
      return uid;
    }
  }
  throw new Error(`${cardId} 不在牌組`);
}

export type StackKey = "serve" | "receive" | "toss" | "attack" | "blockCenter";

/** 把指定卡直接搬進疊放區頂（構造既存キャラ/牌組頂用） */
export function placeOnStack(s: GameState, p: PlayerId, area: StackKey, cardId: string): number {
  const uid = grab(s, p, cardId);
  const ps = s.players[p];
  ps.hand.splice(ps.hand.indexOf(uid), 1);
  ps[area].push(uid);
  return uid;
}

/** 把指定卡搬到牌組頂（公開/檢索/mill 測試用） */
export function placeDeckTop(s: GameState, p: PlayerId, cardId: string): number {
  const uid = grab(s, p, cardId);
  const ps = s.players[p];
  ps.hand.splice(ps.hand.indexOf(uid), 1);
  ps.deck.unshift(uid);
  return uid;
}

/** 把指定卡搬進棄牌區（deployFromDrop 測試用） */
export function placeInDrop(s: GameState, p: PlayerId, cardId: string): number {
  const uid = grab(s, p, cardId);
  const ps = s.players[p];
  ps.hand.splice(ps.hand.indexOf(uid), 1);
  ps.drop.push(uid);
  return uid;
}

/** 把 N 張 filler 從牌組搬進指定疊放區底部（充當既存ガッツ） */
export function seedStack(s: GameState, p: PlayerId, area: StackKey, n: number): void {
  const ps = s.players[p];
  for (let k = 0; k < n; k++) {
    const i = ps.deck.findIndex((u) => s.cards[u] === FILLER);
    ps[area].push(ps.deck.splice(i, 1)[0]!);
  }
}

/** 把手牌縮到 n 張（多的塞回牌組底；keep 指定保留的 uid） */
export function setHandSize(s: GameState, p: PlayerId, n: number, keep: number[] = []): void {
  const ps = s.players[p];
  while (ps.hand.length > n) {
    const i = ps.hand.findIndex((u) => !keep.includes(u));
    if (i < 0) break;
    ps.deck.push(ps.hand.splice(i, 1)[0]!);
  }
}

/** 發球：登場指定卡→pass（發球方為現任 turnPlayer） */
export function serveWith(s: GameState, cardId: string): GameState {
  const p = s.turnPlayer;
  const uid = grab(s, p, cardId);
  s = feed(s, { type: "deploy-serve", uid });
  while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
  s = feed(s, { type: "free", action: "pass" });
  return s;
}

/** 排空 CP：resolve-pending 取第一個、effect-confirm 依 accept 處理，直到出現其他決策 */
export function drainCp(s: GameState, accept = false): GameState {
  for (let i = 0; i < 20; i++) {
    const pd = s.pendingDecision;
    if (pd?.type === "resolve-pending") s = feed(s, { type: "resolve-pending", id: pd.candidates![0]! });
    else if (pd?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept });
    else return s;
  }
  throw new Error("drainCp 未收斂");
}

/** 接球軸推進到托球階段：選接球→抽牌pass→登場接球卡→pass（判定須成功；途中 gate 一律拒絕） */
export function receiveTrack(s: GameState, receiverCardId: string): GameState {
  s = feed(s, { type: "defense-choice", choice: "receive" });
  s = feed(s, { type: "free", action: "pass" }); // draw phase
  const uid = grab(s, s.turnPlayer, receiverCardId);
  s = feed(s, { type: "deploy-receive", uid });
  while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
  s = feed(s, { type: "free", action: "pass" });
  expect(s.phase).toBe("toss"); // 接球成功
  return s;
}
