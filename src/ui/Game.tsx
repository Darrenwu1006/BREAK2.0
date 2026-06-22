import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Card } from "../data/types";
import type { CourtArea } from "../engine/dsl";
import { applyDecision, canChooseBlock, createGame, deployableUids, freeOptions } from "../engine/engine";
import { canDeployTo, deployNames } from "../engine/effects";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { heuristicAiDecision, heuristicProfileForDeckText } from "../ai/heuristic";
import type { CoachWorkerResponse } from "../ai/coach-worker";
import type { CoachActionEstimate, CoachReport } from "../ai/coach";
import { estimateThinkBudgetMs } from "../ai/think-budget";
import { createReplayReviewReport, lostSetCauseLabel, type ActionCardDetail, type LostSetSummary, type ReplayActionEffectiveness } from "../ai/replay-review";
import { CardView } from "./CardView";
import { GameBoard } from "./GameBoard";
import { CardCounter, CardDetails, CoachPanel, CompactHud, DropBrowser, GameLog, LeftPanel, MatchSummary, PHASE_NAME } from "./GamePanels";
import type { CoachPanelState } from "./GamePanels";
import type { AiSpeed, DeckMeta, InspectedCard } from "./gameTypes";
import { MotionLayer, useGameMotion } from "./useGameMotion";
import { canUseInPlaceEffectSelection } from "./selection";
import { popUndoSnapshot, pushPlayerUndoSnapshot, type UndoHistory, UNDO_HISTORY_LIMIT } from "./undoHistory";
import { appendReplayEntry, createReplaySession, keyReplayEntries, stateAtReplayStep, summarizeReplaySession, truncateReplaySession, type ReplayAnalytics, type ReplayEntry, type ReplaySession } from "./replayHistory";
import type { CardPointerDragInfo } from "./CardView";

const HUMAN: PlayerId = 0;
const AI: PlayerId = 1;

const DEPLOY_AREA: Record<string, CourtArea> = {
  "deploy-serve": "serve",
  "deploy-block": "block",
  "deploy-receive": "receive",
  "deploy-toss": "toss",
  "deploy-attack": "attack",
};

const DEPLOY_LABEL: Record<Exclude<CourtArea, "block">, string> = {
  serve: "發球",
  receive: "接球",
  toss: "托球",
  attack: "攻擊",
};

type ToolMode = { type: "detail" } | { type: "coach" } | { type: "counter" } | { type: "drop"; player: PlayerId } | { type: "event"; player: PlayerId };
type DragState = { uid: number; x: number; y: number; width: number; overArea: CourtArea | null; valid: boolean };

function initialSpeed(): AiSpeed {
  const stored = localStorage.getItem("breaktcg-ai-speed");
  return stored === "0.5" || stored === "1" || stored === "2" || stored === "instant" ? stored : "1";
}

function initialSfx(): boolean {
  return localStorage.getItem("breaktcg-sfx") !== "off";
}

const SFX_SCORE_YOU = ["決まった！", "キメた！", "ナイスキル！"];
const SFX_SCORE_OPP = ["やられた…", "とられた！"];
const SFX_ATTACK_YOU = ["ドン！", "バンッ！", "ズバン！"];
const SFX_ATTACK_OPP = ["ドッ！", "ズバッ！"];

type SplashBanner = { text: string; kind: "set" | "match" };
type GameRuntime = { state: GameState; replay: ReplaySession };
type ReplayCritiqueState =
  | { status: "idle" }
  | { status: "loading"; step: number }
  | { status: "ready"; step: number; report: CoachReport }
  | { status: "error"; step: number; error: string };
type ReplayCritiqueResult =
  | { status: "ready"; report: CoachReport }
  | { status: "error"; error: string };
type ReplayCritiqueCache = Record<number, ReplayCritiqueResult>;
type ReplayScanState =
  | { status: "idle" }
  | { status: "running"; currentStep: number; done: number; total: number }
  | { status: "done"; total: number }
  | { status: "stopped"; done: number; total: number };

function decisionLabel(decision: Decision): string {
  switch (decision.type) {
    case "serve-rights": return decision.take ? "取得發球權" : "讓出發球權";
    case "mulligan": return decision.returnUids.length ? `換牌 ${decision.returnUids.length} 張` : "不換牌";
    case "deploy-serve": return decision.uid === null ? "不登場發球" : "發球登場";
    case "deploy-receive": return decision.uid === null ? "不登場接球" : "接球登場";
    case "deploy-toss": return decision.uid === null ? "不登場托球" : "托球登場";
    case "deploy-attack": return decision.uid === null ? "不登場攻擊" : "攻擊登場";
    case "deploy-block": return decision.uids === null ? "不登場攔網" : `攔網登場 ${decision.uids.length} 張`;
    case "defense-choice": return decision.choice === "block" ? "選擇攔網" : "選擇接球";
    case "free": return decision.action === "pass" ? "Pass" : decision.action === "lost" ? "宣告 Lost" : decision.action === "skill" ? "使用技能" : "打出事件";
    case "resolve-pending": return "選擇待機技能";
    case "effect-confirm": return decision.accept ? "使用效果" : "不使用效果";
    case "effect-cards": return `選卡 ${decision.uids.length} 張`;
    case "effect-option": return "選擇效果選項";
    case "pick-set-card": return "拿取 Set 卡";
  }
}

