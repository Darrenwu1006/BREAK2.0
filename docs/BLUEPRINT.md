# 排球少年 バボカ!!BREAK — 專案藍圖

> 本文件是使用者與 Claude 的對接基礎。每次工作前先讀本文件與 WORKLOG.md。
> 狀態標記：⬜ 未開始 / 🟨 進行中 / ✅ 完成 / ⏸ 暫停待討論

## 專案目標

1. **對戰介面**：玩家 vs 電腦 AI 的完整對戰（瀏覽器操作）。
2. **卡池補完工具**：從官網（takaratomy.co.jp）抓取卡片資料，比對並補齊本地卡池缺漏。
3. **牌組維護介面**：使用者友善的牌組編輯器（瀏覽卡池、篩選、合法性檢查）。

## 核心設計原則（針對可擴充性）

- **效果即資料（Effect as Data）**：卡片效果以結構化 DSL 描述（trigger / cost / condition / target / action / duration），由規則引擎統一解讀。無法用 DSL 表達的特例卡才寫獨立腳本，並逐步把常見模式回收進 DSL。
- **分層的數值修正系統**：點數修正（+1/-1、設為X、持續到回合結束…）採用修正層（modifier layers），固定順序套用，避免效果互相打架。
- **判例＝測試案例**：官網 Q&A／判例逐條轉成引擎的單元測試，保證裁定行為永遠正確，重構不破壞。
- **引擎與 UI 完全分離**：引擎是純函式狀態機（state in → events out），UI 和 AI 都只是引擎的消費者。

## 已確認決策（2026-06-11 與使用者定案）

| 項目 | 決策 |
|---|---|
| 應用形式 | 本地網頁 App：TypeScript + Vite + React，`npm run dev` 啟動；小型 Node 後端讀寫本地檔案 |
| 資料主來源 | repo 內 JSON 為唯一真實來源；現有 CSV 一次性匯入；Google Sheet 退為個人瀏覽用 |
| 卡片主鍵 | **卡片編號**（同編號＝同效果）。不同卡面（稀有度 頂/頂P/S/N…）是同一張卡的「印刷版本」，各自有稀有度＋卡圖；牌組編輯器可選卡面 |
| AI 期望 | **越強越好** → 引擎設計為純函式、狀態可快速複製，支援 determinized MCTS（隱藏資訊搜索）；先做啟發式，再上搜索 |
| 顯示語言 | 繁中為主，缺譯名時顯示日文；schema 保留日中雙欄位 |
| 翻譯流程 | 爬蟲補進的新卡自動產生繁中翻譯草稿並標記「機翻待校」，使用者在介面中校對解除 |
| 卡圖 | 從官網爬回本地（僅個人使用），對戰與牌組編輯介面顯示 |
| deck/ 七副牌組 | 使用者自製構築、會持續修改 → 編輯器須無損讀入並回寫 |
| 測試框架 | Vitest（規則引擎 + 判例測試） |

## Milestones

