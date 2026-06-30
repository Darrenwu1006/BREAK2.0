// [Claude 2026-06-30] 問題1：攻擊 buff 的 target 選擇必須看「位置貢獻」，不能只看點數。
// 重現使用者回報（白鳥沢為對手常見）：電腦開攻擊事件卡，卻把 attack +X 加到舉球/攔網區的
// 高攻角色（白費，calcOp 不讀），而非真正會被算進 OP 的攻擊區攻擊手。
import { describe, expect, it } from "vitest";
import { db, deckWith, setup, serveWith, receiveTrack, grab, setHandSize, feed, drainCp } from "../engine/testkit";
import { heuristicAiDecision } from "./heuristic";
import type { GameState, Decision } from "../engine/types";

function deploy(s: GameState, area: "toss" | "attack", uid: number): GameState {
  return feed(s, { type: `deploy-${area}`, uid } as Decision);
}

describe("攻擊 buff target 位置貢獻", () => {
  it("attack +1 的目標選攻擊區攻擊手，不選舉球區的高攻誘餌（calcOp 只算攻擊區）", () => {
    const p0 = deckWith("HV-P01-033"); // 及川 徹 [發5]
    const p1 = deckWith(
      "HV-D01-008", // 澤村 大地 [接5]    ← 接球
      "HV-D01-009", // 菅原 孝支 [托2/攻3] ← 舉球誘餌：攻最高，但站舉球
      "HV-D01-001", // 日向 翔陽 [攻2]     ← 真攻擊手（攻較低）
      "HV-D01-012", // ブロード攻撃（attack+1 選 1 名烏野，choose）
    );
    let s = setup(p0, p1, 0, 7);
    const recv = grab(s, 1, "HV-D01-008");
    const toss = grab(s, 1, "HV-D01-009");
    const atk = grab(s, 1, "HV-D01-001");
    const ev = grab(s, 1, "HV-D01-012");
    setHandSize(s, 1, 4, [recv, toss, atk, ev]);

    s = serveWith(s, "HV-P01-033"); // P0 發球 OP5
    s = receiveTrack(s, "HV-D01-008"); // 澤村(接5) 接球成功 → 反擊
    setHandSize(s, 1, 3, [toss, atk, ev]); // 丟掉接球抽到的牌

    s = deploy(s, "toss", toss); s = drainCp(s, false);
    s = feed(s, { type: "free", action: "pass" }); // → 攻擊階段
    s = deploy(s, "attack", atk); s = drainCp(s, false);

    // ブロード攻撃：抽1 → addParam attack+1 の対象選択（purpose "target"）
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.pendingDecision?.type).toBe("effect-cards");
    expect(s.pendingDecision?.candidates).toEqual(expect.arrayContaining([toss, atk]));

    const decision = heuristicAiDecision(db, s, "heuristic-v2") as Extract<Decision, { type: "effect-cards" }>;
    expect(decision.type).toBe("effect-cards");
    expect(decision.uids).toContain(atk);       // 攻擊區攻擊手（OP 吃得到）
    expect(decision.uids).not.toContain(toss);  // 不是舉球區誘餌（attack 點數白費）
  });
});
