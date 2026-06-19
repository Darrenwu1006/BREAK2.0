import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import cardsJson from "../data/cards.json";
import type { Card } from "../src/data/types";
import type { CardDb, Decision, PlayerId } from "../src/engine/types";
import { createPimcCoachReport } from "../src/ai/coach";
import { createReplayReviewReport, type ReplayGameplanCheckpoint } from "../src/ai/replay-review";
import type { ReplaySession } from "../src/ui/replayHistory";

interface CliOptions {
  file?: string;
  player: PlayerId;
  coach: boolean;
  samples: number;
  threshold: number;
  maxCoachSteps: number;
}

interface CoachFinding {
  step: number;
  setNo: number;
  turnNo: number;
  phase: string;
  pendingType: Decision["type"];
  playerChoice: string;
  playerWinRate: number;
  bestChoice: string;
  bestWinRate: number;
  delta: number;
  explanation: string;
  gameplanTone?: string;
  gameplanDelta?: number;
  gameplanBadges: string[];
  kind: "mistake" | "tradeoff";
}

const db: CardDb = new Map((cardsJson as Card[]).map((c) => [c.id, c]));

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    player: 0,
    coach: false,
    samples: 5,
    threshold: 0.15,
    maxCoachSteps: Infinity,
  };
  for (const arg of argv) {
    if (arg === "--coach") options.coach = true;
    else if (arg.startsWith("--file=")) options.file = arg.slice("--file=".length);
    else if (arg.startsWith("--player=")) options.player = Number(arg.slice("--player=".length)) as PlayerId;
    else if (arg.startsWith("--samples=")) options.samples = Math.max(0, Number(arg.slice("--samples=".length)) || 0);
    else if (arg.startsWith("--threshold=")) options.threshold = Math.max(0, Number(arg.slice("--threshold=".length)) || 0);
    else if (arg.startsWith("--max-coach-steps=")) options.maxCoachSteps = Math.max(0, Number(arg.slice("--max-coach-steps=".length)) || 0);
  }
  if (options.player !== 0 && options.player !== 1) throw new Error("--player must be 0 or 1");
  return options;
}

