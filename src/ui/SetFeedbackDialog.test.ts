import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REPLAY_SET_FEEDBACK_OPTIONS } from "../shared/replaySetFeedbackOptions";
import { SetFeedbackDialog } from "./SetFeedbackDialog";

describe("SetFeedbackDialog", () => {
  it("renders the shared eight choices and Set outcome in the 2D dialog", () => {
    const html = renderToStaticMarkup(createElement(SetFeedbackDialog, {
      result: { setNo: 2, anchorEntryIndex: 17, winner: 1, loser: 0, kind: "set" },
      onSubmit: () => undefined,
      onSkip: () => undefined,
    }));

    expect(REPLAY_SET_FEEDBACK_OPTIONS).toHaveLength(8);
    for (const option of REPLAY_SET_FEEDBACK_OPTIONS) expect(html).toContain(option.label);
    expect(html).toContain("Set 2・你失去了");
    expect(html).toContain("這個 Set，你原本在執行什麼計畫？");
    expect(html).toContain("保存並繼續");
    expect(html).toContain("略過");
  });
});
