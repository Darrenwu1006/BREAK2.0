// M4 第一版 AI：合法手中隨機選（M5 將升級為啟發式/搜索；介面不變）
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { canChooseBlock, deployableUids } from "../engine/engine";

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
      return { type: "free", action: "pass" };
    case "pick-set-card":
      return { type: "pick-set-card", index: Math.floor(rnd() * state.players[p].setArea.length) };
    case "deploy-block": {
      const opts = deployableUids(db, state, p, "block");
      if (opts.length === 0) return { type: "deploy-block", uids: null };
      const names = new Set<string>();
      const chosen: number[] = [];
      for (const u of opts) {
        const n = db.get(state.cards[u]!)!.nameJa;
        if (!names.has(n)) { names.add(n); chosen.push(u); }
        if (chosen.length === 3) break;
      }
      const k = 1 + Math.floor(rnd() * chosen.length);
      const uids = chosen.slice(0, k);
      return { type: "deploy-block", uids, center: pick(uids) };
    }
    case "deploy-serve": case "deploy-receive": case "deploy-toss": case "deploy-attack": {
      const area = pd.type.slice("deploy-".length) as "serve" | "receive" | "toss" | "attack";
      const opts = deployableUids(db, state, p, area);
      return { type: pd.type, uid: opts.length ? pick(opts) : null } as Decision;
    }
  }
}
