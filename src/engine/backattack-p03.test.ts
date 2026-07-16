// P03 バックアタック（HV-P03-020 影山／033 黒尾）。028 古森 延後（bespoke cost）。
// 後排攻擊＝發生源をアタックエリアに登場（原攻擊手はガッツ化）、アタックポイントを N にする。OP は攻擊區頂端一人のみ。
import { describe, it, expect } from "vitest";
import { applyDecision, effParam } from "./engine";
import { topChara } from "./effects";
import { db, deckWith, grab, placeOnStack, seedStack, setup, serveWith, receiveTrack, FILLER } from "./testkit";
import type { GameState, Decision, PlayerId } from "./types";

function feed(s: GameState, d: Decision): GameState {
  return applyDecision(db, s, d);
}
function deploy(s: GameState, area: "toss" | "receive" | "attack", uid: number): GameState {
  return feed(s, { type: `deploy-${area}`, uid } as Decision);
}
function pushTo(s: GameState, p: PlayerId, zone: "serve" | "eventArea", cardId: string): number {
  const u = grab(s, p, cardId);
  s.players[p].hand.splice(s.players[p].hand.indexOf(u), 1);
  s.players[p][zone].push(u);
  return u;
}

describe("バックアタック P03", () => {
  it("P03-020 影山：元々アタック3登場時、ユース棄→影山が受け→攻擊にバックアタック(4)、原攻擊手はガッツ化", () => {
    let s = setup(deckWith("HV-P03-020", "HV-D02-010", "HV-D01-010", "HV-P03-085"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER); // P1 OP=1
    s = receiveTrack(s, "HV-P03-020"); // P0 影山(P03-020, receive5)で接球 → 托球
    pushTo(s, 0, "eventArea", "HV-P03-085"); // ユースのカード（cost）
    const kageReceiver = s.players[0].receive[s.players[0].receive.length - 1]!;
    s = deploy(s, "toss", grab(s, 0, "HV-D02-010")); // 手白（音駒 S、影山以外）托球
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    const azumane = grab(s, 0, "HV-D01-010"); // 東峰（元々アタック3）
    s = deploy(s, "attack", azumane);
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // 020 gate
    s = feed(s, { type: "effect-confirm", accept: true }); // 付 dropFromEventArea ユース → バックアタック(4)
    // 影山が攻擊區頂端、アタック=4
    expect(topChara(s.players[0].attack)).toBe(kageReceiver);
    expect(effParam(db, s, kageReceiver, "attack")).toBe(4);
    // 原攻擊手（東峰）はガッツ化（攻擊區に残るが頂端ではない）
    expect(s.players[0].attack).toContain(azumane);
    expect(topChara(s.players[0].attack)).not.toBe(azumane);
    // 受けエリアからは抜けた
    expect(s.players[0].receive).not.toContain(kageReceiver);
    // 次相手ターン preventOpDecrease 登録
    expect(s.restrictions.some((r) => r.preventOpDecrease && r.player === 0)).toBe(true);
    // OP は頂端（影山4）＋トス（手白1）＝5（埋もれた東峰3は算入されない）
    s = feed(s, { type: "free", action: "pass" });
    expect(s.op?.value).toBe(5);
  });

  it("P03-033 黒尾：音駒攻擊登場時、黒尾が発球→1ガッツ→バックアタック(4)", () => {
    let s = setup(deckWith("HV-P03-033", "HV-D01-002", "HV-D02-006"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER); // P0 → 托球
    // P0 のサーブエリアに黒尾(P03-033)＋1ガッツを構造
    const ps = s.players[0];
    const g = grab(s, 0, FILLER); ps.hand.splice(ps.hand.indexOf(g), 1); ps.serve.push(g); // ガッツ
    const kuroo = grab(s, 0, "HV-P03-033"); ps.hand.splice(ps.hand.indexOf(kuroo), 1); ps.serve.push(kuroo); // サーブキャラ
    s = deploy(s, "toss", grab(s, 0, "HV-D01-002"));
    s = feed(s, { type: "free", action: "pass" });
    const yamamoto = grab(s, 0, "HV-D02-006"); // 音駒攻擊
    s = deploy(s, "attack", yamamoto);
    expect(s.pendingDecision?.type).toBe("effect-confirm"); // 033 gate（1ガッツ）
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(topChara(s.players[0].attack)).toBe(kuroo); // 黒尾が攻擊區頂端
    expect(effParam(db, s, kuroo, "attack")).toBe(4);
    expect(s.players[0].serve).not.toContain(kuroo); // サーブから抜けた
  });

  it("P03-020 影山：トスキャラが同名の場合、バックアタック登場不可（†0-2-2 登場禁止事項；Q1499/Q1500 類推、cost は Q196 型で不返還）", () => {
    let s = setup(deckWith("HV-P03-020", "HV-D02-010", "HV-D01-010", "HV-P03-085", "HV-D01-002"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-P03-020"); // 影山(P03-020)で接球
    const eventCard = pushTo(s, 0, "eventArea", "HV-P03-085"); // ユースのカード（cost）
    const kageReceiver = s.players[0].receive[s.players[0].receive.length - 1]!;
    s = deploy(s, "toss", grab(s, 0, "HV-D02-010")); // 手白（影山以外）は正規登場
    while (s.pendingDecision?.type === "effect-confirm") s = feed(s, { type: "effect-confirm", accept: false });
    // 效果製造的同名狀態（Q1471/Q1476 型）：もう1枚の「影山 飛雄」がトスキャラを覆う → トス＝影山
    placeOnStack(s, 0, "toss", "HV-D01-002");
    s = feed(s, { type: "free", action: "pass" });
    const azumane = grab(s, 0, "HV-D01-010"); // 東峰（元々アタック3）→ 020 誘発
    s = deploy(s, "attack", azumane);
    expect(s.pendingDecision?.type).toBe("effect-confirm");
    s = feed(s, { type: "effect-confirm", accept: true });
    // cost は払う（Q196 型：不返還）
    expect(s.players[0].eventArea).not.toContain(eventCard);
    expect(s.players[0].drop).toContain(eventCard);
    // アタック≠トス同名の登場禁止 → 影山は移動せず、アタックポイントも set されない
    expect(topChara(s.players[0].receive)).toBe(kageReceiver);
    expect(s.players[0].attack).not.toContain(kageReceiver);
    expect(topChara(s.players[0].attack)).toBe(azumane);
    expect(effParam(db, s, kageReceiver, "attack")).toBe(1); // 卡面值のまま
    // バックアタック不成立でも残りの効果は可能な限り解決 → preventOpDecrease は登録
    expect(s.restrictions.some((r) => r.preventOpDecrease && r.player === 0)).toBe(true);
  });

  it("バックアタック(N) は set：登場前の + を上書き（Q1477）", () => {
    let s = setup(deckWith("HV-P03-033", "HV-D01-002", "HV-D02-006"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, FILLER);
    const ps = s.players[0];
    const g = grab(s, 0, FILLER); ps.hand.splice(ps.hand.indexOf(g), 1); ps.serve.push(g);
    const kuroo = grab(s, 0, "HV-P03-033"); ps.hand.splice(ps.hand.indexOf(kuroo), 1); ps.serve.push(kuroo);
    s.modifiers.push({ target: kuroo, param: "attack", amount: 5, source: kuroo }); // 事前 +5
    s = deploy(s, "toss", grab(s, 0, "HV-D01-002"));
    s = feed(s, { type: "free", action: "pass" });
    s = deploy(s, "attack", grab(s, 0, "HV-D02-006"));
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(effParam(db, s, kuroo, "attack")).toBe(4); // +5 は無視され 4 に固定
  });
});
