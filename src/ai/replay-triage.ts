// Triage 篩選掃描（M8 Phase E 復盤教練 skill，塊 3）。
// 全場掃描出「關鍵手候選」＝疑似失誤＋打得好的手＋需留意，每筆標訊號來源與強弱。
// 設計原則（spec §3）：**triage 只提名、不定論**。硬事實（失 Set 點）與軟啟發（PIMC 勝率差）
// 分級顯示；真正判決留到 deep-dive。所有訊號皆由 replay log/既有 report 推導，零幻覺。
//
// 注意分工：lost-set 訊號指向「失 Set 的那一步」（常是 Lost 宣告點），不是根因那一手。
// 使用者選一個失 Set 候選後，deep-dive 會回放整個 Set 的我方決策去找根因（如 Turn 6 倒下、
// 根因在 Turn 4）。這是刻意的——triage 圈出區域，deep-dive 釘出根因。

import type { CardDb, LogEntry, PlayerId } from "../engine/types";
import { replayEntryLogs, type ReplayEntry, type ReplaySession } from "../ui/replayHistory";
import { decisionLabel } from "./replay-board";
import { createReplayReviewReport, type LostSetCause } from "./replay-review";

export type TriageCategory = "mistake" | "good-play" | "concern";
export type TriageSignalSource = "lost-set" | "pimc" | "gameplan" | "effectiveness" | "set-win" | "clutch-defense";

export interface TriageSignal {
  source: TriageSignalSource;
  strength: 1 | 2 | 3;
  detail: string;
}

export interface TriageCandidate {
  step: number; // 1-based（＝entryIndex+1，與 CLI「第 N 步」一致）
  entryIndex: number;
  setNo: number;
  turnNo: number;
  phase: string;
  pendingType: string;
  category: TriageCategory;
  strength: number; // 1~3 綜合
  headline: string;
  signals: TriageSignal[];
}

export interface TriageResult {
  seed: number;
  deckLabels: [string, string];
  player: PlayerId;
  matchWinner: PlayerId | null;
  setWins: [number, number];
  candidates: TriageCandidate[];
}

/** PIMC 掃描的折入訊號（由 CLI 在 samples>0 時計算後傳入；triage 本身不跑 PIMC）。 */
export interface TriagePimcInput {
  entryIndex: number;
  kind: "mistake" | "tradeoff";
  delta: number; // 勝率差（0~1）
  bestChoice: string;
}

export interface TriageOptions {
  player?: PlayerId;
  pimc?: TriagePimcInput[];
  /** clutch 防守判定的最低 OP 門檻（預設 5）。 */
  clutchMinOp?: number;
}

interface RawSignal extends TriageSignal {
  category: TriageCategory;
}

const CATEGORY_RANK: Record<TriageCategory, number> = { mistake: 0, "good-play": 1, concern: 2 };
const LOST_SET_CATEGORY: Record<LostSetCause, TriageCategory> = {
  "no-deploy": "mistake",
  "judge-fail": "mistake",
  voluntary: "concern",
  unknown: "concern",
};

function maxSuccessfulJudgeOp(logs: readonly LogEntry[], minOp: number): number | null {
  let best: number | null = null;
  for (const log of logs) {
    const match = /判定：DP\s*\d+\s*vs\s*OP\s*(\d+)\s*→\s*成功/.exec(log.text);
    if (match) {
      const op = Number(match[1]);
      if (op >= minOp) best = Math.max(best ?? 0, op);
    }
  }
  return best;
}

function paidGutsBy(logs: readonly LogEntry[], player: PlayerId): boolean {
  return logs.some((log) => log.event?.kind === "pay-guts" && log.event.player === player);
}

/** 鏡像 benchmark 的「有效使用」精神：窗口內是否出現抽牌/入手/登場/點數修正。 */
function hasObservableImpact(logs: readonly LogEntry[]): boolean {
  return logs.some((log) => {
    const text = log.text;
    if (text.includes("牌組已空")) return false;
    return /抽|加入手牌|回到手牌|回收|→ (serve|receive|toss|attack)|變為|＋\d|\+\d/.test(text);
  });
}

function setWinners(session: ReplaySession): Map<number, PlayerId> {
  const winners = new Map<number, PlayerId>();
  for (const entry of session.entries) {
    for (const log of replayEntryLogs(entry)) {
      const event = log.event;
      if (event && (event.kind === "set-won" || event.kind === "match-won")) winners.set(event.setNo, event.winner);
    }
  }
  return winners;
}

/** 贏 Set 的決勝手：取該 Set 我方最後一個「實質動作」（攻擊登場優先，其次技能/事件/攔網），
 *  而非最後一步（常是 Pass）——避免把 Pass 誤標成「拿下 Set 的關鍵手」。 */
function decisivePlayerEntryInSet(session: ReplaySession, setNo: number, player: PlayerId): ReplayEntry | undefined {
  let attack: ReplayEntry | undefined;
  let action: ReplayEntry | undefined;
  let any: ReplayEntry | undefined;
  for (const entry of session.entries) {
    if (entry.setNo !== setNo || entry.source !== "player" || entry.player !== player) continue;
    any = entry;
    const decision = entry.decision;
    if (decision.type === "deploy-attack" && decision.uid != null) attack = entry;
    else if (decision.type === "free" && (decision.action === "skill" || decision.action === "event")) action = entry;
    else if (decision.type === "deploy-block" && decision.uids != null) action = entry;
  }
  return attack ?? action ?? any;
}

