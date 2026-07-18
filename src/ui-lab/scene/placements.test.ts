// M9a CP4 擺位測試：全卡有位、視角正背面、merge 合成視圖。

import { describe, expect, it } from "vitest";
import cardsJson from "../../../data/cards.json";
import karasunoDeck from "../../../data/decks/烏野-預組.json";
import nekomaDeck from "../../../data/decks/音駒-音駒-三彈官方.json";
import { heuristicAiDecision } from "../../ai/heuristic";
import type { Card } from "../../data/types";
import { applyDecision, createGame, effParam } from "../../engine/engine";
import type { CardDb, GameState } from "../../engine/types";
import { capturePlayerValueFormulas } from "../presentation/valueFormula";
import { blockSideAnchor, CARD_T, CARD_W, SLOT_H, SLOT_W, zoneAnchor } from "./layout";
import { applyBlockPreview, applyReadingFrame, computePlacements, HAND_COS, HAND_SIN, HAND_TILT, jitter, liftInPlaceReadingCandidates, locateReadingCard, mergePlacements, readingCardsForZone } from "./placements";

interface DeckJson {
  cards: { id: string; count: number }[];
}
const expand = (d: DeckJson): string[] => d.cards.flatMap((c) => Array(c.count).fill(c.id) as string[]);

const db: CardDb = new Map((cardsJson as unknown as Card[]).map((c) => [c.id, c]));
const schools: [string, string] = ["烏野", "音駒"];

function midGame(): GameState {
  let s = createGame(db, { seed: 20260710, decks: [expand(karasunoDeck as DeckJson), expand(nekomaDeck as DeckJson)] });
  for (let i = 0; i < 60 && s.pendingDecision; i++) s = applyDecision(db, s, heuristicAiDecision(db, s));
  return s;
}

