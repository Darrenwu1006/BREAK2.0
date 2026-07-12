import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import aobaDeck from "../../../data/decks/青葉城西-第三彈測試.json";
import fukurodaniDeck from "../../../data/decks/梟谷-第三彈官方.json";
import inarizakiDeck from "../../../data/decks/稲荷崎-稲荷崎_三彈官方.json";
import type { Card } from "../../data/types";
import { heuristicAiDecision } from "../../ai/heuristic";
import type { CardDb, Decision } from "../../engine/types";
import { deckWith, feed, FILLER, grab, placeOnStack, receiveTrack, serveWith, setup } from "../../engine/testkit";
import { LabGameController } from "./controller";

const expand = (deck: { cards: { id: string; count: number }[] }): string[] => deck.cards.flatMap((entry) => Array(entry.count).fill(entry.id));
const db: CardDb = new Map((cardsJson as unknown as Card[]).map((card) => [card.id, card]));
const decks = [aobaDeck, fukurodaniDeck, inarizakiDeck] as const;

describe("CP6B effect parity acceptance", () => {
  it("effect-rich 真實牌組可由 ui-lab controller 走過 confirm/cards/option 並完成對局", () => {
    const seen = new Set<Decision["type"]>();
    for (let index = 0; index < decks.length; index++) {
      const deck = decks[index];
      if (!deck) throw new Error(`missing CP6B fixture deck at index ${index}`);
      const list = expand(deck);
      const controller = new LabGameController(db, [list, list], 700 + index * 97);
      for (let step = 0; step < 1000 && controller.engine.pendingDecision; step++) {
        seen.add(controller.engine.pendingDecision.type);
        controller.decide(heuristicAiDecision(db, controller.engine), true);
        controller.timeline.skip();
      }
      expect(controller.engine.phase).toBe("gameOver");
    }
    for (const type of ["effect-confirm", "effect-cards", "effect-option"] as const) {
      expect(seen.has(type), `應走到 ${type}`).toBe(true);
    }
  });

  it("兩個分散來源待機技能可由 controller 選擇解決順序", () => {
    let state = setup(deckWith("HV-P01-047", "HV-P01-043", "HV-P01-050", "HV-P01-046"), deckWith("HV-D01-002"), 1);
    state = serveWith(state, "HV-D01-002");
    state = receiveTrack(state, "HV-P01-050");
    state = feed(state, { type: "deploy-toss", uid: grab(state, 0, "HV-P01-046") });
    state = feed(state, { type: "free", action: "pass" });
    const konoha = placeOnStack(state, 0, "attack", "HV-P01-047");
    state = feed(state, { type: "deploy-attack", uid: grab(state, 0, "HV-P01-043") });
    expect(state.pendingDecision).toMatchObject({ type: "resolve-pending" });
    expect(state.pendingDecision?.candidates).toHaveLength(2);

    const controller = new LabGameController(db, [expand(aobaDeck), expand(aobaDeck)], 991);
    controller.timeline.skip();
    controller.engine = state;
    const item = state.pendingQueue.find((candidate) => candidate.source === konoha)!;
    controller.decide({ type: "resolve-pending", id: item.id });
    controller.timeline.skip();
    expect(controller.replay.entries.at(-1)?.pendingType).toBe("resolve-pending");
    expect(controller.engine.pendingDecision?.type).toBe("effect-confirm");
  });
});
