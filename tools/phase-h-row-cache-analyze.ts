import { readFileSync } from "node:fs";
import { numberArg, stringArg } from "../src/shared/argv";
import { VALUE_FEATURE_NAMES, type ValueModel } from "../src/ai/rollout-value";
import type { PhaseHOutcomeRow } from "../src/ai/phase-h-value-fit";

interface CachedOutcomeRow extends PhaseHOutcomeRow {
  gameIndex: number;
}

interface OutcomeCacheGame {
  gameIndex: number;
  seed: number;
  decks: [string, string];
  status: "complete" | "skipped";
  winner: 0 | 1 | null;
  rowCount: number;
  reason?: string;
}

interface OutcomeRowCache {
  schemaVersion: number;
  kind: string;
  rows: CachedOutcomeRow[];
  games: OutcomeCacheGame[];
}

interface AnalysisRow extends CachedOutcomeRow {
  index: number;
  localIndex: number;
  perspective: 0 | 1;
  game: OutcomeCacheGame;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function rawScore(model: ValueModel, x: readonly number[]): number {
  let z = model.bias;
  for (let i = 0; i < model.weights.length; i++) z += (model.weights[i] ?? 0) * (x[i] ?? 0);
  return z;
}

function auc(rows: readonly { p: number; y: number }[]): number {
  const sorted = rows.slice().sort((a, b) => a.p - b.p);
  let rankSum = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j]!.p === sorted[i]!.p) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (sorted[k]!.y === 1) rankSum += avgRank;
    i = j;
  }
  const positives = rows.reduce((sum, row) => sum + row.y, 0);
  const negatives = rows.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function accuracy(rows: readonly { p: number; y: number }[]): number {
  if (rows.length === 0) return 0;
  return rows.filter((row) => (row.p >= 0.5 ? 1 : 0) === row.y).length / rows.length;
}

function bucketSetLife(value: number): string {
  if (value <= -2) return "setLife<=-2";
  if (value === -1) return "setLife=-1";
  if (value === 0) return "setLife=0";
  if (value === 1) return "setLife=+1";
  return "setLife>=+2";
}

function modelFromFile(path: string): ValueModel {
  const json = JSON.parse(readFileSync(path, "utf8")) as { model?: ValueModel } | ValueModel;
  if ("model" in json && json.model) return json.model;
  return json as ValueModel;
}

function groupBy(rows: readonly AnalysisRow[], keyFn: (row: AnalysisRow) => string): Map<string, AnalysisRow[]> {
  const groups = new Map<string, AnalysisRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function summarizeGroup(name: string, rows: readonly AnalysisRow[], model: ValueModel): string {
  const scored = rows.map((row) => ({ p: sigmoid(rawScore(model, row.x)), y: row.y }));
  const pos = rows.reduce((sum, row) => sum + row.y, 0);
  const pMean = scored.reduce((sum, row) => sum + row.p, 0) / Math.max(1, scored.length);
  const yMean = pos / Math.max(1, rows.length);
  return `${name}: rows=${rows.length}, pos=${pos}, yRate=${yMean.toFixed(3)}, predMean=${pMean.toFixed(3)}, acc=${accuracy(scored).toFixed(3)}, auc=${auc(scored).toFixed(4)}`;
}

function printTopGroups(title: string, groups: Map<string, AnalysisRow[]>, model: ValueModel, top: number): void {
  console.log(`\n${title}`);
  [...groups.entries()]
    .filter(([, rows]) => rows.length >= numberArg("min-group-rows", 40))
    .map(([name, rows]) => ({ name, rows, auc: auc(rows.map((row) => ({ p: sigmoid(rawScore(model, row.x)), y: row.y }))) }))
    .sort((a, b) => a.auc - b.auc)
    .slice(0, top)
    .forEach(({ name, rows }) => console.log(`- ${summarizeGroup(name, rows, model)}`));
}

function printFeatureDeltas(rows: readonly AnalysisRow[]): void {
  const positives = rows.filter((row) => row.y === 1);
  const negatives = rows.filter((row) => row.y === 0);
  const deltas = VALUE_FEATURE_NAMES.map((name, index) => {
    const posMean = positives.reduce((sum, row) => sum + (row.x[index] ?? 0), 0) / Math.max(1, positives.length);
    const negMean = negatives.reduce((sum, row) => sum + (row.x[index] ?? 0), 0) / Math.max(1, negatives.length);
    return { name, posMean, negMean, delta: posMean - negMean };
  });
  console.log("\nFeature means, positive minus negative outcome");
  for (const item of deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
    console.log(`- ${item.name}: delta=${item.delta.toFixed(4)} pos=${item.posMean.toFixed(4)} neg=${item.negMean.toFixed(4)}`);
  }
}

function printFeatureDeltasForGroup(name: string, rows: readonly AnalysisRow[], limit: number): void {
  const positives = rows.filter((row) => row.y === 1);
  const negatives = rows.filter((row) => row.y === 0);
  const deltas = VALUE_FEATURE_NAMES.map((featureName, index) => {
    const posMean = positives.reduce((sum, row) => sum + (row.x[index] ?? 0), 0) / Math.max(1, positives.length);
    const negMean = negatives.reduce((sum, row) => sum + (row.x[index] ?? 0), 0) / Math.max(1, negatives.length);
    return { featureName, delta: posMean - negMean, posMean, negMean };
  });
  console.log(`\nFeature deltas in ${name}`);
  for (const item of deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, limit)) {
    console.log(`- ${item.featureName}: delta=${item.delta.toFixed(4)} pos=${item.posMean.toFixed(4)} neg=${item.negMean.toFixed(4)}`);
  }
}

