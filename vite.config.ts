import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---- 牌組 API（dev server middleware）----
// GET  /api/decks         → 讀 decks/<學校>/<牌組>.csv（含 0 張候補列）
// POST /api/decks         → body {school, name, cards:[{id,count,printing?}]} 寫回 CSV
// 跳過 template.csv 與 All Cards（收藏清單）

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); if (row.some((f) => f.trim())) rows.push(row); }
  return rows;
}

const csvField = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function deckApi(root: string): Plugin {
  const deckDir = join(root, "decks");
  const listDecks = () => {
    const decks: unknown[] = [];
    for (const school of readdirSync(deckDir)) {
      const p = join(deckDir, school);
      if (!statSync(p).isDirectory()) continue;
      for (const f of readdirSync(p)) {
        if (!f.endsWith(".csv") || f === "template.csv" || f.includes("All Cards")) continue;
        const rows = parseCSV(readFileSync(join(p, f), "utf8"));
        const idx = Object.fromEntries(rows[0]!.map((h, i) => [h.trim(), i]));
        const cards = rows.slice(1).flatMap((r) => {
          const id = (r[idx["卡片編號"]!] ?? "").trim();
          const count = parseInt((r[idx["數量"]!] ?? "").trim(), 10);
          if (!/^HV/.test(id) || Number.isNaN(count)) return [];
          const printing = idx["卡面"] !== undefined ? (r[idx["卡面"]!] ?? "").trim() || undefined : undefined;
          return [{ id, count, ...(printing ? { printing } : {}) }];
        });
        decks.push({ school, name: f.replace(/\.csv$/, ""), source: `decks/${school}/${f}`, cards });
      }
    }
    return decks;
  };

  return {
    name: "deck-api",
    buildStart() {
      this.emitFile({
        type: "asset",
        fileName: "decks.json",
        source: JSON.stringify(listDecks()),
      });
    },
    configureServer(server) {
      server.middlewares.use("/api/decks", (req, res) => {
        try {
          if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(listDecks()));
            return;
          }
          if (req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              try {
                const { school, name, cards } = JSON.parse(body) as {
                  school: string; name: string;
                  cards: { id: string; count: number; printing?: string }[];
                };
                if (!school || !name || /[/\\.]{2}|[/\\]/.test(school + name)) throw new Error("非法的學校或牌組名稱");
                const cardDb = new Map(
                  (JSON.parse(readFileSync(join(root, "data", "cards.json"), "utf8")) as { id: string; nameZh?: string | null; nameJa: string }[])
                    .map((c) => [c.id, c]),
                );
                const lines = ["卡片名稱,卡片編號,數量,卡面"];
                for (const c of cards) {
                  const card = cardDb.get(c.id);
                  if (!card) throw new Error(`未知卡片 ${c.id}`);
                  lines.push([csvField(card.nameZh || card.nameJa), c.id, String(c.count), c.printing ?? ""].join(","));
                }
                mkdirSync(join(deckDir, school), { recursive: true });
                writeFileSync(join(deckDir, school, `${name}.csv`), lines.join("\n") + "\n", "utf8");
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, source: `decks/${school}/${name}.csv` }));
              } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
              }
            });
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
        }
      });
    },
  };
}

export default defineConfig({
  base: "/BREAK2.0/",
  plugins: [react(), deckApi(__dirname)],
  test: {
    include: ["src/**/*.test.ts"],
  },
} as ReturnType<typeof defineConfig>);
