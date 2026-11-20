import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import { applyDecision, createGame, normName } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import {
  AI_THOUGHT_MAX_CANDIDATES,
  AI_THOUGHT_MAX_FACTORS,
  AI_THOUGHT_SCHEMA_VERSION,
  isAiThoughtRecord,
  type AiBeliefSnapshot,
} from "../shared/aiThought";
import { describeDecision } from "../shared/decisionLabels";
import type { CoachActionEstimate, CoachReport } from "./coach";
import { explainValue } from "./rollout-value";
import { buildAiThoughtRecord, narrateAiThought } from "./thought-narrator";

const db: CardDb = new Map((cardsJson as Card[]).map((card) => [card.id, card]));

const BANNED_ENGINEERING_TERMS = [
  "AUC",
  "logit",
  "MCTS",
  "SO-ISMCTS",
  "PIMC",
  "tie-break",
  "tieBreak",
  "heuristic",
  "rollout",
  "determinize",
  "UCB",
  "sampleCount",
  "valueExplanation",
];

function makeBaseDeck(priorityIds: readonly string[]): string[] {
  const filler = [
    "HV-D01-001",
    "HV-D01-002",
    "HV-D01-003",
    "HV-D01-004",
    "HV-D01-005",
    "HV-D01-006",
    "HV-P01-011",
    "HV-P01-013",
  ];
  const deck = [...priorityIds];
  let i = 0;
  while (deck.length < 40) {
    deck.push(filler[i % filler.length]!);
    i++;
  }
  return deck.slice(0, 40);
}

function makePreMulliganState(
  p0Cards: readonly string[],
  p1Cards: readonly string[],
  seed = 42,
): GameState {
  const state = createGame(db, {
    seed,
    decks: [makeBaseDeck(p0Cards), makeBaseDeck(p1Cards)],
    skipDeckValidation: true,
  });
  return applyDecision(db, state, { type: "serve-rights", take: true });
}

function makeState(
  p0Cards: readonly string[],
  p1Cards: readonly string[],
  seed = 42,
): GameState {
  let state = makePreMulliganState(p0Cards, p1Cards, seed);
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });
  return applyDecision(db, state, { type: "mulligan", returnUids: [] });
}

function moveToHand(state: GameState, player: PlayerId, cardIds: readonly string[]): number[] {
  const ps = state.players[player];
  const allZones = [
    ps.deck,
    ps.hand,
    ps.setArea,
    ps.drop,
    ps.eventArea,
    ps.serve,
    ps.blockCenter,
    ps.blockSides,
    ps.receive,
    ps.toss,
    ps.attack,
  ];
  const allPlayerUids = allZones.flat();
  const picked: number[] = [];
  for (const id of cardIds) {
    const uid = allPlayerUids.find((u) => state.cards[u] === id && !picked.includes(u));
    if (uid === undefined) throw new Error(`找不到卡片 ${id} 於玩家 ${player}`);
    picked.push(uid);
  }
  for (const zone of allZones) {
    for (let i = zone.length - 1; i >= 0; i--) {
      if (picked.includes(zone[i]!)) zone.splice(i, 1);
    }
  }
  const rest = ps.hand.splice(0, ps.hand.length);
  ps.deck.push(...rest);
  ps.hand.push(...picked);
  return picked;
}

function putOnCourt(
  state: GameState,
  player: PlayerId,
  area: "serve" | "receive" | "toss" | "attack" | "blockCenter",
  cardId: string,
  gutsCount = 0,
): number {
  const ps = state.players[player];
  const allZones = [ps.deck, ps.hand, ps.setArea, ps.drop, ps.eventArea];
  const takeUid = (targetId?: string): number => {
    for (const zone of allZones) {
      const idx = targetId
        ? zone.findIndex((u) => state.cards[u] === targetId)
        : 0;
      if (idx >= 0 && zone.length > 0) {
        return zone.splice(idx, 1)[0]!;
      }
    }
    throw new Error(`找不到可放到 ${area} 的卡片 ${targetId ?? "(任意)"}`);
  };
  for (let i = 0; i < gutsCount; i++) {
    ps[area].push(takeUid());
  }
  const topUid = takeUid(cardId);
  ps[area].push(topUid);
  return topUid;
}

function makeMockEstimate(
  state: GameState,
  decision: Decision,
  winRate: number,
  sampleCount = 120,
): CoachActionEstimate {
  return {
    decision,
    label: describeDecision(db, state, decision, "named"),
    winRate,
    confidence: 0.85,
    sampleCount,
    wins: Math.round(winRate * sampleCount),
    errors: 0,
    maxSteps: 40,
    principalLine: [],
    explanation: "test estimate",
  };
}

function makeMockReport(
  state: GameState,
  perspectivePlayer: PlayerId,
  recommendations: CoachActionEstimate[],
  completedSamples = 200,
  tieBreakReason?: string,
): CoachReport & { tieBreakReason?: string } {
  const bestAction = recommendations[0]!;
  return {
    kind: "ismcts-coach-v1",
    perspectivePlayer,
    actingPlayer: perspectivePlayer,
    pendingType: bestAction.decision.type,
    rolloutPolicy: "heuristic-v2",
    requestedSamplesPerAction: 250,
    completedSamples,
    timedOut: false,
    fallbackDecision: bestAction.decision,
    bestAction,
    recommendations,
    valueExplanation: explainValue(state, perspectivePlayer, undefined, db),
    ...(tieBreakReason !== undefined ? { tieBreakReason } : {}),
  };
}

