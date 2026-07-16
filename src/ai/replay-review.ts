import type { CardDb, GameState, PlayerId } from "../engine/types";
import { replayEntryLogs, summarizeReplaySession, type ReplayAnalytics, type ReplayEntry, type ReplaySession } from "../shared/replayHistory";
import type { ActionImpactStats } from "./benchmark";
import {
  evaluateGameplanState,
  evaluateGameplanTransition,
  resolveGameplanProfile,
  type GameplanObjectiveResult,
  type GameplanStateReport,
  type GameplanTone,
} from "./gameplan";
import { explainValue, type ValueExplanation } from "./rollout-value";
import { defenseHolds, estimateMaxReceiveDP } from "./opponent-max";

export interface ReplaySetReview {
  setNo: number;
  winner: PlayerId | null;
  lastTurnNo: number;
  lastEntryIndex: number;
  deckCount: number;
  handCount: number;
  dropCount: number;
  gameplanStage?: string;
  gameplanProgressScore?: number;
  objectives?: ReplayObjectiveSnapshot[];
}

export interface ReplayObjectiveSnapshot {
  id: string;
  label: string;
  value: number;
  threshold: number;
  complete: boolean;
}

export interface ReplayGameplanCheckpoint {
  entryIndex: number;
  setNo: number;
  turnNo: number;
  phase: ReplayEntry["phase"];
  source: ReplayEntry["source"];
  actingPlayer: PlayerId;
  pendingType: ReplayEntry["pendingType"];
  tone: GameplanTone;
  delta: number;
  beforeScore: number;
  afterScore: number;
  stage: string;
  badges: string[];
  risks: string[];
  objectiveChanges: ReplayObjectiveChange[];
  logLines: string[];
}

export interface ReplayObjectiveChange {
  id: string;
  label: string;
  before: number;
  after: number;
  threshold: number;
}

export interface ReplayGameplanReview {
  profileId: string;
  displayName: string;
  final: GameplanStateReport;
  checkpoints: ReplayGameplanCheckpoint[];
}

export type LostSetCause = "no-deploy" | "judge-fail" | "voluntary" | "unknown";

/** 玩家失去一個 Set（含敗北）的歸因：哪一步、什麼原因、當下 OP/DP。 */
export interface LostSetAttribution {
  setNo: number;
  entryIndex: number;
  turnNo: number;
  phase: ReplayEntry["phase"];
  matchPoint: boolean;
  cause: LostSetCause;
  detail: string;
  opAtLoss?: number;
  dpAtLoss?: number;
}

export interface LostSetSummary {
  total: number;
  byCause: Record<LostSetCause, number>;
  attributions: LostSetAttribution[];
}

/** 事件 / 技能效率：沿用 benchmark 的「打出後是否有可觀察效果」定義（抽牌 / 入手 / 登場 / 點數修正）。 */
export interface ActionEffectivenessLine {
  kind: "event" | "skill";
  uses: number;
  effectiveUses: number;
  rate: number;
  draws: number;
  handAdds: number;
  deploys: number;
  pointMods: number;
  paidGuts: number;
}

export interface ReplayActionEffectiveness {
  event: ActionEffectivenessLine;
  skill: ActionEffectivenessLine;
}

/**
 * [Claude 2026-07-09] Phase M ③（賽後復盤，地面真相尺）：我方每次攻擊 vs 對手當下真實防守上限。
 * 出處文章第 3/4 點——出手前要估對手接不接得住。這裡用全資訊（replay）算對手那一刻手上/場上
 * 最強接球 DP：`into-hold`＝DP≥OP，正確打法下對手守得住（若非在磨資源，這火力宜改存 Guts）。
 * `clean-break`＝對手怎麼接都擋不住，是穩過的正確 commit。`held`＝實際判定是否被守住。
 */
export type AttackVerdict = "clean-break" | "into-hold";

export interface AttackGambleLine {
  setNo: number;
  turnNo: number;
  entryIndex: number;
  /** 我方該次攻擊實際算出的 OP（attack-op event 值）。 */
  myOP: number;
  /** 對手在我 commit 當下能擺出的最強接球 DP（卡面基礎值）。 */
  oppMaxReceiveDP: number;
  oppBestReceiverName: string | null;
  verdict: AttackVerdict;
  /** 實際判定對手是否守住；紀錄無對應判定行時為 null。 */
  held: boolean | null;
}

