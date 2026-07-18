import { useMemo, useState } from "react";
import type { Card } from "../data/types";
import type { CardDb } from "../engine/types";
import { CARD_BACK_SCHOOLS, CardView, displayName } from "./CardView";
import { CardSkillInfo } from "./GamePanels";

export interface ApiDeck {
  school: string;
  name: string;
  source: string;
  cards: { id: string; count: number; printing?: string }[];
  favorite?: boolean;
}

interface Entry { count: number; printing?: string }

interface DeckRow {
  id: string;
  card: Card;
  count: number;
  printing?: string;
}

export function groupDeckRows<T extends { id: string; card: Pick<Card, "type"> }>(rows: readonly T[]): {
  characters: T[];
  events: T[];
} {
  const byId = (a: T, b: T) => a.id.localeCompare(b.id);
  return {
    characters: rows.filter((row) => row.card.type === "CHARACTER").sort(byId),
    events: rows.filter((row) => row.card.type === "EVENT").sort(byId),
  };
}

export interface CardBackChoice {
  value: string;
  label: string;
}

export function buildCardBackChoices(decks: readonly ApiDeck[]): {
  custom: CardBackChoice[];
  fallback: CardBackChoice[];
} {
  const customSet = new Set(CARD_BACK_SCHOOLS);
  const fallbackValues = new Set(["混合學校"]);
  for (const deck of decks) {
    if (!customSet.has(deck.school)) fallbackValues.add(deck.school);
  }

  return {
    custom: CARD_BACK_SCHOOLS.map((value) => ({ value, label: value })),
    fallback: [...fallbackValues]
      .sort((a, b) => (a === "混合學校" ? -1 : b === "混合學校" ? 1 : a.localeCompare(b)))
      .map((value) => ({
        value,
        label: value === "混合學校" ? "通用卡背（混合學校）" : `${value}（通用卡背）`,
      })),
  };
}

// 彈別（卡片出自哪一個商品／彈）：取卡號中字母開頭的段（D01/P02/PR/HVBP…）
function expansionOf(id: string): string {
  return id.split("-").find((seg) => seg !== "HV" && /^[A-Za-z]+\d*$/.test(seg)) ?? id;
}
const EXPANSION_LABELS: Record<string, string> = {
  D01: "起始牌組①（D01）",
  D02: "起始牌組②（D02）",
  D03: "起始牌組③（D03）",
  P01: "第一彈（P01）",
  P02: "第二彈（P02）",
  P03: "第三彈（P03）",
  PR: "促銷卡（PR）",
  HVBP: "特別卡（HVBP）",
};
const EXPANSION_ORDER = ["D01", "D02", "D03", "P01", "P02", "P03", "PR", "HVBP"];
const expansionRank = (code: string) => {
  const i = EXPANSION_ORDER.indexOf(code);
  return i === -1 ? EXPANSION_ORDER.length : i;
};

