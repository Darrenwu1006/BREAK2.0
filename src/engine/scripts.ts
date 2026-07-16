// 特例腳本 registry＋keyword 編譯（拆分自 effects.ts）[Claude 2026-07-16]
// 責任：安全網 2 的 SCRIPTS（card.<卡號>.<skill序>）與 keyword→Action[] 展開；回傳 DSL Action 塞回解釋器，不直接改 state。
// 依賴方向：scripts → effect-helpers → (types, dsl)。

import type { Action } from "./dsl";
import type { CardDb, GameState, PlayerId } from "./types";
import { baseParam, cardOf, charaAreaOf, charasOf, effParam, effectDefOf, eventTimingsOf, log, maxDistinctAffiliations, nameOf, normName, other, topChara } from "./effect-helpers";

/** script 可讀的唯讀 context（含 db/state 與發生源資訊）。共用 effects.ts 匯出的查詢 helper（charasOf/nameOf/effParam…），不直接改 state。 */
export interface ScriptApi {
  db: CardDb;
  state: GameState;
  player: PlayerId;
  source: number;
  lastTarget: number | null;
  triggerUid: number | null;
}

/** 特例腳本：讀 ScriptApi → 回傳一串 DSL Action（塞回解釋器執行）。
 *  id 命名建議 `card.<卡號>.<skill序>`。可變物件，測試可注入。 */
export const SCRIPTS: Record<string, (api: ScriptApi) => Action[]> = {
  // P03-047 影山：イベントplay毎にトス+1、ただし「このキャラのスキルでトス4以上にならない」。
  // 現トスが ≤2 の時のみ +1（→ 最大3で頭打ち）。他カードの+はこの上限の対象外。
  "card.HV-P03-047": ({ db, state, source }) => {
    const cur = effParam(db, state, source, "toss") ?? 0;
    return cur <= 2 ? [{ op: "addParam", target: "self", param: "toss", amount: 1 }] : [];
  },
  // P03-039 宮侑：[=サーブ]でプレイできる稲荷崎カードを 2 枚ずつドロップ→サーブ+1（Q1498：4枚で+2＝可重複）。
  // 可作れるペア数ぶんの任意 gate を返す（各 gate：2枚ドロップ→+1）。
  "card.HV-P03-039": ({ db, state, player }) => {
    const valid = state.players[player].eventArea.filter(
      (u) => cardOf(db, state, u).affiliations.includes("稲荷崎") && eventTimingsOf(db, state, u).includes("serve"),
    );
    const pairs = Math.floor(valid.length / 2);
    return Array.from({ length: pairs }, () => ({
      op: "gate",
      costs: [{ type: "dropFromEventArea", count: 2, filter: { affiliation: "稲荷崎", playTimingAny: ["serve"] } }],
      then: [{ op: "addParam", target: "self", param: "serve", amount: 1 }],
    } as Action));
  },
  "card.HV-P01-066.condition": ({ db, state, player, source }) => {
    const allKamomedai = charasOf(state, player).length > 0
      && charasOf(state, player).every((c) => cardOf(db, state, c.uid).affiliations.includes("鴎台"));
    const fourAffiliations = maxDistinctAffiliations(charasOf(state, player).map((c) => cardOf(db, state, c.uid).affiliations)) >= 4;
    if (!allKamomedai && !fourAffiliations) return [];
    return [{
      op: "gate",
      costs: [{ type: "guts", count: 3 }],
      then: [
        { op: "addParam", target: "self", param: "attack", amount: 3 },
        { op: "moveOpponentEvent", count: 2, upTo: true, destination: "drop" },
        { op: "if", cond: [{ type: "eventAreaCount", player: "opponent", max: 2 }], then: [{ op: "addParam", target: "self", param: "attack", amount: 1 }] },
      ],
    }];
  },
  "card.HV-P02-004.covered-karasuno": ({ db, state, player, source }) => {
    const area = charaAreaOf(state, player, source);
    if (area === null || area === "block") return [];
    const stack = state.players[player][area];
    const i = stack.indexOf(source);
    const covered = i > 0 ? stack[i - 1] : undefined;
    if (covered === undefined || !cardOf(db, state, covered).affiliations.includes("烏野")) return [];
    return [{
      op: "opponentMayPlaceEvent",
      else: [{ op: "watch", trigger: { on: "handAdd", player: "opponent" }, duration: "nextOpponentTurn", actions: [{ op: "draw", count: 1 }] }],
    }];
  },
  "card.HV-P02-079.choose-guts-area": ({ state, player }) => {
    const areas = [...new Set(charasOf(state, player).map((c) => c.area))];
    if (!areas.length) return [];
    return [{
      op: "chooseOne",
      optional: true,
      options: areas.map((area) => ({
        label: `${area}區`,
        actions: [{ op: "handToGuts", area, filter: { affiliation: "烏野" }, upTo: 1 }],
      })),
    }];
  },
  // P03-099：抽1＋自分白鳥沢アタックキャラ+1；牛島なら相手イベント区キャラ全ドロップ、2枚以上で さらに+1。
  // n（相手イベント区キャラ数）を評価時に確定し、ドロップ枚数と追加+1を静的に組み立てる。
  "card.HV-P03-099": ({ db, state, player }) => {
    const n = state.players[other(player)].eventArea.filter((u) => cardOf(db, state, u).type === "CHARACTER").length;
    const ushijimaBranch: Action[] = [];
    if (n > 0) ushijimaBranch.push({ op: "moveOpponentEvent", filter: { cardType: "CHARACTER" }, count: n, destination: "drop" });
    if (n >= 2) ushijimaBranch.push({ op: "addParam", target: "target", param: "attack", amount: 1 });
    return [
      { op: "draw", count: 1 },
      { op: "addParam", target: { choose: true, player: "self", area: ["attack"], affiliation: "白鳥沢" }, param: "attack", amount: 1 },
      ...(ushijimaBranch.length ? [{ op: "if", cond: [{ type: "targetIs", filter: { names: ["牛島 若利"] } }], then: ushijimaBranch } as Action] : []),
    ];
  },
};

