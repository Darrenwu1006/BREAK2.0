import { applyDecision, createGame } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { createIsmctsReport } from "./ismcts";
import { createMoIsmctsReport } from "./mo-ismcts";
import { enumerateCandidates } from "./coach";
import { describeDecision } from "../shared/decisionLabels";
import { heuristicAiDecision } from "./heuristic";
import { observableProjection } from "./mo-ismcts";
import { evaluateStateValue } from "./rollout-value";

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

export interface MBluffDropHandControlReport {
  scenario: "drop-hand-private-choice";
  description: string;
  candidateLabels: string[];
  opponentBuckets: Array<{ key: string; labels: string[] }>;
  results: MBluffPolicyResult[];
}

export interface MBluffPairedPolicyResult {
  policy: "is-mcts" | "mo-ismcts";
  strongBestLabel: string;
  weakBestLabel: string;
  strongBestDecision: Decision;
  weakBestDecision: Decision;
  sameChoiceAcrossHiddenBacking: boolean;
  strongCompletedIterations: number;
  weakCompletedIterations: number;
  strongTimedOut: boolean;
  weakTimedOut: boolean;
}

export interface MBluffPublicPostureControlReport {
  scenario: "public-posture-private-backing";
  description: string;
  publicPosture: string;
  hiddenBacking: {
    strongLabel: string;
    weakLabel: string;
  };
  results: MBluffPairedPolicyResult[];
}

export interface MBluffChoiceRatePolicyResult {
  policy: "is-mcts" | "mo-ismcts";
  strongBestLabel: string;
  weakBestLabel: string;
  strongBestDecision: Decision;
  weakBestDecision: Decision;
  strongChoosesPublicStrong: boolean;
  weakChoosesPublicStrong: boolean;
  bluffChoiceLift: number;
  strongCompletedIterations: number;
  weakCompletedIterations: number;
  strongTimedOut: boolean;
  weakTimedOut: boolean;
}

export interface MBluffPublicPostureChoiceReport {
  scenario: "public-posture-choice-rate";
  description: string;
  publicStrongPosture: string;
  publicHonestPosture: string;
  hiddenBacking: {
    strongLabel: string;
    weakLabel: string;
  };
  leafRolloutHorizon: number;
  results: MBluffChoiceRatePolicyResult[];
}

export interface MBluffPostureCandidateScore {
  label: string;
  decision: Decision;
  choosesPublicStrong: boolean;
  value: number;
}

export interface MBluffPostureGroundTruth {
  strongBestLabel: string;
  weakBestLabel: string;
  strongChoosesPublicStrong: boolean | null;
  weakChoosesPublicStrong: boolean | null;
  weakPublicStrongValueLift: number | null;
  strongScores: MBluffPostureCandidateScore[];
  weakScores: MBluffPostureCandidateScore[];
}

export interface MBluffPostureCalibratedPolicyResult extends MBluffChoiceRatePolicyResult {
  strongValueGapToGroundTruth: number | null;
  weakValueGapToGroundTruth: number | null;
  matchesWeakGroundTruthChoice: boolean | null;
}

export interface MBluffPostureCalibratedControlReport {
  scenario: "public-posture-choice-rate-v2";
  description: string;
  publicStrongPosture: string;
  publicHonestPosture: string;
  hiddenBacking: {
    strongLabel: string;
    weakLabel: string;
  };
  leafRolloutHorizon: number;
  calibrationHorizon: number;
  groundTruth: MBluffPostureGroundTruth;
  incentiveCompatible: boolean;
  results: MBluffPostureCalibratedPolicyResult[];
}

export interface MBluffPostureCalibratedSweepPolicySummary {
  policy: "is-mcts" | "mo-ismcts";
  seeds: number;
  incentiveCompatibleRate: number;
  weakGroundTruthBluffRate: number | null;
  weakPublicStrongRate: number;
  weakDirectionMatchRate: number | null;
  averageWeakPublicStrongValueLift: number | null;
  averageStrongValueGapToGroundTruth: number | null;
  averageWeakValueGapToGroundTruth: number | null;
  averageStrongCompletedIterations: number;
  averageWeakCompletedIterations: number;
  timeoutRate: number;
}

export interface MBluffPostureCalibratedSweepReport {
  scenario: "public-posture-choice-rate-v2-sweep";
  description: string;
  seedStart: number;
  seeds: number;
  iterations: number;
  leafRolloutHorizon: number;
  calibrationHorizon: number;
  summaries: MBluffPostureCalibratedSweepPolicySummary[];
  reports: MBluffPostureCalibratedControlReport[];
}

export interface MBluffResourceTempoPolicyResult {
  policy: "is-mcts" | "mo-ismcts";
  richBestLabel: string;
  poorBestLabel: string;
  richBestDecision: Decision;
  poorBestDecision: Decision;
  richAttackPoint: number | null;
  poorAttackPoint: number | null;
  attackPointDelta: number | null;
  richChoosesMaxAttack: boolean;
  poorChoosesMaxAttack: boolean;
  richNoDeploy: boolean;
  poorNoDeploy: boolean;
  conservativeLiftWhenRich: number;
  richCompletedIterations: number;
  poorCompletedIterations: number;
  richTimedOut: boolean;
  poorTimedOut: boolean;
}

export interface MBluffResourceTempoSweepPolicySummary {
  policy: "is-mcts" | "mo-ismcts";
  seeds: number;
  averageAttackPointDelta: number | null;
  positiveDeltaRate: number | null;
  averageRichAttackPoint: number | null;
  averagePoorAttackPoint: number | null;
  averageRichCompletedIterations: number;
  averagePoorCompletedIterations: number;
  timeoutRate: number;
}

export interface MBluffResourceTempoSweepReport {
  scenario: "resource-tempo-defense-pressure-sweep";
  description: string;
  seedStart: number;
  seeds: number;
  iterations: number;
  leafRolloutHorizon: number;
  summaries: MBluffResourceTempoSweepPolicySummary[];
  reports: MBluffResourceTempoControlReport[];
}

export interface MBluffResourceTempoControlReport {
  scenario: "resource-tempo-defense-pressure";
  description: string;
  publicAttackChoices: string[];
  opponentPublicResources: {
    richHandCount: number;
    poorHandCount: number;
  };
  leafRolloutHorizon: number;
  results: MBluffResourceTempoPolicyResult[];
}

