// M9a CP4 卡牌動畫殼：對 placement 目標做臨界阻尼緩動＋遠距移動的飛行弧線；
// 拖曳中改跟隨 dragPoint（高阻尼跟手＋速度傾斜＝爐石式「捏著卡」的物性）。
// 動畫全在 useFrame 命令式跑，不經 React state——目標改變才觸發 re-render。

import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, useTexture } from "@react-three/drei";
import { Suspense, useRef } from "react";
import * as THREE from "three";
import { CardMesh } from "./CardMesh";
import { CARD_H, CARD_W } from "./layout";
import type { CardPlacement } from "./placements";

/** 拖曳平面高度（卡被「拿起來」的高度） */
export const DRAG_Y = 1.35;

export interface AnimatedCardProps {
  placement: CardPlacement;
  /** 可拖曳／可選取提示：微升＋卡緣邊框脈動 */
  highlighted?: boolean;
  /** highlight 呼吸燈色（黑↔此色）；通常＝該卡持有者的學校色。 */
  highlightColor?: string;
  /** 技能來源／結算焦點：優先於一般選取與可操作提示 */
  emphasized?: boolean;
  /** 已選取（mulligan 換牌、攔網多選）：金色定亮邊框 */
  selected?: boolean;
  /** hover 拉出（手牌檢視）：明顯上抬＋拉向鏡頭＋放大 */
  hovered?: boolean;
  /** 拖曳中：跟隨 dragPoint（mutable ref，pointer move 直寫、不觸發 render） */
  dragging?: boolean;
  dragPoint?: React.RefObject<THREE.Vector3>;
  /** 新掛載卡的出生點（抽牌從牌組頂飛出等）；僅首幀生效 */
  spawnFrom?: [number, number, number];
  shortcutLabel?: string;
  /** 閱讀／選牌面會隱藏卡上數值與快捷徽章，避免壓住候選。 */
  showBadges?: boolean;
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOver?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: (e: ThreeEvent<PointerEvent>) => void;
}

const { damp, clamp } = THREE.MathUtils;

export function AnimatedCard(props: AnimatedCardProps): React.JSX.Element {
  // Pre-load textures to suspend AnimatedCard until textures are ready,
  // ensuring the animation starts only after loading is complete.
  useTexture(
    [props.placement.frontUrl ?? props.placement.backUrl, props.placement.backUrl],
    (textures) => {
      for (const t of Array.isArray(textures) ? textures : [textures]) {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 16;
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
      }
    }
  );

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
    } else if (props.selected) {
      // [使用者 2026-07-12] #1 方案 B：已選取＝綠框＋明顯抬起（沿卡面內方向拉出，
      // 幅度大於 highlight、接近 hover——「被抽出來」的實體選牌感）。
      const [hx, hy, hz] = p.hoverOffset ?? [0, 0.4, 0.1];
      tx += hx * 0.75;
      ty += hy * 0.75;
      tz += hz * 0.75;
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

  // [使用者 2026-07-11] highlight/selected 直接染在卡邊框上（CardMesh cap），不再另疊 GlowFrame。
  const showEmphasis = !!props.emphasized && !props.dragging;
  const showHighlight = !!props.highlighted && !props.selected && !showEmphasis && !props.dragging;
  // highlight 走 glowColor（黑↔學校色呼吸），emphasis/selected 仍直接染邊框。
  // [使用者 2026-07-12] #1 提案：selected＝實心「已選取綠」（非呼吸、非橘），語意明確；
  //   與 highlight（黑↔學校色呼吸）、emphasis（橘）三態清楚區分。
  const borderColor = showEmphasis ? "#ff7a3d" : props.selected ? "#22c55e" : undefined;
  const glowColor = showHighlight ? (props.highlightColor ?? "#59c8ff") : undefined;

  return (
    <group ref={group} position={props.spawnFrom ?? props.placement.position} rotation={props.placement.rotation}>
      {/* 卡內 Suspense：新卡貼圖載入只讓「這張卡」晚一拍出現，不觸發外層 fallback 整場閃黑 */}
      <Suspense fallback={null}>
        <CardMesh
          frontUrl={props.placement.frontUrl}
          backUrl={props.placement.backUrl}
          faceUp={props.placement.faceUp}
          position={[0, 0, 0]}
          borderColor={borderColor}
          glowColor={glowColor}
          borderGlow={showHighlight || showEmphasis}
          onPointerDown={props.onPointerDown}
          onPointerOver={props.onPointerOver}
          onPointerOut={props.onPointerOut}
        />
      </Suspense>
      {props.showBadges !== false && props.shortcutLabel && (
        <Html position={[CARD_W / 2 - 0.12, 0.04, -CARD_H / 2 + 0.12]} center style={{ pointerEvents: "none" }} zIndexRange={[4, 0]}>
          <span className="ui-lab-hand-shortcut">{props.shortcutLabel}</span>
        </Html>
      )}
      {props.showBadges !== false && props.placement.effectiveValue !== undefined && props.placement.effectiveValue !== null && (
        <Html position={[-CARD_W / 2 + 0.12, 0.045, -CARD_H / 2 + 0.12]} center style={{ pointerEvents: "none" }} zIndexRange={[4, 0]}>
          <span className={`ui-lab-effective-value ${props.placement.baseValue !== props.placement.effectiveValue ? "is-modified" : ""}`}>
            {props.placement.baseValue ?? props.placement.effectiveValue}
            {props.placement.baseValue !== null && props.placement.baseValue !== undefined && props.placement.baseValue !== props.placement.effectiveValue && (
              <small>{props.placement.effectiveValue - props.placement.baseValue > 0 ? "+" : ""}{props.placement.effectiveValue - props.placement.baseValue}</small>
            )}
          </span>
        </Html>
      )}
    </group>
  );
}
