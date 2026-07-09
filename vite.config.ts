import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// ---- 牌組 API（dev server middleware）----
// GET  /api/decks         → 讀 decks/<學校>/<牌組>.csv（含 0 張候補列）
// POST /api/decks         → body {school, name, cards:[{id,count,printing?}]} 寫回 CSV，並同步寫入 data/decks/*.json 供 M8 analyzer 使用
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
  const dataDeckDir = join(root, "data", "decks");
  const adoptionLogPath = join(root, "data", "deck-optimizer-adoptions.jsonl");
  const favoritesPath = join(root, "data", "deck-favorites.json");
  // 牌組「常用」清單：key = `${school}/${name}`，只有勾選的牌組會出現在對戰入口
  const deckKey = (school: string, name: string) => `${school}/${name}`;
  const readFavorites = (): Set<string> => {
    if (!existsSync(favoritesPath)) return new Set();
    try {
      const parsed = JSON.parse(readFileSync(favoritesPath, "utf8")) as unknown;
      return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
    } catch { return new Set(); }
  };
  const writeFavorites = (favs: Set<string>) => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(favoritesPath, `${JSON.stringify([...favs], null, 1)}\n`, "utf8");
  };
  const listDecks = () => {
    const favorites = readFavorites();
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
        const name = f.replace(/\.csv$/, "");
        decks.push({ school, name, source: `decks/${school}/${f}`, cards, favorite: favorites.has(deckKey(school, name)) });
      }
    }
    return decks;
  };
  const listAdoptions = () => {
    if (!existsSync(adoptionLogPath)) return [];
    return readFileSync(adoptionLogPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as unknown]; }
        catch { return []; }
      })
      .slice(-50)
      .reverse();
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
      server.middlewares.use("/api/deck-optimizer-adoptions", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(listAdoptions()));
      });
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
                const { school, name, cards, optimizerAdoption } = JSON.parse(body) as {
                  school: string; name: string;
                  cards: { id: string; count: number; printing?: string }[];
                  optimizerAdoption?: unknown;
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
                mkdirSync(dataDeckDir, { recursive: true });
                writeFileSync(
                  join(dataDeckDir, `${school}-${name}.json`),
                  `${JSON.stringify({ name: `${school}-${name}`, school, source: `decks/${school}/${name}.csv`, cards }, null, 1)}\n`,
                  "utf8",
                );
                let adoptionLog: string | undefined;
                if (optimizerAdoption && typeof optimizerAdoption === "object") {
                  mkdirSync(join(root, "data"), { recursive: true });
                  const record = {
                    savedAt: new Date().toISOString(),
                    targetDeck: `${school}-${name}`,
                    source: `decks/${school}/${name}.csv`,
                    analyzerSource: `data/decks/${school}-${name}.json`,
                    optimizerAdoption,
                  };
                  appendFileSync(adoptionLogPath, `${JSON.stringify(record)}\n`, "utf8");
                  adoptionLog = "data/deck-optimizer-adoptions.jsonl";
                }
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, source: `decks/${school}/${name}.csv`, analyzerSource: `data/decks/${school}-${name}.json`, adoptionLog }));
              } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
              }
            });
            return;
          }
          if (req.method === "DELETE") {
            const url = new URL(req.url || "", `http://${req.headers.host}`);
            const school = (url.searchParams.get("school") || "").trim();
            const name = (url.searchParams.get("name") || "").trim();
            if (!school || !name || /[/\\.]{2}|[/\\]/.test(school + name)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "非法的學校或牌組名稱" }));
              return;
            }
            const csvPath = join(deckDir, school, `${name}.csv`);
            if (!existsSync(csvPath)) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: `找不到牌組 ${school}/${name}` }));
              return;
            }
            unlinkSync(csvPath);
            const jsonPath = join(dataDeckDir, `${school}-${name}.json`);
            if (existsSync(jsonPath)) unlinkSync(jsonPath);
            const favs = readFavorites();
            if (favs.delete(deckKey(school, name))) writeFavorites(favs);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, deleted: `decks/${school}/${name}.csv` }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
        }
      });
      // POST /api/deck-favorites  body {school, name, favorite} → 切換「常用」狀態
      server.middlewares.use("/api/deck-favorites", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { school, name, favorite } = JSON.parse(body) as { school: string; name: string; favorite: boolean };
            if (!school || !name) throw new Error("缺少 school 或 name");
            const favs = readFavorites();
            if (favorite) favs.add(deckKey(school, name));
            else favs.delete(deckKey(school, name));
            writeFavorites(favs);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, favorite }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
          }
        });
      });
    },
  };
}

