// M9a CP4 擺位計算：GameState → 每張卡的 3D 目標位置／朝向（純函式、無 React）。
// 從 CP3 BoardScene 抽出，成為動畫系統的「目標表」：
//   - 靜態盤面＝直接渲染 computePlacements(displayed)
//   - 批次演出中＝displayed 的擺位為底，已演完 card-moved 的 uid 改取批次 after 的擺位（mergePlacements）
// AnimatedCard 對「目標改變」做緩動位移，本檔只管目標在哪。

import type { Card } from "../../data/types";
import { effParam } from "../../engine/engine";
import type { CardDb, GameState, PlayerId } from "../../engine/types";
import { cardBackUrl, cardFrontUrl } from "../assets";
import type { ZoneId } from "../presentation/events";
import { ZONE_LABEL } from "../presentation/textRenderer";
import type { CardValueFormula } from "../presentation/valueFormula";
import { blockSideAnchor, CARD_T, CARD_W, setAreaAnchor, zoneAnchor } from "./layout";

const STACK_ZONES = ["serve", "blockCenter", "receive", "toss", "attack"] as const;

export interface CardPlacement {
  uid: number;
  frontUrl: string | null;
  backUrl: string;
  faceUp: boolean;
  position: [number, number, number];
  rotation: [number, number, number];
  zone: ZoneId;
  player: PlayerId;
  /** 場上角色在目前區域對判定的實際貢獻值；只掛在最上層角色。 */
  effectiveValue?: number | null;
  baseValue?: number | null;
  /** 3D 閱讀框中的來源群組標籤；一般盤面卡沒有。 */
  readingGroup?: string;
  /** hover 拉出的安全位移（沿卡面內方向——與相鄰卡保持平行平面，幾何上不可能相交）。
   *  沒給的卡用 AnimatedCard 的預設世界座標抬升（平放卡安全）。 */
  hoverOffset?: [number, number, number];
  /** highlighted（可拖曳提示）的安全位移，語意同上 */
  highlightOffset?: [number, number, number];
}

/** effect-cards 選牌面的來源分區底盤。卡片仍是 3D mesh；底盤負責把來源區變成
 * 真正的 layout unit，而不是只在全域格狀中的第一張卡旁補一顆標籤。 */
export interface ReadingPanelPlacement {
  key: string;
  label: string;
  detail: string;
  position: [number, number, number];
  width: number;
  depth: number;
}

export interface PilePlacement {
  key: string;
  count: number;
  topUrl: string | null;
  position: [number, number, number];
  rotY: number;
}

export interface BoardPlacements {
  cards: Map<number, CardPlacement>;
  piles: PilePlacement[];
  readingPanels?: ReadingPanelPlacement[];
}

/** 每 uid 一點固定微旋（弧度），給「人手擺的」物性 */
export const jitter = (uid: number): number => (((uid * 37) % 7) - 3) * 0.006;

// ---- P0 手牌扇幾何常數（placements.test 以同組常數驗證「不破圖」不變量） ----
/** 手托傾角（繞 x 軸） */
export const HAND_TILT = 0.72;
export const HAND_SIN = Math.sin(HAND_TILT);
export const HAND_COS = Math.cos(HAND_TILT);
/** 固定可用寬度：滿手時卡牌填滿此範圍（越多越密） */
export const HAND_SPAN = 4.6;
/** 少牌時的單張間距上限（避免 2~3 張時攤太開） */
export const HAND_MAX_STEP = 0.72;
/** 中央弧高（沿卡面內方向，不影響疊序） */
export const HAND_ARC = 0.2;
/** 相鄰卡沿卡面法線的間距：rotY=0 後手牌是嚴格平行平面族，只需 > 卡厚（rotZ 是面內滾轉不出面） */
export const HAND_STACK = 0.028;
// [使用者 2026-07-11] 手牌改「左右並排、不堆疊、不扇形」：每張卡同高同深、rotZ=0，
// 相鄰卡以 gap 隔開（越多越密、越少越鬆），gap 有下限＝不重疊也不相黏。
/** 少牌時的相鄰間隙上限（世界單位） */
export const HAND_GAP_MAX = 0.34;
/** 滿手時的相鄰間隙下限（≈0.5px；只求剛好不相黏、不重疊） */
export const HAND_GAP_MIN = 0.012;
/** 每多一張手牌，間隙收縮量 */
export const HAND_GAP_SHRINK = 0.05;
/** hover 拉出距離：沿卡面「上」方向 û 滑出（平面內移動，與鄰卡平行性不變） */
export const HAND_HOVER_SLIDE = 0.66;
/** highlighted（可拖曳提示）微升距離：同樣沿 û */
export const HAND_HIGHLIGHT_SLIDE = 0.16;

