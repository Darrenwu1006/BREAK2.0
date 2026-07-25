import process from "node:process";
import { stringArg } from "../src/shared/argv";
import { readFileSync } from "node:fs";
import { benchmarkDb } from "../src/ai/benchmark-fixtures";
import { createIsmctsReport, rootDecisionPressureScore } from "../src/ai/ismcts";
import { enumerateCandidates } from "../src/ai/coach";
import { describeDecision } from "../src/shared/decisionLabels";
import { heuristicAiDecision } from "../src/ai/heuristic";
import { runPhaseHFreeAttackGateControl } from "../src/ai/phase-h-gate-control";
import type { Decision, GameState } from "../src/engine/types";
import type { ReplaySession } from "../src/shared/replayHistory";
import type { ValueModel } from "../src/ai/rollout-value";

const seed = Number(stringArg("seed", "940"));
const iterations = Number(stringArg("iterations", "120"));
const leafRolloutHorizon = Number(stringArg("leaf-rollout-horizon", "40"));
const rootPressureTieBreakDelta = Number(stringArg("root-pressure-delta", "0.03"));
const replayFile = stringArg("replay-file", "");
const entryIndex = Number(stringArg("entry", "54"));
const valueModel = readModel(stringArg("model-file", ""));

function isObject(value: unknown): value is { model?: unknown } {
  return typeof value === "object" && value !== null;
}

function isValueModel(value: unknown): value is ValueModel {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ValueModel).weights) &&
    typeof (value as ValueModel).bias === "number"
  );
}

function readModel(file: string): ValueModel | undefined {
  if (!file) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const model = isValueModel(parsed)
    ? parsed
    : isObject(parsed) && isValueModel(parsed.model)
      ? parsed.model
      : undefined;
  if (!model) throw new Error(`Invalid ValueModel file: ${file}`);
  return model;
}

function knownDecksFromReplay(session: ReplaySession): [string[], string[]] {
  return [session.decks[0].cardIds, session.decks[1].cardIds];
}

function acceptOf(decision: Decision): boolean | null {
  return decision.type === "effect-confirm" ? decision.accept : null;
}

if (replayFile) {
  const session = JSON.parse(readFileSync(replayFile, "utf8")) as ReplaySession;
  const entry = session.entries[entryIndex];
  if (!entry) throw new Error(`Replay entry ${entryIndex} not found`);
  const state = entry.before as GameState;
  const player = state.pendingDecision?.player ?? entry.player;
  const fallback = heuristicAiDecision(benchmarkDb, state, "heuristic-v2-burst");
  const candidates = enumerateCandidates(benchmarkDb, state, 4, fallback).filter((decision) => decision.type === "effect-confirm");
  const base = createIsmctsReport(benchmarkDb, state, {
    perspectivePlayer: player,
    knownDecks: knownDecksFromReplay(session),
    iterations,
    candidateLimit: 4,
    leafRolloutHorizon,
      rolloutPolicy: "heuristic-v2-burst",
      seed: seed + 101,
      valueModel,
    });
  const rootPressure = createIsmctsReport(benchmarkDb, state, {
    perspectivePlayer: player,
    knownDecks: knownDecksFromReplay(session),
    iterations,
    candidateLimit: 4,
    leafRolloutHorizon,
      rolloutPolicy: "heuristic-v2-burst",
      rootPressureTieBreakDelta,
      seed: seed + 101,
      valueModel,
    });

  console.log(`Phase-H-Gate-Control: replay entry ${entryIndex}`);
  console.log(`Replay: ${replayFile}`);
  console.log(`Actual decision: ${describeDecision(benchmarkDb, state, entry.decision)}, accept=${acceptOf(entry.decision)}`);
  console.log(`Candidates: ${candidates.map((decision) => describeDecision(benchmarkDb, state, decision)).join(" / ")}`);
  console.log(`Heuristic fallback: ${describeDecision(benchmarkDb, state, fallback)}, accept=${acceptOf(fallback)}`);
  for (const [label, report] of [["is-mcts", base], ["is-mcts-root-pressure", rootPressure]] as const) {
    console.log(
      `- ${label}: ${report.bestAction.label}, accept=${acceptOf(report.bestAction.decision)}, ` +
        `iterations=${report.completedSamples}, timeout=${report.timedOut}`,
    );
    for (const rec of report.recommendations) {
      console.log(
        `  - candidate ${rec.label}: accept=${acceptOf(rec.decision)}, visits=${rec.sampleCount}, ` +
          `winRate=${rec.winRate.toFixed(3)}, pressure=${rootDecisionPressureScore(benchmarkDb, state, rec.decision, player).toFixed(4)}`,
      );
    }
  }
  process.exit(0);
}

const report = runPhaseHFreeAttackGateControl(benchmarkDb, {
  seed,
  iterations,
  leafRolloutHorizon,
  rootPressureTieBreakDelta,
  valueModel,
});

console.log(`Phase-H-Gate-Control: ${report.scenario}`);
console.log(report.description);
console.log(`Candidates: ${report.candidateLabels.join(" / ")}`);
console.log(
  `Attack point: before=${report.beforeAttackPoint}, accept=${report.acceptAttackPoint}, decline=${report.declineAttackPoint}`,
);
console.log("Policy choices:");
for (const item of report.results) {
  console.log(
    `- ${item.policy}: ${item.bestLabel}, accept=${item.accept}, attack=${item.resultingAttackPoint ?? "n/a"}, ` +
      `iterations=${item.completedIterations ?? "n/a"}, timeout=${item.timedOut ?? "n/a"}`,
  );
  for (const rec of item.recommendations) {
    console.log(
      `  - candidate ${rec.label}: accept=${rec.accept}, visits=${rec.visits}, ` +
        `winRate=${rec.winRate.toFixed(3)}, pressure=${rec.pressureScore.toFixed(4)}`,
    );
  }
}
