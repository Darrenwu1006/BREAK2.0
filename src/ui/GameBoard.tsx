import type { Card } from "../data/types";
import type { CourtArea } from "../engine/dsl";
import { canChooseBlock } from "../engine/engine";
import type { CardDb, GameState, PlayerId, Stack } from "../engine/types";
import { CardBack, CardView, displayName } from "./CardView";
import type { DeckMeta } from "./gameTypes";

const AREA_LABEL: Record<CourtArea, string> = {
  serve: "發球",
  block: "攔網",
  receive: "接球",
  toss: "托球",
  attack: "攻擊",
};

const SOURCE_LABEL = {
  serve: "發球",
  block: "攔網回球",
  attack: "攻擊",
  receive: "接球",
} as const;

interface InspectHandlers {
  onHover: (uid: number | null) => void;
  onInspect: (uid: number) => void;
}

interface GameBoardProps extends InspectHandlers {
  db: CardDb;
  state: GameState;
  deckMeta: [DeckMeta, DeckMeta];
  canPickSet: boolean;
  deployArea: CourtArea | null;
  activeGutsKey: string | null;
  recentUids: Set<number>;
  onPickSet: (index: number) => void;
  onOpenDrop: (player: PlayerId) => void;
  onToggleGuts: (key: string | null) => void;
  onDropCard: (uid: number, area: CourtArea) => void;
}

function cardOf(db: CardDb, state: GameState, uid: number): Card {
  return db.get(state.cards[uid]!)!;
}

function StackZone(props: {
  db: CardDb;
  state: GameState;
  player: PlayerId;
  area: CourtArea;
  stack: Stack;
  sideUids?: number[];
  active: boolean;
  canDrop: boolean;
  activeGutsKey: string | null;
  recentUids: Set<number>;
  onToggleGuts: (key: string | null) => void;
  onDropCard: (uid: number, area: CourtArea) => void;
} & InspectHandlers) {
  const { db, state, player, area, stack } = props;
  const top = stack.length ? stack[stack.length - 1]! : null;
  const guts = stack.slice(0, -1).reverse();
  const key = `${player}-${area}`;
  const owner = player === 0 ? "我方" : "對方";
  const topName = top === null ? "空" : displayName(cardOf(db, state, top));
  const aria = `${owner}${AREA_LABEL[area]}區：${topName}${guts.length ? `，Guts ${guts.length}` : ""}`;

  const renderCard = (uid: number, width: number, badge?: string) => (
    <CardView
      key={uid}
      card={cardOf(db, state, uid)}
      uid={uid}
      width={width}
      badge={badge}
      className={props.recentUids.has(uid) ? "card-entering" : undefined}
      onHover={(card) => props.onHover(card ? uid : null)}
      onClick={() => props.onInspect(uid)}
      onLongPress={() => props.onInspect(uid)}
    />
  );

  return (
    <section
      className={`court-zone zone-${area} player-${player}${props.active ? " zone-active" : ""}${props.canDrop ? " zone-droppable" : ""}${props.activeGutsKey === key ? " zone-guts-open" : ""}`}
      aria-label={aria}
      data-zone-anchor={`p${player}-${area}`}
      onDragOver={(event) => {
        if (props.canDrop) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!props.canDrop) return;
        event.preventDefault();
        const uid = Number(event.dataTransfer.getData("text/card-uid"));
        if (Number.isFinite(uid)) props.onDropCard(uid, area);
      }}
    >
      <div className="zone-heading">
        <span>{AREA_LABEL[area]}</span>
        {guts.length > 0 && (
          <button
            className="guts-badge"
            type="button"
            aria-expanded={props.activeGutsKey === key}
            onClick={() => props.onToggleGuts(props.activeGutsKey === key ? null : key)}
          >
            G{guts.length}
          </button>
        )}
      </div>

      <div className="zone-cards">
        {props.sideUids?.map((uid) => renderCard(uid, 44))}
        {top !== null ? renderCard(top, 58, area === "block" ? "中央" : undefined) : <div className="zone-empty" aria-hidden="true" />}
      </div>

      {props.activeGutsKey === key && guts.length > 0 && (
        <div className="guts-popover" role="dialog" aria-label={`${owner}${AREA_LABEL[area]}區 Guts`}>
          <div className="popover-heading">
            <b>Guts {guts.length}</b>
            <button className="btn-quiet" onClick={() => props.onToggleGuts(null)}>關閉</button>
          </div>
          <div className="guts-cards">
            {guts.map((uid) => renderCard(uid, 54))}
          </div>
        </div>
      )}
    </section>
  );
}

