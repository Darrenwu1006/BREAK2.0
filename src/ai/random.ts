// M4 第一版 AI：合法手中隨機選（M5 將升級為啟發式/搜索；介面不變）
// M3 起需處理效果決策：gate 隨機接受、選卡用引擎保底邏輯（autoPickCards）
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { blockDeployMax, canChooseBlock, deployableUids } from "../engine/engine";
import { autoPickCards } from "../engine/effects";
import { pickDeployName, selectBlockers } from "./util";

export function randomAiDecision(db: CardDb, state: GameState, rnd: () => number = Math.random): Decision {
  const pd = state.pendingDecision;
  if (!pd) throw new Error("沒有待決策");
  const p = pd.player as PlayerId;
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;

  switch (pd.type) {
    case "serve-rights":
      return { type: "serve-rights", take: rnd() < 0.5 };
    case "mulligan":
      return { type: "mulligan", returnUids: [] };
    case "defense-choice":
      return { type: "defense-choice", choice: canChooseBlock(state) && rnd() < 0.5 ? "block" : "receive" };
    case "free":
      return { type: "free", action: "pass" }; // 隨機 AI 不主動用技能/事件（被動觸發仍會發生）
    case "pick-set-card":
      return { type: "pick-set-card", index: Math.floor(rnd() * state.players[p].setArea.length) };
    case "resolve-pending":
      return { type: "resolve-pending", id: pick(pd.candidates ?? []) };
    case "effect-confirm":
      return { type: "effect-confirm", accept: rnd() < 0.5 };
    case "effect-cards":
      return { type: "effect-cards", uids: autoPickCards(db, state) };
    case "effect-option":
      return { type: "effect-option", index: Math.floor(rnd() * (pd.options?.length ?? 1)) };
    case "deploy-block": {
      const opts = deployableUids(db, state, p, "block");
      const maxN = blockDeployMax(state, p);
      if (opts.length === 0 || maxN === 0) return { type: "deploy-block", uids: null };
      const sel = selectBlockers(db, state, p, opts, Math.min(3, maxN));
      if (sel.uids.length === 0) return { type: "deploy-block", uids: null };
      const k = 1 + Math.floor(rnd() * sel.uids.length);
      const uids = sel.uids.slice(0, k);
      const nameChoices: Record<number, string> = {};
      for (const u of uids) if (sel.nameChoices[u] !== undefined) nameChoices[u] = sel.nameChoices[u]!;
      return { type: "deploy-block", uids, center: pick(uids), nameChoices };
    }
    case "deploy-serve": case "deploy-receive": case "deploy-toss": case "deploy-attack": {
      const area = pd.type.slice("deploy-".length) as "serve" | "receive" | "toss" | "attack";
      const opts = deployableUids(db, state, p, area);
      if (!opts.length) return { type: pd.type, uid: null } as Decision;
      const uid = pick(opts);
      return { type: pd.type, uid, nameChoice: pickDeployName(db, state, p, uid, area) } as Decision;
    }
    default:
      throw new Error(`隨機 AI 未支援的決策型別 ${pd.type}`);
  }
}
