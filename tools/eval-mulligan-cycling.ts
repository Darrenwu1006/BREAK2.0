import { applyDecision, canChooseBlock, createGame, deployableUids, deployNames, nameOf, normName } from "../src/engine/engine";
import type { Card } from "../src/data/types";
import type { Action, EffectDef, ParamName, SkillDef } from "../src/engine/dsl";
import type { CardDb, Decision, GameState, PlayerId } from "../src/engine/types";
import { benchmarkDb, findBenchmarkDeck, type BenchmarkDeck } from "../src/ai/benchmark-fixtures";
import {
  HEURISTIC_V2_PROFILES,
  heuristicAiDecision,
  heuristicProfileForDeckAxes,
  isImmediateOneTouchBlocker,
  type HeuristicV2ProfileId,
  type HeuristicV2Weights,
} from "../src/ai/heuristic";
import { numberArg } from "../src/shared/argv";

export const TARGET_DECK_NAMES = [
  "青葉城西-四彈新及岩控制_指揮者京谷版",
  "烏野-四彈影日與同步攻擊",
  "音駒-四彈三年級與山本奇襲",
  "伊達工業-四彈茂庭三攔網ドシャット",
  "白鳥沢-四彈三年級與五色強攻",
  "梟谷-四彈木兎木葉三年級軸",
] as const;

const AREAS = ["serve", "block", "receive", "toss", "attack"] as const;
const TIMING_LABEL: Record<ParamName, string> = {
  serve: "發球",
  block: "攔網",
  receive: "接球",
  toss: "舉球",
  attack: "攻擊",
};

function cardOf(db: CardDb, state: GameState, uid: number): Card {
  return db.get(state.cards[uid]!)!;
}

function effectOf(card: Card): EffectDef | null {
  const effect = card.effect as EffectDef | null;
  return effect && Array.isArray(effect.skills) ? effect : null;
}

function timingMatches(card: Card, param: ParamName): boolean {
  return card.timing.some((x) => x.includes(TIMING_LABEL[param]));
}

function legacySkillBonus(card: Card, weights: HeuristicV2Weights, param?: ParamName): number {
  if (card.effectStatus === "vanilla" || card.effectStatus === "todo") return 0;
  let bonus = card.effectStatus === "script" ? 0.9 : 0.55;
  if (param && timingMatches(card, param)) bonus += 0.55 * (param === "block" ? weights.blockTimingValue : 1);
  if (card.skillJa?.includes("[=ターン1]")) bonus += 0.25;
  return bonus * weights.skillValue;
}

function legacySetupCardValue(db: CardDb, state: GameState, p: PlayerId, uid: number, serving: boolean, weights: HeuristicV2Weights): number {
  const card = cardOf(db, state, uid);
  if (card.type === "EVENT") {
    const usefulEarly = serving
      ? timingMatches(card, "serve") || timingMatches(card, "attack")
      : timingMatches(card, "receive") || timingMatches(card, "block") || timingMatches(card, "toss");
    return (usefulEarly ? 5.2 + legacySkillBonus(card, weights) : 2.6 + legacySkillBonus(card, weights) * 0.5) * weights.setupEventValue;
  }
  const pms = card.params;
  if (!pms) return 0;
  const serve = pms.serve ?? 0;
  const receive = pms.receive ?? 0;
  const toss = pms.toss ?? 0;
  const attack = pms.attack ?? 0;
  const block = pms.block ?? 0;
  const coverage = AREAS.filter((a) => pms[a] !== null && (pms[a] ?? 0) > 0).length * 0.45 * weights.coverageValue;
  const role = serving
    ? serve * 2.2 * weights.futureServeValue +
      attack * 1.35 * weights.futureAttackValue +
      receive * 1.1 * weights.futureDefenseValue +
      block * 0.8 * weights.futureBlockValue +
      toss * 0.75
    : receive * 2.25 * weights.futureDefenseValue +
      block * 1.25 * weights.futureBlockValue +
      attack * 1.15 * weights.futureAttackValue +
      toss * 1.0 +
      serve * 0.65 * weights.futureServeValue;
  return role + coverage + legacySkillBonus(card, weights, serving ? "serve" : "receive");
}