export function buildTriage(db: CardDb, session: ReplaySession, options: TriageOptions = {}): TriageResult {
  const player = options.player ?? 0;
  const clutchMinOp = options.clutchMinOp ?? 5;
  const report = createReplayReviewReport(db, session, { player });
  const byEntry = new Map<number, RawSignal[]>();
  const push = (entryIndex: number, signal: RawSignal) => {
    const list = byEntry.get(entryIndex);
    if (list) list.push(signal);
    else byEntry.set(entryIndex, [signal]);
  };

  // 1) 失 Set 歸因（硬事實）——指向失 Set 的那一步。
  for (const attribution of report.lostSets.attributions) {
    push(attribution.entryIndex, {
      source: "lost-set",
      strength: 3,
      category: LOST_SET_CATEGORY[attribution.cause],
      detail: `失 Set ${attribution.setNo}${attribution.matchPoint ? "（敗北）" : ""}：${attribution.detail}`,
    });
  }

  // 2) 主軸轉折（gameplan checkpoints）——只取我方決策，並去重複同一徵狀（同 badge 全場一次、
  //    同風險每 Set 一次），避免每步重複洗版。
  const seenBadge = new Set<string>();
  const seenRisk = new Set<string>();
  for (const checkpoint of report.gameplan?.checkpoints ?? []) {
    if (checkpoint.actingPlayer !== player || checkpoint.source !== "player") continue;
    if (checkpoint.tone === "risk" || checkpoint.tone === "drift") {
      const detail = `主軸${checkpoint.tone === "risk" ? "風險" : "偏移"}：${checkpoint.risks.join("、") || checkpoint.stage}`;
      const key = `${checkpoint.setNo}|${detail}`;
      if (seenRisk.has(key)) continue;
      seenRisk.add(key);
      push(checkpoint.entryIndex, { source: "gameplan", strength: 2, category: "concern", detail });
    } else if (checkpoint.tone === "progress" && checkpoint.badges.some((b) => b.includes("達成") || b.includes("回收循環"))) {
      const detail = `主軸推進：${checkpoint.badges.join("、")}`;
      if (seenBadge.has(detail)) continue;
      seenBadge.add(detail);
      push(checkpoint.entryIndex, { source: "gameplan", strength: 2, category: "good-play", detail });
    }
  }

  // 3) 贏 Set 轉折 ＋ 4) clutch 防守（打得好）。
  const winners = setWinners(session);
  for (const [setNo, winner] of winners) {
    if (winner !== player) continue;
    const entry = decisivePlayerEntryInSet(session, setNo, player);
    if (entry) {
      push(entry.index, { source: "set-win", strength: 2, category: "good-play", detail: `拿下 Set ${setNo} 的決勝手` });
    }
  }
  // clutch：付 Guts 撐住高 OP（任何 phase，抓到 RCV+N 硬接）＝★★★；或純防守 phase 防下高 OP。
  for (const entry of session.entries) {
    if (entry.source !== "player" || entry.player !== player) continue;
    const logs = replayEntryLogs(entry);
    const op = maxSuccessfulJudgeOp(logs, clutchMinOp);
    if (op === null) continue;
    const paid = paidGutsBy(logs, player);
    const defensive = entry.phase === "start" || entry.phase === "receive" || entry.phase === "block";
    let strength: 1 | 2 | 3 | null = null;
    if (paid) strength = 3;
    else if (defensive) strength = op >= 6 ? 3 : 2;
    if (strength === null) continue;
    push(entry.index, {
      source: "clutch-defense",
      strength,
      category: "good-play",
      detail: `硬接 OP ${op}${paid ? "（付 Guts）" : ""} 防守成立`,
    });
  }

  // 5) 技能/事件空放（需留意，弱訊號）。
  for (const entry of session.entries) {
    if (entry.source !== "player" || entry.player !== player) continue;
    const decision = entry.decision;
    if (decision.type !== "free" || (decision.action !== "skill" && decision.action !== "event")) continue;
    if (!hasObservableImpact(replayEntryLogs(entry))) {
      push(entry.index, {
        source: "effectiveness",
        strength: 1,
        category: "concern",
        detail: `${decision.action === "skill" ? "技能" : "事件"}打出後窗口內無可觀察收益`,
      });
    }
  }

  // 6) PIMC（選用，由 CLI 折入）。
  for (const pimc of options.pimc ?? []) {
    push(pimc.entryIndex, {
      source: "pimc",
      strength: 1,
      category: pimc.kind === "mistake" ? "mistake" : "concern",
      detail: `PIMC −${Math.round(pimc.delta * 100)}%（vs「${pimc.bestChoice}」，低樣本待查）`,
    });
  }

  const candidates: TriageCandidate[] = [];
  for (const [entryIndex, signals] of byEntry) {
    const entry = session.entries[entryIndex];
    if (!entry) continue;
    const cats = new Set(signals.map((s) => s.category));
    const category: TriageCategory = cats.has("mistake") ? "mistake" : cats.has("good-play") ? "good-play" : "concern";
    const strength = Math.min(3, Math.max(...signals.map((s) => s.strength)));
    const dominant = [...signals].sort((a, b) => b.strength - a.strength)[0]!;
    candidates.push({
      step: entryIndex + 1,
      entryIndex,
      setNo: entry.setNo,
      turnNo: entry.turnNo,
      phase: entry.phase,
      pendingType: entry.pendingType,
      category,
      strength,
      headline: `${decisionLabel(entry.before, db, entry.decision)}｜${dominant.detail}`,
      signals: signals.map(({ category: _c, ...rest }) => rest),
    });
  }
  candidates.sort(
    (a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || b.strength - a.strength || a.step - b.step,
  );

  return {
    seed: report.seed,
    deckLabels: report.deckLabels,
    player,
    matchWinner: report.analytics.matchWinner,
    setWins: report.analytics.setWins,
    candidates,
  };
}
