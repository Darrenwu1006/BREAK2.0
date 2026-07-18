import { describe, expect, it } from "vitest";
import { buildCardBackChoices, groupDeckRows, type ApiDeck } from "./DeckEditor";

function deck(school: string): ApiDeck {
  return { school, name: "測試", source: `${school}/測試.csv`, cards: [] };
}

describe("buildCardBackChoices", () => {
  it("提供所有專屬卡背與通用卡背", () => {
    const choices = buildCardBackChoices([]);

    expect(choices.custom.map((choice) => choice.value)).toEqual([
      "ユース",
      "伊達工業",
      "梟谷",
      "烏野",
      "白鳥沢",
      "稲荷崎",
      "青葉城西",
      "音駒",
    ]);
    expect(choices.fallback).toEqual([
      { value: "混合學校", label: "通用卡背（混合學校）" },
    ]);
  });

  it("保留既有牌組的其他分類，且不重複專屬卡背", () => {
    const choices = buildCardBackChoices([deck("ユース"), deck("烏野"), deck("ユース")]);

    expect(choices.custom).toContainEqual({ value: "ユース", label: "ユース" });
    expect(choices.fallback.some((choice) => choice.value === "ユース")).toBe(false);
    expect(choices.fallback.some((choice) => choice.value === "烏野")).toBe(false);
  });
});

describe("groupDeckRows", () => {
  it("角色卡在上、事件卡在下，兩區都只按卡號排序", () => {
    const rows = [
      { id: "HV-P02-020", card: { type: "EVENT" as const }, count: 8 },
      { id: "HV-P03-090", card: { type: "CHARACTER" as const }, count: 1 },
      { id: "HV-P01-003", card: { type: "CHARACTER" as const }, count: 6 },
      { id: "HV-P01-099", card: { type: "EVENT" as const }, count: 1 },
    ];

    const grouped = groupDeckRows(rows);

    expect(grouped.characters.map((row) => row.id)).toEqual(["HV-P01-003", "HV-P03-090"]);
    expect(grouped.events.map((row) => row.id)).toEqual(["HV-P01-099", "HV-P02-020"]);
  });
});