/** Phase M0 舊版單卡獨立門檻換牌（固定作為 M0 baseline 對照） */
export function legacyM0ChooseMulligan(db: CardDb, state: GameState, p: PlayerId, weights: HeuristicV2Weights): number[] {
  const serving = p === state.servingPlayer;
  const hand = state.players[p].hand;
  const scored = hand
    .map((uid) => ({ uid, score: legacySetupCardValue(db, state, p, uid, serving, weights), card: cardOf(db, state, uid) }))
    .sort((a, b) => a.score - b.score);

  const hasPrimary = scored.some((x) => {
    if (x.card.type !== "CHARACTER") return false;
    return serving ? (x.card.params?.serve ?? 0) >= 4 : (x.card.params?.receive ?? 0) >= 4;
  });
  const hasAttackLine = scored.some((x) => x.card.type === "CHARACTER" && (x.card.params?.attack ?? 0) >= 2);
  const hasToss = scored.some((x) => x.card.type === "CHARACTER" && (x.card.params?.toss ?? 0) > 0);
  const weakThreshold = (serving ? 4.2 : 4.6) + weights.mulliganWeakDelta;
  const baseMaxReturns = hasPrimary && (serving || hasAttackLine || hasToss) ? 2 : 3;
  const maxReturns = Math.max(1, Math.min(4, baseMaxReturns + weights.mulliganReturnDelta));
  const keepAtLeast = 3;
  const returns: number[] = [];

  for (const item of scored) {
    if (returns.length >= maxReturns || hand.length - returns.length <= keepAtLeast) break;
    const pms = item.card.params;
    const primaryValue = serving ? pms?.serve ?? 0 : pms?.receive ?? 0;
    const isUsefulEvent = item.card.type === "EVENT" && item.score >= weakThreshold + 0.6;
    if (item.score < weakThreshold && primaryValue < 3 && !isUsefulEvent) returns.push(item.uid);
  }

  if (!hasPrimary && returns.length < maxReturns) {
    for (const item of scored) {
      if (returns.includes(item.uid) || hand.length - returns.length <= keepAtLeast) continue;
      const primaryValue = serving ? item.card.params?.serve ?? 0 : item.card.params?.receive ?? 0;
      if (primaryValue < 3) returns.push(item.uid);
      if (returns.length >= maxReturns) break;
    }
  }
  return returns;
}

function sanitizeEffectCardsDecision(db: CardDb, state: GameState, d: Decision): Decision {
  if (d.type !== "effect-cards") return d;
  const aw = state.effectCtx?.awaiting;
  if (!aw || aw.kind !== "cards" || !aw.distinctNames) return d;
  const chosen: number[] = [];
  const usedNames = new Set<string>();
  for (const uid of [...d.uids, ...aw.candidates]) {
    if (!aw.candidates.includes(uid) || chosen.includes(uid)) continue;
    const n = nameOf(db, state, uid);
    if (usedNames.has(n)) continue;
    usedNames.add(n);
    chosen.push(uid);
    if (chosen.length >= Math.max(aw.min, Math.min(aw.max, d.uids.length))) break;
  }
  return { type: "effect-cards", uids: chosen };
}

export function legacyM0AiDecision(db: CardDb, state: GameState, profile: HeuristicV2ProfileId = "heuristic-v2"): Decision {
  if (state.pendingDecision?.type === "mulligan") {
    const p = state.pendingDecision.player;
    return { type: "mulligan", returnUids: legacyM0ChooseMulligan(db, state, p, HEURISTIC_V2_PROFILES[profile]) };
  }
  return sanitizeEffectCardsDecision(db, state, heuristicAiDecision(db, state, profile));
}

