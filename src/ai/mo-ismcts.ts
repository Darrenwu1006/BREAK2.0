import { applyDecision } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { heuristicAiDecision } from "./heuristic";
import type { HeuristicV2ProfileId } from "./heuristic";
import {
  determinizeHiddenState,
  enumerateCandidates,
  inferKnownDecks,
  type CoachActionEstimate,
  type CoachReport,
} from "./coach";
import { describeDecision } from "../shared/decisionLabels";
import { ucbScore } from "./ismcts";
import { evaluateShapedStateValue, type ValueModel } from "./rollout-value";
import type { KnownDecks } from "./remaining-pool";

export interface ObservableProjectionContext {
  actor: PlayerId;
  viewer: PlayerId;
  before: GameState;
  after?: GameState;
}

type PublicCardRef = { cardId: string | null; nameChoice?: string };

export interface MoIsmctsOptions {
  perspectivePlayer?: PlayerId;
  knownDecks?: readonly [readonly string[], readonly string[]];
  iterations?: number;
  timeLimitMs?: number;
  explorationC?: number;
  candidateLimit?: number;
  rolloutPolicy?: HeuristicV2ProfileId;
  leafRolloutHorizon?: number;
  /** [Codex 2026-06-30] Phase H H3：benchmark-only 候選 value model，不傳則沿用 live model。 */
  valueModel?: ValueModel;
  seed?: number;
}

interface MoNode {
  children: Map<string, MoNode>;
  availability: Map<string, number>;
  visits: number;
  valueSumByPlayer: [number, number];
}

interface LegalEntry {
  key: string;
  decision: Decision;
}

const DEFAULT_ITERATIONS = 800;
const DEFAULT_EXPLORATION_C = Math.SQRT2;
const DEFAULT_CANDIDATE_LIMIT = 8;
const SEED_STRIDE = 1000003;

function cardRef(state: GameState, uid: number, nameChoice?: string): PublicCardRef {
  return {
    cardId: state.cards[uid] ?? null,
    ...(nameChoice !== undefined ? { nameChoice } : {}),
  };
}

function stableKey(value: unknown): string {
  return JSON.stringify(value);
}

function newNode(): MoNode {
  return { children: new Map(), availability: new Map(), visits: 0, valueSumByPlayer: [0, 0] };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function confidenceFromRate(samples: number, p: number): number {
  if (samples <= 0) return 0;
  const z = 1.96;
  const denom = 1 + (z * z) / samples;
  const center = p + (z * z) / (2 * samples);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * samples)) / samples);
  const low = Math.max(0, (center - margin) / denom);
  const high = Math.min(1, (center + margin) / denom);
  const widthScore = 1 - (high - low);
  const sampleScore = Math.sqrt(samples / (samples + 12));
  return clamp01(widthScore * sampleScore);
}

function deployProjection(
  decision: Extract<Decision, { type: "deploy-serve" | "deploy-receive" | "deploy-toss" | "deploy-attack" }>,
  ctx: ObservableProjectionContext,
): unknown {
  if (ctx.actor === ctx.viewer) return decision;
  return {
    type: decision.type,
    card: decision.uid === null ? null : cardRef(ctx.before, decision.uid, decision.nameChoice),
  };
}

function blockProjection(
  decision: Extract<Decision, { type: "deploy-block" }>,
  ctx: ObservableProjectionContext,
): unknown {
  if (ctx.actor === ctx.viewer) return decision;
  if (decision.uids === null) return { type: "deploy-block", uids: null };
  return {
    type: "deploy-block",
    cards: decision.uids.map((uid) => ({
      ...cardRef(ctx.before, uid, decision.nameChoices?.[uid]),
      role: uid === decision.center ? "center" : "side",
    })),
  };
}

function freeProjection(decision: Extract<Decision, { type: "free" }>, ctx: ObservableProjectionContext): unknown {
  if (ctx.actor === ctx.viewer) return decision;
  if (decision.action === "skill") {
    return { type: "free", action: "skill", card: cardRef(ctx.before, decision.uid), skillIndex: decision.skillIndex };
  }
  if (decision.action === "event") {
    return { type: "free", action: "event", card: cardRef(ctx.before, decision.uid) };
  }
  return decision;
}

function effectCardsProjection(decision: Extract<Decision, { type: "effect-cards" }>, ctx: ObservableProjectionContext): unknown {
  if (ctx.actor === ctx.viewer) return decision;
  const awaiting = ctx.before.effectCtx?.awaiting;
  const purpose = awaiting?.kind === "cards" ? awaiting.purpose : "unknown";
  return {
    type: "effect-cards",
    purpose,
    count: decision.uids.length,
  };
}

