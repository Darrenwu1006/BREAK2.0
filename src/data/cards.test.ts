// 卡池資料完整性測試
import { describe, it, expect } from "vitest";
import cardsJson from "../../data/cards.json";
import type { Card } from "./types";

const cards = cardsJson as Card[];

describe("data/cards.json", () => {
  it("卡片編號唯一", () => {
    const ids = cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每張卡至少有一個卡面版本", () => {
    for (const c of cards) expect(c.printings.length).toBeGreaterThan(0);
  });

  it("CHARACTER 必有參數物件，EVENT 必無", () => {
    for (const c of cards) {
      if (c.type === "CHARACTER") expect(c.params).not.toBeNull();
      else expect(c.params).toBeNull();
    }
  });

  it("角色卡至少有一個非 null 參數（ボール拾い 位置卡除外）", () => {
    for (const c of cards) {
      if (c.type !== "CHARACTER" || !c.params) continue;
      if (c.positions.includes("ボール拾い")) continue;
      expect(Object.values(c.params).some((v) => v !== null)).toBe(true);
    }
  });

  it("有技能文字（日文或繁中）的卡 effectStatus 不是 vanilla，反之亦然", () => {
    for (const c of cards) {
      if (c.skillJa || c.skillZh) expect(c.effectStatus, c.id).not.toBe("vanilla");
      else expect(c.effectStatus, c.id).toBe("vanilla");
    }
  });

  it("skillZhStatus 與譯文欄位一致", () => {
    for (const c of cards) {
      if (c.skillZh) expect(["human", "machine"], c.id).toContain(c.skillZhStatus);
      else if (c.skillJa) expect(c.skillZhStatus, c.id).toBe("missing");
      else expect(c.skillZhStatus, c.id).toBe("none");
    }
  });

  it("每個卡面版本都有圖檔路徑與稀有度", () => {
    for (const c of cards)
      for (const p of c.printings) {
        expect(p.rarity, c.id).toBeTruthy();
        expect(p.image, c.id).toMatch(/^cards\/.+\.webp$/);
      }
  });
});
