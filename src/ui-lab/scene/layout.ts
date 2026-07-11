// M9a 板面幾何：ZoneRef → 3D 座標的唯一事實來源。
// 座標系：x 向右、z 向觀者（P0 在近側 z>0、網子在 z=0）、y 向上；單位＝卡寬（CARD_W=1）。
// 拖曳合法區判定、演出動畫的落點都應查這張表，不要在元件裡散落硬編座標。

import type { PlayerId } from "../../engine/types";
import type { ZoneId } from "../presentation/events";

export const CARD_W = 1;
export const CARD_H = 1.4;
/** 單卡厚度：保留實體感，但避免 40 張牌組看成厚磚。 */
export const CARD_T = 0.011;

/** 桌墊尺寸（球場區） */
export const MAT_W = 12.4;
export const MAT_D = 10.4;
/** 桌面尺寸（桌墊外的木桌） */
export const TABLE_W = 17;
export const TABLE_D = 13.2;

export interface ZoneAnchor {
  x: number;
  z: number;
}

/** 卡槽外框尺寸（SlotFrame 與間距檢查共用）：卡面＋0.22 邊 */
export const SLOT_W = CARD_W + 0.22;
export const SLOT_H = CARD_H + 0.22;

/** P0 視角的區域錨點；P1 取鏡像（x、z 同時取負）。
 *  [使用者 2026-07-10] 格子不可互相重疊：行距／欄距皆 > SLOT 尺寸——
 *  攔網列貼網、接/托/攻列往手牌方向拉開、Set 卡列往網子方向、左右外欄（Set/牌組/棄牌）獨立。 */
const P0_ANCHORS: Record<ZoneId, ZoneAnchor> = {
  blockCenter: { x: 0, z: 1.15 },
  blockSide: { x: 1.9, z: 1.15 }, // 第 2 張 side 在 -1.9（見 blockSideAnchor）
  receive: { x: -2.1, z: 3.0 },
  toss: { x: 0, z: 3.0 },
  attack: { x: 2.1, z: 3.0 },
  serve: { x: 3.6, z: 3.55 },
  eventArea: { x: -3.6, z: 3.55 },
  setArea: { x: -4.75, z: 1.4 }, // 兩張沿 x 左右展開（見 setAreaAnchor）
  deck: { x: 5.15, z: 2.95 },
  drop: { x: 5.15, z: 1.05 },
  hand: { x: 0, z: 5.35 },
};

export function zoneAnchor(player: PlayerId, zone: ZoneId): ZoneAnchor {
  const a = P0_ANCHORS[zone];
  return player === 0 ? { ...a } : { x: -a.x, z: -a.z };
}

/** サイドブロッカー槽位（最多 2）：中央攔網左右兩側 */
export function blockSideAnchor(player: PlayerId, index: number): ZoneAnchor {
  const a = zoneAnchor(player, "blockSide");
  return index === 0 ? a : { x: -a.x, z: a.z };
}

/** Set 區兩張沿 x 左右排；player 1 反向鏡像 index，保持雙方構圖對稱。 */
export function setAreaAnchor(player: PlayerId, index: number): ZoneAnchor {
  const a = zoneAnchor(player, "setArea");
  const off = (index === 0 ? -0.68 : 0.68) * (player === 0 ? 1 : -1);
  return { x: a.x + off, z: a.z };
}
