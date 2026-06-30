---
id: L0007
title: 電腦對手的 gate-confirm 會在落後/拉鋸時系統性拒絕「免費增益技能」，造成 OP 崩盤（引擎價值函數對技能點數失明）
tags:
  cards: [HV-P01-043]
  phase: attack
  deckAxis: 梟谷-爆發軸二
  mistakeType: AI放水/gate誤拒
sources: [reports/16_ユース合宿精英vs梟谷爆發軸_AI拒絕免費技能gate放水復盤.md]
---

**這是引擎 AI 行為，不是使用者打法問題；驗證 Phase H 放水診斷的可重現實證。**

當電腦對手用「基礎點低＋登場技能爆點」的卡（爆發/技能牌組典型，如 HV-P01-043 木兎：攻0、全員梟谷時 gate「攻擊+5」、無 Guts 成本），它的 `effect-confirm`（gate accept/decline）會在**沒領先（落後/拉鋸）**時系統性 **decline 免費增益**，導致攻擊回合 OP 直接崩到 0；同一場到了明顯該爆的回合卻又 accept（→ OP 8）。表現出「gate 判斷不穩定、偏拒絕」。

**根因（已對程式碼/Phase H spec 對照）**：不是 H-W1「領先就擺爛」（拒絕都在沒領先時發生），而是 **H-W2/W3——價值函數/gate 評估看不到技能帶來的攻防點數**，把「零成本 +5 OP」誤判為低收益而拒。heuristic 的「高成本低收益可拒絕」邏輯對零成本純增益失效。

**正反例**：
- 反例（放水）：木兎[攻3]站著 → 覆蓋成木兎[攻0] → 跳 +5 gate → decline → OP 0。最佳線 accept → OP 5（或不覆蓋保 OP 3）。
- 正例（同場 S3T4）：toss/attack gate 全 accept → OP 8、贏該 Set。差別只在 gate 接受與否。

**復盤/修正提示**：看到爆發牌組電腦 OP 平均偏低（本場 1.88 vs 玩家 3.60）先掃 `effect-confirm accept=False` 集中在哪些 phase/Set；修正屬引擎（gate 評估要看接受後 OP/DP 實際變化），不是調牌組。關聯 [[L0005]]（防守天花板）反向版——這裡是 AI **自己**該爆不爆。
