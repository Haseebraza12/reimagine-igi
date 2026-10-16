/**
 * The combat task types and weapons recovered from the full exe, on synthetic
 * inputs (the real missions: tests/full-combat.test.ts).
 */
import { describe, expect, it } from "vitest";
import { MissionRuntime, buildMissionTasks, perceptionPhases, type MissionHost, type MissionNode } from "../src/loaders/mission";
import "../src/loaders/objects";
import type { IgiTask } from "../src/loaders/tasks";
import { GUARD_EVENTS } from "../src/loaders/objects/guard-generator";
import { MINEFIELD_EVENTS, mineFieldRepeatTicks, type MineFieldExplosion } from "../src/loaders/objects/mine-field";
import {
  STATIONARY_GUN,
  gunnerArcs,
  newStationaryGunState,
  stationaryGunBehind,
  stationaryGunDef,
  stationaryGunMount,
  stationaryGunPose,
  stationaryGunUsePoint,
  stepStationaryGun,
} from "../src/loaders/objects/stationary-gun";
import { AI_TURRET, aiTurretAim, aiTurretDef, newAiTurretState, stepAiTurret } from "../src/loaders/objects/ai-stationary-gun";
import { M203, m203LaunchVelocity, m203Step } from "../src/engine/combat/projectiles";
import { FEMALE_STATE, RPG_STATE, VBIT, femaleTick, rpgTick } from "../src/engine/ai/soldier-variants";
import { fireCooldownTicks } from "../src/loaders";

let nextId = 9000;
const task = (type: string, params: Record<string, unknown> = {}, children: IgiTask[] = [], id = nextId++): IgiTask =>
  ({ id, type, name: "", params: params as IgiTask["params"], children });

function runtime(roots: IgiTask[], host: MissionHost = {}): MissionRuntime {
  return new MissionRuntime(buildMissionTasks(roots), host);
}

describe("GuardGenerator (FUN_00487ee0, full exe)", () => {
  function setup(expr: string, max: number) {
    const soldier = task("HumanSoldier", { Position: [0, 0, 0] }, [task("HumanAI", { "AI Type": "AITYPE_GUARD_AK" })]);
    const gen = task("GuardGenerator", { "Generate guards": expr, "Max spawns": max }, [soldier], 600);
    const events: string[] = [];
    const child = { dead: false, inWorld: true };
    const updated: string[] = [];
    const rt = runtime([gen], {
      onTaskEvent: (_n, e) => void events.push(e),
      query: (name) => (name === GUARD_EVENTS.child ? child : undefined),
      updateTask: (n) => (updated.push(n.type), false),
    });
    return { rt, events, child, updated };
  }

  it("spawns at once while the expression holds; nSpawns counts the first spawn; isSpawned stays", () => {
    const { rt, events, updated } = setup("1", 2);
    expect(rt.member("GuardGenerator_600.nSpawns")).toBe(0);
    expect(updated).toEqual([]);
    rt.tick();
    expect(events).toEqual([GUARD_EVENTS.spawn]);
    expect(rt.member("GuardGenerator_600.isOn")).toBe(1);
    expect(rt.member("GuardGenerator_600.isSpawned")).toBe(1);
    expect(rt.member("GuardGenerator_600.nSpawns")).toBe(1);
    // The children (the soldier and its AI) update after the generator, only once spawned.
    expect(updated).toEqual(["HumanSoldier", "HumanAI"]);
    rt.tick();
    expect(events).toEqual([GUARD_EVENTS.spawn]);
  });

  it("replaces a dead soldier only once it left the world, up to Max spawns", () => {
    const { rt, events, child } = setup("1", 2);
    rt.tick();
    child.dead = true;
    rt.tick(); // dead but still in the world (corpse countdown)
    expect(events).toEqual([GUARD_EVENTS.spawn]);
    child.inWorld = false;
    rt.tick();
    expect(events).toEqual([GUARD_EVENTS.spawn, GUARD_EVENTS.remove, GUARD_EVENTS.spawn]);
    expect(rt.member("GuardGenerator_600.nSpawns")).toBe(2);
    rt.tick();
    expect(events.length).toBe(3); // Max spawns reached
  });

  it("keeps isSpawned while a soldier exists after the expression drops; none spawn while it is 0", () => {
    const { rt, events } = setup("0", 3);
    rt.tick();
    expect(events).toEqual([]);
    expect(rt.member("GuardGenerator_600.isSpawned")).toBe(0);
  });

  it("the templates' HumanAIs take no perception phase at load (FUN_00488220 deletes them)", () => {
    const soldier = task("HumanSoldier", {}, [task("HumanAI", {})]);
    const plain = task("HumanSoldier", {}, [task("HumanAI", {})]);
    const tasks = buildMissionTasks([task("GuardGenerator", { "Generate guards": "1", "Max spawns": 1 }, [soldier]), plain]);
    const { phases, next } = perceptionPhases(tasks, 0);
    expect(phases.size).toBe(1);
    expect(next).toBe(1);
    const aiNode = tasks.nodes.findIndex((n) => n.type === "HumanAI" && n.parent === tasks.nodes.findIndex((m) => m.task === plain));
    expect(phases.get(aiNode)).toBe(0);
  });
});

