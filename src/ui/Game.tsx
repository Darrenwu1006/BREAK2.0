import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import type { Card } from "../data/types";
import type { CourtArea } from "../engine/dsl";
import { canChooseBlock, canDeployTo, deployNames, deployableUids, freeOptions } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { heuristicAiDecision, heuristicProfileForDeckText } from "../ai/heuristic";
import { createSearchController, createWorkerSearchBackend, isSearchCancelled, type CancelableQuery } from "../ai/ai-search";
import { describeDecisionShort } from "../shared/decisionLabels";
import type { CoachReport } from "../ai/coach";
import { estimateThinkBudgetMs } from "../ai/think-budget";
import { CardView } from "./CardView";
import { GameBoard } from "./GameBoard";
import { CardCounter, CardDetails, CoachPanel, DropBrowser, GameLog, MatchSummary, PHASE_NAME, PHASE_ORDER } from "./GamePanels";
import type { CoachPanelState } from "./GamePanels";
import type { DeckMeta } from "../shared/deckMeta";
import type { OpponentEngine, InspectedCard } from "./gameTypes";
import { MotionLayer, useGameMotion } from "./useGameMotion";
import { canUseInPlaceEffectSelection } from "../shared/selection";
import { ZONE_LABEL, groupCandidatesByZone } from "./zoneLocate";
import { MatchSession } from "../shared/matchSession";
import { keyReplayEntries, pendingReplaySetFeedback, stateAtReplayStep, summarizeReplaySession, type ReplayAnalytics, type ReplayEntry, type ReplaySession, type ReplaySetFeedbackChoice } from "../shared/replayHistory";
import type { CardPointerDragInfo } from "./CardView";
import { SetFeedbackDialog } from "./SetFeedbackDialog";
import { PostMatchModal, PostMatchReport } from "../shared/PostMatchReport";

const HUMAN: PlayerId = 0;
/** [Claude 2026-07-25] 候選 C：經典介面的 undo 深度（lab 為 20；純 UX 手感，見 matchSession 的 undoLimit）。 */
const UNDO_HISTORY_LIMIT = 10;
const AI: PlayerId = 1;

const DEPLOY_AREA: Record<string, CourtArea> = {
  "deploy-serve": "serve",
  "deploy-block": "block",
  "deploy-receive": "receive",
  "deploy-toss": "toss",
  "deploy-attack": "attack",
};

const DEPLOY_LABEL: Record<Exclude<CourtArea, "block">, string> = {
  serve: "發球",
  receive: "接球",
  toss: "托球",
  attack: "攻擊",
};

type ToolMode = { type: "detail" } | { type: "coach" } | { type: "counter" } | { type: "settings" } | { type: "drop"; player: PlayerId } | { type: "event"; player: PlayerId };
type DragState = { uid: number; x: number; y: number; width: number; overArea: CourtArea | null; valid: boolean };

// 出手節奏下限（ms）：覆蓋最長的得分潑墨動畫（--splash-ms 900ms），讓出手/得分動畫順順跑完。
// 強敵與快速共用——強敵的思考時間計入此下限，快速無思考、固定等此節奏（不瞬間）。
const AI_PACE_MS = 900;

function initialEngine(): OpponentEngine {
  const stored = localStorage.getItem("breaktcg-opponent-engine");
  if (stored === "strong" || stored === "heuristic") return stored;
  // 從舊「AI 速度」設定遷移一次：instant→heuristic，其餘（0.5/1/2 都是強敵思考預算）→strong。
  const legacy = localStorage.getItem("breaktcg-ai-speed");
  if (legacy !== null) {
    localStorage.removeItem("breaktcg-ai-speed");
    const migrated: OpponentEngine = legacy === "instant" ? "heuristic" : "strong";
    localStorage.setItem("breaktcg-opponent-engine", migrated);
    return migrated;
  }
  return "strong";
}

function initialSfx(): boolean {
  return localStorage.getItem("breaktcg-sfx") !== "off";
}

// [Claude 2026-07-03] Readability V2：手牌卡寬依視窗高自適應（84–108px），
// 取代固定畫布時代的定值；矮視窗自動縮，避免手牌吃掉球場垂直預算。
function handCardFor(viewportHeight: number): number {
  return Math.round(Math.min(100, Math.max(80, viewportHeight * 0.14)));
}

const SFX_SCORE_YOU = ["決まった！", "キメた！", "ナイスキル！"];
const SFX_SCORE_OPP = ["やられた…", "とられた！"];
const SFX_ATTACK_YOU = ["ドン！", "バンッ！", "ズバン！"];
const SFX_ATTACK_OPP = ["ドッ！", "ズバッ！"];

type SplashBanner = { text: string; kind: "set" | "match" };
function actorLabel(entry: ReplayEntry): string {
  return entry.source === "ai" ? "電腦" : entry.player === HUMAN ? "你" : "玩家";
}

/* [Claude 2026-07-03] wireframe V3：Game meta 移入右欄頂部（頂部狀態列廢除）。 */
function SideMeta(props: {
  state: GameState;
  deckMeta: [DeckMeta, DeckMeta];
}) {
  const { state, deckMeta } = props;
  const phaseIndex = PHASE_ORDER.indexOf(state.phase);
  return (
    <section className="side-meta" aria-label="對戰狀態">
      <div className="side-meta-status">
        <span className="top-counter">SET <b>{state.setNo}</b></span>
        <span className="top-counter">TURN <b>{state.turnNo}</b></span>
        <strong>{PHASE_NAME[state.phase]}</strong>
        <small className={state.turnPlayer === HUMAN ? "tone-me" : "tone-op"}>
          {state.turnPlayer === HUMAN ? "你的回合" : "電腦回合"}
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
      <div className="side-meta-decks">
        <span className="player-tone-0"><b>你</b> {deckMeta[0].school}／{deckMeta[0].name}</span>
        <span className="player-tone-1"><b>電腦</b> {deckMeta[1].school}／{deckMeta[1].name}</span>
      </div>
    </section>
  );
}

