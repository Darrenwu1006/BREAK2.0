import process from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AnalyzerPreset } from "./deck-analyzer";
import type { BenchmarkPolicyId } from "./benchmark";
import type { BenchmarkDeck } from "./benchmark-fixtures";
import { benchmarkDb, benchmarkDecks, findBenchmarkDeck } from "./benchmark-fixtures";
import { runDeckAnalyzerComparison } from "./deck-analyzer";
import {
  attachDeckOptimizerEvaluation,
  attachDeckOptimizerValidationMatrix,
  autoLockCoreCards,
  CARD_POOL_HEURISTIC_NOTE,
  createDeckOptimizerCandidateProposal,
  createDeckOptimizerProposalScaffold,
  deckOptimizerIdsFromCards,
  resolveOptimizerCardPool,
  type DeckOptimizerLockedCard,
  type DeckOptimizerObjectiveProfile,
  type DeckOptimizerProposal,
  type OptimizerCardPool,
} from "./deck-optimizer";
import { isHeuristicV2ProfileId } from "./heuristic";

const DEFAULTS = {
  deck: "青葉城西-二彈改",
  policy: "heuristic-v2" as BenchmarkPolicyId,
  opponentPolicy: "heuristic-v2" as BenchmarkPolicyId,
  preset: "direction" as AnalyzerPreset,
  objective: "preserve-current" as DeckOptimizerObjectiveProfile,
  seedStart: 2200,
  games: 4,
  maxSteps: 5000,
  maxReplacements: 2,
};

const PRESETS: Record<Exclude<AnalyzerPreset, "custom">, { games: number; seedStart: number }> = {
  smoke: { games: 1, seedStart: 1600 },
  direction: { games: 4, seedStart: 2200 },
  formal: { games: 20, seedStart: 3200 },
  holdout: { games: 10, seedStart: 9000 },
};

const OBJECTIVES: DeckOptimizerObjectiveProfile[] = ["serve", "block", "burst", "defense", "hybrid", "preserve-current"];

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} 必須是正數`);
  return value;
}

function integerArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} 必須是正整數`);
  return value;
}

function policyArg(name: string, fallback: BenchmarkPolicyId): BenchmarkPolicyId {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  if (raw === "random" || raw === "heuristic-v1" || isHeuristicV2ProfileId(raw)) return raw;
  throw new Error(`--${name} 只支援 random、heuristic-v1、heuristic-v2、heuristic-v2-safe、heuristic-v2-aggressive、heuristic-v2-personality 或 heuristic-v2-<axis>`);
}

function presetArg(): AnalyzerPreset {
  const raw = argValue("preset") ?? DEFAULTS.preset;
  if (raw === "custom" || raw === "smoke" || raw === "direction" || raw === "formal" || raw === "holdout") return raw;
  throw new Error("--preset 只支援 custom、smoke、direction、formal 或 holdout");
}

function objectiveArg(): DeckOptimizerObjectiveProfile {
  const raw = argValue("objective") ?? DEFAULTS.objective;
  if (OBJECTIVES.includes(raw as DeckOptimizerObjectiveProfile)) return raw as DeckOptimizerObjectiveProfile;
  throw new Error("--objective 只支援 serve、block、burst、defense、hybrid 或 preserve-current");
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function parseLockedCards(raw: string | undefined): DeckOptimizerLockedCard[] {
  return splitList(raw).map((entry) => {
    const [id, countRaw] = entry.split(":");
    const minCount = Number(countRaw);
    if (!id || countRaw === undefined || !Number.isInteger(minCount) || minCount <= 0) {
      throw new Error("--locked 格式需為 CARD_ID:張數，例如 HV-P02-017:4");
    }
    return { id, minCount };
  });
}

function assertKnownCardIds(label: string, ids: readonly string[]): void {
  const unknown = ids.filter((id) => !benchmarkDb.has(id));
  if (unknown.length > 0) throw new Error(`${label} 引用了不存在的卡片: ${unknown.join(", ")}`);
}

const KNOWN_SCHOOLS: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const [, card] of benchmarkDb) for (const affiliation of card.affiliations ?? []) set.add(affiliation);
  return set;
})();

