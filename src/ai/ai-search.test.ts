// [Claude 2026-07-24] 候選 A 塊 1：搜尋控制器單元測試（全 Node，用假 backend 繞開 Worker）。
// 驗取消／取代／fallback／preset——這些邏輯過去散在 5 個 React effect、無法被測。
import { describe, expect, it } from "vitest";
import {
  createSearchController,
  isSearchCancelled,
  type CoachReportCtx,
  type OpponentMoveCtx,
  type SearchBackend,
  type SearchRequest,
} from "./ai-search";
import type { CardDb, Decision, GameState } from "../engine/types";
import type { CoachReport } from "./coach";

// ---- 測試替身 ----

const dummyState = {} as GameState;
const dummyDb = new Map() as CardDb;
const HEURISTIC_DECISION: Decision = { type: "free", action: "pass" };
const fakeHeuristic = (): Decision => HEURISTIC_DECISION;

function reportWith(decision: Decision): CoachReport {
  return { bestAction: { decision } } as unknown as CoachReport;
}

interface PendingCall {
  request: SearchRequest;
  signal: AbortSignal;
  resolve: (report: CoachReport) => void;
  reject: (err: unknown) => void;
}

/** 手動控制結算時機的假 backend——不理會 abort，逼控制器自己處理取消／取代。 */
function deferredBackend() {
  const calls: PendingCall[] = [];
  const backend: SearchBackend = {
    run(request, signal) {
      return new Promise<CoachReport>((resolve, reject) => {
        calls.push({ request, signal, resolve, reject });
      });
    },
  };
  return { backend, calls };
}

function opponentCtx(engine: "strong" | "heuristic", timeLimitMs = 1234): OpponentMoveCtx {
  return { db: dummyDb, engine, perspectivePlayer: 1, seed: 42, timeLimitMs };
}

function coachCtx(): CoachReportCtx {
  return { perspectivePlayer: 0, seed: 7 };
}

describe("createSearchController", () => {
  it("① requestOpponentMove 回傳 backend 報告的 bestAction.decision", async () => {
    const { backend, calls } = deferredBackend();
    const search = createSearchController({ backend, heuristic: fakeHeuristic });
    const decision: Decision = { type: "serve-rights", take: true };

    const query = search.requestOpponentMove(dummyState, opponentCtx("strong"));
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(reportWith(decision));

    await expect(query.promise).resolves.toEqual(decision);
  });

  it("① heuristic 引擎走同步快速路徑，完全不碰 backend", async () => {
    const { backend, calls } = deferredBackend();
    const search = createSearchController({ backend, heuristic: fakeHeuristic });

    const query = search.requestOpponentMove(dummyState, opponentCtx("heuristic"));

    expect(calls).toHaveLength(0);
    await expect(query.promise).resolves.toEqual(HEURISTIC_DECISION);
  });

  it("② 同方法再次呼叫會取消並取代前一個查詢", async () => {
    const { backend, calls } = deferredBackend();
    const search = createSearchController({ backend, heuristic: fakeHeuristic });
    const decision: Decision = { type: "serve-rights", take: false };

    const first = search.requestOpponentMove(dummyState, opponentCtx("strong"));
    const second = search.requestOpponentMove(dummyState, opponentCtx("strong"));

    // 前一個查詢的 signal 已被 abort。
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);

    calls[1]!.resolve(reportWith(decision));

    await expect(first.promise).rejects.toSatisfy(isSearchCancelled);
    await expect(second.promise).resolves.toEqual(decision);
  });

  it("③ 對手搜尋失敗（非取消）落到 heuristic", async () => {
    const { backend, calls } = deferredBackend();
    const search = createSearchController({ backend, heuristic: fakeHeuristic });

    const query = search.requestOpponentMove(dummyState, opponentCtx("strong"));
    calls[0]!.reject(new Error("worker 爆了"));

    await expect(query.promise).resolves.toEqual(HEURISTIC_DECISION);
  });

  it("③ 對手搜尋失敗時以失敗原因呼叫 onFallback；成功／取消不呼叫", async () => {
    const { backend, calls } = deferredBackend();
    const search = createSearchController({ backend, heuristic: fakeHeuristic });
    const reasons: string[] = [];

    // 失敗 → onFallback 帶原因
    const failed = search.requestOpponentMove(dummyState, { ...opponentCtx("strong"), onFallback: (r) => reasons.push(r) });
    calls[0]!.reject(new Error("worker 爆了"));
    await expect(failed.promise).resolves.toEqual(HEURISTIC_DECISION);
    expect(reasons).toEqual(["worker 爆了"]);

    // 取消 → 不呼叫
    const cancelled = search.requestOpponentMove(dummyState, { ...opponentCtx("strong"), onFallback: (r) => reasons.push(r) });
    cancelled.cancel();
    await expect(cancelled.promise).rejects.toSatisfy(isSearchCancelled);

    // 成功 → 不呼叫
    const ok = search.requestOpponentMove(dummyState, { ...opponentCtx("strong"), onFallback: (r) => reasons.push(r) });
    calls[calls.length - 1]!.resolve(reportWith({ type: "serve-rights", take: true }));
    await ok.promise;

    expect(reasons).toEqual(["worker 爆了"]);
  });

  it("③ 教練搜尋失敗（非取消）以真實 error reject，不落 heuristic", async () => {
    const { backend, calls } = deferredBackend();
    const search = createSearchController({ backend, heuristic: fakeHeuristic });

    const query = search.requestCoachReport(dummyState, coachCtx());
    calls[0]!.reject(new Error("pimc 逾時"));

    await expect(query.promise).rejects.toThrow("pimc 逾時");
  });

  it("④ cancel() 後即使 backend 事後 resolve 也不回傳報告", async () => {
    const { backend, calls } = deferredBackend();
    const search = createSearchController({ backend, heuristic: fakeHeuristic });

    const query = search.requestCoachReport(dummyState, coachCtx());
    query.cancel();
    // backend 事後才慢慢結算——不該影響已取消的查詢。
    calls[0]!.resolve(reportWith({ type: "free", action: "pass" }));

    await expect(query.promise).rejects.toSatisfy(isSearchCancelled);
  });

  it("⑤ preset：對手帶出 ismcts 固定參數＋呼叫端的 timeLimitMs", () => {
    const { backend, calls } = deferredBackend();
    const search = createSearchController({ backend, heuristic: fakeHeuristic });

    search.requestOpponentMove(dummyState, opponentCtx("strong", 5000));

    expect(calls[0]!.request.engine).toBe("ismcts");
    expect(calls[0]!.request.options).toMatchObject({
      candidateLimit: 8,
      leafRolloutHorizon: 40,
      opponentModel: "heuristic",
      perspectivePlayer: 1,
      seed: 42,
      timeLimitMs: 5000,
    });
  });

  it("⑤ preset：教練＝單一 preset（rollout 1400 / time 1200）", () => {
    const { backend, calls } = deferredBackend();
    const search = createSearchController({ backend, heuristic: fakeHeuristic });

    search.requestCoachReport(dummyState, coachCtx());

    expect(calls[0]!.request.engine).toBe("pimc");
    expect(calls[0]!.request.options).toMatchObject({
      sampleCount: 4,
      candidateLimit: 6,
      rolloutMaxSteps: 1400,
      timeLimitMs: 1200,
    });
  });
});
