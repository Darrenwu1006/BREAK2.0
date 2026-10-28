// [Codex 2026-10-28] 獨立驗收：斷言卡文要求的行為；缺陷直接修復並保持正常回歸斷言，不以 skip/fails 掩蓋。
import { describe, expect, it } from "vitest";
import cardsJson from "../../data/cards.json";
import effectsJson from "../../data/effects.json";
import type { Card } from "../data/types";
import type { GameState, PlayerId } from "./types";
import { canDeployTo, effParam } from "./engine";
import { cleanupTurn, deployCard } from "./effects";
import { baseParam, topChara } from "./effect-helpers";
import { MatchSession } from "../shared/matchSession";
import { heuristicAiDecision } from "../ai/heuristic";
import { db, deckWith, drainCp, feed, FILLER, grab, placeDeckTop, placeInDrop, placeOnStack, receiveTrack, seedStack, serveWith, setup } from "./testkit";

function conserved(s: GameState) {
  const zones = s.players.flatMap((ps) => [ps.deck, ps.hand, ps.setArea, ps.drop, ps.serve, ps.blockCenter, ps.blockSides, ps.receive, ps.toss, ps.attack, ps.eventArea]);
  const uids = zones.flat();
  expect(uids).toHaveLength(80);
  expect(new Set(uids).size).toBe(80);
}

function drawState(p: PlayerId, id = "HV-P04-100") {
  const deck = deckWith(id, "HV-P04-085", "HV-D04-001");
  let s = setup(p === 0 ? deck : deckWith(FILLER), p === 1 ? deck : deckWith(FILLER), (1 - p) as PlayerId);
  s = serveWith(s, FILLER);
  s = feed(s, { type: "defense-choice", choice: "receive" });
  expect(s.turnPlayer).toBe(p);
  return s;
}

function millState(id: string, deckSize?: number) {
  let s = setup(deckWith(id, "HV-P04-093", "HV-P04-094", "HV-P04-095", "HV-D01-008", "HV-D01-009"), deckWith(FILLER), 1);
  s = serveWith(s, FILLER);
  s = feed(s, { type: "defense-choice", choice: "receive" });
  s = feed(s, { type: "free", action: "pass" });
  if (id !== "HV-P04-045") {
    s = feed(s, { type: "deploy-receive", uid: grab(s, 0, "HV-D01-008") });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-toss", uid: grab(s, 0, "HV-D01-009") });
    s = feed(s, { type: "free", action: "pass" });
  }
  const source = grab(s, 0, id);
  const third = placeDeckTop(s, 0, "HV-P04-093");
  const second = placeDeckTop(s, 0, "HV-P04-094");
  const first = placeDeckTop(s, 0, "HV-P04-095");
  if (deckSize !== undefined) s.players[0].drop.push(...s.players[0].deck.splice(deckSize));
  s = feed(s, id === "HV-P04-045" ? { type: "deploy-receive", uid: source } : { type: "deploy-attack", uid: source });
  s = feed(s, { type: "effect-confirm", accept: true });
  return { s, first, second, third, source };
}

describe("P04 acceptance — 資料契約（不能取代行為驗收）", () => {
  it("所有技能卡 effects.json 與 cards.json 深度一致，總數依實際資料計算", () => {
    const cards = cardsJson as unknown as Card[];
    expect(cards).toHaveLength(541);
    expect(cards.filter((c) => c.effectStatus === "dsl")).toHaveLength(358);
    expect(cards.filter((c) => c.effectStatus === "vanilla")).toHaveLength(183);
    expect(cards.filter((c) => c.effectStatus === "todo")).toEqual([]);
    for (const c of cards.filter((c) => c.effectStatus === "dsl")) {
      expect(c.effect, c.id).toEqual((effectsJson as Record<string, unknown>)[c.id]);
    }
  });
});

