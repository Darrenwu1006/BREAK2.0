import process from "node:process";
import { benchmarkDb } from "../src/ai/benchmark-fixtures";
import { runMBluffDropHandControl } from "../src/ai/m-bluff-control";

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

const seed = Number(argValue("seed", "930"));
const iterations = Number(argValue("iterations", "80"));
const report = runMBluffDropHandControl(benchmarkDb, { seed, iterations });

console.log(`M-Bluff-Control: ${report.scenario}`);
console.log(report.description);
console.log(`Candidates: ${report.candidateLabels.join(" / ")}`);
console.log("Opponent projection buckets:");
for (const [index, bucket] of report.opponentBuckets.entries()) {
  console.log(`- bucket ${index + 1}: ${bucket.labels.length} private choices -> ${bucket.labels.join(" / ")}`);
}
console.log("Policy choices:");
for (const item of report.results) {
  console.log(
    `- ${item.policy}: ${item.bestLabel}, private discard cost=${item.privateDiscardCost ?? "n/a"}, ` +
      `bucket size=${item.opponentBucketSize}, iterations=${item.completedIterations}, timeout=${item.timedOut}`,
  );
}
