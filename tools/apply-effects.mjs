// 把 data/effects.json 的效果 DSL 併入 data/cards.json（effect / effectStatus 欄）
// 在 data:rebuild 的最後一步執行——effect 永遠以 effects.json 為唯一真實來源，
// 重跑 import-csv / merge-official 不會弄丟（M3 開工時曾發生 cards.json 被單獨重跑蓋掉的事故）。
import { readFileSync, writeFileSync } from "node:fs";

const CARDS = new URL("../data/cards.json", import.meta.url);
const EFFECTS = new URL("../data/effects.json", import.meta.url);

const cards = JSON.parse(readFileSync(CARDS, "utf8"));
const effects = JSON.parse(readFileSync(EFFECTS, "utf8"));

const ids = new Set(Object.keys(effects));
let applied = 0;
for (const card of cards) {
  if (ids.has(card.id)) {
    card.effect = effects[card.id];
    card.effectStatus = "dsl";
    ids.delete(card.id);
    applied++;
  } else if (card.effectStatus === "dsl") {
    // effects.json 已移除該卡 → 退回 todo/vanilla
    card.effect = null;
    card.effectStatus = card.skillJa || card.skillZh ? "todo" : "vanilla";
  }
}
if (ids.size) {
  console.error(`⚠ effects.json 有未知卡號：${[...ids].join(", ")}`);
  process.exitCode = 1;
}
writeFileSync(CARDS, JSON.stringify(cards, null, 1) + "\n");
console.log(`apply-effects: ${applied} 張卡寫入 DSL（effectStatus=dsl）`);
