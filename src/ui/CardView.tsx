import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { Card } from "../data/types";

export function cardImage(card: Card): string | null {
  const p = card.printings[0];
  return p?.image ? `/${p.image}` : null;
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

export function cardBackImage(school?: string): string {
  const normalized = normalizedSchool(school);
  const ext = normalized ? BACK_EXTENSIONS[normalized] : undefined;
  return normalized && ext ? `/backs/${encodeURIComponent(normalized)}.${ext}` : "/backs/default.png";
}

export function CardView(props: {
  card: Card;
  uid?: number;
  width?: number;
  selected?: boolean;
  dimmed?: boolean;
  badge?: string;
  secondaryBadge?: string;
  className?: string;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onClick?: () => void;
  onLongPress?: () => void;
  onHover?: (card: Card | null) => void;
}) {
  const { card, width = 80 } = props;
  const img = cardImage(card);
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);

  const clearLongPress = () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  useEffect(() => clearLongPress, []);

  const activate = () => {
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    props.onClick?.();
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
    props.onClick && "card-clickable",
    props.draggable && "card-draggable",
    props.className,
  ].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      style={{ width }}
      data-card-uid={props.uid}
      role={props.onClick ? "button" : undefined}
      tabIndex={props.onClick ? 0 : undefined}
      aria-label={props.onClick ? displayName(card) : undefined}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onClick={activate}
      onKeyDown={onKeyDown}
      onPointerDown={() => {
        if (!props.onLongPress) return;
        longPressFired.current = false;
        longPressTimer.current = window.setTimeout(() => {
          longPressFired.current = true;
          props.onLongPress?.();
        }, 480);
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
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
  const src = fallback ? "/backs/default.png" : cardBackImage(props.school);
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
