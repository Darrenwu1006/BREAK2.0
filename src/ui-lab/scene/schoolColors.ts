// [Claude 2026-07-12] CP-V4 學校桌墊分區色。官網風格報告 §4：白底＋隊色滾邊。
// 以球衣印象推定，需對照官方卡圖再微調（使用者授權後續逐一調整）。
// key 用 LabDeck.school 字串；同時容納異體字（稲/稻、沢/澤）與 youth 變體。

/** 每校主色（桌墊滾邊用）。未列出的學校回退中性墨色。 */
const SCHOOL_COLOR: Record<string, string> = {
  烏野: "#e8541e", // 橙（對齊官網能量橙）
  音駒: "#c0272d", // 紅
  稲荷崎: "#7a1f2b", // 酒紅（刻意與白鳥沢分開）
  稻荷崎: "#7a1f2b",
  白鳥沢: "#5b2a86", // 濃紫
  白鳥澤: "#5b2a86",
  青葉城西: "#17b3ae", // 青綠（Seijoh）
  伊達工業: "#1e7a3d", // 深綠（鉄壁）
  梟谷: "#4a5560", // 石板灰（配金，滾邊先用灰）
  鴎台: "#6fb7e0", // 水藍
  井闥山: "#14315e", // 藏青
  ユース: "#d7263d", // 選抜／youth：日本紅
  疑似ユース: "#d7263d",
  混合學校: "#3f4954", // 混編：中性墨
};

/** 中性回退（未知學校）：墨色，等同「無隊色」。 */
export const NEUTRAL_MAT_COLOR = "#3f4954";

/** 取學校桌墊滾邊色；未知回退中性墨。 */
export function schoolMatColor(school: string | undefined): string {
  if (!school) return NEUTRAL_MAT_COLOR;
  return SCHOOL_COLOR[school] ?? NEUTRAL_MAT_COLOR;
}
