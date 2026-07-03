import type { GameState, PendingDecision, PlayerState, PointValue } from "./types";

export const GAME_STATE_SEARCH_CLONE_KEYS = [
  "rngState",
  "cards",
  "players",
  "setNo",
  "turnNo",
  "turnPlayer",
  "servingPlayer",
  "phase",
  "sub",
  "op",
  "dp",
  "judgeSuccess",
  "defenseChoice",
  "lostBy",
  "pendingDecision",
  "winner",
  "setupStage",
  "modifiers",
  "nameOverrides",
  "watchers",
  "restrictions",
  "pendingQueue",
  "turn1",
  "effectCtx",
  "lostRequest",
  "blockDeployedThisTurn",
  "blockHandDeploysThisTurn",
  "nextId",
  "log",
] as const satisfies readonly (keyof GameState)[];

export type SearchCloneMissingGameStateKeys = Exclude<keyof GameState, (typeof GAME_STATE_SEARCH_CLONE_KEYS)[number]>;
export const GAME_STATE_SEARCH_CLONE_KEY_COVERAGE: Record<SearchCloneMissingGameStateKeys, never> = {};

function clonePlayerState(player: PlayerState): PlayerState {
  return {
    deck: [...player.deck],
    hand: [...player.hand],
    setArea: [...player.setArea],
    drop: [...player.drop],
    eventArea: [...player.eventArea],
    serve: [...player.serve],
    blockCenter: [...player.blockCenter],
    blockSides: [...player.blockSides],
    receive: [...player.receive],
    toss: [...player.toss],
    attack: [...player.attack],
  };
}

function clonePointValue(value: PointValue | null): PointValue | null {
  return value === null ? null : { ...value };
}

function clonePendingDecision(decision: PendingDecision | null): PendingDecision | null {
  if (decision === null) return null;
  const copy: PendingDecision = {
    player: decision.player,
    type: decision.type,
  };
  if (decision.prompt !== undefined) copy.prompt = decision.prompt;
  if (decision.candidates !== undefined) copy.candidates = [...decision.candidates];
  if (decision.min !== undefined) copy.min = decision.min;
  if (decision.max !== undefined) copy.max = decision.max;
  if (decision.options !== undefined) copy.options = [...decision.options];
  return copy;
}

function cloneStructured<T>(value: T): T {
  return structuredClone(value) as T;
}

export function cloneStateForSearch(state: GameState): GameState {
  return {
    rngState: state.rngState,
    cards: { ...state.cards },
    players: [clonePlayerState(state.players[0]), clonePlayerState(state.players[1])],
    setNo: state.setNo,
    turnNo: state.turnNo,
    turnPlayer: state.turnPlayer,
    servingPlayer: state.servingPlayer,
    phase: state.phase,
    sub: state.sub,
    op: clonePointValue(state.op),
    dp: clonePointValue(state.dp),
    judgeSuccess: state.judgeSuccess,
    defenseChoice: state.defenseChoice,
    lostBy: state.lostBy,
    pendingDecision: clonePendingDecision(state.pendingDecision),
    winner: state.winner,
    setupStage: state.setupStage,
    modifiers: state.modifiers.map((modifier) => ({ ...modifier })),
    nameOverrides: { ...state.nameOverrides },
    watchers: state.watchers.length === 0 ? [] : cloneStructured(state.watchers),
    restrictions: state.restrictions.length === 0 ? [] : cloneStructured(state.restrictions),
    pendingQueue: state.pendingQueue.length === 0 ? [] : cloneStructured(state.pendingQueue),
    turn1: state.turn1.map((entry) => ({ ...entry })),
    effectCtx: state.effectCtx === null ? null : cloneStructured(state.effectCtx),
    lostRequest: state.lostRequest,
    blockDeployedThisTurn: [...state.blockDeployedThisTurn],
    blockHandDeploysThisTurn: [...state.blockHandDeploysThisTurn],
    nextId: state.nextId,
    log: [],
  };
}
