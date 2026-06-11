import type { Card } from "../data/types";

export function cardImage(card: Card): string | null {
  const p = card.printings[0];
  return p?.image ? `/${p.image}` : null;
}

export function displayName(card: Card): string {
  return card.nameZh || card.nameJa;
}

export function CardView(props: {
  card: Card;
  width?: number;
  selected?: boolean;
  dimmed?: boolean;
  badge?: string;
  onClick?: () => void;
  onHover?: (card: Card | null) => void;
}) {
  const { card, width = 80 } = props;
  const img = cardImage(card);
  return (
    <div
      className={"card" + (props.selected ? " card-selected" : "") + (props.dimmed ? " card-dimmed" : "") + (props.onClick ? " card-clickable" : "")}
      style={{ width }}
      onClick={props.onClick}
      onMouseEnter={() => props.onHover?.(card)}
      onMouseLeave={() => props.onHover?.(null)}
    >
      {img ? (
        <img src={img} width={width} alt={displayName(card)} draggable={false} />
      ) : (
        <div className="card-text-face" style={{ width }}>{displayName(card)}</div>
      )}
      {props.badge && <div className="card-badge">{props.badge}</div>}
    </div>
  );
}

/** 背面卡（牌組/Set 區用） */
export function CardBack(props: { width?: number; label?: string; onClick?: () => void }) {
  const { width = 80 } = props;
  return (
    <div className={"card card-back" + (props.onClick ? " card-clickable" : "")} style={{ width, height: width * 1.4 }} onClick={props.onClick}>
      {props.label ?? ""}
    </div>
  );
}
