// [Claude 2026-07-24] 候選 E 塊 1：CLI 參數解析語義鎖定（缺值、兩種寫法、壞值 throw、list）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { argValue, flag, numberArg, numberListArg, positiveNumberArg, stringArg } from "./argv";

const original = process.argv;
beforeEach(() => {
  process.argv = ["node", "script"];
});
afterEach(() => {
  process.argv = original;
});

function setArgs(...args: string[]): void {
  process.argv = ["node", "script", ...args];
}

describe("argv", () => {
  it("argValue 支援 --name value 與 --name=value；缺值回 undefined", () => {
    setArgs("--deck", "青葉");
    expect(argValue("deck")).toBe("青葉");
    setArgs("--deck=音駒");
    expect(argValue("deck")).toBe("音駒");
    setArgs("--other", "x");
    expect(argValue("deck")).toBeUndefined();
  });

  it("argValue 下一個 token 是旗標時視為無值", () => {
    setArgs("--deck", "--mirror");
    expect(argValue("deck")).toBeUndefined();
    expect(flag("mirror")).toBe(true);
  });

  it("stringArg 缺值回 fallback", () => {
    setArgs("--deck", "青葉");
    expect(stringArg("deck", "預設")).toBe("青葉");
    expect(stringArg("missing", "預設")).toBe("預設");
  });

  it("flag：出現即 true", () => {
    setArgs("--mirror");
    expect(flag("mirror")).toBe(true);
    expect(flag("json")).toBe(false);
  });

  it("numberArg：缺值回 fallback、正常解析、壞值 throw", () => {
    setArgs("--games", "40");
    expect(numberArg("games", 20)).toBe(40);
    expect(numberArg("missing", 20)).toBe(20);
    setArgs("--games", "abc");
    expect(() => numberArg("games", 20)).toThrow(/必須是數字/);
  });

  it("positiveNumberArg：缺值回 fallback、正常解析、非正數 throw", () => {
    setArgs("--games", "40");
    expect(positiveNumberArg("games", 20)).toBe(40);
    expect(positiveNumberArg("missing", 20)).toBe(20);
    setArgs("--games", "-5");
    expect(() => positiveNumberArg("games", 20)).toThrow(/必須是正數/);
    setArgs("--games", "0");
    expect(() => positiveNumberArg("games", 20)).toThrow(/必須是正數/);
  });

  it("numberListArg：逗號分隔、缺值用 fallback、含非數字 throw", () => {
    setArgs("--deltas", "0.02, 0.04 ,0.06");
    expect(numberListArg("deltas", "0.5")).toEqual([0.02, 0.04, 0.06]);
    expect(numberListArg("missing", "0.75,0.85")).toEqual([0.75, 0.85]);
    setArgs("--deltas", "0.02,x");
    expect(() => numberListArg("deltas", "0.5")).toThrow(/非數字項/);
  });
});
