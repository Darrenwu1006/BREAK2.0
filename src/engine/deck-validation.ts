import type { CardDb } from "./types";

export type GameDeckValidationIssue =
  | { code: "size"; message: string }
  | { code: "event-limit"; message: string }
  | { code: "unknown-card"; message: string };

/** 對局與入口共用的輕量構築 preflight；不可依賴規則引擎 runtime。 */
export function validateGameDeck(db: CardDb, deck: readonly string[]): GameDeckValidationIssue[] {
  const issues: GameDeckValidationIssue[] = [];
  if (deck.length !== 40) issues.push({ code: "size", message: `牌組須正好 40 張（目前 ${deck.length} 張）` });
  const events = deck.filter((id) => db.get(id)?.type === "EVENT").length;
  if (events > 8) issues.push({ code: "event-limit", message: `事件卡超過 8 張（目前 ${events} 張）` });
  const unknown = [...new Set(deck.filter((id) => !db.has(id)))];
  if (unknown.length > 0) issues.push({ code: "unknown-card", message: `含未知卡片：${unknown.join("、")}` });
  return issues;
}