export function DeckEditor(props: { db: CardDb; decks: ApiDeck[]; onExit: () => void; onSaved: () => Promise<void> }) {
  const { db } = props;
  const allCards = useMemo(() => [...db.values()].sort((a, b) => a.id.localeCompare(b.id)), [db]);
  const schools = useMemo(() => [...new Set(allCards.flatMap((c) => c.affiliations))].sort(), [allCards]);
  const expansions = useMemo(
    () => [...new Set(allCards.map((c) => expansionOf(c.id)))].sort((a, b) => expansionRank(a) - expansionRank(b) || a.localeCompare(b)),
    [allCards],
  );
  const cardBackChoices = useMemo(() => buildCardBackChoices(props.decks), [props.decks]);

  // 編輯中的牌組
  const [school, setSchool] = useState("");
  const [name, setName] = useState("");
  const [entries, setEntries] = useState<Map<string, Entry>>(new Map());
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 篩選
  const [fSchool, setFSchool] = useState("");
  const [fType, setFType] = useState("");
  const [fExp, setFExp] = useState("");
  const [fText, setFText] = useState("");
  const [hovered, setHovered] = useState<Card | null>(null);
  const [inspected, setInspected] = useState<Card | null>(null);

  const total = [...entries.values()].reduce((s, e) => s + e.count, 0);
  const eventCount = [...entries.entries()].reduce((s, [id, e]) => s + (db.get(id)?.type === "EVENT" ? e.count : 0), 0);
  const legal = total === 40 && eventCount <= 8;

  function loadDeck(d: ApiDeck) {
    setSchool(d.school);
    setName(d.name);
    setEntries(new Map(d.cards.map((c) => [c.id, { count: c.count, printing: c.printing }])));
    setHovered(null);
    setInspected(null);
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
    if (hovered?.id === id) setHovered(null);
    if (inspected?.id === id) setInspected(null);
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
    if (!school.trim() || !name.trim()) { setMessage("⚠ 請選擇卡背並填寫牌組名稱"); return; }
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

  // 目前載入中的牌組是否對應到一個已存在的牌組檔（決定刪除／常用是否可用）
  const existingDeck = props.decks.find((d) => d.school === school.trim() && d.name === name.trim()) ?? null;
  const isFavorite = existingDeck?.favorite ?? false;

  async function toggleFavorite() {
    if (!existingDeck) return;
    const res = await fetch("/api/deck-favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ school: existingDeck.school, name: existingDeck.name, favorite: !isFavorite }),
    });
    const json = await res.json();
    if (!res.ok) { setMessage(`⚠ 常用設定失敗：${json.error}`); return; }
    setMessage(!isFavorite ? "✓ 已設為常用（會出現在對戰入口）" : "✓ 已取消常用");
    await props.onSaved();
  }

  async function deleteDeck() {
    if (!existingDeck) return;
    if (!window.confirm(`確定刪除牌組「${existingDeck.school}／${existingDeck.name}」？此動作無法復原。`)) return;
    const res = await fetch(`/api/decks?school=${encodeURIComponent(existingDeck.school)}&name=${encodeURIComponent(existingDeck.name)}`, {
      method: "DELETE",
    });
    const json = await res.json();
    if (!res.ok) { setMessage(`⚠ 刪除失敗：${json.error}`); return; }
    setMessage(`✓ 已刪除 ${json.deleted}`);
    setSchool(""); setName(""); setEntries(new Map()); setHovered(null); setInspected(null); setDirty(false);
    await props.onSaved();
  }

  const filtered = allCards.filter((c) => {
    if (fSchool && !c.affiliations.includes(fSchool)) return false;
    if (fType && c.type !== fType) return false;
    if (fExp && expansionOf(c.id) !== fExp) return false;
    if (fText) {
      const t = fText.toLowerCase();
      const hay = `${c.id} ${c.nameJa} ${c.nameZh ?? ""} ${c.skillZh ?? ""} ${c.skillJa ?? ""}`.toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  });

  const deckRows: DeckRow[] = [...entries.entries()]
    .map(([id, e]) => ({ id, card: db.get(id)!, ...e }));
  const groupedDeckRows = groupDeckRows(deckRows);
  const visibleDetail = hovered ?? inspected;
  const previewingDetail = hovered !== null && hovered.id !== inspected?.id;

  function renderDeckSection(title: string, rows: DeckRow[]) {
    if (rows.length === 0) return null;
    const copies = rows.reduce((sum, row) => sum + row.count, 0);
    return (
      <section className="deck-section" aria-labelledby={`deck-section-${title}`}>
        <h3 className="deck-section-heading" id={`deck-section-${title}`}>
          <span>{title}</span>
          <small>{copies} 張・{rows.length} 種</small>
        </h3>
        {rows.map(({ id, card, count, printing }) => (
          <div key={id} className={"deck-row" + (count === 0 ? " deck-row-zero" : "")}
            onMouseEnter={() => setHovered(card)} onMouseLeave={() => setHovered(null)}>
            <button
              type="button"
              className="deck-row-name deck-row-inspect"
              aria-pressed={inspected?.id === id}
              title="固定顯示此卡詳情"
              onClick={() => setInspected(card)}
            >
              {displayName(card)}<span className="dim small"> {id.replace("HV-", "")}</span>
            </button>
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
      </section>
    );
  }

  return (
    <div className="editor">
      <div className="editor-main">
        <div className="status-bar">
          <select onChange={(e) => { const d = props.decks[Number(e.target.value)]; if (d) loadDeck(d); }} value="">
            <option value="" disabled>載入現有牌組…</option>
            {props.decks.map((d, i) => <option key={d.source} value={i}>{d.school}／{d.name}</option>)}
          </select>
          <button onClick={() => { setSchool(""); setName(""); setEntries(new Map()); setHovered(null); setInspected(null); setDirty(false); setMessage(null); }}>新牌組</button>
          <select
            aria-label="卡背"
            title="決定對戰時使用的卡背"
            value={school}
            onChange={(e) => { setSchool(e.target.value); setDirty(true); }}
            style={{ width: 150 }}
          >
            <option value="" disabled>選擇卡背…</option>
            <optgroup label="專屬卡背">
              {cardBackChoices.custom.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </optgroup>
            <optgroup label="通用卡背">
              {cardBackChoices.fallback.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </optgroup>
          </select>
          <input placeholder="牌組名稱" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} style={{ width: 150 }} />
          <button className="btn-start-sm" onClick={save}>{import.meta.env.DEV ? `儲存${dirty ? "＊" : ""}` : "線上唯讀"}</button>
          {import.meta.env.DEV && existingDeck && (
            <label className="fav-toggle" title="常用牌組才會出現在對戰入口">
              <input type="checkbox" checked={isFavorite} onChange={toggleFavorite} />
              {isFavorite ? "★ 常用" : "☆ 常用"}
            </label>
          )}
          {import.meta.env.DEV && existingDeck && (
            <button className="btn-x" title="刪除此牌組" onClick={deleteDeck}>刪除</button>
          )}
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
          <select value={fExp} onChange={(e) => setFExp(e.target.value)} title="出自哪一彈／商品">
            <option value="">全部彈別</option>
            {expansions.map((code) => <option key={code} value={code}>{EXPANSION_LABELS[code] ?? code}</option>)}
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
          {renderDeckSection("角色卡", groupedDeckRows.characters)}
          {renderDeckSection("事件卡", groupedDeckRows.events)}
          {deckRows.length === 0 && <p className="dim small">點左側卡片加入牌組。數量 0 的列會保留為「候補」記錄存回 CSV。</p>}
        </div>
        <div className="detail" data-mode={previewingDetail ? "preview" : inspected ? "locked" : "empty"}>
          {visibleDetail ? (
            <>
              <div className="detail-state-row">
                <span className="detail-state">{previewingDetail ? "暫時預覽" : "已固定"}</span>
                {inspected && <button type="button" className="detail-clear" onClick={() => setInspected(null)}>清除固定</button>}
              </div>
              <b>{displayName(visibleDetail)}</b> <span className="dim small">{visibleDetail.id}</span>
              {visibleDetail.params && (
                <div className="dim small">
                  發{visibleDetail.params.serve ?? "－"}／攔{visibleDetail.params.block ?? "－"}／接{visibleDetail.params.receive ?? "－"}／托{visibleDetail.params.toss ?? "－"}／攻{visibleDetail.params.attack ?? "－"}
                </div>
              )}
              <CardSkillInfo card={visibleDetail} />
            </>
          ) : <span className="dim small">滑過卡片快速預覽；點右側卡名可固定詳情。</span>}
        </div>
      </div>
    </div>
  );
}
