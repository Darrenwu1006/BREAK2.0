// M9a CP4 場景組裝：3D 桌面＋依 placements（合成視圖）擺卡。
// CP3 的「直讀 GameState 擺卡」已抽到 placements.ts；本檔只管渲染與互動事件轉發：
//   - AnimatedCard 對 placement 目標緩動（演出位移由 usePlayback 換 placements 驅動）
//   - 拖曳：手牌 pointerdown 起手 → 透明攔截平面回報指標點 → 放手回報 drop
//   - 合法落區高亮（脈動；指標在區內時增強）

import { ContactShadows, useTexture } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { cardBackUrl } from "../assets";
import type { ZoneId } from "../presentation/events";
import { AnimatedCard, DRAG_Y } from "./AnimatedCard";
import { CARD_H, CARD_T, CARD_W, MAT_D, MAT_W, TABLE_D, TABLE_W, zoneAnchor } from "./layout";
import type { BoardPlacements } from "./placements";

function Table(): React.JSX.Element {
  return (
    <group>
      {/* 木桌 */}
      <mesh position={[0, -0.03, 0]}>
        <boxGeometry args={[TABLE_W, 0.06, TABLE_D]} />
        <meshStandardMaterial color="#3d3128" roughness={0.85} />
      </mesh>
      {/* 球場桌墊（排球場橘＋外圈藍綠） */}
      <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[MAT_W + 2.4, MAT_D + 1.6]} />
        <meshStandardMaterial color="#1d5f63" roughness={0.92} />
      </mesh>
      <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[MAT_W, MAT_D]} />
        <meshStandardMaterial color="#c9722e" roughness={0.9} />
      </mesh>
      {/* 中線與邊線 */}
      <mesh position={[0, 0.008, 0]}>
        <boxGeometry args={[MAT_W, 0.002, 0.08]} />
        <meshStandardMaterial color="#f2ede2" roughness={0.8} />
      </mesh>
      {[-MAT_D / 2, MAT_D / 2].map((z) => (
        <mesh key={z} position={[0, 0.008, z]}>
          <boxGeometry args={[MAT_W, 0.002, 0.08]} />
          <meshStandardMaterial color="#f2ede2" roughness={0.8} />
        </mesh>
      ))}
      {[-MAT_W / 2, MAT_W / 2].map((x) => (
        <mesh key={x} position={[x, 0.008, 0]}>
          <boxGeometry args={[0.08, 0.002, MAT_D]} />
          <meshStandardMaterial color="#f2ede2" roughness={0.8} />
        </mesh>
      ))}
      {/* 網（半透明帶＋兩根柱） */}
      <mesh position={[0, 0.24, 0]}>
        <boxGeometry args={[MAT_W + 0.6, 0.34, 0.015]} />
        <meshStandardMaterial color="#dfe7ea" transparent opacity={0.32} roughness={0.6} depthWrite={false} />
      </mesh>
      {[-(MAT_W / 2 + 0.35), MAT_W / 2 + 0.35].map((x) => (
        <mesh key={x} position={[x, 0.22, 0]}>
          <cylinderGeometry args={[0.035, 0.045, 0.44, 12]} />
          <meshStandardMaterial color="#8a8f94" roughness={0.5} metalness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

/** 牌組/棄牌的「厚度」底座：n 張卡的實體疊 */
function Pile(props: { count: number; topUrl: string | null; position: [number, number, number]; rotY: number }): React.JSX.Element | null {
  // useTexture 不可條件呼叫：無頂圖（棄牌底疊）以卡背佔位，頂面材質改用素色
  const tex = useTexture(props.topUrl ?? cardBackUrl(), (t) => {
    const texture = Array.isArray(t) ? t[0]! : t;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
  });
  const materials = useMemo(() => {
    const edge = new THREE.MeshStandardMaterial({ color: "#d9d2c0", roughness: 0.95 });
    const top = props.topUrl ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62 }) : edge;
    return [edge, edge, top, edge, edge, edge];
  }, [tex, props.topUrl]);
  if (props.count <= 0) return null;
  const h = props.count * CARD_T;
  return (
    <mesh position={[props.position[0], h / 2, props.position[2]]} rotation={[0, props.rotY, 0]} material={materials}>
      <boxGeometry args={[CARD_W, h, CARD_H]} />
    </mesh>
  );
}

/** 合法落區高亮：脈動平面，指標在區內時轉暖色增強 */
function ZoneGlow(props: { x: number; z: number; active: boolean }): React.JSX.Element {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    if (!mat.current) return;
    const base = props.active ? 0.42 : 0.2;
    mat.current.opacity = base + 0.1 * Math.sin(performance.now() * 0.006);
    mat.current.color.set(props.active ? "#ffd45e" : "#59c8ff");
  });
  return (
    <mesh position={[props.x, 0.02, props.z]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[CARD_W + 1.1, CARD_H + 0.9]} />
      <meshBasicMaterial ref={mat} color="#59c8ff" transparent opacity={0.2} depthWrite={false} />
    </mesh>
  );
}