const lift = (level: number): number => CARD_T / 2 + level * CARD_T * 1.15;

function cardOf(db: CardDb, state: GameState, uid: number): Card | undefined {
  return db.get(state.cards[uid]!);
}

export function computePlacements(
  db: CardDb,
  state: GameState,
  schools: [string | undefined, string | undefined],
  valueFormulas: ReadonlyMap<number, CardValueFormula> = new Map(),
  handValue?: { player: PlayerId; param: "serve" | "block" | "receive" | "toss" | "attack"; uids: ReadonlySet<number> },
  printingByUid: ReadonlyMap<number, string> = new Map(),
): BoardPlacements {
  const cards = new Map<number, CardPlacement>();
  const piles: PilePlacement[] = [];

  for (const player of [0, 1] as const) {
    const ps = state.players[player];
    const rotY = player === 0 ? 0 : Math.PI;
    const back = cardBackUrl(schools[player]);
    const front = (uid: number): string | null => {
      const card = cardOf(db, state, uid);
      return card ? cardFrontUrl(card, printingByUid.get(uid)) : null;
    };

    // 疊放區：直上疊、不外露（卡堆不超出格子——[使用者 2026-07-10]）；
    // ガッツ張數以徽章顯示、點擊可展開檢視（BoardScene/UiLabApp）
    for (const zone of STACK_ZONES) {
      const stack = ps[zone];
      const anchor = zoneAnchor(player, zone === "blockCenter" ? "blockCenter" : zone);
      stack.forEach((uid, depth) => {
        const param = zone === "blockCenter" ? "block" : zone;
        const top = depth === stack.length - 1;
        const card = cardOf(db, state, uid);
        const formula = valueFormulas.get(uid);
        cards.set(uid, {
          uid,
          frontUrl: front(uid),
          backUrl: back,
          faceUp: true,
          position: [anchor.x, lift(depth), anchor.z],
          rotation: [0, jitter(uid), 0],
          zone,
          player,
          ...(top ? {
            effectiveValue: formula?.total ?? effParam(db, state, uid, param),
            baseValue: formula?.base ?? card?.params?.[param] ?? null,
          } : {}),
        });
      });
    }
    // サイドブロッカー（不疊放、最多 2）
    ps.blockSides.forEach((uid, i) => {
      const anchor = blockSideAnchor(player, i);
      const card = cardOf(db, state, uid);
      const formula = valueFormulas.get(uid);
      cards.set(uid, {
        uid,
        frontUrl: front(uid),
        backUrl: back,
        faceUp: true,
        position: [anchor.x, lift(0), anchor.z],
        rotation: [0, jitter(uid), 0],
        zone: "blockSide",
        player,
        effectiveValue: formula?.total ?? effParam(db, state, uid, "block"),
        baseValue: formula?.base ?? card?.params?.block ?? null,
      });
    });
    // Set 區：平時同一格緊密錯位疊放；只有輪到該玩家 pick-set-card 時展開。
    const setExpanded = state.pendingDecision?.type === "pick-set-card" && state.pendingDecision.player === player;
    ps.setArea.forEach((uid, i) => {
      const anchor = setAreaAnchor(player, i, setExpanded);
      cards.set(uid, {
        uid,
        frontUrl: null,
        backUrl: back,
        faceUp: false,
        position: [anchor.x, lift(setExpanded ? 0 : i), anchor.z],
        rotation: [0, rotY + jitter(uid), 0],
        zone: "setArea",
        player,
      });
    });
    // 牌組＝厚度疊（卡背朝上）；棄牌／事件區＝疊＋頂張正面
    const deckA = zoneAnchor(player, "deck");
    piles.push({ key: `deck${player}`, count: ps.deck.length, topUrl: back, position: [deckA.x, 0, deckA.z], rotY });
    const dropA = zoneAnchor(player, "drop");
    if (ps.drop.length > 1) piles.push({ key: `drop${player}`, count: ps.drop.length - 1, topUrl: null, position: [dropA.x, 0, dropA.z], rotY });
    const dropTop = ps.drop[ps.drop.length - 1];
    if (dropTop !== undefined) {
      cards.set(dropTop, {
        uid: dropTop,
        frontUrl: front(dropTop),
        backUrl: back,
        faceUp: true,
        position: [dropA.x, (ps.drop.length - 1) * CARD_T + CARD_T / 2, dropA.z],
        rotation: [0, jitter(dropTop), 0],
        zone: "drop",
        player,
      });
    }
    const evA = zoneAnchor(player, "eventArea");
    if (ps.eventArea.length > 1) piles.push({ key: `ev${player}`, count: ps.eventArea.length - 1, topUrl: null, position: [evA.x, 0, evA.z], rotY });
    const evTop = ps.eventArea[ps.eventArea.length - 1];
    if (evTop !== undefined) {
      cards.set(evTop, {
        uid: evTop,
        frontUrl: front(evTop),
        backUrl: back,
        faceUp: true,
        position: [evA.x, (ps.eventArea.length - 1) * CARD_T + CARD_T / 2, evA.z],
        rotation: [0, jitter(evTop), 0],
        zone: "eventArea",
        player,
      });
    }
    // 手牌：[使用者 2026-07-11] 改「左右並排、不堆疊、不扇形」——每張卡同高同深、rotY/rotZ=0、
    // 單一傾角 HAND_TILT；相鄰以 gap 隔開，張數越多 gap 越小（下限≈0.5px＝剛好不相黏）。
    // 因為卡片嚴格共面且不重疊，幾何上不可能穿插破圖（不再需要 CP5d 的平行平面/層距技巧）。
    // hover/highlight 位移仍沿卡面內方向，平行性維持。
    // P1＝遠端蓋牌扇（平放卡的 rotY 就是面內滾轉，只需層距 > 卡厚）。
    const handA = zoneAnchor(player, "hand");
    const n = ps.hand.length;
    // P0 手牌：左右並排、不堆疊不扇形；相鄰間隙隨張數動態收縮（下限＝剛好不相黏）。
    const handGap = Math.max(HAND_GAP_MIN, HAND_GAP_MAX - (n - 1) * HAND_GAP_SHRINK);
    const handStep = CARD_W + handGap;
    ps.hand.forEach((uid, i) => {
      const t = n > 1 ? i - (n - 1) / 2 : 0;
      if (player === 0) {
        const showValue = handValue?.player === player && handValue.uids.has(uid);
        const handCard = cardOf(db, state, uid);
        cards.set(uid, {
          uid,
          frontUrl: front(uid),
          backUrl: back,
          faceUp: true,
          // [使用者 2026-07-12] 由左到右＝由下到上：每張沿 index 遞增高度＋往觀者側位移，
          // 形成平行層距（右壓左），徹底消除偶發 z-fighting 破圖。
          position: [handA.x + t * handStep, 0.74 + i * 0.02, handA.z - 0.2 + i * 0.035],
          rotation: [HAND_TILT, 0, 0],
          zone: "hand",
          player,
          hoverOffset: [0, HAND_HOVER_SLIDE * HAND_SIN, -HAND_HOVER_SLIDE * HAND_COS],
          highlightOffset: [0, HAND_HIGHLIGHT_SLIDE * HAND_SIN, -HAND_HIGHLIGHT_SLIDE * HAND_COS],
          ...(showValue ? {
            effectiveValue: effParam(db, state, uid, handValue.param),
            baseValue: handCard?.params?.[handValue.param] ?? null,
          } : {}),
        });
      } else {
        // [使用者 2026-07-18] 只在整場比賽結束後公開對手剩餘手牌；
        // 對局進行中繼續不建立正面貼圖，避免 hidden-information side channel。
        const revealAtMatchEnd = state.phase === "gameOver";
        cards.set(uid, {
          uid,
          frontUrl: revealAtMatchEnd ? front(uid) : null,
          backUrl: back,
          faceUp: revealAtMatchEnd,
          position: [handA.x - t * 0.48, CARD_T / 2 + i * CARD_T * 1.2, handA.z],
          rotation: [0, rotY + t * 0.04, 0],
          zone: "hand",
          player,
        });
      }
    });
  }
  return { cards, piles };
}

