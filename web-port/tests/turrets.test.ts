/**
 * Vehicle-mounted weapons and the Missile object (combat/vehicle-weapons.ts,
 * combat/missile.ts): synthetic tests of the recovered rules (full exe
 * addresses in the modules' headers). The full-data tests are in
 * tests/full-turrets.test.ts.
 */
import { describe, expect, it } from "vitest";
import { decodePhysicsObjType, type MissileConfig } from "../src/loaders/vehicles";
import type { QvmValue } from "../src/loaders/qvm";
import type { Mat3 } from "../src/loaders/mission";
import { headingFromY, vehicleInCone } from "../src/loaders/car-ai";
import { aiTurretAim, aiTurretDef, newAiTurretState, stepAiTurret } from "../src/loaders/objects/ai-stationary-gun";
import { LevelRng } from "../src/engine/ai/rng";
import {
  MISSILE_GUIDANCE,
  MISSILE_RULES,
  createMissile,
  hindGuidance,
  horizontalAngle,
  missileDragElements,
  missileSmoke,
  missileSmokeSystem,
  missileTypeFor,
  updateMissile,
  verticalAngle,
  type MissileType,
} from "../src/engine/combat/missile";
import { RPG18_MISSILE_TYPE } from "../src/engine/combat/projectiles";
import { placeTurret, podLaunch, podSees, turretGunPose, VEHICLE_WEAPON_RULES, type MountedTurret } from "../src/engine/combat/vehicle-weapons";
import type { GrenadeWorld } from "../src/engine/combat/grenade";

const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const sym = (symbol: string): QvmValue => ({ symbol }) as QvmValue;
const UNITS = 4096;

/** QVM float arguments are float32 values. */
const f32Args = (a: QvmValue[]): QvmValue[] => a.map((v) => (typeof v === "number" ? Math.fround(v) : v));
/** physicsobj/missiles/RPG18/missile.qvm's DefinePhysicsObjType arguments [observed]. */
const RPG18_ARGS: QvmValue[] = f32Args([
  sym("TASKTYPE_MISSILE"), 1, 10, 0.4, 5, 0.4, "<SAM>", "<SAMDESC>", "110_02_1", 1, 0, 0, 5, 0.2, 1, 1, 0.7, 0.001,
  200, 5, 0.8, 5, 0.8, 5, 0.8, 200, 0.027, 0.003, 4, 1, 0, 4, 0, 0, 0, 1, 1, 0, 4, 0, 1, 0, 0, ...new Array(14).fill(0), 0, 0, 0,
  sym("MISSILE_SMOKE_NORMAL"), sym("MISSILE_TYPE_MISSILE_DIRECT"), 4, 1, 50, 0.25, 0.5, 1, 1, "smoke2.spr", "radarwind_1",
]);
/** physicsobj/missiles/HIND/missile.qvm [observed]. */
const HIND_ARGS: QvmValue[] = f32Args([
  sym("TASKTYPE_MISSILE"), 1, 10, 0.4, 5, 0.4, "<SAM>", "<SAMDESC>", "700_10_1", 1, 0, 0, 5, 0.2, 1, 1, 0.7, 0.001,
  25, 35, 0.9, 35, 0.9, 35, 0.9, 25, 0.027, 0.003, 4, 1, 0, 4, 0, 0, 0, 1, 1, 0, 4, 0, 1, 0, 0, ...new Array(14).fill(0), 0, 0, 0,
  sym("MISSILE_SMOKE_NORMAL"), sym("MISSILE_TYPE_HIND_HELICOPTER"), 30, 1, 50, 0.1, 0.9, 0.9, 4, "smoke2.spr", "radarwind_1",
]);

/** A horizontal ground plane z = 0 for the missile's contact rays. */
const flatGround = (z = 0): GrenadeWorld => ({
  segment(from, to) {
    if (from[2] >= z && to[2] < z) {
      const t = (from[2] - z) / (from[2] - to[2]);
      return { distance: t * Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]), normal: [0, 0, 1], front: true };
    }
    return null;
  },
  inside: (p) => p[2] < z,
});
const EMPTY: GrenadeWorld = { segment: () => null, inside: () => false };

