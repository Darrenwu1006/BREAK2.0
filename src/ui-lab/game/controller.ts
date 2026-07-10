// M9a CP4 對局控制器：引擎的 ui-lab 消費者（純 TS、無 React、可單元測試）。
// 職責：state 先到位（邏輯即時）——非人類互動的決策由 heuristic 立即代打並連續推進，
// 每手 applyDecision 前後餵 derivePresentationEvents 進 PresentationTimeline；
// 演出節奏與互動閘（佇列清空前不開放操作）屬 renderer 層，本檔不管時間。
//
// M9a 人類互動範圍（spec §2 垂直切片）：deploy-serve/receive/toss/attack 拖曳登場＋defense-choice 二選一。
// 其餘決策型別（mulligan/free/effect-*/deploy-block/serve-rights/resolve-pending/pick-set-card）
// 暫由 heuristic 代打（spec §4 過渡期允許；M9b 逐型別補齊）。

import { heuristicAiDecision } from "../../ai/heuristic";
import { applyDecision, createGame } from "../../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../../engine/types";
import { derivePresentationEvents } from "../presentation/derive";
import { PresentationTimeline, type PresentationBatch } from "../presentation/timeline";

export const HUMAN: PlayerId = 0;

/** M9a 由人類親手操作的決策型別；其餘代打 */
const HUMAN_TYPES: ReadonlySet<Decision["type"]> = new Set(["deploy-serve", "deploy-receive", "deploy-toss", "deploy-attack", "defense-choice"]);

export interface BatchMeta {
  /** 這批演出開始前的盤面（演出底圖） */
  before: GameState;
  /** 這批演出結束後的盤面（card-moved 的目標擺位來源） */
  after: GameState;
  /** true＝人類的決策由 AI 代打（M9a 未實作互動的型別） */
  auto: boolean;
}

const MAX_AUTO_STEPS = 5000; // 全場 heuristic 對局遠低於此；防呆上限

export class LabGameController {
  readonly db: CardDb;
  readonly timeline = new PresentationTimeline();
  /** 權威盤面（邏輯即時；演出落後於它） */
  engine: GameState;
  private meta = new WeakMap<PresentationBatch, BatchMeta>();

  constructor(db: CardDb, decks: [string[], string[]], seed: number) {
    this.db = db;
    this.engine = createGame(db, { seed, decks });
    this.advance();
  }

  /** 是否輪到人類親手操作（不含代打型別） */
  get awaitingHuman(): boolean {
    const pd = this.engine.pendingDecision;
    return !!pd && pd.player === HUMAN && HUMAN_TYPES.has(pd.type);
  }

  metaOf(batch: PresentationBatch): BatchMeta | undefined {
    return this.meta.get(batch);
  }

  /** 人類決策入口：套用後自動推進到下一個人類互動點 */
  decide(decision: Decision): void {
    if (!this.awaitingHuman) throw new Error("目前不是人類互動決策");
    this.step(decision, false);
    this.advance();
  }

  /** 連續代打直到：需要人類互動／對局結束 */
  private advance(): void {
    for (let i = 0; i < MAX_AUTO_STEPS; i++) {
      const pd = this.engine.pendingDecision;
      if (!pd || this.awaitingHuman) return;
      this.step(heuristicAiDecision(this.db, this.engine), pd.player === HUMAN);
    }
    throw new Error("advance 超過步數上限（引擎疑似未收斂）");
  }

  private step(decision: Decision, auto: boolean): void {
    const before = this.engine;
    const actor = before.pendingDecision!.player;
    const after = applyDecision(this.db, before, decision);
    const events = derivePresentationEvents(this.db, before, decision, after);
    const batch: PresentationBatch = { events, actor, decisionType: decision.type };
    this.meta.set(batch, { before, after, auto });
    this.timeline.enqueue(batch);
    this.engine = after;
  }
}
