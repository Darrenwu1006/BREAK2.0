---
name: replay-review
description: 對戰結束後的「教練」復盤——讀真實 replay 紀錄，先 triage 篩出關鍵手（疑似失誤＋打得好），由使用者挑幾手做單手決策深掘，寫成可重用的 reports/NN_*.md 並累積 reports/lessons/ 通則庫（跨場「你上次也這樣」）。當使用者說「幫我復盤/覆盤這場」「這場打得如何」「某一手有沒有更好打法」「Turn N 該不該開技能」「檢討這局」時使用。
---

# 對戰復盤教練（replay-review）

打完一場後，依使用者需求寫一份**有判斷、可重用**的復盤。**這個 skill 的靈魂不是「再產一份統計面板」，而是「像懂這遊戲的教練一樣，根據真實牌況講出該怎麼打、並記住跨場教訓」。** 統計面板（`analyze:replay`）是你的眼睛（資料層）；你是判斷層＋記憶層。

完整設計見 `docs/M8_PHASE_E_REPLAY_REVIEW_SKILL_SPEC.md`。本檔是執行流程。

## 接地契約（動手前釘死，違反＝這份復盤作廢）

報告 10（杜撰勝率、弄錯規則）vs 報告 11（從 replay 重建盤面、對卡查值逐條糾正）是這個 skill 存在的理由。**最大風險＝幻覺盤面/規則/數字。**

1. **盤面一律引用實際 replay**：用 `--board=<步>` 取得精確牌況，禁止憑記憶重建手牌/區域/點數。
2. **卡值/效果先查再講**：`data/cards.json`（`params: 發/攔/接/托/攻`，`null`＝「－」）、`data/effects.json`、`docs/RULINGS.md`。`--board` 已把卡名＋參數攤好，但引用具體效果文字要回查。
3. **規則對 `docs/RULES_SPEC.md`／引擎查證**：尤其「進攻方 receive/toss/attack 三格強制登場」「防守可改攔網（1 張卡）」這類會翻轉整個分析框架的硬規則。引擎已算好的 `state.op/dp` 直接讀，不自行重算。
4. **勝率只能來自 PIMC**（`--triage --coach` 或單步 coach）；沒跑就寫「未評估」，**不捏造數字**。低樣本 PIMC 是噪訊，標清楚。
5. **誠實標記不確定**：該說「這是死局、最佳打法也只延命」就說（見報告 11）。triage 階段只提名、不定論。

## 工作流

### 先確認對象與焦點
- 預設讀 `data/replays/` 最新檔；使用者指定牌組/seed/檔名就用 `--file=`。
- 問清楚分析座位（預設玩家＝`--player=0`）與焦點：是要「整場找關鍵手」還是「看某一手」。

### 階段 0｜triage 篩選（使用者不確定哪手關鍵時的預設入口）
1. 跑 `npm run analyze:replay -- --triage`（要折入 PIMC 噪訊再加 `--coach`）。
2. 把候選清單整理給使用者：**疑似失誤 / 打得好 / 需留意**三組，每筆標步數、Set·Turn、★強弱、一句話理由。
3. 請使用者挑幾手深掘。**不要自己全做**——讓他選。

### 階段 1｜單手決策深掘（報告 11 模式）
對每個選中的步：
1. **取盤面**：`--board=<步>`。**失 Set 候選要回放整個 Set 的我方決策**（`--board=<起>-<迄>`）去找根因——triage 的 lost-set 訊號指向「倒下那一步」，根因常在更早（如倒在 Turn 6、根因在 Turn 4 開錯技能）。
2. **查規則/卡值**：把這手牽涉的硬規則、卡片效果、點數都查證過，再開始推理。
3. **比替代線**：列出當下可行的其他打法，逐線推到結果（像報告 11 §4 那張三線對照表）。需要勝率佐證時對該步跑 PIMC，否則用牌況/資源論證。
4. **下定論**：核心結論一句話講清楚（該不該、為什麼、誠實的天花板）。
5. **寫報告**＋**萃通則**（見下）。

使用者若直接點名某一手（「看 Turn 4 那手」），跳過階段 0，直接進階段 1。

## 通則庫（跨場記憶＝這個 skill 最大的新價值）

### 復盤前：先撈舊教訓
`reports/lessons/INDEX.md` 用 grep 比對當前局面（涉及的卡號、phase、牌組軸、錯誤類型）。命中就在報告裡點出「你在 報告X／L00YY 也遇過同型」。

### 復盤後：寫一則新 lesson
`reports/lessons/L00NN-<slug>.md`，frontmatter＋一段通則（格式見現有 lesson 與 spec §6）：
```markdown
---
id: L00NN
title: <一句話通則>
tags:
  cards: [<卡號>]
  phase: <serve|receive|toss|attack|block|setup|free>
  deckAxis: <牌組-版本>
  mistakeType: <時機/資源誤投/…>   # 好球用 goodPattern
sources: [reports/NN_*.md]
---
<通則本體：什麼情境下成立、對照正反例。>
```
寫完在 `reports/lessons/INDEX.md` 補一行：`- [L00NN](L00NN-<slug>.md) — <hook>；tags: <卡號>, <phase>, <牌組>`。
- 同型教訓已存在 → 更新該則、補 `sources`，不要新增重複。
- 好球也值得記（正向 pattern）。

## 報告輸出

寫到 `reports/NN_標題.md`（沿用既有 01–… 編號往下接）。表頭與結構鏡像報告 11：
```
# <對戰> <焦點> 復盤
> 對戰 Seed：… ｜ 結果：… ｜ 分析者：[Claude YYYY-MM-DD] ｜ 資料來源：<replay 檔名>（第 X–Y 步）
## 0 規則前提（把會翻轉框架的硬規則先釘死）
## 1 核心結論
## 2 盤面逐步還原（取自 --board）
## 3 為什麼（卡值/資源/對手牆）
## 4 建議打法＋替代線對照＋誠實評估
## 5 通則（→ 寫進 reports/lessons/）
```

## 指令速查
| 目的 | 指令 |
|---|---|
| 篩關鍵手 | `npm run analyze:replay -- --triage` |
| 篩＋PIMC 噪訊 | `npm run analyze:replay -- --triage --coach --samples=5` |
| 單步盤面 | `npm run analyze:replay -- --board=29` |
| 一段盤面（整個 Set 找根因） | `npm run analyze:replay -- --board=22-30` |
| 巨觀戰報（失 Set 歸因/效率/主軸） | `npm run analyze:replay` |
| 指定檔案/座位 | `--file=data/replays/<檔>.json --player=0` |

## 收工定義
- 報告寫進 `reports/`，表頭含 seed／資料來源／分析者標記，所有盤面/卡值/規則都可回查、無捏造數字。
- 至少一則 lesson 進 `reports/lessons/` 並更新 INDEX（或更新既有同型 lesson）。
- 若跑過 PIMC，標清樣本數與「這是估計」。
