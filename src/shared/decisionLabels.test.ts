// [Claude 2026-07-24] 候選 D 塊 1：describeDecision 三級用字鎖定 ＋ decisionTypeLabel 完整性。
// 過去 5 份漂移的 decisionLabel 無法被統一驗證；此處把 named 定案用字（1A/2B/3B/4A/5B/6A）與 short/verbose 格式釘死。
import { describe, expect, it } from "vitest";
import { describeDecision, decisionTypeLabel } from "./decisionLabels";
import type { CardDb, Decision, GameState } from "../engine/types";
import type { Card } from "../data/types";

const db = new Map<string, Card>([
  ["C1", { id: "C1", nameZh: "影山", nameJa: "影山飛雄" } as unknown as Card],
  ["C2", { id: "C2", nameZh: "日向", nameJa: "日向翔陽" } as unknown as Card],
]) as CardDb;

const state = { cards: { 10: "C1", 11: "C2" }, pendingDecision: { type: "effect-option", player: 0, options: ["甲", "乙", "丙"] } } as unknown as GameState;
const stateNoOptions = { cards: { 10: "C1", 11: "C2" }, pendingDecision: { type: "effect-option", player: 0 } } as unknown as GameState;

const d = (x: unknown) => x as Decision;

describe("describeDecision — short（原 Game.tsx，不帶卡名）", () => {
  it("各型別短標籤", () => {
    expect(describeDecision(db, state, d({ type: "serve-rights", take: true }), "short")).toBe("取得發球權");
    expect(describeDecision(db, state, d({ type: "mulligan", returnUids: [10, 11] }), "short")).toBe("換牌 2 張");
    expect(describeDecision(db, state, d({ type: "mulligan", returnUids: [] }), "short")).toBe("不換牌");
    expect(describeDecision(db, state, d({ type: "deploy-serve", uid: null }), "short")).toBe("不登場發球");
    expect(describeDecision(db, state, d({ type: "deploy-serve", uid: 10 }), "short")).toBe("發球登場");
    expect(describeDecision(db, state, d({ type: "deploy-block", uids: [10, 11], center: 10, nameChoices: {} }), "short")).toBe("攔網登場 2 張");
    expect(describeDecision(db, state, d({ type: "effect-cards", uids: [10] }), "short")).toBe("選卡 1 張");
    expect(describeDecision(db, state, d({ type: "free", action: "skill", uid: 10, skillIndex: 0 }), "short")).toBe("使用技能");
  });
});

describe("describeDecision — named（用字定案 1A/2B/3B/4A/5B/6A）", () => {
  it("mulligan/effect-cards 列卡名（含〔卡號〕）[1A/4A]", () => {
    expect(describeDecision(db, state, d({ type: "mulligan", returnUids: [10, 11] }))).toBe("換掉 影山〔C1〕、日向〔C2〕");
    expect(describeDecision(db, state, d({ type: "effect-cards", uids: [10] }))).toBe("選 影山〔C1〕");
  });
  it("effect-confirm 使用/接受 · 不使用/拒絕 [2B/3B]", () => {
    expect(describeDecision(db, state, d({ type: "effect-confirm", accept: true }))).toBe("使用 / 接受");
    expect(describeDecision(db, state, d({ type: "effect-confirm", accept: false }))).toBe("不使用 / 拒絕");
  });
  it("effect-option 有標籤取標籤、無標籤 1-based [5B]", () => {
    expect(describeDecision(db, state, d({ type: "effect-option", index: 2 }))).toBe("選項：丙");
    expect(describeDecision(db, stateNoOptions, d({ type: "effect-option", index: 2 }))).toBe("選項：3");
  });
  it("pick-set-card 用『拿取』[6A]", () => {
    expect(describeDecision(db, state, d({ type: "pick-set-card", index: 0 }))).toBe("拿取 Set 卡 #1");
  });
  it("deploy/block 帶卡名（含〔卡號〕）", () => {
    expect(describeDecision(db, state, d({ type: "deploy-serve", uid: 10 }))).toBe("登場 影山〔C1〕");
    expect(describeDecision(db, state, d({ type: "deploy-serve", uid: null }))).toBe("不登場角色");
    expect(describeDecision(db, state, d({ type: "deploy-block", uids: [10, 11], center: 10, nameChoices: {} }))).toBe("攔網 影山〔C1〕、日向〔C2〕");
  });
});

describe("describeDecision — verbose（原 replay-board，含中央/其餘、宣告 Lost）", () => {
  it("deploy 不登場加宣告 Lost；block 標中央與其餘", () => {
    expect(describeDecision(db, state, d({ type: "deploy-serve", uid: null }), "verbose")).toBe("發球區不登場 → 宣告 Lost");
    expect(describeDecision(db, state, d({ type: "deploy-attack", uid: 10 }), "verbose")).toBe("攻擊登場 影山");
    expect(describeDecision(db, state, d({ type: "deploy-block", uids: [10, 11], center: 10, nameChoices: {} }), "verbose")).toBe("攔網 2 張（中央＝影山，其餘 日向）");
  });
  it("free 技能帶技能序號", () => {
    expect(describeDecision(db, state, d({ type: "free", action: "skill", uid: 10, skillIndex: 0 }), "verbose")).toBe("使用技能：影山（技能#0）");
    expect(describeDecision(db, state, d({ type: "free", action: "pass" }), "verbose")).toBe("自由步驟：Pass");
  });
});

describe("decisionTypeLabel — 提示名（每型別皆有）", () => {
  it("完整覆蓋 14 型別且非空", () => {
    const types: Decision["type"][] = [
      "serve-rights", "mulligan", "deploy-serve", "deploy-block", "deploy-receive", "deploy-toss", "deploy-attack",
      "defense-choice", "free", "resolve-pending", "effect-confirm", "effect-cards", "effect-option", "pick-set-card",
    ];
    for (const t of types) expect(decisionTypeLabel(t), t).toBeTruthy();
    expect(decisionTypeLabel("serve-rights")).toBe("選擇發球權");
    expect(decisionTypeLabel("defense-choice")).toBe("選擇防守路線");
  });
});