export interface AttackGambleSummary {
  attacks: number;
  /** oppMaxReceiveDP ≥ myOP 的次數（打進接得住的防線）。 */
  intoHold: number;
  cleanBreaks: number;
  lines: AttackGambleLine[];
}

export interface ReplayReviewReport {
  startedAt: string;
  seed: number;
  deckLabels: [string, string];
  player: PlayerId;
  analytics: ReplayAnalytics;
  setReviews: ReplaySetReview[];
  lostSets: LostSetSummary;
  actionEffectiveness: ReplayActionEffectiveness;
  actionCardDetails: ActionCardDetail[];
  attackGamble: AttackGambleSummary;
  valueExplanation: ValueExplanation;
  narrative: string[];
  gameplan?: ReplayGameplanReview;
}

function effectivenessLine(kind: "event" | "skill", impact: ActionImpactStats): ActionEffectivenessLine {
  return {
    kind,
    uses: impact.uses,
    effectiveUses: impact.effectiveUses,
    rate: impact.uses > 0 ? impact.effectiveUses / impact.uses : 0,
    draws: impact.draws,
    handAdds: impact.handAdds,
    deploys: impact.deploys,
    pointMods: impact.pointMods,
    paidGuts: impact.paidGuts,
  };
}

/** 逐張事件 / 技能命中明細：哪張卡打了幾次、其中幾次有效。 */
export interface ActionCardDetail {
  kind: "event" | "skill";
  cardName: string;
  uses: number;
  effectiveUses: number;
}

function firstNumber(text: string): number {
  const m = /-?\d+/.exec(text);
  return m ? Number(m[0]) : 0;
}

function blankImpact(): ActionImpactStats {
  return { uses: 0, effectiveUses: 0, impactCount: 0, pointMods: 0, draws: 0, handAdds: 0, deploys: 0, paidGuts: 0 };
}

function cardName(db: CardDb, state: GameState, uid: number): string {
  return db.get(state.cards[uid]!)?.nameJa ?? `uid:${uid}`;
}

/**
 * 逐張統計事件 / 技能命中。這裡刻意鏡像 benchmark `collectMatchStats` 的「有效使用」判讀規則
 * （打出後窗口內出現抽牌 / 入手 / 登場 / 點數修正即視為 effective），但 keyed by 卡名。
 * `buildActionCardDetails` 的彙總必須等於 `buildActionEffectiveness`（aggregate）——由測試交叉驗證，
 * 一旦 benchmark 規則改動造成漂移，consistency test 會失敗。
 */
