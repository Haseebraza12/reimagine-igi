/**
 * CollisionWorld queries (HSMC-style flags, materials, sides, the original's
 * hit ordering) and the recovered human movement (FUN_004600f0 / FUN_004606b0
 * / FUN_00460fd0) on synthetic geometry.
 */
import { describe, expect, it } from "vitest";
import {
  CollisionWorldBuilder,
  HIT_TIE_WINDOW_M,
  TERRAIN_HIT_MATERIAL,
  TRI_BULLET,
  TRI_SIGHT,
  TRI_SOLID,
  TRI_TERRAIN,
} from "../src/engine/world/collision";
import {
  GROUND_SNAP_M,
  PLATFORM_TASK_TYPES,
  SWEEP_SKIN_M,
  attachHuman,
  createHumanMoveState,
  detachHuman,
  leaveGround,
  moveHuman,
  platformDelta,
  updatePlatform,
  type HumanMoveState,
} from "../src/engine/world/character";

const ALL = TRI_SOLID | TRI_BULLET | TRI_SIGHT;
const G = 84.74169158935547 / 4096;
const ROOT = 0.95;

/** Quad as two triangles; corners ordered so (c1 - c0) x (c2 - c0) is the outward normal. */
function quad(builder: CollisionWorldBuilder, corners: number[][], flags = ALL, material = -1, owner = -1) {
  builder.addIndexed(corners.flat(), [0, 1, 2, 0, 2, 3], flags, material, owner);
}
/** Floor at y facing up over [x0, x1] x [z0, z1]. */
const floor = (b: CollisionWorldBuilder, y: number, x0: number, x1: number, z0: number, z1: number, flags = ALL, material = -1, owner = -1) =>
  quad(b, [[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], flags, material, owner);

function room() {
  const b = new CollisionWorldBuilder();
  floor(b, 0, -50, 50, -50, 50, ALL | TRI_TERRAIN, TERRAIN_HIT_MATERIAL); // terrain
  quad(b, [[5, 0, -50], [5, 0, 50], [5, 3, 50], [5, 3, -50]], ALL, 11, 0); // wall at x = 5 facing -x
  floor(b, 0.3, -10, -6, -2, 2, ALL, 11, 1); // 0.3 m step top
  quad(b, [[-6, 0, -2], [-6, 0, 2], [-6, 0.3, 2], [-6, 0.3, -2]].reverse(), ALL, 11, 1); // riser facing +x
  return b.build(4);
}

/** Pelvis state with the feet at `feet`. */
function standing(feet: [number, number, number], grounded = true): HumanMoveState {
  const s = createHumanMoveState([feet[0], feet[1] + ROOT, feet[2]]);
  s.grounded = grounded;
  return s;
}
const feetY = (s: HumanMoveState) => s.position[1] - ROOT;
/** One tick with gravity applied to the air velocity while airborne (the player's FUN_00408570). */
function tick(world: ReturnType<typeof room>, s: HumanMoveState, root: [number, number, number] = [0, 0, 0]) {
  if (!s.grounded) s.air[1] -= G;
  else s.air = [0, 0, 0];
  moveHuman(world, s, root, ROOT);
}

describe("CollisionWorld", () => {
  it("reports the nearest hit with side, material and owner", () => {
    const world = room();
    const side = world.raycast(0, 1, 0, 1, 0, 0, 100);
    expect(side?.distance).toBeCloseTo(5, 6);
    expect(side?.front).toBe(true);
    expect(side?.normal[0]).toBeCloseTo(-1, 6); // towards the ray origin
    expect(side?.material).toBe(11);
    expect(side?.owner).toBe(0);
    const back = world.raycast(8, 1, 0, -1, 0, 0, 100);
    expect(back?.front).toBe(false);
    expect(back?.normal[0]).toBeCloseTo(1, 6); // still towards the origin
  });

  it("reports Ground on terrain front faces and none on back faces", () => {
    const world = room();
    const down = world.raycast(20, 10, 0, 0, -1, 0, 100);
    expect(down?.terrain).toBe(true);
    expect(down?.material).toBe(TERRAIN_HIT_MATERIAL);
    const up = world.raycast(20, -1, 0, 0, 1, 0, 100);
    expect(up?.terrain).toBe(true);
    expect(up?.front).toBe(false);
    expect(up?.material).toBe(-1);
  });

  it("prefers a front hit within the 0.1-unit window and a strictly closer terrain hit", () => {
    const b = new CollisionWorldBuilder();
    // Back face (normal +x, ray runs along +x) at x = 1, front face slightly farther.
    quad(b, [[1, 0, -1], [1, 0, 1], [1, 2, 1], [1, 2, -1]].reverse(), ALL, 3, 0);
    const near = 1 + HIT_TIE_WINDOW_M * 0.5;
    quad(b, [[near, 0, -1], [near, 0, 1], [near, 2, 1], [near, 2, -1]], ALL, 5, 1);
    const w1 = b.build();
    expect(w1.raycast(0, 1, 0, 1, 0, 0, 10)?.material).toBe(5);
    const b2 = new CollisionWorldBuilder();
    quad(b2, [[1, 0, -1], [1, 0, 1], [1, 2, 1], [1, 2, -1]].reverse(), ALL, 3, 0);
    const far = 1 + HIT_TIE_WINDOW_M * 2;
    quad(b2, [[far, 0, -1], [far, 0, 1], [far, 2, 1], [far, 2, -1]], ALL, 5, 1);
    expect(b2.build().raycast(0, 1, 0, 1, 0, 0, 10)?.material).toBe(3);
    // Terrain at the same distance as an object does not replace it; strictly closer does.
    const b3 = new CollisionWorldBuilder();
    floor(b3, 0, -5, 5, -5, 5, ALL, 4, 2);
    floor(b3, 0, -5, 5, -5, 5, ALL | TRI_TERRAIN, TERRAIN_HIT_MATERIAL);
    floor(b3, 0.5, -5, 5, -5, 5, ALL | TRI_TERRAIN, TERRAIN_HIT_MATERIAL);
    const w3 = b3.build();
    expect(w3.raycast(0, 0.25, 0, 0, -1, 0, 10)?.material).toBe(4);
    expect(w3.raycast(0, 1, 0, 0, -1, 0, 10)?.terrain).toBe(true);
  });

  it("separates the query sets and filters by owner", () => {
    const b = new CollisionWorldBuilder();
    quad(b, [[0, -1, -1], [0, 1, -1], [0, 1, 1], [0, -1, 1]], TRI_BULLET, 14, 0); // glass: bullets only
    quad(b, [[2, -1, -1], [2, 1, -1], [2, 1, 1], [2, -1, 1]], TRI_SOLID, 21, 1); // hull: characters only
    const world = b.build();
    expect(world.raycast(-5, 0, 0, 1, 0, 0, 10, TRI_BULLET)?.material).toBe(14);
    expect(world.raycast(-5, 0, 0, 1, 0, 0, 10, TRI_SIGHT)).toBeNull();
    expect(world.raycast(-5, 0, 0, 1, 0, 0, 10, TRI_SOLID)?.material).toBe(21);
    expect(world.raycast(-5, 0, 0, 1, 0, 0, 10, TRI_BULLET | TRI_SOLID, 1)?.owner).toBe(1);
  });

  it("lists every hit along a ray, nearest first", () => {
    const b = new CollisionWorldBuilder();
    for (const x of [3, 1, 2]) quad(b, [[x, -1, -1], [x, -1, 1], [x, 1, 1], [x, 1, -1]].reverse(), TRI_SIGHT, x, x);
    // Off the quads' shared diagonal (an edge point is inside both triangles, as in the exe's test).
    const hits = b.build().raycastAll(0, 0.3, 0.1, 1, 0, 0, 10, TRI_SIGHT);
    expect(hits.map((h) => h.material)).toEqual([1, 2, 3]);
  });

  it("finds geometry from a ray starting outside the grid", () => {
    expect(room().raycast(-80, 1, 0, 1, 0, 0, 200)).not.toBeNull();
  });
});

describe("moveHuman (FUN_004600f0)", () => {
  it("falls onto the ground and stands on it", () => {
    const world = room();
    const s = standing([0, 3, 0], false);
    for (let i = 0; i < 60; i++) tick(world, s);
    expect(s.grounded).toBe(true);
    expect(feetY(s)).toBeCloseTo(0, 9);
    expect(s.ground?.terrain).toBe(true);
    expect(s.ground?.material).toBe(TERRAIN_HIT_MATERIAL);
  });

  it("stops at a wall one skin short of the hit and slides along it", () => {
    const world = room();
    const s = standing([0, 0, 0]);
    for (let i = 0; i < 60; i++) tick(world, s, [0.2, 0, 0]);
    expect(s.position[0]).toBeCloseTo(5 - SWEEP_SKIN_M, 9);
    expect(s.slid).toBe(true);
    const t = standing([4, 0, 0]);
    for (let i = 0; i < 10; i++) tick(world, t, [0.2, 0, 0.2]);
    expect(t.position[0]).toBeCloseTo(5 - SWEEP_SKIN_M, 9);
    expect(t.position[2]).toBeCloseTo(2, 9);
  });

  it("climbs a 0.3 m step (below the 0.4 m probe) and is stopped by a 0.45 m one", () => {
    const world = room();
    const s = standing([-3, 0, 0]);
    for (let i = 0; i < 40; i++) tick(world, s, [-0.1, 0, 0]);
    expect(s.position[0]).toBeLessThan(-6.5);
    expect(feetY(s)).toBeCloseTo(0.3, 6); // float32 triangle storage
    const b = new CollisionWorldBuilder();
    floor(b, 0, -50, 50, -50, 50);
    floor(b, 0.45, -10, -6, -2, 2);
    quad(b, [[-6, 0, -2], [-6, 0, 2], [-6, 0.45, 2], [-6, 0.45, -2]].reverse());
    const high = b.build();
    const t = standing([-3, 0, 0]);
    for (let i = 0; i < 40; i++) {
      if (!t.grounded) t.air[1] -= G;
      moveHuman(high, t, [-0.1, 0, 0], ROOT);
    }
    expect(t.position[0]).toBeCloseTo(-6 + SWEEP_SKIN_M, 9);
    expect(feetY(t)).toBeCloseTo(0, 9);
  });

  it("snaps down within 0.5 m and leaves the ground beyond it", () => {
    const b = new CollisionWorldBuilder();
    floor(b, 0.4, -50, 0, -5, 5);
    floor(b, 0, 0, 50, -5, 5);
    floor(b, -2, -50, 50, -50, 50);
    const world = b.build();
    const s = standing([-1, 0.4, 0]);
    for (let i = 0; i < 20; i++) tick(world, s, [0.1, 0, 0]);
    expect(s.grounded).toBe(true);
    expect(feetY(s)).toBeCloseTo(0, 9);
    expect(GROUND_SNAP_M.grounded).toBeCloseTo(0.5, 12);
    const t = standing([3, 0, 4]);
    tick(world, t, [0, 0, 1.2]); // off the platform edge at z = 5: 2 m drop
    expect(t.grounded).toBe(false);
    expect(t.ground?.distance).toBeCloseTo(2, 9);
  });

  it("raises the roof flag under a ceiling closer than 1.8 m to the probe", () => {
    const make = (h: number) => {
      const b = new CollisionWorldBuilder();
      floor(b, 0, -5, 5, -5, 5);
      quad(b, [[-5, h, -5], [5, h, -5], [5, h, 5], [-5, h, 5]]); // faces down
      return b.build();
    };
    const low = standing([0, 0, 0]);
    moveHuman(make(1.2), low, [0, 0, 0], ROOT);
    expect(low.roof).toBe(true); // 0.95 + (1.2 - 0.4) < 1.8
    const high = standing([0, 0, 0]);
    moveHuman(make(1.5), high, [0, 0, 0], ROOT);
    expect(high.roof).toBe(false);
  });

  it("caps the head under a ceiling while airborne", () => {
    const b = new CollisionWorldBuilder();
    floor(b, 0, -5, 5, -5, 5);
    quad(b, [[-5, 2.2, -5], [5, 2.2, -5], [5, 2.2, 5], [-5, 2.2, 5]]);
    const world = b.build();
    const s = standing([0, 0, 0]);
    leaveGround(s);
    s.air = [0, 0.25, 0];
    let highest = 0;
    for (let i = 0; i < 60; i++) {
      tick(world, s);
      highest = Math.max(highest, feetY(s));
    }
    expect(highest).toBeCloseTo(2.2 - 1.8 - SWEEP_SKIN_M, 6);
    expect(s.grounded).toBe(true);
    expect(feetY(s)).toBeCloseTo(0, 9);
  });

  it("slides down slopes steeper than 45 degrees", () => {
    const b = new CollisionWorldBuilder();
    // 60 degree slope rising towards +x.
    const k = Math.tan((60 * Math.PI) / 180);
    quad(b, [[0, 0, -5], [0, 0, 5], [5, 5 * k, 5], [5, 5 * k, -5]]);
    floor(b, 0, -20, 0, -5, 5);
    const world = b.build();
    const s = standing([2, 2 * k, 0]);
    tick(world, s);
    tick(world, s);
    expect(s.slide[0]).toBeLessThan(0); // downhill
    expect(s.position[0]).toBeLessThan(2);
  });

  it("takes the footstep material from the visible face under a hull", () => {
    const b = new CollisionWorldBuilder();
    floor(b, 0, -5, 5, -5, 5, TRI_SOLID, 21, 7); // HumanCollision hull top
    floor(b, 0, -5, 5, -5, 5, TRI_BULLET | TRI_SIGHT, 3, 7); // visible Wood floor of the same object
    floor(b, -0.2, -5, 5, -5, 5, TRI_BULLET | TRI_SIGHT, 11, 8); // another object's face below
    const s = standing([0, 0, 0]);
    moveHuman(b.build(), s, [0, 0, 0], ROOT);
    expect(s.ground?.material).toBe(3);
    expect(s.ground?.owner).toBe(7);
  });

  it("keeps characters inside the play area", () => {
    const world = room();
    const s = standing([0, 0, 0]);
    const area = { minX: -3, maxX: 3, minZ: -3, maxZ: 3 };
    for (let i = 0; i < 60; i++) moveHuman(world, s, [-0.2, 0, 0.2], ROOT, area);
    expect(s.position[0]).toBeCloseTo(-3, 9);
    expect(s.position[2]).toBeCloseTo(3, 9);
  });
});

describe("dynamic bodies", () => {
  /** A 1 m wide, 2 m tall door in the x = 0 plane (z in [0, 1]) as body 7, hinged at z = 0. */
  function doorWorld() {
    const b = new CollisionWorldBuilder();
    floor(b, 0, -50, 50, -50, 50);
    b.setTarget(7);
    quad(b, [[0, 0, 0], [0, 2, 0], [0, 2, 1], [0, 0, 1]], ALL, 3, 4);
    b.setTarget(null);
    return b.build(4);
  }
  /** Column-major rotation about +y by `a` around the hinge at the origin. */
  const rotY = (a: number) => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];

  it("blocks rays and characters in its build pose", () => {
    const world = doorWorld();
    expect(world.bodyIds).toEqual([7]);
    const hit = world.raycast(-3, 1, 0.5, 1, 0, 0, 10, TRI_BULLET);
    expect(hit?.distance).toBeCloseTo(3, 6);
    expect(hit?.triangle).toBe(-8);
    expect(hit?.material).toBe(3);
    expect(hit?.owner).toBe(4);
    // The door's outward side faces +x: approached from there it is a wall. Head-on, the
    // re-swept ray ends exactly on the face, so the slide repeats until the 10-pass cancel:
    // the body stops within one move of the face; any sideways component slides to the skin.
    const s = standing([1, 0, 0.5]);
    for (let i = 0; i < 20; i++) moveHuman(world, s, [-0.1, 0, 0], ROOT);
    expect(s.position[0]).toBeGreaterThan(0);
    expect(s.position[0]).toBeLessThanOrEqual(0.1 + 1e-9);
    const r = standing([1, 0, 0.2]);
    for (let i = 0; i < 20; i++) moveHuman(world, r, [-0.1, 0, 0.01], ROOT);
    expect(r.position[0]).toBeCloseTo(SWEEP_SKIN_M, 9);
    // ...from behind (a back face, as from inside a hull) it does not stop the move (move . n >= 0).
    const t = standing([-1, 0, 0.5]);
    for (let i = 0; i < 20; i++) moveHuman(world, t, [0.1, 0, 0], ROOT);
    expect(t.position[0]).toBeCloseTo(1, 9);
  });

  it("moves with its transform and can be switched off", () => {
    const world = doorWorld();
    world.setBodyTransform(7, rotY(Math.PI / 2)); // swings into the z = 0 plane, x in [0, 1]
    expect(world.raycast(-3, 1, 0.5, 1, 0, 0, 10, TRI_BULLET)).toBeNull();
    const hit = world.raycast(0.5, 1, -3, 0, 0, 1, 10, TRI_BULLET);
    expect(hit?.distance).toBeCloseTo(3, 6);
    expect(Math.abs(hit!.normal[2])).toBeCloseTo(1, 6);
    expect(world.raycastAll(0.5, 0.7, -3, 0, 0, 1, 10, TRI_SIGHT)).toHaveLength(1);
    world.setBodyEnabled(7, false);
    expect(world.raycast(0.5, 1, -3, 0, 0, 1, 10, TRI_BULLET)).toBeNull();
  });
});