function assertSafeNoHandLeakage(
  state: GameState,
  perspectivePlayer: PlayerId,
  dialogue: { safe: string; spoiler: string },
  contextLabel: string,
): void {
  expect(dialogue.safe.length, `${contextLabel} safe 不應為空`).toBeGreaterThan(0);
  expect(dialogue.spoiler.length, `${contextLabel} spoiler 不應為空`).toBeGreaterThan(0);

  for (const uid of state.players[perspectivePlayer].hand) {
    const cardId = state.cards[uid];
    if (!cardId) continue;
    const card = db.get(cardId);
    if (!card) continue;
    const shortId = card.id.split("-").at(-1);
    const forbidden = [
      card.nameJa,
      normName(card.nameJa),
      card.nameZh ?? "",
      card.nameZh ? normName(card.nameZh) : "",
      card.id,
      shortId ?? "",
    ].filter(Boolean);
    for (const token of forbidden) {
      expect(dialogue.safe, `${contextLabel} safe 洩漏 AI 手牌 ${token}`).not.toContain(token);
    }
  }

  for (const text of [dialogue.safe, dialogue.spoiler]) {
    const lower = text.toLowerCase();
    for (const term of BANNED_ENGINEERING_TERMS) {
      expect(lower, `${contextLabel} 出現禁用工程詞 ${term}`).not.toContain(term.toLowerCase());
    }
  }
}