/** 批次演出中的合成視圖：底＝批次 before 的擺位；已演完移動的 uid 取批次 after 的擺位。
 *  牌堆（deck/drop 厚度）以 before 為準，批次結束切 displayed 時一次到位。 */
export function mergePlacements(base: BoardPlacements, target: BoardPlacements, movedUids: ReadonlySet<number>): BoardPlacements {
  if (movedUids.size === 0) return base;
  const cards = new Map(base.cards);
  for (const uid of movedUids) {
    const p = target.cards.get(uid);
    if (p) cards.set(uid, p);
  }
  return { cards, piles: base.piles };
}

/** 移入「未逐張擺放的牌堆」（deck／drop 底疊／event 底疊／setArea）的已演移動卡，
 *  給一個牌堆錨點落點——否則 mergePlacements 找不到 after 擺位、卡片會卡在來源區不動
 *  （換牌回牌組看不到「飛回牌堆」的動態就是這個原因）。卡片飛到牌堆頂後停著＝視覺上併入。 */
export function applyMovedPileTargets(
  base: BoardPlacements,
  afterState: GameState,
  movedUids: ReadonlySet<number>,
  schools: [string | undefined, string | undefined],
): BoardPlacements {
  if (movedUids.size === 0) return base;
  const cards = new Map(base.cards);
  for (const uid of movedUids) {
    const ref = locateReadingCard(afterState, uid);
    if (!ref) continue;
    const ps = afterState.players[ref.player];
    const inPile = ref.zone === "deck"
      || ref.zone === "setArea"
      || (ref.zone === "drop" && ps.drop.at(-1) !== uid)
      || (ref.zone === "eventArea" && ps.eventArea.at(-1) !== uid);
    if (!inPile) continue;
    const anchor = zoneAnchor(ref.player, ref.zone);
    const existing = cards.get(uid);
    // 進牌堆＝蓋著（回牌組不洩漏身分）；drop 底疊維持原可見度。
    const faceUp = ref.zone === "drop" || ref.zone === "eventArea";
    cards.set(uid, {
      uid,
      frontUrl: existing?.frontUrl ?? null,
      backUrl: existing?.backUrl ?? cardBackUrl(schools[ref.player]),
      faceUp,
      position: [anchor.x, 0.12, anchor.z],
      rotation: [0, ref.player === 0 ? 0 : Math.PI, 0],
      zone: ref.zone,
      player: ref.player,
    });
  }
  return { ...base, cards };
}

