import type { GameState, PlayerId } from "../engine/types";

export const UNDO_HISTORY_LIMIT = 10;

export type UndoHistory = GameState[];

export function pushUndoSnapshot(stack: UndoHistory, state: GameState, limit = UNDO_HISTORY_LIMIT): UndoHistory {
  const next = [...stack, structuredClone(state) as GameState];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function pushPlayerUndoSnapshot(
  stack: UndoHistory,
  state: GameState,
  player: PlayerId,
  limit = UNDO_HISTORY_LIMIT,
): UndoHistory {
  return state.pendingDecision?.player === player ? pushUndoSnapshot(stack, state, limit) : stack;
}

export function popUndoSnapshot(stack: UndoHistory): { snapshot: GameState | null; stack: UndoHistory } {
  if (stack.length === 0) return { snapshot: null, stack };
  const snapshot = stack[stack.length - 1]!;
  return {
    snapshot: structuredClone(snapshot) as GameState,
    stack: stack.slice(0, -1),
  };
}
