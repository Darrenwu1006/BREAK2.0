import { describe, expect, it } from "vitest";
import { applyDecision, createGame, deployableUids, effParam } from "../engine/engine";
import type { GameState, PlayerId } from "../engine/types";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import { createIsmctsReport, rootDecisionPressureScore, ucbScore } from "./ismcts";

// [Claude 2026-06-23] Phase G G1：SO-ISMCTS 核心四測（leakage hard gate／determinism／合法性／availability-UCB）。
// 鏡像 coach.test.ts 的 leakage 模式；以固定 iterations（非 timeLimitMs）保證 determinism。

function setupServeDecision(): { state: GameState; decks: readonly [readonly string[], readonly string[]] } {
  const deckA = findBenchmarkDeck("烏野-預組");
  const deckB = findBenchmarkDeck("音駒-預組");
  let state = createGame(benchmarkDb, { seed: 710, decks: [deckA.ids, deckB.ids] });
  state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
  expect(state.pendingDecision).toMatchObject({ player: 0, type: "deploy-serve" });
  return { state, decks: [deckA.ids, deckB.ids] };
}

const baseOptions = (seed: number) =>
  ({ perspectivePlayer: 0 as const, seed, iterations: 120, candidateLimit: 6 });

describe("M8 Phase G SO-ISMCTS", () => {
  it("輸出 ismcts-coach-v1 報告，bestAction 合法、winRate/confidence∈[0,1]、有候選", () => {
    const { state, decks } = setupServeDecision();
    const report = createIsmctsReport(benchmarkDb, state, { ...baseOptions(810), knownDecks: decks });

    expect(report.kind).toBe("ismcts-coach-v1");
    expect(report.perspectivePlayer).toBe(0);
    expect(report.actingPlayer).toBe(0);
    expect(report.pendingType).toBe("deploy-serve");
    expect(report.recommendations.length).toBeGreaterThan(1);
    expect(report.bestAction.winRate).toBeGreaterThanOrEqual(0);
    expect(report.bestAction.winRate).toBeLessThanOrEqual(1);
    expect(report.bestAction.confidence).toBeGreaterThanOrEqual(0);
    expect(report.bestAction.confidence).toBeLessThanOrEqual(1);
    expect(report.bestAction.sampleCount).toBeGreaterThan(0);
    // 合法性 + root 我方視角約束：bestAction 對真實盤面可套用、不 throw。
    expect(() => applyDecision(benchmarkDb, state, report.bestAction.decision)).not.toThrow();
  });

  it("determinism：同 seed 同 options → recommendations 完全一致", () => {
    const { state, decks } = setupServeDecision();
    const opts = { ...baseOptions(811), knownDecks: decks };
    const first = createIsmctsReport(benchmarkDb, state, opts);
    const second = createIsmctsReport(benchmarkDb, state, opts);
    expect(second.recommendations).toEqual(first.recommendations);
    expect(second.bestAction).toEqual(first.bestAction);
  });

  it("leakage hard gate：翻轉對手隱藏區（hand/setArea/deck）→ recommendations 不變", () => {
    const { state, decks } = setupServeDecision();
    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[1].hand.reverse();
    hiddenChanged.players[1].setArea.reverse();
    hiddenChanged.players[1].deck.reverse();
    const opts = { ...baseOptions(812), knownDecks: decks };
    expect(createIsmctsReport(benchmarkDb, hiddenChanged, opts).recommendations).toEqual(
      createIsmctsReport(benchmarkDb, state, opts).recommendations,
    );
  });

  it("Phase H pressure shaping 開啟時仍維持 determinism 與 leakage hard gate", () => {
    const { state, decks } = setupServeDecision();
    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[1].hand.reverse();
    hiddenChanged.players[1].setArea.reverse();
    hiddenChanged.players[1].deck.reverse();
    const opts = { ...baseOptions(813), knownDecks: decks, pressureShapingEpsilon: 0.05 };
    const first = createIsmctsReport(benchmarkDb, state, opts);
    const second = createIsmctsReport(benchmarkDb, state, opts);
    expect(second.recommendations).toEqual(first.recommendations);
    expect(createIsmctsReport(benchmarkDb, hiddenChanged, opts).recommendations).toEqual(first.recommendations);
  });

  it("Phase H H4 live default 等同 root pair tie-break delta 0.04", () => {
    const { state, decks } = setupServeDecision();
    const base = { ...baseOptions(814), knownDecks: decks };
    const implicit = createIsmctsReport(benchmarkDb, state, base);
    const explicit = createIsmctsReport(benchmarkDb, state, {
      ...base,
      rootPressureTieBreakDelta: 0.04,
      rootPairQualityTieBreak: true,
    });
    expect(implicit.bestAction).toEqual(explicit.bestAction);
    expect(implicit.recommendations).toEqual(explicit.recommendations);
  });

  it("Phase H root tie-break score 會偏好更高攻擊點的登場", () => {
    const deckA = findBenchmarkDeck("青葉城西-第三彈測試");
    const deckB = findBenchmarkDeck("青葉城西-第三彈測試");
    let state = createGame(benchmarkDb, { seed: 814, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state.turnPlayer = 0;
    state.phase = "attack";
    state.pendingDecision = { player: 0, type: "deploy-attack" };
    const options = deployableUids(benchmarkDb, state, 0, "attack")
      .map((uid) => ({ uid, value: effParam(benchmarkDb, state, uid, "attack") ?? 0 }))
      .sort((a, b) => a.value - b.value);
    const low = options[0]!;
    const high = options[options.length - 1]!;
    expect(high.value - low.value).toBeGreaterThanOrEqual(2);

    expect(rootDecisionPressureScore(benchmarkDb, state, { type: "deploy-attack", uid: high.uid }, 0)).toBeGreaterThan(
      rootDecisionPressureScore(benchmarkDb, state, { type: "deploy-attack", uid: low.uid }, 0),
    );
  });

  it("Phase H root pair tie-break 會把拖球與後續攻擊一起看", () => {
    const deckA = findBenchmarkDeck("青葉城西-第三彈測試");
    const deckB = findBenchmarkDeck("青葉城西-第三彈測試");
    let state = createGame(benchmarkDb, { seed: 815, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state.turnPlayer = 0;
    state.phase = "attack";
    state.pendingDecision = { player: 0, type: "deploy-toss" };

    const setterUid = state.players[0].hand[0]!;
    const dualThreatUid = state.players[0].hand[1]!;
    state.players[0].hand = [setterUid, dualThreatUid];
    state.cards[setterUid] = "HV-P01-033"; // 及川 徹：拖球 1 / 攻擊 0
    state.cards[dualThreatUid] = "HV-P02-018"; // 宮 侑：拖球 2 / 攻擊 3

    const betterDecision = { type: "deploy-toss", uid: setterUid } as const;
    const worseDecision = { type: "deploy-toss", uid: dualThreatUid } as const;
    const betterPair = (effParam(benchmarkDb, state, setterUid, "toss") ?? 0) + (effParam(benchmarkDb, state, dualThreatUid, "attack") ?? 0);
    const worsePair = (effParam(benchmarkDb, state, dualThreatUid, "toss") ?? 0) + (effParam(benchmarkDb, state, setterUid, "attack") ?? 0);

    const nonPairDelta =
      rootDecisionPressureScore(benchmarkDb, state, betterDecision, 0) -
      rootDecisionPressureScore(benchmarkDb, state, worseDecision, 0);
    const pairDelta =
      rootDecisionPressureScore(benchmarkDb, state, betterDecision, 0, { pairAware: true }) -
      rootDecisionPressureScore(benchmarkDb, state, worseDecision, 0, { pairAware: true });

    expect(effParam(benchmarkDb, state, setterUid, "toss") ?? 0).toBeLessThan(effParam(benchmarkDb, state, dualThreatUid, "toss") ?? 0);
    expect(betterPair).toBeGreaterThanOrEqual(worsePair + 2);
    expect(pairDelta).toBeGreaterThan(nonPairDelta);
  });

  it("availability-UCB：探索項分子用 availability，非 node.visits（防實作回歸到錯分母）", () => {
    // child：visits=4、mean=.5；availability=9（該 action 只在部分 world 合法 → availability < 假想 node.visits）。
    const c = Math.SQRT2;
    const expected = 0.5 + c * Math.sqrt(Math.log(9) / 4);
    expect(ucbScore(4, 2, 9, true, c)).toBeCloseTo(expected, 12);
    // 若誤用較大的 node.visits（例如 25）當分子，分數會不同 → 守住「分子＝availability」。
    const wrongWithNodeVisits = 0.5 + c * Math.sqrt(Math.log(25) / 4);
    expect(ucbScore(4, 2, 9, true, c)).not.toBeCloseTo(wrongWithNodeVisits, 6);
    // 對手節點 exploit 取 (1 − mean)＝樹內對抗。
    expect(ucbScore(4, 2, 9, false, c)).toBeCloseTo(1 - 0.5 + c * Math.sqrt(Math.log(9) / 4), 12);
  });
});

// [Claude 2026-07-02] Phase H H5：certainty-conditioned 資源節省 tie-break。
// 場景配方＝驗證過的「橫跨門檻」構造盤面（見 WORKLOG 2026-07-01「驗證可行的橫跨門檻 R4 替代場景」／
// 「在乾淨場景上實測 SO/MO」）：P0 有 weak(atk1)／strong(atk3) 兩張攻擊候選；P1 已知手牌小，
// rich（2 張已知，maxDP=4）需要 strong 才突破，poor（1 張已知，maxDP=2）weak 就夠贏、strong 是浪費。
// 用窮舉法驗證過這兩個門檻是真實存在的（不是 heuristic-rollout 近似），故可放心當單元測試的 ground truth。
const H5_FILLER = "HV-D01-005"; // 西谷夕，block/atk 皆低，純填充

function h5MoveToHand(state: GameState, p: PlayerId, cardId: string, used: Set<number>): number {
  const zones: (keyof GameState["players"][number])[] = ["hand", "deck", "setArea", "drop"];
  for (const zone of zones) {
    const arr = state.players[p][zone] as number[];
    const idx = arr.findIndex((uid) => !used.has(uid) && state.cards[uid] === cardId);
    if (idx < 0) continue;
    const [uid] = arr.splice(idx, 1);
    used.add(uid!);
    state.players[p].hand.push(uid!);
    return uid!;
  }
  throw new Error(`H5 test fixture: 找不到 ${cardId}`);
}
function h5MoveToToss(state: GameState, p: PlayerId, cardId: string, used: Set<number>): number {
  const uid = h5MoveToHand(state, p, cardId, used);
  state.players[p].hand.pop();
  state.players[p].toss.push(uid);
  return uid;
}
function h5KeepOnlyHand(state: GameState, p: PlayerId, uids: number[]) {
  const keep = new Set(uids);
  for (let i = state.players[p].hand.length - 1; i >= 0; i--) {
    const uid = state.players[p].hand[i]!;
    if (!keep.has(uid)) state.players[p].deck.push(state.players[p].hand.splice(i, 1)[0]!);
  }
}

/** 建構「橫跨門檻」場景：p1RichCount=2 → rich（maxDP=4，需要 strong）；=1 → poor（maxDP=2，weak 就夠）。 */
function buildH5StraddleScenario(seed: number, p1RichCount: 1 | 2) {
  const p0Toss = "HV-P03-022"; // 宮侑
  const p0Weak = "HV-D01-002"; // 影山飛雄 atk1
  const p0Strong = "HV-D01-006"; // 田中龍之介 atk3
  const p1Rich = ["HV-D01-006", "HV-D01-001"]; // 田中(block2)＋日向(block2)，不同名避開同名攔網限制
  const decks: [string[], string[]] = [
    Array(40)
      .fill(H5_FILLER)
      .map((f, i) => (i < 3 ? [p0Toss, p0Weak, p0Strong][i]! : f)),
    Array(40)
      .fill(H5_FILLER)
      .map((f, i) => (i < p1Rich.length ? p1Rich[i]! : f)),
  ];
  let state = createGame(benchmarkDb, { seed, decks, skipDeckValidation: true });
  state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
  state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });

  const used = new Set<number>();
  h5MoveToToss(state, 0, p0Toss, used);
  const weakUid = h5MoveToHand(state, 0, p0Weak, used);
  const strongUid = h5MoveToHand(state, 0, p0Strong, used);
  h5KeepOnlyHand(state, 0, [weakUid, strongUid]);

  const richUids = p1Rich.map((c) => h5MoveToHand(state, 1, c, used));
  h5KeepOnlyHand(state, 1, p1RichCount === 2 ? richUids : [richUids[0]!]);

  state.turnPlayer = 0;
  state.phase = "attack";
  state.sub = 0;
  state.op = null;
  state.dp = null;
  state.defenseChoice = null;
  state.pendingDecision = { player: 0, type: "deploy-attack", prompt: "H5 test fixture" };
  state.effectCtx = null;
  state.pendingQueue = [];
  return { state, weakUid, strongUid, decks };
}

describe("M8 Phase H H5 certainty-conditioned 資源節省 tie-break", () => {
  // iterations=800：300 時 poor 場景兩候選 winRate 太接近門檻（0.850 vs 0.824，雜訊大），800 才穩定收斂
  // （debug 實測 poor 側 weak winRate=0.880 > strong 0.863，見 WORKLOG 2026-07-01/02）。
  const h5Options = (seed: number, decks: readonly [readonly string[], readonly string[]], extra: Record<string, unknown> = {}) => ({
    perspectivePlayer: 0 as const,
    knownDecks: decks,
    seed,
    iterations: 800,
    candidateLimit: 8,
    leafRolloutHorizon: 4,
    ...extra,
  });

  // [Claude 2026-07-02] H5 v2 已 default-on（threshold=0.85，見 DEFAULT_ROOT_CONSERVATION_WIN_RATE_THRESHOLD）。
  // `disabled` 用 Number.POSITIVE_INFINITY 明確關閉 conservation（winRate 最大只會是 1，永遠達不到），
  // 當「H5 之前」的對照組；`h5Options(...)` 不帶 extra 就是 live 預設（0.85 現在會自動生效）。
  const disabled = { rootConservationWinRateThreshold: Number.POSITIVE_INFINITY };

  it("rich（贏面不確定，需要 strong 才突破）：conservation 關閉／預設(0.85) 都選 strong，不受影響", () => {
    const { state, strongUid, decks } = buildH5StraddleScenario(970, 2);
    const off = createIsmctsReport(benchmarkDb, state, h5Options(970, decks, disabled));
    const on = createIsmctsReport(benchmarkDb, state, h5Options(970, decks));
    expect(off.bestAction.decision).toMatchObject({ type: "deploy-attack", uid: strongUid });
    expect(on.bestAction.decision).toMatchObject({ type: "deploy-attack", uid: strongUid });
  });

  it("poor（贏面已確定，weak 就夠）：關閉 conservation 沿用純 H4 偏壓制力，會選不必要的 strong", () => {
    const { state, strongUid, decks } = buildH5StraddleScenario(970, 1);
    const off = createIsmctsReport(benchmarkDb, state, h5Options(970, decks, disabled));
    expect(off.bestAction.decision).toMatchObject({ type: "deploy-attack", uid: strongUid });
  });

  it("poor（贏面已確定，weak 就夠）：live 預設（0.85）改選 weak，省下 strong", () => {
    const { state, weakUid, decks } = buildH5StraddleScenario(970, 1);
    const on = createIsmctsReport(benchmarkDb, state, h5Options(970, decks));
    expect(on.bestAction.decision).toMatchObject({ type: "deploy-attack", uid: weakUid });
  });

  it("Phase H H5 live default 等同 threshold=0.85（[使用者 2026-07-02] 拍板上線）", () => {
    const { state, decks } = buildH5StraddleScenario(970, 1);
    const implicit = createIsmctsReport(benchmarkDb, state, h5Options(970, decks));
    const explicit = createIsmctsReport(benchmarkDb, state, h5Options(970, decks, { rootConservationWinRateThreshold: 0.85 }));
    expect(implicit.bestAction).toEqual(explicit.bestAction);
    expect(implicit.recommendations).toEqual(explicit.recommendations);
  });

  it("v1 回歸守則：conservation 只能動 deploy-attack，deploy-toss(pairAware) 關閉／極低門檻結果必須相同", () => {
    // v1（見 IsmctsOptions 文件註解）錯在把整條 rootDecisionPressureScore（含 pairAware 拖攻配對品質項）
    // 反轉、套用到所有決策類型；對 deploy-toss 而言，反轉方向在數學上等同「刻意選較差的拖攻配對」，是
    // 40 場 ship-gate no-go 的根因之一。此測試鎖死：即使 conservation 門檻極低（幾乎必然 active），
    // deploy-toss 這個決策點的 bestAction 也不能因為開啟 conservation 而改變。
    const deckA = findBenchmarkDeck("青葉城西-第三彈測試");
    const deckB = findBenchmarkDeck("青葉城西-第三彈測試");
    let state = createGame(benchmarkDb, { seed: 815, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state.turnPlayer = 0;
    state.phase = "attack";
    state.pendingDecision = { player: 0, type: "deploy-toss" };
    const setterUid = state.players[0].hand[0]!;
    const dualThreatUid = state.players[0].hand[1]!;
    state.players[0].hand = [setterUid, dualThreatUid];
    state.cards[setterUid] = "HV-P01-033"; // 及川 徹：拖球 1 / 攻擊 0
    state.cards[dualThreatUid] = "HV-P02-018"; // 宮 侑：拖球 2 / 攻擊 3

    const decks: [readonly string[], readonly string[]] = [deckA.ids, deckB.ids];
    const off = createIsmctsReport(benchmarkDb, state, h5Options(815, decks, disabled));
    const on = createIsmctsReport(benchmarkDb, state, h5Options(815, decks, { rootConservationWinRateThreshold: 0.01 }));
    expect(on.bestAction.decision).toMatchObject(off.bestAction.decision);
  });
});
