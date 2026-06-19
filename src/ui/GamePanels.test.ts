import { describe, expect, it } from "vitest";
import { extractLeadingSkillMarkers } from "./GamePanels";

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
