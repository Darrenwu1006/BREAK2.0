import type { Card } from "../data/types";
import type { Action, EffectDef, PhaseIcon, SkillDef } from "../engine/dsl";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import type { CoachActionEstimate, CoachReport } from "./coach";
import { canChooseBlock, deployNames, deployableUids, effParam, nameOf, normName, topChara } from "../engine/engine";
import { allGutsOf, cardOf } from "../engine/effect-helpers";
import { centerBlockNegated } from "../engine/deploy-legality";
import { freeOptions } from "../engine/effects";
import { explainValue } from "./rollout-value";
import { describeDecision } from "../shared/decisionLabels";
import {
  AI_THOUGHT_MAX_CANDIDATES,
  AI_THOUGHT_MAX_FACTORS,
  AI_THOUGHT_SCHEMA_VERSION,
  clampAiThoughtRecord,
  isKeyDecision,
  type AiBeliefSnapshot,
  type AiThoughtCandidate,
  type AiThoughtDialogue,
  type AiThoughtEngine,
  type AiThoughtFactor,
  type AiThoughtRecord,
} from "../shared/aiThought";

/** 建立 AI 思維摘要紀錄所需的輸入資料。 */
export interface BuildAiThoughtInput {
  db: CardDb;
  state: GameState;
  perspectivePlayer: PlayerId;
  decision: Decision;
  engine: AiThoughtEngine;
  report?: (CoachReport & { tieBreakReason?: string }) | null;
  knownDecks?: readonly [readonly string[], readonly string[]];
  belief?: AiBeliefSnapshot;
}

/** 供對話生成器判定公開場況脈絡的唯讀上下文。 */
export interface NarratorContext {
  db: CardDb;
  state: GameState;
  perspectivePlayer: PlayerId;
  decision: Decision;
  oppGuts: number;
  incomingOp: number;
  currentDefenseDp: number;
  hasLegalFollowup: boolean;
  hasPlayableDefBuffEvent: boolean;
  hasPlayableDrawEvent: boolean;
  valueProbability?: number;
}

const TIMING_ZH_TO_PHASE: Record<string, PhaseIcon> = {
  發球: "serve",
  攔網: "block",
  抽牌: "draw",
  接球: "receive",
  舉球: "toss",
  攻擊: "attack",
};

const DRAW_OR_TUTOR_OPS = new Set<Action["op"]>([
  "draw",
  "drawToHandSize",
  "lookTopTutor",
  "revealTopTutor",
  "lookTopTwoPick",
]);

function otherPlayer(p: PlayerId): PlayerId {
  return p === 0 ? 1 : 0;
}

function safeCardOf(db: CardDb, state: GameState, uid: number): Card | null {
  const id = state.cards[uid];
  if (!id) return null;
  return db.get(id) ?? null;
}

