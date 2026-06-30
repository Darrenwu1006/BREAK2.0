export interface DeckMeta {
  school: string;
  name: string;
  total: number;
  implementedCount: number;
  unimplementedCount: number;
}

// [Claude 2026-06-30] 對手引擎兩段切換：強敵（SO-ISMCTS/PIMC 搜尋）vs heuristic（快速、無動畫/擬音）。
// 取代舊「AI 速度」四檔（0.5/1/2 只是強敵思考預算旋鈕，instant 才是另一種引擎，語意混淆）。
export type OpponentEngine = "strong" | "heuristic";

export interface InspectedCard {
  cardId: string;
  uid?: number;
}