function MiniPile(props: {
  label: string;
  count: number;
  school?: string;
  topUid?: number;
  db: CardDb;
  state: GameState;
  player: PlayerId;
  pile: "deck" | "drop" | "event";
  onOpen?: () => void;
} & InspectHandlers) {
  const faceUp = props.topUid !== undefined && props.pile !== "deck";
  return (
    <button
      type="button"
      className={`mini-pile pile-${props.pile}`}
      data-zone-anchor={`p${props.player}-${props.pile}`}
      onClick={props.onOpen}
      disabled={!props.onOpen}
      aria-label={`${props.player === 0 ? "我方" : "對方"}${props.label} ${props.count} 張`}
    >
      <span className="mini-card-slot">
        {faceUp ? (
          <CardView
            card={cardOf(props.db, props.state, props.topUid!)}
            uid={props.topUid}
            width={30}
            onHover={(card) => props.onHover(card ? props.topUid! : null)}
          />
        ) : props.count > 0 ? (
          <CardBack width={30} school={props.school} />
        ) : (
          <span className="mini-pile-empty" />
        )}
      </span>
      <span className="mini-pile-label">{props.label}</span>
      <strong>{props.count}</strong>
    </button>
  );
}

interface PileGroupProps extends InspectHandlers {
  db: CardDb;
  state: GameState;
  player: PlayerId;
  meta: DeckMeta;
}

function SetPileGroup(props: PileGroupProps & { canPickSet: boolean; onPickSet: (index: number) => void }) {
  const ps = props.state.players[props.player];
  return (
    <div
      className="set-pile"
      data-zone-anchor={`p${props.player}-set`}
      aria-label={`${props.player === 0 ? "我方" : "對方"} Set 卡 ${ps.setArea.length} 張`}
    >
      <span className="pile-group-title">Set</span>
      <div className="set-card-row">
        {ps.setArea.map((_, index) => (
          <CardBack
            key={index}
            width={28}
            school={props.meta.school}
            label={props.canPickSet && props.player === 0 ? String(index + 1) : undefined}
            onClick={props.canPickSet && props.player === 0 ? () => props.onPickSet(index) : undefined}
          />
        ))}
        {ps.setArea.length === 0 && <span className="set-empty">0</span>}
      </div>
    </div>
  );
}

function ResourcePileGroup(props: PileGroupProps & { onOpenDrop: () => void }) {
  const ps = props.state.players[props.player];
  const topDrop = ps.drop.length ? ps.drop[ps.drop.length - 1] : undefined;
  const topEvent = ps.eventArea.length ? ps.eventArea[ps.eventArea.length - 1] : undefined;
  return (
    <div className="resource-piles">
      <MiniPile label="事件" count={ps.eventArea.length} topUid={topEvent} db={props.db} state={props.state} player={props.player} pile="event" onHover={props.onHover} onInspect={props.onInspect} />
      <MiniPile label="牌組" count={ps.deck.length} school={props.meta.school} db={props.db} state={props.state} player={props.player} pile="deck" onHover={props.onHover} onInspect={props.onInspect} />
      <MiniPile label="棄牌" count={ps.drop.length} topUid={topDrop} db={props.db} state={props.state} player={props.player} pile="drop" onOpen={props.onOpenDrop} onHover={props.onHover} onInspect={props.onInspect} />
    </div>
  );
}

/** 手機/平板直式：牌堆疊在球場四角（空間有限） */
function PlayerPiles(props: PileGroupProps & {
  canPickSet: boolean;
  onPickSet: (index: number) => void;
  onOpenDrop: () => void;
}) {
  return (
    <div className={`player-piles player-piles-${props.player}`}>
      <SetPileGroup {...props} />
      <ResourcePileGroup {...props} />
    </div>
  );
}

