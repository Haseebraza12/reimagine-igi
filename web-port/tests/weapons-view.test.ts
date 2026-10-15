/**
 * The player's weapons, items and first-person view as recovered from
 * igi.exe (docs/weapons-view.md): weapon state machine timings, knife,
 * binoculars, MP5SD zoom, arms clips, sway, shake and landing dip.
 * Real data from web-port/game-data (skipped when absent).
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { loadIgiLevel, type IgiLevel } from "../src/loaders/level";
import { readAnimations, x87StoreF32 } from "../src/loaders";
import { EventBus, GameEvent } from "../src/engine/events";
import { LevelRng } from "../src/engine/ai/rng";
import type { GameContext } from "../src/engine/context";
import { createWeaponSystem, WEAPON_STATE, type WeaponSystem } from "../src/engine/combat/weapon";
import { readWeaponExtras, zoomTangent } from "../src/engine/combat/weapon-tags";
import { KNIFE_RAY_ANGLES, knifeRayDirections } from "../src/engine/combat/melee";
import { ArmsAnimator, ArmsSway, FIRST_PERSON_CONSTANTS as FPC, ViewEffects, lookDelta } from "../src/engine/player/first-person";
import { createCameraController } from "../src/engine/player/camera";
import { RAW_ROOT, readRaw } from "./helpers";

const haveRaw =
  existsSync(`${RAW_ROOT}/missions/location0/level1/objects.qvm`) &&
  existsSync(`${RAW_ROOT}/weapons/weaponconfig.qvm`) &&
  existsSync(`${RAW_ROOT}/common/anims/005.iff`);

describe("first-person view object (no data)", () => {
  it("steps the weapon-switch sway in 11 ticks each way", () => {
    const s = new ArmsSway();
    s.setTarget(FPC.swayLowered.alpha, FPC.swayLowered.gamma, FPC.swayRate.alpha, FPC.swayRate.gamma);
    let n = 0;
    while (!s.reached()) {
      s.step();
      n++;
    }
    expect(n).toBe(11);
    expect(s.alpha).toBeCloseTo((-35 * Math.PI) / 180, 6);
    expect(s.gamma).toBeCloseTo((-20 * Math.PI) / 180, 6);
    s.setTarget(0, 0, FPC.swayRate.alpha, FPC.swayRate.gamma);
    n = 0;
    while (!s.reached()) {
      s.step();
      n++;
    }
    expect(n).toBe(11);
  });

  it("plays the landing dip over 15 ticks: d sin(k x 12 deg) on the eye, 0.075 of it on the arms", () => {
    const e = new ViewEffects();
    e.landingDip(7.5); // a jump landing: min(1, 7.5 / 8) x -1024 = -960 units
    expect(e.dipAmount).toBeCloseTo(-960, 3);
    const ups: number[] = [];
    for (let i = 0; i < 20; i++) ups.push(e.step(() => 0.5).up);
    const live = ups.filter((u) => u !== 0);
    expect(ups[0]).toBe(0); // sin(0)
    expect(live).toHaveLength(14); // k = 1..14 non-zero, k = 0 is zero, 15 ticks in all
    expect(e.dipAmount).toBe(0);
    expect(Math.min(...ups)).toBeCloseTo(-960 * Math.sin((84 * Math.PI) / 180), 0);
    // Hard landings saturate at -1024 units (0.25 m).
    e.landingDip(20);
    expect(e.dipAmount).toBe(-1024);
  });

  it("shakes for 15 ticks after a bullet hit with five RNG draws per tick", () => {
    const e = new ViewEffects();
    let draws = 0;
    e.hitShake(() => 0.1); // below 0.25: clamped
    expect(e.shakePos).toBeCloseTo(0.25 * 204.8, 4);
    expect(e.shakeAngle).toBeCloseTo(0.25 * 0.013089969754219055, 8);
    let ticks = 0;
    while (e.shakeAmp !== 0 && ticks < 40) {
      e.step(() => {
        draws++;
        return 0.75;
      });
      ticks++;
    }
    expect(ticks).toBeGreaterThanOrEqual(15);
    expect(ticks).toBeLessThanOrEqual(16);
    expect(draws).toBe(5 * ticks);
  });

  it("fades stance clips over 12 ticks and replaces fire clips at once", () => {
    const clips = new Map([
      [1, { duration: 9440, events: [] }],
      [2, { duration: 3360, events: [{ time: 160, trigger: 1006 }] }],
    ]);
    const a = new ArmsAnimator((id) => clips.get(id) ?? null);
    a.play(1, true, 0);
    a.play(2, false, FPC.blendSeconds);
    expect(a.previous?.clip).toBe(1);
    const weights: number[] = [];
    for (let i = 0; i < 13; i++) {
      a.step();
      weights.push(a.previousWeight);
    }
    expect(weights[0]).toBeCloseTo(11 / 12, 6);
    expect(weights[10]).toBeCloseTo(1 / 12, 6);
    expect(weights[11]).toBe(0);
    expect(a.previous).toBeNull();
    // 3360 / 160 = 21 steps to the end flag; a one-shot then keeps flagging.
    const b = new ArmsAnimator((id) => clips.get(id) ?? null);
    b.play(2, false, 0);
    const ends: number[] = [];
    const triggers: number[] = [];
    for (let i = 1; i <= 23; i++) {
      b.step();
      if (b.ended) ends.push(i);
      triggers.push(...b.triggers);
    }
    expect(ends).toEqual([21, 22, 23]);
    expect(triggers).toEqual([1006]);
  });

  it("aims the knife's three rays 15 deg right, 5 deg right, 5 deg left", () => {
    expect(KNIFE_RAY_ANGLES.map((a) => (a * 180) / Math.PI)).toEqual([expect.closeTo(-15, 4), expect.closeTo(-5, 4), expect.closeTo(5, 4)]);
    const [r15, r5, l5] = knifeRayDirections([0, 0, -1], [1, 0, 0]);
    expect(r15[0]).toBeCloseTo(Math.sin((15 * Math.PI) / 180), 5);
    expect(r5[0]).toBeCloseTo(Math.sin((5 * Math.PI) / 180), 5);
    expect(l5[0]).toBeCloseTo(-Math.sin((5 * Math.PI) / 180), 5);
  });

  it("scales the mouse look with the FOV tangent; only pitch is averaged, and only unzoomed", () => {
    expect(lookDelta(0.1, 0.1, 1, "pitch")).toBeCloseTo(0.1 * Math.PI, 5);
    // averaged a = 0.05 is below 0.06: damped by 2 - 16.667 x 0.05
    expect(lookDelta(0.1, 0, 1, "pitch")).toBeCloseTo((0.05 * Math.PI) / (2 - 0.05 * 16.666666666666668), 5);
    expect(lookDelta(0.1, 0, 1, "yaw")).toBeCloseTo(0.1 * Math.PI, 5);
    expect(lookDelta(0.1, 0, 0.5, "pitch")).toBeCloseTo(0.1 * Math.PI * 0.5, 5);
    // Small inputs are damped: /(2 - 16.667 |a|).
    expect(lookDelta(0.03, 0.03, 1, "pitch")).toBeCloseTo((0.03 * Math.PI) / 1.5, 5);
  });
});

interface Rig {
  ctx: GameContext;
  ws: WeaponSystem;
  held: Set<string>;
  pressed: Set<string>;
  events: string[];
  tick(): void;
  run(n: number): void;
  /** Update count when the event was last seen. */
  ticks: number;
}

