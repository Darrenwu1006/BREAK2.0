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

const AREA_EN: Record<CourtArea, string> = {
  serve: "SERVE",
  block: "BLOCK",
  receive: "RECEIVE",
  toss: "TOSS",
  attack: "ATTACK",
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
  settledUids: Set<number>;
  onPickSet: (index: number) => void;
  onOpenDrop: (player: PlayerId) => void;
  onOpenEvent: (player: PlayerId) => void;
  onToggleGuts: (key: string | null) => void;
  onDropCard: (uid: number, area: CourtArea) => void;
}

function cardOf(db: CardDb, state: GameState, uid: number): Card {
  return db.get(state.cards[uid]!)!;
}

/** 單一場區（發球/接球/舉球/攻擊/攔網）。攔網以 sideUids＋中央堆呈現三格。 */
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
  settledUids: Set<number>;
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

  const renderCard = (uid: number, badge?: string) => (
    <CardView
      key={uid}
      card={cardOf(db, state, uid)}
      uid={uid}
      badge={badge}
      className={[props.recentUids.has(uid) ? "card-entering" : "", props.settledUids.has(uid) ? "card-settle" : ""].filter(Boolean).join(" ") || undefined}
      onHover={(card) => props.onHover(card ? uid : null)}
      onClick={() => props.onInspect(uid)}
      onLongPress={() => props.onInspect(uid)}
    />
  );

  const isBlock = area === "block";
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
        <span className="zone-en">{AREA_EN[area]}</span>
        <span className="zone-zh">{AREA_LABEL[area]}</span>
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
        {isBlock ? (
          <>
            {props.sideUids?.[0] !== undefined ? renderCard(props.sideUids[0]) : <div className="zone-empty" aria-hidden="true" />}
            {top !== null ? renderCard(top, "中央") : <div className="zone-empty" aria-hidden="true" />}
            {props.sideUids?.[1] !== undefined ? renderCard(props.sideUids[1]) : <div className="zone-empty" aria-hidden="true" />}
          </>
        ) : (
          top !== null ? renderCard(top) : <div className="zone-empty" aria-hidden="true" />
        )}
      </div>

      {props.activeGutsKey === key && guts.length > 0 && (
        <div className="guts-popover" role="dialog" aria-label={`${owner}${AREA_LABEL[area]}區 Guts`}>
          <div className="popover-heading">
            <b>Guts {guts.length}</b>
            <button className="btn-quiet" onClick={() => props.onToggleGuts(null)}>關閉</button>
          </div>
          <div className="guts-cards">
            {guts.map((uid) => renderCard(uid))}
          </div>
        </div>
      )}
    </section>
  );
}

