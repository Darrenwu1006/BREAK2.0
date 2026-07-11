// M9a 場景組裝：桌面（官方對戰墊風：深色底＋卡槽細線框＋槽位文字）＋依 placements 擺卡。
// CP5b（[使用者 2026-07-10] 回饋輪二）：排球網移除、槽位標籤（空槽才顯示）、
// ガッツ張數徽章、牌堆側面灰線（一張一張的質感）、疊放區點擊展開、發光收斂為邊框。

import { ContactShadows, Html, useTexture } from "@react-three/drei";
import { type ThreeEvent } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { cardBackUrl } from "../assets";
import type { ZoneId } from "../presentation/events";
import { ZONE_LABEL } from "../presentation/textRenderer";
import styles from "../UiLabApp.module.css";
import { AnimatedCard } from "./AnimatedCard";
import { GlowFrame } from "./GlowFrame";
import { blockSideAnchor, CARD_T, CARD_W, CARD_H, MAT_D, MAT_W, setAreaAnchor, SLOT_H, SLOT_W, zoneAnchor } from "./layout";
import type { BoardPlacements } from "./placements";

/** 有疊放（ガッツ）語意的場上區 */
const STACK_ZONES: ReadonlySet<ZoneId> = new Set(["serve", "blockCenter", "receive", "toss", "attack"]);

/** 桌墊卡槽外框（官方對戰桌墊風：極簡細線）＋空槽時的文字指示 */
function SlotFrame(props: { x: number; z: number; label?: string; showLabel?: boolean }): React.JSX.Element {
  const t = 0.035;
  const line = <meshBasicMaterial color="#8fa3b5" transparent opacity={0.35} depthWrite={false} />;
  return (
    <group position={[props.x, 0.006, props.z]}>
      <mesh position={[0, 0, -SLOT_H / 2]}>
        <boxGeometry args={[SLOT_W, 0.003, t]} />
        {line}
      </mesh>
      <mesh position={[0, 0, SLOT_H / 2]}>
        <boxGeometry args={[SLOT_W, 0.003, t]} />
        {line}
      </mesh>
      <mesh position={[-SLOT_W / 2, 0, 0]}>
        <boxGeometry args={[t, 0.003, SLOT_H]} />
        {line}
      </mesh>
      <mesh position={[SLOT_W / 2, 0, 0]}>
        <boxGeometry args={[t, 0.003, SLOT_H]} />
        {line}
      </mesh>
      {props.label && props.showLabel && (
        <Html position={[0, 0.02, 0]} center style={{ pointerEvents: "none" }} zIndexRange={[2, 0]}>
          <div className={styles.slotLabel}>{props.label}</div>
        </Html>
      )}
    </group>
  );
}

/** 單側桌墊的全部卡槽；occupied＝有卡的區（標籤只在空槽顯示，避免 DOM 蓋在卡上） */
function PlayerSlots(props: { player: 0 | 1; occupied: ReadonlySet<string> }): React.JSX.Element {
  const p = props.player;
  const zones: ZoneId[] = ["serve", "receive", "toss", "attack", "blockCenter", "eventArea", "deck", "drop"];
  const show = (zone: string): boolean => !props.occupied.has(`${p}:${zone}`);
  return (
    <group>
      {zones.map((z) => {
        const a = zoneAnchor(p, z);
        return <SlotFrame key={z} x={a.x} z={a.z} label={ZONE_LABEL[z]} showLabel={show(z)} />;
      })}
      {[0, 1].map((i) => {
        const a = blockSideAnchor(p, i);
        return <SlotFrame key={`bs${i}`} x={a.x} z={a.z} label={ZONE_LABEL.blockSide} showLabel={show("blockSide")} />;
      })}
      {[0, 1].map((i) => {
        const a = setAreaAnchor(p, i);
        return <SlotFrame key={`set${i}`} x={a.x} z={a.z} label={ZONE_LABEL.setArea} showLabel={show("setArea")} />;
      })}
    </group>
  );
}

