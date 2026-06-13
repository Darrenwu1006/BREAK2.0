# M3 DSL 架構 Review：擴充性與長期維護風險

> 日期：2026-06-13  
> Review 對象：M3 效果系統（`src/engine/dsl.ts`、`src/engine/effects.ts`、`data/effects.json`）  
> 閱讀者：下次接手的 Claude／其他工程模型  
> 使用者關切：未來卡片詞綴與機制會持續增加，例如「後排攻擊」，擔心效果系統逐漸難以維護。

## Review 結論

M3 的基本方向正確：卡片效果資料化、共用規則引擎、修正層、Check Process，以及官方判例測試，都是適合持續擴充卡池的做法。

目前的主要風險不是 DSL 本身，而是 DSL 詞彙與集中式解釋器隨卡片數量持續成長。若每遇到一種新句型就增加一個專用 `Condition`、`Action` 或 `Restriction`，`dsl.ts` 最終會變成另一套難以理解的程式語言，`effects.ts` 也會成為所有規則耦合在一起的單一模組。

**建議在補完剩餘 94 張卡以前，先做一次架構回覆與小型整理，不要直接依現有模式繼續擴充。** 不要求立即重寫，但需要先定義 DSL、核心規則與特例腳本之間的邊界。

## Findings

### [高] DSL primitive 有逐卡特化的趨勢

目前已出現偏向單一卡片句型的詞彙，例如：

- `selfIsSideBlocker`
- `paidGutsAll`
- `blockFailIfDpMax`
- `deployedByCard`
- `dropDistinctNames`
- `milledIs`

這些實作未必錯，但如果後續每張新卡都新增一個同等粒度的 primitive，DSL 會失去「少量通用積木可組合多張卡」的價值。

建議新增 primitive 前至少回答：

1. 這是遊戲規則中的穩定概念，還是某張卡的句型？
2. 是否能服務三張以上卡片或一整類未來效果？
3. 能否由既有條件、事件、篩選器與 action 組合表達？
4. 若只能服務少數卡，使用特例腳本是否更誠實且更容易測試？

### [高] `effects.ts` 已成為集中式大型解釋器

`effects.ts` 同時負責：

- 卡片與參數查詢
- 登場合法性
- 觸發偵測與 Check Process
- cost 支付
- condition 判斷
- action 執行
- 玩家子決策
- 關鍵字展開
- 持續效果清理
- 部分規則例外

這讓新增一個效果經常需要同時修改型別、解釋器、等待決策、AI 與測試。規則之間也容易產生隱性耦合。

建議逐步拆成可註冊的處理器，而非一次重寫：

```text
effects/
  triggers.ts
  conditions.ts
  costs.ts
  actions.ts
  restrictions.ts
  runtime.ts
  scripts.ts
```

每種 `op`／`type` 對應一個 handler registry，讓新增詞彙不必繼續擴大同一個 `switch`。

### [高] 「後排攻擊」可能不是普通 Action，而是核心流程能力

目前主流程預設：

- 五個固定 Court Area
- 托球後進入攻擊階段
- 攻擊 OP 主要由托球角色與攻擊角色算出
- 攻擊角色是攻擊區頂牌
- OP source 只有 `serve | block | attack`

若「後排攻擊」只是「符合條件時攻擊 +N」，現有 DSL 可以處理；但若它會改變以下任一項，就不應只新增 `{ op: "backRowAttack" }`：

- 哪個區域的角色可以成為攻擊者
- 同一回合可有幾名攻擊參與者
- 攻擊角色如何選擇
- 托球、攻擊與攔網的時序
- OP 的來源與組成方式
- 防守方可以做出的回應
- 攻擊結束後卡片移動與狀態清理

建議先依官方完整規則建立一個通用的 `AttackContext`／進攻參與者模型，再讓 DSL 修改該模型。不要讓卡片效果直接改寫多個 phase 游標與區域欄位。

在規則尚未取得前，請先保留問題，不要猜測後排攻擊的正式語義。

### [中] DSL 宣稱支援四種技能，但型別尚無一般化 permanent

`RULES_SPEC.md` 定義永續、被動、主動、事件四型；目前 `SkillDef` 只有 `passive`、`active`、`event` 與特定的 `deployNameChoice`。