/** deploy-block 尚未提交前，把已選手牌投影到中央／側邊三格；不改 engine state。 */
export function applyBlockPreview(base: BoardPlacements, selected: readonly number[], center: number | null): BoardPlacements {
  if (selected.length === 0) return base;
  const cards = new Map(base.cards);
  let sideIndex = 0;
  for (const uid of selected) {
    const original = cards.get(uid);
    if (!original) continue;
    const isCenter = uid === (center ?? selected[0]);
    const anchor = isCenter ? zoneAnchor(0, "blockCenter") : blockSideAnchor(0, sideIndex++);
    cards.set(uid, {
      ...original,
      position: [anchor.x, lift(0), anchor.z],
      rotation: [0, jitter(uid), 0],
      zone: isCenter ? "blockCenter" : "blockSide",
      player: 0,
    });
  }
  return { ...base, cards };
}

export type InspectZone = "serve" | "blockCenter" | "receive" | "toss" | "attack" | "drop" | "eventArea";

export interface ReadingCardRef {
  uid: number;
  player: PlayerId;
  zone: ZoneId;
  /** 分列鍵：同鍵的卡排成同一列。未給時退回 `${player}:${zone}`。
   *  疊放區 inspect 時用來把「場上角色（最上一張）」與「Guts」拆成兩列。 */
  groupKey?: string;
  /** 該列標籤；未給時退回 `${我方/對手}${區名}`。 */
  groupLabel?: string;
}

const ALL_ZONE_KEYS: readonly (readonly [ZoneId, keyof GameState["players"][0]])[] = [
  ["hand", "hand"], ["setArea", "setArea"], ["drop", "drop"], ["eventArea", "eventArea"],
  ["serve", "serve"], ["blockCenter", "blockCenter"], ["blockSide", "blockSides"],
  ["receive", "receive"], ["toss", "toss"], ["attack", "attack"], ["deck", "deck"],
];

export function locateReadingCard(state: GameState, uid: number): ReadingCardRef | null {
  for (const player of [0, 1] as const) {
    for (const [zone, key] of ALL_ZONE_KEYS) {
      if ((state.players[player][key] as number[]).includes(uid)) return { uid, player, zone };
    }
  }
  return null;
}

const STACK_ZONE_SET: ReadonlySet<string> = new Set(STACK_ZONES);

