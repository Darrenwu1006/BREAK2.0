import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import type { CardDb, GameState, PlayerId, PlayerState, Watcher } from "../engine/types";
import { evaluateGameplanState, evaluateGameplanTransition, resolveGameplanProfile, validateGameplanProfiles } from "./gameplan";

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
    phase: "free",
    sub: 0,
    op: null,
    dp: null,
    judgeSuccess: null,
    defenseChoice: null,
    lostBy: null,
    pendingDecision: { player: 0, type: "free" },
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

function profile(id: "inarizaki" | "aoba") {
  const label = id === "inarizaki" ? "稲荷崎-稲荷崎_堆墓改角名" : "青葉城西-青葉城西_二彈改";
  const resolved = resolveGameplanProfile(label, []);
  expect(resolved).not.toBeNull();
  return resolved!;
}

describe("gameplan profiles", () => {
  it("validates the JSON profile schema", () => {
    expect(validateGameplanProfiles()).toEqual([]);
  });

  it("marks Inarizaki unique drop names from 5 to 6 as a positive unlock", () => {
    const p = profile("inarizaki");
    const before = state(
      ["HV-P02-022", "HV-P02-024", "HV-P02-032", "HV-P02-034", "HV-P02-017", "HV-P02-027"],
      [{ drop: [1, 2, 3, 4, 5], serve: [6, 1, 2, 3] }, {}],
    );
    const after = state(
      ["HV-P02-022", "HV-P02-024", "HV-P02-032", "HV-P02-034", "HV-P02-017", "HV-P02-027"],
      [{ drop: [1, 2, 3, 4, 5, 6], serve: [1] }, {}],
    );

    const report = evaluateGameplanTransition(db, before, after, 0, p);

    expect(report.tone).toBe("progress");
    expect(report.badges.join(" ")).toContain("棄牌區 6 種稻荷崎角色達成");
    expect(report.risks.join(" ")).toContain("Guts");
  });

  it("does not treat duplicate Inarizaki drop names as main-plan progress", () => {
    const p = profile("inarizaki");
    const before = state(["HV-P02-017", "HV-P02-022"], [{ drop: [1], serve: [2, 1, 2, 1] }, {}]);
    const after = state(["HV-P02-017", "HV-P02-022"], [{ drop: [1, 1], serve: [2, 1, 2, 1] }, {}]);

    const report = evaluateGameplanTransition(db, before, after, 0, p);

    expect(report.tone).toBe("neutral");
    expect(report.badges.some((badge) => badge.includes("棄牌區 6 種"))).toBe(false);
  });

  it("treats Inarizaki key-card recovery from drop as a loop action, not pure drift", () => {
    const p = profile("inarizaki");
    const cardIds = ["HV-P02-017", "HV-P02-022", "HV-P02-024", "HV-P02-032", "HV-P02-034", "HV-P02-027"];
    const before = state(cardIds, [{ drop: [1, 2, 3, 4, 5, 6], serve: [2, 3, 4, 5] }, {}]);
    const after = state(cardIds, [{ drop: [2, 3, 4, 5, 6], hand: [1], serve: [2, 3, 4, 5] }, {}]);

    const report = evaluateGameplanTransition(db, before, after, 0, p);

    expect(report.tone).toBe("progress");
    expect(report.badges.join(" ")).toContain("回收循環");
    expect(report.delta).toBeLessThan(0);
  });

  it("also treats non-key Inarizaki character recovery as part of the dump loop", () => {
    const p = profile("inarizaki");
    const cardIds = ["HV-P02-022", "HV-P02-024", "HV-P02-032", "HV-P02-034", "HV-P02-017", "HV-P02-027"];
    const before = state(cardIds, [{ drop: [1, 2, 3, 4], serve: [5, 2, 3, 4] }, {}]);
    const after = state(cardIds, [{ drop: [2, 3, 4], hand: [1], serve: [5, 2, 3, 4] }, {}]);

    const report = evaluateGameplanTransition(db, before, after, 0, p);

    expect(report.tone).toBe("progress");
    expect(report.badges.join(" ")).toContain("回收循環");
  });

  it("tracks Aoba Johsai hand pressure thresholds and Omotta watcher setup", () => {
    const p = profile("aoba");
    const before = state(["HV-P01-033", "HV-P01-087"], [{ toss: [1] }, { hand: [3, 4, 5, 6, 7] }]);
    const afterFour = state(["HV-P01-033", "HV-P01-087"], [{ toss: [1] }, { hand: [3, 4, 5, 6] }]);
    const watcher: Watcher = {
      id: 1,
      player: 0,
      source: 2,
      trigger: { on: "handAddByEffect", player: "opponent" },
      actions: [],
      setNo: 1,
      turnMin: 1,
      turnMax: 2,
      desc: "俺も思った☆",
    };
    const afterThreeAndWatcher = state(
      ["HV-P01-033", "HV-P01-087"],
      [{ toss: [1] }, { hand: [3, 4, 5] }],
      { watchers: [watcher] },
    );

    expect(evaluateGameplanTransition(db, before, afterFour, 0, p).badges.join(" ")).toContain("對手手牌壓到 4 以下達成");
    const report = evaluateGameplanTransition(db, afterFour, afterThreeAndWatcher, 0, p);
    expect(report.badges.join(" ")).toContain("對手手牌壓到 3 以下達成");
    expect(report.badges.join(" ")).toContain("俺も思った☆ 非抽牌補牌懲罰達成");
  });

  it("flags Omotta in hand without Oikawa on the serve/toss line as a risk", () => {
    const p = profile("aoba");
    const s = state(["HV-P01-087"], [{ hand: [1] }, { hand: [2, 3, 4, 5] }]);

    const report = evaluateGameplanState(db, s, 0 as PlayerId, p);

    expect(report.risks.join(" ")).toContain("及川");
  });
});
