// [Claude 2026-07-24] 候選 C Part 2：每場對局的描述性統計（純資料，兩介面共用；各介面原生渲染）。
// 包 summarizeReplaySession（火力/防守/資源/對局結構，含 min）＋補「開技能次數」（含 per-card 前幾名）。
// 資料全部由 replay 導出，不依賴 React／演出。

import type { CardDb, GameState } from "../engine/types";
import { replayEntryLogs, summarizeReplaySession, type ReplayAnalytics, type ReplaySession } from "./replayHistory";

export interface SkillUsageCard {
  name: string;
  count: number;
}

export interface SkillUsage {
  total: number;
  /** 依次數由高到低。 */
  byCard: SkillUsageCard[];
}

export interface MatchSummary {
  analytics: ReplayAnalytics;
  /** per-player 開技能次數（[0]=你 [1]=電腦）。 */
  skillUsage: [SkillUsage, SkillUsage];
}

function cardName(db: CardDb, state: GameState, uid: number): string {
  const id = state.cards[uid];
  if (!id) return `uid ${uid}`;
  const card = db.get(id);
  return card ? card.nameZh || card.nameJa : id;
}

function toUsage(counts: Map<string, number>): SkillUsage {
  const byCard = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total: byCard.reduce((sum, card) => sum + card.count, 0), byCard };
}

export function buildMatchSummary(db: CardDb, session: ReplaySession): MatchSummary {
  const analytics = summarizeReplaySession(session);
  const counts: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
  for (const entry of session.entries) {
    for (const log of replayEntryLogs(entry)) {
      const event = log.event;
      if (event?.kind === "skill-used") {
        const name = cardName(db, entry.after, event.uid);
        const map = counts[event.player];
        map.set(name, (map.get(name) ?? 0) + 1);
      }
    }
  }
  return { analytics, skillUsage: [toUsage(counts[0]), toUsage(counts[1])] };
}
