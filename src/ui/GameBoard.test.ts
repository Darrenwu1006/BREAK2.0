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

function renderBoard(
  state: GameState,
  revealOpponentHand = false,
  thought: { aiThoughtText?: string | null; aiThoughtSpoiler?: boolean } = {},
): string {
  return renderToStaticMarkup(createElement(GameBoard, {
    db,
    state,
    deckMeta: [
      { school: "烏野", name: "預組", total: 40, implementedCount: 40, unimplementedCount: 0 },
      { school: "音駒", name: "三彈官方", total: 40, implementedCount: 40, unimplementedCount: 0 },
    ],
    revealOpponentHand,
    aiThoughtText: thought.aiThoughtText,
    aiThoughtSpoiler: thought.aiThoughtSpoiler,
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

describe("GameBoard aiThought bubble", () => {
  const createLiveState = () => createGame(db, {
    seed: 20260718,
    decks: [expand(karasunoDeck as DeckJson), expand(nekomaDeck as DeckJson)],
  });

  it("傳入 aiThoughtText 且非覆盤時，在對方手牌與對方 Set 堆之間渲染對話框", () => {
    const live = createLiveState();
    const text = "這球接得住，先別急著交牌。對面 Guts 越堆越多，得留一手防後面大招。";
    const markup = renderBoard(live, false, { aiThoughtText: text });

    expect(markup).toContain("ai-thought-slot");
    expect(markup).toContain("ai-thought-bubble");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain("對手心聲");
    expect(markup).toContain(text);
    expect(markup).not.toContain("is-spoiler");
    expect(markup).not.toContain("測試暴雷");

    const oppHandIdx = markup.indexOf('class="opponent-hand"');
    const slotIdx = markup.indexOf('class="ai-thought-slot"');
    const bubbleIdx = markup.indexOf('class="ai-thought-bubble"');
    const oppSetIdx = markup.indexOf('data-zone-anchor="p1-set"');
    expect(oppHandIdx).toBeGreaterThan(-1);
    expect(slotIdx).toBeGreaterThan(oppHandIdx);
    expect(bubbleIdx).toBeGreaterThan(slotIdx);
    expect(oppSetIdx).toBeGreaterThan(bubbleIdx);
  });

  it("傳入 aiThoughtSpoiler: true 時，附加 is-spoiler 樣式與測試暴雷標籤", () => {
    const live = createLiveState();
    const text = "已經接得住，先扣著防禦事件不交（Pass 58% ＞ 開事件 54%）。";
    const markup = renderBoard(live, false, {
      aiThoughtText: text,
      aiThoughtSpoiler: true,
    });

    expect(markup).toContain("ai-thought-bubble is-spoiler");
    expect(markup).toContain("測試暴雷");
    expect(markup).toContain(text);
  });

  it("revealOpponentHand 為 true、終局或無有效 aiThoughtText 時，保留彈性槽但不渲染對話框", () => {
    const live = createLiveState();
    const text = "節奏在我這邊，這手穩穩把壓力打過去就好。";

    const revealedMarkup = renderBoard(live, true, { aiThoughtText: text, aiThoughtSpoiler: true });
    expect(revealedMarkup).toContain("ai-thought-slot");
    expect(revealedMarkup).not.toContain("ai-thought-bubble");
    expect(revealedMarkup).not.toContain(text);

    const ended = structuredClone(live);
    ended.phase = "gameOver";
    ended.pendingDecision = null;
    ended.winner = 1;
    const endedMarkup = renderBoard(ended, false, { aiThoughtText: text });
    expect(endedMarkup).toContain("ai-thought-slot");
    expect(endedMarkup).not.toContain("ai-thought-bubble");
    expect(endedMarkup).not.toContain(text);

    for (const emptyValue of [undefined, null, "", "   "] as const) {
      const emptyMarkup = renderBoard(live, false, { aiThoughtText: emptyValue });
      expect(emptyMarkup).toContain("ai-thought-slot");
      expect(emptyMarkup).not.toContain("ai-thought-bubble");
    }
  });
});
