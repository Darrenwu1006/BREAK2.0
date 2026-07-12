// M9-P0 演出事件層契約（docs/M9_UI_LAB_SPEC.md §1）：renderer 無關的演出指令流。
// 消費者只依賴「陣列順序＝演出順序」；事件如何導出（state diff／log）是 derive.ts 內部事務。
// [Claude 2026-07-10] CP1 定稿：與 spec §1.1 的出入見 WORKLOG（point-scored 併入 set-won、
// judge 拆三拍、faceUp→visibility 三值、新增 turn-started/defense-chosen/lost-declared/guts-paid）。

import type { Decision, PlayerId } from "../../engine/types";

/** 區域 id：沿用引擎 PlayerState 區域名（blockSides 拆單數表意） */
export type ZoneId =
  | "deck"
  | "hand"
  | "setArea"
  | "drop"
  | "eventArea"
  | "serve"
  | "blockCenter"
  | "blockSide"
  | "receive"
  | "toss"
  | "attack";

/** 區域參照：renderer 無關座標系 */
export interface ZoneRef {
  player: PlayerId;
  zone: ZoneId;
  /** 疊放區層位（尾端=最上面=キャラ，其下=ガッツ）；僅 serve/blockCenter/receive/toss/attack 有值 */
  depth?: number;
}

/** 卡片可見度：renderer 依觀者視角決定正背面。
 *  public=一律正面；owner=僅持有者視角正面；hidden=一律背面 */
export type Visibility = "public" | "owner" | "hidden";

export type MoveReason =
  | "deploy" // 登場（手牌/棄牌/牌組→場）
  | "draw" // 抽牌
  | "guts" // 被壓成ガッツ（同區失去頂位）
  | "pay-guts" // 付ガッツ cost → 棄牌
  | "drop" // 其他棄牌（cost 棄手牌、側邊攔網手清理…）
  | "mulligan" // 換牌回牌組
  | "set-pick" // インターバル從 Set 區拿卡
  | "set-place" // 開局 Set 卡配置
  | "effect"; // 其他效果移動（檢索/回收/區間移動…）

export interface CardMovedEvent {
  kind: "card-moved";
  uid: number;
  cardId: string;
  from: ZoneRef;
  to: ZoneRef;
  visibility: Visibility;
  reason: MoveReason;
  /** 換牌補抽使用較快的逐張發牌節奏。 */
  motion?: "mulligan-deal";
}

export type PresentationEvent =
  | CardMovedEvent
  | { kind: "card-group-moved"; moves: CardMovedEvent[]; reason: "mulligan-return" }
  | { kind: "deck-shuffled"; player: PlayerId }
  | { kind: "op-revealed"; player: PlayerId; source: "serve" | "block" | "attack"; value: number }
  | { kind: "dp-revealed"; player: PlayerId; source: "block" | "receive"; value: number }
  | { kind: "judge-revealed"; defense: "block" | "receive"; defender: PlayerId; opValue: number; dpValue: number; success: boolean }
  | { kind: "skill-declared"; player: PlayerId; uid: number; name: string }
  | { kind: "event-played"; player: PlayerId; uid: number; name: string }
  | { kind: "guts-paid"; player: PlayerId; count: number }
  | { kind: "lost-declared"; player: PlayerId }
  | { kind: "set-won"; winner: PlayerId; loser: PlayerId; setNo: number; loserSetRemaining: number }
  | { kind: "match-won"; winner: PlayerId; loser: PlayerId }
  | { kind: "turn-started"; player: PlayerId; setNo: number; turnNo: number; turnKind: "serve" | "normal" }
  | { kind: "defense-chosen"; player: PlayerId; choice: "block" | "receive" }
  | { kind: "decision-requested"; player: PlayerId; decisionType: Decision["type"]; prompt?: string };
