import type { Card } from "../data/types";

export interface SkillTextSegment {
  kind: "text" | "keyword";
  text: string;
}

export interface SkillTimingBadge {
  label: string;
  kind: "phase" | "area";
}

export interface GlossaryItem {
  key: string;
  name: string;
  definition: string;
}

export interface CardSkillPresentation {
  timingLabel: "可使用時機" | "發動時機";
  timingBadges: SkillTimingBadge[];
  oncePerTurn: boolean;
  body: SkillTextSegment[];
  glossary: GlossaryItem[];
  annotationZh: string[];
}

const KEYWORD_TRANSLATIONS: Record<string, string> = {
  "登場": "登場",
  "アタックエリア": "攻擊區",
  "トスエリア": "托球區",
  "レシーブエリア": "接球區",
  "ブロックエリア": "攔網區",
  "サーブエリア": "發球區",
  "コート": "球場",
  "手札": "手牌",
  "サーブ": "發球",
  "レシーブ": "接球",
  "トス": "托球",
  "アタック": "攻擊",
  "ブロック": "攔網",
  "抽牌": "抽牌",
  "ドロー": "抽牌",
  "一回合一次": "一回合一次",
  "一回限り": "僅限一次",
  "ターン1": "一回合一次",
  "ブロックフェイズ": "攔網階段",
  "レシーブフェイズ": "接球階段",
  "アタックフェイズ": "攻擊階段",
  "ドローフェイズ": "抽牌階段",
};

const GLOSSARY_LIST: GlossaryItem[] = [
  { key: "ドシャット", name: "攔死", definition: "攔網成功時的遲發效果。該回合結束時，我方的進攻點數（OP）直接設為該數值。" },
  { key: "ワンタッチ", name: "一次觸球", definition: "使對手的進攻點數（OP）減少該數值，並立即結束攔網階段，進入我方的抽牌階段。" },
  { key: "フェイント", name: "虛攻", definition: "該回合結束時，將我方 OP 設為該數值；下個對手回合中，對手不能登場攔網角色。" },
  { key: "ブロックアウト", name: "打手出界", definition: "下個對手回合中，若對手登場原始攔網點數小於或等於該數值的攔網角色，對手直接宣告 Lost。" },
  { key: "Aパス", name: "A Pass", definition: "當我方的托球角色登場時，其托球點數增加該數值。" },
  { key: "ツーアタック", name: "二次進攻", definition: "將我方 OP 設為該數值，立即進入我方結束階段；下個對手回合中，對手不能登場攔網角色。" },
  { key: "バックアタック", name: "後排攻擊", definition: "將這張卡登場至我方攻擊區，並將該角色的攻擊點數設為該數值。" },
  { key: "ターン1", name: "一回合一次", definition: "這個回合中，使我方所有與這張卡同名的卡片技能無效。" },
];

export function translateSkillKeyword(keyword: string): string {
  if (KEYWORD_TRANSLATIONS[keyword]) return KEYWORD_TRANSLATIONS[keyword]!;
  return keyword
    .replace(/ドシャット/g, "攔死")
    .replace(/ワンタッチ|One Touch/g, "一次觸球")
    .replace(/フェイント/g, "虛攻")
    .replace(/ツーアタック/g, "二次進攻")
    .replace(/Aパス/g, "A Pass")
    .replace(/ブロックアウト/g, "打手出界")
    .replace(/バックアタック/g, "後排攻擊");
}

export function extractLeadingSkillMarkers(text: string): { markers: string[]; body: string } {
  const markers: string[] = [];
  let body = text.trimStart();
  while (true) {
    const match = body.match(/^\[=([^\]]+)\]\s*/);
    if (!match) break;
    markers.push(match[1]!);
    body = body.slice(match[0].length).trimStart();
  }
  return { markers, body };
}

export function tokenizeSkillText(text: string): SkillTextSegment[] {
  return text.split(/(\[=[^\]]+\])/g).filter(Boolean).map((part) => {
    const marker = part.match(/^\[=([^\]]+)\]$/);
    return marker
      ? { kind: "keyword", text: translateSkillKeyword(marker[1]!) }
      : { kind: "text", text: part };
  });
}

