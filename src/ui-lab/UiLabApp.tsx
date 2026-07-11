// M9a CP4 ui-lab 入口：可玩的互動切片（雙入口並行，spec §0：?ui=lab、與 src/ui/ 完全隔離）。
// 人類＝P0（烏野）：deploy-serve/receive/toss/attack 拖曳登場＋defense-choice 二選一；
// 其餘決策型別由 heuristic 代打（spec §4 過渡期允許），對手 P1＝heuristic AI。
// 架構：LabGameController（邏輯即時）→ PresentationTimeline → usePlayback（演出視圖）→ BoardScene（R3F）。
// 鏡頭固定＋關鍵揭示微推近；「自由視角」按鈕僅供構圖檢查。

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import cardsJson from "../../data/cards.json";
import karasunoDeck from "../../data/decks/烏野-預組.json";
import nekomaDeck from "../../data/decks/音駒-預組.json";
import { heuristicAiDecision } from "../ai/heuristic";
import type { Card } from "../data/types";
import { canChooseBlock, deployNames, deployableUids } from "../engine/engine";
import type { CardDb, Decision, GameState } from "../engine/types";
import { cardFrontUrl } from "./assets";
import { HUMAN, LabGameController } from "./game/controller";
import { usePlayback } from "./game/usePlayback";
import type { ZoneId } from "./presentation/events";
import { ZONE_LABEL } from "./presentation/textRenderer";
import { BoardScene } from "./scene/BoardScene";
import { CameraRig, LAB_CAMERA_BASE } from "./scene/CameraRig";
import { zoneAnchor } from "./scene/layout";
import { computePlacements, mergePlacements } from "./scene/placements";
import { RevealLayer } from "./scene/RevealLayer";
import type { TimelineEntry } from "./presentation/timeline";
import styles from "./UiLabApp.module.css";

interface DeckJson {
  name: string;
  school: string;
  cards: { id: string; count: number }[];
}
const expand = (d: DeckJson): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

const KARASUNO = karasunoDeck as DeckJson;
const NEKOMA = nekomaDeck as DeckJson;
const SCHOOLS: [string, string] = [KARASUNO.school, NEKOMA.school];

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

