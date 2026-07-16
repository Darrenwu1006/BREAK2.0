import { describe, expect, it } from "vitest";
import { createGame } from "../../engine/engine";
import { db, deckWith, FILLER } from "../../engine/testkit";
import { buildRemainingCardRows } from "./railCounter";

describe("buildRemainingCardRows", () => {
  it("只回報我方牌組剩餘張數，不暴露順序或對手隱藏區", () => {
    const state = createGame(db, { seed: 71, decks: [deckWith(FILLER), deckWith("HV-D01-009")] });
    const rows = buildRemainingCardRows(db, state);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.remaining <= row.total)).toBe(true);
    expect(rows.some((row) => row.id === "HV-D01-009")).toBe(false);
    expect(Object.keys(rows[0]!)).toEqual(["id", "label", "remaining", "total"]);
  });
});
