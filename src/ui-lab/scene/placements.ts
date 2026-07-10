// M9a CP4 擺位計算：GameState → 每張卡的 3D 目標位置／朝向（純函式、無 React）。
// 從 CP3 BoardScene 抽出，成為動畫系統的「目標表」：
//   - 靜態盤面＝直接渲染 computePlacements(displayed)
//   - 批次演出中＝displayed 的擺位為底，已演完 card-moved 的 uid 改取批次 after 的擺位（mergePlacements）
// AnimatedCard 對「目標改變」做緩動位移，本檔只管目標在哪。

import type { Card } from "../../data/types";
import type { CardDb, GameState, PlayerId } from "../../engine/types";
import { cardBackUrl, cardFrontUrl } from "../assets";
import type { ZoneId } from "../presentation/events";
import { blockSideAnchor, CARD_T, setAreaAnchor, zoneAnchor } from "./layout";

const STACK_ZONES = ["serve", "blockCenter", "receive", "toss", "attack"] as const;

export interface CardPlacement {
  uid: number;
  frontUrl: string | null;
  backUrl: string;
  faceUp: boolean;
  position: [number, number, number];
  rotation: [number, number, number];
  zone: ZoneId;
  player: PlayerId;
}

export interface PilePlacement {
  key: string;
  count: number;
  topUrl: string | null;
  position: [number, number, number];
  rotY: number;
}

export interface BoardPlacements {
  cards: Map<number, CardPlacement>;
  piles: PilePlacement[];
}

/** 每 uid 一點固定微旋（弧度），給「人手擺的」物性 */
export const jitter = (uid: number): number => (((uid * 37) % 7) - 3) * 0.006;

const lift = (level: number): number => CARD_T / 2 + level * CARD_T * 1.15;

function cardOf(db: CardDb, state: GameState, uid: number): Card | undefined {
  return db.get(state.cards[uid]!);
}

export function computePlacements(db: CardDb, state: GameState, schools: [string | undefined, string | undefined]): BoardPlacements {
  const cards = new Map<number, CardPlacement>();
  const piles: PilePlacement[] = [];

  for (const player of [0, 1] as const) {
    const ps = state.players[player];
    const rotY = player === 0 ? 0 : Math.PI;
    const back = cardBackUrl(schools[player]);
    const front = (uid: number): string | null => {
      const card = cardOf(db, state, uid);
      return card ? cardFrontUrl(card) : null;
    };

    // 疊放區（頂＝キャラ正面、其下ガッツ往網子方向外露）
    for (const zone of STACK_ZONES) {
      const stack = ps[zone];
      const anchor = zoneAnchor(player, zone === "blockCenter" ? "blockCenter" : zone);
      stack.forEach((uid, depth) => {
        const fromTop = stack.length - 1 - depth;
        const peekZ = -0.32 * fromTop * (player === 0 ? 1 : -1);
        cards.set(uid, {
          uid,
          frontUrl: front(uid),
          backUrl: back,
          faceUp: true,
          position: [anchor.x, lift(depth), anchor.z + peekZ],
          rotation: [0, rotY + jitter(uid), 0],
          zone,
          player,
        });
      });
    }
    // サイドブロッカー（不疊放、最多 2）
    ps.blockSides.forEach((uid, i) => {
      const anchor = blockSideAnchor(player, i);
      cards.set(uid, {
        uid,
        frontUrl: front(uid),
        backUrl: back,
        faceUp: true,
        position: [anchor.x, lift(0), anchor.z],
        rotation: [0, rotY + jitter(uid), 0],
        zone: "blockSide",
        player,
      });
    });
    // Set 區（背面朝下、兩張並排）
    ps.setArea.forEach((uid, i) => {
      const anchor = setAreaAnchor(player, i);
      cards.set(uid, {
        uid,
        frontUrl: null,
        backUrl: back,
        faceUp: false,
        position: [anchor.x, lift(0), anchor.z],
        rotation: [0, rotY + jitter(uid), 0],
        zone: "setArea",
        player,
      });
    });
    // 牌組＝厚度疊（卡背朝上）；棄牌／事件區＝疊＋頂張正面
    const deckA = zoneAnchor(player, "deck");
    piles.push({ key: `deck${player}`, count: ps.deck.length, topUrl: back, position: [deckA.x, 0, deckA.z], rotY });
    const dropA = zoneAnchor(player, "drop");
    if (ps.drop.length > 1) piles.push({ key: `drop${player}`, count: ps.drop.length - 1, topUrl: null, position: [dropA.x, 0, dropA.z], rotY });
    const dropTop = ps.drop[ps.drop.length - 1];
    if (dropTop !== undefined) {
      cards.set(dropTop, {
        uid: dropTop,
        frontUrl: front(dropTop),
        backUrl: back,
        faceUp: true,
        position: [dropA.x, (ps.drop.length - 1) * CARD_T + CARD_T / 2, dropA.z],
        rotation: [0, rotY + jitter(dropTop), 0],
        zone: "drop",
        player,
      });
    }
    const evA = zoneAnchor(player, "eventArea");
    if (ps.eventArea.length > 1) piles.push({ key: `ev${player}`, count: ps.eventArea.length - 1, topUrl: null, position: [evA.x, 0, evA.z], rotY });
    const evTop = ps.eventArea[ps.eventArea.length - 1];
    if (evTop !== undefined) {
      cards.set(evTop, {
        uid: evTop,
        frontUrl: front(evTop),
        backUrl: back,
        faceUp: true,
        position: [evA.x, (ps.eventArea.length - 1) * CARD_T + CARD_T / 2, evA.z],
        rotation: [0, rotY + jitter(evTop), 0],
        zone: "eventArea",
        player,
      });
    }
    // 手牌：P0＝面向鏡頭的扇形手托；P1＝遠端蓋牌扇
    const handA = zoneAnchor(player, "hand");
    const n = ps.hand.length;
    ps.hand.forEach((uid, i) => {
      const t = n > 1 ? i - (n - 1) / 2 : 0;
      if (player === 0) {
        cards.set(uid, {
          uid,
          frontUrl: front(uid),
          backUrl: back,
          faceUp: true,
          position: [handA.x + t * 0.66, 1.0 + i * 0.012, handA.z - 0.5 + Math.abs(t) * 0.09],
          rotation: [0.8, -t * 0.04, -t * 0.06],
          zone: "hand",
          player,
        });
      } else {
        cards.set(uid, {
          uid,
          frontUrl: null,
          backUrl: back,
          faceUp: false,
          position: [handA.x - t * 0.48, CARD_T / 2 + i * CARD_T * 0.5, handA.z],
          rotation: [0, rotY + t * 0.04, 0],
          zone: "hand",
          player,
        });
      }
    });
  }
  return { cards, piles };
}

/** 批次演出中的合成視圖：底＝批次 before 的擺位；已演完移動的 uid 取批次 after 的擺位。
 *  牌堆（deck/drop 厚度）以 before 為準，批次結束切 displayed 時一次到位。 */
export function mergePlacements(base: BoardPlacements, target: BoardPlacements, movedUids: ReadonlySet<number>): BoardPlacements {
  if (movedUids.size === 0) return base;
  const cards = new Map(base.cards);
  for (const uid of movedUids) {
    const p = target.cards.get(uid);
    if (p) cards.set(uid, p);
  }
  return { cards, piles: base.piles };
}
