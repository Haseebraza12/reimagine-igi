/**
 * Thrown grenades (src/engine/combat/grenade.ts), the player's S7 grenade and
 * S10 medipack states (src/engine/combat/weapon.ts); docs/weapons-view.md,
 * docs/damage.md "Grenade flight". Real-data checks use the staged original
 * files and are skipped when they are absent.
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { LEVEL1_PATHS, loadIgiLevel, readAnimations, type IgiLevel } from "../src/loaders";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { loadDamageModelData, type DamageModelData } from "../src/loaders/damage-data";
import type { PhysicsObjType } from "../src/loaders/vehicles";
import type { Mat3 } from "../src/loaders/coords";
import { EventBus } from "../src/engine/events";
import { LevelRng } from "../src/engine/ai/rng";
import { EV, type AiEvent } from "../src/engine/ai/types";
import type { GameContext } from "../src/engine/context";
import { createWeaponSystem, WEAPON_STATE, type WeaponSystem } from "../src/engine/combat/weapon";
import { readWeaponExtras } from "../src/engine/combat/weapon-tags";
import {
  GRENADE_CONSTANTS as G,
  collisionGrenadeWorld,
  createGrenade,
  createGrenadeSystem,
  grenadeFuseTicks,
  grenadeSystemOf,
  grenadeTypeFor,
  playerThrowSpeed,
  soldierThrowVelocity,
  stepGrenadePhysics,
  type Grenade,
  type GrenadeType,
  type GrenadeWorld,
} from "../src/engine/combat/grenade";
import { DAMAGE_EVENTS, attachDamageSystem, createDamageSystem, damageModelNames, type ExplosionEventPayload } from "../src/engine/combat/object-damage";
import { buildWorld, type BuiltWorld } from "../src/engine/world/world-builder";
import { TRI_BULLET, TRI_SIGHT, TRI_SOLID } from "../src/engine/world/collision";
import { createGrenadeRenderer } from "../src/engine/render/grenades";
import { pickupMatrix } from "../src/engine/render/pickups";
import { RAW_ROOT, readRaw } from "./helpers";

const haveRaw =
  existsSync(`${RAW_ROOT}/${LEVEL1_PATHS.objects}`) &&
  existsSync(`${RAW_ROOT}/weapons/weaponconfig.qvm`) &&
  existsSync(`${RAW_ROOT}/physicsobj/physicsobj.qvm`) &&
  existsSync(`${RAW_ROOT}/common/anims/005.iff`);

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A hand-grenade-like type: the DefinePhysicsObjType values with a 135_01_1-like point set. */
function testType(): GrenadeType {
  const local: Array<[number, number, number]> = [
    [-191, -9, -64],
    [190, -9, -64],
    [4, 188, -64],
    [4, -206, -64],
    [4, -10, -328],
  ];
  return {
    model: "135_01_1",
    mass: Math.fround(0.3),
    size: [Math.fround(0.1), Math.fround(0.1), Math.fround(0.15)],
    points: local.map((p) => ({ local: p, restitution: Math.fround(0.3), grip: 1 })),
    restSpeed: 3,
    restAngular: Math.fround(0.016),
    fuseSeconds: 4,
    explosion: 0,
    originRadius: 356.58,
  };
}

/** The plane z = 0 (outward normal +z); below it is solid. */
const floor: GrenadeWorld = {
  segment(from, to) {
    if (!(from[2] >= 0 && to[2] < 0)) return null;
    return { distance: (from[2] / (from[2] - to[2])) * Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]), normal: [0, 0, 1], front: true };
  },
  inside: (p) => p[2] < 0,
};

const lowestPoint = (g: Grenade): number =>
  Math.min(...g.type.points.map((p) => g.position[2] + g.matrix[6] * p.local[0] + g.matrix[7] * p.local[1] + g.matrix[8] * p.local[2]));