### M0 — 資料基盤與規格定稿 ✅（2026-06-11）
- [x] 關鍵決策定案（見「已確認決策」）
- [x] 精讀 rule/ 三份 PDF → docs/RULES_SPEC.md（實作導向規格，含條文編號可回溯）
- [x] 卡片資料 schema：src/data/types.ts（編號為主鍵、printings 卡面版本、日中雙語、效果 DSL 欄位預留）
- [x] 匯入工具 tools/import-csv.mjs：pool+deck CSV → data/cards.json + data/decks/*.json（194 張卡）
- [x] 腳手架：Vite + React + TS + Vitest；`npm run dev / test / typecheck / build / import:csv` 全部可用
- ⚠️ 發現：deck/ 內是各校收藏卡表（45~138 張），不是 40 張構築 → 待使用者確認定位

### M1 — 卡池補完工具 ✅（2026-06-11）
- [x] 官網 API：`cardlist/itemsearch.php?p=N`（列表）、`itemsearch_single.php?no=&voba=`（單卡）、`rules/itemsearch.php?cn=`（判例）
- [x] 全量抓取 → data/raw/official_cards.json（364 列＝296 唯一卡號）
- [x] 合併工具 tools/merge-official.mjs → data/cards.json 296 張（新增 102；nameJa/skillJa/学年/讀音/卡面清單以官網為準；本地譯名保存於 nameZh/skillZh）
- [x] 機翻草稿：data/translations.json 70 張（skillZhStatus=machine 待校；重跑 pipeline 不會丟失）
- [x] 卡圖 364 張全數下載 → public/cards/{卡號}-{圖檔尾碼}.webp（tools/fetch-images.mjs，可重跑續傳）
- [x] 判例 351 件（通用20＋個別331）→ data/raw/official_faq.json ＋ docs/RULINGS.md（tools/fetch-faq.mjs / gen-rulings.mjs）
- 資料 pipeline：`npm run data:rebuild`＝import-csv → merge-official（含機翻套用），全程可重跑

### M2 — 規則引擎核心 ✅（2026-06-11）
- [x] 遊戲狀態模型 src/engine/types.ts：10 領域、疊放區（頂=キャラ、下=ガッツ）、OP/DP 為脫鉤獨立值、純資料可 structuredClone
- [x] 引擎 src/engine/engine.ts：createGame/applyDecision，「推進到決策點停下」模式（pendingDecision），UI 與 AI 都是決策提供者
- [x] Phase/Step 狀態機全流程：遊戲前手順（發球權/換牌/Set卡）、發球回合、攔網軸、接球軸、End、Lost/Interval、Set 輪轉、勝負
- [x] 登場限制（「－」不可登場、攔網同名禁止、托球≠接球同名、攻擊≠托球同名）、可重現 RNG（狀態內嵌）
- [x] 測試 19 件：腳本化情境＋真實牌組隨機整場模擬×5 種子（每決策點驗 40 張不變量）
- ⚠ チェックプロセス目前為 no-op 占位（M2 無被動技能），M3 在各 phase/step 邊界正式接入 †5-4

### M3 — 效果系統 ✅ 主體完成（2026-06-13，全 7 校＋混合牌組 100% 實裝）
- [x] 效果 DSL（src/engine/dsl.ts）：trigger/cost/condition/target/action/duration；**effect 唯一真實來源＝data/effects.json**，tools/apply-effects.mjs 併入 cards.json（data:rebuild 末端，重跑不丟）
- [x] 引擎接入（src/engine/effects.ts＋engine.ts）：チェックプロセス待機佇列（turn player 優先 †5-4）、修正層 modifier pipeline（calcOp/calcDp 走 effParam）、遲發監看（watch）、登場限制（restrict）、置換效果（072/073 登場改名）、自由步驟技能/事件、スキルコスト與 gate 分歧（†7-7-3）
- [x] 7 個關鍵字全實裝＋測試（ドシャット/ワンタッチ/フェイント/ブロックアウト/ターン1/Aパス/ツーアタック）
- [x] 烏野 18 張技能卡＋072/073＋他校關鍵字卡 6 張（共 33 張 effectStatus=dsl）；逐張行為測試
- [x] 判例→測試 27 件（Q 編號命名，karasuno.test.ts）；測試合計 49 件全綠
- [x] 完成定義達成：烏野牌組 vs AI 技能全生效完整對局（引擎測試×3 種子＋Preview 實測）
- [x] 音駒預組 D02 全實裝（2026-06-12：allyDeploy/chooseOne/lookTopTutor/灰羽移動＋登場限制 turn 累計化）
- [x] 青葉城西全實裝（2026-06-12：forceDrop 對手自選/banHandAdd 禁入手/handAddByEffect 監看/gutsAny/dropToHand/複數 areaIcons）
- [x] 稲荷崎全實裝（2026-06-13：どんぴしゃり連鎖 deployFromGuts+deployedByCard、tilt 無狀態 cost、eventAreaToHand、negateCenterBlock/banOneTouch 等 4 種限制）
- [x] 梟谷全實裝（2026-06-13：covered 被蓋觸發 †1-2-15-2-1、opponentLost＋lostSet 二段化 Q324、gutsFrom 複數區/millDeck/dropChara cost）
- [x] 白鳥沢／伊達工業／混合全實裝（2026-06-13：setParam 固定值、coinFlip、blockFailIfDpMax 追加失敗條件 †5-15-3、millTopAll、dropOpponentGuts、moveGutsToArea、青根置換 side 登場）
- [x] **全 14 副牌組用到的 125 張卡 100% 實裝（effects.json 98 張 dsl）；7 校＋混合皆可全技能對局**
- [ ] 長尾補完：剩 94 張無牌組使用的卡面變體（低優先，使用者組新牌時再補）
- [ ] 非烏野判例轉測試（剩餘 ~300 件，隨實裝逐批）
- [ ] 特例卡腳本機制（目前 DSL 已涵蓋全部烏野卡，待遇到表達不了的卡再開）

### M4 — 對戰介面（玩家 vs AI）✅ 第一版（2026-06-11）
- [x] 主選單：牌組選擇（data/decks 全部 14 副）→ 開戰
- [x] 盤面：雙方五區（含攔網中央/側邊）、Set/牌組/棄牌/事件區計數、OP/DP、phase 高亮、卡圖、滑過看詳情（含機翻標記）
- [x] 決策列：發球權/換牌多選/防守選擇/各區登場（不可登場的手牌變暗）/攔網 1~3 張多選＋中央指定/Pass/Lost/撿 Set 卡
- [x] 對戰 log 面板（中文敘述、自動捲動）；對手＝隨機 AI（src/ai/random.ts，M5 替換）
- [x] Preview 實測：完整 rally（發球→接球判定→托攻→電腦攔網→side blocker 進棄牌）全流程正常
- [x] 第二版（2026-06-12）：自由步驟技能/事件按鈕、效果決策（確認/選卡/選項/解決順序）、072/073 登場選名（單獨登場可手選；攔網多選自動配名）
- [ ] 待 M7 討論：修正值顯示在卡面（目前只在 log）、攔網多選的手動選名

### M5 — 電腦 AI 🟨（啟發式完成 2026-06-11）
- [x] 啟發式 AI src/ai/heuristic.ts：防守選擇評估（接得住→接球；否則攔得住→攔網）、防守用最小夠用卡/進攻用最大點數、註定失敗不登場省牌、換牌退事件卡
- [x] 對戰驗證：vs 隨機 AI 勝率 92%（46/50，先後手各半）；測試門檻 7/10
- [🟨] M3 後第一步已接：AI 合法處理全部效果決策（gate 一律接受、有事件/技能就用、保底選卡）；價值判斷（何時開技能、Guts 管理）待做
- [ ] 強化：determinized MCTS（引擎已就緒：純資料狀態+內嵌 RNG）

### M6 — 牌組編輯器 ✅ 第一版（2026-06-11）
- [x] 卡池瀏覽：篩選（學校/類型/全文搜尋含技能文字）、卡圖牆、滑過看詳情
- [x] 牌組編輯：點擊加卡、+/−/移除、合法性即時檢查（40張、事件≤8）、選卡面（稀有度下拉）、候補列（0張）保留
- [x] 存回 decks/<學校>/<牌組>.csv：與使用者原格式相容＋選填「卡面」欄；Vite dev server 內建 /api/decks（GET/POST）
- [x] 對戰選單改吃 API：存完即可選用新牌組
- [ ] 待補：進階篩選（位置/點數區間/稀有度）、機翻校對流程（在詳情面板校對 translations.json 解除待校標記）→ 可併入 M7 討論

### M7 — 介面美化與互動規劃 ⬜（使用者主導）
- [ ] 與使用者討論整體介面設計：版面配置、視覺風格
- [ ] 盤面工具規劃：哪些資訊常駐／浮動（棄牌區瀏覽、Guts 查看、judge 預覽、回合歷史…）
- [ ] 互動規劃：拖放登場、動畫節奏、AI 速度控制、快捷操作
- [ ] 啟動時機：M3 效果系統接入後（屆時互動需求才完整）；設計細節以使用者討論為準

## OPEN QUESTIONS（待使用者回覆）

見 WORKLOG.md 各日紀錄。已確認的決策會移到上方對應段落。

## 資料現況（2026-06-11 盤點）

- `rule/`：遊戲流程整理 txt（完整 phase/step 結構）＋官方 PDF ×3（general / floor rule / regulation）
- `pool/`：All_Characters.csv 170 筆、All_Events.csv 40 筆；涵蓋 HV-D01(10)/D02(10)/D03(11)/P01(73)/P02(47)/PR(17)
- `deck/`：七隊（烏野/音駒/青葉城西/白鳥沢/稲荷崎/梟谷/伊達工業），格式為 卡名+編號+數量
- 官網 cardlist：JS 動態載入（Vue），有搜尋 API 參數（所屬/學年/位置/類別/點數範圍），有「ルール・Q&A」頁
- 使用者維護的 Google Sheet 卡池（連結見 WORKLOG 2026-06-11）
