// [Claude 2026-07-24] 候選 D：決策的顯示詞彙——跨切面呈現層（UI＋AI＋tools 共用），與規則（engine）分屬兩層。
// 收斂原本散在 5 處、互相漂移的 decisionLabel：
//   describeDecision(db, state, decision, verbosity) — 描述一個具體決策，3 級詳略。
//   decisionTypeLabel(type) — 吃 decision.type 回「提示名」（phase 提示，非某個選擇）。
// 卡名一律用中文優先名（nameZh || nameJa，同 CardView.displayName）；named/verbose 兩級用之。
// named 級用字定案（[使用者 2026-07-24]）：mulligan/effect-cards 列卡名、effect-confirm「使用 / 接受」「不使用 / 拒絕」、
//   effect-option 無標籤時 1-based、pick-set-card「拿取」。short（原 Game.tsx）與 verbose（原 replay-board，順帶修正
//   其 nameOf 參數順序 bug）各自沿用原格式。

import type { CardDb, Decision, GameState } from "../engine/types";

export type DecisionVerbosity = "short" | "named" | "verbose";

// 中文優先名（＝CardView.displayName）；verbose 用之。
function nm(db: CardDb, state: GameState, uid: number | null | undefined): string {
  if (uid == null) return "(無)";
  const card = db.get(state.cards[uid] ?? "");
  return card ? card.nameZh || card.nameJa : `uid ${uid}`;
}

// named 用之：中文優先名＋〔短卡號〕，避免同名卡版本混淆（原 coach.cardName；coach.test 鎖定、多數 AI/tool 消費點依賴）。
function namedName(db: CardDb, state: GameState, uid: number | null | undefined): string {
  if (uid == null) return "(無)";
  const id = state.cards[uid];
  if (!id) return `uid ${uid}`;
  const card = db.get(id);
  const name = card?.nameZh || card?.nameJa || id;
  const shortId = id.split("-").at(-1);
  return shortId ? `${name}〔${shortId}〕` : name;
}

// ---- short：不帶卡名（原 Game.tsx）----
function shortLabel(decision: Decision): string {
  switch (decision.type) {
    case "serve-rights": return decision.take ? "取得發球權" : "讓出發球權";
    case "mulligan": return decision.returnUids.length ? `換牌 ${decision.returnUids.length} 張` : "不換牌";
    case "deploy-serve": return decision.uid === null ? "不登場發球" : "發球登場";
    case "deploy-receive": return decision.uid === null ? "不登場接球" : "接球登場";
    case "deploy-toss": return decision.uid === null ? "不登場托球" : "托球登場";
    case "deploy-attack": return decision.uid === null ? "不登場攻擊" : "攻擊登場";
    case "deploy-block": return decision.uids === null ? "不登場攔網" : `攔網登場 ${decision.uids.length} 張`;
    case "defense-choice": return decision.choice === "block" ? "選擇攔網" : "選擇接球";
    case "free": return decision.action === "pass" ? "Pass" : decision.action === "lost" ? "宣告 Lost" : decision.action === "skill" ? "使用技能" : "打出事件";
    case "resolve-pending": return "選擇待機技能";
    case "effect-confirm": return decision.accept ? "使用效果" : "不使用效果";
    case "effect-cards": return `選卡 ${decision.uids.length} 張`;
    case "effect-option": return "選擇效果選項";
    case "pick-set-card": return "拿取 Set 卡";
  }
}

