import { applyDecision, createGame, effParam } from "../src/engine/engine";
import type { GameState, PlayerId } from "../src/engine/types";
import { benchmarkDb } from "../src/ai/benchmark-fixtures";
import { createIsmctsReport } from "../src/ai/ismcts";
import type { ValueModel } from "../src/ai/rollout-value";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

const H5_FILLER = "HV-D01-005";

interface ProbeRow {
  seed: number;
  scenario: "rich" | "poor";
  mode: "tieBreakOff" | "liveDefault";
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

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

function argNum(name: string, fallback: number): number {
  const value = Number(argValue(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
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
  throw new Error(`K1.5 behavior probe fixture cannot find ${cardId}`);
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
  state.pendingDecision = { player: 0, type: "deploy-attack", prompt: "K1.5 behavior probe" };
  state.effectCtx = null;
  state.pendingQueue = [];
  return { state, weakUid, strongUid, decks };
}

function loadValueModel(path: string): ValueModel {
  const payload = JSON.parse(readFileSync(path, "utf8")) as { model?: ValueModel };
  if (!payload.model) throw new Error(`missing model in ${path}`);
  return payload.model;
}

function bestUid(rowState: GameState, decision: ProbeRow["bestUid"] | unknown): number | null {
  if (decision && typeof decision === "object" && "uid" in decision) {
    const uid = (decision as { uid?: unknown }).uid;
    return typeof uid === "number" ? uid : null;
  }
  return rowState.pendingDecision?.type.startsWith("deploy-") ? null : null;
}

function runOne(
  seed: number,
  scenario: "rich" | "poor",
  mode: "tieBreakOff" | "liveDefault",
  valueModel: ValueModel,
  iterations: number,
): ProbeRow {
  const built = buildH5StraddleScenario(seed, scenario === "rich" ? 2 : 1);
  const expectedUid = scenario === "rich" ? built.strongUid : built.weakUid;
  const report = createIsmctsReport(benchmarkDb, built.state, {
    perspectivePlayer: 0,
    knownDecks: built.decks,
    seed,
    iterations,
    candidateLimit: 8,
    leafRolloutHorizon: 4,
    valueModel,
    ...(mode === "tieBreakOff"
      ? {
          rootPressureTieBreakDelta: 0,
          rootPairQualityTieBreak: false,
          rootConservationWinRateThreshold: Number.POSITIVE_INFINITY,
        }
      : {}),
  });
  const uid = bestUid(built.state, report.bestAction.decision);
  return {
    seed,
    scenario,
    mode,
    expectedUid,
    expectedCardId: built.state.cards[expectedUid]!,
    bestUid: uid,
    bestCardId: uid === null ? null : built.state.cards[uid] ?? null,
    bestAttack: uid === null ? null : effParam(benchmarkDb, built.state, uid, "attack") ?? null,
    correct: uid === expectedUid,
    winRate: report.bestAction.winRate,
    sampleCount: report.bestAction.sampleCount,
    completedSamples: report.completedSamples,
  };
}

const modelPath = argValue("model", "data/ab/phase-k-k1-feature-v1-selected-fit-holdout-g500-i16.json");
const outPath = argValue("out", "data/ab/phase-k-k15-behavior-probe-selected-v1.json");
const seedStart = argNum("seed-start", 970);
const seeds = argNum("seeds", 5);
const iterations = argNum("iterations", 800);
const valueModel = loadValueModel(modelPath);
const rows: ProbeRow[] = [];

for (let offset = 0; offset < seeds; offset++) {
  const seed = seedStart + offset;
  for (const scenario of ["rich", "poor"] as const) {
    for (const mode of ["tieBreakOff", "liveDefault"] as const) {
      rows.push(runOne(seed, scenario, mode, valueModel, iterations));
    }
  }
}

const summary = Object.fromEntries(
  (["tieBreakOff", "liveDefault"] as const).map((mode) => [
    mode,
    Object.fromEntries(
      (["rich", "poor"] as const).map((scenario) => {
        const subset = rows.filter((row) => row.mode === mode && row.scenario === scenario);
        return [scenario, { correct: subset.filter((row) => row.correct).length, total: subset.length }];
      }),
    ),
  ]),
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      modelPath,
      seedStart,
      seeds,
      iterations,
      summary,
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ outPath, summary }, null, 2));
