// 官方判例（ルール・Q&A）抓取：通用 Q&A ＋ 逐卡查詢個別判例
// 輸出 data/raw/official_faq.json（依 Q&A id 去重）
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://www.takaratomy.co.jp/products/haikyuvobacabreak/rules/itemsearch.php";

const cards = JSON.parse(readFileSync(join(ROOT, "data", "cards.json"), "utf8"));
const byId = new Map();

async function fetchFaq(query, label) {
  const res = await fetch(API + query);
  if (!res.ok) { console.log(`✗ ${label}: HTTP ${res.status}`); return; }
  const d = await res.json();
  const groups = d.items ?? {};
  for (const g of Object.values(groups)) {
    for (const q of g.items ?? []) byId.set(q.id, q);
  }
}

await fetchFaq("", "general");
const generalCount = byId.size;
let done = 0;
for (const c of cards) {
  await fetchFaq("?cn=" + encodeURIComponent(c.id), c.id);
  done++;
  if (done % 50 === 0) console.log(`...${done}/${cards.length}（累計 ${byId.size} 件）`);
  await new Promise((r) => setTimeout(r, 200));
}

const all = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
writeFileSync(join(ROOT, "data", "raw", "official_faq.json"), JSON.stringify(all, null, 1), "utf8");
console.log(`完成：通用 ${generalCount} 件、總計 ${all.length} 件（含卡片個別判例 ${all.length - generalCount} 件）`);
