import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import type { CardDb, GameState, PlayerState } from "../engine/types";
import type { ReplaySession } from "../ui/replayHistory";
import { createReplayReviewReport } from "./replay-review";

const db: CardDb = new Map((cardsJson as Card[]).map((card) => [card.id, card]));

function player(patch: Partial<PlayerState> = {}): PlayerState {
  return {
    deck: [],
    hand: [],
    setArea: [],
    drop: [],
    eventArea: [],
    serve: [],
    blockCenter: [],
    blockSides: [],
    receive: [],
    toss: [],
    attack: [],
    ...patch,
  };
}

function state(cardIds: string[], players: [Partial<PlayerState>, Partial<PlayerState>], patch: Partial<GameState> = {}): GameState {
  const cards: Record<number, string> = {};
  cardIds.forEach((id, index) => {
    cards[index + 1] = id;
  });
  return {
    rngState: 1,
    cards,
    players: [player(players[0]), player(players[1])],
    setNo: 1,
    turnNo: 1,
    turnPlayer: 0,
    servingPlayer: 0,
    phase: "toss",
    sub: 0,
    op: null,
    dp: null,
    judgeSuccess: null,
    defenseChoice: null,
    lostBy: null,
    pendingDecision: { player: 0, type: "effect-cards", candidates: [6], min: 1, max: 1 },
    winner: null,
    setupStage: "done",
    modifiers: [],
    nameOverrides: {},
    watchers: [],
    restrictions: [],
    pendingQueue: [],
    turn1: [],
    effectCtx: null,
    lostRequest: null,
    blockDeployedThisTurn: [0, 0],
    blockHandDeploysThisTurn: [0, 0],
    nextId: 1,
    log: [],
    ...patch,
  } as GameState;
}

describe("replay review", () => {
  it("summarizes replay stats and records gameplan checkpoints", () => {
    const cardIds = ["HV-P02-022", "HV-P02-024", "HV-P02-032", "HV-P02-034", "HV-P02-017", "HV-P02-027"];
    const before = state(cardIds, [{ drop: [1, 2, 3, 4, 5], serve: [6, 1, 2, 3] }, { hand: [7, 8, 9, 10] }]);
    const after = state(
      cardIds,
      [{ drop: [1, 2, 3, 4, 5, 6], serve: [6] }, { hand: [7, 8, 9, 10] }],
      {
        log: [
          { setNo: 1, turnNo: 1, player: 0, text: "支付 3 Guts", event: { kind: "pay-guts", player: 0, count: 3, sources: { serve: 3 } } },
          { setNo: 1, turnNo: 1, player: 0, text: "OP 算出 = 8", event: { kind: "attack-op", player: 0, value: 8 } },
          { setNo: 1, turnNo: 1, player: 0, text: "獲勝！", event: { kind: "match-won", winner: 0, loser: 1, setNo: 1 } },
        ],
        winner: 0,
        phase: "gameOver",
      },
    );
    const session: ReplaySession = {
      startedAt: "2026-06-19T00:00:00.000Z",
      seed: 123,
      decks: [
        { label: "稲荷崎-稲荷崎_堆墓改角名", cardIds },
        { label: "音駒-音駒-二口干擾", cardIds: [] },
      ],
      initialState: before,
      entries: [
        {
          index: 0,
          player: 0,
          source: "player",
          phase: "toss",
          setNo: 1,
          turnNo: 1,
          pendingType: "effect-cards",
          decision: { type: "effect-cards", uids: [6] },
          before,
          after,
          logStart: 0,
          logEnd: 3,
        },
      ],
    };

    const report = createReplayReviewReport(db, session);

    expect(report.analytics.matchWinner).toBe(0);
    expect(report.analytics.payGuts[0]).toBe(3);
    expect(report.analytics.op[0].max).toBe(8);
    expect(report.setReviews[0]?.winner).toBe(0);
    expect(report.gameplan?.final.progressScore).toBeGreaterThan(0);
    expect(report.gameplan?.checkpoints).toHaveLength(1);
    expect(report.gameplan?.checkpoints[0]?.badges.join(" ")).toContain("棄牌區 6 種稻荷崎角色達成");
  });
});
