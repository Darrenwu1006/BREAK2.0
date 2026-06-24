import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import type { CardDb, Decision, GameState, LogEntry, PlayerState } from "../engine/types";
import type { ReplayEntry, ReplaySession } from "../ui/replayHistory";
import { buildTriage } from "./replay-triage";

const db: CardDb = new Map((cardsJson as Card[]).map((card) => [card.id, card]));
const IWAIZUMI = "HV-P01-035";

function player(patch: Partial<PlayerState> = {}): PlayerState {
  return {
    deck: [], hand: [], setArea: [], drop: [], eventArea: [],
    serve: [], blockCenter: [], blockSides: [], receive: [], toss: [], attack: [],
    ...patch,
  };
}

function state(patch: Partial<GameState> = {}): GameState {
  return {
    rngState: 1, cards: { 1: IWAIZUMI }, players: [player(), player()],
    setNo: 1, turnNo: 1, turnPlayer: 0, servingPlayer: 1, phase: "receive", sub: 0,
    op: null, dp: null, judgeSuccess: null, defenseChoice: null, lostBy: null,
    pendingDecision: null, winner: null, setupStage: "done",
    modifiers: [], nameOverrides: {}, watchers: [], restrictions: [], pendingQueue: [],
    turn1: [], effectCtx: null, lostRequest: null,
    blockDeployedThisTurn: [0, 0], blockHandDeploysThisTurn: [0, 0], nextId: 1, log: [],
    ...patch,
  } as GameState;
}

function entry(index: number, decision: Decision, log: LogEntry[], patch: Partial<ReplayEntry> = {}): ReplayEntry {
  const after = state({ log });
  return {
    index, player: 0, source: "player", phase: "receive", setNo: 1, turnNo: 1,
    pendingType: decision.type, decision, before: state(), after, logStart: 0, logEnd: log.length,
    ...patch,
  };
}

function session(entries: ReplayEntry[]): ReplaySession {
  return {
    startedAt: "2026-06-21T00:00:00.000Z", seed: 42,
    decks: [{ label: "青葉城西-二彈改", cardIds: [] }, { label: "音駒-二口干擾", cardIds: [] }],
    initialState: state(), entries,
  };
}

describe("buildTriage", () => {
  // 第 1 步：失 Set（判定失敗）→ 疑似失誤（lost-set 硬訊號）。
  const lostEntry = entry(
    0,
    { type: "deploy-receive", uid: 1 },
    [
      { setNo: 1, turnNo: 6, player: 0, text: "判定：DP 2 vs OP 5 → 失敗" },
      {
        setNo: 1, turnNo: 6, player: 0, text: "Set 1 被對手拿下",
        event: { kind: "set-won", winner: 1, loser: 0, setNo: 1, loserSetRemaining: 2 },
      },
    ],
    { setNo: 1, turnNo: 6 },
  );
  // 第 2 步：付 Guts 硬接 OP 7 成功 → 打得好（clutch-defense）。
  const clutchEntry = entry(
    1,
    { type: "deploy-receive", uid: 1 },
    [
      { setNo: 4, turnNo: 3, player: 0, text: "支付 3 Guts", event: { kind: "pay-guts", player: 0, count: 3, sources: { receive: 3 } } },
      { setNo: 4, turnNo: 3, player: 0, text: "判定：DP 8 vs OP 7 → 成功" },
    ],
    { setNo: 4, turnNo: 3 },
  );
  const result = buildTriage(db, session([lostEntry, clutchEntry]), { player: 0 });

  it("surfaces both a mistake and a good play, mistakes ranked first", () => {
    const categories = result.candidates.map((c) => c.category);
    expect(categories).toContain("mistake");
    expect(categories).toContain("good-play");
    expect(result.candidates[0]!.category).toBe("mistake");
  });

  it("flags the lost-set step as a hard-signal mistake", () => {
    const mistake = result.candidates.find((c) => c.category === "mistake")!;
    expect(mistake.step).toBe(1);
    expect(mistake.signals.some((s) => s.source === "lost-set")).toBe(true);
    expect(mistake.strength).toBe(3);
    expect(mistake.headline).toContain("失 Set 1");
  });

  it("flags the Guts-paid high-OP hold as a clutch good play", () => {
    const good = result.candidates.find((c) => c.category === "good-play")!;
    expect(good.step).toBe(2);
    const clutch = good.signals.find((s) => s.source === "clutch-defense")!;
    expect(clutch.strength).toBe(3);
    expect(clutch.detail).toContain("硬接 OP 7");
    expect(clutch.detail).toContain("付 Guts");
  });

  it("does not fold in PIMC signals unless provided", () => {
    expect(result.candidates.every((c) => c.signals.every((s) => s.source !== "pimc"))).toBe(true);
    const withPimc = buildTriage(db, session([lostEntry, clutchEntry]), {
      player: 0,
      pimc: [{ entryIndex: 1, kind: "mistake", delta: 0.2, bestChoice: "攔網" }],
    });
    const pimcCandidate = withPimc.candidates.find((c) => c.signals.some((s) => s.source === "pimc"))!;
    expect(pimcCandidate.signals.find((s) => s.source === "pimc")!.detail).toContain("−20%");
  });
});
