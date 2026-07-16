import { describe, expect, it } from "vitest";
import { nextRevealSnapshot } from "./usePlayback";

describe("nextRevealSnapshot", () => {
  it("fast-forward 依序保留最後一拍 OP／DP／judge", () => {
    let reveal = nextRevealSnapshot({}, { kind: "op-revealed", player: 0, source: "attack", value: 6 });
    reveal = nextRevealSnapshot(reveal, { kind: "dp-revealed", player: 1, source: "block", value: 5 });
    reveal = nextRevealSnapshot(reveal, { kind: "judge-revealed", defense: "block", defender: 1, opValue: 6, dpValue: 5, success: false });
    expect(reveal).toEqual({
      op: { player: 0, source: "attack", value: 6 },
      dp: { player: 1, source: "block", value: 5 },
      judge: { defense: "block", defender: 1, opValue: 6, dpValue: 5, success: false },
    });
  });

  it("新 OP 開新一拍，得失分事件清空快照", () => {
    const previous = { op: { player: 0 as const, source: "serve" as const, value: 2 }, dp: { player: 1 as const, source: "receive" as const, value: 3 } };
    expect(nextRevealSnapshot(previous, { kind: "op-revealed", player: 1, source: "attack", value: 7 })).toEqual({ op: { player: 1, source: "attack", value: 7 } });
    expect(nextRevealSnapshot(previous, { kind: "lost-declared", player: 1 })).toEqual({});
  });
});
