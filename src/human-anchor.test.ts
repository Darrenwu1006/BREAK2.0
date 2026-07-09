import { describe, expect, it } from "vitest";
import {
  applyAnchorScanToJsonl,
  buildHumanAnchorDraft,
  parseHumanAnchorJsonl,
  summarizeAnchorTrend,
  validateHumanAnchorDraft,
  type HumanAnchorMatchRecord,
} from "./human-anchor";

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

  it("accepts and validates L1 anchor-scan fields", () => {
    const record = {
      date: "2026-07-05T21:40:00+08:00",
      aiEngine: "strong",
      decks: { player: "A", ai: "B" },
      result: "player",
      setScore: [3, 1],
      serious: true,
      playerDecisions: 80,
      replayRef: "x.json",
      note: "",
      agreementRate: 0.72,
      blunderCount: 3,
      samplesUsed: 5,
      blunderVerificationSamples: 25,
      blunderCandidates: 9,
      blunderThreshold: 0.15,
      anchorEvaluated: 76,
      anchorScannedAt: "2026-07-05T22:00:00+08:00",
    };
    expect(validateHumanAnchorDraft(record)).toEqual(record);
    expect(() => validateHumanAnchorDraft({ ...record, blunderThreshold: -1 })).toThrow("invalid blunderThreshold");
    expect(() => validateHumanAnchorDraft({ ...record, samplesUsed: 1.5 })).toThrow("invalid samplesUsed");
    expect(() => validateHumanAnchorDraft({ ...record, blunderVerificationSamples: -1 })).toThrow("invalid blunderVerificationSamples");
    expect(() => validateHumanAnchorDraft({ ...record, blunderCandidates: 1.5 })).toThrow("invalid blunderCandidates");
    expect(() => validateHumanAnchorDraft({ ...record, anchorEvaluated: 1.5 })).toThrow("invalid anchorEvaluated");
    expect(() => validateHumanAnchorDraft({ ...record, anchorScannedAt: "not-a-date" })).toThrow("invalid anchorScannedAt");
  });
});

function record(overrides: Partial<HumanAnchorMatchRecord>): HumanAnchorMatchRecord {
  return {
    date: "2026-07-05T12:00:00Z",
    engineVersion: "aaaaaaa",
    aiEngine: "strong",
    decks: { player: "P", ai: "A" },
    result: "ai",
    setScore: [1, 3],
    serious: true,
    playerDecisions: 90,
    replayRef: "replay-x.json",
    note: "",
    ...overrides,
  };
}

describe("human-anchor L1 jsonl parsing", () => {
  it("parses valid lines and tolerates blank/broken lines", () => {
    const text = [
      JSON.stringify(record({})),
      "",
      "not json",
      JSON.stringify({ date: "bad" }),
      JSON.stringify(record({ result: "player", engineVersion: undefined })),
    ].join("\n");
    const { records, skipped } = parseHumanAnchorJsonl(text);
    expect(records).toHaveLength(2);
    expect(skipped).toBe(2);
    expect(records[1]!.engineVersion).toBe("unknown");
  });
});

describe("human-anchor L1 trend summary", () => {
  it("groups serious win rate by engineVersion and excludes experiment games", () => {
    const records = [
      record({ engineVersion: "v1", result: "player" }),
      record({ engineVersion: "v1", result: "ai" }),
      record({ engineVersion: "v2", result: "player" }),
      record({ engineVersion: "v2", result: "player", serious: false }),
    ];
    const summary = summarizeAnchorTrend(records);
    expect(summary.seriousGames).toBe(3);
    expect(summary.experimentGames).toBe(1);
    const v1 = summary.byVersion.find((group) => group.engineVersion === "v1")!;
    const v2 = summary.byVersion.find((group) => group.engineVersion === "v2")!;
    expect(v1).toMatchObject({ games: 2, wins: 1, winRate: 0.5 });
    expect(v2).toMatchObject({ games: 1, wins: 1, winRate: 1 });
  });

  it("computes a date-sorted moving window over the last N serious games", () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      record({
        date: `2026-07-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
        // 前 2 場玩家勝（會滑出窗外）、後 10 場 AI 勝 → 窗內勝率 0
        result: i < 2 ? "player" : "ai",
      }),
    );
    // 打亂順序，驗證依 date 排序
    const summary = summarizeAnchorTrend([...records].reverse());
    expect(summary.recentWindow).toEqual({ window: 10, games: 10, wins: 0, winRate: 0 });
  });

  it("tolerates missing agreement values: only scanned games enter the agreement denominator", () => {
    const records = [
      record({ engineVersion: "v1", agreementRate: 0.8, anchorEvaluated: 100, blunderCount: 2 }),
      record({ engineVersion: "v1", agreementRate: 0.5, anchorEvaluated: 50, blunderCount: 1 }),
      record({ engineVersion: "v1" }), // 未掃描
    ];
    const summary = summarizeAnchorTrend(records);
    const v1 = summary.byVersion.find((group) => group.engineVersion === "v1")!;
    expect(v1.scanned).toBe(2);
    expect(v1.blunderTotal).toBe(3);
    // 加權平均：(0.8*100 + 0.5*50) / 150 = 0.7
    expect(v1.agreementRate).toBeCloseTo(0.7, 10);
  });

  it("returns null window when there are no serious games", () => {
    const summary = summarizeAnchorTrend([record({ serious: false })]);
    expect(summary.recentWindow).toBeNull();
    expect(summary.byVersion).toHaveLength(0);
  });
});

describe("human-anchor L1 jsonl write-back", () => {
  const scan = {
    agreementRate: 0.75,
    blunderCount: 2,
    samplesUsed: 5,
    blunderVerificationSamples: 25,
    blunderCandidates: 7,
    blunderThreshold: 0.15,
    anchorEvaluated: 80,
    anchorScannedAt: "2026-07-05T22:00:00Z",
  };

  it("updates only the matching replayRef line, matching by basename", () => {
    const lines = [
      JSON.stringify(record({ replayRef: "replay-a.json" })),
      JSON.stringify(record({ replayRef: "replay-b.json" })),
    ];
    const updated = applyAnchorScanToJsonl(`${lines.join("\n")}\n`, "data/replays/replay-b.json", scan);
    expect(updated).not.toBeNull();
    const parsed = parseHumanAnchorJsonl(updated!);
    expect(parsed.records[0]!.agreementRate).toBeUndefined();
    expect(parsed.records[1]).toMatchObject(scan);
    expect(parsed.records[1]!.replayRef).toBe("replay-b.json");
  });

  it("overwrites a previous scan instead of duplicating fields", () => {
    const line = JSON.stringify(record({ replayRef: "replay-a.json", agreementRate: 0.1, blunderCount: 9 }));
    const updated = applyAnchorScanToJsonl(line, "replay-a.json", scan);
    expect(parseHumanAnchorJsonl(updated!).records[0]).toMatchObject(scan);
  });

  it("returns null when no record matches", () => {
    const line = JSON.stringify(record({ replayRef: "replay-a.json" }));
    expect(applyAnchorScanToJsonl(line, "replay-zzz.json", scan)).toBeNull();
  });
});