function rig(level: IgiLevel, extras = true, raw?: ArrayBuffer): Rig {
  const held = new Set<string>();
  const pressed = new Set<string>();
  const input = {
    get isFiring() {
      return held.has("Fire");
    },
    action: (a: string) => held.has(a),
    actionPressed: (a: string) => pressed.has(a),
    forward: 0,
    strafe: 0,
  };
  const bus = new EventBus();
  const ctx = {
    level,
    world: null,
    events: bus,
    input,
    rng: new LevelRng(),
    player: {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      grounded: true,
      crouching: false,
      running: false,
      health: 3,
      maxHealth: 3,
      alive: true,
      walking: false,
      eyeHeight: 1.64,
      kickPitch: 0,
      kickYaw: 0,
      leanSide: 0,
      leanUp: 0,
    },
    weapon: null,
    systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: null },
    running: true,
    camera: new THREE.PerspectiveCamera(),
  } as unknown as GameContext;
  const ws = createWeaponSystem(ctx);
  if (extras && raw) ws.setWeaponExtras(readWeaponExtras(raw));
  ws.reset();
  const log: string[] = [];
  const r: Rig = {
    ctx,
    ws,
    held,
    pressed,
    events: log,
    ticks: 0,
    tick() {
      r.ticks++;
      ws.update(1 / 30);
      pressed.clear();
    },
    run(n) {
      for (let i = 0; i < n; i++) r.tick();
    },
  };
  for (const name of ["Fire", "ReloadStart", "ReloadEnd", "WeaponChanged", "DryFire"] as const) {
    bus.on(GameEvent[name], (p) => log.push(`${r.ticks}:${name}:${(p as { weaponId?: string } | undefined)?.weaponId ?? ""}`));
  }
  return r;
}

