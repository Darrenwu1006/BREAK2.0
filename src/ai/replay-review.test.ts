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
    expect(report.lostSets.total).toBe(0); // player 0 贏，沒有失 Set
  });

  it("[失 Set 歸因] 依 log 判讀無登場 / 判定失敗 / 主動放棄三種失 Set 原因", () => {
    const cardIds = ["HV-P02-022", "HV-P02-024"];
    const base = state(cardIds, [{}, {}]);
    const lossEntry = (
      index: number,
      setNo: number,
      logs: GameState["log"],
      matchPoint: boolean,
    ) => ({
      index,
      player: 0 as const,
      source: "player" as const,
      phase: "receive" as const,
      setNo,
      turnNo: setNo,
      pendingType: "free" as const,
      decision: { type: "free", action: "lost" } as never,
      before: base,
      after: state(cardIds, [{}, {}], { log: logs }),
      logStart: 0,
      logEnd: logs.length,
    });

    const session: ReplaySession = {
      startedAt: "2026-06-20T00:00:00.000Z",
      seed: 7,
      decks: [
        { label: "稲荷崎-稲荷崎_堆墓改角名", cardIds },
        { label: "音駒-音駒-二口干擾", cardIds: [] },
      ],
      initialState: base,
      entries: [
        lossEntry(0, 1, [
          { setNo: 1, turnNo: 1, player: 1, text: "未登場角色（attack）" },
          { setNo: 1, turnNo: 1, player: 1, text: "宣告 Lost（Set 1）", event: { kind: "set-won", winner: 0, loser: 1, setNo: 1, loserSetRemaining: 2 } },
        ], false),
        lossEntry(1, 2, [
          { setNo: 2, turnNo: 2, player: 0, text: "判定：DP 5 vs OP 7 → 失敗" },
          { setNo: 2, turnNo: 2, player: 1, text: "宣告 Lost（Set 2）", event: { kind: "set-won", winner: 0, loser: 1, setNo: 2, loserSetRemaining: 1 } },
        ], false),
        lossEntry(2, 3, [
          { setNo: 3, turnNo: 3, player: 1, text: "主動宣告 Lost" },
          { setNo: 3, turnNo: 3, player: 0, text: "獲勝！", event: { kind: "match-won", winner: 0, loser: 1, setNo: 3 } },
        ], true),
      ],
    };

    const report = createReplayReviewReport(db, session, { player: 1 });
    expect(report.lostSets.total).toBe(3);
    expect(report.lostSets.byCause["no-deploy"]).toBe(1);
    expect(report.lostSets.byCause["judge-fail"]).toBe(1);
    expect(report.lostSets.byCause.voluntary).toBe(1);

    const judge = report.lostSets.attributions.find((item) => item.cause === "judge-fail");
    expect(judge?.opAtLoss).toBe(7);
    expect(judge?.dpAtLoss).toBe(5);

    const matchLoss = report.lostSets.attributions.find((item) => item.matchPoint);
    expect(matchLoss?.cause).toBe("voluntary");
    expect(matchLoss?.setNo).toBe(3);
  });

  it("[事件/技能效率] 沿用 benchmark 定義統計有效使用", () => {
    const cardIds = ["HV-P02-022", "HV-P02-024"];
    const before = state(cardIds, [{}, {}]);
    const after = state(cardIds, [{}, {}], {
      log: [
        { setNo: 1, turnNo: 1, player: 0, text: "打出事件卡 テスト事件" },
        { setNo: 1, turnNo: 1, player: 0, text: "抽 2 張" },
        { setNo: 1, turnNo: 1, player: 0, text: "── 區隔 ──" },
        { setNo: 1, turnNo: 1, player: 0, text: "使用 テスト 的技能" },
        // 技能宣告後沒有任何可觀察效果 → 計入 uses 但非 effective
      ],
    });
    const session: ReplaySession = {
      startedAt: "2026-06-20T00:00:00.000Z",
      seed: 1,
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
          pendingType: "free" as const,
          decision: { type: "free", action: "pass" } as never,
          before,
          after,
          logStart: 0,
          logEnd: 4,
        },
      ],
    };

    const report = createReplayReviewReport(db, session, { player: 0 });
    expect(report.actionEffectiveness.event.uses).toBe(1);
    expect(report.actionEffectiveness.event.effectiveUses).toBe(1);
    expect(report.actionEffectiveness.event.draws).toBe(2);
    expect(report.actionEffectiveness.event.rate).toBe(1);
    expect(report.actionEffectiveness.skill.uses).toBe(1);
    expect(report.actionEffectiveness.skill.effectiveUses).toBe(0);
    expect(report.actionEffectiveness.skill.rate).toBe(0);

    // 逐張命中：與 aggregate 一致（交叉驗證，避免 benchmark 規則改動造成漂移）
    const eventCards = report.actionCardDetails.filter((d) => d.kind === "event");
    const skillCards = report.actionCardDetails.filter((d) => d.kind === "skill");
    const sum = (list: typeof report.actionCardDetails, key: "uses" | "effectiveUses") => list.reduce((s, d) => s + d[key], 0);
    expect(sum(eventCards, "uses")).toBe(report.actionEffectiveness.event.uses);
    expect(sum(eventCards, "effectiveUses")).toBe(report.actionEffectiveness.event.effectiveUses);
    expect(sum(skillCards, "uses")).toBe(report.actionEffectiveness.skill.uses);
    expect(sum(skillCards, "effectiveUses")).toBe(report.actionEffectiveness.skill.effectiveUses);
    expect(report.actionCardDetails.find((d) => d.cardName === "テスト事件")?.effectiveUses).toBe(1);
    expect(report.actionCardDetails.find((d) => d.cardName === "テスト")?.effectiveUses).toBe(0);
  });

  it("[檢討文案] 失球根因歸到資源 / 構築層，並綜合結果與效率", () => {
    const cardIds = ["HV-P02-022", "HV-P02-024"];
    const before = state(cardIds, [{}, {}]);
    const after = state(cardIds, [{}, {}], {
      log: [
        { setNo: 1, turnNo: 1, player: 0, text: "判定：DP 4 vs OP 8 → 失敗" },
        { setNo: 1, turnNo: 1, player: 0, text: "宣告 Lost（Set 1）", event: { kind: "set-won", winner: 1, loser: 0, setNo: 1, loserSetRemaining: 2 } },
      ],
    });
    const session: ReplaySession = {
      startedAt: "2026-06-20T00:00:00.000Z",
      seed: 1,
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
          phase: "receive",
          setNo: 1,
          turnNo: 1,
          pendingType: "free" as const,
          decision: { type: "free", action: "pass" } as never,
          before,
          after,
          logStart: 0,
          logEnd: 2,
        },
      ],
    };

    const report = createReplayReviewReport(db, session, { player: 0 });
    expect(report.narrative.length).toBeGreaterThan(0);
    // 第一條為結果摘要
    expect(report.narrative[0]).toContain("Set");
    // 失球根因應指向防守點數 / RCV / Guts（構築與資源層），且帶平均 OP/DP
    const rootCause = report.narrative.find((line) => line.includes("判定失敗"));
    expect(rootCause).toBeTruthy();
    expect(rootCause).toMatch(/RCV|DP|Guts/);
    expect(rootCause).toContain("OP 8.0");
  });
});
