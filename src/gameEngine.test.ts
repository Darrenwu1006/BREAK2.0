import { describe, expect, it } from "vitest";
import { GAME_ENGINE_STORAGE_KEY, readGameEngine, writeGameEngine } from "./gameEngine";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(GAME_ENGINE_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("game engine preference", () => {
  it("defaults invalid or missing values to classic", () => {
    expect(readGameEngine(memoryStorage())).toBe("classic");
    expect(readGameEngine(memoryStorage("unknown"))).toBe("classic");
  });

  it("remembers lab without navigation side effects", () => {
    const storage = memoryStorage();
    writeGameEngine("lab", storage);
    expect(readGameEngine(storage)).toBe("lab");
  });

  it("falls back safely when storage is unavailable", () => {
    const broken = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readGameEngine(broken)).toBe("classic");
    expect(() => writeGameEngine("lab", broken)).not.toThrow();
  });
});
