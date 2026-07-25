// [Claude 2026-07-25] 候選 C Part 1：對局 session——經典 2D 與實驗 3D 共用的權威編排（純 TS、無 React、無演出）。
// 職責：engine 推進、replay 鏈追加／截斷、undo（含 rewound 標記）、Set 回饋、對手決策回填。
// 演出不在此層（grilling Q1a）：每套一手發 onStep(meta)，lab adapter 據此建 PresentationBatch 進 timeline；
// 經典的 motion 仍看 state 變化。mutable class＋onChange 訊號（Q3a）：經典用 ref＋bump 重繪，lab 由 playback 迴圈重繪。
//
// undo 語義以 lab 為準（Q2a）：截斷 replay ＋ 標 rewound/rewindCount ＋ 還原 state；
// 上限為建構參數（經典 10、lab 20），純 UX 手感、無對錯。rewound 標記是正確行為，兩介面統一享有。

import { heuristicAiDecision } from "../ai/heuristic";
import { applyDecision, createGame } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import type { DeckMeta } from "./deckMeta";
import {
  appendReplayEntry,
  appendReplaySetFeedback,
  createReplaySession,
  stateAtReplayStep,
  truncateReplaySession,
  type ReplaySession,
  type ReplaySetFeedback,
} from "./replayHistory";

export const HUMAN: PlayerId = 0;

/** 一手落地的完整資訊；演出層（lab timeline）據此建批次。 */
export interface StepMeta {
  /** 這一手之前的盤面（演出底圖） */
  before: GameState;
  /** 這一手之後的盤面 */
  after: GameState;
  actor: PlayerId;
  decision: Decision;
  /** true＝人類的決策由 AI 代打（非人類親手） */
  auto: boolean;
  thinkMs?: number;
}

export interface MatchSessionOptions {
  deckMeta?: [DeckMeta, DeckMeta];
  /**
   * true＝對手決策不自動代打，停下等 decideOpponent 回填（兩個正式 shell 都用）；
   * false＝同步 heuristic 連續推進（測試／headless 跑完整局）。
   */
  deferOpponent?: boolean;
  /** undo 檢查點上限（經典 10、lab 20）。 */
  undoLimit?: number;
  onStep?: (meta: StepMeta) => void;
  onChange?: () => void;
}

const MAX_AUTO_STEPS = 5000; // 全場 heuristic 對局遠低於此；防呆上限
export const DEFAULT_UNDO_LIMIT = 20;

interface UndoCheckpoint {
  state: GameState;
  replayLength: number;
}

export class MatchSession {
  readonly db: CardDb;
  /** 權威盤面（邏輯即時；演出可落後於它） */
  engine: GameState;
  /** 正式 replay 歷史鏈（兩介面共用同一 schema） */
  replay: ReplaySession;

  private undoHistory: UndoCheckpoint[] = [];
  private readonly deferOpponent: boolean;
  private readonly undoLimit: number;
  private readonly onStep?: (meta: StepMeta) => void;
  private readonly onChange?: () => void;

  constructor(db: CardDb, decks: [string[], string[]], seed: number, options: MatchSessionOptions = {}) {
    this.db = db;
    this.deferOpponent = options.deferOpponent ?? false;
    this.undoLimit = options.undoLimit ?? DEFAULT_UNDO_LIMIT;
    this.onStep = options.onStep;
    this.onChange = options.onChange;
    this.engine = createGame(db, { seed, decks });
    const fallbackMeta = (player: PlayerId): DeckMeta => ({
      school: player === HUMAN ? "Player" : "AI",
      name: "match",
      total: decks[player].length,
      implementedCount: decks[player].length,
      unimplementedCount: 0,
    });
    this.replay = createReplaySession(
      this.engine,
      decks,
      options.deckMeta ?? [fallbackMeta(0), fallbackMeta(1)],
      undefined,
      seed,
    );
    this.advance();
  }

  /**
   * 由既有 replay 重建（唯讀檢視用：經典的「載入對戰紀錄」）。
   * 盤面取最後一步之後的狀態；不推進、不代打。
   */
  static fromReplay(db: CardDb, replay: ReplaySession, options: MatchSessionOptions = {}): MatchSession {
    const session = Object.create(MatchSession.prototype) as MatchSession;
    Object.assign(session, {
      db,
      engine: stateAtReplayStep(replay, replay.entries.length),
      replay,
      undoHistory: [],
      deferOpponent: true,
      undoLimit: options.undoLimit ?? DEFAULT_UNDO_LIMIT,
      onStep: options.onStep,
      onChange: options.onChange,
    });
    return session;
  }

  /** 是否輪到人類親手操作 */
  get awaitingHuman(): boolean {
    const pd = this.engine.pendingDecision;
    return !!pd && pd.player === HUMAN;
  }

  /** 是否等待對手決策（正式 shell 由 worker 接手，經 decideOpponent 回填） */
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

  /** Set 結束軟暫停寫入玩家當下意圖；同一結果只接受第一次回饋。 */
  recordSetFeedback(feedback: ReplaySetFeedback): boolean {
    const next = appendReplaySetFeedback(this.replay, feedback);
    if (next === this.replay) return false;
    this.replay = next;
    this.onChange?.();
    return true;
  }

  /**
   * 人類決策入口：套用後自動推進到下一個人類互動點。
   * delegated＝這一手由「AI 代打」按下（不建立 undo 檢查點）。
   * 過期輸入（UI closure 落後於引擎）安全回 false，不丟例外。
   */
  decide(decision: Decision, delegated = false): boolean {
    const pending = this.engine.pendingDecision;
    if (!pending || pending.player !== HUMAN || pending.type !== decision.type) return false;
    const checkpoint = !delegated
      ? { state: structuredClone(this.engine) as GameState, replayLength: this.replay.entries.length }
      : null;
    this.step(decision, delegated);
    if (checkpoint) {
      this.undoHistory.push(checkpoint);
      if (this.undoHistory.length > this.undoLimit) {
        this.undoHistory.splice(0, this.undoHistory.length - this.undoLimit);
      }
    }
    this.advance();
    this.onChange?.();
    return true;
  }

  /** 對手決策回填（worker 搜尋結果／heuristic 快速決策）。 */
  decideOpponent(decision: Decision, thinkMs?: number): void {
    if (!this.awaitingOpponent) throw new Error("目前不是對手決策");
    this.step(decision, true, thinkMs);
    this.advance();
    this.onChange?.();
  }

  /** 回到上一個人類決策前：還原盤面、截斷 replay、標記 rewound（人類基準完整性）。 */
  undo(): boolean {
    const checkpoint = this.undoHistory.pop();
    if (!checkpoint) return false;
    this.engine = structuredClone(checkpoint.state) as GameState;
    const previousRewinds = this.replay.rewindCount ?? 0;
    this.replay = {
      ...truncateReplaySession(this.replay, checkpoint.replayLength),
      rewound: true,
      rewindCount: previousRewinds + 1,
    };
    this.onChange?.();
    return true;
  }

  /** 連續代打直到：需要人類互動／對局結束／（deferOpponent 時）輪到對手 */
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
    this.replay = appendReplayEntry(this.replay, before, decision, after, actor === HUMAN && !auto ? "player" : "ai");
    this.engine = after;
    this.onStep?.({ before, after, actor, decision, auto, ...(thinkMs !== undefined ? { thinkMs } : {}) });
  }
}