/** 牌堆（牌組/棄牌/事件）小堆，可選 onOpen 開瀏覽。 */
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
            onHover={(card) => props.onHover(card ? props.topUid! : null)}
          />
        ) : props.count > 0 ? (
          <CardBack school={props.school} />
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

/** SET 側欄（左）。 */
function SetPileGroup(props: PileGroupProps & { canPickSet: boolean; onPickSet: (index: number) => void }) {
  const ps = props.state.players[props.player];
  return (
    <div
      className="set-pile"
      data-zone-anchor={`p${props.player}-set`}
      aria-label={`${props.player === 0 ? "我方" : "對方"} Set 卡 ${ps.setArea.length} 張`}
    >
      <span className="pile-group-title">SET<small>{props.player === 0 ? "你" : "對手"}</small></span>
      <div className="set-card-row">
        {ps.setArea.map((_, index) => (
          <CardBack
            key={index}
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

/** DECK＋DROP 側欄（右）。 */
function RailDeckDrop(props: PileGroupProps & { onOpenDrop: () => void }) {
  const ps = props.state.players[props.player];
  const topDrop = ps.drop.length ? ps.drop[ps.drop.length - 1] : undefined;
  return (
    <div className="rail-deckdrop" aria-label={`${props.player === 0 ? "我方" : "對手"}牌組與棄牌`}>
      <MiniPile label="牌組" count={ps.deck.length} school={props.meta.school} db={props.db} state={props.state} player={props.player} pile="deck" onHover={props.onHover} onInspect={props.onInspect} />
      <MiniPile label="棄牌" count={ps.drop.length} topUid={topDrop} db={props.db} state={props.state} player={props.player} pile="drop" onOpen={props.onOpenDrop} onHover={props.onHover} onInspect={props.onInspect} />
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

  const zone = (player: PlayerId, area: CourtArea, stack: Stack, sides?: Stack) => (
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
      settledUids={props.settledUids}
      onToggleGuts={props.onToggleGuts}
      onDropCard={props.onDropCard}
      onHover={props.onHover}
      onInspect={inspect}
    />
  );

  const eventPile = (player: PlayerId) => {
    const ps = state.players[player];
    const topEvent = ps.eventArea.length ? ps.eventArea[ps.eventArea.length - 1] : undefined;
    return (
      <MiniPile label="事件" count={ps.eventArea.length} topUid={topEvent} db={props.db} state={state} player={player} pile="event" onOpen={() => props.onOpenEvent(player)} onHover={props.onHover} onInspect={inspect} />
    );
  };

  const p0 = state.players[0];
  const p1 = state.players[1];

  return (
    <div className="arena">
      <div className="opponent-hand" data-zone-anchor="p1-hand" aria-label={`對方手牌 ${p1.hand.length} 張`}>
        <span>對方手牌</span>
        <div className="opponent-hand-cards">
          {p1.hand.map((uid) => <CardBack key={uid} width={24} school={props.deckMeta[1].school} />)}
        </div>
        <strong>{p1.hand.length}</strong>
      </div>

      <div className="mat">
        <div className="mat-rail rail-set">
          <SetPileGroup db={props.db} state={state} player={1} meta={props.deckMeta[1]} canPickSet={false} onPickSet={props.onPickSet} onHover={props.onHover} onInspect={inspect} />
          <SetPileGroup db={props.db} state={state} player={0} meta={props.deckMeta[0]} canPickSet={props.canPickSet} onPickSet={props.onPickSet} onHover={props.onHover} onInspect={inspect} />
        </div>

        <div className="mat-play">
          {/* 對手半場（鏡像排版、文字正向） */}
          <div className="mat-row mat-back mat-opp">
            {eventPile(1)}
            {zone(1, "serve", p1.serve)}
          </div>
          <div className="mat-row mat-trio mat-opp">
            {zone(1, "attack", p1.attack)}
            {zone(1, "toss", p1.toss)}
            {zone(1, "receive", p1.receive)}
          </div>
          <div className="mat-row mat-blockrow mat-opp">
            {zone(1, "block", p1.blockCenter, p1.blockSides)}
          </div>

          <div className="mat-net" aria-hidden="true" />

          {/* 我方半場 */}
          <div className="mat-row mat-blockrow">
            {zone(0, "block", p0.blockCenter, p0.blockSides)}
          </div>
          <div className="mat-row mat-trio">
            {zone(0, "receive", p0.receive)}
            {zone(0, "toss", p0.toss)}
            {zone(0, "attack", p0.attack)}
          </div>
          <div className="mat-row mat-back">
            {zone(0, "serve", p0.serve)}
            {eventPile(0)}
          </div>

          {/* OP/DP＋judge：移出中軸，浮在 play 右側留白、貼近網高 */}
          <div className="net-anchor">
            <NetScore state={state} />
          </div>
        </div>

        <div className="mat-rail rail-res">
          <RailDeckDrop db={props.db} state={state} player={1} meta={props.deckMeta[1]} onOpenDrop={() => props.onOpenDrop(1)} onHover={props.onHover} onInspect={inspect} />
          <RailDeckDrop db={props.db} state={state} player={0} meta={props.deckMeta[0]} onOpenDrop={() => props.onOpenDrop(0)} onHover={props.onHover} onInspect={inspect} />
        </div>
      </div>
    </div>
  );
}