function buildActionStats(db: CardDb, session: ReplaySession, player: PlayerId): { effectiveness: ReplayActionEffectiveness; details: ActionCardDetail[] } {
  type Active = { kind: "event" | "skill"; name: string; impacted: boolean } | null;
  const active: [Active, Active] = [null, null];
  const impact: Record<"event" | "skill", ActionImpactStats> = { event: blankImpact(), skill: blankImpact() };
  const order: string[] = [];
  const map = new Map<string, ActionCardDetail>();

  const ensure = (kind: "event" | "skill", name: string): ActionCardDetail => {
    const key = `${kind}:${name}`;
    let detail = map.get(key);
    if (!detail) {
      detail = { kind, cardName: name, uses: 0, effectiveUses: 0 };
      map.set(key, detail);
      order.push(key);
    }
    return detail;
  };

  const markImpact = (p: PlayerId) => {
    const a = active[p];
    if (!a || a.impacted) return;
    a.impacted = true;
    if (p === player) {
      ensure(a.kind, a.name).effectiveUses++;
      impact[a.kind].effectiveUses++;
    }
  };

  const markImpactField = (
    p: PlayerId,
    field: keyof Omit<ActionImpactStats, "uses" | "effectiveUses" | "impactCount" | "paidGuts">,
    amount = 1,
  ) => {
    const a = active[p];
    if (!a) return;
    if (p === player) {
      impact[a.kind].impactCount += amount;
      impact[a.kind][field] += amount;
    }
    markImpact(p);
  };

  const registerUse = (kind: "event" | "skill", p: PlayerId, name: string) => {
    active[p] = { kind, name, impacted: false };
    if (p !== player) return;
    ensure(kind, name).uses++;
    impact[kind].uses++;
  };

  // [Claude 2026-07-07] gate 技能路徑：引擎對登場/區域技能先 log「解決：X 的(登場)技能」，
  // 使用與否由下一個該玩家決策（effect-confirm accept／effect-cards 非空選卡）決定；
  // 「解決」行本身不算 use（可能 decline、條件不成立或［ターン1］無效）。
  const pendingSkill: [string | null, string | null] = [null, null];
  const SKILL_RESOLVE = /^解決：(.+?) 的[^ ]*技能$/u;
  const isSkillCostOrImpact = (text: string): boolean =>
    text.startsWith("支付 ") || text.startsWith("棄 ") ||
    (text.includes("抽") && !text.startsWith("接球抽牌") && !text.includes("牌組已空")) ||
    text.includes("加入手牌") ||
    (text.includes(" 的") && (text.includes("+") || text.includes("變為")));

  for (const entry of session.entries) {
    const decision = entry.decision;
    if (decision.type === "free") {
      if (decision.action === "event") registerUse("event", entry.player, cardName(db, entry.before, decision.uid));
      if (decision.action === "skill") registerUse("skill", entry.player, cardName(db, entry.before, decision.uid));
    } else if (decision.type === "resolve-pending") {
      const pending = entry.before.pendingQueue.find((item) => item.id === decision.id);
      if (pending?.kind === "passive") registerUse("skill", pending.player, cardName(db, entry.before, pending.source));
    } else if (decision.type === "effect-confirm" && pendingSkill[entry.player]) {
      if (decision.accept) registerUse("skill", entry.player, pendingSkill[entry.player]!);
      pendingSkill[entry.player] = null;
    } else if (decision.type === "effect-cards" && pendingSkill[entry.player]) {
      if (decision.uids.length > 0) registerUse("skill", entry.player, pendingSkill[entry.player]!);
      pendingSkill[entry.player] = null;
    }

    for (const log of replayEntryLogs(entry)) {
      if (log.player === null) continue;
      const p = log.player;
      const text = log.text;

      if (text.startsWith("── ")) {
        active[p] = null;
        pendingSkill[p] = null;
      }
      const resolveMatch = SKILL_RESOLVE.exec(text);
      if (resolveMatch && !(active[p]?.kind === "skill" && active[p]?.name === resolveMatch[1])) {
        pendingSkill[p] = resolveMatch[1]!;
      }
      if (text === "選擇不使用技能") pendingSkill[p] = null;
      // 無 gate 決策就直接產生成本/效果的技能（強制型）：以第一個成本/效果 log 認定 use
      if (pendingSkill[p] && isSkillCostOrImpact(text)) {
        registerUse("skill", p, pendingSkill[p]!);
        pendingSkill[p] = null;
      }
      if (text.startsWith("打出事件卡 ")) {
        pendingSkill[p] = null; // 換了行動來源，未決技能上下文作廢（防誤配到事件的 gate）
        if (!active[p]) registerUse("event", p, text.slice("打出事件卡 ".length).trim());
      }
      // 關鍵字效果（フェイント/ワンタッチ/バックアタック…）log 形如「［フェイント(4)］」＝技能實效
      if (/^［.+\(\d+\)］/.test(text)) markImpactField(p, "pointMods");
      if (text.startsWith("使用 ") && text.includes(" 的技能") && !active[p]) {
        registerUse("skill", p, text.slice("使用 ".length, text.indexOf(" 的技能")).trim());
      }
      if (text.startsWith("支付 ") && text.includes(" Guts") && active[p] && p === player) {
        impact[active[p]!.kind].paidGuts += firstNumber(text);
      }
      if (text.includes("牌組已空，無法抽牌")) {
        // 無效抽牌，不算命中
      } else if (text.includes("抽") && !text.startsWith("接球抽牌")) {
        markImpactField(p, "draws", Math.max(1, firstNumber(text)));
      }
      if (text.includes("加入手牌") || text.includes("回到手牌") || text.includes("回收")) markImpactField(p, "handAdds");
      const deployMatch = text.match(/→ (serve|receive|toss|attack)$/);
      if (deployMatch) {
        if (text.includes("從") || text.includes("移動") || text.includes("登場 →")) markImpactField(p, "deploys");
        else active[p] = null;
      }
      if (text.match(/^攔網登場 (.+)（中央=/)) active[p] = null;
      if (text.includes(" 的") && (text.includes("+") || text.includes("變為"))) markImpactField(p, "pointMods");
    }
  }

  return {
    effectiveness: {
      event: effectivenessLine("event", impact.event),
      skill: effectivenessLine("skill", impact.skill),
    },
    details: order.map((key) => map.get(key)!),
  };
}

