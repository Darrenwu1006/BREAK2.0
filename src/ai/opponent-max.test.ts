import { describe, expect, it } from "vitest";
import type { Card, CharacterParams } from "../data/types";
import type { CardDb, GameState, PlayerId, PlayerState } from "../engine/types";
import { defenseHolds, estimateMaxAttackOP, estimateMaxReceiveDP } from "./opponent-max";

// [Claude 2026-07-09] Phase M ③ 原語測試。用最小自製 db/state，不依賴 cards.json，
// 直接鎖參數與同名禁止、null slot、場上頂端可續用等關鍵行為。

function chara(id: string, nameJa: string, params: Partial<CharacterParams>): Card {
  return {
    id,
    type: "CHARACTER",
    nameJa,
    affiliations: [],
    positions: [],
    grades: [],
    params: { serve: null, block: null, receive: null, toss: null, attack: null, ...params },
    printings: [],
  } as unknown as Card;
}

function event(id: string, nameJa: string): Card {
  return {
    id,
    type: "EVENT",
    nameJa,
    affiliations: [],
    positions: [],
    grades: [],
    params: null,
    printings: [],
  } as unknown as Card;
}

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

/** cards：uid(1-based) → cardId。players：各自 zone 放 uid。 */
function makeState(cards: Record<number, string>, players: [Partial<PlayerState>, Partial<PlayerState>]): GameState {
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
  } as unknown as GameState;
}

const P0: PlayerId = 0;

describe("estimateMaxAttackOP", () => {
  it("從手牌組出最佳 托+攻（同名禁止、不同卡）", () => {
    const db: CardDb = new Map([
      ["T1", chara("T1", "托手甲", { toss: 4 })],
      ["A1", chara("A1", "攻手乙", { attack: 6 })],
      ["A2", chara("A2", "攻手丙", { attack: 5 })],
    ]);
    // 手牌三張角色
    const state = makeState({ 1: "T1", 2: "A1", 3: "A2" }, [{ hand: [1, 2, 3] }, {}]);
    const est = estimateMaxAttackOP(db, state, P0);
    expect(est.op).toBe(10); // 托4 + 攻6
    expect(est.tossName).toBe("托手甲");
    expect(est.attackName).toBe("攻手乙");
  });

  it("同名卡不可同時當托與攻", () => {
    const db: CardDb = new Map([
      // 同名「萬能」：托5/攻5，但只有這一張名字 → 攻托不能都用它
      ["U1", chara("U1", "萬能", { toss: 5, attack: 5 })],
      ["A1", chara("A1", "純攻", { attack: 3 })],
    ]);
    const state = makeState({ 1: "U1", 2: "A1" }, [{ hand: [1, 2] }, {}]);
    const est = estimateMaxAttackOP(db, state, P0);
    // 最佳＝萬能當托(5) + 純攻(3)=8；不可 萬能托5+萬能攻5
    expect(est.op).toBe(8);
    expect(est.tossName).toBe("萬能");
    expect(est.attackName).toBe("純攻");
  });

  it("場上頂端角色可續用當攻擊線一環", () => {
    const db: CardDb = new Map([
      ["Tfield", chara("Tfield", "場上托", { toss: 7 })],
      ["A1", chara("A1", "手攻", { attack: 4 })],
    ]);
    // 場上 toss 已站一個 7 托，手牌只有攻
    const state = makeState({ 1: "Tfield", 2: "A1" }, [{ toss: [1], hand: [2] }, {}]);
    const est = estimateMaxAttackOP(db, state, P0);
    expect(est.op).toBe(11); // 場上托7 + 手攻4
    expect(est.tossUid).toBe(1);
    expect(est.attackUid).toBe(2);
  });

  it("只有攻擊手、無托：純攻上場（托 0）", () => {
    const db: CardDb = new Map([["A1", chara("A1", "獨攻", { attack: 6 })]]);
    const state = makeState({ 1: "A1" }, [{ hand: [1] }, {}]);
    const est = estimateMaxAttackOP(db, state, P0);
    expect(est.op).toBe(6);
    expect(est.tossUid).toBeNull();
    expect(est.attackUid).toBe(1);
  });

  it("attack param 為 null 的角色不列入攻擊手", () => {
    const db: CardDb = new Map([
      ["R1", chara("R1", "純接", { receive: 8 })], // attack:null
      ["A1", chara("A1", "弱攻", { attack: 2 })],
    ]);
    const state = makeState({ 1: "R1", 2: "A1" }, [{ hand: [1, 2] }, {}]);
    const est = estimateMaxAttackOP(db, state, P0);
    expect(est.op).toBe(2);
    expect(est.attackName).toBe("弱攻");
  });

  it("事件卡不列入", () => {
    const db: CardDb = new Map([
      ["E1", event("E1", "某事件")],
      ["A1", chara("A1", "攻", { attack: 5 })],
    ]);
    const state = makeState({ 1: "E1", 2: "A1" }, [{ hand: [1, 2] }, {}]);
    expect(estimateMaxAttackOP(db, state, P0).op).toBe(5);
  });

  it("無角色可攻：op 0", () => {
    const db: CardDb = new Map([["E1", event("E1", "事件")]]);
    const state = makeState({ 1: "E1" }, [{ hand: [1] }, {}]);
    expect(estimateMaxAttackOP(db, state, P0).op).toBe(0);
  });
});

describe("estimateMaxReceiveDP", () => {
  it("取手牌/場上最大 receive param", () => {
    const db: CardDb = new Map([
      ["Rfield", chara("Rfield", "場接", { receive: 5 })],
      ["R1", chara("R1", "手接甲", { receive: 8 })],
      ["A1", chara("A1", "攻", { attack: 9 })], // receive:null 不算
    ]);
    const state = makeState({ 1: "Rfield", 2: "R1", 3: "A1" }, [{ receive: [1], hand: [2, 3] }, {}]);
    const est = estimateMaxReceiveDP(db, state, P0);
    expect(est.dp).toBe(8);
    expect(est.receiverName).toBe("手接甲");
  });

  it("無接球手：dp 0", () => {
    const db: CardDb = new Map([["A1", chara("A1", "攻", { attack: 5 })]]);
    const state = makeState({ 1: "A1" }, [{ hand: [1] }, {}]);
    expect(estimateMaxReceiveDP(db, state, P0).dp).toBe(0);
  });
});

describe("defenseHolds", () => {
  it("DP ≥ OP 才接得住（含相等）", () => {
    expect(defenseHolds(6, 6)).toBe(true);
    expect(defenseHolds(7, 6)).toBe(true);
    expect(defenseHolds(5, 6)).toBe(false);
  });
});
