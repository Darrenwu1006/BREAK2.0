import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import type { Card } from "../data/types";
import { effParam } from "../engine/engine";
import type { CardDb, Decision, GameState, LogEntry, Phase, PlayerId } from "../engine/types";
import type { CoachReport } from "../ai/coach";
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

interface DisplayLogEntry extends LogEntry {
  summary?: boolean;
}

function enrichedLog(log: LogEntry[]): DisplayLogEntry[] {
  const out: DisplayLogEntry[] = [];
  let lastJudge = "";
  for (const entry of log) {
    out.push(entry);
    if (entry.text.startsWith("判定：")) lastJudge = entry.text.replace("判定：", "").trim();
    if (entry.event?.kind === "set-won" || entry.event?.kind === "match-won") {
      const scorer = entry.event.winner === 0 ? "你得分" : "電腦得分";
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
  sfxEnabled: boolean;
  onToggleSfx: () => void;
  onExit: () => void;
}) {
  const { state, deckMeta } = props;
  const phaseIndex = PHASE_ORDER.indexOf(state.phase);
  return (
    <aside className="left-panel">
      <div className="match-bar">
        <div className="match-line">
          <span className="match-counter-inline">SET <b>{state.setNo}</b></span>
          <span className="match-counter-inline">TURN <b>{state.turnNo}</b></span>
          <button className="btn-quiet match-exit" onClick={props.onExit}>離開</button>
        </div>
        <div className="phase-row">
          <strong>{PHASE_NAME[state.phase]}</strong>
          <small className={state.turnPlayer === 0 ? "tone-me" : "tone-op"}>
            {state.turnPlayer === 0 ? "你的回合" : "電腦回合"}
          </small>
        </div>
        <ol className="phase-pips" aria-label={`回合階段：目前 ${PHASE_NAME[state.phase]}`}>
          {PHASE_ORDER.map((phase, index) => (
            <li
              key={phase}
              className={state.phase === phase ? "on" : index < phaseIndex ? "done" : ""}
              title={PHASE_NAME[phase]}
            />
          ))}
        </ol>
        <div className="match-decks">
          <span className="player-tone-0"><b>你</b> {deckMeta[0].school}／{deckMeta[0].name}</span>
          <span className="player-tone-1"><b>電腦</b> {deckMeta[1].school}／{deckMeta[1].name}</span>
        </div>
      </div>

      <GameLog state={state} />

      <div className="speed-control">
        <span>AI 速度</span>
        <div role="group" aria-label="AI 速度">
          {(["0.5", "1", "2", "instant"] as const).map((speed) => (
            <button key={speed} className={props.speed === speed ? "is-active" : ""} onClick={() => props.onSpeedChange(speed)}>
              {speed === "instant" ? "瞬間" : `${speed}×`}
            </button>
          ))}
        </div>
        <label className="sfx-toggle">
          <input type="checkbox" checked={props.sfxEnabled} onChange={props.onToggleSfx} />
          擬音字
        </label>
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

const KEYWORD_TRANSLATIONS: Record<string, string> = {
  "登場": "登場",
  "アタックエリア": "攻擊區",
  "トスエリア": "托球區",
  "レシーブエリア": "接球區",
  "ブロックエリア": "攔網區",
  "サーブエリア": "發球區",
  "コート": "球場",
  "手札": "手牌",
  "サーブ": "發球",
  "レシーブ": "接球",
  "トス": "托球",
  "アタック": "攻擊",
  "阻擊": "攔網",
  "阻擊フェイズ": "攔網階段",
  "ブロック": "攔網",
  "抽牌": "抽牌",
  "一回合一次": "一回合一次",
  "一回限り": "僅限一次",
  "ターン1": "一回合一次",
  "ブロックフェイズ": "攔網階段",
  "レシーブフェイズ": "接球階段",
  "ドロー": "抽牌",
};

function translateKeyword(kw: string): string {
  if (KEYWORD_TRANSLATIONS[kw]) return KEYWORD_TRANSLATIONS[kw]!;
  return kw
    .replace(/ドシャット/g, "攔死")
    .replace(/ワンタッチ/g, "一次觸球")
    .replace(/One Touch/g, "一次觸球")
    .replace(/ツーアタック/g, "二次進攻")
    .replace(/Aパス/g, "A Pass")
    .replace(/銅牆鐵壁/g, "銅牆鐵壁")
    .replace(/虛攻/g, "虛攻")
    .replace(/ブロックアウト/g, "打手出界");
}

export function extractLeadingSkillMarkers(text: string): { markers: string[]; body: string } {
  const markers: string[] = [];
  let body = text.trimStart();
  while (true) {
    const match = body.match(/^\[=([^\]]+)\]\s*/);
    if (!match) break;
    markers.push(match[1]!);
    body = body.slice(match[0].length).trimStart();
  }
  return { markers, body };
}

/** 把技能文裡的 [=關鍵字] 標記轉成可讀的小 chip，而不是裸露的 [=ターン1]。 */
function renderSkillText(text: string) {
  return text.split(/(\[=[^\]]+\])/g).map((part, index) => {
    const marker = part.match(/^\[=([^\]]+)\]$/);
    if (marker) {
      const translated = translateKeyword(marker[1]!);
      return <span key={index} className="skill-kw">{translated}</span>;
    }
    return <span key={index}>{part}</span>;
  });
}

