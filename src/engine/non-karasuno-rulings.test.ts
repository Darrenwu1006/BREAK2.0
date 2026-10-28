import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import effectsJson from "../../data/effects.json";
import faqJson from "../../data/raw/official_faq.json";
import type { EffectDef } from "./dsl";
import { validateEffectDef } from "./dsl-schema";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Contract = keyof typeof CONTRACT_IDS | "legacy" | "revised" | "pending";

/** [Codex 2026-10-27] 明列目前未建立語義contract的Q快照；下方以skip呈現，不計為通過。 */
const DEFERRED_IDS = [
  1750, 1751, 1752, 1753, 1754, 1755, 1756, 1757, 1758, 1759, 1760, 1761, 1762, 1763, 1764,
  1765, 1766, 1767, 1768, 1769, 1770, 1771, 1772, 1773, 1780, 1781, 1782, 1783, 1784, 1785,
  1786, 1787, 1788, 1789, 1790, 1791, 1792, 1793, 1794, 1795, 1796, 1797, 1798, 1800, 1801,
  1812, 1813, 1815, 1817, 1818, 1819, 1820, 1826, 1827, 1828, 1829, 1830, 1831, 1832, 1833,
  1839, 1840, 1841,
] as const;

const LEGACY_IDS = [
  1109, 1112, 1113, 1114, 1115, 1133, 1136, 1141, 1145, 1148, 1155, 1157, 1158, 1163, 1166, 1167,
  1168, 1169, 1170, 1172, 1174, 1179, 1188, 1226, 1228, 1229, 1231, 1232, 1234, 1236, 1240, 1241,
  1242, 1248, 1250, 1251, 1254, 1255, 1273, 1274, 1276, 1278, 1280, 1289, 1292, 1310, 1313, 1314,
  1318, 1321, 1322, 1326, 1327,
  1842, 1843, 1844, 1845, 1846, 1847, 1848, 1849, 1850, 1869, 1870, 1871, 1872, 1873, 1874, 1875,
  1876, 1877, 1878, 1879, 1880, 1881, 1882, 1883, 1884, 1885, 1886, 1887, 1888, 1889, 1890, 1891,
  1892, 1893, 1894, 1895, 1896, 1897, 1898, 1899, 1900, 1901, 1902, 1903, 1904, 1905, 1906, 1907, 1908,
  1909, 1910, 1913, 1914, 1915, 1916, 1933, 1934, 1935, 1936, 1937, 1938, 1939, 1940, 1941, 1942,
  1943, 1944, 1945, 1946, 1957, 1958, 1959, 1960, 1961,
] as const;

/**
 * 一個官方 Q 對應一個可執行 contract；同機制的 Q 共用 handler。
 * 既有行為測試已深度覆蓋的 Q 標為 legacy，避免複製完整對局。
 */
const CONTRACT_IDS = {
  blockSuccess: [1110],
  doshatto: [1111, 1303, 1304, 1308, 1309, 1377, 1379],
  allAffiliation: [1134, 1135, 1164, 1191],
  baseParam: [1137, 1138, 1139, 1140, 1328, 1330, 1380, 1381, 1382],
  nameIdentity: [1142, 1143, 1154, 1256, 1297, 1298, 1324, 1336, 1343, 1344, 1345, 1346, 1389, 1390, 1391, 1395, 1396, 1397, 1398, 1399, 1400, 1401, 1402, 1403, 1404, 1405, 1409, 1410, 1411, 1412, 1413, 1414],
  coveredPending: [1144, 1147, 1149],
  activeCost: [1150, 1151, 1152, 1299, 1300, 1427, 1428, 1431],
  skillInvalid: [1153, 1296, 1422],
  phaseSkip: [1159, 1160, 1161, 1162, 1171, 1173, 1175, 1183, 1184, 1185, 1186, 1187, 1195, 1306, 1311, 1320, 1337, 1338, 1339, 1437],
  conditionTiming: [1165, 1283, 1301, 1323, 1374],
  placeEvent: [1176, 1178, 1424, 1426],
  chooseParam: [1177, 1425],
  handAdd: [1156, 1180, 1181, 1182, 1235, 1238, 1239, 1419],
  distinctAffiliation: [1189, 1193],
  eventCount: [1190, 1316, 1363, 1375, 1376],
  masterChoice: [1192, 1317, 1420],
  queueOrder: [1194, 1233, 1249, 1253, 1275, 1281, 1282, 1284, 1302, 1305, 1368, 1369, 1418],
  modifierOrder: [1227, 1371],
  eventPlayableNoEffect: [1230, 1237, 1244, 1246],
  revealAbsent: [1243, 1245],
  eventRestriction: [1247, 1290, 1291, 1372, 1383, 1384],
  deckEdge: [1252, 1286, 1312, 1315, 1329, 1331, 1335, 1340, 1364, 1429, 1430],
  dropDistinct: [1277, 1279, 1287, 1288, 1293, 1294, 1295, 1432, 1433, 1434],
  eventAny: [1285, 1341],
  mandatoryElse: [1332, 1333, 1334, 1387, 1388],
  random: [1319],
  deployOrigin: [1325],
  gutsAny: [1370, 1435],
  upTo: [1373],
  charaOnly: [1378],
  filteredCost: [1385, 1386],
  opSource: [1417],
  negative: [1146, 1342, 1423],
  phaseBranch: [1365, 1366, 1367],
  deployWatcher: [1307],
} as const;

