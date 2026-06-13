// 安全網 1：effects.json schema validation 測試
// 接進既有 vitest gate → 拼錯 op / 漏必填欄位 / 白名單與 dsl.ts 飄移，立即紅。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KNOWN_ACTION_OPS, KNOWN_CONDITION_TYPES, KNOWN_COST_TYPES, KNOWN_TRIGGER_ONS,
  validateEffectDef,
} from "./dsl-schema";
import effectsJson from "../../data/effects.json";

const dslSrc = readFileSync(fileURLToPath(new URL("./dsl.ts", import.meta.url)), "utf8");

/** 從 dsl.ts 抓 union 成員的字面值（格式固定：`op: "xxx"` / `{ type: "xxx"` / `on: "xxx"`） */
function literalsIn(re: RegExp): string[] {
  return [...dslSrc.matchAll(re)].map((m) => m[1]!);
}

describe("DSL schema 白名單與 dsl.ts 同步（防飄移）", () => {
  it("dsl.ts 的所有 action op 都已登記在 KNOWN_ACTION_OPS", () => {
    const inSrc = new Set(literalsIn(/\|\s*\{ op: "([^"]+)"/g));
    const known = new Set<string>(KNOWN_ACTION_OPS);
    const missing = [...inSrc].filter((x) => !known.has(x));
    expect(missing, `dsl.ts 新增了 op 但 dsl-schema.ts 漏列：${missing.join(", ")}`).toEqual([]);
  });

  it("dsl.ts 的所有 condition type 都已登記", () => {
    // Condition union 的成員格式：`| { type: "xxx"` —— 但 Cost 也用 type，故與 cost 合併比對
    const inSrc = new Set(literalsIn(/\|\s*\{ type: "([^"]+)"/g));
    const known = new Set<string>([...KNOWN_CONDITION_TYPES, ...KNOWN_COST_TYPES]);
    const missing = [...inSrc].filter((x) => !known.has(x));
    expect(missing, `dsl.ts 新增了 condition/cost type 但 schema 漏列：${missing.join(", ")}`).toEqual([]);
  });

  it("dsl.ts 的所有 trigger.on 都已登記", () => {
    const inSrc = new Set(literalsIn(/\{ on: "([^"]+)"/g));
    const known = new Set<string>(KNOWN_TRIGGER_ONS);
    const missing = [...inSrc].filter((x) => !known.has(x));
    expect(missing, `dsl.ts 新增了 trigger.on 但 schema 漏列：${missing.join(", ")}`).toEqual([]);
  });
});

describe("effects.json 全卡 schema 驗證", () => {
  it("每張卡的 effect 都通過 schema（無未知 op/type/on、必填欄位齊）", () => {
    const effects = effectsJson as Record<string, unknown>;
    const allErrors = Object.entries(effects).flatMap(([id, def]) => validateEffectDef(def, id));
    expect(allErrors.map((e) => `${e.cardId} @${e.path}: ${e.message}`)).toEqual([]);
  });
});

describe("validation 自身有效（故意壞資料會被抓）", () => {
  it("拼錯的 op 被抓", () => {
    const bad = { skills: [{ kind: "event", actions: [{ op: "drawww", count: 1 }] }] };
    const errs = validateEffectDef(bad, "BAD-1");
    expect(errs.some((e) => e.message.includes('未知 action op "drawww"'))).toBe(true);
  });

  it("漏必填欄位被抓", () => {
    const bad = { skills: [{ kind: "event", actions: [{ op: "addParam", target: "self" }] }] }; // 缺 param/amount
    const errs = validateEffectDef(bad, "BAD-2");
    expect(errs.some((e) => e.message.includes('缺必填欄位'))).toBe(true);
  });

  it("未知 condition type 被抓（巢狀於 if）", () => {
    const bad = { skills: [{ kind: "event", actions: [{ op: "if", cond: [{ type: "nonsense" }], then: [] }] }] };
    const errs = validateEffectDef(bad, "BAD-3");
    expect(errs.some((e) => e.message.includes('未知 condition type "nonsense"'))).toBe(true);
  });

  it("未知 kind 被抓", () => {
    const bad = { skills: [{ kind: "weird", actions: [] }] };
    const errs = validateEffectDef(bad, "BAD-4");
    expect(errs.some((e) => e.message.includes('未知 kind "weird"'))).toBe(true);
  });
});
