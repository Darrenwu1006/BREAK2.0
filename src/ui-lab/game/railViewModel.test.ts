import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import karasunoDeck from "../../../data/decks/烏野-預組.json";
import nekomaDeck from "../../../data/decks/音駒-音駒-三彈官方.json";
import type { Card } from "../../data/types";
import type { CardDb } from "../../engine/types";
import { LabGameController } from "./controller";
import { buildBattleRailView, buildCardInspectView, deployLegalityText } from "./railViewModel";

const expand = (deck: { cards: { id: string; count: number }[] }): string[] => deck.cards.flatMap((c) => Array(c.count).fill(c.id));
const db: CardDb = new Map((cardsJson as unknown as Card[]).map((card) => [card.id, card]));
const decks: [string[], string[]] = [expand(karasunoDeck), expand(nekomaDeck)];

describe("CP6 rail view-model", () => {
  it("建立敵我對稱摘要、當前決策與實際 rally 路徑", () => {
    const controller = new LabGameController(db, decks, 42);
    const view = buildBattleRailView(controller.engine, ["烏野", "音駒"]);
    expect(view.players.map((player) => player.label)).toEqual(["烏野", "音駒"]);
    expect(view.players[view.actionPlayer].role).toBe("行動");
    expect(view.actionLabel).toBe(controller.engine.pendingDecision?.type === "mulligan" ? "選擇換牌" : "選擇發球權");
    expect(view.rally.map((step) => step.id)).toEqual(["serve", "defense"]);
    expect(view.rally.filter((step) => step.status === "current")).toHaveLength(1);
  });

  it("card inspect 顯示基礎／有效值，合法性只消費傳入的權威集合", () => {
    const controller = new LabGameController(db, decks, 99);
    const uid = Number(Object.keys(controller.engine.cards)[0]!);
    const selected = buildCardInspectView(db, controller.engine, uid, new Set([uid]), true);
    const blocked = buildCardInspectView(db, controller.engine, uid, new Set(), true);
    expect(selected?.selectable).toBe(true);
    expect(selected?.params).toHaveLength(5);
    expect(selected?.title).toBe(selected?.card.nameJa);
    expect(selected?.subtitle).toBe(selected?.card.nameZh ?? selected?.card.affiliations.join("・"));
    expect(blocked?.selectable).toBe(false);
    expect(blocked?.unavailableReason).toContain("目前決策不可選");
  });

  it("把 engine 的結構化登場不合法 code 翻成可讀原因", () => {
    expect(deployLegalityText("no-area-param")).toContain("數值為「－」");
    expect(deployLegalityText("same-name")).toContain("同名");
    expect(deployLegalityText("block-limit")).toContain("上限");
    expect(deployLegalityText(null)).toBeNull();
  });
});
