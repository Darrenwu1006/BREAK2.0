import process from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { benchmarkDb, benchmarkDecks, findBenchmarkDeck } from "./benchmark-fixtures";
import type { BenchmarkDeck } from "./benchmark-fixtures";
import type { BenchmarkPolicyId } from "./benchmark";
import type { AnalyzerPreset, DeckAnalyzerComparisonReport, DeckAnalyzerReport } from "./deck-analyzer";
import { runDeckAnalyzer, runDeckAnalyzerComparison } from "./deck-analyzer";
import { isHeuristicV2ProfileId } from "./heuristic";
import type { GutsSource, LostReason } from "./benchmark";

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
  throw new Error(`--${name} 只支援 random、heuristic-v1、heuristic-v2、heuristic-v2-safe、heuristic-v2-aggressive、heuristic-v2-personality 或 heuristic-v2-<axis>`);
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

const GUTS_SOURCE_LABELS: Record<GutsSource, string> = {
  serve: "發球區",
  receive: "接球區",
  toss: "托球區",
  attack: "攻擊區",
  blockCenter: "中央攔網",
};

const LOST_REASON_LABELS: Record<LostReason, string> = {
  "judge-fail": "OP/DP 判定失敗",
  "no-deploy": "未能登場",
  voluntary: "主動宣告 Lost",
  effect: "效果造成 Lost",
  unknown: "原因未明",
};

function formatSources(sources: Record<GutsSource, number>): string {
  const entries = Object.entries(sources)
    .filter(([, value]) => value > 0)
    .map(([source, value]) => `${GUTS_SOURCE_LABELS[source as GutsSource]}=${value.toFixed(2)}`);
  return entries.length === 0 ? "none" : entries.join(", ");
}

function formatLostReasons(reasons: Partial<Record<LostReason, number>>): string {
  const entries = Object.entries(reasons) as [LostReason, number][];
  if (entries.length === 0) return "none";
  return entries.map(([reason, count]) => `${LOST_REASON_LABELS[reason]}:${count}`).join(", ");
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
  console.log(`牌組: ${report.config.deck} (${report.config.deckAxes.join("/") || "未標記軸線"})`);
  console.log(`測試設定: ${report.config.preset}, 對手=${report.config.opponents.length}, 每個先後手場次=${report.config.gamesPerSeat}, 完成=${aggregate.completed}/${aggregate.games}`);
  console.log(`AI: ${report.config.policy} vs ${report.config.opponentPolicy}`);
  console.log(`Match 勝率: ${formatPercent(aggregate.winRate)} (95% CI ${formatPercent(aggregate.winRate95.low)}-${formatPercent(aggregate.winRate95.high)})`);
  console.log(`Set 取得率: ${formatPercent(aggregate.setWinRate)}, 平均每 Set rally=${aggregate.averageRalliesPerSet.toFixed(2)}`);
  console.log(`接球判定成功=${formatPercent(aggregate.receiveSuccessRate)}, 攔網判定成功=${formatPercent(aggregate.blockSuccessRate)}, 平均攻擊 OP=${aggregate.averageAttackOp.toFixed(2)}, 高 OP 攻擊比例=${formatPercent(aggregate.burstRate)}`);
  console.log(`OP 來源平均: 發球=${aggregate.averageServeOp.toFixed(2)}, 攔網=${aggregate.averageBlockOp.toFixed(2)}, 攻擊=${aggregate.averageAttackOp.toFixed(2)}`);
  console.log(`事件使用=${aggregate.eventUsesPerMatch.toFixed(2)} 次/場（有實質效果 ${formatPercent(aggregate.eventEffectiveRate)}）, 技能宣言=${aggregate.skillUsesPerMatch.toFixed(2)} 次/場（有實質效果 ${formatPercent(aggregate.skillEffectiveRate)}）, 支付 Guts=${aggregate.paidGutsPerMatch.toFixed(2)} /場`);
  console.log(`Guts 支付區域: ${formatSources(aggregate.gutsPaidBySourcePerMatch)}`);
  console.log("遊戲計畫:");
  for (const line of report.gameplan) console.log(`- ${line}`);
  printFindings("主要風險:", report.weaknesses);
  printFindings("起手 / 構築警訊:", report.brickSources);
  console.log("調整建議:");
  for (const recommendation of report.recommendations.slice(0, 5)) console.log(`- ${recommendation}`);
  const worst = [...report.matchups].sort((a, b) => a.metrics.winRate - b.metrics.winRate).slice(0, 5);
  console.log("苦手對局:");
  for (const matchup of worst) {
    console.log(`- ${matchup.opponent}: Match勝率=${formatPercent(matchup.metrics.winRate)}, Set取得率=${formatPercent(matchup.metrics.setWinRate)}, 失Set原因=${formatLostReasons(matchup.targetLostReasons)}`);
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