export interface MBluffResourceTempoCandidateScore {
  label: string;
  decision: Decision;
  attackPoint: number | null;
  value: number;
}

export interface MBluffResourceTempoGroundTruth {
  richBestLabel: string;
  poorBestLabel: string;
  richBestAttackPoint: number | null;
  poorBestAttackPoint: number | null;
  attackPointDelta: number | null;
  richScores: MBluffResourceTempoCandidateScore[];
  poorScores: MBluffResourceTempoCandidateScore[];
}

export interface MBluffResourceTempoCalibratedPolicyResult extends MBluffResourceTempoPolicyResult {
  richValueGapToGroundTruth: number | null;
  poorValueGapToGroundTruth: number | null;
  matchesGroundTruthDirection: boolean | null;
}

export interface MBluffResourceTempoCalibratedControlReport {
  scenario: "resource-tempo-defense-pressure-v2";
  description: string;
  publicAttackChoices: string[];
  opponentPublicResources: {
    richHandCount: number;
    poorHandCount: number;
  };
  leafRolloutHorizon: number;
  calibrationHorizon: number;
  groundTruth: MBluffResourceTempoGroundTruth;
  incentiveCompatible: boolean;
  results: MBluffResourceTempoCalibratedPolicyResult[];
}

export interface MBluffResourceTempoCalibratedSweepPolicySummary {
  policy: "is-mcts" | "mo-ismcts";
  seeds: number;
  incentiveCompatibleRate: number;
  averageGroundTruthAttackPointDelta: number | null;
  averageAttackPointDelta: number | null;
  directionMatchRate: number | null;
  positiveDeltaRate: number | null;
  averageRichValueGapToGroundTruth: number | null;
  averagePoorValueGapToGroundTruth: number | null;
  averageRichCompletedIterations: number;
  averagePoorCompletedIterations: number;
  timeoutRate: number;
}

export interface MBluffResourceTempoCalibratedSweepReport {
  scenario: "resource-tempo-defense-pressure-v2-sweep";
  description: string;
  seedStart: number;
  seeds: number;
  iterations: number;
  leafRolloutHorizon: number;
  calibrationHorizon: number;
  summaries: MBluffResourceTempoCalibratedSweepPolicySummary[];
  reports: MBluffResourceTempoCalibratedControlReport[];
}

export type MBluffControlReport =
  | MBluffDropHandControlReport
  | MBluffPublicPostureControlReport
  | MBluffPublicPostureChoiceReport
  | MBluffPostureCalibratedControlReport
  | MBluffResourceTempoControlReport
  | MBluffResourceTempoCalibratedControlReport;

const STRONG_CARD = "HV-P02-064"; // 木兎 光太郎：high public stats, costly to discard.
const MID_CARD = "HV-D01-010"; // 東峰 旭：medium attacker/receiver.
const LOW_CARD = "HV-D01-006"; // 田中 龍之介：baseline filler.
const FILLER = LOW_CARD;
const PUBLIC_TOSS = "HV-P03-022"; // 宮 侑：公開托球姿態。
const HONEST_TOSS = "HV-D01-002"; // 影山 飛雄：較低公開托球姿態。
const PUBLIC_ATTACK = MID_CARD; // 東峰 旭：公開攻擊姿態，搭 PUBLIC_TOSS 做出 OP5。
const WEAK_BACKING = "HV-P03-020"; // 影山 飛雄：弱 hidden backing。
const OPP_BLOCK = "HV-P03-030"; // 千鹿谷 栄吉：對手可用攔網手。
const OPP_RECEIVE = STRONG_CARD; // 木兎 光太郎：對手可用接球手。
const OPP_EXTRA_RECEIVE = "HV-P01-011"; // 西谷 夕：高接球資源。
const OPP_EXTRA_ATTACK = "HV-D02-006"; // 山本 猛虎：對手手牌量 filler。

function deckWith(...ids: string[]): string[] {
  return [...ids, ...Array(40 - ids.length).fill(FILLER)];
}

function cardLabel(db: CardDb, cardId: string): string {
  const card = db.get(cardId);
  return card?.nameZh || card?.nameJa || cardId;
}

function moveCardToHand(state: GameState, p: PlayerId, cardId: string, used: Set<number>): number {
  return moveCardToZone(state, p, cardId, "hand", used);
}

type MBluffZone = "hand" | "deck" | "setArea" | "drop" | "eventArea" | "serve" | "receive" | "toss" | "attack" | "blockCenter" | "blockSides";

