/**
 * Mouse look (engine/look.ts) against the recovered rules of FUN_0048e030,
 * FUN_004e3c41, FUN_0045fd00 and FUN_00463470 (docs/gameplay.md "Look").
 */
import { describe, expect, it } from "vitest";
import { LookController, lookChannel, lookSensitivity, lookStep } from "../src/engine/look";

describe("look (igi.exe per-tick rule)", () => {
  it("scales counts by 1/255 and clamps the channel to [-1, 1]", () => {
    expect(lookChannel(255)).toBe(1);
    expect(lookChannel(1000)).toBe(1);
    expect(lookChannel(-1000)).toBe(-1);
    expect(lookChannel(51)).toBeCloseTo(0.2, 6);
  });

  it("turns c x pi x tanX per tick, eased below |c| = 0.06", () => {
    expect(lookStep(0.5, 1)).toBeCloseTo(0.5 * Math.PI, 5);
    expect(lookStep(0.5, 0.5)).toBeCloseTo(0.25 * Math.PI, 5); // zoomed views turn slower
    const c = 1 / 255;
    expect(lookStep(c, 1)).toBeCloseTo((c * Math.PI) / (2 - c * 16.666666666666668), 6);
    expect(lookStep(0.06, 1)).toBeCloseTo(0.06 * Math.PI, 5); // at the threshold: no easing
  });

  it("smooths pitch (not yaw) with the previous tick when unzoomed, turns right for +x and looks up for +y (inverted)", () => {
    const look = new LookController();
    const a = look.tick(51, 51, 1, 0, 0); // c = 0.2: yaw raw, pitch (0.2 + 0) x 0.5
    expect(a.yaw).toBeCloseTo(-0.2 * Math.PI, 5);
    expect(a.pitch).toBeCloseTo(0.1 * Math.PI, 5);
    const b = look.tick(0, 0, 1, a.yaw, a.pitch); // yaw stops; pitch (0 + 0.2) x 0.5 again
    expect(b.yaw).toBe(a.yaw);
    expect(b.pitch - a.pitch).toBeCloseTo(0.1 * Math.PI, 5);
    const up = new LookController().tick(0, 51, 1, 0, 0);
    expect(up.pitch).toBeGreaterThan(0); // mouse moved toward the player raises the view
    const normal = new LookController().tick(0, 51, 1, 0, 0, false);
    expect(normal.pitch).toBeLessThan(0);
  });

  it("scales both channels by clamp(GOInMouSens, 0.05, 1) after the +-1 clamp (FUN_0045cde0)", () => {
    expect(lookSensitivity(0.4)).toBe(Math.fround(0.4));
    expect(lookSensitivity(0)).toBe(Math.fround(0.05));
    expect(lookSensitivity(3)).toBe(1);
    // 1000 counts clamp to 1, then x 0.4: the yaw step is 0.4 pi (tanX 1, |c| >= 0.06).
    const a = new LookController().tick(1000, 0, 1, 0, 0, true, 0.4);
    expect(a.yaw).toBeCloseTo(-0.4 * Math.PI, 5);
  });

  it("does not smooth while zoomed and clamps the pitch to +-pi/2", () => {
    const look = new LookController();
    const z = look.tick(51, 0, 0.5, 0, 0);
    expect(z.yaw).toBeCloseTo(-0.2 * Math.PI * 0.5, 5);
    const top = new LookController().tick(0, 10000, 1, 0, 1.5);
    expect(top.pitch).toBe(Math.fround(Math.PI / 2));
  });
});
