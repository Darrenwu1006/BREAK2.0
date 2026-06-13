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
- 繁中為主缺譯顯日文／新卡自動產生翻譯草稿＋待確認標記／卡圖爬回本地顯示
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
- data/translations.json：70 張新卡技能翻譯草稿（當時為 machine 待確認）；merge 時自動套用，重跑不丟
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

---

## 2026-06-11 — Session 8：git 初始化＋平行 session 規劃＋M6 牌組編輯器

### 使用者交辦
- M3、M7 開獨立 session（已建 2 個 task chip：M3 效果系統、M7 介面美化討論——M7 建議等 M3 完成再點）
- M6 留在本 session 處理 → 已完成第一版

### 完成
- **git init**＋首個 commit `11dae1e`（平行 session 的前提；只在本地，使用者說「上傳」才 push 到 github.com/Darrenwu1006/BREAK2.0）
- **M6 牌組編輯器**（細節見 BLUEPRINT M6）：
  - vite.config.ts 內建 /api/decks（GET 讀 decks/ CSV 含候補列；POST 寫回，檔名防穿越）
  - src/ui/DeckEditor.tsx：卡池牆＋篩選＋牌組面板＋合法性＋卡面選擇＋候補保留
  - App.tsx 改 API 載入牌組（import.meta.glob 移除）；主選單加「牌組編輯」
  - CSV 寫回格式：卡片名稱,卡片編號,數量,卡面（與原格式相容，importer 照常）
  - Preview 實測：載入「烏野-日影攻擊軸」40/40 事件8/8 正常；API round-trip（含卡面欄）通過；測試檔已清
- 全綠：tsc／vitest 20 件

### 注意（平行 session 協調）
- M3 session 會動 src/engine/ 與 data/cards.json 的 effect 欄；本 session 後續若再動 UI，留意合併
- decks/ 的 CSV 現在由編輯器寫入：欄位多了「卡面」（選填），舊檔案不受影響

### 下一步
- 本 session：M6 待補項（進階篩選、翻譯確認流程）或等使用者回饋
- M3/M7：等使用者點 chip 開工

### 中斷點
- 無半成品

---

## 2026-06-12 — Session 9：M3 效果系統（進行中）

### 工作方式（使用者指示）
- M3 拆小塊（B1~B7，見下），每塊結束 tsc+vitest 全綠＝可收工點；token 吃緊就停在塊邊界，WORKLOG 只記進度，接手不重查規則

### 已完成
- **資料事故修復**：發現 data/cards.json 曾被單獨重跑 import-csv 蓋掉（294→194 張、skillJa 全失）。`npm run data:rebuild` 還原（296 張）。教訓：effect 等衍生資料不能只存 cards.json
- **M3-a 效果 DSL**：
  - src/engine/dsl.ts：DSL 型別（trigger/cost/condition/target/action/duration）
  - data/effects.json：33 張卡 DSL（烏野 18 技能卡＋072/073 改名置換＋關鍵字卡 HV-D02-002/P01-041/P01-060/P01-068/PR-022/P02-067）
  - tools/apply-effects.mjs 接入 data:rebuild 末端（effect 唯一真實來源＝effects.json，重跑不丟）
- **規則語義定案**（判例佐證，已固化在 dsl.ts/effects.ts 註解，不用重查）：
  - [=登場] 等 icon＝パッシブ型誘發（強制待機→CP 解決；Q210 強制、Q332 同時觸發任選序、Q353 在事件卡前）
  - 「Nガッツ払えば使える／～の場合に使える」＝解決時 gate 分歧（†7-7-1+7-7-3），「〔…〕：」才是宣言 cost（†1-3-5，只有 P01-013 型）
  - 烏野相關判例 49 件已篩出（official_faq.json 過濾 card_no）；卡名要正規化（官網「山口　忠」全形空白）
  - イベントエリア卡片永久堆積（無清理規則）；事件卡被ターン1無效仍可 play（Q300）
- **types.ts 擴充**：modifiers/nameOverrides/watchers/restrictions/pendingQueue/turn1/effectCtx/lostRequest；新決策型別 free(skill|event)/resolve-pending/effect-confirm/effect-cards/effect-option、deploy 帶 nameChoice
- **src/engine/effects.ts**：DSL 解釋器全量（觸發/CP佇列/gate/修正層/關鍵字展開/跳過進行/效果子決策）

