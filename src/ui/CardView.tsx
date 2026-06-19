import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Card } from "../data/types";

const publicAsset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;

// 牌組編輯器選的卡面版本（稀有度）→ 戰鬥中改用對應版本的卡圖。key=cardId, value=imageEnd/rarity
const printingOverride = new Map<string, string>();
export function setCardPrintings(map: Map<string, string>) {
  printingOverride.clear();
  for (const [id, sel] of map) printingOverride.set(id, sel);
}

export function cardImage(card: Card): string | null {
  const sel = printingOverride.get(card.id);
  if (sel) {
    const chosen = card.printings.find((p) => (p.imageEnd ?? p.rarity) === sel);
    if (chosen?.image) return publicAsset(chosen.image);
  }
  const p = card.printings[0];
  return p?.image ? publicAsset(p.image) : null;
}

export function displayName(card: Card): string {
  return card.nameZh || card.nameJa;
}

const BACK_EXTENSIONS: Record<string, "png" | "jpg"> = {
  伊達工業: "png",
  梟谷: "png",
  烏野: "png",
  白鳥沢: "png",
  稲荷崎: "jpg",
  青葉城西: "png",
  音駒: "png",
};

function normalizedSchool(school?: string): string | undefined {
  if (school === "稻荷崎") return "稲荷崎";
  return school;
}

// 卡背一律用縮圖（backs/thumb/*.png，~300px）——場上顯示僅 ~60px，大圖太浪費頻寬
export function cardBackImage(school?: string): string {
  const normalized = normalizedSchool(school);
  const name = normalized && BACK_EXTENSIONS[normalized] ? normalized : "default";
  return publicAsset(`backs/thumb/${encodeURIComponent(name)}.png`);
}

export interface CardPointerDragInfo {
  uid?: number;
  card: Card;
  pointerId: number;
  clientX: number;
  clientY: number;
  rect: DOMRect;
}

export function CardView(props: {
  card: Card;
  uid?: number;
  width?: number;
  selected?: boolean;
  dimmed?: boolean;
  selectable?: boolean;
  candidate?: boolean;
  candidateHovered?: boolean;
  badge?: string;
  secondaryBadge?: string;
  className?: string;
  draggable?: boolean;
  onPointerDragStart?: (info: CardPointerDragInfo) => void;
  onPointerDragMove?: (info: CardPointerDragInfo) => void;
  onPointerDragEnd?: (info: CardPointerDragInfo) => void;
  onPointerDragCancel?: () => void;
  onClick?: () => void;
  onLongPress?: () => void;
  onHover?: (card: Card | null) => void;
}) {
  const { card, width = 80 } = props;
  const img = cardImage(card);
  const rootRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const press = useRef<{ pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null);
  const suppressNextClick = useRef(false);

  const clearLongPress = () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  useEffect(() => clearLongPress, []);

  const dragInfo = (event: ReactPointerEvent<HTMLDivElement>): CardPointerDragInfo => {
    const el = rootRef.current ?? event.currentTarget;
    return {
      uid: props.uid,
      card,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      rect: el.getBoundingClientRect(),
    };
  };

  const cancelPress = () => {
    clearLongPress();
    if (press.current?.dragging) props.onPointerDragCancel?.();
    press.current = null;
    longPressFired.current = false;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!props.onClick || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    props.onClick();
  };

  const classes = [
    "card",
    props.selected && "card-selected",
    props.dimmed && "card-dimmed",
    props.selectable && "card-selectable",
    props.candidate && "card-candidate",
    props.candidateHovered && "card-candidate-hover",
    props.onClick && "card-clickable",
    props.draggable && "card-draggable",
    props.className,
  ].filter(Boolean).join(" ");

  return (
    <div
      ref={rootRef}
      className={classes}
      style={{ width }}
      data-card-uid={props.uid}
      role={props.onClick ? "button" : undefined}
      tabIndex={props.onClick ? 0 : undefined}
      aria-label={props.onClick ? displayName(card) : undefined}
      draggable={false}
      onClick={(event) => {
        if (!suppressNextClick.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressNextClick.current = false;
      }}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        press.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
        longPressFired.current = false;
        if (props.draggable || props.onLongPress) event.currentTarget.setPointerCapture(event.pointerId);
        if (props.onLongPress) {
          longPressTimer.current = window.setTimeout(() => {
            longPressFired.current = true;
            suppressNextClick.current = true;
            props.onLongPress?.();
          }, 480);
        }
      }}
      onPointerMove={(event) => {
        const current = press.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (longPressFired.current) return;
        const dx = event.clientX - current.startX;
        const dy = event.clientY - current.startY;
        const moved = Math.hypot(dx, dy);
        if (!current.dragging && moved > 8) {
          clearLongPress();
          if (props.draggable) {
            current.dragging = true;
            suppressNextClick.current = true;
            props.onPointerDragStart?.(dragInfo(event));
          }
        }
        if (current.dragging) {
          event.preventDefault();
          props.onPointerDragMove?.(dragInfo(event));
        }
      }}
      onPointerUp={(event) => {
        const current = press.current;
        if (!current || current.pointerId !== event.pointerId) return;
        clearLongPress();
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // Pointer capture may already be gone on some browser cancellation paths.
        }
        press.current = null;
        if (current.dragging) {
          event.preventDefault();
          suppressNextClick.current = true;
          props.onPointerDragEnd?.(dragInfo(event));
          return;
        }
        if (longPressFired.current) {
          longPressFired.current = false;
          return;
        }
        props.onClick?.();
      }}
      onPointerCancel={cancelPress}
      onMouseEnter={() => props.onHover?.(card)}
      onMouseLeave={() => props.onHover?.(null)}
    >
      {img ? (
        <img src={img} width={width} alt={displayName(card)} draggable={false} loading="lazy" />
      ) : (
        <div className="card-text-face" style={{ width }}>{displayName(card)}</div>
      )}
      {props.badge && <div className="card-badge">{props.badge}</div>}
      {props.secondaryBadge && <div className="card-badge card-badge-secondary">{props.secondaryBadge}</div>}
    </div>
  );
}

export function CardBack(props: {
  width?: number;
  label?: string;
  school?: string;
  className?: string;
  onClick?: () => void;
}) {
  const { width = 80 } = props;
  const [fallback, setFallback] = useState(false);
  useEffect(() => setFallback(false), [props.school]);

  const classes = ["card", "card-back", props.onClick && "card-clickable", props.className].filter(Boolean).join(" ");
  const src = fallback ? publicAsset("backs/thumb/default.png") : cardBackImage(props.school);
  return (
    <div
      className={classes}
      style={{ width, height: width * 1.4 }}
      role={props.onClick ? "button" : undefined}
      tabIndex={props.onClick ? 0 : undefined}
      aria-label={props.onClick ? props.label ?? "卡背" : undefined}
      onClick={props.onClick}
      onKeyDown={(event) => {
        if (!props.onClick || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        props.onClick();
      }}
    >
      <img
        src={src}
        alt=""
        width={width}
        height={width * 1.4}
        loading="lazy"
        draggable={false}
        onError={() => setFallback(true)}
      />
      {props.label && <span className="card-back-label">{props.label}</span>}
    </div>
  );
}
