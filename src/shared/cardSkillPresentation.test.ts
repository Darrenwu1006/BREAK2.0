import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import { buildCardSkillPresentation, extractLeadingSkillMarkers, getGlossaryItems, tokenizeSkillText } from "./cardSkillPresentation";

const card = (overrides: Partial<Card>): Card => ({
  id: "TEST-001", type: "CHARACTER", nameJa: "テスト", nameZh: "測試", affiliations: [], positions: [], grades: [], params: null,
  timing: [], skillJa: null, skillZh: null, skillZhStatus: "human", printings: [], notes: null, effect: null, effectStatus: "vanilla", ...overrides,
});

describe("card skill presentation", () => {
  it("把開頭時機與區域拆成中文 badge，正文只保留效果", () => {
    const result = buildCardSkillPresentation(card({ skillZh: "[=登場][=アタックエリア] 進行[=ブロックアウト(2)]。" }));
    expect(result.timingBadges).toEqual([{ label: "登場", kind: "phase" }, { label: "攻擊區", kind: "area" }]);
    expect(result.body).toEqual([{ kind: "text", text: "進行" }, { kind: "keyword", text: "打手出界(2)" }, { kind: "text", text: "。" }]);
  });

  it("將一回合一次抽離為限制而非時機 badge", () => {
    const result = buildCardSkillPresentation(card({ skillZh: "[=ドロー][=ターン1] 抽1張卡。" }));
    expect(result.timingBadges.map((item) => item.label)).toEqual(["抽牌"]);
    expect(result.oncePerTurn).toBe(true);
  });

  it("將官方日文註釋轉成中文說明", () => {
    const result = buildCardSkillPresentation(card({
      skillZh: "[=登場] 支付1點Guts。",
      annotationJa: "ガッツを払う…このキャラの下のカードを指定された枚数ドロップエリアに置く。",
    }));
    expect(result.annotationZh).toEqual(["支付 Guts：將這名角色下方指定數量的卡片放入棄牌區。"]);
  });

  it("保留 parser 與 glossary 的舊版 contract", () => {
    expect(extractLeadingSkillMarkers("[=登場] 進行[=ワンタッチ(2)]。").markers).toEqual(["登場"]);
    expect(tokenizeSkillText("進行[=ワンタッチ(2)]。")[1]?.text).toBe("一次觸球(2)");
    expect(getGlossaryItems(card({ skillZh: "進行[=ワンタッチ(2)]。" })).map((item) => item.name)).toContain("一次觸球");
  });

  it("覆蓋卡池全部官方註釋，且時機與特殊效果不再露出日文標記", () => {
    const cards = cardsJson as unknown as Card[];
    const withAnnotations = cards.filter((item) => item.annotationJa);
    expect(withAnnotations).toHaveLength(64);
    for (const item of withAnnotations) {
      const result = buildCardSkillPresentation(item);
      expect(result.annotationZh.length, item.id).toBeGreaterThan(0);
      expect(result.annotationZh.join(" "), item.id).not.toMatch(/[ぁ-んァ-ヶ]/);
    }
    for (const item of cards) {
      const result = buildCardSkillPresentation(item);
      expect(result.timingBadges.map((badge) => badge.label).join(" "), item.id).not.toMatch(/[ぁ-んァ-ヶ]/);
      expect(result.body.filter((segment) => segment.kind === "keyword").map((segment) => segment.text).join(" "), item.id).not.toMatch(/[ぁ-んァ-ヶ]|\[=/);
    }
  });
});
