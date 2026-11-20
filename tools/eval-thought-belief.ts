import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Card } from "../src/data/types";
import type { Action, PhaseIcon, SkillDef } from "../src/engine/dsl";
import type { CardDb, Decision, GameState, Phase, PlayerId, PlayerState } from "../src/engine/types";
import { canApplyDecision } from "../src/engine/decisions";
import { centerBlockNegated } from "../src/engine/deploy-legality";
import { allGutsOf, cardOf } from "../src/engine/effect-helpers";
import { applyDecision, deployNames, effParam, freeOptions, nameOf, normName, topChara } from "../src/engine/engine";
import { benchmarkDb } from "../src/ai/benchmark-fixtures";
import { determinizeHiddenState } from "../src/ai/coach";
import {
  heuristicAiDecision,
  heuristicProfileForDeckAxes,
  heuristicProfileForDeckText,
  type HeuristicV2ProfileId,
} from "../src/ai/heuristic";
import { createIsmctsReport } from "../src/ai/ismcts";
import { OPPONENT_ISMCTS_PRESET } from "../src/ai/ai-search";
import { flag, numberArg } from "../src/shared/argv";
import type { ReplayEntry, ReplaySession } from "../src/shared/replayHistory";

export const REPLAY_WINDOW = {
  since: "2026-10-28T00:00:00.000Z",
  until: "2026-11-19T16:00:00.000Z",
} as const;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PHASE_N0_FIXTURE_PATH = join(
  REPO_ROOT,
  "src",
  "ai",
  "__fixtures__",
  "phase-n0-real-endgames.json",
);
const REPLAYS_DIR = join(REPO_ROOT, "data", "replays");
const REPLAY_INDEX_PATH = join(REPLAYS_DIR, "index.jsonl");

