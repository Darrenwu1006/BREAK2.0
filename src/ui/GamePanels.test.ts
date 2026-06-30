import { describe, expect, it } from "vitest";
import { extractLeadingSkillMarkers, getGlossaryItems } from "./GamePanels";
import type { Card } from "../data/types";

describe("CardSkillInfo marker layout", () => {
  it("moves leading skill icons out of the body text", () => {
    const result = extractLeadingSkillMarkers("[=登場][=アタックエリア] 支付3點Guts則可使用。進行[=ブロックアウト(2)]。");

    expect(result.markers).toEqual(["登場", "アタックエリア"]);
    expect(result.body).toBe("支付3點Guts則可使用。進行[=ブロックアウト(2)]。");
  });

  it("keeps non-leading keyword icons inside the body text", () => {
    const result = extractLeadingSkillMarkers("對手的OP在4以上時可以使用。進行[=ワンタッチ(2)]。");

    expect(result.markers).toEqual([]);
    expect(result.body).toBe("對手的OP在4以上時可以使用。進行[=ワンタッチ(2)]。");
  });
});

describe("getGlossaryItems keyword detection", () => {
  const dummyCard = (skillZh: string | null, skillJa: string | null, timing: string[] = []): Card => ({
    id: "TEST-001",
    type: "CHARACTER",
    nameJa: "テスト",
    affiliations: [],
    positions: [],
    grades: [],
    params: null,
    timing,
    skillJa,
    skillZh,
    skillZhStatus: "human",
    printings: [],
    notes: null,
    effect: null,
    effectStatus: "vanilla"
  });

  it("detects 攔死 (ドシャット)", () => {
    const card = dummyCard("進行[=ドシャット(5)]。", "進行[=ドシャット(5)]。");
    const items = getGlossaryItems(card);
    expect(items.map(i => i.name)).toContain("攔死");
  });

  it("detects 一次觸球 (ワンタッチ)", () => {
    const card = dummyCard("進行[=ワンタッチ(2)]。", null);
    const items = getGlossaryItems(card);
    expect(items.map(i => i.name)).toContain("一次觸球");
  });

  it("detects multiple keywords", () => {
    const card = dummyCard("進行[=二次進攻(3)]與[=後排攻擊(4)]。", null);
    const items = getGlossaryItems(card);
    expect(items.map(i => i.name)).toContain("二次進攻");
    expect(items.map(i => i.name)).toContain("後排攻擊");
  });

  it("detects 一回合一次 (ターン1)", () => {
    const card = dummyCard("抽1張卡。[=ターン1]", "ドロー。[=ターン1]");
    const items = getGlossaryItems(card);
    expect(items.map(i => i.name)).toContain("一回合一次");
  });

  it("detects 一回合一次 from timing", () => {
    const card = dummyCard("抽1張卡。", "ドロー。", ["回合1"]);
    const items = getGlossaryItems(card);
    expect(items.map(i => i.name)).toContain("一回合一次");
  });
});
