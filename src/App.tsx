import { useMemo, useState } from "react";
import cardsJson from "../data/cards.json";
import type { Card, Deck } from "./data/types";
import type { CardDb } from "./engine/types";
import { Game } from "./ui/Game";

const deckModules = import.meta.glob("../data/decks/*.json", { eager: true }) as Record<string, { default: Deck } | Deck>;
const decks: Deck[] = Object.values(deckModules).map((m) => ("default" in m ? m.default : m) as Deck);

const expand = (d: Deck): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

export function App() {
  const db: CardDb = useMemo(() => new Map((cardsJson as Card[]).map((c) => [c.id, c])), []);
  const [myDeck, setMyDeck] = useState(0);
  const [aiDeck, setAiDeck] = useState(decks.length > 1 ? 1 : 0);
  const [inGame, setInGame] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (inGame) {
    return (
      <Game
        db={db}
        decks={[expand(decks[myDeck]!), expand(decks[aiDeck]!)]}
        deckNames={[decks[myDeck]!.name, decks[aiDeck]!.name]}
        onExit={() => setInGame(false)}
      />
    );
  }

  return (
    <main className="menu">
      <h1>排球少年 バボカ!!BREAK</h1>
      <p className="dim">卡池 {db.size} 張・牌組 {decks.length} 副</p>
      <div className="menu-row">
        <label>我的牌組
          <select value={myDeck} onChange={(e) => setMyDeck(Number(e.target.value))}>
            {decks.map((d, i) => <option key={d.name} value={i}>{d.name}</option>)}
          </select>
        </label>
        <label>電腦牌組
          <select value={aiDeck} onChange={(e) => setAiDeck(Number(e.target.value))}>
            {decks.map((d, i) => <option key={d.name} value={i}>{d.name}</option>)}
          </select>
        </label>
      </div>
      <button
        className="btn-start"
        onClick={() => {
          try { setError(null); setInGame(true); } catch (e) { setError(String(e)); }
        }}
      >
        開始對戰
      </button>
      {error && <p className="danger">{error}</p>}
      <p className="dim small">香草規則對局（卡片技能將於 M3 接入）・電腦＝啟發式 AI（M5）</p>
    </main>
  );
}
