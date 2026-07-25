// [Claude 2026-07-25] 候選 C Part 1（塊 4a）：共用對局 session 的權威編排測試。
// 涵蓋：自動推進停點、deferOpponent 對手回填、undo（截斷＋rewound＋還原）、上限參數化、
// onStep/onChange 觀察者、Set 回饋、過期輸入安全、fromReplay 唯讀重建。
import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import karasunoDeck from "../../data/decks/烏野-預組.json";
import nekomaDeck from "../../data/decks/音駒-音駒-三彈官方.json";
import { heuristicAiDecision } from "../ai/heuristic";
import type { Card } from "../data/types";
import type { CardDb } from "../engine/types";
import { HUMAN, MatchSession, type StepMeta } from "./matchSession";

interface DeckJson {
  cards: { id: string; count: number }[];
}
const expand = (d: DeckJson): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

const db: CardDb = new Map((cardsJson as unknown as Card[]).map((c) => [c.id, c]));
const decks: [string[], string[]] = [expand(karasunoDeck as DeckJson), expand(nekomaDeck as DeckJson)];

describe("MatchSession — 推進與對手", () => {
  it("建構後推進到第一個人類決策", () => {
    const s = new MatchSession(db, decks, 42);
    expect(s.awaitingHuman).toBe(true);
    expect(s.engine.pendingDecision!.player).toBe(HUMAN);
  });

  it("deferOpponent=false：對手由 heuristic 代打，可跑完整局", () => {
    const s = new MatchSession(db, decks, 7);
    for (let i = 0; i < 600 && s.engine.pendingDecision; i++) {
      expect(s.awaitingHuman).toBe(true);
      s.decide(heuristicAiDecision(db, s.engine));
    }
    expect(s.engine.phase).toBe("gameOver");
    expect(s.replay.entries.some((e) => e.source === "player")).toBe(true);
    expect(s.replay.entries.some((e) => e.source === "ai")).toBe(true);
  });

  it("deferOpponent=true：輪到對手時停下，等 decideOpponent 回填", () => {
    const s = new MatchSession(db, decks, 11, { deferOpponent: true });
    // 推進到對手回合
    let guard = 0;
    while (s.awaitingHuman && guard++ < 200) s.decide(heuristicAiDecision(db, s.engine));
    expect(s.awaitingOpponent).toBe(true);
    const before = s.replay.entries.length;
    s.decideOpponent(heuristicAiDecision(db, s.engine), 123);
    expect(s.replay.entries.length).toBeGreaterThan(before);
  });

  it("非對手回合呼叫 decideOpponent 會丟錯", () => {
    const s = new MatchSession(db, decks, 42);
    expect(() => s.decideOpponent(heuristicAiDecision(db, s.engine))).toThrow(/不是對手決策/);
  });
});

describe("MatchSession — undo", () => {
  it("截斷 replay、還原盤面、標記 rewound/rewindCount", () => {
    const s = new MatchSession(db, decks, 42);
    const stateBefore = s.engine;
    const lenBefore = s.replay.entries.length;
    s.decide(heuristicAiDecision(db, s.engine));
    expect(s.replay.entries.length).toBeGreaterThan(lenBefore);

    expect(s.undo()).toBe(true);
    expect(s.replay.entries.length).toBe(lenBefore);
    expect(s.engine.pendingDecision).toEqual(stateBefore.pendingDecision);
    expect(s.replay.rewound).toBe(true);
    expect(s.replay.rewindCount).toBe(1);
  });

  it("委託 AI 代打的手不建立 undo 檢查點", () => {
    const s = new MatchSession(db, decks, 42);
    expect(s.undoDepth).toBe(0);
    s.decide(heuristicAiDecision(db, s.engine), true);
    expect(s.undoDepth).toBe(0);
    expect(s.canUndo).toBe(false);
  });

  it("undoLimit 參數化：只保留最近 N 個檢查點", () => {
    const s = new MatchSession(db, decks, 42, { undoLimit: 3 });
    for (let i = 0; i < 6 && s.awaitingHuman; i++) s.decide(heuristicAiDecision(db, s.engine));
    expect(s.undoDepth).toBeLessThanOrEqual(3);
  });

  it("沒有檢查點時 undo 回 false", () => {
    const s = new MatchSession(db, decks, 42);
    expect(s.undo()).toBe(false);
  });
});

describe("MatchSession — 觀察者與安全性", () => {
  it("onStep 帶 before/after/actor/auto；before 與前一步 after 相接", () => {
    const steps: StepMeta[] = [];
    const s = new MatchSession(db, decks, 42, { onStep: (m) => steps.push(m) });
    expect(steps.length).toBeGreaterThan(0);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.before).toBe(steps[i - 1]!.after);
    expect(steps.at(-1)!.after).toBe(s.engine);
  });

  it("onStep 的 thinkMs 由 decideOpponent 帶入", () => {
    const steps: StepMeta[] = [];
    const s = new MatchSession(db, decks, 11, { deferOpponent: true, onStep: (m) => steps.push(m) });
    let guard = 0;
    while (s.awaitingHuman && guard++ < 200) s.decide(heuristicAiDecision(db, s.engine));
    steps.length = 0;
    s.decideOpponent(heuristicAiDecision(db, s.engine), 456);
    expect(steps[0]!.thinkMs).toBe(456);
  });

  it("onChange 於 decide／undo 後各觸發一次", () => {
    let changes = 0;
    const s = new MatchSession(db, decks, 42, { onChange: () => changes++ });
    expect(changes).toBe(0); // 建構期的自動推進不算「變更通知」
    s.decide(heuristicAiDecision(db, s.engine));
    expect(changes).toBe(1);
    s.undo();
    expect(changes).toBe(2);
  });

  it("過期／不符的輸入安全回 false，不丟例外也不改盤面", () => {
    const s = new MatchSession(db, decks, 42);
    const engineBefore = s.engine;
    const wrongType = { type: "pick-set-card", index: 0 } as never;
    expect(s.decide(wrongType)).toBe(false);
    expect(s.engine).toBe(engineBefore);
  });
});

describe("MatchSession — Set 回饋與 fromReplay", () => {
  it("同一 Set 結果只接受第一次回饋", () => {
    const s = new MatchSession(db, decks, 7);
    for (let i = 0; i < 600 && s.engine.pendingDecision; i++) s.decide(heuristicAiDecision(db, s.engine));
    const setResultEntry = s.replay.entries.find((e) =>
      e.after.log.slice(e.logStart, e.logEnd).some((l) => l.event?.kind === "set-won"),
    );
    if (!setResultEntry) return; // 該局若無 set-won（僅 match-won）則略過
    const feedback = { setNo: 1, anchorEntryIndex: setResultEntry.index, choice: "push-for-set" as const };
    expect(s.recordSetFeedback(feedback)).toBe(true);
    expect(s.recordSetFeedback(feedback)).toBe(false);
  });

  it("fromReplay 重建唯讀檢視：盤面＝最後一步之後，replay 原樣", () => {
    const s = new MatchSession(db, decks, 7);
    for (let i = 0; i < 600 && s.engine.pendingDecision; i++) s.decide(heuristicAiDecision(db, s.engine));
    const viewer = MatchSession.fromReplay(db, s.replay);
    expect(viewer.replay).toBe(s.replay);
    expect(viewer.engine.phase).toBe("gameOver");
    expect(viewer.canUndo).toBe(false);
  });
});
