---
name: implement-card-skills
description: 把卡片技能（effectStatus:"todo"）逐張實裝成效果 DSL（effectStatus:"dsl"），含官方判例轉單元測試。當使用者說「實裝技能」「把 todo 卡做完」「做某校的技能」「實裝新一彈技能」時使用。依賴安全網（dsl-validate.test.ts schema 驗證＋SCRIPTS registry）已存在。
---

# 卡片技能建置（implement-card-skills）

把 `effectStatus:"todo"` 的卡逐張寫成效果 DSL。**這個 skill 的靈魂不是「會寫 DSL」，而是「動手前先正確分類、不亂加 primitive、可被不同模型接手不飄移」。** 嚴格照流程，不要憑感覺擴充。

## 必讀（自包含前提，動工前讀完）

1. `docs/RULES_SPEC.md` 第 6 節（技能 4 型 / 效果 3 種 / 修正層順序）、第 8 節（7 關鍵字）、第 5.4 節（チェックプロセス）
2. `docs/BLUEPRINT.md` →「責任邊界：核心引擎 / DSL / Script」表（**這是分類決策的權威**）
3. `src/engine/dsl.ts`：現有 DSL 詞彙全集（先看有什麼積木，別急著造新的）
4. `src/engine/dsl-schema.ts`：白名單（新 primitive 要在這裡登記，否則 schema 測試會紅）
5. 既有測試 `src/engine/{karasuno,nekoma,aoba,inarizaki,fukurodani,shiratorizawa-date}.test.ts`：學情境構造手法
6. `src/engine/testkit.ts`：測試共用 helper

## 🧭 動手前：每張卡先過分類決策樹（不可跳過）

讀**日文原文 `skillJa`**（不是機翻 `skillZh`），逐張回答：

```
① 這張卡改變「核心回合流程」嗎？
   （誰能當攻擊者／OP 來源與組成／phase 時序／防守可做的回應／區域數量）
   ├─ 是 → 核心引擎工作。停下。若無正式規則（如「後排攻擊」語義不明）→ 不猜、不實作、回報使用者。
   └─ 否 → ②

② 能用現有 DSL 積木（dsl.ts 的 condition/action/cost）組合表達嗎？
   ├─ 能 → 直接寫 effects.json（最常見，多數卡屬此）
   └─ 不能 → ③

③ 需要的新 primitive 通過 rule-of-three 嗎？
   （能服務 ≥3 張卡或一整類未來效果，或對應規則明文概念，如 †5-15-3 追加失敗條件）
   ├─ 通過 → 新增 primitive（dsl.ts ＋ dsl-schema.ts 白名單 ＋ effects.ts handler），
   │         並在 WORKLOG 寫明重用理由與服務哪些卡
   └─ 不通過（只服務 1 卡、純句型）→ 走 script：{op:"script",id}，
             在 effects.ts 的 SCRIPTS registry 註冊（範例見 script-registry.test.ts）
```

**反模式（codex review 點名的風險）**：每遇到一個新句型就加一個 1:1 的專用 primitive（如 `paidGutsAll`）。這會讓 dsl.ts 變成另一套程式語言。寧可走 script。

## DSL 寫法速查

- **效果存哪**：只寫 `data/effects.json`（key＝卡號），然後 `npm run apply:effects` 併入 `cards.json`。**絕不直接編輯 `cards.json` 的 effect 欄**（會被 pipeline 洗掉）。
- **技能型對應 `SkillDef.kind`**：
  - `passive`（被動）：`[=登場]`等 icon→trigger `deploy`；「自分のキャラが登場した時」→`allyDeploy`；「下にある場合」→`covered`。areaIcons＝`[=サーブエリア]`等。
  - `active`（主動）：有使用時機 icon（`[=ドロー]`等→phaseIcons）＋通常 areaIcons `["hand"]`。
  - `event`（事件卡）：play 時機看 `card.timing`。
  - `deployNameChoice`（置換登場改名，如 072/073/宮兄弟）。
- **「ガッツ払えば使える／〜の場合に使える」＝ `gate`**（解決時的選擇性分歧 †7-7-3），**不是宣言 cost**。只有「`〔…〕：`」表記才是真 `cost`（宣言時付，付不出不能宣言）。
- **修正層**：`addParam`＝加減（†6-10-1）；`setParam`＝固定值（「Nにする」，後續 add 依解決順序疊加 †0-2-12）。「－」不受加減。
- **關鍵字**：`{op:"keyword",name:"ドシャット",n:N}` 等，引擎自動展開（dsl.ts KeywordName）。
- 不確定語義時查 `docs/RULES_SPEC.md` 條文編號（†x-x-x）回溯官方原文。

