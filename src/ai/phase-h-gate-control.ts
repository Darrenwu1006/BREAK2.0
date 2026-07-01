import { applyDecision, createGame, effParam } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { decisionLabel, enumerateCandidates } from "./coach";
import { heuristicAiDecision } from "./heuristic";
import { createIsmctsReport, rootDecisionPressureScore } from "./ismcts";
import type { ValueModel } from "./rollout-value";

export interface PhaseHGatePolicyResult {
  policy: "heuristic-v2-burst" | "is-mcts" | "is-mcts-root-pressure";
  bestLabel: string;
  bestDecision: Decision;
  accept: boolean | null;
  resultingAttackPoint: number | null;
  completedIterations: number | null;
  timedOut: boolean | null;
  recommendations: Array<{ label: string; accept: boolean | null; winRate: number; visits: number; pressureScore: number }>;
}

export interface PhaseHGateControlReport {
  scenario: "free-attack-gate";
  description: string;
  candidateLabels: string[];
  beforeAttackPoint: number;
  acceptAttackPoint: number;
  declineAttackPoint: number;
  results: PhaseHGatePolicyResult[];
}

const BOKUTO_FREE_ATTACK = "HV-P01-043";
const FUKURODANI_RECEIVE = "HV-P01-050";
const FUKURODANI_TOSS = "HV-P01-046";
const FILLER = "HV-D01-006";

function deckWith(...ids: string[]): string[] {
  return [...ids, ...Array(40 - ids.length).fill(FILLER)];
}

function moveCardToArea(state: GameState, p: PlayerId, cardId: string, area: "receive" | "toss" | "attack"): number {
  const ps = state.players[p];
  const zones = [ps.hand, ps.deck, ps.setArea, ps.drop, ps.eventArea, ps.serve, ps.receive, ps.toss, ps.attack, ps.blockCenter, ps.blockSides];
  for (const zone of zones) {
    const index = zone.findIndex((uid) => state.cards[uid] === cardId);
    if (index < 0) continue;
    const uid = zone.splice(index, 1)[0]!;
    ps[area].push(uid);
    return uid;
  }
  throw new Error(`找不到情境卡 ${cardId}`);
}

export function createFreeAttackGateState(db: CardDb, seed = 940): GameState {
  let state = createGame(db, {
    seed,
    decks: [
      deckWith(BOKUTO_FREE_ATTACK, FUKURODANI_RECEIVE, FUKURODANI_TOSS),
      deckWith(BOKUTO_FREE_ATTACK, FUKURODANI_RECEIVE, FUKURODANI_TOSS),
    ],
    skipDeckValidation: true,
  });
  state = applyDecision(db, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });

  moveCardToArea(state, 0, FUKURODANI_RECEIVE, "receive");
  moveCardToArea(state, 0, FUKURODANI_TOSS, "toss");
  const source = moveCardToArea(state, 0, BOKUTO_FREE_ATTACK, "attack");
  state.players[0].attack.unshift(FILLER_UID_GUTS(state, 0));
  state.phase = "attack";
  state.turnPlayer = 0;
  state.op = null;
  state.dp = null;
  state.effectCtx = {
    player: 0,
    source,
    frames: [],
    lastTarget: null,
    triggerUid: null,
    turn1: false,
    anyExecuted: false,
    awaiting: {
      kind: "confirm",
      what: "gate",
      costs: [],
      then: [{ op: "addParam", target: "self", param: "attack", amount: 5 }],
      prompt: "Phase H Gate Control：要使用木兎攻擊 +5 嗎？",
    },
    desc: "木兎 光太郎 的登場技能",
  };
  state.pendingDecision = {
    player: 0,
    type: "effect-confirm",
    prompt: "Phase H Gate Control：要使用木兎攻擊 +5 嗎？",
  };
  return state;
}

function FILLER_UID_GUTS(state: GameState, p: PlayerId): number {
  const ps = state.players[p];
  const uid = ps.deck.find((candidate) => state.cards[candidate] === FILLER);
  if (uid === undefined) throw new Error(`找不到 Guts filler ${FILLER}`);
  ps.deck.splice(ps.deck.indexOf(uid), 1);
  return uid;
}

function knownDecksFromState(state: GameState): [string[], string[]] {
  return [0, 1].map((p) => Object.values(state.cards).filter(Boolean)) as [string[], string[]];
}

