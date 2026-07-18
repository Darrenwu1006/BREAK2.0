import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LogEntry } from "../../engine/types";
import type { BattleRailView } from "./railViewModel";
import type { RallyStepView } from "./railViewModel";
import styles from "../UiLabApp.module.css";
import { RAIL_TOOL_TABS, type RailTool } from "./RailTools";

function enrichedLog(log: LogEntry[]): (LogEntry & { summary?: boolean })[] {
  const out: (LogEntry & { summary?: boolean })[] = [];
  let lastJudge = "";
  for (const entry of log.filter((item) => !item.text.startsWith("──"))) {
    out.push(entry);
    if (entry.text.startsWith("判定：")) lastJudge = entry.text.replace("判定：", "").trim();
    if (entry.event?.kind === "set-won" || entry.event?.kind === "match-won") {
      const scorer = entry.event.winner === 0 ? "你得分" : "電腦得分";
      out.push({
        ...entry,
        player: null,
        text: `Turn ${entry.turnNo} ─ ${scorer}${lastJudge ? `（${lastJudge}）` : ""}`,
        summary: true,
      });
      lastJudge = "";
    }
  }
  return out;
}

const RALLY_LOG_TERMS: Record<RallyStepView["id"], readonly string[]> = {
  serve: ["發球"],
  defense: ["防守", "攔網還是接球"],
  block: ["攔網", "DP"],
  receive: ["接球", "DP"],
  toss: ["托球"],
  attack: ["攻擊", "OP"],
  judge: ["判定", "得分", "Set", "Lost"],
};