function SettingsPanel(props: {
  engine: OpponentEngine;
  sfxEnabled: boolean;
  onEngineChange: (engine: OpponentEngine) => void;
  onToggleSfx: () => void;
  onExit: () => void;
}) {
  return (
    <div className="settings-panel">
      <div className="panel-heading">
        <div>
          <b>設定</b>
          <span>對手與演出偏好</span>
        </div>
      </div>
      <section className="settings-section">
        <b>對手引擎</b>
        <div className="segmented-control" role="group" aria-label="對手引擎">
          {([["strong", "強敵"], ["heuristic", "快速"]] as const).map(([value, label]) => (
            <button key={value} className={props.engine === value ? "is-active" : ""} onClick={() => props.onEngineChange(value)}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <b>演出</b>
        <label className="settings-check">
          <input type="checkbox" checked={props.sfxEnabled} onChange={props.onToggleSfx} />
          擬音字
        </label>
      </section>
      {/* [使用者 2026-07-03] 離開對戰收進設定，避免誤觸 */}
      <div className="settings-actions">
        <button className="btn-secondary" onClick={props.onExit}>離開對戰</button>
      </div>
    </div>
  );
}

function ReplayStepSummary(props: {
  state: GameState;
  entry: ReplayEntry | null;
  step: number;
  total: number;
  analytics: ReplayAnalytics;
  keyEntries: ReplayEntry[];
  onJump: (step: number) => void;
}) {
  const { state, entry, step, total, analytics, keyEntries } = props;
  const newLogs = entry ? entry.after.log.slice(entry.logStart, entry.logEnd) : [];
  return (
    <div className="replay-panel">
      <div className="panel-heading">
        <div>
          <b>賽後覆盤</b>
          <span>Step {step} / {total}</span>
        </div>
      </div>
      <div className="replay-body">
        {entry ? (
          <div className="replay-card">
            <span className="replay-pill">{actorLabel(entry)}</span>
            <b>{describeDecisionShort(entry.decision)}</b>
            <small>{PHASE_NAME[entry.phase]}・Set {entry.setNo}・Turn {entry.turnNo}</small>
          </div>
        ) : (
          <div className="replay-card">
            <span className="replay-pill">開局</span>
            <b>對局初始狀態</b>
            <small>{PHASE_NAME[state.phase]}・Set {state.setNo}・Turn {state.turnNo}</small>
          </div>
        )}
        <div className="replay-overview">
          <div className="replay-overview-heading">
            <b>全場索引</b>
          </div>
          <div className="replay-stat-grid">
            <span><small>玩家決策</small><b>{analytics.playerDecisions}</b></span>
            <span><small>AI 決策</small><b>{analytics.aiDecisions}</b></span>
            <span><small>Set</small><b>{analytics.setWins[0]}:{analytics.setWins[1]}</b></span>
            <span><small>Guts</small><b>{analytics.payGuts[0]}:{analytics.payGuts[1]}</b></span>
          </div>
          <div className="replay-source-row" aria-label="OP 來源">
            <span>發球 {analytics.opSources.serve}</span>
            <span>攔網 {analytics.opSources.block}</span>
            <span>攻擊 {analytics.opSources.attack}</span>
          </div>
          <div className="replay-step-list">
            {keyEntries.length === 0 ? (
              <small className="summary-idle">目前沒有關鍵步驟。</small>
            ) : keyEntries.map((item) => {
              const itemStep = item.index + 1;
              return (
                <button
                  key={item.index}
                  className={`replay-step-button${itemStep === step ? " is-active" : ""}`}
                  onClick={() => props.onJump(itemStep)}
                >
                  <span>#{itemStep}</span>
                  <b>{actorLabel(item)}・{describeDecisionShort(item.decision)}</b>
                  <small>{PHASE_NAME[item.phase]}・Set {item.setNo} Turn {item.turnNo}</small>
                </button>
              );
            })}
          </div>
        </div>
        <MatchSummary state={state} replayEntries={total} />
        <div className="replay-logs">
          <b>此步新增紀錄</b>
          {newLogs.length === 0 ? (
            <small className="summary-idle">這一步沒有新增 log。</small>
          ) : (
            <ul>
              {newLogs.slice(-6).map((log, index) => (
                <li key={`${log.setNo}-${log.turnNo}-${index}`}>{log.text}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function Game(props: {
  db: CardDb;
  decks: [string[], string[]];
  deckMeta: [DeckMeta, DeckMeta];
  loadedReplay?: ReplaySession;
  /** [Claude 2026-07-25] 賽後戰報的「再來一場（同牌組）」；由 App 以新 key 重掛（同 UiLabGame 手法）。 */
  onRematch?: () => void;
  onExit: () => void;
}) {
  const { db } = props;
  const aiProfile = useMemo(
    () => heuristicProfileForDeckText(`${props.deckMeta[AI].school} ${props.deckMeta[AI].name}`),
    [props.deckMeta],
  );
  // [Claude 2026-07-25] 候選 C Part 1：對局編排改用共用 MatchSession（mutable class）。
  // React 側只留膠水：ref 持有 session、onChange 觸發 bump 重繪；權威狀態一律讀 session.engine／session.replay。
  const [, bumpSession] = useReducer((tick: number) => tick + 1, 0);
  const sessionRef = useRef<MatchSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = props.loadedReplay
      ? MatchSession.fromReplay(db, props.loadedReplay, { onChange: bumpSession })
      : new MatchSession(db, props.decks, (Date.now() % 0xffffffff) >>> 0, {
          deckMeta: props.deckMeta,
          deferOpponent: true, // 對手決策一律由 ai-search 回填（見下方 AI effect）
          undoLimit: UNDO_HISTORY_LIMIT,
          onChange: bumpSession,
        });
  }
  const session = sessionRef.current;
  const state = session.engine;
  const replay = session.replay;
  const [hovered, setHovered] = useState<InspectedCard | null>(null);
  const [inspected, setInspected] = useState<InspectedCard | null>(null);
  const [multiSel, setMultiSel] = useState<number[]>([]);
  const [nameAsk, setNameAsk] = useState<{ uid: number; names: string[] } | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>({ type: "detail" });
  const [coach, setCoach] = useState<CoachPanelState>({ status: "idle" });
  const [mobilePanel, setMobilePanel] = useState<"log" | "detail" | null>(null);
  const [activeGutsKey, setActiveGutsKey] = useState<string | null>(null);
  const [engine, setEngine] = useState<OpponentEngine>(initialEngine);
  const [scoreBanner, setScoreBanner] = useState<SplashBanner | null>(null);
  const [sfxEnabled, setSfxEnabled] = useState<boolean>(initialSfx);
  const [sfx, setSfx] = useState<{ text: string; key: number } | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [replayMode, setReplayMode] = useState(!!props.loadedReplay);
  const [replayStep, setReplayStep] = useState(props.loadedReplay ? props.loadedReplay.entries.length : 0);
  const [feedbackReadyAnchor, setFeedbackReadyAnchor] = useState<number | null>(null);
  const decisionRef = useRef<HTMLDivElement>(null);
  const handRef = useRef<HTMLDivElement>(null);
  const coachQueryRef = useRef<CancelableQuery<CoachReport> | null>(null);
  // [Claude 2026-06-22] Phase F 塊2：強敵 PIMC 思考用的查詢 handle／思考提示狀態。
  const aiQueryRef = useRef<CancelableQuery<Decision> | null>(null);
  const aiPaceTimerRef = useRef<number | null>(null);
  // [Claude 2026-07-24] 候選 A：搜尋門面（取消/取代/fallback/調參都在 module 內）。React 只留膠水。
  const search = useMemo(() => createSearchController({ backend: createWorkerSearchBackend() }), []);
  const [aiThinking, setAiThinking] = useState<{ budgetMs: number } | null>(null);
  const savedReplayRef = useRef(false);
  const [handWidth, setHandWidth] = useState(0);
  const [handCard, setHandCard] = useState(() => handCardFor(window.innerHeight));
  const [showPostMatchModal, setShowPostMatchModal] = useState(false);
  const seenLogCount = useRef(state.log.length);

  const pendingSetFeedback = useMemo(
    () => replayMode ? null : pendingReplaySetFeedback(replay),
    [replay, replayMode],
  );
  const pd = pendingSetFeedback ? null : state.pendingDecision;
  const viewState = replayMode ? stateAtReplayStep(replay, replayStep) : state;
  const replayEntry = replayStep > 0 ? replay.entries[replayStep - 1] ?? null : null;
  const replayAnalytics = useMemo(() => summarizeReplaySession(replay), [replay]);
  const replayKeyEntries = useMemo(() => keyReplayEntries(replay), [replay]);
  const isMyDecision = pd?.player === HUMAN && state.phase !== "gameOver";
  const deployArea = pd && pd.type in DEPLOY_AREA ? DEPLOY_AREA[pd.type]! : null;
  const deployable = isMyDecision && deployArea ? deployableUids(db, state, HUMAN, deployArea) : [];
  const free = isMyDecision && pd?.type === "free" ? freeOptions(db, state) : { skills: [], events: [] };
  // effect-cards：候選若都在可見的手牌/場上 → 就地選取（不另開卡列）
  const effectCards = pd && pd.type === "effect-cards" ? pd : null;
  const effectCandidates = effectCards?.candidates ?? [];
  const effectMax = effectCards?.max ?? 1;
  const effectCardsInPlace = isMyDecision && !!effectCards
    && canUseInPlaceEffectSelection(state, HUMAN, effectCandidates);
  const { motions, recentUids, settledUids } = useGameMotion({ state: viewState, db, deckMeta: props.deckMeta, disabled: replayMode });

  const visibleInspection = hovered ?? inspected;
  const canUndo = !replayMode && !pendingSetFeedback && session.canUndo;

  function cardOf(uid: number): Card {
    return db.get(viewState.cards[uid]!)!;
  }

  function setHoverUid(uid: number | null) {
    setHovered(uid === null ? null : { cardId: viewState.cards[uid]!, uid });
  }

  function inspectUid(uid: number) {
    setInspected({ cardId: viewState.cards[uid]!, uid });
    setToolMode({ type: "detail" });
    setMobilePanel("detail");
  }

  function clearTransientUi() {
    setMultiSel([]);
    setNameAsk(null);
    setActiveGutsKey(null);
    setDragging(null);
    setScoreBanner(null);
    setSfx(null);
  }

  function decide(decision: Decision) {
    if (pendingSetFeedback) return;
    clearTransientUi();
    session.decide(decision);
  }

  function undoLastDecision() {
    if (pendingSetFeedback || !session.canUndo) return;
    clearTransientUi();
    if (session.undo()) seenLogCount.current = session.engine.log.length;
  }

  function recordSetFeedback(choice: ReplaySetFeedbackChoice, note?: string) {
    if (!pendingSetFeedback) return;
    const target = pendingSetFeedback;
    session.recordSetFeedback({
      setNo: target.setNo,
      anchorEntryIndex: target.anchorEntryIndex,
      choice,
      ...(choice !== "skipped" && note?.trim() ? { note: note.trim() } : {}),
    });
    setFeedbackReadyAnchor(null);
  }

  function enterReplayMode() {
    clearTransientUi();
    setToolMode({ type: "detail" });
    setMobilePanel(null);
    setShowPostMatchModal(false);
    setReplayStep(replay.entries.length);
    setReplayMode(true);
  }

  function exitReplayMode() {
    clearTransientUi();
    setReplayMode(false);
    setReplayStep(0);
  }

  function changeEngine(next: OpponentEngine) {
    setEngine(next);
    localStorage.setItem("breaktcg-opponent-engine", next);
  }

  function toggleSfx() {
    setSfxEnabled((on) => {
      const next = !on;
      localStorage.setItem("breaktcg-sfx", next ? "on" : "off");
      return next;
    });
  }

  // [Claude 2026-06-22] Phase F 塊2：把 PIMC 接成電腦對手的「腦」。
  // 預設＝強敵：用 coach-worker 跑 SO-ISMCTS 搜尋（隱藏資訊抽樣，不偷看），思考預算由 estimateThinkBudgetMs
  // 依盤面自適應約 0.5–10 秒；瑣碎盤面快、決勝高壓盤面想滿。worker 失敗時退回 heuristic 不卡關。
  // engine === "heuristic" 為快速模式：直接走 heuristic、不啟動搜尋、不顯思考提示，但保留出手節奏
  // 與動畫/擬音（不瞬間）——即時運算後等 AI_PACE_MS 讓動畫順順跑完。
  useEffect(() => {
    aiQueryRef.current?.cancel();
    aiQueryRef.current = null;
    if (aiPaceTimerRef.current !== null) { window.clearTimeout(aiPaceTimerRef.current); aiPaceTimerRef.current = null; }
    if (replayMode || pendingSetFeedback || pd?.player !== AI || state.phase === "gameOver") {
      setAiThinking(null);
      return;
    }

    function applyAiDecision(decision: Decision) {
      setAiThinking(null);
      // session 是 mutable，出手前重讀權威狀態：搜尋期間盤面可能已被 undo／Set 回饋改動。
      if (pendingReplaySetFeedback(session.replay) || !session.awaitingOpponent || session.engine.phase === "gameOver") return;
      session.decideOpponent(decision);
    }

    // [Claude 2026-06-22] 出手節奏下限：搜尋常在 1 秒內想完，會搶在出手動畫前推進、把動畫切掉。
    // 故設每手最小耗時，思考時間計入此下限——想得久就不額外等、想得快就補到下限讓動畫跑完。
    const startedAt = Date.now();
    function applyAiDecisionPaced(decision: Decision) {
      const remaining = AI_PACE_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        applyAiDecision(decision);
        return;
      }
      setAiThinking(null);
      aiPaceTimerRef.current = window.setTimeout(() => {
        aiPaceTimerRef.current = null;
        applyAiDecision(decision);
      }, remaining);
    }

    // 演出：strong 顯示思考中回饋＋180ms 前置延遲；heuristic 即時。決策來源（worker vs heuristic）由 search 決定。
    function askOpponent() {
      // requestOpponentMove 內部：strong→worker(ismcts)；heuristic→同步；搜尋失敗（非取消）自動落 heuristic。
      const query = search.requestOpponentMove(state, {
        db,
        engine: engine === "heuristic" ? "heuristic" : "strong",
        perspectivePlayer: AI,
        knownDecks: props.decks,
        seed: state.rngState,
        timeLimitMs: engine === "heuristic" ? 0 : estimateThinkBudgetMs(state),
        rolloutPolicy: aiProfile,
      });
      aiQueryRef.current = query;
      query.promise.then(applyAiDecisionPaced).catch((err) => {
        if (!isSearchCancelled(err)) applyAiDecisionPaced(heuristicAiDecision(db, state, aiProfile));
      });
    }

    if (engine === "heuristic") {
      setAiThinking(null);
      askOpponent();
      return () => {
        if (aiPaceTimerRef.current !== null) { window.clearTimeout(aiPaceTimerRef.current); aiPaceTimerRef.current = null; }
        aiQueryRef.current?.cancel();
        aiQueryRef.current = null;
      };
    }

    const timer = window.setTimeout(() => {
      setAiThinking({ budgetMs: estimateThinkBudgetMs(state) });
      askOpponent();
    }, 180);

    return () => {
      window.clearTimeout(timer);
      if (aiPaceTimerRef.current !== null) { window.clearTimeout(aiPaceTimerRef.current); aiPaceTimerRef.current = null; }
      aiQueryRef.current?.cancel();
      aiQueryRef.current = null;
    };
  }, [aiProfile, db, pd, pendingSetFeedback, props.decks, props.deckMeta, replayMode, engine, state, search]);

  useEffect(() => {
    coachQueryRef.current?.cancel();
    coachQueryRef.current = null;

    if (replayMode || !isMyDecision || !pd) {
      setCoach({ status: "idle" });
      return;
    }

    let fallback: Decision | null = null;
    try {
      fallback = heuristicAiDecision(db, state);
      setCoach({ status: "loading", fallback });
    } catch (error) {
      setCoach({ status: "error", fallback: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const timer = window.setTimeout(() => {
      const query = search.requestCoachReport(state, {
        perspectivePlayer: HUMAN,
        knownDecks: props.decks,
        gameplanDeckLabels: [`${props.deckMeta[0].school}-${props.deckMeta[0].name}`, `${props.deckMeta[1].school}-${props.deckMeta[1].name}`],
        seed: state.rngState,
      });
      coachQueryRef.current = query;
      query.promise.then(
        (report) => {
          if (coachQueryRef.current === query) coachQueryRef.current = null;
          setCoach({ status: "ready", report });
        },
        (err) => {
          if (coachQueryRef.current === query) coachQueryRef.current = null;
          if (!isSearchCancelled(err)) setCoach({ status: "error", fallback, error: err instanceof Error ? err.message : String(err) });
        },
      );
    }, 180);

    return () => {
      window.clearTimeout(timer);
      coachQueryRef.current?.cancel();
      coachQueryRef.current = null;
    };
  }, [db, isMyDecision, pd, props.decks, props.deckMeta, replayMode, state, search]);

  useEffect(() => () => {
    aiQueryRef.current?.cancel();
    coachQueryRef.current?.cancel();
    if (aiPaceTimerRef.current !== null) window.clearTimeout(aiPaceTimerRef.current);
  }, []);

  // 遊戲結束時自動重置 toolMode 並彈出戰報 Modal，並自動儲存對戰紀錄
  useEffect(() => {
    if (state.phase !== "gameOver" || pendingSetFeedback) return;
    setToolMode({ type: "detail" });
    setShowPostMatchModal(true);

    if (!props.loadedReplay && !savedReplayRef.current) {
      savedReplayRef.current = true;
      fetch("/api/replays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(replay),
      })
        .then((res) => {
          if (!res.ok) throw new Error("儲存對戰失敗");
          return res.json();
        })
        .then((data) => {
          console.log("對戰紀錄已儲存:", data.file);
        })
        .catch((err) => {
          console.error("自動儲存對戰紀錄錯誤:", err);
        });
    }
  }, [state.phase, replay, props.loadedReplay, pendingSetFeedback]);

  useEffect(() => {
    const newEntries = state.log.slice(seenLogCount.current);
    seenLogCount.current = state.log.length;
    const events = newEntries.map((entry) => entry.event).filter((event) => event !== undefined);
    const result = [...events].reverse().find((event) => event.kind === "set-won" || event.kind === "match-won");
    const attack = [...events].reverse().find((event) => event.kind === "attack-op");

    if (!result && !attack) return;

    if (result) {
      const youWon = result.winner === HUMAN;
      setScoreBanner({
        kind: result.kind === "match-won" ? "match" : "set",
        text: result.kind === "match-won"
          ? youWon ? "MATCH WIN!" : "MATCH LOST"
          : youWon ? "SET GET!" : "SET LOST",
      });
      if (sfxEnabled) {
        const pool = youWon ? SFX_SCORE_YOU : SFX_SCORE_OPP;
        setSfx({ text: pool[Math.floor(Math.random() * pool.length)]!, key: Date.now() });
      }
    } else if (attack && sfxEnabled) {
      const pool = attack.player === HUMAN ? SFX_ATTACK_YOU : SFX_ATTACK_OPP;
      setSfx({ text: pool[Math.floor(Math.random() * pool.length)]!, key: Date.now() });
    }

    const timer = window.setTimeout(() => {
      setScoreBanner(null);
      setSfx(null);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [state.log, sfxEnabled]);

  // 先完整播放 2D 的 Set 得分演出，再開放原始意圖回饋；等待期間 AI 與玩家操作皆已鎖住。
  useEffect(() => {
    if (!pendingSetFeedback || replayMode) {
      setFeedbackReadyAnchor(null);
      return;
    }
    setFeedbackReadyAnchor(null);
    const anchor = pendingSetFeedback.anchorEntryIndex;
    const timer = window.setTimeout(() => setFeedbackReadyAnchor(anchor), 950);
    return () => window.clearTimeout(timer);
  }, [pendingSetFeedback, replayMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, button");
      if (event.key === "Escape") {
        setMultiSel([]);
        setNameAsk(null);
        setActiveGutsKey(null);
        setDragging(null);
        setMobilePanel(null);
        if (toolMode.type === "drop") setToolMode({ type: "detail" });
        return;
      }
      if (event.code !== "Space" || typing || !isMyDecision) return;
      const primary = decisionRef.current?.querySelector<HTMLButtonElement>('button[data-primary="true"]:not(:disabled)');
      if (!primary) return;
      event.preventDefault();
      primary.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMyDecision, toolMode.type]);

  useLayoutEffect(() => {
    const el = handRef.current;
    if (!el) return;
    const update = () => setHandWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // [Claude 2026-07-03] Readability V2：固定畫布已廢除；只剩手牌卡寬跟著視窗高走。
  useLayoutEffect(() => {
    const update = () => setHandCard(handCardFor(window.innerHeight));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  function toggleSelection(uid: number, max: number) {
    setMultiSel((selected) => selected.includes(uid)
      ? selected.filter((item) => item !== uid)
      : selected.length < max ? [...selected, uid] : selected);
  }

  function dropAreaAt(clientX: number, clientY: number): CourtArea | null {
    const el = document.elementFromPoint(clientX, clientY);
    const area = el instanceof HTMLElement ? el.closest<HTMLElement>("[data-drop-area]")?.dataset.dropArea : undefined;
    return area === "serve" || area === "block" || area === "receive" || area === "toss" || area === "attack" ? area : null;
  }

  function dragStateFrom(info: CardPointerDragInfo, uid: number): DragState {
    const overArea = dropAreaAt(info.clientX, info.clientY);
    const valid = !!overArea && overArea === deployArea && deployable.includes(uid);
    return { uid, x: info.clientX, y: info.clientY, width: info.rect.width, overArea, valid };
  }

  function startHandDrag(uid: number, info: CardPointerDragInfo) {
    if (!deployArea || !deployable.includes(uid)) return;
    setDragging(dragStateFrom(info, uid));
  }

  function moveHandDrag(uid: number, info: CardPointerDragInfo) {
    setDragging((current) => current?.uid === uid ? dragStateFrom(info, uid) : current);
  }

  function finishHandDrag(uid: number, info: CardPointerDragInfo) {
    const next = dragStateFrom(info, uid);
    setDragging(null);
    if (next.valid && next.overArea) onDropCard(uid, next.overArea);
  }

  function onHandClick(uid: number) {
    if (replayMode || !isMyDecision || !pd) {
      inspectUid(uid);
      return;
    }
    if (pd.type === "mulligan") {
      setMultiSel((selected) => selected.includes(uid) ? selected.filter((item) => item !== uid) : [...selected, uid]);
      return;
    }
    if (pd.type === "deploy-block") {
      if (!deployable.includes(uid)) return;
      toggleSelection(uid, 3);
      return;
    }
    if (pd.type === "effect-cards") {
      if (!effectCardsInPlace || !effectCandidates.includes(uid)) { inspectUid(uid); return; }
      toggleSelection(uid, effectMax);
      return;
    }
    if (!deployArea || !deployable.includes(uid)) {
      inspectUid(uid);
      return;
    }
    const names = deployNames(db, state, uid);
    if (names) setNameAsk({ uid, names });
    else decide({ type: pd.type, uid } as Decision);
  }

  function confirmBlockDeploy() {
    const choices: Record<number, string> = {};
    const used = new Set<string>();
    for (const uid of multiSel) {
      const names = deployNames(db, state, uid);
      const name = names
        ? names.find((candidate) => !used.has(candidate) && canDeployTo(db, state, HUMAN, uid, "block", candidate)) ?? names[0]!
        : cardOf(uid).nameJa;
      if (names) choices[uid] = name;
      used.add(name);
    }
    decide({ type: "deploy-block", uids: multiSel, center: multiSel[0]!, nameChoices: choices });
  }

  function onDropCard(uid: number, area: CourtArea) {
    if (area !== deployArea || !deployable.includes(uid)) return;
    onHandClick(uid);
  }

  function bar(hint: string, buttons: React.ReactNode) {
    return <div className="decision-bar"><span className="decision-hint">{hint}</span><div className="decision-actions">{buttons}</div></div>;
  }

  function DecisionBar() {
    if (replayMode) {
      return bar(`賽後覆盤 ${replayStep}/${replay.entries.length}${replayEntry ? `・${actorLabel(replayEntry)}：${describeDecisionShort(replayEntry.decision)}` : "・開局"}`, <>
        <button disabled={replayStep <= 0} onClick={() => setReplayStep((step) => Math.max(0, step - 1))}>上一步</button>
        <button data-primary="true" disabled={replayStep >= replay.entries.length} onClick={() => setReplayStep((step) => Math.min(replay.entries.length, step + 1))}>下一步</button>
        <button className="btn-secondary" onClick={() => setShowPostMatchModal(true)}>查看戰報</button>
        {props.loadedReplay ? (
          <button className="btn-secondary" onClick={props.onExit}>回主選單</button>
        ) : (
          <button className="btn-secondary" onClick={exitReplayMode}>回到結算</button>
        )}
      </>);
    }
    if (state.phase === "gameOver") {
      return bar(state.winner === HUMAN ? "你贏得了這場對戰" : "電腦贏得了這場對戰", <>
        <button data-primary="true" onClick={() => setShowPostMatchModal(true)}>進入賽後覆盤</button>
        <button className="btn-secondary" onClick={props.onExit}>回主選單</button>
      </>);
    }
    if (!pd) return <div className="decision-bar decision-idle"><span>規則引擎正在推進對局</span></div>;
    if (!isMyDecision) {
      const thinkingLabel = aiThinking
        ? `強敵推演中…（最多想 ${(aiThinking.budgetMs / 1000).toFixed(1)} 秒）`
        : "電腦思考中";
      return (
        <div className={`decision-bar decision-idle${aiThinking ? " decision-thinking" : ""}`}>
          <span>{aiThinking && <span className="thinking-dots" aria-hidden="true" />}{thinkingLabel}</span>
          <small>{PHASE_NAME[state.phase]}</small>
        </div>
      );
    }

    switch (pd.type) {
      case "serve-rights":
        return bar("你被選中：要擁有首次發球權嗎？", <>
          <button data-primary="true" onClick={() => decide({ type: "serve-rights", take: true })}>擁有發球權</button>
          <button className="btn-secondary" onClick={() => decide({ type: "serve-rights", take: false })}>讓給對方</button>
        </>);
      case "mulligan":
        return bar(`換牌：點選要放回牌組的卡（已選 ${multiSel.length} 張）`, (
          <button data-primary="true" onClick={() => decide({ type: "mulligan", returnUids: multiSel })}>{multiSel.length ? `換 ${multiSel.length} 張` : "不換牌"}</button>
        ));
      case "defense-choice": {
        const blockAllowed = canChooseBlock(state);
        return bar(`對方 OP ${state.op?.value ?? "?"}：選擇防守方式`, <>
          <button disabled={!blockAllowed} title={blockAllowed ? "" : "發球或攔網回球不能選擇攔網"} onClick={() => decide({ type: "defense-choice", choice: "block" })}>攔網</button>
          <button data-primary="true" onClick={() => decide({ type: "defense-choice", choice: "receive" })}>接球</button>
        </>);
      }
      case "free":
        return bar("自由步驟：可發動技能或結束目前階段", <>
          {free.skills.map((option) => (
            <button key={`s${option.uid}-${option.skillIndex}`} className="btn-skill" onClick={() => decide({ type: "free", action: "skill", uid: option.uid, skillIndex: option.skillIndex })}>{option.label}</button>
          ))}
          {free.events.map((option) => (
            <button key={`e${option.uid}`} className="btn-skill" onClick={() => decide({ type: "free", action: "event", uid: option.uid })}>{option.label}</button>
          ))}
          <button data-primary="true" onClick={() => decide({ type: "free", action: "pass" })}>結束（Pass）</button>
          <button className="btn-danger" onClick={() => decide({ type: "free", action: "lost" })}>宣告 Lost</button>
        </>);
      case "resolve-pending":
        return bar(pd.prompt ?? "選擇先解決的待機技能", pd.candidates?.map((id, index) => {
          const item = state.pendingQueue.find((candidate) => candidate.id === id);
          return <button key={id} data-primary={index === 0 ? "true" : undefined} onClick={() => decide({ type: "resolve-pending", id })}>{item?.desc ?? `技能 ${id}`}</button>;
        }));
      case "effect-confirm":
        return bar(pd.prompt ?? "要使用技能嗎？", <>
          <button data-primary="true" onClick={() => decide({ type: "effect-confirm", accept: true })}>使用</button>
          <button className="btn-secondary" onClick={() => decide({ type: "effect-confirm", accept: false })}>不使用</button>
        </>);
      case "effect-option":
        return bar(pd.prompt ?? "選擇效果", pd.options?.map((option, index) => (
          <button key={option} data-primary={index === 0 ? "true" : undefined} onClick={() => decide({ type: "effect-option", index })}>{option}</button>
        )));
      case "effect-cards": {
        const min = pd.min ?? 0;
        const max = pd.max ?? 1;
        if (effectCardsInPlace) {
          return bar(`${pd.prompt}：點選場上或手牌候選 ${min === max ? min : `${min}～${max}`} 張（已選 ${multiSel.length}）`, (
            <button data-primary="true" disabled={multiSel.length < min || multiSel.length > max} onClick={() => decide({ type: "effect-cards", uids: multiSel })}>確定</button>
          ));
        }
        // 依來源區域把候選卡分組，每組一個有標題的容器，避免跨區挑卡時丟錯
        const candidates = pd.candidates ?? [];
        const groups = groupCandidatesByZone(state, candidates);
        const multiZone = groups.length > 1;
        const renderCard = (uid: number) => (
          <CardView
            key={uid}
            card={cardOf(uid)}
            uid={uid}
            width={Math.max(64, handCard - 26)}
            selected={multiSel.includes(uid)}
            onHover={(card) => setHoverUid(card ? uid : null)}
            onLongPress={() => inspectUid(uid)}
            onClick={() => toggleSelection(uid, max)}
          />
        );
        return (
          <div className="decision-bar decision-card-picker">
            <span className="decision-hint">{pd.prompt}（選 {min === max ? min : `${min}～${max}`} 張）</span>
            {multiZone ? (
              <div className="effect-cards-zones">
                {groups.map((g) => (
                  <div key={g.key} className="effect-cards-zone">
                    <span className="effect-cards-zone-label">
                      {g.owner !== HUMAN ? "對手・" : ""}{ZONE_LABEL[g.zone] ?? g.zone}
                      <em>{g.uids.length}</em>
                    </span>
                    <div className="effect-cards-row">{g.uids.map(renderCard)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="effect-cards-row">{candidates.map(renderCard)}</div>
            )}
            <div className="decision-actions">
              <button data-primary="true" disabled={multiSel.length < min || multiSel.length > max} onClick={() => decide({ type: "effect-cards", uids: multiSel })}>確定</button>
            </div>
          </div>
        );
      }
      case "deploy-block":
        return bar(`攔網登場：選 1～3 張；第 1 張為中央攔網者（已選 ${multiSel.length}）`, <>
          <button data-primary="true" disabled={multiSel.length === 0} onClick={confirmBlockDeploy}>確定登場</button>
          <button className="btn-secondary" onClick={() => setMultiSel([])}>清除選擇</button>
          <button className="btn-danger" onClick={() => decide({ type: "deploy-block", uids: null })}>不登場（Lost）</button>
        </>);
      case "deploy-serve":
      case "deploy-receive":
      case "deploy-toss":
      case "deploy-attack": {
        const area = DEPLOY_AREA[pd.type] as Exclude<CourtArea, "block">;
        if (nameAsk) {
          return bar(`${cardOf(nameAsk.uid).nameJa}：選擇登場時的卡名`, <>
            {nameAsk.names.map((name, index) => (
              <button
                key={name}
                data-primary={index === 0 ? "true" : undefined}
                disabled={!canDeployTo(db, state, HUMAN, nameAsk.uid, area, name)}
                onClick={() => decide({ type: pd.type, uid: nameAsk.uid, nameChoice: name } as Decision)}
              >
                {name}
              </button>
            ))}
            <button className="btn-secondary" onClick={() => setNameAsk(null)}>取消</button>
          </>);
        }
        return bar(`${DEPLOY_LABEL[area]}登場：點選手牌，桌面也可拖到場區`, (
          <button className="btn-danger" onClick={() => decide({ type: pd.type, uid: null } as Decision)}>不登場（Lost）</button>
        ));
      }
      case "pick-set-card":
        return bar("你輸掉這個 Set：點選球場左下的一張 Set 卡加入手牌", null);
    }
  }

  // 手牌間距：「分開為主，擁擠才靠近」——夠放就留正向間隔，放不下才漸進收攏成重疊
  const HAND_CARD = handCard;
  const HAND_GAP = 14;
  const HAND_MIN_VISIBLE = 40;
  const handCount = viewState.players[HUMAN].hand.length;
  let handStep = HAND_GAP;
  if (handCount > 1 && handWidth > 0) {
    const needed = handCount * HAND_CARD + (handCount - 1) * HAND_GAP;
    if (needed > handWidth) {
      handStep = Math.max(-(HAND_CARD - HAND_MIN_VISIBLE), (handWidth - HAND_CARD) / (handCount - 1) - HAND_CARD);
    }
  }
  const handStyle = { "--hand-step": `${handStep}px` } as CSSProperties;
  const showSetFeedback = !!pendingSetFeedback
    && feedbackReadyAnchor === pendingSetFeedback.anchorEntryIndex
    && scoreBanner === null;

  return (
    <div className="fit-shell">
    <svg className="ink-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id="ink-rough" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="7" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
    <div className="game" style={{ "--hand-card": `${handCard}px` } as CSSProperties}>
      <main className="center-panel">
        <GameBoard
          db={db}
          state={viewState}
          deckMeta={props.deckMeta}
          revealOpponentHand={replayMode}
          canPickSet={!replayMode && isMyDecision && pd?.type === "pick-set-card"}
          deployArea={replayMode ? null : deployArea}
          activeGutsKey={activeGutsKey}
          recentUids={replayMode ? new Set() : recentUids}
          settledUids={replayMode ? new Set() : settledUids}
          candidateUids={!replayMode && isMyDecision && effectCardsInPlace ? effectCandidates : []}
          selectableUids={!replayMode && isMyDecision && effectCardsInPlace ? effectCandidates : []}
          selectedUids={!replayMode && effectCardsInPlace ? multiSel : []}
          hoveredUid={hovered?.uid ?? null}
          dragOverArea={!replayMode && dragging?.valid ? dragging.overArea : null}
          onPickSet={(index) => decide({ type: "pick-set-card", index })}
          onOpenDrop={(player) => {
            setToolMode({ type: "drop", player });
            setMobilePanel("detail");
          }}
          onOpenEvent={(player) => {
            setToolMode({ type: "event", player });
            setMobilePanel("detail");
          }}
          onToggleGuts={setActiveGutsKey}
          onDropCard={onDropCard}
          onSelectUid={(uid) => toggleSelection(uid, effectMax)}
          onHover={setHoverUid}
          onInspect={inspectUid}
        />

        <div ref={decisionRef}><DecisionBar /></div>

        <section className="hand-section" aria-label={`你的手牌 ${viewState.players[HUMAN].hand.length} 張`}>
          <div className="hand-heading"><span>{replayMode ? "覆盤手牌" : "你的手牌"}</span><strong>{viewState.players[HUMAN].hand.length}</strong></div>
          {!replayMode && (
            <button className="btn-quiet undo-button hand-undo" disabled={!canUndo} title="回到上一個我方決策前" onClick={undoLastDecision}>返回上一步</button>
          )}
          <div className="hand" style={handStyle} data-zone-anchor="p0-hand" ref={handRef}>
            {viewState.players[HUMAN].hand.length === 0 && <span className="hand-empty">沒有手牌</span>}
            {viewState.players[HUMAN].hand.map((uid) => {
              const selectedIndex = multiSel.indexOf(uid);
              const canDrag = !replayMode && !!deployArea && deployable.includes(uid);
              return (
                <CardView
                  key={uid}
                  card={cardOf(uid)}
                  uid={uid}
                  width={HAND_CARD}
                  className={[recentUids.has(uid) ? "card-entering" : "", settledUids.has(uid) ? "card-settle" : ""].filter(Boolean).join(" ") || undefined}
                  selected={selectedIndex >= 0}
                  selectable={effectCardsInPlace && effectCandidates.includes(uid)}
                  candidate={effectCardsInPlace && effectCandidates.includes(uid)}
                  candidateHovered={effectCardsInPlace && effectCandidates.includes(uid) && hovered?.uid === uid}
                  dimmed={!replayMode && ((!!deployArea && !deployable.includes(uid)) || (effectCardsInPlace && !effectCandidates.includes(uid)))}
                  badge={pd?.type === "deploy-block" && selectedIndex === 0 ? "中央" : selectedIndex > 0 ? String(selectedIndex + 1) : effectCardsInPlace && selectedIndex === 0 ? "1" : undefined}
                  secondaryBadge={cardOf(uid).effectStatus === "todo" ? "未實作" : undefined}
                  draggable={canDrag}
                  onPointerDragStart={canDrag ? (info) => startHandDrag(uid, info) : undefined}
                  onPointerDragMove={canDrag ? (info) => moveHandDrag(uid, info) : undefined}
                  onPointerDragEnd={canDrag ? (info) => finishHandDrag(uid, info) : undefined}
                  onPointerDragCancel={canDrag ? () => setDragging(null) : undefined}
                  onHover={(card) => setHoverUid(card ? uid : null)}
                  onLongPress={() => inspectUid(uid)}
                  onClick={() => onHandClick(uid)}
                />
              );
            })}
          </div>
        </section>
      </main>

      <aside className={`right-panel${mobilePanel === "detail" ? " is-mobile-open" : ""}`}>
        <div className="mobile-panel-heading">
          <b>面板</b>
          <button className="btn-quiet" onClick={() => setMobilePanel(null)}>關閉</button>
        </div>
        <SideMeta state={viewState} deckMeta={props.deckMeta} />
        <div className="info-upper">
          <div className="tool-tabs" role="tablist" aria-label="右欄工具">
            <button role="tab" aria-selected={toolMode.type === "detail"} className={toolMode.type === "detail" ? "is-active" : ""} onClick={() => setToolMode({ type: "detail" })}>詳情</button>
            <button role="tab" aria-selected={toolMode.type === "coach"} className={toolMode.type === "coach" ? "is-active" : ""} onClick={() => setToolMode({ type: "coach" })}>教練</button>
            <button role="tab" aria-selected={toolMode.type === "counter"} className={toolMode.type === "counter" ? "is-active" : ""} onClick={() => setToolMode({ type: "counter" })}>算牌</button>
            <button role="tab" aria-selected={toolMode.type === "drop"} className={toolMode.type === "drop" ? "is-active" : ""} onClick={() => setToolMode({ type: "drop", player: HUMAN })}>棄牌</button>
            <button role="tab" aria-selected={toolMode.type === "settings"} className={toolMode.type === "settings" ? "is-active" : ""} onClick={() => setToolMode({ type: "settings" })}>設定</button>
          </div>
          <div className="tool-content">
            {replayMode ? (
              visibleInspection ? (
                <CardDetails db={db} state={viewState} inspected={visibleInspection} />
              ) : (
                <ReplayStepSummary
                  state={viewState}
                  entry={replayEntry}
                  step={replayStep}
                  total={replay.entries.length}
                  analytics={replayAnalytics}
                  keyEntries={replayKeyEntries}
                  onJump={setReplayStep}
                />
              )
            ) : toolMode.type === "drop" || toolMode.type === "event" ? (
              <DropBrowser
                db={db}
                state={state}
                player={toolMode.player}
                source={toolMode.type === "event" ? "event" : "drop"}
                onClose={() => setToolMode({ type: "detail" })}
                onSelect={(uid) => {
                  inspectUid(uid);
                  setToolMode({ type: "detail" });
                }}
                onHover={setHoverUid}
              />
            ) : toolMode.type === "coach" ? (
              <CoachPanel db={db} state={state} coach={coach} onApply={decide} />
            ) : toolMode.type === "counter" ? (
              <CardCounter db={db} state={state} />
            ) : toolMode.type === "settings" ? (
              <SettingsPanel
                engine={engine}
                sfxEnabled={sfxEnabled}
                onEngineChange={changeEngine}
                onToggleSfx={toggleSfx}
                onExit={props.onExit}
              />
            ) : state.phase === "gameOver" && !visibleInspection ? (
              <PostMatchReport db={db} replay={replay} onReplay={enterReplayMode} />
            ) : visibleInspection ? (
              <CardDetails db={db} state={state} inspected={visibleInspection} />
            ) : (
              <MatchSummary state={state} replayEntries={replay.entries.length} />
            )}
          </div>
        </div>
        <section className="info-log" aria-label="對戰紀錄">
          <div className="info-log-heading">
            <b>對戰紀錄</b>
          </div>
          <GameLog state={viewState} />
        </section>
      </aside>

      <aside className={`mobile-log-panel${mobilePanel === "log" ? " is-open" : ""}`}>
        <div className="mobile-panel-heading"><b>對戰紀錄</b><button className="btn-quiet" onClick={() => setMobilePanel(null)}>關閉</button></div>
        <GameLog state={viewState} />
      </aside>

      {mobilePanel && <button className="panel-backdrop" aria-label="關閉面板" onClick={() => setMobilePanel(null)} />}
    </div>

    {scoreBanner && <div className="focus-lines" aria-hidden="true" />}
    {sfx && <div key={sfx.key} className="sfx-burst" aria-hidden="true">{sfx.text}</div>}
    {scoreBanner && <div className={`score-banner score-banner-${scoreBanner.kind}`} role="status">{scoreBanner.text}</div>}
    {showSetFeedback && pendingSetFeedback && (
      <SetFeedbackDialog
        result={pendingSetFeedback}
        onSubmit={(tag, note) => recordSetFeedback(tag, note)}
        onSkip={() => recordSetFeedback("skipped")}
      />
    )}
    {showPostMatchModal && (
      <PostMatchModal
        db={db}
        replay={replay}
        winner={state.winner ?? null}
        replayMode={replayMode}
        opponentHand={state.players[AI].hand.map((uid) => ({ uid, card: db.get(state.cards[uid]!)! }))}
        onReplay={enterReplayMode}
        onClose={() => setShowPostMatchModal(false)}
        onRematch={props.onRematch}
        onExit={props.onExit}
      />
    )}
    {!replayMode && dragging && (
      <div
        className={`drag-ghost-wrap${dragging.valid ? " is-valid" : ""}`}
        style={{ left: dragging.x, top: dragging.y, width: dragging.width } as CSSProperties}
        aria-hidden="true"
      >
        <CardView card={cardOf(dragging.uid)} width={dragging.width} className="drag-ghost" />
      </div>
    )}
    <MotionLayer motions={motions} deckMeta={props.deckMeta} />

    <div className="rotate-overlay" role="alertdialog" aria-label="請將裝置轉為橫向">
      <div className="rotate-card">
        <div className="rotate-icon" aria-hidden="true" />
        <b>請將裝置轉為橫向</b>
        <span>對戰桌墊為橫式版面</span>
      </div>
    </div>
    </div>
  );
}