export function getGlossaryItems(card: Card): GlossaryItem[] {
  const skillText = `${card.skillZh ?? ""} ${card.skillJa ?? ""}`;
  return GLOSSARY_LIST.filter((item) => {
    if (item.key === "ドシャット") return /ドシャット|攔死/.test(skillText);
    if (item.key === "ワンタッチ") return /ワンタッチ|一次觸球|One Touch/.test(skillText);
    if (item.key === "フェイント") return /フェイント|虛攻/.test(skillText);
    if (item.key === "ブロックアウト") return /ブロックアウト|打手出界/.test(skillText);
    if (item.key === "Aパス") return /Aパス|A\s*Pass/i.test(skillText);
    if (item.key === "ツーアタック") return /ツーアタック|二次進攻|二次攻擊/.test(skillText);
    if (item.key === "バックアタック") return /バックアタック|後排攻擊|後衛攻擊/.test(skillText);
    return /ターン1|一回合一次/.test(skillText) || card.timing.includes("回合1");
  });
}

function translatedAnnotation(card: Card): string[] {
  if (!card.annotationJa) return [];
  const text = card.annotationJa.replace(/\r\n/g, "\n");
  const lines: string[] = [];
  if (/ガッツを払う/.test(text)) {
    lines.push(text.includes("指定されたエリア")
      ? "從指定區域支付 Guts：將該區域角色下方指定數量的卡片放入棄牌區。"
      : text.includes("センターブロッカー")
        ? "支付 Guts：將中央攔網角色下方指定數量的卡片放入棄牌區。"
        : "支付 Guts：將這名角色下方指定數量的卡片放入棄牌區。");
  }
  if (/^ドロップする/m.test(text)) lines.push("棄牌：將指定數量的指定卡片放入棄牌區。");
  if (/オフェンスポイント/.test(text)) lines.push("OP：托球角色的托球點數，加上攻擊角色的攻擊點數。");
  if (/イベントカードと同様のタイミング/.test(text)) {
    const phases = [...text.matchAll(/\[=([^\]]+フェイズ)\]/g)].map((match) => translateSkillKeyword(match[1]!));
    lines.push(`手牌技能：這張卡在手牌中時，可於${phases.join("或")}像事件卡一樣使用。`);
  }
  if (/〔A〕/.test(text)) lines.push("代價 A：必須執行 A 才能使用這項技能。");
  if (/〈パラメータ〉/.test(text)) lines.push("數值：發球、攔網、接球、托球與攻擊點數的總稱。");
  if (/〈ガッツを払う〉/.test(text)) lines.push("支付 Guts：將這名角色下方指定數量的卡片放入棄牌區。");

  for (const item of getGlossaryItems(card)) {
    if (text.includes(item.key) && !lines.includes(item.definition)) lines.push(`${item.name}：${item.definition}`);
  }
  return [...new Set(lines)];
}

function badgeKind(label: string): SkillTimingBadge["kind"] {
  return label.endsWith("區") || label === "球場" || label === "手牌" ? "area" : "phase";
}

export function buildCardSkillPresentation(card: Card): CardSkillPresentation {
  const skillText = card.skillZh ?? card.skillJa ?? "";
  const normalized = extractLeadingSkillMarkers(skillText);
  const oncePerTurn = card.timing.includes("回合1") || normalized.markers.some((marker) => translateSkillKeyword(marker) === "一回合一次");
  const labels = card.timing.filter((timing) => timing !== "回合1");
  for (const marker of normalized.markers) {
    const label = translateSkillKeyword(marker);
    if (label !== "一回合一次" && !labels.includes(label)) labels.push(label);
  }
  return {
    timingLabel: card.type === "EVENT" ? "可使用時機" : "發動時機",
    timingBadges: labels.map((label) => ({ label, kind: badgeKind(label) })),
    oncePerTurn,
    body: tokenizeSkillText(normalized.body || skillText),
    glossary: getGlossaryItems(card),
    annotationZh: translatedAnnotation(card),
  };
}
