// M9-P0 headless 文字 renderer（spec §1.2 驗收用）：把演出事件流 render 成人讀腳本，
// 對照引擎 log 人工抽查一致——renderer 無關性的最便宜證明。全知視角（顯示所有卡名，
// 非公開移動以「（蓋）」標示）。

import type { CardDb } from "../../engine/types";
import type { MoveReason, PresentationEvent, ZoneId, ZoneRef } from "./events";

export const ZONE_LABEL: Record<ZoneId, string> = {
  deck: "牌組",
  hand: "手牌",
  setArea: "Set 區",
  drop: "棄牌區",
  eventArea: "事件區",
  serve: "發球區",
  blockCenter: "中央攔網",
  blockSide: "側邊攔網",
  receive: "接球區",
  toss: "托球區",
  attack: "攻擊區",
};

const REASON_LABEL: Record<MoveReason, string> = {
  deploy: "登場",
  draw: "抽牌",
  guts: "成為ガッツ",
  "pay-guts": "付ガッツ",
  drop: "棄牌",
  mulligan: "換牌",
  "set-pick": "取 Set 卡",
  "set-place": "配置 Set 卡",
  effect: "效果移動",
};

const zoneText = (ref: ZoneRef): string => `P${ref.player} ${ZONE_LABEL[ref.zone]}`;

export function renderEventText(db: CardDb, event: PresentationEvent): string {
  switch (event.kind) {
    case "card-moved": {
      const name = db.get(event.cardId)?.nameJa ?? event.cardId;
      const face = event.visibility === "public" ? "" : "（蓋）";
      return `${name}${face}：${zoneText(event.from)} → ${zoneText(event.to)}【${REASON_LABEL[event.reason]}】`;
    }
    case "op-revealed":
      return `P${event.player} OP 亮出＝${event.value}（${event.source}）`;
    case "dp-revealed":
      return `P${event.player} DP 亮出＝${event.value}（${event.source}）`;
    case "judge-revealed":
      return `判定揭示：DP ${event.dpValue} vs OP ${event.opValue} → ${event.success ? "防守成功" : "防守失敗"}（P${event.defender} ${event.defense === "block" ? "攔網" : "接球"}）`;
    case "skill-declared":
      return `P${event.player} 宣言技能：${event.name}`;
    case "event-played":
      return `P${event.player} 打出事件卡：${event.name}`;
    case "guts-paid":
      return `P${event.player} 支付ガッツ ×${event.count}`;
    case "lost-declared":
      return `P${event.player} 宣告 Lost！`;
    case "set-won":
      return `P${event.winner} 拿下 Set ${event.setNo}！（P${event.loser} 剩餘 Set 卡 ${event.loserSetRemaining}）`;
    case "match-won":
      return `P${event.winner} 獲勝！`;
    case "turn-started":
      return `── Set ${event.setNo}・Turn ${event.turnNo}（P${event.player}${event.turnKind === "serve" ? "・發球" : ""}）──`;
    case "defense-chosen":
      return `P${event.player} 選擇${event.choice === "block" ? "攔網" : "接球"}`;
    case "decision-requested":
      return `⏸ 等待 P${event.player}：${event.decisionType}${event.prompt ? `（${event.prompt}）` : ""}`;
  }
}

export function renderScript(db: CardDb, events: PresentationEvent[]): string[] {
  return events.map((event) => renderEventText(db, event));
}
