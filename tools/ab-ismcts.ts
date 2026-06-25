/**
 * [Claude 2026-06-23] Phase G A/B 驅動器（單進程，聚合 Wilson CI）。
 *
 * 用法：
 *   npx vite-node tools/ab-ismcts.ts -- --games 20 --time-ms 3000 --leaf-horizon 40 [--opp pimc-v2|heuristic-v2] [--mirror]
 *
 * 兩種結構：
 * - 預設（cross-matchup）：4 對戰 deckA vs deckB × P0/P1 換座位 × games 局。座位互換已平衡牌組強度「偏差」，
 *   但**克制關係仍以變異形式稀釋模型訊號**（很多勝負由牌組克制決定，非 policy）。
 * - --mirror（[使用者 2026-06-23] 建議）：**同一套牌組兩邊互打** × P0/P1 換座位 × 跨多套牌組。
 *   消掉牌組強度差與克制（baseline 天生 50%）→ 偏離 50% 純粹是模型實力差，訊噪比更高。
 *   仍換座位（抵先手偏差）、跨多套牌組（原型覆蓋率）。
 */
import process from "node:process";
import { benchmarkDb, findBenchmarkDeck } from "../src/ai/benchmark-fixtures";
import {
  configureIsmctsBenchmark,
  configurePimcBenchmark,
  runBenchmarkBatch,
  mirroredSeeds,
  type BenchmarkDeckInput,
  type BenchmarkPolicyId,
} from "../src/ai/benchmark";

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  return fallback;
}

const games = Number(argValue("games", "20"));
const timeMs = Number(argValue("time-ms", "300"));
const opp = argValue("opp", "pimc-v2") as BenchmarkPolicyId;
const leafHorizon = Number(argValue("leaf-horizon", "0"));
const mirror = process.argv.includes("--mirror");

// cross-matchup：4 對戰，軸線多樣（hybrid/defense/serve/block/burst 都涵蓋）。
const MATCHUPS: [string, string][] = [
  ["烏野-預組", "音駒-預組"],
  ["白鳥沢-最強白鳥沢", "青葉城西-二彈改"],
  ["稲荷崎-稲荷崎_堆墓改角名", "梟谷-高爆發軸"],
  ["烏野-山月攔網軸", "白鳥沢-白板軸"],
];

// mirror：5 套不同原型的牌組，各自對自己互打（消牌組強度＋克制，純測 policy）。
const MIRROR_DECKS = [
  "烏野-預組", // hybrid
  "音駒-預組", // defense
  "梟谷-高爆發軸", // burst
  "白鳥沢-最強白鳥沢", // defense/hybrid
  "青葉城西-二彈改", // serve/hybrid
];

// units＝要跑的對戰單位（[deckP0source, deckP1source]）。mirror 模式下兩邊同牌組。
const units: [string, string][] = mirror ? MIRROR_DECKS.map((d) => [d, d] as [string, string]) : MATCHUPS;

function deck(name: string): BenchmarkDeckInput {
  const d = findBenchmarkDeck(name);
  return { name: d.name, ids: d.ids, axes: d.axes };
}

function wilson(successes: number, total: number): { low: number; high: number; p: number } {
  if (total === 0) return { low: 0, high: 0, p: 0 };
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return { low: Math.max(0, (center - margin) / denom), high: Math.min(1, (center + margin) / denom), p };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// 同 wall-clock：is-mcts 與對手都吃同一個 timeLimitMs。
configureIsmctsBenchmark({ timeLimitMs: timeMs, leafRolloutHorizon: leafHorizon });
if (opp === "pimc-v2" || opp === "pimc") configurePimcBenchmark({ timeLimitMs: timeMs });

console.log(`Phase G A/B — is-mcts(leaf=${leafHorizon}) vs ${opp} @ same wall-clock ${timeMs}ms${mirror ? "  [MIRROR 同牌組]" : ""}`);
console.log(`Structure: ${units.length} ${mirror ? "decks(mirror)" : "matchups"} × 2 seatings × ${games} games = ${units.length * 2 * games} total`);
console.log("");

let ismctsWins = 0;
let completed = 0;
const startTime = Date.now();

units.forEach(([a, b], mi) => {
  let pairWins = 0;
  let pairDone = 0;
  // 兩個座位：is-mcts 先坐 P0，再坐 P1（policy 與 deck 同步交換）。mirror 下 a===b＝兩邊同牌組、僅換座位抵先手。
  for (const seat of [0, 1] as const) {
    const policies: [BenchmarkPolicyId, BenchmarkPolicyId] = seat === 0 ? ["is-mcts", opp] : [opp, "is-mcts"];
    const decks: [BenchmarkDeckInput, BenchmarkDeckInput] = seat === 0 ? [deck(a), deck(b)] : [deck(b), deck(a)];
    const seedStart = 1000 + mi * 1000 + seat * 500;
    const report = runBenchmarkBatch({
      db: benchmarkDb,
      decks,
      policies,
      seeds: mirroredSeeds(seedStart, games),
    });
    for (const m of report.matches) {
      if (m.outcome !== "complete" || m.winner === null) continue;
      pairDone++;
      const ismctsSeat = seat === 0 ? 0 : 1;
      if (m.winner === ismctsSeat) pairWins++;
    }
  }
  ismctsWins += pairWins;
  completed += pairDone;
  const ci = wilson(pairWins, pairDone);
  const label = mirror ? `${a} (mirror)` : `${a} vs ${b}`;
  console.log(`m${mi} ${label}: is-mcts ${pairWins}/${pairDone} (${pct(ci.p)})  [${((Date.now() - startTime) / 1000).toFixed(0)}s]`);
});

const ci = wilson(ismctsWins, completed);
console.log("");
console.log(`COMBINED: is-mcts ${ismctsWins}/${completed} = ${pct(ci.p)}  95% CI ${pct(ci.low)}-${pct(ci.high)}`);
console.log(
  opp === "pimc-v2"
    ? `GO/NO-GO (CI low > 50%): ${ci.low > 0.5 ? "PASS ✅" : "FAIL ❌"}`
    : `non-regression vs ${opp}: ${pct(ci.p)} (現況 ~88% 區間)`,
);
console.log(`Total wall-clock: ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
