// 登場合法性（拆分自 effects.ts）[Claude 2026-07-16]
// 責任：登場禁止事項與登場限制的單一規則真相（†1-3-2-2、†1-4-5-4-1、Q191/Q196/Q204）。
// 依賴方向：deploy-legality → effect-helpers → (types, dsl)。

import type { CourtArea } from "./dsl";
import type { CardDb, GameState, PlayerId } from "./types";
import { baseParam, cardOf, deployNames, nameOf, normName, topChara } from "./effect-helpers";

function restrictionsFor(state: GameState, p: PlayerId, area: CourtArea) {
  return state.restrictions.filter((r) => r.player === p && r.area === area && r.setNo === state.setNo && r.activeTurn === state.turnNo);
}

/** 「スキルでカードを手札に加えられない」生效中（P01-035；Q239~241 含技能/事件抽牌） */
export function banHandAddActive(state: GameState, p: PlayerId): boolean {
  return state.restrictions.some((r) => r.player === p && r.banHandAdd && r.setNo === state.setNo && r.activeTurn === state.turnNo);
}

/** センターブロッカーのブロックP無視中？（Q372~374；P02-027） */
export function centerBlockNegated(state: GameState, p: PlayerId, uid: number): boolean {
  if (topChara(state.players[p].blockCenter) !== uid) return false;
  return state.restrictions.some((r) => r.player === p && r.negateCenterBlock && r.setNo === state.setNo && r.activeTurn === state.turnNo);
}


/** 攔網「還可登場」人數（無限制＝3）；maxCount 是 turn 累計上限（Q191/Q196/Q204）。
 *  origin "hand"＝登場步驟視角（fromHandOnly 限制計入 Q：P02-020）；"effect"＝效果登場視角（fromHandOnly 不適用） */
export function blockDeployMax(state: GameState, p: PlayerId, origin: "hand" | "effect" = "hand"): number {
  let remain = 3 - state.blockDeployedThisTurn[p];
  for (const r of restrictionsFor(state, p, "block")) {
    if (r.maxCount === undefined) continue;
    if (r.fromHandOnly) {
      if (origin === "hand") remain = Math.min(remain, r.maxCount - state.blockHandDeploysThisTurn[p]);
    } else {
      remain = Math.min(remain, r.maxCount - state.blockDeployedThisTurn[p]);
    }
  }
  return Math.max(0, remain);
}

/**
 * 單卡可否登場到指定區（參數「－」†1-3-2-2、登場限制、同名禁止 †1-4-5-4-1）。
 * chosenName＝072/073 的選名（未選時以任一可行名判斷）；效果登場（deployFromDrop）也走這裡。
 */
export type DeployLegalityCode =
  | "not-character"
  | "no-area-param"
  | "area-restricted"
  | "base-param-restricted"
  | "position-restricted"
  | "same-name";

/** null＝合法；code 供 UI／測試說明原因，判斷本身仍只有這一份規則真相。 */
export function deployLegality(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  uid: number,
  area: CourtArea,
  chosenName?: string,
  origin: "hand" | "effect" = "hand",
): DeployLegalityCode | null {
  const c = cardOf(db, state, uid);
  if (c.type !== "CHARACTER" || !c.params) return "not-character";
  if (c.params[area] === null) return "no-area-param";
  for (const r of restrictionsFor(state, p, area)) {
    if (r.fromHandOnly && origin !== "hand") continue; // 「手札から」限定（P01-084/P02-097）
    if (r.maxCount === 0) return "area-restricted";
    if (r.banBaseParamMin) {
      const b = baseParam(db, state, uid, r.banBaseParamMin.param);
      if (b !== null && b >= r.banBaseParamMin.value) return "base-param-restricted";
    }
    if (r.banPositions && r.banPositions.some((x) => c.positions.includes(x))) return "position-restricted";
  }
  // 同名禁止：トス≠レシーブ、アタック≠トス（攔網同名於 deploy-block 整批驗證）
  let banned: string | null = null;
  const ps = state.players[p];
  if (area === "toss") {
    const r = topChara(ps.receive);
    banned = r !== null ? nameOf(db, state, r) : null;
  } else if (area === "attack") {
    const t = topChara(ps.toss);
    banned = t !== null ? nameOf(db, state, t) : null;
  }
  if (banned !== null) {
    const names = deployNames(db, state, uid);
    if (chosenName !== undefined) {
      if (normName(chosenName) === banned) return "same-name";
    } else if (names) {
      if (names.every((n) => normName(n) === banned)) return "same-name"; // 兩個名字都撞名才不可（Q279）
    } else if (normName(c.nameJa) === banned) return "same-name";
  }
  return null;
}

export function canDeployTo(db: CardDb, state: GameState, p: PlayerId, uid: number, area: CourtArea, chosenName?: string, origin: "hand" | "effect" = "hand"): boolean {
  return deployLegality(db, state, p, uid, area, chosenName, origin) === null;
}

