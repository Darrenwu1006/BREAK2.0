import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { Card } from "../data/types";
import type { CourtArea } from "../engine/dsl";
import { applyDecision, canChooseBlock, createGame, deployableUids, freeOptions } from "../engine/engine";
import { canDeployTo, deployNames } from "../engine/effects";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { heuristicAiDecision } from "../ai/heuristic";
import { CardView } from "./CardView";
import { GameBoard } from "./GameBoard";
import { CardCounter, CardDetails, CompactHud, DropBrowser, GameLog, LeftPanel, MatchSummary, PHASE_NAME } from "./GamePanels";
import type { AiSpeed, DeckMeta, InspectedCard } from "./gameTypes";
import { MotionLayer, useGameMotion } from "./useGameMotion";

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

type ToolMode = { type: "detail" } | { type: "counter" } | { type: "drop"; player: PlayerId } | { type: "event"; player: PlayerId };

function initialSpeed(): AiSpeed {
  const stored = localStorage.getItem("breaktcg-ai-speed");
  return stored === "0.5" || stored === "1" || stored === "2" || stored === "instant" ? stored : "1";
}

export function Game(props: {
  db: CardDb;
  decks: [string[], string[]];
  deckMeta: [DeckMeta, DeckMeta];
  onExit: () => void;
}) {
  const { db } = props;
  const [state, setState] = useState<GameState>(() =>
    createGame(db, { seed: (Date.now() % 0xffffffff) >>> 0, decks: props.decks }),
  );
  const [hovered, setHovered] = useState<InspectedCard | null>(null);
  const [inspected, setInspected] = useState<InspectedCard | null>(null);
  const [multiSel, setMultiSel] = useState<number[]>([]);
  const [nameAsk, setNameAsk] = useState<{ uid: number; names: string[] } | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>({ type: "detail" });
  const [mobilePanel, setMobilePanel] = useState<"log" | "detail" | null>(null);
  const [activeGutsKey, setActiveGutsKey] = useState<string | null>(null);
  const [speed, setSpeed] = useState<AiSpeed>(initialSpeed);
  const [scoreBanner, setScoreBanner] = useState<string | null>(null);
  const decisionRef = useRef<HTMLDivElement>(null);
  const handRef = useRef<HTMLDivElement>(null);
  const [handWidth, setHandWidth] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const seenLogCount = useRef(state.log.length);

  const pd = state.pendingDecision;
  const isMyDecision = pd?.player === HUMAN && state.phase !== "gameOver";
  const deployArea = pd && pd.type in DEPLOY_AREA ? DEPLOY_AREA[pd.type]! : null;
  const deployable = isMyDecision && deployArea ? deployableUids(db, state, HUMAN, deployArea) : [];
  const free = isMyDecision && pd?.type === "free" ? freeOptions(db, state) : { skills: [], events: [] };
  // effect-cards：候選若都在我方手牌 → 就地在手牌選取（不另開卡列）
  const effectCards = pd && pd.type === "effect-cards" ? pd : null;
  const effectCandidates = effectCards?.candidates ?? [];
  const effectMax = effectCards?.max ?? 1;
  const effectCardsInHand = isMyDecision && !!effectCards && effectCandidates.length > 0
    && effectCandidates.every((uid) => state.players[HUMAN].hand.includes(uid));
  const { motions, recentUids } = useGameMotion({ state, db, deckMeta: props.deckMeta, disabled: speed === "instant" });

  const visibleInspection = hovered ?? inspected;

  function cardOf(uid: number): Card {
    return db.get(state.cards[uid]!)!;
  }

  function setHoverUid(uid: number | null) {
    setHovered(uid === null ? null : { cardId: state.cards[uid]!, uid });
  }

  function inspectUid(uid: number) {
    setInspected({ cardId: state.cards[uid]!, uid });
    setToolMode({ type: "detail" });
    setMobilePanel("detail");
  }

  function decide(decision: Decision) {
    setMultiSel([]);
    setNameAsk(null);
    setActiveGutsKey(null);
    setState((current) => applyDecision(db, current, decision));
  }

  function changeSpeed(next: AiSpeed) {
    setSpeed(next);
    localStorage.setItem("breaktcg-ai-speed", next);
  }

  useEffect(() => {
    if (pd?.player !== AI || state.phase === "gameOver") return;
    const numeric = speed === "instant" ? Infinity : Number(speed);
    const delay = speed === "instant" ? 0 : 650 / numeric;
    const timer = window.setTimeout(() => {
      setState((current) => current.pendingDecision?.player === AI && current.phase !== "gameOver"
        ? applyDecision(db, current, heuristicAiDecision(db, current))
        : current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [db, pd, speed, state.phase]);

  useEffect(() => {
    const newEntries = state.log.slice(seenLogCount.current);
    seenLogCount.current = state.log.length;
    const lost = [...newEntries].reverse().find((entry) => entry.text.startsWith("宣告 Lost（"));
    if (!lost) return;
    setScoreBanner(lost.player === HUMAN ? "電腦得分" : "BREAK! 你得分");
    const timer = window.setTimeout(() => setScoreBanner(null), 900);
    return () => window.clearTimeout(timer);
  }, [state.log]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, button");
      if (event.key === "Escape") {
        setMultiSel([]);
        setNameAsk(null);
        setActiveGutsKey(null);
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

  function onHandClick(uid: number) {
    if (!isMyDecision || !pd) {
      inspectUid(uid);
      return;
    }
    if (pd.type === "mulligan") {
      setMultiSel((selected) => selected.includes(uid) ? selected.filter((item) => item !== uid) : [...selected, uid]);
      return;
    }
    if (pd.type === "deploy-block") {
      if (!deployable.includes(uid)) return;
      setMultiSel((selected) => selected.includes(uid)
        ? selected.filter((item) => item !== uid)
        : selected.length < 3 ? [...selected, uid] : selected);
      return;
    }
    if (pd.type === "effect-cards") {
      if (!effectCardsInHand || !effectCandidates.includes(uid)) { inspectUid(uid); return; }
      setMultiSel((selected) => selected.includes(uid)
        ? selected.filter((item) => item !== uid)
        : selected.length < effectMax ? [...selected, uid] : selected);
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

  function onDragStart(event: DragEvent<HTMLDivElement>, uid: number) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/card-uid", String(uid));
  }

  function bar(hint: string, buttons: React.ReactNode) {
    return <div className="decision-bar"><span className="decision-hint">{hint}</span><div className="decision-actions">{buttons}</div></div>;
  }

  function DecisionBar() {
    if (state.phase === "gameOver") {
      return bar(state.winner === HUMAN ? "你贏得了這場對戰" : "電腦贏得了這場對戰", (
        <button data-primary="true" onClick={props.onExit}>回主選單</button>
      ));
    }
    if (!pd) return <div className="decision-bar decision-idle"><span>規則引擎正在推進對局</span></div>;
    if (!isMyDecision) return <div className="decision-bar decision-idle"><span>電腦思考中</span><small>{PHASE_NAME[state.phase]}</small></div>;

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
        if (effectCardsInHand) {
          return bar(`${pd.prompt}：在手牌點選 ${min === max ? min : `${min}～${max}`} 張（已選 ${multiSel.length}）`, (
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
                  width={52}
                  selected={multiSel.includes(uid)}
                  onHover={(card) => setHoverUid(card ? uid : null)}
                  onLongPress={() => inspectUid(uid)}
                  onClick={() => setMultiSel((selected) => selected.includes(uid)
                    ? selected.filter((item) => item !== uid)
                    : selected.length < max ? [...selected, uid] : selected)}
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
  const handCount = state.players[HUMAN].hand.length;
  let handStep = HAND_GAP;
  if (handCount > 1 && handWidth > 0) {
    const needed = handCount * HAND_CARD + (handCount - 1) * HAND_GAP;
    if (needed > handWidth) {
      handStep = Math.max(-(HAND_CARD - HAND_MIN_VISIBLE), (handWidth - HAND_CARD) / (handCount - 1) - HAND_CARD);
    }
  }
  const handStyle = { "--hand-step": `${handStep}px` } as CSSProperties;

  return (
    <div className="fit-shell">
    <div className="game" data-instant={speed === "instant" ? "true" : undefined} style={{ "--fit-scale": fitScale } as CSSProperties}>
      <CompactHud
        state={state}
        onOpenLog={() => setMobilePanel("log")}
        onOpenDetail={() => setMobilePanel("detail")}
        onExit={props.onExit}
      />

      <LeftPanel state={state} deckMeta={props.deckMeta} speed={speed} onSpeedChange={changeSpeed} onExit={props.onExit} />

      <main className="center-panel">
        <GameBoard
          db={db}
          state={state}
          deckMeta={props.deckMeta}
          canPickSet={isMyDecision && pd?.type === "pick-set-card"}
          deployArea={deployArea}
          activeGutsKey={activeGutsKey}
          recentUids={recentUids}
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
          onHover={setHoverUid}
          onInspect={inspectUid}
        />

        <div ref={decisionRef}><DecisionBar /></div>

        <section className="hand-section" aria-label={`你的手牌 ${state.players[HUMAN].hand.length} 張`}>
          <div className="hand-heading"><span>你的手牌</span><strong>{state.players[HUMAN].hand.length}</strong></div>
          <div className="hand" style={handStyle} data-zone-anchor="p0-hand" ref={handRef}>
            {state.players[HUMAN].hand.length === 0 && <span className="hand-empty">沒有手牌</span>}
            {state.players[HUMAN].hand.map((uid) => {
              const selectedIndex = multiSel.indexOf(uid);
              const canDrag = !!deployArea && deployable.includes(uid);
              return (
                <CardView
                  key={uid}
                  card={cardOf(uid)}
                  uid={uid}
                  width={84}
                  className={recentUids.has(uid) ? "card-entering" : undefined}
                  selected={selectedIndex >= 0}
                  dimmed={(!!deployArea && !deployable.includes(uid)) || (effectCardsInHand && !effectCandidates.includes(uid))}
                  badge={pd?.type === "deploy-block" && selectedIndex === 0 ? "中央" : selectedIndex > 0 ? String(selectedIndex + 1) : effectCardsInHand && selectedIndex === 0 ? "1" : undefined}
                  secondaryBadge={cardOf(uid).effectStatus === "todo" ? "未實作" : undefined}
                  draggable={canDrag}
                  onDragStart={canDrag ? (event) => onDragStart(event, uid) : undefined}
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
        <div className="tool-tabs" role="tablist" aria-label="右欄工具">
          <button role="tab" aria-selected={toolMode.type === "detail"} className={toolMode.type === "detail" ? "is-active" : ""} onClick={() => setToolMode({ type: "detail" })}>詳情</button>
          <button role="tab" aria-selected={toolMode.type === "counter"} className={toolMode.type === "counter" ? "is-active" : ""} onClick={() => setToolMode({ type: "counter" })}>算牌</button>
          <button role="tab" aria-selected={toolMode.type === "drop"} className={toolMode.type === "drop" ? "is-active" : ""} onClick={() => setToolMode({ type: "drop", player: HUMAN })}>棄牌</button>
          <button role="tab" disabled title="需 AI 引擎支援（未來版本）">勝率</button>
        </div>
        <div className="tool-content">
          {toolMode.type === "drop" || toolMode.type === "event" ? (
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
          ) : toolMode.type === "counter" ? (
            <CardCounter db={db} state={state} />
          ) : visibleInspection ? (
            <CardDetails db={db} state={state} inspected={visibleInspection} />
          ) : (
            <MatchSummary state={state} />
          )}
        </div>
      </aside>

      <aside className={`mobile-log-panel${mobilePanel === "log" ? " is-open" : ""}`}>
        <div className="mobile-panel-heading"><b>對戰紀錄</b><button className="btn-quiet" onClick={() => setMobilePanel(null)}>關閉</button></div>
        <GameLog state={state} />
      </aside>

      {mobilePanel && <button className="panel-backdrop" aria-label="關閉面板" onClick={() => setMobilePanel(null)} />}
      {activeGutsKey && <button className="guts-backdrop" aria-label="關閉 Guts" onClick={() => setActiveGutsKey(null)} />}
    </div>

    {scoreBanner && <div className="score-banner" role="status">{scoreBanner}</div>}
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