export function observableProjection(decision: Decision, ctx: ObservableProjectionContext): string {
  if (ctx.actor === ctx.viewer) return stableKey(decision);
  switch (decision.type) {
    case "mulligan":
      return stableKey({ type: "mulligan", count: decision.returnUids.length });
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack":
      return stableKey(deployProjection(decision, ctx));
    case "deploy-block":
      return stableKey(blockProjection(decision, ctx));
    case "free":
      return stableKey(freeProjection(decision, ctx));
    case "effect-cards":
      return stableKey(effectCardsProjection(decision, ctx));
    case "pick-set-card":
      return stableKey({ type: "pick-set-card", count: 1 });
    case "serve-rights":
    case "defense-choice":
    case "resolve-pending":
    case "effect-confirm":
    case "effect-option":
      return stableKey(decision);
  }
}

function legalEntries(
  db: CardDb,
  cur: GameState,
  actor: PlayerId,
  candidateLimit: number,
  rolloutPolicy: HeuristicV2ProfileId,
): LegalEntry[] {
  const fallback = heuristicAiDecision(db, cur, rolloutPolicy);
  const decisions = enumerateCandidates(db, cur, candidateLimit, fallback);
  return decisions.map((decision) => ({
    key: observableProjection(decision, { actor, viewer: actor, before: cur }),
    decision,
  }));
}

function leafStateAfterRollout(
  db: CardDb,
  cur: GameState,
  rolloutPolicy: HeuristicV2ProfileId,
  horizon: number,
): GameState {
  if (cur.phase === "gameOver" || horizon <= 0) return cur;
  let s = cur;
  for (let step = 0; step < horizon; step++) {
    if (s.phase === "gameOver") return s;
    if (!s.pendingDecision) break;
    try {
      s = applyDecision(db, s, heuristicAiDecision(db, s, rolloutPolicy), { execMode: "search" });
    } catch {
      break;
    }
  }
  return s;
}

function leafEvalFor(db: CardDb, cur: GameState, perspective: PlayerId, valueModel: ValueModel | undefined, knownDecks: KnownDecks | undefined): number {
  if (cur.phase === "gameOver") return cur.winner === perspective ? 1 : 0;
  return clamp01(evaluateShapedStateValue(db, cur, perspective, 0, valueModel, knownDecks));
}

function leafEvalVector(
  db: CardDb,
  cur: GameState,
  rolloutPolicy: HeuristicV2ProfileId,
  leafRolloutHorizon: number,
  valueModel: ValueModel | undefined,
  knownDecks: KnownDecks | undefined,
): [number, number] {
  const leaf = leafStateAfterRollout(db, cur, rolloutPolicy, leafRolloutHorizon);
  return [leafEvalFor(db, leaf, 0, valueModel, knownDecks), leafEvalFor(db, leaf, 1, valueModel, knownDecks)];
}

function iterate(
  db: CardDb,
  roots: readonly [MoNode, MoNode],
  world: GameState,
  explorationC: number,
  candidateLimit: number,
  rolloutPolicy: HeuristicV2ProfileId,
  leafRolloutHorizon: number,
  valueModel: ValueModel | undefined,
  knownDecks: KnownDecks | undefined,
): [number, number] {
  const cursors: [MoNode, MoNode] = [roots[0], roots[1]];
  const path: Array<{ node: MoNode; key: string }> = [];
  let cur = world;

  while (cur.phase !== "gameOver") {
    const pd = cur.pendingDecision;
    if (!pd) break;
    const actor = pd.player as PlayerId;
    const actorNode = cursors[actor];
    const legal = legalEntries(db, cur, actor, candidateLimit, rolloutPolicy);
    if (legal.length === 0) break;

    for (const entry of legal) {
      actorNode.availability.set(entry.key, (actorNode.availability.get(entry.key) ?? 0) + 1);
    }

    const unexpanded = legal.filter((entry) => !actorNode.children.has(entry.key));
    let chosen = unexpanded[0];
    if (!chosen) {
      let bestScore = -Infinity;
      for (const entry of legal) {
        const child = actorNode.children.get(entry.key)!;
        const avail = actorNode.availability.get(entry.key) ?? 1;
        const score = ucbScore(child.visits, child.valueSumByPlayer[actor], avail, true, explorationC);
        if (score > bestScore) {
          bestScore = score;
          chosen = entry;
        }
      }
    }
    if (!chosen) break;

    const before = cur;
    let after: GameState;
    try {
      after = applyDecision(db, cur, chosen.decision, { execMode: "search" });
    } catch {
      break;
    }

    for (const viewer of [0, 1] as const) {
      const key = observableProjection(chosen.decision, { actor, viewer, before, after });
      const node = cursors[viewer];
      let child = node.children.get(key);
      if (!child) {
        child = newNode();
        node.children.set(key, child);
      }
      path.push({ node, key });
      cursors[viewer] = child;
    }
    cur = after;
  }

  const value = leafEvalVector(db, cur, rolloutPolicy, leafRolloutHorizon, valueModel, knownDecks);
  for (const step of path) {
    const child = step.node.children.get(step.key)!;
    child.visits++;
    child.valueSumByPlayer[0] += value[0];
    child.valueSumByPlayer[1] += value[1];
  }
  return value;
}