function printGameOutcomes(title: string, games: readonly OutcomeCacheGame[], keyFn: (game: OutcomeCacheGame) => string, topCount: number): void {
  const groups = new Map<string, { total: number; p0Wins: number; p1Wins: number }>();
  for (const game of games) {
    if (game.status !== "complete" || game.winner === null) continue;
    const key = keyFn(game);
    const group = groups.get(key) ?? { total: 0, p0Wins: 0, p1Wins: 0 };
    group.total++;
    if (game.winner === 0) group.p0Wins++;
    else group.p1Wins++;
    groups.set(key, group);
  }
  console.log(`\n${title}`);
  [...groups.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .slice(0, topCount)
    .forEach(([name, group]) => {
      console.log(`- ${name}: games=${group.total}, P0=${group.p0Wins}, P1=${group.p1Wins}`);
    });
}

function printExclusionSensitivity(rows: readonly AnalysisRow[], model: ValueModel, keyFn: (row: AnalysisRow) => string, topCount: number): void {
  const groups = [...groupBy(rows, keyFn).entries()]
    .filter(([, groupRows]) => groupRows.length >= numberArg("min-group-rows", 40))
    .map(([name, groupRows]) => ({ name, groupRows, auc: auc(groupRows.map((row) => ({ p: sigmoid(rawScore(model, row.x)), y: row.y }))) }))
    .sort((a, b) => a.auc - b.auc)
    .slice(0, topCount);
  console.log("\nAUC after excluding weakest buckets one at a time");
  for (const group of groups) {
    const kept = rows.filter((row) => keyFn(row) !== group.name);
    console.log(`- without ${group.name}: rows=${kept.length}, auc=${auc(kept.map((row) => ({ p: sigmoid(rawScore(model, row.x)), y: row.y }))).toFixed(4)} (excluded bucket auc=${group.auc.toFixed(4)})`);
  }
}

const cachePath = stringArg("cache", "data/ab/phase-h-outcome-rows-so-leaf40-i16.json");
const modelPath = stringArg("model-file", "data/ab/phase-h-value-fit-so-leaf40-g80-nn.json");
const top = numberArg("top", 12);
const cache = JSON.parse(readFileSync(cachePath, "utf8")) as OutcomeRowCache;
const model = modelFromFile(modelPath);
const games = new Map(cache.games.map((game) => [game.gameIndex, game]));
const localCounts = new Map<number, number>();
const rows: AnalysisRow[] = cache.rows.flatMap((row, index) => {
  const game = games.get(row.gameIndex);
  if (!game || game.status !== "complete") return [];
  const localIndex = localCounts.get(row.gameIndex) ?? 0;
  localCounts.set(row.gameIndex, localIndex + 1);
  return [{ ...row, index, localIndex, perspective: (localIndex % 2) as 0 | 1, game }];
});

console.log(`Phase-H Row Cache Analysis`);
console.log(`cache=${cachePath}`);
console.log(`model=${modelPath}`);
console.log(summarizeGroup("overall", rows, model));
console.log(`games=${cache.games.length}, complete=${cache.games.filter((game) => game.status === "complete").length}, skipped=${cache.games.filter((game) => game.status !== "complete").length}`);

printTopGroups("Weakest oriented deck-pair buckets", groupBy(rows, (row) => `${row.game.decks[0]} vs ${row.game.decks[1]}`), model, top);
printTopGroups("Weakest unordered matchup buckets", groupBy(rows, (row) => row.game.decks.slice().sort().join(" <> ")), model, top);
printExclusionSensitivity(rows, model, (row) => row.game.decks.slice().sort().join(" <> "), Math.min(6, top));
printGameOutcomes("Game outcomes by oriented deck-pair", cache.games, (game) => `${game.decks[0]} vs ${game.decks[1]}`, top);
printGameOutcomes("Game outcomes by unordered matchup", cache.games, (game) => game.decks.slice().sort().join(" <> "), top);
printTopGroups("Buckets by perspective seat", groupBy(rows, (row) => `perspective=P${row.perspective}`), model, top);
printTopGroups("Buckets by winner seat", groupBy(rows, (row) => `winner=P${row.game.winner}`), model, top);
printTopGroups("Buckets by setLifeDiff", groupBy(rows, (row) => bucketSetLife(row.x[0] ?? 0)), model, top);
printTopGroups("Buckets by turnMine", groupBy(rows, (row) => `turnMine=${row.x[6] ?? 0}`), model, top);
printTopGroups("Buckets by serving", groupBy(rows, (row) => `serving=${row.x[5] ?? 0}`), model, top);
printFeatureDeltas(rows);

const weakestGroups = [...groupBy(rows, (row) => `${row.game.decks[0]} vs ${row.game.decks[1]}`).entries()]
  .filter(([, groupRows]) => groupRows.length >= numberArg("min-group-rows", 40))
  .map(([name, groupRows]) => ({ name, groupRows, auc: auc(groupRows.map((row) => ({ p: sigmoid(rawScore(model, row.x)), y: row.y }))) }))
  .sort((a, b) => a.auc - b.auc)
  .slice(0, Math.min(3, top));
for (const group of weakestGroups) printFeatureDeltasForGroup(group.name, group.groupRows, 8);
