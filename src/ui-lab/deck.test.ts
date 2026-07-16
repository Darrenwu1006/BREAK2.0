import { describe, expect, it } from "vitest";
import { buildPrintingByUid, type LabDeck } from "./deck";

const makeDeck = (printing: string): LabDeck => ({
  school: "測試",
  name: printing,
  cards: [{ id: "CARD-A", count: 40, printing }],
});

describe("buildPrintingByUid", () => {
  it("同一卡號在雙方牌組可保留各自選擇的卡面版本", () => {
    const cards = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [index + 1, "CARD-A"]));
    const result = buildPrintingByUid(cards, [makeDeck("H"), makeDeck("SP")]);
    expect(result.get(1)).toBe("H");
    expect(result.get(40)).toBe("H");
    expect(result.get(41)).toBe("SP");
    expect(result.get(80)).toBe("SP");
  });
});
