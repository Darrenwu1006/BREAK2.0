import { useEffect, useMemo, useState } from "react";
import cardsJson from "../data/cards.json";
import type { Card } from "./data/types";
import type { CardDb } from "./engine/types";
import { Game } from "./ui/Game";
import { setCardPrintings } from "./ui/CardView";
import { DeckEditor, type ApiDeck } from "./ui/DeckEditor";
import { DeckOptimizerPreview } from "./ui/DeckOptimizerPreview";
import type { DeckMeta } from "./ui/gameTypes";
import type { ReplaySession } from "./ui/replayHistory";

const expand = (d: ApiDeck): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

const APP_VERSION = "0.7.0"; // M7 介面線；卡池/技能進度由資料即時計算

function deckMeta(db: CardDb, deck: ApiDeck): DeckMeta {
  let implementedCount = 0;
  let unimplementedCount = 0;
  for (const entry of deck.cards) {
    const status = db.get(entry.id)?.effectStatus;
    if (status === "todo") unimplementedCount += entry.count;
    else implementedCount += entry.count;
  }
  return {
    school: deck.school,
    name: deck.name,
    total: deck.cards.reduce((sum, card) => sum + card.count, 0),
    implementedCount,
    unimplementedCount,
  };
}

export function App() {
  const db: CardDb = useMemo(() => new Map((cardsJson as Card[]).map((c) => [c.id, c])), []);
  // 當前卡池/版本狀態（由資料即時計算，不硬編、不會過時）
  const poolStatus = useMemo(() => {
    let implemented = 0;
    let withSkill = 0;
    const expansions = new Set<string>();
    for (const card of db.values()) {
      if (card.effectStatus === "dsl" || card.effectStatus === "script") { implemented++; withSkill++; }
      else if (card.effectStatus === "todo") withSkill++;
      // 彈號＝id 中字母開頭的段（D01/P01/P02/PR…），跳過 HV 前綴與純數字流水號
      const code = card.id.split("-").find((seg) => seg !== "HV" && /^[A-Za-z]+\d*$/.test(seg));
      if (code) expansions.add(code);
    }
    const pct = withSkill ? Math.round((implemented / withSkill) * 100) : 100;
    return { exps: [...expansions].sort().join("／"), implemented, withSkill, pct };
  }, [db]);
  const [decks, setDecks] = useState<ApiDeck[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [myDeck, setMyDeck] = useState(0);
  const [aiDeck, setAiDeck] = useState(1);
  const [mode, setMode] = useState<"menu" | "game" | "editor" | "optimizer">("menu");
  const [loadedReplay, setLoadedReplay] = useState<ReplaySession | null>(null);
  const [replays, setReplays] = useState<any[]>([]);
  const [loadingReplays, setLoadingReplays] = useState(false);

  async function refreshDecks() {
    try {
      const endpoint = import.meta.env.DEV ? "/api/decks" : `${import.meta.env.BASE_URL}decks.json`;
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const list = (await res.json()) as ApiDeck[];
      setDecks(list);
      setLoadError(null);
    } catch (e) {
      setLoadError(`無法載入牌組：${e}`);
    }
  }

  async function refreshReplays() {
    setLoadingReplays(true);
    try {
      const res = await fetch("/api/replays");
      if (res.ok) {
        const list = await res.json();
        setReplays(list);
      }
    } catch (e) {
      console.error("無法載入歷史對戰紀錄:", e);
    } finally {
      setLoadingReplays(false);
    }
  }

  async function loadReplay(id: string) {
    try {
      const res = await fetch(`/api/replays?id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error("讀取紀錄失敗");
      const session = await res.json();
      setLoadedReplay(session);
      setMode("game");
    } catch (e) {
      alert(`載入失敗：${e}`);
    }
  }

  async function deleteReplay(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("確定要刪除這筆對戰紀錄嗎？")) return;
    try {
      const res = await fetch(`/api/replays?id=${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error("刪除失敗");
      await refreshReplays();
    } catch (e) {
      alert(`刪除失敗：${e}`);
    }
  }

  useEffect(() => {
    void refreshDecks();
    void refreshReplays();
  }, []);

  // 對戰入口只列「常用」牌組；若一個都沒勾，退而列全部（避免鎖死無牌可選）
  const battleDecks = useMemo(() => {
    const indexed = decks.map((d, i) => ({ d, i }));
    const favs = indexed.filter((x) => x.d.favorite);
    return favs.length ? favs : indexed;
  }, [decks]);
  const hasFavorites = useMemo(() => decks.some((d) => d.favorite), [decks]);

  // 牌組清單變動後，把選取索引夾回目前可選的對戰牌組，避免顯示成空白
  useEffect(() => {
    if (!battleDecks.length) return;
    const valid = new Set(battleDecks.map((x) => x.i));
    if (!valid.has(myDeck)) setMyDeck(battleDecks[0]!.i);
    if (!valid.has(aiDeck)) setAiDeck(battleDecks[Math.min(1, battleDecks.length - 1)]!.i);
  }, [battleDecks]);

  if (mode === "game") {
    if (loadedReplay) {
      const label0 = loadedReplay.decks[0].label;
      const dash0 = label0.indexOf("-");
      const school0 = dash0 !== -1 ? label0.slice(0, dash0) : label0;
      const name0 = dash0 !== -1 ? label0.slice(dash0 + 1) : "";

      const label1 = loadedReplay.decks[1].label;
      const dash1 = label1.indexOf("-");
      const school1 = dash1 !== -1 ? label1.slice(0, dash1) : label1;
      const name1 = dash1 !== -1 ? label1.slice(dash1 + 1) : "";

      const decksData: [string[], string[]] = [
        loadedReplay.decks[0].cardIds,
        loadedReplay.decks[1].cardIds,
      ];

      const deckMeta0: DeckMeta = {
        school: school0,
        name: name0,
        total: loadedReplay.decks[0].cardIds.length,
        implementedCount: loadedReplay.decks[0].cardIds.length,
        unimplementedCount: 0,
      };

      const deckMeta1: DeckMeta = {
        school: school1,
        name: name1,
        total: loadedReplay.decks[1].cardIds.length,
        implementedCount: loadedReplay.decks[1].cardIds.length,
        unimplementedCount: 0,
      };

      setCardPrintings(new Map());

      return (
        <Game
          db={db}
          decks={decksData}
          deckMeta={[deckMeta0, deckMeta1]}
          loadedReplay={loadedReplay}
          onExit={() => {
            setLoadedReplay(null);
            setMode("menu");
            void refreshReplays();
          }}
        />
      );
    }

    if (decks[myDeck] && decks[aiDeck]) {
      const selectedDecks = [decks[myDeck]!, decks[aiDeck]!] as const;
      // 把兩副牌組選的卡面版本帶進戰鬥（我方優先），讓 cardImage 顯示高版本卡圖
      const printings = new Map<string, string>();
      for (const d of [selectedDecks[1], selectedDecks[0]]) {
        for (const c of d.cards) if (c.printing) printings.set(c.id, c.printing);
      }
      setCardPrintings(printings);
      return (
        <Game
          db={db}
          decks={[expand(selectedDecks[0]), expand(selectedDecks[1])]}
          deckMeta={[deckMeta(db, selectedDecks[0]), deckMeta(db, selectedDecks[1])]}
          onExit={() => {
            setMode("menu");
            void refreshReplays();
          }}
        />
      );
    }
  }

  if (mode === "editor") {
    return <DeckEditor db={db} decks={decks} onExit={() => setMode("menu")} onSaved={refreshDecks} />;
  }

  if (mode === "optimizer") {
    return <DeckOptimizerPreview db={db} decks={decks} onExit={() => setMode("menu")} onSaved={refreshDecks} />;
  }

  const deckLabel = (d: ApiDeck) => `${d.school}／${d.name}（${d.cards.reduce((s, c) => s + c.count, 0)}張）`;
  const myMeta = decks[myDeck] ? deckMeta(db, decks[myDeck]!) : null;
  const aiMeta = decks[aiDeck] ? deckMeta(db, decks[aiDeck]!) : null;
  const incomplete = [myMeta, aiMeta].filter((meta): meta is DeckMeta => !!meta && meta.unimplementedCount > 0);

  return (
    <main className="menu">
      <section className="menu-hero">
        <p className="menu-kicker">Deck testing simulator</p>
        <h1>排球少年 バボカ!!BREAK</h1>
        <p className="dim">卡池 {db.size} 張・牌組 {decks.length} 副</p>
      </section>

      <div className="menu-grid">
        <section className="menu-panel" aria-label="對戰設定">
          {loadError && <p className="danger small">{loadError}</p>}
          <div className="menu-row menu-decks">
            <label>我的牌組
              <select value={myDeck} onChange={(e) => setMyDeck(Number(e.target.value))}>
                {battleDecks.map(({ d, i }) => <option key={d.source} value={i}>{deckLabel(d)}</option>)}
              </select>
            </label>
            <span className="menu-versus" aria-hidden="true">VS</span>
            <label>電腦牌組
              <select value={aiDeck} onChange={(e) => setAiDeck(Number(e.target.value))}>
                {battleDecks.map(({ d, i }) => <option key={d.source} value={i}>{deckLabel(d)}</option>)}
              </select>
            </label>
          </div>
          {!hasFavorites && decks.length > 0 && (
            <p className="dim small">尚未設定常用牌組，暫時列出全部 {decks.length} 副。到「牌組編輯」勾選★常用，這裡就只會顯示常用牌組。</p>
          )}

          {incomplete.length > 0 && (
            <div className="support-warning" role="status">
              <b>技能支援提示</b>
              <span>{incomplete.map((meta) => `${meta.school}／${meta.name} 有 ${meta.unimplementedCount} 張卡的技能尚未實作`).join("；")}。仍可開始測試，未實作技能會視為無效果。</span>
            </div>
          )}

          <div className="menu-row menu-actions">
            <button className="btn-start" disabled={!decks.length} onClick={() => setMode("game")}>開始對戰</button>
            <button className="btn-start btn-secondary" onClick={() => setMode("editor")}>牌組編輯</button>
            <button className="btn-start btn-secondary" onClick={() => setMode("optimizer")}>調牌提案</button>
          </div>
        </section>

        <section className="menu-panel" aria-label="歷史對戰紀錄">
          <h2>歷史對戰紀錄 (覆盤)</h2>
          {loadingReplays ? (
            <p className="dim small">正在載入歷史對戰紀錄...</p>
          ) : replays.length === 0 ? (
            <p className="dim small" style={{ margin: "var(--sp-2) 0" }}>
              暫無對戰紀錄。完成手動對戰後，紀錄會自動儲存於此。
            </p>
          ) : (
            <div className="replay-history-list">
              {replays.map((r) => {
                const dateStr = new Date(r.startedAt).toLocaleString("zh-TW", {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                });
                const winnerLabel = r.winner === 0 ? "你贏了" : r.winner === 1 ? "電腦贏了" : "未完局";
                const winnerClass = r.winner === 0 ? "winner-player" : r.winner === 1 ? "winner-ai" : "winner-draw";
                
                return (
                  <div key={r.id} className="replay-history-item" onClick={() => void loadReplay(r.id)}>
                    <div className="replay-item-header">
                      <span className="replay-item-time">{dateStr}</span>
                      <span className={`replay-item-winner ${winnerClass}`}>{winnerLabel}</span>
                    </div>
                    <div className="replay-item-decks">
                      <span className="deck-label">{r.decks[0]}</span>
                      <span className="vs-label">VS</span>
                      <span className="deck-label">{r.decks[1]}</span>
                    </div>
                    <div className="replay-item-meta">
                      <span>共 {r.entryCount} 步決策</span>
                      <button className="btn-delete" onClick={(e) => void deleteReplay(r.id, e)} title="刪除此紀錄">
                        刪除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <div className="version-stamp">v{APP_VERSION} ・ 收錄 {poolStatus.exps} ・ 技能 {poolStatus.implemented}/{poolStatus.withSkill}（{poolStatus.pct}%）</div>
    </main>
  );
}
