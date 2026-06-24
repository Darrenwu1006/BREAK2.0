// [Claude 2026-06-23] PIMC 反擊托球的 OP 壓制 tiebreak（reports/15）。
// 直接驗證新的 decisionOpPressure：它把「托值 + 站托後最佳合法攻擊」算成聯合 OP，
// 所以宮侑(托2)→5、尾白アラン(托0)→3。winRate 同分時 sort 用這個維度決勝，必選 OP 5 線。
import { describe, expect, it } from "vitest";
import { db, deckWith, setup, serveWith, receiveTrack, grab, setHandSize } from "../engine/testkit";
import { createPimcCoachReport, decisionOpPressure } from "./coach";

function counterattackTossState() {
  const p0 = deckWith("HV-P01-033"); // 及川 徹 [發5]
  const p1 = deckWith(
    "HV-P02-022", // 宮治 [接5]   ← 接球
    "HV-P02-029", // 尾白アラン [托0/攻2]✦
    "HV-P02-018", // 宮侑 [托2/攻3]
    "HV-P02-033", // 大耳練 [托0/攻3]
    "HV-P02-032", // 銀島結 [接5/攻0]
    "HV-P02-017", // 宮侑 [托1/攻1]✦
  );
  let s = setup(p0, p1, 0, 7);
  const rec = grab(s, 1, "HV-P02-022");
  const obai = grab(s, 1, "HV-P02-029");
  const miyaToss = grab(s, 1, "HV-P02-018");
  const omimi = grab(s, 1, "HV-P02-033");
  const gin = grab(s, 1, "HV-P02-032");
  const miyaSkill = grab(s, 1, "HV-P02-017");
  setHandSize(s, 1, 6, [rec, obai, miyaToss, omimi, gin, miyaSkill]);
  s = serveWith(s, "HV-P01-033");
  s = receiveTrack(s, "HV-P02-022");
  setHandSize(s, 1, 5, [obai, miyaToss, omimi, gin, miyaSkill]);
  return { s, miyaToss, obai };
}

describe("PIMC 反擊托球 OP tiebreak", () => {
  it("decisionOpPressure 用聯合 OP：宮侑托2→5、尾白托0→3（高低分得開）", () => {
    const { s, miyaToss, obai } = counterattackTossState();
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "deploy-toss" });
    // 站托宮侑（托2）後攻擊格最佳合法攻＝大耳練/另一宮侑(攻3) → 2+3=5
    expect(decisionOpPressure(db, s, { type: "deploy-toss", uid: miyaToss })).toBe(5);
    // 站托尾白アラン（托0）後攻擊格最佳合法攻＝3 → 0+3=3
    expect(decisionOpPressure(db, s, { type: "deploy-toss", uid: obai })).toBe(3);
  });

  it("winRate 同分時 PIMC 最終選最高 OP 的托球線", () => {
    const { s, miyaToss } = counterattackTossState();
    const report = createPimcCoachReport(db, s, {
      perspectivePlayer: 1,
      seed: 99,
      sampleCount: 6,
      candidateLimit: 8,
      rolloutMaxSteps: 4000,
    });
    expect(report.bestAction.decision).toMatchObject({ type: "deploy-toss", uid: miyaToss });
  });
});
