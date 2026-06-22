/**
 * [Claude 2026-06-22] Phase F 第二槓桿 S1a：離線擬合 rollout 價值函數係數。
 *
 * 流程：heuristic-v2 自對弈跑完整局 → 沿途取樣盤面、抽 `extractValueFeatures`（雙視角）→
 * 以該局最終 winner 當 label → logistic regression（標準化後梯度下降、L2）擬合 → 印出可貼回
 * `rollout-value.ts` 的 raw 係數與訓練指標（log-loss / accuracy / AUC）。不動主迴圈、不上線。
 *
 * 用法：npm run fit:rollout-value -- --games 400 --sample-every 4
 */
import { applyDecision, createGame } from "../engine/engine";
import { heuristicAiDecision, heuristicProfileForDeckAxes } from "./heuristic";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import { extractValueFeatures, VALUE_FEATURE_DIM, VALUE_FEATURE_NAMES } from "./rollout-value";
import type { PlayerId } from "../engine/types";

const DECKS = [
  "烏野-預組",
  "音駒-預組",
  "青葉城西-二彈改",
  "白鳥沢-白鳥沢_20260604_優勝",
  "稲荷崎-稲荷崎_堆墓改角名",
  "梟谷-梟谷_20260507_優勝",
  "伊達工業-攔網軸改",
  "烏野-日影攻擊軸",
];

