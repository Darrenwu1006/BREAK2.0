// M5 啟發式 AI：點數效益＋資源保存
// 原則：
// - 防守選擇：接得起來優先接球（保有攻擊回合與抽牌）；接不起來但攔得住才攔網
// - 登場：防守用「剛好夠」的最小點數卡（保存強卡）；進攻用最大點數
// - 判定註定失敗時不登場（直接 Lost，省下手牌＝少抽牌＝牌組撐更久）
// - 換牌：退掉事件卡（M3 技能接入前事件卡無法使用）
import type { Card } from "../data/types";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import { blockDeployMax, canChooseBlock, deployableUids, freeOptions } from "../engine/engine";
import { autoPickCards } from "../engine/effects";
import { pickDeployName, selectBlockers } from "./util";

type Area = "serve" | "block" | "receive" | "toss" | "attack";

function paramOf(db: CardDb, state: GameState, uid: number, area: Area): number {
  const c: Card = db.get(state.cards[uid]!)!;
  return c.params?.[area] ?? 0;
}

/** 對手打過來的 OP 值（不存在時視為 0） */
function incomingOp(state: GameState, me: PlayerId): number {
  return state.op && state.op.owner !== me ? state.op.value : 0;
}

/** 從手牌挑出「不同卡名、攔網點數最高」的至多 3 張（貪婪），回傳由高到低 */
function bestBlockers(db: CardDb, state: GameState, p: PlayerId): number[] {
  const opts = deployableUids(db, state, p, "block")
    .slice()
    .sort((a, b) => paramOf(db, state, b, "block") - paramOf(db, state, a, "block"));
  const names = new Set<string>();
  const chosen: number[] = [];
  for (const u of opts) {
    const name = db.get(state.cards[u]!)!.nameJa;
    if (names.has(name)) continue;
    names.add(name);
    chosen.push(u);
    if (chosen.length === 3) break;
  }
  return chosen;
}

export function heuristicAiDecision(db: CardDb, state: GameState): Decision {
  const pd = state.pendingDecision;
  if (!pd) throw new Error("沒有待決策");
  const p = pd.player as PlayerId;
  const hand = state.players[p].hand;

  switch (pd.type) {
    case "serve-rights":
      // 先發球＝先給壓力，且對手 Lost 時自己拿下個 Set 發球權
      return { type: "serve-rights", take: true };

    case "mulligan":
      return { type: "mulligan", returnUids: [] }; // M3：事件卡已可使用，不再退回

    case "defense-choice": {
      const op = incomingOp(state, p);
      const bestReceive = Math.max(0, ...deployableUids(db, state, p, "receive").map((u) => paramOf(db, state, u, "receive")));
      if (bestReceive >= op) return { type: "defense-choice", choice: "receive" };
      if (canChooseBlock(state)) {
        const blockers = bestBlockers(db, state, p);
        const dp = blockers.reduce((s, u) => s + paramOf(db, state, u, "block"), 0);
        if (dp >= op) return { type: "defense-choice", choice: "block" };
      }
      // 接不起來也攔不住 → 接球（多抽 1 張說不定有救）
      return { type: "defense-choice", choice: "receive" };
    }

    case "deploy-serve": {
      // 最大發球點數施壓
      const opts = deployableUids(db, state, p, "serve");
      if (!opts.length) return { type: "deploy-serve", uid: null };
      const best = opts.reduce((a, b) => (paramOf(db, state, a, "serve") >= paramOf(db, state, b, "serve") ? a : b));
      return { type: "deploy-serve", uid: best, nameChoice: pickDeployName(db, state, p, best, "serve") };
    }

    case "deploy-receive": {
      const op = incomingOp(state, p);
      const opts = deployableUids(db, state, p, "receive");
      // 「剛好夠」的最小接球點數；全都不夠 → 不登場省牌
      const enough = opts.filter((u) => paramOf(db, state, u, "receive") >= op);
      if (!enough.length) return { type: "deploy-receive", uid: null };
      const cheapest = enough.reduce((a, b) => (paramOf(db, state, a, "receive") <= paramOf(db, state, b, "receive") ? a : b));
      return { type: "deploy-receive", uid: cheapest, nameChoice: pickDeployName(db, state, p, cheapest, "receive") };
    }

    case "deploy-toss": case "deploy-attack": {
      const area = pd.type.slice("deploy-".length) as "toss" | "attack";
      const opts = deployableUids(db, state, p, area);
      if (!opts.length) return { type: pd.type, uid: null } as Decision;
      const best = opts.reduce((a, b) => (paramOf(db, state, a, area) >= paramOf(db, state, b, area) ? a : b));
      return { type: pd.type, uid: best, nameChoice: pickDeployName(db, state, p, best, area) } as Decision;
    }

    case "deploy-block": {
      const op = incomingOp(state, p);
      const maxN = blockDeployMax(state, p);
      if (maxN === 0) return { type: "deploy-block", uids: null };
      const ranked = bestBlockers(db, state, p);
      const sel = selectBlockers(db, state, p, ranked, Math.min(3, maxN));
      if (!sel.uids.length) return { type: "deploy-block", uids: null };
      // 取「剛好夠」的最少人數（由高到低累加）；湊不到 OP → 不登場省牌
      const uids: number[] = [];
      let dp = 0;
      for (const u of sel.uids) {
        uids.push(u);
        dp += paramOf(db, state, u, "block");
        if (dp >= op) break;
      }
      if (dp < op) return { type: "deploy-block", uids: null };
      const nameChoices: Record<number, string> = {};
      for (const u of uids) if (sel.nameChoices[u] !== undefined) nameChoices[u] = sel.nameChoices[u]!;
      // 中央放點數最高者（側邊者回合結束會棄掉，留最強的在場上）
      return { type: "deploy-block", uids, center: uids[0]!, nameChoices };
    }

    case "free": {
      // M3 最低限度：有可用的事件卡/主動技能就用（價值判斷與時機選擇留待 M5）
      const fo = freeOptions(db, state);
      if (fo.events.length) return { type: "free", action: "event", uid: fo.events[0]!.uid };
      if (fo.skills.length) return { type: "free", action: "skill", uid: fo.skills[0]!.uid, skillIndex: fo.skills[0]!.skillIndex };
      return { type: "free", action: "pass" };
    }

    case "pick-set-card":
      return { type: "pick-set-card", index: 0 };

    // ---- 效果決策（M3）：gate 一律接受（多為增益）、選卡用引擎保底邏輯 ----
    case "resolve-pending":
      return { type: "resolve-pending", id: (pd.candidates ?? [])[0]! };
    case "effect-confirm":
      return { type: "effect-confirm", accept: true };
    case "effect-cards":
      return { type: "effect-cards", uids: autoPickCards(db, state) };
    case "effect-option":
      return { type: "effect-option", index: 0 };

    default:
      throw new Error(`啟發式 AI 未支援的決策型別 ${pd.type}`);
  }
}
