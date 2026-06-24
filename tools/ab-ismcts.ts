/**
 * [Claude 2026-06-23] Phase G G2：is-mcts vs pimc-v2 同 wall-clock A/B 驅動器（單進程，聚合 Wilson CI）。
 *
 * 用法：
 *   npx vite-node tools/ab-ismcts.ts -- --games 20 --time-ms 300 [--opp pimc-v2|heuristic-v2]
 *
 * 結構＝spec §4：4 對戰 × P0/P1 鏡像 × games 局。is-mcts 在兩個座位各跑一次，合併計 is-mcts 勝率。
 * --opp pimc-v2 ＝主賽（go/no-go）；--opp heuristic-v2 ＝非退化檢查。
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

// 4 對戰，軸線多樣（hybrid/defense/serve/block/burst 都涵蓋）。
const MATCHUPS: [string, string][] = [
  ["烏野-預組", "音駒-預組"],
  ["白鳥沢-最強白鳥沢", "青葉城西-二彈改"],
  ["稲荷崎-稲荷崎_堆墓改角名", "梟谷-高爆發軸"],
  ["烏野-山月攔網軸", "白鳥沢-白板軸"],
];

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

console.log(`Phase G A/B — is-mcts(leaf=${leafHorizon}) vs ${opp} @ same wall-clock ${timeMs}ms`);
console.log(`Structure: ${MATCHUPS.length} matchups × 2 seatings × ${games} games = ${MATCHUPS.length * 2 * games} total`);
console.log("");

let ismctsWins = 0;
let completed = 0;
const startTime = Date.now();

MATCHUPS.forEach(([a, b], mi) => {
  let pairWins = 0;
  let pairDone = 0;
  // 兩個座位：is-mcts 先坐 P0，再坐 P1（policy 與 deck 同步交換以保持對戰公平）。
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
  console.log(`m${mi} ${a} vs ${b}: is-mcts ${pairWins}/${pairDone} (${pct(ci.p)})  [${((Date.now() - startTime) / 1000).toFixed(0)}s]`);
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
