import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import type { GameState } from "../engine/types";
import { createPimcCoachReport } from "./coach";
import type { CoachReport, PimcCoachOptions } from "./coach";

export interface CoachWorkerRequest {
  requestId: string;
  state: GameState;
  options?: PimcCoachOptions;
}

export type CoachWorkerResponse =
  | { requestId: string; ok: true; report: CoachReport }
  | { requestId: string; ok: false; error: string };

const db = new Map((cardsJson as Card[]).map((card) => [card.id, card]));
const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent<CoachWorkerRequest>) => void) | null;
  postMessage: (message: CoachWorkerResponse) => void;
};

workerSelf.onmessage = (event: MessageEvent<CoachWorkerRequest>) => {
  const { requestId, state, options } = event.data;
  try {
    const report = createPimcCoachReport(db, state, options);
    workerSelf.postMessage({ requestId, ok: true, report } satisfies CoachWorkerResponse);
  } catch (error) {
    workerSelf.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies CoachWorkerResponse);
  }
};
