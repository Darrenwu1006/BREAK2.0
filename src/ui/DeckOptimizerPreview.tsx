import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DeckOptimizerCardCount, DeckOptimizerProposal, DeckOptimizerValidationMatrixRun } from "../ai/deck-optimizer";
import type { CardDb } from "../engine/types";
import { displayName } from "./CardView";
import type { ApiDeck } from "./DeckEditor";

const PROPOSAL_SCHEMA = "m8-deck-optimizer-proposal-v1";

type ParseResult =
  | { proposal: DeckOptimizerProposal; error: null }
  | { proposal: null; error: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProposal(value: unknown): value is DeckOptimizerProposal {
  if (!isRecord(value)) return false;
  return value.schemaVersion === PROPOSAL_SCHEMA
    && typeof value.sourceDeck === "string"
    && Array.isArray(value.sourceDeckCards)
    && Array.isArray(value.candidateDeckCards)
    && Array.isArray(value.changes)
    && Array.isArray(value.rationale)
    && Array.isArray(value.risks)
    && typeof value.status === "string";
}

function parseProposal(raw: string): ParseResult {
  if (!raw.trim()) return { proposal: null, error: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isProposal(parsed)) return { proposal: null, error: "這份 JSON 不是 M8 Deck Optimizer proposal。" };
    return { proposal: parsed, error: null };
  } catch {
    return { proposal: null, error: "JSON 格式無法讀取。" };
  }
}

function cardLabel(db: CardDb, id: string, fallback?: string): string {
  const card = db.get(id);
  return card ? displayName(card) : fallback ?? id;
}

function cardTotal(cards: readonly DeckOptimizerCardCount[]): number {
  return cards.reduce((sum, entry) => sum + entry.count, 0);
}

function eventTotal(db: CardDb, cards: readonly DeckOptimizerCardCount[]): number {
  return cards.reduce((sum, entry) => sum + (db.get(entry.id)?.type === "EVENT" ? entry.count : 0), 0);
}

function hasOnlyKnownCards(db: CardDb, cards: readonly DeckOptimizerCardCount[]): boolean {
  return cards.every((entry) => db.has(entry.id) && Number.isInteger(entry.count) && entry.count >= 0);
}

