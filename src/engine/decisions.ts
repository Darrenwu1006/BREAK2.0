// [Claude 2026-07-24] 候選 D：決策合法性原語——規則知識回 engine 這一側（與 applyDecision 同源）。
// 自 ai/coach.ts 搬入 canApplyFast＋其私有 helper；given 一個具體決策，回「合不合法」。
// 舊 coach.canApplyDecision 尾端的 try/catch applyDecision 慢路徑已確認為死碼（canApplyFast 的 switch 對
// Decision["type"] 窮盡、永不回 null），一併移除——不再靠 throw 當合法性驗證。
// enumerateCandidates（搜尋候選生成：排序／組合上限／One Touch lean）屬搜尋概念，留在 ai/coach.ts。

import type { CardDb, Decision, GameState, PlayerId } from "./types";
import { blockDeployMax, canChooseBlock, canDeployTo, deployNames, freeOptions, nameOf, normName } from "./engine";

type DeployArea = "serve" | "receive" | "toss" | "attack";

function handContainsAll(state: GameState, p: PlayerId, uids: readonly number[]): boolean {
  if (new Set(uids).size !== uids.length) return false;
  return uids.every((uid) => state.players[p].hand.includes(uid));
}

function validDeployNameChoice(db: CardDb, state: GameState, p: PlayerId, uid: number, area: DeployArea | "block", nameChoice: string | undefined): boolean {
  const names = deployNames(db, state, uid);
  if (names) {
    if (nameChoice === undefined) return false;
    if (!names.map(normName).includes(normName(nameChoice))) return false;
  } else if (nameChoice !== undefined) {
    return false;
  }
  return canDeployTo(db, state, p, uid, area, nameChoice);
}

function areaOfGuts(state: GameState, p: PlayerId, uid: number): "serve" | "receive" | "toss" | "attack" | "blockCenter" | null {
  const ps = state.players[p];
  for (const key of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
    if (ps[key].slice(0, -1).includes(uid)) return key;
  }
  return null;
}

function canApplyEffectCards(db: CardDb, state: GameState, decision: Extract<Decision, { type: "effect-cards" }>): boolean {
  const aw = state.effectCtx?.awaiting;
  if (!aw || aw.kind !== "cards") return false;
  const uids = decision.uids;
  if (uids.length < aw.min || uids.length > aw.max) return false;
  if (uids.some((uid) => !aw.candidates.includes(uid)) || new Set(uids).size !== uids.length) return false;
  if (aw.distinctNames && new Set(uids.map((uid) => nameOf(db, state, uid))).size !== uids.length) return false;

  const p = state.effectCtx!.player;
  const ps = state.players[p];
  switch (aw.purpose) {
    case "gutsToHand": {
      if (uids.length === 0) return true;
      const areas = new Set(uids.map((uid) => areaOfGuts(state, p, uid)));
      if (areas.size !== 1 || areas.has(null)) return false;
      const names = uids.map((uid) => nameOf(db, state, uid));
      if (new Set(names).size === names.length) return true;
      const affiliationSets = uids.map((uid) => db.get(state.cards[uid]!)?.affiliations ?? []);
      const shared = affiliationSets.slice(1).reduce((acc, cur) => acc.filter((affiliation) => cur.includes(affiliation)), affiliationSets[0] ?? []);
      return shared.length > 0;
    }
    case "dropToHand":
      return uids.every((uid) => ps.drop.includes(uid));
    case "eventToHand":
      return uids.every((uid) => ps.eventArea.includes(uid));
    default:
      return true;
  }
}

/**
 * 給定一個具體 Decision，回它在當前盤面是否合法（權威、與 applyDecision 同源）。
 * switch 對 Decision["type"] 窮盡；每型別即時判定，不執行決策、不靠 throw。
 */
export function canApplyDecision(db: CardDb, state: GameState, decision: Decision): boolean {
  const pending = state.pendingDecision;
  if (!pending || pending.type !== decision.type) return false;
  const p = pending.player as PlayerId;

  switch (decision.type) {
    case "serve-rights":
      return typeof decision.take === "boolean";
    case "mulligan":
      return handContainsAll(state, p, decision.returnUids);
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack": {
      if (decision.uid === null) return true;
      const area = decision.type.slice("deploy-".length) as DeployArea;
      if (!state.players[p].hand.includes(decision.uid)) return false;
      return validDeployNameChoice(db, state, p, decision.uid, area, decision.nameChoice);
    }
    case "deploy-block": {
      if (decision.uids === null) return true;
      const { uids, center } = decision;
      if (uids.length < 1 || uids.length > 3 || uids.length > blockDeployMax(state, p)) return false;
      if (!uids.includes(center) || !handContainsAll(state, p, uids)) return false;
      const choices = decision.nameChoices ?? {};
      const names: string[] = [];
      for (const uid of uids) {
        if (!validDeployNameChoice(db, state, p, uid, "block", choices[uid])) return false;
        const cardName = choices[uid] ?? db.get(state.cards[uid]!)?.nameJa;
        if (!cardName) return false;
        names.push(normName(cardName));
      }
      return new Set(names).size === names.length;
    }
    case "defense-choice":
      return decision.choice === "receive" || (decision.choice === "block" && canChooseBlock(state));
    case "free": {
      if (decision.action === "pass" || decision.action === "lost") return true;
      const opts = freeOptions(db, state);
      if (decision.action === "skill") return opts.skills.some((skill) => skill.uid === decision.uid && skill.skillIndex === decision.skillIndex);
      return opts.events.some((event) => event.uid === decision.uid);
    }
    case "resolve-pending":
      return pending.candidates?.includes(decision.id) ?? false;
    case "effect-confirm":
      return state.effectCtx?.awaiting?.kind === "confirm" && typeof decision.accept === "boolean";
    case "effect-cards":
      return canApplyEffectCards(db, state, decision);
    case "effect-option": {
      const aw = state.effectCtx?.awaiting;
      if (!aw || aw.kind !== "option") return false;
      const max = aw.purpose === "param" ? aw.options.length : aw.labels.length;
      return Number.isInteger(decision.index) && decision.index >= 0 && decision.index < max;
    }
    case "pick-set-card":
      return Number.isInteger(decision.index) && decision.index >= 0 && decision.index < state.players[p].setArea.length;
  }
}
