// LP1/LP4 決策蓋板（DOM overlay，spec §2 面板混合原則：文字密集互動不硬塞 3D）。
// 涵蓋：serve-rights 二選一、effect-confirm/option、resolve-pending 待機選擇、
// effect-cards 跨區分組選卡（保平 M4 的分組 UX）、對局結算。
// 泛用資料全部來自引擎 PendingDecision 的 prompt/candidates/min/max/options——不逐卡客製。

import { useMemo, useState } from "react";
import type { Card } from "../../data/types";
import type { CardDb, GameState, PlayerId } from "../../engine/types";
import { effParam } from "../../engine/engine";
import { cardFrontUrl } from "../assets";
import type { ZoneId } from "../presentation/events";
import { ZONE_LABEL } from "../presentation/textRenderer";
import styles from "../UiLabApp.module.css";
import { HUMAN } from "./controller";

// ---- 跨區分組（M4 UX 保平：候選卡依「誰的哪一區」分組，避免丟錯卡） ----

const LOCATE_ZONES: readonly (readonly [ZoneId, keyof GameState["players"][0]])[] = [
  ["hand", "hand"],
  ["setArea", "setArea"],
  ["attack", "attack"],
  ["toss", "toss"],
  ["receive", "receive"],
  ["serve", "serve"],
  ["blockCenter", "blockCenter"],
  ["blockSide", "blockSides"],
  ["eventArea", "eventArea"],
  ["drop", "drop"],
  ["deck", "deck"],
];

export interface CandidateGroup {
  key: string;
  owner: PlayerId;
  zone: ZoneId | "unknown";
  uids: number[];
}

export function groupCandidates(state: GameState, candidates: readonly number[]): CandidateGroup[] {
  const locate = (uid: number): { owner: PlayerId; zone: ZoneId | "unknown" } => {
    for (const owner of [0, 1] as const) {
      const ps = state.players[owner];
      for (const [zone, key] of LOCATE_ZONES) {
        if ((ps[key] as number[]).includes(uid)) return { owner, zone };
      }
    }
    return { owner: 0, zone: "unknown" };
  };
  const groups: CandidateGroup[] = [];
  const index = new Map<string, number>();
  for (const uid of candidates) {
    const { owner, zone } = locate(uid);
    const key = `${owner}:${zone}`;
    let gi = index.get(key);
    if (gi === undefined) {
      gi = groups.length;
      index.set(key, gi);
      groups.push({ key, owner, zone, uids: [] });
    }
    groups[gi]!.uids.push(uid);
  }
  return groups;
}

export const groupLabel = (g: CandidateGroup): string => `${g.owner === HUMAN ? "我方" : "對手"}${g.zone === "unknown" ? "" : ZONE_LABEL[g.zone]}`;

// ---- 小元件 ----

function CardThumb(props: { card: Card | undefined; uid: number; printing?: string; selected?: boolean; onClick?: () => void }): React.JSX.Element {
  const src = props.card ? cardFrontUrl(props.card, props.printing) : null;
  const name = props.card?.nameZh || props.card?.nameJa || `卡片 ${props.uid}`;
  return (
    <figure className={`${styles.gutsCard} ${props.onClick ? styles.pickable : ""} ${props.selected ? styles.picked : ""}`} onClick={props.onClick}>
      {src ? <img src={src} alt={name} /> : <div className={styles.cardInfoImgEmpty}>{name}</div>}
      <figcaption>{name}</figcaption>
    </figure>
  );
}

// ---- serve-rights ----

export function ServeRightsModal(props: { onPick: (take: boolean) => void }): React.JSX.Element {
  return (
    <div className={styles.modalMask}>
      <div className={styles.modal}>
        <div className={styles.modalTitle}>你獲得選擇權——要首發球權嗎？</div>
        <button className={styles.btn} onClick={() => props.onPick(true)}>
          要，我方先發球
        </button>
        <button className={styles.btnGhost} onClick={() => props.onPick(false)}>
          讓給對手發球
        </button>
      </div>
    </div>
  );
}

// ---- effect-confirm / effect-option / resolve-pending ----

export function EffectConfirmModal(props: { prompt: string; onPick: (accept: boolean) => void }): React.JSX.Element {
  return (
    <div className={styles.modalMask}>
      <div className={styles.modal}>
        <div className={styles.modalTitle}>{props.prompt}</div>
        <button className={styles.btn} onClick={() => props.onPick(true)}>
          使用
        </button>
        <button className={styles.btnGhost} onClick={() => props.onPick(false)}>
          不使用
        </button>
      </div>
    </div>
  );
}