/** 桌面：滿版木質表面＋精品極簡風對戰桌墊（排球網已依回饋 #8 移除；學校專屬桌墊列 M9b）。
 *  [使用者 2026-07-11 LP0] 表面延伸出視野、配 fog 淡出——看不到桌緣，「不像一張桌子」；
 *  這塊區域的漫畫風質地設計列後續（M9b 質地繼承）。 */
function Table(props: { occupied: ReadonlySet<string> }): React.JSX.Element {
  return (
    <group>
      {/* 滿版表面（尺寸遠超出鏡頭視野；遠端由 fog 淡入背景色） */}
      <mesh position={[0, -0.03, 0]}>
        <boxGeometry args={[90, 0.06, 70]} />
        <meshStandardMaterial color="#3d3128" roughness={0.85} />
      </mesh>
      {/* 桌墊：深色雙層（外緣一圈微亮收邊） */}
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
      <PlayerSlots player={0} occupied={props.occupied} />
      <PlayerSlots player={1} occupied={props.occupied} />
    </group>
  );
}

/** 牌堆側面「一張一張」的灰線貼圖（回饋 #10）：每卡厚度一條細線，repeat＝張數 */
function useStripedEdge(count: number): THREE.CanvasTexture {
  return useMemo(() => {
    const cv = document.createElement("canvas");
    cv.width = 8;
    cv.height = 16;
    const g = cv.getContext("2d")!;
    g.fillStyle = "#d3ccba";
    g.fillRect(0, 0, 8, 16);
    g.fillStyle = "rgba(92, 86, 72, 0.6)";
    g.fillRect(0, 0, 8, 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.repeat.set(1, count);
    return tex;
  }, [count]);
}

/** 牌組/棄牌的「厚度」底座：n 張卡的實體疊 */
function Pile(props: { count: number; topUrl: string | null; position: [number, number, number]; rotY: number }): React.JSX.Element | null {
  // useTexture 不可條件呼叫：無頂圖（棄牌底疊）以卡背佔位，頂面材質改用素色
  const tex = useTexture(props.topUrl ?? cardBackUrl(), (t) => {
    const texture = Array.isArray(t) ? t[0]! : t;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
  });
  const stripes = useStripedEdge(Math.max(props.count, 1));
  const materials = useMemo(() => {
    const edge = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.95 });
    const plain = new THREE.MeshStandardMaterial({ color: "#d3ccba", roughness: 0.95 });
    const top = props.topUrl ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62 }) : plain;
    return [edge, edge, top, plain, edge, edge];
  }, [tex, stripes, props.topUrl]);
  if (props.count <= 0) return null;
  const h = props.count * CARD_T;
  return (
    <mesh position={[props.position[0], h / 2, props.position[2]]} rotation={[0, props.rotY, 0]} material={materials}>
      <boxGeometry args={[CARD_W, h, CARD_H]} />
    </mesh>
  );
}

export interface BoardSceneProps {
  placements: BoardPlacements;
  /** 本批已演移動的卡的來源區（新掛載卡的出生點；抽牌從牌組頂飛出） */
  origins: ReadonlyMap<number, { player: 0 | 1; zone: ZoneId }>;
  draggableUids: ReadonlySet<number>;
  /** 點選模式（mulligan 換牌／攔網多選／取 Set 卡／自由步驟技能宣告）：可點選的卡 */
  selectableUids: ReadonlySet<number>;
  /** 已選取的卡（金框） */
  selectedUids: ReadonlySet<number>;
  onCardSelect: (uid: number) => void;
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
  /** 點擊場上疊放區＝展開/收合檢視 ガッツ（回饋 #4） */
  onStackToggle: (player: 0 | 1, zone: ZoneId) => void;
}

