import { describe, expect, it } from "vitest";
import { createGame } from "../../engine/engine";
import { db, deckWith, FILLER } from "../../engine/testkit";
import { buildRemainingCardRows } from "./railCounter";
import { RAIL_TOOL_TABS } from "./RailTools";

describe("buildRemainingCardRows", () => {
  it("將對戰紀錄作為 rail 獨立 tab", () => {
    expect(RAIL_TOOL_TABS.map((item) => item.tool)).toEqual(["log", "coach", "counter", "settings"]);
  });

  it("只回報我方牌組剩餘張數，不暴露順序或對手隱藏區", () => {
    const state = createGame(db, { seed: 71, decks: [deckWith(FILLER), deckWith("HV-D01-009")] });
    const rows = buildRemainingCardRows(db, state);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.remaining <= row.total)).toBe(true);
    expect(rows.some((row) => row.id === "HV-D01-009")).toBe(false);
    expect(Object.keys(rows[0]!)).toEqual(["id", "label", "remaining", "total"]);
  });
});
