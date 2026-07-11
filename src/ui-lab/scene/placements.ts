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
  /** hover 拉出的安全位移（沿卡面內方向——與相鄰卡保持平行平面，幾何上不可能相交）。
   *  沒給的卡用 AnimatedCard 的預設世界座標抬升（平放卡安全）。 */
  hoverOffset?: [number, number, number];
  /** highlighted（可拖曳提示）的安全位移，語意同上 */
  highlightOffset?: [number, number, number];
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

// ---- P0 手牌扇幾何常數（placements.test 以同組常數驗證「不破圖」不變量） ----
/** 手托傾角（繞 x 軸） */
export const HAND_TILT = 0.72;
export const HAND_SIN = Math.sin(HAND_TILT);
export const HAND_COS = Math.cos(HAND_TILT);
/** 固定可用寬度：滿手時卡牌填滿此範圍（越多越密） */
export const HAND_SPAN = 4.6;
/** 少牌時的單張間距上限（避免 2~3 張時攤太開） */
export const HAND_MAX_STEP = 0.72;
/** 中央弧高（沿卡面內方向，不影響疊序） */
export const HAND_ARC = 0.2;
/** 相鄰卡沿卡面法線的間距：rotY=0 後手牌是嚴格平行平面族，只需 > 卡厚（rotZ 是面內滾轉不出面） */
export const HAND_STACK = 0.028;
/** hover 拉出距離：沿卡面「上」方向 û 滑出（平面內移動，與鄰卡平行性不變） */
export const HAND_HOVER_SLIDE = 0.66;
/** highlighted（可拖曳提示）微升距離：同樣沿 û */
export const HAND_HIGHLIGHT_SLIDE = 0.16;

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

    // 疊放區：直上疊、不外露（卡堆不超出格子——[使用者 2026-07-10]）；
    // ガッツ張數以徽章顯示、點擊可展開檢視（BoardScene/UiLabApp）
    for (const zone of STACK_ZONES) {
      const stack = ps[zone];
      const anchor = zoneAnchor(player, zone === "blockCenter" ? "blockCenter" : zone);
      stack.forEach((uid, depth) => {
        cards.set(uid, {
          uid,
          frontUrl: front(uid),
          backUrl: back,
          faceUp: true,
          position: [anchor.x, lift(depth), anchor.z],
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
    // 手牌：P0 參考 Pokémon TCG Pocket——中間略高、左右向內收的淺弧扇形。
    // [使用者 2026-07-11] 固定範圍填滿：手牌越多越密（step 收縮）、少牌時 step 上限。
    // 破圖根治二輪（LP0）：手牌一律 rotY=0 ——扇形感只用 rotZ（卡面內滾轉，不改平面朝向），
    // 所有手牌成為「嚴格平行的平面族」、層距 HAND_STACK > 卡厚 → 幾何上不可能相交。
    // （CP5d 的殘洞＝rotY 用正規化位置 nt 算，手牌少時相鄰 Δnt 最大到 1.0，
    //   卡緣出面擺動 0.028 ＋卡厚 > 層距，2~5 張的常見手牌必穿插。）
    // hover/highlight 的位移也一律沿卡面內方向（HAND_UP），平行性永遠保持。
    // P1＝遠端蓋牌扇（平放卡的 rotY 就是面內滾轉，只需層距 > 卡厚）。
    const handA = zoneAnchor(player, "hand");
    const n = ps.hand.length;
    ps.hand.forEach((uid, i) => {
      const t = n > 1 ? i - (n - 1) / 2 : 0;
      if (player === 0) {
        const maxT = Math.max((n - 1) / 2, 1);
        const nt = t / maxT;
        const step = n > 1 ? Math.min(HAND_MAX_STEP, HAND_SPAN / (n - 1)) : 0;
        const arc = HAND_ARC * (1 - nt * nt); // 沿卡面「上」方向 û=(0, sinθ, -cosθ)
        const stackUp = i * HAND_STACK; // 沿卡面法線 n̂=(0, cosθ, sinθ)：右卡恆在左卡上方
        cards.set(uid, {
          uid,
          frontUrl: front(uid),
          backUrl: back,
          faceUp: true,
          position: [
            handA.x + t * step,
            0.74 + arc * HAND_SIN + stackUp * HAND_COS,
            handA.z - 0.2 - arc * HAND_COS + stackUp * HAND_SIN,
          ],
          rotation: [HAND_TILT, 0, -nt * 0.1],
          zone: "hand",
          player,
          hoverOffset: [0, HAND_HOVER_SLIDE * HAND_SIN, -HAND_HOVER_SLIDE * HAND_COS],
          highlightOffset: [0, HAND_HIGHLIGHT_SLIDE * HAND_SIN, -HAND_HIGHLIGHT_SLIDE * HAND_COS],
        });
      } else {
        cards.set(uid, {
          uid,
          frontUrl: null,
          backUrl: back,
          faceUp: false,
          position: [handA.x - t * 0.48, CARD_T / 2 + i * CARD_T * 1.2, handA.z],
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