describe("grenade rules (no data)", () => {
  it("runs the fuse for 4 s x 30 less the cooked ticks, never below 0 (FUN_00475760)", () => {
    expect(grenadeFuseTicks(4, 0)).toBe(120);
    expect(grenadeFuseTicks(4, 21)).toBe(99);
    expect(grenadeFuseTicks(4, 500)).toBe(0);
  });

  it("throws at (pow(50 h, 0.7) + 0.1 h) x Muzzle Velocity, h clamped to 3..60 (FUN_00461a90)", () => {
    const at = (h: number) => (Math.pow(h * 50, 0.7) + h * Math.fround(0.1)) * 15;
    expect(playerThrowSpeed(0, 15)).toBe(at(3));
    expect(playerThrowSpeed(14, 15)).toBe(at(14));
    expect(playerThrowSpeed(200, 15)).toBe(at(60));
    // units/tick -> m/s: 3.7 to 30.5 m/s for the hand grenade (Muzzle Velocity 15).
    expect((playerThrowSpeed(3, 15) * 30) / 4096).toBeCloseTo(3.70, 2);
    expect((playerThrowSpeed(60, 15) * 30) / 4096).toBeCloseTo(30.5, 1);
  });

  it("aims a soldier's throw with 1.1 d / T + (0, 0, g T / 2) (FUN_00451740)", () => {
    const v = soldierThrowVelocity([0, 0, 0], [30 * 4096, -4096, 2048], 1);
    expect(v[0]).toBeCloseTo((1.1 * 30 * 4096) / 30, 3);
    expect(v[1]).toBeCloseTo((-1.1 * 4096) / 30, 3);
    expect(v[2]).toBeCloseTo((1.1 * 2048) / 30 + 30 * 22.300444444444445, 3);
  });

  it("bounces a central hit with v+ = -0.3 v- (FUN_004f3500 with the point's restitution)", () => {
    const type = { ...testType(), points: [{ local: [0, 0, 0] as [number, number, number], restitution: Math.fround(0.3), grip: 1 }] };
    const g = createGrenade({ weaponId: "W", model: "135_01_1", position: [0, 0, 300], matrix: IDENTITY, velocity: [0, 0, -500], cooked: 0, tags: null, thrower: "player" }, type, 0);
    stepGrenadePhysics(g, floor);
    // Gravity first (FUN_004f2bb0), then the impulse -(1 + e) vn m along n (r = 0: no turn); then the move by the new v.
    const vn = Math.fround(-500 - G.gravity);
    expect(g.contacts).toBe(1);
    expect(g.body.velocity[2]).toBeCloseTo(-0.3 * vn, 2);
    expect(g.position[2]).toBeCloseTo(300 + g.body.velocity[2], 3);
  });

  it("drops onto the floor: the first point in index order takes the hit, no point ends below it (FUN_004f25c0, FUN_004f3240)", () => {
    const g = createGrenade({ weaponId: "W", model: "135_01_1", position: [0, 0, 8192], matrix: IDENTITY, velocity: [0, 0, 0], cooked: 0, tags: null, thrower: "player" }, testType(), 0);
    let first = -1;
    let rose = false;
    const heights: number[] = [];
    for (let t = 0; t < 120; t++) {
      stepGrenadePhysics(g, floor);
      expect(lowestPoint(g)).toBeGreaterThanOrEqual(0);
      if (first < 0 && g.contacts > 0) {
        first = t;
        // Every point's path is cast with the whole tick's motion: side point 0 crosses the floor in the same
        // tick as the bottom point 4 and, coming first, takes the impulse (the grenade starts to tumble).
        expect(g.touching[0]).toBe(true);
        expect(g.body.angularMomentum.some((l) => l !== 0)).toBe(true);
      }
      if (first >= 0 && g.body.velocity[2] > 0) rose = true;
      heights.push(g.position[2]);
    }
    expect(first).toBe(19);
    expect(rose).toBe(true);
    // Settled: the position no longer changes (|v| stays under the 40.96 units/tick move threshold).
    expect(new Set(heights.slice(-20)).size).toBe(1);
    expect(lowestPoint(g)).toBeLessThan(10);
  });

  it("slows a sliding grenade by at most g x grip per tick (FUN_004f38c0)", () => {
    const g = createGrenade({ weaponId: "W", model: "135_01_1", position: [0, 0, 330], matrix: IDENTITY, velocity: [400, 0, 0], cooked: 0, tags: null, thrower: "player" }, testType(), 0);
    const speeds: number[] = [];
    for (let t = 0; t < 20; t++) {
      stepGrenadePhysics(g, floor);
      speeds.push(Math.hypot(g.body.velocity[0], g.body.velocity[1]));
    }
    for (let i = 1; i < speeds.length; i++) expect(speeds[i - 1] - speeds[i]).toBeLessThanOrEqual(G.gravity + 1e-3);
    expect(speeds[speeds.length - 1]).toBeLessThan(1);
  });

  it("explodes on the 121st update; bounce sound and GRENADELAND re-armed after 10 ticks off the ground (FUN_004751f0, FUN_004753f0)", () => {
    const events: Array<AiEvent & { tick: number }> = [];
    const sounds: number[] = [];
    const type = testType();
    const physics: PhysicsObjType = {
      source: "", taskType: "TASKTYPE_GRENADE", index: 0, mass: type.mass, size: type.size, name: "", description: "", model: "135_01_1",
      points: type.points.map((_, i) => ({ vertex: i, a: 0, b: 6, c: Math.fround(0.3), gripLateral: 1, gripRolling: 1 })),
      restSpeed: 3, restAngular: Math.fround(0.016), config: { raw: [4, { symbol: "GRENADE_EXPLOSIONTYPE_NORMAL" }] },
    };
    const ctx = {
      level: { vehicles: { types: [physics] }, originIgi: [0, 0, 0] },
      world: null,
      tick: 0,
      events: new EventBus(),
      systems: { audio: { playAt: (n: string) => n === "grenade_bnc_1" && sounds.push(ctx.tick) } },
    } as unknown as GameContext;
    const sys = createGrenadeSystem(ctx);
    sys.setWorld(floor);
    sys.setAiEvents((ev) => events.push({ ...ev, tick: ctx.tick }));
    const g = sys.spawn({ weaponId: "WEAPON_ID_GRENADE", model: "135_01_1", position: [0, 0, 4096], matrix: IDENTITY, velocity: [300, 0, 200], cooked: 0, tags: null, thrower: "player" })!;
    expect(g.fuse).toBe(120);
    expect(events.map((e) => [e.type, e.team, e.flags, e.range])).toEqual([[EV.GRENADETHROWN, -1, 1, -1]]);
    let updates = 0;
    const contacts: boolean[] = [];
    while (sys.grenades.length && updates < 500) {
      sys.update();
      contacts.push(g.contacts > 0);
      updates++;
      (ctx as { tick: number }).tick++;
    }
    expect(updates).toBe(121);
    expect(g.exploded).toBe(true);
    const lands = events.filter((e) => e.type === EV.GRENADELAND);
    expect(sounds.length).toBeGreaterThanOrEqual(1);
    expect(lands.map((e) => e.tick)).toEqual(sounds);
    expect(lands[0]).toMatchObject({ team: -1, flags: 2, range: 20480 });
    // Each later sound needs a contact-free tick more than 10 ticks after the previous sound.
    for (let k = 1; k < sounds.length; k++) {
      const quiet = contacts.slice(sounds[k - 1] + 11, sounds[k]).some((c) => !c);
      expect(quiet).toBe(true);
    }
    // The first sound is on the first contact.
    expect(sounds[0]).toBe(contacts.indexOf(true));
  });
});

