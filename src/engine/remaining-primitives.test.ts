import { describe, expect, it } from "vitest";
import type { Action } from "./dsl";
import { applyEffectDecision, drawCards, freeOptions, isSkillInvalid, stepEffect } from "./effects";
import { effParam } from "./engine";
import { db, deckWith, FILLER, grab, placeOnStack, setup } from "./testkit";
import type { GameState } from "./types";

function runActions(state: GameState, source: number, actions: Action[]): void {
  state.effectCtx = {
    player: 0,
    source,
    frames: [{ actions, pc: 0 }],
    lastTarget: null,
    triggerUid: null,
    turn1: false,
    anyExecuted: false,
    awaiting: null,
    desc: "test",
  };
  stepEffect(db, state);
}

describe("剩餘卡片新增的共用規則", () => {
  it("gate 無法支付或拒絕時會執行 else", () => {
    const state = setup(deckWith("HV-P02-064"), deckWith(FILLER), 0);
    const source = placeOnStack(state, 0, "attack", "HV-P02-064");
    state.players[0].hand = [];
    runActions(state, source, [{
      op: "gate",
      costs: [{ type: "dropFromHand", count: 2 }],
      then: [],
      else: [{ op: "setParam", target: "self", param: "attack", value: 0 }],
    }]);
    expect(effParam(db, state, source, "attack")).toBe(0);
  });

  it("disableSkills 能依角色所在區域讓技能無效", () => {
    const state = setup(deckWith("HV-D01-006"), deckWith(FILLER), 0);
    const source = placeOnStack(state, 0, "receive", "HV-D01-006");
    state.restrictions.push({
      player: 0,
      disableSkills: { area: ["receive"] },
      setNo: state.setNo,
      activeTurn: state.turnNo,
      desc: "test",
    });
    expect(isSkillInvalid(db, state, 0, source)).toBe(true);
  });

  it("banEventTimings 會從自由步驟排除相符事件", () => {
    const state = setup(deckWith("HV-PR-051"), deckWith(FILLER), 0);
    const event = grab(state, 0, "HV-PR-051");
    state.phase = "attack";
    state.turnPlayer = 0;
    state.restrictions.push({
      player: 0,
      banEventTimings: ["attack"],
      setNo: state.setNo,
      activeTurn: state.turnNo,
      desc: "test",
    });
    expect(freeOptions(db, state).events.some((option) => option.uid === event)).toBe(false);
  });

  it("handAdd 監看包含抽牌，且 maxTriggers 只觸發一次", () => {
    const state = setup(deckWith(FILLER), deckWith(FILLER), 0);
    state.phase = "draw";
    state.watchers.push({
      id: state.nextId++,
      player: 0,
      source: state.players[0].hand[0]!,
      trigger: { on: "handAdd", player: "opponent" },
      actions: [{ op: "draw", count: 1 }],
      setNo: state.setNo,
      turnMin: state.turnNo,
      turnMax: state.turnNo,
      remainingTriggers: 1,
      desc: "test",
    });
    drawCards(state, 1, 2);
    expect(state.pendingQueue).toHaveLength(1);
  });

  it("場上角色回手時會正確移除側邊攔網位置", () => {
    const state = setup(deckWith("HV-D01-006", "HV-P02-092"), deckWith(FILLER), 0);
    const side = grab(state, 0, "HV-D01-006");
    state.players[0].hand.splice(state.players[0].hand.indexOf(side), 1);
    state.players[0].blockSides.push(side);
    const source = grab(state, 0, "HV-P02-092");
    runActions(state, source, [{ op: "moveCharaToHand", from: "court", filter: {}, upTo: 1 }]);
    applyEffectDecision(db, state, { type: "effect-cards", uids: [side] });
    expect(state.players[0].blockSides).not.toContain(side);
    expect(state.players[0].hand).toContain(side);
  });

  it("preventOpDecrease 會阻止對手效果降低受保護的 OP", () => {
    const state = setup(deckWith(FILLER), deckWith(FILLER), 0);
    const source = state.players[0].hand[0]!;
    state.op = { owner: 1, source: "attack", value: 5 };
    state.restrictions.push({
      player: 1,
      preventOpDecrease: true,
      setNo: state.setNo,
      activeTurn: state.turnNo,
      desc: "test",
    });
    runActions(state, source, [{ op: "addOpponentOp", amount: -2 }]);
    expect(state.op.value).toBe(5);
  });
});
