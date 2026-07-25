import { applyDecision, effParam } from "../src/engine/engine";
import { numberArg, stringArg } from "../src/shared/argv";
import type { Decision, GameState, PlayerId } from "../src/engine/types";
import { heuristicAiDecision } from "../src/ai/heuristic";
import { benchmarkDb } from "../src/ai/benchmark-fixtures";
import { determinizeHiddenState, enumerateCandidates } from "../src/ai/coach";
import { describeDecision } from "../src/shared/decisionLabels";
import { ucbScore } from "../src/ai/ismcts";
import { phaseKMlpProbability, type PhaseKMlpValueModel } from "../src/ai/phase-k-mlp-value";
import { extractValueFeatures } from "../src/ai/rollout-value";
import { createGame } from "../src/engine/engine";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const H5_FILLER = "HV-D01-005";
const SEED_STRIDE = 1000003;

interface ProbeRow {
  seed: number;
  scenario: "rich" | "poor";
  expectedUid: number;
  expectedCardId: string;
  bestUid: number | null;
  bestCardId: string | null;
  bestAttack: number | null;
  correct: boolean;
  winRate: number;
  sampleCount: number;
  completedSamples: number;
}

interface Node {
  children: Map<string, Node>;
  availability: Map<string, number>;
  visits: number;
  valueSum: number;
}

function node(): Node {
  return { children: new Map(), availability: new Map(), visits: 0, valueSum: 0 };
}

function h5MoveToHand(state: GameState, p: PlayerId, cardId: string, used: Set<number>): number {
  const zones: (keyof GameState["players"][number])[] = ["hand", "deck", "setArea", "drop"];
  for (const zone of zones) {
    const arr = state.players[p][zone] as number[];
    const idx = arr.findIndex((uid) => !used.has(uid) && state.cards[uid] === cardId);
    if (idx < 0) continue;
    const [uid] = arr.splice(idx, 1);
    used.add(uid!);
    state.players[p].hand.push(uid!);
    return uid!;
  }
  throw new Error(`K4 behavior probe fixture cannot find ${cardId}`);
}

function h5MoveToToss(state: GameState, p: PlayerId, cardId: string, used: Set<number>): number {
  const uid = h5MoveToHand(state, p, cardId, used);
  state.players[p].hand.pop();
  state.players[p].toss.push(uid);
  return uid;
}

function h5KeepOnlyHand(state: GameState, p: PlayerId, uids: number[]): void {
  const keep = new Set(uids);
  for (let i = state.players[p].hand.length - 1; i >= 0; i--) {
    const uid = state.players[p].hand[i]!;
    if (!keep.has(uid)) state.players[p].deck.push(state.players[p].hand.splice(i, 1)[0]!);
  }
}

function buildH5StraddleScenario(seed: number, p1RichCount: 1 | 2) {
  const p0Toss = "HV-P03-022";
  const p0Weak = "HV-D01-002";
  const p0Strong = "HV-D01-006";
  const p1Rich = ["HV-D01-006", "HV-D01-001"];
  const decks: [string[], string[]] = [
    Array(40)
      .fill(H5_FILLER)
      .map((f, i) => (i < 3 ? [p0Toss, p0Weak, p0Strong][i]! : f)),
    Array(40)
      .fill(H5_FILLER)
      .map((f, i) => (i < p1Rich.length ? p1Rich[i]! : f)),
  ];
  let state = createGame(benchmarkDb, { seed, decks, skipDeckValidation: true });
  state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });

  const used = new Set<number>();
  h5MoveToToss(state, 0, p0Toss, used);
  const weakUid = h5MoveToHand(state, 0, p0Weak, used);
  const strongUid = h5MoveToHand(state, 0, p0Strong, used);
  h5KeepOnlyHand(state, 0, [weakUid, strongUid]);

  const richUids = p1Rich.map((cardId) => h5MoveToHand(state, 1, cardId, used));
  h5KeepOnlyHand(state, 1, p1RichCount === 2 ? richUids : [richUids[0]!]);

  state.turnPlayer = 0;
  state.phase = "attack";
  state.sub = 0;
  state.op = null;
  state.dp = null;
  state.defenseChoice = null;
  state.pendingDecision = { player: 0, type: "deploy-attack", prompt: "K4 behavior probe" };
  state.effectCtx = null;
  state.pendingQueue = [];
  return { state, weakUid, strongUid, decks };
}

function loadMlp(path: string): PhaseKMlpValueModel {
  const payload = JSON.parse(readFileSync(path, "utf8")) as { model?: PhaseKMlpValueModel };
  if (!payload.model) throw new Error(`missing model in ${path}`);
  return payload.model;
}

function legalEntries(cur: GameState, candidateLimit: number) {
  const fallback = heuristicAiDecision(benchmarkDb, cur, "heuristic-v2");
  return enumerateCandidates(benchmarkDb, cur, candidateLimit, fallback).map((decision) => ({
    key: JSON.stringify(decision),
    decision,
  }));
}

function mlpProbability(model: PhaseKMlpValueModel, state: GameState, perspective: PlayerId, knownDecks: readonly [readonly string[], readonly string[]]): number {
  return phaseKMlpProbability(model, extractValueFeatures(state, perspective, benchmarkDb, { knownDecks }));
}

