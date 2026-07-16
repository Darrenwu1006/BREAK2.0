// [Claude 2026-07-16] DeckMeta 移至 shared/deckMeta（App/ui/ui-lab/replay 跨模組共用）。
// 本檔只留經典 UI 專用型別。

// [Claude 2026-06-30] 對手引擎兩段切換：強敵（SO-ISMCTS/PIMC 搜尋）vs heuristic（快速、無動畫/擬音）。
// 取代舊「AI 速度」四檔（0.5/1/2 只是強敵思考預算旋鈕，instant 才是另一種引擎，語意混淆）。
export type OpponentEngine = "strong" | "heuristic";

export interface InspectedCard {
  cardId: string;
  uid?: number;
}
