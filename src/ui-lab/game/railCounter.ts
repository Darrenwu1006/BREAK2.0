import type { CardDb, GameState } from "../../engine/types";

export interface RemainingCardRow {
  id: string;
  label: string;
  remaining: number;
  total: number;
}

export function buildRemainingCardRows(db: CardDb, state: GameState): RemainingCardRow[] {
  const ps = state.players[0];
  const all = [...ps.deck, ...ps.hand, ...ps.setArea, ...ps.drop, ...ps.eventArea, ...ps.serve, ...ps.blockCenter, ...ps.blockSides, ...ps.receive, ...ps.toss, ...ps.attack];
  const total = new Map<string, number>();
  const remaining = new Map<string, number>();
  for (const uid of all) {
    const id = state.cards[uid]!;
    total.set(id, (total.get(id) ?? 0) + 1);
  }
  for (const uid of ps.deck) {
    const id = state.cards[uid]!;
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  return [...total.entries()].map(([id, count]) => {
    const card = db.get(id);
    return { id, label: card?.nameZh || card?.nameJa || id, remaining: remaining.get(id) ?? 0, total: count };
  }).sort((a, b) => b.remaining - a.remaining || b.total - a.total || a.id.localeCompare(b.id));
}
