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
  player: PlayerId;
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
    if (!rect.width || !rect.height) return; // 跳過隱藏（display:none）的重複牌堆
    cards.set(uid, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  });
  document.querySelectorAll<HTMLElement>("[data-zone-anchor]").forEach((element) => {
    const key = element.dataset.zoneAnchor;
    if (!key || anchors.has(key)) return;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // 跳過隱藏的重複牌堆，確保用可見的那組當動畫錨點
    anchors.set(key, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  });
  return { cards, anchors };
}

function rectFor(uid: number, zone: string, snapshot: ReturnType<typeof snapshotPositions>): RectLike | undefined {
  return snapshot.cards.get(uid) ?? snapshot.anchors.get(anchorKey(zone));
}

/**
 * 把「來源/目標」矩形收斂成卡片形狀（5:7）。
 * 當來源是區域 anchor（例如對手手牌列，是一條很寬的列）而非單張卡時，
 * 直接用它的寬度會讓飛行卡瞬間變成整列寬的巨卡——這裡以高度換算出卡寬並置中，避免爆大。
 */
function asCardRect(rect: RectLike): RectLike {
  const cardWidth = (rect.height * 5) / 7;
  if (rect.width <= cardWidth * 1.3) return rect;
  return { width: cardWidth, height: rect.height, left: rect.left + (rect.width - cardWidth) / 2, top: rect.top };
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
        const rawFrom = rectFor(uid, fromZone, prevPositions);
        const rawTo = rectFor(uid, toZone, currentPositions);
        const card = props.db.get(props.state.cards[uid]!);
        if (!rawFrom || !rawTo || !card) continue;
        const from = asCardRect(rawFrom);
        const to = asCardRect(rawTo);
        const player = Number(toZone[1]) as PlayerId;
        nextMotions.push({
          id: `${uid}-${fromZone}-${toZone}-${props.state.log.length}`,
          uid,
          player,
          src: cardImage(card),
          label: displayName(card),
          // 蓋牌移動一律顯示背面：來源是對手手牌/牌組，或目的地是 Set/牌組（避免落地前閃正面）
          back: fromZone === "p1-hand" || fromZone === "p1-deck" || toZone.endsWith("-set") || toZone.endsWith("-deck"),
          from,
          to,
          kind: motionKind(fromZone, toZone),
        });
        if (nextMotions.length >= 8) break;
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
        const src = motion.back ? cardBackImage(props.deckMeta[motion.player].school) : motion.src;
        // 等比縮放：來源與目標皆為 5:7 卡片，單一 scale 不會變形
        const scale = motion.to.width / Math.max(motion.from.width, 1);
        const style = {
          left: motion.from.left,
          top: motion.from.top,
          width: motion.from.width,
          height: motion.from.height,
          "--motion-x": `${motion.to.left - motion.from.left}px`,
          "--motion-y": `${motion.to.top - motion.from.top}px`,
          "--motion-scale": String(scale),
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