function LabGame(props: { db: CardDb; seed: number; onRestart: () => void }): React.JSX.Element {
  const { db, seed } = props;
  const controller = useMemo(() => new LabGameController(db, [expand(KARASUNO), expand(NEKOMA)], seed), [db, seed]);
  const { view, tick, markPlaying, skip, setSpeed } = usePlayback(controller, db);

  // ---- 互動狀態（拖曳／點擊出牌／hover） ----
  const dragPoint = useRef(new THREE.Vector3());
  const overRef = useRef(false);
  /** 點擊 vs 拖曳判別：pointerdown 起算時間＋首個拖曳點＋是否已位移 */
  const dragMeta = useRef({ t: 0, firstX: null as number | null, firstZ: 0, moved: false });
  /** draggingUid 的同步鏡像：事件 handler 內的判定不能依賴 setState updater
   *（React 批次會讓 updater 晚於 handler 尾段執行，屆時 overRef 已被重置） */
  const draggingRef = useRef<number | null>(null);
  const [draggingUid, setDraggingUid] = useState<number | null>(null);
  const [overZone, setOverZone] = useState(false);
  const [hoveredUid, setHoveredUid] = useState<number | null>(null);
  const [namePick, setNamePick] = useState<{ uid: number; names: string[] } | null>(null);
  const [speed, setSpeedState] = useState(1);
  const [orbit, setOrbit] = useState(false);
  const [expandedStack, setExpandedStack] = useState<{ player: 0 | 1; zone: StackZone } | null>(null);

  // ---- 演出視圖 → 擺位 ----
  const placements = useMemo(() => {
    const base = computePlacements(db, view.displayed, SCHOOLS);
    if (!view.after || view.movedUids.size === 0) return base;
    return mergePlacements(base, computePlacements(db, view.after, SCHOOLS), view.movedUids);
  }, [db, view.displayed, view.after, view.movedUids]);

  // ---- 互動閘：佇列清空前不開放（spec §1.1） ----
  const engine: GameState = controller.engine;
  const pd = view.playing ? null : engine.pendingDecision;
  const deployType = pd && pd.player === HUMAN && pd.type in DEPLOY_ZONE ? (pd.type as DeployType) : null;
  const zone = deployType ? DEPLOY_ZONE[deployType] : null;
  const draggableUids = useMemo(
    () => (zone ? new Set(deployableUids(db, engine, HUMAN, zone)) : new Set<number>()),
    [db, engine, zone],
  );
  const dropAnchor = zone ? zoneAnchor(HUMAN, zone) : null;

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
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__labDrag = { x, z, over, anchor: dropAnchor };
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
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__labEnd = { uid, deployType, over, isClick, at: Date.now() };
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

  // ---- 顯示輔助 ----
  const banner = bannerOf(view.current, SCHOOLS);
  const pushed = !!view.current && ["judge-revealed", "set-won", "match-won"].includes(view.current.event.kind);
  const gameOver = !view.playing && !engine.pendingDecision;
  const shown = view.displayed;
  const expandedGuts = expandedStack ? shown.players[expandedStack.player][expandedStack.zone].slice(0, -1).reverse() : [];
  /** hover 手牌的中央資訊匡（[使用者 2026-07-11]）：左卡圖、右繁中資訊；拖曳中不顯示 */
  const hoveredCard = hoveredUid !== null && draggingUid === null ? db.get(shown.cards[hoveredUid] ?? "") : undefined;
  const hoveredCardImg = hoveredCard ? cardFrontUrl(hoveredCard) : null;
  const opNote = engine.op && engine.op.owner !== HUMAN ? `對手 OP ${engine.op.value}——` : "";
  const prompt = view.playing
    ? "演出中…"
    : deployType
      ? `${deployType === "deploy-receive" ? opNote : ""}${DEPLOY_PROMPT[deployType]}`
      : pd?.type === "defense-choice"
        ? `${opNote}這一 turn 走攔網還是接球？`
        : gameOver
          ? `比賽結束——${engine.winner !== null ? SCHOOLS[engine.winner] : "?"} 獲勝`
          : pd
            ? `${pd.prompt ?? pd.type}（AI 代打型別，M9b 補齊）`
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
          ui-lab<span className={styles.tag}>M9a 互動切片</span>
        </span>
        <span className={styles.hint}>
          第 {shown.setNo} 局・第 {shown.turnNo} 回合｜Set 卡 {SCHOOLS[0]} {shown.players[0].setArea.length}－{shown.players[1].setArea.length} {SCHOOLS[1]}
          <br />
          你＝{SCHOOLS[0]}（近側）。本畫面直接接共用規則引擎；對手與未實裝決策由 AI 代打。
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
            disabled={!pd || !controller.awaitingHuman}
            onClick={() => pd && controller.awaitingHuman && decide(heuristicAiDecision(db, engine))}
          >
            AI 代打
          </button>
          <button
            className={styles.btnDanger}
            disabled={!deployType}
            onClick={() => deployType && decide({ type: deployType, uid: null } as Decision)}
          >
            不登場
          </button>
          <button
            className={styles.btn}
            disabled={pd?.type !== "defense-choice" || !canChooseBlock(engine)}
            onClick={() => pd?.type === "defense-choice" && decide({ type: "defense-choice", choice: "block" })}
          >
            攔網
          </button>
          <button
            className={styles.btn}
            disabled={pd?.type !== "defense-choice"}
            onClick={() => pd?.type === "defense-choice" && decide({ type: "defense-choice", choice: "receive" })}
          >
            接球
          </button>
          <button className={styles.btnGhost} disabled={!gameOver} onClick={props.onRestart}>
            再來一場
          </button>
        </div>
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

      {/* hover 手牌：中央蓋板資訊匡（左＝卡牌大圖、右＝繁中資訊）。pointer-events:none
          ——純檢視層，不攔截 canvas hover，樣式屬第一版、待使用者回饋再修 */}
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

      {/* 選名彈窗（072/073） */}
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
    </div>
  );
}

export default function UiLabApp(): React.JSX.Element {
  const db: CardDb = useMemo(() => new Map((cardsJson as unknown as Card[]).map((c) => [c.id, c])), []);
  const [round, setRound] = useState(0);
  const seed = 20260710 + round;
  return <LabGame key={seed} db={db} seed={seed} onRestart={() => setRound((r) => r + 1)} />;
}
