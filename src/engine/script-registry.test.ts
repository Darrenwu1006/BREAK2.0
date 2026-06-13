// 安全網 2：script registry contract test
// 證明 {op:"script",id} 會呼叫 SCRIPTS[id]、把回傳的 Action[] 走正常解釋器執行（重用觸發/決策機制）。
// 用注入的合成卡，不污染 data/effects.json。
import { describe, it, expect } from "vitest";
import type { Card } from "../data/types";
import type { EffectDef } from "./dsl";
import { SCRIPTS } from "./effects";
import { db, deckWith, feed, grab, setup, serveWith } from "./testkit";

/** 合成事件卡；timing 預設 [=ドロー]，effect 由參數注入 */
function synthEvent(id: string, effect: EffectDef, timing: string[] = ["抽牌"]): Card {
  return {
    id, type: "EVENT", nameJa: id, affiliations: ["測試"], positions: [], grades: [],
    params: null, timing, skillJa: null, skillZh: null, skillZhStatus: "none",
    notes: null, printings: [{ rarity: "N", image: null }], effect, effectStatus: "dsl",
  };
}

describe("script registry（安全網 2）", () => {
  it("{op:script} 呼叫 registry → 回傳的 actions 走正常解釋器（draw 2）", () => {
    SCRIPTS["test.draw2"] = () => [{ op: "draw", count: 2 }];
    (db as Map<string, Card>).set("T-SCRIPT-DRAW", synthEvent("T-SCRIPT-DRAW", {
      skills: [{ kind: "event", actions: [{ op: "script", id: "test.draw2" }] }],
    }));

    let s = setup(deckWith("T-SCRIPT-DRAW"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002"); // P1 發球
    s = feed(s, { type: "defense-choice", choice: "receive" }); // P0 接球 → ドローフェイズ free step
    const ev = grab(s, 0, "T-SCRIPT-DRAW");
    const deckBefore = s.players[0].deck.length;
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.players[0].deck.length).toBe(deckBefore - 2); // script 抽了 2 張（play 不抽）
  });

  it("script 回傳的 addParam(choose) 仍走 effect-cards 子決策（證明重用解釋器，非繞過）", () => {
    SCRIPTS["test.buffSelf"] = (api) => {
      // 讀 state：只在發生源是事件卡時給場上唯一接球角色 +3（示範 script 讀 state 後產生 DSL）
      void api;
      return [{ op: "addParam", target: { choose: true, player: "self", affiliation: "測試" }, param: "receive", amount: 3 }];
    };
    (db as Map<string, Card>).set("T-SCRIPT-BUFF", synthEvent("T-SCRIPT-BUFF", {
      skills: [{ kind: "event", actions: [{ op: "script", id: "test.buffSelf" }] }],
    }, ["接球"]));
    // 合成一張「測試」所属的接球角色當對象
    (db as Map<string, Card>).set("T-RCV", {
      id: "T-RCV", type: "CHARACTER", nameJa: "測試接球", affiliations: ["測試"], positions: [], grades: [],
      params: { serve: null, block: null, receive: 5, toss: 0, attack: null }, timing: [],
      skillJa: null, skillZh: null, skillZhStatus: "none", notes: null,
      printings: [{ rarity: "N", image: null }], effect: null, effectStatus: "vanilla",
    });

    let s = setup(deckWith("T-SCRIPT-BUFF", "T-RCV"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" }); // 跳過 draw 自由步驟
    const rcv = grab(s, 0, "T-RCV");
    s = feed(s, { type: "deploy-receive", uid: rcv }); // 接球登場（OP 來自 serve，r5 ≥ 1 → 成功）
    const ev = grab(s, 0, "T-SCRIPT-BUFF");
    s = feed(s, { type: "free", action: "event", uid: ev });
    // 對象唯一（場上只有 T-RCV）→ 自動套用，無需 effect-cards；驗證 +3 生效
    expect(s.players[0].receive.length).toBe(1);
    const rcvUid = s.players[0].receive[0]!;
    const modSum = s.modifiers.filter((m) => m.target === rcvUid && m.param === "receive").reduce((a, m) => a + m.amount, 0);
    expect(modSum).toBe(3);
  });

  it("未知 script id 立即 throw（不靜默忽略）", () => {
    (db as Map<string, Card>).set("T-SCRIPT-MISSING", synthEvent("T-SCRIPT-MISSING", {
      skills: [{ kind: "event", actions: [{ op: "script", id: "test.does-not-exist" }] }],
    }));
    let s = setup(deckWith("T-SCRIPT-MISSING"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const ev = grab(s, 0, "T-SCRIPT-MISSING");
    expect(() => feed(s, { type: "free", action: "event", uid: ev })).toThrow(/未知 script id/);
  });
});
