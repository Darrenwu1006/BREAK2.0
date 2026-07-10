// M9a CP4 演出播放器：PresentationTimeline 的 React 消費者。
// 時鐘＝renderer 的 frame loop（R3F useFrame 每幀呼叫 tick(dtMs)），不用 setTimeout——
// 背景分頁的 timer 節流會凍住演出，而 rAF 與 3D 動畫同源，節奏永遠跟畫面一致。
// 維護「演出視圖」：displayed＝目前批次的 before 盤面（底圖）；movedUids＝本批已開演移動的卡
// （改取 after 擺位）；批次播完切到 after。timeline.skip() 直接跳到權威盤面。
// 「佇列清空前新決策不渲染結果」的閘＝view.playing：UI 據此鎖互動。

import { useCallback, useRef, useState } from "react";
import type { CardDb, GameState, PlayerId } from "../../engine/types";
import type { ZoneId } from "../presentation/events";
import { renderEventText } from "../presentation/textRenderer";
import type { PresentationBatch, TimelineEntry } from "../presentation/timeline";
import type { LabGameController } from "./controller";

export interface RevealView {
  op?: { player: PlayerId; source: "serve" | "block" | "attack"; value: number };
  dp?: { player: PlayerId; source: "block" | "receive"; value: number };
  judge?: { defense: "block" | "receive"; defender: PlayerId; opValue: number; dpValue: number; success: boolean };
}

export interface PlaybackView {
  /** 演出底圖盤面（批次 before；全部演完＝權威盤面） */
  displayed: GameState;
  /** 目前批次的 after（movedUids 的目標擺位來源）；非批次中＝null */
  after: GameState | null;
  movedUids: ReadonlySet<number>;
  /** 本批移動卡的來源區（renderer 用作新掛載卡的出生點） */
  origins: ReadonlyMap<number, { player: PlayerId; zone: ZoneId }>;
  current: TimelineEntry | null;
  /** OP/DP/判定的持續顯示（跨事件；turn 邊界與決策點清空） */
  reveal: RevealView;
  /** 演出字幕（headless textRenderer 重用），最新在後 */
  subtitles: readonly string[];
  /** true＝演出中（互動應鎖定） */
  playing: boolean;
}

export interface Playback {
  view: PlaybackView;
  /** 每幀呼叫（R3F useFrame → tick(dt 毫秒)）；驅動事件出隊與批次切換 */
  tick: (dtMs: number) => void;
  /** human decide 後立即鎖互動（下一幀 tick 才會開始拉新批次） */
  markPlaying: () => void;
  /** 跳過全部演出，直接顯示權威盤面 */
  skip: () => void;
  setSpeed: (x: number) => void;
}

export function usePlayback(controller: LabGameController, db: CardDb): Playback {
  const [view, setView] = useState<PlaybackView>(() => {
    const head = controller.timeline.peek();
    return {
      displayed: head ? controller.metaOf(head.batch)!.before : controller.engine,
      after: null,
      movedUids: new Set(),
      origins: new Map(),
      current: null,
      reveal: {},
      subtitles: [],
      playing: !controller.timeline.idle,
    };
  });
  /** 目前開演中的事件與剩餘毫秒（幀驅動、不進 React state） */
  const playing = useRef<{ entry: TimelineEntry; remainMs: number } | null>(null);
  const batchRef = useRef<PresentationBatch | null>(null);
  /** 佇列清空後只 finalize 一次 */
  const settled = useRef(false);

  const finalize = useCallback((): void => {
    const lastAfter = batchRef.current ? controller.metaOf(batchRef.current)!.after : controller.engine;
    batchRef.current = null;
    setView((v) => ({ ...v, displayed: lastAfter, after: null, movedUids: new Set(), origins: new Map(), current: null, playing: false }));
  }, [controller]);

  const tick = useCallback(
    (dtMs: number): void => {
      const cur = playing.current;
      if (cur) {
        cur.remainMs -= dtMs;
        if (cur.remainMs > 0) return;
        playing.current = null;
      }
      if (controller.timeline.idle) {
        if (!settled.current) {
          settled.current = true;
          finalize();
        }
        return;
      }
      settled.current = false;
      const entry = controller.timeline.next()!;
      playing.current = { entry, remainMs: entry.durationMs };
      const meta = controller.metaOf(entry.batch)!;
      const newBatch = batchRef.current !== entry.batch;
      batchRef.current = entry.batch;
      setView((v) => {
        const displayed = newBatch ? meta.before : v.displayed;
        const moved = newBatch ? new Set<number>() : new Set(v.movedUids);
        const origins = newBatch ? new Map<number, { player: PlayerId; zone: ZoneId }>() : new Map(v.origins);
        let reveal: RevealView = { ...v.reveal };
        const e = entry.event;
        // reveal 生命週期：一次攻防＝一拍。新 OP 亮出＝新一拍開始（清掉上一拍全部）；
        // OP/DP/判定跨 turn 存活（此遊戲防守發生在防守方回合，數字要陪玩家做完決策）；
        // 得失分（lost/set/match）＝rally 收束，全清。
        switch (e.kind) {
          case "card-moved":
            moved.add(e.uid);
            origins.set(e.uid, { player: e.from.player, zone: e.from.zone });
            break;
          case "op-revealed":
            reveal = { op: { player: e.player, source: e.source, value: e.value } };
            break;
          case "dp-revealed":
            reveal = { ...reveal, dp: { player: e.player, source: e.source, value: e.value } };
            break;
          case "judge-revealed":
            reveal = { ...reveal, judge: { defense: e.defense, defender: e.defender, opValue: e.opValue, dpValue: e.dpValue, success: e.success } };
            break;
          case "lost-declared":
          case "set-won":
          case "match-won":
            reveal = {};
            break;
        }
        const subtitles = e.kind === "decision-requested" ? v.subtitles : [...v.subtitles.slice(-9), renderEventText(db, e)];
        return { displayed, after: meta.after, movedUids: moved, origins, current: entry, reveal, subtitles, playing: true };
      });
    },
    [controller, db, finalize],
  );

  const markPlaying = useCallback((): void => {
    settled.current = false;
    setView((v) => (v.playing ? v : { ...v, playing: !controller.timeline.idle }));
  }, [controller]);

  const skip = useCallback((): void => {
    controller.timeline.skip();
    playing.current = null;
    batchRef.current = null;
    settled.current = true;
    setView((v) => ({
      ...v,
      displayed: controller.engine,
      after: null,
      movedUids: new Set(),
      origins: new Map(),
      current: null,
      reveal: {},
      playing: false,
    }));
  }, [controller]);

  const setSpeed = useCallback(
    (x: number): void => {
      controller.timeline.speed = x;
    },
    [controller],
  );

  return { view, tick, markPlaying, skip, setSpeed };
}
