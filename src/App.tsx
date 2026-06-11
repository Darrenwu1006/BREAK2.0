import { useEffect, useMemo, useState } from "react";
import cardsJson from "../data/cards.json";
import type { Card } from "./data/types";
import type { CardDb } from "./engine/types";
import { Game } from "./ui/Game";
import { DeckEditor, type ApiDeck } from "./ui/DeckEditor";

const expand = (d: ApiDeck): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

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
    return (
      <Game
        db={db}
        decks={[expand(decks[myDeck]!), expand(decks[aiDeck]!)]}
        deckNames={[decks[myDeck]!.name, decks[aiDeck]!.name]}
        onExit={() => setMode("menu")}
      />
    );
  }

  if (mode === "editor") {
    return <DeckEditor db={db} decks={decks} onExit={() => setMode("menu")} onSaved={refreshDecks} />;
  }

  const deckLabel = (d: ApiDeck) => `${d.school}／${d.name}（${d.cards.reduce((s, c) => s + c.count, 0)}張）`;

  return (
    <main className="menu">
      <h1>排球少年 バボカ!!BREAK</h1>
      <p className="dim">卡池 {db.size} 張・牌組 {decks.length} 副</p>
      {loadError && <p className="danger small">{loadError}</p>}
      <div className="menu-row">
        <label>我的牌組
          <select value={myDeck} onChange={(e) => setMyDeck(Number(e.target.value))}>
            {decks.map((d, i) => <option key={d.source} value={i}>{deckLabel(d)}</option>)}
          </select>
        </label>
        <label>電腦牌組
          <select value={aiDeck} onChange={(e) => setAiDeck(Number(e.target.value))}>
            {decks.map((d, i) => <option key={d.source} value={i}>{deckLabel(d)}</option>)}
          </select>
        </label>
      </div>
      <div className="menu-row">
        <button className="btn-start" disabled={!decks.length} onClick={() => setMode("game")}>開始對戰</button>
        <button className="btn-start btn-editor" onClick={() => setMode("editor")}>牌組編輯</button>
      </div>
      <p className="dim small">香草規則對局（卡片技能將於 M3 接入）・電腦＝啟發式 AI（M5）</p>
    </main>
  );
}
