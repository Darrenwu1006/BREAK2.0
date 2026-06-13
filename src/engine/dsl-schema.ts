// DSL schema 白名單與必填欄位契約（安全網 1：補卡前提）
// 用途：effects.json 是純資料、TS 不驗它 → 拼錯 op / 漏必填欄位要等對局碰到該卡才爆。
// 本檔提供 build/test 時的結構驗證（dsl-validate.test.ts 使用）。
//
// 維護方式：本白名單是「權威清單」。dsl-validate.test.ts 會反向比對 dsl.ts，
// 若 dsl.ts 新增了 op/type/on 但這裡漏列，測試會紅 → 強制同步（零飄移）。

/** Action 的 op（對應 dsl.ts Action union；effects.ts execAction 處理） */
export const KNOWN_ACTION_OPS = [
  "draw", "drawToHandSize", "dropToHand", "forceDrop", "addParam", "if", "gate",
  "revealTopTutor", "lookTopTutor", "chooseOne", "moveSelfToBlockSide", "revealTopCheck",
  "millTop", "dropFromHand", "deployFromDrop", "moveCharaToHand", "gutsToHand",
  "eventAreaToHand", "handToDeckBottom", "deployFromGuts", "setParam", "millTopAll",
  "dropOpponentGuts", "coinFlip", "moveGutsToArea", "watch", "restrict", "keyword",
  "setOwnOp", "addOpponentOp", "skipToPhase", "calcAttackOpAs", "lostOpponent",
  "script", // 安全網 2：特例腳本逃生口
] as const;

/** Condition 的 type（對應 dsl.ts Condition union；effects.ts evalCond 處理） */
export const KNOWN_CONDITION_TYPES = [
  "opponentOp", "selfArea", "handMax", "handMin", "deployedFromHand", "chara",
  "allCharas", "distinctAffiliationCharas", "eventAreaCount", "phaseIs", "targetIs",
  "targetParam", "deployedByCard", "dropDistinctNames", "addedThisSkill", "gutsParity",
  "milledIs", "selfIsSideBlocker", "paidGutsAll",
] as const;

/** Cost 的 type（對應 dsl.ts Cost union；effects.ts costPayable/costOps 處理） */
export const KNOWN_COST_TYPES = [
  "guts", "gutsAny", "dropFromHand", "dropSelf", "handToDeckBottom",
  "placeEventFromHand", "gutsFrom", "millDeck", "dropChara", "tilt",
  "dropSelfFromCourt", "selfToDeckBottom",
] as const;

/** PassiveTrigger.on ∪ DelayedTrigger.on */
export const KNOWN_TRIGGER_ONS = [
  "deploy", "allyDeploy", "covered", // passive
  "opponentLost", "blockSuccess", "turnEnd", "handAddByEffect", // delayed
] as const;

export const KNOWN_DURATIONS = ["thisTurn", "nextOpponentTurn"] as const;

/** SkillDef.kind。註：特例腳本走 action-level `{op:"script"}`（見 KNOWN_ACTION_OPS），
 *  非 skill-level kind——多數怪卡是「效果內容怪」而非「觸發機制怪」，action 級可重用既有觸發/CP。 */
export const KNOWN_SKILL_KINDS = ["passive", "active", "event", "deployNameChoice"] as const;

/**
 * 必填欄位契約：op/type → 必須存在的欄位名。
 * 不求完備（漏列只是少檢查、不會誤報），只收高風險、最常漏的。
 */
export const REQUIRED_FIELDS: Record<string, string[]> = {
  // actions
  draw: ["count"],
  drawToHandSize: ["size"],
  dropToHand: ["filter", "count"],
  forceDrop: ["count"],
  addParam: ["target", "param", "amount"],
  if: ["cond", "then"],
  gate: ["then"],
  revealTopTutor: ["names", "upTo"],
  lookTopTutor: ["count", "upTo"],
  chooseOne: ["options"],
  millTop: ["upTo"],
  dropFromHand: ["count"],
  deployFromDrop: ["filter", "area"],
  moveCharaToHand: ["from", "filter", "upTo"],
  gutsToHand: ["count"],
  eventAreaToHand: ["count"],
  handToDeckBottom: ["count"],
  deployFromGuts: ["filter", "area", "upTo"],
  setParam: ["target", "param", "value"],
  millTopAll: ["count"],
  dropOpponentGuts: ["area", "upTo"],
  coinFlip: ["heads", "tails"],
  moveGutsToArea: ["filter", "area", "upTo"],
  watch: ["trigger", "duration", "actions"],
  restrict: ["restriction", "duration"],
  keyword: ["name"],
  setOwnOp: ["value"],
  addOpponentOp: ["amount"],
  skipToPhase: ["phase"],
  calcAttackOpAs: ["value"],
  script: ["id"],
  // conditions
  chara: ["filter"],
  eventAreaCount: ["player"],
  phaseIs: ["phase"],
  targetIs: ["filter"],
  targetParam: ["param"],
  deployedByCard: ["name"],
  dropDistinctNames: ["affiliation", "min"],
  addedThisSkill: ["min"],
  gutsParity: ["area", "parity"],
  milledIs: ["affiliation"],
  paidGutsAll: ["position"],
  allCharas: ["affiliation"],
  distinctAffiliationCharas: ["min"],
  // costs
  guts: ["count"],
  gutsAny: ["count"],
  gutsFrom: ["areas", "count"],
  millDeck: ["count"],
  dropChara: ["area"],
  // 註：handToDeckBottom 同時是 action 與 cost，兩者必填欄位都是 count，共用上方 action 定義。
};

