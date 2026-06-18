import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card, Deck } from "../data/types";
import type { CardDb } from "../engine/types";
import cardsJson from "../../data/cards.json";

export interface BenchmarkDeck {
  name: string;
  ids: string[];
  source: string;
  axes: DeckAxis[];
}

export const benchmarkDb: CardDb = new Map((cardsJson as Card[]).map((card) => [card.id, card]));

export type DeckAxis = "serve" | "block" | "burst" | "defense" | "hybrid";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DECK_DIR = join(ROOT, "data", "decks");

const AXIS_OVERRIDES: Record<string, DeckAxis[]> = {
  "青葉城西-二彈改": ["serve", "hybrid"],
  "青葉城西-快攻軸": ["burst", "hybrid"],
  "伊達工業-攔網軸": ["block", "defense"],
  "伊達工業-攔網軸改": ["block", "defense"],
  "梟谷-爆發軸二": ["burst"],
  "梟谷-高爆發軸": ["burst"],
  "混合學校-垃圾場": ["hybrid", "defense"],
  "稲荷崎-六名軸": ["hybrid", "burst"],
  "稲荷崎-預組": ["hybrid"],
  "稻荷崎-0612測試": ["hybrid", "burst"],
  "烏野-日影攻擊軸": ["burst"],
  "烏野-山月攔網軸": ["block"],
  "烏野-預組": ["hybrid"],
  "音駒-預組": ["defense"],
  "白鳥沢-白板軸": ["serve", "burst"],
};

function expandDeck(deck: Deck, axes: DeckAxis[]): BenchmarkDeck {
  return {
    name: deck.name,
    ids: deck.cards.flatMap((entry) => Array(entry.count).fill(entry.id) as string[]),
    source: deck.source,
    axes,
  };
}

function hasTextAxis(name: string, source: string, pattern: RegExp): boolean {
  return pattern.test(name) || pattern.test(source);
}

function inferDeckAxes(deck: Deck): DeckAxis[] {
  const axes = new Set<DeckAxis>();
  if (hasTextAxis(deck.name, deck.source, /發球|サーブ|serve/i)) axes.add("serve");
  if (hasTextAxis(deck.name, deck.source, /攔網|ブロック|block/i)) axes.add("block");
  if (hasTextAxis(deck.name, deck.source, /爆發|攻擊|快攻|burst|attack/i)) axes.add("burst");
  if (hasTextAxis(deck.name, deck.source, /防守|接球|垃圾場|defense|receive/i)) axes.add("defense");

  let servePressure = 0;
  let blockPressure = 0;
  let attackPressure = 0;
  let receivePressure = 0;
  let playableAreas = 0;
  for (const entry of deck.cards) {
    const card = benchmarkDb.get(entry.id);
    if (!card?.params) continue;
    const count = entry.count;
    if ((card.params.serve ?? -Infinity) >= 4) servePressure += count;
    if ((card.params.block ?? -Infinity) >= 3) blockPressure += count;
    if ((card.params.attack ?? -Infinity) >= 4) attackPressure += count;
    if ((card.params.receive ?? -Infinity) >= 4) receivePressure += count;
    playableAreas += ["serve", "block", "receive", "toss", "attack"].filter((area) => card.params?.[area as keyof typeof card.params] !== null).length * count;
  }

  if (servePressure >= 8) axes.add("serve");
  if (blockPressure >= 10) axes.add("block");
  if (attackPressure >= 10) axes.add("burst");
  if (receivePressure >= 10) axes.add("defense");
  if (axes.size === 0 || playableAreas >= 80) axes.add("hybrid");
  return [...axes];
}

function readDeckJsons(): Deck[] {
  return readdirSync(DECK_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => JSON.parse(readFileSync(join(DECK_DIR, file), "utf8")) as Deck);
}

export const benchmarkDecks: BenchmarkDeck[] = readDeckJsons().map((deck) => expandDeck(deck, AXIS_OVERRIDES[deck.name] ?? inferDeckAxes(deck)));

export function findBenchmarkDeck(name: string): BenchmarkDeck {
  const deck = benchmarkDecks.find((candidate) => candidate.name === name);
  if (!deck) throw new Error(`找不到牌組 "${name}"`);
  return deck;
}