describe("Missile type (FUN_00429730) and spawn (FUN_00429a30)", () => {
  it("decodes the RPG18 tail: direct guidance, fuel 4, burn 1/30, smoke spacing 0.25 m, sound radarwind_1", () => {
    const t = decodePhysicsObjType(RPG18_ARGS);
    const c = t.config as MissileConfig;
    expect(t.taskType).toBe("TASKTYPE_MISSILE");
    expect(c.c).toEqual([200, 5, Math.fround(0.8), 5, Math.fround(0.8), 5, Math.fround(0.8), 200, Math.fround(0.027), Math.fround(0.003)]);
    expect(c.drag).toHaveLength(4);
    expect(c.drag[0]).toMatchObject({ coef: 1, normal: [0, 0, 1], point: [0, 16384, 0] });
    expect([c.smoke, c.guidance, c.fuel, c.smokeSpacing, c.smokeGrowth, c.smokeInterval, c.smokeSize, c.sprite, c.sound]).toEqual([1, 0, 4, 1024, 2048, 1, 1, "smoke2.spr", "radarwind_1"]);
    expect(c.burn).toBe(Math.fround(0.03333333507180214));
    const h = decodePhysicsObjType(HIND_ARGS).config as MissileConfig;
    expect([h.guidance, h.fuel, h.c[7], h.c[1], h.c[5], h.smokeInterval, h.smokeSize]).toEqual([MISSILE_GUIDANCE.hind, 30, 25, 35, 35, Math.fround(0.9), 4]);
  });

  it("FUN_00429ef0: drag elements 2 / 3 are 0 / 1 with the point's y negated (nose pair mirrored to the tail)", () => {
    const c = decodePhysicsObjType(RPG18_ARGS).config as MissileConfig;
    const d = missileDragElements(c);
    expect(d[2]).toEqual({ coef: 1, normal: [0, 0, 1], point: [0, -16384, 0] });
    expect(d[3]).toEqual({ coef: 1, normal: [1, 0, 0], point: [0, -16384, 0] });
  });

  it("spawn: velocity = col 1 x muzzle velocity x 136.53334 (5 m/s -> 682.7 units/tick), throttle 1, the type's fuel; DIRECT aim 1000 m ahead", () => {
    const type = missileTypeFor([decodePhysicsObjType(RPG18_ARGS)], "110_02_1", [[0, 2420, 0], [0, -2444, 0]])!;
    expect(type.points).toEqual([{ local: [0, 2420, 0], restitution: Math.fround(0.2), grip: 1 }]);
    const m = createMissile(type, { position: [100, 200, 300], matrix: I3, muzzleVelocity: 5 });
    expect(m.body.velocity[1]).toBeCloseTo(682.6667, 3);
    expect([m.throttle, m.throttleTarget, m.fuel]).toEqual([1, 1, 4]);
    expect(m.aim[1]).toBeCloseTo(200 + MISSILE_RULES.directRange, 0);
  });
});