const ALL_ZONES: readonly (keyof PlayerState)[] = [
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

const PUBLIC_HAND_SOURCE_ZONES: readonly (keyof PlayerState)[] = [
  "drop",
  "eventArea",
  "serve",
  "receive",
  "toss",
  "attack",
  "blockCenter",
  "blockSides",
];

const TIMING_ZH_TO_PHASE: Record<string, PhaseIcon> = {
  發球: "serve",
  攔網: "block",
  抽牌: "draw",
  接球: "receive",
  舉球: "toss",
  攻擊: "attack",
};

const MAX_FIXTURE_BYTES = 1_500_000;
const TARGET_CASES_PER_CATEGORY = 12;

export function isDirectCliRun(): boolean {
  if (process.env.VITEST) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  if (resolve(entry) === fileURLToPath(import.meta.url)) return true;
  // vite-node 在未加 --script 時會將 process.argv[1] 留在 vite-node 本身，且只有直接入口不會經過 dependencyRequest
  if (/(?:^|\/)vite-node(?:\.m?js)?$/.test(entry)) {
    const stack = new Error().stack ?? "";
    return !stack.includes("dependencyRequest");
  }
  return false;
}

// ---- 純函式（供單元測試與基準量測共用） ----

function eventSkillOf(card: Card): Extract<SkillDef, { kind: "event" }> | null {
  const eff = card.effect as { skills?: SkillDef[] } | null;
  if (!eff || !Array.isArray(eff.skills)) return null;
  return eff.skills.find((s): s is Extract<SkillDef, { kind: "event" }> => s.kind === "event") ?? null;
}

function eventTimingSet(card: Card, eventSkill: Extract<SkillDef, { kind: "event" }>): Set<PhaseIcon> {
  const set = new Set<PhaseIcon>();
  for (const icon of eventSkill.phaseIcons ?? []) set.add(icon);
  for (const label of card.timing) {
    for (const [zh, icon] of Object.entries(TIMING_ZH_TO_PHASE)) {
      if (label.includes(zh)) set.add(icon);
    }
  }
  return set;
}

function actionsHaveDefensiveBuff(actions: readonly Action[] | undefined): boolean {
  for (const act of actions ?? []) {
    if (
      act.op === "addParam" &&
      (act.param === "receive" || act.param === "block" || act.param === "choose") &&
      (act.amount ?? 1) > 0
    ) {
      return true;
    }
    if (act.op === "setParam" && (act.param === "receive" || act.param === "block")) {
      return true;
    }
    if (act.op === "addOpponentOp" && (act.amount ?? 0) < 0) {
      return true;
    }
    if (act.op === "gate" && (actionsHaveDefensiveBuff(act.then) || actionsHaveDefensiveBuff(act.else))) {
      return true;
    }
    if (act.op === "if" && actionsHaveDefensiveBuff(act.then)) {
      return true;
    }
    if (act.op === "chooseOne" && act.options.some((opt) => actionsHaveDefensiveBuff(opt.actions))) {
      return true;
    }
  }
  return false;
}

export function isDefensiveBuffEvent(card: Card, phase?: "receive" | "block"): boolean {
  if (card.type !== "EVENT") return false;
  const skill = eventSkillOf(card);
  if (!skill) return false;
  const timings = eventTimingSet(card, skill);
  const timingMatch = phase ? timings.has(phase) : timings.has("receive") || timings.has("block");
  if (!timingMatch) return false;
  return actionsHaveDefensiveBuff(skill.actions);
}

const DRAW_OR_TUTOR_OPS = new Set<Action["op"]>([
  "draw",
  "drawToHandSize",
  "lookTopTutor",
  "revealTopTutor",
  "lookTopTwoPick",
]);

function actionsHaveDrawOrTutor(actions: readonly Action[] | undefined): boolean {
  for (const act of actions ?? []) {
    if (DRAW_OR_TUTOR_OPS.has(act.op)) return true;
    if (act.op === "gate" && (actionsHaveDrawOrTutor(act.then) || actionsHaveDrawOrTutor(act.else))) return true;
    if (act.op === "if" && actionsHaveDrawOrTutor(act.then)) return true;
    if (act.op === "chooseOne" && act.options.some((opt) => actionsHaveDrawOrTutor(opt.actions))) return true;
  }
  return false;
}

export function isDrawOrTutorEvent(card: Card): boolean {
  if (card.type !== "EVENT") return false;
  const skill = eventSkillOf(card);
  if (!skill) return false;
  return actionsHaveDrawOrTutor(skill.actions);
}

export function currentDefenseDp(db: CardDb, state: GameState, p: PlayerId): number {
  const ps = state.players[p];
  if (state.phase === "receive") {
    const rTop = topChara(ps.receive);
    return rTop !== null ? (effParam(db, state, rTop, "receive") ?? 0) : 0;
  }
  if (state.phase === "block") {
    let dp = 0;
    const center = topChara(ps.blockCenter);
    if (center !== null && !centerBlockNegated(state, p, center)) {
      dp += effParam(db, state, center, "block") ?? 0;
    }
    for (const sideUid of ps.blockSides) {
      dp += effParam(db, state, sideUid, "block") ?? 0;
    }
    return dp;
  }
  return 0;
}

export function courtGutsCount(state: GameState, p: PlayerId): number {
  return allGutsOf(state, p).length;
}

function candidateDeployNames(db: CardDb, state: GameState, uid: number): string[] {
  const names = deployNames(db, state, uid);
  if (names && names.length > 0) return names.map(normName);
  return [normName(cardOf(db, state, uid).nameJa)];
}

function passesTurnRestrictionsForArea(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  uid: number,
  area: "toss" | "attack",
  chosenName: string,
): boolean {
  const card = cardOf(db, state, uid);
  const normChosen = normName(chosenName);
  for (const r of state.restrictions) {
    if (r.player !== p || r.area !== area || r.setNo !== state.setNo || r.activeTurn !== state.turnNo) continue;
    if (r.maxCount === 0) return false;
    if (r.banBaseParamMin) {
      const b = card.params?.[r.banBaseParamMin.param] ?? null;
      if (b !== null && b >= r.banBaseParamMin.value) return false;
    }
    if (r.banPositions && r.banPositions.some((pos) => card.positions.includes(pos))) return false;
    if (r.banNames && r.banNames.map(normName).includes(normChosen)) return false;
  }
  return true;
}

function hasAttackDeploySkill(card: Card): boolean {
  const eff = card.effect as { skills?: SkillDef[] } | null;
  if (!eff || !Array.isArray(eff.skills)) return false;
  return eff.skills.some(
    (s) =>
      s.kind === "passive" &&
      s.trigger.on === "deploy" &&
      s.areaIcons?.includes("attack") &&
      actionsHaveAttackParamMod(s.actions),
  );
}

function actionsHaveAttackParamMod(actions: readonly Action[] | undefined): boolean {
  for (const act of actions ?? []) {
    if (act.op === "addParam" && act.param === "attack" && (act.amount ?? 1) > 0) return true;
    if (act.op === "setParam" && act.param === "attack" && act.value >= 1) return true;
    if (act.op === "gate" && (actionsHaveAttackParamMod(act.then) || actionsHaveAttackParamMod(act.else))) return true;
    if (act.op === "if" && actionsHaveAttackParamMod(act.then)) return true;
    if (act.op === "chooseOne" && act.options.some((opt) => actionsHaveAttackParamMod(opt.actions))) return true;
  }
  return false;
}

function canServeAsAttackerCard(card: Card): boolean {
  if (card.type !== "CHARACTER" || !card.params) return false;
  if (card.params.attack === null) return false;
  if (card.params.attack >= 1) return true;
  // 部分 0 基攻條件式攻擊手（如 P01-043/P04-063 木兎）可合法登場攻擊
  return hasAttackDeploySkill(card);
}

export function hasLegalFollowupTossAttack(db: CardDb, state: GameState, p: PlayerId): boolean {
  const ps = state.players[p];
  const hand = ps.hand;

  // 若已在 toss 階段且本輪已登場托球手，只檢查手牌是否存在異名合法攻擊手
  if (state.phase === "toss" && state.sub >= 1) {
    const tTop = topChara(ps.toss);
    if (tTop !== null) {
      const tName = nameOf(db, state, tTop);
      for (const aUid of hand) {
        const aCard = cardOf(db, state, aUid);
        if (!canServeAsAttackerCard(aCard)) continue;
        const aNames = candidateDeployNames(db, state, aUid);
        if (aNames.some((an) => an !== tName && passesTurnRestrictionsForArea(db, state, p, aUid, "attack", an))) {
          return true;
        }
      }
      return false;
    }
  }

  const rTop = state.phase === "receive" && ps.receive.length > 0 ? topChara(ps.receive) : null;
  const bannedTossName = rTop !== null ? nameOf(db, state, rTop) : null;

  for (const tUid of hand) {
    const tCard = cardOf(db, state, tUid);
    if (tCard.type !== "CHARACTER" || tCard.params?.toss === null || (tCard.params?.toss ?? 0) < 1) continue;
    const validTNames = candidateDeployNames(db, state, tUid).filter(
      (n) => n !== bannedTossName && passesTurnRestrictionsForArea(db, state, p, tUid, "toss", n),
    );
    if (validTNames.length === 0) continue;

    for (const aUid of hand) {
      if (aUid === tUid) continue;
      const aCard = cardOf(db, state, aUid);
      if (!canServeAsAttackerCard(aCard)) continue;
      const aNames = candidateDeployNames(db, state, aUid);
      for (const tn of validTNames) {
        if (aNames.some((an) => an !== tn && passesTurnRestrictionsForArea(db, state, p, aUid, "attack", an))) {
          return true;
        }
      }
    }
  }
  return false;
}

function cardNameByUid(state: GameState, uid: number, db: CardDb = benchmarkDb): string | null {
  const cardId = state.cards[uid];
  if (!cardId) return null;
  const card = db.get(cardId);
  return card ? normName(card.nameJa) : null;
}

/**
 * 偵測單一 ReplayEntry 中對手公開進入手牌之卡片 uid。
 * - 來源為對手公開區（drop / eventArea / court 五區）→ 直接判定公開入手。
 * - 來源為牌組 → 僅限 `revealTopTutor`（同 entry 或前一步 `awaiting.purpose==="tutor"` 尾端 `公開牌組頂：` + 本步 `加入手牌` 且卡名相符），絕不偷看普通抽牌或 `lookTopTutor`。
 */
export function detectPublicHandAdditionsInEntry(entry: ReplayEntry, oppPlayer: PlayerId): number[] {
  if (entry.before.setNo !== entry.after.setNo) return [];
  const oppBefore = entry.before.players[oppPlayer];
  const oppAfter = entry.after.players[oppPlayer];
  const beforeHand = new Set(oppBefore.hand);
  const addedUids = oppAfter.hand.filter((uid) => !beforeHand.has(uid));
  if (addedUids.length === 0) return [];

  const beforePublic = new Set<number>(PUBLIC_HAND_SOURCE_ZONES.flatMap((zone) => oppBefore[zone]));
  const beforeDeck = new Set<number>(oppBefore.deck);
  const stepLogs = entry.after.log.slice(entry.logStart, entry.logEnd);

  // 收集本步或緊接前一步（revealTopTutor 分兩步等待 effect-cards 時）公開牌組頂的卡名
  const revealedNames: string[] = [];
  for (const l of stepLogs) {
    if (l.text.startsWith("公開牌組頂：") && !l.text.includes("置於牌組底")) {
      revealedNames.push(normName(l.text.slice("公開牌組頂：".length)));
    }
  }
  if (
    revealedNames.length === 0 &&
    entry.before.effectCtx?.awaiting?.kind === "cards" &&
    entry.before.effectCtx.awaiting.purpose === "tutor" &&
    entry.before.log.length > 0
  ) {
    const tailLog = entry.before.log[entry.before.log.length - 1];
    if (
      tailLog &&
      tailLog.setNo === entry.before.setNo &&
      tailLog.player === oppPlayer &&
      tailLog.text.startsWith("公開牌組頂：") &&
      !tailLog.text.includes("置於牌組底")
    ) {
      revealedNames.push(normName(tailLog.text.slice("公開牌組頂：".length)));
    }
  }

  const addedNamesInLogs = new Set<string>();
  for (const l of stepLogs) {
    if (l.player === oppPlayer && l.text.endsWith(" 加入手牌")) {
      const candidateName = normName(l.text.slice(0, -" 加入手牌".length));
      if (candidateName) addedNamesInLogs.add(candidateName);
    }
  }

  const remainingRevealed = [...revealedNames];
  const result: number[] = [];

  for (const uid of addedUids) {
    if (beforePublic.has(uid)) {
      result.push(uid);
      continue;
    }
    if (beforeDeck.has(uid) && remainingRevealed.length > 0) {
      const cardName = cardNameByUid(entry.after, uid);
      if (!cardName) continue;
      const revIdx = remainingRevealed.indexOf(cardName);
      if (revIdx >= 0 && addedNamesInLogs.has(cardName)) {
        remainingRevealed.splice(revIdx, 1);
        result.push(uid);
      }
    }
  }

  return result;
}

function inferRolloutPolicyForDeck(db: CardDb, deckIds: readonly string[], label?: string): HeuristicV2ProfileId {
  if (label) return heuristicProfileForDeckText(label);
  let servePressure = 0;
  let blockPressure = 0;
  let attackPressure = 0;
  let receivePressure = 0;
  let playableAreas = 0;
  for (const id of deckIds) {
    const card = db.get(id);
    if (!card?.params) continue;
    if ((card.params.serve ?? -Infinity) >= 4) servePressure++;
    if ((card.params.block ?? -Infinity) >= 3) blockPressure++;
    if ((card.params.attack ?? -Infinity) >= 4) attackPressure++;
    if ((card.params.receive ?? -Infinity) >= 4) receivePressure++;
    playableAreas += (["serve", "block", "receive", "toss", "attack"] as const).filter(
      (area) => card.params?.[area] !== null,
    ).length;
  }
  const axes: string[] = [];
  if (servePressure >= 8) axes.push("serve");
  if (blockPressure >= 10) axes.push("block");
  if (attackPressure >= 10) axes.push("burst");
  if (receivePressure >= 10) axes.push("defense");
  if (axes.length === 0 || playableAreas >= 80) axes.push("hybrid");
  return heuristicProfileForDeckAxes(axes);
}

function evaluateWaveOutcome(
  cur: GameState,
  aiPlayer: PlayerId,
  startSetNo: number,
  startTurnNo: number,
  step: number,
): boolean | null {
  if (cur.phase === "gameOver" || cur.winner !== null) {
    return cur.winner === aiPlayer;
  }
  if (cur.phase === "lostSet" || cur.phase === "interval") {
    if (cur.lostBy !== null) return cur.lostBy !== aiPlayer;
  }
  if (cur.setNo !== startSetNo) {
    return cur.servingPlayer === aiPlayer;
  }
  if (step > 0 && cur.turnPlayer === aiPlayer && cur.judgeSuccess === true) {
    return true;
  }
  if (cur.turnPlayer === aiPlayer && (cur.phase === "toss" || cur.phase === "attack")) {
    return true;
  }
  if (cur.turnPlayer !== aiPlayer) {
    return true;
  }
  if (cur.turnNo > startTurnNo) {
    return true;
  }
  return null;
}

export function isBurstWaveSurvived(
  db: CardDb,
  startState: GameState,
  knownDecks: readonly [readonly string[], readonly string[]],
  aiPlayer: PlayerId,
  aiPolicy: "heuristic" | "ismcts",
  seed: number,
  ismctsIters: number,
  rolloutPolicyOverride?: HeuristicV2ProfileId,
  leafRolloutHorizon: number = OPPONENT_ISMCTS_PRESET.leafRolloutHorizon,
): boolean {
  const oppPlayer: PlayerId = aiPlayer === 0 ? 1 : 0;
  const aiProfile = rolloutPolicyOverride ?? inferRolloutPolicyForDeck(db, knownDecks[aiPlayer]);
  const oppProfile = inferRolloutPolicyForDeck(db, knownDecks[oppPlayer]);
  const startSetNo = startState.setNo;
  const startTurnNo = startState.turnNo;

  let cur: GameState = structuredClone(startState);
  for (let step = 0; step < 60; step++) {
    const outcome = evaluateWaveOutcome(cur, aiPlayer, startSetNo, startTurnNo, step);
    if (outcome !== null) return outcome;

    const pd = cur.pendingDecision;
    if (!pd) break;

    let decision: Decision;
    if (pd.player === aiPlayer) {
      decision =
        aiPolicy === "ismcts"
          ? createIsmctsReport(db, cur, {
              ...OPPONENT_ISMCTS_PRESET,
              leafRolloutHorizon,
              perspectivePlayer: aiPlayer,
              knownDecks,
              iterations: ismctsIters,
              rolloutPolicy: aiProfile,
              seed: seed + step * 37,
            }).bestAction.decision
          : heuristicAiDecision(db, cur, aiProfile);
    } else {
      decision = heuristicAiDecision(db, cur, oppProfile);
    }

    if (!canApplyDecision(db, cur, decision)) {
      const fallback = heuristicAiDecision(db, cur, pd.player === aiPlayer ? aiProfile : oppProfile);
      if (!canApplyDecision(db, cur, fallback)) return false;
      decision = fallback;
    }

    cur = applyDecision(db, cur, decision, { execMode: "search" });
  }

  return evaluateWaveOutcome(cur, aiPlayer, startSetNo, startTurnNo, 60) ?? false;
}

// ---- 夾具型別與驗證 ----

export type FixtureCategory =
  | "safeFullHandDefEvent"
  | "safeMissingPairDraw"
  | "publicHandRecall"
  | "highGutsBurst";

export interface EndgameFixtureCase {
  id: string;
  category: FixtureCategory;
  replayId: string;
  startedAt: string;
  entryIndex: number;
  deckLabels: [string, string];
  knownDecks: [string[], string[]];
  aiPlayer: PlayerId;
  state: GameState;
  historicalDecision: Decision;
  metadata: {
    setNo: number;
    turnNo: number;
    phase: Phase;
    incomingOp: number;
    currentDefenseDp: number;
    oppCourtGuts: number;
    hasLegalFollowupTossAttack: boolean;
    playableDefBuffEventUids?: number[];
    playableDrawDefEventUids?: number[];
    expectedKnownOppHandCardIds?: string[];
    publicAdditionLogTexts?: string[];
    historicalBurnedDefEvent?: boolean;
    historicalPlayedDrawEvent?: boolean;
    historicalSurvived?: boolean;
  };
}

export interface PhaseN0EndgamesFixture {
  schemaVersion: "phase-n0-endgames-v1";
  extractedAt: string;
  window: { since: string; until: string };
  sourceReplayCount: number;
  cases: {
    safeFullHandDefEvent: EndgameFixtureCase[];
    safeMissingPairDraw: EndgameFixtureCase[];
    publicHandRecall: EndgameFixtureCase[];
    highGutsBurst: EndgameFixtureCase[];
  };
}

export interface RatioMetric {
  numerator: number;
  denominator: number;
  rate: number;
}

export interface PublicHandRecallReport {
  caseCount: number;
  seedsPerCase: number;
  totalKnownCards: number;
  recalledCards: number;
  accuracy: number;
}

export interface ThoughtBeliefMetricsReport {
  safeFullHandDefEventBurnRate: RatioMetric;
  safeMissingPairDrawRate: RatioMetric;
  publicHandRecallAccuracy: PublicHandRecallReport;
  highGutsSurvivalRate: RatioMetric & {
    op7Plus: RatioMetric;
  };
}

export interface ReplayWindowScanResult {
  totalIndexEntries: number;
  windowReplays: number;
  validReplays: number;
  skippedInvalidReplays: number;
  historical: ThoughtBeliefMetricsReport;
  candidates: {
    safeFullHandDefEvent: EndgameFixtureCase[];
    safeMissingPairDraw: EndgameFixtureCase[];
    publicHandRecall: EndgameFixtureCase[];
    highGutsBurst: EndgameFixtureCase[];
  };
}

export interface ThoughtBeliefFixtureEvaluation {
  schemaVersion: "phase-n0-endgames-v1";
  counts: {
    safeFullHandDefEvent: number;
    safeMissingPairDraw: number;
    publicHandRecall: number;
    highGutsBurst: number;
  };
  historical: ThoughtBeliefMetricsReport;
  heuristic: ThoughtBeliefMetricsReport;
  ismcts?: ThoughtBeliefMetricsReport;
}

export interface EvaluateFixtureOptions {
  fixture?: PhaseN0EndgamesFixture;
  fixturePath?: string;
  ismctsIterations?: number;
  recallSeeds?: number;
  seed?: number;
  runIsmcts?: boolean;
  leafRolloutHorizon?: number;
}

interface ReplayIndexRow {
  id: string;
  startedAt: string;
  decks?: string[];
  winner?: PlayerId | null;
  entryCount?: number;
}

export function validateKnownDecks(db: CardDb, decks: readonly [readonly string[], readonly string[]]): boolean {
  if (decks.length !== 2) return false;
  for (const deck of decks) {
    if (deck.length !== 40) return false;
    for (const id of deck) {
      if (!db.has(id)) return false;
    }
  }
  return true;
}

export function validateStateConservation(
  db: CardDb,
  state: GameState,
  knownDecks?: readonly [readonly string[], readonly string[]],
): boolean {
  const allSeen = new Set<number>();
  for (const pid of [0, 1] as const) {
    const ps = state.players[pid];
    const uids = ALL_ZONES.flatMap((zone) => ps[zone]);
    if (uids.length !== 40) return false;
    const pSet = new Set<number>();
    const cardCounts = new Map<string, number>();
    for (const uid of uids) {
      if (pSet.has(uid) || allSeen.has(uid)) return false;
      pSet.add(uid);
      allSeen.add(uid);
      const cardId = state.cards[uid];
      if (!cardId || !db.has(cardId)) return false;
      cardCounts.set(cardId, (cardCounts.get(cardId) ?? 0) + 1);
    }
    if (knownDecks) {
      const deckCounts = new Map<string, number>();
      for (const id of knownDecks[pid]) deckCounts.set(id, (deckCounts.get(id) ?? 0) + 1);
      if (deckCounts.size !== cardCounts.size) return false;
      for (const [id, count] of deckCounts) {
        if (cardCounts.get(id) !== count) return false;
      }
    }
  }
  return allSeen.size === 80;
}

function multisetIntersectionSize(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const id of b) counts.set(id, (counts.get(id) ?? 0) + 1);
  let hits = 0;
  for (const id of a) {
    const left = counts.get(id) ?? 0;
    if (left > 0) {
      counts.set(id, left - 1);
      hits++;
    }
  }
  return hits;
}