function NetScore({ state }: { state: GameState }) {
  if (!state.op && !state.dp) return null;
  const blockAllowed = canChooseBlock(state);
  return (
    <div className={`net-score${state.dp ? " net-score-judge" : ""}`} aria-live="polite">
      <strong>
        {state.op && state.dp ? `${state.op.value} vs ${state.dp.value}` : state.op ? `OP ${state.op.value}` : `DP ${state.dp!.value}`}
      </strong>
      {state.op && !state.dp && <span>{SOURCE_LABEL[state.op.source]}</span>}
      {state.pendingDecision?.type === "defense-choice" && state.op && (
        <small>接球需 {state.op.value}+／{blockAllowed ? "可選攔網" : "攔網不可"}</small>
      )}
    </div>
  );
}

export function GameBoard(props: GameBoardProps) {
  const { state } = props;
  const activePlayer = state.turnPlayer;
  const activeArea = state.phase === "serve" || state.phase === "block" || state.phase === "receive" || state.phase === "toss" || state.phase === "attack" ? state.phase : null;
  const inspect = (uid: number) => props.onInspect(uid);

  return (
    <div className="arena">
      <div className="opponent-hand" data-zone-anchor="p1-hand" aria-label={`對方手牌 ${state.players[1].hand.length} 張`}>
        <span>對方手牌</span>
        <div className="opponent-hand-cards">
          {state.players[1].hand.map((uid) => <CardBack key={uid} width={24} school={props.deckMeta[1].school} />)}
        </div>
        <strong>{state.players[1].hand.length}</strong>
      </div>

      <div className="court-stage">
        <div className="court-flank flank-left">
          <SetPileGroup db={props.db} state={state} player={1} meta={props.deckMeta[1]} canPickSet={false} onPickSet={props.onPickSet} onHover={props.onHover} onInspect={inspect} />
          <SetPileGroup db={props.db} state={state} player={0} meta={props.deckMeta[0]} canPickSet={props.canPickSet} onPickSet={props.onPickSet} onHover={props.onHover} onInspect={inspect} />
        </div>

        <div className="volleyball-court">
          <div className="court-surface" aria-hidden="true">
            <div className="court-inner" />
            <div className="attack-line attack-line-opponent" />
            <div className="attack-line attack-line-human" />
            <div className="net-line" />
          </div>

          <PlayerPiles db={props.db} state={state} player={1} meta={props.deckMeta[1]} canPickSet={false} onPickSet={props.onPickSet} onOpenDrop={() => props.onOpenDrop(1)} onHover={props.onHover} onInspect={inspect} />
          <PlayerPiles db={props.db} state={state} player={0} meta={props.deckMeta[0]} canPickSet={props.canPickSet} onPickSet={props.onPickSet} onOpenDrop={() => props.onOpenDrop(0)} onHover={props.onHover} onInspect={inspect} />

          {([1, 0] as const).flatMap((player) => {
            const ps = state.players[player];
            return ([
              ["serve", ps.serve],
              ["block", ps.blockCenter, ps.blockSides],
              ["receive", ps.receive],
              ["toss", ps.toss],
              ["attack", ps.attack],
            ] as const).map(([area, stack, sides]) => (
              <StackZone
                key={`${player}-${area}`}
                db={props.db}
                state={state}
                player={player}
                area={area}
                stack={stack}
                sideUids={sides ? [...sides] : undefined}
                active={activePlayer === player && activeArea === area}
                canDrop={player === 0 && props.deployArea === area}
                activeGutsKey={props.activeGutsKey}
                recentUids={props.recentUids}
                onToggleGuts={props.onToggleGuts}
                onDropCard={props.onDropCard}
                onHover={props.onHover}
                onInspect={inspect}
              />
            ));
          })}

          <NetScore state={state} />
        </div>

        <div className="court-flank flank-right">
          <ResourcePileGroup db={props.db} state={state} player={1} meta={props.deckMeta[1]} onOpenDrop={() => props.onOpenDrop(1)} onHover={props.onHover} onInspect={inspect} />
          <ResourcePileGroup db={props.db} state={state} player={0} meta={props.deckMeta[0]} onOpenDrop={() => props.onOpenDrop(0)} onHover={props.onHover} onInspect={inspect} />
        </div>
      </div>
    </div>
  );
}
