import { applyDecision, createGame } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { heuristicAiDecision, isHeuristicV2ProfileId } from "./heuristic";
import type { HeuristicV2ProfileId } from "./heuristic";
import { heuristicV1AiDecision } from "./heuristic-v1";
import { randomAiDecision } from "./random";
import type { DeckAxis } from "./benchmark-fixtures";

export type BenchmarkPolicyId = "random" | "heuristic-v1" | HeuristicV2ProfileId;
export type MatchOutcome = "complete" | "error" | "max-steps";
export type MatrixMode = "ring" | "all-vs-all";
export type LostReason = "judge-fail" | "no-deploy" | "voluntary" | "effect" | "unknown";

export interface BenchmarkDeckInput {
  name: string;
  ids: string[];
  axes?: DeckAxis[];
}

export interface MatchConfig {
  db: CardDb;
  decks: readonly [BenchmarkDeckInput, BenchmarkDeckInput];
  policies: readonly [BenchmarkPolicyId, BenchmarkPolicyId];
  seed: number;
  maxSteps?: number;
}

export interface PlayerInvariant {
  player: PlayerId;
  totalCards: number;
  uniqueCards: number;
  expectedCards: number;
  ok: boolean;
}

export interface MatchResult {
  seed: number;
  decks: [string, string];
  policies: [BenchmarkPolicyId, BenchmarkPolicyId];
  outcome: MatchOutcome;
  winner: PlayerId | null;
  winnerPolicy: BenchmarkPolicyId | null;
  steps: number;
  setNo: number;
  turnNo: number;
  setResults: SetResult[];
  averageRalliesPerSet: number;
  lostBy: [number, number];
  lostReasonsByPlayer: [Partial<Record<LostReason, number>>, Partial<Record<LostReason, number>>];
  invariants: [PlayerInvariant, PlayerInvariant];
  error?: string;
  logTail: string[];
}

export interface SetResult {
  setNo: number;
  winner: PlayerId;
  loser: PlayerId;
  lostReason: LostReason;
  rallies: number;
  logIndex: number;
}

export interface BatchConfig {
  db: CardDb;
  decks: readonly [BenchmarkDeckInput, BenchmarkDeckInput];
  policies: readonly [BenchmarkPolicyId, BenchmarkPolicyId];
  seeds: number[];
  maxSteps?: number;
}

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export interface BatchSummary {
  total: number;
  completed: number;
  errored: number;
  maxSteps: number;
  winsByPlayer: [number, number];
  winsByPolicy: Partial<Record<BenchmarkPolicyId, number>>;
  player0WinRate: number;
  player0WinRate95: ConfidenceInterval;
  averageSteps: number;
  averageSetNo: number;
  averageRalliesPerSet: number;
  setWinsByPlayer: [number, number];
  setWinsByReason: Partial<Record<LostReason, number>>;
  lostReasons: Partial<Record<LostReason, number>>;
}

export interface BatchReport {
  config: {
    decks: [string, string];
    deckCards: [string[], string[]];
    deckAxes: [DeckAxis[], DeckAxis[]];
    policies: [BenchmarkPolicyId, BenchmarkPolicyId];
    seeds: number[];
    maxSteps: number;
  };
  summary: BatchSummary;
  matches: MatchResult[];
}

export interface MatrixPairReport extends BatchReport {
  pairIndex: number;
  axes: [DeckAxis[], DeckAxis[]];
}

export interface MatrixConfig {
  db: CardDb;
  decks: readonly BenchmarkDeckInput[];
  policies: readonly [BenchmarkPolicyId, BenchmarkPolicyId];
  seedStart: number;
  gamesPerPair: number;
  maxSteps?: number;
  mode?: MatrixMode;
}

export interface MatrixSummary {
  pairs: number;
  totalGames: number;
  completed: number;
  errored: number;
  maxSteps: number;
  winsByPolicy: Partial<Record<BenchmarkPolicyId, number>>;
  winsByDeck: Record<string, number>;
  winsByAxis: Partial<Record<DeckAxis, number>>;
  averageRalliesPerSet: number;
  setWinsByReason: Partial<Record<LostReason, number>>;
  lostReasons: Partial<Record<LostReason, number>>;
}

export interface MatrixReport {
  config: {
    mode: MatrixMode;
    policies: [BenchmarkPolicyId, BenchmarkPolicyId];
    seedStart: number;
    gamesPerPair: number;
    maxSteps: number;
  };
  summary: MatrixSummary;
  pairs: MatrixPairReport[];
}

