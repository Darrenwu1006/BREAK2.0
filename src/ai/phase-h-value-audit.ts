import { applyDecision } from "../engine/engine";
import type { CardDb, Decision, GameState, PlayerId } from "../engine/types";
import type { ReplaySession } from "../shared/replayHistory";
import { describeDecision } from "../shared/decisionLabels";
import { evaluatePressureScore, evaluateStateValue, type ValueModel } from "./rollout-value";

export interface PhaseHGateValuePair {
  label: string;
  player: PlayerId;
  acceptLabel: string;
  declineLabel: string;
  actualAccept: boolean | null;
  acceptValue: number;
  declineValue: number;
  valueDelta: number;
  acceptPressure: number;
  declinePressure: number;
  pressureDelta: number;
}

export interface PhaseHValueAuditSummary {
  totalPairs: number;
  valueCorrect: number;
  valueTied: number;
  valueWrong: number;
  averageValueDelta: number;
  averagePressureDelta: number;
}

export interface PhaseHReplayAuditResult {
  source: string;
  pairs: PhaseHGateValuePair[];
}

export interface PhaseHValueAuditOptions {
  model?: ValueModel;
  minPressureDelta?: number;
  tieEpsilon?: number;
}

function acceptDecision(): Decision {
  return { type: "effect-confirm", accept: true };
}

function declineDecision(): Decision {
  return { type: "effect-confirm", accept: false };
}

function isGateConfirmState(state: GameState): boolean {
  return state.pendingDecision?.type === "effect-confirm" && state.effectCtx?.awaiting?.kind === "confirm" && state.effectCtx.awaiting.what === "gate";
}

export function analyzeGateValuePair(
  db: CardDb,
  state: GameState,
  label: string,
  options: PhaseHValueAuditOptions = {},
  actualDecision?: Decision,
): PhaseHGateValuePair | null {
  if (!isGateConfirmState(state)) return null;
  const player = state.pendingDecision!.player as PlayerId;
  let acceptState: GameState;
  let declineState: GameState;
  try {
    acceptState = applyDecision(db, state, acceptDecision());
    declineState = applyDecision(db, state, declineDecision());
  } catch {
    return null;
  }
  const model = options.model;
  const acceptValue = evaluateStateValue(acceptState, player, model, db);
  const declineValue = evaluateStateValue(declineState, player, model, db);
  const acceptPressure = evaluatePressureScore(db, acceptState, player);
  const declinePressure = evaluatePressureScore(db, declineState, player);
  const pressureDelta = acceptPressure - declinePressure;
  if (pressureDelta <= (options.minPressureDelta ?? 0)) return null;

  return {
    label,
    player,
    acceptLabel: describeDecision(db, state, acceptDecision()),
    declineLabel: describeDecision(db, state, declineDecision()),
    actualAccept: actualDecision?.type === "effect-confirm" ? actualDecision.accept : null,
    acceptValue,
    declineValue,
    valueDelta: acceptValue - declineValue,
    acceptPressure,
    declinePressure,
    pressureDelta,
  };
}

export function auditReplaySession(
  db: CardDb,
  session: ReplaySession,
  source: string,
  options: PhaseHValueAuditOptions = {},
): PhaseHReplayAuditResult {
  const pairs = session.entries
    .map((entry) =>
      analyzeGateValuePair(
        db,
        entry.before,
        `${source}#${entry.index} Set${entry.setNo}T${entry.turnNo} ${entry.phase}`,
        options,
        entry.decision,
      ),
    )
    .filter((pair): pair is PhaseHGateValuePair => pair !== null);
  return { source, pairs };
}

export function summarizeGateValuePairs(
  pairs: readonly PhaseHGateValuePair[],
  options: Pick<PhaseHValueAuditOptions, "tieEpsilon"> = {},
): PhaseHValueAuditSummary {
  const tieEpsilon = options.tieEpsilon ?? 1e-6;
  const totalPairs = pairs.length;
  const valueCorrect = pairs.filter((pair) => pair.valueDelta > tieEpsilon).length;
  const valueTied = pairs.filter((pair) => Math.abs(pair.valueDelta) <= tieEpsilon).length;
  const valueWrong = pairs.filter((pair) => pair.valueDelta < -tieEpsilon).length;
  return {
    totalPairs,
    valueCorrect,
    valueTied,
    valueWrong,
    averageValueDelta: totalPairs === 0 ? 0 : pairs.reduce((sum, pair) => sum + pair.valueDelta, 0) / totalPairs,
    averagePressureDelta: totalPairs === 0 ? 0 : pairs.reduce((sum, pair) => sum + pair.pressureDelta, 0) / totalPairs,
  };
}
