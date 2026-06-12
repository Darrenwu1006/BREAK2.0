// M3 效果系統：7 個關鍵字（†9）整合測試（使用真實卡片資料）
// 測試手法：skipDeckValidation 牌組＋直接搬移 uid 構造情境（grab/seedStack/setHandSize），
// 引擎決策一律走 applyDecision 正常驗證路徑。

import { describe, it, expect } from "vitest";
import { blockDeployMax, canChooseBlock, deployableUids, effParam } from "./engine";
import { db, deckWith, feed, grab, placeOnStack, placeDeckTop, seedStack, setHandSize, setup, serveWith, receiveTrack, FILLER } from "./testkit";

describe("關鍵字 †9（7 個）", () => {
  it("ドシャット(6) †9-2：HV-P01-008 攔網成功→ターン終了時自分の OP=6（含 gate＋2Guts 支付）", () => {
    let s = setup(deckWith("HV-P01-008", "HV-D01-002"), deckWith("HV-D01-008", "HV-D01-010", "HV-D01-002"), 0);
    s = serveWith(s, "HV-D01-002"); // 影山 serve1 → OP=1
    expect(s.op).toMatchObject({ value: 1, owner: 0, source: "serve" });
    // P1 接球軸：澤村 r5 → 東峰 t0 → 影山 a1 → OP=1
    s = receiveTrack(s, "HV-D01-008");
    const toss = grab(s, 1, "HV-D01-010");
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-002");
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 1, owner: 1, source: "attack" });
    // P0 攔網：月島 P01-008（先鋪 2 張ガッツ）
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "defense-choice" });
    expect(canChooseBlock(s)).toBe(true);
    s = feed(s, { type: "defense-choice", choice: "block" });
    seedStack(s, 0, "blockCenter", 2);
    const tsukki = grab(s, 0, "HV-P01-008");
    s = feed(s, { type: "deploy-block", uids: [tsukki], center: tsukki });
    // [=登場] 被動 → CP → gate（2ガッツ払えば以下の2つを使える）
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "effect-confirm" });
    const gutsBefore = s.players[0].blockCenter.length;
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].blockCenter.length).toBe(gutsBefore - 2); // 2 Guts 進棄牌
    // ▶1：山口不在場 → 不加攔網點數；▶2：blockSuccess 監看已註冊
    s = feed(s, { type: "free", action: "pass" });
    // DP=2 ≥ OP=1 → 攔網成功 → ドシャット(6) → ターン終了時 OP=6
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "defense-choice" });
    expect(s.op).toMatchObject({ value: 6, owner: 0, source: "block" });
    expect(canChooseBlock(s)).toBe(false); // 攔網回球不能再攔
  });

  it("ワンタッチ(2) †9-3：HV-P01-060 對手アタックOP−2＋跳過攔網階段→自己的抽牌階段", () => {
    let s = setup(deckWith("HV-P01-060", "HV-D01-002", "HV-D01-008"), deckWith("HV-D01-008", "HV-D01-002", "HV-D01-010"), 0);
    s = serveWith(s, "HV-D01-002"); // OP=1
    s = receiveTrack(s, "HV-D01-008"); // 澤村 r5
    // P1：影山 t1 → 東峰 a3 → OP=4
    const toss = grab(s, 1, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: toss }); // 影山 [=トスエリア] gate：無ガッツ → 自動跳過
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 1, "HV-D01-010");
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 4, owner: 1, source: "attack" });
    // P0 攔網登場百沢 → gate（OP≥4、無 cost）→ ワンタッチ(2)
    s = feed(s, { type: "defense-choice", choice: "block" });
    const momo = grab(s, 0, "HV-P01-060");
    s = feed(s, { type: "deploy-block", uids: [momo], center: momo });
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "effect-confirm" });
    s = feed(s, { type: "effect-confirm", accept: true });
    // 跳過攔網階段 → 自己的ドローフェイズ（已抽 1，停在自由步驟）
    expect(s.phase).toBe("draw");
    expect(s.turnPlayer).toBe(0);
    expect(s.op).toMatchObject({ value: 2, owner: 1, source: "attack" }); // 4−2
    expect(s.players[0].blockCenter).toContain(momo); // センターブロッカー留場
    // 接球 2 點即可成功
    s = feed(s, { type: "free", action: "pass" });
    const rcv = grab(s, 0, "HV-D01-008");
    s = feed(s, { type: "deploy-receive", uid: rcv });
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss"); // DP5 ≥ OP2 → 成功
    expect(s.op).toBeNull();
  });

  it("フェイント(4) †9-4：HV-P01-041 ターン終了時 OP=4＋次の相手ターン禁攔網登場", () => {
    let s = setup(deckWith("HV-P01-038", "HV-P01-040", "HV-P01-041"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002"); // P1 發球 OP=1
    s = receiveTrack(s, "HV-P01-038"); // P0 花巻 r5（青葉城西）
    const toss = grab(s, 0, "HV-P01-040"); // 矢巾 t2（青葉城西）
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    setHandSize(s, 1, 3); // 条件：相手の手札が3枚以下
    seedStack(s, 0, "attack", 1); // 1ガッツ（注意：自分のキャラすべてが青葉城西の判定在国見登場後，filler 已成 Guts）
    const kunimi = grab(s, 0, "HV-P01-041");
    s = feed(s, { type: "deploy-attack", uid: kunimi });
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "effect-confirm" });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "free", action: "pass" }); // アタックOP算出＝2+0=2
    // エンドフェイズ：フェイント遅発 → OP=4＋限制
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "defense-choice" });
    expect(s.op).toMatchObject({ value: 4, owner: 0, source: "attack" });
    expect(blockDeployMax(s, 1)).toBe(0);
    expect(deployableUids(db, s, 1, "block")).toEqual([]);
    // 對手仍可選攔網（規則未禁），但無法登場 → 自動 Lost
    s = feed(s, { type: "defense-choice", choice: "block" });
    s = feed(s, { type: "deploy-block", uids: null });
    expect(s.lostBy).toBe(1);
  });

  it("ブロックアウト(2) †9-5：HV-P01-068 次の相手ターン中、元々ブロックP≦2 的攔網登場→對手 Lost", () => {
    let s = setup(deckWith("HV-D01-008", "HV-P01-040", "HV-P01-068", "HV-P01-044"), deckWith("HV-D01-002", "HV-D01-008"), 1);
    s = serveWith(s, "HV-D01-002"); // P1 OP=1
    s = receiveTrack(s, "HV-D01-008"); // P0 澤村（烏野）r5
    // 構造：serve 區放木兎（梟谷）→ 4 個別々の所属（烏野/青葉城西/井闥山/梟谷）
    placeOnStack(s, 0, "serve", "HV-P01-044");
    const toss = grab(s, 0, "HV-P01-040"); // 矢巾（青葉城西）
    s = feed(s, { type: "deploy-toss", uid: toss });
    s = feed(s, { type: "free", action: "pass" });
    const sakusa = grab(s, 0, "HV-P01-068"); // 佐久早（井闥山）
    setHandSize(s, 0, 3, [sakusa]); // 条件：自分の手札3枚以下（登場後 2 枚）
    s = feed(s, { type: "deploy-attack", uid: sakusa });
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "effect-confirm" });
    s = feed(s, { type: "effect-confirm", accept: true }); // attack+2＋ブロックアウト(2)
    expect(effParam(db, s, sakusa, "attack")).toBe(4); // 2+2
    s = feed(s, { type: "free", action: "pass" }); // OP = 2 + 4 = 6
    expect(s.op).toMatchObject({ value: 6, owner: 0 });
    // P1 選攔網並登場 元々ブロックP=1 的澤村 → 觸發 → P1 Lost
    s = feed(s, { type: "defense-choice", choice: "block" });
    const blocker = grab(s, 1, "HV-D01-008"); // 澤村 block1 ≤ 2
    s = feed(s, { type: "deploy-block", uids: [blocker], center: blocker });
    expect(s.lostBy).toBe(1);
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "pick-set-card" }); // 進インターバル
  });

  it("Aパス(1) †9-7：HV-PR-022 このターン中トスキャラ登場時トスP+1（修正進入 OP 算出）", () => {
    let s = setup(deckWith("HV-PR-022", "HV-D01-009"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002"); // P1 serve OP=1 ≤ 2 → 条件成立
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" }); // draw
    seedStack(s, 0, "receive", 1); // 內層 gate 的 1ガッツ
    const sawamura = grab(s, 0, "HV-PR-022");
    s = feed(s, { type: "deploy-receive", uid: sawamura });
    // 外層 gate（▶2つを使える）→ 內層 gate（1ガッツ払えば引く）
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "effect-confirm" });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "effect-confirm" });
    const handBefore = s.players[0].hand.length;
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].hand.length).toBe(handBefore + 1); // 付 1 Guts 抽 1
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss"); // r5 ≥ 1 成功
    // 托球登場 → Aパス監看 → トスP+1
    const suga = grab(s, 0, "HV-D01-009"); // 菅原 t2
    s = feed(s, { type: "deploy-toss", uid: suga });
    expect(effParam(db, s, suga, "toss")).toBe(3);
    s = feed(s, { type: "free", action: "pass" });
    const atk = grab(s, 0, FILLER); // 田中 a3
    s = feed(s, { type: "deploy-attack", uid: atk });
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op).toMatchObject({ value: 6, owner: 0 }); // (2+1)+3：修正反映進 OP †6-10-1
  });

  it("ツーアタック(3) †9-8：HV-P02-067 アタックOP算出=3＋跳過托球→エンドフェイズ＋次ターン禁攔網", () => {
    let s = setup(deckWith("HV-P02-067", "HV-P01-044", "HV-D01-008"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002");
    s = receiveTrack(s, "HV-D01-008"); // 澤村 r5
    // 構造牌組頂＝木兎（梟谷キャラ）→ mill 命中
    placeDeckTop(s, 0, "HV-P01-044");
    const akaashi = grab(s, 0, "HV-P02-067");
    s = feed(s, { type: "deploy-toss", uid: akaashi });
    // millTop 確認 → 命中梟谷 → gate 棄 1 手牌 → ツーアタック(3)
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "effect-confirm" });
    s = feed(s, { type: "effect-confirm", accept: true }); // mill
    expect(s.pendingDecision).toMatchObject({ player: 0, type: "effect-confirm" });
    s = feed(s, { type: "effect-confirm", accept: true }); // 棄手牌 gate
    if (s.pendingDecision?.type === "effect-cards") {
      s = feed(s, { type: "effect-cards", uids: [s.pendingDecision.candidates![0]!] });
    }
    // 跳過托球/攻擊 → エンドフェイズ → P1 turn
    expect(s.pendingDecision).toMatchObject({ player: 1, type: "defense-choice" });
    expect(s.op).toMatchObject({ value: 3, owner: 0, source: "attack" });
    expect(s.players[0].attack.length).toBe(0); // 沒有攻擊登場
    expect(canChooseBlock(s)).toBe(true); // アタックOP → 規則上可選攔網
    expect(blockDeployMax(s, 1)).toBe(0); // 但禁止攔網登場
  });

  it("ターン1 †9-6：HV-P01-077 同名第二張當回合技能無效（仍可 play；Q300）", () => {
    let s = setup(deckWith("HV-P01-077", "HV-P01-077", "HV-P01-011"), deckWith("HV-D01-002"), 1);
    s = serveWith(s, "HV-D01-002"); // P1 OP=1
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    const nishinoya = grab(s, 0, "HV-P01-011"); // 西谷 r6（vanilla）
    const e1 = grab(s, 0, "HV-P01-077");
    const e2 = grab(s, 0, "HV-P01-077", [e1]);
    s = feed(s, { type: "deploy-receive", uid: nishinoya });
    // 第一張：レシーブP+2、對象是西谷 → 抽 1；ターン1 發動
    const handBefore = s.players[0].hand.length;
    s = feed(s, { type: "free", action: "event", uid: e1 });
    expect(effParam(db, s, nishinoya, "receive")).toBe(8); // 6+2
    expect(s.players[0].hand.length).toBe(handBefore); // play −1、draw +1
    // 第二張：可 play 但技能無效（Q300）
    s = feed(s, { type: "free", action: "event", uid: e2 });
    expect(effParam(db, s, nishinoya, "receive")).toBe(8); // 沒有再 +2
    expect(s.players[0].eventArea.length).toBe(2);
    expect(s.modifiers.length).toBe(1);
    // 收尾：接球成功＋修正於クリンナップ失效
    s = feed(s, { type: "free", action: "pass" });
    expect(s.phase).toBe("toss");
  });
});