describe("P04 acceptance — 雙方抽牌、封抽與 controller", () => {
  for (const p of [0, 1] as const) {
    for (const selfDraw of [false, true]) for (const oppDraw of [false, true]) {
      it(`P04-100 player=${p} self=${selfDraw} opponent=${oppDraw}：各自選擇、0/2張、卡片守恆`, () => {
        let s = drawState(p);
        const uid = grab(s, p, "HV-P04-100");
        const before = s.players.map((ps) => ps.hand.length);
        const opp = (1 - p) as PlayerId;
        s = feed(s, { type: "free", action: "event", uid });
        expect(s.pendingDecision).toMatchObject({ type: "effect-confirm", player: p });
        s = feed(s, { type: "effect-confirm", accept: selfDraw });
        expect(s.pendingDecision).toMatchObject({ type: "effect-confirm", player: opp });
        s = feed(s, { type: "effect-confirm", accept: oppDraw });
        expect(s.players[p].hand.length).toBe(before[p]! - 1 + (selfDraw ? 2 : 0));
        expect(s.players[opp].hand.length).toBe(before[opp]! + (oppDraw ? 2 : 0));
        expect(s.pendingDecision).toMatchObject({ type: "free", player: p });
        conserved(s);
      });
    }
  }

  it("P04-100 封抽不延伸到接球階段：P04-085 仍可檢索", () => {
    let s = drawState(0);
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P04-100") });
    s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-receive", uid: grab(s, 0, FILLER) });
    const ev = grab(s, 0, "HV-P04-085");
    const target = placeDeckTop(s, 0, "HV-D04-001");
    s = feed(s, { type: "free", action: "event", uid: ev });
    expect(s.pendingDecision?.candidates).toContain(target);
    s = feed(s, { type: "effect-cards", uids: [target] });
    expect(s.players[0].hand).toContain(target);
    conserved(s);
  });

  for (const p of [0, 1] as const) {
    it(`P04-100 controller：事件使用者 P${p} 的對手確認須交給正確玩家`, () => {
      const s = drawState(p);
      const uid = grab(s, p, "HV-P04-100");
      const session = new MatchSession(db, [deckWith(FILLER), deckWith(FILLER)], 42, { deferOpponent: true });
      session.engine = s;
      const event = { type: "free", action: "event", uid } as const;
      if (p === 0) {
        expect(session.decide(event)).toBe(true);
        expect(session.decide({ type: "effect-confirm", accept: false })).toBe(true);
        expect(session.awaitingOpponent).toBe(true);
        session.decideOpponent({ type: "effect-confirm", accept: false });
        expect(session.awaitingHuman).toBe(true);
      } else {
        session.decideOpponent(event);
        session.decideOpponent({ type: "effect-confirm", accept: false });
        expect(session.awaitingHuman).toBe(true);
        expect(session.decide({ type: "effect-confirm", accept: false })).toBe(true);
        expect(session.awaitingOpponent).toBe(true);
      }
      expect(session.engine.pendingDecision).toMatchObject({ type: "free", player: p });
      conserved(session.engine);
    });

    it(`PR-063 Q1953 player=${p}：對手也必須能拒絕抽2張`, () => {
      let s = drawState(p, "HV-PR-063");
      s = feed(s, { type: "free", action: "event", uid: grab(s, p, "HV-PR-063") });
      s = feed(s, { type: "effect-confirm", accept: true }); // tilt gate
      s = feed(s, { type: "effect-confirm", accept: false }); // 自己不抽
      expect(s.pendingDecision).toMatchObject({ type: "effect-confirm", player: 1 - p });
    });
  }
});