// --- Real data -------------------------------------------------------------------

interface Rig {
  ctx: GameContext;
  ws: WeaponSystem;
  held: Set<string>;
  ticks: number;
  attached: Array<{ name: string; tick: number; killed: number }>;
  tick(): void;
  run(n: number): void;
}

function rig(level: IgiLevel, weaponConfig: ArrayBuffer): Rig {
  const held = new Set<string>();
  const input = { get isFiring() { return held.has("Fire"); }, action: (a: string) => held.has(a), actionPressed: () => false, forward: 0, strafe: 0 };
  const attached: Rig["attached"] = [];
  const r = {} as Rig;
  const ctx = {
    level,
    world: null,
    tick: 0,
    events: new EventBus(),
    input,
    rng: new LevelRng(),
    player: { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false, health: 3, maxHealth: 3, alive: true, walking: false, eyeHeight: 1.64, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0 },
    weapon: null,
    systems: {
      weapon: null, enemies: null, objectives: null, hud: null, effects: null, tasks: null, player: null,
      audio: {
        attachTo(name: string) {
          const rec = { name, tick: r.ticks, killed: -1 };
          attached.push(rec);
          return { kill: () => (rec.killed = r.ticks) };
        },
        playAt: () => null,
      },
    },
    running: true,
    camera: new THREE.PerspectiveCamera(),
  } as unknown as GameContext;
  const ws = createWeaponSystem(ctx);
  ws.setWeaponExtras(readWeaponExtras(weaponConfig));
  ws.reset();
  Object.assign(r, {
    ctx, ws, held, ticks: 0, attached,
    tick() {
      r.ticks++;
      ws.update(1 / 30);
      grenadeSystemOf(ctx).update(); // the Dynamic walk after the player (enemy.ts ticks it in the game)
      (ctx as { tick: number }).tick++;
    },
    run(n: number) {
      for (let i = 0; i < n; i++) r.tick();
    },
  });
  return r;
}