describe("computePlacements", () => {
  it("3D 實體卡會使用該 uid 所屬牌組指定的卡面版本", () => {
    const s = midGame();
    const uid = s.players[0].hand[0]!;
    const id = s.cards[uid]!;
    const source = db.get(id)!;
    const localDbMutable = new Map(db);
    localDbMutable.set(id, { ...source, printings: [...source.printings, { rarity: "ALT", image: "cards/alternate.webp" }] });
    const localDb: CardDb = localDbMutable;
    const shown = computePlacements(localDb, s, schools, new Map(), undefined, new Map([[uid, "ALT"]])).cards.get(uid)!;
    expect(shown.frontUrl).toContain("cards/alternate.webp");
  });

  it("deploy/block 決策可只替合法手牌掛上該區有效值 badge", () => {
    const s = midGame();
    const [shownUid, hiddenUid] = s.players[0].hand;
    expect(shownUid).toBeDefined();
    expect(hiddenUid).toBeDefined();
    const cards = computePlacements(db, s, schools, new Map(), {
      player: 0,
      param: "receive",
      uids: new Set([shownUid!]),
    }).cards;
    expect(cards.get(shownUid!)!.effectiveValue).toBe(effParam(db, s, shownUid!, "receive"));
    expect(cards.get(shownUid!)!.baseValue).toBe(db.get(s.cards[shownUid!]!)?.params?.receive ?? null);
    expect(cards.get(hiddenUid!)!.effectiveValue).toBeUndefined();
  });

  it("非牌堆藏牌外的所有 uid 都有擺位；牌組卡不單獨擺（厚度疊表現）", () => {
    const s = midGame();
    const { cards, piles } = computePlacements(db, s, schools);
    for (const player of [0, 1] as const) {
      const ps = s.players[player];
      const placedZones = [ps.hand, ps.setArea, ps.serve, ps.receive, ps.toss, ps.attack, ps.blockCenter, ps.blockSides].flat();
      for (const uid of placedZones) expect(cards.has(uid), `uid ${uid} 應有擺位`).toBe(true);
      for (const uid of ps.deck) expect(cards.has(uid)).toBe(false);
      expect(piles.find((p) => p.key === `deck${player}`)?.count).toBe(ps.deck.length);
    }
  });

  it("hidden-information：P1 手牌／雙方 Set 不帶正面貼圖；對手公開卡朝玩家可讀", () => {
    const s = midGame();
    const { cards } = computePlacements(db, s, schools);
    for (const uid of s.players[0].hand) expect(cards.get(uid)!.faceUp).toBe(true);
    for (const uid of s.players[1].hand) {
      expect(cards.get(uid)!.faceUp).toBe(false);
      expect(cards.get(uid)!.frontUrl).toBeNull();
    }
    for (const player of [0, 1] as const) for (const uid of s.players[player].setArea) {
      expect(cards.get(uid)!.faceUp).toBe(false);
      expect(cards.get(uid)!.frontUrl).toBeNull();
    }
    for (const zone of ["serve", "receive", "toss", "attack", "blockCenter"] as const) {
      const uid = s.players[1][zone].at(-1);
      if (uid !== undefined) expect(cards.get(uid)!.rotation[1]).toBeCloseTo(jitter(uid), 8);
    }
  });

  it("整場結束後才公開 P1 剩餘手牌，Set 仍維持蓋牌", () => {
    const ended = structuredClone(midGame());
    ended.phase = "gameOver";
    ended.pendingDecision = null;
    ended.winner = 1;

    const { cards } = computePlacements(db, ended, schools);
    expect(ended.players[1].hand.length).toBeGreaterThan(0);
    for (const uid of ended.players[1].hand) {
      expect(cards.get(uid)!.faceUp).toBe(true);
      expect(cards.get(uid)!.frontUrl).not.toBeNull();
    }
    for (const uid of ended.players[1].setArea) {
      expect(cards.get(uid)!.faceUp).toBe(false);
      expect(cards.get(uid)!.frontUrl).toBeNull();
    }
  });

  /** [使用者 2026-07-12] 手牌＝左右並排、rotY/rotZ=0、同傾角；由左到右＝由下到上：
   *  y 與 z 沿 index 嚴格遞增（平行層距，右壓左），保證不共面 z-fighting、相鄰不重疊。 */
  function assertHandNoClip(s: GameState): void {
    const { cards } = computePlacements(db, s, schools);
    const hand = s.players[0].hand.map((uid) => cards.get(uid)!);
    for (const p of hand) {
      expect(p.rotation[1], "手牌 rotY 必須為 0").toBe(0);
      expect(p.rotation[2], "手牌不再扇形：rotZ 必須為 0").toBe(0);
      expect(p.rotation[0], "手牌同傾角").toBe(hand[0]!.rotation[0]);
    }
    // x 左到右嚴格遞增、相鄰中心距 > 卡寬 ⇒ 水平不重疊；y/z 遞增 ⇒ 層距分離不 z-fight。
    for (let i = 1; i < hand.length; i++) {
      const dx = hand[i]!.position[0] - hand[i - 1]!.position[0];
      expect(dx, `相鄰手牌 ${i - 1}/${i} 左右並排不重疊`).toBeGreaterThan(CARD_W);
      expect(hand[i]!.position[1], `手牌 ${i} 高於左鄰（由下到上層疊）`).toBeGreaterThan(hand[i - 1]!.position[1]);
      expect(hand[i]!.position[2], `手牌 ${i} 較左鄰靠觀者（層距分離）`).toBeGreaterThan(hand[i - 1]!.position[2]);
    }
    // hover/highlight 位移必須是卡面內移動（沿法線分量 ≈ 0）
    for (const p of hand) {
      for (const off of [p.hoverOffset, p.highlightOffset]) {
        expect(off, "手牌必須帶安全位移").toBeDefined();
        const n = off![1] * HAND_COS + off![2] * HAND_SIN;
        expect(Math.abs(n), "hover/highlight 位移的法線分量").toBeLessThan(1e-9);
      }
    }
  }

  it("P0 手牌：左右並排、間距隨張數收縮、不堆疊不破圖", () => {
    const s = midGame();
    assertHandNoClip(s);
    const stepOf = (st: GameState): number => {
      const { cards } = computePlacements(db, st, schools);
      const h = st.players[0].hand;
      return cards.get(h[1]!)!.position[0] - cards.get(h[0]!)!.position[0];
    };
    const ps = s.players[0];
    while (ps.hand.length > 6) ps.deck.push(ps.hand.pop()!);
    const stepMany = stepOf(s);
    while (ps.hand.length > 3) ps.deck.push(ps.hand.pop()!);
    const stepFew = stepOf(s);
    // 越少張越鬆（間距越大）
    expect(stepFew).toBeGreaterThan(stepMany);
  });

  it("P0 手牌少（2/3/4 張）時同樣不破圖——CP5d 迴歸案例", () => {
    const s = midGame();
    for (const keep of [4, 3, 2]) {
      const ps = s.players[0];
      while (ps.hand.length > keep) ps.deck.push(ps.hand.pop()!);
      assertHandNoClip(s);
    }
  });

  it("P1 蓋牌扇：相鄰層距 > 卡厚（平放卡 rotY＝面內滾轉，只需層距）", () => {
    const s = midGame();
    const { cards } = computePlacements(db, s, schools);
    const hand = s.players[1].hand.map((uid) => cards.get(uid)!);
    for (let i = 1; i < hand.length; i++) {
      expect(hand[i]!.position[1] - hand[i - 1]!.position[1], `P1 手牌 ${i - 1}/${i} 層距`).toBeGreaterThan(CARD_T);
      expect(hand[i]!.rotation[0]).toBe(0);
    }
  });

  it("P0 場上卡槽保留完整間距；接球/托球/攻擊列在 Set 卡列下方", () => {
    const anchors = [
      zoneAnchor(0, "blockCenter"),
      blockSideAnchor(0, 0),
      blockSideAnchor(0, 1),
      zoneAnchor(0, "receive"),
      zoneAnchor(0, "toss"),
      zoneAnchor(0, "attack"),
      zoneAnchor(0, "serve"),
      zoneAnchor(0, "eventArea"),
      zoneAnchor(0, "setArea"),
      zoneAnchor(0, "deck"),
      zoneAnchor(0, "drop"),
    ];
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const a = anchors[i]!;
        const b = anchors[j]!;
        expect(Math.abs(a.x - b.x) >= SLOT_W || Math.abs(a.z - b.z) >= SLOT_H, `slot ${i}/${j} 不應重疊`).toBe(true);
      }
    }
    expect(zoneAnchor(0, "receive").z).toBeGreaterThan(zoneAnchor(0, "setArea").z);
    expect(zoneAnchor(0, "toss").z).toBeGreaterThan(zoneAnchor(0, "blockCenter").z);
    expect(zoneAnchor(0, "attack").z).toBeGreaterThan(zoneAnchor(0, "blockCenter").z);
    expect(zoneAnchor(0, "setArea").z - SLOT_H / 2).toBeGreaterThan(0);
    expect(Math.abs(zoneAnchor(1, "setArea").z) - SLOT_H / 2).toBeGreaterThan(0);
    expect(zoneAnchor(0, "serve").z).toBeLessThan(zoneAnchor(0, "hand").z);
    expect(zoneAnchor(0, "eventArea").z).toBeLessThan(zoneAnchor(0, "hand").z);
  });

  it("Set 平時緊密疊放，pick-set-card 時才展開", () => {
    const s = midGame();
    const player = 0 as const;
    const set = s.players[player].setArea;
    if (set.length < 2) return;
    const compact = computePlacements(db, s, schools).cards;
    const compactDx = Math.abs(compact.get(set[0]!)!.position[0] - compact.get(set[1]!)!.position[0]);
    s.pendingDecision = { player, type: "pick-set-card" };
    const expanded = computePlacements(db, s, schools).cards;
    const expandedDx = Math.abs(expanded.get(set[0]!)!.position[0] - expanded.get(set[1]!)!.position[0]);
    expect(compactDx).toBeLessThan(0.3);
    expect(expandedDx).toBeGreaterThan(1.2);
  });

  it("攔網複選在提交前預覽中央與兩側位置，可替換 center", () => {
    const s = midGame();
    const selected = s.players[0].hand.slice(0, 3);
    if (selected.length < 3) return;
    const base = computePlacements(db, s, schools);
    const preview = applyBlockPreview(base, selected, selected[1]!);
    expect(preview.cards.get(selected[1]!)?.zone).toBe("blockCenter");
    expect(preview.cards.get(selected[0]!)?.zone).toBe("blockSide");
    expect(preview.cards.get(selected[2]!)?.zone).toBe("blockSide");
    expect(preview.cards.get(selected[1]!)?.position[0]).toBe(zoneAnchor(0, "blockCenter").x);
  });

  it("3D reading frame 展開效果候選並按來源分區盤，候選身份由引擎授權後正面顯示", () => {
    const s = midGame();
    const refs = [
      locateReadingCard(s, s.players[0].deck[0]!)!,
      locateReadingCard(s, s.players[0].deck[1]!)!,
      locateReadingCard(s, s.players[1].drop.at(-1) ?? s.players[1].deck[0]!)!,
    ];
    const base = computePlacements(db, s, schools);
    const reading = applyReadingFrame(base, db, s, refs, schools);
    for (const ref of refs) {
      expect(reading.cards.get(ref.uid)?.faceUp).toBe(true);
      expect(reading.cards.get(ref.uid)?.position[1]).toBeGreaterThan(1);
    }
    expect(reading.readingPanels).toHaveLength(2);
    expect(reading.readingPanels?.[0]?.label).toBe("我方牌組");
    expect(reading.readingPanels?.[1]?.label).toMatch(/^對手/);
    const [first, second] = reading.readingPanels!;
    expect(first!.position[0]).not.toBe(second!.position[0]);
  });

  it("跨三個場上區支付 Guts 時，各區保有獨立底盤並即時顯示支付後剩餘", () => {
    const s = midGame();
    const pool = [...s.players[0].hand, ...s.players[0].deck].slice(0, 9);
    expect(pool.length).toBeGreaterThanOrEqual(9);
    const state: GameState = {
      ...s,
      players: [
        {
          ...s.players[0],
          hand: s.players[0].hand.filter((uid) => !pool.includes(uid)),
          deck: s.players[0].deck.filter((uid) => !pool.includes(uid)),
          receive: pool.slice(0, 3),
          toss: pool.slice(3, 6),
          attack: pool.slice(6, 9),
        },
        s.players[1],
      ],
    };
    const candidates = [state.players[0].receive[0]!, state.players[0].receive[1]!, state.players[0].toss[0]!, state.players[0].toss[1]!, state.players[0].attack[0]!, state.players[0].attack[1]!];
    const refs = candidates.map((uid) => locateReadingCard(state, uid)!);
    const framed = applyReadingFrame(computePlacements(db, state, schools), db, state, refs, schools, "select", new Map(), new Set([candidates[0]!, candidates[2]!, candidates[4]!]));
    expect(framed.readingPanels?.map((panel) => panel.label)).toEqual(["我方接球區", "我方托球區", "我方攻擊區"]);
    expect(framed.readingPanels?.every((panel) => panel.detail === "Guts 2・已選 1 → 剩 1")).toBe(true);
    const panelXs = framed.readingPanels!.map((panel) => panel.position[0]);
    expect(new Set(panelXs).size).toBe(3);
  });

  it("疊放區 inspect：最上一張＝場上角色、其餘＝Guts，分列標記且傾角對齊手牌、往觀者拉近", () => {
    const s = midGame();
    const pool = [...s.players[0].hand];
    const gut = pool[0]!;
    const chara = pool[1]!;
    // 造一個含 Guts 的 serve 疊（底＝Guts、頂＝場上角色）；同步從手牌移出避免重複擺位。
    const state: GameState = {
      ...s,
      players: [
        { ...s.players[0], serve: [gut, chara], hand: s.players[0].hand.filter((u) => u !== gut && u !== chara) },
        s.players[1],
      ],
    };
    const refs = readingCardsForZone(state, 0, "serve");
    expect(refs[0]!.uid, "最上一張排最前").toBe(chara);
    expect(refs[0]!.groupLabel).toContain("角色");
    expect(refs[1]!.uid).toBe(gut);
    expect(refs[1]!.groupLabel).toContain("ガッツ");
    // 角色與 Guts 分成兩個不同的列鍵
    expect(refs[0]!.groupKey).not.toBe(refs[1]!.groupKey);

    const base = computePlacements(db, state, schools);
    const framed = applyReadingFrame(base, db, state, refs, schools, "inspect");
    const cp = framed.cards.get(chara)!;
    const gp = framed.cards.get(gut)!;
    expect(cp.rotation[0], "傾角對齊手牌").toBeCloseTo(HAND_TILT, 5);
    expect(gp.rotation[0]).toBeCloseTo(HAND_TILT, 5);
    // 角色列比 Guts 列更靠近觀者（z 較大）
    expect(cp.position[2]).toBeGreaterThan(gp.position[2]);
    // 兩列各有一個標籤
    expect([cp.readingGroup, gp.readingGroup].filter(Boolean).length).toBe(2);
  });

  it("效果選卡 reading frame 與手牌同傾角、候選同尺寸", () => {
    const s = midGame();
    const refs = [locateReadingCard(s, s.players[0].deck[0]!)!];
    const framed = applyReadingFrame(computePlacements(db, s, schools), db, s, refs, schools);
    expect(framed.cards.get(refs[0]!.uid)!.rotation[0]).toBeCloseTo(HAND_TILT, 5);
  });

  it("有效值快照在引擎 modifier 清除後仍顯示基礎值＋修正結果", () => {
    const s = midGame();
    const zone = (["serve", "receive", "toss", "attack"] as const).find((key) => s.players[0][key].length > 0);
    if (!zone) return;
    const uid = s.players[0][zone].at(-1)!;
    const before = structuredClone(s);
    before.modifiers.push({ target: uid, param: zone, amount: 2, source: uid });
    const formulas = capturePlayerValueFormulas(db, before, 0);
    const shown = computePlacements(db, s, schools, formulas).cards.get(uid)!;
    expect(shown.baseValue).not.toBeNull();
    expect(shown.effectiveValue).toBe((shown.baseValue ?? 0) + 2);
  });

  it("混合來源 effect-cards 的可見候選保留原 x/z，只抬高避免 reading frame 遮擋", () => {
    const s = midGame();
    const uid = s.players[0].hand[0]!;
    const base = computePlacements(db, s, schools);
    const original = base.cards.get(uid)!;
    const lifted = liftInPlaceReadingCandidates(base, new Set([uid])).cards.get(uid)!;
    expect(lifted.position[0]).toBe(original.position[0]);
    expect(lifted.position[2]).toBe(original.position[2]);
    expect(lifted.position[1]).toBeGreaterThanOrEqual(1.05);
  });

  it("mergePlacements：只有 movedUids 取 target 擺位，其餘維持 base", () => {
    const before = midGame();
    const after = applyDecision(db, before, heuristicAiDecision(db, before));
    const base = computePlacements(db, before, schools);
    const target = computePlacements(db, after, schools);
    const moved = new Set([before.players[0].hand[0]!]);
    const merged = mergePlacements(base, target, moved);
    for (const [uid, p] of merged.cards) {
      expect(p).toBe(moved.has(uid) ? (target.cards.get(uid) ?? base.cards.get(uid)) : base.cards.get(uid));
    }
    expect(mergePlacements(base, target, new Set())).toBe(base);
  });
});