function moveCardToZone(state: GameState, p: PlayerId, cardId: string, destination: MBluffZone, used: Set<number>): number {
  const ps = state.players[p];
  const zones = [ps.hand, ps.deck, ps.setArea, ps.drop, ps.eventArea, ps.serve, ps.receive, ps.toss, ps.attack, ps.blockCenter, ps.blockSides];
  for (const zone of zones) {
    const index = zone.findIndex((uid) => state.cards[uid] === cardId && !used.has(uid));
    if (index < 0) continue;
    const uid = zone.splice(index, 1)[0]!;
    ps[destination].push(uid);
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

export function createPublicPosturePrivateBackingStates(db: CardDb, seed = 940): {
  strong: GameState;
  weak: GameState;
  knownDecks: [string[], string[]];
  strongBackingUid: number;
} {
  const knownDecks: [string[], string[]] = [
    deckWith(PUBLIC_TOSS, PUBLIC_ATTACK, STRONG_CARD, LOW_CARD, MID_CARD),
    deckWith(OPP_BLOCK, OPP_RECEIVE, STRONG_CARD, LOW_CARD, MID_CARD),
  ];
  let state = createGame(db, {
    seed,
    decks: knownDecks,
    skipDeckValidation: true,
  });
  state = applyDecision(db, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });

  const used = new Set<number>();
  moveCardToZone(state, 0, PUBLIC_TOSS, "toss", used);
  moveCardToZone(state, 0, PUBLIC_ATTACK, "attack", used);
  const backing = moveCardToHand(state, 0, STRONG_CARD, used);
  const block = moveCardToHand(state, 1, OPP_BLOCK, used);
  const receive = moveCardToHand(state, 1, OPP_RECEIVE, used);
  keepOnlyHand(state, 0, [backing]);
  keepOnlyHand(state, 1, [block, receive]);

  state.turnPlayer = 1;
  state.phase = "start";
  state.sub = 1;
  state.op = { owner: 0, value: 5, source: "attack" };
  state.dp = null;
  state.defenseChoice = null;
  state.pendingDecision = { player: 1, type: "defense-choice", prompt: "M-Bluff-Control：面對公開 OP5 攻擊線" };
  state.effectCtx = null;
  state.pendingQueue = [];

  const strong = structuredClone(state) as GameState;
  const weak = structuredClone(state) as GameState;
  weak.cards[backing] = LOW_CARD;
  return { strong, weak, knownDecks, strongBackingUid: backing };
}

export function createPublicPostureChoiceStates(db: CardDb, seed = 950): {
  strong: GameState;
  weak: GameState;
  knownDecks: [string[], string[]];
  publicStrongUid: number;
  publicHonestUid: number;
} {
  const knownDecks: [string[], string[]] = [
    deckWith(PUBLIC_TOSS, HONEST_TOSS, STRONG_CARD, WEAK_BACKING, LOW_CARD),
    deckWith(OPP_BLOCK, OPP_RECEIVE, STRONG_CARD, LOW_CARD, MID_CARD),
  ];
  let state = createGame(db, {
    seed,
    decks: knownDecks,
    skipDeckValidation: true,
  });
  state = applyDecision(db, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });

  const used = new Set<number>();
  const publicStrong = moveCardToHand(state, 0, PUBLIC_TOSS, used);
  const publicHonest = moveCardToHand(state, 0, HONEST_TOSS, used);
  const strongBacking = moveCardToHand(state, 0, STRONG_CARD, used);
  const weakBacking = moveCardToZone(state, 0, WEAK_BACKING, "deck", used);
  keepOnlyHand(state, 0, [publicStrong, publicHonest, strongBacking]);

  state.turnPlayer = 0;
  state.phase = "toss";
  state.sub = 0;
  state.op = null;
  state.dp = null;
  state.defenseChoice = null;
  state.pendingDecision = { player: 0, type: "deploy-toss", prompt: "M-Bluff-Control：選擇公開托球姿態" };
  state.effectCtx = null;
  state.pendingQueue = [];

  const strong = structuredClone(state) as GameState;
  const weak = structuredClone(state) as GameState;
  weak.cards[strongBacking] = WEAK_BACKING;
  weak.cards[weakBacking] = STRONG_CARD;
  return { strong, weak, knownDecks, publicStrongUid: publicStrong, publicHonestUid: publicHonest };
}

