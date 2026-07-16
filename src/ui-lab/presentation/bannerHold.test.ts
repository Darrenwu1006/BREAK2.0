import { afterEach, describe, expect, it, vi } from "vitest";
import { BANNER_HOLD_MS, replaceBannerDismissTimer } from "./bannerHold";

describe("replaceBannerDismissTimer", () => {
  afterEach(() => vi.useRealTimers());

  it("普通 timeline 推進不會取消既有 banner 的自動消失", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const timer = replaceBannerDismissTimer(null, dismiss);

    // banner 之後的普通 timeline entry 不會呼叫 replace／clear；原 timer 必須照常到期。
    vi.advanceTimersByTime(BANNER_HOLD_MS - 1);
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledOnce();
    clearTimeout(timer);
  });

  it("新 banner 會取代舊倒數，只從最新一張重新計時", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const first = replaceBannerDismissTimer(null, dismiss);
    vi.advanceTimersByTime(1000);
    replaceBannerDismissTimer(first, dismiss);
    vi.advanceTimersByTime(BANNER_HOLD_MS - 1);
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
