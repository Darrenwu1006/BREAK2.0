export type HumanAnchorAiEngine = "strong" | "heuristic";
export type HumanAnchorResult = "player" | "ai";

export interface HumanAnchorMatchRecord {
  date: string;
  engineVersion: string;
  aiEngine: HumanAnchorAiEngine;
  decks: {
    player: string;
    ai: string;
  };
  result: HumanAnchorResult;
  setScore: [number, number];
  serious: boolean;
  playerDecisions: number;
  replayRef: string;
  note: string;
  agreementRate?: number;
  blunderCount?: number;
  /** [Claude 2026-07-05] L1：--anchor 掃描回寫。門檻可調故記錄實際採用值（spec §2）。 */
  blunderThreshold?: number;
  /** 掃描時可比對的決策步數（agreementRate 的分母）。 */
  anchorEvaluated?: number;
  anchorScannedAt?: string;
}

export type HumanAnchorMatchDraft = Omit<HumanAnchorMatchRecord, "engineVersion"> & {
  engineVersion?: string;
};

export function buildHumanAnchorDraft(input: {
  date: string;
  aiEngine: HumanAnchorAiEngine;
  playerDeck: string;
  aiDeck: string;
  winner: 0 | 1;
  setScore: [number, number];
  serious: boolean;
  playerDecisions: number;
  replayRef: string;
  note?: string;
}): HumanAnchorMatchDraft {
  return {
    date: input.date,
    aiEngine: input.aiEngine,
    decks: {
      player: input.playerDeck,
      ai: input.aiDeck,
    },
    result: input.winner === 0 ? "player" : "ai",
    setScore: input.setScore,
    serious: input.serious,
    playerDecisions: input.playerDecisions,
    replayRef: input.replayRef,
    note: input.note ?? "",
  };
}

export function validateHumanAnchorDraft(input: unknown): HumanAnchorMatchDraft {
  if (!input || typeof input !== "object") throw new Error("record must be an object");
  const record = input as Partial<HumanAnchorMatchDraft>;
  if (typeof record.date !== "string" || Number.isNaN(Date.parse(record.date))) throw new Error("invalid date");
  if (record.aiEngine !== "strong" && record.aiEngine !== "heuristic") throw new Error("invalid aiEngine");
  if (!record.decks || typeof record.decks.player !== "string" || typeof record.decks.ai !== "string") throw new Error("invalid decks");
  if (record.result !== "player" && record.result !== "ai") throw new Error("invalid result");
  if (!Array.isArray(record.setScore) || record.setScore.length !== 2 || !record.setScore.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error("invalid setScore");
  }
  if (typeof record.serious !== "boolean") throw new Error("invalid serious");
  if (typeof record.playerDecisions !== "number" || !Number.isInteger(record.playerDecisions) || record.playerDecisions < 0) {
    throw new Error("invalid playerDecisions");
  }
  if (typeof record.replayRef !== "string") throw new Error("invalid replayRef");
  if (typeof record.note !== "string") throw new Error("invalid note");
  if (record.engineVersion !== undefined && typeof record.engineVersion !== "string") throw new Error("invalid engineVersion");
  if (record.agreementRate !== undefined && typeof record.agreementRate !== "number") throw new Error("invalid agreementRate");
  if (record.blunderCount !== undefined && (!Number.isInteger(record.blunderCount) || record.blunderCount < 0)) throw new Error("invalid blunderCount");
  if (record.blunderThreshold !== undefined && (typeof record.blunderThreshold !== "number" || record.blunderThreshold < 0)) throw new Error("invalid blunderThreshold");
  if (record.anchorEvaluated !== undefined && (!Number.isInteger(record.anchorEvaluated) || record.anchorEvaluated < 0)) throw new Error("invalid anchorEvaluated");
  if (record.anchorScannedAt !== undefined && (typeof record.anchorScannedAt !== "string" || Number.isNaN(Date.parse(record.anchorScannedAt)))) throw new Error("invalid anchorScannedAt");
  return record as HumanAnchorMatchDraft;
}