### 中斷點（若本 session 在此中止）
- effects.ts 已寫完但**尚未編譯**；engine.ts **尚未接入**（還是 M2 版）
- 下一塊 B1：改 engine.ts——deploy 走 effects.deployCard、主迴圈頭部接 effectCtx/pendingQueue/lostRequest、block/receive 的 judge 拆成 比較→CP→消滅、end phase 接 enqueueTurnEnd+cleanupTurn、lostSet 接 clearSetScoped、applyDecision 加新決策分支（委派 effects.applyEffectDecision/useSkill/playEvent/startPendingItem）、deployableUids 加 restrictions+nameOf、calcOp/calcDp 改 effParam
- B2：AI（src/ai/random.ts、heuristic.ts）處理新決策型別；B3~B5 測試；B6 UI；B7 驗收
- **B1 引擎接入完成**：engine.ts 全面接 effects.ts（deployCard 觸發/CP 迴圈頭/judge 拆步+blockSuccess/end phase turnEnd 迴圈+cleanup/lostSet clearSetScoped/新決策分支）；deployableUids 接限制與改名
- **B2 AI 合法化完成**：random/heuristic 處理 resolve-pending/effect-confirm/effect-cards/effect-option＋登場選名（src/ai/util.ts 共用 selectBlockers/pickDeployName；effects.autoPickCards 保底選卡）
- B1+B2 驗證：tsc 綠、20 測試全綠（含烏野真實牌組隨機整場——效果決策已在模擬中跑動）
- **B3 關鍵字完成**：7 個關鍵字整合測試全綠（src/engine/effects.test.ts，真實卡＋情境構造 helpers grab/seedStack/placeOnStack/setHandSize）；連帶驗證 gate/Guts 支付/CP/修正層進 OP/跳過進行/登場限制
- **B4+B5 測試完成**：src/engine/karasuno.test.ts 21 件＋effects.test.ts 7 件。烏野 18 張技能卡逐張行為測試全綠；判例轉測試 27 件（Q190/199/200/201/202/203/204/205/207/208/210/211/212/214/215/279/280/285/294/295/297/298/300/302/303/305/306，測試名含 Q 編號）。共用情境構造 helpers 在 src/engine/testkit.ts。全套 48 測試綠
- **B6 UI＋AI 最低限度使用完成**：
  - Game.tsx：自由步驟技能/事件按鈕（綠色）、effect-confirm/cards/option/resolve-pending 決策列、072/073 單獨登場手選卡名（攔網多選自動配名）；CSS btn-skill/effect-cards-row
  - heuristic AI：mulligan 不再退事件卡；自由步驟有事件/技能就用（價值判斷留 M5）；發現並修復「未實裝 DSL 的事件卡被 freeOptions 提供」bug（音駒卡 effect=null → playEvent 炸）
- **B7 驗收完成**：
  - 引擎側：烏野日影 vs 烏野山月、雙方啟發式 AI、3 種子完整對局（效果決策>0、40 張不變量、勝負分出）
  - Preview 實測（烏野日影 vs 山月）：ターン1事件、オープン攻撃抽2棄1選卡、AI 山口遲發效果 debuff 我方西谷托球（−2→負值進 OP）、AI 的月島・黒尾自動選名登場，console 零錯誤
  - 全套 49 測試綠、tsc 綠
- **M3 完成定義達成**。BLUEPRINT M3 改 🟨核心完成（剩：他校逐校實裝＋其餘判例）；M4 第二版打勾

### 下一步（建議順序）
1. M3 續：逐校實裝（音駒 D02/P01-017~ 起，模式與烏野高度重複，DSL 詞彙不足再擴充）＋該校判例轉測試
2. M5：技能使用的價值判斷（何時開 gate、Guts 管理、事件卡時機）→ 之後 MCTS
3. M7：介面美化討論（修正值顯示在卡面、攔網選名 UI 等已記在 BLUEPRINT M4/M7）

### 中斷點
- 無半成品。全綠可收工；`npm run dev` 即可玩烏野技能對局
- 注意：cards.json 由 pipeline 產生，改效果一律改 data/effects.json 再 `npm run apply:effects`（或 data:rebuild）

---

## 2026-06-12 — Session 9 續：M3 逐校實裝——音駒預組完成

