// 遊戲狀態模型（規格依據 docs/RULES_SPEC.md；條文編號同官方総合ルール）
// 設計原則：純資料（可 structuredClone）、引擎推進到需要玩家決策時停下（pendingDecision）

import type { Card } from "../data/types";
import type { Action, Cost, CourtArea, DelayedTrigger, ParamName } from "./dsl";

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

// ---- 效果系統（M3）----

/** 數值修正層（†6-10-1 第 3 層；期限＝クリンナップ或對象非キャラ化 †6-10-3）。
 *  kind "set"＝固定值（後續 add 依解決順序再疊加 †0-2-12） */
export interface Modifier {
  target: number; // uid
  param: ParamName;
  amount: number;
  kind?: "set";
  source: number; // 發生源 uid
}

/** 遲發監看（watch action 註冊；期限内每次觸發＝待機一次 †6-6-1①） */
export interface Watcher {
  id: number;
  player: PlayerId; // master
  source: number;
  trigger: DelayedTrigger;
  actions: Action[];
  /** 有效視窗（同一 Set 內的 turnNo 範圍；跨 Set 即失效 †7-4-1） */
  setNo: number;
  turnMin: number;
  turnMax: number;
  /** turnEnd 觸發已於該 turn 待機過（†5-12-2① 不重複待機） */
  firedTurn?: number;
  remainingTriggers?: number;
  desc: string;
}

/** 限制（「次の相手のターン中、…できない」；效果登場也受限 Q191/Q204） */
export interface Restriction {
  player: PlayerId; // 受限玩家
  area?: CourtArea;
  /** 登場人數上限（0=禁止） */
  maxCount?: number;
  /** 禁止元々の param ≥ value 的キャラ登場 */
  banBaseParamMin?: { param: ParamName; value: number };
  /** 「スキルでカードを手札に加えられない」（P01-035；Q239~241） */
  banHandAdd?: true;
  /** maxCount 只計手札からの登場（P02-020） */
  fromHandOnly?: true;
  /** センターブロッカーのブロックP無視（Q372；P02-027） */
  negateCenterBlock?: true;
  /** ワンタッチ(N) 無效（Q356；P02-016） */
  banOneTouch?: true;
  /** [=レシーブフェイズ][=手札] 主動技無效（Q357；P02-016） */
  banHandReceiveActive?: true;
  /** 禁止指定ポジション登場（P01-084/P02-097；搭配 fromHandOnly） */
  banPositions?: string[];
  disableSkills?: import("./dsl").CharaFilter;
  banEventTimings?: import("./dsl").PhaseIcon[];
  preventOpDecrease?: true;
  /** 「DPがN以下→ブロック失敗」追加判定失敗條件（†5-15-3；P02-039） */
  blockFailIfDpMax?: number;
  setNo: number;
  activeTurn: number;
  desc: string;
}

/** 待機狀態（パッシブ型／遲發效果，CP 中解決 †5-4） */
export interface PendingItem {
  id: number;
  player: PlayerId; // master
  source: number;
  kind: "passive" | "delayed";
  /** passive：發生源 EffectDef.skills 的索引 */
  skillIndex?: number;
  /** delayed：要執行的 action 快照 */
  actions?: Action[];
  /** 觸發卡（「登場するたび、そのキャラ」） */
  triggerUid?: number;
  /** 登場觸發的來源領域（deployedFromHand 條件用；Q202） */
  origin?: "hand" | "other";
  /** 效果登場的來源卡名（「どん ぴしゃり」のスキルで登場 P02-016/020） */
  byCard?: string;
  desc: string;
}

/** ターン1 無效化記錄（†9-6：該 turn 中同卡名的自己的卡技能無效） */
export interface Turn1Entry {
  player: PlayerId;
  name: string;
  setNo: number;
  turnNo: number;
}

/** 引擎內部 action（cost 支付）；與 DSL Action 共用執行管線 */
export type RtAction = Action | { op: "_payGuts"; count: number } | { op: "_payGutsAny"; count: number } | { op: "_payGutsFrom"; areas: CourtArea[]; count: number } | { op: "_placeEventCost"; filter?: { affiliation?: string } } | { op: "_millCost"; count: number } | { op: "_dropCharaCost"; area: CourtArea; filter?: import("./dsl").CharaFilter } | { op: "_dropSelfCourt" } | { op: "_selfToDeckBottom" } | { op: "_dropHandCost"; count: number; filter?: import("./dsl").CharaFilter } | { op: "_moveOpponentEventCost"; filter?: { names?: string[]; affiliation?: string }; destination: "deckBottom" };

export interface EffectFrame {
  actions: RtAction[];
  pc: number;
}

/** 效果解決中的待輸入點 */
export type Awaiting =
  | { kind: "confirm"; what: "gate" | "mill" | "draw"; costs?: Cost[]; then: Action[]; else?: Action[]; count?: number; prompt: string }
  | {
      kind: "cards";
      purpose: "guts" | "dropHand" | "target" | "tutor" | "moveToHand" | "gutsToHand" | "gutsToHandAny" | "deployFromDrop" | "dropToHand" | "forceDrop" | "eventToHand" | "handToBottom" | "handToTop" | "deployFromGuts" | "placeEvent" | "placeEventOpponent" | "dropChara" | "dropOppGuts" | "moveGuts" | "handToGuts" | "moveOpponentEvent" | "moveOpponentEventCost";
      /** 決策者（預設＝效果 master；forceDrop＝對手）†6-11-2 */
      chooser?: PlayerId;
      candidates: number[];
      min: number;
      max: number;
      /** target 用：選定後要套用的修正 */
      param?: ParamName | "choose";
      amount?: number;
      /** deployFromDrop 用 */
      area?: CourtArea;
      destination?: "drop" | "deckBottom";
      then?: Action[];
      /** tutor 用：實際看過的卡（選中→手牌、其餘→牌組底） */
      looked?: number[];
      prompt: string;
    }
  | { kind: "option"; purpose: "param"; targetUid: number; amount: number; options: ParamName[]; prompt: string }
  /** 「以下から1つを選んで使える」：labels 與 branches 對應；optional 時尾端附「不使用」 */
  | { kind: "option"; purpose: "chooseOne"; labels: string[]; branches: Action[][]; prompt: string };

