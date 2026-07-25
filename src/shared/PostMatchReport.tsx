// [Claude 2026-07-25] 賽後戰報：經典 2D 與實驗 3D **共用同一個元件**（[使用者 2026-07-25]
// 「樣式與內容完全長得一樣」）。樣式沿用 index.css 的全域 report-*／postmatch-* class——
// index.css 由 main.tsx 全域載入，兩個 shell 都吃得到，故不需重寫或複製樣式。
//
// 對外只吃 db + replay：報告需要的 analytics／review／技能統計都在元件內部算，呼叫端不必穿線。
// footer 按鈕依「有沒有傳該 callback」決定顯示——3D 沒有覆盤模式就不傳 onReplay，按鈕自動消失。

import { useMemo } from "react";
import type { Card } from "../data/types";
import type { CardDb, PlayerId } from "../engine/types";
import { createReplayReviewReport, lostSetCauseLabel, type ActionCardDetail, type LostSetSummary, type ReplayActionEffectiveness } from "../ai/replay-review";
import type { ValueExplanation } from "../ai/rollout-value";
import { buildMatchSummary, type SkillUsage } from "./matchSummary";
import { summarizeReplaySession, type ReplayAnalytics, type ReplaySession } from "./replayHistory";
import { CardView } from "../ui/CardView";
import { ValueExplanationSummary } from "../ui/GamePanels";

