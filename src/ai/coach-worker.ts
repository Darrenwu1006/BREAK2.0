import cardsJson from "../../data/cards.json";
import type { Card } from "../data/types";
import { createPimcCoachReport } from "./coach";
import { createIsmctsReport } from "./ismcts";
// [Claude 2026-07-24] 候選 A：協定型別移至 ai-search.ts（backend 與 worker 共用一份）。本檔＝純 worker entry。
import type { CoachWorkerRequest, CoachWorkerResponse } from "./ai-search";

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
