// 卡圖下載：依 data/raw/official_cards.json 下載全部卡面 → public/cards/{card_no}-{image_end}.webp
// 已存在的檔案跳過（可重複執行）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "cards");
const BASE = "https://www.takaratomy.co.jp/products/haikyuvobacabreak/cardlist/card/";
mkdirSync(OUT, { recursive: true });

const items = JSON.parse(readFileSync(join(ROOT, "data", "raw", "official_cards.json"), "utf8"));
const targets = [...new Map(items.map((i) => [`${i.card_no}-${i.image_end}`, i])).keys()];

let ok = 0, skip = 0, fail = [];
for (const name of targets) {
  const file = join(OUT, `${name}.webp`);
  if (existsSync(file)) { skip++; continue; }
  try {
    const res = await fetch(BASE + `${name}.webp`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    ok++;
    await new Promise((r) => setTimeout(r, 250)); // 禮貌間隔
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
}
console.log(`下載 ${ok}、跳過 ${skip}、失敗 ${fail.length} / 共 ${targets.length}`);
for (const f of fail) console.log("  ✗ " + f);
