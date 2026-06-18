// 規則引擎核心（M2 香草流程＋M3 效果系統）
// 模式：runUntilDecision() 自動推進，需要玩家輸入時設 pendingDecision 停下；
//       applyDecision() 驗證並套用決策後繼續推進。所有函式不可變更傳入的 state 以外的東西。
// M3：效果解決（effectCtx）與チェックプロセス待機佇列（pendingQueue）在主迴圈頭部優先處理，
//     等價於「所有 phase/step 邊界跑 CP」（†5-4：佇列只在邊界/事象發生時被填入）。

import type { Card } from "../data/types";
import type { CourtArea } from "./dsl";
import type { CardDb, Decision, GameState, PlayerId, PlayerState } from "./types";
import { nextRandom, shuffle } from "./rng";
import {
  applyEffectDecision,
  centerBlockNegated,
  blockDeployMax,
  canDeployTo,
  cardOf,
  charasOf,
  cleanupTurn,
  clearSetScoped,
  deployCard,
  deployNames,
  drawCards,
  effParam,
  enqueueTurnEnd,
  freeOptions,
  log,
  nameOf,
  normName,
  onBlockSuccess,
  onLostDeclared,
  other,
  pendingDecisionForAwaiting,
  playEvent,
  processQueue,
  removeFromHand,
  startPendingItem,
  stepEffect,
  topChara,
  useSkill,
} from "./effects";

export { freeOptions, blockDeployMax, deployNames, charasOf, effParam, nameOf } from "./effects";

// ---------- 工具 ----------

/** 可登場到指定區域的手牌 uid 清單（參數「－」†1-3-2-2、同名禁止 †1-4-5-4-1、登場限制） */
export function deployableUids(db: CardDb, state: GameState, p: PlayerId, area: CourtArea): number[] {
  if (area === "block" && blockDeployMax(state, p) === 0) return [];
  return state.players[p].hand.filter((uid) => canDeployTo(db, state, p, uid, area));
}

/**
 * 防守選擇限制（rules_sheet_v1：「※相手のサーブやブロックでの返球に対しては、『ブロック』は選べません」）
 * → 只有對手的 OP 來源是「アタック」時才能選擇攔網；發球與攔網回球只能接球。
 * 註：総合ルール v1.00~1.03 的 5-6-2② 未明文此限制，以官方快速規則書為準。
 */
export function canChooseBlock(state: GameState): boolean {
  return state.op !== null && state.op.owner !== state.turnPlayer && state.op.source === "attack";
}