describe("platform motion (FUN_0045f930)", () => {
  it("carries a human standing on a moving body and reports its heading change", () => {
    const b = new CollisionWorldBuilder();
    floor(b, -2, -50, 50, -50, 50); // ground far below
    b.setTarget(5);
    floor(b, 0, -2, 2, -2, 2, ALL, 3, 1); // a 4 m platform as body 5
    b.setTarget(null);
    const world = b.build();
    const s = standing([0.5, 0, 0]);
    moveHuman(world, s, [0, 0, 0], ROOT); // stand on it: platform captured
    expect(s.platform?.body).toBe(5);
    // The platform slides 0.1 m along +x per tick.
    for (let k = 1; k <= 10; k++) {
      world.setBodyTransform(5, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1 * k, 0, 0, 1]);
      moveHuman(world, s, [0, 0, 0], ROOT);
    }
    expect(s.position[0]).toBeCloseTo(1.5, 9);
    expect(s.grounded).toBe(true);
    // A quarter turn about the platform origin: the human swings round and turns with it.
    const a = Math.PI / 2;
    world.setBodyTransform(5, [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 1, 0, 0, 1]);
    moveHuman(world, s, [0, 0, 0], ROOT);
    expect(s.platformYaw).toBeCloseTo(a, 9);
    expect(s.position[0]).toBeCloseTo(1, 9); // (0.5 local) rotated onto -z
    expect(s.position[2]).toBeCloseTo(-0.5, 9);
  });
});

