import process from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AnalyzerPreset } from "./deck-analyzer";
import type { BenchmarkPolicyId } from "./benchmark";
import type { BenchmarkDeck } from "./benchmark-fixtures";
import { benchmarkDb, benchmarkDecks, findBenchmarkDeck } from "./benchmark-fixtures";
import {
  autoLockCoreCards,
  createDeckOptimizerProposalScaffold,
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

function policyArg(name: string, fallback: BenchmarkPolicyId): BenchmarkPolicyId {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  if (raw === "random" || raw === "heuristic-v1" || isHeuristicV2ProfileId(raw)) return raw;
  throw new Error(`--${name} 只支援 random、heuristic-v1、heuristic-v2、heuristic-v2-safe 或 heuristic-v2-aggressive`);
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

function printProposal(proposal: DeckOptimizerProposal, pool: OptimizerCardPool, autoLockEnabled: boolean): void {
  console.log("M8 Phase C1-3a Deck Optimizer Proposal Scaffold");
  console.log(`牌組: ${proposal.sourceDeck}`);
  console.log(`狀態: ${proposal.status}`);
  console.log(`目標: ${proposal.objectiveProfile ?? "preserve-current"}`);
  console.log(`測試設定: ${proposal.evaluationConfig.preset}, 對手=${proposal.evaluationConfig.opponents.length}, 每個先後手場次=${proposal.evaluationConfig.gamesPerSeat ?? "未指定"}`);
  console.log(`AI: ${proposal.evaluationConfig.policy} vs ${proposal.evaluationConfig.opponentPolicy}`);
  console.log(`變更: ${proposal.changes.length}（C1-3a 不產生候選換卡）`);
  console.log(`候選卡池: 同校 ${pool.schools.join("/") || "未標記"}，共 ${pool.poolIds.length} 張可考慮（含跨校允許 ${pool.crossSchoolAllowed.length} 張）`);
  console.log(`保護核心卡: ${autoLockEnabled ? "自動鎖定 " : ""}${formatLocked(proposal.lockedCards)}`);
  console.log(`禁用卡: ${formatBanned(proposal.bannedCards)}`);
  console.log("驗證: OK");
  console.log("下一步: C1-3b 才會在此卡池內產生 candidate deck；目前不跑 benchmark，也不寫回牌組檔。");
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
  const explicitLocked = parseLockedCards(argValue("locked"));
  const bannedCards = splitList(argValue("banned"));
  const allowCards = splitList(argValue("allow"));
  const unlockCards = splitList(argValue("unlock"));
  assertKnownCardIds("locked", explicitLocked.map((entry) => entry.id));
  assertKnownCardIds("banned", bannedCards);
  assertKnownCardIds("allow", allowCards);
  assertKnownCardIds("unlock", unlockCards);

  const autoLockEnabled = !hasFlag("no-auto-lock");
  const lockedCards = autoLockEnabled
    ? autoLockCoreCards(benchmarkDb, deck.ids, { unlock: unlockCards, explicit: explicitLocked })
    : explicitLocked;
  const cardPool = resolveOptimizerCardPool(benchmarkDb, deck.ids, { allow: allowCards, banned: bannedCards });

  const opponents = resolveOpponents(new Set([deck.name]));
  if (opponents.length === 0) throw new Error("沒有可記錄的對手牌組；請調整 --opponents");

  const proposal = createDeckOptimizerProposalScaffold({
    db: benchmarkDb,
    sourceDeck: deck,
    constraints: { lockedCards, bannedCards },
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
      `核心卡保護：${autoLockEnabled ? `自動鎖定（可用 --unlock 解除、--locked 覆蓋）共 ${lockedCards.length} 張` : "已用 --no-auto-lock 關閉自動鎖定"}。`,
    ],
  });

  const outPath = argValue("out");
  if (hasFlag("json")) {
    console.log(JSON.stringify(proposal, null, 2));
    writeProposal(outPath, proposal, true);
    return;
  }

  printProposal(proposal, cardPool, autoLockEnabled);
  writeProposal(outPath, proposal);
}

run();
