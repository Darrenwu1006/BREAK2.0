// 盤面提取器（M8 Phase E 復盤教練 skill，塊 2）。
// 把單一 replay entry 的盤面攤成卡名文字，供教練做單手決策覆盤時引用精確牌況，
// 而不必把 12MB replay 全載入 context。所有數值直接讀引擎已算好的狀態（state.op/dp、
// 各區疊放、nameOverrides），不自行重算 → 對齊接地契約（spec §2）。

import type { Card } from "../data/types";
import type { CardDb, Decision, GameState, PlayerId, PointValue, Stack } from "../engine/types";
import { replayEntryLogs, type ReplayEntry, type ReplaySession } from "../ui/replayHistory";

const PLAYER_LABEL: Record<PlayerId, string> = { 0: "玩家", 1: "AI" };

/** 與 UI displayName 同義，但不依賴 React/UI 模組（避免把 UI 拖進 CLI）。 */
function displayName(card: Card | undefined, cardId: string | undefined): string {
  if (!card) return cardId ? `??(${cardId})` : "??";
  return card.nameZh || card.nameJa;
}

/** 角色 base 參數 [發/攔/接/托/攻]；null（「－」）原樣顯示。 */
function paramTriplet(card: Card | undefined): string {
  if (!card?.params) return "";
  const f = (v: number | null) => (v === null ? "－" : String(v));
  const p = card.params;
  return `[${f(p.serve)}/${f(p.block)}/${f(p.receive)}/${f(p.toss)}/${f(p.attack)}]`;
}

/** 實體卡名（含 072/073 等登場改名）。 */
function nameOf(state: GameState, db: CardDb, uid: number): string {
  const override = state.nameOverrides?.[uid];
  if (override) return override;
  const cardId = state.cards[uid];
  return displayName(cardId ? db.get(cardId) : undefined, cardId);
}

/** 卡標籤：角色＝名＋參數＋✦(有技能)；事件＝名(事件)。 */
function cardLabel(state: GameState, db: CardDb, uid: number): string {
  const cardId = state.cards[uid];
  const card = cardId ? db.get(cardId) : undefined;
  const name = nameOf(state, db, uid);
  if (!card) return name;
  if (card.type === "EVENT") return `${name}(事件)`;
  return `${name}${paramTriplet(card)}${card.skillJa ? "✦" : ""}`;
}

/** 疊放區：尾端＝最上面＝キャラ，其下計為ガッツ張數（†1-2-14/15）。 */
function stackLabel(state: GameState, db: CardDb, stack: Stack): string {
  if (stack.length === 0) return "－";
  const top = stack[stack.length - 1]!;
  const guts = stack.length - 1;
  return `${cardLabel(state, db, top)}${guts > 0 ? `（+${guts} ガッツ）` : ""}`;
}

function listLabel(state: GameState, db: CardDb, uids: readonly number[]): string {
  if (uids.length === 0) return "－";
  return uids.map((uid) => cardLabel(state, db, uid)).join("、");
}

function pointStr(pv: PointValue | null): string {
  return pv ? `${pv.value}（owner P${pv.owner}, source ${pv.source}）` : "－";
}

