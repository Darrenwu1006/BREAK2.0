// M9-P0 CP2 驗收 demo：真實牌組 heuristic 對局，逐決策印「引擎 log ↔ 演出腳本」對照。
// 用法：npx vite-node tools/presentation-script-demo.ts -- [--seed 42] [--sets 1]
//       [--deckA data/decks/烏野-預組.json] [--deckB data/decks/音駒-預組.json]
// [Claude 2026-07-10] spec §1.2：headless 文字 renderer 對照引擎 log 人工抽查一致性。

import { readFileSync } from "node:fs";
import cardsJson from "../data/cards.json";
import { heuristicAiDecision } from "../src/ai/heuristic";
import { applyDecision, createGame } from "../src/engine/engine";
import type { Card } from "../src/data/types";
import type { CardDb } from "../src/engine/types";
import { derivePresentationEvents } from "../src/ui-lab/presentation/derive";
import { renderScript } from "../src/ui-lab/presentation/textRenderer";

const db: CardDb = new Map((cardsJson as unknown as Card[]).map((c) => [c.id, c]));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function loadDeck(path: string): { name: string; ids: string[] } {
  const json = JSON.parse(readFileSync(path, "utf-8")) as { name: string; cards: { id: string; count: number }[] };
  return { name: json.name, ids: json.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]) };
}

const seed = Number(arg("seed", "42"));
const maxSets = Number(arg("sets", "1"));
const deckA = loadDeck(arg("deckA", "data/decks/烏野-預組.json"));
const deckB = loadDeck(arg("deckB", "data/decks/音駒-預組.json"));

console.log(`# 演出腳本 demo — P0=${deckA.name} vs P1=${deckB.name}（seed=${seed}，跑 ${maxSets} 個 Set）\n`);

let s = createGame(db, { seed, decks: [deckA.ids, deckB.ids] });
let setsDone = 0;
for (let i = 0; i < 5000 && s.phase !== "gameOver" && setsDone < maxSets; i++) {
  const actor = s.pendingDecision!.player;
  const decision = heuristicAiDecision(db, s);
  const next = applyDecision(db, s, decision);
  const events = derivePresentationEvents(db, s, decision, next);
  const logDelta = next.log.slice(s.log.length);

  console.log(`=== 手 #${i + 1}  P${actor} ${decision.type} ===`);
  for (const entry of logDelta) console.log(`  [log ] ${entry.player !== null ? `P${entry.player} ` : ""}${entry.text}`);
  for (const line of renderScript(db, events)) console.log(`  [演出] ${line}`);
  console.log("");

  if (logDelta.some((e) => e.event?.kind === "set-won" || e.event?.kind === "match-won")) setsDone++;
  s = next;
}