export function readingCardsForZone(state: GameState, player: PlayerId, zone: InspectZone): ReadingCardRef[] {
  const stack = state.players[player][zone];
  const uids = [...stack].reverse(); // 頂端（最上一張＝場上角色／最新）排在最前
  const who = player === 0 ? "我方" : "對手";
  if (!STACK_ZONE_SET.has(zone)) {
    return uids.map((uid) => ({ uid, player, zone }));
  }
  // 疊放區：最上面一張是場上角色（非 Guts），其餘才是 Guts——分兩列標記。
  const gutsCount = Math.max(uids.length - 1, 0);
  return uids.map((uid, index) => {
    const isChara = index === 0;
    return {
      uid,
      player,
      zone,
      groupKey: isChara ? `${player}:${zone}:chara` : `${player}:${zone}:guts`,
      groupLabel: isChara ? `${who}場上角色` : `ガッツ（${gutsCount}）`,
    };
  });
}

/** 公開牌堆／效果候選的 3D 閱讀框；同來源卡維持同一列，不塌成無來源清單。
 *  mode="inspect"（點牌堆檢視）：卡片拉近觀者、傾角對齊手牌（HAND_TILT），較好讀；
 *  mode="select"（效果選卡）：全部候選轉成與手牌相同傾角、同尺寸的選牌面。 */