/** 共用：技能發動時機/限制 badge ＋技能文（含關鍵字 chip）。對戰詳情與牌組編輯器共用。 */
export function CardSkillInfo({ card }: { card: Card }) {
  const timingList = card.timing.filter((t) => t !== "回合1");
  const oncePerTurn = card.timing.includes("回合1") || !!card.skillJa?.includes("ターン1");
  const timingLabel = card.type === "EVENT" ? "可使用時機" : "發動時機";
  const skillText = card.skillZh ?? card.skillJa;
  const normalizedSkill = skillText ? extractLeadingSkillMarkers(skillText) : { markers: [], body: "" };
  const timingBadges = [...timingList];
  for (const marker of normalizedSkill.markers) {
    const translated = translateKeyword(marker);
    if (marker === "ターン1" || translated === "一回合一次") continue;
    if (!timingBadges.includes(translated)) timingBadges.push(translated);
  }
  const hasOncePerTurn = oncePerTurn || normalizedSkill.markers.some((marker) => marker === "ターン1");
  const displaySkillText = normalizedSkill.body || skillText;
  if (timingBadges.length === 0 && !hasOncePerTurn && !displaySkillText) return null;
  return (
    <>
      {(timingBadges.length > 0 || hasOncePerTurn) && (
        <div className="timing-row">
          <span className="timing-label">{timingLabel}</span>
          {timingBadges.map((t) => <span key={t} className="timing-badge">{t}</span>)}
          {hasOncePerTurn && <span className="restrict-badge">一回合一次</span>}
        </div>
      )}
      {displaySkillText && (
        <div className="skill-text">
          {renderSkillText(displaySkillText)}
          {card.skillZhStatus === "machine" && <span className="badge-machine">翻譯待確認</span>}
        </div>
      )}
    </>
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
      <CardSkillInfo card={card} />
      {card.effectStatus === "todo" && <p className="support-note">這張卡的文字資料已收錄，但技能尚未接入規則引擎；對戰中會視為無效果。</p>}
    </article>
  );
}

const SOURCE_LABEL: Record<string, string> = { serve: "發球", block: "攔網回球", attack: "攻擊", receive: "接球" };

export function MatchSummary({ state, replayEntries = 0 }: { state: GameState; replayEntries?: number }) {
  const rows = ([0, 1] as const).map((player) => {
    const ps = state.players[player];
    return { player, deck: ps.deck.length, hand: ps.hand.length, drop: ps.drop.length, set: ps.setArea.length, event: ps.eventArea.length };
  });
  return (
    <div className="match-summary">
      <div className="summary-block">
        <b>攻防</b>
        {state.op ? (
          <div className="summary-op">
            <span className="op-tag">OP {state.op.value}</span>
            <small>{SOURCE_LABEL[state.op.source] ?? state.op.source}・{state.op.owner === 0 ? "你" : "電腦"}</small>
            {state.dp && <span className="dp-tag">DP {state.dp.value}</span>}
          </div>
        ) : (
          <small className="summary-idle">目前沒有進行中的攻防</small>
        )}
      </div>
      <div className="summary-block">
        <b>場上資源</b>
        <table className="summary-table">
          <thead>
            <tr><th></th><th>牌組</th><th>手牌</th><th>棄牌</th><th>Set</th><th>事件</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.player}>
                <td className={`tone-cell player-tone-${row.player}`}>{row.player === 0 ? "你" : "電腦"}</td>
                <td>{row.deck}</td><td>{row.hand}</td><td>{row.drop}</td><td>{row.set}</td><td>{row.event}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="summary-block">
        <b>覆盤資料</b>
        <small className="summary-idle">已記錄 {replayEntries} 個決策點，賽後覆盤會以這條歷史鏈重播。</small>
      </div>
      <p className="summary-hint">將游標移到卡片上看詳情，或用上方工具切換「算牌／棄牌」。</p>
    </div>
  );
}

