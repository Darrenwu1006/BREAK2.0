// [Claude 2026-07-24] 候選 A：AI 搜尋門面（框架無關，不 import React）。
// 把散在 5 個 React effect 的搜尋協定收成一個可測 module：worker 生命週期＋取消／取代＋
// heuristic fallback＋調參 preset，全部在這裡。React 只留「呼叫→setState→cleanup」膠水。
//
// seam＝SearchBackend：正式環境用 WorkerSearchBackend（包 coach-worker）；測試注入同步／假 backend。
// 取消／取代／fallback 邏輯寫在控制器本體、與 Worker 解耦，因此在 Node（無 Worker）就能單元測試。
//
// 依賴方向：UI → ai-search →（型別）coach/ismcts、（值）heuristic。
// ismcts/coach 一律 type-only import，不會被拖進主 bundle（重搜尋只活在 worker chunk）。

import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import type { CoachReport, PimcCoachOptions } from "./coach";
import type { IsmctsOptions } from "./ismcts";
import { heuristicAiDecision } from "./heuristic";
import type { HeuristicV2ProfileId } from "./heuristic";

// ---------- worker 協定（自 coach-worker.ts 搬來，backend 與 worker 兩端共用一份定義） ----------

/** worker 依 engine 分派：對手＝ismcts；教練（即時／復盤）＝pimc。 */
export type CoachWorkerRequest =
  | { requestId: string; state: GameState; engine?: "pimc"; options?: PimcCoachOptions }
  | { requestId: string; state: GameState; engine: "ismcts"; options?: IsmctsOptions };

export type CoachWorkerResponse =
  | { requestId: string; ok: true; report: CoachReport }
  | { requestId: string; ok: false; error: string };

// ---------- 取消語義 ----------

/** 查詢被取消／被後續同類查詢取代時，promise 以此 error reject（呼叫端可安靜略過）。 */
export class SearchCancelledError extends Error {
  constructor() {
    super("__search_cancelled__");
    this.name = "SearchCancelledError";
  }
}

export function isSearchCancelled(err: unknown): boolean {
  return err instanceof SearchCancelledError;
}

/** 可取消查詢 handle；同一方法再次呼叫會自動取消並取代前一個查詢。 */
export interface CancelableQuery<T> {
  readonly promise: Promise<T>;
  cancel(): void;
}

// ---------- backend seam ----------

export interface SearchRequest {
  state: GameState;
  engine: "pimc" | "ismcts";
  options: PimcCoachOptions | IsmctsOptions;
}

/** 搜尋後端；正式＝WorkerSearchBackend，測試＝同步／假 backend。收到 abort 應盡快結束。 */
export interface SearchBackend {
  run(request: SearchRequest, signal: AbortSignal): Promise<CoachReport>;
}

// ---------- 調參 preset（唯一定義處） ----------

/** 對手出手（ismcts）固定參數；perspectivePlayer/knownDecks/seed/timeLimitMs/rolloutPolicy 由呼叫端帶入。 */
export const OPPONENT_ISMCTS_PRESET = {
  candidateLimit: 8,
  leafRolloutHorizon: 40,
  opponentModel: "heuristic",
} as const satisfies Partial<IsmctsOptions>;

/**
 * 教練（pimc）preset。兩個消費端（經典即時教練、ui-lab 教練）共用同一組。
 * [Claude 2026-07-25] 候選 C 塊 3 移除復盤教練逐手掃描後，`variant`／REPLAY_COACH_OVERRIDE 成為零消費者的
 * 假想 seam，一併刪除（原「復盤 rolloutMaxSteps 1200→1400」的待驗行為變更亦隨該路徑退場而歸零）。
 * 日後若復盤教練回歸，再加一個 override 即可。
 */
export const COACH_PIMC_PRESET = {
  sampleCount: 4,
  candidateLimit: 6,
  rolloutMaxSteps: 1400,
  timeLimitMs: 1200,
} as const satisfies Partial<PimcCoachOptions>;

// ---------- 呼叫端 ctx ----------

export interface OpponentMoveCtx {
  db: CardDb;
  /** strong→worker(ismcts)；heuristic→同步快速決策。呼叫端不再自行分叉。 */
  engine: "strong" | "heuristic";
  perspectivePlayer: PlayerId;
  knownDecks?: readonly [readonly string[], readonly string[]];
  seed: number;
  /** strong 的思考預算（通常＝estimateThinkBudgetMs(state)）。 */
  timeLimitMs: number;
  /** heuristic 快速路徑與 strong 的 rollout policy；省略則用 ismcts 預設。 */
  rolloutPolicy?: HeuristicV2ProfileId;
  /** strong 搜尋失敗（非取消）→ 落 heuristic 前呼叫此回呼（帶失敗原因），供呼叫端提示。取消不觸發。 */
  onFallback?: (reason: string) => void;
}

export interface CoachReportCtx {
  perspectivePlayer: PlayerId;
  knownDecks?: readonly [readonly string[], readonly string[]];
  seed: number;
  gameplanDeckLabels?: readonly [string, string];
}

function buildOpponentOptions(ctx: OpponentMoveCtx): IsmctsOptions {
  return {
    ...OPPONENT_ISMCTS_PRESET,
    perspectivePlayer: ctx.perspectivePlayer,
    knownDecks: ctx.knownDecks,
    seed: ctx.seed,
    timeLimitMs: ctx.timeLimitMs,
    ...(ctx.rolloutPolicy ? { rolloutPolicy: ctx.rolloutPolicy } : {}),
  };
}