const OTHER: Record<PlayerId, PlayerId> = { 0: 1, 1: 0 };

/**
 * 中文檢討文案：把結果、失 Set 根因（資源 / 構築層解讀）、事件/技能效率、主軸推進綜合成幾條重點。
 * 失 Set 不只報直接原因（未登場 / 判定失敗 / 主動），而是往上歸因到「為何資源不足以登場或判定」。
 */
function buildReplayNarrative(input: {
  player: PlayerId;
  analytics: ReplayAnalytics;
  lostSets: LostSetSummary;
  effectiveness: ReplayActionEffectiveness;
  attackGamble: AttackGambleSummary;
  gameplan?: ReplayGameplanReview;
  valueExplanation?: ValueExplanation;
}): string[] {
  const { player, analytics, lostSets, effectiveness, attackGamble, gameplan, valueExplanation } = input;
  const opp = OTHER[player];
  const lines: string[] = [];

  if (analytics.matchWinner === null) {
    lines.push(`本場未分勝負，Set ${analytics.setWins[player]}:${analytics.setWins[opp]}。`);
  } else {
    const won = analytics.matchWinner === player;
    lines.push(`本場${won ? "獲勝" : "落敗"}，Set ${analytics.setWins[player]}:${analytics.setWins[opp]}。`);
  }

  if (lostSets.total > 0) {
    const byCause = lostSets.byCause;
    const dominant = (Object.entries(byCause) as [LostSetCause, number][])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])[0];
    if (dominant) {
      const [cause, count] = dominant;
      if (cause === "no-deploy") {
        lines.push(`失 ${lostSets.total} Set 主要因「未能登場」（${count} 次）——關鍵時刻該區沒有可登場角色，屬登場資源不足。檢查手牌續航與低成本登場角色比例，或防守區的角色厚度。`);
      } else if (cause === "judge-fail") {
        const judges = lostSets.attributions.filter((a) => a.cause === "judge-fail" && a.opAtLoss !== undefined);
        const avgOp = judges.length ? judges.reduce((s, a) => s + (a.opAtLoss ?? 0), 0) / judges.length : 0;
        const avgDp = judges.length ? judges.reduce((s, a) => s + (a.dpAtLoss ?? 0), 0) / judges.length : 0;
        lines.push(`失 ${lostSets.total} Set 主要因「判定失敗」（${count} 次，平均被 OP ${avgOp.toFixed(1)} 壓過 DP ${avgDp.toFixed(1)}）——防守點數線偏低，考慮提高 RCV/DP 構築、保留 Guts 應對高 OP，或調整接球 / 攔網選擇。`);
      } else if (cause === "voluntary") {
        lines.push(`失 ${lostSets.total} Set 含 ${count} 次「主動放棄」——通常是保資源的取捨，回看是否棄得太早、有沒有更值得守的球。`);
      } else {
        lines.push(`失 ${lostSets.total} Set，部分原因無法從紀錄判讀。`);
      }
    }
  } else if (analytics.matchWinner === player) {
    lines.push("本場沒有失 Set，防守線穩定。");
  }

  const event = effectiveness.event;
  if (event.uses > 0) {
    if (event.rate < 0.5) lines.push(`事件打出 ${event.uses} 次但只有 ${Math.round(event.rate * 100)}% 轉成實質效果，檢查打出時機與成本是否划算。`);
    else lines.push(`事件 ${event.uses} 次中 ${event.effectiveUses} 次打出效果（抽 ${event.draws}、入手 ${event.handAdds}、登場 ${event.deploys}、點數 ${event.pointMods}），運用順暢。`);
  }
  const skill = effectiveness.skill;
  if (skill.uses > 0 && skill.rate < 0.5) {
    lines.push(`技能宣告 ${skill.uses} 次但有效率僅 ${Math.round(skill.rate * 100)}%，部分技能可能在沒收益的時機發動。`);
  }

  // [Claude 2026-07-09] Phase M ③：攻擊打進「對手接得住的防線」的比例。刻意不逕自判為失誤——
  // 磨對手防守資源（手牌數勝負路線）是正解之一（見 L0002/L0006）；只在「非為磨資源」時提示改存 Guts。
  if (attackGamble.attacks > 0 && attackGamble.intoHold > 0) {
    const held = attackGamble.lines.filter((line) => line.verdict === "into-hold" && line.held === true).length;
    const heldNote = held > 0 ? `，其中 ${held} 次確實被守住` : "";
    lines.push(
      `${attackGamble.attacks} 次攻擊有 ${attackGamble.intoHold} 次打進對手接得住的防線（對手當下最強接球 DP ≥ 你的 OP${heldNote}）——若不是在磨對手防守資源，這些點數可考慮改存 Guts、換一次真正穿防的爆發（文章①③）。`,
    );
  }

  if (gameplan) {
    const score = gameplan.final.progressScore;
    if (score >= 70) lines.push(`牌組主軸推進到「${gameplan.final.stage}」（${score}/100），引擎有跑起來。`);
    else if (score < 40) lines.push(`牌組主軸只推進到 ${score}/100（${gameplan.final.stage}），核心引擎沒運轉起來，回看是哪一步斷了節奏。`);
    else lines.push(`牌組主軸推進到 ${score}/100（${gameplan.final.stage}），中段卡住，可找關鍵轉折補強。`);
    if (gameplan.final.risks.length) lines.push(`主軸風險：${gameplan.final.risks.join("、")}。`);
  }

  if (valueExplanation) {
    const signal = valueExplanation.terms.find((term) => term.direction !== "neutral");
    if (signal) {
      lines.push(`終局估值 ${Math.round(valueExplanation.probability * 100)}%，主要來源是「${signal.label}」（${signal.contribution >= 0 ? "+" : ""}${signal.contribution.toFixed(2)}）。`);
    }
  }

  return lines;
}