describe.skipIf(!haveRaw)("player weapons (level 1 data)", () => {
  let level: IgiLevel;
  let raw: ArrayBuffer;
  beforeAll(async () => {
    level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
    raw = await readRaw("weapons/weaponconfig.qvm");
  }, 60000);

  it("reads the zoom tags and handler types from weaponconfig.qvm", () => {
    const x = readWeaponExtras(raw);
    expect(x.get("WEAPON_ID_MP5SD")).toMatchObject({ taskType: "TASKTYPE_GUNMP5SD", projectileType: "TASKTYPE_GUNSHOT", zoomMinFovDeg: 60 });
    expect(x.get("WEAPON_ID_MP5SD")!.zoomMinTan).toBe(zoomTangent(60));
    expect(x.get("WEAPON_ID_MP5SD")!.zoomMinTan).toBeCloseTo(Math.tan(Math.PI / 6), 6);
    expect(x.get("WEAPON_ID_DRAGUNOV")).toMatchObject({ taskType: "TASKTYPE_GUNDRAGUNOV", zoomMinFovDeg: 5 });
    expect(x.get("WEAPON_ID_KNIFE")).toMatchObject({ taskType: "TASKTYPE_GUN", projectileType: "TASKTYPE_KNIFESTAB" });
    expect(x.get("WEAPON_ID_GLOCK")).toMatchObject({ taskType: "TASKTYPE_GUN", zoomMinFovDeg: null });
    const b = x.get("WEAPON_ID_BINOCULARS")!;
    expect(b.taskType).toBe("TASKTYPE_BINOCULAR");
    expect(b.projectileType).toBeNull();
    expect(b.binocular).toMatchObject({ defaultDeg: 70, maxDeg: 90, minDeg: 5 });
    expect(b.binocular!.tanDefault).toBeCloseTo(Math.tan((35 * Math.PI) / 180), 6);
  });

  it("starts with an empty hand and raises the knife: swap on tick 13, usable from tick 25", () => {
    const r = rig(level, true, raw);
    r.tick();
    expect(r.ws.requested).toBe("WEAPON_ID_KNIFE");
    expect(r.ctx.weapon).toBeNull();
    r.run(11);
    expect(r.ctx.weapon).toBeNull();
    r.tick(); // 13
    expect(r.ctx.weapon?.spec.scriptId).toBe("WEAPON_ID_KNIFE");
    expect(r.events).toContain("13:WeaponChanged:WEAPON_ID_KNIFE");
    r.run(10); // 23
    expect(r.ws.state).toBe(WEAPON_STATE.switchRaise);
    r.tick(); // 24
    expect(r.ws.state).toBe(WEAPON_STATE.ready);
    expect(r.ctx.firstPerson!.sway.alpha).toBe(0);
  });

  it("stabs once per hold: every 24 ticks while Fire is held (clip 28 is 21 ticks)", () => {
    const r = rig(level, true, raw);
    r.run(24);
    r.held.add("Fire");
    r.run(80);
    const stabs = r.events.filter((e) => e.endsWith(":Fire:WEAPON_ID_KNIFE")).map((e) => Number(e.split(":")[0]));
    expect(stabs).toEqual([26, 50, 74, 98]);
  });

  it("chains FireAnim1-3 when the knife is clicked again after the 11-tick cooldown", () => {
    const r = rig(level, true, raw);
    r.run(24);
    const clips: number[] = [];
    for (let t = 0; t < 40; t++) {
      // two-tick clicks from ticks 25, 37, 49 (a one-tick click from S1 only enters S9)
      if (t === 0 || t === 1 || t === 12 || t === 13 || t === 24 || t === 25) r.held.add("Fire");
      else r.held.delete("Fire");
      const before = r.ctx.firstPerson!.arms.plays;
      r.tick();
      const cur = r.ctx.firstPerson!.arms.current;
      if (r.ctx.firstPerson!.arms.plays !== before && cur && cur.clip >= 28 && cur.clip <= 30) clips.push(cur.clip);
    }
    expect(clips).toEqual([28, 29, 30]);
  });

  it("switches to the MP5SD with key 3 in 22 ticks and fires every 2 ticks from the tick after the press", () => {
    const r = rig(level, true, raw);
    r.run(24);
    r.ws.selectCategory(3);
    r.tick(); // 25: request + lower
    expect(r.ws.state).toBe(WEAPON_STATE.switchLower);
    r.run(10); // 35
    expect(r.ctx.weapon?.spec.scriptId).toBe("WEAPON_ID_KNIFE");
    r.tick(); // 36: swap
    expect(r.ctx.weapon?.spec.scriptId).toBe("WEAPON_ID_MP5SD");
    r.run(11); // 47: active
    expect(r.ws.state).toBe(WEAPON_STATE.ready);
    r.held.add("Fire");
    r.run(8); // 48..55
    const shots = r.events.filter((e) => e.endsWith(":Fire:WEAPON_ID_MP5SD")).map((e) => Number(e.split(":")[0]));
    expect(shots).toEqual([49, 51, 53, 55]);
    expect(r.ctx.weapon?.ammo).toBe(28);
  });

  it("zooms the MP5SD with AlternateFire: x0.8 per tick to 0.512 (54 deg), x1.25 back to 90 deg", () => {
    const r = rig(level, true, raw);
    r.run(24);
    r.ws.selectCategory(3);
    r.run(24); // 48: MP5SD ready
    const fp = r.ctx.firstPerson!;
    r.held.add("AlternateFire");
    const tans: number[] = [];
    for (let i = 0; i < 6; i++) {
      r.tick();
      r.held.delete("AlternateFire");
      tans.push(fp.tanX);
    }
    expect(tans[0]).toBe(1);
    expect(tans[1]).toBe(x87StoreF32(0.800000011920929));
    expect(tans[3]).toBeCloseTo(0.512, 6);
    expect(tans[4]).toBe(tans[3]);
    expect(fp.gunTanX).toBeCloseTo(FPC.tanGun * 0.512, 6);
    expect(fp.scoped).toBe(false); // the MP5SD keeps the arms
    r.held.add("AlternateFire");
    r.tick();
    r.held.delete("AlternateFire");
    r.run(3);
    // Chopped products: 0.512 x 1.25^3 = 0.99999982, so a fourth tick overshoots and clamps to 1.
    expect(fp.tanX).toBeLessThan(1);
    expect(fp.tanX).toBeCloseTo(1, 6);
    r.tick();
    expect(fp.tanX).toBe(1);
    expect(fp.gunTanX).toBe(FPC.tanGun);
  });

  it("raises the binoculars at once at 70 deg; ZoomIn x0.96 per tick down to 5 deg; arms hidden; no firing", () => {
    const r = rig(level, true, raw);
    r.run(24);
    const fp = r.ctx.firstPerson!;
    r.pressed.add("Binoculars");
    r.tick();
    expect(r.ctx.weapon?.spec.scriptId).toBe("WEAPON_ID_BINOCULARS");
    expect(r.ws.binocularMode).toBe(true);
    expect(fp.scoped).toBe(true);
    expect(fp.tanX).toBe(zoomTangent(70));
    r.held.add("ZoomIn");
    let n = 0;
    while (fp.tanX > zoomTangent(5) && n < 200) {
      r.tick();
      n++;
    }
    expect(n).toBe(68);
    r.tick();
    const min = fp.tanX;
    expect(min).toBeLessThanOrEqual(zoomTangent(5));
    r.held.delete("ZoomIn");
    r.held.add("Fire");
    r.run(5);
    expect(r.events.some((e) => e.includes(":Fire:"))).toBe(false);
    r.held.delete("Fire");
    // Binoculars again: back to the knife through the normal switch.
    r.pressed.add("Binoculars");
    r.tick();
    expect(r.ws.requested).toBe("WEAPON_ID_KNIFE");
    r.tick();
    expect(r.ws.state).toBe(WEAPON_STATE.switchLower);
    expect(fp.scoped).toBe(false);
    expect(fp.tanX).toBe(1);
  });

  it("reloads the MP5SD for the length of ReloadAnim 21 (100 ticks) and moves the rounds at its end", () => {
    const r = rig(level, true, raw);
    r.run(24);
    r.ws.selectCategory(3);
    r.run(24);
    r.held.add("Fire");
    r.run(2); // one shot (tick 50 fires? first shot on the second tick)
    r.held.delete("Fire");
    r.held.add("Reload");
    r.run(1);
    r.held.delete("Reload");
    r.run(110);
    const start = r.events.find((e) => e.includes(":ReloadStart:"));
    const end = r.events.find((e) => e.includes(":ReloadEnd:"));
    expect(start && end).toBeTruthy();
    expect(Number(end!.split(":")[0]) - Number(start!.split(":")[0])).toBe(100);
    expect(r.ctx.weapon?.ammo).toBe(32);
    expect(r.ctx.weapon?.reserve).toBe(48);
    const anim = readAnimations(level.animations.get(5)!);
    expect(anim.clips.get(21)!.duration / 160).toBe(100);
  });

  it("dry-fires once on an empty Glock and reloads after the release", () => {
    const r = rig(level, true, raw);
    r.run(24);
    r.ws.selectCategory(2);
    r.run(24); // Glock ready
    expect(r.ctx.weapon?.spec.scriptId).toBe("WEAPON_ID_GLOCK");
    // Empty the clip: 17 single shots (3-tick presses).
    for (let i = 0; i < 17 * 30 && (r.ctx.weapon?.ammo ?? 0) > 0; i++) {
      if (i % 30 < 3) r.held.add("Fire");
      else r.held.delete("Fire");
      r.tick();
    }
    expect(r.ctx.weapon?.ammo).toBe(0);
    // Holding Fire on the empty clip: one "guns_dry_1" once the fire clip has ended (S2 -> S12).
    r.held.add("Fire");
    r.run(40);
    expect(r.events.filter((e) => e.includes(":DryFire:"))).toHaveLength(1);
    expect(r.ws.state).toBe(WEAPON_STATE.dryFire);
    expect(r.events.some((e) => e.includes(":ReloadStart:"))).toBe(false);
    // Released: S1 reloads the empty clip by itself (pool 49).
    r.held.delete("Fire");
    r.run(3);
    expect(r.events.filter((e) => e.includes(":ReloadStart:WEAPON_ID_GLOCK"))).toHaveLength(1);
  });

  it("stabs the first soldier a knife ray reaches: 1000 x zone when it has no combat target, else 0.1 x zone", () => {
    for (const aware of [false, true]) {
      const r = rig(level, true, raw);
      const enemy = { id: 7, alive: true } as unknown as import("../src/engine/context").Enemy;
      const calls: Array<{ dir: number[]; options: unknown }> = [];
      const damage: number[] = [];
      r.ctx.systems.enemies = {
        hitTest(_from: number[], dir: number[], max: number, options?: unknown) {
          calls.push({ dir, options });
          // Only the middle ray (5 deg right) meets the soldier 1.2 m ahead.
          const yawDeg = (Math.atan2(dir[0], -dir[2]) * 180) / Math.PI;
          return Math.abs(yawDeg - 5) < 1 && max >= 1.2 ? [{ enemy, distance: 1.2, point: [0, 1.6, -1.2], head: false, zoneMultiplier: 1, material: 8 }] : [];
        },
        damage(_e: unknown, amount: number) {
          damage.push(amount);
        },
        aiOf: () => ({ target: aware ? {} : null }),
      } as unknown as GameContext["systems"]["enemies"];
      r.run(24);
      r.held.add("Fire");
      r.run(2); // tick 26: the stab
      expect(calls.map((c) => Math.round((Math.atan2(c.dir[0], -c.dir[2]) * 180) / Math.PI))).toEqual([15, 5]);
      expect(calls.every((c) => (c.options as { nearMiss?: boolean }).nearMiss === false)).toBe(true);
      expect(damage).toEqual([aware ? 0.10000000149011612 : 1000]);
    }
  });

  it("drives the camera FOV from the zoom tangent", () => {
    const r = rig(level, true, raw);
    r.run(24);
    const cam = createCameraController(r.ctx);
    expect(cam.fovYDeg()).toBeCloseTo(73.74, 2);
    r.pressed.add("Binoculars");
    r.tick();
    expect(cam.lookScale()).toBeCloseTo(Math.tan((35 * Math.PI) / 180), 6);
    expect(cam.fovYDeg()).toBeCloseTo((2 * Math.atan(0.75 * Math.tan((35 * Math.PI) / 180)) * 180) / Math.PI, 4);
    cam.update(0);
    expect(r.ctx.camera.fov).toBeCloseTo(cam.fovYDeg(), 6);
  });
});
