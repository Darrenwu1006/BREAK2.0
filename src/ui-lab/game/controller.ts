// M9a CP4 對局控制器：引擎的 ui-lab 消費者（純 TS、無 React、可單元測試）。
// 職責：state 先到位（邏輯即時）——非人類互動的決策由 heuristic 立即代打並連續推進，
// 每手 applyDecision 前後餵 derivePresentationEvents 進 PresentationTimeline；
// 演出節奏與互動閘（佇列清空前不開放操作）屬 renderer 層，本檔不管時間。
//
// LP1~LP5（[使用者 2026-07-11] 完整對局路線）：P0 的**全部**決策型別由人類親手操作
// （serve-rights/mulligan/deploy-*/defense-choice/free/resolve-pending/effect-*/pick-set-card）；
// 「AI 代打」按鈕仍可對任何單手委託 heuristic。對手 P1 與 chooser=對手的效果決策照舊自動。

import { heuristicAiDecision } from "../../ai/heuristic";
import { applyDecision, createGame } from "../../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../../engine/types";
import type { DeckMeta } from "../../shared/deckMeta";
import { appendReplayEntry, createReplaySession, truncateReplaySession, type ReplaySession } from "../../shared/replayHistory";
import { derivePresentationEvents } from "../presentation/derive";
import { PresentationTimeline, type PresentationBatch } from "../presentation/timeline";

export const HUMAN: PlayerId = 0;

export interface BatchMeta {
  /** 這批演出開始前的盤面（演出底圖） */
  before: GameState;
  /** 這批演出結束後的盤面（card-moved 的目標擺位來源） */
  after: GameState;
  /** true＝人類的決策由 AI 代打（M9a 未實作互動的型別） */
  auto: boolean;
}

const MAX_AUTO_STEPS = 5000; // 全場 heuristic 對局遠低於此；防呆上限
export const LAB_UNDO_LIMIT = 20;

interface UndoCheckpoint {
  state: GameState;
  replayLength: number;
}

export class LabGameController {
  readonly db: CardDb;
  readonly timeline = new PresentationTimeline();
  /** 權威盤面（邏輯即時；演出落後於它） */
  engine: GameState;
  /** 與經典介面共用的正式 replay 歷史鏈；CP6A undo／CP6C 分支會沿用此 schema。 */
  replay: ReplaySession;
  private meta = new WeakMap<PresentationBatch, BatchMeta>();
  private undoHistory: UndoCheckpoint[] = [];
  private readonly deferOpponent: boolean;

  constructor(db: CardDb, decks: [string[], string[]], seed: number, deckMeta?: [DeckMeta, DeckMeta], options?: { deferOpponent?: boolean }) {
    this.db = db;
    this.deferOpponent = options?.deferOpponent ?? false;
    this.engine = createGame(db, { seed, decks });
    const fallbackMeta = (player: PlayerId): DeckMeta => ({
      school: player === HUMAN ? "Player" : "AI",
      name: "ui-lab",
      total: decks[player].length,
      implementedCount: decks[player].length,
      unimplementedCount: 0,
    });
    this.replay = createReplaySession(
      this.engine,
      decks,
      deckMeta ?? [fallbackMeta(0), fallbackMeta(1)],
      undefined,
      seed,
    );
    this.advance();
  }

  /** 是否輪到人類親手操作（P0 的所有決策型別） */
  get awaitingHuman(): boolean {
    const pd = this.engine.pendingDecision;
    return !!pd && pd.player === HUMAN;
  }

  /** 正式 shell 由 worker 接手 P1；測試／headless 預設仍可同步 heuristic 跑完整局。 */
  get awaitingOpponent(): boolean {
    const pd = this.engine.pendingDecision;
    return !!pd && pd.player !== HUMAN;
  }

  get canUndo(): boolean {
    return this.undoHistory.length > 0;
  }

  get undoDepth(): number {
    return this.undoHistory.length;
  }

  metaOf(batch: PresentationBatch): BatchMeta | undefined {
    return this.meta.get(batch);
  }

  /** 人類決策入口：套用後自動推進到下一個人類互動點 */
  decide(decision: Decision, delegated = false): boolean {
    // UI event handlers may retain a render-time closure while the engine has
    // already advanced (including across the human/opponent boundary). A stale
    // input is harmless and must never end a match or surface a scary toast.
    const pending = this.engine.pendingDecision;
    if (!pending || pending.player !== HUMAN || pending.type !== decision.type) return false;
    const checkpoint = !delegated ? {
      state: structuredClone(this.engine) as GameState,
      replayLength: this.replay.entries.length,
    } : null;
    try {
      this.step(decision, delegated);
      if (checkpoint) {
        this.undoHistory.push(checkpoint);
        if (this.undoHistory.length > LAB_UNDO_LIMIT) this.undoHistory.splice(0, this.undoHistory.length - LAB_UNDO_LIMIT);
      }
      // If an unexpected auto-advance failure happens after the human step,
      // retain the checkpoint so the fatal recovery modal can genuinely undo.
      this.advance();
      return true;
    } catch (error) {
      throw error;
    }
  }

  /** CP6C worker 回傳的對手決策入口。 */
  decideOpponent(decision: Decision, thinkMs?: number): void {
    if (!this.awaitingOpponent) throw new Error("目前不是對手決策");
    this.step(decision, true, thinkMs);
    this.advance();
  }

  /** 回到上一個人類決策前；timeline 直接作廢，renderer 由 usePlayback.skip 對齊恢復後 state。 */
  undo(): boolean {
    const checkpoint = this.undoHistory.pop();
    if (!checkpoint) return false;
    this.timeline.skip();
    this.engine = structuredClone(checkpoint.state) as GameState;
    const previousRewinds = this.replay.rewindCount ?? 0;
    this.replay = {
      ...truncateReplaySession(this.replay, checkpoint.replayLength),
      rewound: true,
      rewindCount: previousRewinds + 1,
    };
    return true;
  }

  /** 連續代打直到：需要人類互動／對局結束 */
  private advance(): void {
    for (let i = 0; i < MAX_AUTO_STEPS; i++) {
      const pd = this.engine.pendingDecision;
      if (!pd || this.awaitingHuman) return;
      if (this.deferOpponent && pd.player !== HUMAN) return;
      this.step(heuristicAiDecision(this.db, this.engine), pd.player === HUMAN);
    }
    throw new Error("advance 超過步數上限（引擎疑似未收斂）");
  }

  private step(decision: Decision, auto: boolean, thinkMs?: number): void {
    const before = this.engine;
    const actor = before.pendingDecision!.player;
    const after = applyDecision(this.db, before, decision);
    const events = derivePresentationEvents(this.db, before, decision, after);
    const batch: PresentationBatch = {
      events,
      actor,
      decisionType: decision.type,
      ...(thinkMs !== undefined ? { thinkMs } : {}),
    };
    this.meta.set(batch, { before, after, auto });
    this.timeline.enqueue(batch);
    this.replay = appendReplayEntry(this.replay, before, decision, after, actor === HUMAN && !auto ? "player" : "ai");
    this.engine = after;
  }
}