export function applyReadingFrame(
  base: BoardPlacements,
  db: CardDb,
  state: GameState,
  refs: readonly ReadingCardRef[],
  schools: [string | undefined, string | undefined],
  mode: "select" | "inspect" = "select",
  printingByUid: ReadonlyMap<number, string> = new Map(),
  selectedUids: ReadonlySet<number> = new Set(),
): BoardPlacements {
  if (refs.length === 0) return base;
  const cards = new Map(base.cards);
  const grouped = new Map<string, ReadingCardRef[]>();
  for (const ref of refs) {
    const key = ref.groupKey ?? `${ref.player}:${ref.zone}`;
    const group = grouped.get(key) ?? [];
    group.push(ref);
    grouped.set(key, group);
  }
  const zoneOrder: readonly ZoneId[] = ["serve", "blockCenter", "blockSide", "receive", "toss", "attack", "hand", "eventArea", "drop", "setArea", "deck"];
  const groups = [...grouped.values()].sort((a, b) => {
    const player = a[0]!.player - b[0]!.player;
    if (player !== 0) return player;
    return zoneOrder.indexOf(a[0]!.zone) - zoneOrder.indexOf(b[0]!.zone);
  });
  const inspect = mode === "inspect";
  const rotation: [number, number, number] = [HAND_TILT, 0, 0];
  // inspect：整框往上（z 小、遠離手牌 z≈5.35，不再蓋手牌）＋傾角對齊手牌。
  // 疊放區（角色＋Guts＝兩組）採左右分欄：最上一張角色在左單欄、Guts 在右邊較大格狀區。
  const split = inspect && groups.length === 2;
  const Y_BASE = 1.7;
  const Z_BASE = 1.45;
  const readingPanels: ReadingPanelPlacement[] = [];
  // [使用者 2026-07-16] 選牌面把來源區提升為有邊界的分區盤。每盤內仍維持同尺寸、
  // 同傾角格狀；最多三盤一列，更多來源換到第二列，不縮小卡片犧牲可讀性。
  const selectLayouts = !inspect ? groups.map((group) => {
    const columns = Math.min(group.length, groups.length >= 3 ? 2 : 3);
    const rows = Math.ceil(group.length / Math.max(columns, 1));
    return {
      group,
      columns,
      rows,
      width: columns * CARD_W + Math.max(columns - 1, 0) * 0.18 + 0.52,
      depth: rows * 1.48 + 0.7,
    };
  }) : [];
  const selectRows = !inspect
    ? Array.from({ length: Math.ceil(selectLayouts.length / 3) }, (_, row) => selectLayouts.slice(row * 3, row * 3 + 3))
    : [];
  const layoutByGroup = new Map<ReadingCardRef[], { x: number; z: number; columns: number; width: number; depth: number }>();
  if (!inspect) {
    const rowDepths = selectRows.map((row) => Math.max(...row.map((item) => item.depth)));
    const totalDepth = rowDepths.reduce((sum, depth) => sum + depth, 0) + Math.max(rowDepths.length - 1, 0) * 0.3;
    let rowBack = 0.7 - totalDepth / 2;
    selectRows.forEach((row, rowIndex) => {
      const rowWidth = row.reduce((sum, item) => sum + item.width, 0) + Math.max(row.length - 1, 0) * 0.28;
      let left = -rowWidth / 2;
      const rowDepth = rowDepths[rowIndex]!;
      const z = rowBack + rowDepth / 2;
      row.forEach((item) => {
        const x = left + item.width / 2;
        layoutByGroup.set(item.group, { x, z, columns: item.columns, width: item.width, depth: item.depth });
        left += item.width + 0.28;
      });
      rowBack += rowDepth + 0.3;
    });
  }
  groups.forEach((group, gi) => {
    const first = group[0]!;
    const label = first.groupLabel ?? `${first.player === 0 ? "我方" : "對手"}${ZONE_LABEL[first.zone]}`;
    const layout = layoutByGroup.get(group);
    const columns = inspect
      ? (split ? (gi === 0 ? 1 : Math.min(group.length, 5)) : Math.min(group.length, 6))
      : layout!.columns;
    if (!inspect) {
      const stateKey = ALL_ZONE_KEYS.find(([zone]) => zone === first.zone)?.[1];
      const stack = stateKey ? state.players[first.player][stateKey] as number[] : [];
      const stackGuts = STACK_ZONE_SET.has(first.zone) ? new Set(stack.slice(0, -1)) : null;
      const allCandidatesAreGuts = stackGuts !== null && group.every((ref) => stackGuts.has(ref.uid));
      const picked = group.filter((ref) => selectedUids.has(ref.uid)).length;
      const detail = allCandidatesAreGuts
        ? `Guts ${stackGuts.size}・已選 ${picked} → 剩 ${Math.max(stackGuts.size - picked, 0)}`
        : `候選 ${group.length}・已選 ${picked}`;
      readingPanels.push({
        key: first.groupKey ?? `${first.player}:${first.zone}`,
        label,
        detail,
        position: [layout!.x, 1.17, layout!.z],
        width: layout!.width,
        depth: layout!.depth,
      });
    }
    group.forEach((ref, index) => {
      const col = index % columns;
      const subRow = Math.floor(index / columns);
      const card = db.get(state.cards[ref.uid] ?? "");
      let x: number, y: number, z: number;
      if (!inspect) {
        // 分區盤內橫向優先；盤與盤之間保留實體空隙與底板，不再跨區連成一張全域格狀。
        const col = index % columns;
        const row = Math.floor(index / columns);
        x = layout!.x + (col - (columns - 1) / 2) * 1.18;
        y = 1.6 + row * 0.055;
        z = layout!.z - layout!.depth / 2 + 1.15 + row * 1.48;
      } else if (split && gi === 0) {
        // 角色：左側單張，略往觀者側凸出以突顯「這是場上角色、不是 Guts」。
        x = -3.4; y = Y_BASE; z = Z_BASE + 0.25;
      } else if (split) {
        // Guts：右側較大格狀區，往網子退＋升高展開。
        x = -0.1 + col * 1.16;
        y = Y_BASE + subRow * 0.78;
        z = Z_BASE - subRow * 1.3;
      } else {
        // 單組（棄牌／事件公開堆）：置中格狀。
        x = (col - (columns - 1) / 2) * 1.14;
        y = Y_BASE + subRow * 0.78;
        z = Z_BASE - subRow * 1.3;
      }
      cards.set(ref.uid, {
        uid: ref.uid,
        frontUrl: card ? cardFrontUrl(card, printingByUid.get(ref.uid)) : null,
        backUrl: cardBackUrl(schools[ref.player]),
        faceUp: true,
        position: [x, y, z],
        rotation,
        zone: ref.zone,
        player: ref.player,
        readingGroup: inspect && index === 0 ? label : undefined,
      });
    });
  });
  return { ...base, cards, readingPanels: inspect ? undefined : readingPanels };
}

/** 舊版混合來源選牌相容函式；新 effect-cards 已統一進選牌面。 */
export function liftInPlaceReadingCandidates(base: BoardPlacements, uids: ReadonlySet<number>): BoardPlacements {
  if (uids.size === 0) return base;
  const cards = new Map(base.cards);
  for (const uid of uids) {
    const card = cards.get(uid);
    if (!card) continue;
    cards.set(uid, { ...card, position: [card.position[0], Math.max(card.position[1], 1.05), card.position[2]] });
  }
  return { ...base, cards };
}