describe("MineField (FUN_0043abc0 / FUN_0043ac40, full exe)", () => {
  function setup(params: Record<string, unknown>, explode = { v: 1 }) {
    const out: MineFieldExplosion[] = [];
    const mf = task("MineField", { Position: [1, 2, 3], Explode: "EditVariable_77.nValue", ...params });
    const ev = task("EditVariable", { "Initial value": explode.v }, [], 77);
    const rt = runtime([ev, mf], {
      onTaskEvent: (_n, e, d) => e === MINEFIELD_EVENTS.explode && out.push(d as MineFieldExplosion),
      query: (name, ...a) => (name === MINEFIELD_EVENTS.position ? (a[0] === 0 ? [100, 200, 5000] : null) : name === MINEFIELD_EVENTS.snap ? 1000 : undefined),
    });
    return { rt, out };
  }

  it("explodes at the named task snapped to the ground, then every fistp(repeat x 30) + 1 ticks", () => {
    const { rt, out } = setup({ "Explode close to task ID": 0, "Explosion radius (meter)": 3, "Explosion falloff radius (meter)": 1.5, "Explosion damage scale": 4.5, "Explosion sound": "explo_m_02" });
    rt.tick();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ position: [100, 200, 1000], damage: 4.5, radius: 12288, falloff: 6144, scorch: 6144, fragments: 3, fireballs: 3, sound: "explo_m_02", aiRange: null, interval: 0, count: 1 });
    expect(mineFieldRepeatTicks(5)).toBe(150);
    for (let i = 0; i < 150; i++) rt.tick();
    expect(out).toHaveLength(1);
    rt.tick();
    expect(out).toHaveLength(2);
  });

  it("-1: explode once (the timer goes negative and never reaches 0 or -1); no task -> no explosion but the timer runs", () => {
    const a = setup({ "Explosion delay between explosions (seconds) -1: explode once": -1 });
    for (let i = 0; i < 400; i++) a.rt.tick();
    expect(a.out).toHaveLength(1);
    const b = setup({ "Explode close to task ID": 5 });
    for (let i = 0; i < 400; i++) b.rt.tick();
    expect(b.out).toHaveLength(0);
  });

  it("does nothing while the expression is 0", () => {
    const { rt, out } = setup({}, { v: 0 });
    for (let i = 0; i < 10; i++) rt.tick();
    expect(out).toHaveLength(0);
  });
});

