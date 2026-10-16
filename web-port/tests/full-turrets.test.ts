/**
 * Vehicle-mounted weapons and the Missile on the full game's missions
 * (game-data): the APC / T80 / Mil turrets and the Mil rocket pods built from
 * the vehicles' ATTA magic objects, the car and heli "Can fire" perceptions
 * feeding them, their fire at the player (bullets and Missiles), the cheats,
 * and the Missile's recovered flight and explosion. Skipped without game-data.
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { readQvmCallTree } from "../src/loaders/qvm";
import { readMagicObjects, readPhysicsObjTypes, type MissileConfig } from "../src/loaders/vehicles";
import { PHYSICSOBJ_SCRIPTS } from "../src/loaders/level-vehicles";
import { flattenTasks, readTaskTree } from "../src/loaders/tasks";
import type { IgiLevel } from "../src/loaders";
import { GameEvent } from "../src/engine/events";
import { damageSystemOf } from "../src/engine/combat/object-damage";
import { projectileSystemOf } from "../src/engine/combat/projectiles";
import { MISSILE_RULES, createMissile, updateMissile } from "../src/engine/combat/missile";
import { LevelRng } from "../src/engine/ai/rng";
import { FULL, bytes, loadMission, turretRig, type TurretRig } from "./turrets-rig";

const haveFull = existsSync(`${FULL}/missions/location0/level14/objects.qvm`);
const UNITS = 4096;

describe.skipIf(!haveFull)("vehicle weapons in the data (magicobj.qvm, physicsobj, weaponconfig)", () => {
  it("the only mounted weapons: AIStationaryGun 601_02_1 / 614_02_1 / 614_10_1 / 700_11_1 (and the L14 holder turret 456_12_1), RocketPod 700_09_1 (15)", () => {
    const magic = readMagicObjects(bytes(`${FULL}/magicobj/magicobj.qvm`));
    const guns = [...magic].filter(([, d]) => d.taskType === "TASKTYPE_AISTATIONARYGUN").map(([k]) => k).sort();
    expect(guns).toEqual(["456_12_1", "601_02_1", "614_02_1", "614_10_1", "700_11_1"]);
    const pods = [...magic].filter(([, d]) => d.taskType === "TASKTYPE_ROCKETPOD");
    expect(pods.map(([k, d]) => [k, d.params[0]])).toEqual([["700_09_1", 15]]);
  });

  it("missile types: RPG18 110_02_1 and cgm2 136_02_1 direct (fuel 4 / 15 s, thrust 200), HIND 700_10_1 guided (fuel 30 s, thrust 25, turn 35)", () => {
    const types = PHYSICSOBJ_SCRIPTS.filter((p) => p.includes("missiles")).flatMap((p) => readPhysicsObjTypes(bytes(`${FULL}/${p}`), p));
    const by = new Map(types.map((t) => [t.model, t.config as MissileConfig]));
    expect([...by.keys()].sort()).toEqual(["110_02_1", "136_02_1", "700_10_1"]);
    expect(by.get("110_02_1")).toMatchObject({ guidance: 0, fuel: 4, smoke: 1, sprite: "smoke2.spr", sound: "radarwind_1" });
    expect(by.get("110_02_1")!.c[7]).toBe(200);
    expect(by.get("136_02_1")).toMatchObject({ guidance: 0, fuel: 15 });
    expect(by.get("700_10_1")).toMatchObject({ guidance: 1, fuel: 30 });
    expect([by.get("700_10_1")!.c[7], by.get("700_10_1")!.c[1], by.get("700_10_1")!.c[5]]).toEqual([25, 35, 35]);
  });

  it("armed vehicles of missions 2-14 (objects.qvm): APC 601_01_1 in 6/7/8/14, T80 614_01_1 in 7/8/10, Mil 700_01_1 in 6/7/10/12", () => {
    const armed: Record<string, number[]> = { "601_01_1": [], "614_01_1": [], "700_01_1": [] };
    for (let l = 2; l <= 14; l++) {
      const tasks = flattenTasks(readTaskTree(readQvmCallTree(bytes(`${FULL}/missions/location0/level${l}/objects.qvm`))));
      for (const t of tasks) {
        const m = String(t.params["Model"] ?? "");
        if ((t.type === "Car" || t.type === "Heli") && m in armed && !armed[m].includes(l)) armed[m].push(l);
      }
    }
    expect(armed).toEqual({ "601_01_1": [6, 7, 8, 14], "614_01_1": [7, 8, 10], "700_01_1": [6, 7, 10, 12] });
  });
});

describe.skipIf(!haveFull)("mission 7 loads: every armed vehicle gets its turrets and pods", () => {
  let level: IgiLevel;
  let rig: TurretRig;
  beforeAll(async () => {
    level = await loadMission(7);
    rig = await turretRig(7, level);
  }, 600_000);

  it("APC 355 / 352: 601_02_1 with WEAPON_ID_APC (Missile 110_02_1); T80 354 / 357 / 361: 614_02_1 (T80, Missile) carrying 614_10_1 (M2HB bullets); Mil 356 / 353: 700_11_1 (MIL bullets) + 4 pods of 450 ticks", () => {
    const vw = rig.combat.vehicleWeapons;
    const veh = rig.mission.vehicles!;
    const idOf = (key: number) => veh.cars.find((c) => c.key === key)?.id ?? veh.helis.find((h) => h.key === key)?.id;
    const rows = vw.turrets.map((t) => `${idOf(t.vehicleKey)} ${t.model} ${t.gun.weapon?.scriptId} ${t.gun.missileModel ?? "-"} ${t.container ? t.container.model : "-"}`).sort();
    expect(rows).toEqual([
      "352 601_02_1 WEAPON_ID_APC 110_02_1 -",
      "353 700_11_1 WEAPON_ID_MIL - -",
      "354 614_02_1 WEAPON_ID_T80 110_02_1 -",
      "354 614_10_1 WEAPON_ID_M2HB - 614_02_1",
      "355 601_02_1 WEAPON_ID_APC 110_02_1 -",
      "356 700_11_1 WEAPON_ID_MIL - -",
      "357 614_02_1 WEAPON_ID_T80 110_02_1 -",
      "357 614_10_1 WEAPON_ID_M2HB - 614_02_1",
      "361 614_02_1 WEAPON_ID_T80 110_02_1 -",
      "361 614_10_1 WEAPON_ID_M2HB - 614_02_1",
    ]);
    expect(vw.pods.map((p) => [idOf(p.vehicleKey), p.reload])).toEqual([[356, 450], [356, 450], [356, 450], [356, 450], [353, 450], [353, 450], [353, 450], [353, 450]]);
    for (const p of vw.pods) expect(p.cooldown).toBeLessThan(450);
    // Gun muzzles: the APC gun's magic vertex 2 is 3.7 m along its barrel, the T80 cannon's 10 m.
    const apc = vw.turrets.find((t) => t.model === "601_02_1")!;
    expect(apc.gun.magic[2][1]).toBeCloseTo(15222, 0);
    expect(apc.pivot[1]).toBeCloseTo(-4844.3, 0);
    expect(vw.turrets.find((t) => t.model === "614_02_1")!.gun.magic[2][1]).toBeCloseTo(40937, 0);
    // The run-time models are in the level: the gun models and the HIND rocket.
    for (const m of ["601_05_1", "614_03_1", "123_01_1", "700_12_1", "110_02_1", "700_10_1"]) expect(level.models.has(m)).toBe(true);
  });
});

describe.skipIf(!haveFull)("mission 7 in the engine: the T80 #354 fires at the visible player", () => {
  let rig: TurretRig;
  beforeAll(async () => {
    rig = await turretRig(7);
  }, 600_000);

  const placeAhead = (r: TurretRig, carId: number, metres: number) => {
    const car = r.mission.vehicles!.cars.find((c) => c.id === carId)!;
    const m = car.sim.matrix;
    const p = car.sim.position;
    r.placePlayer([p[0] + m[1] * metres * UNITS, p[1] + m[4] * metres * UNITS, p[2]]);
    return car;
  };

  it("perception (Can fire 1) -> the turrets update twice per tick, aim, the cannon launches a Missile (source 43) and the M2HB's bullets hit the player", () => {
    const r = rig;
    const t80 = placeAhead(r, 354, 30);
    const vw = r.combat.vehicleWeapons;
    const mine = vw.turrets.filter((t) => t.vehicleKey === t80.key);
    const cannon = mine.find((t) => t.model === "614_02_1")!;
    const mg = mine.find((t) => t.model === "614_10_1")!;
    let hits = 0;
    r.ctx.events.on(GameEvent.PlayerHit, () => hits++);
    const missiles: number[] = [];
    const ps = projectileSystemOf(r.ctx);
    const u0 = cannon.updates;
    for (let i = 0; i < 40 && r.ctx.player.alive; i++) {
      r.step();
      for (const f of ps.flying) if (f.kind === "missile" && !missiles.includes(f.id)) missiles.push(f.id);
      if (i === 9) expect(cannon.updates - u0).toBe(20);
    }
    expect(t80.state.canFire).toBe(true);
    expect(t80.state.detector.list).toContain("player");
    expect(cannon.gun.rounds).toBeGreaterThanOrEqual(1);
    expect(missiles.length).toBeGreaterThanOrEqual(1);
    expect(ps.flying.find((f) => f.kind === "missile")?.sourceWeaponId ?? 43).toBe(43);
    expect(mg.gun.rounds).toBeGreaterThan(1);
    expect(hits).toBeGreaterThan(0);
    expect(r.ctx.player.health).toBeLessThan(3);
  });

  it("Unlimited Health: the vehicle fire leaves the player's health; Invisible To Enemies: the perception drops the player and the guns stop", async () => {
    const r = await turretRig(7);
    r.ctx.cheats = { unlimitedAmmo: false, unlimitedHealth: true, oneShotKills: false, invisible: false, allWeapons: false };
    const t80 = placeAhead(r, 354, 30);
    const mg = r.combat.vehicleWeapons.turrets.find((t) => t.vehicleKey === t80.key && t.model === "614_10_1")!;
    let hits = 0;
    r.ctx.events.on(GameEvent.PlayerHit, () => hits++);
    r.step(60);
    expect(hits).toBeGreaterThan(0);
    expect(r.ctx.player.health).toBe(3);
    expect(r.ctx.player.alive).toBe(true);
    r.ctx.cheats.invisible = true;
    r.step(8);
    expect(t80.state.detector.list).not.toContain("player");
    const rounds = mg.gun.rounds;
    r.step(60);
    expect(mg.gun.rounds).toBe(rounds);
  }, 600_000);
});

describe.skipIf(!haveFull)("mission 7 in the engine: the Mil #353 (AnimTask_302) gun and rocket pods", () => {
  it("the heli perception (M Rx(-pi/2), cone 270 deg / 150 m) sees the player; the nose gun fires bullets; the pods launch HIND rockets (700_10_1, heli speed + 5 m/s) that explode", async () => {
    const r = await turretRig(7);
    r.ctx.cheats = { unlimitedAmmo: false, unlimitedHealth: true, oneShotKills: false, invisible: false, allWeapons: false };
    const rt = r.mission.runtime!;
    const mil = r.mission.vehicles!.helis.find((h) => h.id === 353)!;
    const ev = rt.tasks.nodes.find((n) => n.type === "EditVariable" && n.id === 2001)!;
    rt.behaviourState(ev.index).nValue = 1; // AnimTask_302's Run expression
    const m = mil.sim.matrix;
    const p = mil.sim.position;
    r.placePlayer([p[0] + m[1] * 40 * UNITS, p[1] + m[4] * 40 * UNITS, p[2]]);
    const vw = r.combat.vehicleWeapons;
    const ps = projectileSystemOf(r.ctx);
    const seen = new Map<number, { model: string; speed: number }>();
    const explosions: Array<{ damage: number; radius: number; falloff: number; sound: string }> = [];
    const d = damageSystemOf(r.ctx)!;
    const make = d.makeExplosion.bind(d);
    d.makeExplosion = (a) => {
      explosions.push({ damage: a.damage, radius: a.radius, falloff: a.falloff, sound: a.sound });
      return make(a);
    };
    for (let i = 0; i < 600; i++) {
      r.step();
      for (const f of ps.flying) if (f.kind === "missile" && !seen.has(f.id)) seen.set(f.id, { model: f.model, speed: f.missile!.body.speed });
    }
    expect(mil.canFire).toBe(true);
    expect(mil.detector.list).toContain("player");
    // The AnimTask's nTick 0 re-created the heli's attached children (FUN_00431b70): read them now.
    const gun = vw.turrets.find((t) => t.vehicleKey === mil.key)!;
    const pods = vw.pods.filter((x) => x.vehicleKey === mil.key);
    expect(gun.updates).toBeGreaterThan(400);
    expect(gun.gun.rounds).toBeGreaterThan(0);
    expect(pods.reduce((s, x) => s + x.launches, 0)).toBeGreaterThan(0);
    const rockets = [...seen.values()].filter((x) => x.model === "700_10_1");
    expect(rockets.length).toBeGreaterThan(0);
    // Launch speed: (heli speed m/s + 5) x 136.53 units/tick; the heli moves slowly here.
    for (const x of rockets) expect(x.speed).toBeGreaterThan(5 * 136.5 - 10);
    expect(explosions.some((e) => e.damage === 5 && e.radius === 10240 && e.falloff === 7168 && e.sound === "explo_03_l")).toBe(true);
  }, 600_000);
});

describe.skipIf(!haveFull)("the Missile on a real mission (mission 10, RPG18 110_02_1)", () => {
  it("flies by the recovered rigid body (same speeds as the pure flight), explodes on contact with damage 5 / radius 2.5 m / falloff 1.75 m, explo_03_l, source 12", async () => {
    const r = await turretRig(10);
    const ps = projectileSystemOf(r.ctx);
    const type = ps.missileTypeOf("110_02_1")!;
    expect(type.points[0].local[1]).toBeCloseTo(2420.49, 2);
    const explosions: Array<{ position: number[]; damage: number; radius: number; falloff: number; sound: string; source: number | null }> = [];
    const d = damageSystemOf(r.ctx)!;
    const make = d.makeExplosion.bind(d);
    d.makeExplosion = (a) => {
      explosions.push({ position: [...a.position], damage: a.damage, radius: a.radius, falloff: a.falloff, sound: a.sound, source: a.sourceWeaponId ?? null });
      return make(a);
    };
    // From 3 m above the player's feet, pitched 20 deg down: it hits the ground about 8 m ahead.
    const o = r.level.originIgi;
    const pp = r.ctx.player.position;
    const start: [number, number, number] = [pp[0] * UNITS + o[0], -pp[2] * UNITS + o[1], (pp[1] + 3) * UNITS + o[2]];
    const a = -20 * Math.PI / 180;
    const matrix: [number, number, number, number, number, number, number, number, number] = [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
    ps.spawnMissile({ position: start, matrix, muzzleVelocity: 5, model: "110_02_1", owner: "player", sourceWeaponId: 12 });
    const f = ps.flying.find((x) => x.kind === "missile")!;
    // The pure flight with an empty world gives the same first speeds (no contact yet).
    const pure = createMissile(type, { position: start, matrix, muzzleVelocity: 5 });
    const rng = new LevelRng(0);
    const speeds: number[] = [];
    const pureSpeeds: number[] = [];
    for (let i = 0; i < 3; i++) {
      r.step();
      if (ps.flying.includes(f)) speeds.push(f.missile!.body.speed);
      updateMissile(pure, { world: { segment: () => null, inside: () => false }, rng, frame: 1, probeDown: () => true });
      pureSpeeds.push(pure.body.speed);
    }
    speeds.forEach((s, i) => expect(s).toBeCloseTo(pureSpeeds[i], 3));
    for (let i = 0; i < 60 && explosions.length === 0; i++) r.step();
    expect(explosions).toHaveLength(1);
    const x = MISSILE_RULES.explosion;
    expect(explosions[0]).toMatchObject({ damage: x.damage, radius: 10240, falloff: 7168, sound: "explo_03_l", source: 12 });
    expect(ps.flying.some((y) => y.kind === "missile")).toBe(false);
    expect(ps.lastMissileExplosion?.sourceWeaponId).toBe(12);
    // Exploded near the ground ahead (within the 4 m it moves per tick at most).
    const e = explosions[0].position;
    const dx = (e[0] - start[0]) / UNITS;
    const dy = (e[1] - start[1]) / UNITS;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(2);
    expect(Math.hypot(dx, dy)).toBeLessThan(40);
  }, 600_000);
});
