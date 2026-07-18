# 3D 牌堆圓角黑框 Design QA

> [Codex 2026-07-17] 本報告只驗收 3D 牌堆與既有卡片 mesh 的視覺一致性；不重新評估整體場景、相機或 rail。

## Comparison target

- Source visual truth: `/Users/wuyuming/Desktop/截圖 2026-07-16 下午8.14.53.png`
- Implementation screenshot: `/Users/wuyuming/.codex/visualizations/2026/07/17/019f6edd-c445-7c02-8bb3-0fcee1238102/pile-rounded-mulligan.png`
- Focused comparison: `/Users/wuyuming/.codex/visualizations/2026/07/17/019f6edd-c445-7c02-8bb3-0fcee1238102/pile-comparison.png`
- Viewport: 1440 × 900 implementation gate；source screenshot 為較高 DPR 的同一 desktop surface。
- State: mulligan，雙方手牌 6、牌組 34；source 與 implementation 使用不同牌組，卡背內容不是本輪 fidelity target。

## Full-view comparison evidence

- [Codex 2026-07-17] 原截圖中手牌有圓角黑框，牌堆頂面卡背貼滿直角長方體；implementation 中雙方牌堆與手牌都具有一致的圓角外輪廓與單層黑框。
- [Codex 2026-07-17] 牌堆位置、尺寸、厚度、桌面槽位、rail 與 mulligan 操作區未因修正位移。

## Focused region comparison evidence

- [Codex 2026-07-17] focused comparison 將原始遠端牌堆與修正後遠端牌堆並列：修正後頂面卡背內縮，四周露出近黑 cap，四角輪廓確實倒圓；側面每張卡的細分隔線仍可辨識。

## Required fidelity surfaces

- Fonts and typography: [Codex 2026-07-17] 無文字修改；既有字體、字級與換行維持原狀。
- Spacing and layout rhythm: [Codex 2026-07-17] `CARD_W`、`CARD_H`、牌堆高度與錨點不變；圓角只收掉原本不應存在的四角體積。
- Colors and visual tokens: [Codex 2026-07-17] 牌堆 cap 直接共用單張卡 `BORDER_COLOR`，沒有新增近似黑或第二圈 outline。
- Image quality and asset fidelity: [Codex 2026-07-17] 沿用原始卡背貼圖與 SRGB／anisotropy 設定，僅改為與單張卡相同的內縮圓角貼圖面。
- Copy and content: [Codex 2026-07-17] 無文案或資料內容變更。

## Findings

- [Codex 2026-07-17] 無 actionable P0／P1／P2 差異。
- [P3] 圓角最側邊的分隔線因曲面透視稍微收窄，屬真實圓角厚度的預期結果，不需阻塞交付。

## Comparison history

- Pass 1: [Codex 2026-07-17] 直角 `BoxGeometry` 改為共用圓角 card-body geometry，頂部改為近黑 cap＋內縮卡背；首次 1440 × 900 capture 已無 P0／P1／P2，未觸發視覺修正迴圈。

## Runtime verification

- [Codex 2026-07-17] 測試路徑：入口切換 Experimental 3D → 開始對戰 → 選擇我方先發球 → 進入 mulligan。
- [Codex 2026-07-17] 主要互動可完成；console errors = 0。僅有既存 `THREE.Clock` deprecated warning，與本輪牌堆修改無關。

## Implementation checklist

- [x] 圓角牌堆卡身
- [x] 與單張卡相同的內縮頂面與黑框常數
- [x] 保留側面張數分隔線
- [x] 1440 × 900 mulligan 實機驗收

final result: passed
