// 官網卡片列表抓取：cardlist/itemsearch.php?p=N 逐頁 → data/raw/official_cards.json
// 每頁 20 筆，items 為空陣列即停。全量覆蓋、可重跑。
// 這是 data:rebuild 的上游：merge-official.mjs 讀本檔輸出。
// （M1 當時用一次性腳本抓取未留存，本工具補回；見 .claude/skills/update-card-pool/SKILL.md）
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://www.takaratomy.co.jp/products/haikyuvobacabreak/cardlist/itemsearch.php";
const OUT = join(ROOT, "data", "raw", "official_cards.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const all = [];
for (let p = 1; p <= 500; p++) {
  const res = await fetch(`${API}?p=${p}`);
  if (!res.ok) throw new Error(`p=${p} HTTP ${res.status}（官網暫時故障或改版）— 停止，不寫壞資料`);
  const json = await res.json();
  if (!json || !Array.isArray(json.items)) {
    throw new Error(`p=${p} 回應無 items 陣列 → 官網格式可能改版，停止（不寫壞資料）`);
  }
  if (json.items.length === 0) break; // 超出範圍 → 抓完
  all.push(...json.items);
  process.stdout.write(`\r抓取中… p=${p} 累計 ${all.length} 筆`);
  await sleep(300); // 禮貌延遲
}
process.stdout.write("\n");

// 健全性檢查（任一失敗即停，不覆蓋既有檔）
const noCardNo = all.filter((x) => !x.card_no);
if (noCardNo.length) throw new Error(`${noCardNo.length} 筆缺 card_no → 格式異常，中止`);
const ids = all.map((x) => x.ID);
if (new Set(ids).size !== ids.length) throw new Error("ID 有重複 → 抓取異常，中止");
if (all.length < 100) throw new Error(`只抓到 ${all.length} 筆，疑似不完整，中止`);

// 與既有檔比對，提示新增/移除的卡號（增量更新時的可見回饋）
let prevCardNos = new Set();
try {
  prevCardNos = new Set(JSON.parse(readFileSync(OUT, "utf8")).map((x) => x.card_no));
} catch { /* 首次執行，無既有檔 */ }
const nowCardNos = new Set(all.map((x) => x.card_no));
const added = [...nowCardNos].filter((c) => !prevCardNos.has(c));
const removed = [...prevCardNos].filter((c) => !nowCardNos.has(c));

writeFileSync(OUT, JSON.stringify(all, null, 1) + "\n");
console.log(`✓ ${all.length} 列（${nowCardNos.size} 唯一卡號）→ data/raw/official_cards.json`);
if (added.length) console.log(`  新增卡號 ${added.length}：${added.join(", ")}`);
if (removed.length) console.log(`  ⚠ 既有檔有、官網已無 ${removed.length}：${removed.join(", ")}`);
if (!added.length && !removed.length) console.log("  卡號無變化（與既有檔一致）");
