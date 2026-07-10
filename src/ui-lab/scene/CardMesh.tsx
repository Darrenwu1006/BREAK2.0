// 卡牌 mesh：厚度盒＋正反面 webp 貼圖（spec §2 卡牌物性——立體感來自厚度/傾斜/投影，不是建模）。
// 圓角輪廓屬 M9a 手感迭代的質地項，基線先用直角盒（換幾何不動 props 契約）。

import { useTexture } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import { CARD_H, CARD_T, CARD_W } from "./layout";

const EDGE_COLOR = "#e9e3d5"; // 紙側面

export interface CardMeshProps {
  /** 正面貼圖；null＝素面（無卡圖資料） */
  frontUrl: string | null;
  backUrl: string;
  faceUp: boolean;
  position: [number, number, number];
  /** 弧度；P1 的卡通常 rotY=π（面向對手） */
  rotation?: [number, number, number];
}

export function CardMesh(props: CardMeshProps): React.JSX.Element {
  // useTexture 不可條件呼叫：素面卡以卡背佔位，正面材質改用純色
  const [front, back] = useTexture([props.frontUrl ?? props.backUrl, props.backUrl], (textures) => {
    for (const t of Array.isArray(textures) ? textures : [textures]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
    }
  });

  const materials = useMemo(() => {
    const edge = new THREE.MeshStandardMaterial({ color: EDGE_COLOR, roughness: 0.9 });
    const faceOf = (tex: THREE.Texture | null): THREE.MeshStandardMaterial =>
      tex ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62 }) : new THREE.MeshStandardMaterial({ color: "#f5f0e4", roughness: 0.62 });
    const topTex = props.faceUp ? (props.frontUrl ? (front ?? null) : null) : (back ?? null);
    const bottomTex = props.faceUp ? (back ?? null) : props.frontUrl ? (front ?? null) : null;
    // BoxGeometry 材質順序：+x, -x, +y(上), -y(下), +z, -z
    return [edge, edge, faceOf(topTex), faceOf(bottomTex), edge, edge];
  }, [front, back, props.faceUp, props.frontUrl]);

  return (
    <mesh position={props.position} rotation={props.rotation ?? [0, 0, 0]} material={materials}>
      <boxGeometry args={[CARD_W, CARD_T, CARD_H]} />
    </mesh>
  );
}
