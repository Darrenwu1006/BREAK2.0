// headless 文字 renderer 驗收（spec §1.2）：事件流 → 文字腳本，對照引擎 log 抽查。
import { describe, expect, it } from "vitest";
import { db, deckWith, feed, FILLER, grab, setup } from "../../engine/testkit";
import type { Decision, GameState } from "../../engine/types";
import { derivePresentationEvents } from "./derive";
import { renderEventText, renderScript } from "./textRenderer";

describe("renderEventText", () => {
  it("card-moved 含卡名、區域標籤、移動理由；非公開移動標（蓋）", () => {
    const line = renderEventText(db, {
      kind: "card-moved",
      uid: 1,
      cardId: FILLER,
      from: { player: 0, zone: "hand" },
      to: { player: 0, zone: "serve", depth: 0 },
      visibility: "public",
      reason: "deploy",
    });
    expect(line).toContain("田中");
    expect(line).toContain("P0 手牌 → P0 發球區");
    expect(line).toContain("登場");
    const hiddenLine = renderEventText(db, {
      kind: "card-moved",
      uid: 2,
      cardId: FILLER,
      from: { player: 1, zone: "deck" },
      to: { player: 1, zone: "hand" },
      visibility: "owner",
      reason: "draw",
    });
    expect(hiddenLine).toContain("（蓋）");
  });

  it("判定揭示三拍與 Lost/Set 結果都有人讀文字", () => {
    expect(renderEventText(db, { kind: "op-revealed", player: 0, source: "serve", value: 3 })).toBe("P0 OP 亮出＝3（serve）");
    expect(renderEventText(db, { kind: "judge-revealed", defense: "receive", defender: 1, opValue: 3, dpValue: 2, success: false })).toContain("防守失敗");
    expect(renderEventText(db, { kind: "lost-declared", player: 1 })).toContain("Lost");
    expect(renderEventText(db, { kind: "set-won", winner: 0, loser: 1, setNo: 1, loserSetRemaining: 1 })).toContain("拿下 Set 1");
  });
});

describe("renderScript — 一段 rally 的腳本（與引擎 log 對照的驗收路徑）", () => {
  it("發球→接球判定的腳本含關鍵節點且順序正確", () => {
    let s = setup(deckWith(FILLER), deckWith(FILLER), 0);
    const lines: string[] = [];
    const push = (prev: GameState, d: Decision): GameState => {
      const next = feed(prev, d);
      lines.push(...renderScript(db, derivePresentationEvents(db, prev, d, next)));
      return next;
    };
    s = push(s, { type: "deploy-serve", uid: grab(s, 0, FILLER) });
    s = push(s, { type: "free", action: "pass" });
    s = push(s, { type: "defense-choice", choice: "receive" });
    s = push(s, { type: "free", action: "pass" });
    s = push(s, { type: "deploy-receive", uid: grab(s, 1, FILLER) });
    s = push(s, { type: "free", action: "pass" });

    const script = lines.join("\n");
    const serveIdx = script.indexOf("【登場】");
    const opIdx = script.indexOf("OP 亮出");
    const dpIdx = script.indexOf("DP 亮出");
    const judgeIdx = script.indexOf("判定揭示");
    expect(serveIdx).toBeGreaterThanOrEqual(0);
    expect(opIdx).toBeGreaterThan(serveIdx);
    expect(dpIdx).toBeGreaterThan(opIdx);
    expect(judgeIdx).toBeGreaterThan(dpIdx);
    expect(script).toContain("防守成功");
  });
});
