import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import type { CardDb, Decision, GameState, PlayerState } from "../engine/types";
import { AI_THOUGHT_SCHEMA_VERSION, type AiThoughtRecord } from "../shared/aiThought";
import type { ReplayEntry, ReplaySession } from "../shared/replayHistory";
import { renderBoardRange, renderEntryBoard } from "./replay-board";
import { describeDecision } from "../shared/decisionLabels";

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
    expect(describeDecision(db, before, { type: "deploy-attack", uid: null }, "verbose")).toContain("不登場 → 宣告 Lost");
  });

  it("labels a mulligan with returned card names", () => {
    const label = describeDecision(db, before, { type: "mulligan", returnUids: [1] }, "verbose");
    expect(label).toContain("換牌 1 張");
    expect(label).toContain(db.get(IWAIZUMI)!.nameZh || db.get(IWAIZUMI)!.nameJa);
  });

  it("omits AI 思維 block verbatim when entry.aiThought is absent", () => {
    const withLog = state([IWAIZUMI], [{ attack: [1] }, {}], {
      op: { value: 2, owner: 0, source: "attack" },
      log: [{ player: 0, setNo: 1, turnNo: 4, text: "發動技能" }],
    });
    const plainEntry = entry({
      index: 0,
      decision: { type: "free", action: "skill", uid: 1, skillIndex: 0 },
      before,
      after: withLog,
    });
    const out = renderEntryBoard(db, session([plainEntry]), 1);
    expect(out).not.toContain("AI 思維：");
    const lines = out.split("\n");
    const decisionIdx = lines.findIndex((line) => line.startsWith("決策："));
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    expect(lines[decisionIdx + 1]).toBe("log[0..1]：");
  });

  it("renders structured AI 思維 block between decision and logs when aiThought is present", () => {
    const iwa = db.get(IWAIZUMI)!;
    const iwaZh = iwa.nameZh || iwa.nameJa;
    const withLog = state([IWAIZUMI], [{ attack: [1] }, {}], {
      op: { value: 2, owner: 0, source: "attack" },
      log: [{ player: 1, setNo: 1, turnNo: 4, text: "自由步驟 Pass" }],
    });
    const aiThought: AiThoughtRecord = {
      schemaVersion: AI_THOUGHT_SCHEMA_VERSION,
      engine: "strong",
      isKeyDecision: true,
      pendingType: "free",
      chosenLabel: "自由步驟 Pass",
      chosenWinRate: 0.58,
      completedSamples: 200,
      tieBreakReason: "pressure-tiebreak",
      topCandidates: [
        { label: "自由步驟 Pass", decisionType: "free", winRate: 0.58, sampleCount: 120, isChosen: true },
        { label: "使用事件 繋げ", decisionType: "free", winRate: 0.54, sampleCount: 80, isChosen: false },
      ],
      valueFactors: [
        { feature: "oppGutsThreat", label: "對面 Guts 威脅", contribution: 0.24, direction: "helps" },
        { feature: "dpExcess", label: "溢點接球", contribution: -0.08, direction: "hurts" },
      ],
      belief: {
        knownOppHandCardIds: [IWAIZUMI],
        reducedTags: ["matchpoint-high-receive"],
        oppGuts: 6,
        oppRemainingHighReceive: 2.5,
        oppRemainingDefEvent: 1.75,
      },
      dialogue: {
        safe: "先保留手牌資源。",
        spoiler: "已經接得住，先扣著事件不交（Pass 58% ＞ 開事件 54%）。",
      },
    };
    const thoughtEntry = entry({
      index: 0,
      player: 1,
      source: "ai",
      decision: { type: "free", action: "pass" },
      before,
      after: withLog,
      aiThought,
    });
    const out = renderEntryBoard(db, session([thoughtEntry]), 1);

    const decisionPos = out.indexOf("決策：");
    const thoughtPos = out.indexOf("AI 思維：");
    const logPos = out.indexOf("log[0..1]：");
    expect(decisionPos).toBeGreaterThanOrEqual(0);
    expect(thoughtPos).toBeGreaterThan(decisionPos);
    expect(logPos).toBeGreaterThan(thoughtPos);

    expect(out).toContain("engine=strong");
    expect(out).toContain("關鍵步");
    expect(out).toContain("samples=200");
    expect(out).toContain("chosenWinRate=58.0%");
    expect(out).toContain("tieBreakReason=pressure-tiebreak");
    expect(out).toContain("spoiler：已經接得住，先扣著事件不交（Pass 58% ＞ 開事件 54%）。");
    expect(out).toContain("★ 自由步驟 Pass (free)｜勝率 58.0%｜樣本 120");
    expect(out).toContain("使用事件 繋げ (free)｜勝率 54.0%｜樣本 80");
    expect(out).toContain("對面 Guts 威脅 (oppGutsThreat, helps)：+0.24");
    expect(out).toContain("溢點接球 (dpExcess, hurts)：-0.08");
    expect(out).toContain(`已知對手手牌：${iwaZh}(${IWAIZUMI})`);
    expect(out).toContain("oppGuts=6");
    expect(out).toContain("oppRemainingHighReceive=2.5");
    expect(out).toContain("oppRemainingDefEvent=1.75");
    expect(out).toContain("reducedTags=matchpoint-high-receive");
  });

  it("renders minimal heuristic transition aiThought cleanly without optional sections", () => {
    const minimalThought: AiThoughtRecord = {
      schemaVersion: AI_THOUGHT_SCHEMA_VERSION,
      engine: "heuristic",
      isKeyDecision: false,
      pendingType: "serve-rights",
      chosenLabel: "先攻發球",
      completedSamples: 0,
      topCandidates: [],
      valueFactors: [],
      dialogue: { safe: "", spoiler: "" },
    };
    const minimalEntry = entry({
      index: 0,
      player: 1,
      source: "ai",
      decision: { type: "serve-rights", take: true },
      before,
      after: before,
      aiThought: minimalThought,
    });
    const out = renderEntryBoard(db, session([minimalEntry]), 1);
    expect(out).toContain("AI 思維：engine=heuristic｜過場步｜samples=0");
    expect(out).not.toContain("chosenWinRate=");
    expect(out).not.toContain("tieBreakReason=");
    expect(out).not.toContain("belief：");
  });
});
