// M9a CP4 控制器測試：代打推進、人類互動停點、批次 meta 對齊、整場 smoke。

import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import karasunoDeck from "../../../data/decks/烏野-預組.json";
import nekomaDeck from "../../../data/decks/音駒-預組.json";
import { heuristicAiDecision } from "../../ai/heuristic";
import type { Card } from "../../data/types";
import type { CardDb } from "../../engine/types";
import { HUMAN, LAB_UNDO_LIMIT, LabGameController } from "./controller";

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
    expect(c.replay.seed).toBe(7);
    expect(c.replay.entries.length).toBeGreaterThan(0);
    expect(c.replay.entries.at(-1)?.after.phase).toBe("gameOver");
    expect(c.replay.entries.some((entry) => entry.source === "player")).toBe(true);
    expect(c.replay.entries.some((entry) => entry.source === "ai")).toBe(true);
  });

  it("replay 使用正式共用 schema，保留牌組標籤與每步可重播 state", () => {
    const c = new LabGameController(db, decks, 314, [
      { school: "烏野", name: "預組", total: 40, implementedCount: 40, unimplementedCount: 0 },
      { school: "音駒", name: "預組", total: 40, implementedCount: 40, unimplementedCount: 0 },
    ]);
    const beforeCount = c.replay.entries.length;
    c.decide(heuristicAiDecision(db, c.engine));
    expect(c.replay.decks.map((deck) => deck.label)).toEqual(["烏野-預組", "音駒-預組"]);
    expect(c.replay.entries.length).toBeGreaterThan(beforeCount);
    for (const [index, entry] of c.replay.entries.entries()) {
      expect(entry.index).toBe(index);
      expect(entry.before.pendingDecision?.type).toBe(entry.pendingType);
      expect(entry.after).toBeDefined();
    }
  });

  it("undo 回到人類決策前、截斷 replay future、恢復 RNG 並標記 rewound", () => {
    const c = new LabGameController(db, decks, 2718);
    c.timeline.skip();
    const before = structuredClone(c.engine);
    const replayLength = c.replay.entries.length;
    const decision = heuristicAiDecision(db, c.engine);
    c.decide(decision);
    expect(c.canUndo).toBe(true);
    expect(c.replay.entries.length).toBeGreaterThan(replayLength);
    expect(c.undo()).toBe(true);
    expect(c.engine).toEqual(before);
    expect(c.engine.rngState).toBe(before.rngState);
    expect(c.replay.entries).toHaveLength(replayLength);
    expect(c.replay).toMatchObject({ rewound: true, rewindCount: 1 });
    expect(c.timeline.idle).toBe(true);

    // 同狀態＋同行動必須重現相同 AI／RNG future。
    c.decide(decision);
    const firstFuture = structuredClone(c.engine);
    expect(c.undo()).toBe(true);
    c.decide(decision);
    expect(c.engine).toEqual(firstFuture);
  });

  it("只保留最近 20 個實際人類決策；委託 AI 的手不建立 undo 點", () => {
    const c = new LabGameController(db, decks, 1618);
    c.timeline.skip();
    c.decide(heuristicAiDecision(db, c.engine), true);
    expect(c.undoDepth).toBe(0);
    for (let i = 0; i < LAB_UNDO_LIMIT + 5 && c.engine.pendingDecision; i++) {
      c.timeline.skip();
      c.decide(heuristicAiDecision(db, c.engine));
    }
    expect(c.undoDepth).toBe(LAB_UNDO_LIMIT);
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

  it("正式 shell defer 模式停在每個對手決策，必須由 worker 入口明確推進", () => {
    const c = new LabGameController(db, decks, 73, undefined, { deferOpponent: true });
    for (let step = 0; step < 20 && !c.awaitingOpponent; step++) {
      expect(c.awaitingHuman).toBe(true);
      c.decide(heuristicAiDecision(db, c.engine));
      c.timeline.skip();
    }
    expect(c.awaitingOpponent).toBe(true);
    const replayLength = c.replay.entries.length;
    c.decideOpponent(heuristicAiDecision(db, c.engine));
    expect(c.replay.entries.length).toBe(replayLength + 1);
    expect(c.replay.entries.at(-1)?.source).toBe("ai");
  });
});
