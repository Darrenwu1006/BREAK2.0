// M9a ui-lab 入口（雙入口並行，spec §0）：?ui=lab 進入，與 src/ui/ 完全隔離的元件樹。
// CP3 場景基線：3D 桌面＋透視微俯角相機＋卡牌 mesh，以 demo 對局擺一個 rally 中段的盤面。
// OrbitControls 僅供基線構圖討論用（拖動視角檢視），正式手感版將鎖定鏡頭。

import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense, useMemo } from "react";
import cardsJson from "../../data/cards.json";
import karasunoDeck from "../../data/decks/烏野-預組.json";
import nekomaDeck from "../../data/decks/音駒-預組.json";
import type { Card } from "../data/types";
import { applyDecision, createGame } from "../engine/engine";
import type { CardDb, GameState } from "../engine/types";
import { heuristicAiDecision } from "../ai/heuristic";
import { BoardScene } from "./scene/BoardScene";
import styles from "./UiLabApp.module.css";

interface DeckJson {
  name: string;
  school: string;
  cards: { id: string; count: number }[];
}

const expand = (d: DeckJson): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

/** 推進 demo 對局到「rally 中段」：雙方球場都有卡、攻擊手已登場的熱鬧時點 */
function buildDemoState(db: CardDb): GameState {
  const courtCount = (s: GameState, p: 0 | 1): number => {
    const ps = s.players[p];
    return ps.serve.length + ps.receive.length + ps.toss.length + ps.attack.length + ps.blockCenter.length + ps.blockSides.length;
  };
  let s = createGame(db, { seed: 20260710, decks: [expand(karasunoDeck as DeckJson), expand(nekomaDeck as DeckJson)] });
  let best = s;
  let bestScore = -1;
  for (let i = 0; i < 400 && s.phase !== "gameOver"; i++) {
    s = applyDecision(db, s, heuristicAiDecision(db, s));
    const tp = s.players[s.turnPlayer];
    const busy = courtCount(s, 0) >= 2 && courtCount(s, 1) >= 2;
    if (busy && s.phase === "attack" && tp.attack.length > 0) return s;
    // 退而求其次：挑整局裡最熱鬧的盤面（雙方場上卡最多、攻擊階段加分）
    const score = courtCount(s, 0) + courtCount(s, 1) + (s.phase === "attack" ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

export default function UiLabApp(): React.JSX.Element {
  const db: CardDb = useMemo(() => new Map((cardsJson as unknown as Card[]).map((c) => [c.id, c])), []);
  const state = useMemo(() => buildDemoState(db), [db]);
  const schools: [string, string] = [(karasunoDeck as DeckJson).school, (nekomaDeck as DeckJson).school];

  return (
    <div className={styles.root}>
      <Canvas className={styles.canvas} camera={{ position: [0, 8.8, 8.6], fov: 40 }} dpr={[1, 2]}>
        <color attach="background" args={["#0d1115"]} />
        <fog attach="fog" args={["#0d1115", 18, 34]} />
        <Suspense fallback={null}>
          <BoardScene db={db} state={state} schools={schools} />
        </Suspense>
        <OrbitControls target={[0, 0, 0.6]} enablePan={false} minPolarAngle={0.15} maxPolarAngle={1.35} minDistance={6} maxDistance={20} />
      </Canvas>
      <div className={styles.overlay}>
        <span className={styles.badge}>
          ui-lab<span className={styles.tag}>M9a 場景基線</span>
        </span>
        <span className={styles.hint}>
          demo 盤面：{(karasunoDeck as DeckJson).school} vs {(nekomaDeck as DeckJson).school}（rally 中段快照）。
          滑鼠拖曳＝轉視角、滾輪＝縮放——僅基線檢視用，正式版鏡頭固定。
        </span>
        <a className={styles.link} href="./">
          ← 回經典介面
        </a>
      </div>
    </div>
  );
}
