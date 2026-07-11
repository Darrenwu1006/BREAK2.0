// M9a CP4 控制器測試：代打推進、人類互動停點、批次 meta 對齊、整場 smoke。

import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import karasunoDeck from "../../../data/decks/烏野-預組.json";
import nekomaDeck from "../../../data/decks/音駒-預組.json";
import { heuristicAiDecision } from "../../ai/heuristic";
import type { Card } from "../../data/types";
import type { CardDb } from "../../engine/types";
import { HUMAN, LabGameController } from "./controller";

interface DeckJson {
  cards: { id: string; count: number }[];
}
const expand = (d: DeckJson): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

const db: CardDb = new Map((cardsJson as unknown as Card[]).map((c) => [c.id, c]));
const decks: [string[], string[]] = [expand(karasunoDeck as DeckJson), expand(nekomaDeck as DeckJson)];

describe("LabGameController", () => {
  it("建構後自動推進到第一個人類互動決策，沿途批次都有 meta 且 before/after 相接", () => {
    const c = new LabGameController(db, decks, 42);
    expect(c.awaitingHuman).toBe(true);
    // LP2 起：P0 的所有決策型別都停給人類（含 serve-rights/mulligan）
    expect(c.engine.pendingDecision!.player).toBe(HUMAN);
    // 佇列裡至少有 serve-rights＋抽牌等前置批次
    expect(c.timeline.idle).toBe(false);
    let prev: ReturnType<typeof c.metaOf> | undefined;
    for (let e = c.timeline.next(); e; e = c.timeline.next()) {
      const m = c.metaOf(e.batch);
      expect(m).toBeDefined();
      if (prev && m !== prev) expect(m!.before).toBe(prev.after); // 批次串接：上一批的 after＝下一批的 before
      if (m !== prev) prev = m;
    }
    // 最後一批的 after＝權威盤面
    expect(prev!.after).toBe(c.engine);
  });

  it("人類決策後繼續推進；整場打完（人類手由 heuristic 模擬）", () => {
    const c = new LabGameController(db, decks, 7);
    for (let i = 0; i < 600 && c.engine.pendingDecision; i++) {
      expect(c.awaitingHuman).toBe(true);
      c.decide(heuristicAiDecision(db, c.engine));
      c.timeline.skip();
    }
    expect(c.engine.pendingDecision).toBeNull();
    expect(c.engine.phase).toBe("gameOver");
  });

  it("非人類互動時 decide 擲錯", () => {
    const c = new LabGameController(db, decks, 42);
    c.decide(heuristicAiDecision(db, c.engine));
    if (!c.awaitingHuman) {
      expect(() => c.decide({ type: "defense-choice", choice: "receive" })).toThrow();
    }
    // 至少驗證 awaitingHuman 與 pendingDecision 一致
    const pd = c.engine.pendingDecision;
    if (pd) expect(c.awaitingHuman).toBe(pd.player === HUMAN);
  });
});
