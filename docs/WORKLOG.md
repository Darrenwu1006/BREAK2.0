# 工作日誌（WORKLOG）

> 規則：每個工作階段（session）一節，記錄完成事項、未解問題、下一步。
> 若當日流量不足而中斷，最後一條必須寫清楚「中斷點」與「接手指示」。

---

## 2026-06-11 — Session 1：盤點與藍圖討論

### 完成
- 盤點現有資料（rule/pool/deck），結果記於 BLUEPRINT.md「資料現況」
- 確認官網 cardlist 為 JS 動態載入（Vue 模板），預期背後有 JSON API；官網有「ルール・Q&A」頁可抓判例
- 建立 docs/（本檔 + BLUEPRINT.md）
- 向使用者提出第一輪關鍵決策問題（技術形式/資料流/效果實作/AI 期望）＋細項問題

### 參考連結
- 官網卡表：https://www.takaratomy.co.jp/products/haikyuvobacabreak/cardlist/
- 官網規則/Q&A：https://www.takaratomy.co.jp/products/haikyuvobacabreak/rules/
- 使用者 Google Sheet 卡池：https://docs.google.com/spreadsheets/d/1C6X_JooFx6RwHz_vxJNZO5SAuRWruVWzctpWn7r39qk/edit?gid=1507637399#gid=1507637399

### 已定案（詳見 BLUEPRINT.md「已確認決策」）
- 本地網頁 App（TS+Vite+React+Node）／repo JSON 為主／AI 越強越好（引擎須支援 MCTS）
- 繁中為主缺譯顯日文／新卡自動機翻草稿+待校標記／卡圖爬回本地顯示
- deck/ 為使用者自製構築會持續改／**卡片編號為主鍵，稀有度（頂、頂P、S、N…）只是同卡的不同卡面版本，牌組編輯器可選卡面**

### 待自行查證（不需問使用者，讀 PDF/官網即可）
- Guts 機制完整規則（流程 txt 未提，應在 rules_general_v1.pdf）
- 構築規則細節：同名卡張數上限、Set 數勝利條件等（regulation_v1.pdf）
- rules_floorr_v1.pdf 內容定位（推測為フロアルール/賽事規定）
- 官網 Q&A 判例頁實際內容與格式（https://www.takaratomy.co.jp/products/haikyuvobacabreak/rules/）
- 官網 cardlist 背後的 JSON API 端點（用瀏覽器開發工具/直接試端點）

### 下一步（下個 session 從這裡開始）
1. M0：精讀 rule/ 三份 PDF → 產出 docs/RULES_SPEC.md（機器可讀的規則規格，含 Guts、構築規則、勝負條件）
2. M0：定義卡片 JSON schema（編號為主鍵、printings 陣列放卡面版本、日中雙語欄位、效果 DSL 欄位預留）
3. M0：CSV → JSON 匯入工具 + 專案腳手架（Vite + TS + Vitest）

### 中斷點
- 無（本日為討論階段，未開始實作，等待使用者放行開工）

---

## 2026-06-11 — Session 2：M0 完成＋M1 過半（使用者已放行開工）

### 完成
- **M0 全部完成**：
  - 精讀三份規則 PDF（總合ルール45頁全文、floor rule、regulation）→ 產出 docs/RULES_SPEC.md
  - 規則要點：無同名卡張數上限；「－」≠0；OP/DP 算出後與參數脫鉤；チェックプロセス為唯一觸發解決點；修正層順序 †6-10-1/†0-2-12；關鍵字ドシャット/ワンタッチ/ターン1
  - schema（src/data/types.ts）＋匯入工具（tools/import-csv.mjs）→ data/cards.json（194張）+ data/decks/
  - 腳手架 Vite+React+TS+Vitest；資料完整性測試 5 件全過；typecheck/build 全綠
- **M1 過半**：
  - 官網 API：`cardlist/itemsearch.php?p=N`（參數見 cardsearch.js：word/ser/aff/gra/pos/cat/vob/para/各參數min-max/p）
  - 已全量抓取 364 列 → data/raw/official_cards.json；本地缺 102 唯一卡號（P02×38, PR×35, P01×15, HVBP×14）
  - 本地卡池是官網嚴格子集（無幽靈卡）

### 發現/待確認
- **deck/ 內七個 CSV 是各校收藏卡表（45~138 張），不是 40 張構築**（檔名 All Cards）→ 已問使用者定位（候補池？持有清單？）
- 匯入警告：HV-P01-072/073 兩卡不同卡面的譯文措辭略異（意思相同），保留先出現者
- 官網 vobarity 值含「秘」「極」等；affiliation 格式為「烏野·1年」（含学年，合併時要拆）

### 下一步（依序）
1. M1 合併工具：official → cards.json（補 102 張新卡＋全卡補 skillJa/学年/name_ruby；新卡繁中機翻+machine 標記）
2. M1 卡圖：分析詳細頁（setLinkCard → card.php?）找圖檔 URL 規則，下載至 public/cards/
3. M1 判例：抓 /products/haikyuvobacabreak/rules/ → docs/RULINGS.md
4. M2 引擎開工（見 RULES_SPEC.md 第 10 節實作註記）