/** 驗證 072/073 型卡的登場選名（一般卡不可帶 nameChoice） */
function validateNameChoice(db: CardDb, state: GameState, uid: number, nameChoice: string | undefined): void {
  const names = deployNames(db, state, uid);
  if (names) {
    if (nameChoice === undefined) throw new Error(`${cardOf(db, state, uid).nameJa} 登場時必須選擇卡名`);
    if (!names.map(normName).includes(normName(nameChoice))) throw new Error(`無效的卡名選擇 ${nameChoice}`);
  } else if (nameChoice !== undefined) {
    throw new Error("該卡登場不可選擇卡名");
  }
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
    judgeSuccess: null,
    defenseChoice: null, lostBy: null,
    pendingDecision: null, winner: null,
    setupStage: "serve-rights",
    modifiers: [],
    nameOverrides: {},
    watchers: [],
    restrictions: [],
    pendingQueue: [],
    turn1: [],
    effectCtx: null,
    lostRequest: null,
    blockDeployedThisTurn: [0, 0],
    blockHandDeploysThisTurn: [0, 0],
    nextId: 1,
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
        drawCards(state, pid, 6);
      }
      state.setupStage = "mulligan-first";
      state.pendingDecision = { player: state.servingPlayer, type: "mulligan" };
      break;
    }
    case "mulligan": {
      const ps = state.players[p];
      for (const uid of decision.returnUids) removeFromHand(state, p, uid);
      if (decision.returnUids.length > 0) {
        ps.deck.push(...decision.returnUids);
        shuffle(state, ps.deck);
        drawCards(state, p, 6 - ps.hand.length);
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
      const area = decision.type.slice("deploy-".length) as Exclude<CourtArea, "block">;
      if (decision.uid === null) {
        log(state, p, `未登場角色（${area}）`);
        declareLost(state, p);
        break;
      }
      const legal = deployableUids(db, state, p, area);
      if (!legal.includes(decision.uid)) throw new Error(`uid ${decision.uid} 不能登場到 ${area}`);
      validateNameChoice(db, state, decision.uid, decision.nameChoice);
      if (decision.nameChoice !== undefined && !canDeployTo(db, state, p, decision.uid, area, decision.nameChoice)) {
        throw new Error(`以「${decision.nameChoice}」之名不能登場到 ${area}`); // Q279
      }
      removeFromHand(state, p, decision.uid);
      deployCard(db, state, p, decision.uid, area, { origin: "hand", nameChoice: decision.nameChoice }); // 疊放 †8-3＋觸發
      log(state, p, `登場 ${nameOf(db, state, decision.uid)} → ${area}`);
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
      const maxN = blockDeployMax(state, p);
      if (uids.length < 1 || uids.length > 3) throw new Error("攔網登場須 1~3 張");
      if (uids.length > maxN) throw new Error(`登場限制：本回合攔網最多登場 ${maxN} 張`);
      if (!uids.includes(center)) throw new Error("center 必須是登場卡之一");
      const choices = decision.nameChoices ?? {};
      for (const u of uids) validateNameChoice(db, state, u, choices[u]);
      // 同名禁止（以選定名比對）†1-4-5-4-1
      const names = uids.map((u) => normName(choices[u] ?? cardOf(db, state, u).nameJa));
      if (new Set(names).size !== names.length) throw new Error("攔網不可登場同名卡 ×2");
      const legal = deployableUids(db, state, p, "block");
      for (const u of uids) if (!legal.includes(u)) throw new Error(`uid ${u} 不能登場到 block`);
      const ps = state.players[p];
      for (const u of uids) removeFromHand(state, p, u);
      deployCard(db, state, p, center, "block", { origin: "hand", nameChoice: choices[center] });
      for (const u of uids) if (u !== center) deployCard(db, state, p, u, "block", { origin: "hand", nameChoice: choices[u], blockSide: true });
      log(state, p, `攔網登場 ${names.join("、")}（中央=${nameOf(db, state, center)}）`);
      void ps;
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
        declareLost(state, p); // 佇列為空才會出現 free 決策 → †1-4-9-2 自動滿足
      } else if (decision.action === "pass") {
        state.sub++; // 結束自由步驟
      } else if (decision.action === "skill") {
        useSkill(db, state, decision.uid, decision.skillIndex); // 解決後回到自由步驟（sub 不變）†5-14
      } else {
        playEvent(db, state, decision.uid);
      }
      break;
    }
    case "resolve-pending": {
      if (!pending.candidates?.includes(decision.id)) throw new Error("無效的待機項目選擇");
      startPendingItem(db, state, decision.id);
      break;
    }
    case "effect-confirm": case "effect-cards": case "effect-option": {
      applyEffectDecision(db, state, decision as unknown as { type: string });
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
  const winner = other(p);
  // 敗北判定 †0-1-3-1-1：Set 區 0 張時宣告 Lost → 立即敗北
  if (state.players[p].setArea.length === 0) {
    log(state, p, `宣告 Lost（Set ${state.setNo}）`);
    state.winner = winner;
    state.phase = "gameOver";
    log(state, winner, "獲勝！", { kind: "match-won", winner, loser: p, setNo: state.setNo });
    return;
  }
  log(state, p, `宣告 Lost（Set ${state.setNo}）`, {
    kind: "set-won",
    winner,
    loser: p,
    setNo: state.setNo,
    loserSetRemaining: state.players[p].setArea.length - 1,
  });
  enterPhase(state, "lostSet");
}

