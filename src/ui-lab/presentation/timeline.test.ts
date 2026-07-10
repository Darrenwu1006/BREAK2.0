import { describe, expect, it } from "vitest";
import type { PresentationEvent } from "./events";
import { BASE_PACE_MS, paceFor, PresentationTimeline, tensionOf, type PresentationBatch } from "./timeline";

const judge: PresentationEvent = { kind: "judge-revealed", defense: "receive", defender: 1, opValue: 1, dpValue: 2, success: true };
const move: PresentationEvent = {
  kind: "card-moved",
  uid: 1,
  cardId: "HV-D01-006",
  from: { player: 0, zone: "hand" },
  to: { player: 0, zone: "serve", depth: 0 },
  visibility: "public",
  reason: "deploy",
};
const batch = (events: PresentationEvent[], thinkMs?: number): PresentationBatch => ({ events, actor: 0, decisionType: "free", ...(thinkMs !== undefined ? { thinkMs } : {}) });

describe("paceFor — 節奏參數", () => {
  it("揭示類事件吃思考張力係數；移動類不吃", () => {
    expect(tensionOf(undefined)).toBe(1);
    expect(tensionOf(9000)).toBe(1.5);
    expect(paceFor(judge, batch([judge]))).toBe(BASE_PACE_MS["judge-revealed"]);
    expect(paceFor(judge, batch([judge], 9000))).toBe(BASE_PACE_MS["judge-revealed"] * 1.5);
    expect(paceFor(move, batch([move], 9000))).toBe(BASE_PACE_MS["card-moved"]);
  });

  it("speed 倍率直接除時長", () => {
    expect(paceFor(judge, batch([judge]), 2)).toBe(BASE_PACE_MS["judge-revealed"] / 2);
  });
});

describe("PresentationTimeline — 佇列消費", () => {
  it("跨批次依序出隊；audio hook 於開演時觸發；清空時通知 idle", () => {
    const tl = new PresentationTimeline();
    const played: string[] = [];
    tl.audioHook = (entry) => played.push(entry.event.kind);
    let idleFired = 0;
    tl.onIdle(() => idleFired++);

    tl.enqueue(batch([move, judge]));
    tl.enqueue(batch([move]));
    expect(tl.idle).toBe(false);
    expect(tl.peek()?.event.kind).toBe("card-moved");

    expect(tl.next()?.event.kind).toBe("card-moved");
    expect(tl.next()?.event.kind).toBe("judge-revealed");
    expect(idleFired).toBe(0);
    expect(tl.next()?.event.kind).toBe("card-moved");
    expect(idleFired).toBe(1);
    expect(tl.idle).toBe(true);
    expect(tl.next()).toBeNull();
    expect(played).toEqual(["card-moved", "judge-revealed", "card-moved"]);
  });

  it("skip 清空佇列並通知 idle（state 已到位、直接顯示最終盤面）", () => {
    const tl = new PresentationTimeline();
    let idleFired = 0;
    tl.onIdle(() => idleFired++);
    tl.enqueue(batch([move, judge, move]));
    tl.skip();
    expect(tl.idle).toBe(true);
    expect(idleFired).toBe(1);
    expect(tl.next()).toBeNull();
    tl.skip(); // 已空再 skip 不重複通知
    expect(idleFired).toBe(1);
  });

  it("出隊時依當下 speed 計算時長", () => {
    const tl = new PresentationTimeline();
    tl.enqueue(batch([judge]));
    tl.speed = 3;
    expect(tl.next()?.durationMs).toBe(BASE_PACE_MS["judge-revealed"] / 3);
  });
});
