import { applyDecision, createGame } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { createPimcCoachReport } from "./coach";
import { benchmarkDb, findBenchmarkDeck, type BenchmarkDeck, type DeckAxis } from "./benchmark-fixtures";
import { heuristicAiDecision, heuristicProfileForDeckAxes } from "./heuristic";
import { heuristicV1AiDecision } from "./heuristic-v1";
import { createIsmctsReport } from "./ismcts";
import { randomAiDecision } from "./random";
import { type ValueModel } from "./rollout-value";
import { seededRnd } from "./benchmark";

export type LadderPolicyId = "random" | "heuristic-v1" | "heuristic-v2" | "pimc-v2" | "so-h4h5" | "so-k-v1";

export interface LadderPolicySnapshot {
  id: LadderPolicyId;
  label: string;
  family: "random" | "heuristic" | "pimc" | "so-ismcts";
  frozenAt: string;
  options: Record<string, unknown>;
}

export interface LadderConfig {
  policies: LadderPolicyId[];
  basePolicies: LadderPolicyId[];
  anchorPolicy: LadderPolicyId;
  anchorElo: number;
  mirrorDecks: string[];
  gamesPerSeat: number;
  seedStart: number;
  maxSteps: number;
  pimcSamples: number;
  searchIterations: number;
  leafRolloutHorizon: number;
  candidateLimit: number;
}

export interface LadderMatchRecord {
  policyA: LadderPolicyId;
  policyB: LadderPolicyId;
  deck: string;
  seat: 0 | 1;
  seed: number;
  outcome: "complete" | "error" | "max-steps";
  winnerPolicy: LadderPolicyId | null;
  steps: number;
  error?: string;
}

export interface LadderPairSummary {
  policyA: LadderPolicyId;
  policyB: LadderPolicyId;
  completed: number;
  winsA: number;
  winsB: number;
}

export interface LadderPolicyRating {
  id: LadderPolicyId;
  label: string;
  elo: number;
  wins: number;
  losses: number;
  completed: number;
  baseFrozen: boolean;
}

export interface LadderReport {
  kind: "policy-ladder-elo";
  generatedAt: string;
  config: LadderConfig;
  policySnapshots: LadderPolicySnapshot[];
  matches: LadderMatchRecord[];
  pairSummaries: LadderPairSummary[];
  ratings: LadderPolicyRating[];
  incrementalCheck: {
    basePolicies: LadderPolicyId[];
    referenceOrder: LadderPolicyId[];
    currentOrder: LadderPolicyId[];
    pass: boolean;
  };
}

export const LADDER_MIRROR_DECKS = [
  "烏野-預組",
  "音駒-預組",
  "梟谷-高爆發軸",
  "白鳥沢-最強白鳥沢",
  "青葉城西-二彈改",
] as const;

export const LADDER_POLICY_IDS = [
  "random",
  "heuristic-v1",
  "heuristic-v2",
  "pimc-v2",
  "so-h4h5",
  "so-k-v1",
] as const satisfies readonly LadderPolicyId[];

export const DEFAULT_LADDER_CONFIG: LadderConfig = {
  policies: [...LADDER_POLICY_IDS],
  basePolicies: [...LADDER_POLICY_IDS],
  anchorPolicy: "heuristic-v2",
  anchorElo: 1500,
  mirrorDecks: [...LADDER_MIRROR_DECKS],
  gamesPerSeat: 1,
  seedStart: 17000,
  maxSteps: 5000,
  pimcSamples: 8,
  searchIterations: 32,
  leafRolloutHorizon: 40,
  candidateLimit: 8,
};

/**
 * [Claude 2026-07-06] L2 review 加固：so-k-v1 原直接引用 live `ROLLOUT_VALUE_MODEL`，下次 value model
 * 換版時 ladder 會靜默漂移（so-k-v1 變成新模型、跨版本刻度失真、增量性檢查失效）。凍結為權重副本，
 * 與 H3 快照同慣例；未來新版本上線＝另立新 policy id，不改此常數。
 */