const DEFAULT_MAX_STEPS = 5000;

export function seededRnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x9e3779b9;
    let t = Math.imul(s ^ (s >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

function other(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

export function benchmarkPolicyDecision(
  policy: BenchmarkPolicyId,
  db: CardDb,
  state: GameState,
  randomByPlayer: [() => number, () => number],
): Decision {
  const pending = state.pendingDecision;
  if (!pending) throw new Error("目前沒有待決策，benchmark 無法推進");
  const player = pending.player as PlayerId;
  if (isHeuristicV2ProfileId(policy)) return heuristicAiDecision(db, state, policy);
  if (policy === "heuristic-v1") return heuristicV1AiDecision(db, state);
  return randomAiDecision(db, state, randomByPlayer[player]);
}

function collectPlayerUids(state: GameState, p: PlayerId): number[] {
  const ps = state.players[p];
  return [
    ...ps.deck,
    ...ps.hand,
    ...ps.setArea,
    ...ps.drop,
    ...ps.eventArea,
    ...ps.serve,
    ...ps.blockCenter,
    ...ps.blockSides,
    ...ps.receive,
    ...ps.toss,
    ...ps.attack,
  ];
}

function playerInvariant(state: GameState, p: PlayerId, expectedCards: number): PlayerInvariant {
  const uids = collectPlayerUids(state, p);
  const uniqueCards = new Set(uids).size;
  return {
    player: p,
    totalCards: uids.length,
    uniqueCards,
    expectedCards,
    ok: uids.length === expectedCards && uniqueCards === expectedCards,
  };
}

function classifyLostReason(state: GameState, logIndex: number): LostReason {
  const entry = state.log[logIndex];
  if (!entry || entry.player === null) return "unknown";
  const recent = state.log.slice(Math.max(0, logIndex - 4), logIndex).filter((candidate) => candidate.player === entry.player);
  if (recent.some((candidate) => candidate.text.includes("主動宣告 Lost"))) return "voluntary";
  if (recent.some((candidate) => candidate.text.includes("未登場角色"))) return "no-deploy";
  if (recent.some((candidate) => candidate.text.includes("判定") && candidate.text.includes("失敗"))) return "judge-fail";
  if (recent.some((candidate) => candidate.text.includes("效果") || candidate.text.includes("ブロックアウト"))) return "effect";
  return "unknown";
}

function collectLostStats(state: GameState): {
  lostBy: [number, number];
  lostReasonsByPlayer: [Partial<Record<LostReason, number>>, Partial<Record<LostReason, number>>];
  setResults: SetResult[];
} {
  const counts: [number, number] = [0, 0];
  const reasons: [Partial<Record<LostReason, number>>, Partial<Record<LostReason, number>>] = [{}, {}];
  const setResults: SetResult[] = [];
  for (let index = 0; index < state.log.length; index++) {
    const entry = state.log[index]!;
    if (!entry.text.includes("宣告 Lost") || entry.player === null) continue;
    counts[entry.player]++;
    const reason = classifyLostReason(state, index);
    reasons[entry.player][reason] = (reasons[entry.player][reason] ?? 0) + 1;
    setResults.push({
      setNo: entry.setNo,
      winner: other(entry.player),
      loser: entry.player,
      lostReason: reason,
      rallies: Math.max(1, entry.turnNo),
      logIndex: index,
    });
  }
  return { lostBy: counts, lostReasonsByPlayer: reasons, setResults };
}

function averageRallies(setResults: SetResult[]): number {
  if (setResults.length === 0) return 0;
  return setResults.reduce((sum, result) => sum + result.rallies, 0) / setResults.length;
}

function logTail(state: GameState, count = 8): string[] {
  return state.log.slice(-count).map((entry) => {
    const player = entry.player === null ? "-" : `P${entry.player}`;
    return `S${entry.setNo}T${entry.turnNo} ${player} ${entry.text}`;
  });
}

function resultFromState(config: MatchConfig, state: GameState, outcome: MatchOutcome, steps: number, error?: string): MatchResult {
  const winner = state.winner;
  const winnerPolicy = winner === null ? null : config.policies[winner];
  const lost = collectLostStats(state);
  return {
    seed: config.seed,
    decks: [config.decks[0].name, config.decks[1].name],
    policies: [config.policies[0], config.policies[1]],
    outcome,
    winner,
    winnerPolicy,
    steps,
    setNo: state.setNo,
    turnNo: state.turnNo,
    setResults: lost.setResults,
    averageRalliesPerSet: averageRallies(lost.setResults),
    lostBy: lost.lostBy,
    lostReasonsByPlayer: lost.lostReasonsByPlayer,
    invariants: [
      playerInvariant(state, 0, config.decks[0].ids.length),
      playerInvariant(state, 1, config.decks[1].ids.length),
    ],
    error,
    logTail: logTail(state),
  };
}

export function playBenchmarkMatch(config: MatchConfig): MatchResult {
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
  const randomByPlayer: [() => number, () => number] = [
    seededRnd(config.seed * 3 + 11),
    seededRnd(config.seed * 5 + 17),
  ];

  let state: GameState;
  try {
    state = createGame(config.db, {
      seed: config.seed,
      decks: [config.decks[0].ids, config.decks[1].ids],
    });
  } catch (error) {
    const fallback = createGame(config.db, {
      seed: config.seed,
      decks: [config.decks[0].ids, config.decks[1].ids],
      skipDeckValidation: true,
    });
    return resultFromState(config, fallback, "error", 0, error instanceof Error ? error.message : String(error));
  }

  for (let step = 0; step < maxSteps; step++) {
    if (state.phase === "gameOver") return resultFromState(config, state, "complete", step);
    const pending = state.pendingDecision;
    if (!pending) return resultFromState(config, state, "error", step, "遊戲未結束但沒有 pendingDecision");

    try {
      const player = pending.player as PlayerId;
      const decision = benchmarkPolicyDecision(config.policies[player], config.db, state, randomByPlayer);
      state = applyDecision(config.db, state, decision);
    } catch (error) {
      return resultFromState(config, state, "error", step, error instanceof Error ? error.message : String(error));
    }
  }

  return resultFromState(config, state, "max-steps", maxSteps, `超過 maxSteps=${maxSteps}`);
}

function wilson(successes: number, total: number): ConfidenceInterval {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

export function summarizeMatches(matches: MatchResult[]): BatchSummary {
  const completedMatches = matches.filter((match) => match.outcome === "complete");
  const winsByPlayer: [number, number] = [
    completedMatches.filter((match) => match.winner === 0).length,
    completedMatches.filter((match) => match.winner === 1).length,
  ];
  const winsByPolicy: Partial<Record<BenchmarkPolicyId, number>> = {};
  for (const match of completedMatches) {
    if (!match.winnerPolicy) continue;
    winsByPolicy[match.winnerPolicy] = (winsByPolicy[match.winnerPolicy] ?? 0) + 1;
  }
  const completed = completedMatches.length;
  const stepSum = completedMatches.reduce((sum, match) => sum + match.steps, 0);
  const setSum = completedMatches.reduce((sum, match) => sum + match.setNo, 0);
  const setResults = matches.flatMap((match) => match.setResults);
  const lostReasons: Partial<Record<LostReason, number>> = {};
  const setWinsByPlayer: [number, number] = [0, 0];
  const setWinsByReason: Partial<Record<LostReason, number>> = {};
  for (const result of setResults) {
    setWinsByPlayer[result.winner]++;
    setWinsByReason[result.lostReason] = (setWinsByReason[result.lostReason] ?? 0) + 1;
  }
  for (const match of matches) {
    for (const byPlayer of match.lostReasonsByPlayer) {
      for (const [reason, count] of Object.entries(byPlayer) as [LostReason, number][]) {
        lostReasons[reason] = (lostReasons[reason] ?? 0) + count;
      }
    }
  }
  return {
    total: matches.length,
    completed,
    errored: matches.filter((match) => match.outcome === "error").length,
    maxSteps: matches.filter((match) => match.outcome === "max-steps").length,
    winsByPlayer,
    winsByPolicy,
    player0WinRate: completed === 0 ? 0 : winsByPlayer[0] / completed,
    player0WinRate95: wilson(winsByPlayer[0], completed),
    averageSteps: completed === 0 ? 0 : stepSum / completed,
    averageSetNo: completed === 0 ? 0 : setSum / completed,
    averageRalliesPerSet: averageRallies(setResults),
    setWinsByPlayer,
    setWinsByReason,
    lostReasons,
  };
}

export function runBenchmarkBatch(config: BatchConfig): BatchReport {
  const matches = config.seeds.map((seed) => playBenchmarkMatch({ ...config, seed }));
  return {
    config: {
      decks: [config.decks[0].name, config.decks[1].name],
      deckCards: [[...config.decks[0].ids], [...config.decks[1].ids]],
      deckAxes: [config.decks[0].axes ?? [], config.decks[1].axes ?? []],
      policies: [config.policies[0], config.policies[1]],
      seeds: [...config.seeds],
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    },
    summary: summarizeMatches(matches),
    matches,
  };
}

export function mirroredSeeds(start: number, games: number): number[] {
  return Array.from({ length: games }, (_, index) => start + index);
}

function matrixPairs(decks: readonly BenchmarkDeckInput[], mode: MatrixMode): [BenchmarkDeckInput, BenchmarkDeckInput][] {
  if (decks.length < 2) throw new Error("matrix benchmark 至少需要兩副牌組");
  if (mode === "ring") return decks.map((deck, index) => [deck, decks[(index + 1) % decks.length]!]);
  const pairs: [BenchmarkDeckInput, BenchmarkDeckInput][] = [];
  for (let i = 0; i < decks.length; i++) {
    for (let j = 0; j < decks.length; j++) {
      if (i === j) continue;
      pairs.push([decks[i]!, decks[j]!]);
    }
  }
  return pairs;
}

function addCount<T extends string>(record: Partial<Record<T, number>>, key: T, amount = 1): void {
  record[key] = (record[key] ?? 0) + amount;
}

export function runBenchmarkMatrix(config: MatrixConfig): MatrixReport {
  const mode = config.mode ?? "ring";
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
  const pairs = matrixPairs(config.decks, mode).map((pair, pairIndex): MatrixPairReport => {
    const seedStart = config.seedStart + pairIndex * config.gamesPerPair;
    const report = runBenchmarkBatch({
      db: config.db,
      decks: pair,
      policies: config.policies,
      seeds: mirroredSeeds(seedStart, config.gamesPerPair),
      maxSteps,
    });
    return {
      ...report,
      pairIndex,
      axes: [pair[0].axes ?? [], pair[1].axes ?? []],
    };
  });

  const winsByPolicy: Partial<Record<BenchmarkPolicyId, number>> = {};
  const winsByDeck: Record<string, number> = {};
  const winsByAxis: Partial<Record<DeckAxis, number>> = {};
  const lostReasons: Partial<Record<LostReason, number>> = {};
  const setWinsByReason: Partial<Record<LostReason, number>> = {};
  let totalGames = 0;
  let completed = 0;
  let errored = 0;
  let maxStepsCount = 0;
  let rallyTotal = 0;
  let setTotal = 0;

  for (const pair of pairs) {
    totalGames += pair.summary.total;
    completed += pair.summary.completed;
    errored += pair.summary.errored;
    maxStepsCount += pair.summary.maxSteps;
    rallyTotal += pair.summary.averageRalliesPerSet * pair.summary.setWinsByPlayer.reduce((sum, count) => sum + count, 0);
    setTotal += pair.summary.setWinsByPlayer.reduce((sum, count) => sum + count, 0);
    for (const [policy, wins] of Object.entries(pair.summary.winsByPolicy) as [BenchmarkPolicyId, number][]) {
      addCount(winsByPolicy, policy, wins);
    }
    for (const [reason, count] of Object.entries(pair.summary.lostReasons) as [LostReason, number][]) {
      addCount(lostReasons, reason, count);
    }
    for (const [reason, count] of Object.entries(pair.summary.setWinsByReason) as [LostReason, number][]) {
      addCount(setWinsByReason, reason, count);
    }
    for (const match of pair.matches) {
      if (match.outcome !== "complete" || match.winner === null) continue;
      const winnerDeck = match.decks[match.winner]!;
      winsByDeck[winnerDeck] = (winsByDeck[winnerDeck] ?? 0) + 1;
      for (const axis of pair.axes[match.winner]) addCount(winsByAxis, axis);
    }
  }

  return {
    config: {
      mode,
      policies: [config.policies[0], config.policies[1]],
      seedStart: config.seedStart,
      gamesPerPair: config.gamesPerPair,
      maxSteps,
    },
    summary: {
      pairs: pairs.length,
      totalGames,
      completed,
      errored,
      maxSteps: maxStepsCount,
      winsByPolicy,
      winsByDeck,
      winsByAxis,
      averageRalliesPerSet: setTotal === 0 ? 0 : rallyTotal / setTotal,
      setWinsByReason,
      lostReasons,
    },
    pairs,
  };
}

export function swapPlayers(config: BatchConfig): BatchConfig {
  return {
    ...config,
    decks: [config.decks[1], config.decks[0]],
    policies: [config.policies[1], config.policies[0]],
  };
}

export function opponentOf(player: PlayerId): PlayerId {
  return other(player);
}
