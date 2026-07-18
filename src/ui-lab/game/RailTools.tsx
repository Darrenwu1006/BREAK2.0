import { useMemo } from "react";
import type { CoachReport } from "../../ai/coach";
import type { CardDb, Decision, GameState } from "../../engine/types";
import styles from "../UiLabApp.module.css";
import { buildRemainingCardRows } from "./railCounter";

// [使用者 2026-07-18] #2：卡片詳情移到場邊獨立面板（CardInfoPanel），rail 預設顯示紀錄。
export type RailTool = "log" | "coach" | "counter" | "settings";
export const RAIL_TOOL_TABS: readonly { tool: RailTool; label: string }[] = [
  { tool: "log", label: "紀錄" },
  { tool: "coach", label: "教練" },
  { tool: "counter", label: "算牌" },
  { tool: "settings", label: "設定" },
];
export type LabCoachState =
  | { status: "idle" }
  | { status: "loading"; fallback: Decision }
  | { status: "ready"; report: CoachReport }
  | { status: "error"; fallback: Decision | null; error: string };

export function LabCardCounter(props: { db: CardDb; state: GameState }): React.JSX.Element {
  const rows = useMemo(() => buildRemainingCardRows(props.db, props.state), [props.db, props.state]);
  return (
    <div className={styles.drawerTool}>
      <div className={styles.drawerToolHeading}><div><strong>你的牌組剩餘</strong><span>{props.state.players[0].deck.length} 張・{rows.length} 種</span></div></div>
      <ul className={styles.counterList}>
        {rows.map((row) => <li key={row.id} className={row.remaining === 0 ? styles.counterZero : ""}><span>{row.label}</span><b>{row.remaining}<small>/{row.total}</small></b></li>)}
      </ul>
      <p className={styles.drawerHint}>只統計剩餘數量，不顯示抽牌順序或任何隱藏資訊。</p>
    </div>
  );
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

export function LabCoachPanel(props: { state: GameState; coach: LabCoachState; onApply: (decision: Decision) => void }): React.JSX.Element {
  const coach = props.coach;
  if (!props.state.pendingDecision || props.state.pendingDecision.player !== 0) return <div className={styles.drawerEmpty}><strong>Coach</strong><p>輪到你做決策時，這裡會顯示建議。</p></div>;
  if (coach.status === "idle") return <div className={styles.drawerEmpty}><strong>Coach</strong><p>準備目前局面的建議。</p></div>;
  if (coach.status === "error") return (
    <div className={styles.drawerTool}>
      <div className={styles.drawerToolHeading}><div><strong>Coach</strong><span>PIMC 暫時無法完成</span></div></div>
      {coach.fallback && <button className={styles.btn} onClick={() => props.onApply(coach.fallback!)}>採用快速建議</button>}
      <p className={styles.drawerError}>{coach.error}</p>
    </div>
  );
  if (coach.status === "loading") return (
    <div className={styles.drawerTool}>
      <div className={styles.drawerToolHeading}><div><strong>Coach</strong><span>PIMC 計算中</span></div></div>
      <div className={styles.coachBest}><small>Heuristic 快速建議</small><button className={styles.btn} onClick={() => props.onApply(coach.fallback)}>先採用快速建議</button></div>
      <div className={styles.coachLoading} aria-label="Coach 計算中"><span /><span /><span /></div>
    </div>
  );
  const report = coach.report;
  return (
    <div className={styles.drawerTool}>
      <div className={styles.drawerToolHeading}><div><strong>Coach</strong><span>{report.completedSamples} samples・{report.timedOut ? "timeout" : "PIMC"}</span></div></div>
      <section className={styles.coachBest}>
        <small>最佳建議</small>
        <strong>{report.bestAction.label}</strong>
        <div className={styles.coachMetrics}><span><b>{percent(report.bestAction.winRate)}</b> 勝率</span><span><b>{percent(report.bestAction.confidence)}</b> 信心</span></div>
        <p>{report.bestAction.explanation}</p>
        <button className={styles.btn} onClick={() => props.onApply(report.bestAction.decision)}>採用建議</button>
      </section>
      <ol className={styles.coachList}>
        {report.recommendations.slice(0, 4).map((item, index) => <li key={`${item.label}-${index}`}><div><strong>{item.label}</strong><b>{percent(item.winRate)}</b></div><small>信心 {percent(item.confidence)}・{item.sampleCount} samples</small><p>{item.explanation}</p></li>)}
      </ol>
    </div>
  );
}

export function LabSettingsPanel(props: {
  speed: number;
  reducedMotion: boolean;
  autoPlay: boolean;
  opponentEngine: "strong" | "heuristic";
  onSpeed: (speed: number) => void;
  onReducedMotion: (value: boolean) => void;
  onAutoPlay: (value: boolean) => void;
  onOpponentEngine: (value: "strong" | "heuristic") => void;
  onExit: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.railSettings}>
      <section><strong>對手引擎</strong><div className={styles.segmented}>{(["strong", "heuristic"] as const).map((value) => <button key={value} className={props.opponentEngine === value ? styles.segmentedActive : ""} onClick={() => props.onOpponentEngine(value)}>{value === "strong" ? "強敵" : "快速"}</button>)}</div></section>
      <section><strong>演出節奏</strong><div className={styles.segmented}>{[1, 2].map((value) => <button key={value} className={props.speed === value ? styles.segmentedActive : ""} onClick={() => props.onSpeed(value)}>{value}×</button>)}</div></section>
      <label><input type="checkbox" checked={props.reducedMotion} onChange={(event) => props.onReducedMotion(event.target.checked)} />減少鏡頭動態</label>
      <label><input type="checkbox" checked={props.autoPlay} onChange={(event) => props.onAutoPlay(event.target.checked)} />觀戰：AI 代打整場</label>
      <div className={styles.settingsDanger}><button className={styles.btnDanger} onClick={props.onExit}>離開對戰</button></div>
    </div>
  );
}