function eventSkillOf(card: Card): Extract<SkillDef, { kind: "event" }> | null {
  const eff = card.effect as EffectDef | null;
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

function anyActionMatches(actions: readonly Action[] | undefined, pred: (act: Action) => boolean): boolean {
  for (const act of actions ?? []) {
    if (pred(act)) return true;
    if (act.op === "gate" && (anyActionMatches(act.then, pred) || anyActionMatches(act.else, pred))) return true;
    if (
      (act.op === "if" || act.op === "revealTopCheck" || act.op === "millTop" || act.op === "millTopAll") &&
      anyActionMatches(act.then, pred)
    ) {
      return true;
    }
    if (act.op === "coinFlip" && (anyActionMatches(act.heads, pred) || anyActionMatches(act.tails, pred))) return true;
    if (act.op === "chooseOne" && act.options.some((opt) => anyActionMatches(opt.actions, pred))) return true;
  }
  return false;
}

function isDefensiveBuffAction(act: Action): boolean {
  if (
    act.op === "addParam" &&
    (act.param === "receive" || act.param === "block" || act.param === "choose") &&
    (act.amount ?? 1) > 0
  ) {
    return true;
  }
  if (act.op === "setParam" && (act.param === "receive" || act.param === "block")) return true;
  return act.op === "addOpponentOp" && (act.amount ?? 0) < 0;
}

function isDefensiveBuffEvent(card: Card, phase?: "receive" | "block"): boolean {
  if (card.type !== "EVENT") return false;
  const skill = eventSkillOf(card);
  if (!skill) return false;
  const timings = eventTimingSet(card, skill);
  const timingMatch = phase ? timings.has(phase) : timings.has("receive") || timings.has("block");
  if (!timingMatch) return false;
  return anyActionMatches(skill.actions, isDefensiveBuffAction);
}

function isDrawOrTutorEvent(card: Card): boolean {
  if (card.type !== "EVENT") return false;
  const skill = eventSkillOf(card);
  if (!skill) return false;
  return anyActionMatches(skill.actions, (act) => DRAW_OR_TUTOR_OPS.has(act.op));
}

function computeDefenseDp(db: CardDb, state: GameState, p: PlayerId): number {
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
  const card = safeCardOf(db, state, uid);
  if (!card) return false;
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
  const eff = card.effect as EffectDef | null;
  if (!eff || !Array.isArray(eff.skills)) return false;
  return eff.skills.some(
    (s) =>
      s.kind === "passive" &&
      s.trigger.on === "deploy" &&
      s.areaIcons?.includes("attack") &&
      anyActionMatches(
        s.actions,
        (act) =>
          (act.op === "addParam" && act.param === "attack" && (act.amount ?? 1) > 0) ||
          (act.op === "setParam" && act.param === "attack" && act.value >= 1),
      ),
  );
}

function canServeAsAttackerCard(card: Card): boolean {
  if (card.type !== "CHARACTER" || !card.params) return false;
  if (card.params.attack === null) return false;
  if (card.params.attack >= 1) return true;
  return hasAttackDeploySkill(card);
}

function hasLegalFollowupTossAttack(db: CardDb, state: GameState, p: PlayerId): boolean {
  const ps = state.players[p];
  const hand = ps.hand;

  // 若已在 toss 且已登場托球手（sub >= 1），改檢查場上托球手＋手牌異名攻擊手
  if (state.phase === "toss" && state.sub >= 1) {
    const tTop = topChara(ps.toss);
    if (tTop !== null) {
      const tName = nameOf(db, state, tTop);
      for (const aUid of hand) {
        const aCard = safeCardOf(db, state, aUid);
        if (!aCard || !canServeAsAttackerCard(aCard)) continue;
        const aNames = candidateDeployNames(db, state, aUid);
        if (aNames.some((an) => an !== tName && passesTurnRestrictionsForArea(db, state, p, aUid, "attack", an))) {
          return true;
        }
      }
      return false;
    }
  }

  const rTop =
    (state.phase === "receive" || state.phase === "toss") && ps.receive.length > 0 ? topChara(ps.receive) : null;
  const bannedTossName = rTop !== null ? nameOf(db, state, rTop) : null;

  for (const tUid of hand) {
    const tCard = safeCardOf(db, state, tUid);
    if (!tCard || tCard.type !== "CHARACTER" || tCard.params?.toss === null || (tCard.params?.toss ?? 0) < 1) {
      continue;
    }
    const validTNames = candidateDeployNames(db, state, tUid).filter(
      (n) => n !== bannedTossName && passesTurnRestrictionsForArea(db, state, p, tUid, "toss", n),
    );
    if (validTNames.length === 0) continue;

    for (const aUid of hand) {
      if (aUid === tUid) continue;
      const aCard = safeCardOf(db, state, aUid);
      if (!aCard || !canServeAsAttackerCard(aCard)) continue;
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

function computeLegalCandidateCount(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  decision: Decision,
  report?: CoachReport | null,
): number | undefined {
  if (report && report.recommendations.length > 0) {
    return report.recommendations.length;
  }
  switch (decision.type) {
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack": {
      const area = decision.type.slice("deploy-".length) as "serve" | "receive" | "toss" | "attack";
      return deployableUids(db, state, p, area).length + 1;
    }
    case "deploy-block":
      return deployableUids(db, state, p, "block").length > 0 ? 2 : 1;
    case "defense-choice":
      return canChooseBlock(state) ? 2 : 1;
    case "mulligan":
      return state.players[p].hand.length > 0 ? 2 : 1;
    default:
      return undefined;
  }
}

function canonicalDecisionKey(d: Decision): string {
  if (d.type === "deploy-block" && d.uids !== null) {
    const entries = Object.entries(d.nameChoices ?? {}).sort(([ka], [kb]) => Number(ka) - Number(kb));
    if (entries.length === 0) {
      return JSON.stringify({ type: d.type, uids: d.uids, center: d.center });
    }
    return JSON.stringify({ type: d.type, uids: d.uids, center: d.center, nameChoices: Object.fromEntries(entries) });
  }
  return JSON.stringify(d);
}

function decisionsMatch(a: Decision, b: Decision): boolean {
  return JSON.stringify(a) === JSON.stringify(b) || canonicalDecisionKey(a) === canonicalDecisionKey(b);
}

function buildTopCandidates(
  db: CardDb,
  state: GameState,
  decision: Decision,
  chosenLabel: string,
  recommendations: readonly CoachActionEstimate[],
): AiThoughtCandidate[] {
  const topRecs = recommendations.slice(0, AI_THOUGHT_MAX_CANDIDATES);
  const labels = topRecs.map((est) => describeDecision(db, state, est.decision, "named"));
  // 同名多張在手時 label 會相同，優先用完整 decision 結構比對確保只命中唯一選擇
  let chosenIdx = topRecs.findIndex((est) => decisionsMatch(est.decision, decision));
  if (chosenIdx < 0) {
    chosenIdx = labels.findIndex((label) => label === chosenLabel);
  }
  return topRecs.map((est, idx): AiThoughtCandidate => ({
    label: labels[idx]!,
    decisionType: est.decision.type,
    winRate: est.winRate,
    sampleCount: est.sampleCount,
    isChosen: idx === chosenIdx,
  }));
}

/** 建立完整的結構化 AI 思維摘要紀錄（含真人語氣雙版本台詞）。 */
export function buildAiThoughtRecord(input: BuildAiThoughtInput): AiThoughtRecord {
  const { db, state, perspectivePlayer, decision, engine, report, knownDecks, belief } = input;
  const opp = otherPlayer(perspectivePlayer);
  const oppGuts = allGutsOf(state, opp).length;
  const incomingOp = state.op && state.op.owner !== perspectivePlayer ? state.op.value : 0;
  const currentDefenseDp = computeDefenseDp(db, state, perspectivePlayer);
  const hasLegalFollowup = hasLegalFollowupTossAttack(db, state, perspectivePlayer);

  const isMyFreeStep =
    state.turnPlayer === perspectivePlayer &&
    (state.pendingDecision ? state.pendingDecision.type === "free" && state.pendingDecision.player === perspectivePlayer : decision.type === "free");
  const fo = isMyFreeStep ? freeOptions(db, state) : { skills: [], events: [] };

  const defBuffPhase = state.phase === "receive" || state.phase === "block" ? state.phase : undefined;
  const hasPlayableDefBuffEvent = fo.events.some((ev) => {
    const card = safeCardOf(db, state, ev.uid);
    return card ? isDefensiveBuffEvent(card, defBuffPhase) : false;
  });
  const hasPlayableDrawEvent = fo.events.some((ev) => {
    const card = safeCardOf(db, state, ev.uid);
    return card ? isDrawOrTutorEvent(card) : false;
  });

  const matchedPending = state.pendingDecision?.type === decision.type ? state.pendingDecision : undefined;
  const legalCandidateCount = computeLegalCandidateCount(db, state, perspectivePlayer, decision, report);
  const keyDecision = isKeyDecision({
    pendingType: decision.type,
    decision,
    legalCandidateCount,
    freeActionableCount: decision.type === "free" ? fo.skills.length + fo.events.length : undefined,
    pendingDecision: matchedPending,
  });

  const chosenLabel = describeDecision(db, state, decision, "named");
  const hasSearchSamples = engine === "strong" && !!report && report.completedSamples > 0;
  const completedSamples = hasSearchSamples ? report.completedSamples : 0;

  let chosenWinRate: number | undefined;
  let topCandidates: AiThoughtCandidate[] = [];
  if (hasSearchSamples) {
    const matchedRec = report.recommendations.find((est) => decisionsMatch(est.decision, decision));
    chosenWinRate = matchedRec ? matchedRec.winRate : report.bestAction.winRate;
    topCandidates = buildTopCandidates(db, state, decision, chosenLabel, report.recommendations);
  }

  const ve = report?.valueExplanation ?? explainValue(state, perspectivePlayer, undefined, db, knownDecks);
  const valueFactors: AiThoughtFactor[] = [...ve.terms]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .filter((term) => Math.abs(term.contribution) >= 0.01)
    .slice(0, AI_THOUGHT_MAX_FACTORS)
    .map((term) => ({
      feature: term.feature,
      label: term.label,
      contribution: term.contribution,
      direction: term.contribution > 0.001 ? "helps" : term.contribution < -0.001 ? "hurts" : "neutral",
    }));

  const recordWithoutDialogue: Omit<AiThoughtRecord, "dialogue"> = {
    schemaVersion: AI_THOUGHT_SCHEMA_VERSION,
    engine,
    isKeyDecision: keyDecision,
    pendingType: decision.type,
    chosenLabel,
    completedSamples,
    topCandidates,
    valueFactors,
    ...(chosenWinRate !== undefined ? { chosenWinRate } : {}),
    ...(report?.tieBreakReason !== undefined ? { tieBreakReason: report.tieBreakReason } : {}),
    ...(belief !== undefined ? { belief } : {}),
  };

  const dialogue = narrateAiThought(recordWithoutDialogue, {
    db,
    state,
    perspectivePlayer,
    decision,
    oppGuts,
    incomingOp,
    currentDefenseDp,
    hasLegalFollowup,
    hasPlayableDefBuffEvent,
    hasPlayableDrawEvent,
    valueProbability: ve.probability,
  });

  return clampAiThoughtRecord({
    ...recordWithoutDialogue,
    dialogue,
  });
}

function hasImmediateOneTouchHint(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  uid: number,
  incomingOp: number,
): boolean {
  if (
    state.restrictions.some(
      (r) => r.player === p && r.banOneTouch && r.setNo === state.setNo && r.activeTurn === state.turnNo,
    )
  ) {
    return false;
  }
  const card = safeCardOf(db, state, uid);
  if (!card) return false;
  const eff = card.effect as EffectDef | null;
  if (!eff || !Array.isArray(eff.skills)) return false;
  return eff.skills.some((skill) => {
    if (skill.kind !== "passive" || skill.trigger.on !== "deploy") return false;
    if (skill.areaIcons && !skill.areaIcons.includes("block")) return false;
    return skill.actions.some((action) => {
      if (action.op === "keyword") return action.name === "ワンタッチ";
      if (action.op !== "gate" || (action.costs?.length ?? 0) > 0) return false;
      if (action.cond) {
        const opCond = action.cond.find((c) => c.type === "opponentOp");
        if (opCond && opCond.type === "opponentOp") {
          if (opCond.min !== undefined && incomingOp < opCond.min) return false;
          if (opCond.max !== undefined && incomingOp > opCond.max) return false;
        }
      }
      return action.then.some((child) => child.op === "keyword" && child.name === "ワンタッチ");
    });
  });
}

function blockDecisionDp(
  db: CardDb,
  state: GameState,
  p: PlayerId,
  decision: Extract<Decision, { type: "deploy-block" }>,
): number {
  if (decision.uids === null) return 0;
  const centerNegated = state.restrictions.some(
    (r) => r.player === p && r.negateCenterBlock && r.setNo === state.setNo && r.activeTurn === state.turnNo,
  );
  let dp = 0;
  for (const uid of decision.uids) {
    if (uid === decision.center && centerNegated) continue;
    const card = safeCardOf(db, state, uid);
    dp += card?.params?.block ?? 0;
  }
  for (const sideUid of state.players[p].blockSides) {
    dp += effParam(db, state, sideUid, "block") ?? 0;
  }
  return dp;
}

function fmtPct(winRate: number): string {
  return `${Math.round(winRate * 100)}%`;
}

function hasSearchStats(record: Omit<AiThoughtRecord, "dialogue">): boolean {
  return record.completedSamples > 0 && record.chosenWinRate !== undefined;
}

function spoilerCompare(record: Omit<AiThoughtRecord, "dialogue">): string {
  if (!hasSearchStats(record)) {
    return record.chosenLabel;
  }
  const chosen = record.topCandidates.find((c) => c.isChosen) ?? record.topCandidates[0];
  const runnerUp = record.topCandidates.find((c) => !c.isChosen);
  if (chosen && runnerUp) {
    const chosenPct = Math.round(chosen.winRate * 100);
    const runnerPct = Math.round(runnerUp.winRate * 100);
    const sep = chosenPct > runnerPct ? "＞" : "vs";
    return `${chosen.label} ${chosenPct}% ${sep} ${runnerUp.label} ${runnerPct}%`;
  }
  const rate = chosen ? chosen.winRate : record.chosenWinRate!;
  return `${record.chosenLabel} ${fmtPct(rate)}`;
}

function spoilerCardLabel(db: CardDb, cardId: string): string {
  const card = db.get(cardId);
  if (!card) return cardId;
  return card.nameZh || card.nameJa || cardId;
}

function safeOppPublicCardLabel(ctx: NarratorContext, cardId: string): string {
  const card = ctx.db.get(cardId);
  const label = card ? card.nameZh || card.nameJa : "";
  if (!label) return "那張關鍵牌";
  const normLabel = normName(label);
  // 鏡像對局時，若對手公開入手的卡剛好與我方隱藏手牌同名，safe 改採代稱避免觸發零洩漏護欄
  for (const uid of ctx.state.players[ctx.perspectivePlayer].hand) {
    const handCard = safeCardOf(ctx.db, ctx.state, uid);
    if (!handCard) continue;
    const candidates = [handCard.nameJa, normName(handCard.nameJa), handCard.nameZh ?? "", normName(handCard.nameZh ?? "")];
    if (candidates.some((name) => name && (normLabel.includes(name) || name.includes(normLabel)))) {
      return "那張關鍵牌";
    }
  }
  return label;
}

function isSteadyDefense(ctx: NarratorContext): boolean {
  return (ctx.state.phase === "receive" || ctx.state.phase === "block") && ctx.incomingOp > 0 && ctx.currentDefenseDp >= ctx.incomingOp;
}

function isPlayedDrawEvent(ctx: NarratorContext): boolean {
  if (ctx.decision.type !== "free" || ctx.decision.action !== "event") return false;
  const card = safeCardOf(ctx.db, ctx.state, ctx.decision.uid);
  return card ? isDrawOrTutorEvent(card) : ctx.hasPlayableDrawEvent;
}

function narrateTransition(record: Omit<AiThoughtRecord, "dialogue">): AiThoughtDialogue {
  const withStats = hasSearchStats(record);
  if (record.pendingType === "serve-rights") {
    return {
      safe: "開局先就位，照自己順手的節奏打就好。",
      spoiler: withStats ? `開局手順：${spoilerCompare(record)}。` : `開局手順：${record.chosenLabel}。`,
    };
  }
  if (record.pendingType === "pick-set-card") {
    return {
      safe: "這局先這樣收尾，拿回一張牌準備下一局反攻。",
      spoiler: withStats ? `局間手順：${spoilerCompare(record)}。` : `局間手順：${record.chosenLabel}。`,
    };
  }
  if (record.pendingType === "free") {
    return {
      safe: "這邊沒有特別要補的動作，順順往下一步走。",
      spoiler: withStats ? `無可宣告技能或事件，直接 ${spoilerCompare(record)}。` : `無可宣告技能或事件，直接${record.chosenLabel}。`,
    };
  }
  return {
    safe: "這步沒什麼分歧，照著單一路線往下走就好。",
    spoiler: withStats ? `無分歧過場決策：${spoilerCompare(record)}。` : `唯一或直接出手選項：${record.chosenLabel}。`,
  };
}

function narrateDeployTone(
  record: Omit<AiThoughtRecord, "dialogue">,
  ctx: NarratorContext,
  area: "serve" | "receive" | "toss" | "attack",
): AiThoughtDialogue {
  if (
    (ctx.decision.type === "deploy-serve" ||
      ctx.decision.type === "deploy-receive" ||
      ctx.decision.type === "deploy-toss" ||
      ctx.decision.type === "deploy-attack") &&
    ctx.decision.uid === null
  ) {
    return {
      safe: "手上實在湊不出合適的人選了，這局先放掉保留實力。",
      spoiler: hasSearchStats(record) ? `無合適人選可登場（${spoilerCompare(record)}）。` : `選擇不登場（${record.chosenLabel}）。`,
    };
  }

  const prob = record.chosenWinRate ?? ctx.valueProbability ?? 0.5;
  const stance = prob >= 0.58 ? "ahead" : prob <= 0.42 ? "behind" : "even";

  const safeByArea: Record<typeof area, Record<typeof stance, string>> = {
    serve: {
      ahead: "節奏在我這邊，這球穩穩把發球壓力打過去就好。",
      even: "雙方還在拉鋸，這記發球先試著搶點主動權。",
      behind: "現在分數比較吃緊，得靠這記發球把節奏搶回來！",
    },
    receive: {
      ahead: "局面還算主動，這球穩穩接起來再準備反推一波。",
      even: "這波攻防很關鍵，先把球接穩再找機會反擊。",
      behind: "這球一定要頂住，先接起來才有辦法撐住後面幾拍。",
    },
    toss: {
      ahead: "先穩住舉球品質，把進攻線架好讓後面更好發揮。",
      even: "先做好舉球銜接，讓這波進攻保持足夠的威脅。",
      behind: "局勢有點被動，得靠這球托到位、看能不能打出一波反攻。",
    },
    attack: {
      ahead: "節奏在我這邊，這手穩穩把壓力打過去就好。",
      even: "這波僵持不下，穩穩把這記扣球送過去測試對面防線。",
      behind: "現在落後了不能再保守，這球全力打穿對面防線！",
    },
  };

  const spoilerPrefix: Record<typeof stance, string> = {
    ahead: "局勢佔優",
    even: "場面拉鋸",
    behind: "局勢落後力圖反攻",
  };

  return {
    safe: safeByArea[area][stance],
    spoiler: hasSearchStats(record)
      ? `${spoilerPrefix[stance]}；選擇 ${spoilerCompare(record)}。`
      : `${spoilerPrefix[stance]}；直覺選擇「${record.chosenLabel}」。`,
  };
}

/** 依思維摘要與場況生成確定性繁中真人語氣雙版本台詞（safe 絕不洩漏我方手牌）。 */
export function narrateAiThought(record: Omit<AiThoughtRecord, "dialogue">, ctx: NarratorContext): AiThoughtDialogue {
  const withStats = hasSearchStats(record);

  if (record.pendingType === "serve-rights" || record.pendingType === "pick-set-card") {
    return narrateTransition(record);
  }

  // 1. 公開記憶抓到對手手牌
  if (record.belief && record.belief.knownOppHandCardIds.length > 0) {
    const firstId = record.belief.knownOppHandCardIds[0]!;
    const safeName = safeOppPublicCardLabel(ctx, firstId);
    const spoilerName = spoilerCardLabel(ctx.db, firstId);
    return {
      safe: `剛看你把${safeName}撿回手上，這輪防守不能太大意。得留點後手，別輕易把防線交代光。`,
      spoiler: withStats
        ? `記憶鎖定對手手牌「${spoilerName}」；優先考量路線（${spoilerCompare(record)}）。`
        : `記憶鎖定對手手牌「${spoilerName}」；選擇「${record.chosenLabel}」。`,
    };
  }

  // 2. 賽末點負面排除
  if (record.belief?.reducedTags.some((tag) => tag.includes("matchpoint"))) {
    return {
      safe: "你上一球都放了，手上高接球應該不多，這波直接壓上去！趁現在把節奏抓回來。",
      spoiler: withStats
        ? `賽末點負面排除對手高接球權重；${spoilerCompare(record)}。`
        : `賽末點負面排除對手高接球權重；選擇「${record.chosenLabel}」。`,
    };
  }

  // 3. 必敗局戰術攔網濾牌
  const isHopelessCycling =
    record.tieBreakReason === "hopeless-defense-cycling" ||
    (record.pendingType === "deploy-block" &&
      ctx.decision.type === "deploy-block" &&
      ctx.decision.uids !== null &&
      ctx.decision.uids.length > 0 &&
      ctx.incomingOp > 0 &&
      ctx.state.players[ctx.perspectivePlayer].setArea.length > 0 &&
      blockDecisionDp(ctx.db, ctx.state, ctx.perspectivePlayer, ctx.decision) < ctx.incomingOp &&
      !ctx.decision.uids.some((u) => hasImmediateOneTouchHint(ctx.db, ctx.state, ctx.perspectivePlayer, u, ctx.incomingOp)));

  if (isHopelessCycling) {
    return {
      safe: "這球硬接也擋不住了，不如順手攔網換幾張新牌、為下一局鋪路。",
      spoiler: withStats
        ? `必敗局啟動戰術濾牌：${spoilerCompare(record)}，進 Interval 補抽（優於直接 Lost）。`
        : `必敗局啟動戰術濾牌：${record.chosenLabel} 進 Interval 補抽（優於直接 Lost）。`,
    };
  }

  // 4. free 穩接＋有舉攻＋對面高 Guts (oppGuts >= 3)＋手上有防禦加點事件卻選 pass
  if (
    record.pendingType === "free" &&
    ctx.decision.type === "free" &&
    ctx.decision.action === "pass" &&
    isSteadyDefense(ctx) &&
    ctx.hasLegalFollowup &&
    ctx.oppGuts >= 3 &&
    ctx.hasPlayableDefBuffEvent
  ) {
    return {
      safe: "這球接得住，先別急著交牌。對面 Guts 越堆越多，得留一手防後面大招。",
      spoiler: withStats
        ? `已經接得住，先扣著防禦事件不交（${spoilerCompare(record)}）；留著防對面 ${ctx.oppGuts} Guts 爆發。`
        : `已經接得住，先扣著防禦事件不交（選擇 Pass）；留著防對面 ${ctx.oppGuts} Guts 爆發。`,
    };
  }

  // 5. free 穩接但缺舉攻鏈＋打出抽／檢索事件
  if (
    record.pendingType === "free" &&
    ctx.decision.type === "free" &&
    ctx.decision.action === "event" &&
    isSteadyDefense(ctx) &&
    !ctx.hasLegalFollowup &&
    isPlayedDrawEvent(ctx)
  ) {
    return {
      safe: "這球雖然接得住，但我手上缺反擊拼圖，先開一張濾一下牌！",
      spoiler: withStats
        ? `手牌缺舉攻線，選擇先開事件抽濾（${spoilerCompare(record)}）。`
        : `手牌缺舉攻線，選擇先開事件抽濾（${record.chosenLabel}）。`,
    };
  }

  // 非關鍵過場步（於專屬 read/free 語意條件後裁定）
  if (!record.isKeyDecision) {
    return narrateTransition(record);
  }

  // 6. 其他 free 關鍵動作（event / skill / lost / 有選項但忍住 pass）
  if (record.pendingType === "free" && ctx.decision.type === "free") {
    if (ctx.decision.action === "lost") {
      return {
        safe: "這球確實救不回來了，乾脆直接讓掉這分、保留手牌拼下一局。",
        spoiler: withStats
          ? `判斷主動讓分保留資源（${spoilerCompare(record)}）。`
          : `判斷主動讓分保留資源（${record.chosenLabel}）。`,
      };
    }
    if (ctx.decision.action === "event") {
      if (isSteadyDefense(ctx)) {
        return {
          safe: "這球算接得穩，順手把手上適合現在節奏的事件打出來鋪局。",
          spoiler: withStats
            ? `雖已接穩仍開事件調度局面（${spoilerCompare(record)}）。`
            : `打出事件調整場面（${record.chosenLabel}）。`,
        };
      }
      if (ctx.incomingOp > 0 && ctx.currentDefenseDp < ctx.incomingOp) {
        return {
          safe: "對面這球來勢不小，現在交出這張牌拼過線最划算。",
          spoiler: withStats
            ? `點數吃緊，開事件補防過線（${spoilerCompare(record)}）。`
            : `點數吃緊，開事件補防過線（${record.chosenLabel}）。`,
        };
      }
      return {
        safe: "節奏剛好走到這步，先開一張事件幫後面的攻擊鋪路。",
        spoiler: withStats
          ? `自由步驟主動開事件擴大優勢（${spoilerCompare(record)}）。`
          : `自由步驟開事件鋪場（${record.chosenLabel}）。`,
      };
    }
    if (ctx.decision.action === "skill") {
      return {
        safe: "這波把場上的主動技能點起來，趁機多賺一點場面優勢。",
        spoiler: withStats
          ? `啟動主動技能強化局面（${spoilerCompare(record)}）。`
          : `啟動主動技能（${record.chosenLabel}）。`,
      };
    }
    if (isSteadyDefense(ctx)) {
      return {
        safe: "目前防線還站得住，先扣著牌不亂交，留給後面關鍵球用。",
        spoiler: withStats
          ? `防線足夠過線，保留手牌選擇 Pass（${spoilerCompare(record)}）。`
          : `防線足夠過線，保留手牌選擇 Pass。`,
      };
    }
    return {
      safe: "有牌可以開，但現在交出去太虧了，先忍一手保留資源。",
      spoiler: withStats
        ? `評估保留資源更有利，選擇 Pass（${spoilerCompare(record)}）。`
        : `評估保留資源更有利，選擇 Pass。`,
    };
  }

  // 7. 各類關鍵決策與 tieBreakReason
  if (record.tieBreakReason === "one-touch-lean") {
    return {
      safe: "用一張就能靠 One Touch 摸下來，沒必要多賠手牌去陪葬。",
      spoiler: withStats
        ? `勝率相近下採精簡單攔 One Touch（${spoilerCompare(record)}），省下手牌成本。`
        : `採精簡單攔 One Touch（${record.chosenLabel}）。`,
    };
  }

  if (record.tieBreakReason === "conservation-attack") {
    return {
      safe: "贏面已經很穩了，這球省點火力出剛好的就好，大牌留著壓後面。",
      spoiler: withStats
        ? `高勝率優勢下改用低耗點數省資源進攻（${spoilerCompare(record)}）。`
        : `優勢局面省資源進攻（${record.chosenLabel}）。`,
    };
  }

  if (record.tieBreakReason === "pressure-tiebreak") {
    const c0 = record.topCandidates[0];
    const c1 = record.topCandidates[1];
    return {
      safe: "這幾手感覺差不多，那就挑壓制力最足的路線打過去！",
      spoiler:
        withStats && c0 && c1
          ? `勝率接近平手（${fmtPct(c0.winRate)} vs ${fmtPct(c1.winRate)}），依場上壓制力選較高輸出路線（${record.chosenLabel}）。`
          : withStats
            ? `勝率接近平手，依場上壓制力選較高輸出路線（${spoilerCompare(record)}）。`
            : `盤勢接近，依壓制力選高輸出路線（${record.chosenLabel}）。`,
    };
  }

  switch (record.pendingType) {
    case "mulligan": {
      const returned = ctx.decision.type === "mulligan" ? ctx.decision.returnUids.length : 0;
      if (returned === 0) {
        return {
          safe: "這副起手攻守節奏都算齊，先穩穩保留不換牌。",
          spoiler: withStats
            ? `起手結構完整，選擇保留全手牌（${spoilerCompare(record)}）。`
            : "起手結構完整，選擇不換牌。",
        };
      }
      return {
        safe: "起手稍微卡了點，把重複或多餘的牌洗回去，再補找關鍵拼圖。",
        spoiler: withStats
          ? `調整起手節奏，換掉 ${returned} 張（${spoilerCompare(record)}）。`
          : `調整起手結構：${record.chosenLabel}。`,
      };
    }

    case "defense-choice": {
      const choseBlock = ctx.decision.type === "defense-choice" && ctx.decision.choice === "block";
      if (choseBlock) {
        return {
          safe: "這球有機會直接攔網斷下來，先試著在網前施壓！",
          spoiler: withStats
            ? `評估網前攔網更具優勢（${spoilerCompare(record)}）。`
            : "評估選擇攔網防守。",
        };
      }
      return {
        safe: "這波穩一點接球再組織反擊，順便多看一張牌比較踏實。",
        spoiler: withStats
          ? `選擇接球線兼顧抽牌與反擊（${spoilerCompare(record)}）。`
          : "評估選擇接球路線。",
      };
    }

    case "deploy-block": {
      if (ctx.decision.type === "deploy-block" && ctx.decision.uids === null) {
        return {
          safe: "這球攔不下來了，乾脆把牌留著拚下一局比較實際。",
          spoiler: withStats
            ? `放棄攔網保留手牌（${spoilerCompare(record)}）。`
            : "不登場攔網保留資源。",
        };
      }
      const uids = ctx.decision.type === "deploy-block" && ctx.decision.uids ? ctx.decision.uids : [];
      if (uids.length === 1 && hasImmediateOneTouchHint(ctx.db, ctx.state, ctx.perspectivePlayer, uids[0]!, ctx.incomingOp)) {
        return {
          safe: "先派一位單人頂在網前拚 One Touch，省點手牌過這關。",
          spoiler: withStats
            ? `單人攔網拚 One Touch（${spoilerCompare(record)}）。`
            : `單人攔網拚 One Touch（${record.chosenLabel}）。`,
        };
      }
      if (uids.length >= 2) {
        return {
          safe: "這球威力不小，多叫幾位一起跳起來築牆才撐得住！",
          spoiler: withStats
            ? `多人聯防攔網擋住高壓進攻（${spoilerCompare(record)}）。`
            : `多人聯防攔網（${record.chosenLabel}）。`,
        };
      }
      return {
        safe: "單人守在網前卡位，先把對面的進攻路線封起來。",
        spoiler: withStats
          ? `單人攔網守線（${spoilerCompare(record)}）。`
          : `單人攔網（${record.chosenLabel}）。`,
      };
    }

    case "deploy-serve":
      return narrateDeployTone(record, ctx, "serve");
    case "deploy-receive":
      return narrateDeployTone(record, ctx, "receive");
    case "deploy-toss":
      return narrateDeployTone(record, ctx, "toss");
    case "deploy-attack":
      return narrateDeployTone(record, ctx, "attack");

    case "effect-confirm": {
      const accept = ctx.decision.type === "effect-confirm" && ctx.decision.accept;
      if (accept) {
        return {
          safe: "這波效果開起來效益不錯，果斷發動搶佔主動權！",
          spoiler: withStats
            ? `確認發動效果（${spoilerCompare(record)}）。`
            : `確認發動效果（${record.chosenLabel}）。`,
        };
      }
      return {
        safe: "現在發動代價不太划算，先省下來留給更需要的場面。",
        spoiler: withStats
          ? `放棄發動效果以保留資源（${spoilerCompare(record)}）。`
          : `選擇不使用效果（${record.chosenLabel}）。`,
      };
    }

    case "effect-cards": {
      const count = ctx.decision.type === "effect-cards" ? ctx.decision.uids.length : 0;
      if (count === 0) {
        return {
          safe: "這邊不需要硬湊著選，保持手上的節奏就好。",
          spoiler: withStats
            ? `效果選擇不選卡（${spoilerCompare(record)}）。`
            : "效果選擇不選卡。",
        };
      }
      return {
        safe: "挑最能幫上接下來幾拍的牌來處理，讓資源效益最大化。",
        spoiler: withStats
          ? `依局面挑出最佳對象（${spoilerCompare(record)}）。`
          : `效果選卡：${record.chosenLabel}。`,
      };
    }

    case "effect-option":
      return {
        safe: "比對一下眼前的場面需求，挑對這回合最有幫助的分支。",
        spoiler: withStats
          ? `挑選較有利的效果分支（${spoilerCompare(record)}）。`
          : `選擇效果分支：${record.chosenLabel}。`,
      };

    case "resolve-pending":
      return {
        safe: "幾個效果排在一起，先處理順手的那個把連鎖串起來。",
        spoiler: withStats
          ? `安排效果結算順序（${spoilerCompare(record)}）。`
          : `先解決：${record.chosenLabel}。`,
      };

    default:
      return narrateTransition(record);
  }
}