export function BoardScene(props: BoardSceneProps): React.JSX.Element {
  const { placements, origins, draggableUids, draggingUid, dragPoint } = props;
  const cards = useMemo(() => [...placements.cards.values()], [placements]);

  /** 佔用區（槽位標籤隱藏）＋ガッツ徽章資料 */
  const { occupied, badges, stackKeys } = useMemo(() => {
    const occupied = new Set<string>();
    const stackCount = new Map<string, number>();
    for (const p of placements.cards.values()) {
      occupied.add(`${p.player}:${p.zone}`);
      if (STACK_ZONES.has(p.zone)) {
        const k = `${p.player}:${p.zone}`;
        stackCount.set(k, (stackCount.get(k) ?? 0) + 1);
      }
    }
    for (const pile of placements.piles) {
      if (pile.count > 0) occupied.add(pile.key.startsWith("deck") ? `${pile.key.slice(4)}:deck` : "");
    }
    const stackKeys = new Set([...stackCount.entries()].filter(([, n]) => n > 1).map(([key]) => key));
    const badges = [...stackCount.entries()]
      .filter(([, n]) => n > 1)
      .map(([k, n]) => {
        const [playerS, zone] = k.split(":") as [string, ZoneId];
        const player = Number(playerS) as 0 | 1;
        const a = zoneAnchor(player, zone);
        return { key: k, player, zone, x: a.x, z: a.z, guts: n - 1 };
      });
    return { occupied, badges, stackKeys };
  }, [placements]);

  const setCursor = (c: string) => {
    document.body.style.cursor = c;
  };

  return (
    <group>
      <ambientLight intensity={0.85} />
      <directionalLight position={[4, 11, 7]} intensity={1.35} />
      <directionalLight position={[-6, 6, -4]} intensity={0.35} />
      <Table occupied={occupied} />
      {props.dropZone && (
        <GlowFrame
          width={SLOT_W}
          height={SLOT_H}
          thickness={0.07}
          color={props.dropZone.active ? "#ffd45e" : "#59c8ff"}
          visible
          opacityRange={props.dropZone.active ? [0.75, 1] : [0.35, 0.6]}
          position={[props.dropZone.x, 0.02, props.dropZone.z]}
        />
      )}
      {placements.piles.map(({ key, ...p }) => (
        <Pile key={key} {...p} />
      ))}
      {/* ガッツ張數徽章（回饋 #5；點擊與場上卡共用展開行為） */}
      {badges.map((b) => (
        <Html
          key={b.key}
          position={[b.x + SLOT_W / 2 - 0.08, 0.25, b.z + (b.player === 0 ? -1 : 1) * (SLOT_H / 2 - 0.06)]}
          center
          style={{ pointerEvents: "auto" }}
          zIndexRange={[3, 0]}
        >
          <button className={styles.gutsBadge} type="button" onClick={() => props.onStackToggle(b.player, b.zone)}>
            Guts {b.guts}
          </button>
        </Html>
      ))}
      {cards.map((p) => {
        const draggable = draggableUids.has(p.uid) && draggingUid === null;
        const selectable = props.selectableUids.has(p.uid) && draggingUid === null;
        const hoverable = p.player === 0 && p.zone === "hand" && draggingUid === null;
        const stackable = stackKeys.has(`${p.player}:${p.zone}`) && draggingUid === null;
        const org = origins.get(p.uid);
        const orgAnchor = org ? zoneAnchor(org.player, org.zone) : null;
        return (
          <AnimatedCard
            key={p.uid}
            placement={p}
            highlighted={draggable || selectable}
            selected={props.selectedUids.has(p.uid)}
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
                : selectable
                  ? (e) => {
                      e.stopPropagation();
                      props.onCardSelect(p.uid);
                    }
                  : stackable
                    ? (e) => {
                        e.stopPropagation();
                        props.onStackToggle(p.player, p.zone);
                      }
                    : undefined
            }
            onPointerOver={
              draggable || selectable || hoverable || stackable
                ? (e) => {
                    e.stopPropagation();
                    setCursor(draggable ? "grab" : "pointer");
                    if (hoverable) props.onCardHover(p.uid);
                  }
                : undefined
            }
            onPointerOut={
              draggable || selectable || hoverable || stackable
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
          （平面架高會產生視差；卡牌本身仍浮在 DRAG_Y 高度，AnimatedCard 強制 ty）。 */}
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