## 判例轉測試（每批都做）

- 來源：`data/raw/official_faq.json`，用 `card_no` 過濾出該卡判例
- 測試名含 **Q 編號**（如 `"Q199/Q200：..."`），對應 `docs/RULINGS.md`
- 每張實裝卡至少 1 個行為測試；有判例的逐條轉

### 兩層判例測試（相同規則不重複造整場對局）

1. **機制層，深度行為測試**：每個獨特機制至少一個完整情境，真正執行引擎並斷言卡片移動、數值、時序或禁止規則。既有逐校測試屬於這層。
2. **判例層，逐 Q 語意 contract**：官方每一個 Q 都要有獨立的 Vitest case；重複機制可共用 handler，但必須斷言對應 DSL / script / 引擎能力，**只檢查卡片存在或 schema 合法不算完成**。

目前非烏野總表在 `src/engine/non-karasuno-rulings.test.ts`：

- 依 `official_faq.json` 與 `cards.json` 的 affiliation 即時推導官方範圍，不手寫「還有幾件」。
- coverage gate 要求官方 Q ID 與 contract ID **完全相等、無缺漏、無重複**。
- 已有深度測試的 Q 可標為 `legacy`，但總表必須反向驗證該 Q 編號仍存在既有行為測試中。
- 官方 FAQ 更新後，新 Q 會先讓 coverage gate 變紅；先判斷是否屬於既有 contract，否則新增 handler 與至少一個機制層行為測試。
- 單獨驗證：`npx vitest run src/engine/non-karasuno-rulings.test.ts`

### testkit 用法＋常見坑

- `setup(deckA, deckB, serving)`：serving＝發球方（0 或 1）。`serveWith(s, cardId)`＝現任 turnPlayer 發球——**該卡必須在發球方牌組裡**（最常踩：發球方牌組沒放該卡 → 「不在牌組」。發球方無特定需求時用 `FILLER` 發球）。
- `grab(s,p,id)` 從牌組/手牌/Set區拿卡到手牌；`placeOnStack/placeInDrop/placeDeckTop/seedStack` 構造情境；`drainCp(s,accept)` 排空多個待機。
- 接球軸要接得住 OP，否則 Lost 進 interval（斷言會收到 `pick-set-card`）。
- `seedStack` 放的是ガッツ（頂牌才是キャラ）；要某張當ガッツ＋某張當頂，先 seed 再 `placeOnStack`。

## 分塊與交接

- **按學校/彈別分塊**，每塊收工＝`npx tsc --noEmit` ＋ `npx vitest run` 全綠。
- token 吃緊就停在塊邊界，`docs/WORKLOG.md` 開新節寫：本塊完成卡號、新增 primitive 及理由、未完卡號、下一步。下一棒讀 WORKLOG 接續。
- effect 改完一律 `npm run apply:effects`（或 `data:rebuild`）。

## ✅ Acceptance Gate（builder 完成＝verifier 確認用同一份）

逐項機器可驗，全綠才算完成：

1. `npx tsc --noEmit` 綠
2. `npx vitest run` 全綠——**含 `dsl-validate.test.ts`**（schema：無未知 op/type、必填欄位齊；白名單與 dsl.ts 同步）
3. 本批每張卡 `effectStatus:"dsl"`（`npm run apply:effects` 後確認；無半成品 todo 殘留）
4. 本批每張卡 ≥ 1 個測試；有判例者已轉（測試名含 Q 編號），且目標範圍的官方 Q ID 與 contract ID 完全相等
5. **新增的 primitive 在 WORKLOG 寫明 rule-of-three 理由**（服務哪些卡 / 對應哪條規則）；不滿足者應走 script
6. 跨效果不變量（每批順手驗，可加進測試或抽查）：禁止優先於允許 †0-2-6；卡離開有效區域後其 modifier 已清；同時待機 turn player 優先；跳過 phase 時該 phase 待機/到期效果正確處理；set/add 不同順序結果一致；卡不會憑空增減或同時存在多區（40 張不變量）

## verifier（不同模型檢驗）怎麼做

讀本檔「Acceptance Gate」章節→跑那些指令→全綠即過；再抽查 2~3 張卡的 effects.json 對照 skillJa 日文原文（語義是否正確、有無被機翻誤導）＋抽查新 primitive 是否真的過 rule-of-three（或該走 script）。**不做主觀「看起來對」，只認 Gate＋抽查。**
