// LP1 對局殼：ui-lab 進場選牌組。資料來源同經典介面（dev＝/api/decks、prod＝decks.json），
// 常用（favorite）優先；載入失敗時退回內建預組（烏野 vs 音駒），對局不因後端缺席而不可用。
// 刻意不 import src/ui/（雙棧隔離）。

import { useEffect, useMemo, useState } from "react";
import karasunoDeck from "../../data/decks/烏野-預組.json";
import nekomaDeck from "../../data/decks/音駒-預組.json";
import styles from "./UiLabApp.module.css";

export interface LabDeck {
  school: string;
  name: string;
  cards: { id: string; count: number; printing?: string }[];
  favorite?: boolean;
  source?: string;
}

const BUILTIN: LabDeck[] = [karasunoDeck as LabDeck, nekomaDeck as LabDeck];

export const expandDeck = (d: LabDeck): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

export function LabMenu(props: { onStart: (decks: [LabDeck, LabDeck]) => void }): React.JSX.Element {
  const [decks, setDecks] = useState<LabDeck[]>(BUILTIN);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [mine, setMine] = useState(0);
  const [ai, setAi] = useState(1);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const endpoint = import.meta.env.DEV ? "/api/decks" : `${import.meta.env.BASE_URL}decks.json`;
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error(`${res.status}`);
        const list = (await res.json()) as LabDeck[];
        if (alive && list.length > 0) {
          setDecks(list);
          setNote(null);
        }
      } catch {
        if (alive) setNote("無法載入牌組清單，先用內建預組。");
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 對戰入口只列「常用」；一個都沒勾就列全部（同經典介面的心智模型）
  const options = useMemo(() => {
    const indexed = decks.map((d, i) => ({ d, i }));
    const favs = indexed.filter((x) => x.d.favorite);
    return favs.length ? favs : indexed;
  }, [decks]);

  // 清單載入後把選取夾回合法範圍
  useEffect(() => {
    if (!options.length) return;
    const valid = new Set(options.map((o) => o.i));
    if (!valid.has(mine)) setMine(options[0]!.i);
    if (!valid.has(ai)) setAi(options[Math.min(1, options.length - 1)]!.i);
  }, [options, mine, ai]);

  const label = (d: LabDeck): string => `${d.school}／${d.name}（${d.cards.reduce((s, c) => s + c.count, 0)}張）`;

  return (
    <div className={styles.root} style={{ position: "fixed", inset: 0 }}>
      <div className={styles.menuWrap}>
        <span className={styles.badge}>
          ui-lab<span className={styles.tag}>對局</span>
        </span>
        <h1 className={styles.menuTitle}>排球少年 バボカ!!BREAK</h1>
        <p className={styles.menuSub}>新介面實驗線——選牌組開打；對手＝heuristic AI。</p>
        {note && <p className={styles.menuNote}>{note}</p>}
        <div className={styles.menuRow}>
          <label>
            我的牌組
            <select value={mine} onChange={(e) => setMine(Number(e.target.value))}>
              {options.map(({ d, i }) => (
                <option key={d.source ?? `${d.school}-${d.name}`} value={i}>
                  {label(d)}
                </option>
              ))}
            </select>
          </label>
          <span className={styles.menuVersus}>VS</span>
          <label>
            電腦牌組
            <select value={ai} onChange={(e) => setAi(Number(e.target.value))}>
              {options.map(({ d, i }) => (
                <option key={d.source ?? `${d.school}-${d.name}`} value={i}>
                  {label(d)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={styles.menuActions}>
          <button className={styles.btnStart} disabled={!loaded || !decks[mine] || !decks[ai]} onClick={() => props.onStart([decks[mine]!, decks[ai]!])}>
            開始對戰
          </button>
          <a className={styles.link} href="./">
            ← 回經典介面
          </a>
        </div>
      </div>
    </div>
  );
}
