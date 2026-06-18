import process from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { benchmarkDb, benchmarkDecks, findBenchmarkDeck } from "./benchmark-fixtures";
import type { BenchmarkDeck } from "./benchmark-fixtures";
import type { BenchmarkPolicyId } from "./benchmark";
import type { AnalyzerPreset, DeckAnalyzerComparisonReport, DeckAnalyzerReport } from "./deck-analyzer";
import { runDeckAnalyzer, runDeckAnalyzerComparison } from "./deck-analyzer";
import { isHeuristicV2ProfileId } from "./heuristic";

const DEFAULTS = {
  deck: "烏野-預組",
  policy: "heuristic-v2" as BenchmarkPolicyId,
  opponentPolicy: "heuristic-v2" as BenchmarkPolicyId,
  seedStart: 1200,
  games: 4,
  maxSteps: 5000,
};

const PRESETS: Record<Exclude<AnalyzerPreset, "custom">, { games: number; seedStart: number }> = {
  smoke: { games: 1, seedStart: 1600 },
  direction: { games: 4, seedStart: 2200 },
  formal: { games: 20, seedStart: 3200 },
  holdout: { games: 10, seedStart: 9000 },
};

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} 必須是正數`);
  return value;
}

function policyArg(name: string, fallback: BenchmarkPolicyId): BenchmarkPolicyId {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  if (raw === "random" || raw === "heuristic-v1" || isHeuristicV2ProfileId(raw)) return raw;
  throw new Error(`--${name} 只支援 random、heuristic-v1、heuristic-v2、heuristic-v2-safe 或 heuristic-v2-aggressive`);
}

function presetArg(): AnalyzerPreset {
  const raw = argValue("preset");
  if (raw === undefined) return "custom";
  if (raw === "custom" || raw === "smoke" || raw === "direction" || raw === "formal" || raw === "holdout") return raw;
  throw new Error("--preset 只支援 custom、smoke、direction、formal 或 holdout");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSources(sources: Record<string, number>): string {
  const entries = Object.entries(sources)
    .filter(([, value]) => value > 0)
    .map(([source, value]) => `${source}=${value.toFixed(2)}`);
  return entries.length === 0 ? "none" : entries.join(", ");
}

function printDecks(): void {
  for (const deck of benchmarkDecks) {
    console.log(`${deck.name} (${deck.ids.length} 張, axes=${deck.axes.join("/")})`);
  }
}

function resolveOpponents(excluded: Set<string>): BenchmarkDeck[] {
  const raw = argValue("opponents") ?? "all";
  if (raw === "all") return benchmarkDecks.filter((deck) => !excluded.has(deck.name));
  const names = raw.split(",").map((name) => name.trim()).filter(Boolean);
  const decks = names.map((name) => findBenchmarkDeck(name));
  return decks.filter((deck) => !excluded.has(deck.name));
}

function writeReport(path: string | undefined, report: DeckAnalyzerReport | DeckAnalyzerComparisonReport, quiet = false): void {
  if (!path) return;
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!quiet) console.log(`Report written: ${abs}`);
}

function printFindings(title: string, findings: { severity: string; label: string; evidence: string }[]): void {
  console.log(title);
  if (findings.length === 0) {
    console.log("- none");
    return;
  }
  for (const finding of findings.slice(0, 5)) console.log(`- [${finding.severity}] ${finding.label}: ${finding.evidence}`);
}

function printDeckReport(report: DeckAnalyzerReport, title = "M8 Phase B2 Deck Analyzer"): void {
  const { aggregate } = report;
  console.log(title);
  console.log(`Deck: ${report.config.deck} (${report.config.deckAxes.join("/") || "no-axis"})`);
  console.log(`Preset: ${report.config.preset}, opponents=${report.config.opponents.length}, games/seat=${report.config.gamesPerSeat}, completed=${aggregate.completed}/${aggregate.games}`);
  console.log(`Policies: ${report.config.policy} vs ${report.config.opponentPolicy}`);
  console.log(`Win rate: ${formatPercent(aggregate.winRate)} (95% CI ${formatPercent(aggregate.winRate95.low)}-${formatPercent(aggregate.winRate95.high)})`);
  console.log(`Set win rate: ${formatPercent(aggregate.setWinRate)}, average rallies/set=${aggregate.averageRalliesPerSet.toFixed(2)}`);
  console.log(`Receive success=${formatPercent(aggregate.receiveSuccessRate)}, block success=${formatPercent(aggregate.blockSuccessRate)}, attack OP=${aggregate.averageAttackOp.toFixed(2)}, burst=${formatPercent(aggregate.burstRate)}`);
  console.log(`OP sources: serve=${aggregate.averageServeOp.toFixed(2)}, block=${aggregate.averageBlockOp.toFixed(2)}, attack=${aggregate.averageAttackOp.toFixed(2)}`);
  console.log(`Events/match=${aggregate.eventUsesPerMatch.toFixed(2)} (effective ${formatPercent(aggregate.eventEffectiveRate)}), skills/match=${aggregate.skillUsesPerMatch.toFixed(2)} (effective ${formatPercent(aggregate.skillEffectiveRate)}), paid Guts/match=${aggregate.paidGutsPerMatch.toFixed(2)}`);
  console.log(`Guts sources/match: ${formatSources(aggregate.gutsPaidBySourcePerMatch)}`);
  console.log("Gameplan:");
  for (const line of report.gameplan) console.log(`- ${line}`);
  printFindings("Weaknesses:", report.weaknesses);
  printFindings("Brick sources:", report.brickSources);
  console.log("Recommendations:");
  for (const recommendation of report.recommendations.slice(0, 5)) console.log(`- ${recommendation}`);
  const worst = [...report.matchups].sort((a, b) => a.metrics.winRate - b.metrics.winRate).slice(0, 5);
  console.log("Worst matchups:");
  for (const matchup of worst) {
    console.log(`- ${matchup.opponent}: win=${formatPercent(matchup.metrics.winRate)}, set=${formatPercent(matchup.metrics.setWinRate)}, lost=${Object.entries(matchup.targetLostReasons).map(([reason, count]) => `${reason}:${count}`).join(", ") || "none"}`);
    for (const line of matchup.diagnosis.slice(0, 2)) console.log(`  - ${line}`);
  }
}

function printComparison(report: DeckAnalyzerComparisonReport): void {
  printDeckReport(report.base, "M8 Phase B2 Deck Analyzer — Base");
  console.log("");
  printDeckReport(report.candidate, "M8 Phase B2 Deck Analyzer — Candidate");
  console.log("");
  console.log("A/B Comparison");
  console.log(`Base: ${report.comparison.baseDeck}`);
  console.log(`Candidate: ${report.comparison.candidateDeck}`);
  console.log(`Verdict: ${report.comparison.verdict}`);
  for (const note of report.comparison.notes) console.log(`- ${note}`);
  console.log("Matchup deltas:");
  for (const delta of report.comparison.matchupDeltas.slice(0, 8)) {
    console.log(`- ${delta.opponent}: win ${delta.winRateDelta >= 0 ? "+" : ""}${formatPercent(delta.winRateDelta)}, set ${delta.setWinRateDelta >= 0 ? "+" : ""}${formatPercent(delta.setWinRateDelta)}`);
  }
}

function run(): void {
  if (hasFlag("list-decks")) {
    printDecks();
    return;
  }

  const deck = findBenchmarkDeck(argValue("deck") ?? DEFAULTS.deck);
  const compareDeckName = argValue("compare-deck");
  const compareDeck = compareDeckName ? findBenchmarkDeck(compareDeckName) : null;
  const preset = presetArg();
  const presetDefaults = preset === "custom" ? DEFAULTS : { ...DEFAULTS, ...PRESETS[preset] };
  const policy = policyArg("policy", DEFAULTS.policy);
  const opponentPolicy = policyArg("opponent-policy", DEFAULTS.opponentPolicy);
  const seedStart = numberArg("seed-start", presetDefaults.seedStart);
  const gamesPerSeat = numberArg("games", presetDefaults.games);
  const maxSteps = numberArg("max-steps", DEFAULTS.maxSteps);
  const outPath = argValue("out");
  const excluded = new Set([deck.name, compareDeck?.name].filter((name): name is string => !!name));
  const opponents = resolveOpponents(excluded);
  if (opponents.length === 0) throw new Error("沒有可分析的對手牌組；請調整 --opponents");

  if (compareDeck) {
    const report = runDeckAnalyzerComparison({
      db: benchmarkDb,
      baseDeck: deck,
      candidateDeck: compareDeck,
      opponents,
      policy,
      opponentPolicy,
      seedStart,
      gamesPerSeat,
      maxSteps,
      preset,
    });
    if (hasFlag("json")) {
      console.log(JSON.stringify(report, null, 2));
      writeReport(outPath, report, true);
      return;
    }
    printComparison(report);
    writeReport(outPath, report);
    return;
  }

  const report = runDeckAnalyzer({
    db: benchmarkDb,
    deck,
    opponents,
    policy,
    opponentPolicy,
    seedStart,
    gamesPerSeat,
    maxSteps,
    preset,
  });
  if (hasFlag("json")) {
    console.log(JSON.stringify(report, null, 2));
    writeReport(outPath, report, true);
    return;
  }
  printDeckReport(report);
  writeReport(outPath, report);
}

run();
