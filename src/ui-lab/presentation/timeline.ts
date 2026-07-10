// M9-P0 演出佇列／timeline：state 先到位（邏輯即時），演出照自己的節奏放。
// 純 TS、不含 React、不持有計時器——renderer 以 peek/next 拉取事件並依 durationMs 演出，
// 這使本模組可單元測試、且 renderer 無關（R3F／DOM／headless 都能驅動）。
// 「佇列清空前新決策不渲染結果」的閘：renderer 監聽 onIdle＋自查 idle 決定何時開放互動。

import type { Decision, PlayerId } from "../../engine/types";
import type { PresentationEvent } from "./events";

/** 一手決策產生的演出批次 */
export interface PresentationBatch {
  events: PresentationEvent[];
  /** 這手的決策者 */
  actor: PlayerId;
  decisionType: Decision["type"];
  /** J4 對接：AI 這手實際思考毫秒數（人類手可缺）——想越久、關鍵揭示演越重 */
  thinkMs?: number;
}

/** 事件基準演出時長（ms）。M9a 手感迭代的主要調參表。 */
export const BASE_PACE_MS: Record<PresentationEvent["kind"], number> = {
  "card-moved": 360,
  "op-revealed": 600,
  "dp-revealed": 600,
  "judge-revealed": 900,
  "skill-declared": 600,
  "event-played": 600,
  "guts-paid": 300,
  "lost-declared": 800,
  "set-won": 1500,
  "match-won": 2400,
  "turn-started": 400,
  "defense-chosen": 400,
  "decision-requested": 0,
};

/** 吃「思考時長」張力加成的事件（揭示/結算類） */
const TENSION_KINDS: ReadonlySet<PresentationEvent["kind"]> = new Set(["op-revealed", "dp-revealed", "judge-revealed", "set-won", "match-won"]);

/** 思考時長 → 張力係數（J4 不對稱時序的廉價轉譯：瑣碎手快演、關鍵手拉節奏） */
export function tensionOf(thinkMs: number | undefined): number {
  if (thinkMs === undefined) return 1;
  if (thinkMs >= 8000) return 1.5;
  if (thinkMs >= 3000) return 1.25;
  return 1;
}

/** 單一事件的建議演出時長 */
export function paceFor(event: PresentationEvent, batch: PresentationBatch, speed = 1): number {
  const tension = TENSION_KINDS.has(event.kind) ? tensionOf(batch.thinkMs) : 1;
  return Math.round((BASE_PACE_MS[event.kind] * tension) / speed);
}

export interface TimelineEntry {
  event: PresentationEvent;
  batch: PresentationBatch;
  /** 依出隊當下 speed 計算的建議演出時長（ms） */
  durationMs: number;
}

/** 音效預留（spec §1.1）：事件出隊（開演）時呼叫；本期不掛任何實作 */
export type AudioHook = (entry: TimelineEntry) => void;

export class PresentationTimeline {
  private queue: { event: PresentationEvent; batch: PresentationBatch }[] = [];
  private idleListeners = new Set<() => void>();
  /** 播放速度倍率（skip 之外的加速手段） */
  speed = 1;
  audioHook: AudioHook | null = null;

  enqueue(batch: PresentationBatch): void {
    for (const event of batch.events) this.queue.push({ event, batch });
  }

  /** 佇列頭（不出隊）；null＝空 */
  peek(): { event: PresentationEvent; batch: PresentationBatch } | null {
    return this.queue[0] ?? null;
  }

  /** 出隊開演：回傳事件＋建議時長；佇列因此清空時通知 idle */
  next(): TimelineEntry | null {
    const head = this.queue.shift();
    if (!head) return null;
    const entry: TimelineEntry = { ...head, durationMs: paceFor(head.event, head.batch, this.speed) };
    this.audioHook?.(entry);
    if (this.queue.length === 0) this.fireIdle();
    return entry;
  }

  /** 跳過：清空佇列（state 本來就已到位，renderer 直接顯示最終盤面） */
  skip(): void {
    if (this.queue.length === 0) return;
    this.queue = [];
    this.fireIdle();
  }

  /** 佇列已空（最後一個事件可能仍在演；renderer 於 advance 完成時合併判斷） */
  get idle(): boolean {
    return this.queue.length === 0;
  }

  onIdle(cb: () => void): () => void {
    this.idleListeners.add(cb);
    return () => this.idleListeners.delete(cb);
  }

  private fireIdle(): void {
    for (const cb of this.idleListeners) cb();
  }
}
