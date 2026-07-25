// ui-lab 對局 renderer；由 App 的唯一入口 lazy 載入並餵入已選牌組。
// LP1~LP5（[使用者 2026-07-11] 完整對局路線）：人類親手操作 P0 全部 18 種
// 決策變體（拖曳登場／攔網多選＋center／換牌多選／自由步驟技能事件／效果決策蓋板／
// 取 Set 卡／serve-rights）→ 結算畫面。對手 P1＝heuristic AI；任何單手可按「AI 代打」委託。
// 架構：LabGameController（邏輯即時）→ PresentationTimeline → usePlayback（演出視圖）→ BoardScene（R3F）。

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { CoachReport } from "../ai/coach";
import { createSearchController, createWorkerSearchBackend, isSearchCancelled, type CancelableQuery } from "../ai/ai-search";
import { heuristicAiDecision } from "../ai/heuristic";
import { estimateThinkBudgetMs } from "../ai/think-budget";
import { blockDeployMax, canChooseBlock, deployLegality, deployNames, deployableUids, freeCardReasons, freeOptions } from "../engine/engine";
import type { CardDb, Decision, GameState, LogEntry } from "../engine/types";
import type { DeckMeta } from "../shared/deckMeta";
import { pendingReplaySetFeedback, type ReplaySetFeedbackChoice } from "../shared/replayHistory";
import { buildMatchSummary } from "../shared/matchSummary";
import { cardBackUrl, cardFrontUrl } from "./assets";
import { HUMAN, LabGameController } from "./game/controller";
import { CardInfoPanel } from "./game/CardInfoPanel";
import { DecisionRail } from "./game/DecisionRail";
import { LabCardCounter, LabCoachPanel, LabSettingsPanel, type LabCoachState, type RailTool } from "./game/RailTools";
import {
  BlockPickPanel,
  EffectConfirmModal,
  EffectOptionModal,
  ResolvePendingModal,
  SetFeedbackModal,
  ServeRightsModal,
  SettlementModal,
} from "./game/overlays";
import { usePlayback } from "./game/usePlayback";
import { buildBattleRailView, buildCardInspectView, deployLegalityText } from "./game/railViewModel";
import { buildPrintingByUid, expandDeck, printingSelections, type LabDeck } from "./deck";
import { schoolMatColor } from "./scene/schoolColors";
import type { ZoneId } from "./presentation/events";
import { ZONE_LABEL } from "./presentation/textRenderer";
import type { TimelineEntry } from "./presentation/timeline";
import { replaceBannerDismissTimer } from "./presentation/bannerHold";
import { BoardScene } from "./scene/BoardScene";
import { CameraRig, CameraViewportOffset, LAB_CAMERA_BASE } from "./scene/CameraRig";
import { zoneAnchor } from "./scene/layout";
import { applyBlockPreview, applyMovedPileTargets, applyReadingFrame, computePlacements, locateReadingCard, mergePlacements, readingCardsForZone, type InspectZone, type ReadingCardRef } from "./scene/placements";
import { canUseInPlaceEffectSelection } from "../shared/selection";
import { RevealLayer } from "./scene/RevealLayer";
import styles from "./UiLabApp.module.css";

type DeployType = "deploy-serve" | "deploy-receive" | "deploy-toss" | "deploy-attack";
type StackZone = "serve" | "blockCenter" | "receive" | "toss" | "attack";
type InspectTarget = { player: 0 | 1; zone: InspectZone };
const STACK_ZONES: ReadonlySet<ZoneId> = new Set(["serve", "blockCenter", "receive", "toss", "attack"]);
const isStackZone = (zone: ZoneId): zone is StackZone => STACK_ZONES.has(zone);
const DEPLOY_ZONE: Record<DeployType, "serve" | "receive" | "toss" | "attack"> = {
  "deploy-serve": "serve",
  "deploy-receive": "receive",
  "deploy-toss": "toss",
  "deploy-attack": "attack",
};
const DEPLOY_PROMPT: Record<DeployType, string> = {
  "deploy-serve": "發球登場：點擊發亮的手牌直接出牌，或拖曳到發光區（不登場＝Lost）",
  "deploy-receive": "接球登場：點擊發亮的手牌直接出牌，或拖曳到發光區",
  "deploy-toss": "托球登場：點擊發亮的手牌直接出牌，或拖曳到發光區",
  "deploy-attack": "攻擊登場：點擊發亮的手牌直接出牌，或拖曳到發光區",
};

/** 中央 banner（宣言/得分類事件演出中顯示）；null＝不顯示 */
function bannerOf(entry: TimelineEntry | null, schools: [string, string]): { text: string; heavy: boolean } | null {
  if (!entry) return null;
  const e = entry.event;
  switch (e.kind) {
    case "skill-declared":
      return { text: `⚡ 技能發動：${e.name}`, heavy: false };
    case "event-played":
      return { text: `事件卡：${e.name}`, heavy: false };
    case "defense-chosen":
      return { text: e.choice === "block" ? "攔網宣言！" : "接球宣言！", heavy: false };
    case "lost-declared":
      return { text: `${schools[e.player]} 宣告 Lost…`, heavy: false };
    case "set-won":
      return { text: `第 ${e.setNo} 局——${schools[e.winner]} 拿下！`, heavy: true };
    case "match-won":
      return { text: `比賽結束——${schools[e.winner]} 獲勝！`, heavy: true };
    default:
      return null;
  }
}

/** 演出時鐘：掛在 Canvas 內，用 R3F frame loop 驅動 playback（背景 timer 節流免疫） */
function PlaybackTicker(props: { tick: (dtMs: number) => void }): null {
  useFrame((_, dt) => props.tick(Math.min(dt, 0.1) * 1000));
  return null;
}

