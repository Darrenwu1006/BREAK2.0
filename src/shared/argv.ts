// [Claude 2026-07-24] 候選 E：CLI／tooling 共用參數解析。取代 tools/* 與 src/ai/*-cli 各自複製的
// argValue/numberArg/argNum（17 份、兩種漂移語義）。僅供 CLI 腳本用，非 app runtime。
// 統一語義（[使用者 2026-07-24] 定案）：
//   - 缺值：argValue 回 undefined；stringArg/numberArg/numberListArg 回 fallback。
//   - 數字壞值：throw（實驗腳本寧可早失敗，避免用錯設定白跑一場長 benchmark）。
//   - 支援 `--name value` 與 `--name=value` 兩種寫法。
import process from "node:process";

/** 取 `--name value` 或 `--name=value` 的原始字串；未提供回 undefined。 */
export function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) {
    const next = process.argv[idx + 1];
    // 下一個 token 若是另一個旗標（--foo）則視為「此參數無值」。
    if (next !== undefined && !next.startsWith("--")) return next;
  }
  return undefined;
}

/** 布林旗標：出現 `--name` 即 true。 */
export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 字串參數；未提供回 fallback。 */
export function stringArg(name: string, fallback: string): string {
  return argValue(name) ?? fallback;
}

/** 數字參數；未提供回 fallback，提供但非數字則 throw。 */
export function numberArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} 必須是數字，收到「${raw}」`);
  return value;
}

/** 正數參數；未提供回 fallback，提供但非數字或 ≤0 則 throw（seed/games/steps 等要求正數的旋鈕）。 */
export function positiveNumberArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} 必須是正數，收到「${raw}」`);
  return value;
}

/** 逗號分隔數字列表；未提供用 fallback 字串解析，含非數字項則 throw。 */
export function numberListArg(name: string, fallback: string): number[] {
  const raw = argValue(name) ?? fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const value = Number(item);
      if (!Number.isFinite(value)) throw new Error(`--${name} 含非數字項「${item}」`);
      return value;
    });
}
