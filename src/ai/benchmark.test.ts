import { describe, expect, it } from "vitest";
import { applyDecision, createGame, deployableUids, effParam } from "../engine/engine";
import { benchmarkDb, benchmarkDecks, findBenchmarkDeck } from "./benchmark-fixtures";
import { benchmarkPolicyDecision, configureIsmctsBenchmark, configurePimcBenchmark, mirroredSeeds, playBenchmarkMatch, recordPlayQualityDecision, runBenchmarkBatch, runBenchmarkMatrix, seededRnd } from "./benchmark";
import type { BenchmarkPolicyId, PlayQualityStats } from "./benchmark";
import { BENCHMARK_REPORT_SCHEMA_VERSION, createBenchmarkReportEnvelope } from "./benchmark-report";

describe("M8 benchmark harness", () => {
  function blankPlayQualityStats(): PlayQualityStats {
    return {
      lowPointDeploy: {
        toss: { opportunities: 0, lowPointChoices: 0, totalDeficit: 0, maxDeficit: 0 },
        attack: { opportunities: 0, lowPointChoices: 0, totalDeficit: 0, maxDeficit: 0 },
      },
      defenseSkillNonUse: { opportunities: 0, nonUses: 0 },
    };
  }

  it("同一組 seed 重跑會得到一致結果", () => {
    const deckA = findBenchmarkDeck("烏野-預組");
    const deckB = findBenchmarkDeck("音駒-預組");
    const config = {
      db: benchmarkDb,
      decks: [deckA, deckB] as const,
      policies: ["heuristic-v2", "random"] as const,
      seed: 120,
      maxSteps: 5000,
    };

    const first = playBenchmarkMatch(config);
    const second = playBenchmarkMatch(config);

    expect(second.outcome).toBe(first.outcome);
    expect(second.winner).toBe(first.winner);
    expect(second.steps).toBe(first.steps);
    expect(second.lostBy).toEqual(first.lostBy);
    expect(second.setResults).toEqual(first.setResults);
    expect(second.averageRalliesPerSet).toBe(first.averageRalliesPerSet);
    expect(second.invariants).toEqual(first.invariants);
  });

  it("batch summary 會輸出勝率、信賴區間與完成數", () => {
    const report = runBenchmarkBatch({
      db: benchmarkDb,
      decks: [findBenchmarkDeck("烏野-預組"), findBenchmarkDeck("音駒-預組")],
      policies: ["heuristic-v2", "random"],
      seeds: mirroredSeeds(130, 4),
      maxSteps: 5000,
    });

    expect(report.matches).toHaveLength(4);
    expect(report.summary.completed).toBe(4);
    expect(report.summary.errored).toBe(0);
    expect(report.summary.maxSteps).toBe(0);
    expect(report.summary.player0WinRate).toBeGreaterThanOrEqual(0);
    expect(report.summary.player0WinRate).toBeLessThanOrEqual(1);
    expect(report.summary.player0WinRate95.low).toBeGreaterThanOrEqual(0);
    expect(report.summary.player0WinRate95.high).toBeLessThanOrEqual(1);
    expect(report.summary.averageSteps).toBeGreaterThan(0);
    expect(report.summary.averageRalliesPerSet).toBeGreaterThan(0);
    expect(Object.values(report.summary.setWinsByReason).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    expect(Object.values(report.summary.lostReasons).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    for (const match of report.matches) {
      expect(match.setResults.length, `seed ${match.seed}`).toBeGreaterThan(0);
      expect(match.averageRalliesPerSet, `seed ${match.seed}`).toBeGreaterThan(0);
      expect(match.stats.players[0].opBySource.attack.count + match.stats.players[1].opBySource.attack.count, `seed ${match.seed}`).toBeGreaterThan(0);
      expect(match.stats.players[0].gutsPaidBySource.attack + match.stats.players[1].gutsPaidBySource.attack, `seed ${match.seed}`).toBeGreaterThanOrEqual(0);
    }
    expect(report.summary.playQualityByPlayer[0].lowPointDeployRate).toBeGreaterThanOrEqual(0);
    expect(report.summary.playQualityByPlayer[0].lowPointDeployRate).toBeLessThanOrEqual(1);
    expect(report.summary.playQualityByPlayer[0].defenseSkillNonUseRate).toBeGreaterThanOrEqual(0);
    expect(report.summary.playQualityByPlayer[0].defenseSkillNonUseRate).toBeLessThanOrEqual(1);
    expect(report.summary.playQualityByPlayer[0].averageOpPressure).toBeGreaterThanOrEqual(0);
  });

  it("Phase H 行為尺會計入明顯低於手中最高點的攻擊登場", () => {
    const deckA = findBenchmarkDeck("烏野-預組");
    const deckB = findBenchmarkDeck("音駒-預組");
    let state = createGame(benchmarkDb, { seed: 171, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    const p = 0;
    state.turnPlayer = p;
    state.phase = "attack";
    state.pendingDecision = { player: p, type: "deploy-attack" };

    const attackOptions = deployableUids(benchmarkDb, state, p, "attack")
      .map((uid) => ({ uid, value: effParam(benchmarkDb, state, uid, "attack") ?? 0 }))
      .sort((a, b) => a.value - b.value);
    const low = attackOptions[0]!;
    const high = attackOptions[attackOptions.length - 1]!;
    expect(high.value - low.value).toBeGreaterThanOrEqual(2);

    const stats = blankPlayQualityStats();
    recordPlayQualityDecision(benchmarkDb, state, { type: "deploy-attack", uid: low.uid }, stats);

    expect(stats.lowPointDeploy.attack.opportunities).toBe(1);
    expect(stats.lowPointDeploy.attack.lowPointChoices).toBe(1);
    expect(stats.lowPointDeploy.attack.totalDeficit).toBe(high.value - low.value);
    expect(stats.lowPointDeploy.attack.maxDeficit).toBe(high.value - low.value);
  });

  it("Phase H 行為尺會計入防守中拒絕可用技能的怠用", () => {
    const deckA = findBenchmarkDeck("烏野-預組");
    const deckB = findBenchmarkDeck("音駒-預組");
    let state = createGame(benchmarkDb, { seed: 172, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state.phase = "block";
    state.turnPlayer = 0;
    state.op = { owner: 1, value: 5, source: "attack" };
    state.pendingDecision = { player: 0, type: "effect-confirm", prompt: "3ガッツ払えば使える" };
    state.effectCtx = {
      player: 0,
      source: state.players[0].hand[0]!,
      frames: [],
      lastTarget: null,
      triggerUid: null,
      turn1: false,
      anyExecuted: false,
      awaiting: { kind: "confirm", what: "gate", costs: [], then: [], prompt: "3ガッツ払えば使える" },
      desc: "黒尾 鉄朗 的技能",
    };

    const stats = blankPlayQualityStats();
    recordPlayQualityDecision(benchmarkDb, state, { type: "effect-confirm", accept: false }, stats);

    expect(stats.defenseSkillNonUse.opportunities).toBe(1);
    expect(stats.defenseSkillNonUse.nonUses).toBe(1);
  });

  it("benchmark 牌組池會包含 UI 新增牌組且都是 40 張", () => {
    expect(benchmarkDecks.length).toBeGreaterThanOrEqual(14);
    expect(benchmarkDecks.some((deck) => deck.name === "稻荷崎-0612測試")).toBe(true);
    for (const deck of benchmarkDecks) {
      expect(deck.ids, deck.name).toHaveLength(40);
      expect(deck.axes.length, deck.name).toBeGreaterThan(0);
    }
  });

  it("heuristic-v1 可作為粗略歷史基準跑完整場", () => {
    const result = playBenchmarkMatch({
      db: benchmarkDb,
      decks: [findBenchmarkDeck("烏野-預組"), findBenchmarkDeck("音駒-預組")],
      policies: ["heuristic-v1", "random"],
      seed: 150,
      maxSteps: 5000,
    });
    expect(result.outcome).toBe("complete");
    expect(result.invariants.every((entry) => entry.ok)).toBe(true);
  });

  it("ring matrix 可跑完 benchmark 牌組池固定煙霧測試", () => {
    const report = runBenchmarkMatrix({
      db: benchmarkDb,
      decks: benchmarkDecks,
      policies: ["heuristic-v2", "random"],
      seedStart: 300,
      gamesPerPair: 1,
      maxSteps: 5000,
      mode: "ring",
    });

    expect(report.summary.pairs).toBe(benchmarkDecks.length);
    expect(report.summary.totalGames).toBe(benchmarkDecks.length);
    expect(report.summary.completed).toBe(benchmarkDecks.length);
    expect(report.summary.errored).toBe(0);
    expect(report.summary.maxSteps).toBe(0);
    expect(Object.keys(report.summary.winsByAxis).length).toBeGreaterThan(0);
    expect(report.summary.averageRalliesPerSet).toBeGreaterThan(0);
    expect(Object.keys(report.summary.setWinsByReason).length).toBeGreaterThan(0);
  });

  it("非隨機 policy 不會依賴對手隱藏手牌、Set 或牌組順序", () => {
    const deckA = findBenchmarkDeck("烏野-預組");
    const deckB = findBenchmarkDeck("音駒-預組");
    let state = createGame(benchmarkDb, { seed: 170, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    expect(state.pendingDecision?.type).toBe("deploy-serve");

    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[1].hand.reverse();
    hiddenChanged.players[1].deck.reverse();
    hiddenChanged.players[1].setArea.reverse();

    for (const policy of ["heuristic-v1", "heuristic-v2", "heuristic-v2-safe", "heuristic-v2-aggressive", "heuristic-v2-personality"] satisfies BenchmarkPolicyId[]) {
      const rndA = [seededRnd(1), seededRnd(2)] as [() => number, () => number];
      const rndB = [seededRnd(1), seededRnd(2)] as [() => number, () => number];
      expect(benchmarkPolicyDecision(policy, benchmarkDb, hiddenChanged, rndB)).toEqual(
        benchmarkPolicyDecision(policy, benchmarkDb, state, rndA),
      );
    }
  });

  it("heuristic-v2 權重變體可作為 benchmark policy 跑完整場", () => {
    for (const policy of ["heuristic-v2-safe", "heuristic-v2-aggressive", "heuristic-v2-block", "heuristic-v2-personality"] satisfies BenchmarkPolicyId[]) {
      const result = playBenchmarkMatch({
        db: benchmarkDb,
        decks: [findBenchmarkDeck("烏野-預組"), findBenchmarkDeck("音駒-預組")],
        policies: [policy, "random"],
        seed: policy === "heuristic-v2-safe" ? 180 : policy === "heuristic-v2-aggressive" ? 181 : policy === "heuristic-v2-block" ? 182 : 183,
        maxSteps: 5000,
      });
      expect(result.outcome, policy).toBe("complete");
      expect(result.policies[0]).toBe(policy);
      expect(result.invariants.every((entry) => entry.ok)).toBe(true);
    }
  });

  it("personality policy 讓真實攔網軸牌組至少產生攔網登場或攔網 OP 訊號", () => {
    for (const deckName of ["伊達工業-攔網軸", "烏野-山月攔網軸"]) {
      const report = runBenchmarkBatch({
        db: benchmarkDb,
        decks: [findBenchmarkDeck(deckName), findBenchmarkDeck("烏野-預組")],
        policies: ["heuristic-v2-personality", "heuristic-v2"],
        seeds: mirroredSeeds(deckName === "伊達工業-攔網軸" ? 2620 : 2630, 2),
        maxSteps: 5000,
      });
      const targetStats = report.matches.map((match) => match.stats.players[0]);
      const blockSignals = targetStats.reduce((sum, stats) => sum + stats.deployments.block + stats.opBySource.block.count, 0);
      expect(report.summary.completed, deckName).toBe(2);
      expect(blockSignals, deckName).toBeGreaterThan(0);
    }
  });

  it("benchmark report envelope 會包含 schema 與 engine/package metadata", () => {
    const report = runBenchmarkBatch({
      db: benchmarkDb,
      decks: [findBenchmarkDeck("烏野-預組"), findBenchmarkDeck("音駒-預組")],
      policies: ["heuristic-v2-safe", "heuristic-v2-aggressive"],
      seeds: [190],
      maxSteps: 5000,
    });
    const envelope = createBenchmarkReportEnvelope("batch", report, ["--games=1"], "2026-06-16T00:00:00.000Z");

    expect(envelope.schemaVersion).toBe(BENCHMARK_REPORT_SCHEMA_VERSION);
    expect(envelope.metadata.appName).toBe("breaktcg");
    expect(envelope.metadata.appVersion).toBe("0.1.0");
    expect(envelope.metadata.engineVersion).toBe("0.1.0");
    expect(envelope.metadata.benchmarkSchemaVersion).toBe(BENCHMARK_REPORT_SCHEMA_VERSION);
    if (!("deckCards" in envelope.report.config)) throw new Error("expected batch report config");
    expect(envelope.report.config.deckCards[0]).toHaveLength(40);
    expect(envelope.report.summary.averageRalliesPerSet).toBeGreaterThan(0);
  });

  // [Claude 2026-06-22] Phase F：PIMC 接成 benchmark policy。此處只驗單一決策點（接上＋合法＋不洩漏）；
  // 全場強度量測由 CLI 小規模實跑承擔，因為全場逐點搜尋的成本正是 sample budget gate 要決定的事。
  it("pimc policy 可在 benchmark harness 產生合法決策並維持隱藏資訊不洩漏", () => {
    configurePimcBenchmark({ sampleCount: 4, rolloutMaxSteps: 150, candidateLimit: 4 });
    const deckA = findBenchmarkDeck("烏野-預組");
    const deckB = findBenchmarkDeck("音駒-預組");
    let state = createGame(benchmarkDb, { seed: 170, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    expect(state.pendingDecision?.type).toBe("deploy-serve");

    const axes = [deckA.axes, deckB.axes] as const;
    const known = [deckA.ids, deckB.ids] as const;
    const acting = state.pendingDecision!.player;
    const oppo = acting === 0 ? 1 : 0;

    const decision = benchmarkPolicyDecision("pimc", benchmarkDb, state, [seededRnd(1), seededRnd(2)], axes, known);
    expect(decision.type).toBeTruthy();
    expect(() => applyDecision(benchmarkDb, state, decision)).not.toThrow();

    // 翻轉「對手」隱藏區（手牌/牌庫/Set），PIMC 應靠抽樣得到相同決策，不偷看真實隱藏資訊。
    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[oppo].hand.reverse();
    hiddenChanged.players[oppo].deck.reverse();
    hiddenChanged.players[oppo].setArea.reverse();
    const fromHidden = benchmarkPolicyDecision("pimc", benchmarkDb, hiddenChanged, [seededRnd(1), seededRnd(2)], axes, known);
    const fromClean = benchmarkPolicyDecision("pimc", benchmarkDb, state, [seededRnd(1), seededRnd(2)], axes, known);
    expect(fromHidden).toEqual(fromClean);
  });

  it("is-mcts-h2 / h2b / h2c policy 可在 benchmark harness 產生合法決策並維持隱藏資訊不洩漏", () => {
    configureIsmctsBenchmark({ iterations: 80, candidateLimit: 6, leafRolloutHorizon: 10 });
    const deckA = findBenchmarkDeck("青葉城西-第三彈測試");
    const deckB = findBenchmarkDeck("青葉城西-第三彈測試");
    let state = createGame(benchmarkDb, { seed: 191, decks: [deckA.ids, deckB.ids] });
    state = applyDecision(benchmarkDb, state, { type: "serve-rights", take: state.pendingDecision!.player === 0 });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });
    state = applyDecision(benchmarkDb, state, { type: "mulligan", returnUids: [] });

    const axes = [deckA.axes, deckB.axes] as const;
    const known = [deckA.ids, deckB.ids] as const;
    const acting = state.pendingDecision!.player;
    const oppo = acting === 0 ? 1 : 0;

    const hiddenChanged = structuredClone(state);
    hiddenChanged.players[oppo].hand.reverse();
    hiddenChanged.players[oppo].deck.reverse();
    hiddenChanged.players[oppo].setArea.reverse();
    for (const policy of ["is-mcts-h2", "is-mcts-h2b", "is-mcts-h2c"] satisfies BenchmarkPolicyId[]) {
      const decision = benchmarkPolicyDecision(policy, benchmarkDb, state, [seededRnd(1), seededRnd(2)], axes, known);
      expect(decision.type, policy).toBeTruthy();
      expect(() => applyDecision(benchmarkDb, state, decision), policy).not.toThrow();
      const fromHidden = benchmarkPolicyDecision(policy, benchmarkDb, hiddenChanged, [seededRnd(1), seededRnd(2)], axes, known);
      const fromClean = benchmarkPolicyDecision(policy, benchmarkDb, state, [seededRnd(1), seededRnd(2)], axes, known);
      expect(fromHidden, policy).toEqual(fromClean);
    }
  });
});
