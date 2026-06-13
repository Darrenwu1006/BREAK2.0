---
name: update-card-pool
description: 從官網（takaratomy.co.jp バボカ!!BREAK）抓取新卡片描述、卡圖、判例並合併進遊戲資料、產生繁中翻譯草稿。當使用者說「幫我更新卡池」「補新卡」「新一彈出了」或要把官網最新卡片同步進專案時使用。卡池更新週期約 1~1.5 月。
---

# 卡池更新（update-card-pool）

把官網最新卡片同步進專案：抓取 → 合併 → 翻譯草稿 → 驗收。**這個 skill 只負責「卡片資料層」；技能效果化（effectStatus todo→dsl）是另一個 skill `implement-card-skills` 的工作，本 skill 結束時新卡停在 `effectStatus:"todo"`。**

## 先讀（自包含前提）

- `docs/WORKLOG.md` Session 1~3：M1 卡池建置的完整經過、官網 API、各 tools 用途、踩過的坑
- `docs/BLUEPRINT.md` M1 段＋「資料現況」
- `src/data/types.ts`：卡片 schema（主鍵＝卡片編號；printings＝卡面版本；日中雙欄位）

## 官網 API（M1 已驗證，2026-06 有效；官網改版可能失效）

- Base：`https://www.takaratomy.co.jp/products/haikyuvobacabreak/`
- 卡片列表：`cardlist/itemsearch.php?p=N`（分頁；參數見官網 cardsearch.js：word/ser/aff/gra/pos/cat/vob/para/各參數 min-max/p）
- 單卡：`cardlist/itemsearch_single.php?no=<卡號>&voba=<卡面>`
- 判例：`rules/itemsearch.php?cn=<卡號>`

## ⚠ 已知缺口（動工前先處理）

`tools/merge-official.mjs` 讀 `data/raw/official_cards.json`，**但 tools/ 裡沒有產生它的抓取工具**（M1 當時是一次性腳本，未留存）。更新卡池前必須先有 `tools/fetch-official-cards.mjs`：用上方 `itemsearch.php?p=N` 逐頁抓全量卡片 → 寫 `data/raw/official_cards.json`（格式參考現有檔的欄位）。**先建這個工具、跑通、確認新卡有進來，再往下。**

## 前置檢查（必做，失敗即停）

1. `curl -sS '.../cardlist/itemsearch.php?p=1'` 有正常回應且結構未變 → 否則官網改版，停下報告，**不要讓壞資料進 pipeline**
2. `git status` 乾淨或已知狀態（更新會改 data/，先確認沒有未提交的混雜）

## 步驟

1. **抓取**（增量、可重跑、已存在跳過）：
   - `node tools/fetch-official-cards.mjs` → `data/raw/official_cards.json`（新建工具，見上）
   - `node tools/fetch-faq.mjs` → `data/raw/official_faq.json`（判例）
   - `node tools/fetch-images.mjs` → `public/cards/{卡號}-{尾碼}.webp`（卡圖，已存在跳過）
2. **合併＋套用效果**：`npm run data:rebuild`（＝import-csv → merge-official → **apply-effects**，全鏈路冪等）
3. **判例可讀化**：`node tools/gen-rulings.mjs` → `docs/RULINGS.md`
4. **翻譯草稿**：新卡技能以 `{ "text": "...", "status": "machine" }` 寫入 `data/translations.json`，介面標示為「翻譯待確認」（merge 時自動套用、重跑不丟）；人工確認後把 `status` 改為 `human`

## 🔒 防呆（寫死，不可違反）

- **effect 唯一真實來源＝`data/effects.json`**。`cards.json` 的 effect 欄是衍生資料，由 `apply-effects` 產生。**永遠跑完整 `npm run data:rebuild`，絕不單跑 `import-csv` 或 `merge-official`**（單跑會把 effect/技能欄洗掉——M3 開工時踩過這個坑，skillJa 全失）。
- **這是增量更新，不是全量重建**：新卡標 `effectStatus:"todo"`（有技能）或 `vanilla`（無技能）；**既有卡的 effect、effectStatus、人工譯文一律不動**。
- 機翻只是草稿。**技能效果化以日文原文 `skillJa` 為準，不可用機翻譯文當規則**（那是 `implement-card-skills` 的事）。

## ✅ Acceptance Gate（builder 完成＝verifier 確認用同一份）

逐項機器可驗，全綠才算完成：

1. `npm run data:rebuild` 跑完無錯
2. **既有 dsl 卡的 effect 一張都沒掉**：`git diff data/cards.json` 不應出現「既有卡的 effect 變 null / effectStatus 從 dsl 退回 todo」。可用 `node -e` 比對 rebuild 前後 `effectStatus==="dsl"` 的卡集合（應只增不減）
3. **新卡全部 `effectStatus:"todo"` 或 `vanilla`**，沒有半成品 dsl
4. **卡圖數 = 卡號數**：`ls public/cards/ | wc -l` 對得上 `official_cards.json` 的卡面數
5. `npx tsc --noEmit` 與 `npx vitest run` 全綠（含 `dsl-validate.test.ts` schema 驗證）
6. 新增工具（如 fetch-official-cards.mjs）有註解、可重跑

## 交接（token 不足換手時）

每完成一步即一個斷點。中斷時在 `docs/WORKLOG.md` 開新節寫：完成到哪一步、`data/raw/` 與 `public/cards/` 現況、新卡卡號清單、下一步。下一棒讀 WORKLOG 接續。

## 完成後

新卡已進 `cards.json`（todo/vanilla）、卡圖到位、判例更新。**接著呼叫 `implement-card-skills`** 把 todo 卡效果化。在 WORKLOG 記錄本次新增卡號清單，供技能 skill 接手。