### 完成（N1~N3 全部）
- **DSL 詞彙擴充**（src/engine/dsl.ts）：
  - PassiveTrigger 增 `allyDeploy`（「自分のキャラが登場した時」，D02-004 灰羽型）
  - Condition 增 `selfArea`（「このキャラがアタックキャラの場合」）
  - Action 增 `lookTopTutor`（看頂N張檢索，D02-012）、`chooseOne`（▶選一使用，D02-011）、`moveSelfToBlockSide`（灰羽移動）
  - **登場限制改為 turn 累計上限**：state.blockDeployedThisTurn 計數（Q191/Q196/Q204——效果登場也計入額度）
- **音駒 D02 預組 7 張實裝**（effects.json 共 39 張）：D02-001 孤爪/003 夜久/004 灰羽/009 芝山/011 手は前/012 物理攻撃（002 黒尾前批已做）
- **測試**（src/engine/nekoma.test.ts 7 件）：判例 Q192/Q195/Q196/Q197/Q198 全轉測試；音駒預組 vs 烏野預組雙啟發式完整對局×2 種子
- **修復**：engine.test.ts 煙霧測試的 M2 時代內建決策器不認得效果決策（灰羽 allyDeploy 造成 resolve-pending）→ 改用正式 randomAiDecision
- 全綠：tsc／vitest 56 件（data7＋engine12＋effects7＋烏野22＋音駒7＋ai1）

### 語義筆記（已固化在程式碼）
- Q195：ガッツ未指定時從技能卡所在區支付（gutsFor 既有行為）
- Q196：登場限制下 gate 的 cost 照付、移動 action 單獨失敗
- 灰羽 allyDeploy 與中央卡自身被動同時待機 → resolve-pending（turn player 選順序）

### 下一步
1. 逐校實裝下一批：青葉城西（P01-036~043）或 D03 白鳥沢/梟谷預組（建議照使用者常用牌組優先）
2. M5 技能價值判斷／M7 介面討論（同前）

### 中斷點
- 無半成品。音駒預組可全技能對局

---

## 2026-06-12 — Session 9 續２：M3 逐校實裝——青葉城西完成

### 完成
- **DSL 詞彙擴充**（dsl.ts/types.ts/effects.ts）：
  - Cost：`gutsAny`（自分のコートから合計N、任意組合 Q315）、`dropFromHand` 帶所属 filter
  - Condition：`handMin`；Action：`draw` 加 `upTo`（「N枚まで引く」）、`drawToHandSize`、`dropToHand`（棄牌區回收；Q409 含剛付的 cost）、`forceDrop`（**對手自選棄牌——Awaiting 新增 chooser 欄位，決策者可以不是效果 master**）
  - DelayedTrigger：`handAddByEffect`（「引く以外の方法で手札に加えるたび」Q321；每張觸發一次 Q317）
  - Restriction：`banHandAdd`（「スキルでカードを手札に加えられない」P01-035；Q240 檢索強制置底、Q241 連事件抽牌都禁；area 改 optional）
  - SkillDef：areaIcon → **areaIcons 複數**（P01-033 [=サーブエリア][=トスエリア]；effects.json 既有 24 處已遷移）
- **青葉城西 11 張實裝**（effects.json 共 50 張）：P01-033/035/039/085/086/087/088、P02-056/057/058、PR-025（041 國見前批已做；042/PR-007/PR-008 香草）
- **測試**（src/engine/aoba.test.ts 10 件）：判例 Q238/239/240/241/246/315/317/319/409/410 轉測試；青葉城西二彈改 vs 快攻軸完整對局×2 種子
- 修復：restrict handler 漏複製 banHandAdd 欄位
- 全綠：tsc／vitest 66 件

### 下一步
- 逐校實裝剩餘：白鳥沢／稲荷崎（D03＋P02-0xx，含「どん ぴしゃり」效果登場連鎖 Q332 系）／梟谷／伊達工業
- M5 技能價值判斷／M7 介面討論（同前）

### 中斷點
- 無半成品。青葉城西兩副牌組可全技能對局

---

## 2026-06-13 — Session 10：M3 逐校實裝——稲荷崎完成

