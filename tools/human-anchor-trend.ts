// [Claude 2026-07-05] Phase L L1：人類錨點趨勢 CLI（spec §2）。
// 讀本機 data/human-anchor/matches.jsonl（gitignored），輸出認真局 win rate（依 engineVersion
// 分組）、近 10 場移動窗、一致率彙整。小樣本誠實標注、缺值（未掃描場次）容忍。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANCHOR_SMALL_SAMPLE_N,
  parseHumanAnchorJsonl,
  summarizeAnchorTrend,
  type AnchorVersionSummary,
} from "../src/human-anchor";

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function smallSampleNote(n: number): string {
  return n < ANCHOR_SMALL_SAMPLE_N ? `（n=${n}，僅供方向參考）` : "";
}

function versionLine(group: AnchorVersionSummary): string {
  const agreement = group.scanned > 0
    ? `一致率 ${pct(group.agreementRate ?? 0)}（已掃 ${group.scanned}/${group.games} 場、blunder 共 ${group.blunderTotal}）`
    : `一致率 -（0/${group.games} 場已掃描）`;
  return `  ${group.engineVersion.padEnd(10)} 勝率 ${pct(group.winRate)}（${group.wins}/${group.games}）${smallSampleNote(group.games)}｜${agreement}`;
}

const matchesPath = join(process.cwd(), "data", "human-anchor", "matches.jsonl");
if (!existsSync(matchesPath)) {
  console.log(`找不到 ${matchesPath}——還沒有人類錨點紀錄。打完一場認真局（gameOver 會自動記錄）再跑。`);
  process.exit(0);
}

const { records, skipped } = parseHumanAnchorJsonl(readFileSync(matchesPath, "utf8"));
const summary = summarizeAnchorTrend(records);

console.log(`人類錨點趨勢（data/human-anchor/matches.jsonl）`);
console.log(`認真局 ${summary.seriousGames} 場｜實驗局 ${summary.experimentGames} 場（不計入勝率）${skipped > 0 ? `｜壞行略過 ${skipped}` : ""}`);

if (summary.seriousGames === 0) {
  console.log("目前沒有認真局紀錄，無法輸出趨勢。");
  process.exit(0);
}

console.log("");
console.log("依 engineVersion 分組（認真局）");
for (const group of summary.byVersion) console.log(versionLine(group));

if (summary.recentWindow) {
  const window = summary.recentWindow;
  console.log("");
  const partial = window.games < window.window ? `（不足 ${window.window} 場，實際 ${window.games} 場）` : "";
  console.log(`近 ${window.window} 場移動窗：勝率 ${pct(window.winRate)}（${window.wins}/${window.games}）${partial}${smallSampleNote(window.games)}`);
}

if (summary.seriousGames < ANCHOR_SMALL_SAMPLE_N) {
  console.log("");
  console.log(`總樣本 n=${summary.seriousGames} < ${ANCHOR_SMALL_SAMPLE_N}：以上數字僅供方向參考，不具統計顯著性。`);
}

const unscanned = summary.byVersion.reduce((sum, group) => sum + (group.games - group.scanned), 0);
if (unscanned > 0) {
  console.log("");
  console.log(`一致率掃描是 opt-in（PIMC 全掃耗時）：還有 ${unscanned} 場未掃描，挑幾場跑`);
  console.log(`  npm run analyze:replay -- --file=data/replays/<檔名> --anchor`);
}
