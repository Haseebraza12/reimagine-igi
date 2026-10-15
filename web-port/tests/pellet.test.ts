/**
 * Pellet direction of FUN_004772c0 (engine/combat/pellet.ts): frame(aim)
 * Ry(b) Rx(a), column y.
 */
import { describe, expect, it } from "vitest";
import { aimFrame, drawPellet, pelletDirection, spreadRadians } from "../src/engine/combat/pellet";

describe("pellet direction (FUN_004772c0)", () => {
  it("builds FUN_00486a60's frame: x right, z up for a level aim, x along +x for a steep one", () => {
    // Aim north (engine -z): x = east, z = up.
    const f = aimFrame([0, 0, -1]);
    expect(f.x[0]).toBeCloseTo(1, 6);
    expect(f.z[1]).toBeCloseTo(1, 6);
    // Straight down (|aim.z| > 0.95): z = normalize(X x aim) = (0, -u.z, u.y) = IGI north = engine -z; x = aim x z.
    const s = aimFrame([0, -1, 0]);
    expect(s.z[2]).toBe(-1);
    expect(s.x[0]).toBeCloseTo(1, 6);
  });

  it("tilts by the cone angle; azimuth 0 tilts up, pi/2 tilts right", () => {
    const aim = [0, 0, -1];
    const a = 0.1;
    const upTilt = pelletDirection(aim, a, 0);
    expect(upTilt[1]).toBeCloseTo(Math.sin(a), 6);
    expect(upTilt[2]).toBeCloseTo(-Math.cos(a), 6);
    const rightTilt = pelletDirection(aim, a, Math.PI / 2);
    expect(rightTilt[0]).toBeCloseTo(Math.sin(a), 6);
    const angle = Math.acos(-pelletDirection(aim, a, 2.3)[2]);
    expect(angle).toBeCloseTo(a, 5);
  });

  it("draws three cube factors then the azimuth, in float32", () => {
    const draws = [0.5, 0.5, 0.5, 0.25];
    let i = 0;
    const p = drawPellet(spreadRadians(10), () => draws[i++]);
    expect(i).toBe(4);
    expect(p.angle).toBeCloseTo(0.125 * 10 * (Math.PI / 180), 6);
    expect(p.azimuth).toBe(Math.fround(0.25 * Math.fround(6.2831854820251465)));
    expect(spreadRadians(-3)).toBeGreaterThan(0);
    expect(spreadRadians(0)).toBe(0);
  });
});
