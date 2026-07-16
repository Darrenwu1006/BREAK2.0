import { describe, expect, it } from "vitest";
import { db, FILLER } from "../engine/testkit";
import { buildBattleDeckWarnings } from "./battleDeckValidation";

const deck = (name: string, count: number) => ({
  school: "測試校",
  name,
  cards: [{ id: FILLER, count }],
});

describe("buildBattleDeckWarnings", () => {
  it("任一方不滿 40 張時阻擋開始，並指出牌組與目前張數", () => {
    expect(buildBattleDeckWarnings(db, deck("玩家 39", 39), deck("電腦 38", 38))).toEqual([
      "我的牌組「測試校／玩家 39」：牌組須正好 40 張（目前 39 張）",
      "電腦牌組「測試校／電腦 38」：牌組須正好 40 張（目前 38 張）",
    ]);
  });

  it("雙方合法時允許進入 renderer", () => {
    expect(buildBattleDeckWarnings(db, deck("玩家", 40), deck("電腦", 40))).toEqual([]);
  });
});
