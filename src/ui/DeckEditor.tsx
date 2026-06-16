import { useMemo, useState } from "react";
import type { Card } from "../data/types";
import type { CardDb } from "../engine/types";
import { CardView, displayName } from "./CardView";
import { CardSkillInfo } from "./GamePanels";

export interface ApiDeck {
  school: string;
  name: string;
  source: string;
  cards: { id: string; count: number; printing?: string }[];
}

interface Entry { count: number; printing?: string }

export function DeckEditor(props: { db: CardDb; decks: ApiDeck[]; onExit: () => void; onSaved: () => Promise<void> }) {
  const { db } = props;
  const allCards = useMemo(() => [...db.values()].sort((a, b) => a.id.localeCompare(b.id)), [db]);
  const schools = useMemo(() => [...new Set(allCards.flatMap((c) => c.affiliations))].sort(), [allCards]);

  // 編輯中的牌組
  const [school, setSchool] = useState("");
  const [name, setName] = useState("");
  const [entries, setEntries] = useState<Map<string, Entry>>(new Map());
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 篩選
  const [fSchool, setFSchool] = useState("");
  const [fType, setFType] = useState("");
  const [fText, setFText] = useState("");
  const [hovered, setHovered] = useState<Card | null>(null);

  const total = [...entries.values()].reduce((s, e) => s + e.count, 0);
  const eventCount = [...entries.entries()].reduce((s, [id, e]) => s + (db.get(id)?.type === "EVENT" ? e.count : 0), 0);
  const legal = total === 40 && eventCount <= 8;

  function loadDeck(d: ApiDeck) {
    setSchool(d.school);
    setName(d.name);
    setEntries(new Map(d.cards.map((c) => [c.id, { count: c.count, printing: c.printing }])));
    setDirty(false);
    setMessage(null);
  }

  function adjust(id: string, delta: number) {
    setEntries((prev) => {
      const next = new Map(prev);
      const e = next.get(id) ?? { count: 0 };
      const count = Math.max(0, e.count + delta);
      if (count === 0 && !prev.has(id)) next.delete(id);
      else next.set(id, { ...e, count });
      return next;
    });
    setDirty(true);
  }

  function removeEntry(id: string) {
    setEntries((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setDirty(true);
  }

  function setPrinting(id: string, printing: string) {
    setEntries((prev) => {
      const next = new Map(prev);
      const e = next.get(id);
      if (e) next.set(id, { ...e, printing: printing || undefined });
      return next;
    });
    setDirty(true);
  }

  async function save() {
    if (!import.meta.env.DEV) {
      setMessage("GitHub Pages 為唯讀模式；請在本機開發環境儲存 CSV");
      return;
    }
    if (!school.trim() || !name.trim()) { setMessage("⚠ 請填寫學校與牌組名稱"); return; }
    const cards = [...entries.entries()].map(([id, e]) => ({ id, count: e.count, printing: e.printing }));
    const res = await fetch("/api/decks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ school: school.trim(), name: name.trim(), cards }),
    });
    const json = await res.json();
    if (!res.ok) { setMessage(`⚠ 儲存失敗：${json.error}`); return; }
    setMessage(`✓ 已存到 ${json.source}`);
    setDirty(false);
    await props.onSaved();
  }

  const filtered = allCards.filter((c) => {
    if (fSchool && !c.affiliations.includes(fSchool)) return false;
    if (fType && c.type !== fType) return false;
    if (fText) {
      const t = fText.toLowerCase();
      const hay = `${c.id} ${c.nameJa} ${c.nameZh ?? ""} ${c.skillZh ?? ""} ${c.skillJa ?? ""}`.toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  });

  const deckRows = [...entries.entries()]
    .map(([id, e]) => ({ id, card: db.get(id)!, ...e }))
    .sort((a, b) => (b.count - a.count) || a.id.localeCompare(b.id));

  return (
    <div className="editor">
      <div className="editor-main">
        <div className="status-bar">
          <select onChange={(e) => { const d = props.decks[Number(e.target.value)]; if (d) loadDeck(d); }} value="">
            <option value="" disabled>載入現有牌組…</option>
            {props.decks.map((d, i) => <option key={d.source} value={i}>{d.school}／{d.name}</option>)}
          </select>
          <button onClick={() => { setSchool(""); setName(""); setEntries(new Map()); setDirty(false); setMessage(null); }}>新牌組</button>
          <input placeholder="學校" value={school} onChange={(e) => { setSchool(e.target.value); setDirty(true); }} style={{ width: 110 }} />
          <input placeholder="牌組名稱" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} style={{ width: 150 }} />
          <button className="btn-start-sm" onClick={save}>{import.meta.env.DEV ? `儲存${dirty ? "＊" : ""}` : "線上唯讀"}</button>
          {message && <span className={message.startsWith("✓") ? "win" : "danger"}>{message}</span>}
          <button className="btn-exit" onClick={props.onExit}>回主選單</button>
        </div>

        <div className="filters">
          <select value={fSchool} onChange={(e) => setFSchool(e.target.value)}>
            <option value="">全部學校</option>
            {schools.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={fType} onChange={(e) => setFType(e.target.value)}>
            <option value="">角色＋事件</option>
            <option value="CHARACTER">角色</option>
            <option value="EVENT">事件</option>
          </select>
          <input placeholder="搜尋卡名／編號／技能文字" value={fText} onChange={(e) => setFText(e.target.value)} style={{ flex: 1 }} />
          <span className="dim small">{filtered.length} 張</span>
        </div>

        <div className="pool">
          {filtered.map((c) => {
            const inDeck = entries.get(c.id)?.count ?? 0;
            return (
              <CardView key={c.id} card={c} width={92}
                onClick={() => adjust(c.id, +1)}
                onHover={setHovered}
                badge={inDeck > 0 ? `×${inDeck}` : undefined}
              />
            );
          })}
        </div>
      </div>

      <div className="sidebar">
        <div className="deck-summary">
          <b className={legal ? "win" : "danger"}>{total}／40 張</b>
          <span className={eventCount > 8 ? "danger" : "dim"}>事件 {eventCount}／8</span>
          {!legal && <span className="dim small">{total !== 40 ? "張數須正好 40" : "事件卡超過 8 張"}</span>}
        </div>
        <div className="deck-list">
          {deckRows.map(({ id, card, count, printing }) => (
            <div key={id} className={"deck-row" + (count === 0 ? " deck-row-zero" : "")}
              onMouseEnter={() => setHovered(card)} onMouseLeave={() => setHovered(null)}>
              <span className="deck-row-name">{displayName(card)}<span className="dim small"> {id.replace("HV-", "")}</span></span>
              {card.printings.length > 1 && (
                <select className="printing-sel" value={printing ?? ""} onChange={(e) => setPrinting(id, e.target.value)} title="卡面">
                  <option value="">{card.printings[0]!.rarity}</option>
                  {card.printings.slice(1).map((p) => <option key={p.rarity} value={p.imageEnd ?? p.rarity}>{p.rarity}</option>)}
                </select>
              )}
              <span className="deck-row-controls">
                <button onClick={() => adjust(id, -1)}>−</button>
                <b>{count}</b>
                <button onClick={() => adjust(id, +1)}>＋</button>
                <button className="btn-x" title="移除（含候補記錄）" onClick={() => removeEntry(id)}>✕</button>
              </span>
            </div>
          ))}
          {deckRows.length === 0 && <p className="dim small">點左側卡片加入牌組。數量 0 的列會保留為「候補」記錄存回 CSV。</p>}
        </div>
        <div className="detail">
          {hovered ? (
            <>
              <b>{displayName(hovered)}</b> <span className="dim small">{hovered.id}</span>
              {hovered.params && (
                <div className="dim small">
                  發{hovered.params.serve ?? "－"}／攔{hovered.params.block ?? "－"}／接{hovered.params.receive ?? "－"}／托{hovered.params.toss ?? "－"}／攻{hovered.params.attack ?? "－"}
                </div>
              )}
              <CardSkillInfo card={hovered} />
            </>
          ) : <span className="dim small">滑過卡片查看詳情</span>}
        </div>
      </div>
    </div>
  );
}
