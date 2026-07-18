import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import karasunoDeck from "../../data/decks/烏野-預組.json";
import nekomaDeck from "../../data/decks/音駒-音駒-三彈官方.json";
import type { Card } from "../data/types";
import { createGame } from "../engine/engine";
import type { CardDb, GameState } from "../engine/types";
import { GameBoard } from "./GameBoard";

interface DeckJson {
  cards: { id: string; count: number }[];
}

const expand = (deck: DeckJson): string[] => deck.cards.flatMap((entry) => Array(entry.count).fill(entry.id) as string[]);
const db: CardDb = new Map((cardsJson as unknown as Card[]).map((card) => [card.id, card]));

function renderBoard(state: GameState, revealOpponentHand = false): string {
  return renderToStaticMarkup(createElement(GameBoard, {
    db,
    state,
    deckMeta: [
      { school: "烏野", name: "預組", total: 40, implementedCount: 40, unimplementedCount: 0 },
      { school: "音駒", name: "三彈官方", total: 40, implementedCount: 40, unimplementedCount: 0 },
    ],
    revealOpponentHand,
    canPickSet: false,
    deployArea: null,
    activeGutsKey: null,
    recentUids: new Set<number>(),
    settledUids: new Set<number>(),
    candidateUids: [],
    selectableUids: [],
    selectedUids: [],
    hoveredUid: null,
    dragOverArea: null,
    onPickSet: () => undefined,
    onOpenDrop: () => undefined,
    onOpenEvent: () => undefined,
    onToggleGuts: () => undefined,
    onDropCard: () => undefined,
    onSelectUid: () => undefined,
    onHover: () => undefined,
    onInspect: () => undefined,
  }));
}

describe("GameBoard opponent hand reveal", () => {
  it("正常對局中蓋住電腦手牌，覆盤模式公開該步手牌", () => {
    const live = createGame(db, {
      seed: 20260718,
      decks: [expand(karasunoDeck as DeckJson), expand(nekomaDeck as DeckJson)],
    });
    expect(renderBoard(live)).not.toContain("opponent-hand is-revealed");
    const replayMarkup = renderBoard(live, true);
    expect(replayMarkup).toContain("opponent-hand is-revealed");
    expect(replayMarkup).toContain("電腦公開手牌");
  });

  it("不在覆盤模式時，整場結束仍會公開電腦手牌", () => {
    const live = createGame(db, {
      seed: 20260718,
      decks: [expand(karasunoDeck as DeckJson), expand(nekomaDeck as DeckJson)],
    });
    const ended = structuredClone(live);
    ended.phase = "gameOver";
    ended.pendingDecision = null;
    ended.winner = 1;
    const markup = renderBoard(ended);
    expect(markup).toContain("opponent-hand is-revealed");
    expect(markup).toContain("電腦公開手牌");
  });
});
