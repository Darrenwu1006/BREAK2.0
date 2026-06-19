import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Card } from "../data/types";
import type { CourtArea } from "../engine/dsl";
import { applyDecision, canChooseBlock, createGame, deployableUids, freeOptions } from "../engine/engine";
import { canDeployTo, deployNames } from "../engine/effects";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { heuristicAiDecision } from "../ai/heuristic";
import type { CoachWorkerResponse } from "../ai/coach-worker";
import type { CoachActionEstimate, CoachReport } from "../ai/coach";
import { CardView } from "./CardView";
import { GameBoard } from "./GameBoard";
import { CardCounter, CardDetails, CoachPanel, CompactHud, DropBrowser, GameLog, LeftPanel, MatchSummary, PHASE_NAME } from "./GamePanels";
import type { CoachPanelState } from "./GamePanels";
import type { AiSpeed, DeckMeta, InspectedCard } from "./gameTypes";
import { MotionLayer, useGameMotion } from "./useGameMotion";
import { canUseInPlaceEffectSelection } from "./selection";
import { popUndoSnapshot, pushPlayerUndoSnapshot, type UndoHistory, UNDO_HISTORY_LIMIT } from "./undoHistory";
import { appendReplayEntry, createReplaySession, keyReplayEntries, stateAtReplayStep, summarizeReplaySession, truncateReplaySession, type ReplayAnalytics, type ReplayEntry, type ReplaySession } from "./replayHistory";
import type { CardPointerDragInfo } from "./CardView";

const HUMAN: PlayerId = 0;
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

type ToolMode = { type: "detail" } | { type: "coach" } | { type: "counter" } | { type: "drop"; player: PlayerId } | { type: "event"; player: PlayerId };
type DragState = { uid: number; x: number; y: number; width: number; overArea: CourtArea | null; valid: boolean };

function initialSpeed(): AiSpeed {
  const stored = localStorage.getItem("breaktcg-ai-speed");
  return stored === "0.5" || stored === "1" || stored === "2" || stored === "instant" ? stored : "1";
}

function initialSfx(): boolean {
  return localStorage.getItem("breaktcg-sfx") !== "off";
}

const SFX_SCORE_YOU = ["決まった！", "キメた！", "ナイスキル！"];
const SFX_SCORE_OPP = ["やられた…", "とられた！"];
const SFX_ATTACK_YOU = ["ドン！", "バンッ！", "ズバン！"];
const SFX_ATTACK_OPP = ["ドッ！", "ズバッ！"];

type SplashBanner = { text: string; kind: "set" | "match" };
type GameRuntime = { state: GameState; replay: ReplaySession };
type ReplayCritiqueState =
  | { status: "idle" }
  | { status: "loading"; step: number }
  | { status: "ready"; step: number; report: CoachReport }
  | { status: "error"; step: number; error: string };
type ReplayCritiqueResult =
  | { status: "ready"; report: CoachReport }
  | { status: "error"; error: string };
type ReplayCritiqueCache = Record<number, ReplayCritiqueResult>;
type ReplayScanState =
  | { status: "idle" }
  | { status: "running"; currentStep: number; done: number; total: number }
  | { status: "done"; total: number }
  | { status: "stopped"; done: number; total: number };

function decisionLabel(decision: Decision): string {
  switch (decision.type) {
    case "serve-rights": return decision.take ? "取得發球權" : "讓出發球權";
    case "mulligan": return decision.returnUids.length ? `換牌 ${decision.returnUids.length} 張` : "不換牌";
    case "deploy-serve": return decision.uid === null ? "不登場發球" : "發球登場";
    case "deploy-receive": return decision.uid === null ? "不登場接球" : "接球登場";
    case "deploy-toss": return decision.uid === null ? "不登場托球" : "托球登場";
    case "deploy-attack": return decision.uid === null ? "不登場攻擊" : "攻擊登場";
    case "deploy-block": return decision.uids === null ? "不登場攔網" : `攔網登場 ${decision.uids.length} 張`;
    case "defense-choice": return decision.choice === "block" ? "選擇攔網" : "選擇接球";
    case "free": return decision.action === "pass" ? "Pass" : decision.action === "lost" ? "宣告 Lost" : decision.action === "skill" ? "使用技能" : "打出事件";
    case "resolve-pending": return "選擇待機技能";
    case "effect-confirm": return decision.accept ? "使用效果" : "不使用效果";
    case "effect-cards": return `選卡 ${decision.uids.length} 張`;
    case "effect-option": return "選擇效果選項";
    case "pick-set-card": return "拿取 Set 卡";
  }
}

