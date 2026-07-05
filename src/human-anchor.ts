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
  return record as HumanAnchorMatchDraft;
}
