import { useEffect, useState, useRef } from "react";
import type { Card } from "../data/types";
import type { CardDb, Decision, GameState, PlayerId, Stack } from "../engine/types";
import { applyDecision, canChooseBlock, createGame, deployableUids } from "../engine/engine";
import { heuristicAiDecision } from "../ai/heuristic";
import { CardBack, CardView, displayName } from "./CardView";

const HUMAN: PlayerId = 0;
const AI: PlayerId = 1;

const PHASE_NAME: Record<string, string> = {
  setup: "準備", serve: "發球階段", start: "開始階段", block: "攔網階段", draw: "抽牌階段",
  receive: "接球階段", toss: "托球階段", attack: "攻擊階段", end: "結束階段",
  lostSet: "Lost", interval: "間隔", gameOver: "比賽結束",
};

const DEPLOY_AREA: Record<string, "serve" | "block" | "receive" | "toss" | "attack"> = {
  "deploy-serve": "serve", "deploy-block": "block", "deploy-receive": "receive",
  "deploy-toss": "toss", "deploy-attack": "attack",
};

export function Game(props: { db: CardDb; decks: [string[], string[]]; deckNames: [string, string]; onExit: () => void }) {
  const { db } = props;
  const [state, setState] = useState<GameState>(() =>
    createGame(db, { seed: (Date.now() % 0xffffffff) >>> 0, decks: props.decks }),
  );
  const [hovered, setHovered] = useState<Card | null>(null);
  const [multiSel, setMultiSel] = useState<number[]>([]); // 攔網/換牌的多選
  const logRef = useRef<HTMLDivElement>(null);

  const pd = state.pendingDecision;
  const isMyDecision = pd?.player === HUMAN && state.phase !== "gameOver";
  const deployArea = pd && pd.type in DEPLOY_AREA ? DEPLOY_AREA[pd.type]! : null;
  const deployable = isMyDecision && deployArea ? deployableUids(db, state, HUMAN, deployArea) : [];

  function decide(d: Decision) {
    setMultiSel([]);
    setState((s) => applyDecision(db, s, d));
  }

  // AI 決策（延遲一拍讓人看得到流程）
  useEffect(() => {
    if (pd?.player === AI && state.phase !== "gameOver") {
      const t = setTimeout(() => {
        setState((s) => (s.pendingDecision?.player === AI && s.phase !== "gameOver" ? applyDecision(db, s, heuristicAiDecision(db, s)) : s));
      }, 650);
      return () => clearTimeout(t);
    }
  }, [state, db, pd]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state.log.length]);

  const cardOf = (uid: number): Card => db.get(state.cards[uid]!)!;

  function onHandClick(uid: number) {
    if (!isMyDecision || !pd) return;
    if (pd.type === "mulligan") {
      setMultiSel((sel) => (sel.includes(uid) ? sel.filter((u) => u !== uid) : [...sel, uid]));
    } else if (pd.type === "deploy-block") {
      if (!deployable.includes(uid)) return;
      setMultiSel((sel) => (sel.includes(uid) ? sel.filter((u) => u !== uid) : sel.length < 3 ? [...sel, uid] : sel));
    } else if (deployArea) {
      if (deployable.includes(uid)) decide({ type: pd.type, uid } as Decision);
    }
  }

  // ---------- 子元件 ----------

  function Zone(z: { label: string; stack: Stack; highlight?: boolean }) {
    const top = z.stack.length ? z.stack[z.stack.length - 1]! : null;
    return (
      <div className={"zone" + (z.highlight ? " zone-active" : "")}>
        <div className="zone-label">{z.label}{z.stack.length > 1 ? `（G${z.stack.length - 1}）` : ""}</div>
        {top !== null ? <CardView card={cardOf(top)} width={72} onHover={setHovered} /> : <div className="zone-empty" />}
      </div>
    );
  }

  function Court(c: { p: PlayerId }) {
    const ps = state.players[c.p];
    const active = state.turnPlayer === c.p && state.phase !== "gameOver";
    return (
      <div className={"court" + (c.p === AI ? " court-ai" : "")}>
        <Zone label="發球" stack={ps.serve} highlight={active && state.phase === "serve"} />
        <div className={"zone" + (active && state.phase === "block" ? " zone-active" : "")}>
          <div className="zone-label">攔網{ps.blockCenter.length > 1 ? `（G${ps.blockCenter.length - 1}）` : ""}</div>
          <div className="block-row">
            {ps.blockSides.map((u) => <CardView key={u} card={cardOf(u)} width={56} onHover={setHovered} />)}
            {ps.blockCenter.length ? <CardView card={cardOf(ps.blockCenter[ps.blockCenter.length - 1]!)} width={72} onHover={setHovered} badge="中央" /> : <div className="zone-empty" />}
          </div>
        </div>
        <Zone label="接球" stack={ps.receive} highlight={active && state.phase === "receive"} />
        <Zone label="托球" stack={ps.toss} highlight={active && state.phase === "toss"} />
        <Zone label="攻擊" stack={ps.attack} highlight={active && state.phase === "attack"} />
      </div>
    );
  }

  function SideInfo(c: { p: PlayerId }) {
    const ps = state.players[c.p];
    const pickSet = isMyDecision && pd?.type === "pick-set-card" && c.p === HUMAN;
    return (
      <div className="side-info">
        <span>牌組 {ps.deck.length}</span>
        <span className="set-cards">
          Set：{ps.setArea.map((_, i) => <CardBack key={i} width={26} onClick={pickSet ? () => decide({ type: "pick-set-card", index: i }) : undefined} />)}
          {ps.setArea.length === 0 && state.setupStage === "done" && <b className="danger">0（再 Lost 即敗北）</b>}
        </span>
        <span>棄牌 {ps.drop.length}</span>
        <span>事件區 {ps.eventArea.length}</span>
        {c.p === AI && <span>手牌 {ps.hand.length}</span>}
      </div>
    );
  }

  // ---------- 決策列 ----------

  function DecisionBar() {
    if (state.phase === "gameOver") {
      return (
        <div className="decision-bar">
          <b className={state.winner === HUMAN ? "win" : "danger"}>{state.winner === HUMAN ? "🏆 你獲勝了！" : "💀 電腦獲勝"}</b>
          <button onClick={props.onExit}>回主選單</button>
        </div>
      );
    }
    if (!pd) return null;
    if (!isMyDecision) return <div className="decision-bar dim">電腦思考中…（{PHASE_NAME[state.phase]}）</div>;

    switch (pd.type) {
      case "serve-rights":
        return bar("你被選中：要擁有首次發球權嗎？", <>
          <button onClick={() => decide({ type: "serve-rights", take: true })}>擁有發球權</button>
          <button onClick={() => decide({ type: "serve-rights", take: false })}>讓給對方</button>
        </>);
      case "mulligan":
        return bar(`換牌：點選要放回牌組的卡（已選 ${multiSel.length} 張）`, <>
          <button onClick={() => decide({ type: "mulligan", returnUids: multiSel })}>{multiSel.length ? `換 ${multiSel.length} 張` : "不換牌"}</button>
        </>);
      case "defense-choice": {
        const blockOk = canChooseBlock(state);
        return bar(
          `對方 OP=${state.op?.value ?? "?"}（${state.op?.source === "serve" ? "發球" : state.op?.source === "block" ? "攔網回球" : "攻擊"}）：${blockOk ? "本回合要攔網還是接球？" : "發球/攔網回球只能接球"}`,
          <>
            <button disabled={!blockOk} title={blockOk ? "" : "對手的發球或攔網回球不能選擇攔網"} onClick={() => decide({ type: "defense-choice", choice: "block" })}>攔網</button>
            <button onClick={() => decide({ type: "defense-choice", choice: "receive" })}>接球（先抽 1 張）</button>
          </>,
        );
      }
      case "free":
        return bar("自由步驟", <>
          <button onClick={() => decide({ type: "free", action: "pass" })}>結束（Pass）</button>
          <button className="btn-danger" onClick={() => decide({ type: "free", action: "lost" })}>宣告 Lost</button>
        </>);
      case "deploy-block":
        return bar(`攔網登場：點選手牌 1~3 張（已選 ${multiSel.length}；第 1 張為中央攔網者）`, <>
          <button disabled={multiSel.length === 0} onClick={() => decide({ type: "deploy-block", uids: multiSel, center: multiSel[0]! })}>確定登場</button>
          <button className="btn-danger" onClick={() => decide({ type: "deploy-block", uids: null })}>不登場（Lost）</button>
        </>);
      case "deploy-serve": case "deploy-receive": case "deploy-toss": case "deploy-attack": {
        const labels: Record<string, string> = { "deploy-serve": "發球", "deploy-receive": "接球", "deploy-toss": "托球", "deploy-attack": "攻擊" };
        return bar(`${labels[pd.type]}登場：點選一張亮起的手牌`, <>
          <button className="btn-danger" onClick={() => decide({ type: pd.type, uid: null } as Decision)}>不登場（Lost）</button>
        </>);
      }
      case "pick-set-card":
        return bar("你輸掉這個 Set：點選自己的一張 Set 卡加入手牌", null);
    }
  }

  const bar = (hint: string, buttons: React.ReactNode) => (
    <div className="decision-bar"><span>{hint}</span>{buttons}</div>
  );

  // ---------- 版面 ----------

  return (
    <div className="game">
      <div className="board">
        <div className="status-bar">
          <span>Set {state.setNo}・Turn {state.turnNo}・{PHASE_NAME[state.phase]}</span>
          <span>{state.op ? `OP ${state.op.value}（${state.op.owner === HUMAN ? "你" : "電腦"}・${state.op.source}）` : "OP —"}</span>
          <span>{state.dp ? `DP ${state.dp.value}` : "DP —"}</span>
          <button className="btn-exit" onClick={props.onExit}>離開</button>
        </div>

        <SideInfo p={AI} />
        <Court p={AI} />
        <div className="net" />
        <Court p={HUMAN} />
        <SideInfo p={HUMAN} />

        <DecisionBar />

        <div className="hand">
          {state.players[HUMAN].hand.map((uid) => (
            <CardView
              key={uid}
              card={cardOf(uid)}
              width={84}
              onHover={setHovered}
              onClick={() => onHandClick(uid)}
              selected={multiSel.includes(uid)}
              dimmed={!!deployArea && !deployable.includes(uid)}
              badge={pd?.type === "deploy-block" && multiSel[0] === uid ? "中央" : undefined}
            />
          ))}
        </div>
      </div>

      <div className="sidebar">
        <div className="detail">
          {hovered ? (
            <>
              <b>{displayName(hovered)}</b>
              {hovered.nameZh && <div className="dim">{hovered.nameJa}</div>}
              <div className="dim">{hovered.affiliations.join("/")} {hovered.grades.join("/")} {hovered.positions.join("/")}</div>
              {hovered.params && (
                <table className="params"><tbody>
                  <tr><td>發球</td><td>攔網</td><td>接球</td><td>托球</td><td>攻擊</td></tr>
                  <tr>{(["serve", "block", "receive", "toss", "attack"] as const).map((k) => <td key={k}><b>{hovered.params![k] ?? "－"}</b></td>)}</tr>
                </tbody></table>
              )}
              {(hovered.skillZh || hovered.skillJa) && (
                <p className="skill-text">
                  {hovered.skillZh ?? hovered.skillJa}
                  {hovered.skillZhStatus === "machine" && <span className="badge-machine">機翻待校</span>}
                </p>
              )}
              <p className="dim small">※ M2 階段技能尚未生效（香草規則對局）</p>
            </>
          ) : (
            <span className="dim">滑過卡片查看詳情</span>
          )}
        </div>
        <div className="log" ref={logRef}>
          {state.log.map((e, i) => (
            <div key={i} className={e.player === HUMAN ? "log-me" : e.player === AI ? "log-ai" : ""}>
              {e.player !== null ? (e.player === HUMAN ? "你" : "電腦") + "：" : ""}{e.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
