// CP6A blocking smoke：從 ui-lab controller（非直接 engine）走過核心回合 Decision union。

import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import karasunoDeck from "../../../data/decks/烏野-預組.json";
import nekomaDeck from "../../../data/decks/音駒-預組.json";
import { heuristicAiDecision } from "../../ai/heuristic";
import type { Card } from "../../data/types";
import { canChooseBlock } from "../../engine/engine";
import type { CardDb, Decision } from "../../engine/types";
import { LabGameController } from "./controller";

const expand = (deck: { cards: { id: string; count: number }[] }): string[] => deck.cards.flatMap((entry) => Array(entry.count).fill(entry.id));
const db: CardDb = new Map((cardsJson as unknown as Card[]).map((card) => [card.id, card]));
const decks: [string[], string[]] = [expand(karasunoDeck), expand(nekomaDeck)];

const REQUIRED: Decision["type"][] = [
  "serve-rights",
  "mulligan",
  "deploy-serve",
  "defense-choice",
  "deploy-block",
  "deploy-receive",
  "deploy-toss",
  "deploy-attack",
  "free",
  "pick-set-card",
];

describe("CP6A core round acceptance", () => {
  it("ui-lab 可走過開局、接球路線、攔網路線、Lost／取 Set 與攻守交換", () => {
    const seen = new Set<Decision["type"]>();
    let sawBlockChoice = false;
    for (const seed of [11, 29, 47]) {
      const controller = new LabGameController(db, decks, seed);
      for (let step = 0; step < 800 && controller.engine.pendingDecision; step++) {
        const pending = controller.engine.pendingDecision!;
        seen.add(pending.type);
        let decision = heuristicAiDecision(db, controller.engine);
        if (pending.type === "defense-choice" && canChooseBlock(controller.engine)) {
          decision = { type: "defense-choice", choice: "block" };
          sawBlockChoice = true;
        }
        controller.decide(decision, true);
        controller.timeline.skip();
      }
      expect(controller.engine.phase).toBe("gameOver");
    }
    for (const type of REQUIRED) expect(seen.has(type), `應走到 ${type}`).toBe(true);
    expect(sawBlockChoice).toBe(true);
  });
});
