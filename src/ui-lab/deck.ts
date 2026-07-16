export interface LabDeck {
  school: string;
  name: string;
  cards: { id: string; count: number; printing?: string }[];
  favorite?: boolean;
  source?: string;
}

export const expandDeck = (deck: LabDeck): string[] =>
  deck.cards.flatMap((card) => Array(card.count).fill(card.id) as string[]);

export const printingSelections = (deck: LabDeck): ReadonlyMap<string, string> =>
  new Map(deck.cards.flatMap((card) => card.printing ? [[card.id, card.printing] as const] : []));

/** createGame 依 P0→P1 順序配置 uid；在 renderer 端把兩副牌各自的卡面選擇固定到實體 uid。 */
export function buildPrintingByUid(
  cards: Readonly<Record<number, string>>,
  decks: readonly [LabDeck, LabDeck],
): ReadonlyMap<number, string> {
  const firstDeckSize = expandDeck(decks[0]).length;
  const selections = [printingSelections(decks[0]), printingSelections(decks[1])] as const;
  const out = new Map<number, string>();
  for (const [rawUid, cardId] of Object.entries(cards)) {
    const uid = Number(rawUid);
    const selected = selections[uid <= firstDeckSize ? 0 : 1].get(cardId);
    if (selected) out.set(uid, selected);
  }
  return out;
}
