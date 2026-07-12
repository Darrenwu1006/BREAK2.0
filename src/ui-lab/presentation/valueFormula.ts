import type { ParamName } from "../../engine/dsl";
import { baseParam, effParam } from "../../engine/effects";
import type { CardDb, GameState, PlayerId } from "../../engine/types";

/** UI 演出快照：不改引擎 modifier 壽命，只保存玩家看見的算式。 */
export interface CardValueFormula {
  uid: number;
  base: number;
  delta: number;
  total: number;
}

const STACK_PARAMS = [
  ["serve", "serve"],
  ["blockCenter", "block"],
  ["receive", "receive"],
  ["toss", "toss"],
  ["attack", "attack"],
] as const satisfies readonly (readonly ["serve" | "blockCenter" | "receive" | "toss" | "attack", ParamName])[];

/** 鎖存一位玩家目前所有場上角色的有效值算式；疊放區只取最上層角色。 */
export function capturePlayerValueFormulas(db: CardDb, state: GameState, player: PlayerId): Map<number, CardValueFormula> {
  const out = new Map<number, CardValueFormula>();
  const add = (uid: number | undefined, param: ParamName): void => {
    if (uid === undefined) return;
    const base = baseParam(db, state, uid, param);
    const total = effParam(db, state, uid, param);
    if (base === null || total === null) return;
    out.set(uid, { uid, base, delta: total - base, total });
  };
  const ps = state.players[player];
  for (const [zone, param] of STACK_PARAMS) add(ps[zone].at(-1), param);
  for (const uid of ps.blockSides) add(uid, "block");
  return out;
}