function argNum(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) {
    const v = Number(inline.slice(`--${name}=`.length));
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

interface Row {
  x: number[];
  y: number; // 1＝該視角最終獲勝
}

function collect(games: number, seedStart: number, sampleEvery: number, maxSteps: number): Row[] {
  const rows: Row[] = [];
  for (let g = 0; g < games; g++) {
    const deckA = findBenchmarkDeck(DECKS[g % DECKS.length]!);
    const deckB = findBenchmarkDeck(DECKS[(g * 3 + 1) % DECKS.length]!);
    if (deckA.name === deckB.name) continue;
    const profiles: [ReturnType<typeof heuristicProfileForDeckAxes>, ReturnType<typeof heuristicProfileForDeckAxes>] = [
      heuristicProfileForDeckAxes(deckA.axes),
      heuristicProfileForDeckAxes(deckB.axes),
    ];
    let state = createGame(benchmarkDb, { seed: seedStart + g, decks: [deckA.ids, deckB.ids] });
    const snapshots: { x0: number[]; x1: number[] }[] = [];
    let step = 0;
    let ok = true;
    while (state.phase !== "gameOver" && state.pendingDecision) {
      if (step >= maxSteps) { ok = false; break; }
      if (step % sampleEvery === 0) {
        snapshots.push({
          x0: extractValueFeatures(state, 0 as PlayerId),
          x1: extractValueFeatures(state, 1 as PlayerId),
        });
      }
      const player = state.pendingDecision.player as PlayerId;
      try {
        state = applyDecision(benchmarkDb, state, heuristicAiDecision(benchmarkDb, state, profiles[player]));
      } catch {
        ok = false;
        break;
      }
      step++;
    }
    if (!ok || state.winner === null) continue;
    const winner = state.winner;
    for (const snap of snapshots) {
      rows.push({ x: snap.x0, y: winner === 0 ? 1 : 0 });
      rows.push({ x: snap.x1, y: winner === 1 ? 1 : 0 });
    }
  }
  return rows;
}

function sigmoid(z: number): number {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

function fit(rows: Row[], epochs: number, lr: number, l2: number) {
  const dim = VALUE_FEATURE_DIM;
  const n = rows.length;
  // 標準化（避免特徵尺度差異拖慢收斂），擬合後折回 raw 係數。
  const mean = new Array(dim).fill(0);
  const std = new Array(dim).fill(0);
  for (const r of rows) for (let j = 0; j < dim; j++) mean[j] += r.x[j]!;
  for (let j = 0; j < dim; j++) mean[j] /= n;
  for (const r of rows) for (let j = 0; j < dim; j++) std[j] += (r.x[j]! - mean[j]) ** 2;
  for (let j = 0; j < dim; j++) std[j] = Math.sqrt(std[j] / n) || 1;

  const z = rows.map((r) => r.x.map((v, j) => (v - mean[j]) / std[j]));
  const w = new Array(dim).fill(0);
  let b = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Array(dim).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let s = b;
      for (let j = 0; j < dim; j++) s += w[j] * z[i]![j]!;
      const p = sigmoid(s);
      const err = p - rows[i]!.y;
      for (let j = 0; j < dim; j++) gw[j] += err * z[i]![j]!;
      gb += err;
    }
    for (let j = 0; j < dim; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }

  // 折回 raw 特徵：w_raw = w_std / std；b_raw = b_std − Σ w_std·mean/std
  const wRaw = w.map((wj, j) => wj / std[j]);
  let bRaw = b;
  for (let j = 0; j < dim; j++) bRaw -= w[j] * mean[j] / std[j];

  // 指標
  let logloss = 0, correct = 0;
  const scored: { p: number; y: number }[] = [];
  for (const r of rows) {
    let s = bRaw;
    for (let j = 0; j < dim; j++) s += wRaw[j]! * r.x[j]!;
    const p = sigmoid(s);
    logloss += -(r.y * Math.log(p + 1e-12) + (1 - r.y) * Math.log(1 - p + 1e-12));
    if ((p >= 0.5 ? 1 : 0) === r.y) correct++;
    scored.push({ p, y: r.y });
  }
  logloss /= n;
  const acc = correct / n;
  const auc = computeAuc(scored);
  return { wRaw, bRaw, logloss, acc, auc };
}

function computeAuc(scored: { p: number; y: number }[]): number {
  const sorted = scored.slice().sort((a, b) => a.p - b.p);
  let rankSum = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j]!.p === sorted[i]!.p) j++;
    const avgRank = (i + 1 + j) / 2; // 1-based 平均秩
    for (let k = i; k < j; k++) if (sorted[k]!.y === 1) rankSum += avgRank;
    i = j;
  }
  const nPos = scored.reduce((a, r) => a + r.y, 0);
  const nNeg = scored.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function run(): void {
  const games = argNum("games", 400);
  const seedStart = argNum("seed-start", 5000);
  const sampleEvery = argNum("sample-every", 4);
  const maxSteps = argNum("max-steps", 4000);
  const epochs = argNum("epochs", 4000);
  const lr = argNum("lr", 0.5);
  const l2 = argNum("l2", 1e-4);

  console.log(`蒐集自對弈資料：games=${games}, sampleEvery=${sampleEvery} ...`);
  const rows = collect(games, seedStart, sampleEvery, maxSteps);
  console.log(`樣本數＝${rows.length}（正例 ${rows.reduce((a, r) => a + r.y, 0)}）`);
  if (rows.length < 100) { console.error("樣本太少，調高 --games"); process.exit(1); }

  const { wRaw, bRaw, logloss, acc, auc } = fit(rows, epochs, lr, l2);
  console.log(`\n訓練指標：log-loss=${logloss.toFixed(4)}  accuracy=${(acc * 100).toFixed(1)}%  AUC=${auc.toFixed(4)}`);
  console.log("\n特徵：" + VALUE_FEATURE_NAMES.join(", "));
  console.log("\n貼回 rollout-value.ts 的 ROLLOUT_VALUE_MODEL：");
  console.log(`  weights: [${wRaw.map((v) => v.toFixed(4)).join(", ")}],`);
  console.log(`  bias: ${bRaw.toFixed(4)},`);
  console.log(`  provenance: "fit games=${games} samples=${rows.length} logloss=${logloss.toFixed(4)} acc=${(acc * 100).toFixed(1)}% auc=${auc.toFixed(4)} [Claude 2026-06-22]",`);
}

run();
