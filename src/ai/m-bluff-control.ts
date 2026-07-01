import { applyDecision, createGame } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { createIsmctsReport } from "./ismcts";
import { createMoIsmctsReport } from "./mo-ismcts";
import { decisionLabel, enumerateCandidates } from "./coach";
import { heuristicAiDecision } from "./heuristic";
import { observableProjection } from "./mo-ismcts";

export interface MBluffPolicyResult {
  policy: "is-mcts" | "mo-ismcts";
  bestLabel: string;
  bestDecision: Decision;
  privateDiscardCost: number | null;
  opponentBucketSize: number;
  opponentBucketLabels: string[];
  completedIterations: number;
  timedOut: boolean;
}

export interface MBluffControlReport {
  scenario: "drop-hand-private-choice";
  description: string;
  candidateLabels: string[];
  opponentBuckets: Array<{ key: string; labels: string[] }>;
  results: MBluffPolicyResult[];
}

const STRONG_CARD = "HV-P02-064"; // 木兎 光太郎：high public stats, costly to discard.
const MID_CARD = "HV-D01-010"; // 東峰 旭：medium attacker/receiver.
const LOW_CARD = "HV-D01-006"; // 田中 龍之介：baseline filler.
const FILLER = LOW_CARD;

function deckWith(...ids: string[]): string[] {
  return [...ids, ...Array(40 - ids.length).fill(FILLER)];
}

function cardLabel(db: CardDb, cardId: string): string {
  const card = db.get(cardId);
  return card?.nameZh || card?.nameJa || cardId;
}

function moveCardToHand(state: GameState, p: PlayerId, cardId: string, used: Set<number>): number {
  const ps = state.players[p];
  const zones = [ps.hand, ps.deck, ps.setArea, ps.drop, ps.eventArea, ps.serve, ps.receive, ps.toss, ps.attack, ps.blockCenter, ps.blockSides];
  for (const zone of zones) {
    const index = zone.findIndex((uid) => state.cards[uid] === cardId && !used.has(uid));
    if (index < 0) continue;
    const uid = zone.splice(index, 1)[0]!;
    ps.hand.push(uid);
    used.add(uid);
    return uid;
  }
  throw new Error(`找不到情境卡 ${cardId}`);
}

function keepOnlyHand(state: GameState, p: PlayerId, keep: readonly number[]): void {
  const ps = state.players[p];
  const keepSet = new Set(keep);
  for (let i = ps.hand.length - 1; i >= 0; i--) {
    const uid = ps.hand[i]!;
    if (keepSet.has(uid)) continue;
    ps.deck.push(ps.hand.splice(i, 1)[0]!);
  }
}

export function createDropHandPrivateChoiceState(db: CardDb, seed = 930): GameState {
  let state = createGame(db, {
    seed,
    decks: [
      deckWith(STRONG_CARD, MID_CARD, LOW_CARD, STRONG_CARD, MID_CARD),
      deckWith(STRONG_CARD, MID_CARD, LOW_CARD, STRONG_CARD, MID_CARD),
    ],
    skipDeckValidation: true,
  });
  state = applyDecision(db, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });

  const used = new Set<number>();
  const strong = moveCardToHand(state, 0, STRONG_CARD, used);
  const mid = moveCardToHand(state, 0, MID_CARD, used);
  const low = moveCardToHand(state, 0, LOW_CARD, used);
  keepOnlyHand(state, 0, [strong, mid, low]);

  state.effectCtx = {
    player: 0,
    source: strong,
    frames: [],
    lastTarget: null,
    triggerUid: null,
    turn1: false,
    anyExecuted: false,
    awaiting: {
      kind: "cards",
      purpose: "dropHand",
      candidates: [strong, mid, low],
      min: 1,
      max: 1,
      prompt: "M-Bluff-Control：私有手牌棄 1 張",
    },
    desc: "M-Bluff-Control dropHand",
  };
  state.pendingDecision = {
    player: 0,
    type: "effect-cards",
    candidates: [strong, mid, low],
    min: 1,
    max: 1,
    prompt: "M-Bluff-Control：私有手牌棄 1 張",
  };
  return state;
}