/** 效果解決 context（一次一個技能 †6-2-1；frame 堆疊處理巢狀 if/gate） */
export interface EffectCtx {
  player: PlayerId;
  source: number;
  frames: EffectFrame[];
  /** 「そのキャラ」＝最近一次選擇/登場的對象 */
  lastTarget: number | null;
  /** 遲發觸發卡 */
  triggerUid: number | null;
  /** 此次效果來自事件卡；解決完畢後才觸發「使用事件卡時」。 */
  eventSource?: true;
  origin?: "hand" | "other";
  /** 效果登場的來源卡名（deployedByCard 條件） */
  byCard?: string;
  /** 本技能解決中已加入手牌張數（addedThisSkill 條件；P02-089） */
  addedToHand?: number;
  /** cost millDeck 棄掉的 uid（milledIs 條件；P01-051） */
  milled?: number[];
  /** 本技能付出的ガッツ（paidGutsAll 條件；P02-050） */
  paidGuts?: number[];
  /** 解決完且有任一部分執行 → 套用ターン1（†9-6-3） */
  turn1: boolean;
  anyExecuted: boolean;
  awaiting: Awaiting | null;
  desc: string;
}

// ---- 決策（引擎停下來等玩家輸入的點）----

export type Decision =
  | { type: "serve-rights"; take: boolean } // 遊戲前手順：要不要首發球權 †4-2-1-2
  | { type: "mulligan"; returnUids: number[] } // 換牌（可空陣列＝不換）†4-2-1-4
  | { type: "deploy-serve"; uid: number | null; nameChoice?: string } // null = 不登場 → 自動 Lost †1-4-9-1
  | { type: "deploy-block"; uids: number[]; center: number; nameChoices?: Record<number, string> } // 1~3 張、center 必在 uids 中
  | { type: "deploy-block"; uids: null } // 不登場 → Lost（以 uids:null 表示）
  | { type: "deploy-receive"; uid: number | null; nameChoice?: string }
  | { type: "deploy-toss"; uid: number | null; nameChoice?: string }
  | { type: "deploy-attack"; uid: number | null; nameChoice?: string }
  | { type: "defense-choice"; choice: "block" | "receive" } // スタートフェイズ †5-6
  | { type: "free"; action: "pass" } // 自由步驟 †5-14
  | { type: "free"; action: "lost" }
  | { type: "free"; action: "skill"; uid: number; skillIndex: number } // 使用アクティブ型技能
  | { type: "free"; action: "event"; uid: number } // 打出事件卡 †6-8
  | { type: "resolve-pending"; id: number } // CP：選擇解決哪個待機技能 †5-4
  | { type: "effect-confirm"; accept: boolean } // 「～ば使える」等 yes/no
  | { type: "effect-cards"; uids: number[] } // 選卡（對象/付 Guts/棄手牌/檢索…）
  | { type: "effect-option"; index: number } // 選項（選參數種類…）
  | { type: "pick-set-card"; index: number }; // インターバル③ 從 Set 區拿 1 張 †5-3

export interface PendingDecision {
  player: PlayerId;
  type: Decision["type"];
  /** effect 子決策／CP 的展示資料（UI 與 AI 共用） */
  prompt?: string;
  candidates?: number[]; // effect-cards 候選 uid／resolve-pending 候選 item id
  min?: number;
  max?: number;
  options?: string[]; // effect-option 的選項標籤
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
  /** ジャッジ比較結果（block/receive phase 內部暫存） */
  judgeSuccess: boolean | null;
  /** start phase 選的防守路線（攔網 turn 或接球 turn） */
  defenseChoice: "block" | "receive" | null;
  /** 宣告 Lost 的玩家（lostSet/interval 期間有值） */
  lostBy: PlayerId | null;
  pendingDecision: PendingDecision | null;
  winner: PlayerId | null;
  /** 遊戲前手順進度（mulligan 順序等） */
  setupStage: "serve-rights" | "mulligan-first" | "mulligan-second" | "done";
  // ---- 效果系統狀態（M3）----
  modifiers: Modifier[];
  /** 072/073 登場改名（uid → 卡名；期限＝turn 終了） */
  nameOverrides: Record<number, string>;
  watchers: Watcher[];
  restrictions: Restriction[];
  pendingQueue: PendingItem[];
  turn1: Turn1Entry[];
  effectCtx: EffectCtx | null;
  /** 效果要求 Lost（ブロックアウト）；引擎主迴圈處理 */
  lostRequest: PlayerId | null;
  /** 本 turn 各玩家已登場的攔網角色數（登場限制 maxCount 是 turn 累計上限：Q191/Q196/Q204） */
  blockDeployedThisTurn: [number, number];
  /** 本 turn 各玩家「從手牌」登場的攔網角色數（fromHandOnly 限制用；P02-020） */
  blockHandDeploysThisTurn: [number, number];
  /** watcher/pending 流水號 */
  nextId: number;
  log: LogEntry[];
}
