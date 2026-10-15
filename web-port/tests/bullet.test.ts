/**
 * Bullet tracing (combat/bullet.ts) against the recovered FUN_00479e30 rules
 * on synthetic geometry.
 */
import { describe, expect, it } from "vitest";
import type { SurfaceMaterial } from "../src/loaders";
import { traceBullet, HUMAN_HIT_MATERIAL } from "../src/engine/combat/bullet";
import { CollisionWorldBuilder, TERRAIN_HIT_MATERIAL, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } from "../src/engine/world/collision";

const ALL = TRI_SOLID | TRI_BULLET | TRI_SIGHT;

function material(index: number, name: string, hardness: number, ricochetDeg: number): SurfaceMaterial {
  return { index, name, hardness, ricochetDeg } as unknown as SurfaceMaterial;
}
const MATERIALS: SurfaceMaterial[] = [];
MATERIALS[1] = material(1, "Ground", 10, 5);
MATERIALS[3] = material(3, "Wood", 1, 10);
MATERIALS[5] = material(5, "StrongMetal", 10, 30);
MATERIALS[HUMAN_HIT_MATERIAL] = material(HUMAN_HIT_MATERIAL, "Flesh", 1, 0);

/** A closed slab between x0 and x1 (front face at x0 facing -x, back face at x1 facing +x). */
function slab(b: CollisionWorldBuilder, x0: number, x1: number, mat: number, owner: number) {
  b.addIndexed([x0, -5, -5, x0, -5, 5, x0, 5, 5, x0, 5, -5], [0, 1, 2, 0, 2, 3], ALL, mat, owner); // normal -x
  b.addIndexed([x1, -5, -5, x1, 5, -5, x1, 5, 5, x1, -5, 5], [0, 1, 2, 0, 2, 3], ALL, mat, owner); // normal +x
}

/** Random source returning the listed values in order (then 0.99). */
const seq = (...values: number[]) => () => (values.length ? values.shift()! : 0.99);

describe("traceBullet (FUN_00479e30)", () => {
  it("passes a softer surface, then stops at the next front face after leaving a solid", () => {
    const b = new CollisionWorldBuilder();
    slab(b, 2, 2.1, 3, 0); // wood, hardness 1
    slab(b, 4, 4.1, 3, 1);
    const r = traceBullet({ world: b.build(), from: [0, 0.3, 0.1], dir: [1, 0, 0], range: 100, penetration: 2, materials: MATERIALS, random: seq() });
    expect(r.impacts.map((i) => i.material)).toEqual(["Wood", "Wood"]);
    expect(r.end[0]).toBeCloseTo(4, 6);
  });

  it("stops at harder surfaces and passes equal hardness with chance 0.6", () => {
    const b = new CollisionWorldBuilder();
    slab(b, 2, 2.1, 3, 0);
    const world = b.build();
    const run = (draws: number[]) =>
      traceBullet({ world, from: [0, 0.3, 0.1], dir: [1, 0, 0], range: 10, penetration: 1, materials: MATERIALS, random: seq(...draws) });
    // Draw 1: ricochet roll (head-on: chance < 0). Draw 2: the equal-hardness roll.
    // Each hit restarts 20.48 units (5 mm) past it while only the hit distance is used up (as in the exe).
    expect(run([0.5, 0.59]).end[0]).toBeCloseTo(10 + 2 * (Math.fround(20.48) / 4096), 6);
    expect(run([0.5, 0.61]).end[0]).toBeCloseTo(2, 6);
    const hard = new CollisionWorldBuilder();
    slab(hard, 2, 2.1, 5, 0);
    expect(traceBullet({ world: hard.build(), from: [0, 0.3, 0.1], dir: [1, 0, 0], range: 10, penetration: 5, materials: MATERIALS, random: seq() }).end[0]).toBeCloseTo(2, 6);
  });

  it("never passes terrain", () => {
    const b = new CollisionWorldBuilder();
    b.addIndexed([-50, 0, -50, -50, 0, 50, 50, 0, 50, 50, 0, -50], [0, 1, 2, 0, 2, 3], ALL | TRI_TERRAIN, TERRAIN_HIT_MATERIAL);
    const d = Math.SQRT1_2;
    const r = traceBullet({ world: b.build(), from: [0, 1, 0.1], dir: [d, -d, 0], range: 10, penetration: 100, materials: MATERIALS, random: seq(0.99) });
    expect(r.impacts).toHaveLength(1);
    expect(r.impacts[0].material).toBe("Ground");
    expect(r.end[1]).toBeCloseTo(0, 6);
  });

  it("ricochets once off a grazing hit with chance (A - (90 - i)) / A", () => {
    const b = new CollisionWorldBuilder();
    b.addIndexed([-50, 0, -50, -50, 0, 50, 50, 0, 50, 50, 0, -50], [0, 1, 2, 0, 2, 3], ALL, 5, 0); // metal floor, A = 30 deg
    const world = b.build();
    // 10 degrees below horizontal: incidence 80 degrees -> chance (30 - 10) / 30 = 2/3.
    const a = (10 * Math.PI) / 180;
    const dir: [number, number, number] = [Math.cos(a), -Math.sin(a), 0];
    const bounce = traceBullet({ world, from: [0, 1, 0.1], dir, range: 50, penetration: 1, materials: MATERIALS, random: seq(0.6) });
    expect(bounce.impacts[0].ricochet).toBe(true);
    expect(bounce.end[1]).toBeGreaterThan(0.5); // left upwards
    const stop = traceBullet({ world, from: [0, 1, 0.1], dir, range: 50, penetration: 1, materials: MATERIALS, random: seq(0.7) });
    expect(stop.impacts[0].ricochet).toBe(false);
    expect(stop.end[1]).toBeCloseTo(0, 6);
  });

  it("hits a human once, then stops at the next surface (the body's exit is implied)", () => {
    const b = new CollisionWorldBuilder();
    slab(b, 5, 5.1, 3, 0);
    let hits = 0;
    const r = traceBullet({
      world: b.build(),
      from: [0, 0.3, 0.1],
      dir: [1, 0, 0],
      range: 50,
      penetration: 2,
      materials: MATERIALS,
      random: seq(),
      human: (o, _d, max, exclude) => (exclude.has("h") || 2 - o[0] > max || o[0] > 2 ? null : { distance: 2 - o[0], point: [2, 0.3, 0.1], key: "h", apply: () => hits++ }),
    });
    expect(hits).toBe(1);
    expect(r.impacts.map((i) => [i.material, i.human])).toEqual([["Flesh", true], ["Wood", false]]);
    expect(r.end[0]).toBeCloseTo(5, 6);
  });
});