describe("thought-narrator: Safe 零洩漏與禁用詞硬測試", () => {
  it("涵蓋所有決策型態與雙引擎時，dialogue.safe 絕不洩漏 AI 未打出手牌且不含工程術語", () => {
    const aiPlayer: PlayerId = 0;

    // 1. serve-rights (開局過場)
    const rawServeRights = createGame(db, {
      seed: 1,
      decks: [makeBaseDeck(["HV-D01-001", "HV-D01-004"]), makeBaseDeck(["HV-D01-005"])],
      skipDeckValidation: true,
    });
    const srDecision: Decision = { type: "serve-rights", take: true };
    const srRec = buildAiThoughtRecord({
      db,
      state: rawServeRights,
      perspectivePlayer: rawServeRights.pendingDecision!.player,
      decision: srDecision,
      engine: "heuristic",
    });
    expect(isAiThoughtRecord(srRec)).toBe(true);
    expect(srRec.isKeyDecision).toBe(false);
    assertSafeNoHandLeakage(rawServeRights, rawServeRights.pendingDecision!.player, srRec.dialogue, "serve-rights");

    // 2. mulligan
    const mullState = makePreMulliganState(["HV-D01-004", "HV-P01-011", "HV-D01-002", "HV-D01-001", "HV-P01-076"], []);
    const mullHand = moveToHand(mullState, aiPlayer, ["HV-D01-004", "HV-P01-011", "HV-D01-002", "HV-D01-001", "HV-P01-076"]);
    mullState.pendingDecision = { player: aiPlayer, type: "mulligan" };
    const mullReturn: Decision = { type: "mulligan", returnUids: [mullHand[4]!] };
    const mullKeep: Decision = { type: "mulligan", returnUids: [] };
    const mullRec = buildAiThoughtRecord({
      db,
      state: mullState,
      perspectivePlayer: aiPlayer,
      decision: mullReturn,
      engine: "strong",
      report: makeMockReport(mullState, aiPlayer, [
        makeMockEstimate(mullState, mullReturn, 0.56),
        makeMockEstimate(mullState, mullKeep, 0.49),
      ]),
    });
    expect(mullRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(mullState, aiPlayer, mullRec.dialogue, "mulligan");

    // 3. defense-choice (block vs receive)
    const defChoiceState = makeState(["HV-D01-003", "HV-P01-011", "HV-P01-060"], []);
    moveToHand(defChoiceState, aiPlayer, ["HV-D01-003", "HV-P01-011", "HV-P01-060"]);
    defChoiceState.phase = "start";
    defChoiceState.turnPlayer = aiPlayer;
    defChoiceState.op = { value: 6, owner: 1, source: "attack" };
    defChoiceState.pendingDecision = { player: aiPlayer, type: "defense-choice" };
    const dcBlock: Decision = { type: "defense-choice", choice: "block" };
    const dcRecv: Decision = { type: "defense-choice", choice: "receive" };
    const dcRec = buildAiThoughtRecord({
      db,
      state: defChoiceState,
      perspectivePlayer: aiPlayer,
      decision: dcRecv,
      engine: "strong",
      report: makeMockReport(defChoiceState, aiPlayer, [
        makeMockEstimate(defChoiceState, dcRecv, 0.61),
        makeMockEstimate(defChoiceState, dcBlock, 0.45),
      ]),
    });
    expect(dcRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(defChoiceState, aiPlayer, dcRec.dialogue, "defense-choice");

    // 4. deploy-serve
    const dServeState = makeState(["HV-D01-004", "HV-D01-001"], []);
    const dServeHand = moveToHand(dServeState, aiPlayer, ["HV-D01-004", "HV-D01-001"]);
    dServeState.phase = "serve";
    dServeState.turnPlayer = aiPlayer;
    dServeState.pendingDecision = { player: aiPlayer, type: "deploy-serve" };
    const dServeDec: Decision = { type: "deploy-serve", uid: dServeHand[0]! };
    const dServeRec = buildAiThoughtRecord({
      db,
      state: dServeState,
      perspectivePlayer: aiPlayer,
      decision: dServeDec,
      engine: "heuristic",
    });
    expect(dServeRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(dServeState, aiPlayer, dServeRec.dialogue, "deploy-serve");

    // 5. deploy-receive
    const dRecvState = makeState(["HV-P01-011", "HV-D01-005"], []);
    const dRecvHand = moveToHand(dRecvState, aiPlayer, ["HV-P01-011", "HV-D01-005"]);
    dRecvState.phase = "receive";
    dRecvState.turnPlayer = aiPlayer;
    dRecvState.op = { value: 5, owner: 1, source: "attack" };
    dRecvState.pendingDecision = { player: aiPlayer, type: "deploy-receive" };
    const dRecvDec: Decision = { type: "deploy-receive", uid: dRecvHand[0]! };
    const dRecvRec = buildAiThoughtRecord({
      db,
      state: dRecvState,
      perspectivePlayer: aiPlayer,
      decision: dRecvDec,
      engine: "strong",
      report: makeMockReport(dRecvState, aiPlayer, [
        makeMockEstimate(dRecvState, dRecvDec, 0.63),
        makeMockEstimate(dRecvState, { type: "deploy-receive", uid: dRecvHand[1]! }, 0.57),
      ]),
    });
    expect(dRecvRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(dRecvState, aiPlayer, dRecvRec.dialogue, "deploy-receive");

    // 6. deploy-toss
    const dTossState = makeState(["HV-D01-002", "HV-P01-072", "HV-D01-001"], []);
    const dTossHand = moveToHand(dTossState, aiPlayer, ["HV-D01-002", "HV-P01-072", "HV-D01-001"]);
    dTossState.phase = "toss";
    dTossState.turnPlayer = aiPlayer;
    dTossState.pendingDecision = { player: aiPlayer, type: "deploy-toss" };
    const dTossDec: Decision = { type: "deploy-toss", uid: dTossHand[0]! };
    const dTossRec = buildAiThoughtRecord({
      db,
      state: dTossState,
      perspectivePlayer: aiPlayer,
      decision: dTossDec,
      engine: "heuristic",
    });
    expect(dTossRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(dTossState, aiPlayer, dTossRec.dialogue, "deploy-toss");

    // 7. deploy-attack
    const dAtkState = makeState(["HV-D01-006", "HV-D01-001", "HV-D01-002"], []);
    const dAtkHand = moveToHand(dAtkState, aiPlayer, ["HV-D01-006", "HV-D01-001"]);
    putOnCourt(dAtkState, aiPlayer, "toss", "HV-D01-002");
    dAtkState.phase = "attack";
    dAtkState.turnPlayer = aiPlayer;
    dAtkState.pendingDecision = { player: aiPlayer, type: "deploy-attack" };
    const dAtkDec: Decision = { type: "deploy-attack", uid: dAtkHand[0]! };
    const dAtkRec = buildAiThoughtRecord({
      db,
      state: dAtkState,
      perspectivePlayer: aiPlayer,
      decision: dAtkDec,
      engine: "strong",
      report: makeMockReport(dAtkState, aiPlayer, [
        makeMockEstimate(dAtkState, dAtkDec, 0.71),
        makeMockEstimate(dAtkState, { type: "deploy-attack", uid: dAtkHand[1]! }, 0.62),
      ]),
    });
    expect(dAtkRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(dAtkState, aiPlayer, dAtkRec.dialogue, "deploy-attack");

    // 8. deploy-block
    const dBlkState = makeState(["HV-D01-003", "HV-P01-060", "HV-D01-004"], []);
    const dBlkHand = moveToHand(dBlkState, aiPlayer, ["HV-D01-003", "HV-P01-060", "HV-D01-004"]);
    dBlkState.phase = "block";
    dBlkState.turnPlayer = aiPlayer;
    dBlkState.op = { value: 5, owner: 1, source: "attack" };
    dBlkState.pendingDecision = { player: aiPlayer, type: "deploy-block" };
    const dBlkDec: Decision = { type: "deploy-block", uids: [dBlkHand[0]!, dBlkHand[2]!], center: dBlkHand[2]! };
    const dBlkRec = buildAiThoughtRecord({
      db,
      state: dBlkState,
      perspectivePlayer: aiPlayer,
      decision: dBlkDec,
      engine: "heuristic",
    });
    expect(dBlkRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(dBlkState, aiPlayer, dBlkRec.dialogue, "deploy-block");

    // 9. free: pass (both non-key and key with event)
    const freePassNoOpt = makeState(["HV-D01-001", "HV-P01-076"], []);
    moveToHand(freePassNoOpt, aiPlayer, ["HV-D01-001"]);
    freePassNoOpt.phase = "receive";
    freePassNoOpt.turnPlayer = aiPlayer;
    freePassNoOpt.pendingDecision = { player: aiPlayer, type: "free" };
    const fpRec = buildAiThoughtRecord({
      db,
      state: freePassNoOpt,
      perspectivePlayer: aiPlayer,
      decision: { type: "free", action: "pass" },
      engine: "heuristic",
    });
    expect(fpRec.isKeyDecision).toBe(false);
    assertSafeNoHandLeakage(freePassNoOpt, aiPlayer, fpRec.dialogue, "free: pass (non-key)");

    // 10. free: event
    const freeEvtState = makeState(["HV-D01-011", "HV-P01-011", "HV-D01-001"], []);
    const freeEvtHand = moveToHand(freeEvtState, aiPlayer, ["HV-D01-011", "HV-D01-001"]);
    putOnCourt(freeEvtState, aiPlayer, "receive", "HV-P01-011");
    freeEvtState.phase = "receive";
    freeEvtState.sub = 1;
    freeEvtState.turnPlayer = aiPlayer;
    freeEvtState.op = { value: 5, owner: 1, source: "attack" };
    freeEvtState.pendingDecision = { player: aiPlayer, type: "free" };
    const feDec: Decision = { type: "free", action: "event", uid: freeEvtHand[0]! };
    const feRec = buildAiThoughtRecord({
      db,
      state: freeEvtState,
      perspectivePlayer: aiPlayer,
      decision: feDec,
      engine: "strong",
      report: makeMockReport(freeEvtState, aiPlayer, [
        makeMockEstimate(freeEvtState, feDec, 0.62),
        makeMockEstimate(freeEvtState, { type: "free", action: "pass" }, 0.51),
      ]),
    });
    expect(feRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(freeEvtState, aiPlayer, feRec.dialogue, "free: event");

    // 11. free: skill (HV-P01-013 緣下 力 在手牌開接球主動技)
    const freeSkillState = makeState(["HV-P01-013", "HV-D01-001", "HV-D01-006"], []);
    const freeSkillHand = moveToHand(freeSkillState, aiPlayer, ["HV-P01-013", "HV-D01-006"]);
    putOnCourt(freeSkillState, aiPlayer, "receive", "HV-D01-001");
    freeSkillState.phase = "receive";
    freeSkillState.sub = 1;
    freeSkillState.turnPlayer = aiPlayer;
    freeSkillState.op = { value: 4, owner: 1, source: "attack" };
    freeSkillState.pendingDecision = { player: aiPlayer, type: "free" };
    const fsDec: Decision = { type: "free", action: "skill", uid: freeSkillHand[0]!, skillIndex: 0 };
    const fsRec = buildAiThoughtRecord({
      db,
      state: freeSkillState,
      perspectivePlayer: aiPlayer,
      decision: fsDec,
      engine: "heuristic",
    });
    expect(fsRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(freeSkillState, aiPlayer, fsRec.dialogue, "free: skill");

    // 12. effect-confirm
    const effConfirmState = makeState(["HV-D01-001", "HV-D01-004", "HV-P01-076"], []);
    moveToHand(effConfirmState, aiPlayer, ["HV-D01-001", "HV-D01-004", "HV-P01-076"]);
    effConfirmState.pendingDecision = { player: aiPlayer, type: "effect-confirm", prompt: "是否支付 Guts 啟動效果？" };
    const ecDec: Decision = { type: "effect-confirm", accept: true };
    const ecRec = buildAiThoughtRecord({
      db,
      state: effConfirmState,
      perspectivePlayer: aiPlayer,
      decision: ecDec,
      engine: "strong",
      report: makeMockReport(effConfirmState, aiPlayer, [
        makeMockEstimate(effConfirmState, ecDec, 0.59),
        makeMockEstimate(effConfirmState, { type: "effect-confirm", accept: false }, 0.52),
      ]),
    });
    expect(ecRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(effConfirmState, aiPlayer, ecRec.dialogue, "effect-confirm");

    // 13. effect-cards
    const effCardsState = makeState(["HV-D01-001", "HV-D01-002", "HV-D01-004"], []);
    const effCardsHand = moveToHand(effCardsState, aiPlayer, ["HV-D01-001", "HV-D01-002", "HV-D01-004"]);
    effCardsState.pendingDecision = {
      player: aiPlayer,
      type: "effect-cards",
      candidates: effCardsHand,
      min: 1,
      max: 1,
    };
    const ecdDec: Decision = { type: "effect-cards", uids: [effCardsHand[0]!] };
    const ecdRec = buildAiThoughtRecord({
      db,
      state: effCardsState,
      perspectivePlayer: aiPlayer,
      decision: ecdDec,
      engine: "heuristic",
    });
    expect(ecdRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(effCardsState, aiPlayer, ecdRec.dialogue, "effect-cards");

    // 14. effect-option
    const effOptState = makeState(["HV-D01-001", "HV-P01-011"], []);
    moveToHand(effOptState, aiPlayer, ["HV-D01-001", "HV-P01-011"]);
    effOptState.pendingDecision = {
      player: aiPlayer,
      type: "effect-option",
      options: ["接球 +1", "抽 1 張牌"],
    };
    const eoDec: Decision = { type: "effect-option", index: 0 };
    const eoRec = buildAiThoughtRecord({
      db,
      state: effOptState,
      perspectivePlayer: aiPlayer,
      decision: eoDec,
      engine: "strong",
      report: makeMockReport(effOptState, aiPlayer, [
        makeMockEstimate(effOptState, eoDec, 0.65),
        makeMockEstimate(effOptState, { type: "effect-option", index: 1 }, 0.54),
      ]),
    });
    expect(eoRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(effOptState, aiPlayer, eoRec.dialogue, "effect-option");

    // 15. resolve-pending & pick-set-card
    const rpState = makeState(["HV-D01-001", "HV-D01-002"], []);
    moveToHand(rpState, aiPlayer, ["HV-D01-001", "HV-D01-002"]);
    rpState.pendingDecision = { player: aiPlayer, type: "resolve-pending", candidates: [1, 2] };
    const rpRec = buildAiThoughtRecord({
      db,
      state: rpState,
      perspectivePlayer: aiPlayer,
      decision: { type: "resolve-pending", id: 1 },
      engine: "heuristic",
    });
    expect(rpRec.isKeyDecision).toBe(true);
    assertSafeNoHandLeakage(rpState, aiPlayer, rpRec.dialogue, "resolve-pending");

    const pickSetState = makeState(["HV-D01-001", "HV-D01-005"], []);
    moveToHand(pickSetState, aiPlayer, ["HV-D01-001", "HV-D01-005"]);
    pickSetState.pendingDecision = { player: aiPlayer, type: "pick-set-card" };
    const pickSetRec = buildAiThoughtRecord({
      db,
      state: pickSetState,
      perspectivePlayer: aiPlayer,
      decision: { type: "pick-set-card", index: 0 },
      engine: "heuristic",
    });
    expect(pickSetRec.isKeyDecision).toBe(false);
    assertSafeNoHandLeakage(pickSetState, aiPlayer, pickSetRec.dialogue, "pick-set-card");
  });

  it("鏡像對局時若對手公開入手的王牌剛好也在 AI 手牌中，dialogue.safe 仍不洩漏該卡名", () => {
    const aiPlayer: PlayerId = 0;
    const state = makeState(["HV-P01-035", "HV-D01-001"], ["HV-P01-035"]);
    const hand = moveToHand(state, aiPlayer, ["HV-P01-035", "HV-D01-001"]);
    state.phase = "receive";
    state.turnPlayer = aiPlayer;
    state.op = { value: 5, owner: 1, source: "attack" };
    state.pendingDecision = { player: aiPlayer, type: "deploy-receive" };

    const belief: AiBeliefSnapshot = {
      knownOppHandCardIds: ["HV-P01-035"],
      reducedTags: [],
      oppGuts: 2,
      oppRemainingHighReceive: 2,
      oppRemainingDefEvent: 1,
    };
    const dec: Decision = { type: "deploy-receive", uid: hand[0]! };
    const rec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: dec,
      engine: "heuristic",
      belief,
    });

    assertSafeNoHandLeakage(state, aiPlayer, rec.dialogue, "mirror-public-recall");
    expect(rec.dialogue.spoiler).toContain("岩泉 一");
  });
});

describe("thought-narrator: §4.2 六大核心情境與決策語意", () => {
  it("情境 1：穩接＋有舉攻＋對面高 Guts (oppGuts >= 3)＋手上有防禦加點事件卻選 Pass", () => {
    const aiPlayer: PlayerId = 0;
    // AI 場上西谷夕 R=6，來襲 OP=5（已穩接）；手牌含托球(影山)+攻擊(日向)+防禦加點事件(HV-D01-011)
    const state = makeState(
      ["HV-P01-011", "HV-D01-002", "HV-D01-001", "HV-D01-011"],
      ["HV-D01-001", "HV-D01-002"],
    );
    const hand = moveToHand(state, aiPlayer, ["HV-D01-002", "HV-D01-001", "HV-D01-011"]);
    putOnCourt(state, aiPlayer, "receive", "HV-P01-011");
    putOnCourt(state, 1, "attack", "HV-D01-001", 4); // 對手場上 4 Guts >= 3
    state.phase = "receive";
    state.sub = 1;
    state.turnPlayer = aiPlayer;
    state.op = { value: 5, owner: 1, source: "attack" };
    state.pendingDecision = { player: aiPlayer, type: "free" };

    const passDec: Decision = { type: "free", action: "pass" };
    const evtDec: Decision = { type: "free", action: "event", uid: hand[2]! };
    const rec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: passDec,
      engine: "strong",
      report: makeMockReport(state, aiPlayer, [
        makeMockEstimate(state, passDec, 0.58),
        makeMockEstimate(state, evtDec, 0.54),
      ]),
    });

    expect(rec.isKeyDecision).toBe(true);
    expect(rec.dialogue.safe).toContain("接得住");
    expect(rec.dialogue.safe).toContain("Guts");
    expect(rec.dialogue.safe).toContain("留一手");
    expect(rec.dialogue.spoiler).toContain("58%");
    expect(rec.dialogue.spoiler).toContain("54%");
    expect(rec.dialogue.spoiler).toContain("4 Guts");
    assertSafeNoHandLeakage(state, aiPlayer, rec.dialogue, "steady-hold-high-guts");
  });

  it("情境 2：穩接但缺舉攻鏈＋打出抽／檢索事件", () => {
    const aiPlayer: PlayerId = 0;
    // 場上西谷夕 R=6 vs OP=5（穩接），手牌只有日向（缺托球手）與事件 HV-D01-011（draw 1 + receive +1）
    const state = makeState(["HV-P01-011", "HV-D01-001", "HV-D01-011"], []);
    const hand = moveToHand(state, aiPlayer, ["HV-D01-001", "HV-D01-011"]);
    putOnCourt(state, aiPlayer, "receive", "HV-P01-011");
    state.phase = "receive";
    state.sub = 1;
    state.turnPlayer = aiPlayer;
    state.op = { value: 5, owner: 1, source: "attack" };
    state.pendingDecision = { player: aiPlayer, type: "free" };

    const evtDec: Decision = { type: "free", action: "event", uid: hand[1]! };
    const passDec: Decision = { type: "free", action: "pass" };
    const rec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: evtDec,
      engine: "strong",
      report: makeMockReport(state, aiPlayer, [
        makeMockEstimate(state, evtDec, 0.61),
        makeMockEstimate(state, passDec, 0.55),
      ]),
    });

    expect(rec.isKeyDecision).toBe(true);
    expect(rec.dialogue.safe).toContain("接得住");
    expect(rec.dialogue.safe).toContain("反擊拼圖");
    expect(rec.dialogue.spoiler).toContain("缺舉攻線");
    expect(rec.dialogue.spoiler).toContain("61%");
    assertSafeNoHandLeakage(state, aiPlayer, rec.dialogue, "steady-missing-pair-draw");
  });

  it("情境 3：公開記憶抓到對手手握特定王牌", () => {
    const aiPlayer: PlayerId = 0;
    const state = makeState(["HV-P01-011", "HV-D01-001"], ["HV-P01-035"]);
    const hand = moveToHand(state, aiPlayer, ["HV-P01-011", "HV-D01-001"]);
    state.phase = "receive";
    state.turnPlayer = aiPlayer;
    state.op = { value: 5, owner: 1, source: "attack" };
    state.pendingDecision = { player: aiPlayer, type: "deploy-receive" };

    const belief: AiBeliefSnapshot = {
      knownOppHandCardIds: ["HV-P01-035"], // 岩泉 一（不在 AI 手牌中）
      reducedTags: [],
      oppGuts: 3,
      oppRemainingHighReceive: 2,
      oppRemainingDefEvent: 1,
    };
    const dec: Decision = { type: "deploy-receive", uid: hand[0]! };
    const rec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: dec,
      engine: "strong",
      report: makeMockReport(state, aiPlayer, [makeMockEstimate(state, dec, 0.62)]),
      belief,
    });

    expect(rec.dialogue.safe).toContain("岩泉 一");
    expect(rec.dialogue.safe).toContain("撿回手上");
    expect(rec.dialogue.spoiler).toContain("岩泉 一");
    expect(rec.dialogue.spoiler).toContain("62%");
    assertSafeNoHandLeakage(state, aiPlayer, rec.dialogue, "public-recall");
  });

  it("情境 4：賽末點負面排除對手高接球 → 猛壓進攻", () => {
    const aiPlayer: PlayerId = 0;
    const state = makeState(["HV-D01-006", "HV-D01-001", "HV-D01-002"], []);
    const hand = moveToHand(state, aiPlayer, ["HV-D01-006", "HV-D01-001"]);
    putOnCourt(state, aiPlayer, "toss", "HV-D01-002");
    state.phase = "attack";
    state.turnPlayer = aiPlayer;
    state.pendingDecision = { player: aiPlayer, type: "deploy-attack" };

    const belief: AiBeliefSnapshot = {
      knownOppHandCardIds: [],
      reducedTags: ["matchpoint-high-receive"],
      oppGuts: 1,
      oppRemainingHighReceive: 0.4,
      oppRemainingDefEvent: 0.5,
    };
    const dec: Decision = { type: "deploy-attack", uid: hand[0]! };
    const rec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: dec,
      engine: "strong",
      report: makeMockReport(state, aiPlayer, [
        makeMockEstimate(state, dec, 0.67),
        makeMockEstimate(state, { type: "deploy-attack", uid: hand[1]! }, 0.59),
      ]),
      belief,
    });

    expect(rec.dialogue.safe).toContain("高接球");
    expect(rec.dialogue.safe).toContain("壓上去");
    expect(rec.dialogue.spoiler).toContain("賽末點負面排除");
    expect(rec.dialogue.spoiler).toContain("67%");
    assertSafeNoHandLeakage(state, aiPlayer, rec.dialogue, "matchpoint-exclusion");
  });

  it("情境 5：必敗局戰術攔網濾牌（tieBreakReason 與 heuristic 無標籤路徑皆可觸發）", () => {
    const aiPlayer: PlayerId = 0;
    const state = makeState(["HV-D01-001", "HV-D01-006", "HV-D01-005"], []);
    const hand = moveToHand(state, aiPlayer, ["HV-D01-001", "HV-D01-006"]);
    state.phase = "block";
    state.turnPlayer = aiPlayer;
    state.op = { value: 8, owner: 1, source: "attack" };
    state.pendingDecision = { player: aiPlayer, type: "deploy-block" };

    const blkDec: Decision = { type: "deploy-block", uids: [hand[0]!], center: hand[0]! };
    const lostDec: Decision = { type: "deploy-block", uids: null };

    const strongRec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: blkDec,
      engine: "strong",
      report: makeMockReport(
        state,
        aiPlayer,
        [makeMockEstimate(state, blkDec, 0.34), makeMockEstimate(state, lostDec, 0.31)],
        180,
        "hopeless-defense-cycling",
      ),
    });
    expect(strongRec.tieBreakReason).toBe("hopeless-defense-cycling");
    expect(strongRec.dialogue.safe).toContain("攔網");
    expect(strongRec.dialogue.safe).toContain("下一局");
    expect(strongRec.dialogue.spoiler).toContain("必敗局啟動戰術濾牌");
    assertSafeNoHandLeakage(state, aiPlayer, strongRec.dialogue, "hopeless-strong");

    // heuristic 無 tieBreakReason 時也能從場況（非賽末點＋必敗攔網無 One Touch）辨識
    const heurRec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: blkDec,
      engine: "heuristic",
    });
    expect(heurRec.dialogue.safe).toContain("攔網");
    expect(heurRec.dialogue.spoiler).toContain("必敗局啟動戰術濾牌");
    assertSafeNoHandLeakage(state, aiPlayer, heurRec.dialogue, "hopeless-heuristic");
  });

  it("情境 6：平手壓制力（pressure-tiebreak）、one-touch-lean 與 conservation-attack", () => {
    const aiPlayer: PlayerId = 0;
    const state = makeState(["HV-D01-006", "HV-D01-001", "HV-D01-002", "HV-P01-060"], []);
    const hand = moveToHand(state, aiPlayer, ["HV-D01-006", "HV-D01-001", "HV-P01-060"]);
    putOnCourt(state, aiPlayer, "toss", "HV-D01-002");
    state.phase = "attack";
    state.turnPlayer = aiPlayer;
    state.pendingDecision = { player: aiPlayer, type: "deploy-attack" };

    const decA: Decision = { type: "deploy-attack", uid: hand[0]! };
    const decB: Decision = { type: "deploy-attack", uid: hand[1]! };
    const pressureRec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: decA,
      engine: "strong",
      report: makeMockReport(
        state,
        aiPlayer,
        [makeMockEstimate(state, decA, 0.64), makeMockEstimate(state, decB, 0.62)],
        240,
        "pressure-tiebreak",
      ),
    });
    expect(pressureRec.dialogue.safe).toContain("壓制力");
    expect(pressureRec.dialogue.spoiler).toContain("64%");
    expect(pressureRec.dialogue.spoiler).toContain("62%");
    assertSafeNoHandLeakage(state, aiPlayer, pressureRec.dialogue, "pressure-tiebreak");

    const conserveRec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: decB,
      engine: "strong",
      report: makeMockReport(
        state,
        aiPlayer,
        [makeMockEstimate(state, decB, 0.89), makeMockEstimate(state, decA, 0.88)],
        240,
        "conservation-attack",
      ),
    });
    expect(conserveRec.dialogue.safe).toContain("省點火力");
    expect(conserveRec.dialogue.spoiler).toContain("省資源進攻");
    assertSafeNoHandLeakage(state, aiPlayer, conserveRec.dialogue, "conservation-attack");

    state.phase = "block";
    state.op = { value: 6, owner: 1, source: "attack" };
    state.pendingDecision = { player: aiPlayer, type: "deploy-block" };
    const otDec: Decision = { type: "deploy-block", uids: [hand[2]!], center: hand[2]! };
    const otRec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: otDec,
      engine: "strong",
      report: makeMockReport(
        state,
        aiPlayer,
        [
          makeMockEstimate(state, otDec, 0.55),
          makeMockEstimate(state, { type: "deploy-block", uids: [hand[2]!, hand[0]!], center: hand[2]! }, 0.54),
        ],
        200,
        "one-touch-lean",
      ),
    });
    expect(otRec.dialogue.safe).toContain("One Touch");
    expect(otRec.dialogue.spoiler).toContain("One Touch");
    assertSafeNoHandLeakage(state, aiPlayer, otRec.dialogue, "one-touch-lean");
  });
});