// ---------- Phase 推進 ----------

function enterPhase(state: GameState, phase: GameState["phase"]): void {
  state.phase = phase;
  state.sub = 0;
}

/** OP 算出 †5-17（修正後參數 †6-10-1） */
function calcOp(db: CardDb, state: GameState): void {
  const p = state.turnPlayer;
  const ps = state.players[p];
  let value = 0;
  let source: "serve" | "block" | "attack";
  if (state.phase === "serve") {
    source = "serve";
    const u = topChara(ps.serve);
    value = u !== null ? (effParam(db, state, u, "serve") ?? 0) : 0;
  } else if (state.phase === "block") {
    source = "block";
    value = 0; // †5-17-4
  } else {
    source = "attack";
    const t = topChara(ps.toss);
    const a = topChara(ps.attack);
    value = (t !== null ? (effParam(db, state, t, "toss") ?? 0) : 0) + (a !== null ? (effParam(db, state, a, "attack") ?? 0) : 0);
  }
  state.op = { value, owner: p, source };
  log(state, p, `OP 算出 = ${value}`, source === "attack" ? { kind: "attack-op", player: p, value } : { kind: "op-calc", player: p, source, value });
}

/** DP 算出 †5-18 */
function calcDp(db: CardDb, state: GameState): void {
  const p = state.turnPlayer;
  const ps = state.players[p];
  let value = 0;
  if (state.phase === "block") {
    const blockers = [...ps.blockSides, ...(topChara(ps.blockCenter) !== null ? [topChara(ps.blockCenter)!] : [])];
    for (const u of blockers) {
      if (centerBlockNegated(state, p, u)) continue; // ブロックP無いものとして扱う（Q372）
      value += effParam(db, state, u, "block") ?? 0;
    }
    state.dp = { value, owner: p, source: "block" };
  } else {
    const u = topChara(ps.receive);
    value = u !== null ? (effParam(db, state, u, "receive") ?? 0) : 0;
    state.dp = { value, owner: p, source: "receive" };
  }
  log(state, p, `DP 算出 = ${value}`);
}

/** ジャッジ①：比較（†5-15；消滅與 Lost 在後續子步驟，期間跑 CP） */
function judgeCompare(state: GameState): void {
  const op = state.op;
  const dp = state.dp;
  const opValue = op && op.owner !== state.turnPlayer ? op.value : 0;
  state.judgeSuccess = (dp?.value ?? 0) >= opValue;
  // 效果追加的失敗條件（任一成立即失敗 †5-15-3；P02-039「DP6以下→ブロック失敗」Q393）
  if (state.judgeSuccess && state.phase === "block") {
    for (const r of state.restrictions) {
      if (r.player !== state.turnPlayer || r.blockFailIfDpMax === undefined) continue;
      if (r.setNo !== state.setNo || r.activeTurn !== state.turnNo) continue;
      if ((dp?.value ?? 0) <= r.blockFailIfDpMax) {
        state.judgeSuccess = false;
        log(state, state.turnPlayer, `效果：DP ≤ ${r.blockFailIfDpMax} → 攔網失敗（†5-15-3）`);
      }
    }
  }
  log(state, state.turnPlayer, `判定：DP ${dp?.value ?? 0} vs OP ${opValue} → ${state.judgeSuccess ? "成功" : "失敗"}`);
}

/**
 * 推進遊戲直到需要玩家決策或遊戲結束。
 * 每個 phase 是一串子步驟（state.sub 為游標）；需要輸入的子步驟設定 pendingDecision 後 return。
 * 迴圈頭部優先處理：lostRequest → 效果解決（effectCtx）→ 待機佇列（CP †5-4）→ phase 推進。
 */