function ratio(num: number, den: number): RatioMetric {
  return { numerator: num, denominator: den, rate: den > 0 ? num / den : 0 };
}

function evaluatePublicHandRecallCases(
  cases: readonly EndgameFixtureCase[],
  recallSeeds: number,
  baseSeed: number,
): PublicHandRecallReport {
  if (cases.length === 0) {
    return { caseCount: 0, seedsPerCase: recallSeeds, totalKnownCards: 0, recalledCards: 0, accuracy: 0 };
  }
  let totalKnownCards = 0;
  let recalledCards = 0;
  let sumCaseAccuracy = 0;

  for (let i = 0; i < cases.length; i++) {
    const item = cases[i]!;
    const expected = item.metadata.expectedKnownOppHandCardIds ?? [];
    if (expected.length === 0) continue;
    const oppPlayer: PlayerId = item.aiPlayer === 0 ? 1 : 0;
    let caseHits = 0;
    for (let k = 0; k < recallSeeds; k++) {
      const detSeed = baseSeed + i * 1009 + k * 37;
      const det = determinizeHiddenState(item.state, item.aiPlayer, item.knownDecks, detSeed);
      const detOppHandCardIds = det.players[oppPlayer].hand.map((uid) => det.cards[uid]!).filter(Boolean);
      caseHits += multisetIntersectionSize(expected, detOppHandCardIds);
    }
    const caseTotal = expected.length * recallSeeds;
    totalKnownCards += caseTotal;
    recalledCards += caseHits;
    sumCaseAccuracy += caseHits / caseTotal;
  }

  return {
    caseCount: cases.length,
    seedsPerCase: recallSeeds,
    totalKnownCards,
    recalledCards,
    accuracy: sumCaseAccuracy / cases.length,
  };
}