describe("StationaryGun rules (FUN_00474190 / FUN_00474420, full exe)", () => {
  const def = stationaryGunDef({ Position: [1000, 2000, 3000], Orientation: [0, 0, 0], "Holder model": "123_02_1", "Max up angle": 25, "Max down angle": -25, "Max sideways angle": 180, Ammo: -1 });
  const noKick = () => ({ kickPitch: 0, kickYaw: 0 });

  it("unmanned: the stored pitch drops 5 deg per tick to Max down without overshoot; yaw and the drawn totals stay", () => {
    const st = newStationaryGunState();
    st.totalPitch = 0.2;
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      stepStationaryGun(def, st, null, noKick);
      seen.push(st.pitch);
    }
    expect(seen[0]).toBeCloseTo(-STATIONARY_GUN.dropStep, 7);
    expect(seen[4]).toBeCloseTo(-25 * (Math.PI / 180), 6);
    expect(seen[6]).toBe(seen[4]);
    expect(st.totalPitch).toBe(0.2);
    expect(st.yaw).toBe(0);
  });

  it("manned: pitch += look x pi, yaw -= turn x pi, clamped; totals = angle + last kick; the kick is overwritten by the gun's", () => {
    const st = newStationaryGunState();
    const fires: boolean[] = [];
    stepStationaryGun(def, st, { turn: 0.1, look: 0.05, fire: 1 }, (f) => (fires.push(f), { kickPitch: 0.01, kickYaw: -0.02 }));
    expect(st.pitch).toBeCloseTo(0.05 * Math.PI, 6);
    expect(st.yaw).toBeCloseTo(-0.1 * Math.PI, 6);
    expect(st.totalPitch).toBeCloseTo(st.pitch, 6); // the kick was 0 on this tick
    expect(fires).toEqual([true]);
    expect([st.kickPitch, st.kickYaw]).toEqual([Math.fround(0.01), Math.fround(-0.02)]);
    stepStationaryGun(def, st, { turn: 0, look: 1, fire: 0 }, noKick);
    expect(st.pitch).toBeCloseTo(25 * (Math.PI / 180), 6); // clamped at Max up
    expect(st.totalPitch).toBeCloseTo(st.pitch + Math.fround(0.01), 6);
    expect(st.kickPitch).toBe(0);
    // maxSide 180 deg = pi < 2 pi: the yaw is clamped to +-pi.
    for (let i = 0; i < 20; i++) stepStationaryGun(def, st, { turn: -1, look: 0, fire: 0 }, noKick);
    expect(st.yaw).toBeCloseTo(Math.PI, 6);
    const wide = stationaryGunDef({ "Max sideways angle": 361 });
    const s2 = newStationaryGunState();
    for (let i = 0; i < 20; i++) stepStationaryGun(wide, s2, { turn: -1, look: 0, fire: 0 }, noKick);
    expect(s2.yaw).toBeGreaterThan(2 * Math.PI); // no clamp, no wrap
  });

  it("pose: one magic vertex -> pivot = origin; the barrel along -col1; the eye 0.2 m up, 0.5 m back along the gun", () => {
    const st = newStationaryGunState();
    const p = stationaryGunPose(def, st, 1, null);
    expect(p.pivot).toEqual([1000, 2000, 3000]);
    expect(p.gun[1]).toBeCloseTo(0, 6);
    expect(p.gun[4]).toBeCloseTo(-1, 6); // col1 = (0, -1, 0)
    expect(p.eye[0]).toBeCloseTo(1000, 3);
    expect(p.eye[1]).toBeCloseTo(2000 + 2048, 3);
    expect(p.eye[2]).toBeCloseTo(3000 + 819.2, 3);
    st.totalYaw = Math.PI / 2;
    const q = stationaryGunPose(def, st, 2, [10, 0, 0]);
    expect(q.pivot[0]).toBeCloseTo(1000, 3);
    expect(q.pivot[1]).toBeCloseTo(2010, 3); // vertex 1 under Rz(90)
  });

  it("use: a candidate only from behind; the user stands 0.7 m behind the use point facing the barrel", () => {
    const st = newStationaryGunState();
    const u = stationaryGunUsePoint(def, st, [0, -3, 460]);
    expect(u.point).toEqual([1000, 1997, 3460]);
    expect(stationaryGunBehind(u.point, u.matrix, [1000, 3000, 3000])).toBe(true);
    expect(stationaryGunBehind(u.point, u.matrix, [1000, 1000, 3000])).toBe(false);
    const m = stationaryGunMount(u.point, u.matrix, [1000, 3000, 3000], true);
    expect(m.x).toBeCloseTo(1000, 3);
    expect(m.y).toBeCloseTo(1997 + 2867.2, 2);
    expect(m.heading).toBeCloseTo(Math.PI, 5); // body forward (-sin h, cos h) = (0, -1): the barrel
  });

  it("the gunner's arcs: in front of the barrel within the limits", () => {
    expect(gunnerArcs(def, [1000, 2000 - 40960, 3000]).inArcs).toBe(true);
    expect(gunnerArcs(def, [1000, 2000 - 40960, 3000 + 40960]).inArcs).toBe(false); // 45 deg up > 25
    expect(gunnerArcs(def, [1000, 2000 + 40960, 3000]).inArcs).toBe(false); // behind: |h| = pi > maxSide... pi = maxSide
  });

  it("the M2HB's cooldown is 2 ticks (800 rpm), the SPAS12's 45 (40 rpm)", () => {
    expect(fireCooldownTicks(800)).toBe(2);
    expect(fireCooldownTicks(40)).toBe(45);
  });
});

