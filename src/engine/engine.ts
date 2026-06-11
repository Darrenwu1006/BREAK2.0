// 規則引擎核心（M2：香草卡整場流程；技能/效果系統於 M3 接入）
// 模式：runUntilDecision() 自動推進，需要玩家輸入時設 pendingDecision 停下；
//       applyDecision() 驗證並套用決策後繼續推進。所有函式不可變更傳入的 state 以外的東西。

import type { Card } from "../data/types";
import type { CardDb, Decision, GameState, PlayerId, PlayerState, Stack } from "./types";
import { nextRandom, shuffle } from "./rng";

// ---------- 工具 ----------

const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);

function card(db: CardDb, state: GameState, uid: number): Card {
  const c = db.get(state.cards[uid]!);
  if (!c) throw new Error(`unknown card uid=${uid}`);
  return c;
}

/** キャラ＝疊放區最上面那張 †1-2-14 */
const topChara = (stack: Stack): number | null => (stack.length ? stack[stack.length - 1]! : null);

function log(state: GameState, player: PlayerId | null, text: string): void {
  state.log.push({ setNo: state.setNo, turnNo: state.turnNo, player, text });
}

function removeFromHand(ps: PlayerState, uid: number): void {
  const i = ps.hand.indexOf(uid);
  if (i < 0) throw new Error(`uid ${uid} not in hand`);
  ps.hand.splice(i, 1);
}

/** 抽 N 張（牌組不足時抽到沒有為止 †0-2-5-5） */
function draw(state: GameState, p: PlayerId, n: number): number {
  const ps = state.players[p];
  let drawn = 0;
  while (drawn < n && ps.deck.length > 0) {
    ps.hand.push(ps.deck.shift()!);
    drawn++;
  }
  return drawn;
}

/** 對應區域的參數為「－」(null) 的卡不能登場 †1-3-2-2 */
function paramFor(c: Card, area: "serve" | "block" | "receive" | "toss" | "attack"): number | null {
  if (c.type !== "CHARACTER" || !c.params) return null;
  return c.params[area];
}

/** 可登場到指定區域的手牌 uid 清單 */
export function deployableUids(db: CardDb, state: GameState, p: PlayerId, area: "serve" | "block" | "receive" | "toss" | "attack"): number[] {
  const ps = state.players[p];
  let banned: string | null = null; // 同名禁止 †1-4-5-4-1
  if (area === "toss") {
    const r = topChara(ps.receive);
    banned = r !== null ? card(db, state, r).nameJa : null;
  } else if (area === "attack") {
    const t = topChara(ps.toss);
    banned = t !== null ? card(db, state, t).nameJa : null;
  }
  return ps.hand.filter((uid) => {
    const c = card(db, state, uid);
    if (paramFor(c, area) === null) return false;
    if (banned !== null && c.nameJa === banned) return false;
    return true;
  });
}

/**
 * 防守選擇限制（rules_sheet_v1：「※相手のサーブやブロックでの返球に対しては、『ブロック』は選べません」）
 * → 只有對手的 OP 來源是「アタック」時才能選擇攔網；發球與攔網回球只能接球。
 * 註：総合ルール v1.00~1.03 的 5-6-2② 未明文此限制，以官方快速規則書為準。
 */
export function canChooseBlock(state: GameState): boolean {
  return state.op !== null && state.op.owner !== state.turnPlayer && state.op.source === "attack";
}

// ---------- 建局 ----------

export interface CreateGameOptions {
  seed: number;
  decks: [string[], string[]]; // 各 40 個 cardId
  /** 跳過構築驗證（測試用） */
  skipDeckValidation?: boolean;
}

export function createGame(db: CardDb, opts: CreateGameOptions): GameState {
  for (const [i, deck] of opts.decks.entries()) {
    if (!opts.skipDeckValidation) {
      if (deck.length !== 40) throw new Error(`玩家${i} 牌組須正好 40 張（目前 ${deck.length}）`); // †4-1-2
      const events = deck.filter((id) => db.get(id)?.type === "EVENT").length;
      if (events > 8) throw new Error(`玩家${i} 事件卡超過 8 張（${events}）`);
    }
    for (const id of deck) if (!db.has(id)) throw new Error(`未知卡片 ${id}`);
  }

  const cards: Record<number, string> = {};
  let uid = 0;
  const mkPlayer = (deckIds: string[]): PlayerState => ({
    deck: deckIds.map((id) => ((cards[++uid] = id), uid)),
    hand: [], setArea: [], drop: [], eventArea: [],
    serve: [], blockCenter: [], blockSides: [], receive: [], toss: [], attack: [],
  });

  const state: GameState = {
    rngState: opts.seed >>> 0 || 1,
    cards,
    players: [mkPlayer(opts.decks[0]), mkPlayer(opts.decks[1])],
    setNo: 1, turnNo: 0,
    turnPlayer: 0, servingPlayer: 0,
    phase: "setup", sub: 0,
    op: null, dp: null,
    defenseChoice: null, lostBy: null,
    pendingDecision: null, winner: null,
    setupStage: "serve-rights",
    log: [],
  };

  // 遊戲前手順 †4-2：隨機選一人決定要不要首發球權
  const decider: PlayerId = nextRandom(state) < 0.5 ? 0 : 1;
  state.pendingDecision = { player: decider, type: "serve-rights" };
  log(state, decider, "決定是否擁有首次發球權");
  return state;
}