### 完成（I1~I3 全部）
- **DSL 詞彙擴充**：
  - Cost：`handToDeckBottom`（手牌置底 D03-002）、`placeEventFromHand`（置事件卡不發動技能 Q337/Q344）、`gutsFrom`（指定區付ガッツ D03-012）、`tilt`（「斜めにする」＝純物理動作無狀態 **Q375**）
  - Condition：`deployedByCard`（「どんぴしゃり」のスキルで登場 P02-016/020）、`dropDistinctNames`（棄牌區卡名異種數 Q359/Q360 限キャラ）、`addedThisSkill`（「3枚加えた場合」P02-089）
  - Action：`eventAreaToHand`（事件區回收不限頂牌 Q331/Q368、then=「加えた場合」）、`handToDeckBottom`、`deployFromGuts`（ガッツから登場、byCard 標記）
  - Restriction 新旗標×4：`fromHandOnly`（「手札から」限定計數，新增 blockHandDeploysThisTurn）、`negateCenterBlock`（中央攔網者ブロックP無視 Q372~374：DP 不加算＋修正不可、ワンタッチ仍可用）、`banOneTouch`（任意N Q356）、`banHandReceiveActive`（[=レシーブフェイズ][=手札]技無效 Q357）
  - CharaFilter：`positionsAny`（「WSかMBの」）
- **稲荷崎 18 張實裝**（effects.json 共 69 張）：D03-001/002/003/008/011/012/013、P01-065、P02-003/016/017/020/024/027/035/077/085/087/089
- **測試**（src/engine/inarizaki.test.ts 10 件）：判例 Q271/331/333/334/337/338/356/359/361/363/372 轉測試；**どんぴしゃり完整連鎖**（ガッツ雙子登場→016/020 追加效果→fromHandOnly 限制＋ワンタッチ無效）一次通過；六名軸 vs 預組完整對局×2 種子
- 全綠：tsc／vitest 76 件

### 語義筆記（已固化在程式碼）
- Q375：斜め（タップ）無遊戲狀態——cost 恆可付，不需 tapped 追蹤
- Q361/Q363：「ドロップに6種類」在付ガッツ之後判定（剛付的算數）→ DSL 寫成 gate{costs}→if{cond}
- deployedByCard 經 deployCard opts.byCard → PendingItem → ctx 一路傳遞

### 下一步
- 逐校實裝剩餘：白鳥沢／梟谷／伊達工業（牌組清單上還有混合學校「垃圾場」）
- M5 技能價值判斷／M7 介面討論（同前）

### 中斷點
- 無半成品。稲荷崎兩副牌組可全技能對局（0612測試 deck 只有 CSV 沒有 json——data:rebuild 會生成，不影響對戰選單）

---

## 2026-06-13 — Session 10 續：M3 逐校實裝——梟谷完成

### 完成
- **DSL 詞彙擴充**：
  - PassiveTrigger：`covered`（**被蓋成ガッツ時觸發**——「下にある場合」有效的技能 †1-2-15-2-1；木葉 P01-047；pendingValid 對此型放寬「須為キャラ」檢查）
  - DelayedTrigger：`opponentLost`（P01-090；**Q324：Lost 宣告時點不屬於任何回合**→ lostSet 拆兩步：①OP/DP消滅＋turn 期限限制即時失效＋ロスト時待機 →CP→ ③④清理；新 helper onLostDeclared）
  - Cost：`gutsFrom` 改複數區（「トスとアタックから合計4」Q251）、`millDeck`（デッキ頂棄N＝cost，ctx.milled 供 milledIs 判定）、`dropChara`（棄自家指定キャラ P01-091）
  - Condition：`gutsParity`（攻擊區ガッツ奇數 P01-043）、`milledIs`
  - lookTopTutor 加 affiliation 篩選（P01-089）；addOpponentOp 加 source==="attack" 檢查（卡面「アタックの」）
- **梟谷 7 張實裝**（effects.json 共 76 張）：P01-043/045/047/051/089/090/091
- **測試**（src/engine/fukurodani.test.ts 8 件）：判例 Q249/250/251/252/253/255/257/323/324/325；ワンタッチ実卡流程（鷲尾：mill cost→梟谷判定→OP−3→跳過攔網→Q257 同梯次待機消滅）；高爆發 vs 爆發二完整對局×2
- 全綠：tsc／vitest 84 件

### 下一步
- 剩白鳥沢（白板軸）＋伊達工業（攔網軸×2）＋混合學校垃圾場 → 全卡池 dsl 化收尾
- M5 技能價值判斷／M7 介面討論（同前）

### 中斷點
- 無半成品

---

## 2026-06-13 — Session 10 續２：M3 收尾——白鳥沢／伊達工業／混合完成（全牌組卡實裝）

