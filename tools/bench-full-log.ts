// AI 對 AI 跑批並保留「完整 state.log＋uid→cardId 對照」的補充跑批器。
// 標準 benchmark:m8 只留 logTail 8 行，無法做單卡得分歸因；此工具輸出每場完整逐條 log
// （含 skill-used / judge / set-won 等結構化事件），供賽後 set 級與點級分析。
// 用法：
//   vite-node tools/bench-full-log.ts -- --deck-a <名> --deck-b <名> \
//     --policy is-mcts-h4 --games 10 --ismcts-time-ms 3000 --seed-start 100 --out-dir <目錄>
import process from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyDecision, createGame } from "../src/engine/engine";
import type { GameState, PlayerId } from "../src/engine/types";
import { benchmarkDb, findBenchmarkDeck } from "../src/ai/benchmark-fixtures";
import {
  benchmarkPolicyDecision,
  seededRnd,
} from "../src/ai/benchmark";
import type { BenchmarkPolicyId, BenchmarkRunContext } from "../src/ai/benchmark";
import { argValue, numberArg } from "../src/shared/argv";

const deckAName = argValue("deck-a") ?? "青葉城西-第三彈測試_調整C萬用體";
const deckBName = argValue("deck-b") ?? "音駒-音駒-三彈官方";
const policy = (argValue("policy") ?? "is-mcts-h4") as BenchmarkPolicyId;
const games = numberArg("games", 10);
const seedStart = numberArg("seed-start", 100);
const maxSteps = numberArg("max-steps", 5000);
const timeLimitMs = numberArg("ismcts-time-ms", 3000);
const outDir = argValue("out-dir") ?? "data/ab/full-log";

const runCtx: BenchmarkRunContext = { timeLimitMs };

const deckA = findBenchmarkDeck(deckAName);
const deckB = findBenchmarkDeck(deckBName);
mkdirSync(outDir, { recursive: true });

for (let game = 0; game < games; game++) {
  const seed = seedStart + game;
  const randomByPlayer: [() => number, () => number] = [
    seededRnd(seed * 3 + 11),
    seededRnd(seed * 5 + 17),
  ];
  let state: GameState = createGame(benchmarkDb, {
    seed,
    decks: [deckA.ids, deckB.ids],
  });
  let outcome = "complete";
  let step = 0;
  for (; step < maxSteps; step++) {
    if (state.phase === "gameOver") break;
    const pending = state.pendingDecision;
    if (!pending) {
      outcome = "error:no-pending";
      break;
    }
    const decision = benchmarkPolicyDecision(
      policy,
      benchmarkDb,
      state,
      randomByPlayer,
      runCtx,
      [deckA.axes, deckB.axes],
      [deckA.ids, deckB.ids],
    );
    state = applyDecision(benchmarkDb, state, decision);
  }
  if (state.phase !== "gameOver" && outcome === "complete") outcome = "max-steps";

  const record = {
    seed,
    decks: [deckAName, deckBName] as const,
    policy,
    timeLimitMs,
    outcome,
    steps: step,
    winner: state.winner as PlayerId | null,
    cards: state.cards,
    log: state.log,
  };
  const outPath = join(outDir, `game-${seed}.json`);
  writeFileSync(outPath, JSON.stringify(record));
  console.log(
    `[${new Date().toISOString()}] game seed=${seed} done: winner=P${state.winner} outcome=${outcome} steps=${step} → ${outPath}`,
  );
}
console.log("all games done");
