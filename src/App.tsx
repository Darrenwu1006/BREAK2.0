import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import cardsJson from "../data/cards.json";
import type { Card } from "./data/types";
import type { CardDb } from "./engine/types";
import { setCardPrintings } from "./ui/CardView";
import type { ApiDeck } from "./ui/DeckEditor";
import type { DeckMeta } from "./shared/deckMeta";
import type { ReplaySession } from "./shared/replayHistory";
import { readGameEngine, writeGameEngine, type GameEngine } from "./gameEngine";
import { buildBattleDeckWarnings } from "./shared/battleDeckValidation";

const Game = lazy(() =>
  import("./ui/Game").then((module) => ({ default: module.Game })),
);

const DeckEditor = lazy(() =>
  import("./ui/DeckEditor").then((module) => ({ default: module.DeckEditor })),
);

const DeckOptimizerPreview = lazy(() =>
  import("./ui/DeckOptimizerPreview").then((module) => ({ default: module.DeckOptimizerPreview })),
);

const LabGame = lazy(() =>
  import("./ui-lab/UiLabApp").then((module) => ({ default: module.UiLabGame })),
);

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
  const [mode, setMode] = useState<"menu" | "classic-game" | "lab-game" | "editor" | "optimizer">("menu");
  const [engine, setEngine] = useState<GameEngine>(() => readGameEngine());
  const [loadedReplay, setLoadedReplay] = useState<ReplaySession | null>(null);
  const [replays, setReplays] = useState<any[]>([]);
  const [loadingReplays, setLoadingReplays] = useState(false);
  const [deckStartWarning, setDeckStartWarning] = useState<string[] | null>(null);
  // 預設只撈最近 10 場（列表只讀後端輕量 index、不碰 16MB 大檔）；展開後撈全部
  const [replaysExpanded, setReplaysExpanded] = useState(false);

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

  async function refreshReplays(expanded = replaysExpanded) {
    setLoadingReplays(true);
    try {
      const res = await fetch(`/api/replays?${expanded ? "all=1" : "limit=10"}`);
      if (res.ok) {
        const list = await res.json();
        setReplays(list);
        setReplaysExpanded(expanded);
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
      setMode("classic-game");
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

  useEffect(() => {
    if (!deckStartWarning) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeckStartWarning(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deckStartWarning]);

  const startBattle = (): void => {
    const playerDeck = decks[myDeck];
    const opponentDeck = decks[aiDeck];
    if (!playerDeck || !opponentDeck) return;
    const selected = [playerDeck, opponentDeck] as const;
    const issues = buildBattleDeckWarnings(db, selected[0], selected[1]);
    if (issues.length > 0) {
      setDeckStartWarning(issues);
      return;
    }
    setDeckStartWarning(null);
    setMode(engine === "lab" ? "lab-game" : "classic-game");
  };

  if (mode === "classic-game") {
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
        <Suspense fallback={<div className="game-loading" role="status">載入經典 2D 對局…</div>}>
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
        </Suspense>
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
        <Suspense fallback={<div className="game-loading" role="status">載入經典 2D 對局…</div>}>
          <Game
            db={db}
            decks={[expand(selectedDecks[0]), expand(selectedDecks[1])]}
            deckMeta={[deckMeta(db, selectedDecks[0]), deckMeta(db, selectedDecks[1])]}
            onExit={() => {
              setMode("menu");
              void refreshReplays();
            }}
          />
        </Suspense>
      );
    }
  }

  if (mode === "lab-game" && decks[myDeck] && decks[aiDeck]) {
    return (
      <Suspense fallback={<div className="game-loading" role="status">載入實驗 3D 對局…</div>}>
        <LabGame
          db={db}
          decks={[decks[myDeck]!, decks[aiDeck]!]}
          onExit={() => {
            setMode("menu");
            void refreshReplays();
          }}
        />
      </Suspense>
    );
  }

  if (mode === "editor") {
    return (
      <Suspense fallback={<div className="game-loading" role="status">載入牌組編輯器…</div>}>
        <DeckEditor db={db} decks={decks} onExit={() => setMode("menu")} onSaved={refreshDecks} />
      </Suspense>
    );
  }

  if (mode === "optimizer") {
    return (
      <Suspense fallback={<div className="game-loading" role="status">載入調牌提案…</div>}>
        <DeckOptimizerPreview db={db} decks={decks} onExit={() => setMode("menu")} onSaved={refreshDecks} />
      </Suspense>
    );
  }

  const deckLabel = (d: ApiDeck) => `${d.school}／${d.name}（${d.cards.reduce((s, c) => s + c.count, 0)}張）`;
  const myMeta = decks[myDeck] ? deckMeta(db, decks[myDeck]!) : null;
  const aiMeta = decks[aiDeck] ? deckMeta(db, decks[aiDeck]!) : null;
  const incomplete = [myMeta, aiMeta].filter((meta): meta is DeckMeta => !!meta && meta.unimplementedCount > 0);

  return (
    <main className="menu">
      <section className="menu-hero" aria-labelledby="menu-title">
        <div className="menu-brand-copy">
          <p className="menu-kicker">Deck testing simulator</p>
          <h1 id="menu-title">排球少年 <span>バボカ!!BREAK</span></h1>
        </div>
        <div className="menu-pool-status" aria-label="目前資料狀態">
          <span><b>{db.size}</b> Cards</span>
          <span><b>{decks.length}</b> Decks</span>
          <span><b>{poolStatus.pct}%</b> Skills</span>
        </div>
        <p className="menu-disclaimer">
          本程式為個人製作的非官方模擬器，僅供牌組測試與學習研究之用。
          『ハイキュー!!』『バボカ!!BREAK』之著作權・商標均屬 ©古舘春一／集英社・「ハイキュー!!」製作委員会・©TOMY 所有，與官方無任何關聯。請支持官方正版產品。
        </p>
      </section>

      <div className="menu-grid">
        <section className="menu-panel" aria-label="對戰設定">
          <header className="menu-panel-header">
            <div>
              <span className="menu-panel-index">01</span>
              <div>
                <p>Match setup</p>
                <h2>對戰設定</h2>
              </div>
            </div>
            <span className="menu-panel-tag">Player vs AI</span>
          </header>

          {loadError && <p className="danger small">{loadError}</p>}
          <div className="menu-row menu-decks">
            <label><span className="menu-field-label">我的牌組</span>
              <select value={myDeck} onChange={(e) => { setMyDeck(Number(e.target.value)); setDeckStartWarning(null); }}>
                {battleDecks.map(({ d, i }) => <option key={d.source} value={i}>{deckLabel(d)}</option>)}
              </select>
            </label>
            <span className="menu-versus" aria-hidden="true">VS</span>
            <label><span className="menu-field-label">電腦牌組</span>
              <select value={aiDeck} onChange={(e) => { setAiDeck(Number(e.target.value)); setDeckStartWarning(null); }}>
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

          <div className="ui-toggle-row">
            <div className="ui-toggle-heading">
              <span className="ui-toggle-label">Battle view</span>
              <b>選擇本場介面</b>
            </div>
            <div className="ui-toggle" aria-label="介面切換">
              <span className={engine === "classic" ? "is-active" : ""}>經典 2D</span>
              <button
                type="button"
                className="ui-toggle-switch"
                role="switch"
                aria-checked={engine === "lab"}
                aria-label={`切換至${engine === "classic" ? "實驗 3D" : "經典 2D"}`}
                onClick={() => {
                  const next = engine === "classic" ? "lab" : "classic";
                  setEngine(next);
                  writeGameEngine(next);
                }}
              >
                <span className="ui-toggle-thumb" aria-hidden="true" />
              </button>
              <span className={engine === "lab" ? "is-active" : ""}>實驗 3D</span>
            </div>
          </div>

          <div className="menu-row menu-actions">
            <button aria-label="開始對戰" className="btn-start menu-primary-action" disabled={!decks.length} onClick={startBattle}>
              <span>開始對戰</span>
              <small>{engine === "lab" ? "Experimental 3D" : "Classic 2D"}</small>
            </button>
            <div className="menu-tool-actions" aria-label="牌組工具">
              <button aria-label="牌組編輯" className="btn-start btn-secondary" onClick={() => setMode("editor")}><span>牌組編輯</span><small>Deck editor</small></button>
              <button aria-label="調牌提案" className="btn-start btn-secondary" onClick={() => setMode("optimizer")}><span>調牌提案</span><small>Deck proposal</small></button>
            </div>
          </div>
        </section>

        <section className="menu-panel" aria-label="歷史對戰紀錄">
          <header className="menu-panel-header">
            <div>
              <span className="menu-panel-index">02</span>
              <div>
                <p>Replay archive</p>
                <h2>歷史對戰紀錄</h2>
              </div>
            </div>
            <span className="menu-panel-tag">{replays.length} Recent</span>
          </header>
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
              {!replaysExpanded && replays.length >= 10 && (
                <button
                  className="btn-start btn-secondary"
                  disabled={loadingReplays}
                  onClick={() => void refreshReplays(true)}
                >
                  顯示更多對局
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="version-stamp">v{APP_VERSION} ・ 收錄 {poolStatus.exps} ・ 技能 {poolStatus.implemented}/{poolStatus.withSkill}（{poolStatus.pct}%）</div>

      {deckStartWarning && (
        <div className="deck-start-warning-overlay" onMouseDown={() => setDeckStartWarning(null)}>
          <section
            className="deck-start-warning"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deck-start-warning-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="deck-start-warning-kicker">DECK CHECK</span>
            <h2 id="deck-start-warning-title">無法開始對戰</h2>
            <p>對戰牌組必須符合構築規則，請先回到牌組編輯器修正：</p>
            <ul>{deckStartWarning.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            <button className="btn-start menu-primary-action" autoFocus onClick={() => setDeckStartWarning(null)}>返回牌組選擇</button>
          </section>
        </div>
      )}
    </main>
  );
}
