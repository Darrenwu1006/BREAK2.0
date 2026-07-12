// 卡牌 mesh：圓角輪廓＋單層邊框（spec §2.1）＋紙側面厚度。
// 幾何＝圓角 extrude「卡身」（頂/底 cap＝邊框、側牆＝紙色邊）＋兩張略內縮的圓角貼圖面；
// cap 從內縮面周圍露出一圈＝單層邊框，輪廓圓角來自 extrude shape。
// [使用者 2026-07-11] 邊框加粗一倍；highlight/selected 直接做在邊框上（cap 變色＋發光脈動），
// 不再另疊 GlowFrame。幾何對所有卡相同、模組載入建一次共用；每卡只換材質。

import { useTexture } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { CARD_H, CARD_T, CARD_W } from "./layout";

export const EDGE_COLOR = "#e9e3d5"; // 紙側面
export const BORDER_COLOR = "#141210"; // 單層細邊框（近黑）
/** 圓角半徑（世界單位；依鏡頭距離與實機觀感調整，不鎖死裝置像素） */
export const CORNER_R = 0.07;
/** 邊框視覺粗細（cap 從內縮貼圖面露出的一圈）——[使用者 2026-07-11] 加粗一倍。 */
export const BORDER_W = 0.036;

/** 置中的圓角矩形輪廓（共用給卡身、貼圖面、牌堆） */
export function roundedShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.min(r, w / 2, h / 2);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

/** 圓角貼圖面：躺平於 XZ、法線 +Y；UV 重映射到 bounding box 0..1（否則 ShapeGeometry 以世界座標當 UV） */
export function faceGeometry(w: number, h: number, r: number): THREE.BufferGeometry {
  const geo = new THREE.ShapeGeometry(roundedShape(w, h, r), 16);
  const pos = geo.attributes.position!;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uvs[i * 2] = (pos.getX(i) + w / 2) / w;
    uvs[i * 2 + 1] = (pos.getY(i) + h / 2) / h;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.rotateX(-Math.PI / 2); // XY 面（法線 +Z）→ XZ 面（法線 +Y）
  return geo;
}

/** 卡身：圓角 extrude，厚度沿 Y 置中；材質群組 0＝頂/底 cap、1＝側牆 */
const BODY_GEO = (() => {
  const geo = new THREE.ExtrudeGeometry(roundedShape(CARD_W, CARD_H, CORNER_R), {
    depth: CARD_T,
    bevelEnabled: false,
    curveSegments: 16,
  });
  geo.translate(0, 0, -CARD_T / 2);
  geo.rotateX(-Math.PI / 2); // extrude 沿 +Z → 厚度沿 +Y
  return geo;
})();

const FACE_GEO = faceGeometry(CARD_W - 2 * BORDER_W, CARD_H - 2 * BORDER_W, Math.max(CORNER_R - BORDER_W, 0.02));

export interface CardMeshProps {
  /** 正面貼圖；null＝素面（無卡圖資料） */
  frontUrl: string | null;
  backUrl: string;
  faceUp: boolean;
  position: [number, number, number];
  /** 弧度；P1 的卡通常 rotY=π（面向對手） */
  rotation?: [number, number, number];
  /** 邊框顏色（selected/emphasis 直接染在邊框上）；未給＝預設近黑 */
  borderColor?: string;
  /** 呼吸燈色（highlight 提示）：邊框保持黑底，emissive 在黑↔此色間脈動（[使用者 2026-07-12]）。 */
  glowColor?: string;
  /** 邊框發光脈動（可拖曳/可選取提示） */
  borderGlow?: boolean;
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOver?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: (e: ThreeEvent<PointerEvent>) => void;
}

export function CardMesh(props: CardMeshProps): React.JSX.Element {
  // useTexture 不可條件呼叫：素面卡以卡背佔位，正面材質改用純色
  const [front, back] = useTexture([props.frontUrl ?? props.backUrl, props.backUrl], (textures) => {
    for (const t of Array.isArray(textures) ? textures : [textures]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 16;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
    }
  });

  const capRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const borderColor = props.borderColor ?? BORDER_COLOR;
  const glowColor = props.glowColor ?? null;
  const active = !!props.borderColor || !!glowColor; // 有 highlight/selected/emphasis 染色或呼吸

  const { bodyMats, topMat, bottomMat } = useMemo(() => {
    const faceOf = (tex: THREE.Texture | null): THREE.MeshStandardMaterial =>
      tex
        ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.98, metalness: 0 })
        : new THREE.MeshStandardMaterial({ color: "#f5f0e4", roughness: 0.98, metalness: 0 });
    const topTex = props.faceUp ? (props.frontUrl ? (front ?? null) : null) : (back ?? null);
    const bottomTex = props.faceUp ? (back ?? null) : props.frontUrl ? (front ?? null) : null;
    // 呼吸燈（glowColor）：cap 底色保持近黑，emissive 才是學校色 → 脈動時黑↔色。
    // selected/emphasis（borderColor）：cap 直接染色。
    const capColor = glowColor ? BORDER_COLOR : borderColor;
    const cap = new THREE.MeshStandardMaterial({
      color: capColor,
      roughness: 0.98,
      emissive: new THREE.Color(glowColor ?? (props.borderColor ? borderColor : "#000000")),
      emissiveIntensity: active ? 0.4 : 0,
      metalness: 0,
    });
    capRef.current = cap;
    const side = new THREE.MeshStandardMaterial({ color: EDGE_COLOR, roughness: 0.98 });
    return { bodyMats: [cap, side], topMat: faceOf(topTex), bottomMat: faceOf(bottomTex) };
  }, [front, back, props.faceUp, props.frontUrl, borderColor, glowColor, active]);

  // highlight/selected 的邊框發光脈動（做在邊框上，取代舊 GlowFrame）
  useFrame((state) => {
    const cap = capRef.current;
    if (!cap) return;
    if (props.borderGlow && glowColor) {
      // 呼吸燈：intensity 0.05↔1.15，低點近黑、高點亮出學校色
      cap.emissiveIntensity = 0.6 + Math.sin(state.clock.elapsedTime * 3.2) * 0.55;
    } else if (props.borderGlow) {
      cap.emissiveIntensity = 0.45 + Math.sin(state.clock.elapsedTime * 4) * 0.3;
    } else if (active) {
      cap.emissiveIntensity = 0.55; // selected：定亮
    } else {
      cap.emissiveIntensity = 0;
    }
  });

  const handlers = {
    onPointerDown: props.onPointerDown,
    onPointerOver: props.onPointerOver,
    onPointerOut: props.onPointerOut,
  };

  return (
    <group position={props.position} rotation={props.rotation ?? [0, 0, 0]}>
      <mesh geometry={BODY_GEO} material={bodyMats} {...handlers} />
      <mesh geometry={FACE_GEO} material={topMat} position={[0, CARD_T / 2 + 0.0015, 0]} {...handlers} />
      <mesh geometry={FACE_GEO} material={bottomMat} position={[0, -CARD_T / 2 - 0.0015, 0]} rotation={[Math.PI, 0, 0]} {...handlers} />
    </group>
  );
}