function estimateFromChild(
  db: CardDb,
  state: GameState,
  decision: Decision,
  child: MoNode,
  perspective: PlayerId,
): CoachActionEstimate {
  const winRate = child.visits === 0 ? 0 : child.valueSumByPlayer[perspective] / child.visits;
  const confidence = confidenceFromRate(child.visits, winRate);
  return {
    decision,
    label: describeDecision(db, state, decision),
    winRate,
    confidence,
    sampleCount: child.visits,
    wins: Math.round(winRate * child.visits),
    errors: 0,
    maxSteps: 0,
    principalLine: [],
    explanation: `MO-ISMCTS：${child.visits} 次多觀察者樹內訪問，估計勝率 ${Math.round(winRate * 100)}%（依各玩家可觀察資訊更新 edge key）。`,
  };
}

function fallbackEstimate(db: CardDb, state: GameState, decision: Decision): CoachActionEstimate {
  return {
    decision,
    label: describeDecision(db, state, decision),
    winRate: 0,
    confidence: 0,
    sampleCount: 0,
    wins: 0,
    errors: 0,
    maxSteps: 0,
    principalLine: [],
    explanation: "MO-ISMCTS：未完成任何 iteration，回傳 heuristic fallback。",
  };
}

export function createMoIsmctsReport(db: CardDb, state: GameState, options: MoIsmctsOptions = {}): CoachReport {
  const pd = state.pendingDecision;
  if (!pd) throw new Error("沒有待決策，無法產生 MO-ISMCTS 建議");
  const actingPlayer = pd.player as PlayerId;
  const perspective = options.perspectivePlayer ?? actingPlayer;
  if (perspective !== actingPlayer) {
    throw new Error("MO-ISMCTS Phase I 只支援目前決策玩家的視角");
  }

  const knownDecks = options.knownDecks ?? inferKnownDecks(state);
  const explorationC = options.explorationC ?? DEFAULT_EXPLORATION_C;
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const rolloutPolicy = options.rolloutPolicy ?? "heuristic-v2";
  const leafRolloutHorizon = Math.max(0, Math.floor(options.leafRolloutHorizon ?? 40));
  const valueModel = options.valueModel;
  const baseSeed = options.seed ?? state.rngState ?? 1;
  const iterationCap =
    options.iterations !== undefined
      ? Math.max(0, Math.floor(options.iterations))
      : options.timeLimitMs !== undefined
        ? 1_000_000
        : DEFAULT_ITERATIONS;
  const deadline = options.timeLimitMs === undefined ? Infinity : Date.now() + Math.max(0, options.timeLimitMs);
  const fallbackDecision = heuristicAiDecision(db, state, rolloutPolicy);

  const roots: [MoNode, MoNode] = [newNode(), newNode()];
  let completed = 0;
  let timedOut = false;
  for (let iter = 0; iter < iterationCap; iter++) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const world = determinizeHiddenState(state, perspective, knownDecks, baseSeed + iter * SEED_STRIDE);
    iterate(db, roots, world, explorationC, candidateLimit, rolloutPolicy, leafRolloutHorizon, valueModel, knownDecks);
    completed++;
  }

  const rootLegal = legalEntries(db, state, perspective, candidateLimit, rolloutPolicy);
  const legalByKey = new Map(rootLegal.map((entry) => [entry.key, entry.decision] as const));
  const recommendations: CoachActionEstimate[] = [];
  for (const [key, child] of roots[perspective].children) {
    const decision = legalByKey.get(key);
    if (!decision) continue;
    recommendations.push(estimateFromChild(db, state, decision, child, perspective));
  }
  recommendations.sort((a, b) => b.sampleCount - a.sampleCount || b.winRate - a.winRate || b.confidence - a.confidence);
  const bestAction = recommendations[0] ?? fallbackEstimate(db, state, fallbackDecision);

  return {
    kind: "mo-ismcts-coach-v1",
    perspectivePlayer: perspective,
    actingPlayer,
    pendingType: pd.type,
    rolloutPolicy,
    requestedSamplesPerAction: iterationCap,
    completedSamples: completed,
    timedOut,
    fallbackDecision,
    bestAction,
    recommendations,
  };
}

export const __moIsmctsTest = {
  newNode,
  iterate,
};