未來若出現大量「只要此卡在場就……」「構築時……」「開局時……」效果，可能會被迫以 watcher、restriction 或特例方式模擬。建議先決定是否需要正式的 `permanent`／continuous rule layer。

### [中] duration 模型太窄

目前主要期限是 `thisTurn` 與 `nextOpponentTurn`。未來可能出現：

- 此 Phase／Step 結束前
- 下一次攻擊或判定前
- 只要來源卡仍在指定區域
- 直到 Set 結束
- 整場遊戲
- 使用 N 次後失效

建議把 duration 從字串擴充為結構化失效條件，而不是持續加入新的字串分支。

### [中] 特例腳本是設計原則，但尚未建立正式機制

`BLUEPRINT.md` 已寫明 DSL 無法表達時使用獨立腳本，但目前 `SkillDef` 沒有正式的 script handler registry。

沒有這條逃生路徑，實作者容易為了維持「全 DSL」而加入過度專用的 primitive。建議先建立最小機制：

```ts
{ kind: "script", id: "card.HV-XXX-000.skill-1" }
```

script 仍需使用共用的狀態操作 API、合法性檢查與測試，不應任意直接改寫整個 state。

### [中] JSON 缺少執行前 schema 驗證與版本策略

TypeScript 型別不會在執行時驗證 `data/effects.json`。拼錯 `op`、漏欄位或資料格式過期，可能直到對局碰到該卡才出錯。

建議加入：

- build/test 時完整驗證所有 effects
- DSL schema version
- 卡號、skill index、handler id 的完整性檢查
- 每種 action／condition 至少有一個 contract test

### [中] 判例測試很好，但組合爆炸仍是主要風險

目前測試能證明單卡與部分真實牌組可運作，不能完整證明多個持續效果、限制與置換效果交互時仍正確。

建議增加跨效果不變量：

- 禁止效果永遠優先於允許效果
- 卡片離開有效區域後，所有以該角色為對象的 modifier 正確清除
- 同時待機永遠遵守 turn player 優先
- 跳過 Phase 時，該 Phase 的待機與到期效果正確處理
- `set`、`add`、無效化與固定值在不同順序下結果一致
- 效果不能讓卡片憑空增加、消失或重複存在於多個區域

## 建議的演進順序

1. **先盤點剩餘 94 張卡，不實作。** 將需求分為「現有 DSL 可表達／需要通用 primitive／需要核心流程擴充／適合 script」。
2. **Claude 回覆本文件的問題。** 先確認是否認同風險與邊界，再決定是否重構。
3. **建立最小 script registry 與 JSON schema validation。** 先提供安全出口與資料防線。
4. **把 `effects.ts` 依責任逐步拆分。** 保持行為不變，每一步全測試綠。
5. **針對後排攻擊等新機制定義核心領域模型。** 取得正式規則後才實作。
6. **最後才分批補完剩餘卡片。** 每批記錄新增 primitive 的重用理由。

## 請 Claude 下次接手時回覆

請不要只回覆「可以維護」或直接開始補卡。請在 `WORKLOG.md` 留下具體判斷：

1. 是否同意 `dsl.ts`／`effects.ts` 已出現規模與耦合風險？不同意的依據是什麼？
2. 哪些現有 primitive 應保留為通用語彙，哪些更適合改成 script 或較小積木的組合？
3. 對「後排攻擊」這類會改變參與角色與流程的機制，預計放在核心引擎、DSL 還是 script？判斷標準是什麼？
4. 是否應在補 94 張卡前先建立 script registry、schema validation 與 handler 拆分？請提出最小變更方案。
5. 如何避免未來每個新詞綴都同時修改 `dsl.ts`、`effects.ts`、`engine.ts`、UI 與 AI？
6. 請列出建議的架構調整順序、預估影響範圍，以及哪些項目可以延後。

## Acceptance Criteria

本 review 不要求立即重構。下一階段至少應達成：

- Claude 已書面回覆上述六題。
- 剩餘 94 張卡先完成機制分類，再開始實作。
- 新 primitive 有清楚的重用理由。
- 遇到會改變核心回合流程的新機制時，不以單一卡片 action 草率繞過。
- DSL、script 與核心規則各自的責任邊界被寫入 `BLUEPRINT.md`。
