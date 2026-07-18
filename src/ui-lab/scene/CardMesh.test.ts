import { describe, expect, it } from "vitest";
import { BORDER_W, cardBodyGeometry, cardFaceGeometry } from "./CardMesh";
import { CARD_H, CARD_W } from "./layout";

describe("shared rounded card geometry", () => {
  it("牌堆可沿用單張卡的圓角卡身，並保留 cap／側牆材質群組", () => {
    const depth = 0.44;
    const geometry = cardBodyGeometry(depth);
    geometry.computeBoundingBox();

    const box = geometry.boundingBox!;
    expect(box.max.x - box.min.x).toBeCloseTo(CARD_W, 5);
    expect(box.max.y - box.min.y).toBeCloseTo(depth, 5);
    expect(box.max.z - box.min.z).toBeCloseTo(CARD_H, 5);
    expect(new Set(geometry.groups.map((group) => group.materialIndex))).toEqual(new Set([0, 1]));

    const positions = geometry.attributes.position!;
    const hasSquareCorner = Array.from({ length: positions.count }, (_, index) => index)
      .some((index) => Math.abs(positions.getX(index)) > CARD_W / 2 - 0.01
        && Math.abs(positions.getZ(index)) > CARD_H / 2 - 0.01);
    expect(hasSquareCorner).toBe(false);
  });

  it("牌堆頂面與單張卡使用相同的內縮黑框寬度", () => {
    const geometry = cardFaceGeometry();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;

    expect(box.max.x - box.min.x).toBeCloseTo(CARD_W - 2 * BORDER_W, 5);
    expect(box.max.z - box.min.z).toBeCloseTo(CARD_H - 2 * BORDER_W, 5);
  });
});