function runUntilDecision(db: CardDb, state: GameState): void {
  for (let guard = 0; guard < 100000; guard++) {
    if (state.pendingDecision || state.phase === "gameOver" || state.phase === "setup") return;

    // 效果要求的 Lost（ブロックアウト †9-5）
    if (state.lostRequest !== null) {
      const lp = state.lostRequest;
      state.lostRequest = null;
      declareLost(state, lp);
      continue;
    }
    // 效果解決中
    if (state.effectCtx) {
      stepEffect(db, state);
      if (state.effectCtx?.awaiting) {
        pendingDecisionForAwaiting(state);
        return;
      }
      continue;
    }
    // チェックプロセス †5-4
    if (state.pendingQueue.length > 0) {
      const r = processQueue(db, state);
      if (r === "decision") return;
      continue;
    }

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
        else if (state.sub === 3) { judgeCompare(state); if (state.judgeSuccess) onBlockSuccess(db, state); state.sub++; } // ②CP 由迴圈頭處理
        else if (state.sub === 4) {
          state.op = null; state.dp = null; // ③消滅
          if (!state.judgeSuccess) { state.judgeSuccess = null; declareLost(state, tp); } else { state.judgeSuccess = null; state.sub++; }
        }
        else if (state.sub === 5) { calcOp(db, state); state.sub++; }
        else {
          // フェイズ終了：サイドブロッカー → 棄牌區 †5-7-2⑦
          const ps = state.players[tp];
          ps.drop.push(...ps.blockSides);
          ps.blockSides = [];
          enterPhase(state, "end");
        }
        break;

      case "draw": // †5-8
        if (state.sub === 0) { const n = drawCards(state, tp, 1); log(state, tp, n ? "接球抽牌 +1" : "牌組已空，無法抽牌"); state.sub++; }
        else if (state.sub === 1) { state.pendingDecision = { player: tp, type: "free" }; return; }
        else enterPhase(state, "receive");
        break;

      case "receive": // †5-9
        if (state.sub === 0) { state.pendingDecision = { player: tp, type: "deploy-receive" }; return; }
        else if (state.sub === 1) { state.pendingDecision = { player: tp, type: "free" }; return; }
        else if (state.sub === 2) { calcDp(db, state); state.sub++; }
        else if (state.sub === 3) { judgeCompare(state); state.sub++; }
        else if (state.sub === 4) {
          state.op = null; state.dp = null;
          if (!state.judgeSuccess) { state.judgeSuccess = null; declareLost(state, tp); } else { state.judgeSuccess = null; state.sub++; }
        }
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

      case "end": // †5-12
        if (state.sub === 0) {
          // ①「ターン終了時」待機（每 turn 至多一次；新增者由迴圈頭 CP 解決後回到本 sub 再確認 †5-12-2①）
          if (enqueueTurnEnd(state) > 0) break;
          state.sub++;
        } else {
          // ②クリンナップ †5-19 → ③turn 交替
          cleanupTurn(state);
          state.defenseChoice = null;
          state.turnPlayer = other(tp);
          enterPhase(state, "start");
        }
        break;

      case "lostSet": // †5-20
        if (state.sub === 0) {
          // ①OP/DP 消滅 → turn 即時終了（「ターン中」限制失效 Q324）→ ②「ロスト時」監看待機（CP 由迴圈頭解決）
          state.op = null;
          state.dp = null;
          onLostDeclared(db, state, state.lostBy!);
          state.sub++;
        } else {
          // ③④ Set 中效果/待機消滅 → ⑤インターバル
          clearSetScoped(state);
          enterPhase(state, "interval");
        }
        break;

      case "interval": { // †5-3
        const loser = state.lostBy!;
        if (state.sub === 0) {
          // ② 雙方補滿手牌到 6（turn player 先 †0-2-7）
          for (const pid of [state.turnPlayer, other(state.turnPlayer)]) {
            const need = 6 - state.players[pid].hand.length;
            if (need > 0) drawCards(state, pid, need);
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

/** 測試輔助：取得卡片（保留 M2 介面） */
export function card(db: CardDb, state: GameState, uid: number): Card {
  return cardOf(db, state, uid);
}