// ---------- 決策套用 ----------

export function applyDecision(db: CardDb, prev: GameState, decision: Decision): GameState {
  const state = structuredClone(prev) as GameState;
  const pending = state.pendingDecision;
  if (!pending) throw new Error("目前不需要決策");
  if (pending.type !== decision.type) throw new Error(`需要 ${pending.type}，收到 ${decision.type}`);
  const p = pending.player;
  state.pendingDecision = null;

  switch (decision.type) {
    case "serve-rights": {
      state.servingPlayer = decision.take ? p : other(p);
      state.turnPlayer = state.servingPlayer;
      log(state, state.servingPlayer, "擁有首次發球權");
      // 洗牌、各抽 6 †4-2-1-3/4
      for (const pid of [0, 1] as const) {
        shuffle(state, state.players[pid].deck);
        draw(state, pid, 6);
      }
      state.setupStage = "mulligan-first";
      state.pendingDecision = { player: state.servingPlayer, type: "mulligan" };
      break;
    }
    case "mulligan": {
      const ps = state.players[p];
      for (const uid of decision.returnUids) removeFromHand(ps, uid);
      if (decision.returnUids.length > 0) {
        ps.deck.push(...decision.returnUids);
        shuffle(state, ps.deck);
        draw(state, p, 6 - ps.hand.length);
        log(state, p, `換牌 ${decision.returnUids.length} 張`);
      }
      if (state.setupStage === "mulligan-first") {
        state.setupStage = "mulligan-second";
        state.pendingDecision = { player: other(p), type: "mulligan" };
      } else {
        // Set 卡配置 †4-2-1-5 → 發球階段開始
        for (const pid of [0, 1] as const) {
          const ps2 = state.players[pid];
          ps2.setArea.push(...ps2.deck.splice(0, 2));
        }
        state.setupStage = "done";
        enterPhase(state, "serve");
      }
      break;
    }
    case "deploy-serve": case "deploy-receive": case "deploy-toss": case "deploy-attack": {
      const area = decision.type.slice("deploy-".length) as "serve" | "receive" | "toss" | "attack";
      if (decision.uid === null) {
        log(state, p, `未登場角色（${area}）`);
        declareLost(state, p);
        break;
      }
      const legal = deployableUids(db, state, p, area);
      if (!legal.includes(decision.uid)) throw new Error(`uid ${decision.uid} 不能登場到 ${area}`);
      removeFromHand(state.players[p], decision.uid);
      state.players[p][area].push(decision.uid); // 疊放，原キャラ成為ガッツ †8-3
      log(state, p, `登場 ${card(db, state, decision.uid).nameJa} → ${area}`);
      state.sub++;
      break;
    }
    case "deploy-block": {
      if (decision.uids === null) {
        log(state, p, "未登場角色（block）");
        declareLost(state, p);
        break;
      }
      const { uids, center } = decision;
      if (uids.length < 1 || uids.length > 3) throw new Error("攔網登場須 1~3 張");
      if (!uids.includes(center)) throw new Error("center 必須是登場卡之一");
      const names = uids.map((u) => card(db, state, u).nameJa);
      if (new Set(names).size !== names.length) throw new Error("攔網不可登場同名卡 ×2"); // †1-4-5-4-1
      const legal = deployableUids(db, state, p, "block");
      for (const u of uids) if (!legal.includes(u)) throw new Error(`uid ${u} 不能登場到 block`);
      const ps = state.players[p];
      for (const u of uids) removeFromHand(ps, u);
      ps.blockCenter.push(center);
      ps.blockSides.push(...uids.filter((u) => u !== center));
      log(state, p, `攔網登場 ${names.join("、")}（中央=${card(db, state, center).nameJa}）`);
      state.sub++;
      break;
    }
    case "defense-choice": {
      if (decision.choice === "block" && !canChooseBlock(state)) {
        throw new Error("對手的發球或攔網回球不能選擇攔網（rules_sheet：ブロックは選べません）");
      }
      state.defenseChoice = decision.choice;
      log(state, p, decision.choice === "block" ? "選擇攔網" : "選擇接球");
      state.sub++;
      break;
    }
    case "free": {
      if (decision.action === "lost") {
        log(state, p, "主動宣告 Lost");
        declareLost(state, p);
      } else {
        state.sub++; // pass → 結束自由步驟
      }
      break;
    }
    case "pick-set-card": {
      const ps = state.players[p];
      if (decision.index < 0 || decision.index >= ps.setArea.length) throw new Error("無效的 Set 卡索引");
      const uidTaken = ps.setArea.splice(decision.index, 1)[0]!;
      ps.hand.push(uidTaken);
      log(state, p, "從 Set 區拿 1 張卡加入手牌");
      state.sub++;
      break;
    }
  }

  runUntilDecision(db, state);
  return state;
}

