// 遊戲狀態模型（規格依據 docs/RULES_SPEC.md；條文編號同官方総合ルール）
// 設計原則：純資料（可 structuredClone）、引擎推進到需要玩家決策時停下（pendingDecision）

import type { Card } from "../data/types";

/** 卡片靜態資料查詢表（id → Card） */
export type CardDb = ReadonlyMap<string, Card>;

export type PlayerId = 0 | 1;

/** 實體卡（同一卡片編號可有多張實體）。uid 全局唯一。 */
export interface CardInstance {
  uid: number;
  cardId: string;
}

/**
 * コート的一個疊放區：陣列尾端＝最上面＝キャラ（†1-2-14），其下為ガッツ（†1-2-15）。
 */
export type Stack = number[]; // uid 列表

export interface PlayerState {
  deck: number[]; // 索引 0 = 牌組頂
  hand: number[];
  setArea: number[]; // 背面朝下
  drop: number[]; // 尾端 = 最上面
  eventArea: number[];
  serve: Stack;
  /** センターブロッカー置き場（疊放） */
  blockCenter: Stack;
  /** サイドブロッカー（不疊放、最多 2，ブロックフェイズ終了時進棄牌區）†3-6 */
  blockSides: number[];
  receive: Stack;
  toss: Stack;
  attack: Stack;
}

export type Phase =
  | "setup"
  | "serve"
  | "start"
  | "block"
  | "draw"
  | "receive"
  | "toss"
  | "attack"
  | "end"
  | "lostSet"
  | "interval"
  | "gameOver";

/** 算出後的 OP/DP：與來源角色參數脫鉤的獨立數值（†5-17-7, †5-18-6） */
export interface PointValue {
  value: number;
  owner: PlayerId;
  /** 產生來源（serve/block/attack；DP 為 block/receive），效果系統會參照 */
  source: "serve" | "block" | "attack" | "receive";
}

// ---- 決策（引擎停下來等玩家輸入的點）----

export type Decision =
  | { type: "serve-rights"; take: boolean } // 遊戲前手順：要不要首發球權 †4-2-1-2
  | { type: "mulligan"; returnUids: number[] } // 換牌（可空陣列＝不換）†4-2-1-4
  | { type: "deploy-serve"; uid: number | null } // null = 不登場 → 自動 Lost †1-4-9-1
  | { type: "deploy-block"; uids: number[]; center: number } // 1~3 張、center 必在 uids 中
  | { type: "deploy-block"; uids: null } // 不登場 → Lost（以 uids:null 表示）
  | { type: "deploy-receive"; uid: number | null }
  | { type: "deploy-toss"; uid: number | null }
  | { type: "deploy-attack"; uid: number | null }
  | { type: "defense-choice"; choice: "block" | "receive" } // スタートフェイズ †5-6
  | { type: "free"; action: "pass" | "lost" } // 自由步驟（M2：尚無技能/事件卡）†5-14
  | { type: "pick-set-card"; index: number }; // インターバル③ 從 Set 區拿 1 張 †5-3

export interface PendingDecision {
  player: PlayerId;
  type: Decision["type"];
}

export interface LogEntry {
  setNo: number;
  turnNo: number;
  player: PlayerId | null;
  text: string;
}

export interface GameState {
  rngState: number;
  /** uid → cardId（實體卡對照表） */
  cards: Record<number, string>;
  players: [PlayerState, PlayerState];
  setNo: number; // 1 起算
  turnNo: number; // 該 set 內的 turn 序號
  turnPlayer: PlayerId;
  /** 本 set 的發球權玩家 †1-2-4 */
  servingPlayer: PlayerId;
  phase: Phase;
  /** 目前 phase 內的子步驟索引（引擎內部游標） */
  sub: number;
  /** 場上的 OP / DP（不存在時為 null） */
  op: PointValue | null;
  dp: PointValue | null;
  /** start phase 選的防守路線（攔網 turn 或接球 turn） */
  defenseChoice: "block" | "receive" | null;
  /** 宣告 Lost 的玩家（lostSet/interval 期間有值） */
  lostBy: PlayerId | null;
  pendingDecision: PendingDecision | null;
  winner: PlayerId | null;
  /** 遊戲前手順進度（mulligan 順序等） */
  setupStage: "serve-rights" | "mulligan-first" | "mulligan-second" | "done";
  log: LogEntry[];
}