function replayBurstWaveSurvived(entries: readonly ReplayEntry[], startIdx: number, aiPlayer: PlayerId): boolean {
  const startEntry = entries[startIdx]!;
  const startSetNo = startEntry.before.setNo;
  const startTurnNo = startEntry.before.turnNo;

  for (let j = startIdx; j < entries.length; j++) {
    const ej = entries[j]!;
    if (ej.before.setNo !== startSetNo) {
      const prevAfter = entries[j - 1]?.after;
      if (prevAfter?.lostBy !== null && prevAfter?.lostBy !== undefined) return prevAfter.lostBy !== aiPlayer;
      return ej.before.servingPlayer === aiPlayer;
    }
    const logs = ej.after.log.slice(ej.logStart, ej.logEnd);
    for (const l of logs) {
      if (l.event && (l.event.kind === "set-won" || l.event.kind === "match-won")) {
        return l.event.winner === aiPlayer;
      }
    }
    if (ej.after.lostBy !== null) return ej.after.lostBy !== aiPlayer;
    if (ej.after.winner !== null) return ej.after.winner === aiPlayer;
    if (ej.after.setNo !== startSetNo) return ej.after.servingPlayer === aiPlayer;
    if (ej.after.turnPlayer === aiPlayer && (ej.after.phase === "toss" || ej.after.phase === "attack")) {
      return true;
    }
    if (ej.after.turnNo > startTurnNo || ej.after.turnPlayer !== aiPlayer) {
      return true;
    }
  }
  const lastAfter = entries[entries.length - 1]?.after;
  return lastAfter ? lastAfter.lostBy !== aiPlayer && lastAfter.winner !== (aiPlayer === 0 ? 1 : 0) : false;
}