describe("Missile flight (0x428390, FUN_00428d00 + FUN_004fc0e0)", () => {
  it("burns 4 s with v <- 0.95 (v + 892): 53.1 m/s after 10 ticks, ~124 m/s at burnout (tick 120), straight; then it tumbles", () => {
    const rng = new LevelRng(0);
    const m = createMissile(RPG18_MISSILE_TYPE, { position: [0, 0, 1000 * UNITS], matrix: I3, muzzleVelocity: 5 });
    const speeds: number[] = [];
    for (let t = 1; t <= 130; t++) {
      expect(updateMissile(m, { world: EMPTY, rng, frame: 1, probeDown: () => true })).toBe("fly");
      speeds.push((m.body.speed * 30) / UNITS);
      if (t <= 120) expect([m.matrix[1], m.matrix[4], m.matrix[7]]).toEqual([0, 1, 0]);
    }
    expect(speeds[9]).toBeCloseTo(53.1, 0);
    expect(speeds[119]).toBeGreaterThan(123.5);
    expect(speeds[119]).toBeLessThan(124.5);
    expect(m.fuel).toBe(0);
    // Out of fuel: the tumble turns the body, and the 0.95 damping slows it.
    expect(m.matrix[4]).toBeLessThan(1);
    expect(speeds[129]).toBeLessThan(90);
  });

  it("the tumble and the smoke draw from the missile generator only: 1 + 6 n draws per smoke emission, 3 per tumble tick", () => {
    const rng = new LevelRng(0);
    const m = createMissile(RPG18_MISSILE_TYPE, { position: [0, 0, 1000 * UNITS], matrix: I3, muzzleVelocity: 5 });
    // First update: speed 682.7 / spacing 1024 -> n = 0 -> 1 particle: 1 + 6 draws.
    const emitted: number[] = [];
    updateMissile(m, { world: EMPTY, rng, frame: 1, probeDown: () => true, smoke: (p) => emitted.push(p.fadeTicks) });
    expect(rng.draws).toBe(7);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBeGreaterThanOrEqual(18);
    expect(emitted[0]).toBeLessThanOrEqual(27);
    while (m.fuel > 0) updateMissile(m, { world: EMPTY, rng, frame: 1, probeDown: () => true });
    const before = rng.draws;
    updateMissile(m, { world: EMPTY, rng, frame: 1, probeDown: () => true });
    expect(rng.draws - before).toBe(3);
  });

  it("smoke system FUN_00429dc0: half-size 1024, growth (2048 / 1024 - 1) / 30 per tick, rising 0.0218, 2000 particles", () => {
    const s = missileSmokeSystem(RPG18_MISSILE_TYPE.config);
    expect(s).toMatchObject({ sprite: "smoke2.spr", halfSize: [1024, 1024], maxParticles: 2000, far: 2048000, flags: 0x1080000 });
    expect(s.growth).toBeCloseTo(1 / 30, 6);
    expect(s.accel[2]).toBeCloseTo(0.0217778, 6);
    const rng = new LevelRng(0);
    const m = createMissile(RPG18_MISSILE_TYPE, { position: [0, 0, 0], matrix: I3, muzzleVelocity: 5 });
    m.body.velocity = [0, 16384, 0];
    m.body.updateSpeed();
    const pts: number[][] = [];
    missileSmoke(m, rng, (p) => pts.push(p.position));
    // n = fistp(16384 / 1024) = 16 particles spaced v / 16 from the tail (magic vertex 1).
    expect(pts).toHaveLength(16);
    expect(pts[0][1]).toBeCloseTo(-2444, 3);
    expect(pts[1][1] - pts[0][1]).toBeCloseTo(1024, 3);
  });

  it("contact: the nose ray meets the ground -> explode (impulse with e 0.2); no ground within 1000 m on a probe frame -> deleted", () => {
    const rng = new LevelRng(0);
    const pitchDown: Mat3 = [1, 0, 0, 0, Math.cos(-0.3), -Math.sin(-0.3), 0, Math.sin(-0.3), Math.cos(-0.3)];
    const m = createMissile(RPG18_MISSILE_TYPE, { position: [0, 0, 5 * UNITS], matrix: pitchDown, muzzleVelocity: 5 });
    let out = "fly";
    let ticks = 0;
    while (out === "fly" && ticks < 300) {
      out = updateMissile(m, { world: flatGround(0), rng, frame: 1, probeDown: () => true });
      ticks++;
    }
    expect(out).toBe("explode");
    expect(m.contacts).toBeGreaterThan(0);
    expect(m.position[2]).toBeLessThan(2 * UNITS);
    const lost = createMissile(RPG18_MISSILE_TYPE, { position: [0, 0, 5 * UNITS], matrix: I3, muzzleVelocity: 5 });
    expect(updateMissile(lost, { world: EMPTY, rng, frame: 33, probeDown: () => false })).toBe("fly");
    expect(updateMissile(lost, { world: EMPTY, rng, frame: 64, probeDown: () => false })).toBe("delete");
  });

  it("HIND guidance FUN_00428930 / FUN_00428b60: the inputs point at the target (left / up positive), clamped to +-1; the rocket turns toward it", () => {
    const hind = missileTypeFor([decodePhysicsObjType(HIND_ARGS)], "700_10_1", [[0, 2420, 0], [0, -2444, 0]]) as MissileType;
    const m = createMissile(hind, { position: [0, 0, 0], matrix: I3, muzzleVelocity: 10, target: [-100 * UNITS, 100 * UNITS, 20 * UNITS] });
    expect(m.offset).toEqual([-100 * UNITS, 100 * UNITS, 20 * UNITS]);
    hindGuidance(m);
    expect(m.inputs[2]).toBeGreaterThan(0); // target to the left (x < 0)
    expect(m.inputs[0]).toBeGreaterThan(0); // and above
    const rng = new LevelRng(0);
    for (let t = 0; t < 20; t++) updateMissile(m, { world: EMPTY, rng, frame: 1, probeDown: () => true });
    const fwd = [m.matrix[1], m.matrix[4], m.matrix[7]];
    expect(fwd[0]).toBeLessThan(-0.3);
    expect(fwd[2]).toBeGreaterThan(0);
  });

  it("FUN_00414950 / FUN_004148f0: the horizontal heading ignores z, the vertical angle ignores x (signed)", () => {
    expect(horizontalAngle([1, 1, 50])).toBeCloseTo(-Math.PI / 4, 9);
    expect(headingFromY([1, 1, 50])).toBeCloseTo(-Math.PI / 4, 9);
    expect(verticalAngle([30, 1, -1])).toBeCloseTo(-Math.PI / 4, 9);
    // The vehicle cone's gamma test uses the horizontal heading: a target far above but straight ahead passes a 60 deg gamma.
    const eye = { position: [0, 0, 0] as [number, number, number], matrix: I3, alpha: Math.PI, gamma: Math.PI / 3, length: 100 * UNITS };
    expect(vehicleInCone(eye, [0, 10 * UNITS, 50 * UNITS])).toBe(true);
  });
});

