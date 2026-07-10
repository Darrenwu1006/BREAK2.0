// M9a 場景組裝：3D 桌面（球場桌墊＋網）＋依 GameState 擺卡。
// 只讀 state 擺盤（靜態基線）；演出動畫（M9a 下一塊）將由 PresentationTimeline 驅動位移。

import { ContactShadows, useTexture } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import type { Card } from "../../data/types";
import type { CardDb, GameState, PlayerId } from "../../engine/types";
import { cardBackUrl, cardFrontUrl } from "../assets";
import { CardMesh, type CardMeshProps } from "./CardMesh";
import { blockSideAnchor, CARD_H, CARD_T, CARD_W, MAT_D, MAT_W, setAreaAnchor, TABLE_D, TABLE_W, zoneAnchor } from "./layout";

const STACK_ZONES = ["serve", "blockCenter", "receive", "toss", "attack"] as const;

/** 每 uid 一點固定微旋（弧度），給「人手擺的」物性 */
const jitter = (uid: number): number => (((uid * 37) % 7) - 3) * 0.006;

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
  const url = props.topUrl ?? cardBackUrl();
  const tex = useTexture(url, (t) => {
    const texture = Array.isArray(t) ? t[0]! : t;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
  });
  const materials = useMemo(() => {
    const edge = new THREE.MeshStandardMaterial({ color: "#d9d2c0", roughness: 0.95 });
    const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62 });
    const bottom = new THREE.MeshStandardMaterial({ color: "#d9d2c0", roughness: 0.95 });
    return [edge, edge, top, bottom, edge, edge];
  }, [tex]);
  if (props.count <= 0) return null;
  const h = props.count * CARD_T;
  return (
    <mesh position={[props.position[0], h / 2, props.position[2]]} rotation={[0, props.rotY, 0]} material={materials}>
      <boxGeometry args={[CARD_W, h, CARD_H]} />
    </mesh>
  );
}

function cardOf(db: CardDb, state: GameState, uid: number): Card | undefined {
  return db.get(state.cards[uid]!);
}

