import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import effectsJson from "../../data/effects.json";
import faqJson from "../../data/raw/official_faq.json";
import type { EffectDef } from "./dsl";
import { validateEffectDef } from "./dsl-schema";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Contract = keyof typeof CONTRACT_IDS | "legacy";

const LEGACY_IDS = [
  192, 195, 196, 197, 198, 216, 219, 224, 228, 231, 238, 240, 241, 246, 249, 250,
  251, 252, 253, 255, 257, 262, 271, 309, 311, 312, 314, 315, 317, 319, 323, 324,
  325, 331, 333, 334, 337, 338, 356, 357, 359, 361, 363, 372, 375, 393, 396, 397,
  401, 404, 405, 409, 410,
] as const;

/**
 * 一個官方 Q 對應一個可執行 contract；同機制的 Q 共用 handler。
 * 既有行為測試已深度覆蓋的 Q 標為 legacy，避免複製完整對局。
 */
const CONTRACT_IDS = {
  blockSuccess: [193],
  doshatto: [194, 386, 387, 391, 392, 460, 462],
  allAffiliation: [217, 218, 247, 274],
  baseParam: [220, 221, 222, 223, 411, 413, 463, 464, 465],
  nameIdentity: [225, 226, 237, 339, 380, 381, 407, 419, 426, 427, 428, 429, 472, 473, 474, 478, 479, 480, 481, 482, 483, 484, 485, 486, 487, 488, 492, 493, 494, 495, 496, 497],
  coveredPending: [227, 230, 232],
  activeCost: [233, 234, 235, 382, 383, 510, 511, 514],
  skillInvalid: [236, 379, 505],
  phaseSkip: [242, 243, 244, 245, 254, 256, 258, 266, 267, 268, 269, 270, 278, 389, 394, 403, 420, 421, 422, 520],
  conditionTiming: [248, 366, 384, 406, 457],
  placeEvent: [259, 261, 507, 509],
  chooseParam: [260, 508],
  handAdd: [239, 263, 264, 265, 318, 321, 322, 502],
  distinctAffiliation: [272, 276],
  eventCount: [273, 399, 446, 458, 459],
  masterChoice: [275, 400, 503],
  queueOrder: [277, 316, 332, 336, 358, 364, 365, 367, 385, 388, 451, 452, 501],
  modifierOrder: [310, 454],
  eventPlayableNoEffect: [313, 320, 327, 329],
  revealAbsent: [326, 328],
  eventRestriction: [330, 373, 374, 455, 466, 467],
  deckEdge: [335, 369, 395, 398, 412, 414, 418, 423, 447, 512, 513],
  dropDistinct: [360, 362, 370, 371, 376, 377, 378, 515, 516, 517],
  eventAny: [368, 424],
  mandatoryElse: [415, 416, 417, 470, 471],
  random: [402],
  deployOrigin: [408],
  gutsAny: [453, 518],
  upTo: [456],
  charaOnly: [461],
  filteredCost: [468, 469],
  opSource: [500],
  negative: [229, 425, 506],
  phaseBranch: [448, 449, 450],
  deployWatcher: [390],
} as const;

const cards = cardsJson as { id: string; affiliations: string[]; effectStatus: string }[];
const effects = effectsJson as Record<string, EffectDef>;
const faq = faqJson as { id: string; card_no: string; que: string; ans: string }[];
const cardById = new Map(cards.map((card) => [card.id, card]));
const legacyTestSources = Object.values(import.meta.glob(
  "./{nekoma,aoba,inarizaki,fukurodani,shiratorizawa-date,remaining-cards}.test.ts",
  { query: "?raw", import: "default", eager: true },
)) as string[];

const contractByQ = new Map<number, Contract>(LEGACY_IDS.map((id) => [id, "legacy"]));
for (const [contract, ids] of Object.entries(CONTRACT_IDS) as [keyof typeof CONTRACT_IDS, readonly number[]][]) {
  for (const id of ids) {
    if (contractByQ.has(id)) throw new Error(`Q${id} 被重複分類`);
    contractByQ.set(id, contract);
  }
}

