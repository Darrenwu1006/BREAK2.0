import type { CardDb, GameState, PlayerId, PlayerState } from "../engine/types";
import type { CharacterParams } from "../data/types";

type ZoneName = keyof PlayerState;

export type KnownDecks = readonly [readonly string[], readonly string[]];

const HIDDEN_FOR_SELF: ZoneName[] = ["deck", "setArea"];
const HIDDEN_FOR_OTHER: ZoneName[] = ["deck", "hand", "setArea"];
const ALL_ZONES: ZoneName[] = [
  "deck",
  "hand",
  "setArea",
  "drop",
  "eventArea",
  "serve",
  "blockCenter",
  "blockSides",
  "receive",
  "toss",
  "attack",
];

export interface RemainingPool {
  ids: string[];
  highAttackRate: number;
  highBlockRate: number;
}

function other(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

function hiddenZonesForPlayer(player: PlayerId, perspective: PlayerId): readonly ZoneName[] {
  return player === perspective ? HIDDEN_FOR_SELF : HIDDEN_FOR_OTHER;
}

function multisetMinus(source: readonly string[], remove: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of remove) counts.set(id, (counts.get(id) ?? 0) + 1);
  const result: string[] = [];
  for (const id of source) {
    const count = counts.get(id) ?? 0;
    if (count > 0) {
      counts.set(id, count - 1);
      continue;
    }
    result.push(id);
  }
  return result;
}

function cardIdsInZones(state: GameState, player: PlayerId, zones: readonly ZoneName[]): string[] {
  const ps = state.players[player];
  return zones.flatMap((zone) => ps[zone]).map((uid) => state.cards[uid]).filter((id): id is string => Boolean(id));
}

export function visibleCardIdsForRemaining(state: GameState, player: PlayerId, perspective: PlayerId): string[] {
  const hidden = new Set(hiddenZonesForPlayer(player, perspective));
  return cardIdsInZones(state, player, ALL_ZONES.filter((zone) => !hidden.has(zone)));
}

function countParamAtLeast(db: CardDb, ids: readonly string[], param: keyof CharacterParams, threshold: number): number {
  return ids.reduce((count, id) => {
    const value = db.get(id)?.params?.[param];
    return count + (typeof value === "number" && value >= threshold ? 1 : 0);
  }, 0);
}

export function expectedCountFromRate(pool: RemainingPool, hiddenCount: number, kind: "highAttack" | "highBlock"): number {
  const rate = kind === "highAttack" ? pool.highAttackRate : pool.highBlockRate;
  return rate * Math.max(0, hiddenCount);
}

export function remainingPoolForPlayer(
  db: CardDb,
  state: GameState,
  player: PlayerId,
  perspective: PlayerId,
  knownDecks?: KnownDecks,
): RemainingPool {
  const known = knownDecks?.[player] ?? [];
  if (known.length === 0) return { ids: [], highAttackRate: 0, highBlockRate: 0 };
  const visible = visibleCardIdsForRemaining(state, player, perspective);
  const ids = multisetMinus(known, visible);
  return {
    ids,
    highAttackRate: ids.length === 0 ? 0 : countParamAtLeast(db, ids, "attack", 3) / ids.length,
    highBlockRate: ids.length === 0 ? 0 : countParamAtLeast(db, ids, "block", 2) / ids.length,
  };
}

export function opponentRemainingHighAttackExpected(db: CardDb, state: GameState, perspective: PlayerId, knownDecks?: KnownDecks): number {
  const opp = other(perspective);
  const pool = remainingPoolForPlayer(db, state, opp, perspective, knownDecks);
  return expectedCountFromRate(pool, state.players[opp].hand.length + state.players[opp].deck.length, "highAttack");
}

export function opponentRemainingHighBlockExpected(db: CardDb, state: GameState, perspective: PlayerId, knownDecks?: KnownDecks): number {
  const opp = other(perspective);
  const pool = remainingPoolForPlayer(db, state, opp, perspective, knownDecks);
  return expectedCountFromRate(pool, state.players[opp].hand.length + state.players[opp].deck.length, "highBlock");
}

export function ownRemainingHighAttackExpected(db: CardDb, state: GameState, perspective: PlayerId, knownDecks?: KnownDecks): number {
  const mine = state.players[perspective];
  const handHighAttack = countParamAtLeast(db, cardIdsInZones(state, perspective, ["hand"]), "attack", 3);
  const pool = remainingPoolForPlayer(db, state, perspective, perspective, knownDecks);
  return handHighAttack + expectedCountFromRate(pool, mine.deck.length, "highAttack");
}