export function scanReplays(options: { allP04?: boolean; recallSeeds?: number; seed?: number } = {}): ReplayWindowScanResult {
  const recallSeeds = options.recallSeeds ?? 20;
  const baseSeed = options.seed ?? 20261120;

  if (!existsSync(REPLAY_INDEX_PATH)) {
    throw new Error(`找不到 ${REPLAY_INDEX_PATH}`);
  }

  const indexLines = readFileSync(REPLAY_INDEX_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReplayIndexRow);

  const filtered = indexLines
    .filter((row) =>
      options.allP04
        ? row.startedAt >= REPLAY_WINDOW.since
        : row.startedAt >= REPLAY_WINDOW.since && row.startedAt < REPLAY_WINDOW.until,
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));

  let validReplays = 0;
  let skippedInvalidReplays = 0;

  let safeFullNum = 0;
  let safeFullDen = 0;
  let safeMissNum = 0;
  let safeMissDen = 0;
  let burstSurvived = 0;
  let burstTotal = 0;
  let burst7Survived = 0;
  let burst7Total = 0;

  const candidates: ReplayWindowScanResult["candidates"] = {
    safeFullHandDefEvent: [],
    safeMissingPairDraw: [],
    publicHandRecall: [],
    highGutsBurst: [],
  };

  for (const row of filtered) {
    const replayPath = join(REPLAYS_DIR, row.id);
    if (!existsSync(replayPath)) {
      skippedInvalidReplays++;
      continue;
    }
    const session = JSON.parse(readFileSync(replayPath, "utf8")) as ReplaySession;
    const knownDecks: [string[], string[]] = [
      session.decks?.[0]?.cardIds ?? [],
      session.decks?.[1]?.cardIds ?? [],
    ];
    if (!validateKnownDecks(benchmarkDb, knownDecks)) {
      skippedInvalidReplays++;
      continue;
    }
    validReplays++;

    const deckLabels: [string, string] = [session.decks[0].label, session.decks[1].label];
    const entries = session.entries ?? [];
    const aiPlayer: PlayerId = 1;
    const oppPlayer: PlayerId = 0;

    const seenBurstWaves = new Set<string>();
    const trackedPublicUids = new Map<number, string[]>(); // uid -> log texts
    let lastSetNo = -1;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const st = entry.before;
      if (st.setNo !== lastSetNo) {
        trackedPublicUids.clear();
        lastSetNo = st.setNo;
      }

      const pd = st.pendingDecision;
      const incomingOp = st.op && st.op.owner !== aiPlayer ? st.op.value : 0;
      const oppGuts = courtGutsCount(st, oppPlayer);

      // 3. 若先前偵測到對手公開入手卡、目前是 AI 在同一 Set 下一次決策，且卡片仍在 opp.hand → 記錄 recall case
      if (pd?.player === aiPlayer && trackedPublicUids.size > 0) {
        const oppHandSet = new Set(st.players[oppPlayer].hand);
        const activeUids = [...trackedPublicUids.keys()].filter((u) => oppHandSet.has(u));
        if (activeUids.length > 0 && canApplyDecision(benchmarkDb, st, entry.decision) && validateStateConservation(benchmarkDb, st, knownDecks)) {
          const expectedIds = activeUids.map((u) => st.cards[u]!).filter(Boolean);
          const logTexts = activeUids.flatMap((u) => trackedPublicUids.get(u) ?? []);
          candidates.publicHandRecall.push({
            id: `publicHandRecall-${row.id}-${i}`,
            category: "publicHandRecall",
            replayId: row.id,
            startedAt: session.startedAt,
            entryIndex: i,
            deckLabels,
            knownDecks,
            aiPlayer,
            state: st,
            historicalDecision: entry.decision,
            metadata: {
              setNo: st.setNo,
              turnNo: st.turnNo,
              phase: st.phase,
              incomingOp,
              currentDefenseDp: currentDefenseDp(benchmarkDb, st, aiPlayer),
              oppCourtGuts: oppGuts,
              hasLegalFollowupTossAttack: hasLegalFollowupTossAttack(benchmarkDb, st, aiPlayer),
              expectedKnownOppHandCardIds: expectedIds,
              publicAdditionLogTexts: logTexts,
            },
          });
          // 本次公開入手事件已完成「下一次 AI 決策」追蹤
          for (const u of activeUids) trackedPublicUids.delete(u);
        } else if (activeUids.length === 0) {
          trackedPublicUids.clear();
        }
      }

      if (pd?.player === aiPlayer) {
        // 1 & 2. safeFullHandDefEvent & safeMissingPairDraw
        if ((st.phase === "receive" || st.phase === "block") && pd.type === "free" && incomingOp > 0) {
          const dp = currentDefenseDp(benchmarkDb, st, aiPlayer);
          if (dp >= incomingOp) {
            const fo = freeOptions(benchmarkDb, st);
            const defBuffUids = fo.events
              .filter((ev) => isDefensiveBuffEvent(cardOf(benchmarkDb, st, ev.uid), st.phase as "receive" | "block"))
              .map((ev) => ev.uid);
            const drawDefUids = fo.events
              .filter((ev) => isDrawOrTutorEvent(cardOf(benchmarkDb, st, ev.uid)))
              .map((ev) => ev.uid);
            const hasFollowup = hasLegalFollowupTossAttack(benchmarkDb, st, aiPlayer);
            const playedEventUid =
              entry.decision.type === "free" && entry.decision.action === "event" ? entry.decision.uid : null;

            if (defBuffUids.length > 0 && hasFollowup && oppGuts >= 3) {
              safeFullDen++;
              const burned = playedEventUid !== null && defBuffUids.includes(playedEventUid);
              if (burned) safeFullNum++;
              if (canApplyDecision(benchmarkDb, st, entry.decision) && validateStateConservation(benchmarkDb, st, knownDecks)) {
                candidates.safeFullHandDefEvent.push({
                  id: `safeFullHandDefEvent-${row.id}-${i}`,
                  category: "safeFullHandDefEvent",
                  replayId: row.id,
                  startedAt: session.startedAt,
                  entryIndex: i,
                  deckLabels,
                  knownDecks,
                  aiPlayer,
                  state: st,
                  historicalDecision: entry.decision,
                  metadata: {
                    setNo: st.setNo,
                    turnNo: st.turnNo,
                    phase: st.phase,
                    incomingOp,
                    currentDefenseDp: dp,
                    oppCourtGuts: oppGuts,
                    hasLegalFollowupTossAttack: true,
                    playableDefBuffEventUids: defBuffUids,
                    historicalBurnedDefEvent: burned,
                  },
                });
              }
            }

            if (drawDefUids.length > 0 && !hasFollowup) {
              safeMissDen++;
              const playedDraw = playedEventUid !== null && drawDefUids.includes(playedEventUid);
              if (playedDraw) safeMissNum++;
              if (canApplyDecision(benchmarkDb, st, entry.decision) && validateStateConservation(benchmarkDb, st, knownDecks)) {
                candidates.safeMissingPairDraw.push({
                  id: `safeMissingPairDraw-${row.id}-${i}`,
                  category: "safeMissingPairDraw",
                  replayId: row.id,
                  startedAt: session.startedAt,
                  entryIndex: i,
                  deckLabels,
                  knownDecks,
                  aiPlayer,
                  state: st,
                  historicalDecision: entry.decision,
                  metadata: {
                    setNo: st.setNo,
                    turnNo: st.turnNo,
                    phase: st.phase,
                    incomingOp,
                    currentDefenseDp: dp,
                    oppCourtGuts: oppGuts,
                    hasLegalFollowupTossAttack: false,
                    playableDrawDefEventUids: drawDefUids,
                    historicalPlayedDrawEvent: playedDraw,
                  },
                });
              }
            }
          }
        }

        // 4. highGutsBurst（每波次僅計一次入口點）
        const inDefPhase = st.phase === "start" || st.phase === "block" || st.phase === "draw" || st.phase === "receive";
        if (inDefPhase && incomingOp > 0 && (incomingOp >= 7 || (oppGuts >= 4 && incomingOp >= 5))) {
          const waveKey = `${st.setNo}:${st.turnNo}`;
          if (!seenBurstWaves.has(waveKey)) {
            seenBurstWaves.add(waveKey);
            const survived = replayBurstWaveSurvived(entries, i, aiPlayer);
            burstTotal++;
            if (survived) burstSurvived++;
            if (incomingOp >= 7) {
              burst7Total++;
              if (survived) burst7Survived++;
            }
            if (canApplyDecision(benchmarkDb, st, entry.decision) && validateStateConservation(benchmarkDb, st, knownDecks)) {
              candidates.highGutsBurst.push({
                id: `highGutsBurst-${row.id}-${i}`,
                category: "highGutsBurst",
                replayId: row.id,
                startedAt: session.startedAt,
                entryIndex: i,
                deckLabels,
                knownDecks,
                aiPlayer,
                state: st,
                historicalDecision: entry.decision,
                metadata: {
                  setNo: st.setNo,
                  turnNo: st.turnNo,
                  phase: st.phase,
                  incomingOp,
                  currentDefenseDp: currentDefenseDp(benchmarkDb, st, aiPlayer),
                  oppCourtGuts: oppGuts,
                  hasLegalFollowupTossAttack: hasLegalFollowupTossAttack(benchmarkDb, st, aiPlayer),
                  historicalSurvived: survived,
                },
              });
            }
          }
        }
      }

      // 更新公開入手追蹤（檢查本步後是否有新公開入手、並清除已離開對手手牌的 uid）
      if (entry.before.setNo === entry.after.setNo) {
        const newlyAdded = detectPublicHandAdditionsInEntry(entry, oppPlayer);
        if (newlyAdded.length > 0) {
          const relevantLogs = [
            ...(entry.before.log.length > 0 && entry.before.log[entry.before.log.length - 1]?.text.startsWith("公開牌組頂：")
              ? [entry.before.log[entry.before.log.length - 1]!.text]
              : []),
            ...entry.after.log.slice(entry.logStart, entry.logEnd).map((l) => l.text),
          ];
          for (const uid of newlyAdded) {
            trackedPublicUids.set(uid, relevantLogs);
          }
        }
        const oppAfterHand = new Set(entry.after.players[oppPlayer].hand);
        for (const uid of [...trackedPublicUids.keys()]) {
          if (!oppAfterHand.has(uid)) trackedPublicUids.delete(uid);
        }
      } else {
        trackedPublicUids.clear();
      }
    }
  }

  return {
    totalIndexEntries: indexLines.length,
    windowReplays: filtered.length,
    validReplays,
    skippedInvalidReplays,
    historical: {
      safeFullHandDefEventBurnRate: ratio(safeFullNum, safeFullDen),
      safeMissingPairDrawRate: ratio(safeMissNum, safeMissDen),
      publicHandRecallAccuracy: evaluatePublicHandRecallCases(candidates.publicHandRecall, recallSeeds, baseSeed),
      highGutsSurvivalRate: {
        ...ratio(burstSurvived, burstTotal),
        op7Plus: ratio(burst7Survived, burst7Total),
      },
    },
    candidates,
  };
}

