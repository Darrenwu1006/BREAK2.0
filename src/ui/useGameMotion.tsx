import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { CardDb, GameState, PlayerId } from "../engine/types";
import { cardBackImage, cardImage, displayName } from "./CardView";
import type { DeckMeta } from "./gameTypes";

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Motion {
  id: string;
  uid: number;
  src: string | null;
  label: string;
  back: boolean;
  from: RectLike;
  to: RectLike;
  kind: "move" | "drop" | "guts" | "draw";
}

function zonesOf(state: GameState): Map<number, string> {
  const out = new Map<number, string>();
  for (const player of [0, 1] as const) {
    const ps = state.players[player];
    for (const uid of ps.deck) out.set(uid, `p${player}-deck`);
    for (const uid of ps.hand) out.set(uid, `p${player}-hand`);
    for (const uid of ps.setArea) out.set(uid, `p${player}-set`);
    for (const uid of ps.drop) out.set(uid, `p${player}-drop`);
    for (const uid of ps.eventArea) out.set(uid, `p${player}-event`);
    for (const area of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
      const zone = area === "blockCenter" ? "block" : area;
      const stack = ps[area];
      stack.forEach((uid, index) => out.set(uid, `p${player}-${zone}${index === stack.length - 1 ? "" : "-guts"}`));
    }
    for (const uid of ps.blockSides) out.set(uid, `p${player}-block`);
  }
  return out;
}

function anchorKey(zone: string): string {
  return zone.replace(/-guts$/, "");
}

function snapshotPositions(): { cards: Map<number, RectLike>; anchors: Map<string, RectLike> } {
  const cards = new Map<number, RectLike>();
  const anchors = new Map<string, RectLike>();
  document.querySelectorAll<HTMLElement>("[data-card-uid]").forEach((element) => {
    const uid = Number(element.dataset.cardUid);
    if (!Number.isFinite(uid) || cards.has(uid)) return;
    const rect = element.getBoundingClientRect();
    cards.set(uid, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  });
  document.querySelectorAll<HTMLElement>("[data-zone-anchor]").forEach((element) => {
    const key = element.dataset.zoneAnchor;
    if (!key || anchors.has(key)) return;
    const rect = element.getBoundingClientRect();
    anchors.set(key, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  });
  return { cards, anchors };
}

function rectFor(uid: number, zone: string, snapshot: ReturnType<typeof snapshotPositions>): RectLike | undefined {
  return snapshot.cards.get(uid) ?? snapshot.anchors.get(anchorKey(zone));
}

function motionKind(from: string, to: string): Motion["kind"] {
  if (to.endsWith("-drop")) return "drop";
  if (to.endsWith("-guts")) return "guts";
  if (from.endsWith("-deck") && to.endsWith("-hand")) return "draw";
  return "move";
}

export function useGameMotion(props: {
  state: GameState;
  db: CardDb;
  deckMeta: [DeckMeta, DeckMeta];
  disabled: boolean;
}) {
  const previousState = useRef<GameState | null>(null);
  const previousPositions = useRef<ReturnType<typeof snapshotPositions> | null>(null);
  const [motions, setMotions] = useState<Motion[]>([]);

  useLayoutEffect(() => {
    const currentPositions = snapshotPositions();
    const prev = previousState.current;
    const prevPositions = previousPositions.current;

    if (!props.disabled && prev && prevPositions) {
      const before = zonesOf(prev);
      const after = zonesOf(props.state);
      const nextMotions: Motion[] = [];
      for (const [uid, toZone] of after) {
        const fromZone = before.get(uid);
        if (!fromZone || fromZone === toZone) continue;
        const from = rectFor(uid, fromZone, prevPositions);
        const to = rectFor(uid, toZone, currentPositions);
        const card = props.db.get(props.state.cards[uid]!);
        if (!from || !to || !card) continue;
        const player = Number(toZone[1]) as PlayerId;
        nextMotions.push({
          id: `${uid}-${fromZone}-${toZone}-${props.state.log.length}`,
          uid,
          src: cardImage(card),
          label: displayName(card),
          back: fromZone === "p1-hand" || fromZone === "p1-deck",
          from,
          to,
          kind: motionKind(fromZone, toZone),
        });
        if (nextMotions.length >= 8) break;
        void player;
      }
      if (nextMotions.length) {
        setMotions(nextMotions);
        const timer = window.setTimeout(() => setMotions([]), 360);
        previousState.current = props.state;
        previousPositions.current = currentPositions;
        return () => window.clearTimeout(timer);
      }
    }

    previousState.current = props.state;
    previousPositions.current = currentPositions;
  }, [props.state, props.db, props.deckMeta, props.disabled]);

  const recentUids = useMemo(() => new Set(motions.map((motion) => motion.uid)), [motions]);
  return { motions, recentUids };
}

export function MotionLayer(props: { motions: Motion[]; deckMeta: [DeckMeta, DeckMeta] }) {
  return (
    <div className="motion-layer" aria-hidden="true">
      {props.motions.map((motion) => {
        const player = motion.id.includes("-p1-") ? 1 : 0;
        const src = motion.back ? cardBackImage(props.deckMeta[player].school) : motion.src;
        const style = {
          left: motion.from.left,
          top: motion.from.top,
          width: motion.from.width,
          height: motion.from.height,
          "--motion-x": `${motion.to.left - motion.from.left}px`,
          "--motion-y": `${motion.to.top - motion.from.top}px`,
          "--motion-scale-x": String(motion.to.width / Math.max(motion.from.width, 1)),
          "--motion-scale-y": String(motion.to.height / Math.max(motion.from.height, 1)),
        } as CSSProperties;
        return (
          <div key={motion.id} className={`motion-card motion-${motion.kind}`} style={style}>
            {src ? <img src={src} alt="" /> : <span>{motion.label}</span>}
          </div>
        );
      })}
    </div>
  );
}
