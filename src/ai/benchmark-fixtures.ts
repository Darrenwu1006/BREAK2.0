import type { Card, Deck } from "../data/types";
import type { CardDb } from "../engine/types";
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

export interface BenchmarkDeck {
  name: string;
  ids: string[];
  source: string;
  axes: DeckAxis[];
}

export const benchmarkDb: CardDb = new Map((cardsJson as Card[]).map((card) => [card.id, card]));

export type DeckAxis = "serve" | "block" | "burst" | "defense" | "hybrid";

function expandDeck(deck: Deck, axes: DeckAxis[]): BenchmarkDeck {
  return {
    name: deck.name,
    ids: deck.cards.flatMap((entry) => Array(entry.count).fill(entry.id) as string[]),
    source: deck.source,
    axes,
  };
}

const deckJsons: { deck: Deck; axes: DeckAxis[] }[] = [
  { deck: deckAoba2, axes: ["serve", "hybrid"] },
  { deck: deckAobaFast, axes: ["burst", "hybrid"] },
  { deck: deckDateBlock, axes: ["block", "defense"] },
  { deck: deckDateBlock2, axes: ["block", "defense"] },
  { deck: deckFukurodani2, axes: ["burst"] },
  { deck: deckFukurodaniHigh, axes: ["burst"] },
  { deck: deckGarbage, axes: ["hybrid", "defense"] },
  { deck: deckInarizaki6, axes: ["hybrid", "burst"] },
  { deck: deckInarizakiPrecon, axes: ["hybrid"] },
  { deck: deckKarasunoAttack, axes: ["burst"] },
  { deck: deckKarasunoBlock, axes: ["block"] },
  { deck: deckKarasuno, axes: ["hybrid"] },
  { deck: deckNekoma, axes: ["defense"] },
  { deck: deckShiratorizawa, axes: ["serve", "burst"] },
];

export const benchmarkDecks: BenchmarkDeck[] = deckJsons.map(({ deck, axes }) => expandDeck(deck, axes));

export function findBenchmarkDeck(name: string): BenchmarkDeck {
  const deck = benchmarkDecks.find((candidate) => candidate.name === name);
  if (!deck) throw new Error(`找不到牌組 "${name}"`);
  return deck;
}