describe("AIStationaryGun turret (0x46f390, full exe)", () => {
  const def = aiTurretDef(["456_12_1", "456_12_1", { symbol: "TASKTYPE_AISTATIONARYGUN" }, "456_13_1", 361, -10, -90, 10000, 60, 60, "tank_turret", 45, 0.2])!;

  it("reads the definition: steps per tick, limits in radians, min range in units", () => {
    expect(def.gunModel).toBe("456_13_1");
    expect(def.pitchStep).toBeCloseTo((2 * Math.PI) / 180, 6);
    expect(def.maxSide).toBeGreaterThan(AI_TURRET.twoPiF);
    expect(def.minRange).toBeCloseTo(819.2, 2);
  });

  it("slews 2 deg per tick, fires within 5 deg beyond the min range, keeps the lost target for 90 ticks", () => {
    const st = newAiTurretState();
    const aim = aiTurretAim([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], [-40960, 40960, -40960]); // left-forward, below
    expect(aim.yaw).toBeCloseTo(Math.PI / 4, 5);
    expect(aim.pitch).toBeLessThan(0);
    let fired = 0;
    let first = -1;
    for (let i = 0; i < 40; i++) {
      const r = stepAiTurret(def, st, aim);
      if (r.fire) {
        fired++;
        if (first < 0) first = i;
      }
    }
    expect(st.yaw).toBeCloseTo(aim.yaw, 5);
    expect(first).toBeGreaterThan(15); // 45 deg at 2 deg/tick, within 5 deg after ~20 ticks
    expect(fired).toBeGreaterThan(10);
    expect(st.spin).toBeCloseTo(fired * def.spinStep, 4);
    // Target lost: the angles are kept 90 ticks, then back to 0.
    const yaw = st.yaw;
    for (let i = 0; i < 90; i++) stepAiTurret(def, st, null);
    expect(st.yaw).toBeCloseTo(yaw, 5);
    stepAiTurret(def, st, null);
    expect(st.yaw).toBeLessThan(yaw);
  });
});

describe("M203 grenade (FUN_00473510 / 0x476340, full exe)", () => {
  it("leaves at 270 km/h = 10240 units/tick and flies with drag 0.995 and gravity 35.68 per tick", () => {
    expect(m203LaunchVelocity([0, 1, 0], M203.defaults.muzzleKmh)[1]).toBeCloseTo(10240, 1);
    // A level shot from 1.6 m above flat ground lands after ~20 ticks, ~47.5 m away (spec, derived).
    const pos: [number, number, number] = [0, 0, 1.6 * 4096];
    const vel = m203LaunchVelocity([0, 1, 0], 270);
    let ticks = 0;
    while (pos[2] > 0 && ticks < 100) {
      m203Step(pos, vel);
      ticks++;
    }
    expect(ticks).toBe(20);
    expect(pos[1] / 4096).toBeCloseTo(47.5, 0);
  });
});

describe("HumanSoldierFemale / HumanSoldierRPG graphs (full exe)", () => {
  const G = VBIT.GROUNDED;
  it("female: aim request raises, fires while aiming, lowers; reload back to stand; no flinch transitions without the bit", () => {
    const F = FEMALE_STATE;
    const t = (s: number, bits: number, fire = false) => femaleTick(s, { bits, scripted: 0, fireChannel: fire });
    expect(t(F.STAND, G | VBIT.CH23).next).toBe(F.RAISE);
    expect(t(F.RAISE, G | VBIT.FINISHED).next).toBe(F.AIM);
    expect(t(F.AIM, G | VBIT.CH23 | VBIT.FIRE).next).toBe(F.FIRE);
    expect(t(F.FIRE, G | VBIT.FIRE, true)).toMatchObject({ next: -1, trigger: true });
    expect(t(F.FIRE, G | VBIT.FINISHED | VBIT.CH23).next).toBe(F.AIM);
    expect(t(F.AIM, G).next).toBe(F.LOWER);
    expect(t(F.RELOAD, G | VBIT.FINISHED)).toMatchObject({ next: F.STAND, refill: true });
    expect(t(F.STAND, G | VBIT.FORWARD | VBIT.WALKING).next).toBe(F.WALK);
    expect(t(F.STAND, G | VBIT.CH21).next).toBe(F.ANIMATION);
    expect(t(F.STAND, 0).next).toBe(F.FALL);
  });

  it("RPG: fire shoulders the launcher; kneel on ch 21; the kneeling reload refills", () => {
    const R = RPG_STATE;
    const t = (s: number, bits: number, fire = false) => rpgTick(s, { bits, scripted: 0, fireChannel: fire });
    expect(t(R.STAND, G | VBIT.FIRE).next).toBe(R.SHOULDER);
    expect(t(R.SHOULDER, G | VBIT.FINISHED).next).toBe(R.FIRE);
    expect(t(R.STAND, G | VBIT.CH21).next).toBe(R.TO_KNEEL);
    expect(t(R.TO_KNEEL, G | VBIT.FINISHED).next).toBe(R.KNEEL);
    expect(t(R.KNEEL, G | VBIT.CH21 | VBIT.RELOAD).next).toBe(R.KNEEL_RELOAD);
    expect(t(R.KNEEL_RELOAD, G | VBIT.FINISHED)).toMatchObject({ next: R.KNEEL, refill: true });
    expect(t(R.KNEEL, G).next).toBe(R.STAND);
    expect(t(R.FALL, 0)).toMatchObject({ next: R.FALL, reenter: true });
  });
});

// Keep the MissionNode type import used (tests compile under the project's strict settings).
export type { MissionNode };
