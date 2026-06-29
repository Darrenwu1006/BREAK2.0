import type { GameState, PlayerId } from "../engine/types";

// 全區挑卡時，把候選卡依來源區域標示／分組，避免丟錯卡（#1）
export const ZONE_LABEL: Record<string, string> = {
  hand: "手牌",
  setArea: "Set 區",
  drop: "棄牌區",
  eventArea: "事件區",
  serve: "發球區",
  blockCenter: "中央攔網",
  blockSides: "側邊攔網",
  receive: "接球區",
  toss: "托球區",
  attack: "攻擊區",
  deck: "牌組",
};

// 顯示順序：手牌／場上由前到後／棄牌、牌組殿後
export const ZONE_ORDER = ["hand", "setArea", "attack", "toss", "receive", "serve", "blockCenter", "blockSides", "eventArea", "drop", "deck"];

/** 找出某 uid 目前所在的區域；回傳 owner（用於跨方候選時標示「對手」）與區域 key。 */
export function locateUidZone(state: GameState, uid: number): { owner: PlayerId; zone: string } | null {
  for (const owner of [0, 1] as PlayerId[]) {
    const ps = state.players[owner];
    for (const zone of ZONE_ORDER) {
      if ((ps[zone as keyof typeof ps] as number[]).includes(uid)) return { owner, zone };
    }
  }
  return null;
}

export interface ZoneGroup { key: string; owner: PlayerId; zone: string; uids: number[] }

/** 把候選 uid 依來源區域分組，保留候選原始順序、組內也保留出現順序。 */
export function groupCandidatesByZone(state: GameState, candidates: number[]): ZoneGroup[] {
  const groups: ZoneGroup[] = [];
  const index = new Map<string, number>();
  for (const uid of candidates) {
    const loc = locateUidZone(state, uid);
    const owner = (loc?.owner ?? 0) as PlayerId;
    const zone = loc?.zone ?? "unknown";
    const key = `${owner}:${zone}`;
    let gi = index.get(key);
    if (gi === undefined) { gi = groups.length; index.set(key, gi); groups.push({ key, owner, zone, uids: [] }); }
    groups[gi]!.uids.push(uid);
  }
  return groups;
}
