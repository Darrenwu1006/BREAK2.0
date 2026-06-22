import { describe, expect, it } from "vitest";
import type { GameState } from "../engine/types";
import { estimateThinkBudgetMs } from "./think-budget";

// [Claude 2026-06-22] Phase F：自適應思考預算的單元測試。
// estimateThinkBudgetMs 只讀 state 的 pendingDecision.type / op.value / dp.value / setNo，
// 因此用最小 fixture（cast 成 GameState）聚焦在「訊號→預算」的映射與邊界，不必拉真實對局。
function fakeState(patch: {
  type?: string;
  op?: number;
  dp?: number;
  setNo?: number;
  noDecision?: boolean;
}): GameState {
  return {
    pendingDecision: patch.noDecision ? null : { type: patch.type ?? "free", player: 0 },
    op: patch.op === undefined ? null : { value: patch.op },
    dp: patch.dp === undefined ? null : { value: patch.dp },
    setNo: patch.setNo ?? 1,
  } as unknown as GameState;
}

describe("estimateThinkBudgetMs", () => {
  it("沒有待決策時回傳下限（沒有要想的事）", () => {
    expect(estimateThinkBudgetMs(fakeState({ noDecision: true }))).toBe(3000);
  });

  it("瑣碎決策＋零壓力＋首局＝落在下限", () => {
    // serve-rights 權重 0，無 OP/DP，set1 → weight 0 → minMs。
    expect(estimateThinkBudgetMs(fakeState({ type: "serve-rights", setNo: 1 }))).toBe(3000);
  });

  it("最複雜＋高壓＋決勝局＝逼近上限", () => {
    // deploy-block(0.4) + 滿壓(+0.4) + set5(+0.4) = 1.2 → clamp 1 → maxMs。
    expect(estimateThinkBudgetMs(fakeState({ type: "deploy-block", op: 7, setNo: 5 }))).toBe(10000);
  });

  it("輸出永遠落在 [min, max] 區間", () => {
    const types = ["serve-rights", "free", "deploy-block", "effect-confirm", "mulligan"];
    for (const type of types) {
      for (const op of [0, 3, 7, 12]) {
        for (const setNo of [1, 3, 5]) {
          const ms = estimateThinkBudgetMs(fakeState({ type, op, setNo }));
          expect(ms).toBeGreaterThanOrEqual(3000);
          expect(ms).toBeLessThanOrEqual(10000);
        }
      }
    }
  });

  it("場上壓力越高，思考預算越高（單調）", () => {
    const low = estimateThinkBudgetMs(fakeState({ type: "free", op: 0, setNo: 1 }));
    const mid = estimateThinkBudgetMs(fakeState({ type: "free", op: 4, setNo: 1 }));
    const high = estimateThinkBudgetMs(fakeState({ type: "free", op: 7, setNo: 1 }));
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });

  it("OP 與 DP 取較大者當壓力來源", () => {
    const byOp = estimateThinkBudgetMs(fakeState({ type: "free", op: 6, dp: 0, setNo: 1 }));
    const byDp = estimateThinkBudgetMs(fakeState({ type: "free", op: 0, dp: 6, setNo: 1 }));
    expect(byDp).toBe(byOp);
  });

  it("越後面的 set 越值得多想（單調不減）", () => {
    const set1 = estimateThinkBudgetMs(fakeState({ type: "free", op: 3, setNo: 1 }));
    const set3 = estimateThinkBudgetMs(fakeState({ type: "free", op: 3, setNo: 3 }));
    const set5 = estimateThinkBudgetMs(fakeState({ type: "free", op: 3, setNo: 5 }));
    expect(set3).toBeGreaterThan(set1);
    expect(set5).toBeGreaterThan(set3);
  });

  it("可用 options 覆寫 min/max 邊界", () => {
    expect(estimateThinkBudgetMs(fakeState({ noDecision: true }), { minMs: 500 })).toBe(500);
    expect(
      estimateThinkBudgetMs(fakeState({ type: "deploy-block", op: 7, setNo: 5 }), { minMs: 1000, maxMs: 4000 }),
    ).toBe(4000);
  });
});
