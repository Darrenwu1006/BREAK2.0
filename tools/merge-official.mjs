// 官網資料合併工具：data/raw/official_cards.json → data/cards.json
// - 官網是日文欄位（卡名/讀音/技能原文/所属+学年/位置/參數/卡面版本）的權威來源
// - 本地既有的繁中欄位（nameZh/skillZh/notes/effect）一律保留
// - 參數不一致時以官網為準並警告（使用者 CSV 可能抄錯）
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const warnings = [];
const clean = (s) => (s ?? "").trim();
const dash = (s) => { const v = clean(s); return v === "" || v === "-" || v === "－" ? null : v; };

// 官網所属欄 typo 修正表
const AFF_FIX = { "梟谷·3年/梟谷2·年": "梟谷·3年/梟谷·2年" };

/** "烏野·1年,音駒·2年" → { affiliations:["烏野","音駒"], grades:["1年","2年"] }（分隔符 ·・･ 混用） */
function parseAffiliation(raw) {
  const v = AFF_FIX[clean(raw)] ?? clean(raw);
  const affiliations = [], grades = [];
  if (!dash(v)) return { affiliations, grades };
  for (const entry of v.split(/[,，/]/)) {
    const m = entry.trim().match(/^(.+?)[·・･](\d年)$/);
    if (m) {
      if (!affiliations.includes(m[1])) affiliations.push(m[1]);
      if (!grades.includes(m[2])) grades.push(m[2]);
    } else if (entry.trim()) {
      if (!affiliations.includes(entry.trim())) affiliations.push(entry.trim());
    }
  }
  return { affiliations, grades };
}

const parsePositions = (raw) => (dash(raw) ? [...new Set(clean(raw).split(/[,，/]/).map((s) => s.trim()).filter(Boolean))] : []);
const parseParam = (s) => (dash(s) === null ? null : parseInt(clean(s), 10));

const official = JSON.parse(readFileSync(join(ROOT, "data", "raw", "official_cards.json"), "utf8"));
const cards = new Map(JSON.parse(readFileSync(join(ROOT, "data", "cards.json"), "utf8")).map((c) => [c.id, c]));

// 官網列 → 以卡號分組
const byNo = new Map();
for (const item of official) {
  if (!byNo.has(item.card_no)) byNo.set(item.card_no, []);
  byNo.get(item.card_no).push(item);
}

let added = 0, enriched = 0;
for (const [cardNo, rows] of byNo) {
  const base = rows[0];
  const { affiliations, grades } = parseAffiliation(base.affiliation);
  const officialParams =
    base.category === "CHARACTER"
      ? { serve: parseParam(base.serve), block: parseParam(base.block), receive: parseParam(base.receive), toss: parseParam(base.toss), attack: parseParam(base.attack) }
      : null;
  const printings = rows.map((r) => ({
    rarity: clean(r.vobarity),
    imageEnd: clean(r.image_end),
    image: `cards/${cardNo}-${clean(r.image_end)}.webp`,
    illustrator: dash(r.illustrator),
  }));

  let card = cards.get(cardNo);
  if (!card) {
    card = {
      id: cardNo,
      type: base.category,
      nameJa: clean(base.name),
      nameZh: null,
      affiliations, grades,
      positions: parsePositions(base.position),
      params: officialParams,
      timing: [],
      skillJa: null, skillZh: null, skillZhStatus: "none",
      notes: null, printings: [],
      effect: null, effectStatus: "vanilla",
    };
    cards.set(cardNo, card);
    added++;
  } else {
    enriched++;
    if (card.nameJa !== clean(base.name)) {
      // 本地 CSV 的卡片名稱多為繁中譯名 → 移到 nameZh 保存，nameJa 以官網為準
      if (!card.nameZh) card.nameZh = card.nameJa;
      warnings.push(`${cardNo}: 名稱不一致 → nameJa="${clean(base.name)}"（官網）, nameZh="${card.nameZh}"（本地保存）`);
      card.nameJa = clean(base.name);
    }
    if (officialParams && card.params) {
      for (const k of Object.keys(officialParams)) {
        if (card.params[k] !== officialParams[k]) {
          warnings.push(`${cardNo} ${card.nameJa}: 參數 ${k} 不一致 本地${card.params[k]} / 官網${officialParams[k]} → 採官網`);
        }
      }
    }
    card.params = officialParams;
    card.affiliations = affiliations.length ? affiliations : card.affiliations;
    card.grades = grades;
    card.positions = parsePositions(base.position).length ? parsePositions(base.position) : card.positions;
  }

  // 官網權威欄位（新卡舊卡一致處理）
  card.type = base.category;
  card.nameRuby = dash(base.name_ruby);
  card.skillJa = dash(base.skill);
  card.annotationJa = dash(base.annotation);
  card.productType = clean(base.product_type);
  card.productName = clean(base.product_name);
  card.printings = printings; // 官網卡面清單為準（本地原本只有稀有度字串）

  // 狀態推導
  if (card.skillJa && !card.skillZh) card.skillZhStatus = "missing";
  else if (!card.skillJa && !card.skillZh) card.skillZhStatus = "none";
  if (card.skillJa || card.skillZh) { if (card.effectStatus === "vanilla") card.effectStatus = "todo"; }
  else card.effectStatus = card.effectStatus === "vanilla" ? "vanilla" : card.effectStatus;
}

// 機翻草稿套用（data/translations.json；skillZh 缺漏時補上並標記 machine）
try {
  const translations = JSON.parse(readFileSync(join(ROOT, "data", "translations.json"), "utf8"));
  let applied = 0;
  for (const [id, zh] of Object.entries(translations)) {
    if (id.startsWith("_")) continue;
    const card = cards.get(id);
    if (!card) { warnings.push(`translations.json: 查無卡號 ${id}`); continue; }
    if (!card.skillZh) { card.skillZh = zh; card.skillZhStatus = "machine"; applied++; }
  }
  console.log(`機翻草稿套用: ${applied} 張`);
} catch { /* translations.json 不存在時略過 */ }

// 本地有但官網沒有的卡（理論上為 0）
for (const id of cards.keys()) if (!byNo.has(id)) warnings.push(`${id}: 本地存在但官網查無此卡號`);

const out = [...cards.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(join(ROOT, "data", "cards.json"), JSON.stringify(out, null, 1), "utf8");

const missing = out.filter((c) => c.skillZhStatus === "missing").length;
console.log(`合併完成: 共 ${out.length} 張（新增 ${added}、補充 ${enriched}）`);
console.log(`待翻譯（有日文技能、無繁中）: ${missing} 張`);
if (warnings.length) {
  console.log(`\n⚠ 警告 ${warnings.length} 件:`);
  for (const w of warnings) console.log("  - " + w);
}