describe("Mounted turrets (0x46f390, 0x46fba0, FUN_00470050) and rocket pods (FUN_00427a70)", () => {
  const def = aiTurretDef(["601_02_1", "601_02_1", { symbol: "TASKTYPE_AISTATIONARYGUN" }, "601_05_1", 361, 75, -8, 10000, 30, 30, "tank_turret", 0, 6])!;
  const turret = (attach: Mat3, offset: [number, number, number], pivot: [number, number, number]): MountedTurret => ({
    id: 1, vehicleKey: 1, instance: 0, path: "17", model: "601_02_1", container: null, children: [], offset, attach, def, pivot, state: newAiTurretState(),
    position: [0, 0, 0], matrix: I3, gunPosition: [0, 0, 0], gunMatrix: I3,
    gun: { weapon: null, missileModel: null, cooldown: 0, shots: 0, clip: 10000, firing: false, rounds: 0, magic: [] }, turning: null, flash: null, updates: 0,
  });

  it("place: turret = P + Pm offset, Pm B Rz(yaw); the Gun at the turret's magic vertex 1 with V Rz(yaw) Rx(pitch): its col 1 points at the aimed target", () => {
    // APC-like turret: B = Rz(pi), pivot 1.2 m behind in the turret frame (= ahead in the car frame).
    const B: Mat3 = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
    const t = turret(B, [0, 0, 4096], [0, -4844, 1478]);
    const c = Math.cos(0.5);
    const s = Math.sin(0.5);
    const V: Mat3 = [c, -s, 0, s, c, 0, 0, 0, 1]; // the car yawed 0.5 rad
    placeTurret(t, [1000, 2000, 0], V, V);
    expect(t.position).toEqual([1000, 2000, 4096]);
    // Aim at a target ahead-left and below, then slew until in the window.
    const target = [1000 + 40 * 4096 * -s, 2000 + 40 * 4096 * c, -4096];
    for (let i = 0; i < 200; i++) {
      stepAiTurret(def, t.state, aiTurretAim(V, t.position, target));
      placeTurret(t, [1000, 2000, 0], V, V);
    }
    const g = turretGunPose(t, V);
    const d = [target[0] - g.position[0], target[1] - g.position[1], target[2] - g.position[2]];
    const n = Math.hypot(d[0], d[1], d[2]);
    const fwd = [g.matrix[1], g.matrix[4], g.matrix[7]];
    expect(fwd[0] * d[0] / n + fwd[1] * d[1] / n + fwd[2] * d[2] / n).toBeGreaterThan(0.995);
    // The pivot (magic vertex 1) lies ahead of the turret origin in the car frame (B = Rz(pi)).
    const ahead = (g.position[0] - t.position[0]) * -s + (g.position[1] - t.position[1]) * c;
    expect(ahead).toBeCloseTo(4844, 0);
  });

  it("a nested turret (T80 614_10_1) is placed in its container's frame but aims in the vehicle's frame", () => {
    const main = turret(I3, [0, 0, 4096], [0, 0, 0]);
    const mg = turret(I3, [4096, 0, 1024], [0, 0, 0]);
    main.children.push(mg);
    mg.container = main;
    main.state.yaw = Math.fround(Math.PI / 2);
    placeTurret(main, [0, 0, 0], I3, I3);
    // The MG sits on the turned main turret: offset (1 m, 0) turned by 90 deg -> (0, 1 m).
    expect(mg.position[0]).toBeCloseTo(0, 3);
    expect(mg.position[1]).toBeCloseTo(4096, 3);
    // Its gun uses the vehicle matrix with its own yaw (0): forward = vehicle +y.
    expect([mg.gunMatrix[1], mg.gunMatrix[4], mg.gunMatrix[7]]).toEqual([0, 1, 0]);
  });

  it("rocket pod: targets in front with |heading| < 1.3 rad; launch 0.5 m ahead at heli speed + 5 m/s", () => {
    const pod: Mat3 = I3;
    expect(podSees([0, 0, 0], pod, [10, 100, -50])).toBe(true);
    expect(podSees([0, 0, 0], pod, [10, -100, 0])).toBe(false); // behind
    expect(podSees([0, 0, 0], pod, [1000, 200, 0])).toBe(false); // 1.37 rad to the right
    const l = podLaunch([0, 0, 0], pod, 4096 / 30 * 20); // heli at 20 m/s
    expect(l.position).toEqual([0, VEHICLE_WEAPON_RULES.podForward, 0]);
    expect(l.speed).toBeCloseTo(25, 4);
  });
});
