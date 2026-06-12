export interface DeckMeta {
  school: string;
  name: string;
  total: number;
  implementedCount: number;
  unimplementedCount: number;
}

export type AiSpeed = "0.5" | "1" | "2" | "instant";

export interface InspectedCard {
  cardId: string;
  uid?: number;
}