/** 展開關鍵字 †9 */
export function keywordActions(state: GameState, name: string, n: number): Action[] {
  switch (name) {
    case "ドシャット": // †9-2：ターン終了時、自分の OP は N になる
      return [{ op: "watch", trigger: { on: "turnEnd" }, duration: "thisTurn", actions: [{ op: "setOwnOp", value: n }] }];
    case "ワンタッチ": // †9-3：相手アタック OP −N、跳過ブロックフェイズ→自分のドローフェイズ
      return [{ op: "addOpponentOp", amount: -n }, { op: "skipToPhase", phase: "draw" }];
    case "フェイント": // †9-4：ターン終了時 OP=N＋次の相手ターン禁攔網登場
      return [
        {
          op: "watch",
          trigger: { on: "turnEnd" },
          duration: "thisTurn",
          actions: [{ op: "setOwnOp", value: n }, { op: "restrict", restriction: { area: "block", maxCount: 0 }, duration: "nextOpponentTurn" }],
        },
      ];
    case "ブロックアウト": // †9-5：次の相手ターン中、元々ブロックP≦N の攔網登場 → 相手 Lost
      return [
        {
          op: "watch",
          trigger: { on: "deploy", player: "opponent", area: ["block"], filter: { baseParamMax: { param: "block", value: n } } },
          duration: "nextOpponentTurn",
          actions: [{ op: "lostOpponent" }],
        },
      ];
    case "Aパス": // †9-7：このターン中、トスキャラ登場時トスP+N
      return [
        {
          op: "watch",
          trigger: { on: "deploy", player: "self", area: ["toss"] },
          duration: "thisTurn",
          actions: [{ op: "addParam", target: "trigger", param: "toss", amount: n }],
        },
      ];
    case "ツーアタック": // †9-8：アタック OP 算出＝N、跳過トスフェイズ→自分のエンドフェイズ、次の相手ターン禁攔網
      return [
        { op: "calcAttackOpAs", value: n },
        { op: "skipToPhase", phase: "end" },
        { op: "restrict", restriction: { area: "block", maxCount: 0 }, duration: "nextOpponentTurn" },
      ];
    case "バックアタック": // 後排攻擊：發生源をアタックエリアに登場させ、アタックポイントを N にする（P03-020/033）
      return [{ op: "backAttack", n }];
    default:
      log(state, null, `（未實裝關鍵字 ${name}）`);
      return [];
  }
}
