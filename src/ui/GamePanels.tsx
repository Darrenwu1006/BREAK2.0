import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import type { Card } from "../data/types";
import { effParam } from "../engine/engine";
import type { CardDb, GameState, LogEntry, Phase, PlayerId } from "../engine/types";
import { CardView, displayName } from "./CardView";
import type { AiSpeed, DeckMeta, InspectedCard } from "./gameTypes";

export const PHASE_NAME: Record<Phase, string> = {
  setup: "準備",
  serve: "發球階段",
  start: "開始階段",
  block: "攔網階段",
  draw: "抽牌階段",
  receive: "接球階段",
  toss: "托球階段",
  attack: "攻擊階段",
  end: "結束階段",
  lostSet: "Lost",
  interval: "間隔",
  gameOver: "比賽結束",
};

const PHASE_ORDER: Phase[] = ["serve", "start", "block", "draw", "receive", "toss", "attack", "end"];

function supportText(meta: DeckMeta): string {
  return meta.unimplementedCount === 0 ? "技能完整" : `${meta.unimplementedCount} 張技能未實作`;
}

export function DeckSupport({ meta, player }: { meta: DeckMeta; player: PlayerId }) {
  const complete = meta.unimplementedCount === 0;
  return (
    <div className={`deck-support player-tone-${player}`}>
      <span>{player === 0 ? "你" : "電腦"}</span>
      <b>{meta.school}／{meta.name}</b>
      <small className={complete ? "support-complete" : "support-partial"}>{supportText(meta)}</small>
    </div>
  );
}

interface DisplayLogEntry extends LogEntry {
  summary?: boolean;
}

function enrichedLog(log: LogEntry[]): DisplayLogEntry[] {
  const out: DisplayLogEntry[] = [];
  let lastJudge = "";
  for (const entry of log) {
    out.push(entry);
    if (entry.text.startsWith("判定：")) lastJudge = entry.text.replace("判定：", "").trim();
    if (entry.text.startsWith("宣告 Lost（")) {
      const scorer = entry.player === 0 ? "電腦得分" : "你得分";
      out.push({
        ...entry,
        player: null,
        text: `Turn ${entry.turnNo} ─ ${scorer}${lastJudge ? `（${lastJudge}）` : ""}`,
        summary: true,
      });
      lastJudge = "";
    }
  }
  return out;
}

