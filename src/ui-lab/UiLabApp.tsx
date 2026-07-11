// ui-lab 入口（雙入口並行，spec §0：?ui=lab、與 src/ui/ 完全隔離）。
// LP1~LP5（[使用者 2026-07-11] 完整對局路線）：選牌組進場 → 人類親手操作 P0 全部 18 種
// 決策變體（拖曳登場／攔網多選＋center／換牌多選／自由步驟技能事件／效果決策蓋板／
// 取 Set 卡／serve-rights）→ 結算畫面。對手 P1＝heuristic AI；任何單手可按「AI 代打」委託。
// 架構：LabGameController（邏輯即時）→ PresentationTimeline → usePlayback（演出視圖）→ BoardScene（R3F）。

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import cardsJson from "../../data/cards.json";
import { heuristicAiDecision } from "../ai/heuristic";
import type { Card } from "../data/types";
import { blockDeployMax, canChooseBlock, deployNames, deployableUids, freeOptions } from "../engine/engine";
import type { CardDb, Decision, GameState } from "../engine/types";
import { cardFrontUrl } from "./assets";
import { HUMAN, LabGameController } from "./game/controller";
import {
  BlockPickPanel,
  EffectCardsPanel,
  EffectConfirmModal,
  EffectOptionModal,
  ResolvePendingModal,
  ServeRightsModal,
  SettlementModal,
} from "./game/overlays";
import { usePlayback } from "./game/usePlayback";
import { expandDeck, LabMenu, type LabDeck } from "./LabMenu";
import type { ZoneId } from "./presentation/events";
import { ZONE_LABEL } from "./presentation/textRenderer";
import type { TimelineEntry } from "./presentation/timeline";
import { BoardScene } from "./scene/BoardScene";
import { CameraRig, LAB_CAMERA_BASE } from "./scene/CameraRig";
import { zoneAnchor } from "./scene/layout";
import { computePlacements, mergePlacements } from "./scene/placements";
import { RevealLayer } from "./scene/RevealLayer";
import styles from "./UiLabApp.module.css";