/** 把一個 Decision 轉成人類可讀字串（triage headline 與 board 共用）。 */
export function decisionLabel(state: GameState, db: CardDb, decision: Decision): string {
  const n = (uid: number | null | undefined) => (uid == null ? "(無)" : nameOf(state, db, uid));
  switch (decision.type) {
    case "serve-rights":
      return decision.take ? "取得首次發球權" : "讓出首次發球權";
    case "mulligan":
      return decision.returnUids.length === 0
        ? "不換牌"
        : `換牌 ${decision.returnUids.length} 張（${decision.returnUids.map(n).join("、")}）`;
    case "deploy-serve":
      return decision.uid == null ? "發球區不登場 → 宣告 Lost" : `發球登場 ${n(decision.uid)}`;
    case "deploy-receive":
      return decision.uid == null ? "接球區不登場 → 宣告 Lost" : `接球登場 ${n(decision.uid)}`;
    case "deploy-toss":
      return decision.uid == null ? "托球區不登場 → 宣告 Lost" : `托球登場 ${n(decision.uid)}`;
    case "deploy-attack":
      return decision.uid == null ? "攻擊區不登場 → 宣告 Lost" : `攻擊登場 ${n(decision.uid)}`;
    case "deploy-block": {
      if (decision.uids == null) return "不攔網 → 宣告 Lost";
      const others = decision.uids.filter((uid) => uid !== decision.center);
      const rest = others.length ? `，其餘 ${others.map(n).join("、")}` : "";
      return `攔網 ${decision.uids.length} 張（中央＝${n(decision.center)}${rest}）`;
    }
    case "defense-choice":
      return decision.choice === "block" ? "防守選擇：攔網" : "防守選擇：接球";
    case "free":
      if (decision.action === "pass") return "自由步驟：Pass";
      if (decision.action === "lost") return "自由步驟：主動宣告 Lost";
      if (decision.action === "skill") return `使用技能：${n(decision.uid)}（技能#${decision.skillIndex}）`;
      return `打出事件：${n(decision.uid)}`;
    case "resolve-pending":
      return `解決待機技能 #${decision.id}`;
    case "effect-confirm":
      return decision.accept ? "效果：接受" : "效果：拒絕／不使用";
    case "effect-cards":
      return decision.uids.length === 0 ? "效果選卡：不選" : `效果選卡：${decision.uids.map(n).join("、")}`;
    case "effect-option":
      return `效果選項：#${decision.index}`;
    case "pick-set-card":
      return `撿 Set 卡：#${decision.index}`;
    default:
      return JSON.stringify(decision);
  }
}

/** 渲染單一 entry 的盤面（用 before 狀態＝決策當下面對的局面）＋實際決策＋該步 log。 */
export function renderEntry(db: CardDb, entry: ReplayEntry): string {
  const s = entry.before;
  const lines: string[] = [];
  lines.push(
    `═══ 第 ${entry.index + 1} 步｜Set ${entry.setNo} Turn ${entry.turnNo}｜${entry.phase} phase｜` +
      `決策者：${PLAYER_LABEL[entry.player]}(P${entry.player})｜${entry.pendingType}｜來源：${entry.source} ═══`,
  );
  lines.push("（角色參數＝[發/攔/接/托/攻]，✦＝有技能）");
  for (const p of [0, 1] as PlayerId[]) {
    const ps = s.players[p];
    lines.push(`【${PLAYER_LABEL[p]} P${p}】手牌(${ps.hand.length})：${listLabel(s, db, ps.hand)}`);
    lines.push(
      `  發球：${stackLabel(s, db, ps.serve)}｜接球：${stackLabel(s, db, ps.receive)}｜` +
        `托球：${stackLabel(s, db, ps.toss)}｜攻擊：${stackLabel(s, db, ps.attack)}`,
    );
    lines.push(
      `  攔網中央：${stackLabel(s, db, ps.blockCenter)}｜攔網側邊：${listLabel(s, db, ps.blockSides)}｜` +
        `事件區：${listLabel(s, db, ps.eventArea)}`,
    );
    lines.push(`  牌庫：${ps.deck.length}｜棄牌：${ps.drop.length}｜Set區：${ps.setArea.length}`);
  }
  lines.push(`OP：${pointStr(s.op)}｜DP：${pointStr(s.dp)}`);
  lines.push(`決策：${decisionLabel(s, db, entry.decision)}`);
  const logs = replayEntryLogs(entry);
  if (logs.length) {
    lines.push(`log[${entry.logStart}..${entry.logEnd}]：`);
    for (const log of logs) lines.push(`  ${log.text}`);
  }
  return lines.join("\n");
}

/** 第 step 步（1-based，與 CLI「第 N 步」一致）的盤面。 */
export function renderEntryBoard(db: CardDb, session: ReplaySession, step: number): string {
  const entry = session.entries[step - 1];
  if (!entry) return `找不到第 ${step} 步（本場共 ${session.entries.length} 步）`;
  return renderEntry(db, entry);
}

/** 一段步數範圍 [from, to]（1-based，含端點）的盤面。 */
export function renderBoardRange(db: CardDb, session: ReplaySession, from: number, to: number): string {
  const lo = Math.max(1, Math.min(from, to));
  const hi = Math.min(session.entries.length, Math.max(from, to));
  if (lo > session.entries.length) return `找不到第 ${from} 步（本場共 ${session.entries.length} 步）`;
  const blocks: string[] = [];
  for (let step = lo; step <= hi; step++) blocks.push(renderEntryBoard(db, session, step));
  return blocks.join("\n\n");
}