function candidateNamesForUid(db: CardDb, state: GameState, uid: number): string[] {
  const names = deployNames(db, state, uid);
  if (names && names.length > 0) return names.map(normName);
  return [normName(cardOf(db, state, uid).nameJa)];
}

function canPairNames(namesA: string[], namesB: string[]): boolean {
  for (const a of namesA) {
    for (const b of namesB) {
      if (a !== b) return true;
    }
  }
  return false;
}

/**
 * 檢查指定 uid 集合中是否存在合法「接球 (R>=4) + 舉球 (T>=1) + 異名攻擊 (A>=2)」三件套
 * （三張不同 uid，且滿足 トス≠レシーブ 與 アタック≠トス 同名限制）
 */
export function hasStrictOpeningTriad(db: CardDb, state: GameState, uids: readonly number[]): boolean {
  const charas = uids
    .map((uid) => ({ uid, card: cardOf(db, state, uid), names: candidateNamesForUid(db, state, uid) }))
    .filter((x) => x.card.type === "CHARACTER" && x.card.params);

  for (const r of charas) {
    if ((r.card.params?.receive ?? 0) < 4) continue;
    for (const t of charas) {
      if (t.uid === r.uid) continue;
      if ((t.card.params?.toss ?? 0) < 1) continue;
      if (!canPairNames(r.names, t.names)) continue;
      for (const a of charas) {
        if (a.uid === r.uid || a.uid === t.uid) continue;
        if ((a.card.params?.attack ?? 0) < 2) continue;
        if (!canPairNames(t.names, a.names)) continue;
        return true;
      }
    }
  }
  return false;
}

function actionHasEarlyTutorOrDraw(actions: Action[] | undefined): boolean {
  for (const act of actions ?? []) {
    if (act.op === "lookTopTutor" || act.op === "revealTopTutor" || act.op === "draw" || act.op === "drawToHandSize") {
      return true;
    }
    if (act.op === "gate" && actionHasEarlyTutorOrDraw(act.then)) return true;
    if (act.op === "if" && actionHasEarlyTutorOrDraw(act.then)) return true;
    if (act.op === "chooseOne" && act.options.some((o) => actionHasEarlyTutorOrDraw(o.actions))) return true;
  }
  return false;
}

function isEarlySearchOrReceiveHelper(card: Card): boolean {
  const eff = effectOf(card);
  if (!eff) return false;
  const earlyTiming = card.timing.some((t) => t.includes("抽牌") || t.includes("接球") || t.includes("自由") || t.includes("舉球"));
  if (!earlyTiming && card.type === "EVENT") return false;
  return eff.skills.some((s: SkillDef) => "actions" in s && actionHasEarlyTutorOrDraw(s.actions));
}

/**
 * 檢查是否具備 strictTriad，或僅缺 1 環但手牌有開局可用的檢索／抽濾卡可補位
 */
export function hasPlayableOpeningTriad(db: CardDb, state: GameState, uids: readonly number[]): boolean {
  if (hasStrictOpeningTriad(db, state, uids)) return true;
  const hasHelper = uids.some((uid) => isEarlySearchOrReceiveHelper(cardOf(db, state, uid)));
  if (!hasHelper) return false;

  const charas = uids
    .map((uid) => ({ uid, card: cardOf(db, state, uid), names: candidateNamesForUid(db, state, uid) }))
    .filter((x) => x.card.type === "CHARACTER" && x.card.params);

  // Check if any 2 of (R>=4, T>=1, A>=2) exist with distinct uids & valid names
  const hasR = charas.filter((c) => (c.card.params?.receive ?? 0) >= 4);
  const hasT = charas.filter((c) => (c.card.params?.toss ?? 0) >= 1);
  const hasA = charas.filter((c) => (c.card.params?.attack ?? 0) >= 2);

  // R + T
  for (const r of hasR) {
    for (const t of hasT) {
      if (r.uid !== t.uid && canPairNames(r.names, t.names)) return true;
    }
  }
  // T + A
  for (const t of hasT) {
    for (const a of hasA) {
      if (t.uid !== a.uid && canPairNames(t.names, a.names)) return true;
    }
  }
  // R + A
  for (const r of hasR) {
    for (const a of hasA) {
      if (r.uid !== a.uid) return true;
    }
  }
  return false;
}

