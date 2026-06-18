import { useEffect, useMemo, useState } from "react";
import cardsJson from "../data/cards.json";
import type { Card } from "./data/types";
import type { CardDb } from "./engine/types";
import { Game } from "./ui/Game";
import { setCardPrintings } from "./ui/CardView";
import { DeckEditor, type ApiDeck } from "./ui/DeckEditor";
import { DeckOptimizerPreview } from "./ui/DeckOptimizerPreview";
import type { DeckMeta } from "./ui/gameTypes";

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
  useEffect(() => { void refreshDecks(); }, []);

  if (mode === "game" && decks[myDeck] && decks[aiDeck]) {
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
        onExit={() => setMode("menu")}
      />
    );
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

      <section className="menu-panel" aria-label="對戰設定">
        {loadError && <p className="danger small">{loadError}</p>}
        <div className="menu-row menu-decks">
          <label>我的牌組
            <select value={myDeck} onChange={(e) => setMyDeck(Number(e.target.value))}>
              {decks.map((d, i) => <option key={d.source} value={i}>{deckLabel(d)}</option>)}
            </select>
          </label>
          <span className="menu-versus" aria-hidden="true">VS</span>
          <label>電腦牌組
            <select value={aiDeck} onChange={(e) => setAiDeck(Number(e.target.value))}>
              {decks.map((d, i) => <option key={d.source} value={i}>{deckLabel(d)}</option>)}
            </select>
          </label>
        </div>

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
      <div className="version-stamp">v{APP_VERSION} ・ 收錄 {poolStatus.exps} ・ 技能 {poolStatus.implemented}/{poolStatus.withSkill}（{poolStatus.pct}%）</div>
    </main>
  );
}