export function createResourceTempoDefensePressureStates(db: CardDb, seed = 960): {
  rich: GameState;
  poor: GameState;
  knownDecks: [string[], string[]];
  attackUids: number[];
} {
  const knownDecks: [string[], string[]] = [
    deckWith(PUBLIC_TOSS, STRONG_CARD, MID_CARD, LOW_CARD, WEAK_BACKING),
    deckWith(OPP_RECEIVE, OPP_BLOCK, OPP_EXTRA_RECEIVE, OPP_EXTRA_ATTACK, MID_CARD, LOW_CARD, WEAK_BACKING),
  ];
  let state = createGame(db, {
    seed,
    decks: knownDecks,
    skipDeckValidation: true,
  });
  state = applyDecision(db, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(db, state, { type: "mulligan", returnUids: [] });

  const used = new Set<number>();
  moveCardToZone(state, 0, PUBLIC_TOSS, "toss", used);
  const strongAttack = moveCardToHand(state, 0, STRONG_CARD, used);
  const midAttack = moveCardToHand(state, 0, MID_CARD, used);
  const lowAttack = moveCardToHand(state, 0, LOW_CARD, used);
  const weakAttack = moveCardToHand(state, 0, WEAK_BACKING, used);
  const attackUids = [strongAttack, midAttack, lowAttack, weakAttack];
  keepOnlyHand(state, 0, attackUids);

  const richHand = [
    moveCardToHand(state, 1, OPP_RECEIVE, used),
    moveCardToHand(state, 1, OPP_BLOCK, used),
    moveCardToHand(state, 1, OPP_EXTRA_RECEIVE, used),
    moveCardToHand(state, 1, OPP_EXTRA_ATTACK, used),
    moveCardToHand(state, 1, MID_CARD, used),
    moveCardToHand(state, 1, LOW_CARD, used),
  ];
  keepOnlyHand(state, 1, richHand);

  state.turnPlayer = 0;
  state.phase = "attack";
  state.sub = 0;
  state.op = null;
  state.dp = null;
  state.defenseChoice = null;
  state.pendingDecision = { player: 0, type: "deploy-attack", prompt: "M-Tempo-Control：面對對手公開防守資源，選擇攻擊姿態" };
  state.effectCtx = null;
  state.pendingQueue = [];

  const rich = structuredClone(state) as GameState;
  const poor = structuredClone(state) as GameState;
  const poorKeep = new Set([poor.players[1].hand[0]]);
  for (let i = poor.players[1].hand.length - 1; i >= 0; i--) {
    const uid = poor.players[1].hand[i]!;
    if (poorKeep.has(uid)) continue;
    poor.players[1].deck.push(poor.players[1].hand.splice(i, 1)[0]!);
  }
  return { rich, poor, knownDecks, attackUids };
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
    bucket.labels.push(describeDecision(db, state, decision));
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

export function runMBluffDropHandControl(db: CardDb, options: { seed?: number; iterations?: number } = {}): MBluffDropHandControlReport {
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

function sameDecision(a: Decision, b: Decision): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function runMBluffPublicPostureControl(db: CardDb, options: { seed?: number; iterations?: number } = {}): MBluffPublicPostureControlReport {
  const seed = options.seed ?? 940;
  const iterations = options.iterations ?? 80;
  const { strong, weak, knownDecks } = createPublicPosturePrivateBackingStates(db, seed);
  const run = (policy: "is-mcts" | "mo-ismcts", state: GameState, seedOffset: number) =>
    policy === "is-mcts"
      ? createIsmctsReport(db, state, {
          perspectivePlayer: 1,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon: 0,
          rootPressureTieBreakDelta: 0,
          rootPairQualityTieBreak: false,
          seed: seed + seedOffset,
        })
      : createMoIsmctsReport(db, state, {
          perspectivePlayer: 1,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon: 0,
          seed: seed + seedOffset,
        });

  const results: MBluffPairedPolicyResult[] = (["is-mcts", "mo-ismcts"] as const).map((policy) => {
    const strongReport = run(policy, strong, 201);
    const weakReport = run(policy, weak, 201);
    return {
      policy,
      strongBestLabel: strongReport.bestAction.label,
      weakBestLabel: weakReport.bestAction.label,
      strongBestDecision: strongReport.bestAction.decision,
      weakBestDecision: weakReport.bestAction.decision,
      sameChoiceAcrossHiddenBacking: sameDecision(strongReport.bestAction.decision, weakReport.bestAction.decision),
      strongCompletedIterations: strongReport.completedSamples,
      weakCompletedIterations: weakReport.completedSamples,
      strongTimedOut: strongReport.timedOut,
      weakTimedOut: weakReport.timedOut,
    };
  });

  return {
    scenario: "public-posture-private-backing",
    description:
      "P0 公開場面呈現 OP5 攻擊線，P1 正要選擇接球或攔網；兩個 paired states 只差在 P0 隱藏手牌 backing 是強牌或弱牌。P1 不應因這張隱藏 backing 不同而改變策略。",
    publicPosture: `${cardLabel(db, PUBLIC_TOSS)} + ${cardLabel(db, PUBLIC_ATTACK)}，公開 OP=5`,
    hiddenBacking: {
      strongLabel: cardLabel(db, STRONG_CARD),
      weakLabel: cardLabel(db, LOW_CARD),
    },
    results,
  };
}

function isDeployUid(decision: Decision, uid: number): boolean {
  return (
    (decision.type === "deploy-serve" ||
      decision.type === "deploy-receive" ||
      decision.type === "deploy-toss" ||
      decision.type === "deploy-attack") &&
    decision.uid === uid
  );
}

function attackPointForDecision(db: CardDb, state: GameState, decision: Decision): number | null {
  if (decision.type !== "deploy-attack" || decision.uid === null) return null;
  const card = db.get(state.cards[decision.uid] ?? "");
  const value = card?.params?.attack;
  return typeof value === "number" ? value : null;
}

function maxAttackPoint(db: CardDb, state: GameState, attackUids: readonly number[]): number {
  return Math.max(
    ...attackUids.map((uid) => {
      const card = db.get(state.cards[uid] ?? "");
      const value = card?.params?.attack;
      return typeof value === "number" ? value : 0;
    }),
  );
}

function nullableDelta(poor: number | null, rich: number | null): number | null {
  return poor === null || rich === null ? null : poor - rich;
}

function avgNumber(items: readonly number[]): number {
  return items.length === 0 ? 0 : items.reduce((sum, item) => sum + item, 0) / items.length;
}

function avgNullable(items: readonly (number | null)[]): number | null {
  const numbers = items.filter((item): item is number => item !== null);
  return numbers.length === 0 ? null : avgNumber(numbers);
}

function rolloutWithHeuristic(db: CardDb, state: GameState, horizon: number): GameState {
  let cur = state;
  for (let step = 0; step < horizon; step++) {
    if (cur.phase === "gameOver" || !cur.pendingDecision) return cur;
    try {
      cur = applyDecision(db, cur, heuristicAiDecision(db, cur, "heuristic-v2"));
    } catch {
      return cur;
    }
  }
  return cur;
}

function scoreDecisionAfterRollout(db: CardDb, state: GameState, decision: Decision, perspective: PlayerId, horizon: number): number {
  try {
    const afterDecision = applyDecision(db, state, decision);
    if (afterDecision.phase === "gameOver") return afterDecision.winner === perspective ? 1 : 0;
    const leaf = rolloutWithHeuristic(db, afterDecision, horizon);
    if (leaf.phase === "gameOver") return leaf.winner === perspective ? 1 : 0;
    return evaluateStateValue(leaf, perspective, undefined, db);
  } catch {
    return -Infinity;
  }
}

function attackCandidateScores(db: CardDb, state: GameState, perspective: PlayerId, horizon: number): MBluffResourceTempoCandidateScore[] {
  const fallback = heuristicAiDecision(db, state, "heuristic-v2");
  return enumerateCandidates(db, state, 8, fallback)
    .filter((decision) => decision.type === "deploy-attack")
    .map((decision) => ({
      label: describeDecision(db, state, decision),
      decision,
      attackPoint: attackPointForDecision(db, state, decision),
      value: scoreDecisionAfterRollout(db, state, decision, perspective, horizon),
    }))
    .filter((score) => Number.isFinite(score.value))
    .sort((a, b) => b.value - a.value || (b.attackPoint ?? -1) - (a.attackPoint ?? -1));
}

function postureCandidateScores(
  db: CardDb,
  state: GameState,
  publicStrongUid: number,
  perspective: PlayerId,
  horizon: number,
): MBluffPostureCandidateScore[] {
  const fallback = heuristicAiDecision(db, state, "heuristic-v2");
  return enumerateCandidates(db, state, 8, fallback)
    .filter((decision) => decision.type === "deploy-toss")
    .map((decision) => ({
      label: describeDecision(db, state, decision),
      decision,
      choosesPublicStrong: isDeployUid(decision, publicStrongUid),
      value: scoreDecisionAfterRollout(db, state, decision, perspective, horizon),
    }))
    .filter((score) => Number.isFinite(score.value))
    .sort((a, b) => b.value - a.value || Number(b.choosesPublicStrong) - Number(a.choosesPublicStrong));
}

function bestScore(scores: readonly MBluffResourceTempoCandidateScore[]): MBluffResourceTempoCandidateScore | null {
  return scores.length > 0 ? scores[0]! : null;
}

function bestPostureScore(scores: readonly MBluffPostureCandidateScore[]): MBluffPostureCandidateScore | null {
  return scores.length > 0 ? scores[0]! : null;
}

function scoreForDecision(
  scores: readonly MBluffResourceTempoCandidateScore[],
  db: CardDb,
  state: GameState,
  decision: Decision,
  perspective: PlayerId,
  horizon: number,
): MBluffResourceTempoCandidateScore {
  const found = scores.find((score) => sameDecision(score.decision, decision));
  if (found) return found;
  return {
    label: describeDecision(db, state, decision),
    decision,
    attackPoint: attackPointForDecision(db, state, decision),
    value: scoreDecisionAfterRollout(db, state, decision, perspective, horizon),
  };
}

function nullableSign(value: number | null): number | null {
  if (value === null) return null;
  return value === 0 ? 0 : value > 0 ? 1 : -1;
}

function postureScoreForDecision(
  scores: readonly MBluffPostureCandidateScore[],
  db: CardDb,
  state: GameState,
  decision: Decision,
  publicStrongUid: number,
  perspective: PlayerId,
  horizon: number,
): MBluffPostureCandidateScore {
  const found = scores.find((score) => sameDecision(score.decision, decision));
  if (found) return found;
  return {
    label: describeDecision(db, state, decision),
    decision,
    choosesPublicStrong: isDeployUid(decision, publicStrongUid),
    value: scoreDecisionAfterRollout(db, state, decision, perspective, horizon),
  };
}

function publicStrongValueLift(scores: readonly MBluffPostureCandidateScore[]): number | null {
  const publicStrong = scores.find((score) => score.choosesPublicStrong);
  const alternatives = scores.filter((score) => !score.choosesPublicStrong);
  if (!publicStrong || alternatives.length === 0) return null;
  return publicStrong.value - Math.max(...alternatives.map((score) => score.value));
}

export function runMBluffPublicPostureChoiceControl(
  db: CardDb,
  options: { seed?: number; iterations?: number; leafRolloutHorizon?: number } = {},
): MBluffPublicPostureChoiceReport {
  const seed = options.seed ?? 950;
  const iterations = options.iterations ?? 80;
  const leafRolloutHorizon = options.leafRolloutHorizon ?? 4;
  const { strong, weak, knownDecks, publicStrongUid, publicHonestUid } = createPublicPostureChoiceStates(db, seed);
  const run = (policy: "is-mcts" | "mo-ismcts", state: GameState, seedOffset: number) =>
    policy === "is-mcts"
      ? createIsmctsReport(db, state, {
          perspectivePlayer: 0,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon,
          rootPressureTieBreakDelta: 0,
          rootPairQualityTieBreak: false,
          seed: seed + seedOffset,
        })
      : createMoIsmctsReport(db, state, {
          perspectivePlayer: 0,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon,
          seed: seed + seedOffset,
        });

  const results: MBluffChoiceRatePolicyResult[] = (["is-mcts", "mo-ismcts"] as const).map((policy) => {
    const strongReport = run(policy, strong, 301);
    const weakReport = run(policy, weak, 301);
    const strongChooses = isDeployUid(strongReport.bestAction.decision, publicStrongUid);
    const weakChooses = isDeployUid(weakReport.bestAction.decision, publicStrongUid);
    return {
      policy,
      strongBestLabel: strongReport.bestAction.label,
      weakBestLabel: weakReport.bestAction.label,
      strongBestDecision: strongReport.bestAction.decision,
      weakBestDecision: weakReport.bestAction.decision,
      strongChoosesPublicStrong: strongChooses,
      weakChoosesPublicStrong: weakChooses,
      bluffChoiceLift: (weakChooses ? 1 : 0) - (strongChooses ? 1 : 0),
      strongCompletedIterations: strongReport.completedSamples,
      weakCompletedIterations: weakReport.completedSamples,
      strongTimedOut: strongReport.timedOut,
      weakTimedOut: weakReport.timedOut,
    };
  });

  return {
    scenario: "public-posture-choice-rate",
    description:
      "P0 在托球步驟可選高公開姿態（宮侑 toss2）或較低公開姿態（影山 toss1）；paired states 只差 P0 hidden backing 是強攻擊牌或弱攻擊牌。weak backing 下仍選高公開姿態可視為 M-Bluff1 choice-rate 的 controlled proxy。",
    publicStrongPosture: cardLabel(db, PUBLIC_TOSS),
    publicHonestPosture: cardLabel(db, HONEST_TOSS),
    hiddenBacking: {
      strongLabel: cardLabel(db, STRONG_CARD),
      weakLabel: cardLabel(db, WEAK_BACKING),
    },
    leafRolloutHorizon,
    results,
  };
}

export function runMBluffPublicPostureCalibratedControl(
  db: CardDb,
  options: { seed?: number; iterations?: number; leafRolloutHorizon?: number; calibrationHorizon?: number } = {},
): MBluffPostureCalibratedControlReport {
  const seed = options.seed ?? 980;
  const iterations = options.iterations ?? 80;
  const leafRolloutHorizon = options.leafRolloutHorizon ?? 4;
  const calibrationHorizon = options.calibrationHorizon ?? 20;
  const { strong, weak, knownDecks, publicStrongUid, publicHonestUid } = createPublicPostureChoiceStates(db, seed);
  const strongScores = postureCandidateScores(db, strong, publicStrongUid, 0, calibrationHorizon);
  const weakScores = postureCandidateScores(db, weak, publicStrongUid, 0, calibrationHorizon);
  const strongBest = bestPostureScore(strongScores);
  const weakBest = bestPostureScore(weakScores);
  const weakLift = publicStrongValueLift(weakScores);
  const incentiveCompatible = weakLift !== null && weakLift > 0;
  const run = (policy: "is-mcts" | "mo-ismcts", state: GameState, seedOffset: number) =>
    policy === "is-mcts"
      ? createIsmctsReport(db, state, {
          perspectivePlayer: 0,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon,
          rootPressureTieBreakDelta: 0,
          rootPairQualityTieBreak: false,
          seed: seed + seedOffset,
        })
      : createMoIsmctsReport(db, state, {
          perspectivePlayer: 0,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon,
          seed: seed + seedOffset,
        });

  const results: MBluffPostureCalibratedPolicyResult[] = (["is-mcts", "mo-ismcts"] as const).map((policy) => {
    const strongReport = run(policy, strong, 601);
    const weakReport = run(policy, weak, 601);
    const strongChooses = isDeployUid(strongReport.bestAction.decision, publicStrongUid);
    const weakChooses = isDeployUid(weakReport.bestAction.decision, publicStrongUid);
    const strongChosenScore = postureScoreForDecision(strongScores, db, strong, strongReport.bestAction.decision, publicStrongUid, 0, calibrationHorizon);
    const weakChosenScore = postureScoreForDecision(weakScores, db, weak, weakReport.bestAction.decision, publicStrongUid, 0, calibrationHorizon);
    return {
      policy,
      strongBestLabel: strongReport.bestAction.label,
      weakBestLabel: weakReport.bestAction.label,
      strongBestDecision: strongReport.bestAction.decision,
      weakBestDecision: weakReport.bestAction.decision,
      strongChoosesPublicStrong: strongChooses,
      weakChoosesPublicStrong: weakChooses,
      bluffChoiceLift: (weakChooses ? 1 : 0) - (strongChooses ? 1 : 0),
      strongCompletedIterations: strongReport.completedSamples,
      weakCompletedIterations: weakReport.completedSamples,
      strongTimedOut: strongReport.timedOut,
      weakTimedOut: weakReport.timedOut,
      strongValueGapToGroundTruth: strongBest ? Math.max(0, strongBest.value - strongChosenScore.value) : null,
      weakValueGapToGroundTruth: weakBest ? Math.max(0, weakBest.value - weakChosenScore.value) : null,
      matchesWeakGroundTruthChoice: weakBest ? weakChooses === weakBest.choosesPublicStrong : null,
    };
  });

  return {
    scenario: "public-posture-choice-rate-v2",
    description:
      "M-Bluff v2：P0 在托球步驟選公開強姿態或保守姿態，先用 heuristic-rollout calibration 確認 weak backing 下公開強姿態是否真的有 EV 優勢，再量 SO/MO 是否跟上。",
    publicStrongPosture: cardLabel(db, PUBLIC_TOSS),
    publicHonestPosture: cardLabel(db, HONEST_TOSS),
    hiddenBacking: {
      strongLabel: cardLabel(db, STRONG_CARD),
      weakLabel: cardLabel(db, WEAK_BACKING),
    },
    leafRolloutHorizon,
    calibrationHorizon,
    groundTruth: {
      strongBestLabel: strongBest?.label ?? "n/a",
      weakBestLabel: weakBest?.label ?? "n/a",
      strongChoosesPublicStrong: strongBest?.choosesPublicStrong ?? null,
      weakChoosesPublicStrong: weakBest?.choosesPublicStrong ?? null,
      weakPublicStrongValueLift: weakLift,
      strongScores,
      weakScores,
    },
    incentiveCompatible,
    results,
  };
}

export function runMBluffResourceTempoControl(
  db: CardDb,
  options: { seed?: number; iterations?: number; leafRolloutHorizon?: number } = {},
): MBluffResourceTempoControlReport {
  const seed = options.seed ?? 960;
  const iterations = options.iterations ?? 80;
  const leafRolloutHorizon = options.leafRolloutHorizon ?? 4;
  const { rich, poor, knownDecks, attackUids } = createResourceTempoDefensePressureStates(db, seed);
  const maxAttack = maxAttackPoint(db, rich, attackUids);
  const run = (policy: "is-mcts" | "mo-ismcts", state: GameState, seedOffset: number) =>
    policy === "is-mcts"
      ? createIsmctsReport(db, state, {
          perspectivePlayer: 0,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon,
          rootPressureTieBreakDelta: 0,
          rootPairQualityTieBreak: false,
          seed: seed + seedOffset,
        })
      : createMoIsmctsReport(db, state, {
          perspectivePlayer: 0,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon,
          seed: seed + seedOffset,
        });

  const results: MBluffResourceTempoPolicyResult[] = (["is-mcts", "mo-ismcts"] as const).map((policy) => {
    const richReport = run(policy, rich, 401);
    const poorReport = run(policy, poor, 401);
    const richAttack = attackPointForDecision(db, rich, richReport.bestAction.decision);
    const poorAttack = attackPointForDecision(db, poor, poorReport.bestAction.decision);
    const attackPointDelta = nullableDelta(poorAttack, richAttack);
    const richChoosesMax = richAttack !== null && richAttack >= maxAttack;
    const poorChoosesMax = poorAttack !== null && poorAttack >= maxAttack;
    return {
      policy,
      richBestLabel: richReport.bestAction.label,
      poorBestLabel: poorReport.bestAction.label,
      richBestDecision: richReport.bestAction.decision,
      poorBestDecision: poorReport.bestAction.decision,
      richAttackPoint: richAttack,
      poorAttackPoint: poorAttack,
      attackPointDelta,
      richChoosesMaxAttack: richChoosesMax,
      poorChoosesMaxAttack: poorChoosesMax,
      richNoDeploy: richReport.bestAction.decision.type === "deploy-attack" && richReport.bestAction.decision.uid === null,
      poorNoDeploy: poorReport.bestAction.decision.type === "deploy-attack" && poorReport.bestAction.decision.uid === null,
      conservativeLiftWhenRich: (richChoosesMax ? 0 : 1) - (poorChoosesMax ? 0 : 1),
      richCompletedIterations: richReport.completedSamples,
      poorCompletedIterations: poorReport.completedSamples,
      richTimedOut: richReport.timedOut,
      poorTimedOut: poorReport.timedOut,
    };
  });

  return {
    scenario: "resource-tempo-defense-pressure",
    description:
      "P0 在攻擊步驟可選多個攻擊點姿態；paired states 的差異是 P1 公開手牌資源量充足或稀薄。這是 MO R4 的早期診斷：觀察搜尋是否會因對手防守資源充足而降低硬攻傾向。",
    publicAttackChoices: attackUids.map((uid) => `${cardLabel(db, rich.cards[uid] ?? "")} attack=${attackPointForDecision(db, rich, { type: "deploy-attack", uid }) ?? "n/a"}`),
    opponentPublicResources: {
      richHandCount: rich.players[1].hand.length,
      poorHandCount: poor.players[1].hand.length,
    },
    leafRolloutHorizon,
    results,
  };
}

export function runMBluffPublicPostureCalibratedSweep(
  db: CardDb,
  options: { seedStart?: number; seeds?: number; iterations?: number; leafRolloutHorizon?: number; calibrationHorizon?: number } = {},
): MBluffPostureCalibratedSweepReport {
  const seedStart = options.seedStart ?? 980;
  const seeds = options.seeds ?? 5;
  const iterations = options.iterations ?? 400;
  const leafRolloutHorizon = options.leafRolloutHorizon ?? 4;
  const calibrationHorizon = options.calibrationHorizon ?? 20;
  const reports = Array.from({ length: seeds }, (_, index) =>
    runMBluffPublicPostureCalibratedControl(db, {
      seed: seedStart + index,
      iterations,
      leafRolloutHorizon,
      calibrationHorizon,
    }),
  );
  const summaries: MBluffPostureCalibratedSweepPolicySummary[] = (["is-mcts", "mo-ismcts"] as const).map((policy) => {
    const items = reports.flatMap((report) => report.results.filter((result) => result.policy === policy));
    const weakGroundTruthChoices = reports
      .map((report) => report.groundTruth.weakChoosesPublicStrong)
      .filter((item): item is boolean => item !== null);
    const directionMatches = items
      .map((item) => item.matchesWeakGroundTruthChoice)
      .filter((item): item is boolean => item !== null);
    return {
      policy,
      seeds: items.length,
      incentiveCompatibleRate: avgNumber(reports.map((report) => (report.incentiveCompatible ? 1 : 0))),
      weakGroundTruthBluffRate: weakGroundTruthChoices.length === 0 ? null : avgNumber(weakGroundTruthChoices.map((item) => (item ? 1 : 0))),
      weakPublicStrongRate: avgNumber(items.map((item) => (item.weakChoosesPublicStrong ? 1 : 0))),
      weakDirectionMatchRate: directionMatches.length === 0 ? null : avgNumber(directionMatches.map((item) => (item ? 1 : 0))),
      averageWeakPublicStrongValueLift: avgNullable(reports.map((report) => report.groundTruth.weakPublicStrongValueLift)),
      averageStrongValueGapToGroundTruth: avgNullable(items.map((item) => item.strongValueGapToGroundTruth)),
      averageWeakValueGapToGroundTruth: avgNullable(items.map((item) => item.weakValueGapToGroundTruth)),
      averageStrongCompletedIterations: avgNumber(items.map((item) => item.strongCompletedIterations)),
      averageWeakCompletedIterations: avgNumber(items.map((item) => item.weakCompletedIterations)),
      timeoutRate: avgNumber(items.flatMap((item) => [item.strongTimedOut ? 1 : 0, item.weakTimedOut ? 1 : 0])),
    };
  });

  return {
    scenario: "public-posture-choice-rate-v2-sweep",
    description:
      "M-Bluff v2 場景級 high-N sweep：先校準 weak backing 下公開強姿態是否有 EV 優勢，再比較 SO/MO 是否選擇同一方向。",
    seedStart,
    seeds,
    iterations,
    leafRolloutHorizon,
    calibrationHorizon,
    summaries,
    reports,
  };
}

export function runMBluffResourceTempoSweep(
  db: CardDb,
  options: { seedStart?: number; seeds?: number; iterations?: number; leafRolloutHorizon?: number } = {},
): MBluffResourceTempoSweepReport {
  const seedStart = options.seedStart ?? 960;
  const seeds = options.seeds ?? 5;
  const iterations = options.iterations ?? 400;
  const leafRolloutHorizon = options.leafRolloutHorizon ?? 4;
  const reports = Array.from({ length: seeds }, (_, index) =>
    runMBluffResourceTempoControl(db, {
      seed: seedStart + index,
      iterations,
      leafRolloutHorizon,
    }),
  );
  const summaries: MBluffResourceTempoSweepPolicySummary[] = (["is-mcts", "mo-ismcts"] as const).map((policy) => {
    const items = reports.flatMap((report) => report.results.filter((result) => result.policy === policy));
    const deltas = items.map((item) => item.attackPointDelta);
    const numericDeltas = deltas.filter((item): item is number => item !== null);
    return {
      policy,
      seeds: items.length,
      averageAttackPointDelta: avgNullable(deltas),
      positiveDeltaRate: numericDeltas.length === 0 ? null : avgNumber(numericDeltas.map((delta) => (delta > 0 ? 1 : 0))),
      averageRichAttackPoint: avgNullable(items.map((item) => item.richAttackPoint)),
      averagePoorAttackPoint: avgNullable(items.map((item) => item.poorAttackPoint)),
      averageRichCompletedIterations: avgNumber(items.map((item) => item.richCompletedIterations)),
      averagePoorCompletedIterations: avgNumber(items.map((item) => item.poorCompletedIterations)),
      timeoutRate: avgNumber(items.flatMap((item) => [item.richTimedOut ? 1 : 0, item.poorTimedOut ? 1 : 0])),
    };
  });

  return {
    scenario: "resource-tempo-defense-pressure-sweep",
    description:
      "R6/R7 場景級 high-N sweep：固定單一攻擊決策點，掃多個 seed，比較 SO/MO 在對手公開資源 rich/poor 下的攻擊點方向差。主要讀數是 attackPointDelta = poorAttackPoint - richAttackPoint；正值代表對手資源少時更敢硬攻。",
    seedStart,
    seeds,
    iterations,
    leafRolloutHorizon,
    summaries,
    reports,
  };
}

export function runMBluffResourceTempoCalibratedControl(
  db: CardDb,
  options: { seed?: number; iterations?: number; leafRolloutHorizon?: number; calibrationHorizon?: number } = {},
): MBluffResourceTempoCalibratedControlReport {
  const seed = options.seed ?? 970;
  const iterations = options.iterations ?? 80;
  const leafRolloutHorizon = options.leafRolloutHorizon ?? 4;
  const calibrationHorizon = options.calibrationHorizon ?? 12;
  const { rich, poor, knownDecks, attackUids } = createResourceTempoDefensePressureStates(db, seed);
  const richScores = attackCandidateScores(db, rich, 0, calibrationHorizon);
  const poorScores = attackCandidateScores(db, poor, 0, calibrationHorizon);
  const richBest = bestScore(richScores);
  const poorBest = bestScore(poorScores);
  const groundTruthDelta = nullableDelta(poorBest?.attackPoint ?? null, richBest?.attackPoint ?? null);
  const incentiveCompatible = groundTruthDelta !== null && groundTruthDelta > 0;
  const run = (policy: "is-mcts" | "mo-ismcts", state: GameState, seedOffset: number) =>
    policy === "is-mcts"
      ? createIsmctsReport(db, state, {
          perspectivePlayer: 0,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon,
          rootPressureTieBreakDelta: 0,
          rootPairQualityTieBreak: false,
          seed: seed + seedOffset,
        })
      : createMoIsmctsReport(db, state, {
          perspectivePlayer: 0,
          knownDecks,
          iterations,
          candidateLimit: 8,
          leafRolloutHorizon,
          seed: seed + seedOffset,
        });

  const results: MBluffResourceTempoCalibratedPolicyResult[] = (["is-mcts", "mo-ismcts"] as const).map((policy) => {
    const richReport = run(policy, rich, 501);
    const poorReport = run(policy, poor, 501);
    const richAttack = attackPointForDecision(db, rich, richReport.bestAction.decision);
    const poorAttack = attackPointForDecision(db, poor, poorReport.bestAction.decision);
    const attackPointDelta = nullableDelta(poorAttack, richAttack);
    const richChosenScore = scoreForDecision(richScores, db, rich, richReport.bestAction.decision, 0, calibrationHorizon);
    const poorChosenScore = scoreForDecision(poorScores, db, poor, poorReport.bestAction.decision, 0, calibrationHorizon);
    const richValueGap = richBest ? Math.max(0, richBest.value - richChosenScore.value) : null;
    const poorValueGap = poorBest ? Math.max(0, poorBest.value - poorChosenScore.value) : null;
    const groundTruthSign = nullableSign(groundTruthDelta);
    const policySign = nullableSign(attackPointDelta);
    const matchesGroundTruthDirection = groundTruthSign === null || policySign === null ? null : groundTruthSign === policySign;
    const maxAttack = maxAttackPoint(db, rich, attackUids);
    const richChoosesMax = richAttack !== null && richAttack >= maxAttack;
    const poorChoosesMax = poorAttack !== null && poorAttack >= maxAttack;
    return {
      policy,
      richBestLabel: richReport.bestAction.label,
      poorBestLabel: poorReport.bestAction.label,
      richBestDecision: richReport.bestAction.decision,
      poorBestDecision: poorReport.bestAction.decision,
      richAttackPoint: richAttack,
      poorAttackPoint: poorAttack,
      attackPointDelta,
      richChoosesMaxAttack: richChoosesMax,
      poorChoosesMaxAttack: poorChoosesMax,
      richNoDeploy: richReport.bestAction.decision.type === "deploy-attack" && richReport.bestAction.decision.uid === null,
      poorNoDeploy: poorReport.bestAction.decision.type === "deploy-attack" && poorReport.bestAction.decision.uid === null,
      conservativeLiftWhenRich: (richChoosesMax ? 0 : 1) - (poorChoosesMax ? 0 : 1),
      richCompletedIterations: richReport.completedSamples,
      poorCompletedIterations: poorReport.completedSamples,
      richTimedOut: richReport.timedOut,
      poorTimedOut: poorReport.timedOut,
      richValueGapToGroundTruth: richValueGap,
      poorValueGapToGroundTruth: poorValueGap,
      matchesGroundTruthDirection,
    };
  });

  return {
    scenario: "resource-tempo-defense-pressure-v2",
    description:
      "R4 v2：同樣固定 P0 攻擊決策點，但先用 heuristic rollout calibration 判定 rich/poor 兩側的候選 EV 排序；只有 ground-truth 也支持 poor 比 rich 更該硬攻時，才把此盤面視為誘因相容。",
    publicAttackChoices: attackUids.map((uid) => `${cardLabel(db, rich.cards[uid] ?? "")} attack=${attackPointForDecision(db, rich, { type: "deploy-attack", uid }) ?? "n/a"}`),
    opponentPublicResources: {
      richHandCount: rich.players[1].hand.length,
      poorHandCount: poor.players[1].hand.length,
    },
    leafRolloutHorizon,
    calibrationHorizon,
    groundTruth: {
      richBestLabel: richBest?.label ?? "n/a",
      poorBestLabel: poorBest?.label ?? "n/a",
      richBestAttackPoint: richBest?.attackPoint ?? null,
      poorBestAttackPoint: poorBest?.attackPoint ?? null,
      attackPointDelta: groundTruthDelta,
      richScores,
      poorScores,
    },
    incentiveCompatible,
    results,
  };
}

export function runMBluffResourceTempoCalibratedSweep(
  db: CardDb,
  options: { seedStart?: number; seeds?: number; iterations?: number; leafRolloutHorizon?: number; calibrationHorizon?: number } = {},
): MBluffResourceTempoCalibratedSweepReport {
  const seedStart = options.seedStart ?? 970;
  const seeds = options.seeds ?? 5;
  const iterations = options.iterations ?? 400;
  const leafRolloutHorizon = options.leafRolloutHorizon ?? 4;
  const calibrationHorizon = options.calibrationHorizon ?? 12;
  const reports = Array.from({ length: seeds }, (_, index) =>
    runMBluffResourceTempoCalibratedControl(db, {
      seed: seedStart + index,
      iterations,
      leafRolloutHorizon,
      calibrationHorizon,
    }),
  );
  const summaries: MBluffResourceTempoCalibratedSweepPolicySummary[] = (["is-mcts", "mo-ismcts"] as const).map((policy) => {
    const items = reports.flatMap((report) => report.results.filter((result) => result.policy === policy));
    const deltas = items.map((item) => item.attackPointDelta);
    const numericDeltas = deltas.filter((item): item is number => item !== null);
    const directionMatches = items
      .map((item) => item.matchesGroundTruthDirection)
      .filter((item): item is boolean => item !== null);
    return {
      policy,
      seeds: items.length,
      incentiveCompatibleRate: avgNumber(reports.map((report) => (report.incentiveCompatible ? 1 : 0))),
      averageGroundTruthAttackPointDelta: avgNullable(reports.map((report) => report.groundTruth.attackPointDelta)),
      averageAttackPointDelta: avgNullable(deltas),
      directionMatchRate: directionMatches.length === 0 ? null : avgNumber(directionMatches.map((item) => (item ? 1 : 0))),
      positiveDeltaRate: numericDeltas.length === 0 ? null : avgNumber(numericDeltas.map((delta) => (delta > 0 ? 1 : 0))),
      averageRichValueGapToGroundTruth: avgNullable(items.map((item) => item.richValueGapToGroundTruth)),
      averagePoorValueGapToGroundTruth: avgNullable(items.map((item) => item.poorValueGapToGroundTruth)),
      averageRichCompletedIterations: avgNumber(items.map((item) => item.richCompletedIterations)),
      averagePoorCompletedIterations: avgNumber(items.map((item) => item.poorCompletedIterations)),
      timeoutRate: avgNumber(items.flatMap((item) => [item.richTimedOut ? 1 : 0, item.poorTimedOut ? 1 : 0])),
    };
  });

  return {
    scenario: "resource-tempo-defense-pressure-v2-sweep",
    description:
      "R4 v2 場景級 high-N sweep：在每個 seed 先校準候選 EV 排序，再比較 SO/MO 的 attackPointDelta 是否跟 ground-truth 方向一致。",
    seedStart,
    seeds,
    iterations,
    leafRolloutHorizon,
    calibrationHorizon,
    summaries,
    reports,
  };
}