const cards = cardsJson as { id: string; affiliations: string[]; effectStatus: string }[];
const effects = effectsJson as Record<string, EffectDef>;
const faq = faqJson as { id: string; card_no: string; que: string; ans: string }[];
const cardById = new Map(cards.map((card) => [card.id, card]));
const legacyTestSources = Object.values(import.meta.glob(
  "./{nekoma,aoba,inarizaki,fukurodani,shiratorizawa-date,remaining-cards,p04-batch1,p04-batch2,p04-batch3}.test.ts",
  { query: "?raw", import: "default", eager: true },
)) as string[];

const contractByQ = new Map<number, Contract>(LEGACY_IDS.map((id) => [id, "legacy"]));
for (const id of DEFERRED_IDS) {
  if (contractByQ.has(id)) throw new Error(`Q${id} 被重複分類`);
  contractByQ.set(id, "pending");
}
for (const [contract, ids] of Object.entries(CONTRACT_IDS) as [keyof typeof CONTRACT_IDS, readonly number[]][]) {
  for (const id of ids) {
    if (contractByQ.has(id)) throw new Error(`Q${id} 被重複分類`);
    contractByQ.set(id, contract);
  }
}

const revisedTestSources = Object.values(import.meta.glob(
  "./{inarizaki-deferred-p03,faq-revisions}.test.ts",
  { query: "?raw", import: "default", eager: true },
)) as string[];
for (const id of [1799, 1814, 1816]) {
  if (contractByQ.has(id)) throw new Error(`Q${id} 被重複分類`);
  contractByQ.set(id, "revised");
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
  if (contract === "pending") throw new Error("未覆蓋FAQ不可當作已通過contract");
  const def = effects[cardId];
  expect(def, `${cardId} 缺少 effect`).toBeTruthy();
  if (!def) throw new Error(`${cardId} 缺少 effect`);
  expect(validateEffectDef(def, cardId)).toEqual([]);

  switch (contract) {
    case "revised":
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
  it("官方非烏野Q與contract／明列待辦的ID集合完全相同、無重複", () => {
    const officialIds = nonKarasunoFaq.map((row) => Number(row.id));
    expect(new Set(officialIds).size).toBe(officialIds.length);
    expect([...contractByQ.keys()].sort((a, b) => a - b)).toEqual(officialIds.sort((a, b) => a - b));
    expect(new Set(DEFERRED_IDS).size).toBe(DEFERRED_IDS.length);
  });

  it("五筆文字修訂均有行為測試Q引用，不能當純重編或pending", () => {
    for (const id of [1799, 1806, 1814, 1816, 1837]) {
      expect(revisedTestSources.some((source) => new RegExp(`\\bQ${id}\\b`).test(source)), `Q${id} 缺行為測試`).toBe(true);
      if (nonKarasunoFaq.some((row) => Number(row.id) === id)) expect(contractByQ.get(id)).toBe("revised");
    }
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

  it.skip.each(nonKarasunoFaq.filter((row) => contractByQ.get(Number(row.id)) === "pending"))(
    "待技能實裝／獨立語義覆蓋 Q$id $card_no：$que", () => {},
  );

  it.each(nonKarasunoFaq.filter((row) => contractByQ.get(Number(row.id)) !== "pending"))("Q$id $card_no：$que", (row) => {
    const contract = contractByQ.get(Number(row.id));
    expect(contract, `Q${row.id} 尚未分類`).toBeDefined();
    assertContract(contract!, row.card_no);
  });
});
