import { describe, expect, it } from "vitest";
import { buildHumanAnchorDraft, validateHumanAnchorDraft } from "./human-anchor";

describe("human-anchor L0 schema", () => {
  it("builds a serious match draft from replay summary fields", () => {
    const draft = buildHumanAnchorDraft({
      date: "2026-07-05T21:40:00+08:00",
      aiEngine: "strong",
      playerDeck: "青葉城西-第三彈測試",
      aiDeck: "白鳥澤-三彈",
      winner: 1,
      setScore: [1, 3],
      serious: true,
      playerDecisions: 87,
      replayRef: "replay-2026-07-05.json",
    });

    expect(draft).toMatchObject({
      result: "ai",
      serious: true,
      playerDecisions: 87,
      replayRef: "replay-2026-07-05.json",
    });
    expect(validateHumanAnchorDraft(draft)).toEqual(draft);
  });

  it("rejects malformed records before appending jsonl", () => {
    expect(() => validateHumanAnchorDraft({ aiEngine: "strong" })).toThrow("invalid date");
    expect(() => validateHumanAnchorDraft({
      date: "2026-07-05T21:40:00+08:00",
      aiEngine: "strong",
      decks: { player: "A", ai: "B" },
      result: "draw",
      setScore: [3, 2],
      serious: true,
      playerDecisions: 10,
      replayRef: "x.json",
      note: "",
    })).toThrow("invalid result");
  });
});