// ---- 確定性夾具抽取 ----

function outcomeKey(item: EndgameFixtureCase): string {
  switch (item.category) {
    case "safeFullHandDefEvent":
      return `${item.metadata.phase}:${item.metadata.historicalBurnedDefEvent ? "burn" : "keep"}`;
    case "safeMissingPairDraw":
      return `${item.metadata.phase}:${item.metadata.historicalPlayedDrawEvent ? "draw" : "pass"}`;
    case "publicHandRecall":
      return `${item.metadata.expectedKnownOppHandCardIds?.[0] ?? "x"}`;
    case "highGutsBurst":
      return `${item.metadata.incomingOp >= 7 ? "op7+" : "guts4op5+"}:${item.metadata.historicalSurvived ? "surv" : "lost"}`;
  }
}

function selectDiverseCases(
  pool: readonly EndgameFixtureCase[],
  targetCount: number,
  maxLogLength: number,
): EndgameFixtureCase[] {
  if (pool.length <= targetCount) return [...pool];

  // 先偏好 log 長度適中者，確保 JSON 不截斷 log 也能小於 1.5MB
  const scored = pool.map((item) => {
    const logLen = item.state.log.length;
    const logPenalty = logLen > maxLogLength ? logLen - maxLogLength : 0;
    return { item, logLen, logPenalty };
  });

  scored.sort(
    (a, b) =>
      a.logPenalty - b.logPenalty ||
      a.logLen - b.logLen ||
      a.item.startedAt.localeCompare(b.item.startedAt) ||
      a.item.entryIndex - b.item.entryIndex,
  );

  const selected: EndgameFixtureCase[] = [];
  const usedIds = new Set<string>();
  const usedReplays = new Set<string>();
  const usedDeckPairs = new Set<string>();
  const outcomeCounts = new Map<string, number>();

  // 多輪確定性貪心挑選：最大化不同 replay、不同牌組、不同 setNo、不同結果分層
  while (selected.length < targetCount) {
    let bestCandidate: (typeof scored)[number] | null = null;
    let bestRank = -Infinity;

    for (const cand of scored) {
      if (usedIds.has(cand.item.id)) continue;
      const deckKey = `${cand.item.deckLabels[0]}|${cand.item.deckLabels[1]}`;
      const oKey = outcomeKey(cand.item);
      let rank = 0;
      if (!usedReplays.has(cand.item.replayId)) rank += 1000;
      if (!usedDeckPairs.has(deckKey)) rank += 300;
      rank -= (outcomeCounts.get(oKey) ?? 0) * 180;
      rank -= cand.logPenalty * 2;
      rank -= cand.logLen * 0.05;
      if (rank > bestRank) {
        bestRank = rank;
        bestCandidate = cand;
      }
    }

    if (!bestCandidate) break;
    selected.push(bestCandidate.item);
    usedIds.add(bestCandidate.item.id);
    usedReplays.add(bestCandidate.item.replayId);
    usedDeckPairs.add(`${bestCandidate.item.deckLabels[0]}|${bestCandidate.item.deckLabels[1]}`);
    const oKey = outcomeKey(bestCandidate.item);
    outcomeCounts.set(oKey, (outcomeCounts.get(oKey) ?? 0) + 1);
  }

  return selected.sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.replayId.localeCompare(b.replayId) || a.entryIndex - b.entryIndex,
  );
}

