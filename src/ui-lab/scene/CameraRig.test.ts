import { describe, expect, it } from "vitest";
import { cameraViewOffsetX } from "./CameraRig";

describe("cameraViewOffsetX", () => {
  it("將完整 Canvas 的光學中心留在左側 80% 舞台中央", () => {
    expect(cameraViewOffsetX(1280)).toBe(128);
    expect(cameraViewOffsetX(1440)).toBe(144);
  });
});
