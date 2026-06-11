// data/raw/official_faq.json → docs/RULINGS.md（人類可讀的判例總覽）
// M3 時每條判例會再轉成引擎測試案例（以 id 對應）
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const faqs = JSON.parse(readFileSync(join(ROOT, "data", "raw", "official_faq.json"), "utf8"));
const cards = new Map(JSON.parse(readFileSync(join(ROOT, "data", "cards.json"), "utf8")).map((c) => [c.id, c]));

const general = faqs.filter((q) => !q.card_no);
const perCard = faqs.filter((q) => q.card_no);

let md = `# 官方判例（ルール・Q&A）

> 來源：官網 rules/itemsearch.php（工具：tools/fetch-faq.mjs → tools/gen-rulings.mjs，請勿手動編輯本檔）
> 共 ${faqs.length} 件（通用 ${general.length}／卡片個別 ${perCard.length}）。每條的 Q編號 對應 official_faq.json 的 id，M3 判例測試以此編號命名。

## 通用判例
`;
for (const q of general) {
  md += `\n### Q${q.id}（${q.category}）\n**Q:** ${q.que.trim()}\n**A:** ${q.ans.trim()}\n`;
}

md += `\n## 卡片個別判例\n`;
const byCard = new Map();
for (const q of perCard) {
  if (!byCard.has(q.card_no)) byCard.set(q.card_no, []);
  byCard.get(q.card_no).push(q);
}
for (const [no, qs] of [...byCard.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const card = cards.get(no);
  md += `\n### ${no} ${card ? card.nameZh || card.nameJa : qs[0].card_name ?? ""}\n`;
  for (const q of qs.sort((a, b) => Number(a.order) - Number(b.order))) {
    md += `- **Q${q.id}:** ${q.que.trim()}\n  **A:** ${q.ans.trim()}\n`;
  }
}

writeFileSync(join(ROOT, "docs", "RULINGS.md"), md, "utf8");
console.log(`docs/RULINGS.md 產出完成（${faqs.length} 件、${byCard.size} 張卡有個別判例）`);