export interface DeckOpeningStats {
  deckName: string;
  openings: number;
  servingStrictTriad: number;
  servingPlayableTriad: number;
  receivingStrictTriad: number;
  receivingPlayableTriad: number;
  totalStrictTriad: number;
  totalPlayableTriad: number;
  avgReturnedServing: number;
  avgReturnedReceiving: number;
  avgDuplicateNamesPostMulligan: number;
}

export function evaluateDeckOpenings(
  db: CardDb,
  deck: BenchmarkDeck,
  seedsPerRole: number,
  decisionFn: (db: CardDb, state: GameState, profile: HeuristicV2ProfileId) => Decision,
): DeckOpeningStats {
  const profile = heuristicProfileForDeckAxes(deck.axes);
  let servingStrict = 0;
  let servingPlayable = 0;
  let receivingStrict = 0;
  let receivingPlayable = 0;
  let returnedServing = 0;
  let returnedReceiving = 0;
  let duplicateNamesTotal = 0;

  for (let i = 0; i < seedsPerRole; i++) {
    const seed = 1000 + i;
    // 1. Player 0 as Serving
    {
      let s = createGame(db, { seed, decks: [deck.ids, deck.ids] });
      s = applyDecision(db, s, { type: "serve-rights", take: s.pendingDecision!.player === 0 });
      while (s.pendingDecision?.type === "mulligan") {
        const p = s.pendingDecision.player;
        const d = decisionFn(db, s, profile);
        if (p === 0 && d.type === "mulligan") returnedServing += d.returnUids.length;
        s = applyDecision(db, s, d);
      }
      const hand0 = s.players[0].hand;
      if (hasStrictOpeningTriad(db, s, hand0)) servingStrict++;
      if (hasPlayableOpeningTriad(db, s, hand0)) servingPlayable++;
      const charaNames = hand0
        .map((u) => cardOf(db, s, u))
        .filter((c) => c.type === "CHARACTER")
        .map((c) => normName(c.nameJa));
      duplicateNamesTotal += charaNames.length - new Set(charaNames).size;
    }

    // 2. Player 0 as Receiving (includes Set 1 first receive rule draw = deck[0] after setArea placement)
    {
      let s = createGame(db, { seed, decks: [deck.ids, deck.ids] });
      s = applyDecision(db, s, { type: "serve-rights", take: s.pendingDecision!.player !== 0 });
      while (s.pendingDecision?.type === "mulligan") {
        const p = s.pendingDecision.player;
        const d = decisionFn(db, s, profile);
        if (p === 0 && d.type === "mulligan") returnedReceiving += d.returnUids.length;
        s = applyDecision(db, s, d);
      }
      const hand0 = s.players[0].hand;
      const firstDrawUid = s.players[0].deck[0];
      const effectiveHand = firstDrawUid !== undefined ? [...hand0, firstDrawUid] : hand0;
      if (hasStrictOpeningTriad(db, s, effectiveHand)) receivingStrict++;
      if (hasPlayableOpeningTriad(db, s, effectiveHand)) receivingPlayable++;
      const charaNames = hand0
        .map((u) => cardOf(db, s, u))
        .filter((c) => c.type === "CHARACTER")
        .map((c) => normName(c.nameJa));
      duplicateNamesTotal += charaNames.length - new Set(charaNames).size;
    }
  }

  const totalOpenings = seedsPerRole * 2;
  return {
    deckName: deck.name,
    openings: totalOpenings,
    servingStrictTriad: servingStrict / seedsPerRole,
    servingPlayableTriad: servingPlayable / seedsPerRole,
    receivingStrictTriad: receivingStrict / seedsPerRole,
    receivingPlayableTriad: receivingPlayable / seedsPerRole,
    totalStrictTriad: (servingStrict + receivingStrict) / totalOpenings,
    totalPlayableTriad: (servingPlayable + receivingPlayable) / totalOpenings,
    avgReturnedServing: returnedServing / seedsPerRole,
    avgReturnedReceiving: returnedReceiving / seedsPerRole,
    avgDuplicateNamesPostMulligan: duplicateNamesTotal / totalOpenings,
  };
}