describe("thought-narrator: completedSamples === 0 防呆與資料契約", () => {
  it("heuristic 與 direct shortcut（completedSamples === 0）不設定 chosenWinRate、topCandidates=[] 且不出現 0%", () => {
    const aiPlayer: PlayerId = 0;
    const state = makeState(["HV-D01-001", "HV-D01-006", "HV-D01-002"], []);
    const hand = moveToHand(state, aiPlayer, ["HV-D01-001", "HV-D01-006"]);
    putOnCourt(state, aiPlayer, "toss", "HV-D01-002");
    state.phase = "attack";
    state.turnPlayer = aiPlayer;
    state.pendingDecision = { player: aiPlayer, type: "deploy-attack" };
    const dec: Decision = { type: "deploy-attack", uid: hand[0]! };

    const heurRec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: dec,
      engine: "heuristic",
      report: null,
    });
    expect(heurRec.completedSamples).toBe(0);
    expect(heurRec.chosenWinRate).toBeUndefined();
    expect("chosenWinRate" in heurRec).toBe(false);
    expect(heurRec.topCandidates).toEqual([]);
    expect(heurRec.dialogue.safe).not.toContain("0%");
    expect(heurRec.dialogue.spoiler).not.toContain("0%");

    // 模擬 directRootDecision 回傳 winRate: 0, completedSamples: 0 的佔位報告
    const directRec = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: dec,
      engine: "strong",
      report: makeMockReport(state, aiPlayer, [makeMockEstimate(state, dec, 0, 0)], 0),
    });
    expect(directRec.completedSamples).toBe(0);
    expect(directRec.chosenWinRate).toBeUndefined();
    expect("chosenWinRate" in directRec).toBe(false);
    expect(directRec.topCandidates).toEqual([]);
    expect(directRec.dialogue.safe).not.toContain("0%");
    expect(directRec.dialogue.spoiler).not.toContain("0%");

    // 直接呼叫 narrateAiThought 並刻意傳入 completedSamples: 0 + chosenWinRate: 0 也不應吐出 0%
    const directDialogue = narrateAiThought(
      {
        schemaVersion: AI_THOUGHT_SCHEMA_VERSION,
        engine: "strong",
        isKeyDecision: true,
        pendingType: "deploy-attack",
        chosenLabel: "登場 田中 龍之介〔006〕",
        chosenWinRate: 0,
        completedSamples: 0,
        topCandidates: [],
        valueFactors: [],
      },
      {
        db,
        state,
        perspectivePlayer: aiPlayer,
        decision: dec,
        oppGuts: 0,
        incomingOp: 0,
        currentDefenseDp: 0,
        hasLegalFollowup: false,
        hasPlayableDefBuffEvent: false,
        hasPlayableDrawEvent: false,
      },
    );
    expect(directDialogue.safe).not.toContain("0%");
    expect(directDialogue.spoiler).not.toContain("0%");
  });

  it("確定性重現、topCandidates / valueFactors 上限 <= 3、同卡複數張唯一命中 isChosen", () => {
    const aiPlayer: PlayerId = 0;
    const state = makeState(
      ["HV-D01-001", "HV-D01-001", "HV-D01-006", "HV-D01-003", "HV-D01-004", "HV-D01-002"],
      [],
    );
    const hand = moveToHand(state, aiPlayer, ["HV-D01-001", "HV-D01-001", "HV-D01-006", "HV-D01-003"]);
    putOnCourt(state, aiPlayer, "toss", "HV-D01-002");
    state.phase = "attack";
    state.turnPlayer = aiPlayer;
    state.pendingDecision = { player: aiPlayer, type: "deploy-attack" };

    // 刻意選第二張同名 HV-D01-001 (hand[1]) 作為決策
    const decDup0: Decision = { type: "deploy-attack", uid: hand[0]! };
    const decDup1: Decision = { type: "deploy-attack", uid: hand[1]! };
    const decOther1: Decision = { type: "deploy-attack", uid: hand[2]! };
    const decOther2: Decision = { type: "deploy-attack", uid: hand[3]! };
    const report = makeMockReport(state, aiPlayer, [
      makeMockEstimate(state, decDup0, 0.59, 100),
      makeMockEstimate(state, decDup1, 0.63, 140),
      makeMockEstimate(state, decOther1, 0.55, 80),
      makeMockEstimate(state, decOther2, 0.48, 40),
    ]);

    const r1 = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: decDup1,
      engine: "strong",
      report,
    });
    const r2 = buildAiThoughtRecord({
      db,
      state,
      perspectivePlayer: aiPlayer,
      decision: decDup1,
      engine: "strong",
      report,
    });

    expect(r1).toEqual(r2);
    expect(r1.topCandidates.length).toBeLessThanOrEqual(AI_THOUGHT_MAX_CANDIDATES);
    expect(r1.topCandidates.length).toBe(3);
    expect(r1.valueFactors.length).toBeLessThanOrEqual(AI_THOUGHT_MAX_FACTORS);
    expect(r1.valueFactors.every((f) => Math.abs(f.contribution) >= 0.01)).toBe(true);
    expect(r1.chosenWinRate).toBe(0.63);
    // 兩張同名卡在手時，只有被選中的 hand[1] (index 1) 應為 isChosen: true
    expect(r1.topCandidates.map((c) => c.isChosen)).toEqual([false, true, false]);
  });

  it("isKeyDecision 邊界：無事件技能 free:pass 與不可攔網 defense-choice 回傳 false", () => {
    const aiPlayer: PlayerId = 0;

    // 1. free: pass 無可用事件/技能（即使報告列出 pass 與 lost 兩個候選，仍必為 false）
    const freeState = makeState(["HV-D01-001", "HV-D01-006"], []);
    moveToHand(freeState, aiPlayer, ["HV-D01-001"]);
    freeState.phase = "receive";
    freeState.turnPlayer = aiPlayer;
    freeState.pendingDecision = { player: aiPlayer, type: "free" };
    const passDec: Decision = { type: "free", action: "pass" };
    const lostDec: Decision = { type: "free", action: "lost" };
    const freePassRec = buildAiThoughtRecord({
      db,
      state: freeState,
      perspectivePlayer: aiPlayer,
      decision: passDec,
      engine: "strong",
      report: makeMockReport(freeState, aiPlayer, [
        makeMockEstimate(freeState, passDec, 0.55),
        makeMockEstimate(freeState, lostDec, 0.1),
      ]),
    });
    expect(freePassRec.isKeyDecision).toBe(false);

    // 2. defense-choice 當對面是發球（canChooseBlock === false）→ false
    const dcServeState = makeState(["HV-D01-005"], []);
    moveToHand(dcServeState, aiPlayer, ["HV-D01-005"]);
    dcServeState.phase = "start";
    dcServeState.turnPlayer = aiPlayer;
    dcServeState.op = { value: 5, owner: 1, source: "serve" };
    dcServeState.pendingDecision = { player: aiPlayer, type: "defense-choice" };
    const dcServeRec = buildAiThoughtRecord({
      db,
      state: dcServeState,
      perspectivePlayer: aiPlayer,
      decision: { type: "defense-choice", choice: "receive" },
      engine: "heuristic",
    });
    expect(dcServeRec.isKeyDecision).toBe(false);

    // 3. deploy-attack 手牌無合法可登場攻擊手時（事件卡不可登場，0 + 1 = 1）→ false
    const noAtkState = makeState(["HV-D01-011", "HV-P01-076"], []);
    moveToHand(noAtkState, aiPlayer, ["HV-D01-011", "HV-P01-076"]);
    noAtkState.phase = "attack";
    noAtkState.turnPlayer = aiPlayer;
    noAtkState.pendingDecision = { player: aiPlayer, type: "deploy-attack" };
    const noAtkRec = buildAiThoughtRecord({
      db,
      state: noAtkState,
      perspectivePlayer: aiPlayer,
      decision: { type: "deploy-attack", uid: null },
      engine: "heuristic",
    });
    expect(noAtkRec.isKeyDecision).toBe(false);

    // 4. deploy-block 手牌無合法可攔網角色（Li block=null ＋事件卡）→ false
    const noBlkState = makeState(["HV-P01-011", "HV-D01-011"], []);
    moveToHand(noBlkState, aiPlayer, ["HV-P01-011", "HV-D01-011"]);
    noBlkState.phase = "block";
    noBlkState.turnPlayer = aiPlayer;
    noBlkState.op = { value: 5, owner: 1, source: "attack" };
    noBlkState.pendingDecision = { player: aiPlayer, type: "deploy-block" };
    const noBlkRec = buildAiThoughtRecord({
      db,
      state: noBlkState,
      perspectivePlayer: aiPlayer,
      decision: { type: "deploy-block", uids: null },
      engine: "heuristic",
    });
    expect(noBlkRec.isKeyDecision).toBe(false);
  });

  it("spoilerCompare 當獲選候選勝率低於次佳候選時改用 vs 而非 ＞", () => {
    const aiPlayer: PlayerId = 0;
    const st = makeState(["HV-D01-011", "HV-D01-001"], []);
    const hand = moveToHand(st, aiPlayer, ["HV-D01-011", "HV-D01-001"]);
    st.phase = "receive";
    st.sub = 1;
    st.turnPlayer = aiPlayer;
    st.op = { value: 5, owner: 1, source: "attack" };
    st.pendingDecision = { player: aiPlayer, type: "free" };
    const passDec: Decision = { type: "free", action: "pass" };
    const evDec: Decision = { type: "free", action: "event", uid: hand[0]! };
    const rec = buildAiThoughtRecord({
      db,
      state: st,
      perspectivePlayer: aiPlayer,
      decision: passDec,
      engine: "strong",
      report: makeMockReport(st, aiPlayer, [
        makeMockEstimate(st, passDec, 0.42, 120),
        makeMockEstimate(st, evDec, 0.46, 80),
      ]),
    });
    expect(rec.dialogue.spoiler).toContain("42% vs ");
    expect(rec.dialogue.spoiler).not.toContain("42% ＞ 46%");
  });
});
