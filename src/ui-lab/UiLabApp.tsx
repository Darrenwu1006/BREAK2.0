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
import { HUMAN, LabGameController } from "./game/controller";
import { usePlayback } from "./game/usePlayback";
import { BoardScene } from "./scene/BoardScene";
import { CameraRig } from "./scene/CameraRig";
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
const DEPLOY_ZONE: Record<DeployType, "serve" | "receive" | "toss" | "attack"> = {
  "deploy-serve": "serve",
  "deploy-receive": "receive",
  "deploy-toss": "toss",
  "deploy-attack": "attack",
};
const DEPLOY_PROMPT: Record<DeployType, string> = {
  "deploy-serve": "發球登場：拖曳手牌到發光區（不登場＝Lost）",
  "deploy-receive": "接球登場：拖曳手牌到發光區",
  "deploy-toss": "托球登場：拖曳手牌到發光區",
  "deploy-attack": "攻擊登場：拖曳手牌到發光區",
};

/** 中央 banner（宣言/得分類事件演出中顯示）；null＝不顯示 */
function bannerOf(entry: TimelineEntry | null, schools: [string, string]): { text: string; heavy: boolean } | null {
  if (!entry) return null;
  const e = entry.event;
  switch (e.kind) {
    case "skill-declared":
      return { text: `⚡ スキル：${e.name}`, heavy: false };
    case "event-played":
      return { text: `イベント：${e.name}`, heavy: false };
    case "defense-chosen":
      return { text: e.choice === "block" ? "ブロック宣言！" : "レシーブ宣言！", heavy: false };
    case "lost-declared":
      return { text: `${schools[e.player]} Lost…`, heavy: false };
    case "set-won":
      return { text: `第 ${e.setNo} セット——${schools[e.winner]} 先取！`, heavy: true };
    case "match-won":
      return { text: `試合終了——${schools[e.winner]} 勝利！`, heavy: true };
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

  // ---- 互動狀態（拖曳） ----
  const dragPoint = useRef(new THREE.Vector3());
  const overRef = useRef(false);
  const [draggingUid, setDraggingUid] = useState<number | null>(null);
  const [overZone, setOverZone] = useState(false);
  const [namePick, setNamePick] = useState<{ uid: number; names: string[] } | null>(null);
  const [speed, setSpeedState] = useState(1);
  const [orbit, setOrbit] = useState(false);

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

  // ---- 拖曳流程 ----
  const beginDrag = useCallback(
    (uid: number): void => {
      const p = placements.cards.get(uid);
      if (p) dragPoint.current.set(p.position[0], p.position[1], p.position[2]);
      overRef.current = false;
      setOverZone(false);
      setDraggingUid(uid);
    },
    [placements],
  );

  const onDragMove = useCallback(
    (x: number, z: number): void => {
      dragPoint.current.set(x, dragPoint.current.y, z);
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
    document.body.style.cursor = "";
    setDraggingUid((uid) => {
      if (uid !== null && overRef.current && deployType) {
        const names = deployNames(db, engine, uid);
        if (names && names.length > 1) setNamePick({ uid, names });
        else decide({ type: deployType, uid } as Decision);
      }
      return null;
    });
    overRef.current = false;
    setOverZone(false);
  }, [db, engine, deployType, decide]);

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
  const opNote = engine.op && engine.op.owner !== HUMAN ? `對手 OP ${engine.op.value}——` : "";
  const prompt = view.playing
    ? "演出中…"
    : deployType
      ? `${deployType === "deploy-receive" ? opNote : ""}${DEPLOY_PROMPT[deployType]}`
      : pd?.type === "defense-choice"
        ? `${opNote}這一 turn 走攔網還是接球？`
        : gameOver
          ? `試合終了——${engine.winner !== null ? SCHOOLS[engine.winner] : "?"} 勝利`
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
        camera={{ position: [0, 8.8, 8.6], fov: 40 }}
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
            dropZone={dropAnchor && draggingUid !== null ? { x: dropAnchor.x, z: dropAnchor.z, active: overZone } : null}
            onCardPointerDown={beginDrag}
            onDragMove={onDragMove}
            onDragEnd={endDrag}
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
          第 {shown.setNo} セット・turn {shown.turnNo}｜Set 卡 {SCHOOLS[0]} {shown.players[0].setArea.length}－{shown.players[1].setArea.length} {SCHOOLS[1]}
          <br />
          你＝{SCHOOLS[0]}（近側）。對手與未實裝決策由 AI 代打。
        </span>
        <a className={styles.link} href="./">
          ← 回經典介面
        </a>
      </div>

      {/* 右上：演出控制 */}
      <div className={styles.controls}>
        {view.playing && (
          <button className={styles.btnGhost} data-testid="skip" onClick={skip}>
            跳過演出 ⏭
          </button>
        )}
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

      {/* 底部：決策列 */}
      <div className={styles.promptBar}>
        <span className={styles.promptText}>{prompt}</span>
        {deployType && (
          <button className={styles.btnDanger} onClick={() => decide({ type: deployType, uid: null } as Decision)}>
            不登場
          </button>
        )}
        {pd && controller.awaitingHuman && (
          <button className={styles.btnGhost} data-testid="auto-one" onClick={() => decide(heuristicAiDecision(db, engine))}>
            AI 代打此手
          </button>
        )}
        {pd?.type === "defense-choice" && (
          <>
            <button className={styles.btn} disabled={!canChooseBlock(engine)} onClick={() => decide({ type: "defense-choice", choice: "block" })}>
              ブロック
            </button>
            <button className={styles.btn} onClick={() => decide({ type: "defense-choice", choice: "receive" })}>
              レシーブ
            </button>
          </>
        )}
        {gameOver && (
          <button className={styles.btn} onClick={props.onRestart}>
            再來一場
          </button>
        )}
      </div>

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