### 完成（全 7 校＋混合）
- **DSL 詞彙擴充**（最後一批）：
  - Action：`setParam`（**修正層 set/add 依解決順序疊加** †0-2-12；P01-082「7にする」）、`coinFlip`（內嵌 RNG；天童 P02-048，Q402 任意隨機方式）、`millTopAll`（デッキ頂N全棄→全符合才 then；P02-041，Q395/396 可能な限り）、`dropOpponentGuts`（牛島 P02-046，Q400 master 選）、`moveGutsToArea`（白布 P02-050，Q405 任意區）、`deployFromGuts` 加 fromArea/then（P02-096）、`deployFromDrop` 加 side（サイドブロッカー登場）
  - Cost：`dropSelfFromCourt`（夜久 P01-023 被蓋時棄自身ガッツ）、`selfToDeckBottom`（青根 P02-037）
  - Condition：`chara` 加 minCount（P02-093「2人以上」）、`selfIsSideBlocker`（P02-037/038）、`paidGutsAll`（白布「払ったガッツすべてがS」）
  - CharaFilter：baseParamEq／notNames／effParamMin／effParamEq（Q457 用修正後值，且 centerBlock 無視時參照不可）／skillless（P02-041）
  - Restriction：`banPositions`（MB 登場禁止 P01-084/P02-097）、`blockFailIfDpMax`（**追加判定失敗條件** †5-15-3；二口 P02-039，Q393 判定時點、Q394 ワンタッチ優先）
  - gutsToHand 重寫支援 distinctNames＋affiliation（黒尾 P01-021，Q224）
  - **Q226 修正**：purgeModifiers 同時清 nameOverrides（072/073 離場/成ガッツ → 卡名還原）
  - **Q404 修正**：allCharas 空集合（0 人）不成立
- **最後 22 張實裝**（effects.json 共 **98 張，全牌組卡 100% 實裝**）：音駒 P01-021/023/031、伊達 P01-054/P02-037/038/039/041/042/090/091/093、白鳥沢 P01-056/P02-046/048/049/050/052/096/097
- **測試**（src/engine/shiratorizawa-date.test.ts 10 件）：判例 Q224/228/311/314/393/396/397/404/405；P02-041 牌組檢索→side 登場、P02-037 青根置換登場、P02-050 白布移ガッツ、天童硬幣；4 組跨校牌組（白鳥沢/伊達/混合）×2 種子完整對局
- **全綠：tsc／vitest 94 件；卡池 dsl 98＋vanilla 104＋todo 94（todo 全為無牌組使用的卡面變體）；7 校＋混合全部牌組可全技能對局**

### 下一步（M3 主體完成）
- 收尾選項：① 剩餘 94 張無牌組卡逐步補（低優先，等使用者組新牌再做）② M5 技能價值判斷（AI 強化）③ M7 介面討論
- 建議：M3 可標記為「主體完成」，剩餘是長尾補完

### 中斷點
- 無半成品。全 14 副牌組皆可全技能對局

---

## 📌 下次起點（使用者指定）：補完剩餘 94 張 todo 卡

> **開始補卡前先停下做架構回覆**：閱讀 `docs/M3_DSL_ARCHITECTURE_REVIEW.md`。使用者擔心未來「後排攻擊」等新詞綴使 DSL 與 `effects.ts` 難以維護。接手的 Claude 應先回覆 review 六題、分類 94 張卡的機制需求，再決定最小整理方案；不要直接開始大量新增 primitive。
>
> ✅ **review 六題已書面回覆**（見上方「2026-06-13 — Claude 對 M3_DSL_ARCHITECTURE_REVIEW 的書面回覆」節）；責任邊界已寫入 BLUEPRINT「核心引擎/DSL/Script」表。**補卡前順序改為下方 Step 0→1→2，不再「直接補」。**

**Step 0（補卡前，~半天）安全網——最小變更（兩項，與 review 一致；effects.ts 拆分降級延後）：**
1. `tools/apply-effects.mjs` 加 schema validation：walk 每張 effect，檢查 op/type 在白名單、必填欄位齊 → 拼錯立即報錯（現在要對局碰到才爆）。約 40 行
2. script registry：`SkillDef` 加 `{kind:"script",id}`；effects.ts 加 `Record<string,(db,state,ctx)=>void>` 查表；挑 1 張現有單卡 primitive（建議白布 P02-050 的 paidGutsAll，或天童 coinFlip）改寫成 script 當範例＋驗證。約 50 行