describe("P04 acceptance — 牌組頂棄牌（資訊邊界與選擇一致性）", () => {
  for (const id of ["HV-P04-039", "HV-P04-043", "HV-P04-045"]) {
    it(`${id}：棄牌張數決定前不得暴露未公開牌組卡`, () => {
      const { s } = millState(id);
      expect((s.pendingDecision?.candidates ?? []).filter((uid) => s.players[0].deck.includes(uid))).toEqual([]);
    });
    it(`${id}：若採卡片選擇，選第三張不應靜默改棄第一張`, () => {
      const { s, third } = millState(id);
      expect(() => feed(s, { type: "effect-cards", uids: [third] })).toThrow();
    });
    it(`${id}：選0張保持牌組、棄牌、參數不變且守恆`, () => {
      const { s, source } = millState(id);
      const beforeDeck = [...s.players[0].deck];
      const beforeDrop = [...s.players[0].drop];
      const param = id === "HV-P04-045" ? "receive" : "attack";
      const next = feed(s, { type: "effect-option", index: 0 });
      expect(next.players[0].deck).toEqual(beforeDeck);
      expect(next.players[0].drop).toEqual(beforeDrop);
      expect(effParam(db, next, source, param)).toBe(baseParam(db, next, source, param));
      conserved(next);
    });
  }

  for (const count of [0, 1, 2, 3]) it(`P04-095 同一millDeck.upTo通道：不得預看，選${count}張只棄牌組頂`, () => {
    let s = setup(deckWith("HV-P04-095", "HV-P04-039", "HV-D01-008", "HV-D01-009"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    s = feed(s, { type: "deploy-toss", uid: grab(s, 0, "HV-D01-009") });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-attack", uid: grab(s, 0, "HV-P04-039") });
    s = feed(s, { type: "effect-confirm", accept: false });
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P04-095") });
    s = feed(s, { type: "effect-option", index: 4 });
    s = feed(s, { type: "effect-confirm", accept: true });
    expect((s.pendingDecision?.candidates ?? []).filter((uid) => s.players[0].deck.includes(uid))).toEqual([]);
    expect(s.pendingDecision?.type).toBe("effect-option");
    const deck = [...s.players[0].deck];
    const drop = [...s.players[0].drop];
    expect(() => feed(s, { type: "effect-cards", uids: [deck[2]!] })).toThrow();
    s = feed(s, { type: "effect-option", index: count });
    // 095 在棄到事件時另抽一張；棄牌集合必須與頂端張數一致。
    expect(s.players[0].drop).toEqual([...drop, ...deck.slice(0, count)]);
    for (const uid of deck.slice(count)) expect(s.players[0].drop).not.toContain(uid);
    conserved(s);
  });
});

describe("P04 acceptance — 強制入手與既有封鎖互動", () => {
  it("P04-085：未加入手牌的不同卡必須讓玩家選擇任意置底順序", () => {
    let s = setup(deckWith("HV-P04-085", "HV-D01-001", "HV-D01-002", "HV-D01-003"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const ev = grab(s, 0, "HV-P04-085");
    placeDeckTop(s, 0, "HV-D01-001");
    placeDeckTop(s, 0, "HV-D01-002");
    placeDeckTop(s, 0, "HV-D01-003");
    s = feed(s, { type: "free", action: "event", uid: ev });
    // 3張皆非青城，必須仍能在[C,B,A]以外選擇例如[A,B,C]；直接回free代表玩家沒有排序機會。
    expect(s.pendingDecision?.type).not.toBe("free");
  });

  function revealState() {
    let s = setup(deckWith("HV-D04-013", "HV-D04-012", "HV-D04-010"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    s = feed(s, { type: "deploy-receive", uid: grab(s, 0, "HV-D04-010") });
    const ev = grab(s, 0, "HV-D04-013");
    const target = placeDeckTop(s, 0, "HV-D04-012");
    s = feed(s, { type: "free", action: "event", uid: ev });
    return { s, target };
  }
  it("D04-013：選擇公開青城卡後不得拒收，公開是可選、入手是強制", () => {
    let { s, target } = revealState();
    s = feed(s, { type: "effect-confirm", accept: true });
    if (!s.players[0].hand.includes(target)) {
      expect(s.pendingDecision).toMatchObject({ type: "effect-cards", min: 1 });
      expect(() => feed(s, { type: "effect-cards", uids: [] })).toThrow();
      s = feed(s, { type: "effect-cards", uids: [target] });
      expect(s.players[0].hand).toContain(target);
      conserved(s);
    }
  });
  it("D04-013：可選不公開，牌組原順序不變", () => {
    const { s } = revealState();
    const deck = [...s.players[0].deck];
    const next = feed(s, { type: "effect-confirm", accept: false });
    expect(next.players[0].deck).toEqual(deck);
    conserved(next);
  });
  it("D04-013 × 舊 banHandAdd：仍公開但不得入手或抽牌", () => {
    let { s, target } = revealState();
    s.restrictions.push({ player: 0, banHandAdd: true, setNo: s.setNo, activeTurn: s.turnNo, desc: "舊技能封鎖入手" });
    const count = s.players[0].hand.length;
    s = feed(s, { type: "effect-confirm", accept: true });
    expect(s.players[0].hand).not.toContain(target);
    expect(s.players[0].hand.length).toBe(count);
    expect(s.players[0].deck.at(-1)).toBe(target);
    conserved(s);
  });
});

describe("P04 acceptance — 新卡混合牌組整場冒煙（非勝率評估）", () => {
  const schools = ["烏野", "青葉城西", "角川", "条善寺", "和久谷南", "音駒", "伊達工業", "白鳥沢", "梟谷", "稲荷崎", "ユース", "町内会"];
  function schoolDeck(school: string): string[] {
    const cards = (cardsJson as unknown as Card[]).filter((c) => c.affiliations.includes(school));
    const prioritizeNew = (a: Card, b: Card) => Number(b.id.startsWith("HV-P04") || b.id.startsWith("HV-D04")) - Number(a.id.startsWith("HV-P04") || a.id.startsWith("HV-D04"));
    const chars = cards.filter((c) => c.type === "CHARACTER").sort(prioritizeNew);
    const events = cards.filter((c) => c.type === "EVENT").sort(prioritizeNew);
    return [...Array.from({ length: events.length ? 32 : 40 }, (_, i) => chars[i % chars.length]!.id), ...Array.from({ length: events.length ? 8 : 0 }, (_, i) => events[i % events.length]!.id)];
  }
  for (const [index, school] of schools.entries()) for (const seed of [17, 91]) {
    it(`${school} vs ${schools[(index + 1) % schools.length]} seed=${seed}：合法決策、不掛住、每步80張守恆`, () => {
      let s = setup(schoolDeck(school), schoolDeck(schools[(index + 1) % schools.length]!), 0, seed);
      let steps = 0;
      while (s.pendingDecision && steps++ < 1500) {
        s = feed(s, heuristicAiDecision(db, s));
        conserved(s);
      }
      expect(s.phase).toBe("gameOver");
      expect(steps).toBeLessThan(1500);
    });
  }
});

describe("P04 acceptance — 新舊效果組合", () => {
  it("P04-016 固定A4後才結算舊孤爪的登場-2（Q1874）", () => {
    let s = setup(deckWith("HV-P04-016", "HV-P04-031", "HV-D04-002", "HV-D04-010", "HV-D04-010"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D04-010");
    seedStack(s, 0, "toss", 2);
    const iwa = placeOnStack(s, 0, "serve", "HV-D04-002");
    placeOnStack(s, 0, "serve", "HV-D04-010");
    s = feed(s, { type: "deploy-toss", uid: grab(s, 0, "HV-P04-016") });
    s = feed(s, { type: "free", action: "pass" });
    // 直接構造前回合舊孤爪技能已產生的正式 watcher，隔離對手回合準備。
    s.watchers.push({ id: s.nextId++, player: 1, source: s.players[1].serve.at(-1)!, trigger: { on: "deploy", player: "opponent", area: ["attack"] }, actions: [{ op: "addParam", target: "trigger", param: "attack", amount: -2 }], setNo: s.setNo, turnMin: s.turnNo, turnMax: s.turnNo, desc: "Q1874 舊孤爪登場-2" });
    s = feed(s, { type: "deploy-attack", uid: grab(s, 0, "HV-P04-031") });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [iwa] });
    s = drainCp(s);
    expect(topChara(s.players[0].attack)).toBe(iwa);
    expect(effParam(db, s, iwa, "attack")).toBe(2);
    conserved(s);
  });

  it("P04-070 全體防降：來源被蓋後仍保護之後登場的同校角色，cleanup到期", () => {
    let s = setup(deckWith("HV-P04-070", "HV-D03-001", "HV-D03-002", "HV-D03-002", "HV-D03-012", "HV-D03-013", "HV-P03-091"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    s = feed(s, { type: "free", action: "pass" });
    for (const id of ["HV-D03-012", "HV-D03-013", "HV-P03-091"]) {
      const uid = grab(s, 0, id);
      s.players[0].hand.splice(s.players[0].hand.indexOf(uid), 1);
      s.players[0].eventArea.push(uid);
    }
    const cost = grab(s, 0, "HV-D03-002");
    const kita = grab(s, 0, "HV-P04-070");
    s = feed(s, { type: "deploy-receive", uid: kita });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.pendingDecision?.type === "effect-cards") s = feed(s, { type: "effect-cards", uids: [cost] });
    expect(s.modifiers.some((m) => m.kind === "noDecrease")).toBe(true);
    const atsumu = grab(s, 0, "HV-D03-001");
    s.players[0].hand.splice(s.players[0].hand.indexOf(atsumu), 1);
    deployCard(db, s, 0, atsumu, "receive", { origin: "other" });
    const ally = placeOnStack(s, 0, "attack", "HV-D03-002");
    const enemy = placeOnStack(s, 1, "attack", FILLER);
    s.modifiers.push({ source: enemy, target: ally, param: "attack", amount: -2 });
    expect(effParam(db, s, ally, "attack")).toBe(baseParam(db, s, ally, "attack"));
    s.modifiers.push({ source: enemy, target: ally, param: "attack", amount: 1, kind: "set" });
    expect(effParam(db, s, ally, "attack")).toBe(1); // 不防數值固定
    cleanupTurn(s);
    expect(s.modifiers.some((m) => m.kind === "noDecrease")).toBe(false);
    conserved(s);
  });

  it("P04-083 × 舊banHandAdd：影山留場時，菅原仍可登場、不得複製卡片", () => {
    let s = setup(deckWith("HV-P04-083", "HV-D01-002", "HV-D01-009", "HV-D01-008"), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = receiveTrack(s, "HV-D01-008");
    const kage = grab(s, 0, "HV-D01-002");
    s = feed(s, { type: "deploy-toss", uid: kage });
    const suga = grab(s, 0, "HV-D01-009");
    s.restrictions.push({ player: 0, banHandAdd: true, setNo: s.setNo, activeTurn: s.turnNo, desc: "舊技能封鎖入手" });
    s = feed(s, { type: "free", action: "event", uid: grab(s, 0, "HV-P04-083") });
    s = feed(s, { type: "effect-confirm", accept: true });
    s = feed(s, { type: "effect-cards", uids: [suga] });
    expect(s.players[0].toss).toEqual([kage, suga]);
    expect(effParam(db, s, suga, "toss")).toBe(3);
    conserved(s);
  });

  it("P04-037 禁止優先：即使效果登場也不得在接球區登場百沢", () => {
    let s = setup(deckWith("HV-P04-037", "HV-P04-033", "HV-P04-038"), deckWith(FILLER), 0);
    s.phase = "block"; s.sub = 0; s.op = { owner: 1, source: "attack", value: 6 };
    s.pendingDecision = { type: "deploy-block", player: 0 };
    const target = placeInDrop(s, 0, "HV-P04-033");
    const cost = grab(s, 0, "HV-P04-038");
    const source = grab(s, 0, "HV-P04-037");
    s = feed(s, { type: "deploy-block", uids: [source], center: source });
    s = feed(s, { type: "effect-confirm", accept: true });
    if (s.effectCtx?.awaiting?.kind === "cards" && s.effectCtx.awaiting.purpose === "dropHand") s = feed(s, { type: "effect-cards", uids: [cost] });
    s = feed(s, { type: "effect-cards", uids: [target] });
    expect(canDeployTo(db, s, 0, target, "receive", undefined, "effect")).toBe(false);
    conserved(s);
  });
});

// [Codex 2026-10-28] F1–F5 修正回歸：以公開決策及實際牌區結果驗證。
describe("P04 acceptance — 修正後張數與置底順序", () => {
  for (const id of ["HV-P04-039", "HV-P04-043", "HV-P04-045"]) {
    for (const count of [0, 1, 2, 3]) {
      it(`${id}：選${count}張只棄頂端連續卡，決策前無牌面資訊`, () => {
        const { s, first, second, third } = millState(id);
        const beforeDeck = [...s.players[0].deck];
        const beforeDrop = [...s.players[0].drop];
        expect(s.pendingDecision).toMatchObject({ type: "effect-option", player: 0, options: ["棄 0 張", "棄 1 張", "棄 2 張", "棄 3 張"] });
        expect(s.pendingDecision?.candidates).toBeUndefined();
        for (const index of [-1, 4, 1.5, NaN]) {
          expect(() => feed(s, { type: "effect-option", index })).toThrow();
        }
        const next = feed(s, { type: "effect-option", index: count });
        // 土湯棄到兩張以上事件後，卡文另要求抽1張。
        const extraDraw = id === "HV-P04-045" && count >= 2 ? 1 : 0;
        expect(next.players[0].deck).toEqual(beforeDeck.slice(count + extraDraw));
        if (extraDraw) expect(next.players[0].hand).toContain(beforeDeck[count]);
        expect(next.players[0].drop).toEqual([...beforeDrop, ...[first, second, third].slice(0, count)]);
        conserved(next);
      });
    }
  }

  for (const p of [0, 1] as const) for (const selfDraw of [false, true]) for (const oppDraw of [false, true]) {
    it(`PR-063 Q1953/Q1954：P${p} 自己${selfDraw}、對手${oppDraw}`, () => {
      let s = drawState(p, "HV-PR-063");
      const uid = grab(s, p, "HV-PR-063");
      const before = s.players.map((ps) => ps.hand.length);
      const opp = (1 - p) as PlayerId;
      s = feed(s, { type: "free", action: "event", uid });
      s = feed(s, { type: "effect-confirm", accept: true });
      expect(s.pendingDecision).toMatchObject({ type: "effect-confirm", player: p });
      s = feed(s, { type: "effect-confirm", accept: selfDraw });
      expect(s.pendingDecision).toMatchObject({ type: "effect-confirm", player: opp });
      s = feed(s, { type: "effect-confirm", accept: oppDraw });
      expect(s.players[p].hand.length).toBe(before[p]! - 1 + (selfDraw ? 2 : 0));
      expect(s.players[opp].hand.length).toBe(before[opp]! + (oppDraw ? 2 : 0));
      expect(s.pendingDecision).toMatchObject({ type: "free", player: p });
      conserved(s);
    });
  }

  function tutorState(ids: string[], short: boolean, blocked = false) {
    let s = setup(deckWith("HV-P04-085", ...ids), deckWith(FILLER), 1);
    s = serveWith(s, FILLER);
    s = feed(s, { type: "defense-choice", choice: "receive" });
    const event = grab(s, 0, "HV-P04-085");
    const top = ids.map((id) => placeDeckTop(s, 0, id)).reverse();
    if (short) s.players[0].drop.push(...s.players[0].deck.splice(top.length));
    const tail = s.players[0].deck.slice(top.length);
    if (blocked) s.restrictions.push({ player: 0, banHandAdd: true, setNo: s.setNo, activeTurn: s.turnNo, desc: "禁止效果入手" });
    s = feed(s, { type: "free", action: "event", uid: event });
    return { s, top, tail };
  }

  const nonAoba = ["HV-D01-001", "HV-D01-002", "HV-D01-003"];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    it(`P04-085 全不符：任意置底排列 ${order.join(",")}`, () => {
      let { s, top, tail } = tutorState(nonAoba, false);
      for (const index of order.slice(0, -1)) {
        expect(s.pendingDecision).toMatchObject({ type: "effect-cards", player: 0, min: 1, max: 1 });
        expect(() => feed(s, { type: "effect-cards", uids: [] })).toThrow();
        s = feed(s, { type: "effect-cards", uids: [top[index]!] });
        conserved(s);
      }
      expect(s.players[0].deck).toEqual([...tail, ...order.map((i) => top[i]!)]);
      expect(s.pendingDecision?.type).toBe("free");
    });
  }

  for (const count of [0, 1, 2, 3]) for (const pick of [false, true]) for (const blocked of [false, true]) {
    it(`P04-085 牌組剩${count}張／選卡${pick}／封入手${blocked}：處理剩餘卡排序並守恆`, () => {
      let { s, top } = tutorState(["HV-D04-001", "HV-D01-001", "HV-D01-002"].slice(0, count), true, blocked);
      const target = top.at(-1);
      const selected = count > 0 && pick && !blocked ? [target!] : [];
      if (count > 0 && !blocked) s = feed(s, { type: "effect-cards", uids: selected });
      const expected = top.filter((u) => !selected.includes(u)).reverse();
      for (const uid of expected.slice(0, -1)) {
        expect(s.pendingDecision?.player).toBe(0);
        s = feed(s, { type: "effect-cards", uids: [uid] });
        conserved(s);
      }
      expect(s.players[0].deck).toEqual(expected);
      if (target) expect(s.players[0].hand.includes(target)).toBe(selected.length > 0);
      expect(s.pendingDecision?.type).toBe("free");
      conserved(s);
    });
  }
});

// [Codex 2026-10-28] 短牌組：選項上限依實際剩餘張數；空牌組直接完成。
describe("P04 acceptance — 棄牌組頂不足3張", () => {
  for (const id of ["HV-P04-039", "HV-P04-043", "HV-P04-045"]) for (const size of [0, 1, 2]) {
    it(`${id} 剩${size}張：無越界選項、棄至空牌組仍守恆`, () => {
      let { s } = millState(id, size);
      if (size) {
        expect(s.pendingDecision).toMatchObject({ type: "effect-option", options: Array.from({ length: size + 1 }, (_, n) => `棄 ${n} 張`) });
        expect(() => feed(s, { type: "effect-option", index: size + 1 })).toThrow();
        s = feed(s, { type: "effect-option", index: size });
      }
      expect(s.players[0].deck).toEqual([]);
      expect(s.pendingDecision?.type).toBe("free");
      conserved(s);
    });
  }
});
