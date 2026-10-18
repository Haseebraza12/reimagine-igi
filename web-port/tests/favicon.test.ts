import { describe, expect, it } from "vitest";
import { iconRegion, LOGO_EMBLEM, opaqueBounds, setFaviconFromPicture } from "../src/engine/ui/favicon";

const pic = (width: number, height: number, opaque: Array<[number, number]>) => {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of opaque) rgba[(y * width + x) * 4 + 3] = 255;
  return { width, height, rgba, format: "test" };
};

describe("tab icon (ui/favicon.ts)", () => {
  it("trims a picture to its opaque pixels", () => {
    expect(opaqueBounds(pic(10, 8, [[2, 3], [6, 5]]))).toEqual({ x: 2, y: 3, w: 5, h: 3 });
    expect(opaqueBounds(pic(4, 4, []))).toBeNull();
  });

  it("shows the emblem of logo.pic (295 x 107) and the whole of any other picture", () => {
    const logo = pic(LOGO_EMBLEM.width, LOGO_EMBLEM.height, [[0, 0]]);
    expect(iconRegion(logo)).toEqual({ x: 75, y: 10, w: 142, h: 94 });
    expect(iconRegion(pic(20, 10, [[1, 1], [18, 8]]))).toEqual({ x: 1, y: 1, w: 18, h: 8 });
  });

  it("does nothing without a page", () => {
    expect(setFaviconFromPicture(pic(4, 4, [[1, 1]]))).toBe(false);
  });
});
