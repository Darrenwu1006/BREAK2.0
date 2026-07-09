# 通則庫 INDEX

> 對戰復盤累積的跨場教訓。每則一檔，frontmatter 帶 tags（卡號/phase/牌組軸/錯誤類型）。
> 復盤前 grep 本檔比對當前局面 → 命中就在報告裡點出「你上次也遇過」。
> 由 `replay-review` skill 維護（見 `.claude/skills/replay-review/SKILL.md`）。

- [L0001](L0001-iwaizumi-skill-timing.md) — 岩泉/及川棄牌技是補刀技不是常駐技，打不穿的回合手牌就是防線；tags: HV-P01-035, attack, 青葉城西, 技能時機
- [L0002](L0002-inarizaki-mill-tempo.md) — 稲荷崎堆墓靠大見/小作的「棄牌成本」點火(無Guts)，北信介/宮侑是Guts/6種gated的payoff別當燃料；Set1任務是挖miller+survive+保防禦牌；贏線是厚DP+回收續航；tags: HV-P02-085, HV-P02-035, HV-P02-024, receive, 稲荷崎堆墓, gameplan節奏
- [L0003](L0003-defense-route-body-chain.md) — 防守先比較單卡攔網與接球三身體鏈；0點仍可合法登場；tags: HV-P01-035, HV-P01-041, start, 青葉城西, 合法動作
- [L0004](L0004-resource-burn-exchange-rate.md) — 資源燃燒看交換率，花費要換到對手身體或不可逆終結；tags: HV-P01-033, HV-P01-035, HV-P01-087, HV-PR-025, attack, 青葉城西
- [L0005](L0005-defense-ceiling-and-triage.md) — 當對手爆發力超越防守天花板時，防守拖延是慢性自殺，贏線應轉向速攻或手牌控制；tags: HV-P01-041, HV-P01-042, receive, 青葉城西-二彈改, gameplan節奏
- [L0006](L0006-defense-reserve-vs-grind.md) — 對 grind/堆墓型對手防守儲備不可歸零，付 Guts 撐場前先問「下一個對手 OP 還擋不擋得住」；手牌沖到 0 等於把生死交給牌庫頂；tags: HV-P02-029, HV-P01-041, receive, 青葉城西-二彈改, 資源誤投
- [L0007](L0007-ai-declines-free-gate.md) — 【AI 行為】電腦 gate-confirm 在落後/拉鋸時系統性拒絕「免費增益技能」（攻+5/防守加點）→ OP 崩盤；根因＝價值函數對技能點數失明（Phase H W2/W3，非 H-W1 飽和）；tags: HV-P01-043, attack, 梟谷-爆發軸二, AI放水/gate誤拒
- [L0008](L0008-ai-fold-advice-pessimism.md) — 【AI 行為】「主動 Lost」勸棄建議過度悲觀，125 段實戰續打逆轉率 54%；採納前過「續打成本 ≤2 手牌＋下 Set 有利」準則；tags: free, 跨牌組, AI價值校準
- [L0009](L0009-name-chain-planning.md) — 少名字/多版本牌組每 Set 開局先排接→托→攻名字鏈（失 Set 大宗「未能登場」時手牌中位仍有 7 張）；多版本同名卡定義專屬崗位；死局送參數最無用的牌；tags: HV-P03-020, HV-PR-059, HV-P01-033, setup, ユース＋青葉城西, 登場資源規劃
- [L0010](L0010-cantrip-thinning-and-forced-deploys.md) — cantrip 事件密度＝牌庫自磨速度；三格強制登場下長局資源死是結構性的——高 cantrip 牌組要 Set 內速戰或後期節流、死 Set 早棄期望值高；tags: HV-P02-087, HV-D03-013, free, 稲荷崎雙子, 資源節奏