**Step 1（補卡前，~1hr）94 張機制分類（只分類不實作）：** 四類——①現有 DSL 可表達 ②需通用 primitive（須過 rule-of-three：服務≥3卡或對應規則明文）③需核心流程擴充（如後排攻擊→不猜，等規則） ④適合 script。

**Step 2（補卡，分批）** 多數套現有 DSL；新 primitive 過 rule-of-three 否則走 script；每批順手加跨效果不變量測試（禁止優先、modifier 清除、set/add 順序一致、turn player 優先、跳 phase 清理）。

**目標**：把目前 effectStatus=todo 的 94 張卡（無牌組使用的卡面變體）全部實裝成 dsl，達成「整個卡池 100% 效果化」。

**清單（94 張，跑 `node -e` 過濾 effectStatus==="todo" 可重新產生）**：
HV-P01-018/019/025/028/032/034/037/057/066/080/081/083/092/093、
HV-P02-001/002/004/005/006/007/010/011/012/014/021/025/029/031/036/051/060/061/062/064/066/070/071/073/074/076/078/079/080/081/082/083/084/086/088/092/094/095/098/099/100、
HV-PR-009/012/013/014/015/016/017/018/023/024/026/027/028/029/030/031/036/037/038/039/040/041/042/044/045/046/047/048/049/050/051/052、
HVBP-001/002/003/004/009/013/014

**做法**（沿用逐校節奏，但這次按「彈別/字母」分塊）：
1. 先 `node -e` 印出這 94 張的 skillJa，分群：哪些用現有 DSL 詞彙就能寫、哪些需要新 primitive
2. 多數應該是既有卡的不同卡面（同名異番）或同模式變體 → 可大量套用現成 DSL
3. 真正需要新詞彙的（估計 < 15 張）才擴充 dsl.ts/effects.ts
4. 每張至少一個行為測試或判例測試；相關判例在 official_faq.json（用 card_no 過濾）
5. 分塊收工：每塊 tsc+vitest 全綠

**注意**：
- effect 一律寫 data/effects.json，再 `npm run apply:effects`（絕不直接改 cards.json）
- 這些卡沒有牌組使用 → 「完整對局」驗收無法直接做，改用「合成牌組」測試（deckWith 塞滿）或純效果情境測試
- 完成後 BLUEPRINT M3 的「長尾補完」項打勾、effectStatus todo 應歸 0（只剩真正無技能的 vanilla）

### 中斷點
- 無半成品。從上面「下次起點」的步驟 1 開始即可

---

## 2026-06-13 — Claude 對 M3_DSL_ARCHITECTURE_REVIEW 的書面回覆

> 回應 docs/M3_DSL_ARCHITECTURE_REVIEW.md 的六題（review 要求書面回覆）。實測數據：effects.ts 1814 行/83 case、33 action op＋31 condition 服務 98 卡、被點名 primitive 多為 1:1。

**Q1 是否同意規模與耦合風險？** 同意，且數據佐證（上行）。但限定：這是「200+ 卡時兌現的債」，非現在的阻塞——目前擴充一校仍 1~2hr，耦合未拖慢開發。結論：該還，不必恐慌式重寫。

**Q2 哪些 primitive 通用、哪些改 script/小積木？** 反對「一律視為特化」，做三分類：
- 保留（規則層穩定概念，即使現只 1 卡）：`blockFailIfDpMax`（†5-15-3 追加失敗條件，建議改名 addFailCondition）、`negateCenterBlock`（無效化參照）、`covered`（†1-2-15-2-1 ガッツ技能）、`opponentLost`（觸發時點）、`milledIs`。
- 一般化成更小積木：`gutsParity`→`gutsCount`+比較運算子；`paidGutsAll`→通用「付出卡集合述詞」。
- script 候選（純 1 卡無規則普遍性）：之後若無第二張卡用，移 script。現不急搬。

**Q3 後排攻擊放哪？判斷標準？** 標準（採 review 清單）：改變「誰能當攻擊者／OP 組成／階段時序／防守回應」任一 → 核心引擎（擴 AttackContext）；只是條件式數值增減 → DSL；單卡怪交互 → script。後排攻擊大概率核心引擎（改變攻擊參與者）。**但無正式規則前不動、不猜語義。** 目前卡池無此卡。

