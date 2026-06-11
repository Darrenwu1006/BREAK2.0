// 可重現的亂數（mulberry32）。RNG 狀態存在 GameState 內，確保引擎為純函式、模擬可重播。

export function nextRandom(state: { rngState: number }): number {
  let t = (state.rngState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Fisher–Yates；就地洗牌 */
export function shuffle<T>(state: { rngState: number }, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}
