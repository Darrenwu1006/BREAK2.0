import { mkdirSync, writeFileSync } from "node:fs";
import { numberArg, stringArg } from "../src/shared/argv";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_LADDER_CONFIG,
  LADDER_POLICY_IDS,
  runPolicyLadder,
  type LadderConfig,
  type LadderPolicyId,
} from "../src/ai/policy-ladder";

function parsePolicies(raw: string): LadderPolicyId[] {
  const policies = raw.split(",").map((item) => item.trim()).filter(Boolean);
  const allowed = new Set<string>(LADDER_POLICY_IDS);
  for (const policy of policies) {
    if (!allowed.has(policy)) throw new Error(`Unsupported ladder policy: ${policy}`);
  }
  return policies as LadderPolicyId[];
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

const outPath = stringArg("out", "data/ladder/elo.json");
const policies = parsePolicies(stringArg("policies", DEFAULT_LADDER_CONFIG.policies.join(",")));
const config: LadderConfig = {
  ...DEFAULT_LADDER_CONFIG,
  policies,
  basePolicies: DEFAULT_LADDER_CONFIG.basePolicies.filter((policy) => policies.includes(policy)),
  gamesPerSeat: Math.max(1, Math.floor(numberArg("games", DEFAULT_LADDER_CONFIG.gamesPerSeat))),
  seedStart: Math.floor(numberArg("seed-start", DEFAULT_LADDER_CONFIG.seedStart)),
  maxSteps: Math.max(1, Math.floor(numberArg("max-steps", DEFAULT_LADDER_CONFIG.maxSteps))),
  pimcSamples: Math.max(1, Math.floor(numberArg("pimc-samples", DEFAULT_LADDER_CONFIG.pimcSamples))),
  searchIterations: Math.max(1, Math.floor(numberArg("search-iters", DEFAULT_LADDER_CONFIG.searchIterations))),
  leafRolloutHorizon: Math.max(0, Math.floor(numberArg("leaf-horizon", DEFAULT_LADDER_CONFIG.leafRolloutHorizon))),
  candidateLimit: Math.max(1, Math.floor(numberArg("candidate-limit", DEFAULT_LADDER_CONFIG.candidateLimit))),
};

const started = Date.now();
console.log("Policy Ladder L2");
console.log(`Policies: ${config.policies.join(", ")}`);
console.log(`Structure: ${config.policies.length} policies round-robin x ${config.mirrorDecks.length} mirror decks x 2 seats x ${config.gamesPerSeat} games`);
console.log(`Seeds: start=${config.seedStart}; heuristic-v2 anchor=${config.anchorElo}; search-iters=${config.searchIterations}; pimc-samples=${config.pimcSamples}`);
console.log("");

const report = runPolicyLadder(config);
const completed = report.matches.filter((match) => match.outcome === "complete").length;
const errored = report.matches.filter((match) => match.outcome === "error").length;
const maxSteps = report.matches.filter((match) => match.outcome === "max-steps").length;

console.log("Elo");
console.log(`${pad("policy", 16)} ${pad("elo", 6)} ${pad("W-L", 9)} win`);
for (const rating of report.ratings) {
  console.log(`${pad(rating.id, 16)} ${pad(String(rating.elo), 6)} ${pad(`${rating.wins}-${rating.losses}`, 9)} ${pct(rating.wins, rating.completed)}`);
}

console.log("");
console.log(`Completed: ${completed}/${report.matches.length}; errors=${errored}; maxSteps=${maxSteps}`);
console.log(`Incremental check: ${report.incrementalCheck.pass ? "PASS" : "FAIL"} (${report.incrementalCheck.currentOrder.join(" > ")})`);
console.log(`Wall-clock: ${((Date.now() - started) / 1000).toFixed(1)}s`);

const abs = resolve(outPath);
mkdirSync(dirname(abs), { recursive: true });
writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Report written: ${abs}`);