// 對戰紀錄 API。單場 replay 檔可達 16MB，過去列表每次都 readFileSync+parse
// 全部檔案（累積後 ~1GB／~4s），拖慢每次頁面載入。改為維護一份輕量摘要
// index.jsonl（一場一行、幾百 bytes）：列表只讀 index，永遠不碰大檔；存檔時
// 即時 append，缺漏／被刪的檔案在 GET 時自我修復（首次會一次性回填既有檔）。
function replayApi(root: string): Plugin {
  const replaysDir = join(root, "data", "replays");
  const indexPath = join(replaysDir, "index.jsonl");

  type ReplaySummary = {
    id: string;
    startedAt: string;
    decks: [string, string];
    winner: number | null;
    entryCount: number;
  };

  const summarize = (id: string, session: any): ReplaySummary => {
    const lastEntry = session.entries?.[session.entries.length - 1];
    return {
      id,
      startedAt: session.startedAt || new Date().toISOString(),
      decks: [
        session.decks?.[0]?.label || "Unknown",
        session.decks?.[1]?.label || "Unknown",
      ],
      winner: lastEntry ? lastEntry.after.winner : null,
      entryCount: session.entries?.length || 0,
    };
  };

  const loadIndex = (): Map<string, ReplaySummary> => {
    const map = new Map<string, ReplaySummary>();
    if (!existsSync(indexPath)) return map;
    for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as ReplaySummary;
        if (s && s.id) map.set(s.id, s); // 後出現者覆蓋，天然去重
      } catch { /* 略過壞行 */ }
    }
    return map;
  };

  const writeIndex = (map: Map<string, ReplaySummary>) => {
    const body = [...map.values()].map((s) => JSON.stringify(s)).join("\n");
    writeFileSync(indexPath, body ? body + "\n" : "", "utf8");
  };

  // 只讀 index；index 缺的檔才逐一 parse 補上，檔案已刪的順手剔除。
  // 穩態下（所有檔都已入 index）完全不碰 16MB 大檔。
  const getReplayList = (limit?: number): ReplaySummary[] => {
    if (!existsSync(replaysDir)) return [];
    const files = readdirSync(replaysDir).filter((f) => f.endsWith(".json"));
    const index = loadIndex();
    const fileSet = new Set(files);
    let changed = false;
    for (const f of files) {
      if (index.has(f)) continue;
      try {
        const session = JSON.parse(readFileSync(join(replaysDir, f), "utf8"));
        index.set(f, summarize(f, session));
        changed = true;
      } catch (e) {
        console.error(`Failed to parse replay file ${f}:`, e);
      }
    }
    for (const id of [...index.keys()]) {
      if (!fileSet.has(id)) { index.delete(id); changed = true; }
    }
    if (changed) writeIndex(index);
    const list = [...index.values()].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    return limit && limit > 0 ? list.slice(0, limit) : list;
  };

  return {
    name: "replay-api",
    configureServer(server) {
      server.middlewares.use("/api/replays", (req, res) => {
        const url = new URL(req.url || "", `http://${req.headers.host}`);
        const id = url.searchParams.get("id");
        try {
          if (req.method === "GET") {
            if (id) {
              const filePath = join(replaysDir, id);
              if (!filePath.startsWith(replaysDir)) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: "Access denied" }));
                return;
              }
              if (!existsSync(filePath)) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "Replay not found" }));
                return;
              }
              res.setHeader("Content-Type", "application/json");
              res.end(readFileSync(filePath, "utf8"));
              return;
            }
            // 預設只回最近 10 場；?all=1 或 ?limit=N 取更多
            const all = url.searchParams.get("all") === "1";
            const limitParam = parseInt(url.searchParams.get("limit") || "", 10);
            const limit = all ? undefined : (Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 10);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(getReplayList(limit)));
            return;
          }
          if (req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              try {
                const session = JSON.parse(body);
                if (!session.startedAt) {
                  throw new Error("Missing startedAt in session");
                }
                const cleanTime = session.startedAt.replace(/[:.]/g, "-");
                const label0 = (session.decks?.[0]?.label || "Player").replace(/[/\\?%*:|"<>]/g, "_");
                const label1 = (session.decks?.[1]?.label || "AI").replace(/[/\\?%*:|"<>]/g, "_");
                const fileName = `replay-${cleanTime}-${label0}-vs-${label1}.json`;
                mkdirSync(replaysDir, { recursive: true });
                const filePath = join(replaysDir, fileName);
                writeFileSync(filePath, JSON.stringify(session, null, 2), "utf8");
                appendFileSync(indexPath, `${JSON.stringify(summarize(fileName, session))}\n`, "utf8");
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, file: fileName }));
              } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
              }
            });
            return;
          }
          if (req.method === "DELETE") {
            if (!id) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "Missing id parameter" }));
              return;
            }
            const filePath = join(replaysDir, id);
            if (!filePath.startsWith(replaysDir)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "Access denied" }));
              return;
            }
            if (existsSync(filePath)) {
              unlinkSync(filePath);
            }
            const index = loadIndex();
            if (index.delete(id)) writeIndex(index); // 同步剔除 index
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
        }
      });
    }
  };
}