export interface ValidationError {
  cardId: string;
  path: string;
  message: string;
}

const KNOWN_OPS = new Set<string>(KNOWN_ACTION_OPS);
const KNOWN_CONDS = new Set<string>(KNOWN_CONDITION_TYPES);
const KNOWN_COSTS = new Set<string>(KNOWN_COST_TYPES);
const KNOWN_ONS = new Set<string>(KNOWN_TRIGGER_ONS);
const KNOWN_DURS = new Set<string>(KNOWN_DURATIONS);
const KNOWN_KINDS = new Set<string>(KNOWN_SKILL_KINDS);

function checkRequired(node: Record<string, unknown>, key: string, cardId: string, path: string, errs: ValidationError[]): void {
  const req = REQUIRED_FIELDS[key];
  if (!req) return;
  for (const f of req) {
    if (!(f in node)) errs.push({ cardId, path, message: `${key} 缺必填欄位 "${f}"` });
  }
}

/**
 * 遞迴驗證一個 EffectDef 節點。檢查：
 * - skill.kind 在白名單
 * - action.op / condition.type / cost.type / trigger.on / duration 在白名單
 * - 必填欄位齊
 * 不認識的 op/type 即「拼錯或未登記」→ 報錯。
 */
export function validateEffectDef(def: unknown, cardId: string): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!def || typeof def !== "object" || !Array.isArray((def as { skills?: unknown }).skills)) {
    errs.push({ cardId, path: "$", message: "effect 缺 skills 陣列" });
    return errs;
  }
  for (const [i, skill] of (def as { skills: unknown[] }).skills.entries()) {
    const s = skill as Record<string, unknown>;
    const kind = s["kind"] as string;
    if (!KNOWN_KINDS.has(kind)) errs.push({ cardId, path: `skills[${i}]`, message: `未知 kind "${kind}"` });
    walkActions(s["actions"], cardId, `skills[${i}].actions`, errs);
    walkConds(s["cond"], cardId, `skills[${i}].cond`, errs);
    walkCosts(s["costs"], cardId, `skills[${i}].costs`, errs);
  }
  return errs;
}

function walkActions(actions: unknown, cardId: string, path: string, errs: ValidationError[]): void {
  if (!Array.isArray(actions)) return;
  for (const [i, a] of actions.entries()) {
    const node = a as Record<string, unknown>;
    const op = node["op"] as string;
    const p = `${path}[${i}]`;
    if (!KNOWN_OPS.has(op)) {
      errs.push({ cardId, path: p, message: `未知 action op "${op}"` });
      continue;
    }
    checkRequired(node, op, cardId, p, errs);
    // 巢狀
    walkActions(node["then"], cardId, `${p}.then`, errs);
    walkActions(node["actions"], cardId, `${p}.actions`, errs);
    walkActions(node["heads"], cardId, `${p}.heads`, errs);
    walkActions(node["tails"], cardId, `${p}.tails`, errs);
    walkConds(node["cond"], cardId, `${p}.cond`, errs);
    walkCosts(node["costs"], cardId, `${p}.costs`, errs);
    if (op === "chooseOne" && Array.isArray(node["options"])) {
      for (const [j, opt] of (node["options"] as Record<string, unknown>[]).entries()) {
        walkActions(opt["actions"], cardId, `${p}.options[${j}].actions`, errs);
      }
    }
    if (op === "watch") {
      checkTrigger(node["trigger"], cardId, `${p}.trigger`, errs);
      checkDuration(node["duration"], cardId, p, errs);
      walkActions(node["actions"], cardId, `${p}.actions`, errs);
    }
  }
}

function walkConds(conds: unknown, cardId: string, path: string, errs: ValidationError[]): void {
  if (!Array.isArray(conds)) return;
  for (const [i, c] of conds.entries()) {
    const node = c as Record<string, unknown>;
    const t = node["type"] as string;
    const p = `${path}[${i}]`;
    if (!KNOWN_CONDS.has(t)) {
      errs.push({ cardId, path: p, message: `未知 condition type "${t}"` });
      continue;
    }
    checkRequired(node, t, cardId, p, errs);
  }
}

function walkCosts(costs: unknown, cardId: string, path: string, errs: ValidationError[]): void {
  if (!Array.isArray(costs)) return;
  for (const [i, c] of costs.entries()) {
    const node = c as Record<string, unknown>;
    const t = node["type"] as string;
    const p = `${path}[${i}]`;
    if (!KNOWN_COSTS.has(t)) {
      errs.push({ cardId, path: p, message: `未知 cost type "${t}"` });
      continue;
    }
    checkRequired(node, t, cardId, p, errs);
  }
}

function checkTrigger(trigger: unknown, cardId: string, path: string, errs: ValidationError[]): void {
  const on = (trigger as Record<string, unknown> | undefined)?.["on"] as string;
  if (!KNOWN_ONS.has(on)) errs.push({ cardId, path, message: `未知 trigger.on "${on}"` });
}

function checkDuration(duration: unknown, cardId: string, path: string, errs: ValidationError[]): void {
  if (!KNOWN_DURS.has(duration as string)) errs.push({ cardId, path, message: `未知 duration "${duration}"` });
}