const LOST_SET_CAUSE_LABEL: Record<LostSetCause, string> = {
  "no-deploy": "未能登場",
  "judge-fail": "判定失敗",
  voluntary: "主動放棄",
  unknown: "原因不明",
};

export function lostSetCauseLabel(cause: LostSetCause): string {
  return LOST_SET_CAUSE_LABEL[cause];
}

/** 從失球該 entry 的 log 文字判讀失 Set 原因；judge 行可解析出 OP/DP。 */
function classifyLostSet(logTexts: readonly string[]): { cause: LostSetCause; detail: string; opAtLoss?: number; dpAtLoss?: number } {
  let judge: { op: number; dp: number } | undefined;
  let hasNoDeploy = false;
  let hasVoluntary = false;
  for (const text of logTexts) {
    if (text.includes("未登場角色")) hasNoDeploy = true;
    if (text.includes("主動宣告 Lost")) hasVoluntary = true;
    const m = /判定：DP\s*(\d+)\s*vs\s*OP\s*(\d+)\s*→\s*失敗/.exec(text);
    if (m) judge = { dp: Number(m[1]), op: Number(m[2]) }; // 取最後一次失敗判定
  }
  if (hasNoDeploy) return { cause: "no-deploy", detail: "未能登場角色，被迫宣告 Lost（該區無法防守）" };
  if (judge) return { cause: "judge-fail", detail: `判定失敗：DP ${judge.dp} 擋不住 OP ${judge.op}`, opAtLoss: judge.op, dpAtLoss: judge.dp };
  if (hasVoluntary) return { cause: "voluntary", detail: "主動宣告 Lost（放棄此球）" };
  return { cause: "unknown", detail: "失球原因無法從紀錄判讀" };
}

function buildLostSetSummary(session: ReplaySession, player: PlayerId): LostSetSummary {
  const byCause: Record<LostSetCause, number> = { "no-deploy": 0, "judge-fail": 0, voluntary: 0, unknown: 0 };
  const attributions: LostSetAttribution[] = [];
  for (const entry of session.entries) {
    const logs = replayEntryLogs(entry);
    const lossEvent = logs.find(
      (log) => (log.event?.kind === "set-won" || log.event?.kind === "match-won") && log.event.loser === player,
    )?.event;
    if (!lossEvent || (lossEvent.kind !== "set-won" && lossEvent.kind !== "match-won")) continue;
    const classification = classifyLostSet(logs.map((log) => log.text));
    byCause[classification.cause]++;
    attributions.push({
      setNo: lossEvent.setNo,
      entryIndex: entry.index,
      turnNo: entry.turnNo,
      phase: entry.phase,
      matchPoint: lossEvent.kind === "match-won",
      cause: classification.cause,
      detail: classification.detail,
      opAtLoss: classification.opAtLoss,
      dpAtLoss: classification.dpAtLoss,
    });
  }
  return { total: attributions.length, byCause, attributions };
}