function buildCoachOptions(ctx: CoachReportCtx): PimcCoachOptions {
  return {
    ...COACH_PIMC_PRESET,
    perspectivePlayer: ctx.perspectivePlayer,
    knownDecks: ctx.knownDecks,
    seed: ctx.seed,
    ...(ctx.gameplanDeckLabels ? { gameplanDeckLabels: ctx.gameplanDeckLabels } : {}),
  };
}

// ---------- 控制器 ----------

export interface SearchController {
  /**
   * 問對手一手。strong 搜尋失敗（非取消）→ 落到 heuristic（保留現況行為，promise 不會因搜尋失敗 reject）。
   * 取消／被取代 → promise reject(SearchCancelledError)。
   */
  requestOpponentMove(state: GameState, ctx: OpponentMoveCtx): CancelableQuery<Decision>;
  /**
   * 要一份教練報告。搜尋失敗（非取消）→ promise reject(真實 error)，呼叫端顯示錯誤態。
   * 取消／被取代 → promise reject(SearchCancelledError)。
   */
  requestCoachReport(state: GameState, ctx: CoachReportCtx): CancelableQuery<CoachReport>;
}

export interface SearchControllerDeps {
  backend: SearchBackend;
  /** 快速路徑與 fallback 用；預設＝真 heuristicAiDecision，測試可注入假的以驗路由。 */
  heuristic?: (db: CardDb, state: GameState, profile?: HeuristicV2ProfileId) => Decision;
}

/**
 * abort 一觸發即 reject——不倚賴 backend 主動回應 abort，讓「取消／取代」在任何 backend 下都可觀測。
 */
function runWithAbort(backend: SearchBackend, request: SearchRequest, signal: AbortSignal): Promise<CoachReport> {
  if (signal.aborted) return Promise.reject(new SearchCancelledError());
  return new Promise<CoachReport>((resolve, reject) => {
    const onAbort = () => reject(new SearchCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    backend.run(request, signal).then(
      (report) => {
        signal.removeEventListener("abort", onAbort);
        resolve(report);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function createSearchController(deps: SearchControllerDeps): SearchController {
  const heuristic = deps.heuristic ?? ((db: CardDb, state: GameState, profile?: HeuristicV2ProfileId) =>
    profile ? heuristicAiDecision(db, state, profile) : heuristicAiDecision(db, state));

  // 每方法各自持有「當前查詢」；同方法再呼叫先 abort 前一個（stale 比對進 module）。
  let opponentSlot: AbortController | null = null;
  let coachSlot: AbortController | null = null;

  function requestOpponentMove(state: GameState, ctx: OpponentMoveCtx): CancelableQuery<Decision> {
    opponentSlot?.abort();
    const ac = new AbortController();
    opponentSlot = ac;
    const { signal } = ac;

    const promise = (async (): Promise<Decision> => {
      // heuristic 快速路徑：同步決策，不碰 backend。
      if (ctx.engine === "heuristic") {
        if (signal.aborted) throw new SearchCancelledError();
        return heuristic(ctx.db, state, ctx.rolloutPolicy);
      }
      // strong：跑搜尋 backend；搜尋失敗（非取消）→ heuristic fallback。
      const request: SearchRequest = { state, engine: "ismcts", options: buildOpponentOptions(ctx) };
      try {
        const report = await runWithAbort(deps.backend, request, signal);
        return report.bestAction.decision;
      } catch (err) {
        if (signal.aborted || isSearchCancelled(err)) throw new SearchCancelledError();
        ctx.onFallback?.(err instanceof Error ? err.message : String(err));
        return heuristic(ctx.db, state, ctx.rolloutPolicy);
      }
    })();

    return { promise, cancel: () => ac.abort() };
  }

  function requestCoachReport(state: GameState, ctx: CoachReportCtx): CancelableQuery<CoachReport> {
    coachSlot?.abort();
    const ac = new AbortController();
    coachSlot = ac;
    const { signal } = ac;

    const promise = (async (): Promise<CoachReport> => {
      const request: SearchRequest = { state, engine: "pimc", options: buildCoachOptions(ctx) };
      try {
        return await runWithAbort(deps.backend, request, signal);
      } catch (err) {
        if (signal.aborted || isSearchCancelled(err)) throw new SearchCancelledError();
        throw err instanceof Error ? err : new Error(String(err));
      }
    })();

    return { promise, cancel: () => ac.abort() };
  }

  return { requestOpponentMove, requestCoachReport };
}

// ---------- 正式 backend：包 coach-worker ----------

let workerRequestSeq = 0;

/**
 * 每查詢開一個 worker，settle／取消即 terminate（維持現況生命週期）。
 * 只在瀏覽器環境可用（Node 無 Worker）——測試改注入同步／假 backend。
 */
export function createWorkerSearchBackend(): SearchBackend {
  return {
    run(request, signal) {
      return new Promise<CoachReport>((resolve, reject) => {
        if (signal.aborted) {
          reject(new SearchCancelledError());
          return;
        }
        const requestId = String(++workerRequestSeq);
        const worker = new Worker(new URL("./coach-worker.ts", import.meta.url), { type: "module" });
        const cleanup = () => {
          worker.terminate();
          signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(new SearchCancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        worker.onmessage = (event: MessageEvent<CoachWorkerResponse>) => {
          if (event.data.requestId !== requestId) return;
          cleanup();
          if (event.data.ok) resolve(event.data.report);
          else reject(new Error(event.data.error));
        };
        worker.onerror = (event) => {
          cleanup();
          reject(new Error(event.message || "search worker 發生錯誤"));
        };
        worker.postMessage({
          requestId,
          state: request.state,
          engine: request.engine,
          options: request.options,
        } satisfies CoachWorkerRequest);
      });
    },
  };
}
