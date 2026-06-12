import { useEffect, useMemo, useState } from "react";
import cardsJson from "../data/cards.json";
import type { Card } from "./data/types";
import type { CardDb } from "./engine/types";
import { Game } from "./ui/Game";
import { DeckEditor, type ApiDeck } from "./ui/DeckEditor";
import type { DeckMeta } from "./ui/gameTypes";

const expand = (d: ApiDeck): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

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
  const [decks, setDecks] = useState<ApiDeck[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [myDeck, setMyDeck] = useState(0);
  const [aiDeck, setAiDeck] = useState(1);
  const [mode, setMode] = useState<"menu" | "game" | "editor">("menu");

  async function refreshDecks() {
    try {
      const res = await fetch("/api/decks");
      const list = (await res.json()) as ApiDeck[];
      setDecks(list);
      setLoadError(null);
    } catch (e) {
      setLoadError(`無法載入牌組（API 僅在 npm run dev 下可用）：${e}`);
    }
  }
  useEffect(() => { void refreshDecks(); }, []);

  if (mode === "game" && decks[myDeck] && decks[aiDeck]) {
    const selectedDecks = [decks[myDeck]!, decks[aiDeck]!] as const;
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
        </div>
        <p className="dim small">烏野現有三副牌組已支援完整技能流程；其他學校由 M3 工作線逐步補完。</p>
      </section>
    </main>
  );
}