export interface HopelessDefenseStats {
  opportunities: number;
  blockCycled: number;
  receiveDrawnThenLost: number;
  emptyOrWasted: number;
  cyclingRate: number;
}

function maxBlockDpPossible(db: CardDb, state: GameState, p: PlayerId): number {
  if (!canChooseBlock(state)) return 0;
  const deployable = deployableUids(db, state, p, "block");
  if (deployable.some((uid) => isImmediateOneTouchBlocker(db, state, p, uid))) return 999;
  const maxN = Math.min(3, deployable.length);
  if (maxN <= 0) return 0;
  const sorted = deployable
    .map((u) => ({ uid: u, b: cardOf(db, state, u).params?.block ?? 0, name: normName(cardOf(db, state, u).nameJa) }))
    .sort((a, b) => b.b - a.b);
  let dp = 0;
  const used = new Set<string>();
  let count = 0;
  for (const item of sorted) {
    if (used.has(item.name)) continue;
    used.add(item.name);
    dp += item.b;
    count++;
    if (count >= maxN) break;
  }
  return dp;
}

function maxReceiveDpPossible(db: CardDb, state: GameState, p: PlayerId): number {
  const deployable = deployableUids(db, state, p, "receive");
  let best = 0;
  for (const uid of deployable) {
    const r = cardOf(db, state, uid).params?.receive ?? 0;
    if (r > best) best = r;
  }
  return best;
}

export function evaluateHopelessDefenseCycling(
  db: CardDb,
  decks: readonly BenchmarkDeck[],
  gamesPerPair: number,
  decisionFn: (db: CardDb, state: GameState, profile: HeuristicV2ProfileId) => Decision,
): HopelessDefenseStats {
  let opportunities = 0;
  let blockCycled = 0;
  let receiveDrawnThenLost = 0;
  let emptyOrWasted = 0;

  for (let i = 0; i < decks.length; i++) {
    const deckA = decks[i]!;
    const deckB = decks[(i + 1) % decks.length]!;
    const profA = heuristicProfileForDeckAxes(deckA.axes);
    const profB = heuristicProfileForDeckAxes(deckB.axes);

    for (let g = 0; g < gamesPerPair; g++) {
      let s = createGame(db, { seed: 5000 + i * 100 + g, decks: [deckA.ids, deckB.ids] });
      for (let step = 0; step < 3000 && s.phase !== "gameOver"; step++) {
        const pd = s.pendingDecision;
        if (!pd) break;
        const p = pd.player;
        const prof = p === 0 ? profA : profB;

        if (
          pd.type === "defense-choice" &&
          canChooseBlock(s) &&
          s.players[p].setArea.length > 0 &&
          s.players[p].hand.length >= 5
        ) {
          const op = s.op?.value ?? 0;
          const maxB = maxBlockDpPossible(db, s, p);
          const maxR = maxReceiveDpPossible(db, s, p);
          if (op >= 6 && maxB < op && maxR < op) {
            const setBefore = s.setNo;
            const d = decisionFn(db, s, prof);
            s = applyDecision(db, s, d);
            // Advance until either set ends or turn changes
            let deployedBlockCount = 0;
            let deployedReceiveCount = 0;
            while (
              s.phase !== "gameOver" &&
              s.phase !== "lostSet" &&
              s.phase !== "interval" &&
              s.setNo === setBefore &&
              s.turnPlayer === p
            ) {
              const nextPd = s.pendingDecision;
              if (!nextPd) break;
              const nextP = nextPd.player;
              const nextProf = nextP === 0 ? profA : profB;
              const rawNextD = decisionFn(db, s, nextProf);
              const nextD = sanitizeEffectCardsDecision(db, s, rawNextD);
              if (nextP === p && nextD.type === "deploy-block" && nextD.uids && nextD.uids.length > 0) {
                deployedBlockCount += nextD.uids.length;
              }
              if (nextP === p && nextD.type === "deploy-receive" && nextD.uid !== null) {
                deployedReceiveCount += 1;
              }
              s = applyDecision(db, s, nextD);
            }
            // Only count if this rally actually lost the set (confirming it was truly hopeless)
            if (s.lostBy === p) {
              opportunities++;
              if (d.type === "defense-choice" && d.choice === "block" && deployedBlockCount > 0) {
                blockCycled++;
              } else if (d.type === "defense-choice" && d.choice === "receive" && deployedReceiveCount === 0) {
                receiveDrawnThenLost++;
              } else {
                emptyOrWasted++;
              }
            }
            continue;
          }
        }

        const d = decisionFn(db, s, prof);
        s = applyDecision(db, s, d);
      }
    }
  }

  return {
    opportunities,
    blockCycled,
    receiveDrawnThenLost,
    emptyOrWasted,
    cyclingRate: opportunities > 0 ? blockCycled / opportunities : 0,
  };
}

