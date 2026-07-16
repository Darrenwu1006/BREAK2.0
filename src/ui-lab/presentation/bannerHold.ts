export const BANNER_HOLD_MS = 2400;

export function replaceBannerDismissTimer(
  previous: ReturnType<typeof setTimeout> | null,
  dismiss: () => void,
  delay = BANNER_HOLD_MS,
): ReturnType<typeof setTimeout> {
  if (previous !== null) clearTimeout(previous);
  return setTimeout(dismiss, delay);
}