function latestReplayFile(): string {
  const replaysDir = join(process.cwd(), "data", "replays");
  if (!existsSync(replaysDir)) throw new Error("data/replays does not exist.");
  const files = readdirSync(replaysDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(replaysDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) throw new Error("No replay files found.");
  return files[0]!;
}

function loadReplay(file?: string): { path: string; session: ReplaySession } {
  const path = file ? join(process.cwd(), file) : latestReplayFile();
  return { path, session: JSON.parse(readFileSync(path, "utf8")) as ReplaySession };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fixed(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

function playerName(player: PlayerId): string {
  return player === 0 ? "玩家" : "AI";
}

function checkpointLine(checkpoint: ReplayGameplanCheckpoint): string {
  const changes = checkpoint.objectiveChanges
    .map((change) => `${change.label} ${change.before}->${change.after}/${change.threshold}`)
    .join("；");
  const badges = checkpoint.badges.length ? `｜${checkpoint.badges.join("、")}` : "";
  const risks = checkpoint.risks.length ? `｜風險：${checkpoint.risks.join("、")}` : "";
  return `  - #${checkpoint.entryIndex + 1} Set ${checkpoint.setNo} Turn ${checkpoint.turnNo} ${checkpoint.phase}：${checkpoint.tone} ${checkpoint.beforeScore}->${checkpoint.afterScore}${badges}${risks}${changes ? `｜${changes}` : ""}`;
}

function isSameDecision(a: Decision, b: Decision): boolean {
  return a.type === b.type && JSON.stringify(a) === JSON.stringify(b);
}

function scanCoachFindings(session: ReplaySession, options: CliOptions): { findings: CoachFinding[]; evaluated: number; errors: number } {
  const entries = session.entries.filter((entry) => entry.source === "player" && entry.player === options.player);
  const targetEntries = Number.isFinite(options.maxCoachSteps) ? entries.slice(0, options.maxCoachSteps) : entries;
  const findings: CoachFinding[] = [];
  let evaluated = 0;
  let errors = 0;

  for (const entry of targetEntries) {
    try {
      const report = createPimcCoachReport(db, entry.before, {
        sampleCount: options.samples,
        perspectivePlayer: options.player,
        knownDecks: [session.decks[0].cardIds, session.decks[1].cardIds],
        gameplanDeckLabels: [session.decks[0].label, session.decks[1].label],
      });
      const actualEstimate = report.recommendations.find((rec) => isSameDecision(rec.decision, entry.decision));
      if (actualEstimate) {
        const delta = report.bestAction.winRate - actualEstimate.winRate;
        if (delta >= options.threshold) {
          const progress = actualEstimate.gameplan?.tone === "progress";
          findings.push({
            step: entry.index + 1,
            setNo: entry.setNo,
            turnNo: entry.turnNo,
            phase: entry.phase,
            pendingType: entry.pendingType,
            playerChoice: actualEstimate.label,
            playerWinRate: actualEstimate.winRate,
            bestChoice: report.bestAction.label,
            bestWinRate: report.bestAction.winRate,
            explanation: actualEstimate.explanation,
            delta,
            gameplanTone: actualEstimate.gameplan?.tone,
            gameplanDelta: actualEstimate.gameplan?.delta,
            gameplanBadges: actualEstimate.gameplan?.badges ?? [],
            kind: progress ? "tradeoff" : "mistake",
          });
        }
      }
    } catch {
      errors++;
    }
    evaluated++;
    if (evaluated % 15 === 0 || evaluated === targetEntries.length) {
      console.log(`Coach scan: ${evaluated}/${targetEntries.length}`);
    }
  }

  return { findings, evaluated, errors };
}

function printReport(path: string, session: ReplaySession, options: CliOptions): void {
  const report = createReplayReviewReport(db, session, { player: options.player });
  const analytics = report.analytics;
  console.log(`載入對戰紀錄: ${path}`);
  console.log(`對戰組合: ${report.deckLabels[0]} VS ${report.deckLabels[1]}`);
  console.log(`開始時間: ${report.startedAt}`);
  console.log(`Seed: ${report.seed}`);
  console.log(`總決策步數: ${analytics.totalDecisions}（玩家 ${analytics.playerDecisions} / AI ${analytics.aiDecisions}）`);
  console.log(`結果: ${analytics.matchWinner === null ? "未分勝負" : `${playerName(analytics.matchWinner)}獲勝`}`);
  console.log("");

  console.log("Set 走向");
  for (const set of report.setReviews) {
    const winner = set.winner === null ? "-" : playerName(set.winner);
    const progress = set.gameplanProgressScore === undefined ? "" : `｜主軸 ${set.gameplanProgressScore} / ${set.gameplanStage}`;
    const firstObjective = set.objectives?.[0];
    const objectiveText = firstObjective ? `｜${firstObjective.label} ${firstObjective.value}/${firstObjective.threshold}` : "";
    console.log(
      `  Set ${set.setNo}: 勝者 ${winner}｜最後 Turn ${set.lastTurnNo}｜牌庫 ${set.deckCount}｜手牌 ${set.handCount}｜棄牌 ${set.dropCount}${progress}${objectiveText}`,
    );
  }

  console.log("");
  console.log("全場統計");
  console.log(`  ${playerName(0)} OP 平均 ${fixed(analytics.op[0].average)} / 最高 ${analytics.op[0].max}；DP 平均 ${fixed(analytics.dp[0].average)} / 最高 ${analytics.dp[0].max}`);
  console.log(`  ${playerName(1)} OP 平均 ${fixed(analytics.op[1].average)} / 最高 ${analytics.op[1].max}；DP 平均 ${fixed(analytics.dp[1].average)} / 最高 ${analytics.dp[1].max}`);
  console.log(`  Guts 支付: ${playerName(0)} ${analytics.payGuts[0]} / ${playerName(1)} ${analytics.payGuts[1]}`);

  if (report.gameplan) {
    console.log("");
    console.log(`主軸覆盤: ${report.gameplan.displayName}`);
    console.log(`  最終階段: ${report.gameplan.final.stage}｜進度 ${report.gameplan.final.progressScore}/100`);
    if (report.gameplan.final.risks.length) console.log(`  風險: ${report.gameplan.final.risks.join("、")}`);
    const checkpoints = report.gameplan.checkpoints.slice(0, 18);
    console.log(`  關鍵轉折: ${report.gameplan.checkpoints.length} 個${report.gameplan.checkpoints.length > checkpoints.length ? `（先列前 ${checkpoints.length} 個）` : ""}`);
    for (const checkpoint of checkpoints) console.log(checkpointLine(checkpoint));
  } else {
    console.log("");
    console.log(`主軸覆盤: 找不到 ${session.decks[options.player].label} 對應的 gameplan profile`);
  }
}

const options = parseArgs(process.argv.slice(2));
const { path, session } = loadReplay(options.file);
printReport(path, session, options);

if (options.coach) {
  console.log("");
  console.log(`開始 Coach/PIMC 掃描（samples=${options.samples}, threshold=${pct(options.threshold)}）`);
  const result = scanCoachFindings(session, options);
  const mistakes = result.findings.filter((finding) => finding.kind === "mistake");
  const tradeoffs = result.findings.filter((finding) => finding.kind === "tradeoff");
  console.log("");
  console.log(`Coach 掃描完成: 已評估 ${result.evaluated} 步，錯誤略過 ${result.errors} 步`);
  console.log(`重大失誤: ${mistakes.length}；短期勝率下降但主軸推進: ${tradeoffs.length}`);
  for (const finding of result.findings) {
    const label = finding.kind === "tradeoff" ? "短期勝率下降，但有主軸推進" : "重大失誤候選";
    console.log("");
    console.log(`[第 ${finding.step} 步] ${label}｜Set ${finding.setNo} Turn ${finding.turnNo} (${finding.phase}/${finding.pendingType})`);
    console.log(`  實際: ${finding.playerChoice}（${pct(finding.playerWinRate)}）`);
    console.log(`  建議: ${finding.bestChoice}（${pct(finding.bestWinRate)}）`);
    console.log(`  勝率差: -${pct(finding.delta)}`);
    if (finding.gameplanTone) {
      const badges = finding.gameplanBadges.length ? `｜${finding.gameplanBadges.join("、")}` : "";
      console.log(`  主軸: ${finding.gameplanTone}${finding.gameplanDelta === undefined ? "" : ` (${finding.gameplanDelta >= 0 ? "+" : ""}${finding.gameplanDelta})`}${badges}`);
    }
    if (finding.explanation) console.log(`  Coach: ${finding.explanation}`);
  }
}