/**
 * --allow 同時接受單卡（CARD_ID）與整校（所屬名稱）。混校構築常見，整校允許讓使用者不必逐張列卡。
 * 回傳分開的 cards / schools，未知 token 直接報錯。
 */
function partitionAllowTokens(tokens: readonly string[]): { cards: string[]; schools: string[] } {
  const cards: string[] = [];
  const schools: string[] = [];
  const unknown: string[] = [];
  for (const token of tokens) {
    if (benchmarkDb.has(token)) cards.push(token);
    else if (KNOWN_SCHOOLS.has(token)) schools.push(token);
    else unknown.push(token);
  }
  if (unknown.length > 0) throw new Error(`allow 引用了不存在的卡片或所屬: ${unknown.join(", ")}`);
  return { cards, schools };
}

function resolveOpponents(excluded: Set<string>): BenchmarkDeck[] {
  const raw = argValue("opponents") ?? "all";
  if (raw === "all") return benchmarkDecks.filter((deck) => !excluded.has(deck.name));
  const decks = splitList(raw).map((name) => findBenchmarkDeck(name));
  return decks.filter((deck) => !excluded.has(deck.name));
}

function cardLabel(id: string): string {
  const card = benchmarkDb.get(id);
  return `${card?.nameZh || card?.nameJa || id} (${id})`;
}

function formatLocked(cards: readonly DeckOptimizerLockedCard[]): string {
  if (cards.length === 0) return "none";
  return cards.map((entry) => `${cardLabel(entry.id)} x${entry.minCount}+`).join(", ");
}

function formatBanned(ids: readonly string[]): string {
  if (ids.length === 0) return "none";
  return ids.map(cardLabel).join(", ");
}

function writeProposal(path: string | undefined, proposal: DeckOptimizerProposal, quiet = false): void {
  if (!path) return;
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  if (!quiet) console.log(`Proposal written: ${abs}`);
}

function printDecks(): void {
  for (const deck of benchmarkDecks) {
    console.log(`${deck.name} (${deck.ids.length} 張, axes=${deck.axes.join("/")})`);
  }
}