export function EffectOptionModal(props: { prompt: string; options: readonly string[]; onPick: (index: number) => void }): React.JSX.Element {
  return (
    <div className={styles.modalMask}>
      <div className={styles.modal}>
        <div className={styles.modalTitle}>{props.prompt}</div>
        {props.options.map((label, i) => (
          <button key={`${i}-${label}`} className={styles.btn} onClick={() => props.onPick(i)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ResolvePendingModal(props: {
  state: GameState;
  candidates: readonly number[];
  onHover?: (uid: number | null) => void;
  onPick: (id: number) => void;
}): React.JSX.Element {
  return (
    <div className={styles.modalMask}>
      <div className={styles.modal}>
        <div className={styles.modalTitle}>選擇要先解決的待機技能</div>
        {props.candidates.map((id) => {
          const item = props.state.pendingQueue.find((q) => q.id === id);
          return (
            <button
              key={id}
              className={styles.btn}
              onMouseEnter={() => props.onHover?.(item?.source ?? null)}
              onMouseLeave={() => props.onHover?.(null)}
              onClick={() => props.onPick(id)}
            >
              {item?.desc ?? `待機 #${id}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- effect-cards：跨區分組選卡面板 ----

export function EffectCardsPanel(props: {
  db: CardDb;
  state: GameState;
  prompt: string;
  candidates: readonly number[];
  min: number;
  max: number;
  printingByUid?: ReadonlyMap<number, string>;
  onConfirm: (uids: number[]) => void;
}): React.JSX.Element {
  const [picked, setPicked] = useState<number[]>([]);
  const groups = useMemo(() => groupCandidates(props.state, props.candidates), [props.state, props.candidates]);
  const toggle = (uid: number): void => {
    setPicked((cur) => (cur.includes(uid) ? cur.filter((u) => u !== uid) : cur.length < props.max ? [...cur, uid] : cur));
  };
  const ok = picked.length >= props.min && picked.length <= props.max;
  return (
    <section className={styles.effectPanel} role="dialog" aria-label="選擇卡片">
      <div className={styles.gutsPanelHeader}>
        <div>
          <strong>{props.prompt}</strong>
          <span>
            已選 {picked.length}／需 {props.min === props.max ? props.min : `${props.min}~${props.max}`} 張
          </span>
        </div>
        <button className={styles.btn} disabled={!ok} onClick={() => props.onConfirm(picked)}>
          {picked.length === 0 ? (props.min === 0 ? "不選擇" : "確認") : `確認（${picked.length}）`}
        </button>
      </div>
      {groups.map((g) => (
        <div key={g.key} className={styles.effectGroup}>
          <div className={styles.effectGroupLabel}>{groupLabel(g)}</div>
          <div className={styles.gutsCards}>
            {g.uids.map((uid) => (
              <CardThumb key={uid} uid={uid} card={props.db.get(props.state.cards[uid] ?? "")} printing={props.printingByUid?.get(uid)} selected={picked.includes(uid)} onClick={() => toggle(uid)} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

// ---- deploy-block：已選攔網手＋center 指定 ----

export function BlockPickPanel(props: {
  db: CardDb;
  state: GameState;
  selected: readonly number[];
  center: number | null;
  max: number;
  printingByUid?: ReadonlyMap<number, string>;
  onSetCenter: (uid: number) => void;
  onConfirm: () => void;
  onGiveUp: () => void;
}): React.JSX.Element {
  const opponentOp = props.state.op?.owner === HUMAN ? null : props.state.op?.value ?? null;
  const estimatedDp = props.selected.reduce((sum, uid) => sum + (effParam(props.db, props.state, uid, "block") ?? 0), 0);
  return (
    <section className={styles.effectPanel} role="dialog" aria-label="攔網登場">
      <div className={styles.gutsPanelHeader}>
        <div>
          <strong>攔網登場（1~{props.max} 張）——點下方縮圖指定中央攔網手</strong>
          <span>
            {props.selected.length === 0
              ? "點擊發亮的手牌加入攔網"
              : `已選 ${props.selected.length} 張；中央=${(() => {
                  if (props.center === null) return "未指定";
                  const card = props.db.get(props.state.cards[props.center] ?? "");
                  return card?.nameZh || card?.nameJa || "?";
                })()}`}
          </span>
          <span className={styles.numericContext}>
            預估 DP {estimatedDp}{opponentOp !== null ? ` vs OP ${opponentOp}` : ""}
          </span>
        </div>
        <div className={styles.blockPickActions}>
          <button className={styles.btn} disabled={props.selected.length === 0 || props.center === null} onClick={props.onConfirm}>
            攔網登場！
          </button>
          <button className={styles.btnDanger} onClick={props.onGiveUp}>
            不登場
          </button>
        </div>
      </div>
      {props.selected.length > 0 && (
        <div className={styles.gutsCards}>
          {props.selected.map((uid) => (
            <div key={uid} className={styles.blockValueCard}>
              <CardThumb uid={uid} card={props.db.get(props.state.cards[uid] ?? "")} printing={props.printingByUid?.get(uid)} selected={props.center === uid} onClick={() => props.onSetCenter(uid)} />
              <strong>攔網 {effParam(props.db, props.state, uid, "block") ?? "—"}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- 結算 ----

export function SettlementModal(props: {
  winner: PlayerId | null;
  schools: [string, string];
  setCards: [number, number];
  onRematch: () => void;
  onExit: () => void;
}): React.JSX.Element {
  const win = props.winner;
  return (
    <div className={styles.modalMask}>
      <div className={`${styles.modal} ${styles.settlement}`}>
        <div className={styles.settlementTitle}>{win !== null ? `${props.schools[win]} 獲勝！` : "比賽結束"}</div>
        <div className={styles.settlementScore}>
          {win === HUMAN ? "🏆 你贏下了這場比賽" : win !== null ? "對手拿下了這場比賽" : ""}
          <br />
          剩餘 Set 卡：{props.schools[0]} {props.setCards[0]}－{props.setCards[1]} {props.schools[1]}
        </div>
        <button className={styles.btn} onClick={props.onRematch}>
          再來一場（同牌組）
        </button>
        <button className={styles.btnGhost} onClick={props.onExit}>
          換牌組
        </button>
      </div>
    </div>
  );
}