export function extractPhaseN0Fixture(outPath: string = PHASE_N0_FIXTURE_PATH): {
  fixture: PhaseN0EndgamesFixture;
  bytes: number;
  scan: ReplayWindowScanResult;
} {
  const scan = scanReplays({ allP04: false });
  const categories: FixtureCategory[] = [
    "safeFullHandDefEvent",
    "safeMissingPairDraw",
    "publicHandRecall",
    "highGutsBurst",
  ];

  for (const cat of categories) {
    if (scan.candidates[cat].length === 0) {
      throw new Error(`異常：類別 ${cat} 在 63 場實戰中抽取到 0 筆樣本，已停止輸出！`);
    }
  }

  let cap = TARGET_CASES_PER_CATEGORY;
  let maxLog = 260;
  let fixture: PhaseN0EndgamesFixture | null = null;
  let serialized = "";

  // 若總大小超過 1.5MB，逐步收緊每類題數上限（絕不截斷 state.log）
  for (const attemptCap of [cap, 10, 8, 6]) {
    const candidateFixture: PhaseN0EndgamesFixture = {
      schemaVersion: "phase-n0-endgames-v1",
      extractedAt: REPLAY_WINDOW.until,
      window: { ...REPLAY_WINDOW },
      sourceReplayCount: scan.validReplays,
      cases: {
        safeFullHandDefEvent: selectDiverseCases(scan.candidates.safeFullHandDefEvent, attemptCap, maxLog),
        safeMissingPairDraw: selectDiverseCases(scan.candidates.safeMissingPairDraw, attemptCap, maxLog),
        publicHandRecall: selectDiverseCases(scan.candidates.publicHandRecall, attemptCap, maxLog),
        highGutsBurst: selectDiverseCases(scan.candidates.highGutsBurst, attemptCap, maxLog),
      },
    };
    const json = `${JSON.stringify(candidateFixture, null, 2)}\n`;
    fixture = candidateFixture;
    serialized = json;
    if (Buffer.byteLength(json, "utf8") < MAX_FIXTURE_BYTES) break;
    maxLog = Math.max(140, maxLog - 40);
  }

  if (!fixture) throw new Error("無法產生 fixture");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized, "utf8");
  return { fixture, bytes: Buffer.byteLength(serialized, "utf8"), scan };
}

// ---- 夾具載入與策略評測 ----

export function loadPhaseN0Fixture(fixturePath: string = PHASE_N0_FIXTURE_PATH): PhaseN0EndgamesFixture {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as PhaseN0EndgamesFixture;
}

function evaluateHistoricalOnFixture(
  fixture: PhaseN0EndgamesFixture,
  recallSeeds: number,
  baseSeed: number,
): ThoughtBeliefMetricsReport {
  let safeFullNum = 0;
  for (const c of fixture.cases.safeFullHandDefEvent) {
    const uids = c.metadata.playableDefBuffEventUids ?? [];
    if (c.historicalDecision.type === "free" && c.historicalDecision.action === "event" && uids.includes(c.historicalDecision.uid)) {
      safeFullNum++;
    }
  }
  let safeMissNum = 0;
  for (const c of fixture.cases.safeMissingPairDraw) {
    const uids = c.metadata.playableDrawDefEventUids ?? [];
    if (c.historicalDecision.type === "free" && c.historicalDecision.action === "event" && uids.includes(c.historicalDecision.uid)) {
      safeMissNum++;
    }
  }
  let burstSurv = 0;
  let burst7Surv = 0;
  let burst7Total = 0;
  for (const c of fixture.cases.highGutsBurst) {
    const surv = c.metadata.historicalSurvived === true;
    if (surv) burstSurv++;
    if (c.metadata.incomingOp >= 7) {
      burst7Total++;
      if (surv) burst7Surv++;
    }
  }

  return {
    safeFullHandDefEventBurnRate: ratio(safeFullNum, fixture.cases.safeFullHandDefEvent.length),
    safeMissingPairDrawRate: ratio(safeMissNum, fixture.cases.safeMissingPairDraw.length),
    publicHandRecallAccuracy: evaluatePublicHandRecallCases(fixture.cases.publicHandRecall, recallSeeds, baseSeed),
    highGutsSurvivalRate: {
      ...ratio(burstSurv, fixture.cases.highGutsBurst.length),
      op7Plus: ratio(burst7Surv, burst7Total),
    },
  };
}

function evaluatePolicyOnFixture(
  fixture: PhaseN0EndgamesFixture,
  policy: "heuristic" | "ismcts",
  ismctsIterations: number,
  recallSeeds: number,
  baseSeed: number,
  leafRolloutHorizon: number,
): ThoughtBeliefMetricsReport {
  const decide = (item: EndgameFixtureCase, idx: number): Decision => {
    const profile = inferRolloutPolicyForDeck(benchmarkDb, item.knownDecks[item.aiPlayer], item.deckLabels[item.aiPlayer]);
    if (policy === "heuristic") {
      return heuristicAiDecision(benchmarkDb, item.state, profile);
    }
    return createIsmctsReport(benchmarkDb, item.state, {
      ...OPPONENT_ISMCTS_PRESET,
      leafRolloutHorizon,
      perspectivePlayer: item.aiPlayer,
      knownDecks: item.knownDecks,
      iterations: ismctsIterations,
      rolloutPolicy: profile,
      seed: baseSeed + idx * 37,
    }).bestAction.decision;
  };

  let safeFullNum = 0;
  fixture.cases.safeFullHandDefEvent.forEach((c, idx) => {
    const d = decide(c, idx);
    const uids = c.metadata.playableDefBuffEventUids ?? [];
    if (d.type === "free" && d.action === "event" && uids.includes(d.uid)) safeFullNum++;
  });

  let safeMissNum = 0;
  fixture.cases.safeMissingPairDraw.forEach((c, idx) => {
    const d = decide(c, 100 + idx);
    const uids = c.metadata.playableDrawDefEventUids ?? [];
    if (d.type === "free" && d.action === "event" && uids.includes(d.uid)) safeMissNum++;
  });

  let burstSurv = 0;
  let burst7Surv = 0;
  let burst7Total = 0;
  fixture.cases.highGutsBurst.forEach((c, idx) => {
    const profile = inferRolloutPolicyForDeck(benchmarkDb, c.knownDecks[c.aiPlayer], c.deckLabels[c.aiPlayer]);
    const surv = isBurstWaveSurvived(
      benchmarkDb,
      c.state,
      c.knownDecks,
      c.aiPlayer,
      policy,
      baseSeed + 1000 + idx * 101,
      ismctsIterations,
      profile,
      leafRolloutHorizon,
    );
    if (surv) burstSurv++;
    if (c.metadata.incomingOp >= 7) {
      burst7Total++;
      if (surv) burst7Surv++;
    }
  });

  return {
    safeFullHandDefEventBurnRate: ratio(safeFullNum, fixture.cases.safeFullHandDefEvent.length),
    safeMissingPairDrawRate: ratio(safeMissNum, fixture.cases.safeMissingPairDraw.length),
    publicHandRecallAccuracy: evaluatePublicHandRecallCases(fixture.cases.publicHandRecall, recallSeeds, baseSeed),
    highGutsSurvivalRate: {
      ...ratio(burstSurv, fixture.cases.highGutsBurst.length),
      op7Plus: ratio(burst7Surv, burst7Total),
    },
  };
}

