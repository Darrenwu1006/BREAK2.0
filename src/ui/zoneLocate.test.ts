import { describe, expect, it } from "vitest";
import type { GameState, PlayerState } from "../engine/types";
import { groupCandidatesByZone, locateUidZone, ZONE_LABEL } from "./zoneLocate";

function player(over: Partial<PlayerState> = {}): PlayerState {
  return {
    deck: [], hand: [], setArea: [], drop: [], eventArea: [],
    serve: [], blockCenter: [], blockSides: [], receive: [], toss: [], attack: [],
    ...over,
  };
}

function state(p0: PlayerState, p1: PlayerState): GameState {
  return { players: [p0, p1] } as unknown as GameState;
}

describe("zoneLocate", () => {
  it("locates a uid in the owning player's zone", () => {
    const s = state(player({ hand: [10], attack: [20] }), player({ drop: [30] }));
    expect(locateUidZone(s, 10)).toEqual({ owner: 0, zone: "hand" });
    expect(locateUidZone(s, 20)).toEqual({ owner: 0, zone: "attack" });
    expect(locateUidZone(s, 30)).toEqual({ owner: 1, zone: "drop" });
    expect(locateUidZone(s, 999)).toBeNull();
  });

  it("groups cross-zone candidates by source, preserving order, with stable buckets", () => {
    // 模擬「全區挑 Guts」：候選散落在攻擊/托球/接球區（同一玩家）
    const s = state(player({ attack: [1, 2], toss: [3], receive: [4] }), player());
    const groups = groupCandidatesByZone(s, [1, 3, 2, 4]);
    // 三個不同區域 → 三組；同區的 1、2 收進同一桶
    expect(groups.map((g) => g.zone)).toEqual(["attack", "toss", "receive"]);
    expect(groups.find((g) => g.zone === "attack")!.uids).toEqual([1, 2]);
    expect(groups.every((g) => g.owner === 0)).toBe(true);
    expect(groups).toHaveLength(3);
  });

  it("distinguishes opponent-owned candidates by owner", () => {
    const s = state(player({ hand: [1] }), player({ attack: [2] }));
    const groups = groupCandidatesByZone(s, [1, 2]);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.owner).toBe(1);
    expect(ZONE_LABEL[groups[1]!.zone]).toBe("攻擊區");
  });

  it("returns a single group when all candidates share one zone", () => {
    const s = state(player({ hand: [1, 2, 3] }), player());
    const groups = groupCandidatesByZone(s, [1, 2, 3]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.zone).toBe("hand");
  });
});
