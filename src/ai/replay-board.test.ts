import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import type { CardDb, Decision, GameState, PlayerState } from "../engine/types";
import type { ReplayEntry, ReplaySession } from "../ui/replayHistory";
import { decisionLabel, renderBoardRange, renderEntryBoard } from "./replay-board";

const db: CardDb = new Map((cardsJson as Card[]).map((card) => [card.id, card]));

// 岩泉一（block=3、有技能）——報告 11 的核心卡，拿來驗參數＋✦渲染。
const IWAIZUMI = "HV-P01-035";

function player(patch: Partial<PlayerState> = {}): PlayerState {
  return {
    deck: [], hand: [], setArea: [], drop: [], eventArea: [],
    serve: [], blockCenter: [], blockSides: [], receive: [], toss: [], attack: [],
    ...patch,
  };
}

function state(cardIds: string[], players: [Partial<PlayerState>, Partial<PlayerState>], patch: Partial<GameState> = {}): GameState {
  const cards: Record<number, string> = {};
  cardIds.forEach((id, index) => {
    cards[index + 1] = id;
  });
  return {
    rngState: 1, cards, players: [player(players[0]), player(players[1])],
    setNo: 1, turnNo: 4, turnPlayer: 0, servingPlayer: 1, phase: "attack", sub: 0,
    op: null, dp: null, judgeSuccess: null, defenseChoice: null, lostBy: null,
    pendingDecision: null, winner: null, setupStage: "done",
    modifiers: [], nameOverrides: {}, watchers: [], restrictions: [], pendingQueue: [],
    turn1: [], effectCtx: null, lostRequest: null,
    blockDeployedThisTurn: [0, 0], blockHandDeploysThisTurn: [0, 0], nextId: 1, log: [],
    ...patch,
  } as GameState;
}

function entry(patch: Partial<ReplayEntry> & { decision: Decision; before: GameState; after: GameState }): ReplayEntry {
  return {
    index: 0, player: 0, source: "player", phase: "attack", setNo: 1, turnNo: 4,
    pendingType: patch.decision.type, logStart: 0, logEnd: patch.after.log.length,
    ...patch,
  };
}

function session(entries: ReplayEntry[]): ReplaySession {
  return {
    startedAt: "2026-06-21T00:00:00.000Z",
    seed: 1,
    decks: [{ label: "A", cardIds: [] }, { label: "B", cardIds: [] }],
    initialState: state([], [{}, {}]),
    entries,
  };
}

describe("replay-board renderEntryBoard", () => {
  const iwa = db.get(IWAIZUMI)!;
  const iwaName = iwa.nameZh || iwa.nameJa;
  const before = state(
    [IWAIZUMI],
    [{ attack: [1], hand: [] }, { hand: [] }],
    { op: { value: 2, owner: 0, source: "attack" } },
  );
  const decision: Decision = { type: "free", action: "skill", uid: 1, skillIndex: 0 };
  const sess = session([entry({ decision, before, after: before })]);
  const out = renderEntryBoard(db, sess, 1);

  it("renders the step header, set/turn/phase and actor", () => {
    expect(out).toContain("第 1 步");
    expect(out).toContain("Set 1 Turn 4");
    expect(out).toContain("attack phase");
    expect(out).toContain("玩家(P0)");
  });

  it("renders the character with engine-truth params and a skill marker", () => {
    expect(out).toContain(iwaName);
    // 參數三元組直接由 db 算出（不硬寫數值），確保渲染對齊卡池真值。
    const p = iwa.params!;
    const f = (v: number | null) => (v === null ? "－" : String(v));
    expect(out).toContain(`[${f(p.serve)}/${f(p.block)}/${f(p.receive)}/${f(p.toss)}/${f(p.attack)}]`);
    expect(out).toContain("✦");
  });

  it("reads OP straight from state (no recompute) and labels the decision", () => {
    expect(out).toContain("OP：2（owner P0, source attack）");
    expect(out).toContain(`使用技能：${iwaName}`);
  });

  it("returns a clear message for an out-of-range step", () => {
    expect(renderEntryBoard(db, sess, 99)).toContain("找不到第 99 步");
  });
});

describe("replay-board renderBoardRange & decisionLabel", () => {
  const before = state([IWAIZUMI], [{ attack: [1] }, {}], { op: { value: 2, owner: 0, source: "attack" } });
  const e0 = entry({ index: 0, decision: { type: "free", action: "skill", uid: 1, skillIndex: 0 }, before, after: before });
  const e1 = entry({ index: 1, decision: { type: "deploy-attack", uid: null }, before, after: before });
  const sess = session([e0, e1]);

  it("renders multiple steps in a range", () => {
    const out = renderBoardRange(db, sess, 1, 2);
    expect(out).toContain("第 1 步");
    expect(out).toContain("第 2 步");
  });

  it("labels a null deploy as a Lost declaration", () => {
    expect(decisionLabel(before, db, { type: "deploy-attack", uid: null })).toContain("不登場 → 宣告 Lost");
  });

  it("labels a mulligan with returned card names", () => {
    const label = decisionLabel(before, db, { type: "mulligan", returnUids: [1] });
    expect(label).toContain("換牌 1 張");
    expect(label).toContain(db.get(IWAIZUMI)!.nameZh || db.get(IWAIZUMI)!.nameJa);
  });
});