// ---------------------------------------------------------------------------
// [Claude 2026-07-05] Phase L L1：趨勢彙整與 --anchor 回寫的純函式核心（CLI 只做 IO）。
// ---------------------------------------------------------------------------

export interface HumanAnchorParseResult {
  records: HumanAnchorMatchRecord[];
  /** 無法 parse 的行數（趨勢對壞行容忍，但要誠實回報）。 */
  skipped: number;
}

export function parseHumanAnchorJsonl(text: string): HumanAnchorParseResult {
  const records: HumanAnchorMatchRecord[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const draft = validateHumanAnchorDraft(JSON.parse(line));
      records.push({ engineVersion: draft.engineVersion ?? "unknown", ...draft } as HumanAnchorMatchRecord);
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

export interface AnchorVersionSummary {
  engineVersion: string;
  games: number;
  wins: number;
  winRate: number;
  /** 一致率已回寫的場數（缺值容忍：分母只算掃描過的場）。 */
  scanned: number;
  /** 掃描過場次的一致率平均（依 anchorEvaluated 加權；缺權重時視為 1）。 */
  agreementRate: number | null;
  blunderTotal: number;
}

export interface AnchorTrendSummary {
  seriousGames: number;
  experimentGames: number;
  byVersion: AnchorVersionSummary[];
  /** 近 N 場（認真局、依 date 排序）移動窗勝率；不足 N 場時 window=實際場數。 */
  recentWindow: { window: number; games: number; wins: number; winRate: number } | null;
}

export const ANCHOR_SMALL_SAMPLE_N = 10;

export function summarizeAnchorTrend(records: HumanAnchorMatchRecord[], windowSize = 10): AnchorTrendSummary {
  const serious = records
    .filter((record) => record.serious)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const byVersionMap = new Map<string, AnchorVersionSummary>();
  const agreementWeights = new Map<string, number>();
  for (const record of serious) {
    const key = record.engineVersion || "unknown";
    let group = byVersionMap.get(key);
    if (!group) {
      group = { engineVersion: key, games: 0, wins: 0, winRate: 0, scanned: 0, agreementRate: null, blunderTotal: 0 };
      byVersionMap.set(key, group);
    }
    group.games++;
    if (record.result === "player") group.wins++;
    if (record.agreementRate !== undefined) {
      const weight = record.anchorEvaluated && record.anchorEvaluated > 0 ? record.anchorEvaluated : 1;
      const prevWeight = agreementWeights.get(key) ?? 0;
      const prevRate = group.agreementRate ?? 0;
      agreementWeights.set(key, prevWeight + weight);
      group.agreementRate = (prevRate * prevWeight + record.agreementRate * weight) / (prevWeight + weight);
      group.scanned++;
      group.blunderTotal += record.blunderCount ?? 0;
    }
  }
  const byVersion = [...byVersionMap.values()].map((group) => ({
    ...group,
    winRate: group.games > 0 ? group.wins / group.games : 0,
  }));
  const recent = serious.slice(-windowSize);
  const recentWins = recent.filter((record) => record.result === "player").length;
  return {
    seriousGames: serious.length,
    experimentGames: records.length - serious.length,
    byVersion,
    recentWindow: recent.length > 0
      ? { window: windowSize, games: recent.length, wins: recentWins, winRate: recentWins / recent.length }
      : null,
  };
}

export interface AnchorScanSummary {
  agreementRate: number;
  blunderCount: number;
  blunderThreshold: number;
  anchorEvaluated: number;
  anchorScannedAt: string;
}

/** 依 replayRef（比對 basename，容忍傳入完整路徑）把掃描摘要回寫進 jsonl 文字；找不到回 null。 */
export function applyAnchorScanToJsonl(text: string, replayRef: string, summary: AnchorScanSummary): string | null {
  const target = replayRef.split("/").pop() ?? replayRef;
  const lines = text.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (found || !line.trim()) return line;
    try {
      const record = JSON.parse(line) as HumanAnchorMatchRecord;
      const ref = (record.replayRef ?? "").split("/").pop();
      if (ref !== target) return line;
      found = true;
      return JSON.stringify({ ...record, ...summary });
    } catch {
      return line;
    }
  });
  return found ? updated.join("\n") : null;
}