describe("platform rules (FUN_0045f930 / FUN_004600f0 / FUN_00461930)", () => {
  const rotYAt = (a: number, tx: number) => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, tx, 0, 0, 1];
  function platformWorld() {
    const b = new CollisionWorldBuilder();
    floor(b, -2, -50, 50, -50, 50); // ground far below
    b.setTarget(5);
    floor(b, 0, -4, 4, -4, 4, ALL, 3, 1); // an 8 m platform as body 5
    b.setTarget(null);
    return b.build();
  }

  it("only objects with the delta-move method carry (Train, Car, Elevator, StationaryGun)", () => {
    expect([...PLATFORM_TASK_TYPES].sort()).toEqual(["Car", "Elevator", "StationaryGun", "Train"]);
    const world = platformWorld();
    const s = standing([0.5, 0, 0]);
    const notCarried = { carries: (body: number) => body !== 5 };
    moveHuman(world, s, [0, 0, 0], ROOT, undefined, notCarried);
    world.setBodyTransform(5, rotYAt(0, 0.1));
    moveHuman(world, s, [0, 0, 0], ROOT, undefined, notCarried);
    expect(s.position[0]).toBeCloseTo(0.5, 9); // a Heli or a door does not move the human
    expect(s.platformMove).toEqual([0, 0, 0]);
  });

  it("moves the start of the move, reports the displacement in `moved` and keeps sweeping", () => {
    const world = platformWorld();
    const s = standing([0.5, 0, 0]);
    moveHuman(world, s, [0, 0, 0], ROOT);
    world.setBodyTransform(5, rotYAt(0, 0.1));
    moveHuman(world, s, [0.02, 0, 0], ROOT);
    expect(s.position[0]).toBeCloseTo(0.62, 9);
    expect(s.moved[0]).toBeCloseTo(0.12, 9); // +0x688 = move + platform displacement
    expect(s.grounded).toBe(true);
  });

  it("computes the displacement at the tick start; leaving the ground (jump) cancels the start shift", () => {
    const world = platformWorld();
    const s = standing([0.5, 0, 0]);
    moveHuman(world, s, [0, 0, 0], ROOT);
    world.setBodyTransform(5, rotYAt(0, 0.1));
    updatePlatform(world, s); // FUN_0045f930 before the state machine
    expect(s.platformMove[0]).toBeCloseTo(0.1, 9); // a jump entry adds this to its air velocity (0x40bc87)
    leaveGround(s); // FUN_00461f10 zeroes +0x728
    moveHuman(world, s, [0, 0, 0], ROOT);
    expect(s.position[0]).toBeCloseTo(0.5, 9);
  });

  it("uses the exe's pivot formula when the object's origin is known", () => {
    const prev = rotYAt(0, 0);
    const now = rotYAt(Math.PI / 2, 1); // turned a quarter about its origin and moved 1 m along x
    const p: [number, number, number] = [2, 0, 0];
    const exe = platformDelta(prev, now, p, [0, 0, 0]);
    // (c - p) - R_d (c - p) + t with c = (1, 0, 0), t = (1, 0, 0), R_d (-1, 0, 0) = (0, 0, 1)
    expect(exe.move[0]).toBeCloseTo(0, 9);
    expect(exe.move[2]).toBeCloseTo(-1, 9);
    const exact = platformDelta(prev, now, p);
    expect(exact.move[0]).toBeCloseTo(-1, 9);
    expect(exact.move[2]).toBeCloseTo(-2, 9);
    expect(exe.yaw).toBeCloseTo(Math.PI / 2, 9);
  });

  it("an attached human rides rigidly with its root motion only (no gravity, sweep or probe)", () => {
    const world = platformWorld();
    const s = standing([1, 0, 0], false);
    s.air = [0, -0.5, 0];
    expect(attachHuman(world, s, 5)).toBe(true);
    world.setBodyTransform(5, rotYAt(Math.PI / 2, 0));
    moveHuman(world, s, [0, 0, 0], ROOT);
    expect(s.position[0]).toBeCloseTo(0, 9); // (1, y, 0) turned onto -z
    expect(s.position[1]).toBeCloseTo(ROOT, 9); // no fall
    expect(s.position[2]).toBeCloseTo(-1, 9);
    expect(s.platformYaw).toBeCloseTo(Math.PI / 2, 9);
    moveHuman(world, s, [0, 0, -0.1], ROOT); // root motion in world axes, kept in the body's frame
    expect(s.position[2]).toBeCloseTo(-1.1, 9);
    world.setBodyTransform(5, rotYAt(Math.PI / 2, 2));
    moveHuman(world, s, [0, 0, 0], ROOT);
    expect(s.position[0]).toBeCloseTo(2, 9);
    expect(s.position[2]).toBeCloseTo(-1.1, 9);
    detachHuman(s);
    expect(s.attach).toBeNull();
  });
});
