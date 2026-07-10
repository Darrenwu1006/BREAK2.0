// M9a 板面幾何：ZoneRef → 3D 座標的唯一事實來源。
// 座標系：x 向右、z 向觀者（P0 在近側 z>0、網子在 z=0）、y 向上；單位＝卡寬（CARD_W=1）。
// 拖曳合法區判定、演出動畫的落點都應查這張表，不要在元件裡散落硬編座標。

import type { PlayerId } from "../../engine/types";
import type { ZoneId } from "../presentation/events";

export const CARD_W = 1;
export const CARD_H = 1.4;
export const CARD_T = 0.02;

/** 桌墊尺寸（球場區） */
export const MAT_W = 12.4;
export const MAT_D = 9.6;
/** 桌面尺寸（桌墊外的木桌） */
export const TABLE_W = 17;
export const TABLE_D = 12.5;

export interface ZoneAnchor {
  x: number;
  z: number;
}

/** P0 視角的區域錨點；P1 取鏡像（x、z 同時取負） */
const P0_ANCHORS: Record<ZoneId, ZoneAnchor> = {
  blockCenter: { x: 0, z: 1.05 },
  blockSide: { x: 1.4, z: 1.05 }, // 第 2 張 side 在 -1.4（見 blockSideAnchor）
  receive: { x: -1.75, z: 2.5 },
  toss: { x: 0, z: 2.5 },
  attack: { x: 1.75, z: 2.5 },
  serve: { x: 3.5, z: 3.7 },
  eventArea: { x: -3.5, z: 3.2 },
  setArea: { x: -5.15, z: 2.1 },
  deck: { x: 5.15, z: 2.7 },
  drop: { x: 5.15, z: 1.0 },
  hand: { x: 0, z: 5.2 },
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

/** Set 區兩張並排 */
export function setAreaAnchor(player: PlayerId, index: number): ZoneAnchor {
  const a = zoneAnchor(player, "setArea");
  const off = (index === 0 ? -0.58 : 0.58) * (player === 0 ? 1 : -1);
  return { x: a.x + off, z: a.z };
}

/** 疊放區ガッツ的視覺外露：距頂 n 層，往網子方向退 */
export function stackPeek(player: PlayerId, fromTop: number): ZoneAnchor {
  const dz = -0.3 * fromTop * (player === 0 ? 1 : -1);
  return { x: 0, z: dz };
}