function iterate(root: Node, world: GameState, perspective: PlayerId, model: PhaseKMlpValueModel, knownDecks: readonly [readonly string[], readonly string[]], candidateLimit: number, leafHorizon: number): void {
  let cur = world;
  let current = root;
  const path: Array<{ node: Node; key: string }> = [];
  while (cur.phase !== "gameOver") {
    if (!cur.pendingDecision) break;
    if (cur.pendingDecision.player !== perspective) {
      try {
        cur = applyDecision(benchmarkDb, cur, heuristicAiDecision(benchmarkDb, cur, "heuristic-v2"), { execMode: "search" });
      } catch {
        break;
      }
      continue;
    }
    const legal = legalEntries(cur, candidateLimit);
    for (const entry of legal) current.availability.set(entry.key, (current.availability.get(entry.key) ?? 0) + 1);
    const unexpanded = legal.find((entry) => !current.children.has(entry.key));
    if (unexpanded) {
      const child = node();
      current.children.set(unexpanded.key, child);
      cur = applyDecision(benchmarkDb, cur, unexpanded.decision, { execMode: "search" });
      path.push({ node: current, key: unexpanded.key });
      current = child;
      break;
    }
    let best = legal[0]!;
    let bestScore = -Infinity;
    for (const entry of legal) {
      const child = current.children.get(entry.key)!;
      const score = ucbScore(child.visits, child.valueSum, current.availability.get(entry.key) ?? 1, true, Math.SQRT2);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    cur = applyDecision(benchmarkDb, cur, best.decision, { execMode: "search" });
    path.push({ node: current, key: best.key });
    current = current.children.get(best.key)!;
  }
  const value =
    cur.phase === "gameOver"
      ? cur.winner === perspective ? 1 : 0
      : (() => {
          let s = cur;
          for (let step = 0; step < leafHorizon; step++) {
            if (s.phase === "gameOver") return s.winner === perspective ? 1 : 0;
            if (!s.pendingDecision) break;
            try {
              s = applyDecision(benchmarkDb, s, heuristicAiDecision(benchmarkDb, s, "heuristic-v2"), { execMode: "search" });
            } catch {
              break;
            }
          }
          if (s.phase === "gameOver") return s.winner === perspective ? 1 : 0;
          return mlpProbability(model, s, perspective, knownDecks);
        })();
  for (const step of path) {
    const child = step.node.children.get(step.key)!;
    child.visits++;
    child.valueSum += value;
  }
}

function bestUid(decision: Decision | undefined): number | null {
  if (decision && "uid" in decision) return typeof decision.uid === "number" ? decision.uid : null;
  return null;
}

function runOne(seed: number, scenario: "rich" | "poor", model: PhaseKMlpValueModel, iterations: number, candidateLimit: number, leafHorizon: number): ProbeRow {
  const built = buildH5StraddleScenario(seed, scenario === "rich" ? 2 : 1);
  const expectedUid = scenario === "rich" ? built.strongUid : built.weakUid;
  const root = node();
  for (let iter = 0; iter < iterations; iter++) {
    const world = determinizeHiddenState(built.state, 0, built.decks, seed + iter * SEED_STRIDE);
    iterate(root, world, 0, model, built.decks, candidateLimit, leafHorizon);
  }
  const legalByKey = new Map(legalEntries(built.state, candidateLimit).map((entry) => [entry.key, entry.decision] as const));
  const recommendations = [...root.children.entries()]
    .map(([key, child]) => ({ key, child, decision: legalByKey.get(key) }))
    .filter((item): item is { key: string; child: Node; decision: Decision } => item.decision !== undefined)
    .map((item) => ({
      decision: item.decision,
      label: describeDecision(benchmarkDb, built.state, item.decision),
      winRate: item.child.visits === 0 ? 0 : item.child.valueSum / item.child.visits,
      sampleCount: item.child.visits,
    }))
    .sort((a, b) => b.sampleCount - a.sampleCount || b.winRate - a.winRate);
  const best = recommendations[0];
  const uid = bestUid(best?.decision);
  return {
    seed,
    scenario,
    expectedUid,
    expectedCardId: built.state.cards[expectedUid]!,
    bestUid: uid,
    bestCardId: uid === null ? null : built.state.cards[uid] ?? null,
    bestAttack: uid === null ? null : effParam(benchmarkDb, built.state, uid, "attack") ?? null,
    correct: uid === expectedUid,
    winRate: best?.winRate ?? 0,
    sampleCount: best?.sampleCount ?? 0,
    completedSamples: iterations,
  };
}

const modelPath = stringArg("model", "data/ab/phase-k-k4-mlp-fit-holdout-g2000-i16.json");
const outPath = stringArg("out", "data/ab/phase-k-k4-behavior-probe-mlp.json");
const seedStart = numberArg("seed-start", 970);
const seeds = numberArg("seeds", 5);
const iterations = numberArg("iterations", 800);
const candidateLimit = numberArg("candidate-limit", 8);
const leafHorizon = numberArg("leaf-horizon", 4);
const model = loadMlp(modelPath);
const rows: ProbeRow[] = [];

for (let offset = 0; offset < seeds; offset++) {
  const seed = seedStart + offset;
  rows.push(runOne(seed, "rich", model, iterations, candidateLimit, leafHorizon));
  rows.push(runOne(seed, "poor", model, iterations, candidateLimit, leafHorizon));
}

const summary = Object.fromEntries(
  (["rich", "poor"] as const).map((scenario) => {
    const subset = rows.filter((row) => row.scenario === scenario);
    return [scenario, { correct: subset.filter((row) => row.correct).length, total: subset.length }];
  }),
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify({ modelPath, seedStart, seeds, iterations, candidateLimit, leafHorizon, mode: "tieBreakOff", summary, rows }, null, 2)}\n`,
);
console.log(JSON.stringify({ outPath, summary }, null, 2));