// ---- named：帶卡名的中詳細度（原 coach + GamePanels，用字定案）----
function namedLabel(db: CardDb, state: GameState, decision: Decision): string {
  const n = (uid: number | null | undefined) => namedName(db, state, uid);
  switch (decision.type) {
    case "serve-rights": return decision.take ? "取得首次發球權" : "讓出首次發球權";
    case "mulligan": return decision.returnUids.length ? `換掉 ${decision.returnUids.map(n).join("、")}` : "不換牌";
    case "defense-choice": return decision.choice === "block" ? "選擇攔網" : "選擇接球";
    case "free":
      if (decision.action === "pass") return "自由步驟 Pass";
      if (decision.action === "lost") return "主動 Lost";
      return decision.action === "event" ? `使用事件 ${n(decision.uid)}` : `使用技能 ${n(decision.uid)}`;
    case "resolve-pending": return `解決待機效果 #${decision.id}`;
    case "effect-confirm": return decision.accept ? "使用 / 接受" : "不使用 / 拒絕";
    case "effect-cards": return decision.uids.length ? `選 ${decision.uids.map(n).join("、")}` : "不選卡";
    case "effect-option": return `選項：${state.pendingDecision?.options?.[decision.index] ?? decision.index + 1}`;
    case "pick-set-card": return `拿取 Set 卡 #${decision.index + 1}`;
    case "deploy-block": return decision.uids === null ? "不登場攔網" : `攔網 ${decision.uids.map(n).join("、")}`;
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack":
      return decision.uid === null ? "不登場角色" : `登場 ${n(decision.uid)}`;
  }
}

// ---- verbose：最詳盡（原 replay-board）。卡名用中文優先名（原 replay-board 用其本地 nameOf，格式等價）----
function verboseLabel(db: CardDb, state: GameState, decision: Decision): string {
  const n = (uid: number | null | undefined) => nm(db, state, uid);
  switch (decision.type) {
    case "serve-rights": return decision.take ? "取得首次發球權" : "讓出首次發球權";
    case "mulligan":
      return decision.returnUids.length === 0
        ? "不換牌"
        : `換牌 ${decision.returnUids.length} 張（${decision.returnUids.map(n).join("、")}）`;
    case "deploy-serve": return decision.uid == null ? "發球區不登場 → 宣告 Lost" : `發球登場 ${n(decision.uid)}`;
    case "deploy-receive": return decision.uid == null ? "接球區不登場 → 宣告 Lost" : `接球登場 ${n(decision.uid)}`;
    case "deploy-toss": return decision.uid == null ? "托球區不登場 → 宣告 Lost" : `托球登場 ${n(decision.uid)}`;
    case "deploy-attack": return decision.uid == null ? "攻擊區不登場 → 宣告 Lost" : `攻擊登場 ${n(decision.uid)}`;
    case "deploy-block": {
      if (decision.uids == null) return "不攔網 → 宣告 Lost";
      const others = decision.uids.filter((uid) => uid !== decision.center);
      const rest = others.length ? `，其餘 ${others.map(n).join("、")}` : "";
      return `攔網 ${decision.uids.length} 張（中央＝${n(decision.center)}${rest}）`;
    }
    case "defense-choice": return decision.choice === "block" ? "防守選擇：攔網" : "防守選擇：接球";
    case "free":
      if (decision.action === "pass") return "自由步驟：Pass";
      if (decision.action === "lost") return "自由步驟：主動宣告 Lost";
      if (decision.action === "skill") return `使用技能：${n(decision.uid)}（技能#${decision.skillIndex}）`;
      return `打出事件：${n(decision.uid)}`;
    case "resolve-pending": return `解決待機技能 #${decision.id}`;
    case "effect-confirm": return decision.accept ? "效果：接受" : "效果：拒絕／不使用";
    case "effect-cards": return decision.uids.length === 0 ? "效果選卡：不選" : `效果選卡：${decision.uids.map(n).join("、")}`;
    case "effect-option": return `效果選項：#${decision.index}`;
    case "pick-set-card": return `撿 Set 卡：#${decision.index}`;
  }
}

/** 描述一個具體決策。verbosity 預設 named。 */
export function describeDecision(db: CardDb, state: GameState, decision: Decision, verbosity: DecisionVerbosity = "named"): string {
  switch (verbosity) {
    case "short": return shortLabel(decision);
    case "verbose": return verboseLabel(db, state, decision);
    default: return namedLabel(db, state, decision);
  }
}

/** short 級不需卡名 → 免傳 db/state 的便捷入口（給無盤面上下文的 UI 摘要函式）。 */
export function describeDecisionShort(decision: Decision): string {
  return shortLabel(decision);
}

const DECISION_TYPE_LABELS: Record<Decision["type"], string> = {
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

/** 吃 decision.type 回「提示名」（phase 提示，非某個具體選擇）。 */
export function decisionTypeLabel(type: Decision["type"]): string {
  return DECISION_TYPE_LABELS[type];
}
