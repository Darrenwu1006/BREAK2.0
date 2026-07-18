import { describe, expect, it } from "vitest";
import type { Card } from "../data/types";
import { cardBackUrl, cardFrontUrl } from "./assets";

const card = {
  id: "CARD-A",
  printings: [
    { rarity: "N", image: "cards/default.webp" },
    { rarity: "頂", imageEnd: "H", image: "cards/high.webp" },
    { rarity: "SP", image: "cards/special.webp" },
  ],
} as Card;

describe("cardFrontUrl", () => {
  it("可用 imageEnd 或 rarity 選擇非預設卡面", () => {
    expect(cardFrontUrl(card, "H")).toContain("cards/high.webp");
    expect(cardFrontUrl(card, "SP")).toContain("cards/special.webp");
  });

  it("無效選擇安全退回預設卡面", () => {
    expect(cardFrontUrl(card, "missing")).toContain("cards/default.webp");
  });
});

describe("cardBackUrl", () => {
  it("ユース使用專屬完整卡背", () => {
    expect(decodeURIComponent(cardBackUrl("ユース"))).toContain("backs/ユース.png");
  });
});