function actorLabel(entry: ReplayEntry): string {
  return entry.source === "ai" ? "電腦" : entry.player === HUMAN ? "你" : "玩家";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function sameDecision(a: Decision, b: Decision): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function findActualEstimate(report: CoachReport, decision: Decision): CoachActionEstimate | null {
  return report.recommendations.find((item) => sameDecision(item.decision, decision)) ?? null;
}

function critiqueTone(delta: number, actual: CoachActionEstimate | null): { label: string; className: string } {
  if (!actual) return { label: "未覆蓋", className: "is-neutral" };
  if (delta >= 0.15) return { label: "失誤", className: "is-warning" };
  if (delta <= -0.03) return { label: "妙手", className: "is-good" };
  return { label: "可接受", className: "is-neutral" };
}

function gameplanTone(tone: NonNullable<CoachActionEstimate["gameplan"]>["tone"] | undefined): { label: string; className: string } {
  if (tone === "progress") return { label: "主軸推進", className: "is-good" };
  if (tone === "risk") return { label: "主軸風險", className: "is-warning" };
  if (tone === "drift") return { label: "主軸偏離", className: "is-warning" };
  return { label: "主軸持平", className: "is-neutral" };
}

function critiqueToneForEntry(entry: ReplayEntry, result: ReplayCritiqueResult | undefined): { label: string; className: string } | null {
  if (!result) return null;
  if (result.status === "error") return { label: "錯誤", className: "is-neutral" };
  const actual = findActualEstimate(result.report, entry.decision);
  const delta = actual ? result.report.bestAction.winRate - actual.winRate : 0;
  return critiqueTone(delta, actual);
}

function statAverage(stats: ReplayAnalytics["op"][number]): string {
  return stats.count === 0 ? "-" : stats.average.toFixed(1);
}

function winRateBand(rate: number): "low" | "mid" | "good" | "high" {
  if (rate < 0.4) return "low";
  if (rate < 0.55) return "mid";
  if (rate < 0.7) return "good";
  return "high";
}

function critiqueSummary(entries: ReplayEntry[], cache: ReplayCritiqueCache) {
  const summary = {
    totalPlayerSteps: entries.filter((entry) => entry.source === "player").length,
    evaluated: 0,
    mistakes: 0,
    acceptable: 0,
    brilliants: 0,
    uncovered: 0,
    errors: 0,
    actualWinRateTotal: 0,
    bestWinRateTotal: 0,
    bands: { low: 0, mid: 0, good: 0, high: 0 },
    largestSwing: null as null | { step: number; delta: number; label: string },
  };
  for (const entry of entries) {
    if (entry.source !== "player") continue;
    const step = entry.index + 1;
    const result = cache[step];
    if (!result) continue;
    if (result.status === "error") {
      summary.errors++;
      continue;
    }
    summary.evaluated++;
    const actual = findActualEstimate(result.report, entry.decision);
    if (!actual) {
      summary.uncovered++;
      continue;
    }
    const delta = result.report.bestAction.winRate - actual.winRate;
    summary.actualWinRateTotal += actual.winRate;
    summary.bestWinRateTotal += result.report.bestAction.winRate;
    summary.bands[winRateBand(actual.winRate)]++;
    if (delta >= 0.15) summary.mistakes++;
    else if (delta <= -0.03) summary.brilliants++;
    else summary.acceptable++;
    if (!summary.largestSwing || delta > summary.largestSwing.delta) {
      summary.largestSwing = { step, delta, label: decisionLabel(entry.decision) };
    }
  }
  return summary;
}

function LostSetSection(props: { lostSets: LostSetSummary }) {
  const { lostSets } = props;
  if (lostSets.total === 0) {
    return (
      <section className="report-section">
        <b>失 Set 歸因</b>
        <small className="summary-idle">本場沒有失 Set。</small>
      </section>
    );
  }
  const causes = (Object.entries(lostSets.byCause) as [keyof LostSetSummary["byCause"], number][])
    .filter(([, count]) => count > 0);
  return (
    <section className="report-section">
      <b>失 Set 歸因</b>
      <div className="report-stat-grid">
        <span><small>失 Set</small><b>{lostSets.total}</b></span>
        {causes.map(([cause, count]) => (
          <span key={cause}><small>{lostSetCauseLabel(cause)}</small><b>{count}</b></span>
        ))}
      </div>
      <ul className="lostset-list">
        {lostSets.attributions.map((item) => (
          <li key={item.entryIndex}>
            <b>Set {item.setNo}{item.matchPoint ? "（敗北）" : ""}</b>
            <span>{item.detail}</span>
            <small>Step {item.entryIndex + 1}・Turn {item.turnNo}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActionEffectivenessSection(props: { effectiveness: ReplayActionEffectiveness; cardDetails: ActionCardDetail[] }) {
  const lines = [props.effectiveness.event, props.effectiveness.skill];
  if (lines.every((line) => line.uses === 0)) {
    return (
      <section className="report-section">
        <b>事件 / 技能效率</b>
        <small className="summary-idle">本場沒有打出事件或宣告技能。</small>
      </section>
    );
  }
  return (
    <section className="report-section">
      <b>事件 / 技能效率</b>
      <small className="report-note">「有效」＝打出後有抽牌、入手、登場或點數修正等可觀察效果。</small>
      <div className="report-compare">
        {lines.map((line) => (
          <span key={line.kind}>
            <small>{line.kind === "event" ? "事件" : "技能"}</small>
            <b>{line.uses === 0 ? "未使用" : `${line.effectiveUses}/${line.uses}・${percent(line.rate)}`}</b>
            <em>抽{line.draws}・入手{line.handAdds}・登場{line.deploys}・點數{line.pointMods}</em>
          </span>
        ))}
      </div>
      {props.cardDetails.length > 0 && (
        <ul className="action-card-list">
          {props.cardDetails.map((detail) => (
            <li key={`${detail.kind}:${detail.cardName}`} className={detail.effectiveUses < detail.uses ? "is-partial" : ""}>
              <span className="action-card-kind">{detail.kind === "event" ? "事件" : "技能"}</span>
              <b>{detail.cardName}</b>
              <small>{detail.effectiveUses}/{detail.uses} 有效</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NarrativeSection(props: { narrative: string[] }) {
  if (props.narrative.length === 0) return null;
  return (
    <section className="report-section report-narrative">
      <b>檢討重點</b>
      <ul className="narrative-list">
        {props.narrative.map((line, index) => <li key={index}>{line}</li>)}
      </ul>
    </section>
  );
}

function PostMatchReportBody(props: {
  analytics: ReplayAnalytics;
  lostSets: LostSetSummary;
  effectiveness: ReplayActionEffectiveness;
  cardDetails: ActionCardDetail[];
  narrative: string[];
  keyEntries: ReplayEntry[];
  critiqueCache: ReplayCritiqueCache;
  scan: ReplayScanState;
  onScan: () => void;
  onStopScan: () => void;
}) {
  const { analytics, lostSets, effectiveness, keyEntries, critiqueCache, scan } = props;
  const quality = critiqueSummary(keyEntries, critiqueCache);
  const evaluatedWithWinRate = quality.mistakes + quality.acceptable + quality.brilliants;
  const avgActual = evaluatedWithWinRate ? quality.actualWinRateTotal / evaluatedWithWinRate : 0;
  const avgBest = evaluatedWithWinRate ? quality.bestWinRateTotal / evaluatedWithWinRate : 0;
  const bandTotal = Math.max(1, evaluatedWithWinRate);
  const humanOp = analytics.op[HUMAN];
  const aiOp = analytics.op[AI];
  const humanDp = analytics.dp[HUMAN];
  const aiDp = analytics.dp[AI];
  return (
    <div className="postmatch-body">
      <section className="report-hero">
        <span className="replay-pill">Set {analytics.setWins[0]}:{analytics.setWins[1]}</span>
        <b>{analytics.matchWinner === HUMAN ? "這場可以回看哪些選擇拉開勝負。" : "先看資源與決策分布，再回放關鍵步。"}</b>
        <small>{analytics.totalDecisions} 個決策點・玩家 {analytics.playerDecisions}・AI {analytics.aiDecisions}</small>
      </section>

      <NarrativeSection narrative={props.narrative} />

      <section className="report-section">
        <div className="replay-overview-heading">
          <b>勝率分布</b>
          {scan.status === "running" ? (
            <button className="btn-quiet" onClick={props.onStopScan}>停止掃描</button>
          ) : (
            <button className="btn-quiet" disabled={quality.totalPlayerSteps === 0} onClick={props.onScan}>掃描玩家決策</button>
          )}
        </div>
        <div className="report-stat-grid">
          <span><small>已評估</small><b>{quality.evaluated}/{quality.totalPlayerSteps}</b></span>
          <span><small>失誤</small><b>{quality.mistakes}</b></span>
          <span><small>可接受</small><b>{quality.acceptable}</b></span>
          <span><small>妙手</small><b>{quality.brilliants}</b></span>
        </div>
        {scan.status === "running" && <small className="summary-idle">正在評估 Step {scan.currentStep}（{scan.done}/{scan.total}）</small>}
        {scan.status === "done" && <small className="summary-idle">玩家決策掃描完成。</small>}
        {quality.evaluated > 0 ? (
          <>
            <div className="winrate-bars" aria-label="實際選擇勝率分布">
              {([
                ["low", "<40%", quality.bands.low],
                ["mid", "40-55%", quality.bands.mid],
                ["good", "55-70%", quality.bands.good],
                ["high", "70%+", quality.bands.high],
              ] as const).map(([key, label, count]) => (
                <div key={key} className={`winrate-bar is-${key}`}>
                  <span style={{ width: `${Math.max(6, (count / bandTotal) * 100)}%` }} />
                  <b>{label}</b>
                  <small>{count}</small>
                </div>
              ))}
            </div>
            <p className="report-note">
              實際選擇平均勝率 {percent(avgActual)}，Coach 最佳候選平均 {percent(avgBest)}
              {quality.largestSwing && quality.largestSwing.delta > 0
                ? `；最大可回看差距在 Step ${quality.largestSwing.step}（約 ${percent(quality.largestSwing.delta)}）。`
                : "。"}
            </p>
          </>
        ) : (
          <small className="summary-idle">尚未掃描玩家決策；掃描後這裡會出現勝率區間與失誤分布。</small>
        )}
        {quality.uncovered > 0 && <small className="summary-idle">有 {quality.uncovered} 步未被 Coach 候選列舉覆蓋，先不要把它當成錯誤。</small>}
      </section>

      <section className="report-section">
        <b>攻防平均</b>
        <div className="report-compare">
          <span><small>你 平均 OP</small><b>{statAverage(humanOp)}</b><em>最高 {humanOp.max || "-"}</em></span>
          <span><small>AI 平均 OP</small><b>{statAverage(aiOp)}</b><em>最高 {aiOp.max || "-"}</em></span>
          <span><small>你 平均 DP</small><b>{statAverage(humanDp)}</b><em>{humanDp.count} 次</em></span>
          <span><small>AI 平均 DP</small><b>{statAverage(aiDp)}</b><em>{aiDp.count} 次</em></span>
        </div>
      </section>

      <section className="report-section">
        <b>Guts 使用</b>
        <div className="report-compare">
          <span><small>你 總支付</small><b>{analytics.payGuts[HUMAN]}</b><em>每場</em></span>
          <span><small>AI 總支付</small><b>{analytics.payGuts[AI]}</b><em>每場</em></span>
        </div>
        <div className="replay-source-row">
          <span>你：發球 {analytics.payGutsBySource[HUMAN].serve}</span>
          <span>接球 {analytics.payGutsBySource[HUMAN].receive}</span>
          <span>托球 {analytics.payGutsBySource[HUMAN].toss}</span>
          <span>攻擊 {analytics.payGutsBySource[HUMAN].attack}</span>
          <span>攔網 {analytics.payGutsBySource[HUMAN].blockCenter}</span>
        </div>
      </section>

      <LostSetSection lostSets={lostSets} />

      <ActionEffectivenessSection effectiveness={effectiveness} cardDetails={props.cardDetails} />
    </div>
  );
}

function PostMatchReport(props: {
  analytics: ReplayAnalytics;
  lostSets: LostSetSummary;
  effectiveness: ReplayActionEffectiveness;
  cardDetails: ActionCardDetail[];
  narrative: string[];
  keyEntries: ReplayEntry[];
  critiqueCache: ReplayCritiqueCache;
  scan: ReplayScanState;
  onScan: () => void;
  onStopScan: () => void;
  onReplay: () => void;
}) {
  return (
    <div className="postmatch-report">
      <div className="panel-heading">
        <div>
          <b>賽後戰報</b>
          <span>{props.analytics.matchWinner === HUMAN ? "你贏了這場比賽" : props.analytics.matchWinner === AI ? "電腦獲勝" : "比賽結束"}</span>
        </div>
      </div>
      <PostMatchReportBody
        analytics={props.analytics}
        lostSets={props.lostSets}
        effectiveness={props.effectiveness}
        cardDetails={props.cardDetails}
        narrative={props.narrative}
        keyEntries={props.keyEntries}
        critiqueCache={props.critiqueCache}
        scan={props.scan}
        onScan={props.onScan}
        onStopScan={props.onStopScan}
      />
      <div className="report-actions" style={{ padding: "0 var(--sp-4) var(--sp-4)" }}>
        <button data-primary="true" disabled={props.analytics.totalDecisions === 0} onClick={props.onReplay}>逐步覆盤</button>
      </div>
    </div>
  );
}

function PostMatchModal(props: {
  analytics: ReplayAnalytics;
  lostSets: LostSetSummary;
  effectiveness: ReplayActionEffectiveness;
  cardDetails: ActionCardDetail[];
  narrative: string[];
  keyEntries: ReplayEntry[];
  critiqueCache: ReplayCritiqueCache;
  scan: ReplayScanState;
  winner: PlayerId | null;
  replayMode: boolean;
  onScan: () => void;
  onStopScan: () => void;
  onReplay: () => void;
  onClose: () => void;
}) {
  const won = props.winner === HUMAN;
  return (
    <div className="postmatch-modal-overlay" role="dialog" aria-modal="true" aria-label="賽後戰報">
      <div className="postmatch-modal">
        <div className="postmatch-modal-header">
          <div className="postmatch-modal-result">
            <span className={`postmatch-result-badge ${won ? "is-win" : "is-lose"}`}>
              {won ? "MATCH WIN" : "MATCH LOST"}
            </span>
            <b className="postmatch-modal-title">賽後戰報</b>
            <span className="postmatch-modal-sub">
              {props.analytics.matchWinner === HUMAN ? "你贏了這場比賽" : props.analytics.matchWinner === AI ? "電腦獲勝" : "比賽結束"}
            </span>
          </div>
        </div>
        <div className="postmatch-modal-body">
          <PostMatchReportBody
            analytics={props.analytics}
            lostSets={props.lostSets}
            effectiveness={props.effectiveness}
            cardDetails={props.cardDetails}
            narrative={props.narrative}
            keyEntries={props.keyEntries}
            critiqueCache={props.critiqueCache}
            scan={props.scan}
            onScan={props.onScan}
            onStopScan={props.onStopScan}
          />
        </div>
        <div className="postmatch-modal-footer">
          {props.replayMode ? (
            <button data-primary="true" onClick={props.onClose}>返回覆盤</button>
          ) : (
            <>
              <button className="btn-secondary" onClick={props.onClose}>先看看</button>
              <button data-primary="true" disabled={props.analytics.totalDecisions === 0} onClick={props.onReplay}>逐步覆盤</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReplayStepSummary(props: {
  state: GameState;
  entry: ReplayEntry | null;
  step: number;
  total: number;
  analytics: ReplayAnalytics;
  keyEntries: ReplayEntry[];
  critique: ReplayCritiqueState;
  critiqueCache: ReplayCritiqueCache;
  scan: ReplayScanState;
  onEvaluate: () => void;
  onScan: () => void;
  onStopScan: () => void;
  onJump: (step: number) => void;
}) {
  const { state, entry, step, total, analytics, keyEntries, critique, critiqueCache, scan } = props;
  const newLogs = entry ? entry.after.log.slice(entry.logStart, entry.logEnd) : [];
  const report = critique.status === "ready" && critique.step === step ? critique.report : null;
  const error = critique.status === "error" && critique.step === step ? critique.error : null;
  const loading = critique.status === "loading" && critique.step === step;
  const actual = report && entry ? findActualEstimate(report, entry.decision) : null;
  const delta = report && actual ? report.bestAction.winRate - actual.winRate : 0;
  const tone = report ? critiqueTone(delta, actual) : null;
  const actualGameplan = actual?.gameplan;
  const gameplan = gameplanTone(actualGameplan?.tone);
  const mixedSignal = !!actualGameplan && actualGameplan.tone === "progress" && delta >= 0.15;
  return (
    <div className="replay-panel">
      <div className="panel-heading">
        <div>
          <b>賽後覆盤</b>
          <span>Step {step} / {total}</span>
        </div>
      </div>
      <div className="replay-body">
        {entry ? (
          <div className="replay-card">
            <span className="replay-pill">{actorLabel(entry)}</span>
            <b>{decisionLabel(entry.decision)}</b>
            <small>{PHASE_NAME[entry.phase]}・Set {entry.setNo}・Turn {entry.turnNo}</small>
          </div>
        ) : (
          <div className="replay-card">
            <span className="replay-pill">開局</span>
            <b>對局初始狀態</b>
            <small>{PHASE_NAME[state.phase]}・Set {state.setNo}・Turn {state.turnNo}</small>
          </div>
        )}
        <div className="replay-overview">
          <div className="replay-overview-heading">
            <b>全場索引</b>
            {scan.status === "running" ? (
              <button className="btn-quiet" onClick={props.onStopScan}>停止掃描</button>
            ) : (
              <button className="btn-quiet" disabled={keyEntries.every((item) => item.source !== "player")} onClick={props.onScan}>掃描玩家決策</button>
            )}
          </div>
          <div className="replay-stat-grid">
            <span><small>玩家決策</small><b>{analytics.playerDecisions}</b></span>
            <span><small>AI 決策</small><b>{analytics.aiDecisions}</b></span>
            <span><small>Set</small><b>{analytics.setWins[0]}:{analytics.setWins[1]}</b></span>
            <span><small>Guts</small><b>{analytics.payGuts[0]}:{analytics.payGuts[1]}</b></span>
          </div>
          <div className="replay-source-row" aria-label="OP 來源">
            <span>發球 {analytics.opSources.serve}</span>
            <span>攔網 {analytics.opSources.block}</span>
            <span>攻擊 {analytics.opSources.attack}</span>
          </div>
          {scan.status === "running" && (
            <small className="summary-idle">正在評估 Step {scan.currentStep}（{scan.done}/{scan.total}）</small>
          )}
          {scan.status === "done" && <small className="summary-idle">已完成 {scan.total} 個玩家決策掃描。</small>}
          {scan.status === "stopped" && <small className="summary-idle">已停止掃描（{scan.done}/{scan.total}）。</small>}
          <div className="replay-step-list">
            {keyEntries.length === 0 ? (
              <small className="summary-idle">目前沒有關鍵步驟。</small>
            ) : keyEntries.map((item) => {
              const itemStep = item.index + 1;
              const cachedTone = critiqueToneForEntry(item, critiqueCache[itemStep]);
              const scanning = scan.status === "running" && scan.currentStep === itemStep;
              return (
                <button
                  key={item.index}
                  className={`replay-step-button${itemStep === step ? " is-active" : ""}`}
                  onClick={() => props.onJump(itemStep)}
                >
                  <span>#{itemStep}</span>
                  <b>{actorLabel(item)}・{decisionLabel(item.decision)}</b>
                  <small>{PHASE_NAME[item.phase]}・Set {item.setNo} Turn {item.turnNo}</small>
                  {(cachedTone || scanning) && (
                    <em className={`replay-step-badge ${cachedTone?.className ?? "is-neutral"}`}>
                      {scanning ? "評估中" : cachedTone?.label}
                    </em>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <MatchSummary state={state} replayEntries={total} />
        <div className="replay-logs">
          <b>此步新增紀錄</b>
          {newLogs.length === 0 ? (
            <small className="summary-idle">這一步沒有新增 log。</small>
          ) : (
            <ul>
              {newLogs.slice(-6).map((log, index) => (
                <li key={`${log.setNo}-${log.turnNo}-${index}`}>{log.text}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="replay-critique">
          <div className="replay-critique-heading">
            <b>出牌檢討</b>
            <button className="btn-quiet" disabled={!entry || loading} onClick={props.onEvaluate}>
              {loading ? "評估中" : "評估此步"}
            </button>
          </div>
          {!entry ? (
            <small className="summary-idle">開局狀態沒有實際決策可評估。</small>
          ) : error ? (
            <p className="coach-error">{error}</p>
          ) : report ? (
            <div className="critique-result">
              <span className={`critique-badge ${tone?.className ?? ""}`}>{tone?.label}</span>
              {actualGameplan && <span className={`critique-badge ${gameplan.className}`}>{gameplan.label}</span>}
              <div className="critique-row">
                <small>最佳建議</small>
                <b>{report.bestAction.label}</b>
                <span>{percent(report.bestAction.winRate)} 勝率・信心 {percent(report.bestAction.confidence)}</span>
                {report.bestAction.gameplan && <span>主軸：{report.bestAction.gameplan.stage}・{report.bestAction.gameplan.progressScore} 分・Δ {report.bestAction.gameplan.delta >= 0 ? "+" : ""}{report.bestAction.gameplan.delta}</span>}
              </div>
              <div className="critique-row">
                <small>實際選擇</small>
                <b>{actual?.label ?? decisionLabel(entry.decision)}</b>
                <span>{actual ? `${percent(actual.winRate)} 勝率・差距 ${percent(Math.max(0, delta))}` : "此決策不在本次候選評估內"}</span>
                {actualGameplan && <span>主軸：{actualGameplan.stage}・{actualGameplan.progressScore} 分・Δ {actualGameplan.delta >= 0 ? "+" : ""}{actualGameplan.delta}</span>}
              </div>
              {actualGameplan && (actualGameplan.badges.length > 0 || actualGameplan.risks.length > 0) && (
                <p>{[...actualGameplan.badges.slice(0, 2), ...actualGameplan.risks.slice(0, 2)].join("；")}</p>
              )}
              <p>{actual ? (mixedSignal ? "這一步短期勝率較低，但有推進牌組主軸；先不要直接判成單純失誤，值得回看它是否是在啟動引擎。" : delta >= 0.15 ? "這一步可能有更高期望值的選擇，值得回看當時資源與後續防守壓力。" : "這一步和 Coach 推薦差距不大，可先視為合理路線。") : "Coach v1 的候選列舉沒有覆蓋這個實際決策；後續需擴充候選生成再評分。"}</p>
            </div>
          ) : (
            <small className="summary-idle">按下評估後，會用 Coach / PIMC 從此步決策前狀態估算推薦選擇。</small>
          )}
        </div>
      </div>
    </div>
  );
}

export function Game(props: {
  db: CardDb;
  decks: [string[], string[]];
  deckMeta: [DeckMeta, DeckMeta];
  loadedReplay?: ReplaySession;
  onExit: () => void;
}) {
  const { db } = props;
  const aiProfile = useMemo(
    () => heuristicProfileForDeckText(`${props.deckMeta[AI].school} ${props.deckMeta[AI].name}`),
    [props.deckMeta],
  );
  const initialGameRef = useRef<GameRuntime | null>(null);
  if (!initialGameRef.current) {
    if (props.loadedReplay) {
      initialGameRef.current = {
        state: stateAtReplayStep(props.loadedReplay, props.loadedReplay.entries.length),
        replay: props.loadedReplay,
      };
    } else {
      const seed = (Date.now() % 0xffffffff) >>> 0;
      const initialState = createGame(db, { seed, decks: props.decks });
      initialGameRef.current = {
        state: initialState,
        replay: createReplaySession(initialState, props.decks, props.deckMeta, undefined, seed),
      };
    }
  }
  const [game, setGame] = useState<GameRuntime>(() => initialGameRef.current!);
  const state = game.state;
  const replay = game.replay;
  const [hovered, setHovered] = useState<InspectedCard | null>(null);
  const [inspected, setInspected] = useState<InspectedCard | null>(null);
  const [multiSel, setMultiSel] = useState<number[]>([]);
  const [nameAsk, setNameAsk] = useState<{ uid: number; names: string[] } | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>({ type: "detail" });
  const [coach, setCoach] = useState<CoachPanelState>({ status: "idle" });
  const [mobilePanel, setMobilePanel] = useState<"log" | "detail" | null>(null);
  const [activeGutsKey, setActiveGutsKey] = useState<string | null>(null);
  const [speed, setSpeed] = useState<AiSpeed>(initialSpeed);
  const [scoreBanner, setScoreBanner] = useState<SplashBanner | null>(null);
  const [sfxEnabled, setSfxEnabled] = useState<boolean>(initialSfx);
  const [sfx, setSfx] = useState<{ text: string; key: number } | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [undoHistory, setUndoHistory] = useState<UndoHistory>([]);
  const [undoReplayLengths, setUndoReplayLengths] = useState<number[]>([]);
  const [replayMode, setReplayMode] = useState(!!props.loadedReplay);
  const [replayStep, setReplayStep] = useState(props.loadedReplay ? props.loadedReplay.entries.length : 0);
  const decisionRef = useRef<HTMLDivElement>(null);
  const handRef = useRef<HTMLDivElement>(null);
  const coachRequestRef = useRef(0);
  const coachWorkerRef = useRef<Worker | null>(null);
  // [Claude 2026-06-22] Phase F 塊2：強敵 PIMC 思考用的 worker / 請求序號 / 思考提示狀態。
  const aiRequestRef = useRef(0);
  const aiWorkerRef = useRef<Worker | null>(null);
  const [aiThinking, setAiThinking] = useState<{ budgetMs: number } | null>(null);
  const replayCoachRequestRef = useRef(0);
  const replayScanTokenRef = useRef(0);
  const replayCoachWorkerRef = useRef<Worker | null>(null);
  const replayCoachRejectRef = useRef<((error: Error) => void) | null>(null);
  const savedReplayRef = useRef(false);
  const replayCritiquesRef = useRef<ReplayCritiqueCache>({});
  const [handWidth, setHandWidth] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const [replayCritique, setReplayCritique] = useState<ReplayCritiqueState>({ status: "idle" });
  const [replayCritiques, setReplayCritiques] = useState<ReplayCritiqueCache>({});
  const [replayScan, setReplayScan] = useState<ReplayScanState>({ status: "idle" });
  const [showPostMatchModal, setShowPostMatchModal] = useState(false);
  const seenLogCount = useRef(state.log.length);

  const pd = state.pendingDecision;
  const viewState = replayMode ? stateAtReplayStep(replay, replayStep) : state;
  const replayEntry = replayStep > 0 ? replay.entries[replayStep - 1] ?? null : null;
  const replayAnalytics = useMemo(() => summarizeReplaySession(replay), [replay]);
  const replayReview = useMemo(() => createReplayReviewReport(db, replay, { player: HUMAN }), [db, replay]);
  const replayKeyEntries = useMemo(() => keyReplayEntries(replay), [replay]);
  const isMyDecision = pd?.player === HUMAN && state.phase !== "gameOver";
  const deployArea = pd && pd.type in DEPLOY_AREA ? DEPLOY_AREA[pd.type]! : null;
  const deployable = isMyDecision && deployArea ? deployableUids(db, state, HUMAN, deployArea) : [];
  const free = isMyDecision && pd?.type === "free" ? freeOptions(db, state) : { skills: [], events: [] };
  // effect-cards：候選若都在可見的手牌/場上 → 就地選取（不另開卡列）
  const effectCards = pd && pd.type === "effect-cards" ? pd : null;
  const effectCandidates = effectCards?.candidates ?? [];
  const effectMax = effectCards?.max ?? 1;
  const effectCardsInPlace = isMyDecision && !!effectCards
    && canUseInPlaceEffectSelection(state, HUMAN, effectCandidates);
  const { motions, recentUids, settledUids } = useGameMotion({ state: viewState, db, deckMeta: props.deckMeta, disabled: speed === "instant" || replayMode });

  const visibleInspection = hovered ?? inspected;
  const canUndo = !replayMode && undoHistory.length > 0;

  function cardOf(uid: number): Card {
    return db.get(viewState.cards[uid]!)!;
  }

  function setHoverUid(uid: number | null) {
    setHovered(uid === null ? null : { cardId: viewState.cards[uid]!, uid });
  }

  function inspectUid(uid: number) {
    setInspected({ cardId: viewState.cards[uid]!, uid });
    setToolMode({ type: "detail" });
    setMobilePanel("detail");
  }

  function clearTransientUi() {
    setMultiSel([]);
    setNameAsk(null);
    setActiveGutsKey(null);
    setDragging(null);
    setScoreBanner(null);
    setSfx(null);
  }

  function decide(decision: Decision) {
    clearTransientUi();
    setUndoHistory((history) => pushPlayerUndoSnapshot(history, state, HUMAN));
    setUndoReplayLengths((lengths) => {
      const next = [...lengths, replay.entries.length];
      return next.length > UNDO_HISTORY_LIMIT ? next.slice(next.length - UNDO_HISTORY_LIMIT) : next;
    });
    setGame((current) => {
      const nextState = applyDecision(db, current.state, decision);
      return {
        state: nextState,
        replay: appendReplayEntry(current.replay, current.state, decision, nextState, "player"),
      };
    });
  }

  function undoLastDecision() {
    const popped = popUndoSnapshot(undoHistory);
    if (!popped.snapshot) return;
    const replayLength = undoReplayLengths[undoReplayLengths.length - 1] ?? replay.entries.length;
    clearTransientUi();
    seenLogCount.current = popped.snapshot.log.length;
    setUndoHistory(popped.stack);
    setUndoReplayLengths((lengths) => lengths.slice(0, -1));
    setGame((current) => ({
      state: popped.snapshot!,
      replay: truncateReplaySession(current.replay, replayLength),
    }));
  }

  function enterReplayMode() {
    clearTransientUi();
    setToolMode({ type: "detail" });
    setMobilePanel(null);
    setShowPostMatchModal(false);
    setReplayStep(replay.entries.length);
    setReplayMode(true);
  }

  function exitReplayMode() {
    clearTransientUi();
    setReplayMode(false);
    setReplayStep(0);
    setReplayCritique({ status: "idle" });
    setReplayScan({ status: "idle" });
    replayScanTokenRef.current++;
    replayCoachRejectRef.current?.(new Error("__cancelled__"));
    replayCoachRejectRef.current = null;
    replayCoachWorkerRef.current?.terminate();
    replayCoachWorkerRef.current = null;
  }

  function storeReplayCritique(step: number, result: ReplayCritiqueResult) {
    replayCritiquesRef.current = { ...replayCritiquesRef.current, [step]: result };
    setReplayCritiques(replayCritiquesRef.current);
  }

  function requestReplayCoach(entry: ReplayEntry, step: number, token: number): Promise<CoachReport> {
    const requestId = String(++replayCoachRequestRef.current);
    replayCoachRejectRef.current?.(new Error("__cancelled__"));
    replayCoachRejectRef.current = null;
    replayCoachWorkerRef.current?.terminate();
    replayCoachWorkerRef.current = null;
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("../ai/coach-worker.ts", import.meta.url), { type: "module" });
      replayCoachWorkerRef.current = worker;
      replayCoachRejectRef.current = reject;
      worker.onmessage = (event: MessageEvent<CoachWorkerResponse>) => {
        if (event.data.requestId !== requestId || replayCoachRequestRef.current !== Number(requestId)) return;
        worker.terminate();
        if (replayCoachWorkerRef.current === worker) replayCoachWorkerRef.current = null;
        if (replayCoachRejectRef.current === reject) replayCoachRejectRef.current = null;
        if (replayScanTokenRef.current !== token) {
          reject(new Error("__cancelled__"));
          return;
        }
        if (event.data.ok) resolve(event.data.report);
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event) => {
        if (replayCoachRequestRef.current !== Number(requestId)) return;
        worker.terminate();
        if (replayCoachWorkerRef.current === worker) replayCoachWorkerRef.current = null;
        if (replayCoachRejectRef.current === reject) replayCoachRejectRef.current = null;
        if (replayScanTokenRef.current !== token) {
          reject(new Error("__cancelled__"));
          return;
        }
        reject(new Error(event.message || "Replay Coach worker 發生錯誤"));
      };
      worker.postMessage({
        requestId,
        state: entry.before,
        options: {
          perspectivePlayer: entry.player,
          knownDecks: props.decks,
          gameplanDeckLabels: [replay.decks[0].label, replay.decks[1].label],
          seed: entry.before.rngState + step * 97,
          sampleCount: 4,
          candidateLimit: 6,
          rolloutMaxSteps: 1200,
          timeLimitMs: 1400,
        },
      });
    });
  }

  async function evaluateReplayStep() {
    if (!replayMode || !replayEntry) return;
    const step = replayStep;
    const token = ++replayScanTokenRef.current;
    setReplayScan({ status: "idle" });
    setReplayCritique({ status: "loading", step });
    try {
      const report = await requestReplayCoach(replayEntry, step, token);
      storeReplayCritique(step, { status: "ready", report });
      setReplayCritique({ status: "ready", step, report });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "__cancelled__") return;
      storeReplayCritique(step, { status: "error", error: message });
      setReplayCritique({ status: "error", step, error: message });
    }
  }

  async function scanReplayDecisions() {
    if (!replayMode && state.phase !== "gameOver") return;
    const targets = replayKeyEntries
      .filter((entry) => entry.source === "player")
      .filter((entry) => replayCritiquesRef.current[entry.index + 1]?.status !== "ready");
    const total = targets.length;
    if (total === 0) {
      setReplayScan({ status: "done", total: 0 });
      return;
    }
    const token = ++replayScanTokenRef.current;
    let done = 0;
    for (const entry of targets) {
      if (replayScanTokenRef.current !== token) {
        setReplayScan({ status: "stopped", done, total });
        return;
      }
      const step = entry.index + 1;
      setReplayScan({ status: "running", currentStep: step, done, total });
      setReplayCritique({ status: "loading", step });
      try {
        const report = await requestReplayCoach(entry, step, token);
        storeReplayCritique(step, { status: "ready", report });
        if (replayStep === step) setReplayCritique({ status: "ready", step, report });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "__cancelled__") {
          setReplayScan({ status: "stopped", done, total });
          return;
        }
        storeReplayCritique(step, { status: "error", error: message });
        if (replayStep === step) setReplayCritique({ status: "error", step, error: message });
      }
      done++;
    }
    if (replayScanTokenRef.current === token) setReplayScan({ status: "done", total });
  }

  function stopReplayScan() {
    replayScanTokenRef.current++;
    replayCoachRejectRef.current?.(new Error("__cancelled__"));
    replayCoachRejectRef.current = null;
    replayCoachWorkerRef.current?.terminate();
    replayCoachWorkerRef.current = null;
    setReplayScan((scan) => scan.status === "running" ? { status: "stopped", done: scan.done, total: scan.total } : scan);
  }

  function changeSpeed(next: AiSpeed) {
    setSpeed(next);
    localStorage.setItem("breaktcg-ai-speed", next);
  }

  function toggleSfx() {
    setSfxEnabled((on) => {
      const next = !on;
      localStorage.setItem("breaktcg-sfx", next ? "on" : "off");
      return next;
    });
  }

  // [Claude 2026-06-22] Phase F 塊2：把 PIMC 接成電腦對手的「腦」。
  // 預設＝強敵：用 coach-worker 跑 PIMC 搜尋（隱藏資訊抽樣，不偷看），思考預算由 estimateThinkBudgetMs
  // 依盤面自適應 3–10 秒；瑣碎盤面想得短、決勝高壓盤面想滿。worker 失敗時退回 heuristic 不卡關。
  // speed === "instant" 保留為快速測試模式：直接走 heuristic、不啟動 PIMC、不顯思考提示。
  useEffect(() => {
    aiWorkerRef.current?.terminate();
    aiWorkerRef.current = null;
    if (replayMode || pd?.player !== AI || state.phase === "gameOver") {
      setAiThinking(null);
      return;
    }

    function applyAiDecision(decision: Decision) {
      setAiThinking(null);
      setGame((current) => {
        if (current.state.pendingDecision?.player !== AI || current.state.phase === "gameOver") return current;
        const nextState = applyDecision(db, current.state, decision);
        return {
          state: nextState,
          replay: appendReplayEntry(current.replay, current.state, decision, nextState, "ai"),
        };
      });
    }

    if (speed === "instant") {
      setAiThinking(null);
      const timer = window.setTimeout(() => applyAiDecision(heuristicAiDecision(db, state, aiProfile)), 0);
      return () => window.clearTimeout(timer);
    }

    const requestId = String(++aiRequestRef.current);
    const budgetMs = estimateThinkBudgetMs(state);
    // 0.5x/1x/2x 速度＝思考預算的乘除旋鈕（仍夾在 3–10 秒之間），讓速度設定對強敵有實際意義。
    const speedFactor = Number(speed) || 1;
    const timeLimitMs = Math.round(budgetMs / speedFactor);
    const timer = window.setTimeout(() => {
      setAiThinking({ budgetMs: timeLimitMs });
      const worker = new Worker(new URL("../ai/coach-worker.ts", import.meta.url), { type: "module" });
      aiWorkerRef.current = worker;
      worker.onmessage = (event: MessageEvent<CoachWorkerResponse>) => {
        if (event.data.requestId !== requestId || aiRequestRef.current !== Number(requestId)) return;
        worker.terminate();
        if (aiWorkerRef.current === worker) aiWorkerRef.current = null;
        if (event.data.ok) applyAiDecision(event.data.report.bestAction.decision);
        else applyAiDecision(heuristicAiDecision(db, state, aiProfile));
      };
      worker.onerror = () => {
        if (aiRequestRef.current !== Number(requestId)) return;
        worker.terminate();
        if (aiWorkerRef.current === worker) aiWorkerRef.current = null;
        applyAiDecision(heuristicAiDecision(db, state, aiProfile));
      };
      worker.postMessage({
        requestId,
        state,
        options: {
          perspectivePlayer: AI,
          knownDecks: props.decks,
          gameplanDeckLabels: [`${props.deckMeta[0].school}-${props.deckMeta[0].name}`, `${props.deckMeta[1].school}-${props.deckMeta[1].name}`],
          seed: state.rngState,
          sampleCount: 32,
          candidateLimit: 8,
          rolloutMaxSteps: 1400,
          timeLimitMs,
          rolloutPolicy: aiProfile,
          // [Claude 2026-06-22] S1 終局 EV cut（A/B 同預算 68.8%、CI 61.2%-75.4% 顯著贏現況，且 rollout ~3x 快
          // → 同時間預算內想更多手）。horizon 30 為驗證值。
          valueCutHorizon: 30,
        },
      });
    }, 180);

    return () => {
      window.clearTimeout(timer);
      aiWorkerRef.current?.terminate();
      aiWorkerRef.current = null;
    };
  }, [aiProfile, db, pd, props.decks, props.deckMeta, replayMode, speed, state]);

  useEffect(() => {
    coachWorkerRef.current?.terminate();
    coachWorkerRef.current = null;
    const requestId = String(++coachRequestRef.current);

    if (replayMode || !isMyDecision || !pd) {
      setCoach({ status: "idle" });
      return;
    }

    let fallback: Decision | null = null;
    try {
      fallback = heuristicAiDecision(db, state);
      setCoach({ status: "loading", fallback });
    } catch (error) {
      setCoach({ status: "error", fallback: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const timer = window.setTimeout(() => {
      const worker = new Worker(new URL("../ai/coach-worker.ts", import.meta.url), { type: "module" });
      coachWorkerRef.current = worker;
      worker.onmessage = (event: MessageEvent<CoachWorkerResponse>) => {
        if (event.data.requestId !== requestId || coachRequestRef.current !== Number(requestId)) return;
        if (event.data.ok) setCoach({ status: "ready", report: event.data.report });
        else setCoach({ status: "error", fallback, error: event.data.error });
        worker.terminate();
        if (coachWorkerRef.current === worker) coachWorkerRef.current = null;
      };
      worker.onerror = (event) => {
        if (coachRequestRef.current !== Number(requestId)) return;
        setCoach({ status: "error", fallback, error: event.message || "Coach worker 發生錯誤" });
        worker.terminate();
        if (coachWorkerRef.current === worker) coachWorkerRef.current = null;
      };
      worker.postMessage({
        requestId,
        state,
        options: {
          perspectivePlayer: HUMAN,
          knownDecks: props.decks,
          gameplanDeckLabels: [`${props.deckMeta[0].school}-${props.deckMeta[0].name}`, `${props.deckMeta[1].school}-${props.deckMeta[1].name}`],
          seed: state.rngState,
          sampleCount: 4,
          candidateLimit: 6,
          rolloutMaxSteps: 1400,
          timeLimitMs: 1200,
        },
      });
    }, 180);

    return () => {
      window.clearTimeout(timer);
      coachWorkerRef.current?.terminate();
      coachWorkerRef.current = null;
    };
  }, [db, isMyDecision, pd, props.decks, replayMode, state]);

  useEffect(() => {
    const cached = replayCritiquesRef.current[replayStep];
    if (cached?.status === "ready") setReplayCritique({ status: "ready", step: replayStep, report: cached.report });
    else if (cached?.status === "error") setReplayCritique({ status: "error", step: replayStep, error: cached.error });
    else if (replayScan.status !== "running" || replayScan.currentStep !== replayStep) setReplayCritique({ status: "idle" });
  }, [replayStep]);

  useEffect(() => () => {
    replayCoachRejectRef.current?.(new Error("__cancelled__"));
    replayCoachWorkerRef.current?.terminate();
    aiWorkerRef.current?.terminate();
    coachWorkerRef.current?.terminate();
  }, []);

  // 遊戲結束時自動重置 toolMode 並彈出戰報 Modal，並自動儲存對戰紀錄
  useEffect(() => {
    if (state.phase !== "gameOver") return;
    setToolMode({ type: "detail" });
    setShowPostMatchModal(true);

    if (!props.loadedReplay && !savedReplayRef.current) {
      savedReplayRef.current = true;
      fetch("/api/replays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(replay),
      })
        .then((res) => {
          if (!res.ok) throw new Error("儲存對戰失敗");
          return res.json();
        })
        .then((data) => {
          console.log("對戰紀錄已儲存:", data.file);
        })
        .catch((err) => {
          console.error("自動儲存對戰紀錄錯誤:", err);
        });
    }
  }, [state.phase, replay, props.loadedReplay]);

  useEffect(() => {
    const newEntries = state.log.slice(seenLogCount.current);
    seenLogCount.current = state.log.length;
    const events = newEntries.map((entry) => entry.event).filter((event) => event !== undefined);
    const result = [...events].reverse().find((event) => event.kind === "set-won" || event.kind === "match-won");
    const attack = [...events].reverse().find((event) => event.kind === "attack-op");

    if (!result && !attack) return;

    if (result) {
      const youWon = result.winner === HUMAN;
      setScoreBanner({
        kind: result.kind === "match-won" ? "match" : "set",
        text: result.kind === "match-won"
          ? youWon ? "MATCH WIN!" : "MATCH LOST"
          : youWon ? "SET GET!" : "SET LOST",
      });
      if (sfxEnabled && speed !== "instant") {
        const pool = youWon ? SFX_SCORE_YOU : SFX_SCORE_OPP;
        setSfx({ text: pool[Math.floor(Math.random() * pool.length)]!, key: Date.now() });
      }
    } else if (attack && sfxEnabled && speed !== "instant") {
      const pool = attack.player === HUMAN ? SFX_ATTACK_YOU : SFX_ATTACK_OPP;
      setSfx({ text: pool[Math.floor(Math.random() * pool.length)]!, key: Date.now() });
    }

    const timer = window.setTimeout(() => {
      setScoreBanner(null);
      setSfx(null);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [state.log, sfxEnabled, speed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, button");
      if (event.key === "Escape") {
        setMultiSel([]);
        setNameAsk(null);
        setActiveGutsKey(null);
        setDragging(null);
        setMobilePanel(null);
        if (toolMode.type === "drop") setToolMode({ type: "detail" });
        return;
      }
      if (event.code !== "Space" || typing || !isMyDecision) return;
      const primary = decisionRef.current?.querySelector<HTMLButtonElement>('button[data-primary="true"]:not(:disabled)');
      if (!primary) return;
      event.preventDefault();
      primary.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMyDecision, toolMode.type]);

  useLayoutEffect(() => {
    const el = handRef.current;
    if (!el) return;
    const update = () => setHandWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 固定設計畫布 1600×900，等比縮放置中（封頂 1.0：夠大的瀏覽器尺寸與間距一律相同）
  useLayoutEffect(() => {
    const update = () => setFitScale(Math.min(1, window.innerWidth / 1600, window.innerHeight / 1040));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  function toggleSelection(uid: number, max: number) {
    setMultiSel((selected) => selected.includes(uid)
      ? selected.filter((item) => item !== uid)
      : selected.length < max ? [...selected, uid] : selected);
  }

  function dropAreaAt(clientX: number, clientY: number): CourtArea | null {
    const el = document.elementFromPoint(clientX, clientY);
    const area = el instanceof HTMLElement ? el.closest<HTMLElement>("[data-drop-area]")?.dataset.dropArea : undefined;
    return area === "serve" || area === "block" || area === "receive" || area === "toss" || area === "attack" ? area : null;
  }

  function dragStateFrom(info: CardPointerDragInfo, uid: number): DragState {
    const overArea = dropAreaAt(info.clientX, info.clientY);
    const valid = !!overArea && overArea === deployArea && deployable.includes(uid);
    return { uid, x: info.clientX, y: info.clientY, width: info.rect.width, overArea, valid };
  }

  function startHandDrag(uid: number, info: CardPointerDragInfo) {
    if (!deployArea || !deployable.includes(uid)) return;
    setDragging(dragStateFrom(info, uid));
  }

  function moveHandDrag(uid: number, info: CardPointerDragInfo) {
    setDragging((current) => current?.uid === uid ? dragStateFrom(info, uid) : current);
  }

  function finishHandDrag(uid: number, info: CardPointerDragInfo) {
    const next = dragStateFrom(info, uid);
    setDragging(null);
    if (next.valid && next.overArea) onDropCard(uid, next.overArea);
  }

  function onHandClick(uid: number) {
    if (replayMode || !isMyDecision || !pd) {
      inspectUid(uid);
      return;
    }
    if (pd.type === "mulligan") {
      setMultiSel((selected) => selected.includes(uid) ? selected.filter((item) => item !== uid) : [...selected, uid]);
      return;
    }
    if (pd.type === "deploy-block") {
      if (!deployable.includes(uid)) return;
      toggleSelection(uid, 3);
      return;
    }
    if (pd.type === "effect-cards") {
      if (!effectCardsInPlace || !effectCandidates.includes(uid)) { inspectUid(uid); return; }
      toggleSelection(uid, effectMax);
      return;
    }
    if (!deployArea || !deployable.includes(uid)) {
      inspectUid(uid);
      return;
    }
    const names = deployNames(db, state, uid);
    if (names) setNameAsk({ uid, names });
    else decide({ type: pd.type, uid } as Decision);
  }

  function confirmBlockDeploy() {
    const choices: Record<number, string> = {};
    const used = new Set<string>();
    for (const uid of multiSel) {
      const names = deployNames(db, state, uid);
      const name = names
        ? names.find((candidate) => !used.has(candidate) && canDeployTo(db, state, HUMAN, uid, "block", candidate)) ?? names[0]!
        : cardOf(uid).nameJa;
      if (names) choices[uid] = name;
      used.add(name);
    }
    decide({ type: "deploy-block", uids: multiSel, center: multiSel[0]!, nameChoices: choices });
  }

  function onDropCard(uid: number, area: CourtArea) {
    if (area !== deployArea || !deployable.includes(uid)) return;
    onHandClick(uid);
  }

  function bar(hint: string, buttons: React.ReactNode) {
    return <div className="decision-bar"><span className="decision-hint">{hint}</span><div className="decision-actions">{buttons}</div></div>;
  }

  function DecisionBar() {
    if (replayMode) {
      return bar(`賽後覆盤 ${replayStep}/${replay.entries.length}${replayEntry ? `・${actorLabel(replayEntry)}：${decisionLabel(replayEntry.decision)}` : "・開局"}`, <>
        <button disabled={replayStep <= 0} onClick={() => setReplayStep((step) => Math.max(0, step - 1))}>上一步</button>
        <button data-primary="true" disabled={replayStep >= replay.entries.length} onClick={() => setReplayStep((step) => Math.min(replay.entries.length, step + 1))}>下一步</button>
        <button className="btn-secondary" onClick={() => setShowPostMatchModal(true)}>查看戰報</button>
        {props.loadedReplay ? (
          <button className="btn-secondary" onClick={props.onExit}>回主選單</button>
        ) : (
          <button className="btn-secondary" onClick={exitReplayMode}>回到結算</button>
        )}
      </>);
    }
    if (state.phase === "gameOver") {
      return bar(state.winner === HUMAN ? "你贏得了這場對戰" : "電腦贏得了這場對戰", <>
        <button data-primary="true" onClick={() => setShowPostMatchModal(true)}>進入賽後覆盤</button>
        <button className="btn-secondary" onClick={props.onExit}>回主選單</button>
      </>);
    }
    if (!pd) return <div className="decision-bar decision-idle"><span>規則引擎正在推進對局</span></div>;
    if (!isMyDecision) {
      const thinkingLabel = aiThinking
        ? `強敵推演中…（最多想 ${(aiThinking.budgetMs / 1000).toFixed(1)} 秒）`
        : "電腦思考中";
      return (
        <div className={`decision-bar decision-idle${aiThinking ? " decision-thinking" : ""}`}>
          <span>{aiThinking && <span className="thinking-dots" aria-hidden="true" />}{thinkingLabel}</span>
          <small>{PHASE_NAME[state.phase]}</small>
        </div>
      );
    }

    switch (pd.type) {
      case "serve-rights":
        return bar("你被選中：要擁有首次發球權嗎？", <>
          <button data-primary="true" onClick={() => decide({ type: "serve-rights", take: true })}>擁有發球權</button>
          <button className="btn-secondary" onClick={() => decide({ type: "serve-rights", take: false })}>讓給對方</button>
        </>);
      case "mulligan":
        return bar(`換牌：點選要放回牌組的卡（已選 ${multiSel.length} 張）`, (
          <button data-primary="true" onClick={() => decide({ type: "mulligan", returnUids: multiSel })}>{multiSel.length ? `換 ${multiSel.length} 張` : "不換牌"}</button>
        ));
      case "defense-choice": {
        const blockAllowed = canChooseBlock(state);
        return bar(`對方 OP ${state.op?.value ?? "?"}：選擇防守方式`, <>
          <button disabled={!blockAllowed} title={blockAllowed ? "" : "發球或攔網回球不能選擇攔網"} onClick={() => decide({ type: "defense-choice", choice: "block" })}>攔網</button>
          <button data-primary="true" onClick={() => decide({ type: "defense-choice", choice: "receive" })}>接球</button>
        </>);
      }
      case "free":
        return bar("自由步驟：可發動技能或結束目前階段", <>
          {free.skills.map((option) => (
            <button key={`s${option.uid}-${option.skillIndex}`} className="btn-skill" onClick={() => decide({ type: "free", action: "skill", uid: option.uid, skillIndex: option.skillIndex })}>{option.label}</button>
          ))}
          {free.events.map((option) => (
            <button key={`e${option.uid}`} className="btn-skill" onClick={() => decide({ type: "free", action: "event", uid: option.uid })}>{option.label}</button>
          ))}
          <button data-primary="true" onClick={() => decide({ type: "free", action: "pass" })}>結束（Pass）</button>
          <button className="btn-danger" onClick={() => decide({ type: "free", action: "lost" })}>宣告 Lost</button>
        </>);
      case "resolve-pending":
        return bar(pd.prompt ?? "選擇先解決的待機技能", pd.candidates?.map((id, index) => {
          const item = state.pendingQueue.find((candidate) => candidate.id === id);
          return <button key={id} data-primary={index === 0 ? "true" : undefined} onClick={() => decide({ type: "resolve-pending", id })}>{item?.desc ?? `技能 ${id}`}</button>;
        }));
      case "effect-confirm":
        return bar(pd.prompt ?? "要使用技能嗎？", <>
          <button data-primary="true" onClick={() => decide({ type: "effect-confirm", accept: true })}>使用</button>
          <button className="btn-secondary" onClick={() => decide({ type: "effect-confirm", accept: false })}>不使用</button>
        </>);
      case "effect-option":
        return bar(pd.prompt ?? "選擇效果", pd.options?.map((option, index) => (
          <button key={option} data-primary={index === 0 ? "true" : undefined} onClick={() => decide({ type: "effect-option", index })}>{option}</button>
        )));
      case "effect-cards": {
        const min = pd.min ?? 0;
        const max = pd.max ?? 1;
        if (effectCardsInPlace) {
          return bar(`${pd.prompt}：點選場上或手牌候選 ${min === max ? min : `${min}～${max}`} 張（已選 ${multiSel.length}）`, (
            <button data-primary="true" disabled={multiSel.length < min || multiSel.length > max} onClick={() => decide({ type: "effect-cards", uids: multiSel })}>確定</button>
          ));
        }
        return (
          <div className="decision-bar decision-card-picker">
            <span className="decision-hint">{pd.prompt}（選 {min === max ? min : `${min}～${max}`} 張）</span>
            <div className="effect-cards-row">
              {pd.candidates?.map((uid) => (
                <CardView
                  key={uid}
                  card={cardOf(uid)}
                  uid={uid}
                  width={64}
                  selected={multiSel.includes(uid)}
                  onHover={(card) => setHoverUid(card ? uid : null)}
                  onLongPress={() => inspectUid(uid)}
                  onClick={() => toggleSelection(uid, max)}
                />
              ))}
            </div>
            <div className="decision-actions">
              <button data-primary="true" disabled={multiSel.length < min || multiSel.length > max} onClick={() => decide({ type: "effect-cards", uids: multiSel })}>確定</button>
            </div>
          </div>
        );
      }
      case "deploy-block":
        return bar(`攔網登場：選 1～3 張；第 1 張為中央攔網者（已選 ${multiSel.length}）`, <>
          <button data-primary="true" disabled={multiSel.length === 0} onClick={confirmBlockDeploy}>確定登場</button>
          <button className="btn-secondary" onClick={() => setMultiSel([])}>清除選擇</button>
          <button className="btn-danger" onClick={() => decide({ type: "deploy-block", uids: null })}>不登場（Lost）</button>
        </>);
      case "deploy-serve":
      case "deploy-receive":
      case "deploy-toss":
      case "deploy-attack": {
        const area = DEPLOY_AREA[pd.type] as Exclude<CourtArea, "block">;
        if (nameAsk) {
          return bar(`${cardOf(nameAsk.uid).nameJa}：選擇登場時的卡名`, <>
            {nameAsk.names.map((name, index) => (
              <button
                key={name}
                data-primary={index === 0 ? "true" : undefined}
                disabled={!canDeployTo(db, state, HUMAN, nameAsk.uid, area, name)}
                onClick={() => decide({ type: pd.type, uid: nameAsk.uid, nameChoice: name } as Decision)}
              >
                {name}
              </button>
            ))}
            <button className="btn-secondary" onClick={() => setNameAsk(null)}>取消</button>
          </>);
        }
        return bar(`${DEPLOY_LABEL[area]}登場：點選手牌，桌面也可拖到場區`, (
          <button className="btn-danger" onClick={() => decide({ type: pd.type, uid: null } as Decision)}>不登場（Lost）</button>
        ));
      }
      case "pick-set-card":
        return bar("你輸掉這個 Set：點選球場左下的一張 Set 卡加入手牌", null);
    }
  }

  // 手牌間距：「分開為主，擁擠才靠近」——夠放就留正向間隔，放不下才漸進收攏成重疊
  const HAND_CARD = 84;
  const HAND_GAP = 12;
  const HAND_MIN_VISIBLE = 34;
  const handCount = viewState.players[HUMAN].hand.length;
  let handStep = HAND_GAP;
  if (handCount > 1 && handWidth > 0) {
    const needed = handCount * HAND_CARD + (handCount - 1) * HAND_GAP;
    if (needed > handWidth) {
      handStep = Math.max(-(HAND_CARD - HAND_MIN_VISIBLE), (handWidth - HAND_CARD) / (handCount - 1) - HAND_CARD);
    }
  }
  const handStyle = { "--hand-step": `${handStep}px` } as CSSProperties;

  return (
    <div className="fit-shell" data-instant={speed === "instant" ? "true" : undefined}>
    <svg className="ink-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id="ink-rough" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="7" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
    <div className="game" data-instant={speed === "instant" ? "true" : undefined} style={{ "--fit-scale": fitScale } as CSSProperties}>
      <CompactHud
        state={viewState}
        onOpenLog={() => setMobilePanel("log")}
        onOpenDetail={() => setMobilePanel("detail")}
        onExit={props.onExit}
      />

      <LeftPanel
        state={viewState}
        deckMeta={props.deckMeta}
        speed={speed}
        onSpeedChange={changeSpeed}
        sfxEnabled={sfxEnabled}
        onToggleSfx={toggleSfx}
        onExit={props.onExit}
      />

      <main className="center-panel">
        <GameBoard
          db={db}
          state={viewState}
          deckMeta={props.deckMeta}
          canPickSet={!replayMode && isMyDecision && pd?.type === "pick-set-card"}
          deployArea={replayMode ? null : deployArea}
          activeGutsKey={activeGutsKey}
          recentUids={replayMode ? new Set() : recentUids}
          settledUids={replayMode ? new Set() : settledUids}
          candidateUids={!replayMode && isMyDecision && effectCardsInPlace ? effectCandidates : []}
          selectableUids={!replayMode && isMyDecision && effectCardsInPlace ? effectCandidates : []}
          selectedUids={!replayMode && effectCardsInPlace ? multiSel : []}
          hoveredUid={hovered?.uid ?? null}
          dragOverArea={!replayMode && dragging?.valid ? dragging.overArea : null}
          onPickSet={(index) => decide({ type: "pick-set-card", index })}
          onOpenDrop={(player) => {
            setToolMode({ type: "drop", player });
            setMobilePanel("detail");
          }}
          onOpenEvent={(player) => {
            setToolMode({ type: "event", player });
            setMobilePanel("detail");
          }}
          onToggleGuts={setActiveGutsKey}
          onDropCard={onDropCard}
          onSelectUid={(uid) => toggleSelection(uid, effectMax)}
          onHover={setHoverUid}
          onInspect={inspectUid}
        />

        <div ref={decisionRef}><DecisionBar /></div>

        <section className="hand-section" aria-label={`你的手牌 ${viewState.players[HUMAN].hand.length} 張`}>
          <div className="hand-heading"><span>{replayMode ? "覆盤手牌" : "你的手牌"}</span><strong>{viewState.players[HUMAN].hand.length}</strong></div>
          <div className="hand" style={handStyle} data-zone-anchor="p0-hand" ref={handRef}>
            {viewState.players[HUMAN].hand.length === 0 && <span className="hand-empty">沒有手牌</span>}
            {viewState.players[HUMAN].hand.map((uid) => {
              const selectedIndex = multiSel.indexOf(uid);
              const canDrag = !replayMode && !!deployArea && deployable.includes(uid);
              return (
                <CardView
                  key={uid}
                  card={cardOf(uid)}
                  uid={uid}
                  width={84}
                  className={[recentUids.has(uid) ? "card-entering" : "", settledUids.has(uid) ? "card-settle" : ""].filter(Boolean).join(" ") || undefined}
                  selected={selectedIndex >= 0}
                  selectable={effectCardsInPlace && effectCandidates.includes(uid)}
                  candidate={effectCardsInPlace && effectCandidates.includes(uid)}
                  candidateHovered={effectCardsInPlace && effectCandidates.includes(uid) && hovered?.uid === uid}
                  dimmed={!replayMode && ((!!deployArea && !deployable.includes(uid)) || (effectCardsInPlace && !effectCandidates.includes(uid)))}
                  badge={pd?.type === "deploy-block" && selectedIndex === 0 ? "中央" : selectedIndex > 0 ? String(selectedIndex + 1) : effectCardsInPlace && selectedIndex === 0 ? "1" : undefined}
                  secondaryBadge={cardOf(uid).effectStatus === "todo" ? "未實作" : undefined}
                  draggable={canDrag}
                  onPointerDragStart={canDrag ? (info) => startHandDrag(uid, info) : undefined}
                  onPointerDragMove={canDrag ? (info) => moveHandDrag(uid, info) : undefined}
                  onPointerDragEnd={canDrag ? (info) => finishHandDrag(uid, info) : undefined}
                  onPointerDragCancel={canDrag ? () => setDragging(null) : undefined}
                  onHover={(card) => setHoverUid(card ? uid : null)}
                  onLongPress={() => inspectUid(uid)}
                  onClick={() => onHandClick(uid)}
                />
              );
            })}
          </div>
        </section>
      </main>

      <aside className={`right-panel${mobilePanel === "detail" ? " is-mobile-open" : ""}`}>
        <div className="mobile-panel-heading">
          <b>面板</b>
          <button className="btn-quiet" onClick={() => setMobilePanel(null)}>關閉</button>
        </div>
        <div className="tool-actions">
          <button className="btn-quiet undo-button" disabled={!canUndo} title="回到上一個我方決策前" onClick={undoLastDecision}>返回上一步</button>
        </div>
        <div className="tool-tabs" role="tablist" aria-label="右欄工具">
          <button role="tab" aria-selected={toolMode.type === "detail"} className={toolMode.type === "detail" ? "is-active" : ""} onClick={() => setToolMode({ type: "detail" })}>詳情</button>
          <button role="tab" aria-selected={toolMode.type === "coach"} className={toolMode.type === "coach" ? "is-active" : ""} onClick={() => setToolMode({ type: "coach" })}>教練</button>
          <button role="tab" aria-selected={toolMode.type === "counter"} className={toolMode.type === "counter" ? "is-active" : ""} onClick={() => setToolMode({ type: "counter" })}>算牌</button>
          <button role="tab" aria-selected={toolMode.type === "drop"} className={toolMode.type === "drop" ? "is-active" : ""} onClick={() => setToolMode({ type: "drop", player: HUMAN })}>棄牌</button>
        </div>
        <div className="tool-content">
          {replayMode ? (
            visibleInspection ? (
              <CardDetails db={db} state={viewState} inspected={visibleInspection} />
            ) : (
              <ReplayStepSummary
                state={viewState}
                entry={replayEntry}
                step={replayStep}
                total={replay.entries.length}
                analytics={replayAnalytics}
                keyEntries={replayKeyEntries}
                critique={replayCritique}
                critiqueCache={replayCritiques}
                scan={replayScan}
                onEvaluate={evaluateReplayStep}
                onScan={scanReplayDecisions}
                onStopScan={stopReplayScan}
                onJump={setReplayStep}
              />
            )
          ) : toolMode.type === "drop" || toolMode.type === "event" ? (
            <DropBrowser
              db={db}
              state={state}
              player={toolMode.player}
              source={toolMode.type === "event" ? "event" : "drop"}
              onClose={() => setToolMode({ type: "detail" })}
              onSelect={(uid) => {
                inspectUid(uid);
                setToolMode({ type: "detail" });
              }}
              onHover={setHoverUid}
            />
          ) : toolMode.type === "coach" ? (
            <CoachPanel db={db} state={state} coach={coach} onApply={decide} />
          ) : toolMode.type === "counter" ? (
            <CardCounter db={db} state={state} />
          ) : state.phase === "gameOver" && !visibleInspection ? (
            <PostMatchReport
              analytics={replayAnalytics}
              lostSets={replayReview.lostSets}
              effectiveness={replayReview.actionEffectiveness}
              cardDetails={replayReview.actionCardDetails}
              narrative={replayReview.narrative}
              keyEntries={replayKeyEntries}
              critiqueCache={replayCritiques}
              scan={replayScan}
              onScan={scanReplayDecisions}
              onStopScan={stopReplayScan}
              onReplay={enterReplayMode}
            />
          ) : visibleInspection ? (
            <CardDetails db={db} state={state} inspected={visibleInspection} />
          ) : (
            <MatchSummary state={state} replayEntries={replay.entries.length} />
          )}
        </div>
      </aside>

      <aside className={`mobile-log-panel${mobilePanel === "log" ? " is-open" : ""}`}>
        <div className="mobile-panel-heading"><b>對戰紀錄</b><button className="btn-quiet" onClick={() => setMobilePanel(null)}>關閉</button></div>
        <GameLog state={viewState} />
      </aside>

      {mobilePanel && <button className="panel-backdrop" aria-label="關閉面板" onClick={() => setMobilePanel(null)} />}
      {activeGutsKey && <button className="guts-backdrop" aria-label="關閉 Guts" onClick={() => setActiveGutsKey(null)} />}
    </div>

    {scoreBanner && <div className="focus-lines" aria-hidden="true" />}
    {sfx && <div key={sfx.key} className="sfx-burst" aria-hidden="true">{sfx.text}</div>}
    {scoreBanner && <div className={`score-banner score-banner-${scoreBanner.kind}`} role="status">{scoreBanner.text}</div>}
    {showPostMatchModal && (
      <PostMatchModal
        analytics={replayAnalytics}
        lostSets={replayReview.lostSets}
        effectiveness={replayReview.actionEffectiveness}
        cardDetails={replayReview.actionCardDetails}
        narrative={replayReview.narrative}
        keyEntries={replayKeyEntries}
        critiqueCache={replayCritiques}
        scan={replayScan}
        winner={state.winner ?? null}
        replayMode={replayMode}
        onScan={scanReplayDecisions}
        onStopScan={stopReplayScan}
        onReplay={enterReplayMode}
        onClose={() => setShowPostMatchModal(false)}
      />
    )}
    {!replayMode && dragging && (
      <div
        className={`drag-ghost-wrap${dragging.valid ? " is-valid" : ""}`}
        style={{ left: dragging.x, top: dragging.y, width: dragging.width } as CSSProperties}
        aria-hidden="true"
      >
        <CardView card={cardOf(dragging.uid)} width={dragging.width} className="drag-ghost" />
      </div>
    )}
    <MotionLayer motions={motions} deckMeta={props.deckMeta} />

    <div className="rotate-overlay" role="alertdialog" aria-label="請將裝置轉為橫向">
      <div className="rotate-card">
        <div className="rotate-icon" aria-hidden="true" />
        <b>請將裝置轉為橫向</b>
        <span>對戰桌墊為橫式版面</span>
      </div>
    </div>
    </div>
  );
}