const K_SELECTED_V1_VALUE_MODEL: ValueModel = {
  weights: [
    1.0792904515664883,
    0.10125110367845033,
    0,
    0.12845235855358444,
    -0.02109804724880147,
    -0.13481758380063316,
    0.10064361394120208,
    0.1580467920340516,
    0.3299436108005369,
    -0.0696573514192975,
    0.026916631267495057,
    -0.06491096486945418,
    -0.07549608081834222,
    0.08946038511873473,
    -0.044363709074465844,
    0,
    0,
    0,
    0,
    0,
    -0.08651622401556772,
    -0.02746377458189579,
    0.10639185166360375,
    -0.0020727394014032545,
    0,
    0,
    0,
    0,
    0,
  ],
  bias: 0.15702473665271066,
  provenance:
    "Frozen ladder snapshot: Phase K selected v1 29-dim default-on model; copied from commit a8ef068 src/ai/rollout-value.ts. [Claude 2026-07-06]",
};

const H3_VALUE_MODEL: ValueModel = {
  weights: [
    1.6047480620171253,
    0.13933774202857876,
    0,
    0.28120472769083127,
    -0.06160478069224429,
    -0.22083047076638376,
    -0.02064792168222764,
    -0.35911542999440854,
    -0.3052494204120485,
    0.02934524962116886,
    -0.12561231052949046,
    -0.10651494510836863,
    0,
    0.2220708438893249,
    0.02687112911904538,
  ],
  bias: -3.252606517456513e-17,
  provenance:
    "Frozen ladder snapshot: Phase H H4/H5 live model before Phase K selected-v1 default-on; copied from commit 5f51c71 src/ai/rollout-value.ts. [Codex 2026-07-06]",
};

export function ladderPolicySnapshots(config: LadderConfig = DEFAULT_LADDER_CONFIG): LadderPolicySnapshot[] {
  return config.policies.map((id) => {
    if (id === "random") return { id, label: "Random", family: "random", frozenAt: "M5 baseline", options: {} };
    if (id === "heuristic-v1") return { id, label: "Heuristic v1", family: "heuristic", frozenAt: "M5 historical baseline", options: {} };
    if (id === "heuristic-v2") return { id, label: "Heuristic v2", family: "heuristic", frozenAt: "M5 v2 baseline", options: { profile: "heuristic-v2" } };
    if (id === "pimc-v2") {
      return {
        id,
        label: "PIMC v2",
        family: "pimc",
        frozenAt: "Phase F S1",
        options: { sampleCount: config.pimcSamples, rolloutMaxSteps: 600, candidateLimit: config.candidateLimit, valueCutHorizon: 40 },
      };
    }
    const common = {
      iterations: config.searchIterations,
      leafRolloutHorizon: config.leafRolloutHorizon,
      candidateLimit: config.candidateLimit,
      rootPressureTieBreakDelta: 0.04,
      rootPairQualityTieBreak: true,
      rootConservationWinRateThreshold: 0.85,
    };
    if (id === "so-h4h5") {
      return {
        id,
        label: "SO-H4/H5",
        family: "so-ismcts",
        frozenAt: "Phase H H4/H5 before Phase K",
        options: { ...common, valueModel: "phase-h-h3-15d" },
      };
    }
    return {
      id,
      label: "SO-K v1",
      family: "so-ismcts",
      frozenAt: "Phase K selected v1 default-on",
      options: { ...common, valueModel: "phase-k-selected-v1-29d" },
    };
  });
}