function resultingAttackPoint(db: CardDb, state: GameState, decision: Decision): number | null {
  if (decision.type !== "effect-confirm") return null;
  const next = applyDecision(db, state, decision);
  const source = state.effectCtx?.source;
  return source === undefined ? null : effParam(db, next, source, "attack") ?? null;
}

function acceptOf(decision: Decision): boolean | null {
  return decision.type === "effect-confirm" ? decision.accept : null;
}

function recommendationsFor(db: CardDb, state: GameState, report: ReturnType<typeof createIsmctsReport>): PhaseHGatePolicyResult["recommendations"] {
  return report.recommendations.map((item) => ({
    label: item.label,
    accept: acceptOf(item.decision),
    winRate: item.winRate,
    visits: item.sampleCount,
    pressureScore: rootDecisionPressureScore(db, state, item.decision, 0),
  }));
}

export function runPhaseHFreeAttackGateControl(
  db: CardDb,
  options: { seed?: number; iterations?: number; leafRolloutHorizon?: number; rootPressureTieBreakDelta?: number; valueModel?: ValueModel } = {},
): PhaseHGateControlReport {
  const seed = options.seed ?? 940;
  const iterations = options.iterations ?? 120;
  const leafRolloutHorizon = options.leafRolloutHorizon ?? 40;
  const rootPressureTieBreakDelta = options.rootPressureTieBreakDelta ?? 0.03;
  const valueModel = options.valueModel;
  const state = createFreeAttackGateState(db, seed);
  const fallback = heuristicAiDecision(db, state, "heuristic-v2-burst");
  const candidates = enumerateCandidates(db, state, 4, fallback).filter((decision) => decision.type === "effect-confirm");
  const knownDecks = knownDecksFromState(state);
  const source = state.effectCtx!.source;

  const base = createIsmctsReport(db, state, {
    perspectivePlayer: 0,
    knownDecks,
    iterations,
    candidateLimit: 4,
    leafRolloutHorizon,
    rolloutPolicy: "heuristic-v2-burst",
    seed: seed + 101,
    valueModel,
  });
  const rootPressure = createIsmctsReport(db, state, {
    perspectivePlayer: 0,
    knownDecks,
    iterations,
    candidateLimit: 4,
    leafRolloutHorizon,
    rolloutPolicy: "heuristic-v2-burst",
    rootPressureTieBreakDelta,
    seed: seed + 101,
    valueModel,
  });

  const results: PhaseHGatePolicyResult[] = [
    {
      policy: "heuristic-v2-burst",
      bestLabel: decisionLabel(db, state, fallback),
      bestDecision: fallback,
      accept: acceptOf(fallback),
      resultingAttackPoint: resultingAttackPoint(db, state, fallback),
      completedIterations: null,
      timedOut: null,
      recommendations: [],
    },
    {
      policy: "is-mcts",
      bestLabel: base.bestAction.label,
      bestDecision: base.bestAction.decision,
      accept: acceptOf(base.bestAction.decision),
      resultingAttackPoint: resultingAttackPoint(db, state, base.bestAction.decision),
      completedIterations: base.completedSamples,
      timedOut: base.timedOut,
      recommendations: recommendationsFor(db, state, base),
    },
    {
      policy: "is-mcts-root-pressure",
      bestLabel: rootPressure.bestAction.label,
      bestDecision: rootPressure.bestAction.decision,
      accept: acceptOf(rootPressure.bestAction.decision),
      resultingAttackPoint: resultingAttackPoint(db, state, rootPressure.bestAction.decision),
      completedIterations: rootPressure.completedSamples,
      timedOut: rootPressure.timedOut,
      recommendations: recommendationsFor(db, state, rootPressure),
    },
  ];

  return {
    scenario: "free-attack-gate",
    description: "HV-P01-043 木兎已站攻擊區，gate 為零成本 attack +5；accept 應把攻擊點數由 0 推到 5。",
    candidateLabels: candidates.map((decision) => decisionLabel(db, state, decision)),
    beforeAttackPoint: effParam(db, state, source, "attack") ?? 0,
    acceptAttackPoint: resultingAttackPoint(db, state, { type: "effect-confirm", accept: true }) ?? 0,
    declineAttackPoint: resultingAttackPoint(db, state, { type: "effect-confirm", accept: false }) ?? 0,
    results,
  };
}
