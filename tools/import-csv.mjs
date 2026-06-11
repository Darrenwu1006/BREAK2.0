// CSV → JSON 匯入工具
// 讀取 pool/*.csv 與 deck/*/*.csv，輸出 data/cards.json 與 data/decks/*.json
// 卡片以「卡片編號」為主鍵；同編號多列 → 合併為同一張卡的多個 printings（卡面版本）
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** RFC4180 風 CSV 解析（支援引號欄位內的逗號與換行） */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f.trim() !== "")) rows.push(row); }
  return rows;
}

const clean = (s) => (s ?? "").trim();
const isEmpty = (s) => { const v = clean(s); return v === "" || v === "-" || v === "－"; };
/** 參數：「－」→ null（規則上不是 0）；數字 → int */
function parseParam(s, warnCtx) {
  if (isEmpty(s)) return null;
  const n = parseInt(clean(s), 10);
  if (Number.isNaN(n)) { warnings.push(`${warnCtx}: 參數無法解析 "${s}" → 視為 null`); return null; }
  return n;
}
/** 時機點："登場,發球,舉球" → ["登場","發球","舉球"] */
const parseTiming = (s) => (isEmpty(s) ? [] : clean(s).split(/[,、，]/).map((t) => t.trim()).filter(Boolean));

const warnings = [];
const cards = new Map();

function addCard(rec) {
  const existing = cards.get(rec.id);
  if (!existing) {
    cards.set(rec.id, rec);
    return;
  }
  // 同編號 → 視為同一張卡的另一個卡面版本；檢查遊戲資訊是否一致
  for (const key of ["type", "nameJa", "skillZh"]) {
    if (clean(String(existing[key] ?? "")) !== clean(String(rec[key] ?? ""))) {
      warnings.push(`${rec.id}: 同編號但「${key}」不一致 → 保留先出現者，請人工確認\n  A: ${existing[key]}\n  B: ${rec[key]}`);
    }
  }
  for (const p of rec.printings) {
    if (!existing.printings.some((q) => q.rarity === p.rarity)) existing.printings.push(p);
  }
}

function importPool(file, kind) {
  const rows = parseCSV(readFileSync(join(ROOT, "pool", file), "utf8"));
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [clean(h), i]));
  const need = ["School", "卡片類型", "卡片編號", "卡片名稱", "時機點", "稀有度", "完整技能", "注釋"];
  for (const k of need) if (!(k in idx)) throw new Error(`${file}: 缺少欄位 ${k}（實際: ${header.join("/")}）`);

  for (const row of rows.slice(1)) {
    const get = (k) => row[idx[k]] ?? "";
    const id = clean(get("卡片編號"));
    if (!/^HV-/.test(id)) { warnings.push(`${file}: 略過格式異常列（編號="${id}", 名稱="${clean(get("卡片名稱"))}"）`); continue; }
    const ctx = `${file} ${id}`;
    const rec = {
      id,
      type: kind,
      nameJa: clean(get("卡片名稱")),
      affiliations: clean(get("School")) ? [clean(get("School"))] : [],
      positions: kind === "CHARACTER" ? parseTiming(get("位置")).flatMap((p) => p.split("/")) : [],
      grades: [], // 學年：CSV 無此欄，待官網爬蟲補
      params:
        kind === "CHARACTER"
          ? {
              serve: parseParam(get("發球"), ctx),
              block: parseParam(get("攔網"), ctx),
              receive: parseParam(get("接球"), ctx),
              toss: parseParam(get("托球"), ctx),
              attack: parseParam(get("攻擊"), ctx),
            }
          : null,
      timing: parseTiming(get("時機點")),
      skillJa: null, // 日文原文：待官網爬蟲補
      skillZh: isEmpty(get("完整技能")) ? null : clean(get("完整技能")),
      skillZhStatus: isEmpty(get("完整技能")) ? "none" : "human", // human=使用者翻譯 / machine=機翻待校 / none=無技能
      notes: isEmpty(get("注釋")) ? null : clean(get("注釋")),
      printings: [{ rarity: isEmpty(get("稀有度")) ? "?" : clean(get("稀有度")), image: null }],
      effect: null, // 效果 DSL：M3 填入
      effectStatus: isEmpty(get("完整技能")) ? "vanilla" : "todo",
    };
    addCard(rec);
  }
}

importPool("All_Characters.csv", "CHARACTER");
importPool("All_Events.csv", "EVENT");

// --- 牌組（decks/<學校>/<牌組名>.csv）---
// 跳過：template.csv（全 0 的構築起點）、All Cards（收藏清單，暫不使用）、非 csv
const deckDir = join(ROOT, "decks");
const decks = [];
for (const entry of readdirSync(deckDir)) {
  const p = join(deckDir, entry);
  if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p)) {
    if (!f.endsWith(".csv") || f === "template.csv" || f.includes("All Cards")) continue;
    const rows = parseCSV(readFileSync(join(p, f), "utf8"));
    const idx = Object.fromEntries(rows[0].map((h, i) => [clean(h), i]));
    const deckName = `${entry}-${f.replace(/\.csv$/, "")}`;
    const deck = { name: deckName, school: entry, source: `decks/${entry}/${f}`, cards: [] };
    for (const row of rows.slice(1)) {
      const id = clean(row[idx["卡片編號"]]);
      const count = parseInt(clean(row[idx["數量"]]), 10);
      if (count === 0) continue; // 候補卡記錄（未編入 40 張）
      if (!/^HV/.test(id) || Number.isNaN(count)) { if (id || clean(row[idx["卡片名稱"]])) warnings.push(`${deckName}: 略過異常列 ${row.join(",")}`); continue; }
      if (!cards.has(id)) warnings.push(`${deckName}: 牌組引用了卡池中不存在的卡 ${id}（${clean(row[idx["卡片名稱"]])}）`);
      deck.cards.push({ id, count });
    }
    const total = deck.cards.reduce((s, c) => s + c.count, 0);
    if (total !== 40) warnings.push(`${deckName}: 牌組共 ${total} 張（規則要求正好 40）`);
    decks.push(deck);
  }
}

// --- 輸出 ---
rmSync(join(ROOT, "data", "decks"), { recursive: true, force: true });
mkdirSync(join(ROOT, "data", "decks"), { recursive: true });
const cardList = [...cards.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(join(ROOT, "data", "cards.json"), JSON.stringify(cardList, null, 1), "utf8");
for (const d of decks) writeFileSync(join(ROOT, "data", "decks", `${d.name}.json`), JSON.stringify(d, null, 1), "utf8");

console.log(`卡片: ${cardList.length} 張（CHARACTER ${cardList.filter((c) => c.type === "CHARACTER").length} / EVENT ${cardList.filter((c) => c.type === "EVENT").length}）`);
console.log(`牌組: ${decks.map((d) => `${d.name}(${d.cards.reduce((s, c) => s + c.count, 0)})`).join(", ")}`);
if (warnings.length) {
  console.log(`\n⚠ 警告 ${warnings.length} 件:`);
  for (const w of warnings) console.log("  - " + w);
}