const HUMAN: PlayerId = 0;
const AI: PlayerId = 1;

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function statAverage(stats: ReplayAnalytics["op"][number]): string {
  return stats.count === 0 ? "-" : stats.average.toFixed(1);
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

// [Claude 2026-07-24] 候選 C Part 2：開技能次數（per-card 前幾名），資料來自 matchSummary。
function SkillUsageSection(props: { human: SkillUsage; ai: SkillUsage }) {
  const top = (usage: SkillUsage) => usage.byCard.slice(0, 5);
  return (
    <section className="report-section">
      <b>技能使用</b>
      <div className="report-compare">
        <span><small>你 開技能</small><b>{props.human.total}</b><em>次</em></span>
        <span><small>AI 開技能</small><b>{props.ai.total}</b><em>次</em></span>
      </div>
      {top(props.human).length > 0 && (
        <div className="replay-source-row">
          {top(props.human).map((card) => (
            <span key={card.name}>{card.name} ×{card.count}</span>
          ))}
        </div>
      )}
    </section>
  );
}

function PostMatchReportBody(props: {
  analytics: ReplayAnalytics;
  skillUsage: [SkillUsage, SkillUsage];
  lostSets: LostSetSummary;
  effectiveness: ReplayActionEffectiveness;
  cardDetails: ActionCardDetail[];
  valueExplanation: ValueExplanation;
  narrative: string[];
}) {
  const { analytics, lostSets, effectiveness } = props;
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
        <b>局面估值</b>
        <ValueExplanationSummary explanation={props.valueExplanation} />
      </section>

      <section className="report-section">
        <b>攻防平均</b>
        <div className="report-compare">
          <span><small>你 平均 OP</small><b>{statAverage(humanOp)}</b><em>{humanOp.count ? `${humanOp.min}–${humanOp.max}` : "-"}</em></span>
          <span><small>AI 平均 OP</small><b>{statAverage(aiOp)}</b><em>{aiOp.count ? `${aiOp.min}–${aiOp.max}` : "-"}</em></span>
          <span><small>你 平均 DP</small><b>{statAverage(humanDp)}</b><em>{humanDp.count ? `${humanDp.min}–${humanDp.max}・${humanDp.count} 次` : "-"}</em></span>
          <span><small>AI 平均 DP</small><b>{statAverage(aiDp)}</b><em>{aiDp.count ? `${aiDp.min}–${aiDp.max}・${aiDp.count} 次` : "-"}</em></span>
        </div>
        <div className="replay-source-row">
          <span>你 OP≥6 收割 {humanOp.highCount} 手</span>
          <span>AI OP≥6 收割 {aiOp.highCount} 手</span>
          <span>得分來源 發 {analytics.opSources.serve}／攔 {analytics.opSources.block}／攻 {analytics.opSources.attack}</span>
        </div>
      </section>

      <SkillUsageSection human={props.skillUsage[HUMAN]} ai={props.skillUsage[AI]} />

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


/** 報告本體所需的全部資料——由 replay 一次算出，呼叫端不必逐項穿線。 */
export function useMatchReportData(db: CardDb, replay: ReplaySession) {
  return useMemo(() => {
    const review = createReplayReviewReport(db, replay, { player: HUMAN });
    return {
      analytics: summarizeReplaySession(replay),
      skillUsage: buildMatchSummary(db, replay).skillUsage,
      lostSets: review.lostSets,
      effectiveness: review.actionEffectiveness,
      cardDetails: review.actionCardDetails,
      valueExplanation: review.valueExplanation,
      narrative: review.narrative,
    };
  }, [db, replay]);
}

export interface PostMatchModalProps {
  db: CardDb;
  replay: ReplaySession;
  winner: PlayerId | null;
  /** 對手（電腦）剩餘手牌；空陣列＝不顯示該區。 */
  opponentHand: { uid: number; card: Card }[];
  /** 目前已在覆盤模式（footer 改為單一「返回覆盤」）。 */
  replayMode?: boolean;
  /** 有傳才顯示「逐步覆盤」（3D 無覆盤模式，不傳）。 */
  onReplay?: () => void;
  /** 有傳才顯示「先看看」（關閉戰報留在原畫面）。 */
  onClose?: () => void;
  /** 有傳才顯示「再來一場（同牌組）」。 */
  onRematch?: () => void;
  /** 有傳才顯示「換牌組」。 */
  onExit?: () => void;
}

export function PostMatchModal(props: PostMatchModalProps) {
  const data = useMatchReportData(props.db, props.replay);
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
              {data.analytics.matchWinner === HUMAN ? "你贏了這場比賽" : data.analytics.matchWinner === AI ? "電腦獲勝" : "比賽結束"}
            </span>
          </div>
        </div>
        <div className="postmatch-modal-body">
          {props.opponentHand.length > 0 && (
            <section className="postmatch-opponent-hand" aria-label={`電腦剩餘手牌 ${props.opponentHand.length} 張`}>
              <div className="postmatch-opponent-hand-cards">
                {props.opponentHand.map(({ uid, card }) => (
                  <CardView key={uid} card={card} uid={uid} width={72} />
                ))}
              </div>
            </section>
          )}
          <PostMatchReportBody {...data} />
        </div>
        <div className="postmatch-modal-footer">
          {props.replayMode ? (
            <button data-primary="true" onClick={props.onClose}>返回覆盤</button>
          ) : (
            <>
              {props.onClose && <button className="btn-secondary" onClick={props.onClose}>先看看</button>}
              {props.onExit && <button className="btn-secondary" onClick={props.onExit}>換牌組</button>}
              {props.onRematch && <button className="btn-secondary" onClick={props.onRematch}>再來一場（同牌組）</button>}
              {props.onReplay && (
                <button data-primary="true" disabled={data.analytics.totalDecisions === 0} onClick={props.onReplay}>逐步覆盤</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 側欄用的靜態報告（不含 modal 外框）。 */
export function PostMatchReport(props: { db: CardDb; replay: ReplaySession; onReplay: () => void }) {
  const data = useMatchReportData(props.db, props.replay);
  return (
    <div className="postmatch-report">
      <div className="panel-heading">
        <div>
          <b>賽後戰報</b>
          <span>{data.analytics.matchWinner === HUMAN ? "你贏了這場比賽" : data.analytics.matchWinner === AI ? "電腦獲勝" : "比賽結束"}</span>
        </div>
      </div>
      <PostMatchReportBody {...data} />
      <div className="report-actions" style={{ padding: "0 var(--sp-4) var(--sp-4)" }}>
        <button data-primary="true" disabled={data.analytics.totalDecisions === 0} onClick={props.onReplay}>逐步覆盤</button>
      </div>
    </div>
  );
}