type DeployType = "deploy-serve" | "deploy-receive" | "deploy-toss" | "deploy-attack";
type StackZone = "serve" | "blockCenter" | "receive" | "toss" | "attack";
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
  const controller = useMemo(
    () => new LabGameController(db, [expandDeck(props.decks[0]), expandDeck(props.decks[1])], seed),
    [db, props.decks, seed],
  );
  const { view, tick, markPlaying, skip, setSpeed } = usePlayback(controller, db);

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
  const [namePick, setNamePick] = useState<{ uid: number; names: string[] } | null>(null);
  const [speed, setSpeedState] = useState(1);
  const [orbit, setOrbit] = useState(false);
  /** 觀戰模式：我方決策全部自動委託 heuristic（LP6 全流程驗證兼觀戰用） */
  const [autoPlay, setAutoPlay] = useState(false);
  const [expandedStack, setExpandedStack] = useState<{ player: 0 | 1; zone: StackZone } | null>(null);
  /** 多選（mulligan 換牌／攔網登場）＋攔網中央指定＋攔網選名佇列 */
  const [boardSel, setBoardSel] = useState<number[]>([]);
  const [blockCenter, setBlockCenter] = useState<number | null>(null);
  const [blockNames, setBlockNames] = useState<{ queue: { uid: number; names: string[] }[]; chosen: Record<number, string> } | null>(null);

  // ---- 演出視圖 → 擺位 ----
  const placements = useMemo(() => {
    const base = computePlacements(db, view.displayed, schools);
    if (!view.after || view.movedUids.size === 0) return base;
    return mergePlacements(base, computePlacements(db, view.after, schools), view.movedUids);
  }, [db, view.displayed, view.after, view.movedUids, schools[0], schools[1]]);

  // ---- 互動閘：佇列清空前不開放（spec §1.1） ----
  const engine: GameState = controller.engine;
  const pd = view.playing ? null : engine.pendingDecision;
  const myPd = pd && pd.player === HUMAN ? pd : null;
  const deployType = myPd && myPd.type in DEPLOY_ZONE ? (myPd.type as DeployType) : null;
  const zone = deployType ? DEPLOY_ZONE[deployType] : null;
  const draggableUids = useMemo(
    () => (zone ? new Set(deployableUids(db, engine, HUMAN, zone)) : new Set<number>()),
    [db, engine, zone],
  );
  const dropAnchor = zone ? zoneAnchor(HUMAN, zone) : null;

  // 決策切換時清空選取狀態
  useEffect(() => {
    setBoardSel([]);
    setBlockCenter(null);
    setBlockNames(null);
    setNamePick(null);
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
      default:
        return new Set<number>();
    }
  }, [db, engine, myPd, freeOpts]);
  const selectedUids = useMemo(() => new Set(boardSel), [boardSel]);

  const decide = useCallback(
    (decision: Decision): void => {
      try {
        controller.decide(decision);
      } catch (err) {
        console.error("[ui-lab] decide 失敗", err);
      }
      markPlaying();
    },
    [controller, markPlaying],
  );

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
              const next = cur.filter((u) => u !== uid);
              setBlockCenter((c) => (c === uid ? (next[0] ?? null) : c));
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
        default:
          break;
      }
    },
    [myPd, engine, decide, blockMax, freeOpts],
  );

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

  const toggleStack = useCallback((player: 0 | 1, zone: ZoneId): void => {
    if (!isStackZone(zone)) return;
    setExpandedStack((current) => (current?.player === player && current.zone === zone ? null : { player, zone }));
  }, []);

  // 放手在 canvas 外的保險
  useEffect(() => {
    if (draggingUid === null) return;
    window.addEventListener("pointerup", endDrag);
    return () => window.removeEventListener("pointerup", endDrag);
  }, [draggingUid, endDrag]);

  // 觀戰模式：演出空檔自動代打我方決策
  useEffect(() => {
    if (!autoPlay || view.playing || !controller.awaitingHuman) return;
    const t = window.setTimeout(() => decide(heuristicAiDecision(db, controller.engine)), 80);
    return () => window.clearTimeout(t);
  }, [autoPlay, view.playing, controller, db, decide, pd]);

  // ---- 顯示輔助 ----
  const banner = bannerOf(view.current, schools);
  const pushed = !!view.current && ["judge-revealed", "set-won", "match-won"].includes(view.current.event.kind);
  const gameOver = !view.playing && !engine.pendingDecision;
  const shown = view.displayed;
  const expandedGuts = expandedStack ? shown.players[expandedStack.player][expandedStack.zone].slice(0, -1).reverse() : [];
  /** hover 手牌的中央資訊匡：左卡圖、右繁中資訊；拖曳中不顯示 */
  const hoveredCard = hoveredUid !== null && draggingUid === null ? db.get(shown.cards[hoveredUid] ?? "") : undefined;
  const hoveredCardImg = hoveredCard ? cardFrontUrl(hoveredCard) : null;
  const opNote = engine.op && engine.op.owner !== HUMAN ? `對手 OP ${engine.op.value}——` : "";
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
                ? "自由步驟：可宣告技能／打出事件卡（點發亮的卡或下方選項），或結束步驟"
                : gameOver
                  ? `比賽結束——${engine.winner !== null ? schools[engine.winner] : "?"} 獲勝`
                  : myPd
                    ? (myPd.prompt ?? myPd.type)
                    : pd
                      ? "對手行動中…"
                      : "";

  return (
    // 尺寸關鍵容器用 inline style：R3F 以 ResizeObserver 量測容器，冷載入時 CSS module
    // 注入時序可能晚於首次量測（實測黑屏），inline 直接消除此時序依賴。
    <div className={styles.root} style={{ position: "fixed", inset: 0 }}>
      <Canvas
        className={styles.canvas}
        style={{ position: "absolute", inset: 0 }}
        camera={{ position: LAB_CAMERA_BASE, fov: 40 }}
        dpr={[1, 2]}
      >
        <color attach="background" args={["#0d1115"]} />
        <fog attach="fog" args={["#0d1115", 18, 34]} />
        <Suspense fallback={null}>
          <BoardScene
            placements={placements}
            origins={view.origins}
            draggableUids={draggableUids}
            selectableUids={selectableUids}
            selectedUids={selectedUids}
            onCardSelect={onCardSelect}
            draggingUid={draggingUid}
            dragPoint={dragPoint}
            hoveredUid={hoveredUid}
            onCardHover={setHoveredUid}
            dropZone={dropAnchor && draggingUid !== null ? { x: dropAnchor.x, z: dropAnchor.z, active: overZone } : null}
            onCardPointerDown={beginDrag}
            onDragMove={onDragMove}
            onDragEnd={endDrag}
            onStackToggle={toggleStack}
          />
          <RevealLayer reveal={view.reveal} />
        </Suspense>
        <PlaybackTicker tick={tick} />
        <CameraRig pushed={pushed} enabled={!orbit} />
        {orbit && <OrbitControls target={[0, 0, 0.6]} enablePan={false} minPolarAngle={0.15} maxPolarAngle={1.35} minDistance={6} maxDistance={20} />}
      </Canvas>

      {/* 左上：狀態列 */}
      <div className={styles.overlay}>
        <span className={styles.badge}>
          ui-lab<span className={styles.tag}>對局</span>
        </span>
        <span className={styles.hint}>
          第 {shown.setNo} 局・第 {shown.turnNo} 回合｜Set 卡 {schools[0]} {shown.players[0].setArea.length}－{shown.players[1].setArea.length} {schools[1]}
          <br />
          你＝{schools[0]}（近側）。對手＝AI；任何一手都可按「AI 代打」委託。
        </span>
        <a className={styles.link} href="./">
          ← 回經典介面
        </a>
      </div>

      {/* 右上：演出控制 */}
      <div className={styles.controls}>
        <button
          className={styles.btnGhost}
          onClick={() => {
            const next = speed === 1 ? 2 : 1;
            setSpeedState(next);
            setSpeed(next);
          }}
        >
          節奏 {speed}x
        </button>
        <button className={styles.btnGhost} onClick={() => setOrbit((o) => !o)}>
          {orbit ? "鎖定鏡頭" : "自由視角"}
        </button>
        <button className={autoPlay ? styles.btn : styles.btnGhost} data-testid="autoplay" onClick={() => setAutoPlay((a) => !a)}>
          {autoPlay ? "⏹ 停止代打" : "AI 代打到底"}
        </button>
      </div>

      {/* 右側：演出字幕 */}
      <div className={styles.subtitles}>
        {view.subtitles.map((s, i) => (
          <div key={`${i}-${s}`} className={i === view.subtitles.length - 1 ? styles.subLineHot : styles.subLine}>
            {s}
          </div>
        ))}
      </div>

      {/* 中央 banner */}
      {banner && (
        <div key={banner.text + view.subtitles.length} className={banner.heavy ? styles.bannerHeavy : styles.banner}>
          {banner.text}
        </div>
      )}

      {/* 右下：常駐決策控制器。所有可能出現的按鈕保留位置，只有當下合法操作會亮起。 */}
      <section className={styles.promptBar} aria-label="對局操作">
        <div className={styles.controlHeading}>對局操作</div>
        <div className={styles.promptText} aria-live="polite">{prompt || "等待下一個決策…"}</div>
        <div className={styles.actionGrid}>
          <button className={styles.btnGhost} data-testid="skip" disabled={!view.playing} onClick={skip}>
            跳過演出
          </button>
          <button
            className={styles.btnGhost}
            data-testid="auto-one"
            disabled={!myPd || !controller.awaitingHuman}
            onClick={() => myPd && controller.awaitingHuman && decide(heuristicAiDecision(db, engine))}
          >
            AI 代打
          </button>
          <button
            className={styles.btnDanger}
            disabled={!deployType && myPd?.type !== "deploy-block" && myPd?.type !== "free"}
            onClick={() => {
              if (deployType) decide({ type: deployType, uid: null } as Decision);
              else if (myPd?.type === "deploy-block") decide({ type: "deploy-block", uids: null });
              else if (myPd?.type === "free") decide({ type: "free", action: "lost" });
            }}
          >
            {myPd?.type === "free" ? "宣告 Lost" : "不登場"}
          </button>
          <button
            className={styles.btn}
            disabled={myPd?.type !== "defense-choice" || !canChooseBlock(engine)}
            onClick={() => myPd?.type === "defense-choice" && decide({ type: "defense-choice", choice: "block" })}
          >
            攔網
          </button>
          <button
            className={styles.btn}
            disabled={myPd?.type !== "defense-choice"}
            onClick={() => myPd?.type === "defense-choice" && decide({ type: "defense-choice", choice: "receive" })}
          >
            接球
          </button>
          <button
            className={styles.btn}
            disabled={myPd?.type !== "free" && myPd?.type !== "mulligan"}
            onClick={() => {
              if (myPd?.type === "free") decide({ type: "free", action: "pass" });
              else if (myPd?.type === "mulligan") decide({ type: "mulligan", returnUids: boardSel });
            }}
          >
            {myPd?.type === "mulligan" ? (boardSel.length ? `換 ${boardSel.length} 張` : "不換牌") : "結束步驟"}
          </button>
        </div>
        {/* 自由步驟的技能／事件選項列 */}
        {myPd?.type === "free" && (freeOpts.skills.length > 0 || freeOpts.events.length > 0) && (
          <div className={styles.freeOpts}>
            {freeOpts.skills.map((s) => (
              <button
                key={`s-${s.uid}-${s.skillIndex}`}
                className={styles.btnGhost}
                onClick={() => decide({ type: "free", action: "skill", uid: s.uid, skillIndex: s.skillIndex })}
              >
                ⚡ {s.label}
              </button>
            ))}
            {freeOpts.events.map((e) => (
              <button key={`e-${e.uid}`} className={styles.btnGhost} onClick={() => decide({ type: "free", action: "event", uid: e.uid })}>
                {e.label}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 場上疊放區：沿用經典介面的 Guts popover 心智模型，點場上卡或徽章開啟。 */}
      {expandedStack && expandedGuts.length > 0 && (
        <section className={styles.gutsPanel} role="dialog" aria-label={`${ZONE_LABEL[expandedStack.zone]} Guts`}>
          <div className={styles.gutsPanelHeader}>
            <div>
              <strong>{expandedStack.player === HUMAN ? "我方" : "對手"}{ZONE_LABEL[expandedStack.zone]}</strong>
              <span>Guts {expandedGuts.length}</span>
            </div>
            <button className={styles.btnGhost} onClick={() => setExpandedStack(null)}>關閉</button>
          </div>
          <div className={styles.gutsCards}>
            {expandedGuts.map((uid) => {
              const card = db.get(shown.cards[uid]!);
              const src = card ? cardFrontUrl(card) : null;
              return (
                <figure className={styles.gutsCard} key={uid}>
                  {src && <img src={src} alt={card?.nameZh || card?.nameJa || `卡片 ${uid}`} />}
                  <figcaption>{card?.nameZh || card?.nameJa || `卡片 ${uid}`}</figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      )}

      {/* hover 手牌：中央蓋板資訊匡（左＝卡牌大圖、右＝繁中資訊）。pointer-events:none */}
      {hoveredCard && (
        <section className={styles.cardInfo} aria-hidden>
          {hoveredCardImg ? (
            <img className={styles.cardInfoImg} src={hoveredCardImg} alt={hoveredCard.nameJa} />
          ) : (
            <div className={styles.cardInfoImgEmpty}>無卡圖</div>
          )}
          <div className={styles.cardInfoBody}>
            <div className={styles.cardInfoName}>
              {hoveredCard.nameZh ?? hoveredCard.nameJa}
              {hoveredCard.nameZh && <span>{hoveredCard.nameJa}</span>}
            </div>
            <div className={styles.cardInfoMeta}>
              {hoveredCard.type === "CHARACTER" ? "角色" : "事件"}｜{hoveredCard.affiliations.join("・")}
              {hoveredCard.positions.length > 0 ? `｜${hoveredCard.positions.join("/")}` : ""}
              {hoveredCard.grades.length > 0 ? `｜${hoveredCard.grades.join("/")}` : ""}
            </div>
            {hoveredCard.params && (
              <div className={styles.paramRow}>
                {(
                  [
                    ["發球", hoveredCard.params.serve],
                    ["攔網", hoveredCard.params.block],
                    ["接球", hoveredCard.params.receive],
                    ["托球", hoveredCard.params.toss],
                    ["攻擊", hoveredCard.params.attack],
                  ] as const
                ).map(([label, v]) => (
                  <div key={label} className={styles.paramCell}>
                    <span>{label}</span>
                    <strong>{v ?? "－"}</strong>
                  </div>
                ))}
              </div>
            )}
            {hoveredCard.timing.length > 0 && <div className={styles.cardInfoTiming}>時機：{hoveredCard.timing.join("・")}</div>}
            {(hoveredCard.skillZh ?? hoveredCard.skillJa) && (
              <div className={styles.cardInfoSkill}>
                {hoveredCard.skillZh ?? hoveredCard.skillJa}
                {hoveredCard.skillZhStatus === "machine" && <em>（機翻待確認）</em>}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ---- 決策蓋板（LP2/LP4/LP5）---- */}
      {myPd?.type === "serve-rights" && <ServeRightsModal onPick={(take) => decide({ type: "serve-rights", take })} />}
      {myPd?.type === "effect-confirm" && (
        <EffectConfirmModal prompt={myPd.prompt ?? "要使用效果嗎？"} onPick={(accept) => decide({ type: "effect-confirm", accept })} />
      )}
      {myPd?.type === "effect-option" && (
        <EffectOptionModal prompt={myPd.prompt ?? "選擇效果"} options={myPd.options ?? []} onPick={(index) => decide({ type: "effect-option", index })} />
      )}
      {myPd?.type === "resolve-pending" && (
        <ResolvePendingModal state={engine} candidates={myPd.candidates ?? []} onPick={(id) => decide({ type: "resolve-pending", id })} />
      )}
      {myPd?.type === "effect-cards" && (
        <EffectCardsPanel
          key={engine.log.length}
          db={db}
          state={engine}
          prompt={myPd.prompt ?? "選擇卡片"}
          candidates={myPd.candidates ?? []}
          min={myPd.min ?? 0}
          max={myPd.max ?? (myPd.candidates?.length ?? 0)}
          onConfirm={(uids) => decide({ type: "effect-cards", uids })}
        />
      )}
      {myPd?.type === "deploy-block" && !blockNames && (
        <BlockPickPanel
          db={db}
          state={engine}
          selected={boardSel}
          center={blockCenter}
          max={blockMax}
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
      {gameOver && (
        <SettlementModal
          winner={engine.winner}
          schools={schools}
          setCards={[engine.players[0].setArea.length, engine.players[1].setArea.length]}
          onRematch={props.onRematch}
          onExit={props.onExit}
        />
      )}
    </div>
  );
}

export default function UiLabApp(): React.JSX.Element {
  const db: CardDb = useMemo(() => new Map((cardsJson as unknown as Card[]).map((c) => [c.id, c])), []);
  const [session, setSession] = useState<{ decks: [LabDeck, LabDeck]; baseSeed: number; round: number } | null>(null);
  if (!session) {
    return <LabMenu onStart={(decks) => setSession({ decks, baseSeed: (Date.now() % 1000000) + 1, round: 0 })} />;
  }
  const seed = session.baseSeed + session.round * 7919;
  return (
    <LabGame
      key={seed}
      db={db}
      decks={session.decks}
      seed={seed}
      onRematch={() => setSession({ ...session, round: session.round + 1 })}
      onExit={() => setSession(null)}
    />
  );
}