function LabGame(props: { db: CardDb; decks: [LabDeck, LabDeck]; seed: number; onRematch: () => void; onExit: () => void }): React.JSX.Element {
  const { db, seed } = props;
  const schools: [string, string] = [props.decks[0].school, props.decks[1].school];
  const matColors: [string, string] = [schoolMatColor(schools[0]), schoolMatColor(schools[1])];
  const expanded = useMemo<[string[], string[]]>(() => [expandDeck(props.decks[0]), expandDeck(props.decks[1])], [props.decks]);
  const controller = useMemo(
    () => {
      const meta: [DeckMeta, DeckMeta] = props.decks.map((deck, player) => ({
        school: deck.school,
        name: deck.name,
        total: expanded[player]!.length,
        implementedCount: expanded[player]!.length,
        unimplementedCount: 0,
      })) as [DeckMeta, DeckMeta];
      return new LabGameController(db, expanded, seed, meta, { deferOpponent: true });
    },
    [db, expanded, props.decks, seed],
  );
  const printingByPlayer = useMemo(
    () => [printingSelections(props.decks[0]), printingSelections(props.decks[1])] as const,
    [props.decks],
  );
  const printingByUid = useMemo(
    () => buildPrintingByUid(controller.engine.cards, props.decks),
    [controller, props.decks],
  );
  const { view, tick, markPlaying, skip, reset, setPaused, setSpeed } = usePlayback(controller, db);

  // ---- 互動狀態（拖曳／點擊出牌／hover／多選） ----
  const dragPoint = useRef(new THREE.Vector3());
  const overRef = useRef(false);
  /** 點擊 vs 拖曳判別：pointerdown 起算時間＋首個拖曳點＋是否已位移 */
  const dragMeta = useRef({ t: 0, firstX: null as number | null, firstZ: 0, moved: false });
  /** draggingUid 的同步鏡像：事件 handler 內的判定不能依賴 setState updater */
  const draggingRef = useRef<number | null>(null);
  const [draggingUid, setDraggingUid] = useState<number | null>(null);
  const [overZone, setOverZone] = useState(false);
  const [hoveredUid, setHoveredUid] = useState<number | null>(null);
  const [pinnedUid, setPinnedUid] = useState<number | null>(null);
  const [namePick, setNamePick] = useState<{ uid: number; names: string[] } | null>(null);
  const [speed, setSpeedState] = useState(2); // [使用者 2026-07-12] 預設 2x（1x 太慢）
  const [confirmExit, setConfirmExit] = useState(false);
  const [orbit, setOrbit] = useState(false);
  // [使用者 2026-07-18] #4：預設減少鏡頭動態（banner 滑入滑出照常，見 CSS reducedMotion 區塊）。
  const [reducedMotion, setReducedMotion] = useState(true);
  /** 觀戰模式：我方決策全部自動委託 heuristic（LP6 全流程驗證兼觀戰用） */
  const [autoPlay, setAutoPlay] = useState(false);
  const [opponentEngine, setOpponentEngine] = useState<"strong" | "heuristic">(() => {
    try { return localStorage.getItem("breaktcg-opponent-engine") === "heuristic" ? "heuristic" : "strong"; }
    catch { return "strong"; }
  });
  const [railTool, setRailTool] = useState<RailTool>("log");
  const [coach, setCoach] = useState<LabCoachState>({ status: "idle" });
  const [inspectTarget, setInspectTarget] = useState<InspectTarget | null>(null);
  /** 多選（mulligan 換牌／攔網登場）＋攔網中央指定＋攔網選名佇列 */
  const [boardSel, setBoardSel] = useState<number[]>([]);
  const [blockCenter, setBlockCenter] = useState<number | null>(null);
  const [blockNames, setBlockNames] = useState<{ queue: { uid: number; names: string[] }[]; chosen: Record<number, string> } | null>(null);
  const replaySaved = useRef(false);
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  // 預設節奏 2x（初次掛載套用到 timeline）
  useEffect(() => { setSpeed(2); }, [setSpeed]);
  const [aiThinking, setAiThinking] = useState<{ budgetMs: number; startedAt: number } | null>(null);
  const [thinkingNow, setThinkingNow] = useState(Date.now());
  const [shellNotice, setShellNotice] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [confirmLost, setConfirmLost] = useState(false);
  const [assetProgress, setAssetProgress] = useState({ loaded: 0, total: 0, done: false });
  const aiQueryRef = useRef<CancelableQuery<Decision> | null>(null);
  const coachQueryRef = useRef<CancelableQuery<CoachReport> | null>(null);
  const coachCacheRef = useRef<{ key: string; state: LabCoachState } | null>(null);
  // [Claude 2026-07-24] 候選 A：搜尋門面（取消/取代/fallback/調參都在 module 內）。React 只留膠水。
  const search = useMemo(() => createSearchController({ backend: createWorkerSearchBackend() }), []);

  useEffect(() => {
    const urls = new Set<string>(schools.map((school) => cardBackUrl(school)));
    for (const player of [0, 1] as const) for (const id of expanded[player]) {
      const card = db.get(id);
      const url = card ? cardFrontUrl(card, printingByPlayer[player].get(id)) : null;
      if (url) urls.add(url);
    }
    let cancelled = false;
    let loaded = 0;
    setAssetProgress({ loaded: 0, total: urls.size, done: urls.size === 0 });
    for (const url of urls) {
      const img = new Image();
      const settle = () => {
        if (cancelled) return;
        loaded += 1;
        setAssetProgress({ loaded, total: urls.size, done: loaded >= urls.size });
      };
      img.onload = settle;
      img.onerror = settle;
      img.src = url;
    }
    return () => { cancelled = true; };
  }, [db, expanded, printingByPlayer, schools[0], schools[1]]);

  useEffect(() => {
    if (!actionNotice) return;
    const id = window.setTimeout(() => setActionNotice(null), 2600);
    return () => window.clearTimeout(id);
  }, [actionNotice]);

  // ---- 互動閘：佇列清空前不開放（spec §1.1） ----
  const engine: GameState = controller.engine;
  const replayEntryCount = controller.replay.entries.length;
  const replayFeedbackCount = controller.replay.setFeedback?.length ?? 0;
  const pendingSetFeedback = useMemo(
    () => pendingReplaySetFeedback(controller.replay),
    [controller, replayEntryCount, replayFeedbackCount, feedbackRevision],
  );
  const pd = view.playing || inspectTarget || pendingSetFeedback ? null : engine.pendingDecision;
  const myPd = pd && pd.player === HUMAN ? pd : null;
  const effectCandidates = myPd?.type === "effect-cards" ? (myPd.candidates ?? []) : [];
  const effectCardsInPlace = myPd?.type === "effect-cards" && canUseInPlaceEffectSelection(engine, HUMAN, effectCandidates);
  // [使用者 2026-07-12] #1：能直接在場上點選就不出懸浮選牌面（移除 ≥3 也強制上面板的規則）；
  // 只有候選不在場上（牌堆/隱藏/跨區不可見）時才搬到選牌面。
  const effectSelectionSurface = myPd?.type === "effect-cards" && !effectCardsInPlace;
  const readingRefs = useMemo<ReadingCardRef[]>(() => {
    if (inspectTarget) return readingCardsForZone(view.displayed, inspectTarget.player, inspectTarget.zone);
    if (effectSelectionSurface) {
      return effectCandidates.map((uid) => locateReadingCard(engine, uid)).filter((ref): ref is ReadingCardRef => ref !== null);
    }
    return [];
  }, [inspectTarget, view.displayed, effectSelectionSurface, effectCandidates, engine]);
  const readingFrameActive = readingRefs.length > 0;

  const deployType = myPd && myPd.type in DEPLOY_ZONE ? (myPd.type as DeployType) : null;
  const zone = deployType ? DEPLOY_ZONE[deployType] : null;
  const valueParam = myPd?.type === "deploy-block" ? "block" : zone;
  const contextualHandUids = useMemo(
    () => valueParam ? new Set(deployableUids(db, engine, HUMAN, valueParam === "block" ? "block" : valueParam)) : new Set<number>(),
    [db, engine, valueParam],
  );
  const handValue = valueParam ? { player: HUMAN, param: valueParam, uids: contextualHandUids } as const : undefined;

  // ---- 演出視圖 → 擺位 ----
  const placements = useMemo(() => {
    const base = computePlacements(db, view.displayed, schools, view.valueFormulas, handValue, printingByUid);
    const mergedBase = !view.after || view.movedUids.size === 0
      ? base
      : mergePlacements(base, computePlacements(db, view.after, schools, view.valueFormulas, handValue, printingByUid), view.movedUids);
    // 移入牌堆的移動（換牌回牌組等）給牌堆錨點落點，才有「飛回牌堆」動態。
    const merged = view.after ? applyMovedPileTargets(mergedBase, view.after, view.movedUids, schools) : mergedBase;
    const previewed = myPd?.type === "deploy-block" ? applyBlockPreview(merged, boardSel, blockCenter) : merged;
    if (!readingFrameActive) return previewed;
    return applyReadingFrame(previewed, db, inspectTarget ? view.displayed : engine, readingRefs, schools, inspectTarget ? "inspect" : "select", printingByUid, new Set(boardSel));
  }, [db, view.displayed, view.after, view.movedUids, view.valueFormulas, schools[0], schools[1], myPd?.type, boardSel, blockCenter, readingFrameActive, readingRefs, inspectTarget, engine, handValue, printingByUid]);

  const draggableUids = useMemo(
    () => (zone ? contextualHandUids : new Set<number>()),
    [zone, contextualHandUids],
  );
  const dropAnchor = zone ? zoneAnchor(HUMAN, zone) : null;

  // 決策切換時清空選取狀態
  useEffect(() => {
    setBoardSel([]);
    setBlockCenter(null);
    setBlockNames(null);
    setNamePick(null);
    setConfirmLost(false);
  }, [pd]);

  /** 自由步驟可用選項（技能宣告／事件卡） */
  const freeOpts = useMemo(
    () => (myPd?.type === "free" ? freeOptions(db, engine) : { skills: [], events: [] }),
    [db, engine, myPd],
  );
  const blockMax = myPd?.type === "deploy-block" ? Math.min(3, blockDeployMax(engine, HUMAN)) : 0;

  /** 點選模式的可選卡 */
  const selectableUids = useMemo(() => {
    if (!myPd) return new Set<number>();
    switch (myPd.type) {
      case "mulligan":
        return new Set(engine.players[HUMAN].hand);
      case "pick-set-card":
        return new Set(engine.players[HUMAN].setArea);
      case "deploy-block":
        return new Set(deployableUids(db, engine, HUMAN, "block"));
      case "free":
        return new Set([...freeOpts.skills.map((s) => s.uid), ...freeOpts.events.map((e) => e.uid)]);
      case "effect-cards":
        return new Set(myPd.candidates ?? []);
      default:
        return new Set<number>();
    }
  }, [db, engine, myPd, freeOpts]);
  const selectedUids = useMemo(() => new Set(boardSel), [boardSel]);
  const contextSourceUid = myPd && ["effect-confirm", "effect-cards", "effect-option"].includes(myPd.type) ? (engine.effectCtx?.source ?? null) : null;
  const emphasisUids = useMemo(() => new Set<number>(contextSourceUid === null ? [] : [contextSourceUid]), [contextSourceUid]);
  const inspectableUids = useMemo(() => {
    if (inspectTarget) return new Set(readingRefs.map((ref) => ref.uid));
    const out = new Set<number>();
    for (const player of [0, 1] as const) {
      const ps = view.displayed.players[player];
      const dropTop = ps.drop.at(-1);
      const eventTop = ps.eventArea.at(-1);
      if (dropTop !== undefined) out.add(dropTop);
      if (eventTop !== undefined) out.add(eventTop);
    }
    return out;
  }, [inspectTarget, readingRefs, view.displayed]);
  const handShortcuts = useMemo(() => new Map(engine.players[HUMAN].hand.slice(0, 10).map((uid, index) => [uid, index === 9 ? "0" : String(index + 1)])), [engine]);
  const deferFaceUpUids = useMemo(() => {
    const current = view.current?.event;
    return new Set<number>(current?.kind === "card-moved" && current.reason === "set-pick" ? [current.uid] : []);
  }, [view.current]);
  const shufflingPlayer = view.current?.event.kind === "deck-shuffled" ? view.current.event.player : null;

  const decide = useCallback(
    (decision: Decision, delegated = false): boolean => {
      try {
        const applied = controller.decide(decision, delegated);
        if (!applied) return false;
      } catch (err) {
        console.error("[ui-lab] decide 失敗", err);
        setActionNotice(`這個操作目前不能執行：${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      if (!delegated && "uid" in decision && typeof decision.uid === "number") {
        const card = db.get(controller.engine.cards[decision.uid] ?? "");
        setActionNotice(`已${decision.type === "free" ? "發動" : "登場"} ${card?.nameZh || card?.nameJa || "卡片"}・Cmd+Z 撤回`);
      }
      markPlaying();
      return true;
    },
    [controller, db, markPlaying],
  );

  const undoDecision = useCallback((): void => {
    if (!controller.undo()) return;
    setBoardSel([]);
    setBlockCenter(null);
    setBlockNames(null);
    setNamePick(null);
    setInspectTarget(null);
    setPaused(false);
    setHoveredUid(null);
    reset();
  }, [controller, reset, setPaused]);

  /** 攔網登場確認：收集 072/073 選名後送出 */
  const confirmBlock = useCallback((): void => {
    if (!boardSel.length) return;
    const center = blockCenter ?? boardSel[0]!;
    const chosen: Record<number, string> = {};
    const queue: { uid: number; names: string[] }[] = [];
    for (const uid of boardSel) {
      const names = deployNames(db, engine, uid);
      if (!names || names.length === 0) continue;
      if (names.length === 1) chosen[uid] = names[0]!;
      else queue.push({ uid, names });
    }
    if (queue.length > 0) {
      setBlockNames({ queue, chosen });
      return;
    }
    decide({ type: "deploy-block", uids: boardSel, center, ...(Object.keys(chosen).length ? { nameChoices: chosen } : {}) });
  }, [db, engine, boardSel, blockCenter, decide]);

  /** 點選卡片（依決策型別分派） */
  const onCardSelect = useCallback(
    (uid: number): void => {
      if (!myPd) return;
      switch (myPd.type) {
        case "mulligan":
          setBoardSel((cur) => (cur.includes(uid) ? cur.filter((u) => u !== uid) : [...cur, uid]));
          break;
        case "pick-set-card": {
          const index = engine.players[HUMAN].setArea.indexOf(uid);
          if (index >= 0) decide({ type: "pick-set-card", index });
          break;
        }
        case "deploy-block":
          setBoardSel((cur) => {
            if (cur.includes(uid)) {
              // 已選 side 再點一次＝改成 center；已是 center 再點＝取消該張。
              if (blockCenter !== uid) {
                setBlockCenter(uid);
                return cur;
              }
              const next = cur.filter((u) => u !== uid);
              setBlockCenter(next[0] ?? null);
              return next;
            }
            if (cur.length >= blockMax) return cur;
            setBlockCenter((c) => c ?? uid);
            return [...cur, uid];
          });
          break;
        case "free": {
          const skill = freeOpts.skills.find((s) => s.uid === uid);
          if (skill) {
            decide({ type: "free", action: "skill", uid: skill.uid, skillIndex: skill.skillIndex });
            break;
          }
          const event = freeOpts.events.find((e) => e.uid === uid);
          if (event) decide({ type: "free", action: "event", uid: event.uid });
          break;
        }
        case "effect-cards": {
          const max = myPd.max ?? (myPd.candidates?.length ?? 0);
          if (!(myPd.candidates ?? []).includes(uid)) break;
          setBoardSel((current) => current.includes(uid) ? current.filter((item) => item !== uid) : current.length < max ? [...current, uid] : current);
          break;
        }
        default:
          break;
      }
    },
    [myPd, engine, decide, blockMax, blockCenter, freeOpts],
  );

  /** 手牌數字鍵等同點擊；同一 Decision 期間 engine 手牌順序不會自行重排。 */
  const activateHandShortcut = useCallback((uid: number): void => {
    if (!myPd || view.playing) return;
    if (deployType) {
      if (!draggableUids.has(uid)) return;
      const names = deployNames(db, engine, uid);
      if (names && names.length > 1) setNamePick({ uid, names });
      else decide({ type: deployType, uid } as Decision);
      return;
    }
    onCardSelect(uid);
  }, [myPd, view.playing, deployType, draggableUids, db, engine, decide, onCardSelect]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.matches("input, textarea, select") || target.isContentEditable)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoDecision();
        return;
      }
      if (event.code === "Space" && view.playing) {
        event.preventDefault();
        skip();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (railTool === "coach" || railTool === "counter") {
          setRailTool("log");
          return;
        }
        setInspectTarget(null);
        setPaused(false);
        setHoveredUid(null);
        setNamePick(null);
        setBlockNames(null);
        setBoardSel([]);
        setBlockCenter(null);
        return;
      }
      if (namePick || blockNames || view.playing) return;
      if (event.key === "Enter") {
        if (myPd?.type === "mulligan") {
          event.preventDefault();
          decide({ type: "mulligan", returnUids: boardSel });
        } else if (myPd?.type === "deploy-block" && boardSel.length > 0) {
          event.preventDefault();
          confirmBlock();
        } else if (myPd?.type === "effect-cards") {
          const min = myPd.min ?? 0;
          const max = myPd.max ?? effectCandidates.length;
          if (boardSel.length >= min && boardSel.length <= max) {
            event.preventDefault();
            decide({ type: "effect-cards", uids: boardSel });
          }
        }
        return;
      }
      const index = event.key === "0" ? 9 : /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
      if (index < 0) return;
      const uid = engine.players[HUMAN].hand[index];
      if (uid === undefined) return;
      event.preventDefault();
      activateHandShortcut(uid);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoDecision, view.playing, skip, namePick, blockNames, myPd, boardSel, decide, confirmBlock, engine, activateHandShortcut, setPaused, effectCandidates, railTool]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden && view.playing) skip();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [skip, view.playing]);

  // ---- 拖曳／點擊出牌流程 ----
  const beginDrag = useCallback(
    (uid: number): void => {
      const p = placements.cards.get(uid);
      if (p) dragPoint.current.set(p.position[0], p.position[1], p.position[2]);
      dragMeta.current = { t: performance.now(), firstX: null, firstZ: 0, moved: false };
      overRef.current = false;
      draggingRef.current = uid;
      setOverZone(false);
      setHoveredUid(null);
      setDraggingUid(uid);
    },
    [placements],
  );

  const onDragMove = useCallback(
    (x: number, z: number): void => {
      dragPoint.current.set(x, dragPoint.current.y, z);
      const m = dragMeta.current;
      if (m.firstX === null) {
        m.firstX = x;
        m.firstZ = z;
      } else if (!m.moved && Math.hypot(x - m.firstX, z - m.firstZ) > 0.35) {
        m.moved = true;
      }
      if (!dropAnchor) return;
      const over = Math.abs(x - dropAnchor.x) < 1.6 && Math.abs(z - dropAnchor.z) < 1.4;
      if (over !== overRef.current) {
        overRef.current = over;
        setOverZone(over);
      }
    },
    [dropAnchor],
  );

  const endDrag = useCallback((): void => {
    const uid = draggingRef.current;
    if (uid === null) return; // 已結束（plane 與 window 保險各觸發一次）
    document.body.style.cursor = "";
    // 出牌成立條件：拖進合法區放手，或「點一下」（未位移的短按＝點擊出牌，觸控板友善）
    const over = overRef.current;
    const isClick = !dragMeta.current.moved && performance.now() - dragMeta.current.t < 450;
    draggingRef.current = null;
    overRef.current = false;
    setDraggingUid(null);
    setOverZone(false);
    if (deployType && (over || isClick)) {
      const names = deployNames(db, engine, uid);
      if (names && names.length > 1) setNamePick({ uid, names });
      else decide({ type: deployType, uid } as Decision);
    }
  }, [db, engine, deployType, decide]);

  const closeInspect = useCallback((): void => {
    setInspectTarget(null);
    setPaused(false);
  }, [setPaused]);

  const toggleStack = useCallback((player: 0 | 1, zone: ZoneId): void => {
    if (!isStackZone(zone)) return;
    setInspectTarget((current) => {
      const close = current?.player === player && current.zone === zone;
      setPaused(!close);
      return close ? null : { player, zone };
    });
  }, [setPaused]);

  const inspectPile = useCallback((player: 0 | 1, zone: "drop" | "eventArea"): void => {
    setInspectTarget({ player, zone });
    setPaused(true);
  }, [setPaused]);

  const inspectCard = useCallback((uid: number): void => {
    if (inspectTarget) {
      setHoveredUid(uid);
      return;
    }
    const ref = locateReadingCard(view.displayed, uid);
    if (!ref || (ref.zone !== "drop" && ref.zone !== "eventArea")) return;
    inspectPile(ref.player, ref.zone);
  }, [inspectTarget, view.displayed, inspectPile]);

  // 放手在 canvas 外的保險
  useEffect(() => {
    if (draggingUid === null) return;
    window.addEventListener("pointerup", endDrag);
    return () => window.removeEventListener("pointerup", endDrag);
  }, [draggingUid, endDrag]);

  // 觀戰模式：演出空檔自動代打我方決策
  useEffect(() => {
    if (!autoPlay || view.playing || pendingSetFeedback || !controller.awaitingHuman) return;
    const t = window.setTimeout(() => decide(heuristicAiDecision(db, controller.engine), true), 80);
    return () => window.clearTimeout(t);
  }, [autoPlay, view.playing, controller, db, decide, pd, pendingSetFeedback]);

  // 觀戰／全自動模式沒有玩家的主觀意圖，明確記為略過，維持自動跑完全場的用途。
  useEffect(() => {
    if (!autoPlay || !pendingSetFeedback) return;
    const recorded = controller.recordSetFeedback({
      setNo: pendingSetFeedback.setNo,
      anchorEntryIndex: pendingSetFeedback.anchorEntryIndex,
      choice: "skipped",
    });
    if (recorded) setFeedbackRevision((revision) => revision + 1);
  }, [autoPlay, controller, pendingSetFeedback]);

  // 對手設定：強敵走 SO-ISMCTS worker；快速走 heuristic。兩者共用相同決策入口。
  // [使用者 2026-07-18] #1：閱讀 Guts／牌堆（inspectTarget）不得中斷對手運算——
  // 條件收斂成單一布林：inspect 開閉在「不該重啟」的情況下不改變它，worker 得以續跑；
  // 演出暫停中（閱讀時）也允許先算（結果套用後演出照常凍結，關閉閱讀才補播）。
  const opponentShouldThink = !fatalError && !pendingSetFeedback && controller.awaitingOpponent && (!view.playing || inspectTarget !== null);
  const rawPendingDecision = engine.pendingDecision;
  useEffect(() => {
    if (!opponentShouldThink) {
      setAiThinking(null);
      return;
    }
    const state = controller.engine;
    const budgetMs = opponentEngine === "strong" ? estimateThinkBudgetMs(state) : 180;
    const startedAt = Date.now();
    setAiThinking({ budgetMs, startedAt });
    setShellNotice(null);
    const applyOpponent = (decision: Decision): void => {
      try {
        controller.decideOpponent(decision, Date.now() - startedAt);
        setAiThinking(null);
        markPlaying();
      } catch (error) {
        setAiThinking(null);
        setFatalError(error instanceof Error ? error.message : String(error));
      }
    };
    // requestOpponentMove 內部：strong→worker(ismcts)；heuristic→同步（不帶 rolloutPolicy＝ismcts/heuristic 預設）；
    // 搜尋失敗（非取消）自動落 heuristic 並經 onFallback 顯示提示。
    const runQuery = (): void => {
      const query = search.requestOpponentMove(state, {
        db,
        engine: opponentEngine === "strong" ? "strong" : "heuristic",
        perspectivePlayer: 1,
        knownDecks: expanded,
        seed: state.rngState,
        timeLimitMs: opponentEngine === "strong" ? budgetMs : 0,
        onFallback: (reason) => setShellNotice(`對手搜尋暫時失敗，已切換快速決策：${reason}`),
      });
      aiQueryRef.current = query;
      query.promise.then(applyOpponent).catch((err) => {
        if (!isSearchCancelled(err)) setFatalError(err instanceof Error ? err.message : String(err));
      });
    };
    if (opponentEngine === "heuristic") {
      // 最小思考延遲（演出），再即時決策。
      const timer = window.setTimeout(runQuery, budgetMs);
      return () => {
        window.clearTimeout(timer);
        aiQueryRef.current?.cancel();
        aiQueryRef.current = null;
      };
    }
    runQuery();
    return () => {
      aiQueryRef.current?.cancel();
      aiQueryRef.current = null;
    };
  }, [controller, db, expanded, markPlaying, opponentShouldThink, rawPendingDecision, opponentEngine, search]);

  // Coach 僅在 drawer 開啟時啟動，並以當前 replay/pending/rng 快取。
  useEffect(() => {
    coachQueryRef.current?.cancel();
    coachQueryRef.current = null;
    if (railTool !== "coach" || view.playing || !myPd || inspectTarget) {
      setCoach({ status: "idle" });
      return;
    }
    const state = controller.engine;
    const cacheKey = `${controller.replay.entries.length}:${state.rngState}:${myPd.type}`;
    if (coachCacheRef.current?.key === cacheKey) {
      setCoach(coachCacheRef.current.state);
      return;
    }
    let fallback: Decision;
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
        knownDecks: expanded,
        gameplanDeckLabels: [`${props.decks[0].school}-${props.decks[0].name}`, `${props.decks[1].school}-${props.decks[1].name}`],
        seed: state.rngState,
      });
      coachQueryRef.current = query;
      query.promise.then(
        (report) => {
          if (coachQueryRef.current === query) coachQueryRef.current = null;
          const next: LabCoachState = { status: "ready", report };
          coachCacheRef.current = { key: cacheKey, state: next };
          setCoach(next);
        },
        (err) => {
          if (coachQueryRef.current === query) coachQueryRef.current = null;
          if (isSearchCancelled(err)) return;
          const next: LabCoachState = { status: "error", fallback, error: err instanceof Error ? err.message : String(err) };
          coachCacheRef.current = { key: cacheKey, state: next };
          setCoach(next);
        },
      );
    }, 180);
    return () => {
      window.clearTimeout(timer);
      coachQueryRef.current?.cancel();
      coachQueryRef.current = null;
    };
  }, [controller, db, expanded, inspectTarget, myPd, props.decks, railTool, view.playing, search]);

  useEffect(() => {
    if (!aiThinking) return;
    setThinkingNow(Date.now());
    const timer = window.setInterval(() => setThinkingNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [aiThinking]);

  // ---- 顯示輔助 ----
  const banner = bannerOf(view.current, schools);
  // [使用者 2026-07-12] #4：banner 至少停留一段時間再消失（演出時間軸推進太快會把滑入動畫切斷）。
  // 把最後一次非空 banner 鎖存 2.4s，讓「左滑入→停留→右滑出」完整跑完。
  const [heldBanner, setHeldBanner] = useState<{ text: string; heavy: boolean } | null>(null);
  const bannerKey = useRef(0);
  const bannerDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!banner) return;
    bannerKey.current += 1;
    setHeldBanner(banner);
    bannerDismissTimer.current = replaceBannerDismissTimer(
      bannerDismissTimer.current,
      () => {
        bannerDismissTimer.current = null;
        setHeldBanner(null);
      },
    );
  }, [banner?.text, banner?.heavy]);
  useEffect(() => () => {
    if (bannerDismissTimer.current !== null) clearTimeout(bannerDismissTimer.current);
  }, []);
  const pushed = !!view.current && ["judge-revealed", "set-won", "match-won"].includes(view.current.event.kind);
  const gameOver = !view.playing && !engine.pendingDecision;
  const showSetFeedback = !!pendingSetFeedback && !view.playing && !heldBanner && !inspectTarget && !fatalError && !autoPlay;
  const shown = view.displayed;
  /** rail 卡片詳情：合法性只使用 engine helper 已產生的集合，不在 UI 重寫規則。 */
  const legalCardUids = useMemo(() => new Set([...draggableUids, ...selectableUids]), [draggableUids, selectableUids]);
  const infoUid = hoveredUid ?? pinnedUid ?? contextSourceUid;
  const detailedUnavailableReason: string | readonly string[] | null = infoUid === null
    ? null
    : zone
      ? deployLegalityText(deployLegality(db, engine, HUMAN, infoUid, zone))
      : myPd?.type === "deploy-block"
        ? deployLegalityText(blockMax === 0 ? "block-limit" : deployLegality(db, engine, HUMAN, infoUid, "block"))
        : myPd?.type === "free"
          ? freeCardReasons(db, engine, infoUid)
          : null;
  const inspectedCard = infoUid !== null && draggingUid === null
    ? buildCardInspectView(db, shown, infoUid, legalCardUids, !!myPd, detailedUnavailableReason)
    : null;
  const hoveredCardImg = inspectedCard && infoUid !== null ? cardFrontUrl(inspectedCard.card, printingByUid.get(infoUid)) : null;
  const railView = buildBattleRailView(engine, schools);
  const onLogHover = useCallback((entry: LogEntry | null): void => {
    if (!entry?.event) {
      setHoveredUid(null);
      return;
    }
    const event = entry.event;
    if (event.kind === "skill-used" || event.kind === "event-card" || event.kind === "skill-resolved") {
      setHoveredUid(event.uid);
      return;
    }
    if (event.kind === "op-calc" || event.kind === "dp-calc") {
      const zone = event.source === "block" ? "blockCenter" : event.source;
      setHoveredUid(engine.players[event.player][zone].at(-1) ?? null);
      return;
    }
    setHoveredUid(null);
  }, [engine]);
  const opNote = engine.op && engine.op.owner !== HUMAN ? `對手 OP ${engine.op.value}——` : "";
  const opponentOp = engine.op && engine.op.owner !== HUMAN ? engine.op.value : null;
  const freeActionCount = freeOpts.skills.length + freeOpts.events.length;
  const prompt = view.playing
    ? "演出中…"
    : deployType
      ? `${deployType === "deploy-receive" ? opNote : ""}${DEPLOY_PROMPT[deployType]}`
      : myPd?.type === "defense-choice"
        ? `${opNote}這一 turn 走攔網還是接球？`
        : myPd?.type === "mulligan"
          ? "換牌：點手牌切換選取（可 0 張），選好按「換牌」"
          : myPd?.type === "deploy-block"
            ? `${opNote}攔網登場：點發亮手牌選 1~${blockMax} 張，面板上指定中央後確認`
            : myPd?.type === "pick-set-card"
              ? "拿回一張 Set 卡：點擊你的 Set 區卡片"
              : myPd?.type === "free"
                ? "自由步驟：點亮起的手牌打出事件卡、或宣告角色技能；也可結束步驟或宣告 Lost"
                : gameOver
                  ? `比賽結束——${engine.winner !== null ? schools[engine.winner] : "?"} 獲勝`
                  : myPd
                    ? (myPd.prompt ?? myPd.type)
                    : pd
                      ? "對手行動中…"
                      : "";
  const decisionContext = myPd?.type === "defense-choice" && opponentOp !== null
    ? `對手 OP ${opponentOp}・接球／攔網需 ${opponentOp}+`
    : myPd?.type === "deploy-receive" && opponentOp !== null
      ? `對手 OP ${opponentOp}・接球需 ${opponentOp}+`
      : deployType && opponentOp !== null
        ? `對手 OP ${opponentOp}`
        : "";
  const activeEffects = Array.from(new Set([
    ...engine.restrictions.map((item) => item.desc),
    ...engine.watchers.map((item) => item.desc),
  ].filter(Boolean))).slice(0, 3);
  const drawerOpen = railTool === "coach" || railTool === "counter";
  const changeSpeed = (next: number): void => {
    setSpeedState(next);
    setSpeed(next);
  };
  const changeOpponentEngine = (next: "strong" | "heuristic"): void => {
    setOpponentEngine(next);
    try { localStorage.setItem("breaktcg-opponent-engine", next); } catch { /* in-memory setting remains usable */ }
  };
  const applyCoach = (decision: Decision): void => {
    if (!decide(decision)) return;
    setRailTool("log");
    setActionNotice("已採用 Coach 建議・Cmd+Z 撤回");
  };
  const recordSetFeedback = (choice: ReplaySetFeedbackChoice, note?: string): void => {
    if (!pendingSetFeedback) return;
    const recorded = controller.recordSetFeedback({
      setNo: pendingSetFeedback.setNo,
      anchorEntryIndex: pendingSetFeedback.anchorEntryIndex,
      choice,
      ...(choice !== "skipped" && note?.trim() ? { note: note.trim() } : {}),
    });
    if (!recorded) return;
    setFeedbackRevision((revision) => revision + 1);
    setActionNotice(choice === "skipped" ? `已略過 Set ${pendingSetFeedback.setNo} 回饋` : `已保存 Set ${pendingSetFeedback.setNo} 的當下想法`);
  };
  const hasDecisionOverlay = !!myPd && ["serve-rights", "effect-confirm", "effect-option", "resolve-pending", "deploy-block"].includes(myPd.type);
  const showIntegratedDecision = !!myPd && !hasDecisionOverlay && !gameOver && !inspectTarget && !deployType;

  // [Codex 2026-07-11] CP6 前置：ui-lab 沿用正式 ReplaySession，完整場結束只存一次。
  useEffect(() => {
    if (!gameOver || pendingSetFeedback || replaySaved.current) return;
    replaySaved.current = true;
    void fetch("/api/replays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(controller.replay),
    }).then((res) => {
      if (!res.ok) throw new Error(`儲存對戰失敗（${res.status}）`);
      return res.json();
    }).then((data) => {
      console.log("[ui-lab] 對戰紀錄已儲存:", data.file);
    }).catch((err) => {
      replaySaved.current = false;
      console.error("[ui-lab] 自動儲存對戰紀錄錯誤:", err);
      setShellNotice(`本場已結束，但對戰紀錄尚未儲存：${err instanceof Error ? err.message : String(err)}`);
    });
  }, [controller, gameOver, pendingSetFeedback]);

  return (
    // 尺寸關鍵容器用 inline style：R3F 以 ResizeObserver 量測容器，冷載入時 CSS module
    // 注入時序可能晚於首次量測（實測黑屏），inline 直接消除此時序依賴。
    <div className={`${styles.root} ${reducedMotion ? styles.reducedMotion : ""}`} style={{ position: "fixed", inset: 0 }}>
      <div className={styles.stage}>
        <Canvas
          className={styles.canvas}
          style={{ position: "absolute", inset: 0 }}
          camera={{ position: LAB_CAMERA_BASE, fov: 40 }}
          dpr={[1, 2]}
          onPointerMissed={() => setPinnedUid(null)}
        >
          <color attach="background" args={["#e9ebee"]} />
          <fog attach="fog" args={["#e9ebee", 22, 40]} />
          <Suspense fallback={null}>
            <BoardScene
              matColors={matColors}
              placements={placements}
              origins={view.origins}
              draggableUids={draggableUids}
              selectableUids={selectableUids}
              selectedUids={selectedUids}
              emphasisUids={emphasisUids}
              handShortcuts={handShortcuts}
              deferFaceUpUids={deferFaceUpUids}
              shufflingPlayer={shufflingPlayer}
              readingFrameActive={readingFrameActive}
              inspectableUids={inspectableUids}
              onInspectCard={inspectCard}
              onPileInspect={myPd?.type === "effect-cards" ? () => {} : inspectPile}
              onReadingFrameClose={inspectTarget ? closeInspect : () => {}}
              onCardSelect={onCardSelect}
              draggingUid={draggingUid}
              dragPoint={dragPoint}
              hoveredUid={hoveredUid}
              onCardHover={setHoveredUid}
              onCardPin={(uid) => setPinnedUid((current) => current === uid ? null : uid)}
              dropZone={dropAnchor && draggingUid !== null ? { x: dropAnchor.x, z: dropAnchor.z, active: overZone } : null}
              onCardPointerDown={beginDrag}
              onDragMove={onDragMove}
              onDragEnd={endDrag}
              onStackToggle={myPd?.type === "effect-cards" ? () => {} : toggleStack}
            />
            <RevealLayer
              reveal={readingFrameActive ? {} : view.reveal}
              showJudge={view.current?.event.kind === "judge-revealed"}
            />
          </Suspense>
          <PlaybackTicker tick={tick} />
          <CameraViewportOffset railRatio={0.2} />
          <CameraRig pushed={pushed && !reducedMotion} enabled={!orbit && !reducedMotion} />
          {orbit && <OrbitControls target={[0, 0, 0.6]} enablePan={false} minPolarAngle={0.15} maxPolarAngle={1.35} minDistance={6} maxDistance={20} />}
        </Canvas>
      </div>

      <section
        className={`${styles.statusSlot} ${showIntegratedDecision || inspectTarget ? styles.statusSlotInteractive : ""} ${drawerOpen ? styles.statusSlotDrawerOpen : ""}`}
        aria-label={inspectTarget ? "牌堆閱讀模式" : showIntegratedDecision ? "目前狀態與決策" : "目前狀態"}
      >
        <div className={styles.statusTopRow}>
          <div className={styles.statusSummary} role="status" aria-live="polite" aria-atomic="true">
            {inspectTarget ? (
              <><strong>{inspectTarget.player === HUMAN ? "我方" : "對手"}{ZONE_LABEL[inspectTarget.zone]}</strong><span>牌堆閱讀模式・{readingRefs.length} 張公開卡</span></>
            ) : aiThinking ? (
              <><strong>對手思考中</strong><span>{Math.max(0, (thinkingNow - aiThinking.startedAt) / 1000).toFixed(1)} 秒・最多 {(aiThinking.budgetMs / 1000).toFixed(1)} 秒</span></>
            ) : myPd && !view.playing ? (
              <><strong>{railView.actionLabel}</strong><span>{prompt || myPd.prompt || myPd.type}</span>{decisionContext && <span className={styles.numericContext}>{decisionContext}</span>}</>
            ) : !view.playing ? <><strong>{railView.actionLabel}</strong><span>規則結算中</span></> : null}
            {activeEffects.length > 0 && <div className={styles.effectChips}>{activeEffects.map((text) => <span key={text} title={text}>持續・{text}</span>)}</div>}
          </div>

          {inspectTarget ? (
            <div className={styles.statusDecisionArea}>
              <button className={styles.btnGhost} onClick={closeInspect}>關閉（Esc）</button>
            </div>
          ) : showIntegratedDecision && (
            <div className={styles.statusDecisionArea} aria-label="目前決策">
              {myPd.type === "effect-cards" ? (
                <div className={styles.effectSelectionActions}>
                  <span>已選 {boardSel.length}／{myPd.min ?? 0}–{myPd.max ?? effectCandidates.length} 張</span>
                  <button className={styles.btnGhost} disabled={boardSel.length === 0} onClick={() => setBoardSel([])}>清除</button>
                  <button
                    className={styles.btn}
                    disabled={boardSel.length < (myPd.min ?? 0) || boardSel.length > (myPd.max ?? effectCandidates.length)}
                    onClick={() => decide({ type: "effect-cards", uids: boardSel })}
                  >確認選擇</button>
                </div>
              ) : (
                <div className={styles.decisionActions}>
                  {myPd.type === "defense-choice" && (
                    <>
                      <button className={styles.btn} disabled={!canChooseBlock(engine)} onClick={() => decide({ type: "defense-choice", choice: "block" })}>攔網</button>
                      <button className={styles.btn} onClick={() => decide({ type: "defense-choice", choice: "receive" })}>接球</button>
                    </>
                  )}
                  {myPd.type === "mulligan" && (
                    <button className={styles.btn} onClick={() => decide({ type: "mulligan", returnUids: boardSel })}>{boardSel.length ? `換 ${boardSel.length} 張` : "不換牌"}</button>
                  )}
                  {myPd.type === "free" && (
                    <button className={styles.btn} onClick={() => decide({ type: "free", action: "pass" })}>結束步驟{freeActionCount ? `（放棄 ${freeActionCount} 個行動）` : ""}</button>
                  )}
                </div>
              )}
              {myPd.type === "free" && freeActionCount > 0 && (
                <div className={styles.freeOpts} aria-label="可用事件與技能">
                  {freeOpts.events.map((event) => <button key={`e-${event.uid}`} className={styles.actionChip} title={event.label} onMouseEnter={() => setHoveredUid(event.uid)} onMouseLeave={() => setHoveredUid(null)} onClick={() => decide({ type: "free", action: "event", uid: event.uid })}>{handShortcuts.get(event.uid) ? `${handShortcuts.get(event.uid)} ` : ""}{event.label}</button>)}
                  {freeOpts.skills.map((s) => <button key={`s-${s.uid}-${s.skillIndex}`} className={styles.actionChip} title={s.label} onMouseEnter={() => setHoveredUid(s.uid)} onMouseLeave={() => setHoveredUid(null)} onClick={() => decide({ type: "free", action: "skill", uid: s.uid, skillIndex: s.skillIndex })}>⚡ {handShortcuts.get(s.uid) ? `${handShortcuts.get(s.uid)} ` : ""}{s.label}</button>)}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {!assetProgress.done && (
        <div className={styles.assetLoading} role="status">載入本場卡圖 {assetProgress.loaded}/{assetProgress.total}</div>
      )}

      {/* 中央 banner（鎖存 2.4s 讓滑入→停留→滑出完整跑完） */}
      {heldBanner && !readingFrameActive && (
        <div key={bannerKey.current} className={heldBanner.heavy ? styles.bannerHeavy : styles.banner}>
          {heldBanner.text}
        </div>
      )}

      <DecisionRail
        view={railView}
        presentationLines={view.subtitles}
        log={engine.log}
        tool={railTool}
        onToolChange={setRailTool}
        onDrawerClose={() => setRailTool("log")}
        settingsContent={<LabSettingsPanel speed={speed} reducedMotion={reducedMotion} autoPlay={autoPlay} opponentEngine={opponentEngine} onSpeed={changeSpeed} onReducedMotion={setReducedMotion} onAutoPlay={setAutoPlay} onOpponentEngine={changeOpponentEngine} onExit={() => setConfirmExit(true)} />}
        drawerContent={railTool === "coach" ? <LabCoachPanel state={engine} coach={coach} onApply={applyCoach} /> : railTool === "counter" ? <LabCardCounter db={db} state={engine} /> : null}
        onLogHover={onLogHover}
      />

      {/* [使用者 2026-07-11] 所有常用決策回到左側 80% 舞台中央；rail 只負責資訊。 */}
      <div className={styles.stageInteractionLayer}>
        {/* [使用者 2026-07-18] 輪二：卡片資訊面板與右上工具列（不登場鈕）同欄對齊，直接出現不做動畫。 */}
        {inspectedCard && (
          <div className={styles.cardInfoFloating}>
            <CardInfoPanel card={inspectedCard} cardImage={hoveredCardImg} />
          </div>
        )}
        <div className={styles.stageUtilityStack}>
          <div className={styles.stageToolbar}>
            <button className={styles.btnGhost} disabled={!controller.canUndo} onClick={undoDecision}>Undo {controller.undoDepth ? `(${controller.undoDepth})` : ""}</button>
            {import.meta.env.DEV && <button className={styles.btnGhost} onClick={() => setOrbit((o) => !o)}>{orbit ? "鎖定鏡頭" : "開發視角"}</button>}
          </div>
          {(deployType || myPd?.type === "free") && (
            <div className={styles.dangerDock} aria-label="Lost 與不登場">
              {deployType && <button className={styles.btnDanger} onClick={() => decide({ type: deployType, uid: null } as Decision)}>不登場（Lost）</button>}
              {myPd?.type === "free" && <button className={styles.btnDanger} onClick={() => confirmLost ? decide({ type: "free", action: "lost" }) : setConfirmLost(true)}>{confirmLost ? "再次確認 Lost" : "宣告 Lost"}</button>}
            </div>
          )}
        </div>

        {shellNotice && !fatalError && (
          <div className={styles.shellNotice} role="status">{shellNotice}</div>
        )}
        {actionNotice && !fatalError && <div className={styles.actionNotice} role="status">{actionNotice}</div>}

        {/* ---- 決策蓋板（LP2/LP4/LP5）；定位基準＝左側舞台自身。 ---- */}
        {myPd?.type === "serve-rights" && <ServeRightsModal onPick={(take) => decide({ type: "serve-rights", take })} />}
        {myPd?.type === "effect-confirm" && (
        <EffectConfirmModal prompt={myPd.prompt ?? "要使用效果嗎？"} onPick={(accept) => decide({ type: "effect-confirm", accept })} />
        )}
        {myPd?.type === "effect-option" && (
        <EffectOptionModal prompt={myPd.prompt ?? "選擇效果"} options={myPd.options ?? []} onPick={(index) => decide({ type: "effect-option", index })} />
        )}
        {myPd?.type === "resolve-pending" && (
        <ResolvePendingModal state={engine} candidates={myPd.candidates ?? []} onHover={setHoveredUid} onPick={(id) => decide({ type: "resolve-pending", id })} />
        )}
        {myPd?.type === "deploy-block" && !blockNames && (
        <BlockPickPanel
          db={db}
          state={engine}
          selected={boardSel}
          center={blockCenter}
          max={blockMax}
          printingByUid={printingByUid}
          onSetCenter={setBlockCenter}
          onConfirm={confirmBlock}
          onGiveUp={() => decide({ type: "deploy-block", uids: null })}
        />
        )}

        {/* 選名彈窗（072/073）：單張登場 */}
        {namePick && deployType && (
        <div className={styles.modalMask}>
          <div className={styles.modal}>
            <div className={styles.modalTitle}>以哪個名字登場？</div>
            {(() => {
              const card = db.get(engine.cards[namePick.uid] ?? "");
              const src = card ? cardFrontUrl(card, printingByUid.get(namePick.uid)) : null;
              return src ? <img className={styles.namePickCard} src={src} alt={card?.nameZh || card?.nameJa || "選名卡片"} /> : null;
            })()}
            {namePick.names.map((n) => (
              <button
                key={n}
                className={styles.btn}
                onClick={() => {
                  setNamePick(null);
                  decide({ type: deployType, uid: namePick.uid, nameChoice: n } as Decision);
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        )}

        {/* 選名彈窗（072/073）：攔網多張逐一選名 */}
        {blockNames && blockNames.queue.length > 0 && (
        <div className={styles.modalMask}>
          <div className={styles.modal}>
            <div className={styles.modalTitle}>
              {db.get(engine.cards[blockNames.queue[0]!.uid] ?? "")?.nameZh ?? "這張卡"}以哪個名字登場？
            </div>
            {(() => {
              const uid = blockNames.queue[0]!.uid;
              const card = db.get(engine.cards[uid] ?? "");
              const src = card ? cardFrontUrl(card, printingByUid.get(uid)) : null;
              return src ? <img className={styles.namePickCard} src={src} alt={card?.nameZh || card?.nameJa || "選名卡片"} /> : null;
            })()}
            {blockNames.queue[0]!.names.map((n) => (
              <button
                key={n}
                className={styles.btn}
                onClick={() => {
                  const [head, ...rest] = blockNames.queue;
                  const chosen = { ...blockNames.chosen, [head!.uid]: n };
                  if (rest.length > 0) {
                    setBlockNames({ queue: rest, chosen });
                  } else {
                    setBlockNames(null);
                    decide({ type: "deploy-block", uids: boardSel, center: blockCenter ?? boardSel[0]!, nameChoices: chosen });
                  }
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        )}

        {/* 結算（LP1） */}
        {showSetFeedback && pendingSetFeedback && (
        <SetFeedbackModal
          result={pendingSetFeedback}
          onSubmit={(tag, note) => recordSetFeedback(tag, note)}
          onSkip={() => recordSetFeedback("skipped")}
        />
        )}

        {gameOver && !pendingSetFeedback && (
        <SettlementModal
          winner={engine.winner}
          schools={schools}
          setCards={[engine.players[0].setArea.length, engine.players[1].setArea.length]}
          db={db}
          state={engine}
          summary={buildMatchSummary(db, controller.replay)}
          printingByUid={printingByUid}
          onRematch={props.onRematch}
          onExit={props.onExit}
        />
        )}

        {fatalError && (
          <div className={styles.modalMask} role="alertdialog" aria-modal="true" aria-label="對局無法繼續">
            <div className={styles.modal}>
              <div className={styles.modalTitle}>這場對局暫時無法繼續</div>
              <p className={styles.promptText}>{fatalError}</p>
              {controller.canUndo && <button className={styles.btn} onClick={() => { setFatalError(null); undoDecision(); }}>退回上一步（Undo）</button>}
              <button className={styles.btn} onClick={props.onRematch}>重新開始這組對戰</button>
              <button className={styles.btnGhost} onClick={props.onExit}>回牌組選擇</button>
            </div>
          </div>
        )}
      </div>

      {/* 必須晚於所有決策 modal 掛載，確保任何 phase 都能實際點擊離開。 */}
      {confirmExit && (
        <div className={`${styles.modalMask} ${styles.exitModalMask}`} onClick={() => setConfirmExit(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>離開這場對戰？</div>
            <p style={{ margin: "0 0 4px", fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-2)" }}>
              目前進度不會保存。
            </p>
            <div className={styles.decisionActions}>
              <button className={styles.btnGhost} onClick={() => setConfirmExit(false)}>取消</button>
              <button className={styles.btnDanger} onClick={props.onExit}>離開對戰</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function UiLabGame(props: { db: CardDb; decks: [LabDeck, LabDeck]; onExit: () => void }): React.JSX.Element {
  const [session, setSession] = useState(() => ({ baseSeed: (Date.now() % 1000000) + 1, round: 0 }));
  const seed = session.baseSeed + session.round * 7919;
  return (
    <LabGame
      key={seed}
      db={props.db}
      decks={props.decks}
      seed={seed}
      onRematch={() => setSession({ ...session, round: session.round + 1 })}
      onExit={props.onExit}
    />
  );
}

export default UiLabGame;
