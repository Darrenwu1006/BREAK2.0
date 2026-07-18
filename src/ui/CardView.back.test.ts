import { describe, expect, it } from "vitest";
import { cardBackImage } from "./CardView";

describe("cardBackImage", () => {
  it("ユース使用專屬縮圖卡背", () => {
    expect(decodeURIComponent(cardBackImage("ユース"))).toContain("backs/thumb/ユース.png");
  });

  it("未知陣營仍安全退回通用卡背", () => {
    expect(cardBackImage("未知陣營")).toContain("backs/thumb/default.png");
  });
});