// ---------- Lost / 勝負 ----------

function declareLost(state: GameState, p: PlayerId): void {
  state.lostBy = p;
  log(state, p, `宣告 Lost（Set ${state.setNo}）`);
  // 敗北判定 †0-1-3-1-1：Set 區 0 張時宣告 Lost → 立即敗北
  if (state.players[p].setArea.length === 0) {
    state.winner = other(p);
    state.phase = "gameOver";
    log(state, other(p), "獲勝！");
    return;
  }
  enterPhase(state, "lostSet");
}

// ---------- Phase 推進 ----------

function enterPhase(state: GameState, phase: GameState["phase"]): void {
  state.phase = phase;
  state.sub = 0;
}

/** OP 算出 †5-17（M2 無修正效果） */
function calcOp(db: CardDb, state: GameState): void {
  const p = state.turnPlayer;
  const ps = state.players[p];
  let value = 0;
  let source: "serve" | "block" | "attack";
  if (state.phase === "serve") {
    source = "serve";
    const u = topChara(ps.serve);
    value = u !== null ? (paramFor(card(db, state, u), "serve") ?? 0) : 0;
  } else if (state.phase === "block") {
    source = "block";
    value = 0; // †5-17-4
  } else {
    source = "attack";
    const t = topChara(ps.toss);
    const a = topChara(ps.attack);
    value = (t !== null ? (paramFor(card(db, state, t), "toss") ?? 0) : 0) + (a !== null ? (paramFor(card(db, state, a), "attack") ?? 0) : 0);
  }
  state.op = { value, owner: p, source };
  log(state, p, `OP 算出 = ${value}`);
}

/** DP 算出 †5-18 */
function calcDp(db: CardDb, state: GameState): void {
  const p = state.turnPlayer;
  const ps = state.players[p];
  let value = 0;
  if (state.phase === "block") {
    const blockers = [...ps.blockSides, ...(topChara(ps.blockCenter) !== null ? [topChara(ps.blockCenter)!] : [])];
    for (const u of blockers) value += paramFor(card(db, state, u), "block") ?? 0;
    state.dp = { value, owner: p, source: "block" };
  } else {
    const u = topChara(ps.receive);
    value = u !== null ? (paramFor(card(db, state, u), "receive") ?? 0) : 0;
    state.dp = { value, owner: p, source: "receive" };
  }
  log(state, p, `DP 算出 = ${value}`);
}

/** ジャッジ †5-15：DP < 對手 OP → 失敗 → Lost */
function judge(state: GameState): boolean {
  const op = state.op;
  const dp = state.dp;
  const opValue = op && op.owner !== state.turnPlayer ? op.value : 0;
  const success = (dp?.value ?? 0) >= opValue;
  log(state, state.turnPlayer, `判定：DP ${dp?.value ?? 0} vs OP ${opValue} → ${success ? "成功" : "失敗"}`);
  // ③ OP/DP 消滅
  state.op = null;
  state.dp = null;
  return success;
}

/**
 * 推進遊戲直到需要玩家決策或遊戲結束。
 * 每個 phase 是一串子步驟（state.sub 為游標）；需要輸入的子步驟設定 pendingDecision 後 return。
 * チェックプロセス †5-4 在 M2 為 no-op（無被動技能），M3 在各邊界接入。
 */
