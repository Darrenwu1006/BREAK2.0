// [Claude 2026-06-23] 反擊托球聯合最佳化（修掉 reports/15 的 AI 盲點）。
// 重現該局 Set 1 Turn 2 稲荷崎反擊的 5 張手牌：舊版托/攻各自獨立貪心會把尾白アラン(托0)站托、
// 宮侑(攻3)站攻 → OP 3；正解是宮侑(托2)站托、大耳練(攻3)站攻 → OP 5（同名禁止允許，名字不同）。
import { describe, expect, it } from "vitest";
import { db, deckWith, setup, serveWith, receiveTrack, grab, setHandSize, feed } from "../engine/testkit";
import { heuristicAiDecision } from "./heuristic";

describe("反擊托球聯合最佳化", () => {
  it("托球選能讓『托+攻』最大的卡，整體達到最高合法 OP（reports/15）", () => {
    // P0：及川 發5 發球（OP 5）。P1（稲荷崎）：宮治 接5 接球，再反擊。
    const p0 = deckWith("HV-P01-033"); // 及川 徹 [發5]
    const p1 = deckWith(
      "HV-P02-022", // 宮治 [接5]    ← 接球
      "HV-P02-029", // 尾白アラン [托0/攻2]✦
      "HV-P02-018", // 宮侑 [托2/攻3]
      "HV-P02-033", // 大耳練 [托0/攻3]
      "HV-P02-032", // 銀島結 [接5/攻0]
      "HV-P02-017", // 宮侑 [托1/攻1]✦
    );
    let s = setup(p0, p1, 0, 7);

    // 把這手反擊用牌全撈進 P1 手牌，並縮成這 6 張（排除其他隨機牌干擾）。
    const rec = grab(s, 1, "HV-P02-022");
    const obai = grab(s, 1, "HV-P02-029");
    const miyaToss = grab(s, 1, "HV-P02-018");
    const omimi = grab(s, 1, "HV-P02-033");
    const gin = grab(s, 1, "HV-P02-032");
    const miyaSkill = grab(s, 1, "HV-P02-017");
    const keep = [rec, obai, miyaToss, omimi, gin, miyaSkill];
    setHandSize(s, 1, keep.length, keep);

    // P0 發球 → OP 5
    s = serveWith(s, "HV-P01-033");
    expect(s.op?.value).toBe(5);

    // P1 以 宮治(接5) 接球 → 接球成功，進入托球階段
    s = receiveTrack(s, "HV-P02-022");
    // 丟掉接球抽到的那張，手牌只留 5 張反擊牌
    setHandSize(s, 1, 5, [obai, miyaToss, omimi, gin, miyaSkill]);

    expect(s.pendingDecision).toMatchObject({ player: 1, type: "deploy-toss" });

    // 修正後：托球該選宮侑(托2)，而不是尾白アラン(托0)。
    const tossDecision = heuristicAiDecision(db, s, "heuristic-v2");
    expect(tossDecision).toMatchObject({ type: "deploy-toss", uid: miyaToss });

    // 一路把托球＋攻擊打完，驗證最終 OP 達到最高合法值 5。
    s = feed(s, tossDecision);
    for (let i = 0; i < 8 && s.pendingDecision?.player === 1 && s.phase !== "start"; i++) {
      const d = heuristicAiDecision(db, s, "heuristic-v2");
      s = feed(s, d);
      if (s.op && s.op.owner === 1) break;
    }
    expect(s.op?.owner).toBe(1);
    expect(s.op?.value).toBe(5);
  });
});