export function BoardScene(props: { db: CardDb; state: GameState; schools: [string | undefined, string | undefined] }): React.JSX.Element {
  const { db, state, schools } = props;

  const { cards, piles } = useMemo(() => {
    const cards: (CardMeshProps & { key: string })[] = [];
    const piles: { key: string; count: number; topUrl: string | null; position: [number, number, number]; rotY: number }[] = [];

    for (const player of [0, 1] as const) {
      const ps = state.players[player];
      const rotY = player === 0 ? 0 : Math.PI;
      const back = cardBackUrl(schools[player]);
      const lift = (level: number): number => CARD_T / 2 + level * CARD_T * 1.15;

      // 疊放區（頂＝キャラ正面、其下ガッツ往網子方向外露）
      for (const zone of STACK_ZONES) {
        const stack = ps[zone];
        const anchor = zoneAnchor(player, zone === "blockCenter" ? "blockCenter" : zone);
        stack.forEach((uid, depth) => {
          const fromTop = stack.length - 1 - depth;
          const peekZ = -0.32 * fromTop * (player === 0 ? 1 : -1);
          const card = cardOf(db, state, uid);
          cards.push({
            key: `c${uid}`,
            frontUrl: card ? cardFrontUrl(card) : null,
            backUrl: back,
            faceUp: true,
            position: [anchor.x, lift(depth), anchor.z + peekZ],
            rotation: [0, rotY + jitter(uid), 0],
          });
        });
      }
      // サイドブロッカー（不疊放、最多 2）
      ps.blockSides.forEach((uid, i) => {
        const anchor = blockSideAnchor(player, i);
        const card = cardOf(db, state, uid);
        cards.push({
          key: `c${uid}`,
          frontUrl: card ? cardFrontUrl(card) : null,
          backUrl: back,
          faceUp: true,
          position: [anchor.x, lift(0), anchor.z],
          rotation: [0, rotY + jitter(uid), 0],
        });
      });
      // Set 區（背面朝下、兩張並排）
      ps.setArea.forEach((uid, i) => {
        const anchor = setAreaAnchor(player, i);
        cards.push({
          key: `c${uid}`,
          frontUrl: null,
          backUrl: back,
          faceUp: false,
          position: [anchor.x, lift(0), anchor.z],
          rotation: [0, rotY + jitter(uid), 0],
        });
      });
      // 牌組＝厚度疊（卡背朝上）；棄牌＝疊＋頂張正面；事件區＝疊＋頂張正面
      const deckA = zoneAnchor(player, "deck");
      piles.push({ key: `deck${player}`, count: ps.deck.length, topUrl: back, position: [deckA.x, 0, deckA.z], rotY });
      const dropA = zoneAnchor(player, "drop");
      if (ps.drop.length > 1) piles.push({ key: `drop${player}`, count: ps.drop.length - 1, topUrl: null, position: [dropA.x, 0, dropA.z], rotY });
      const dropTop = ps.drop[ps.drop.length - 1];
      if (dropTop !== undefined) {
        const card = cardOf(db, state, dropTop);
        cards.push({
          key: `c${dropTop}`,
          frontUrl: card ? cardFrontUrl(card) : null,
          backUrl: back,
          faceUp: true,
          position: [dropA.x, (ps.drop.length - 1) * CARD_T + CARD_T / 2, dropA.z],
          rotation: [0, rotY + jitter(dropTop), 0],
        });
      }
      const evA = zoneAnchor(player, "eventArea");
      if (ps.eventArea.length > 1) piles.push({ key: `ev${player}`, count: ps.eventArea.length - 1, topUrl: null, position: [evA.x, 0, evA.z], rotY });
      const evTop = ps.eventArea[ps.eventArea.length - 1];
      if (evTop !== undefined) {
        const card = cardOf(db, state, evTop);
        cards.push({
          key: `c${evTop}`,
          frontUrl: card ? cardFrontUrl(card) : null,
          backUrl: back,
          faceUp: true,
          position: [evA.x, (ps.eventArea.length - 1) * CARD_T + CARD_T / 2, evA.z],
          rotation: [0, rotY + jitter(evTop), 0],
        });
      }
      // 手牌：P0＝面向鏡頭的扇形手托；P1＝遠端蓋牌扇
      const handA = zoneAnchor(player, "hand");
      const n = ps.hand.length;
      ps.hand.forEach((uid, i) => {
        const t = n > 1 ? i - (n - 1) / 2 : 0;
        if (player === 0) {
          const card = cardOf(db, state, uid);
          cards.push({
            key: `c${uid}`,
            frontUrl: card ? cardFrontUrl(card) : null,
            backUrl: back,
            faceUp: true,
            position: [handA.x + t * 0.66, 1.0 + i * 0.012, handA.z - 0.5 + Math.abs(t) * 0.09],
            rotation: [0.8, -t * 0.04, -t * 0.06],
          });
        } else {
          cards.push({
            key: `c${uid}`,
            frontUrl: null,
            backUrl: back,
            faceUp: false,
            position: [handA.x - t * 0.48, CARD_T / 2 + i * CARD_T * 0.5, handA.z],
            rotation: [0, rotY + t * 0.04, 0],
          });
        }
      });
    }
    return { cards, piles };
  }, [db, state, schools]);

  return (
    <group>
      <ambientLight intensity={0.85} />
      <directionalLight position={[4, 11, 7]} intensity={1.35} />
      <directionalLight position={[-6, 6, -4]} intensity={0.35} />
      <Table />
      {piles.map(({ key, ...p }) => (
        <Pile key={key} {...p} />
      ))}
      {cards.map(({ key, ...c }) => (
        <CardMesh key={key} {...c} />
      ))}
      <ContactShadows position={[0, 0.012, 0]} opacity={0.45} scale={22} blur={2.2} far={3.2} resolution={512} />
    </group>
  );
}