function runUntilDecision(db: CardDb, state: GameState): void {
  for (let guard = 0; guard < 10000; guard++) {
    if (state.pendingDecision || state.phase === "gameOver" || state.phase === "setup") return;
    const tp = state.turnPlayer;

    switch (state.phase) {
      case "serve": // †5-5
        if (state.sub === 0) { state.turnNo++; log(state, tp, `── Set ${state.setNo}・發球回合 ──`); state.sub++; }
        else if (state.sub === 1) { state.pendingDecision = { player: tp, type: "deploy-serve" }; return; }
        else if (state.sub === 2) { state.pendingDecision = { player: tp, type: "free" }; return; }
        else if (state.sub === 3) { calcOp(db, state); state.sub++; }
        else enterPhase(state, "end");
        break;

      case "start": // †5-6
        if (state.sub === 0) { state.turnNo++; log(state, tp, `── Turn ${state.turnNo} ──`); state.sub++; }
        else if (state.sub === 1) { state.pendingDecision = { player: tp, type: "defense-choice" }; return; }
        else enterPhase(state, state.defenseChoice === "block" ? "block" : "draw");
        break;

      case "block": // †5-7
        if (state.sub === 0) { state.pendingDecision = { player: tp, type: "deploy-block" }; return; }
        else if (state.sub === 1) { state.pendingDecision = { player: tp, type: "free" }; return; }
        else if (state.sub === 2) { calcDp(db, state); state.sub++; }
        else if (state.sub === 3) { if (!judge(state)) { declareLost(state, tp); } else state.sub++; }
        else if (state.sub === 4) { calcOp(db, state); state.sub++; }
        else {
          // フェイズ終了：サイドブロッカー → 棄牌區 †5-7-2⑦
          const ps = state.players[tp];
          ps.drop.push(...ps.blockSides);
          ps.blockSides = [];
          enterPhase(state, "end");
        }
        break;

      case "draw": // †5-8
        if (state.sub === 0) { const n = draw(state, tp, 1); log(state, tp, n ? "接球抽牌 +1" : "牌組已空，無法抽牌"); state.sub++; }
        else if (state.sub === 1) { state.pendingDecision = { player: tp, type: "free" }; return; }
        else enterPhase(state, "receive");
        break;

      case "receive": // †5-9
        if (state.sub === 0) { state.pendingDecision = { player: tp, type: "deploy-receive" }; return; }
        else if (state.sub === 1) { state.pendingDecision = { player: tp, type: "free" }; return; }
        else if (state.sub === 2) { calcDp(db, state); state.sub++; }
        else if (state.sub === 3) { if (!judge(state)) { declareLost(state, tp); } else state.sub++; }
        else enterPhase(state, "toss");
        break;

      case "toss": // †5-10
        if (state.sub === 0) { state.pendingDecision = { player: tp, type: "deploy-toss" }; return; }
        else if (state.sub === 1) { state.pendingDecision = { player: tp, type: "free" }; return; }
        else enterPhase(state, "attack");
        break;

      case "attack": // †5-11
        if (state.sub === 0) { state.pendingDecision = { player: tp, type: "deploy-attack" }; return; }
        else if (state.sub === 1) { state.pendingDecision = { player: tp, type: "free" }; return; }
        else if (state.sub === 2) { calcOp(db, state); state.sub++; }
        else enterPhase(state, "end");
        break;

      case "end": // †5-12（M2 無「ターン終了時」技能；清理步驟無持續效果可清）
        state.defenseChoice = null;
        state.turnPlayer = other(tp);
        enterPhase(state, "start");
        break;

      case "lostSet": // †5-20
        // ① OP/DP 消滅 → （②③④ 技能/效果相關，M2 no-op）→ ⑤ 進インターバル
        state.op = null;
        state.dp = null;
        enterPhase(state, "interval");
        break;

      case "interval": { // †5-3
        const loser = state.lostBy!;
        if (state.sub === 0) {
          // ② 雙方補滿手牌到 6（turn player 先 †0-2-7）
          for (const pid of [state.turnPlayer, other(state.turnPlayer)]) {
            const need = 6 - state.players[pid].hand.length;
            if (need > 0) draw(state, pid, need);
          }
          state.sub++;
        } else if (state.sub === 1) {
          // ③ Lost 方從 Set 區拿 1 張
          state.pendingDecision = { player: loser, type: "pick-set-card" };
          return;
        } else {
          // ⑥ 非 Lost 方取得發球權 → 下一 Set
          state.servingPlayer = other(loser);
          state.turnPlayer = state.servingPlayer;
          state.setNo++;
          state.turnNo = 0;
          state.lostBy = null;
          log(state, state.servingPlayer, `取得 Set ${state.setNo} 發球權`);
          enterPhase(state, "serve");
        }
        break;
      }
    }
  }
  throw new Error("引擎推進超過上限（疑似無限迴圈）");
}