const JUDGE_RE = /判定：DP\s*(\d+)\s*vs\s*OP\s*(\d+)\s*→\s*(成功|失敗)/u;

/** 從攻擊 entry 起向後（同一 Set 內）找第一個 OP 相符的判定行，回傳防守方是否守住（成功＝守住）。 */
function attackHeldAfter(entries: readonly ReplayEntry[], fromIdx: number, setNo: number, myOP: number): boolean | null {
  for (let i = fromIdx; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.setNo !== setNo) break;
    for (const log of replayEntryLogs(entry)) {
      const m = JUDGE_RE.exec(log.text);
      if (m && Number(m[2]) === myOP) return m[3] === "成功";
    }
  }
  return null;
}

/**
 * 我方每次攻擊（attack-op event）對上對手當下真實防守上限。用攻擊 entry 的 `before` 快照——
 * 該時點對手尚未登場接球手，手上/場上接球資源完整 → estimateMaxReceiveDP 反映其真實防守天花板。
 */
function buildAttackGambleSummary(db: CardDb, session: ReplaySession, player: PlayerId): AttackGambleSummary {
  const opp = OTHER[player];
  const lines: AttackGambleLine[] = [];
  session.entries.forEach((entry, idx) => {
    for (const log of replayEntryLogs(entry)) {
      if (log.event?.kind !== "attack-op" || log.event.player !== player) continue;
      const myOP = log.event.value;
      const def = estimateMaxReceiveDP(db, entry.before, opp);
      lines.push({
        setNo: entry.setNo,
        turnNo: entry.turnNo,
        entryIndex: entry.index,
        myOP,
        oppMaxReceiveDP: def.dp,
        oppBestReceiverName: def.receiverName,
        verdict: defenseHolds(def.dp, myOP) ? "into-hold" : "clean-break",
        held: attackHeldAfter(session.entries, idx, entry.setNo, myOP),
      });
    }
  });
  const intoHold = lines.filter((line) => line.verdict === "into-hold").length;
  return { attacks: lines.length, intoHold, cleanBreaks: lines.length - intoHold, lines };
}

export interface ReplayReviewOptions {
  player?: PlayerId;
  includeNeutralObjectiveChanges?: boolean;
}

function objectiveSnapshot(objective: GameplanObjectiveResult): ReplayObjectiveSnapshot {
  return {
    id: objective.id,
    label: objective.label,
    value: objective.value,
    threshold: objective.threshold,
    complete: objective.complete,
  };
}

function objectiveChanges(before: GameplanStateReport, after: GameplanStateReport): ReplayObjectiveChange[] {
  const changes: ReplayObjectiveChange[] = [];
  for (const next of after.objectives) {
    const prev = before.objectives.find((item) => item.id === next.id);
    if (!prev || prev.value === next.value) continue;
    changes.push({
      id: next.id,
      label: next.label,
      before: prev.value,
      after: next.value,
      threshold: next.threshold,
    });
  }
  return changes;
}

function setWinnerFromLogs(entries: readonly ReplayEntry[], setNo: number): PlayerId | null {
  for (const entry of entries) {
    for (const log of replayEntryLogs(entry)) {
      if (log.event?.kind === "set-won" && log.event.setNo === setNo) return log.event.winner;
      if (log.event?.kind === "match-won" && log.event.setNo === setNo) return log.event.winner;
    }
  }
  return null;
}

function maxSetNo(session: ReplaySession): number {
  return session.entries.reduce((max, entry) => Math.max(max, entry.setNo), session.initialState.setNo);
}

function finalStateForSet(session: ReplaySession, setNo: number): { state: GameState; entry: ReplayEntry | null } {
  const entries = session.entries.filter((entry) => entry.setNo === setNo);
  const entry = entries.at(-1) ?? null;
  return { state: entry?.after ?? session.initialState, entry };
}

