import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const tasks = [
  { deckA: "ユース-合宿精英-優化", deckB: "梟谷-第三彈官方", out: "reports/optimizer/bench_0_fukurodani.json" },
  { deckA: "ユース-合宿精英-優化", deckB: "音駒-音駒-二口干擾", out: "reports/optimizer/bench_0_nekoma_disturb.json" },
  { deckA: "ユース-合宿精英-優化", deckB: "音駒-音駒-三彈官方", out: "reports/optimizer/bench_0_nekoma_official.json" },
  { deckA: "ユース-合宿精英-優化", deckB: "白鳥沢-三彈優化", out: "reports/optimizer/bench_0_shiratorizawa.json" },
  { deckA: "ユース-合宿精英-優化", deckB: "伊達工業-攔網軸改_韋宏", out: "reports/optimizer/bench_0_date_tech.json" }
];

const MAX_CONCURRENT = 4;
let activeCount = 0;
let taskIndex = 0;

function runNext() {
  if (taskIndex >= tasks.length && activeCount === 0) {
    console.log("All tasks completed!");
    process.exit(0);
  }

  while (activeCount < MAX_CONCURRENT && taskIndex < tasks.length) {
    const currentTaskIndex = taskIndex++;
    const task = tasks[currentTaskIndex];
    activeCount++;

    console.log(`[Start Task ${currentTaskIndex + 1}/${tasks.length}] ${task.deckA} vs ${task.deckB}`);

    mkdirSync(dirname(task.out), { recursive: true });

    const child = spawn("npx", [
      "vite-node",
      "src/ai/benchmark-cli.ts",
      `--deck-a=${task.deckA}`,
      `--deck-b=${task.deckB}`,
      "--policy-a=is-mcts",
      "--policy-b=is-mcts",
      "--games=5",
      "--time-ms=1000",
      `--out=${task.out}`
    ], { stdio: "inherit" });

    child.on("close", (code) => {
      activeCount--;
      console.log(`[Finish Task ${currentTaskIndex + 1}/${tasks.length}] Code: ${code}`);
      runNext();
    });

    child.on("error", (err) => {
      console.error(`Task ${currentTaskIndex + 1} failed:`, err);
    });
  }
}

console.log(`Starting ${tasks.length} tasks with max concurrency of ${MAX_CONCURRENT}`);
runNext();
