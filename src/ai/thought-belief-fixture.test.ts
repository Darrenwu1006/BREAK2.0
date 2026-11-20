import { describe, expect, it } from "vitest";
import { canApplyDecision } from "../engine/decisions";
import { applyDecision, createGame, freeOptions, normName } from "../engine/engine";
import type { GameState, PlayerId } from "../engine/types";
import type { ReplayEntry } from "../shared/replayHistory";
import { benchmarkDb, findBenchmarkDeck } from "./benchmark-fixtures";
import { heuristicAiDecision, heuristicProfileForDeckText } from "./heuristic";
import {
  courtGutsCount,
  currentDefenseDp,
  detectPublicHandAdditionsInEntry,
  evaluateThoughtBeliefFixture,
  hasLegalFollowupTossAttack,
  isBurstWaveSurvived,
  isDefensiveBuffEvent,
  isDrawOrTutorEvent,
  loadPhaseN0Fixture,
  validateKnownDecks,
  validateStateConservation,
  type RatioMetric,
} from "../../tools/eval-thought-belief";

function assertRateInUnitInterval(metric: RatioMetric): void {
  expect(metric.denominator).toBeGreaterThan(0);
  expect(metric.numerator).toBeGreaterThanOrEqual(0);
  expect(metric.numerator).toBeLessThanOrEqual(metric.denominator);
  expect(metric.rate).toBeGreaterThanOrEqual(0);
  expect(metric.rate).toBeLessThanOrEqual(1);
}

function multisetContains(superset: readonly string[], subset: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const id of superset) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of subset) {
    const left = counts.get(id) ?? 0;
    if (left <= 0) return false;
    counts.set(id, left - 1);
  }
  return true;
}