export interface HeadToHeadResult {
  totalGames: number;
  m1Wins: number;
  m0Wins: number;
  m1WinRate: number;
  mirrorGames: number;
  mirrorM1Wins: number;
  mirrorM0Wins: number;
  mirrorM1WinRate: number;
  byDeckMirror: { deckName: string; m1Wins: number; m0Wins: number; winRate: number }[];
}

export function runM1VsM0HeadToHead(
  db: CardDb,
  decks: readonly BenchmarkDeck[],
  seedsPerDeckPair: number,
): HeadToHeadResult {
  let m1Wins = 0;
  let m0Wins = 0;
  let mirrorM1Wins = 0;
  let mirrorM0Wins = 0;
  const byDeckMirror: { deckName: string; m1Wins: number; m0Wins: number; winRate: number }[] = [];

  // 1. Same-deck mirror (40 seed pairs per deck = 80 games per deck, 480 games total)
  const mirrorSeeds = Math.max(20, seedsPerDeckPair * 5);
  for (let i = 0; i < decks.length; i++) {
    const deck = decks[i]!;
    const prof = heuristicProfileForDeckAxes(deck.axes);
    let dM1 = 0;
    let dM0 = 0;
    for (let sIdx = 0; sIdx < mirrorSeeds; sIdx++) {
      const seed = 12000 + i * 1000 + sIdx;
      for (const m1Seat of [0, 1] as const) {
        let s = createGame(db, { seed, decks: [deck.ids, deck.ids] });
        for (let step = 0; step < 4000 && s.phase !== "gameOver"; step++) {
          const p = s.pendingDecision!.player;
          const rawD = p === m1Seat ? heuristicAiDecision(db, s, prof) : legacyM0AiDecision(db, s, prof);
          const d = sanitizeEffectCardsDecision(db, s, rawD);
          s = applyDecision(db, s, d);
        }
        if (s.winner === m1Seat) {
          mirrorM1Wins++;
          dM1++;
        } else if (s.winner !== null) {
          mirrorM0Wins++;
          dM0++;
        }
      }
    }
    byDeckMirror.push({
      deckName: deck.name,
      m1Wins: dM1,
      m0Wins: dM0,
      winRate: dM1 + dM0 > 0 ? dM1 / (dM1 + dM0) : 0,
    });
  }

  // 2. All-vs-All cross-deck matrix
  for (let i = 0; i < decks.length; i++) {
    const deckA = decks[i]!;
    const profA = heuristicProfileForDeckAxes(deckA.axes);
    for (let j = 0; j < decks.length; j++) {
      const deckB = decks[j]!;
      const profB = heuristicProfileForDeckAxes(deckB.axes);

      for (let sIdx = 0; sIdx < seedsPerDeckPair; sIdx++) {
        const seed = 8000 + i * 1000 + j * 100 + sIdx;
        for (const m1Seat of [0, 1] as const) {
          let s = createGame(db, {
            seed,
            decks: m1Seat === 0 ? [deckA.ids, deckB.ids] : [deckB.ids, deckA.ids],
          });
          for (let step = 0; step < 4000 && s.phase !== "gameOver"; step++) {
            const p = s.pendingDecision!.player;
            const prof = m1Seat === 0 ? (p === 0 ? profA : profB) : (p === 0 ? profB : profA);
            const rawD = p === m1Seat ? heuristicAiDecision(db, s, prof) : legacyM0AiDecision(db, s, prof);
            const d = sanitizeEffectCardsDecision(db, s, rawD);
            s = applyDecision(db, s, d);
          }
          if (s.winner === m1Seat) {
            m1Wins++;
          } else if (s.winner !== null) {
            m0Wins++;
          }
        }
      }
    }
  }

  const totalGames = m1Wins + m0Wins;
  const mirrorGames = mirrorM1Wins + mirrorM0Wins;
  return {
    totalGames,
    m1Wins,
    m0Wins,
    m1WinRate: totalGames > 0 ? m1Wins / totalGames : 0,
    mirrorGames,
    mirrorM1Wins,
    mirrorM0Wins,
    mirrorM1WinRate: mirrorGames > 0 ? mirrorM1Wins / mirrorGames : 0,
    byDeckMirror,
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function runMain() {
  const seedsPerRole = Math.max(10, Math.floor(numberArg("seeds", 200)));
  const h2hSeeds = Math.max(2, Math.floor(numberArg("h2h-seeds", 10)));
  const decks = TARGET_DECK_NAMES.map((name) => findBenchmarkDeck(name));

  console.log(`=== M8 Phase M0 / M1 Evaluation (seedsPerRole=${seedsPerRole}, totalOpenings=${decks.length * seedsPerRole * 2}) ===\n`);

  const m0Stats = decks.map((d) => evaluateDeckOpenings(benchmarkDb, d, seedsPerRole, legacyM0AiDecision));
  const curStats = decks.map((d) => evaluateDeckOpenings(benchmarkDb, d, seedsPerRole, heuristicAiDecision));

  console.log("--- Opening Triad Rate (M0 Baseline vs Current Heuristic) ---");
  console.log("Deck | M0 Strict (Srv/Rcv/All) | Cur Strict (Srv/Rcv/All) | Delta Strict | M0 Playable | Cur Playable | AvgMull (M0->Cur) | AvgDup (M0->Cur)");
  for (let i = 0; i < decks.length; i++) {
    const m0 = m0Stats[i]!;
    const cur = curStats[i]!;
    const deltaStrict = (cur.totalStrictTriad - m0.totalStrictTriad) * 100;
    const m0AvgMull = (m0.avgReturnedServing + m0.avgReturnedReceiving) / 2;
    const curAvgMull = (cur.avgReturnedServing + cur.avgReturnedReceiving) / 2;
    console.log(
      `${m0.deckName} | ${pct(m0.servingStrictTriad)}/${pct(m0.receivingStrictTriad)}/${pct(m0.totalStrictTriad)} | ` +
        `${pct(cur.servingStrictTriad)}/${pct(cur.receivingStrictTriad)}/${pct(cur.totalStrictTriad)} | ` +
        `${deltaStrict >= 0 ? "+" : ""}${deltaStrict.toFixed(1)}pp | ` +
        `${pct(m0.totalPlayableTriad)} | ${pct(cur.totalPlayableTriad)} | ` +
        `${m0AvgMull.toFixed(2)} -> ${curAvgMull.toFixed(2)} | ` +
        `${m0.avgDuplicateNamesPostMulligan.toFixed(2)} -> ${cur.avgDuplicateNamesPostMulligan.toFixed(2)}`,
    );
  }

  const avg = <T>(arr: T[], fn: (x: T) => number) => arr.reduce((s, x) => s + fn(x), 0) / arr.length;
  const m0OverallStrict = avg(m0Stats, (x) => x.totalStrictTriad);
  const curOverallStrict = avg(curStats, (x) => x.totalStrictTriad);
  const m0OverallPlayable = avg(m0Stats, (x) => x.totalPlayableTriad);
  const curOverallPlayable = avg(curStats, (x) => x.totalPlayableTriad);
  const m0OverallRcvStrict = avg(m0Stats, (x) => x.receivingStrictTriad);
  const curOverallRcvStrict = avg(curStats, (x) => x.receivingStrictTriad);

  console.log(
    `\nOVERALL AVERAGE (6 Decks, ${decks.length * seedsPerRole * 2} openings):\n` +
      `  Strict Triad (All):      M0 = ${pct(m0OverallStrict)} -> Current = ${pct(curOverallStrict)} (${((curOverallStrict - m0OverallStrict) * 100).toFixed(1)}pp)\n` +
      `  Strict Triad (Receiving):M0 = ${pct(m0OverallRcvStrict)} -> Current = ${pct(curOverallRcvStrict)} (${((curOverallRcvStrict - m0OverallRcvStrict) * 100).toFixed(1)}pp)\n` +
      `  Playable Triad (All):    M0 = ${pct(m0OverallPlayable)} -> Current = ${pct(curOverallPlayable)} (${((curOverallPlayable - m0OverallPlayable) * 100).toFixed(1)}pp)`,
  );

  const hopelessM0 = evaluateHopelessDefenseCycling(benchmarkDb, decks, 20, legacyM0AiDecision);
  console.log(
    `\n--- Hopeless Defense Cycling Baseline (M0) ---\n` +
      `  Hopeless Attack Opportunities (hand>=5, DP<OP): ${hopelessM0.opportunities}\n` +
      `  Block Cycled (1~2 cards): ${hopelessM0.blockCycled} (${pct(hopelessM0.cyclingRate)})\n` +
      `  Receive Draw 1 then Lost: ${hopelessM0.receiveDrawnThenLost} (${hopelessM0.opportunities > 0 ? pct(hopelessM0.receiveDrawnThenLost / hopelessM0.opportunities) : "0.0%"})\n` +
      `  Wasted / Empty Block Lost: ${hopelessM0.emptyOrWasted}`,
  );

  const h2h = runM1VsM0HeadToHead(benchmarkDb, decks, h2hSeeds);
  console.log(
    `\n--- Head-to-Head Match Win Rate (Current M1 vs M0 Baseline) ---\n` +
      `  Same-Deck Mirror (${h2h.mirrorGames} games): M1 ${h2h.mirrorM1Wins} - ${h2h.mirrorM0Wins} M0 (${pct(h2h.mirrorM1WinRate)})\n` +
      `  All-vs-All Matrix (${h2h.totalGames} games): M1 ${h2h.m1Wins} - ${h2h.m0Wins} M0 (${pct(h2h.m1WinRate)})`,
  );
  for (const row of h2h.byDeckMirror) {
    console.log(`  [Mirror] ${row.deckName}: ${row.m1Wins}-${row.m0Wins} (${pct(row.winRate)})`);
  }
}

runMain();
