import type { ReplaySetFeedbackTag } from "./replayHistory";

/** 2D／3D 對局共用；選項順序也是介面呈現順序。 */
export const REPLAY_SET_FEEDBACK_OPTIONS = [
  { tag: "push-for-set", label: "全力搶下這個 Set" },
  { tag: "save-for-next-set", label: "為下一個 Set 保留資源" },
  { tag: "build-resources", label: "按牌組計畫累積資源" },
  { tag: "test-line", label: "測試特定打法" },
  { tag: "gamble-key-piece", label: "在賭關鍵拼圖" },
  { tag: "suspected-mistake", label: "我覺得自己打錯了" },
  { tag: "forced-line", label: "手牌／局面讓我沒得選" },
  { tag: "review-request", label: "我不確定，請幫我回看" },
] as const satisfies readonly { tag: ReplaySetFeedbackTag; label: string }[];