const nonKarasunoFaq = faq.filter((row) => {
  const card = cardById.get(row.card_no);
  return card && !card.affiliations.includes("烏野");
});

function walk(value: unknown, predicate: (node: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => walk(item, predicate));
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (predicate(node)) return true;
  return Object.values(node).some((item) => walk(item, predicate));
}

const ANY_VALUE = Symbol("any-value");
const has = (def: EffectDef, key: string, value: unknown | typeof ANY_VALUE = ANY_VALUE): boolean =>
  walk(def as unknown as Json, (node) => key in node && (value === ANY_VALUE || node[key] === value));

const hasAny = (def: EffectDef, pairs: [string, unknown][]): boolean => pairs.some(([key, value]) => has(def, key, value));

function assertContract(contract: Contract, cardId: string): void {
  const def = effects[cardId];
  expect(def, `${cardId} 缺少 effect`).toBeTruthy();
  if (!def) throw new Error(`${cardId} 缺少 effect`);
  expect(validateEffectDef(def, cardId)).toEqual([]);

  switch (contract) {
    case "legacy":
      return;
    case "blockSuccess":
      expect(has(def, "on", "blockSuccess")).toBe(true);
      return;
    case "doshatto":
      expect(has(def, "name", "ドシャット")).toBe(true);
      return;
    case "allAffiliation":
      expect(hasAny(def, [["type", "allCharas"], ["id", "card.HV-P01-066.condition"]])).toBe(true);
      return;
    case "baseParam":
      expect(hasAny(def, [["baseParamMax", ANY_VALUE], ["baseParamEq", ANY_VALUE], ["op", "deployFromGuts"]])).toBe(true);
      return;
    case "nameIdentity":
      expect(hasAny(def, [["kind", "deployNameChoice"], ["type", "paidGutsAll"], ["op", "gutsToHand"], ["type", "deployedFromHand"], ["disableSkills", ANY_VALUE], ["names", ANY_VALUE]])).toBe(true);
      return;
    case "coveredPending":
      expect(hasAny(def, [["on", "covered"], ["op", "deployFromGuts"], ["on", "deploy"]])).toBe(true);
      return;
    case "activeCost":
      expect(has(def, "kind", "active")).toBe(true);
      expect(has(def, "type", "dropSelf")).toBe(true);
      return;
    case "skillInvalid":
      expect(hasAny(def, [["disableSkills", ANY_VALUE], ["turn1", true]])).toBe(true);
      return;
    case "phaseSkip":
      expect(hasAny(def, [["name", "ワンタッチ"], ["name", "ブロックアウト"], ["name", "ツーアタック"], ["op", "skipToPhase"], ["preventOpDecrease", true], ["type", "selfToDeckBottom"], ["blockFailIfDpMax", ANY_VALUE]])).toBe(true);
      return;
    case "conditionTiming":
      expect(hasAny(def, [["type", "handMax"], ["type", "chara"], ["effParamEq", ANY_VALUE], ["type", "targetParam"]])).toBe(true);
      return;
    case "placeEvent":
      expect(hasAny(def, [["type", "placeEventFromHand"], ["op", "opponentMayPlaceEvent"]])).toBe(true);
      return;
    case "chooseParam":
      expect(has(def, "param", "choose")).toBe(true);
      return;
    case "handAdd":
      expect(hasAny(def, [["on", "handAddByEffect"], ["on", "handAdd"], ["banHandAdd", true]])).toBe(true);
      return;
    case "distinctAffiliation":
      expect(hasAny(def, [["type", "distinctAffiliationCharas"], ["id", "card.HV-P01-066.condition"]])).toBe(true);
      return;
    case "eventCount":
      expect(hasAny(def, [["type", "eventAreaCount"], ["id", "card.HV-P01-066.condition"]])).toBe(true);
      return;
    case "masterChoice":
      expect(hasAny(def, [["op", "moveOpponentEvent"], ["op", "dropOpponentGuts"], ["id", "card.HV-P01-066.condition"]])).toBe(true);
      return;
    case "queueOrder":
      expect(hasAny(def, [["kind", "passive"], ["op", "deployFromGuts"], ["on", "deploy"]])).toBe(true);
      return;
    case "modifierOrder":
      expect(hasAny(def, [["op", "setParam"], ["op", "deployFromGuts"]])).toBe(true);
      return;
    case "eventPlayableNoEffect":
      expect(hasAny(def, [["kind", "event"], ["turn1", true]])).toBe(true);
      return;
    case "revealAbsent":
      expect(has(def, "affiliationAbsentFromCourt", true)).toBe(true);
      return;
    case "eventRestriction":
      expect(hasAny(def, [["banEventTimings", ANY_VALUE], ["negateCenterBlock", true], ["banPositions", ANY_VALUE]])).toBe(true);
      return;
    case "deckEdge":
      expect(hasAny(def, [["op", "draw"], ["op", "millTop"], ["op", "millTopAll"], ["op", "lookTopTutor"], ["op", "handToDeckTop"], ["op", "handToDeckBottom"], ["type", "handToDeckBottom"], ["type", "millDeck"]])).toBe(true);
      return;
    case "dropDistinct":
      expect(has(def, "type", "dropDistinctNames")).toBe(true);
      return;
    case "eventAny":
      expect(has(def, "op", "eventAreaToHand")).toBe(true);
      return;
    case "mandatoryElse":
      expect(hasAny(def, [["else", ANY_VALUE], ["type", "addedThisSkill"]])).toBe(true);
      return;
    case "random":
      expect(has(def, "op", "coinFlip")).toBe(true);
      return;
    case "deployOrigin":
      expect(has(def, "type", "deployedFromHand")).toBe(true);
      return;
    case "gutsAny":
      expect(hasAny(def, [["op", "deployFromGuts"], ["op", "dropToHand"]])).toBe(true);
      return;
    case "upTo":
      expect(has(def, "upTo", true)).toBe(true);
      return;
    case "charaOnly":
      expect(has(def, "op", "moveCharaToHand")).toBe(true);
      return;
    case "filteredCost":
      expect(has(def, "type", "dropFromHand")).toBe(true);
      expect(has(def, "names", ANY_VALUE)).toBe(true);
      return;
    case "opSource":
      expect(hasAny(def, [["type", "opponentOp"], ["type", "triggerIs"]])).toBe(true);
      return;
    case "negative":
      expect(walk(def, (node) => node.op === "addParam" && typeof node.amount === "number" && node.amount < 0)).toBe(true);
      return;
    case "phaseBranch":
      expect(has(def, "type", "phaseIs")).toBe(true);
      return;
    case "deployWatcher":
      expect(has(def, "on", "deploy")).toBe(true);
      return;
  }
}

describe("非烏野官方判例 coverage gate", () => {
  it("官方 240 件非烏野卡片判例全部有唯一 contract", () => {
    expect(nonKarasunoFaq).toHaveLength(240);
    const official = nonKarasunoFaq.map((row) => Number(row.id)).sort((a, b) => a - b);
    const covered = [...contractByQ.keys()].sort((a, b) => a - b);
    expect(covered).toEqual(official);
  });

  it("既有 53 件深度判例仍由行為測試覆蓋", () => {
    for (const id of LEGACY_IDS) {
      const pattern = new RegExp(`\\bQ${id}\\b`);
      expect(
        legacyTestSources.some((source) => pattern.test(source)),
        `Q${id} 的既有行為測試已遺失`,
      ).toBe(true);
    }
  });

  it.each(nonKarasunoFaq)("Q$id $card_no：$que", (row) => {
    const contract = contractByQ.get(Number(row.id));
    expect(contract, `Q${row.id} 尚未分類`).toBeDefined();
    assertContract(contract!, row.card_no);
  });
});
