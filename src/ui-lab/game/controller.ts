// M9a CP4 對局控制器：共用 MatchSession 的 ui-lab adapter（純 TS、無 React、可單元測試）。
// [Claude 2026-07-25] 候選 C Part 1：權威編排（engine 推進／replay 鏈／undo／Set 回饋／對手回填）
// 已移入 shared/matchSession，兩介面共用；本檔只剩 lab 專屬的**演出層**——訂閱 session 的 onStep，
// 把每一手轉成 PresentationBatch 進 PresentationTimeline，並保存批次 meta 供 renderer 取底圖。
// 演出節奏與互動閘（佇列清空前不開放操作）屬 renderer 層，本檔不管時間。
//
// LP1~LP5（[使用者 2026-07-11] 完整對局路線）：P0 的**全部**決策型別由人類親手操作；
// 「AI 代打」按鈕仍可對任何單手委託 heuristic。對手 P1 與 chooser=對手的效果決策照舊自動。

import type { CardDb, Decision, GameState, PlayerId } from "../../engine/types";
import type { DeckMeta } from "../../shared/deckMeta";
import { HUMAN, MatchSession, type StepMeta } from "../../shared/matchSession";
import type { ReplaySession, ReplaySetFeedback } from "../../shared/replayHistory";
import { derivePresentationEvents } from "../presentation/derive";
import { PresentationTimeline, type PresentationBatch } from "../presentation/timeline";

export { HUMAN };

export interface BatchMeta {
  /** 這批演出開始前的盤面（演出底圖） */
  before: GameState;
  /** 這批演出結束後的盤面（card-moved 的目標擺位來源） */
  after: GameState;
  /** true＝人類的決策由 AI 代打 */
  auto: boolean;
}

export const LAB_UNDO_LIMIT = 20;

export class LabGameController {
  readonly db: CardDb;
  readonly timeline = new PresentationTimeline();
  private meta = new WeakMap<PresentationBatch, BatchMeta>();
  private readonly session: MatchSession;

  constructor(db: CardDb, decks: [string[], string[]], seed: number, deckMeta?: [DeckMeta, DeckMeta], options?: { deferOpponent?: boolean }) {
    this.db = db;
    this.session = new MatchSession(db, decks, seed, {
      deckMeta,
      deferOpponent: options?.deferOpponent ?? false,
      undoLimit: LAB_UNDO_LIMIT,
      onStep: (step) => this.enqueuePresentation(step),
    });
  }

  /** 權威盤面（邏輯即時；演出落後於它）。setter 供測試注入構造盤面。 */
  get engine(): GameState {
    return this.session.engine;
  }

  set engine(next: GameState) {
    this.session.engine = next;
  }

  /** 與經典介面共用的正式 replay 歷史鏈。 */
  get replay(): ReplaySession {
    return this.session.replay;
  }

  get awaitingHuman(): boolean {
    return this.session.awaitingHuman;
  }

  get awaitingOpponent(): boolean {
    return this.session.awaitingOpponent;
  }

  get canUndo(): boolean {
    return this.session.canUndo;
  }

  get undoDepth(): number {
    return this.session.undoDepth;
  }

  metaOf(batch: PresentationBatch): BatchMeta | undefined {
    return this.meta.get(batch);
  }

  /** Set 結束軟暫停寫入玩家當下意圖；同一結果只接受第一次回饋。 */
  recordSetFeedback(feedback: ReplaySetFeedback): boolean {
    return this.session.recordSetFeedback(feedback);
  }

  /** 人類決策入口：套用後自動推進到下一個人類互動點。過期輸入安全回 false。 */
  decide(decision: Decision, delegated = false): boolean {
    return this.session.decide(decision, delegated);
  }

  /** CP6C worker 回傳的對手決策入口。 */
  decideOpponent(decision: Decision, thinkMs?: number): void {
    this.session.decideOpponent(decision, thinkMs);
  }

  /** 回到上一個人類決策前；timeline 直接作廢，renderer 由 usePlayback.skip 對齊恢復後 state。 */
  undo(): boolean {
    if (!this.session.canUndo) return false;
    this.timeline.skip();
    return this.session.undo();
  }

  /** session 每落地一手 → 轉成演出批次進佇列（本 adapter 的唯一職責）。 */
  private enqueuePresentation(step: StepMeta): void {
    const events = derivePresentationEvents(this.db, step.before, step.decision, step.after);
    const batch: PresentationBatch = {
      events,
      actor: step.actor,
      decisionType: step.decision.type,
      ...(step.thinkMs !== undefined ? { thinkMs: step.thinkMs } : {}),
    };
    this.meta.set(batch, { before: step.before, after: step.after, auto: step.auto });
    this.timeline.enqueue(batch);
  }
}

export type { PlayerId };
