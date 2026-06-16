// M8 benchmark baseline：保留早期「點數最大、有招就用」的粗略 AI，用來量化 v2 之後的提升。
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { blockDeployMax, canChooseBlock, deployableUids, freeOptions } from "../engine/engine";
import { autoPickCards } from "../engine/effects";
import type { CourtArea } from "../engine/dsl";
import { pickDeployName, selectBlockers } from "./util";

type DeployArea = Exclude<CourtArea, "block">;

function cardParam(db: CardDb, state: GameState, uid: number, area: CourtArea): number {
  return db.get(state.cards[uid]!)?.params?.[area] ?? 0;
}

function chooseMaxParam(db: CardDb, state: GameState, p: PlayerId, area: DeployArea): number | null {
  const opts = deployableUids(db, state, p, area);
  if (!opts.length) return null;
  return opts.reduce((best, uid) => (cardParam(db, state, uid, area) > cardParam(db, state, best, area) ? uid : best));
}

function incomingOp(state: GameState, p: PlayerId): number {
  return state.op && state.op.owner !== p ? state.op.value : 0;
}

export function heuristicV1AiDecision(db: CardDb, state: GameState): Decision {
  const pd = state.pendingDecision;
  if (!pd) throw new Error("沒有待決策");
  const p = pd.player as PlayerId;

  switch (pd.type) {
    case "serve-rights":
      return { type: "serve-rights", take: true };
    case "mulligan":
      return { type: "mulligan", returnUids: [] };
    case "defense-choice":
      return { type: "defense-choice", choice: canChooseBlock(state) ? "block" : "receive" };
    case "deploy-serve":
    case "deploy-receive":
    case "deploy-toss":
    case "deploy-attack": {
      const area = pd.type.slice("deploy-".length) as DeployArea;
      const uid = chooseMaxParam(db, state, p, area);
      return { type: pd.type, uid, nameChoice: uid === null ? undefined : pickDeployName(db, state, p, uid, area) } as Decision;
    }
    case "deploy-block": {
      const opts = deployableUids(db, state, p, "block");
      const maxN = Math.min(3, blockDeployMax(state, p));
      if (!opts.length || maxN <= 0) return { type: "deploy-block", uids: null };
      const ranked = opts.slice().sort((a, b) => cardParam(db, state, b, "block") - cardParam(db, state, a, "block"));
      const need = incomingOp(state, p);
      let chosenCount = Math.min(maxN, ranked.length);
      let total = 0;
      for (let i = 0; i < Math.min(maxN, ranked.length); i++) {
        total += cardParam(db, state, ranked[i]!, "block");
        if (total >= need) {
          chosenCount = i + 1;
          break;
        }
      }
      const selection = selectBlockers(db, state, p, ranked, chosenCount);
      if (!selection.uids.length) return { type: "deploy-block", uids: null };
      const center = selection.uids.reduce((best, uid) => (cardParam(db, state, uid, "block") > cardParam(db, state, best, "block") ? uid : best));
      return { type: "deploy-block", uids: selection.uids, center, nameChoices: selection.nameChoices };
    }
    case "free": {
      const options = freeOptions(db, state);
      const event = options.events[0];
      if (event) return { type: "free", action: "event", uid: event.uid };
      const skill = options.skills[0];
      if (skill) return { type: "free", action: "skill", uid: skill.uid, skillIndex: skill.skillIndex };
      return { type: "free", action: "pass" };
    }
    case "pick-set-card":
      return { type: "pick-set-card", index: 0 };
    case "resolve-pending":
      return { type: "resolve-pending", id: pd.candidates?.[0] ?? 0 };
    case "effect-confirm":
      return { type: "effect-confirm", accept: true };
    case "effect-cards":
      return { type: "effect-cards", uids: autoPickCards(db, state) };
    case "effect-option":
      return { type: "effect-option", index: 0 };
    default:
      throw new Error(`heuristic-v1 未支援的決策型別 ${pd.type}`);
  }
}