export function evaluateThoughtBeliefFixture(options: EvaluateFixtureOptions = {}): ThoughtBeliefFixtureEvaluation {
  const fixture = options.fixture ?? loadPhaseN0Fixture(options.fixturePath ?? PHASE_N0_FIXTURE_PATH);
  const ismctsIterations = options.ismctsIterations ?? 64;
  const recallSeeds = options.recallSeeds ?? 20;
  const baseSeed = options.seed ?? 20261120;
  const runIsmcts = options.runIsmcts ?? true;
  const leafRolloutHorizon = options.leafRolloutHorizon ?? OPPONENT_ISMCTS_PRESET.leafRolloutHorizon;

  const historical = evaluateHistoricalOnFixture(fixture, recallSeeds, baseSeed);
  const heuristic = evaluatePolicyOnFixture(fixture, "heuristic", ismctsIterations, recallSeeds, baseSeed, leafRolloutHorizon);
  const ismcts = runIsmcts
    ? evaluatePolicyOnFixture(fixture, "ismcts", ismctsIterations, recallSeeds, baseSeed, leafRolloutHorizon)
    : undefined;

  return {
    schemaVersion: fixture.schemaVersion,
    counts: {
      safeFullHandDefEvent: fixture.cases.safeFullHandDefEvent.length,
      safeMissingPairDraw: fixture.cases.safeMissingPairDraw.length,
      publicHandRecall: fixture.cases.publicHandRecall.length,
      highGutsBurst: fixture.cases.highGutsBurst.length,
    },
    historical,
    heuristic,
    ...(ismcts ? { ismcts } : {}),
  };
}

// ---- CLI 輸出 ----

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtRatio(m: RatioMetric): string {
  return `${pct(m.rate)} (${m.numerator}/${m.denominator})`;
}

function printReport(title: string, m: ThoughtBeliefMetricsReport): void {
  console.log(`  [${title}]`);
  console.log(`    1. safeFullHandDefEventBurnRate : ${fmtRatio(m.safeFullHandDefEventBurnRate)}`);
  console.log(`    2. safeMissingPairDrawRate      : ${fmtRatio(m.safeMissingPairDrawRate)}`);
  console.log(
    `    3. publicHandRecallAccuracy     : ${pct(m.publicHandRecallAccuracy.accuracy)} ` +
      `(${m.publicHandRecallAccuracy.recalledCards}/${m.publicHandRecallAccuracy.totalKnownCards} across ${m.publicHandRecallAccuracy.caseCount} cases × ${m.publicHandRecallAccuracy.seedsPerCase} seeds)`,
  );
  console.log(
    `    4. highGutsSurvivalRate         : ${fmtRatio(m.highGutsSurvivalRate)} | OP>=7: ${fmtRatio(m.highGutsSurvivalRate.op7Plus)}`,
  );
}

function runCli(): void {
  const fixtureOnly = flag("fixture-only");
  const doExtract = flag("extract-fixture");
  const allP04 = flag("all-p04");
  const ismctsIters = Math.max(1, Math.floor(numberArg("ismcts-iters", 64)));
  const recallSeeds = Math.max(1, Math.floor(numberArg("recall-seeds", 20)));
  const seed = Math.floor(numberArg("seed", 20261120));

  if (doExtract) {
    if (!existsSync(REPLAY_INDEX_PATH)) {
      console.error(`找不到 ${REPLAY_INDEX_PATH}，無法執行 --extract-fixture。`);
      process.exitCode = 1;
      return;
    }
    const { fixture, bytes, scan } = extractPhaseN0Fixture();
    console.log(
      `[Phase N0 Extract] 視窗對局 ${scan.windowReplays} 場（有效 ${scan.validReplays} / 略過 ${scan.skippedInvalidReplays}）`,
    );
    console.log(
      `  候選總數：safeFullHandDefEvent=${scan.candidates.safeFullHandDefEvent.length}, ` +
        `safeMissingPairDraw=${scan.candidates.safeMissingPairDraw.length}, ` +
        `publicHandRecall=${scan.candidates.publicHandRecall.length}, ` +
        `highGutsBurst=${scan.candidates.highGutsBurst.length}`,
    );
    console.log(
      `  抽取題數：safeFullHandDefEvent=${fixture.cases.safeFullHandDefEvent.length}, ` +
        `safeMissingPairDraw=${fixture.cases.safeMissingPairDraw.length}, ` +
        `publicHandRecall=${fixture.cases.publicHandRecall.length}, ` +
        `highGutsBurst=${fixture.cases.highGutsBurst.length}`,
    );
    console.log(`  輸出路徑：${PHASE_N0_FIXTURE_PATH} (${(bytes / 1024).toFixed(1)} KB)`);
    return;
  }

  if (!fixtureOnly) {
    if (!existsSync(REPLAY_INDEX_PATH)) {
      console.log(`提示：找不到 ${REPLAY_INDEX_PATH}，改以 --fixture-only 模式執行夾具評測。`);
    } else {
      const scan = scanReplays({ allP04, recallSeeds, seed });
      const windowLabel = allP04
        ? `>= ${REPLAY_WINDOW.since}`
        : `${REPLAY_WINDOW.since} ~ ${REPLAY_WINDOW.until}`;
      console.log(
        `=== Phase N0 Replay 基準線 (${windowLabel}) | 有效 ${scan.validReplays}/${scan.windowReplays} 場 (略過 ${scan.skippedInvalidReplays}) ===`,
      );
      printReport("Replay Historical (AI實戰)", scan.historical);
      console.log(
        `  [樣本池] safeFull=${scan.candidates.safeFullHandDefEvent.length}, safeMiss=${scan.candidates.safeMissingPairDraw.length}, publicRecall=${scan.candidates.publicHandRecall.length}, highGutsBurst=${scan.candidates.highGutsBurst.length}\n`,
      );
    }
  }

  if (existsSync(PHASE_N0_FIXTURE_PATH)) {
    const evalRes = evaluateThoughtBeliefFixture({
      ismctsIterations: ismctsIters,
      recallSeeds,
      seed,
      runIsmcts: true,
    });
    console.log(
      `=== Phase N0 固定殘局夾具評測 (ismctsIters=${ismctsIters}, recallSeeds=${recallSeeds}, ` +
        `題數=${evalRes.counts.safeFullHandDefEvent}/${evalRes.counts.safeMissingPairDraw}/${evalRes.counts.publicHandRecall}/${evalRes.counts.highGutsBurst}) ===`,
    );
    printReport("Fixture Historical", evalRes.historical);
    printReport("Fixture Heuristic", evalRes.heuristic);
    if (evalRes.ismcts) {
      printReport(`Fixture SO-ISMCTS (iters=${ismctsIters})`, evalRes.ismcts);
    }
  } else {
    console.log(`提示：找不到夾具 ${PHASE_N0_FIXTURE_PATH}，請先執行 --extract-fixture。`);
  }
}

if (isDirectCliRun()) {
  runCli();
}
