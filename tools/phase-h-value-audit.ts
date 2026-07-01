import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { benchmarkDb } from "../src/ai/benchmark-fixtures";
import { createFreeAttackGateState } from "../src/ai/phase-h-gate-control";
import {
  analyzeGateValuePair,
  auditReplaySession,
  summarizeGateValuePairs,
  type PhaseHGateValuePair,
  type PhaseHValueAuditOptions,
} from "../src/ai/phase-h-value-audit";
import type { ValueModel } from "../src/ai/rollout-value";
import type { ReplaySession } from "../src/ui/replayHistory";

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function replayFiles(): string[] {
  const file = argValue("file", "");
  if (file) return [file];
  const dir = argValue("dir", join("data", "replays"));
  if (!existsSync(dir)) return [];
  const limit = Number(argValue("limit", "0"));
  const files = readdirSync(dir)
    .filter((candidate) => candidate.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((candidate) => join(dir, candidate));
  return limit > 0 ? files.slice(-limit) : files;
}

function readReplay(file: string): ReplaySession | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ReplaySession;
  } catch (error) {
    console.warn(`Skip unreadable replay ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readModel(file: string): ValueModel | undefined {
  if (!file) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const model = isValueModel(parsed)
    ? parsed
    : isObject(parsed) && isValueModel(parsed.model)
      ? parsed.model
      : undefined;
  if (!model || !Array.isArray(model.weights) || typeof model.bias !== "number") {
    throw new Error(`Invalid ValueModel file: ${file}`);
  }
  return model;
}

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

function formatPair(pair: PhaseHGateValuePair): string {
  const actual = pair.actualAccept === null ? "n/a" : String(pair.actualAccept);
  return (
    `${pair.label} player=${pair.player} actualAccept=${actual} ` +
    `valueDelta=${pair.valueDelta.toFixed(4)} pressureDelta=${pair.pressureDelta.toFixed(4)} ` +
    `acceptValue=${pair.acceptValue.toFixed(4)} declineValue=${pair.declineValue.toFixed(4)}`
  );
}

const options: PhaseHValueAuditOptions = {
  model: readModel(argValue("model-file", "")),
  minPressureDelta: Number(argValue("min-pressure-delta", "0")),
  tieEpsilon: Number(argValue("tie-epsilon", "0.000001")),
};
const pairs: PhaseHGateValuePair[] = [];
const includeSynthetic = !hasFlag("no-synthetic") || hasFlag("include-synthetic");
if (includeSynthetic) {
  const synthetic = analyzeGateValuePair(
    benchmarkDb,
    createFreeAttackGateState(benchmarkDb, Number(argValue("seed", "940"))),
    "synthetic:free-attack-gate",
    options,
  );
  if (synthetic) pairs.push(synthetic);
}

for (const file of replayFiles()) {
  const session = readReplay(file);
  if (!session) continue;
  pairs.push(...auditReplaySession(benchmarkDb, session, file, options).pairs);
}

const summary = summarizeGateValuePairs(pairs, options);
const topCount = Number(argValue("top", "10"));
const topFailures = [...pairs]
  .sort((a, b) => a.valueDelta - b.valueDelta || b.pressureDelta - a.pressureDelta)
  .slice(0, topCount);

console.log("Phase-H-Value-Audit");
console.log(
  `pairs=${summary.totalPairs}, valueCorrect=${summary.valueCorrect}, valueTied=${summary.valueTied}, valueWrong=${summary.valueWrong}`,
);
console.log(
  `averageValueDelta=${summary.averageValueDelta.toFixed(4)}, averagePressureDelta=${summary.averagePressureDelta.toFixed(4)}`,
);
console.log("Top value failures/ties among gate-positive pairs:");
for (const pair of topFailures) console.log(`- ${formatPair(pair)}`);

const out = argValue("out", "");
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ summary, pairs }, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}