export function GameLog({ state }: { state: GameState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const entries = useMemo(() => enrichedLog(state.log), [state.log]);

  useEffect(() => {
    if (!paused) ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [entries.length, paused]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setPaused(el.scrollHeight - el.scrollTop - el.clientHeight > 32);
  };

  return (
    <div className="log-wrap">
      <div className="log" ref={ref} onScroll={onScroll} aria-live="polite" aria-label="對戰紀錄">
        {entries.map((entry, index) => (
          <div
            key={`${entry.setNo}-${entry.turnNo}-${index}`}
            className={`${entry.player === 0 ? "log-me" : entry.player === 1 ? "log-ai" : ""}${entry.summary ? " log-summary" : ""}`}
          >
            {entry.player !== null ? `${entry.player === 0 ? "你" : "電腦"}：` : ""}{entry.text}
          </div>
        ))}
      </div>
      {paused && (
        <button
          className="log-latest"
          onClick={() => {
            setPaused(false);
            ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
          }}
        >
          回到最新
        </button>
      )}
    </div>
  );
}

export function LeftPanel(props: {
  state: GameState;
  deckMeta: [DeckMeta, DeckMeta];
  speed: AiSpeed;
  onSpeedChange: (speed: AiSpeed) => void;
  onExit: () => void;
}) {
  return (
    <aside className="left-panel">
      <div className="match-heading">
        <div className="match-counter"><span>SET</span><strong>{props.state.setNo}</strong></div>
        <div className="match-counter"><span>TURN</span><strong>{props.state.turnNo}</strong></div>
        <button className="btn-quiet exit-button" onClick={props.onExit}>離開對戰</button>
      </div>

      <div className="phase-current">
        <span>目前階段</span>
        <strong>{PHASE_NAME[props.state.phase]}</strong>
        <small>{props.state.turnPlayer === 0 ? "你的回合" : "電腦回合"}</small>
      </div>

      <ol className="phase-rail" aria-label="回合階段">
        {PHASE_ORDER.map((phase) => (
          <li key={phase} className={props.state.phase === phase ? "phase-active" : ""}>{PHASE_NAME[phase]}</li>
        ))}
      </ol>

      <div className="deck-support-list">
        <DeckSupport meta={props.deckMeta[0]} player={0} />
        <DeckSupport meta={props.deckMeta[1]} player={1} />
      </div>

      <GameLog state={props.state} />

      <div className="speed-control">
        <span>AI 速度</span>
        <div role="group" aria-label="AI 速度">
          {(["0.5", "1", "2", "instant"] as const).map((speed) => (
            <button key={speed} className={props.speed === speed ? "is-active" : ""} onClick={() => props.onSpeedChange(speed)}>
              {speed === "instant" ? "瞬間" : `${speed}×`}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

function ParamsTable(props: { card: Card; state: GameState; db: CardDb; uid?: number }) {
  if (!props.card.params) return null;
  const keys = ["serve", "block", "receive", "toss", "attack"] as const;
  const labels = ["發球", "攔網", "接球", "托球", "攻擊"];
  return (
    <table className="params">
      <tbody>
        <tr>{labels.map((label) => <th key={label}>{label}</th>)}</tr>
        <tr>
          {keys.map((key) => {
            const base = props.card.params![key];
            const value = props.uid === undefined ? base : effParam(props.db, props.state, props.uid, key);
            const modified = base !== null && value !== base;
            return <td key={key} className={modified ? "param-modified" : ""}><b>{value ?? "－"}</b>{modified && <small>{base}</small>}</td>;
          })}
        </tr>
      </tbody>
    </table>
  );
}

export function CardDetails(props: {
  db: CardDb;
  state: GameState;
  inspected: InspectedCard | null;
}) {
  const card = props.inspected ? props.db.get(props.inspected.cardId) ?? null : null;
  if (!card) {
    return (
      <div className="empty-detail">
        <b>卡片詳情</b>
        <span>將游標移到卡片上，或在觸控裝置長按卡片。</span>
      </div>
    );
  }

  const statusLabel = card.effectStatus === "dsl" ? "效果已實作" : card.effectStatus === "todo" ? "效果尚未實作" : card.effectStatus === "script" ? "特例效果" : "無技能";
  return (
    <article className="card-detail-content">
      <div className="detail-title">
        <div>
          <b>{displayName(card)}</b>
          {card.nameZh && <span>{card.nameJa}</span>}
        </div>
        <small>{card.id}</small>
      </div>
      <div className="detail-badges">
        <span>{card.affiliations.join("/") || "無所屬"}</span>
        <span className={`effect-status effect-${card.effectStatus}`}>{statusLabel}</span>
      </div>
      <ParamsTable card={card} state={props.state} db={props.db} uid={props.inspected?.uid} />
      {(card.skillZh || card.skillJa) && (
        <div className="skill-text">
          {card.skillZh ?? card.skillJa}
          {card.skillZhStatus === "machine" && <span className="badge-machine">翻譯待確認</span>}
        </div>
      )}
      {card.effectStatus === "todo" && <p className="support-note">這張卡的文字資料已收錄，但技能尚未接入規則引擎；對戰中會視為無效果。</p>}
    </article>
  );
}

export function DropBrowser(props: {
  db: CardDb;
  state: GameState;
  player: PlayerId;
  onClose: () => void;
  onSelect: (uid: number) => void;
  onHover: (uid: number | null) => void;
}) {
  const cards = [...props.state.players[props.player].drop].reverse();
  return (
    <div className="drop-browser">
      <div className="panel-heading">
        <div><b>{props.player === 0 ? "你的" : "對方的"}棄牌</b><span>{cards.length} 張</span></div>
        <button className="btn-quiet" onClick={props.onClose}>返回</button>
      </div>
      {cards.length === 0 ? (
        <div className="drop-empty">棄牌區是空的</div>
      ) : (
        <div className="drop-grid">
          {cards.map((uid) => (
            <CardView
              key={uid}
              card={props.db.get(props.state.cards[uid]!)!}
              uid={uid}
              width={58}
              onClick={() => props.onSelect(uid)}
              onLongPress={() => props.onSelect(uid)}
              onHover={(card) => props.onHover(card ? uid : null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CompactHud(props: {
  state: GameState;
  onOpenLog: () => void;
  onOpenDetail: () => void;
  onExit: () => void;
}) {
  return (
    <header className="compact-hud">
      <div className="compact-score"><span>SET {props.state.setNo}</span><span>TURN {props.state.turnNo}</span></div>
      <strong>{PHASE_NAME[props.state.phase]}</strong>
      {props.state.op && <span className="compact-op">OP {props.state.op.value}</span>}
      <div className="compact-actions">
        <button onClick={props.onOpenLog}>紀錄</button>
        <button onClick={props.onOpenDetail}>卡片</button>
        <button onClick={props.onExit}>離開</button>
      </div>
    </header>
  );
}