function shouldKeepCheckpoint(
  transition: ReturnType<typeof evaluateGameplanTransition>,
  changes: readonly ReplayObjectiveChange[],
  before: GameplanStateReport,
  includeNeutralObjectiveChanges: boolean,
): boolean {
  const newRisks = transition.risks.filter((risk) => !before.risks.includes(risk));
  const meaningfulChanges = changes.filter((change) => change.before < change.threshold || change.after < change.threshold);
  const unlockBadge = transition.badges.some((badge) => badge.includes("達成") || badge.includes("回收循環"));
  if (transition.tone === "risk" || transition.tone === "drift") return true;
  if (transition.delta !== 0 || unlockBadge || newRisks.length > 0) return true;
  if (transition.tone === "progress" && meaningfulChanges.length > 0) return true;
  return includeNeutralObjectiveChanges && meaningfulChanges.length > 0;
}

export function createReplayReviewReport(db: CardDb, session: ReplaySession, options: ReplayReviewOptions = {}): ReplayReviewReport {
  const player = options.player ?? 0;
  const analytics = summarizeReplaySession(session);
  const deckLabels: [string, string] = [session.decks[0].label, session.decks[1].label];
  const profile = resolveGameplanProfile(session.decks[player].label, session.decks[player].cardIds);
  const finalState = session.entries.at(-1)?.after ?? session.initialState;
  const finalGameplan = profile ? evaluateGameplanState(db, finalState, player, profile) : undefined;

  const setReviews: ReplaySetReview[] = [];
  for (let setNo = 1; setNo <= maxSetNo(session); setNo++) {
    const { state, entry } = finalStateForSet(session, setNo);
    const gameplan = profile ? evaluateGameplanState(db, state, player, profile) : undefined;
    setReviews.push({
      setNo,
      winner: setWinnerFromLogs(session.entries, setNo),
      lastTurnNo: entry?.turnNo ?? state.turnNo,
      lastEntryIndex: entry?.index ?? -1,
      deckCount: state.players[player].deck.length,
      handCount: state.players[player].hand.length,
      dropCount: state.players[player].drop.length,
      gameplanStage: gameplan?.stage,
      gameplanProgressScore: gameplan?.progressScore,
      objectives: gameplan?.objectives.map(objectiveSnapshot),
    });
  }

  const checkpoints: ReplayGameplanCheckpoint[] = [];
  if (profile) {
    for (const entry of session.entries) {
      const before = evaluateGameplanState(db, entry.before, player, profile);
      const transition = evaluateGameplanTransition(db, entry.before, entry.after, player, profile);
      const changes = objectiveChanges(before, transition);
      if (!shouldKeepCheckpoint(transition, changes, before, options.includeNeutralObjectiveChanges ?? true)) continue;
      checkpoints.push({
        entryIndex: entry.index,
        setNo: entry.setNo,
        turnNo: entry.turnNo,
        phase: entry.phase,
        source: entry.source,
        actingPlayer: entry.player,
        pendingType: entry.pendingType,
        tone: transition.tone,
        delta: transition.delta,
        beforeScore: before.progressScore,
        afterScore: transition.progressScore,
        stage: transition.stage,
        badges: transition.badges,
        risks: transition.risks.filter((risk) => !before.risks.includes(risk)),
        objectiveChanges: changes,
        logLines: replayEntryLogs(entry).map((log) => log.text),
      });
    }
  }

  const lostSets = buildLostSetSummary(session, player);
  const actionStats = buildActionStats(db, session, player);
  const actionEffectiveness = actionStats.effectiveness;
  const attackGamble = buildAttackGambleSummary(db, session, player);
  const valueExplanation = explainValue(finalState, player, undefined, db, [session.decks[0].cardIds, session.decks[1].cardIds]);
  const gameplan = profile && finalGameplan
    ? { profileId: profile.id, displayName: profile.displayName, final: finalGameplan, checkpoints }
    : undefined;

  return {
    startedAt: session.startedAt,
    seed: session.seed,
    deckLabels,
    player,
    analytics,
    setReviews,
    lostSets,
    actionEffectiveness,
    actionCardDetails: actionStats.details,
    attackGamble,
    valueExplanation,
    narrative: buildReplayNarrative({ player, analytics, lostSets, effectiveness: actionEffectiveness, attackGamble, gameplan, valueExplanation }),
    gameplan,
  };
}