function other(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function ladderPolicyDecision(
  policy: LadderPolicyId,
  db: CardDb,
  state: GameState,
  randomByPlayer: [() => number, () => number],
  deckAxesByPlayer: readonly [readonly DeckAxis[], readonly DeckAxis[]],
  knownDecksByPlayer: readonly [readonly string[], readonly string[]],
  config: LadderConfig,
): Decision {
  const pending = state.pendingDecision;
  if (!pending) throw new Error("目前沒有待決策，ladder 無法推進");
  const player = pending.player as PlayerId;
  if (policy === "random") return randomAiDecision(db, state, randomByPlayer[player]);
  if (policy === "heuristic-v1") return heuristicV1AiDecision(db, state);
  if (policy === "heuristic-v2") return heuristicAiDecision(db, state, "heuristic-v2");
  const rolloutPolicy = heuristicProfileForDeckAxes(deckAxesByPlayer[player]);
  if (policy === "pimc-v2") {
    return createPimcCoachReport(db, state, {
      perspectivePlayer: player,
      knownDecks: knownDecksByPlayer,
      sampleCount: config.pimcSamples,
      rolloutMaxSteps: 600,
      candidateLimit: config.candidateLimit,
      rolloutPolicy,
      valueCutHorizon: 40,
    }).bestAction.decision;
  }
  return createIsmctsReport(db, state, {
    perspectivePlayer: player,
    knownDecks: knownDecksByPlayer,
    iterations: config.searchIterations,
    explorationC: Math.SQRT2,
    candidateLimit: config.candidateLimit,
    leafRolloutHorizon: config.leafRolloutHorizon,
    rootPressureTieBreakDelta: 0.04,
    rootPairQualityTieBreak: true,
    rootConservationWinRateThreshold: 0.85,
    rolloutPolicy,
    valueModel: policy === "so-h4h5" ? H3_VALUE_MODEL : K_SELECTED_V1_VALUE_MODEL,
  }).bestAction.decision;
}

function playLadderMatch(args: {
  db: CardDb;
  deck: BenchmarkDeck;
  policies: readonly [LadderPolicyId, LadderPolicyId];
  seed: number;
  seat: 0 | 1;
  config: LadderConfig;
}): LadderMatchRecord {
  const randomByPlayer: [() => number, () => number] = [
    seededRnd(args.seed * 3 + 11),
    seededRnd(args.seed * 5 + 17),
  ];
  let state: GameState;
  try {
    state = createGame(args.db, { seed: args.seed, decks: [args.deck.ids, args.deck.ids] });
  } catch (error) {
    return {
      policyA: args.policies[0],
      policyB: args.policies[1],
      deck: args.deck.name,
      seat: args.seat,
      seed: args.seed,
      outcome: "error",
      winnerPolicy: null,
      steps: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const knownDecks = [args.deck.ids, args.deck.ids] as const;
  const axes = [args.deck.axes, args.deck.axes] as const;
  for (let step = 0; step < args.config.maxSteps; step++) {
    if (state.phase === "gameOver") {
      const winnerPolicy = state.winner === null ? null : args.policies[state.winner];
      return {
        policyA: args.policies[0],
        policyB: args.policies[1],
        deck: args.deck.name,
        seat: args.seat,
        seed: args.seed,
        outcome: "complete",
        winnerPolicy,
        steps: step,
      };
    }
    const pending = state.pendingDecision;
    if (!pending) {
      return {
        policyA: args.policies[0],
        policyB: args.policies[1],
        deck: args.deck.name,
        seat: args.seat,
        seed: args.seed,
        outcome: "error",
        winnerPolicy: null,
        steps: step,
        error: "遊戲未結束但沒有 pendingDecision",
      };
    }
    try {
      const player = pending.player as PlayerId;
      const decision = ladderPolicyDecision(args.policies[player], args.db, state, randomByPlayer, axes, knownDecks, args.config);
      state = applyDecision(args.db, state, decision);
    } catch (error) {
      return {
        policyA: args.policies[0],
        policyB: args.policies[1],
        deck: args.deck.name,
        seat: args.seat,
        seed: args.seed,
        outcome: "error",
        winnerPolicy: null,
        steps: step,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    policyA: args.policies[0],
    policyB: args.policies[1],
    deck: args.deck.name,
    seat: args.seat,
    seed: args.seed,
    outcome: "max-steps",
    winnerPolicy: null,
    steps: args.config.maxSteps,
    error: `超過 maxSteps=${args.config.maxSteps}`,
  };
}

export function summarizeLadderPairs(matches: readonly LadderMatchRecord[]): LadderPairSummary[] {
  const byPair = new Map<string, LadderPairSummary>();
  for (const match of matches) {
    const [policyA, policyB] = [match.policyA, match.policyB].sort() as [LadderPolicyId, LadderPolicyId];
    const key = `${policyA}::${policyB}`;
    const summary = byPair.get(key) ?? { policyA, policyB, completed: 0, winsA: 0, winsB: 0 };
    if (match.outcome === "complete" && match.winnerPolicy) {
      summary.completed++;
      if (match.winnerPolicy === policyA) summary.winsA++;
      if (match.winnerPolicy === policyB) summary.winsB++;
    }
    byPair.set(key, summary);
  }
  return [...byPair.values()].sort((a, b) => `${a.policyA}:${a.policyB}`.localeCompare(`${b.policyA}:${b.policyB}`));
}

function expectedScore(eloA: number, eloB: number): number {
  return 1 / (1 + 10 ** ((eloB - eloA) / 400));
}

function fitBaseRatings(
  policies: readonly LadderPolicyId[],
  matches: readonly LadderMatchRecord[],
  anchorPolicy: LadderPolicyId,
  anchorElo: number,
): Map<LadderPolicyId, number> {
  const ratings = new Map<LadderPolicyId, number>();
  for (const policy of policies) ratings.set(policy, anchorElo);
  ratings.set(anchorPolicy, anchorElo);
  const movable = policies.filter((policy) => policy !== anchorPolicy);
  for (let pass = 0; pass < 240; pass++) {
    const gradient = new Map<LadderPolicyId, number>(movable.map((policy) => [policy, 0]));
    for (const match of matches) {
      if (match.outcome !== "complete" || !match.winnerPolicy) continue;
      if (!policies.includes(match.policyA) || !policies.includes(match.policyB)) continue;
      const eloA = ratings.get(match.policyA) ?? anchorElo;
      const eloB = ratings.get(match.policyB) ?? anchorElo;
      const actualA = match.winnerPolicy === match.policyA ? 1 : 0;
      const error = actualA - expectedScore(eloA, eloB);
      if (gradient.has(match.policyA)) gradient.set(match.policyA, (gradient.get(match.policyA) ?? 0) + error);
      if (gradient.has(match.policyB)) gradient.set(match.policyB, (gradient.get(match.policyB) ?? 0) - error);
    }
    const step = 24 / Math.sqrt(pass + 1);
    for (const policy of movable) {
      const next = (ratings.get(policy) ?? anchorElo) + step * (gradient.get(policy) ?? 0);
      ratings.set(policy, Math.max(400, Math.min(2600, next)));
    }
    ratings.set(anchorPolicy, anchorElo);
  }
  return ratings;
}

function fitSingleRating(
  policy: LadderPolicyId,
  fixedRatings: ReadonlyMap<LadderPolicyId, number>,
  matches: readonly LadderMatchRecord[],
  fallbackElo: number,
): number {
  const relevant = matches.filter(
    (match) =>
      match.outcome === "complete" &&
      match.winnerPolicy &&
      ((match.policyA === policy && fixedRatings.has(match.policyB)) || (match.policyB === policy && fixedRatings.has(match.policyA))),
  );
  if (relevant.length === 0) return fallbackElo;
  let low = 400;
  let high = 2600;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    let gradient = 0;
    for (const match of relevant) {
      const opponent = match.policyA === policy ? match.policyB : match.policyA;
      const actual = match.winnerPolicy === policy ? 1 : 0;
      gradient += actual - expectedScore(mid, fixedRatings.get(opponent) ?? fallbackElo);
    }
    if (gradient > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function computeLadderRatings(
  policies: readonly LadderPolicyId[],
  basePolicies: readonly LadderPolicyId[],
  matches: readonly LadderMatchRecord[],
  anchorPolicy: LadderPolicyId = "heuristic-v2",
  anchorElo = 1500,
): LadderPolicyRating[] {
  const base = policies.filter((policy) => basePolicies.includes(policy));
  const ratings = fitBaseRatings(base, matches, anchorPolicy, anchorElo);
  for (const policy of policies) {
    if (ratings.has(policy)) continue;
    ratings.set(policy, fitSingleRating(policy, ratings, matches, anchorElo));
  }

  return policies.map((id) => {
    let wins = 0;
    let losses = 0;
    for (const match of matches) {
      if (match.outcome !== "complete" || !match.winnerPolicy) continue;
      if (match.policyA !== id && match.policyB !== id) continue;
      if (match.winnerPolicy === id) wins++;
      else losses++;
    }
    return {
      id,
      label: ladderPolicySnapshots({ ...DEFAULT_LADDER_CONFIG, policies: [...policies] }).find((p) => p.id === id)?.label ?? id,
      elo: Math.round(ratings.get(id) ?? anchorElo),
      wins,
      losses,
      completed: wins + losses,
      baseFrozen: basePolicies.includes(id),
    };
  }).sort((a, b) => b.elo - a.elo || a.id.localeCompare(b.id));
}

export function ladderOrder(ratings: readonly LadderPolicyRating[], subset: readonly LadderPolicyId[]): LadderPolicyId[] {
  const wanted = new Set(subset);
  return ratings.filter((rating) => wanted.has(rating.id)).map((rating) => rating.id);
}

export function runPolicyLadder(config: LadderConfig = DEFAULT_LADDER_CONFIG, db: CardDb = benchmarkDb): LadderReport {
  const matches: LadderMatchRecord[] = [];
  const decks = config.mirrorDecks.map((name) => findBenchmarkDeck(name));
  let pairIndex = 0;
  for (let i = 0; i < config.policies.length; i++) {
    for (let j = i + 1; j < config.policies.length; j++) {
      const policyA = config.policies[i]!;
      const policyB = config.policies[j]!;
      for (let deckIndex = 0; deckIndex < decks.length; deckIndex++) {
        const deck = decks[deckIndex]!;
        for (const seat of [0, 1] as const) {
          for (let game = 0; game < config.gamesPerSeat; game++) {
            const policies = seat === 0 ? [policyA, policyB] as const : [policyB, policyA] as const;
            matches.push(
              playLadderMatch({
                db,
                deck,
                policies,
                seed: config.seedStart + pairIndex * 100000 + deckIndex * 1000 + seat * 500 + game,
                seat,
                config,
              }),
            );
          }
        }
      }
      pairIndex++;
    }
  }
  const ratings = computeLadderRatings(config.policies, config.basePolicies, matches, config.anchorPolicy, config.anchorElo);
  const baseRatings = computeLadderRatings(config.basePolicies, config.basePolicies, matches, config.anchorPolicy, config.anchorElo);
  const referenceOrder = ladderOrder(baseRatings, config.basePolicies);
  const currentOrder = ladderOrder(ratings, config.basePolicies);
  return {
    kind: "policy-ladder-elo",
    generatedAt: new Date().toISOString(),
    config,
    policySnapshots: ladderPolicySnapshots(config),
    matches,
    pairSummaries: summarizeLadderPairs(matches),
    ratings,
    incrementalCheck: {
      basePolicies: [...config.basePolicies],
      referenceOrder,
      currentOrder,
      pass: referenceOrder.join("\n") === currentOrder.join("\n"),
    },
  };
}