export function CardCounter({ db, state }: { db: CardDb; state: GameState }) {
  const groups = useMemo(() => {
    const ps = state.players[0];
    const allUids = [
      ...ps.deck,
      ...ps.hand,
      ...ps.setArea,
      ...ps.drop,
      ...ps.eventArea,
      ...ps.serve,
      ...ps.blockCenter,
      ...ps.blockSides,
      ...ps.receive,
      ...ps.toss,
      ...ps.attack,
    ];

    const totalCount = new Map<string, number>();
    for (const uid of allUids) {
      const id = state.cards[uid]!;
      totalCount.set(id, (totalCount.get(id) ?? 0) + 1);
    }

    const deckCount = new Map<string, number>();
    for (const uid of ps.deck) {
      const id = state.cards[uid]!;
      deckCount.set(id, (deckCount.get(id) ?? 0) + 1);
    }

    return [...totalCount.entries()]
      .map(([id, total]) => ({
        id,
        count: deckCount.get(id) ?? 0,
        total,
        card: db.get(id),
      }))
      .filter((row) => row.card)
      .sort((a, b) => b.count - a.count || b.total - a.total || a.id.localeCompare(b.id));
  }, [db, state.cards, state.players]);

  const remaining = state.players[0].deck.length;
  return (
    <div className="card-counter">
      <div className="panel-heading">
        <div><b>你的牌組剩餘</b><span>{remaining} 張・{groups.length} 種</span></div>
      </div>
      {groups.length === 0 ? (
        <div className="drop-empty">牌組已抽完</div>
      ) : (
        <ul className="counter-list">
          {groups.map((row) => (
            <li key={row.id} className={row.count === 0 ? "counter-zero" : ""}>
              <span className="counter-name">{displayName(row.card!)}</span>
              <span className="counter-count">
                <b>{row.count}</b><span className="counter-slash">/</span>{row.total}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="summary-hint">顯示「剩餘數量／投入總量」，不洩漏抽牌順序，方便練習算牌。</p>
    </div>
  );
}

export function DropBrowser(props: {
  db: CardDb;
  state: GameState;
  player: PlayerId;
  source?: "drop" | "event";
  onClose: () => void;
  onSelect: (uid: number) => void;
  onHover: (uid: number | null) => void;
}) {
  const source = props.source ?? "drop";
  const label = source === "event" ? "事件區" : "棄牌";
  const pile = source === "event" ? props.state.players[props.player].eventArea : props.state.players[props.player].drop;
  const cards = [...pile].reverse();
  return (
    <div className="drop-browser">
      <div className="panel-heading">
        <div><b>{props.player === 0 ? "你的" : "對方的"}{label}</b><span>{cards.length} 張</span></div>
        <button className="btn-quiet" onClick={props.onClose}>返回</button>
      </div>
      {cards.length === 0 ? (
        <div className="drop-empty">{label}是空的</div>
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

export type CoachPanelState =
  | { status: "idle" }
  | { status: "loading"; fallback: Decision }
  | { status: "ready"; report: CoachReport }
  | { status: "error"; fallback: Decision | null; error: string };

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function cardLabel(db: CardDb, state: GameState, uid: number): string {
  const id = state.cards[uid];
  const card = id ? db.get(id) : null;
  return card ? displayName(card) : `uid ${uid}`;
}

function decisionLabel(db: CardDb, state: GameState, decision: Decision): string {
  switch (decision.type) {
    case "serve-rights":
      return decision.take ? "取得首次發球權" : "讓出首次發球權";
    case "mulligan":
      return decision.returnUids.length ? `換 ${decision.returnUids.length} 張` : "不換牌";
    case "defense-choice":
      return decision.choice === "block" ? "選擇攔網" : "選擇接球";
    case "free":
      if (decision.action === "pass") return "自由步驟 Pass";
      if (decision.action === "lost") return "主動 Lost";
      return decision.action === "event" ? `使用事件 ${cardLabel(db, state, decision.uid)}` : `使用技能 ${cardLabel(db, state, decision.uid)}`;
    case "resolve-pending":
      return `解決待機效果 #${decision.id}`;
    case "effect-confirm":
      return decision.accept ? "使用 / 接受" : "不使用 / 拒絕";
    case "effect-cards":
      return decision.uids.length ? `選 ${decision.uids.length} 張` : "不選卡";
    case "effect-option":
      return `選項：${state.pendingDecision?.options?.[decision.index] ?? decision.index + 1}`;
    case "pick-set-card":
      return `拿 Set 卡 #${decision.index + 1}`;
    case "deploy-block":
      return decision.uids === null ? "不登場攔網" : `攔網 ${decision.uids.map((uid) => cardLabel(db, state, uid)).join("、")}`;
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack":
      return decision.uid === null ? "不登場角色" : `登場 ${cardLabel(db, state, decision.uid)}`;
  }
}

export function CoachPanel(props: {
  db: CardDb;
  state: GameState;
  coach: CoachPanelState;
  onApply: (decision: Decision) => void;
}) {
  const { coach, db, state } = props;
  const pending = state.pendingDecision;
  if (state.phase === "gameOver") {
    return (
      <div className="coach-panel">
        <div className="panel-heading"><div><b>Coach</b><span>對戰已結束</span></div></div>
        <p className="summary-hint">這場比賽已經結束，沒有需要分析的當前行動。</p>
      </div>
    );
  }
  if (!pending || pending.player !== 0) {
    return (
      <div className="coach-panel">
        <div className="panel-heading"><div><b>Coach</b><span>等待你的決策</span></div></div>
        <p className="summary-hint">輪到你選擇行動時，這裡會顯示快速建議與 PIMC 勝率估計。</p>
      </div>
    );
  }

  if (coach.status === "idle") {
    return (
      <div className="coach-panel">
        <div className="panel-heading"><div><b>Coach</b><span>準備中</span></div></div>
        <p className="summary-hint">正在準備目前局面的建議。</p>
      </div>
    );
  }

  if (coach.status === "error") {
    return (
      <div className="coach-panel">
        <div className="panel-heading"><div><b>Coach</b><span>暫時無法完成 PIMC</span></div></div>
        {coach.fallback && (
          <div className="coach-best">
            <small>Heuristic fallback</small>
            <b>{decisionLabel(db, state, coach.fallback)}</b>
            <button onClick={() => props.onApply(coach.fallback!)}>採用</button>
          </div>
        )}
        <p className="coach-error">{coach.error}</p>
      </div>
    );
  }

  if (coach.status === "loading") {
    return (
      <div className="coach-panel">
        <div className="panel-heading"><div><b>Coach</b><span>PIMC 計算中</span></div></div>
        <div className="coach-best">
          <small>Heuristic fallback</small>
          <b>{decisionLabel(db, state, coach.fallback)}</b>
          <p>先用快速 AI 給出可採用建議；背景會繼續計算勝率。</p>
          <button onClick={() => props.onApply(coach.fallback)}>採用</button>
        </div>
        <div className="coach-loading" aria-hidden="true"><span /><span /><span /></div>
      </div>
    );
  }

  const { report } = coach;
  const top = report.recommendations.slice(0, 4);
  return (
    <div className="coach-panel">
      <div className="panel-heading">
        <div>
          <b>Coach</b>
          <span>{report.completedSamples} samples・{report.timedOut ? "timeout fallback" : "PIMC"}</span>
        </div>
      </div>
      <div className="coach-best">
        <small>最佳建議</small>
        <b>{report.bestAction.label}</b>
        <div className="coach-metrics">
          <span><b>{percent(report.bestAction.winRate)}</b> 勝率</span>
          <span><b>{percent(report.bestAction.confidence)}</b> 信心</span>
        </div>
        <p>{report.bestAction.explanation}</p>
        <button onClick={() => props.onApply(report.bestAction.decision)}>採用建議</button>
      </div>
      <ol className="coach-list">
        {top.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            <div className="coach-row-head">
              <b>{item.label}</b>
              <span>{percent(item.winRate)}</span>
            </div>
            <div className="coach-row-meta">
              <span>信心 {percent(item.confidence)}</span>
              <span>{item.sampleCount} samples</span>
            </div>
            <p>{item.explanation}</p>
            {item.principalLine.length > 0 && (
              <details>
                <summary>模擬線</summary>
                {item.principalLine.slice(0, 3).map((line) => <small key={line}>{line}</small>)}
              </details>
            )}
          </li>
        ))}
      </ol>
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
