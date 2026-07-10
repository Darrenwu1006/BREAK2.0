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
import { AnimatedCard } from "./AnimatedCard";
import { blockSideAnchor, CARD_H, CARD_T, CARD_W, MAT_D, MAT_W, setAreaAnchor, TABLE_D, TABLE_W, zoneAnchor } from "./layout";
import type { BoardPlacements } from "./placements";

/** 桌墊卡槽外框（官方對戰桌墊風：極簡細線框） */
function SlotFrame(props: { x: number; z: number }): React.JSX.Element {
  const w = CARD_W + 0.22;
  const h = CARD_H + 0.22;
  const t = 0.035;
  const line = <meshBasicMaterial color="#8fa3b5" transparent opacity={0.35} depthWrite={false} />;
  return (
    <group position={[props.x, 0.006, props.z]}>
      <mesh position={[0, 0, -h / 2]}>
        <boxGeometry args={[w, 0.003, t]} />
        {line}
      </mesh>
      <mesh position={[0, 0, h / 2]}>
        <boxGeometry args={[w, 0.003, t]} />
        {line}
      </mesh>
      <mesh position={[-w / 2, 0, 0]}>
        <boxGeometry args={[t, 0.003, h]} />
        {line}
      </mesh>
      <mesh position={[w / 2, 0, 0]}>
        <boxGeometry args={[t, 0.003, h]} />
        {line}
      </mesh>
    </group>
  );
}

/** 單側桌墊的全部卡槽（依 layout 錨點；手牌區不畫槽） */
function PlayerSlots(props: { player: 0 | 1 }): React.JSX.Element {
  const p = props.player;
  const zones: ZoneId[] = ["serve", "receive", "toss", "attack", "blockCenter", "eventArea", "deck", "drop"];
  return (
    <group>
      {zones.map((z) => {
        const a = zoneAnchor(p, z);
        return <SlotFrame key={z} x={a.x} z={a.z} />;
      })}
      {[0, 1].map((i) => {
        const a = blockSideAnchor(p, i);
        return <SlotFrame key={`bs${i}`} x={a.x} z={a.z} />;
      })}
      {[0, 1].map((i) => {
        const a = setAreaAnchor(p, i);
        return <SlotFrame key={`set${i}`} x={a.x} z={a.z} />;
      })}
    </group>
  );
}

/** 桌面：木桌＋精品極簡風對戰桌墊（深色底＋細線卡槽＋中線；學校專屬桌墊列後續設計） */
function Table(): React.JSX.Element {
  return (
    <group>
      {/* 木桌 */}
      <mesh position={[0, -0.03, 0]}>
        <boxGeometry args={[TABLE_W, 0.06, TABLE_D]} />
        <meshStandardMaterial color="#3d3128" roughness={0.85} />
      </mesh>
      {/* 桌墊：深色雙層（外緣一圈微亮的收邊） */}
      <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[MAT_W + 2.4, MAT_D + 1.6]} />
        <meshStandardMaterial color="#232c36" roughness={0.94} />
      </mesh>
      <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[MAT_W + 2.1, MAT_D + 1.3]} />
        <meshStandardMaterial color="#151b22" roughness={0.94} />
      </mesh>
      {/* 中線（雙方分界） */}
      <mesh position={[0, 0.006, 0]}>
        <boxGeometry args={[MAT_W + 2.1, 0.002, 0.05]} />
        <meshBasicMaterial color="#8fa3b5" transparent opacity={0.4} depthWrite={false} />
      </mesh>
      {/* 卡槽格線 */}
      <PlayerSlots player={0} />
      <PlayerSlots player={1} />
      {/* 網（保留輕薄一片，暗示排球 DNA） */}
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[MAT_W + 1.2, 0.26, 0.012]} />
        <meshStandardMaterial color="#dfe7ea" transparent opacity={0.16} roughness={0.6} depthWrite={false} />
      </mesh>
      {[-(MAT_W / 2 + 0.85), MAT_W / 2 + 0.85].map((x) => (
        <mesh key={x} position={[x, 0.17, 0]}>
          <cylinderGeometry args={[0.028, 0.036, 0.34, 12]} />
          <meshStandardMaterial color="#6d747b" roughness={0.5} metalness={0.4} />
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
  /** hover 拉出的手牌 uid（僅 P0 手牌） */
  hoveredUid: number | null;
  onCardHover: (uid: number | null) => void;
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
        const hoverable = p.player === 0 && p.zone === "hand" && draggingUid === null;
        const org = origins.get(p.uid);
        const orgAnchor = org ? zoneAnchor(org.player, org.zone) : null;
        return (
          <AnimatedCard
            key={p.uid}
            placement={p}
            highlighted={draggable}
            hovered={props.hoveredUid === p.uid && hoverable}
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
            onPointerOver={
              draggable || hoverable
                ? (e) => {
                    e.stopPropagation();
                    if (draggable) setCursor("grab");
                    if (hoverable) props.onCardHover(p.uid);
                  }
                : undefined
            }
            onPointerOut={
              draggable || hoverable
                ? () => {
                    setCursor("");
                    if (hoverable) props.onCardHover(null);
                  }
                : undefined
            }
          />
        );
      })}
      {/* 拖曳攔截平面：貼齊桌面高度——指標落點的 x/z 才等於「畫面上看到的位置」
          （平面架高會產生視差，拖到發光區放手卻判定不在區內＝先前放不下的主因）；
          卡牌本身仍浮在 DRAG_Y 高度（AnimatedCard 強制 ty）。 */}
      {draggingUid !== null && (
        <mesh
          position={[0, 0.02, 0]}
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
