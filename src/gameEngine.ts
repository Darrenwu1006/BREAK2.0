export type GameEngine = "classic" | "lab";

export const GAME_ENGINE_STORAGE_KEY = "break.game-engine";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read the remembered battle renderer without letting storage failures block the menu. */
export function readGameEngine(storage?: StorageLike): GameEngine {
  try {
    const target = storage ?? globalThis.localStorage;
    return target.getItem(GAME_ENGINE_STORAGE_KEY) === "lab" ? "lab" : "classic";
  } catch {
    return "classic";
  }
}

/** Remember which renderer the next battle should use. This never navigates or reloads. */
export function writeGameEngine(engine: GameEngine, storage?: StorageLike): void {
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(GAME_ENGINE_STORAGE_KEY, engine);
  } catch {
    // A private/restricted browser can still use the in-memory React state.
  }
}