function actorLabel(entry: ReplayEntry): string {
  return entry.source === "ai" ? "電腦" : entry.player === HUMAN ? "你" : "玩家";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function sameDecision(a: Decision, b: Decision): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function findActualEstimate(report: CoachReport, decision: Decision): CoachActionEstimate | null {
  return report.recommendations.find((item) => sameDecision(item.decision, decision)) ?? null;
}

function critiqueTone(delta: number, actual: CoachActionEstimate | null): { label: string; className: string } {
  if (!actual) return { label: "未覆蓋", className: "is-neutral" };
  if (delta >= 0.15) return { label: "失誤", className: "is-warning" };
  if (delta <= -0.03) return { label: "妙手", className: "is-good" };
  return { label: "可接受", className: "is-neutral" };
}

function critiqueToneForEntry(entry: ReplayEntry, result: ReplayCritiqueResult | undefined): { label: string; className: string } | null {
  if (!result) return null;
  if (result.status === "error") return { label: "錯誤", className: "is-neutral" };
  const actual = findActualEstimate(result.report, entry.decision);
  const delta = actual ? result.report.bestAction.winRate - actual.winRate : 0;
  return critiqueTone(delta, actual);
}

function ReplayStepSummary(props: {
  state: GameState;
  entry: ReplayEntry | null;
  step: number;
  total: number;
  analytics: ReplayAnalytics;
  keyEntries: ReplayEntry[];
  critique: ReplayCritiqueState;
  critiqueCache: ReplayCritiqueCache;
  scan: ReplayScanState;
  onEvaluate: () => void;
  onScan: () => void;
  onStopScan: () => void;
  onJump: (step: number) => void;
}) {
  const { state, entry, step, total, analytics, keyEntries, critique, critiqueCache, scan } = props;
  const newLogs = entry ? entry.after.log.slice(entry.logStart, entry.logEnd) : [];
  const report = critique.status === "ready" && critique.step === step ? critique.report : null;
  const error = critique.status === "error" && critique.step === step ? critique.error : null;
  const loading = critique.status === "loading" && critique.step === step;
  const actual = report && entry ? findActualEstimate(report, entry.decision) : null;
  const delta = report && actual ? report.bestAction.winRate - actual.winRate : 0;
  const tone = report ? critiqueTone(delta, actual) : null;
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
            <b>{decisionLabel(entry.decision)}</b>
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
            {scan.status === "running" ? (
              <button className="btn-quiet" onClick={props.onStopScan}>停止掃描</button>
            ) : (
              <button className="btn-quiet" disabled={keyEntries.every((item) => item.source !== "player")} onClick={props.onScan}>掃描玩家決策</button>
            )}
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
          {scan.status === "running" && (
            <small className="summary-idle">正在評估 Step {scan.currentStep}（{scan.done}/{scan.total}）</small>
          )}
          {scan.status === "done" && <small className="summary-idle">已完成 {scan.total} 個玩家決策掃描。</small>}
          {scan.status === "stopped" && <small className="summary-idle">已停止掃描（{scan.done}/{scan.total}）。</small>}
          <div className="replay-step-list">
            {keyEntries.length === 0 ? (
              <small className="summary-idle">目前沒有關鍵步驟。</small>
            ) : keyEntries.map((item) => {
              const itemStep = item.index + 1;
              const cachedTone = critiqueToneForEntry(item, critiqueCache[itemStep]);
              const scanning = scan.status === "running" && scan.currentStep === itemStep;
              return (
                <button
                  key={item.index}
                  className={`replay-step-button${itemStep === step ? " is-active" : ""}`}
                  onClick={() => props.onJump(itemStep)}
                >
                  <span>#{itemStep}</span>
                  <b>{actorLabel(item)}・{decisionLabel(item.decision)}</b>
                  <small>{PHASE_NAME[item.phase]}・Set {item.setNo} Turn {item.turnNo}</small>
                  {(cachedTone || scanning) && (
                    <em className={`replay-step-badge ${cachedTone?.className ?? "is-neutral"}`}>
                      {scanning ? "評估中" : cachedTone?.label}
                    </em>
                  )}
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
        <div className="replay-critique">
          <div className="replay-critique-heading">
            <b>出牌檢討</b>
            <button className="btn-quiet" disabled={!entry || loading} onClick={props.onEvaluate}>
              {loading ? "評估中" : "評估此步"}
            </button>
          </div>
          {!entry ? (
            <small className="summary-idle">開局狀態沒有實際決策可評估。</small>
          ) : error ? (
            <p className="coach-error">{error}</p>
          ) : report ? (
            <div className="critique-result">
              <span className={`critique-badge ${tone?.className ?? ""}`}>{tone?.label}</span>
              <div className="critique-row">
                <small>最佳建議</small>
                <b>{report.bestAction.label}</b>
                <span>{percent(report.bestAction.winRate)} 勝率・信心 {percent(report.bestAction.confidence)}</span>
              </div>
              <div className="critique-row">
                <small>實際選擇</small>
                <b>{actual?.label ?? decisionLabel(entry.decision)}</b>
                <span>{actual ? `${percent(actual.winRate)} 勝率・差距 ${percent(Math.max(0, delta))}` : "此決策不在本次候選評估內"}</span>
              </div>
              <p>{actual ? (delta >= 0.15 ? "這一步可能有更高期望值的選擇，值得回看當時資源與後續防守壓力。" : "這一步和 Coach 推薦差距不大，可先視為合理路線。") : "Coach v1 的候選列舉沒有覆蓋這個實際決策；後續需擴充候選生成再評分。"}</p>
            </div>
          ) : (
            <small className="summary-idle">按下評估後，會用 Coach / PIMC 從此步決策前狀態估算推薦選擇。</small>
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
  onExit: () => void;
}) {
  const { db } = props;
  const initialGameRef = useRef<GameRuntime | null>(null);
  if (!initialGameRef.current) {
    const seed = (Date.now() % 0xffffffff) >>> 0;
    const initialState = createGame(db, { seed, decks: props.decks });
    initialGameRef.current = {
      state: initialState,
      replay: createReplaySession(initialState, props.decks, props.deckMeta, undefined, seed),
    };
  }
  const [game, setGame] = useState<GameRuntime>(() => initialGameRef.current!);
  const state = game.state;
  const replay = game.replay;
  const [hovered, setHovered] = useState<InspectedCard | null>(null);
  const [inspected, setInspected] = useState<InspectedCard | null>(null);
  const [multiSel, setMultiSel] = useState<number[]>([]);
  const [nameAsk, setNameAsk] = useState<{ uid: number; names: string[] } | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>({ type: "detail" });
  const [coach, setCoach] = useState<CoachPanelState>({ status: "idle" });
  const [mobilePanel, setMobilePanel] = useState<"log" | "detail" | null>(null);
  const [activeGutsKey, setActiveGutsKey] = useState<string | null>(null);
  const [speed, setSpeed] = useState<AiSpeed>(initialSpeed);
  const [scoreBanner, setScoreBanner] = useState<SplashBanner | null>(null);
  const [sfxEnabled, setSfxEnabled] = useState<boolean>(initialSfx);
  const [sfx, setSfx] = useState<{ text: string; key: number } | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [undoHistory, setUndoHistory] = useState<UndoHistory>([]);
  const [undoReplayLengths, setUndoReplayLengths] = useState<number[]>([]);
  const [replayMode, setReplayMode] = useState(false);
  const [replayStep, setReplayStep] = useState(0);
  const decisionRef = useRef<HTMLDivElement>(null);
  const handRef = useRef<HTMLDivElement>(null);
  const coachRequestRef = useRef(0);
  const coachWorkerRef = useRef<Worker | null>(null);
  const replayCoachRequestRef = useRef(0);
  const replayScanTokenRef = useRef(0);
  const replayCoachWorkerRef = useRef<Worker | null>(null);
  const replayCoachRejectRef = useRef<((error: Error) => void) | null>(null);
  const replayCritiquesRef = useRef<ReplayCritiqueCache>({});
  const [handWidth, setHandWidth] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const [replayCritique, setReplayCritique] = useState<ReplayCritiqueState>({ status: "idle" });
  const [replayCritiques, setReplayCritiques] = useState<ReplayCritiqueCache>({});
  const [replayScan, setReplayScan] = useState<ReplayScanState>({ status: "idle" });
  const seenLogCount = useRef(state.log.length);

  const pd = state.pendingDecision;
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
  const { motions, recentUids, settledUids } = useGameMotion({ state: viewState, db, deckMeta: props.deckMeta, disabled: speed === "instant" || replayMode });

  const visibleInspection = hovered ?? inspected;
  const canUndo = !replayMode && undoHistory.length > 0;

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
    clearTransientUi();
    setUndoHistory((history) => pushPlayerUndoSnapshot(history, state, HUMAN));
    setUndoReplayLengths((lengths) => {
      const next = [...lengths, replay.entries.length];
      return next.length > UNDO_HISTORY_LIMIT ? next.slice(next.length - UNDO_HISTORY_LIMIT) : next;
    });
    setGame((current) => {
      const nextState = applyDecision(db, current.state, decision);
      return {
        state: nextState,
        replay: appendReplayEntry(current.replay, current.state, decision, nextState, "player"),
      };
    });
  }

  function undoLastDecision() {
    const popped = popUndoSnapshot(undoHistory);
    if (!popped.snapshot) return;
    const replayLength = undoReplayLengths[undoReplayLengths.length - 1] ?? replay.entries.length;
    clearTransientUi();
    seenLogCount.current = popped.snapshot.log.length;
    setUndoHistory(popped.stack);
    setUndoReplayLengths((lengths) => lengths.slice(0, -1));
    setGame((current) => ({
      state: popped.snapshot!,
      replay: truncateReplaySession(current.replay, replayLength),
    }));
  }

  function enterReplayMode() {
    clearTransientUi();
    setToolMode({ type: "detail" });
    setMobilePanel(null);
    setReplayStep(replay.entries.length);
    setReplayMode(true);
  }

  function exitReplayMode() {
    clearTransientUi();
    setReplayMode(false);
    setReplayStep(0);
    setReplayCritique({ status: "idle" });
    setReplayScan({ status: "idle" });
    replayScanTokenRef.current++;
    replayCoachRejectRef.current?.(new Error("__cancelled__"));
    replayCoachRejectRef.current = null;
    replayCoachWorkerRef.current?.terminate();
    replayCoachWorkerRef.current = null;
  }

  function storeReplayCritique(step: number, result: ReplayCritiqueResult) {
    replayCritiquesRef.current = { ...replayCritiquesRef.current, [step]: result };
    setReplayCritiques(replayCritiquesRef.current);
  }

  function requestReplayCoach(entry: ReplayEntry, step: number, token: number): Promise<CoachReport> {
    const requestId = String(++replayCoachRequestRef.current);
    replayCoachRejectRef.current?.(new Error("__cancelled__"));
    replayCoachRejectRef.current = null;
    replayCoachWorkerRef.current?.terminate();
    replayCoachWorkerRef.current = null;
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("../ai/coach-worker.ts", import.meta.url), { type: "module" });
      replayCoachWorkerRef.current = worker;
      replayCoachRejectRef.current = reject;
      worker.onmessage = (event: MessageEvent<CoachWorkerResponse>) => {
        if (event.data.requestId !== requestId || replayCoachRequestRef.current !== Number(requestId)) return;
        worker.terminate();
        if (replayCoachWorkerRef.current === worker) replayCoachWorkerRef.current = null;
        if (replayCoachRejectRef.current === reject) replayCoachRejectRef.current = null;
        if (replayScanTokenRef.current !== token) {
          reject(new Error("__cancelled__"));
          return;
        }
        if (event.data.ok) resolve(event.data.report);
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event) => {
        if (replayCoachRequestRef.current !== Number(requestId)) return;
        worker.terminate();
        if (replayCoachWorkerRef.current === worker) replayCoachWorkerRef.current = null;
        if (replayCoachRejectRef.current === reject) replayCoachRejectRef.current = null;
        if (replayScanTokenRef.current !== token) {
          reject(new Error("__cancelled__"));
          return;
        }
        reject(new Error(event.message || "Replay Coach worker 發生錯誤"));
      };
      worker.postMessage({
        requestId,
        state: entry.before,
        options: {
          perspectivePlayer: entry.player,
          knownDecks: props.decks,
          seed: entry.before.rngState + step * 97,
          sampleCount: 4,
          candidateLimit: 6,
          rolloutMaxSteps: 1200,
          timeLimitMs: 1400,
        },
      });
    });
  }

  async function evaluateReplayStep() {
    if (!replayMode || !replayEntry) return;
    const step = replayStep;
    const token = ++replayScanTokenRef.current;
    setReplayScan({ status: "idle" });
    setReplayCritique({ status: "loading", step });
    try {
      const report = await requestReplayCoach(replayEntry, step, token);
      storeReplayCritique(step, { status: "ready", report });
      setReplayCritique({ status: "ready", step, report });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "__cancelled__") return;
      storeReplayCritique(step, { status: "error", error: message });
      setReplayCritique({ status: "error", step, error: message });
    }
  }

  async function scanReplayDecisions() {
    if (!replayMode) return;
    const targets = replayKeyEntries
      .filter((entry) => entry.source === "player")
      .filter((entry) => replayCritiquesRef.current[entry.index + 1]?.status !== "ready");
    const total = targets.length;
    if (total === 0) {
      setReplayScan({ status: "done", total: 0 });
      return;
    }
    const token = ++replayScanTokenRef.current;
    let done = 0;
    for (const entry of targets) {
      if (replayScanTokenRef.current !== token) {
        setReplayScan({ status: "stopped", done, total });
        return;
      }
      const step = entry.index + 1;
      setReplayScan({ status: "running", currentStep: step, done, total });
      setReplayCritique({ status: "loading", step });
      try {
        const report = await requestReplayCoach(entry, step, token);
        storeReplayCritique(step, { status: "ready", report });
        if (replayStep === step) setReplayCritique({ status: "ready", step, report });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "__cancelled__") {
          setReplayScan({ status: "stopped", done, total });
          return;
        }
        storeReplayCritique(step, { status: "error", error: message });
        if (replayStep === step) setReplayCritique({ status: "error", step, error: message });
      }
      done++;
    }
    if (replayScanTokenRef.current === token) setReplayScan({ status: "done", total });
  }

  function stopReplayScan() {
    replayScanTokenRef.current++;
    replayCoachRejectRef.current?.(new Error("__cancelled__"));
    replayCoachRejectRef.current = null;
    replayCoachWorkerRef.current?.terminate();
    replayCoachWorkerRef.current = null;
    setReplayScan((scan) => scan.status === "running" ? { status: "stopped", done: scan.done, total: scan.total } : scan);
  }

  function changeSpeed(next: AiSpeed) {
    setSpeed(next);
    localStorage.setItem("breaktcg-ai-speed", next);
  }

  function toggleSfx() {
    setSfxEnabled((on) => {
      const next = !on;
      localStorage.setItem("breaktcg-sfx", next ? "on" : "off");
      return next;
    });
  }

  useEffect(() => {
    if (replayMode) return;
    if (pd?.player !== AI || state.phase === "gameOver") return;
    const numeric = speed === "instant" ? Infinity : Number(speed);
    const delay = speed === "instant" ? 0 : 650 / numeric;
    const timer = window.setTimeout(() => {
      setGame((current) => current.state.pendingDecision?.player === AI && current.state.phase !== "gameOver"
        ? (() => {
            const decision = heuristicAiDecision(db, current.state);
            const nextState = applyDecision(db, current.state, decision);
            return {
              state: nextState,
              replay: appendReplayEntry(current.replay, current.state, decision, nextState, "ai"),
            };
          })()
        : current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [db, pd, replayMode, speed, state.phase]);

  useEffect(() => {
    coachWorkerRef.current?.terminate();
    coachWorkerRef.current = null;
    const requestId = String(++coachRequestRef.current);

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
      const worker = new Worker(new URL("../ai/coach-worker.ts", import.meta.url), { type: "module" });
      coachWorkerRef.current = worker;
      worker.onmessage = (event: MessageEvent<CoachWorkerResponse>) => {
        if (event.data.requestId !== requestId || coachRequestRef.current !== Number(requestId)) return;
        if (event.data.ok) setCoach({ status: "ready", report: event.data.report });
        else setCoach({ status: "error", fallback, error: event.data.error });
        worker.terminate();
        if (coachWorkerRef.current === worker) coachWorkerRef.current = null;
      };
      worker.onerror = (event) => {
        if (coachRequestRef.current !== Number(requestId)) return;
        setCoach({ status: "error", fallback, error: event.message || "Coach worker 發生錯誤" });
        worker.terminate();
        if (coachWorkerRef.current === worker) coachWorkerRef.current = null;
      };
      worker.postMessage({
        requestId,
        state,
        options: {
          perspectivePlayer: HUMAN,
          knownDecks: props.decks,
          seed: state.rngState,
          sampleCount: 4,
          candidateLimit: 6,
          rolloutMaxSteps: 1400,
          timeLimitMs: 1200,
        },
      });
    }, 180);

    return () => {
      window.clearTimeout(timer);
      coachWorkerRef.current?.terminate();
      coachWorkerRef.current = null;
    };
  }, [db, isMyDecision, pd, props.decks, replayMode, state]);

  useEffect(() => {
    const cached = replayCritiquesRef.current[replayStep];
    if (cached?.status === "ready") setReplayCritique({ status: "ready", step: replayStep, report: cached.report });
    else if (cached?.status === "error") setReplayCritique({ status: "error", step: replayStep, error: cached.error });
    else if (replayScan.status !== "running" || replayScan.currentStep !== replayStep) setReplayCritique({ status: "idle" });
  }, [replayStep]);

  useEffect(() => () => {
    replayCoachRejectRef.current?.(new Error("__cancelled__"));
    replayCoachWorkerRef.current?.terminate();
  }, []);

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
      if (sfxEnabled && speed !== "instant") {
        const pool = youWon ? SFX_SCORE_YOU : SFX_SCORE_OPP;
        setSfx({ text: pool[Math.floor(Math.random() * pool.length)]!, key: Date.now() });
      }
    } else if (attack && sfxEnabled && speed !== "instant") {
      const pool = attack.player === HUMAN ? SFX_ATTACK_YOU : SFX_ATTACK_OPP;
      setSfx({ text: pool[Math.floor(Math.random() * pool.length)]!, key: Date.now() });
    }

    const timer = window.setTimeout(() => {
      setScoreBanner(null);
      setSfx(null);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [state.log, sfxEnabled, speed]);

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

  // 固定設計畫布 1600×900，等比縮放置中（封頂 1.0：夠大的瀏覽器尺寸與間距一律相同）
  useLayoutEffect(() => {
    const update = () => setFitScale(Math.min(1, window.innerWidth / 1600, window.innerHeight / 1040));
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
      return bar(`賽後覆盤 ${replayStep}/${replay.entries.length}${replayEntry ? `・${actorLabel(replayEntry)}：${decisionLabel(replayEntry.decision)}` : "・開局"}`, <>
        <button disabled={replayStep <= 0} onClick={() => setReplayStep((step) => Math.max(0, step - 1))}>上一步</button>
        <button data-primary="true" disabled={replayStep >= replay.entries.length} onClick={() => setReplayStep((step) => Math.min(replay.entries.length, step + 1))}>下一步</button>
        <button className="btn-secondary" onClick={exitReplayMode}>回到結算</button>
      </>);
    }
    if (state.phase === "gameOver") {
      return bar(state.winner === HUMAN ? "你贏得了這場對戰" : "電腦贏得了這場對戰", <>
        <button data-primary="true" disabled={replay.entries.length === 0} onClick={enterReplayMode}>進入賽後覆盤</button>
        <button className="btn-secondary" onClick={props.onExit}>回主選單</button>
      </>);
    }
    if (!pd) return <div className="decision-bar decision-idle"><span>規則引擎正在推進對局</span></div>;
    if (!isMyDecision) return <div className="decision-bar decision-idle"><span>電腦思考中</span><small>{PHASE_NAME[state.phase]}</small></div>;

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
        return (
          <div className="decision-bar decision-card-picker">
            <span className="decision-hint">{pd.prompt}（選 {min === max ? min : `${min}～${max}`} 張）</span>
            <div className="effect-cards-row">
              {pd.candidates?.map((uid) => (
                <CardView
                  key={uid}
                  card={cardOf(uid)}
                  uid={uid}
                  width={64}
                  selected={multiSel.includes(uid)}
                  onHover={(card) => setHoverUid(card ? uid : null)}
                  onLongPress={() => inspectUid(uid)}
                  onClick={() => toggleSelection(uid, max)}
                />
              ))}
            </div>
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
  const HAND_CARD = 84;
  const HAND_GAP = 12;
  const HAND_MIN_VISIBLE = 34;
  const handCount = viewState.players[HUMAN].hand.length;
  let handStep = HAND_GAP;
  if (handCount > 1 && handWidth > 0) {
    const needed = handCount * HAND_CARD + (handCount - 1) * HAND_GAP;
    if (needed > handWidth) {
      handStep = Math.max(-(HAND_CARD - HAND_MIN_VISIBLE), (handWidth - HAND_CARD) / (handCount - 1) - HAND_CARD);
    }
  }
  const handStyle = { "--hand-step": `${handStep}px` } as CSSProperties;

  return (
    <div className="fit-shell" data-instant={speed === "instant" ? "true" : undefined}>
    <svg className="ink-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id="ink-rough" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="7" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
    <div className="game" data-instant={speed === "instant" ? "true" : undefined} style={{ "--fit-scale": fitScale } as CSSProperties}>
      <CompactHud
        state={viewState}
        onOpenLog={() => setMobilePanel("log")}
        onOpenDetail={() => setMobilePanel("detail")}
        onExit={props.onExit}
      />

      <LeftPanel
        state={viewState}
        deckMeta={props.deckMeta}
        speed={speed}
        onSpeedChange={changeSpeed}
        sfxEnabled={sfxEnabled}
        onToggleSfx={toggleSfx}
        onExit={props.onExit}
      />

      <main className="center-panel">
        <GameBoard
          db={db}
          state={viewState}
          deckMeta={props.deckMeta}
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
                  width={84}
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
        <div className="tool-actions">
          <button className="btn-quiet undo-button" disabled={!canUndo} title="回到上一個我方決策前" onClick={undoLastDecision}>返回上一步</button>
        </div>
        <div className="tool-tabs" role="tablist" aria-label="右欄工具">
          <button role="tab" aria-selected={toolMode.type === "detail"} className={toolMode.type === "detail" ? "is-active" : ""} onClick={() => setToolMode({ type: "detail" })}>詳情</button>
          <button role="tab" aria-selected={toolMode.type === "coach"} className={toolMode.type === "coach" ? "is-active" : ""} onClick={() => setToolMode({ type: "coach" })}>教練</button>
          <button role="tab" aria-selected={toolMode.type === "counter"} className={toolMode.type === "counter" ? "is-active" : ""} onClick={() => setToolMode({ type: "counter" })}>算牌</button>
          <button role="tab" aria-selected={toolMode.type === "drop"} className={toolMode.type === "drop" ? "is-active" : ""} onClick={() => setToolMode({ type: "drop", player: HUMAN })}>棄牌</button>
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
                critique={replayCritique}
                critiqueCache={replayCritiques}
                scan={replayScan}
                onEvaluate={evaluateReplayStep}
                onScan={scanReplayDecisions}
                onStopScan={stopReplayScan}
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
          ) : visibleInspection ? (
            <CardDetails db={db} state={state} inspected={visibleInspection} />
          ) : (
            <MatchSummary state={state} replayEntries={replay.entries.length} />
          )}
        </div>
      </aside>

      <aside className={`mobile-log-panel${mobilePanel === "log" ? " is-open" : ""}`}>
        <div className="mobile-panel-heading"><b>對戰紀錄</b><button className="btn-quiet" onClick={() => setMobilePanel(null)}>關閉</button></div>
        <GameLog state={viewState} />
      </aside>

      {mobilePanel && <button className="panel-backdrop" aria-label="關閉面板" onClick={() => setMobilePanel(null)} />}
      {activeGutsKey && <button className="guts-backdrop" aria-label="關閉 Guts" onClick={() => setActiveGutsKey(null)} />}
    </div>

    {scoreBanner && <div className="focus-lines" aria-hidden="true" />}
    {sfx && <div key={sfx.key} className="sfx-burst" aria-hidden="true">{sfx.text}</div>}
    {scoreBanner && <div className={`score-banner score-banner-${scoreBanner.kind}`} role="status">{scoreBanner.text}</div>}
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
