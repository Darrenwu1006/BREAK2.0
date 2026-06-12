// AI 共用：登場選名（072/073 置換）與攔網整批選擇（同名/上限/選名約束）
import type { CardDb, GameState, PlayerId } from "../engine/types";
import { canDeployTo, deployNames, normName } from "../engine/effects";
import type { CourtArea } from "../engine/dsl";

/** 072/073 型卡：挑一個目前合法的登場卡名（一般卡回傳 undefined） */
export function pickDeployName(db: CardDb, state: GameState, p: PlayerId, uid: number, area: CourtArea, avoid?: Set<string>): string | undefined {
  const names = deployNames(db, state, uid);
  if (!names) return undefined;
  for (const n of names) {
    if (avoid?.has(normName(n))) continue;
    if (canDeployTo(db, state, p, uid, area, n)) return n;
  }
  return names.find((n) => !avoid?.has(normName(n)));
}

export interface BlockSelection {
  uids: number[];
  nameChoices: Record<number, string>;
}

/**
 * 從候選（已依優先序排列）挑出至多 maxN 張、卡名互不重複的攔網登場組合。
 * 072/073 自動選不撞名的卡名。
 */
export function selectBlockers(db: CardDb, state: GameState, p: PlayerId, ranked: number[], maxN: number): BlockSelection {
  const used = new Set<string>();
  const uids: number[] = [];
  const nameChoices: Record<number, string> = {};
  for (const u of ranked) {
    if (uids.length >= maxN) break;
    const choice = pickDeployName(db, state, p, u, "block", used);
    const name = normName(choice ?? db.get(state.cards[u]!)!.nameJa);
    if (used.has(name)) continue;
    used.add(name);
    uids.push(u);
    if (choice !== undefined) nameChoices[u] = choice;
  }
  return { uids, nameChoices };
}
