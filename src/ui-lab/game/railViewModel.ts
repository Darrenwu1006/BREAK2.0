// CP6-0：decision-first rail 的純 view-model。
// 只讀共用 GameState／CardDb，不保存規則狀態，也不自行判定合法性。

import type { Card } from "../../data/types";
import { effParam, type DeployLegalityCode } from "../../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../../engine/types";

export interface RailPlayerSummary {
  player: PlayerId;
  label: string;
  hand: number;
  deck: number;
  drop: number;
  set: number;
  role: "行動" | "等待" | "勝利" | "落敗";
}

export interface RallyStepView {
  id: "serve" | "defense" | "block" | "receive" | "toss" | "attack" | "judge";
  label: string;
  status: "done" | "current" | "upcoming";
}

export interface BattleRailView {
  players: [RailPlayerSummary, RailPlayerSummary];
  actionPlayer: PlayerId;
  actionLabel: string;
  phaseLabel: string;
  op: { owner: PlayerId; value: number } | null;
  dp: { owner: PlayerId; value: number } | null;
  judge: "成功" | "突破" | null;
  rally: RallyStepView[];
  recentEvents: string[];
}

export interface CardInspectView {
  uid: number;
  card: Card;
  title: string;
  subtitle: string;
  params: { label: string; base: number | null; effective: number | null }[];
  selectable: boolean;
  unavailableReason: string | null;
  unavailableReasons: string[];
}

const PHASE_LABEL: Record<GameState["phase"], string> = {
  setup: "開局準備",
  serve: "發球",
  start: "防守選擇",
  block: "攔網",
  draw: "接球準備",
  receive: "接球",
  toss: "托球",
  attack: "攻擊",
  end: "回合結束",
  lostSet: "Lost 結算",
  interval: "Set 間隔",
  gameOver: "比賽結束",
};

const RALLY_LABEL: Record<RallyStepView["id"], string> = {
  serve: "發球",
  defense: "防守選擇",
  block: "攔網",
  receive: "接球",
  toss: "托球",
  attack: "攻擊",
  judge: "判定",
};

function rallyView(state: GameState): RallyStepView[] {
  const ids: RallyStepView["id"][] = state.defenseChoice === "block"
    ? ["serve", "defense", "block", "judge"]
    : state.defenseChoice === "receive"
      ? ["serve", "defense", "receive", "toss", "attack", "judge"]
      : ["serve", "defense"];

  let current: RallyStepView["id"] = "serve";
  switch (state.phase) {
    case "start": current = "defense"; break;
    case "block": current = state.sub >= 2 ? "judge" : "block"; break;
    case "draw":
    case "receive": current = state.phase === "receive" && state.sub >= 2 ? "judge" : "receive"; break;
    case "toss": current = "toss"; break;
    case "attack": current = "attack"; break;
    case "end":
    case "lostSet":
    case "interval":
    case "gameOver": current = "judge"; break;
    default: current = "serve";
  }
  const completed = ["end", "lostSet", "interval", "gameOver"].includes(state.phase);
  const currentIndex = completed ? ids.length : Math.max(0, ids.indexOf(current));
  return ids.map((id, index) => ({
    id,
    label: RALLY_LABEL[id],
    status: index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming",
  }));
}

export function buildBattleRailView(state: GameState, labels: [string, string]): BattleRailView {
  const actionPlayer = state.phase === "gameOver" && state.winner !== null ? state.winner : (state.pendingDecision?.player ?? state.turnPlayer);
  const summary = (player: PlayerId): RailPlayerSummary => ({
    player,
    label: labels[player],
    hand: state.players[player].hand.length,
    deck: state.players[player].deck.length,
    drop: state.players[player].drop.length,
    set: state.players[player].setArea.length,
    role: state.phase === "gameOver"
      ? player === state.winner ? "勝利" : "落敗"
      : player === actionPlayer ? "行動" : "等待",
  });
  const recentEvents = state.log
    .filter((entry) => !entry.text.startsWith("──"))
    .slice(-3)
    .map((entry) => entry.text);
  return {
    players: [summary(0), summary(1)],
    actionPlayer,
    actionLabel: state.pendingDecision ? decisionLabel(state.pendingDecision.type) : state.phase === "gameOver" ? "已結束" : "規則結算中",
    phaseLabel: PHASE_LABEL[state.phase],
    op: state.op ? { owner: state.op.owner, value: state.op.value } : null,
    dp: state.dp ? { owner: state.dp.owner, value: state.dp.value } : null,
    judge: state.judgeSuccess === null ? null : state.judgeSuccess ? "成功" : "突破",
    rally: rallyView(state),
    recentEvents,
  };
}

function decisionLabel(type: Decision["type"]): string {
  const labels: Record<Decision["type"], string> = {
    "serve-rights": "選擇發球權",
    mulligan: "選擇換牌",
    "deploy-serve": "發球登場",
    "deploy-block": "攔網登場",
    "deploy-receive": "接球登場",
    "deploy-toss": "托球登場",
    "deploy-attack": "攻擊登場",
    "defense-choice": "選擇防守路線",
    free: "自由步驟",
    "resolve-pending": "決定技能順序",
    "effect-confirm": "確認技能",
    "effect-cards": "選擇卡片",
    "effect-option": "選擇效果",
    "pick-set-card": "選擇 Set 卡",
  };
  return labels[type];
}

/**
 * selectableUids 必須由 engine legal helper 產生；本函式只把權威結果翻成 UI 語言。
 * CP6A 再把 engine 的結構化 reason 接入 unavailableReason，不在此重寫規則。
 */
export function buildCardInspectView(
  db: CardDb,
  state: GameState,
  uid: number,
  selectableUids: ReadonlySet<number>,
  hasActiveCardDecision: boolean,
  detailedUnavailableReason?: string | readonly string[] | null,
): CardInspectView | null {
  const card = db.get(state.cards[uid] ?? "");
  if (!card) return null;
  const paramKeys = ["serve", "block", "receive", "toss", "attack"] as const;
  const labels = ["發球", "攔網", "接球", "托球", "攻擊"];
  const selectable = selectableUids.has(uid);
  return {
    uid,
    card,
    title: card.nameZh ?? card.nameJa,
    subtitle: card.nameZh ? card.nameJa : card.affiliations.join("・"),
    params: paramKeys.map((key, index) => ({
      label: labels[index]!,
      base: card.params?.[key] ?? null,
      effective: card.type === "CHARACTER" ? effParam(db, state, uid, key) : null,
    })),
    selectable,
    unavailableReason: hasActiveCardDecision && !selectable
      ? (Array.isArray(detailedUnavailableReason) ? detailedUnavailableReason[0] : detailedUnavailableReason) ?? "目前決策不可選"
      : null,
    unavailableReasons: hasActiveCardDecision && !selectable
      ? Array.isArray(detailedUnavailableReason) ? [...detailedUnavailableReason] : [detailedUnavailableReason ?? "目前決策不可選"]
      : [],
  };
}

export function deployLegalityText(code: DeployLegalityCode | "block-limit" | null): string | null {
  switch (code) {
    case "not-character": return "事件卡不能登場到角色區";
    case "no-area-param": return "這張卡在此位置的數值為「－」";
    case "area-restricted": return "目前效果禁止在此位置登場";
    case "base-param-restricted": return "卡面基礎數值不符合目前登場限制";
    case "position-restricted": return "目前效果禁止此位置標籤的角色登場";
    case "same-name": return "與相鄰階段角色同名，不能登場";
    case "block-limit": return "本回合可登場的攔網人數已達上限";
    default: return null;
  }
}