describe("M8 Phase N0 基準線診斷純函式與實戰殘局回歸夾具", () => {
  const fixture = loadPhaseN0Fixture();

  it("1. 夾具 schemaVersion 為 phase-n0-endgames-v1 且四大類別皆非空", () => {
    expect(fixture.schemaVersion).toBe("phase-n0-endgames-v1");
    expect(fixture.sourceReplayCount).toBe(63);
    expect(fixture.cases.safeFullHandDefEvent.length).toBeGreaterThan(0);
    expect(fixture.cases.safeMissingPairDraw.length).toBeGreaterThan(0);
    expect(fixture.cases.publicHandRecall.length).toBeGreaterThan(0);
    expect(fixture.cases.highGutsBurst.length).toBeGreaterThan(0);
  });

  it("2. 每題皆通過 80 張卡守恆、AI(player=1) 待決策、歷史決策合法且現行 Heuristic 合法", () => {
    const allCases = [
      ...fixture.cases.safeFullHandDefEvent,
      ...fixture.cases.safeMissingPairDraw,
      ...fixture.cases.publicHandRecall,
      ...fixture.cases.highGutsBurst,
    ];

    for (const item of allCases) {
      expect(validateKnownDecks(benchmarkDb, item.knownDecks), `${item.id} knownDecks`).toBe(true);
      expect(validateStateConservation(benchmarkDb, item.state, item.knownDecks), `${item.id} 80張卡守恆`).toBe(true);
      expect(item.aiPlayer).toBe(1);
      expect(item.state.pendingDecision?.player, `${item.id} pending player`).toBe(1);
      expect(
        canApplyDecision(benchmarkDb, item.state, item.historicalDecision),
        `${item.id} historicalDecision 合法`,
      ).toBe(true);

      const profile = heuristicProfileForDeckText(item.deckLabels[1]);
      const hDecision = heuristicAiDecision(benchmarkDb, item.state, profile);
      expect(
        canApplyDecision(benchmarkDb, item.state, hDecision),
        `${item.id} heuristicAiDecision(${profile}) 合法`,
      ).toBe(true);
    }
  });

  it("3. 各類別皆嚴格滿足自身盤面不變量與公開日誌溯源", () => {
    for (const item of fixture.cases.safeFullHandDefEvent) {
      expect(["receive", "block"]).toContain(item.state.phase);
      expect(item.state.pendingDecision?.type).toBe("free");
      const incomingOp = item.state.op && item.state.op.owner !== 1 ? item.state.op.value : 0;
      expect(incomingOp).toBeGreaterThan(0);
      expect(currentDefenseDp(benchmarkDb, item.state, 1)).toBeGreaterThanOrEqual(incomingOp);
      expect(hasLegalFollowupTossAttack(benchmarkDb, item.state, 1)).toBe(true);
      expect(courtGutsCount(item.state, 0)).toBeGreaterThanOrEqual(3);

      const phase = item.state.phase as "receive" | "block";
      const defEvents = freeOptions(benchmarkDb, item.state).events.filter((ev) => {
        const cardId = item.state.cards[ev.uid]!;
        return isDefensiveBuffEvent(benchmarkDb.get(cardId)!, phase);
      });
      expect(defEvents.length).toBeGreaterThan(0);
      expect(item.metadata.playableDefBuffEventUids).toEqual(defEvents.map((e) => e.uid));
    }

    for (const item of fixture.cases.safeMissingPairDraw) {
      expect(["receive", "block"]).toContain(item.state.phase);
      expect(item.state.pendingDecision?.type).toBe("free");
      const incomingOp = item.state.op && item.state.op.owner !== 1 ? item.state.op.value : 0;
      expect(incomingOp).toBeGreaterThan(0);
      expect(currentDefenseDp(benchmarkDb, item.state, 1)).toBeGreaterThanOrEqual(incomingOp);
      expect(hasLegalFollowupTossAttack(benchmarkDb, item.state, 1)).toBe(false);

      const drawEvents = freeOptions(benchmarkDb, item.state).events.filter((ev) => {
        const cardId = item.state.cards[ev.uid]!;
        return isDrawOrTutorEvent(benchmarkDb.get(cardId)!);
      });
      expect(drawEvents.length).toBeGreaterThan(0);
      expect(item.metadata.playableDrawDefEventUids).toEqual(drawEvents.map((e) => e.uid));
    }

    for (const item of fixture.cases.publicHandRecall) {
      const expectedIds = item.metadata.expectedKnownOppHandCardIds ?? [];
      expect(expectedIds.length).toBeGreaterThan(0);
      const oppHandCardIds = item.state.players[0].hand.map((uid) => item.state.cards[uid]!).filter(Boolean);
      expect(multisetContains(oppHandCardIds, expectedIds), `${item.id} 公開卡仍在對手手牌`).toBe(true);

      // 以 state.log 驗證該卡片確有公開入手紀錄（公開區入手或 公開牌組頂 + 加入手牌），絕不偷窺純隱藏抽牌
      for (const cardId of expectedIds) {
        const cardName = normName(benchmarkDb.get(cardId)!.nameJa);
        const hasPublicAddLog = item.state.log.some(
          (l) =>
            l.setNo === item.state.setNo &&
            l.player === 0 &&
            (normName(l.text) === `公開牌組頂：${cardName}` ||
              normName(l.text) === `${cardName} 加入手牌` ||
              normName(l.text) === `${cardName} 從事件區加入手牌` ||
              normName(l.text) === `${cardName} 回到手牌`),
        );
        expect(hasPublicAddLog, `${item.id} state.log 缺少 ${cardName} 公開入手證據`).toBe(true);
      }
    }

    for (const item of fixture.cases.highGutsBurst) {
      const incomingOp = item.state.op && item.state.op.owner !== 1 ? item.state.op.value : 0;
      const oppGuts = courtGutsCount(item.state, 0);
      expect(incomingOp >= 7 || (oppGuts >= 4 && incomingOp >= 5)).toBe(true);
    }
  });

  it("4. 純函式單元檢查：防禦事件分類、抽濾分類、公開入手偵測（拒絕隱藏抽牌／lookTopTutor）", () => {
    const pureDef = benchmarkDb.get("HV-D04-013")!; // receive +1 + script（靜態 actions 不含 draw/tutor）
    const pureDraw = benchmarkDb.get("HV-P01-089")!; // 闇路建行: lookTopTutor, no DP buff
    const twoPickDraw = benchmarkDb.get("HV-P03-079")!; // lookTopTwoPick
    const blockBuff = benchmarkDb.get("HV-P01-079")!; // block only + draw
    const bothBuff = benchmarkDb.get("HV-D02-011")!; // block & receive + draw

    expect(isDefensiveBuffEvent(pureDef, "receive")).toBe(true);
    expect(isDefensiveBuffEvent(pureDef, "block")).toBe(false);
    expect(isDefensiveBuffEvent(pureDraw)).toBe(false);
    expect(isDefensiveBuffEvent(blockBuff, "block")).toBe(true);
    expect(isDefensiveBuffEvent(blockBuff, "receive")).toBe(false);
    expect(isDefensiveBuffEvent(bothBuff, "receive")).toBe(true);
    expect(isDefensiveBuffEvent(bothBuff, "block")).toBe(true);

    expect(isDrawOrTutorEvent(pureDraw)).toBe(true);
    expect(isDrawOrTutorEvent(twoPickDraw)).toBe(true);
    expect(isDrawOrTutorEvent(bothBuff)).toBe(true);
    expect(isDrawOrTutorEvent(pureDef)).toBe(false);

    // 確認 currentDefenseDp 與 hasLegalFollowupTossAttack 在夾具樣本上正常運作
    const safeFullItem = fixture.cases.safeFullHandDefEvent[0]!;
    expect(currentDefenseDp(benchmarkDb, safeFullItem.state, 1)).toBe(safeFullItem.metadata.currentDefenseDp);
    expect(hasLegalFollowupTossAttack(benchmarkDb, safeFullItem.state, 1)).toBe(true);

    // 公開入手偵測邊界：拒絕普通抽牌與 lookTopTutor 偷窺，接受公開區與 revealTopTutor
    const deckA = findBenchmarkDeck("青葉城西-四彈新及岩控制_指揮者京谷版");
    const deckB = findBenchmarkDeck("烏野-四彈影日與同步攻擊");
    let base = createGame(benchmarkDb, { seed: 4242, decks: [deckA.ids, deckB.ids] });
    base = applyDecision(benchmarkDb, base, { type: "serve-rights", take: base.pendingDecision!.player === 0 });
    base = applyDecision(benchmarkDb, base, { type: "mulligan", returnUids: [] });
    base = applyDecision(benchmarkDb, base, { type: "mulligan", returnUids: [] });

    const uidFromDrop = base.players[0].deck[0]!;
    const uidFromHiddenDraw = base.players[0].deck[1]!;
    const uidFromReveal = base.players[0].deck[2]!;
    const uidFromLookTutor = base.players[0].deck[3]!;

    const beforeMock: GameState = structuredClone(base);
    beforeMock.players[0].drop.push(uidFromDrop);
    beforeMock.players[0].deck = beforeMock.players[0].deck.filter((u) => u !== uidFromDrop);

    const afterMock: GameState = structuredClone(beforeMock);
    afterMock.players[0].drop = [];
    afterMock.players[0].deck = afterMock.players[0].deck.filter(
      (u) => u !== uidFromHiddenDraw && u !== uidFromReveal && u !== uidFromLookTutor,
    );
    afterMock.players[0].hand.push(uidFromDrop, uidFromHiddenDraw, uidFromReveal, uidFromLookTutor);
    const revealName = benchmarkDb.get(afterMock.cards[uidFromReveal]!)!.nameJa;
    const lookName = benchmarkDb.get(afterMock.cards[uidFromLookTutor]!)!.nameJa;
    const logStart = beforeMock.log.length;
    afterMock.log.push(
      { setNo: afterMock.setNo, turnNo: afterMock.turnNo, player: 0, text: "抽 1 張卡" },
      { setNo: afterMock.setNo, turnNo: afterMock.turnNo, player: 0, text: `公開牌組頂：${revealName}` },
      { setNo: afterMock.setNo, turnNo: afterMock.turnNo, player: 0, text: `${revealName} 加入手牌` },
      { setNo: afterMock.setNo, turnNo: afterMock.turnNo, player: 0, text: "查看牌組頂 3 張" },
      { setNo: afterMock.setNo, turnNo: afterMock.turnNo, player: 0, text: `${lookName} 加入手牌` },
    );

    const mockEntry: ReplayEntry = {
      index: 0,
      player: 0,
      source: "player",
      phase: beforeMock.phase,
      setNo: beforeMock.setNo,
      turnNo: beforeMock.turnNo,
      pendingType: "free",
      decision: { type: "free", action: "pass" },
      before: beforeMock,
      after: afterMock,
      logStart,
      logEnd: afterMock.log.length,
    };

    const detected = detectPublicHandAdditionsInEntry(mockEntry, 0 as PlayerId);
    expect(detected).toContain(uidFromDrop);
    expect(detected).toContain(uidFromReveal);
    expect(detected).not.toContain(uidFromHiddenDraw);
    // lookName 若剛好與 revealName 同名也只會配對 1 張（remainingRevealed 逐筆消耗）；不同名則絕不納入
    if (normName(lookName) !== normName(revealName)) {
      expect(detected).not.toContain(uidFromLookTutor);
    }
    expect(detected.length).toBe(2);

    // 確認高壓波次函式對第 1 題 highGutsBurst 執行無誤
    const burstCase = fixture.cases.highGutsBurst[0]!;
    const survived = isBurstWaveSurvived(
      benchmarkDb,
      burstCase.state,
      burstCase.knownDecks,
      1,
      "heuristic",
      777,
      8,
    );
    expect(typeof survived).toBe("boolean");
  });

  it("5 & 6. evaluateThoughtBeliefFixture 快速煙霧驗證：確定性完全一致且所有指標落於 [0, 1]", () => {
    const first = evaluateThoughtBeliefFixture({
      fixture,
      ismctsIterations: 8,
      recallSeeds: 5,
      seed: 20261120,
      runIsmcts: true,
    });
    const second = evaluateThoughtBeliefFixture({
      fixture,
      ismctsIterations: 8,
      recallSeeds: 5,
      seed: 20261120,
      runIsmcts: true,
    });

    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe("phase-n0-endgames-v1");
    expect(first.ismcts).toBeDefined();

    for (const report of [first.historical, first.heuristic, first.ismcts!]) {
      assertRateInUnitInterval(report.safeFullHandDefEventBurnRate);
      assertRateInUnitInterval(report.safeMissingPairDrawRate);
      assertRateInUnitInterval(report.highGutsSurvivalRate);
      assertRateInUnitInterval(report.highGutsSurvivalRate.op7Plus);
      expect(report.publicHandRecallAccuracy.caseCount).toBe(fixture.cases.publicHandRecall.length);
      expect(report.publicHandRecallAccuracy.accuracy).toBeGreaterThanOrEqual(0);
      expect(report.publicHandRecallAccuracy.accuracy).toBeLessThanOrEqual(1);
    }
  });
});