export interface BoardSceneProps {
  placements: BoardPlacements;
  /** 本批已演移動的卡的來源區（新掛載卡的出生點；抽牌從牌組頂飛出） */
  origins: ReadonlyMap<number, { player: 0 | 1; zone: ZoneId }>;
  draggableUids: ReadonlySet<number>;
  draggingUid: number | null;
  dragPoint: React.RefObject<THREE.Vector3>;
  /** 合法落區（deploy 目標）；active＝指標在區內 */
  dropZone: { x: number; z: number; active: boolean } | null;
  onCardPointerDown: (uid: number) => void;
  onDragMove: (x: number, z: number) => void;
  onDragEnd: () => void;
}

export function BoardScene(props: BoardSceneProps): React.JSX.Element {
  const { placements, origins, draggableUids, draggingUid, dragPoint } = props;
  const cards = useMemo(() => [...placements.cards.values()], [placements]);

  const setCursor = (c: string) => {
    document.body.style.cursor = c;
  };

  return (
    <group>
      <ambientLight intensity={0.85} />
      <directionalLight position={[4, 11, 7]} intensity={1.35} />
      <directionalLight position={[-6, 6, -4]} intensity={0.35} />
      <Table />
      {props.dropZone && <ZoneGlow x={props.dropZone.x} z={props.dropZone.z} active={props.dropZone.active} />}
      {placements.piles.map(({ key, ...p }) => (
        <Pile key={key} {...p} />
      ))}
      {cards.map((p) => {
        const draggable = draggableUids.has(p.uid) && draggingUid === null;
        const org = origins.get(p.uid);
        const orgAnchor = org ? zoneAnchor(org.player, org.zone) : null;
        return (
          <AnimatedCard
            key={p.uid}
            placement={p}
            highlighted={draggable}
            dragging={draggingUid === p.uid}
            dragPoint={dragPoint}
            spawnFrom={orgAnchor ? [orgAnchor.x, 0.5, orgAnchor.z] : undefined}
            onPointerDown={
              draggable
                ? (e) => {
                    e.stopPropagation();
                    props.onCardPointerDown(p.uid);
                  }
                : undefined
            }
            onPointerOver={draggable ? () => setCursor("grab") : undefined}
            onPointerOut={draggable ? () => setCursor("") : undefined}
          />
        );
      })}
      {/* 拖曳攔截平面：拖曳中才存在，透明但可被 raycast */}
      {draggingUid !== null && (
        <mesh
          position={[0, DRAG_Y, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={(e: ThreeEvent<PointerEvent>) => props.onDragMove(e.point.x, e.point.z)}
          onPointerUp={(e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            props.onDragEnd();
          }}
        >
          <planeGeometry args={[120, 120]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      <ContactShadows position={[0, 0.012, 0]} opacity={0.45} scale={22} blur={2.2} far={3.2} resolution={512} />
    </group>
  );
}
