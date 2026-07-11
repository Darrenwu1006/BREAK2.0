// M9a CP4 卡牌動畫殼：對 placement 目標做臨界阻尼緩動＋遠距移動的飛行弧線；
// 拖曳中改跟隨 dragPoint（高阻尼跟手＋速度傾斜＝爐石式「捏著卡」的物性）。
// 動畫全在 useFrame 命令式跑，不經 React state——目標改變才觸發 re-render。

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useRef } from "react";
import * as THREE from "three";
import { CardMesh } from "./CardMesh";
import { GlowFrame } from "./GlowFrame";
import { CARD_H, CARD_W } from "./layout";
import type { CardPlacement } from "./placements";

/** 拖曳平面高度（卡被「拿起來」的高度） */
export const DRAG_Y = 1.35;

export interface AnimatedCardProps {
  placement: CardPlacement;
  /** 可拖曳／可選取提示：微升＋卡緣邊框脈動 */
  highlighted?: boolean;
  /** 已選取（mulligan 換牌、攔網多選）：金色定亮邊框 */
  selected?: boolean;
  /** hover 拉出（手牌檢視）：明顯上抬＋拉向鏡頭＋放大 */
  hovered?: boolean;
  /** 拖曳中：跟隨 dragPoint（mutable ref，pointer move 直寫、不觸發 render） */
  dragging?: boolean;
  dragPoint?: React.RefObject<THREE.Vector3>;
  /** 新掛載卡的出生點（抽牌從牌組頂飛出等）；僅首幀生效 */
  spawnFrom?: [number, number, number];
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOver?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: (e: ThreeEvent<PointerEvent>) => void;
}

const { damp, clamp } = THREE.MathUtils;

export function AnimatedCard(props: AnimatedCardProps): React.JSX.Element {
  const group = useRef<THREE.Group>(null);
  const cur = useRef<THREE.Vector3 | null>(null);
  const rot = useRef(new THREE.Euler());
  const prev = useRef(new THREE.Vector3());
  const flight = useRef({ key: "", total: 0 });

  useFrame((_, dtRaw) => {
    const g = group.current;
    if (!g) return;
    const dt = Math.min(dtRaw, 0.05);
    const p = props.placement;

    if (!cur.current) {
      cur.current = new THREE.Vector3(...(props.spawnFrom ?? p.position));
      rot.current.set(...p.rotation);
      prev.current.copy(cur.current);
    }
    const c = cur.current;

    // ---- 目標 ----
    let [tx, ty, tz] = p.position;
    let [rx, ry, rz] = p.rotation;
    if (props.dragging && props.dragPoint?.current) {
      const dp = props.dragPoint.current;
      tx = dp.x;
      ty = DRAG_Y;
      tz = dp.z;
    } else if (props.hovered) {
      // [使用者 2026-07-11 LP0] 手牌 hover 沿「卡面內」方向滑出（placement.hoverOffset）——
      // 與鄰卡保持平行平面、幾何上不可能打架；平放卡（無 offset）退回世界座標抬升。
      const [ox, oy, oz] = p.hoverOffset ?? [0, 0.5, 0.1];
      tx += ox;
      ty += oy;
      tz += oz;
    } else if (props.highlighted) {
      const [ox, oy, oz] = p.highlightOffset ?? [0, 0.16, 0.05];
      tx += ox;
      ty += oy;
      tz += oz;
    }

    // ---- 飛行弧線簿記：目標換了才重算航程 ----
    const key = `${tx.toFixed(2)},${tz.toFixed(2)},${props.dragging ? "d" : "s"}`;
    if (key !== flight.current.key) {
      flight.current.key = key;
      flight.current.total = props.dragging ? 0 : Math.hypot(tx - c.x, tz - c.z);
    }

    // ---- 位置緩動 ----
    const lambda = props.dragging ? 22 : 8.5;
    c.x = damp(c.x, tx, lambda, dt);
    c.y = damp(c.y, ty, lambda, dt);
    c.z = damp(c.z, tz, lambda, dt);

    // 遠距移動加拋物線弧（登場/棄牌的「飛過去」）
    let arc = 0;
    const total = flight.current.total;
    if (total > 0.6) {
      const remain = Math.hypot(tx - c.x, tz - c.z);
      const prog = 1 - Math.min(remain / total, 1);
      arc = Math.min(1.1, 0.28 * total + 0.12) * 4 * prog * (1 - prog);
    }

    // ---- 速度→拖曳傾斜（跟手物性的關鍵） ----
    const vx = (c.x - prev.current.x) / dt;
    const vz = (c.z - prev.current.z) / dt;
    prev.current.set(c.x, c.y, c.z);
    if (props.dragging) {
      rx = 0.5 + clamp(vz * 0.05, -0.4, 0.4);
      ry = 0;
      rz = clamp(-vx * 0.05, -0.4, 0.4);
    }
    const rl = props.dragging ? 15 : 9;
    rot.current.x = damp(rot.current.x, rx, rl, dt);
    rot.current.y = damp(rot.current.y, ry, rl, dt);
    rot.current.z = damp(rot.current.z, rz, rl, dt);

    g.position.set(c.x, c.y + arc, c.z);
    g.rotation.copy(rot.current);
    const s = damp(g.scale.x, props.dragging ? 1.07 : props.hovered ? 1.12 : 1, 12, dt);
    g.scale.setScalar(s);

  });

  return (
    <group ref={group} position={props.spawnFrom ?? props.placement.position} rotation={props.placement.rotation}>
      {/* 卡內 Suspense：新卡貼圖載入只讓「這張卡」晚一拍出現，不觸發外層 fallback 整場閃黑 */}
      <Suspense fallback={null}>
        <CardMesh
          frontUrl={props.placement.frontUrl}
          backUrl={props.placement.backUrl}
          faceUp={props.placement.faceUp}
          position={[0, 0, 0]}
          onPointerDown={props.onPointerDown}
          onPointerOver={props.onPointerOver}
          onPointerOut={props.onPointerOut}
        />
      </Suspense>
      {/* 可拖曳／可選取提示：卡緣邊框脈動（回饋 #6——光收在邊框、不溢出） */}
      <GlowFrame width={CARD_W} height={CARD_H} visible={!!props.highlighted && !props.selected && !props.dragging} position={[0, -0.012, 0]} opacityRange={[0.4, 0.85]} />
      {/* 已選取：金色定亮 */}
      <GlowFrame width={CARD_W} height={CARD_H} visible={!!props.selected} color="#ffd45e" opacityRange={[0.8, 0.95]} position={[0, -0.012, 0]} />
    </group>
  );
}