**Q4 補卡前是否先建 registry/validation/拆分？最小方案？**
- schema validation：**是，補卡前做**。apply-effects.mjs 加 walk 檢查 op/type 白名單＋必填欄位。~40 行。
- script registry：**是，補卡前做**。SkillDef 加 `{kind:"script",id}`＋effects.ts 一個 `Record<id,(ctx)=>void>` 查表。~50 行＋首個 script 範例。
- handler 拆分（effects.ts→registry 目錄）：**否，延後**。單作者階段過早抽象，補完卡或遇 merge 痛點再做。

**Q5 如何避免每詞綴都改 dsl+effects+engine+UI+AI？** 現況其實已大幅收斂：純數值/選卡效果**已不需改** engine/UI/AI（走通用 effect-confirm/cards/option/resolve-pending 決策通道）。這幾批幾乎無新增決策型別＝good。對策：①DSL 新詞只改 dsl.ts+effects.ts（可接受的最小擴散）②嚴禁為單卡新增「決策型別」，複用現有 4 種 ③script registry 當逃生口。

**Q6 調整順序／影響／可延後？** 修正版（與 review 略異，把拆分降級）：
1.【補卡前 ~半天】schema validation＋script registry（安全網）— 影響：tools/＋dsl.ts/effects.ts 各小幅
2.【補卡前 ~1hr】94 張機制分類（不實作）
3.【補卡 分批】多數套現有 DSL；新 primitive 須過 rule-of-three，否則走 script；每批順手加跨效果不變量測試
4.【延後】effects.ts 漸進拆分（補完卡/痛點時）
5.【延後，取得正式規則後】後排攻擊等核心流程模型（不猜）
6.【延後】permanent 型一般化、duration 結構化

**與 review 的分歧（明確記錄）：** review 第 4 步「拆 effects.ts」我降級為延後項，理由＝過早抽象/YAGNI/單作者。其餘大方向認同。

**自我糾正：** 我上則 WORKLOG「下次直接補 94 張」是錯的（違反 review 的 acceptance：先分類/先安全網）。已採納，下次起點改為下節。

---

## 📌 進行中待辦（2026-06-13 使用者定案：把 M3 沉澱成可交接 skill spec）

> 背景：使用者要把卡池更新與技能建置做成 skill spec，讓**不同模型分別建置/檢驗**（測各模型規則建構能力），token 不足時換手。卡池更新週期 ~1.5 月，**下次 6/27**。決策：① verifier 不獨立、Gate 內嵌同一 spec ② 安全網由本次 Claude 先建 ③ 先落兩份 SKILL.md 給 codex 閱讀。
>
> ⚠ **token 防失憶**：以下 4 塊每塊獨立可交接，做完一塊即 tsc+vitest 全綠的斷點。換手時從未打勾的塊接續。

**塊 1 ✅ — 安全網：schema validation**（已完成 2026-06-13；dsl-schema.ts＋dsl-validate.test.ts 8 測試）
- [ ] `src/engine/dsl-schema.ts`：每個 action op / condition type / cost type 的必填欄位白名單
- [ ] `src/engine/dsl-validate.test.ts`：讀 effects.json 遞迴 walk，驗 op/type 在白名單＋必填欄位齊；拼錯立即 vitest 紅
- 完成判定：tsc+vitest 全綠，故意拼錯一個 op 會被抓到

**塊 2 ✅ — 安全網：script registry**（已完成 2026-06-13；{op:"script",id} action＋SCRIPTS registry＋3 contract test。註：採 action-level 非 kind-level，理由見下）
- [ ] dsl.ts：`SkillDef` 加 `{ kind:"script"; id:string }`
- [ ] effects.ts：`SCRIPTS: Record<string,(api)=>Action[]>` registry；script 回傳 Action[] 塞回 frame 重用解釋器（**不直接改 state**，符合 review）；在 startPendingItem/useSkill/playEvent 觸發點接入
- [ ] contract test：用注入的合成 script 卡證明機制通（不污染 effects.json）
- 註：現有 98 卡都能 DSL 表達 → **不硬搬現有卡**，只建機制；未來 paidGutsAll 等可在此搬遷
- 完成判定：tsc+vitest 全綠