export function DecisionRail(props: {
  view: BattleRailView;
  presentationLines: readonly string[];
  log: LogEntry[];
  tool: RailTool;
  settingsContent: ReactNode;
  drawerContent: ReactNode | null;
  onToolChange: (tool: RailTool) => void;
  onDrawerClose: () => void;
  onLogHover?: (entry: LogEntry | null) => void;
}): React.JSX.Element {
  const { view } = props;
  const logRef = useRef<HTMLDivElement>(null);
  const [logPaused, setLogPaused] = useState(false);
  const [rallyFocus, setRallyFocus] = useState<RallyStepView["id"] | null>(null);
  const enrichedEntries = useMemo(() => enrichedLog(props.log), [props.log]);
  const visibleEntries = useMemo(() => rallyFocus
    ? enrichedEntries.filter((entry) => RALLY_LOG_TERMS[rallyFocus].some((term) => entry.text.includes(term)))
    : enrichedEntries,
  [enrichedEntries, rallyFocus]);

  // [使用者 2026-07-18] #2：切進紀錄 tab 直接落在最新（瞬移，不從最上面平滑捲下來）。
  useEffect(() => {
    if (props.tool !== "log") return;
    setLogPaused(false);
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [props.tool]);

  useEffect(() => {
    if (!logPaused) {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [enrichedEntries.length, logPaused]);

  const onLogScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setLogPaused(el.scrollHeight - el.scrollTop - el.clientHeight > 32);
  };

  return (
    <>
      <aside className={styles.decisionRail} aria-label="對局資訊">
        <header className={styles.railHeader}>
          <div>
            <span className={styles.railEyebrow}>UI LAB・第 {view.phaseLabel}</span>
            <strong>{view.players[view.actionPlayer].label}・{view.actionLabel}</strong>
          </div>
        </header>

        <section className={styles.battleBoard} aria-label="戰況板">
          {[view.players[1], view.players[0]].map((player) => (
            <div className={`${styles.playerSummary} ${player.player === view.actionPlayer ? styles.playerSummaryActive : ""}`} key={player.player}>
              <div><strong>{player.label}</strong><span>{player.player === 0 ? "你" : "對手"}・{player.role}</span></div>
              <dl>
                <div><dt>手</dt><dd>{player.hand}</dd></div>
                <div><dt>牌組</dt><dd>{player.deck}</dd></div>
                <div><dt>棄牌</dt><dd>{player.drop}</dd></div>
                <div><dt>Set</dt><dd>{player.set}</dd></div>
              </dl>
            </div>
          ))}
          <div className={styles.pointBoard}>
            <div><span>OP</span><strong>{view.op?.value ?? "—"}</strong></div>
            <em>VS</em>
            <div><span>DP</span><strong>{view.dp?.value ?? "—"}</strong></div>
            {view.judge && <b>{view.judge}</b>}
          </div>
        </section>

        <ol className={styles.rallyTrack} aria-label="Rally 規則進度">
          {view.rally.map((step) => (
            <li className={`${styles[`rally_${step.status}`]} ${rallyFocus === step.id ? styles.rallyFocused : ""}`} key={step.id}>
              <button
                type="button"
                disabled={step.status === "upcoming"}
                onClick={() => {
                  setRallyFocus((current) => current === step.id ? null : step.id);
                  props.onToolChange("log");
                }}
                aria-label={`查看${step.label}紀錄`}
              ><span /><small>{step.label}</small></button>
            </li>
          ))}
        </ol>

        <nav className={styles.railTabs} role="tablist" aria-label="Rail 工具">
          {RAIL_TOOL_TABS.map(({ tool, label }) => (
            <button key={tool} role="tab" aria-selected={props.tool === tool} className={props.tool === tool ? styles.railTabActive : ""} onClick={() => props.onToolChange(tool)}>{label}</button>
          ))}
        </nav>

        <div className={styles.railWorkspaceWrapper}>
          <section className={styles.railWorkspace} aria-label="情境工作區">
          {props.tool === "log" ? (
            <div className={styles.railLogPanel}>
              <div className={styles.footerHeading}>
                <div className={styles.footerTitleGroup}>
                  <strong>對戰紀錄</strong>
                  {rallyFocus && <button className={styles.logFocusChip} onClick={() => setRallyFocus(null)}>{view.rally.find((step) => step.id === rallyFocus)?.label} ×</button>}
                </div>
                {logPaused && (
                  <button className={styles.logLatest} onClick={() => {
                    setLogPaused(false);
                    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
                  }}>回到最新</button>
                )}
              </div>
              <div className={styles.logWrap}>
                <div className={styles.logList} ref={logRef} onScroll={onLogScroll}>
                  {visibleEntries.map((entry, index) => {
                    const previous = visibleEntries[index - 1];
                    const newGroup = !previous || previous.setNo !== entry.setNo || previous.turnNo !== entry.turnNo;
                    return <div key={`${entry.setNo}-${entry.turnNo}-${index}`}>
                      {newGroup && <div className={styles.logGroupLabel}>SET {entry.setNo} · RALLY {entry.turnNo}</div>}
                      <div
                        className={`${styles.logItem} ${entry.player === 0 ? styles.logMe : entry.player === 1 ? styles.logAi : ""} ${entry.summary ? styles.logSummary : ""}`}
                        onPointerEnter={() => props.onLogHover?.(entry)}
                        onPointerLeave={() => props.onLogHover?.(null)}
                      >
                        {entry.player !== null ? `${entry.player === 0 ? "你" : "電腦"}：` : ""}{entry.text}
                      </div>
                    </div>;
                  })}
                  {visibleEntries.length === 0 && <div className={styles.logEmpty}>等待對局開始…</div>}
                </div>
              </div>
            </div>
          ) : props.tool === "settings" ? (
            props.settingsContent
          ) : (
            <div className={styles.railIdleInfo}>
              <span>{props.tool === "coach" ? "COACH DRAWER" : "CARD COUNTER"}</span>
              <p>深度工具已向牌桌側展開；目前戰況與決策仍保留在原位。</p>
            </div>
          )}
        </section>

        </div>
      </aside>
      {props.drawerContent && (
        <aside className={styles.railDrawer} aria-label={props.tool === "coach" ? "Coach drawer" : "算牌 drawer"}>
          <header><div><span>RAIL TOOL</span><strong>{props.tool === "coach" ? "教練" : "算牌"}</strong></div><button className={styles.btnGhost} onClick={props.onDrawerClose} aria-label="關閉 drawer">關閉（Esc）</button></header>
          <div className={styles.railDrawerBody}>{props.drawerContent}</div>
        </aside>
      )}
    </>
  );
}
