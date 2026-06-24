import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import type { GameState } from "../engine/types";
import { createPimcCoachReport } from "./coach";
import type { CoachReport, PimcCoachOptions } from "./coach";
import { createIsmctsReport } from "./ismcts";
import type { IsmctsOptions } from "./ismcts";

// [Claude 2026-06-23] Phase G G4：worker 依 engine 分派 PIMC／IS-MCTS。
// 電腦對手（強敵）走 ismcts；玩家側的 coach 提示與 replay 復盤維持 pimc。
export type CoachWorkerRequest =
  | { requestId: string; state: GameState; engine?: "pimc"; options?: PimcCoachOptions }
  | { requestId: string; state: GameState; engine: "ismcts"; options?: IsmctsOptions };

export type CoachWorkerResponse =
  | { requestId: string; ok: true; report: CoachReport }
  | { requestId: string; ok: false; error: string };

const db = new Map((cardsJson as Card[]).map((card) => [card.id, card]));
const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent<CoachWorkerRequest>) => void) | null;
  postMessage: (message: CoachWorkerResponse) => void;
};

workerSelf.onmessage = (event: MessageEvent<CoachWorkerRequest>) => {
  const { requestId, state } = event.data;
  try {
    const report =
      event.data.engine === "ismcts"
        ? createIsmctsReport(db, state, event.data.options)
        : createPimcCoachReport(db, state, event.data.options);
    workerSelf.postMessage({ requestId, ok: true, report } satisfies CoachWorkerResponse);
  } catch (error) {
    workerSelf.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies CoachWorkerResponse);
  }
};