function formatDelta(value: number | undefined, digits = 1): string {
  if (value === undefined) return "n/a";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

function printProposal(proposal: DeckOptimizerProposal, pool: OptimizerCardPool, autoLockEnabled: boolean, evaluated: boolean): void {
  console.log(proposal.validation ? "M8 Phase C2 Deck Optimizer Validation Proposal" : evaluated ? "M8 Phase C1-4 Deck Optimizer Evaluated Proposal" : "M8 Phase C1-3b Deck Optimizer Candidate Proposal");
  console.log(`牌組: ${proposal.sourceDeck}`);
  console.log(`狀態: ${proposal.status}`);
  console.log(`目標: ${proposal.objectiveProfile ?? "preserve-current"}`);
  console.log(`測試設定: ${proposal.evaluationConfig.preset}, 對手=${proposal.evaluationConfig.opponents.length}, 每個先後手場次=${proposal.evaluationConfig.gamesPerSeat ?? "未指定"}`);
  console.log(`AI: ${proposal.evaluationConfig.policy} vs ${proposal.evaluationConfig.opponentPolicy}`);
  console.log(`變更: ${proposal.changes.length === 0 ? "0（未產生換卡）" : proposal.changes.map((change) => `${change.cardName} ${change.delta >= 0 ? "+" : ""}${change.delta}`).join(", ")}`);
  console.log(`候選卡池: 同校 ${pool.schools.join("/") || "未標記"}，共 ${pool.poolIds.length} 張可考慮（含跨校允許 ${pool.crossSchoolAllowed.length} 張）`);
  console.log(`保護核心卡: ${autoLockEnabled ? "自動鎖定 " : ""}${formatLocked(proposal.lockedCards)}`);
  console.log(`禁用卡: ${formatBanned(proposal.bannedCards)}`);
  if (proposal.score) {
    console.log(`評分: ${proposal.score.value.toFixed(2)}（Match勝率 ${formatDelta(proposal.deltas.matchWinRateDelta)}, Set取得率 ${formatDelta(proposal.deltas.setWinRateDelta)}）`);
    console.log(`穩定度: 未能登場改善 ${formatDelta(proposal.deltas.noDeployLossDelta)}, 判定失敗改善 ${formatDelta(proposal.deltas.judgeFailLossDelta)}, Guts支付改善 ${proposal.deltas.paidGutsDelta === undefined ? "n/a" : `${proposal.deltas.paidGutsDelta >= 0 ? "+" : ""}${proposal.deltas.paidGutsDelta.toFixed(2)}/場`}`);
  } else {
    console.log(proposal.validation ? "單次評分: 未跑 C1-4 --evaluate（已跑 C2 formal/holdout 驗證）" : "評分: 尚未評估（加 --evaluate 才會跑 Deck Analyzer）");
  }
  if (proposal.validation) {
    console.log(`C2 驗證: ${proposal.validation.verdict}`);
    for (const run of proposal.validation.runs) {
      console.log(`- ${run.label}: ${run.status}, score=${run.score.value.toFixed(2)}, Match勝率 ${formatDelta(run.deltas.matchWinRateDelta)}, seed=${run.seedStart}, games=${run.gamesPerSeat}`);
    }
  }
  console.log("驗證: OK");
  console.log(proposal.validation ? "下一步: validated 才能進入人工採納討論；目前仍不寫回牌組檔。" : evaluated ? "下一步: 用 --validate-c2 跑 formal / holdout，再決定是否採用；目前仍不寫回牌組檔。" : "下一步: 加 --evaluate 跑 baseline / candidate 比較；目前不跑 benchmark，也不寫回牌組檔。");
}

function run(): void {
  if (hasFlag("list-decks")) {
    printDecks();
    return;
  }

  const deck = findBenchmarkDeck(argValue("deck") ?? DEFAULTS.deck);
  const preset = presetArg();
  const presetDefaults = preset === "custom" ? DEFAULTS : { ...DEFAULTS, ...PRESETS[preset] };
  const policy = policyArg("policy", DEFAULTS.policy);
  const opponentPolicy = policyArg("opponent-policy", DEFAULTS.opponentPolicy);
  const seedStart = numberArg("seed-start", presetDefaults.seedStart);
  const gamesPerSeat = numberArg("games", presetDefaults.games);
  const maxSteps = numberArg("max-steps", DEFAULTS.maxSteps);
  const maxReplacements = integerArg("max-replacements", DEFAULTS.maxReplacements);
  const explicitLocked = parseLockedCards(argValue("locked"));
  const bannedCards = splitList(argValue("banned"));
  const { cards: allowCards, schools: allowSchools } = partitionAllowTokens(splitList(argValue("allow")));
  const unlockCards = splitList(argValue("unlock"));
  assertKnownCardIds("locked", explicitLocked.map((entry) => entry.id));
  assertKnownCardIds("banned", bannedCards);
  assertKnownCardIds("unlock", unlockCards);

  const autoLockEnabled = !hasFlag("no-auto-lock");
  const lockedCards = autoLockEnabled
    ? autoLockCoreCards(benchmarkDb, deck.ids, { unlock: unlockCards, explicit: explicitLocked })
    : explicitLocked;
  const schoolsArg = splitList(argValue("schools"));
  const cardPool = resolveOptimizerCardPool(benchmarkDb, deck.ids, {
    allow: allowCards,
    allowSchools,
    banned: bannedCards,
    schools: schoolsArg.length > 0 ? schoolsArg : undefined,
  });

  const opponents = resolveOpponents(new Set([deck.name]));
  if (opponents.length === 0) throw new Error("沒有可記錄的對手牌組；請調整 --opponents");

  let proposal = hasFlag("scaffold") ? createDeckOptimizerProposalScaffold({
    db: benchmarkDb,
    sourceDeck: deck,
    constraints: { lockedCards, bannedCards },
    cardPool,
    generationConfig: {
      strategy: "none",
      autoLock: autoLockEnabled,
      allow: allowCards,
      allowSchools,
      unlock: unlockCards,
    },
    objectiveProfile: objectiveArg(),
    evaluationConfig: {
      opponents: opponents.map((opponent) => opponent.name),
      policy,
      opponentPolicy,
      preset,
      gamesPerSeat,
      seedStart,
      maxSteps,
    },
    extraRationale: [
      `候選卡池：同校 ${cardPool.schools.join("/") || "未標記"}，共 ${cardPool.poolIds.length} 張可考慮（含跨校允許 ${cardPool.crossSchoolAllowed.length} 張）。`,
      CARD_POOL_HEURISTIC_NOTE,
      `核心卡保護：${autoLockEnabled ? `自動鎖定（可用 --unlock 解除、--locked 覆蓋）共 ${lockedCards.length} 張` : "已用 --no-auto-lock 關閉自動鎖定"}。`,
    ],
  }) : createDeckOptimizerCandidateProposal({
    db: benchmarkDb,
    sourceDeck: deck,
    constraints: { lockedCards, bannedCards },
    cardPool,
    maxReplacements,
    generationConfig: {
      strategy: "static-coverage-v1",
      maxReplacements,
      autoLock: autoLockEnabled,
      allow: allowCards,
      allowSchools,
      unlock: unlockCards,
    },
    objectiveProfile: objectiveArg(),
    evaluationConfig: {
      opponents: opponents.map((opponent) => opponent.name),
      policy,
      opponentPolicy,
      preset,
      gamesPerSeat,
      seedStart,
      maxSteps,
    },
    extraRationale: [
      `候選卡池：同校 ${cardPool.schools.join("/") || "未標記"}，共 ${cardPool.poolIds.length} 張可考慮（含跨校允許 ${cardPool.crossSchoolAllowed.length} 張）。`,
      CARD_POOL_HEURISTIC_NOTE,
      `核心卡保護：${autoLockEnabled ? `自動鎖定（可用 --unlock 解除、--locked 覆蓋）共 ${lockedCards.length} 張` : "已用 --no-auto-lock 關閉自動鎖定"}。`,
    ],
  });

  if (hasFlag("evaluate")) {
    const comparison = runDeckAnalyzerComparison({
      db: benchmarkDb,
      baseDeck: deck,
      candidateDeck: {
        name: `${deck.name}-optimizer-candidate`,
        ids: deckOptimizerIdsFromCards(proposal.candidateDeckCards),
        axes: deck.axes,
      },
      opponents,
      policy,
      opponentPolicy,
      seedStart,
      gamesPerSeat,
      maxSteps,
      preset,
    });
    proposal = attachDeckOptimizerEvaluation(proposal, comparison);
  }

  if (hasFlag("validate-c2")) {
    const validationGamesRaw = argValue("validation-games");
    const validationGames = validationGamesRaw === undefined ? undefined : integerArg("validation-games", DEFAULTS.games);
    const candidateDeck = {
      name: `${deck.name}-optimizer-candidate`,
      ids: deckOptimizerIdsFromCards(proposal.candidateDeckCards),
      axes: deck.axes,
    };
    const validationRuns = ([
      { label: "formal" as const, preset: "formal" as AnalyzerPreset, gamesPerSeat: validationGames ?? PRESETS.formal.games, seedStart: PRESETS.formal.seedStart },
      { label: "holdout" as const, preset: "holdout" as AnalyzerPreset, gamesPerSeat: validationGames ?? PRESETS.holdout.games, seedStart: PRESETS.holdout.seedStart },
    ]).map((run) => ({
      ...run,
      report: runDeckAnalyzerComparison({
        db: benchmarkDb,
        baseDeck: deck,
        candidateDeck,
        opponents,
        policy,
        opponentPolicy,
        seedStart: run.seedStart,
        gamesPerSeat: run.gamesPerSeat,
        maxSteps,
        preset: run.preset,
      }),
    }));
    proposal = attachDeckOptimizerValidationMatrix(proposal, validationRuns);
  }

  const outPath = argValue("out");
  if (hasFlag("json")) {
    console.log(JSON.stringify(proposal, null, 2));
    writeProposal(outPath, proposal, true);
    return;
  }

  printProposal(proposal, cardPool, autoLockEnabled, hasFlag("evaluate") || hasFlag("validate-c2"));
  writeProposal(outPath, proposal);
}

run();