function formatPct(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function formatScore(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return value.toFixed(2);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-TW", { hour12: false });
}

function statusLabel(status: DeckOptimizerProposal["status"]): string {
  if (status === "validated") return "已通過驗證";
  if (status === "rejected") return "退回";
  if (status === "candidate") return "候選";
  return "草稿";
}

function verdictLabel(verdict: NonNullable<DeckOptimizerProposal["validation"]>["verdict"]): string {
  if (verdict === "validated") return "已通過驗證";
  if (verdict === "rejected") return "退回";
  return "需要人工確認";
}

function StatusPill(props: { tone: string; children: ReactNode }) {
  return <span className={`optimizer-pill optimizer-pill-${props.tone}`}>{props.children}</span>;
}

function deriveDeckTarget(sourceDeck: string): { school: string; name: string } {
  const [school, ...nameParts] = sourceDeck.split("-");
  return {
    school: school?.trim() || "未分類",
    name: `${(nameParts.join("-").trim() || sourceDeck.trim() || "候選牌組")}-optimizer`,
  };
}

function isValidatedProposal(proposal: DeckOptimizerProposal | null): boolean {
  return proposal?.status === "validated" && proposal.validation?.verdict === "validated";
}

/** 未通過 C2 驗證、但資料合法的 proposal 可走「手動覆核」採納，前提是填寫覆核理由。 */
function requiresManualOverride(proposal: DeckOptimizerProposal | null): boolean {
  return !!proposal && !isValidatedProposal(proposal);
}

interface AdoptionRecord {
  savedAt: string;
  targetDeck: string;
  source?: string;
  analyzerSource?: string;
  optimizerAdoption?: {
    sourceDeck?: string;
    proposalGeneratedAt?: string;
    optimizerVersion?: string;
    status?: string;
    validationVerdict?: string;
    score?: number | null;
    manualOverride?: boolean;
    reviewNote?: string;
    changes?: { cardId: string; before: number; after: number; delta: number }[];
  };
}

function ValidationRunRow(props: { run: DeckOptimizerValidationMatrixRun }) {
  const { run } = props;
  const tone = run.status === "validated" ? "ok" : run.status === "rejected" ? "bad" : "mid";
  return (
    <div className="optimizer-run">
      <div>
        <b>{run.label === "formal" ? "正式組" : "保留組"}</b>
        <span className="dim small"> {run.preset}・seed {run.seedStart}・{run.gamesPerSeat} 場/先後手</span>
      </div>
      <div className="optimizer-run-metrics">
        <StatusPill tone={tone}>{statusLabel(run.status)}</StatusPill>
        <span>Score {formatScore(run.score.value)}</span>
        <span>Match {formatPct(run.deltas.matchWinRateDelta)}</span>
      </div>
      {run.notes.length > 0 && <p className="dim small">{run.notes.join("；")}</p>}
    </div>
  );
}

export function DeckOptimizerPreview(props: { db: CardDb; decks: ApiDeck[]; onExit: () => void; onSaved: () => Promise<void> }) {
  const { db } = props;
  const [raw, setRaw] = useState("");
  const [school, setSchool] = useState("");
  const [name, setName] = useState("");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [adoptions, setAdoptions] = useState<AdoptionRecord[]>([]);
  const parsed = useMemo(() => parseProposal(raw), [raw]);
  const proposal = parsed.proposal;
  const sourceTotal = proposal ? cardTotal(proposal.sourceDeckCards) : 0;
  const candidateTotal = proposal ? cardTotal(proposal.candidateDeckCards) : 0;
  const sourceEvents = proposal ? eventTotal(db, proposal.sourceDeckCards) : 0;
  const candidateEvents = proposal ? eventTotal(db, proposal.candidateDeckCards) : 0;
  const existingDeck = props.decks.some((deck) => deck.school === school.trim() && deck.name === name.trim());
  const candidateLegal = !!proposal
    && candidateTotal === 40
    && candidateEvents <= 8
    && hasOnlyKnownCards(db, proposal.candidateDeckCards);
  const needsOverride = requiresManualOverride(proposal);
  const overrideReady = !needsOverride || reviewNote.trim().length > 0;
  const canSave = !!proposal && candidateLegal && overrideReady && !!school.trim() && !!name.trim() && !existingDeck && !saving;

  useEffect(() => {
    if (!proposal) return;
    const target = deriveDeckTarget(proposal.sourceDeck);
    setSchool(target.school);
    setName(target.name);
    setReviewNote("");
    setSaveMessage(null);
  }, [proposal]);

  async function refreshAdoptions() {
    if (!import.meta.env.DEV) return;
    try {
      const res = await fetch("/api/deck-optimizer-adoptions");
      if (!res.ok) return;
      setAdoptions((await res.json()) as AdoptionRecord[]);
    } catch {
      // Adoption history is a local-dev convenience; ignore missing endpoints.
    }
  }

  useEffect(() => { void refreshAdoptions(); }, []);

  async function importFile(file: File | undefined) {
    if (!file) return;
    setRaw(await file.text());
  }

  async function saveCandidateDeck() {
    if (!proposal) return;
    if (!import.meta.env.DEV) {
      setSaveMessage("線上模式無法寫入牌組。");
      return;
    }
    if (!candidateLegal) {
      setSaveMessage("候選牌組未通過 40 張、事件上限或卡片資料檢查。");
      return;
    }
    if (requiresManualOverride(proposal) && reviewNote.trim().length === 0) {
      setSaveMessage("未通過 C2 驗證的 proposal 需填寫手動覆核理由才可另存。");
      return;
    }
    if (!school.trim() || !name.trim()) {
      setSaveMessage("請填寫學校與牌組名稱。");
      return;
    }
    if (existingDeck) {
      setSaveMessage("這個牌組名稱已存在，請改成新名稱。");
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/decks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          school: school.trim(),
          name: name.trim(),
          cards: proposal.candidateDeckCards.map((entry) => ({
            id: entry.id,
            count: entry.count,
            ...(entry.printing ? { printing: entry.printing } : {}),
          })),
          optimizerAdoption: {
            sourceDeck: proposal.sourceDeck,
            proposalGeneratedAt: proposal.generatedAt,
            optimizerVersion: proposal.optimizerVersion,
            objectiveProfile: proposal.objectiveProfile,
            status: proposal.status,
            validationVerdict: proposal.validation?.verdict,
            validationStrategy: proposal.validation?.strategy,
            score: proposal.score?.value ?? null,
            matchWinRateDelta: proposal.deltas.matchWinRateDelta,
            manualOverride: requiresManualOverride(proposal),
            ...(requiresManualOverride(proposal) ? { reviewNote: reviewNote.trim() } : {}),
            changes: proposal.changes.map((change) => ({
              cardId: change.cardId,
              before: change.before,
              after: change.after,
              delta: change.delta,
            })),
          },
        }),
      });
      const json = await res.json() as { source?: string; analyzerSource?: string; adoptionLog?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "儲存失敗");
      await props.onSaved();
      await refreshAdoptions();
      setSaveMessage(`已另存${requiresManualOverride(proposal) ? "（手動覆核）" : ""}：${json.source ?? `${school}/${name}.csv`}`);
    } catch (error) {
      setSaveMessage(`儲存失敗：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="optimizer">
      <div className="optimizer-main">
        <div className="status-bar optimizer-bar">
          <b>M8 調牌提案</b>
          <label className="optimizer-file">
            匯入 JSON
            <input type="file" accept="application/json,.json" onChange={(event) => { void importFile(event.currentTarget.files?.[0]); }} />
          </label>
          <button className="btn-secondary" disabled={!raw} onClick={() => setRaw("")}>清空</button>
          <button className="btn-exit" onClick={props.onExit}>回主選單</button>
        </div>

        <div className="optimizer-workspace">
          <section className="optimizer-panel optimizer-input-panel">
            <div className="optimizer-section-title">
              <b>Proposal JSON</b>
              {proposal && <span className="dim small">{formatDate(proposal.generatedAt)}</span>}
            </div>
            <textarea
              className="optimizer-textarea"
              spellCheck={false}
              value={raw}
              placeholder="貼上 --json 產出的 proposal"
              onChange={(event) => setRaw(event.target.value)}
            />
            {parsed.error && <p className="danger small">{parsed.error}</p>}
          </section>

          <section className="optimizer-panel optimizer-report">
            {proposal ? (
              <>
                <div className="optimizer-section-title">
                  <div>
                    <b>{proposal.sourceDeck}</b>
                    <p className="dim small">目標 {proposal.objectiveProfile ?? "preserve-current"}・{proposal.optimizerVersion}</p>
                  </div>
                  <StatusPill tone={proposal.status === "validated" ? "ok" : proposal.status === "rejected" ? "bad" : "mid"}>
                    {statusLabel(proposal.status)}
                  </StatusPill>
                </div>

                <div className="optimizer-stats">
                  <div className="optimizer-stat">
                    <span>原始牌組</span>
                    <b>{sourceTotal} 張</b>
                    <small>事件 {sourceEvents}</small>
                  </div>
                  <div className="optimizer-stat">
                    <span>候選牌組</span>
                    <b>{candidateTotal} 張</b>
                    <small>事件 {candidateEvents}</small>
                  </div>
                  <div className="optimizer-stat">
                    <span>Score</span>
                    <b>{formatScore(proposal.score?.value)}</b>
                    <small>Match {formatPct(proposal.deltas.matchWinRateDelta)}</small>
                  </div>
                  <div className="optimizer-stat">
                    <span>C2 驗證</span>
                    <b>{proposal.validation ? verdictLabel(proposal.validation.verdict) : "尚未執行"}</b>
                    <small>{proposal.validation?.strategy ?? "validation matrix 未附上"}</small>
                  </div>
                </div>

                <div className="optimizer-change-list">
                  <div className="optimizer-section-title"><b>換牌</b><span className="dim small">{proposal.changes.length} 項</span></div>
                  {proposal.changes.length === 0 ? (
                    <p className="dim small">這份 proposal 沒有改動張數。</p>
                  ) : proposal.changes.map((change) => (
                    <div key={`${change.cardId}:${change.before}:${change.after}`} className="optimizer-change">
                      <div>
                        <b>{cardLabel(db, change.cardId, change.cardName)}</b>
                        <span className="dim small"> {change.cardId.replace("HV-", "")}</span>
                        <p className="dim small">{change.reason}</p>
                      </div>
                      <span className={change.delta > 0 ? "win" : "danger"}>{change.before} → {change.after}</span>
                    </div>
                  ))}
                </div>

                {proposal.validation && (
                  <div className="optimizer-validation">
                    <div className="optimizer-section-title">
                      <b>C2 驗證</b>
                      <StatusPill tone={proposal.validation.verdict === "validated" ? "ok" : proposal.validation.verdict === "rejected" ? "bad" : "mid"}>
                        {verdictLabel(proposal.validation.verdict)}
                      </StatusPill>
                    </div>
                    {proposal.validation.runs.map((run) => <ValidationRunRow key={`${run.label}:${run.seedStart}`} run={run} />)}
                    {proposal.validation.rationale.length > 0 && <p className="dim small">{proposal.validation.rationale.join("；")}</p>}
                  </div>
                )}
              </>
            ) : (
              <div className="optimizer-empty">
                <b>尚未載入 proposal</b>
                <span className="dim small">optimizer 只會輸出建議；這裡負責檢查，不會改牌組。</span>
              </div>
            )}
          </section>
        </div>
      </div>

      <aside className="optimizer-side">
        <section>
          <h2>判讀</h2>
          {proposal ? (
            <>
              <div className={`optimizer-note-block optimizer-adopt${needsOverride ? " optimizer-adopt-override" : ""}`}>
                <b>另存候選牌組</b>
                {needsOverride && (
                  <p className="danger small">
                    ⚠ 這份 proposal {proposal.validation ? "未通過 C2 驗證" : "尚未跑 C2 驗證"}（{statusLabel(proposal.status)}）。
                    手動覆核採納前請確認你了解風險，並寫下覆核理由。
                  </p>
                )}
                <label>學校
                  <input value={school} onChange={(event) => setSchool(event.target.value)} />
                </label>
                <label>牌組名稱
                  <input value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                {needsOverride && (
                  <label>手動覆核理由（必填）
                    <textarea
                      className="optimizer-review-note"
                      value={reviewNote}
                      placeholder="例：smoke 樣本不足但方向正確，先採納試打觀察"
                      onChange={(event) => setReviewNote(event.target.value)}
                    />
                  </label>
                )}
                <button className="btn-start-sm" disabled={!canSave} onClick={() => { void saveCandidateDeck(); }}>
                  {saving ? "儲存中" : needsOverride ? "手動覆核另存" : "另存"}
                </button>
                {needsOverride && !reviewNote.trim() && <p className="dim small">填寫覆核理由後才可另存。</p>}
                {!candidateLegal && <p className="danger small">候選牌組未通過資料檢查（40 張／事件上限／卡片）。</p>}
                {existingDeck && <p className="danger small">這個名稱已存在。</p>}
                {saveMessage && <p className={saveMessage.startsWith("已另存") ? "win small" : "danger small"}>{saveMessage}</p>}
              </div>
              <div className="optimizer-note-block">
                <b>理由</b>
                {proposal.rationale.length > 0
                  ? proposal.rationale.map((entry, index) => <p key={index} className="small">{entry}</p>)
                  : <p className="dim small">沒有附加理由。</p>}
              </div>
              <div className="optimizer-note-block">
                <b>風險</b>
                {proposal.risks.length > 0
                  ? proposal.risks.map((entry, index) => <p key={index} className="small">{entry}</p>)
                  : <p className="dim small">沒有附加風險。</p>}
              </div>
              {proposal.cardPool && (
                <div className="optimizer-note-block">
                  <b>候選卡池</b>
                  <p className="small">同校 {proposal.cardPool.schools.join("/") || "未標記"}・共 {proposal.cardPool.poolIds.length} 張可考慮（含跨校允許 {proposal.cardPool.crossSchoolAllowed.length} 張）</p>
                  <p className="dim small">同校卡池僅為預設搜尋啟發，非合法性限制；混校構築合法，跨校候選請用 --allow（可指定單卡或整校）。</p>
                </div>
              )}
              {proposal.lockedCards.length > 0 && (
                <div className="optimizer-note-block">
                  <b>保護核心卡</b>
                  {proposal.lockedCards.map((entry) => (
                    <p key={entry.id} className="small">{cardLabel(db, entry.id)} 至少 {entry.minCount}</p>
                  ))}
                </div>
              )}
            </>
          ) : <p className="dim small">等待 proposal。</p>}
          {adoptions.length > 0 && (
            <div className="optimizer-note-block optimizer-history">
              <b>最近採納</b>
              {adoptions.slice(0, 5).map((record) => (
                <div key={`${record.savedAt}:${record.targetDeck}`} className="optimizer-history-row">
                  <span>
                    {record.targetDeck}
                    {record.optimizerAdoption?.manualOverride && <StatusPill tone="bad">手動覆核</StatusPill>}
                  </span>
                  <small className="dim">
                    {formatDate(record.savedAt)}
                    {record.optimizerAdoption?.sourceDeck ? `・${record.optimizerAdoption.sourceDeck}` : ""}
                    {typeof record.optimizerAdoption?.score === "number" ? `・Score ${formatScore(record.optimizerAdoption.score)}` : ""}
                  </small>
                  {record.optimizerAdoption?.reviewNote && <small className="dim">覆核理由：{record.optimizerAdoption.reviewNote}</small>}
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