### 中斷點
- 無未完成的半成品；M1 合併工具尚未動工，從上面「下一步1」直接開始即可
- 環境：已 npm install；poppler 已裝（pdftotext 可用）；規則純文字在 /tmp/rules_general.txt（重開機會消失，可重新 pdftotext 產生）

---

## 2026-06-11 — Session 3：M1 完成

### 使用者回覆
- deck/（舊）＝各校**持有卡清單**，暫不做收藏功能；真正構築在 **decks/**（每校資料夾：40張軸構築、template.csv=全0候補模板、部分有 All Cards）。deck/ 可刪 → 先保留不匯入（日後做持有檢查可用），匯入來源改為 decks/（跳過 template 與 All Cards、count=0 列為候補卡靜默跳過）
- 特殊卡面（秘/極等）照單全收

### 完成（M1 全部）
- merge-official.mjs：官網 → cards.json，共 296 張。重點處理：
  - 本地 CSV 卡片名稱其實是繁中譯名 → 名稱不一致時移存 nameZh，nameJa 採官網
  - 所属欄正規化（分隔符 ·・･ 混用、逗號/斜線複數、官網 typo「梟谷2·年」修正表）→ affiliations[] + grades[]
  - 參數不一致以官網為準並警告（發現 HV-P01-049 猿杙大和 本地參數整列錯位）
- data/translations.json：70 張新卡技能機翻草稿（machine 待校）；merge 時自動套用，重跑不丟
- 卡圖 364/364 → public/cards/（32MB）；稀有度↔圖檔尾碼：頂→H、秘→I、極→K
- 判例 351 件 → data/raw/official_faq.json + docs/RULINGS.md（141 張卡有個別判例）
- 測試 7 件全過、typecheck 過
- 官方技能原文自帶 icon 標記（[=登場][=ターン1][=ドシャット(5)]…）→ M3 DSL 解析的天然 token
- ⚠ 新關鍵字（規則書 ver1.00 未收錄，由卡片補足文定義）：フェイント(4)、ブロックアウト(2)、ツーアタック(3)、Aパス(1) → M3 要從卡片詳細頁或判例補定義

### 下一步
1. M2 規則引擎：純函式狀態機（src/engine/）。順序：GameState 型別＋區域 → Phase/Step 狀態機＋CP 骨架 → 香草卡整場可玩＋引擎測試
2. M2 期間順手：把 RULES_SPEC 的 Phase 流程寫成測試（發球→Lost→Interval→Set輪轉→勝負）
3. 之後 M4 簡易對戰 UI（文字卡面＋卡圖）→ M5 AI → M3 效果系統逐張實裝（與 M4/M5 交錯）

### 中斷點
- 無半成品。M2 從零開始，先讀 docs/RULES_SPEC.md 第 5/10 節
- 待使用者校對：data/translations.json 70 張機翻（不阻塞 M2）；HV-P01-072/073 兩卡兩版本譯文擇一（匯入警告中）

---

## 2026-06-11 — Session 4：M2 規則引擎完成

### 使用者交辦
- GitHub repo：https://github.com/Darrenwu1006/BREAK2.0 — **只在使用者說「上傳到 git」時 push**，平常不主動 commit（已記入長期記憶）。本地尚未 git init

### 完成（M2 全部）
- src/engine/{types,rng,engine}.ts：純函式引擎，「推進到決策點停下」模式
  - 決策型別：serve-rights / mulligan / deploy-serve|block|receive|toss|attack / defense-choice / free(pass|lost) / pick-set-card
  - deploy null＝不登場＝自動 Lost（†1-4-9-1，發球回合可藉此放棄發球權）
  - RNG（mulberry32）狀態存於 GameState → 可重播；structuredClone 即可複製（MCTS 就緒）
- 測試 19 件全過：遊戲前手順、「－」不可登場、同名限制、OP/DP 算出與脫鉤、攔網側邊者進棄牌、接球/攔網失敗→Lost→Interval→Set輪轉、Set 0 張敗北、真實牌組隨機整場×5
- 注意：判定成功等無決策的子步驟會被引擎一路推進（測試斷言要看 pendingDecision 而非中間 phase）

### 設計筆記（M3 接入點）
- チェックプロセス：在 runUntilDecision 的各 phase/step 邊界呼叫（目前 no-op）；待機狀態佇列尚未建模
- 修正層系統尚未存在：calcOp/calcDp 直接讀卡面參數，M3 改為走 modifier pipeline
- 事件卡在 M2 是手牌死卡（free step 只有 pass/lost）

### 下一步
1. **M4 簡易對戰 UI 先行**（讓使用者可以實際玩到香草卡對局＝最早的可見成果）：盤面、手牌、決策按鈕、對戰 log、卡圖顯示
2. M5 第一版 AI（隨機→簡單啟發式）接上 UI 的對手座位
3. 然後回頭 M3 效果系統（DSL＋CP＋修正層），逐school實裝技能

### 中斷點
- 無半成品。下一步從 M4 UI 開始（src/App.tsx 目前是占位頁）

---

## 2026-06-11 — Session 5：M4 對戰介面第一版完成

### 完成
- src/ai/random.ts：隨機合法 AI（介面與引擎間的「決策提供者」契約，M5 直接替換內部）
- src/ui/{Game,CardView}.tsx + src/index.css + App.tsx 主選單：完整對戰 UI（細節見 BLUEPRINT M4）
- .claude/launch.json：`npm run dev`（port 5173）；Preview 實測整條 rally 流程正常
- 修正：建局換牌階段不顯示「Set 0 再Lost即敗北」誤導警告（Set 卡規則上是換牌後才配置）
- 全綠：tsc / vitest 19 件 / vite build

### 已知待辦（不阻塞）
- UI 第二版需求記在 BLUEPRINT M4 末行（技能互動等 M3 後）
- 手牌超過 ~10 張時橫向捲動，體驗可再優化
- AI 思考延遲固定 650ms，之後可加速度設定

### 下一步
1. M5 啟發式 AI：替換 randomAiDecision——防守選擇看 OP 與手牌攔網/接球質量；登場選點數效益最高且保留資源；可考慮淺層模擬
2. M3 效果系統（大工程，建議獨立 session 開工）：DSL schema → CP/待機佇列 → 修正層 → 逐校實裝＋判例測試
3. M6 牌組編輯器（可穿插）

### 中斷點
- 無半成品。`npm run dev` 即可遊玩香草對局

---

## 2026-06-11 — Session 6：規則修正（攔網選擇限制）＋規則書更新至 v1.03

### 使用者指正
- 「我方派出攔網球員後，對面不能也派攔網球員回應」→ 查證屬實且範圍更大：
  **對手的發球或攔網回球都不能選攔網，只有攻擊能攔**（rules_sheet_v1：「※相手のサーブやブロックでの返球に対しては、『ブロック』は選べません」）
- 重要教訓：**這條規則総合ルール v1.00~v1.03 都沒明文**（5-6-2②無限制），只寫在快速規則書。判例 Q498/Q500（OP 分サーブ/ブロック/アタック三種）與フェイント等關鍵字設計可佐證

### 完成
- 引擎：新增 `canChooseBlock()`（OP 來源=attack 才可攔網），defense-choice 驗證；AI 與隨機測試遵守；UI 攔網按鈕禁用＋提示文字；Preview 實測通過
- 測試重寫：攔網測試改走「發球→對手接攻→我方攔網」完整流程；新增「發球後不能攔」「攔網回球不能再攔」案例；19 件全綠
- **發現官方規則已更新**：下載 rule/rules_general_v1.03.pdf、rules_floorr_v1.03.pdf、rules_sheet_v1.pdf（快速規則書，之前沒有）
  - v1.01 新增關鍵字フェイントN/ブロックアウトN；v1.03 新增 AパスN/ツーアタックN（定義已入 RULES_SPEC 第 8 節）
  - v1.02/v1.03 其他變更：1-3-3-5/6 補足文/注釈文措辭、1-1-7 対象、7-8 比較表記、付表1 所属追加
- RULES_SPEC.md 更新：來源改 v1.03＋rules_sheet、5.1 攔網限制專節、關鍵字 7 個全列

### 待辦（下次）
- [ ] v1.02/v1.03 差分精讀（特別是 7-8 比較表記、1-1-7 対象——影響 M3 DSL 用語）
- [ ] 舊 v1.00 PDF 可刪（保留 v1.03）

### 下一步
- 同 Session 5：M5 啟發式 AI 或 M3 效果系統

### 中斷點
- 無半成品

---

## 2026-06-11 — Session 7：M5 啟發式 AI＋新增 M7 里程碑

### 使用者交辦
- 新增介面美化里程碑 → 已加為 **M7 介面美化與互動規劃**（使用者主導討論：版面工具、互動規劃；建議 M3 後啟動）

### 完成
- src/ai/heuristic.ts：啟發式 AI（策略見 BLUEPRINT M5）；對戰介面已改用（random.ts 保留給測試）
- src/ai/ai.test.ts：啟發式 vs 隨機 10 場（先後手各半）須勝 ≥7；實測 50 場勝 46（92%）
- 全綠：tsc／vitest 20 件（data 7＋engine 12＋ai 1）；Preview 實測 AI 會退事件卡、用最高發球點施壓

### 下一步（建議順序）
1. **M3 效果系統**（最大工程，開新 session）：
   a. 效果 DSL schema 設計（以官方 skillJa 的 icon 標記為 token：[=登場][=ターン1][=ドシャット(N)]…）
   b. 引擎接入：チェックプロセス正式化（待機佇列）、修正層（modifier pipeline）、スキルコスト、置換效果
   c. 關鍵字 7 個實裝 → 香草+關鍵字卡先動起來
   d. 逐校實裝技能（建議從烏野 D01/P01 開始）＋判例轉測試（docs/RULINGS.md 351 件）
2. M6 牌組編輯器（可與 M3 穿插，當 M3 寫累時的調劑）
3. M7 介面美化（等使用者開討論）

### 中斷點
- 無半成品。M3 開工前先重讀 RULES_SPEC 第 6 節與 data/cards.json 的 skillJa 樣態
