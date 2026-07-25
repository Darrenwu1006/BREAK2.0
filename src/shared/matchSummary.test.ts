// [Claude 2026-07-24] 候選 C Part 2：matchSummary 描述性統計（火力 min/max/avg/highCount ＋ per-card 技能次數）。
import { describe, expect, it } from "vitest";
import { buildMatchSummary } from "./matchSummary";
import type { ReplayEntry, ReplaySession } from "./replayHistory";
import type { CardDb, GameEvent, GameState } from "../engine/types";
import type { Card } from "../data/types";

const db = new Map<string, Card>([
  ["C1", { id: "C1", nameZh: "影山", nameJa: "影山飛雄" } as unknown as Card],
  ["C2", { id: "C2", nameZh: "日向", nameJa: "日向翔陽" } as unknown as Card],
]) as CardDb;

const cards = { 1: "C1", 2: "C2" };

function entry(player: 0 | 1, source: "player" | "ai", events: GameEvent[]): ReplayEntry {
  const log = events.map((event) => ({ setNo: 1, turnNo: 1, player, text: "", event }));
  const after = { cards, log } as unknown as GameState;
  return { index: 0, player, source, phase: "attack", setNo: 1, turnNo: 1, pendingType: "free", decision: { type: "free", action: "pass" }, before: after, after, logStart: 0, logEnd: log.length } as unknown as ReplayEntry;
}

const session = {
  startedAt: "", seed: 0,
  decks: [{ label: "你", cardIds: [] }, { label: "電腦", cardIds: [] }],
  initialState: { cards, log: [] } as unknown as GameState,
  entries: [
    entry(0, "player", [{ kind: "skill-used", player: 0, uid: 1 }, { kind: "op-calc", player: 0, source: "attack", value: 5 }]),
    entry(0, "player", [{ kind: "skill-used", player: 0, uid: 1 }, { kind: "op-calc", player: 0, source: "serve", value: 8 }]),
    entry(1, "ai", [{ kind: "skill-used", player: 1, uid: 2 }]),
  ],
} as unknown as ReplaySession;

describe("buildMatchSummary", () => {
  const summary = buildMatchSummary(db, session);

  it("火力 op：min/max/average/highCount 正確", () => {
    expect(summary.analytics.op[0]).toMatchObject({ count: 2, min: 5, max: 8, average: 6.5, highCount: 1 });
  });

  it("開技能次數：per-card 計數並依次數排序，uid 經 after.cards 解析卡名", () => {
    expect(summary.skillUsage[0]).toEqual({ total: 2, byCard: [{ name: "影山", count: 2 }] });
    expect(summary.skillUsage[1]).toEqual({ total: 1, byCard: [{ name: "日向", count: 1 }] });
  });

  it("得分來源計數（opSources）", () => {
    expect(summary.analytics.opSources).toMatchObject({ attack: 1, serve: 1 });
  });
});
