import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import karasunoDeck from "../../../data/decks/烏野-預組.json";
import nekomaDeck from "../../../data/decks/音駒-預組.json";
import { heuristicAiDecision } from "../../ai/heuristic";
import type { Card } from "../../data/types";
import type { CardDb, Decision } from "../../engine/types";
import { LabGameController } from "./controller";

interface DeckJson { cards: { id: string; count: number }[] }
const expand = (deck: DeckJson): string[] => deck.cards.flatMap((entry) => Array(entry.count).fill(entry.id));
const db: CardDb = new Map((cardsJson as unknown as Card[]).map((card) => [card.id, card]));
const decks: [string[], string[]] = [expand(karasunoDeck as DeckJson), expand(nekomaDeck as DeckJson)];

function decideCurrent(controller: LabGameController): void {
  const decision = heuristicAiDecision(db, controller.engine);
  if (controller.awaitingHuman) controller.decide(decision);
  else if (controller.awaitingOpponent) controller.decideOpponent(decision);
  else throw new Error("pending decision has no shell owner");
  controller.timeline.skip();
}

describe("CP6C formal shell acceptance", () => {
  it("deferred opponent path can finish a real match with every decision explicitly owned by player or worker", () => {
    const controller = new LabGameController(db, decks, 20260711, undefined, { deferOpponent: true });
    let humanSteps = 0;
    let workerSteps = 0;
    for (let step = 0; step < 1500 && controller.engine.pendingDecision; step++) {
      if (controller.awaitingHuman) humanSteps++;
      if (controller.awaitingOpponent) workerSteps++;
      decideCurrent(controller);
    }
    expect(controller.engine.phase).toBe("gameOver");
    expect(humanSteps).toBeGreaterThan(10);
    expect(workerSteps).toBeGreaterThan(10);
    expect(controller.replay.entries.some((entry) => entry.source === "player")).toBe(true);
    expect(controller.replay.entries.some((entry) => entry.source === "ai")).toBe(true);
  });

  it("cross-decision undo truncates the old future and allows a different opening branch", () => {
    const controller = new LabGameController(db, decks, 404, undefined, { deferOpponent: true });
    controller.timeline.skip();
    expect(controller.engine.pendingDecision).toMatchObject({ type: "serve-rights" });
    const first = heuristicAiDecision(db, controller.engine) as Extract<Decision, { type: "serve-rights" }>;
    controller.decide(first);
    controller.timeline.skip();
    while (!controller.awaitingHuman) decideCurrent(controller);
    controller.decide(heuristicAiDecision(db, controller.engine));
    controller.timeline.skip();
    expect(controller.undoDepth).toBe(2);

    expect(controller.undo()).toBe(true);
    expect(controller.undo()).toBe(true);
    expect(controller.engine.pendingDecision).toMatchObject({ type: "serve-rights" });
    const truncatedLength = controller.replay.entries.length;
    controller.decide({ type: "serve-rights", take: !first.take });
    controller.timeline.skip();

    expect(controller.replay).toMatchObject({ rewound: true, rewindCount: 2 });
    expect(controller.replay.entries[truncatedLength]?.decision).toEqual({ type: "serve-rights", take: !first.take });
    expect(controller.replay.entries.slice(truncatedLength).some((entry) => entry.decision.type === "serve-rights" && entry.decision.take === first.take)).toBe(false);
  });
});