**塊 3 ✅ — `.claude/skills/update-card-pool/SKILL.md`**（已完成 2026-06-13）
- [ ] frontmatter（name/description）＋章節：前置檢查 API 活著 → 抓取(itemsearch/faq/images) → `data:rebuild` → 翻譯草稿 → Acceptance Gate
- [ ] 防呆寫死：effect 唯一真實來源=effects.json、永遠跑完整 data:rebuild、6/27 是增量(新卡 todo 既有不動)
- [ ] Gate：既有 dsl effect 一張沒掉(diff)／新卡全 todo／卡圖數=卡號數／tsc+vitest 綠

**塊 4 ✅ — `.claude/skills/implement-card-skills/SKILL.md`**（已完成 2026-06-13）
- [ ] frontmatter＋章節：必讀(RULES_SPEC 6/8＋BLUEPRINT 責任邊界＋dsl 詞彙) → **強制分類決策樹**(動手前) → 寫法(只進 effects.json、skillJa 為準勿信機翻) → 判例轉測試 → 分塊 → 交接格式 → Acceptance Gate
- [ ] Gate：schema 通過／tsc+測試綠／該批全 dsl／每張≥1測試／新 primitive 寫明 rule-of-three 理由
- 依賴：塊 1+2 先完成（分類樹的「script 出口」要 registry 存在才不是空話）

**全部完成後**：BLUEPRINT 標記 skill 化完成；6/27 拿真實新卡，用不同模型跑 Skill A→B、比較規則建構能力。

---

## 2026-06-13 — Session 11：skill 化＋安全網（4 塊全完成）

### 完成
- **安全網 1（schema validation）**：`src/engine/dsl-schema.ts`（op/condition/cost 白名單＋必填欄位）＋`dsl-validate.test.ts`（8 測試）。拼錯 op / 漏欄位 / 白名單與 dsl.ts 飄移 → 立即 vitest 紅。接進既有 gate。
- **安全網 2（script registry）**：`{op:"script",id}` action（**非 kind-level**——多數怪卡是「效果內容怪」非「觸發機制怪」，action 級可重用既有觸發/CP/cost，侵入最小且 script 回傳 Action[] 不直接改 state，符合 review）；`effects.ts` 的 `SCRIPTS` registry（現空，98 卡皆能 DSL）＋`ScriptApi`；`script-registry.test.ts` 3 contract test（draw2 端到端／回傳 actions 仍走子決策／未知 id 立即 throw）。
- **兩份 SKILL.md**（`.claude/skills/`）：
  - `update-card-pool`：官網抓取→data:rebuild→機翻→Acceptance Gate。標明缺口：**tools/ 無產生 official_cards.json 的抓取工具**（M1 一次性腳本沒留），更新前需先建 `fetch-official-cards.mjs`。防呆寫死（effect 唯一真實來源、增量非全量、勿單跑 import-csv）。
  - `implement-card-skills`：靈魂＝**動手前分類決策樹**（核心引擎/DSL rule-of-three/script）＋寫法速查＋testkit 坑＋判例轉測試＋Acceptance Gate＋verifier 怎麼做。
- 全綠：tsc／vitest 105 件（新增 schema 8＋script 3）

### 設計決策記錄
- script 採 **action-level** 不 kind-level（理由見上；kind-level 留 YAGNI，遇怪觸發再加）
- effects.ts 拆分成 registry 目錄＝**延後項**（與 review 分歧，理由：單作者階段過早抽象）

### 下一步
- **6/27 卡池更新**：用 `update-card-pool`（先補 fetch-official-cards.mjs）→ `implement-card-skills`，可派不同模型跑、比較規則建構能力
- 仍未做：剩餘無牌組卡的 todo→dsl 補完（用 implement-card-skills 跑）；effects.ts 拆分（延後）；後排攻擊等核心流程（等正式規則）

### 中斷點
- 無半成品。兩個安全網＋兩份 skill 就緒，105 測試全綠

---

## 2026-06-13 — Session 12：70 張繁中技能翻譯確認完成

### 完成
- 70 張譯文比對後全部採用，沒有修改技能文字；確認紀錄整理至 `docs/TRANSLATION_REVIEW.md`。
- `data/translations.json` 改為 `{ text, status }` 結構，70 張狀態全數設為 `human`；`data/cards.json` 同步為 192 張 human、104 張 none、0 張 machine。
- `merge-official.mjs` 支援新結構與舊字串格式，重建資料時會保留人工確認狀態。
- 介面的待確認標示統一為「翻譯待確認」，供日後新增、尚未確認的譯文使用。
