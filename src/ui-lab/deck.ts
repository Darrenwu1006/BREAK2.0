export interface LabDeck {
  school: string;
  name: string;
  cards: { id: string; count: number; printing?: string }[];
  favorite?: boolean;
  source?: string;
}

export const expandDeck = (deck: LabDeck): string[] =>
  deck.cards.flatMap((card) => Array(card.count).fill(card.id) as string[]);
