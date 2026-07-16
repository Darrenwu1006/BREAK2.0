import { validateGameDeck } from "../engine/deck-validation";
import type { CardDb } from "../engine/types";

export interface BattleDeckInput {
  school: string;
  name: string;
  cards: { id: string; count: number }[];
}

const expandDeck = (deck: BattleDeckInput): string[] =>
  deck.cards.flatMap((card) => Array(card.count).fill(card.id) as string[]);

export function buildBattleDeckWarnings(
  db: CardDb,
  playerDeck: BattleDeckInput,
  opponentDeck: BattleDeckInput,
): string[] {
  const labels = ["我的牌組", "電腦牌組"] as const;
  return [playerDeck, opponentDeck].flatMap((deck, index) =>
    validateGameDeck(db, expandDeck(deck)).map((issue) =>
      `${labels[index]}「${deck.school}／${deck.name}」：${issue.message}`,
    ),
  );
}