function humanAnchorApi(root: string): Plugin {
  const anchorDir = join(root, "data", "human-anchor");
  const matchesPath = join(anchorDir, "matches.jsonl");
  const engineVersion = () => {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return "dev";
    }
  };
  const readMatches = () => {
    if (!existsSync(matchesPath)) return [];
    return readFileSync(matchesPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as { replayRef?: string }]; }
        catch { return []; }
      });
  };
  const validateRecord = (record: any) => {
    if (!record || typeof record !== "object") throw new Error("record must be an object");
    if (typeof record.date !== "string" || Number.isNaN(Date.parse(record.date))) throw new Error("invalid date");
    if (record.aiEngine !== "strong" && record.aiEngine !== "heuristic") throw new Error("invalid aiEngine");
    if (!record.decks || typeof record.decks.player !== "string" || typeof record.decks.ai !== "string") throw new Error("invalid decks");
    if (record.result !== "player" && record.result !== "ai") throw new Error("invalid result");
    if (!Array.isArray(record.setScore) || record.setScore.length !== 2 || !record.setScore.every((n: unknown) => Number.isInteger(n) && Number(n) >= 0)) {
      throw new Error("invalid setScore");
    }
    if (typeof record.serious !== "boolean") throw new Error("invalid serious");
    if (!Number.isInteger(record.playerDecisions) || record.playerDecisions < 0) throw new Error("invalid playerDecisions");
    if (typeof record.replayRef !== "string") throw new Error("invalid replayRef");
    if (typeof record.note !== "string") throw new Error("invalid note");
  };

  return {
    name: "human-anchor-api",
    configureServer(server) {
      server.middlewares.use("/api/human-anchor", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const incoming = JSON.parse(body);
            validateRecord(incoming);
            const duplicate = incoming.replayRef
              ? readMatches().some((match) => match.replayRef === incoming.replayRef)
              : false;
            if (duplicate) {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, duplicate: true, file: "data/human-anchor/matches.jsonl" }));
              return;
            }
            const record = {
              ...incoming,
              engineVersion: typeof incoming.engineVersion === "string" && incoming.engineVersion.trim()
                ? incoming.engineVersion.trim()
                : engineVersion(),
            };
            mkdirSync(anchorDir, { recursive: true });
            appendFileSync(matchesPath, `${JSON.stringify(record)}\n`, "utf8");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, duplicate: false, file: "data/human-anchor/matches.jsonl" }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: "/BREAK2.0/",
  plugins: [react(), deckApi(__dirname), replayApi(__dirname), humanAnchorApi(__dirname)],
  server: {
    // 這些是可重生產物／執行期大檔（replay dump 累積可達 ~1GB、AB log），
    // 不是原始碼、也不手改，排除出檔案監看以省啟動負擔與記憶體。
    watch: {
      ignored: ["**/data/replays/**", "**/data/ab/**", "**/dist/**"],
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
} as ReturnType<typeof defineConfig>);
