import type { CourtArea } from "../engine/dsl";
import type { GameState, PlayerId, PlayerState, Stack } from "../engine/types";

const COURT_AREAS = ["serve", "receive", "toss", "attack"] as const satisfies readonly CourtArea[];

function addTop(stack: Stack, out: Set<number>) {
  const top = stack[stack.length - 1];
  if (top !== undefined) out.add(top);
}

function addVisibleBoardUids(player: PlayerState, out: Set<number>) {
  for (const area of COURT_AREAS) addTop(player[area], out);
  addTop(player.blockCenter, out);
  for (const uid of player.blockSides) out.add(uid);
}

export function visibleEffectSelectionUids(state: GameState, player: PlayerId): Set<number> {
  const visible = new Set<number>(state.players[player].hand);
  addVisibleBoardUids(state.players[0], visible);
  addVisibleBoardUids(state.players[1], visible);
  return visible;
}

export function canUseInPlaceEffectSelection(state: GameState, player: PlayerId, candidates: readonly number[]): boolean {
  if (candidates.length === 0) return false;
  const visible = visibleEffectSelectionUids(state, player);
  return candidates.every((uid) => visible.has(uid));
}
