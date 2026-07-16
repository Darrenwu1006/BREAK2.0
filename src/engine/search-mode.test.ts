import { describe, expect, it } from "vitest";
import { applyDecision, createGame } from "./engine";
import type { GameState } from "./types";
import { benchmarkDb, findBenchmarkDeck } from "../ai/benchmark-fixtures";
import { heuristicAiDecision } from "../ai/heuristic";

function stripLog(state: GameState): Omit<GameState, "log"> {
  const { log: _log, ...rest } = state;
  return rest;
}

describe("Phase J J1 search exec mode", () => {
  it("matches live state transitions except for log across deterministic games", () => {
    const pairs = [
      ["烏野-預組", "音駒-音駒-三彈官方", 710],
      ["梟谷-第三彈官方", "白鳥沢-最強白鳥沢", 720],
      ["伊達工業-攔網軸改_韋宏", "青葉城西-第三彈測試", 730],
    ] as const;

    for (const [deckAName, deckBName, seed] of pairs) {
      const deckA = findBenchmarkDeck(deckAName);
      const deckB = findBenchmarkDeck(deckBName);
      let live = createGame(benchmarkDb, { seed, decks: [deckA.ids, deckB.ids] });
      let search = structuredClone(live) as GameState;

      for (let step = 0; step < 120 && live.phase !== "gameOver"; step++) {
        expect(stripLog(search), `${deckAName} vs ${deckBName} step ${step}`).toEqual(stripLog(live));
        if (!live.pendingDecision) break;
        const decision = heuristicAiDecision(benchmarkDb, live, "heuristic-v2");
        live = applyDecision(benchmarkDb, live, decision);
        search = applyDecision(benchmarkDb, search, decision, { execMode: "search" });
        expect(search.log, `${deckAName} vs ${deckBName} search log step ${step}`).toHaveLength(0);
      }

      expect(stripLog(search), `${deckAName} vs ${deckBName} final`).toEqual(stripLog(live));
      expect(live.log.length, `${deckAName} vs ${deckBName} live log`).toBeGreaterThan(0);
      expect(search.log, `${deckAName} vs ${deckBName} search log final`).toHaveLength(0);
    }
  });
});