export function privateDiscardCost(db: CardDb, state: GameState, decision: Decision): number | null {
  if (decision.type !== "effect-cards" || decision.uids.length !== 1) return null;
  const card = db.get(state.cards[decision.uids[0]!] ?? "");
  if (!card?.params) return 0;
  return Math.max(
    card.params.serve ?? 0,
    card.params.block ?? 0,
    card.params.receive ?? 0,
    card.params.toss ?? 0,
    card.params.attack ?? 0,
  );
}

function candidateBuckets(db: CardDb, state: GameState): Array<{ key: string; labels: string[]; decisions: Decision[] }> {
  const actor = state.pendingDecision!.player as PlayerId;
  const viewer = (actor === 0 ? 1 : 0) as PlayerId;
  const fallback = heuristicAiDecision(db, state, "heuristic-v2");
  const candidates = enumerateCandidates(db, state, 8, fallback).filter((decision) => decision.type === "effect-cards");
  const byKey = new Map<string, { key: string; labels: string[]; decisions: Decision[] }>();
  for (const decision of candidates) {
    const key = observableProjection(decision, { actor, viewer, before: state });
    const bucket = byKey.get(key) ?? { key, labels: [], decisions: [] };
    bucket.labels.push(decisionLabel(db, state, decision));
    bucket.decisions.push(decision);
    byKey.set(key, bucket);
  }
  return [...byKey.values()];
}

function policyBucketSize(db: CardDb, state: GameState, decision: Decision, buckets: ReturnType<typeof candidateBuckets>): { size: number; labels: string[] } {
  const actor = state.pendingDecision!.player as PlayerId;
  const viewer = (actor === 0 ? 1 : 0) as PlayerId;
  const key = observableProjection(decision, { actor, viewer, before: state });
  const bucket = buckets.find((item) => item.key === key);
  return { size: bucket?.decisions.length ?? 0, labels: bucket?.labels ?? [] };
}

export function runMBluffDropHandControl(db: CardDb, options: { seed?: number; iterations?: number } = {}): MBluffControlReport {
  const seed = options.seed ?? 930;
  const iterations = options.iterations ?? 80;
  const state = createDropHandPrivateChoiceState(db, seed);
  const buckets = candidateBuckets(db, state);
  const candidateLabels = buckets.flatMap((bucket) => bucket.labels);
  const knownDecks: [string[], string[]] = [0, 1].map((p) => Object.values(state.cards).filter(Boolean)) as [string[], string[]];

  const so = createIsmctsReport(db, state, {
    perspectivePlayer: 0,
    knownDecks,
    iterations,
    candidateLimit: 8,
    leafRolloutHorizon: 0,
    seed: seed + 101,
  });
  const mo = createMoIsmctsReport(db, state, {
    perspectivePlayer: 0,
    knownDecks,
    iterations,
    candidateLimit: 8,
    leafRolloutHorizon: 0,
    seed: seed + 101,
  });

  const results = [
    { policy: "is-mcts" as const, report: so },
    { policy: "mo-ismcts" as const, report: mo },
  ].map(({ policy, report }) => {
    const bucket = policyBucketSize(db, state, report.bestAction.decision, buckets);
    return {
      policy,
      bestLabel: report.bestAction.label,
      bestDecision: report.bestAction.decision,
      privateDiscardCost: privateDiscardCost(db, state, report.bestAction.decision),
      opponentBucketSize: bucket.size,
      opponentBucketLabels: bucket.labels,
      completedIterations: report.completedSamples,
      timedOut: report.timedOut,
    };
  });

  return {
    scenario: "drop-hand-private-choice",
    description:
      `我方要私下棄 1 張手牌（${cardLabel(db, STRONG_CARD)} / ${cardLabel(db, MID_CARD)} / ${cardLabel(db, LOW_CARD)}）。` +
      " 對手可觀察資訊只知道 dropHand 棄 1 張，不知道棄哪張。",
    candidateLabels,
    opponentBuckets: buckets.map(({ key, labels }) => ({ key, labels })),
    results,
  };
}