/** Select a weapon category and wait until it is in the hand and S1 runs again. */
function bringUp(r: Rig, key: number, id: string): void {
  r.ws.selectCategory(key);
  for (let i = 0; i < 80 && !(r.ctx.weapon?.spec.scriptId === id && r.ws.state === WEAPON_STATE.ready); i++) r.tick();
  expect(r.ctx.weapon?.spec.scriptId).toBe(id);
  expect(r.ws.state).toBe(WEAPON_STATE.ready);
}

describe.skipIf(!haveRaw)("grenades and the medipack (level 1 data)", () => {
  let level: IgiLevel;
  let weaponConfig: ArrayBuffer;
  beforeAll(async () => {
    level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
    weaponConfig = await readRaw("weapons/weaponconfig.qvm");
  }, 120_000);

  it("reads the grenade physics types, weaponconfig tags and arms clips", async () => {
    const types = level.vehicles?.types ?? [];
    const hand = types.find((t) => t.taskType === "TASKTYPE_GRENADE" && t.model === "135_01_1")!;
    expect(hand).toMatchObject({ mass: Math.fround(0.3), restSpeed: 3, restAngular: Math.fround(0.016) });
    expect(hand.size).toEqual([Math.fround(0.1), Math.fround(0.1), Math.fround(0.15)]);
    expect(hand.points.map((p) => [p.vertex, p.c, p.gripRolling])).toEqual([0, 1, 2, 3, 4].map((v) => [v, Math.fround(0.3), 1]));
    const data = await loadDamageModelData(createFsAssetSource(RAW_ROOT), ["135_01_1", "137_01_1"], [], () => true);
    const b = data.bounds.get("135_01_1")!;
    const t = grenadeTypeFor(types, "135_01_1", b.magic, b.originRadius)!;
    expect(t).toMatchObject({ fuseSeconds: 4, explosion: 0 });
    expect(t.points[4].local[2]).toBeCloseTo(-327.83, 1); // the bottom of the grenade
    const flash = data.bounds.get("137_01_1")!;
    expect(grenadeTypeFor(types, "137_01_1", flash.magic, flash.originRadius)).toMatchObject({ fuseSeconds: 4, explosion: 1 });
    expect(damageModelNames(level).bounds.has("135_01_1")).toBe(true);
    const x = readWeaponExtras(weaponConfig);
    expect(x.get("WEAPON_ID_GRENADE")).toMatchObject({ taskType: "TASKTYPE_GUN", projectileType: "TASKTYPE_GRENADE", grenade: { damage: 1, radiusM: 7, falloffM: 3 } });
    expect(x.get("WEAPON_ID_FLASHBANG")!.grenade).toEqual({ damage: 1, radiusM: 10, falloffM: 15 });
    expect(x.get("WEAPON_ID_MEDIPACK")).toMatchObject({ taskType: "TASKTYPE_MEDIPACK", projectileType: null, medipackFactor: Math.fround(0.01) });
    const anim = readAnimations(level.animations.get(5)!);
    expect(anim.clips.get(24)!.events.map((e) => [e.trigger, e.time])).toEqual([[4, 3520]]);
    expect(anim.clips.get(25)!.events.map((e) => [e.trigger, e.time])).toEqual([[3, 960]]);
    expect(anim.clips.get(78)!.events.map((e) => e.trigger)).toEqual([1050]); // "syringe"
  });

  it("S7: pin on tick 22, FireAnim2 on 29, throw on 35 at h = 14, refill on 47, S1 on 58 (tap)", () => {
    const r = rig(level, weaponConfig);
    r.ws.addWeapon("WEAPON_ID_GRENADE", 1);
    r.ws.addWeaponAmmo("WEAPON_ID_GRENADE", 1);
    r.ws.addWeaponAmmo("WEAPON_ID_GRENADE", 1);
    expect(r.ws.reserveOf("AMMO_ID_GRENADE")).toBe(2);
    r.run(30);
    bringUp(r, 7, "WEAPON_ID_GRENADE");
    const grenades = grenadeSystemOf(r.ctx);
    r.held.add("Fire");
    r.tick();
    const E = r.ticks;
    expect(r.ws.state).toBe(WEAPON_STATE.grenade);
    r.held.delete("Fire");
    const states: Array<[number, number]> = [];
    const draws: number[] = [];
    let thrown = -1;
    let last = r.ws.state;
    for (let i = 0; i < 70; i++) {
      const d = r.ctx.rng.draws;
      r.tick();
      draws.push(r.ctx.rng.draws - d);
      if (r.ws.state !== last) states.push([r.ticks - E, (last = r.ws.state)]);
      if (thrown < 0 && grenades.grenades.length) thrown = r.ticks - E;
    }
    expect(r.attached.map((a) => [a.name, a.tick - E, a.killed - E])).toEqual([["grenade_tick_1", 22, 35]]);
    expect(states).toEqual([
      [29, WEAPON_STATE.grenadeThrow],
      [47, WEAPON_STATE.grenadeRaise],
      [58, WEAPON_STATE.ready],
    ]);
    expect(thrown).toBe(35);
    // Only the throw tick draws: the view-kick loop (two draws per try, FUN_00477ea0).
    draws.forEach((n, i) => (i + 1 === 35 ? expect(n % 2 === 0 && n >= 2).toBe(true) : expect(n).toBe(0)));
    const g = grenades.grenades[0];
    expect(g.weaponId).toBe("WEAPON_ID_GRENADE");
    expect(g.tags).toEqual({ damage: 1, radiusM: 7, falloffM: 3 });
    // setWeaponExtras also hands the tags to the soldiers' grenades.
    expect(grenades.tagsOf("WEAPON_ID_FLASHBANG")).toEqual({ damage: 1, radiusM: 10, falloffM: 15 });
    expect(g.fuse).toBe(120 - (70 - 35 + 1)); // the full 4 s: nothing is cooked off (Human method 0x4feb90)
    // Thrown along the view (yaw 0, pitch 0: IGI +y) at the h = 14 speed, then gravity / drag act.
    expect(g.type.points).toHaveLength(5);
    const w = r.ctx.weapon!;
    expect(w.ammo).toBe(1);
    expect(w.reserve).toBe(1);
    expect(playerThrowSpeed(14, 15)).toBeCloseTo(1492, 0);
  });

  it("spawns at the eye with the h-dependent velocity, cooked 0", () => {
    const r = rig(level, weaponConfig);
    r.ws.addWeapon("WEAPON_ID_GRENADE", 1);
    r.run(30);
    bringUp(r, 7, "WEAPON_ID_GRENADE");
    const grenades = grenadeSystemOf(r.ctx);
    const spawned: Grenade[] = [];
    const spawn = grenades.spawn.bind(grenades);
    grenades.spawn = (s) => {
      const g = spawn(s);
      if (g) spawned.push(structuredClone({ v: g.body.velocity, p: g.position, fuse: g.fuse }) as unknown as Grenade);
      return g;
    };
    // Hold Fire for 40 ticks after the pin: h = 7 (pin -> FireAnim1 end) + 41 hold + 6.
    r.held.add("Fire");
    r.run(70);
    r.held.delete("Fire");
    r.run(20);
    expect(spawned).toHaveLength(1);
    const s = spawned[0] as unknown as { v: number[]; p: number[]; fuse: number };
    const speed = Math.hypot(s.v[0], s.v[1], s.v[2]);
    // FireAnim1 ends on tick 29 but Fire is held: the cook count runs from tick 22 to the release + 6.
    expect(speed).toBeCloseTo(playerThrowSpeed(70 + 1 - 22 + 6, 15), 0);
    expect(s.v[1]).toBeGreaterThan(0.99 * speed); // forward = IGI +y at yaw 0
    expect(s.fuse).toBe(120);
  });

  it("switches to the next weapon of the cycle after the last grenade", () => {
    const r = rig(level, weaponConfig);
    r.ws.addWeapon("WEAPON_ID_GRENADE", 1);
    r.run(30);
    bringUp(r, 7, "WEAPON_ID_GRENADE");
    r.held.add("Fire");
    r.tick();
    const E = r.ticks;
    r.held.delete("Fire");
    let requestedAt = -1;
    let swappedAt = -1;
    for (let i = 0; i < 80; i++) {
      r.tick();
      if (requestedAt < 0 && r.ws.requested !== null) requestedAt = r.ticks - E;
      if (swappedAt < 0 && r.ctx.weapon?.spec.scriptId === "WEAPON_ID_KNIFE") swappedAt = r.ticks - E;
    }
    // FireAnim2 ends (tick 47): FUN_0040f890 requests the knife (cycle wraps past FLASHBANG ... MEDIPACK);
    // S4's lower tick swaps once the empty arms are back up (11 sway steps).
    expect(requestedAt).toBe(47);
    expect(swappedAt).toBe(58);
    expect(r.ws.state).toBe(WEAPON_STATE.ready);
  });

  it("S10: heals 0.01 x max per AMMO_ID_MEDIPACK round every 9 ticks while Fire is held", () => {
    const r = rig(level, weaponConfig);
    r.ws.addWeapon("WEAPON_ID_MEDIPACK", 3);
    r.ws.addAmmo("AMMO_ID_MEDIPACK", 50);
    r.run(30);
    bringUp(r, 9, "WEAPON_ID_MEDIPACK");
    // Full health: Fire does nothing (falls through S1), no ammo used.
    r.held.add("Fire");
    r.run(5);
    expect(r.ws.state).toBe(WEAPON_STATE.ready);
    r.held.delete("Fire");
    r.tick();
    const p = r.ctx.player;
    p.health = 3 - 0.0625;
    r.held.add("Fire");
    r.tick();
    const E = r.ticks;
    expect(r.ws.state).toBe(WEAPON_STATE.medipack);
    const heals: Array<[number, number]> = [];
    const states: Array<[number, number]> = [];
    let last = r.ws.state;
    let health = p.health;
    let triggers: number[] = [];
    for (let i = 0; i < 120; i++) {
      r.tick();
      if (p.health !== health) heals.push([r.ticks - E, (health = p.health)]);
      if (r.ws.state !== last) states.push([r.ticks - E, (last = r.ws.state)]);
      if (r.ctx.firstPerson!.arms.triggers.includes(1050)) triggers.push(r.ticks - E);
    }
    expect(triggers).toEqual([34]); // FireAnim1 (78) plays "syringe" (trigger 1050 at 5600)
    const step = 3 * Math.fround(0.01);
    expect(heals.map(([t]) => t)).toEqual([38, 47, 56]);
    expect(heals[0][1]).toBeCloseTo(3 - 0.0625 + step, 6);
    expect(heals[2][1]).toBe(3); // clamped at 0 damage
    expect(r.ws.reserveOf("AMMO_ID_MEDIPACK")).toBe(47);
    // Full health on the next round tick (65): FireAnim3 (80, 27 ticks) and S1 when it ends.
    expect(states).toEqual([
      [37, WEAPON_STATE.medipackHeal],
      [65, WEAPON_STATE.medipackEnd],
      [65 + 27, WEAPON_STATE.ready],
    ]);
    expect(r.ctx.weapon!.reserve).toBe(47); // the medipack's pool is AMMO_ID_MEDIPACK (calibre 10005)
  });

  it("draws a flying grenade as its Gun Model, vertex-lit with its current rotation (render/grenades.ts)", () => {
    const scene = new THREE.Scene();
    const renderer = createGrenadeRenderer({ level }, scene);
    const g = createGrenade(
      { weaponId: "WEAPON_ID_GRENADE", model: "135_01_1", position: [...level.originIgi] as [number, number, number], matrix: IDENTITY, velocity: [0, 0, 0], cooked: 0, tags: null, thrower: "player" },
      testType(),
      0,
    );
    renderer.update([g]);
    expect(renderer.count).toBe(1);
    const mesh = renderer.group.children[0] as THREE.Mesh;
    expect(mesh.name).toBe(`grenade:${g.id}:135_01_1`);
    expect([...mesh.matrix.elements]).toEqual(pickupMatrix({ position: g.position, rotation: g.matrix }, level.originIgi));
    const light = mesh.geometry.getAttribute("objLight") as THREE.BufferAttribute;
    const before = Array.from(light.array as Float32Array);
    g.matrix = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // upside down: the lit side changes
    renderer.update([g]);
    expect(Array.from(light.array as Float32Array)).not.toEqual(before);
    renderer.update([]);
    expect(renderer.count).toBe(0);
    renderer.dispose();
    expect(scene.children).not.toContain(renderer.group);
  });

  describe("on the level-1 ground", () => {
    let world: BuiltWorld;
    let data: DamageModelData;
    beforeAll(async () => {
      const names = damageModelNames(level);
      data = await loadDamageModelData(createFsAssetSource(RAW_ROOT), names.bounds, names.build, (key) => level.textures.has(key));
      world = buildWorld(level, (b) => b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices, TRI_BULLET | TRI_SIGHT | TRI_SOLID, 1));
    }, 240_000);

    it("bounces, comes to rest on the ground and explodes after 4 s with the weaponconfig tags", () => {
      const sounds: string[] = [];
      const ctx = {
        events: new EventBus(),
        rng: new LevelRng(),
        level,
        world: world.collision,
        tick: 0,
        scene: new THREE.Scene(),
        player: { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false, health: 3, maxHealth: 3, alive: true, walking: false, eyeHeight: 1.6, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0 },
        systems: { weapon: null, enemies: null, objectives: null, audio: { playAt: (n: string) => sounds.push(n) }, hud: null, effects: null, tasks: null, player: null },
      } as unknown as GameContext;
      const damage = createDamageSystem(ctx, { fx: false });
      damage.attach(level, world, data);
      attachDamageSystem(ctx, damage);
      const booms: ExplosionEventPayload[] = [];
      ctx.events.on(DAMAGE_EVENTS.Explosion, (p) => booms.push(p as ExplosionEventPayload));
      const grenades = grenadeSystemOf(ctx);
      // From the player's start, 1.6 m above the ground, thrown at 10 m/s along +y and slightly up.
      const e = level.player.position;
      const ground = world.collision.raycast(e[0], e[1] + 5, e[2], 0, -1, 0, 50, TRI_BULLET)!;
      const o = level.originIgi;
      const start: [number, number, number] = [e[0] * 4096 + o[0], -e[2] * 4096 + o[1], (ground.point[1] + 1.6) * 4096 + o[2]];
      const g = grenades.spawn({ weaponId: "WEAPON_ID_GRENADE", model: "135_01_1", position: start, matrix: IDENTITY, velocity: [0, 1365, 400], cooked: 0, tags: { damage: 1, radiusM: 7, falloffM: 3 }, thrower: "player" })!;
      expect(g.type.points.map((p) => p.local[2])).toEqual(data.bounds.get("135_01_1")!.magic.slice(0, 5).map((v) => v[2]));
      const probe = collisionGrenadeWorld(ctx);
      let contactTick = -1;
      let explodedAt = -1;
      for (let t = 0; t < 130 && explodedAt < 0; t++) {
        damage.beginTick();
        grenades.update();
        damage.endTick();
        (ctx as { tick: number }).tick++;
        if (booms.length) explodedAt = t + 1;
        if (contactTick < 0 && g.contacts > 0) contactTick = t + 1;
        // No contact point ever ends inside the ground.
        for (const p of g.type.points) {
          const m = g.matrix;
          const q: [number, number, number] = [
            g.position[0] + m[0] * p.local[0] + m[1] * p.local[1] + m[2] * p.local[2],
            g.position[1] + m[3] * p.local[0] + m[4] * p.local[1] + m[5] * p.local[2],
            g.position[2] + m[6] * p.local[0] + m[7] * p.local[1] + m[8] * p.local[2],
          ];
          expect(probe.inside(q, G.insideRay)).toBe(false);
        }
      }
      expect(contactTick).toBeGreaterThan(5);
      expect(explodedAt).toBe(121);
      expect(sounds[0]).toBe("grenade_bnc_1");
      expect(booms).toHaveLength(1);
      expect(booms[0]).toMatchObject({ radiusM: 7, falloffM: 3, damage: 1, sound: "explo_02_m", fireballs: 1, fragments: 3 });
      // It came to rest on the ground a few metres away along +y (engine -z).
      expect(booms[0].position[2]).toBeLessThan(e[2] - 2);
      const below = world.collision.raycast(booms[0].position[0], booms[0].position[1] + 1, booms[0].position[2], 0, -1, 0, 5, TRI_BULLET)!;
      expect(booms[0].position[1] - below.point[1]).toBeLessThan(0.15);
      expect(grenades.grenades).toHaveLength(0);
    }, 60_000);
  });
});
