# BREAK2.0 Agent Collaboration Protocol

本檔是所有 AI agent / model 進入此 repo 時的共同協作入口。  
適用對象：使用者、Codex、Claude、Gemini，以及後續其他模型。

## Before You Work

- 先讀 `docs/BLUEPRINT.md` 與 `docs/WORKLOG.md`，再開始規劃或修改。
- 如果任務涉及卡片效果，先讀 `docs/RULES_SPEC.md` 與 `docs/M3_DSL_ARCHITECTURE_REVIEW.md`。
- 如果任務涉及 AI / MCTS / 牌組分析，先讀 `docs/BLUEPRINT.md` 的 M5 與 M8。
- `docs/` 是本地協作文件，可能不在 git status 中出現；不要因此忽略它。

## Planning / Reasoning Budget

- 當使用者提出需求，且本輪會產出規劃、spec、架構判斷或跨模型交接文件時，agent 必須附上「推理等級建議」。
- 推理等級使用：低 / 中 / 高 / 超高。
- 建議內容需包含：建議等級、理由、可切分給不同模型接手的邊界。
- 目的不是追求最高推理，而是用足夠但不浪費的模型能力完成工作，讓不同模型接手時有清楚切分點。
- 若任務涉及規則引擎、AI / MCTS / Deck Analyzer、資料 schema、hidden-information、公平性測試，預設至少為「高」；除非能清楚說明為何可降低。

建議判準：

| 等級 | 適用情境 |
|---|---|
| 低 | 小 UI 文案、樣式微調、明確 bug、單檔修改 |
| 中 | 一般功能 spec、既有架構內新增 UI / 工具 / 文件 |
| 高 | 涉及規則引擎、AI、資料結構、跨模組狀態、測試策略 |
| 超高 | MCTS / optimizer / hidden information / 大型架構決策 / 多模型交接的核心 spec |

## Author Tags

任何新增規格、決策、待辦、架構判斷、實驗結果或工作紀錄，都必須標記來源。

允許的作者標記：

- `[使用者]`
- `[Codex]`
- `[Claude]`
- `[Gemini]`

建議格式：

```md
- [ ] [Codex 2026-06-16] 建立 MCTS rollout policy，Heuristic v2 作為 fallback。
- [Claude 2026-06-16] Review：此策略需補 hidden-information leakage 測試。
- [使用者 2026-06-16] 保留現有核心卡，不讓 optimizer 自動移除。
```

規則：

- 新增條目一定要標作者；修改既有條目時，若改變語意，也要加註作者與日期。
- 早期未標記條目視為共同歷史脈絡，不要為了補標而猜作者。
- 若是 review 意見，不要直接覆蓋原判斷；新增自己的 `[作者 日期] Review:` 條目。
- 若是實作完成，記錄「完成內容、驗證、剩餘事項」，不要只寫聊天式摘要。

## Durable Records

- `docs/BLUEPRINT.md`：里程碑、長期架構、跨模型交接規格。
- `docs/WORKLOG.md`：每次完成實作或重要決策後的 session log。
- 完成實作、重要文件規劃、架構決策後，都要同步更新 `docs/WORKLOG.md`。
- M5/M8 相關規劃需標清楚是「對局內決策」、「Coach Mode」、「Match Simulator」或「Deck Optimizer」，不要混成單一 AI 任務。

## Guardrails

- 不要覆蓋使用者或其他模型未提交的變更；先讀再改。
- 不要把 hidden-information AI 寫成偷看對手手牌、Set 或牌組順序。
- 不要直接覆寫使用者的 deck CSV；構築最佳化先輸出 proposal，經確認後再寫入。
- 新 DSL primitive 必須符合 `docs/BLUEPRINT.md` 的核心引擎 / DSL / Script 責任邊界。
