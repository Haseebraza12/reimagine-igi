/**
 * The recovered HumanSoldier state graph (engine/ai/soldier-graph.ts), the
 * motor that runs it on real 001.iff clips, the upper-body aim, flinches,
 * deaths and the bone-model LOD rule (docs/characters.md "Soldier state
 * graph", "Upper-body aim", "Hit reactions and deaths", "Bone-model LOD").
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readAnimations, poseSkeleton, type AnimationFile, type IgiLevel } from "../src/loaders";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { ClipPlayer, phaseTime } from "../src/engine/ai/clip-player";
import { SoldierMotor, type GunSpec } from "../src/engine/ai/motor";
import {
  COND,
  SOLDIER_ACTION_TABLES,
  SOLDIER_STATE as S,
  SOLDIER_STATES,
  SOLDIER_ZONES,
  applyUpperBodyAim,
  headingOfDirection,
  soldierActionTable,
  soldierTick,
  splitAimAngle,
  type SoldierTickInput,
} from "../src/engine/ai/soldier-graph";
import { loadSoldierLods, mefSphere, soldierLod } from "../src/engine/combat/soldier-lod";
import { RAW_ROOT, readRaw } from "./helpers";

const HAVE_ANIMS = existsSync(`${RAW_ROOT}/common/anims/001.iff`);
const HAVE_MODELS = existsSync(`${RAW_ROOT}/missions/location0/level1/models/level1.res`) && existsSync(`${RAW_ROOT}/lod.qvm`);

const base = (bits: number, extra: Partial<SoldierTickInput> = {}): SoldierTickInput => ({
  bits: bits | COND.GROUNDED,
  scripted: 0,
  counter: 0,
  eventTrigger: -1,
  eventClip: -1,
  currentClip: -1,
  aiHasTarget: true,
  thrown: false,
  struck: false,
  use: false,
  usePrevious: false,
  ...extra,
});

describe("HumanSoldier state graph (0x53cbc0, FUN_0045b6a0)", () => {
  it("has the 38 states of the action table and the recovered tables", () => {
    expect(SOLDIER_STATES.length).toBe(38);
    expect(SOLDIER_ACTION_TABLES.default.length).toBe(38);
    expect(SOLDIER_ACTION_TABLES.default[S.FIRE]).toEqual({ clip: 56, loop: true });
    expect(SOLDIER_ACTION_TABLES.default[S.STATIONARY_GUN]).toEqual({ clip: 31, loop: true });
    expect(soldierActionTable("AITYPE_GUARD_AK")).toBe(SOLDIER_ACTION_TABLES.default);
    expect(soldierActionTable("AITYPE_SPETNAZ_GUARD_SPAS")).toBe(SOLDIER_ACTION_TABLES.spetnaz);
    expect(soldierActionTable("AITYPE_PRIBOI")[0].clip).toBe(64);
    expect(SOLDIER_ZONES.map((z) => z.flinchClip)).toEqual([44, 44, 44, 47, 47, 47, 45, 45, 45, 46, 46, 46, 27, 27, 27, 27, 27]);
    expect(SOLDIER_ZONES[15].deathClips[0]).toBe(30);
    expect(SOLDIER_ZONES[16].deathClips[1]).toBe(22);
  });

  it("stand: priorities fall > flinch > dead > kneel/roof > liedown > aim > grenade > reload > animation > close combat > run", () => {
    expect(soldierTick(S.STAND, { ...base(0), bits: COND.AIM }).next).toBe(S.FALL); // not grounded
    expect(soldierTick(S.STAND, base(COND.FLINCH | COND.DEAD)).next).toBe(S.FLINCH);
    expect(soldierTick(S.STAND, base(COND.DEAD | COND.KNEEL)).next).toBe(S.DEATH_STAND);
    expect(soldierTick(S.STAND, base(COND.ROOF)).next).toBe(S.TO_KNEEL);
    expect(soldierTick(S.STAND, base(COND.AIM | COND.GRENADE)).next).toBe(S.RAISE);
    expect(soldierTick(S.STAND, base(COND.FIRE)).next).toBe(-1); // the trigger alone does nothing standing
    expect(soldierTick(S.STAND, base(COND.FORWARD | COND.WALKING)).next).toBe(S.WALK);
    expect(soldierTick(S.STAND, base(COND.FORWARD)).next).toBe(S.RUN);
    expect(soldierTick(S.STAND, base(COND.FORWARD | COND.PANIC)).next).toBe(S.RUN_PANIC);
    expect(soldierTick(S.STAND, base(COND.FORWARD | COND.CH26 | COND.PANIC)).next).toBe(S.RUN_GUN);
    expect(soldierTick(S.STAND, base(COND.LEFT)).next).toBe(S.ROLL_LEFT);
  });

  it("aim / fire cycle: raise -> aim -> fire (trigger) -> aim or lower at a loop end", () => {
    expect(soldierTick(S.RAISE, base(COND.AIM)).next).toBe(-1);
    expect(soldierTick(S.RAISE, base(COND.FINISHED)).next).toBe(S.AIM);
    expect(soldierTick(S.AIM, base(COND.AIM | COND.FIRE)).next).toBe(S.FIRE);
    expect(soldierTick(S.AIM, base(0)).next).toBe(S.LOWER);
    const firing = soldierTick(S.FIRE, base(COND.AIM | COND.FIRE | COND.FINISHED));
    expect([firing.next, firing.trigger]).toEqual([-1, true]);
    expect(soldierTick(S.FIRE, base(COND.AIM | COND.FINISHED)).next).toBe(S.AIM);
    expect(soldierTick(S.FIRE, base(COND.FINISHED)).next).toBe(S.LOWER);
    expect(soldierTick(S.LOWER, base(COND.FINISHED)).next).toBe(S.STAND);
    // Reload refills at the clip end; running fire refills every tick.
    expect(soldierTick(S.RELOAD, base(COND.FINISHED)).refill).toBe(true);
    expect(soldierTick(S.RUN_FIRE, base(COND.CH26 | COND.FORWARD | COND.FIRE)).refill).toBe(true);
  });

  it("kneel and prone: no kneel-to-stand clip, kneel fire needs aim, prone flinch guard", () => {
    expect(soldierTick(S.TO_KNEEL, base(COND.FINISHED)).next).toBe(S.KNEEL);
    expect(soldierTick(S.KNEEL, base(0)).next).toBe(S.STAND);
    expect(soldierTick(S.KNEEL, base(COND.ROOF)).next).toBe(-1);
    expect(soldierTick(S.KNEEL, base(COND.KNEEL | COND.FIRE)).next).toBe(S.KNEEL_AIM);
    expect(soldierTick(S.KNEEL_AIM, base(COND.KNEEL | COND.FIRE)).next).toBe(S.KNEEL);
    expect(soldierTick(S.KNEEL_AIM, base(COND.KNEEL | COND.FIRE | COND.AIM | COND.FINISHED)).next).toBe(S.KNEEL_FIRE);
    expect(soldierTick(S.ROLL_LEFT, base(COND.DEAD)).next).toBe(S.DEATH_KNEEL);
    expect(soldierTick(S.DIVE, base(COND.DEAD)).next).toBe(S.DEATH_PRONE);
    expect(soldierTick(S.PRONE, base(COND.LIEDOWN | COND.FLINCH)).next).toBe(S.PRONE_FLINCH);
    expect(soldierTick(S.PRONE, base(0)).next).toBe(S.PRONE_TO_STAND);
    const guarded = soldierTick(S.PRONE_FLINCH, base(COND.FLINCH, { counter: 5 }));
    expect([guarded.next, guarded.counter]).toEqual([-1, 6]);
    expect(soldierTick(S.PRONE_FLINCH, base(COND.FLINCH, { counter: 20 })).next).toBe(S.PRONE_FLINCH);
  });

  it("scripted animation ends on any move / fire / stance input, the clip end, or -1", () => {
    expect(soldierTick(S.ANIMATION, base(COND.ANIMATION)).next).toBe(-1);
    expect(soldierTick(S.ANIMATION, base(COND.WALKING)).next).toBe(-1);
    expect(soldierTick(S.ANIMATION, base(COND.FORWARD)).next).toBe(S.STAND);
    expect(soldierTick(S.ANIMATION, base(COND.FINISHED)).next).toBe(S.STAND);
    expect(soldierTick(S.ANIMATION, base(0, { scripted: -1 })).next).toBe(S.STAND);
  });

  it("splits the aim angle at 0.96 rad between spine and neck (FUN_00488390)", () => {
    expect(splitAimAngle(0.5)).toEqual({ spine: Math.fround(0.5), neck: 0 });
    const s = splitAimAngle(1.2);
    expect(s.spine).toBeCloseTo(0.95993114, 7);
    expect(s.neck).toBeCloseTo(1.2 - 0.95993114, 6);
    expect(splitAimAngle(-1.5).spine).toBeCloseTo(-0.95993114, 7);
  });

  it("FUN_00486950 heading: acos(y/|v|), negative for x > 0", () => {
    expect(headingOfDirection([0, 1, 0])).toBe(0);
    expect(headingOfDirection([1, 0, 0])).toBeCloseTo(-Math.PI / 2, 12);
    expect(headingOfDirection([-1, 0, 0])).toBeCloseTo(Math.PI / 2, 12);
    expect(headingOfDirection([0, 0, 0])).toBe(0);
  });
});

describe("LOD of bone objects (FUN_004c4fc0 with lod.qvm distances)", () => {
  const set = { variants: [], explicit: [5, 9, 40, 50, 80], centre: [0, 0, 0] as [number, number, number], radius: 3778 };
  it("switches at d = t (depth - radius) past 5 / 9 / 40 / 50 m and culls past 80 m", () => {
    const r = 3778 / 4096;
    expect(soldierLod(set, 5, 3, 1)).toBe(0);
    expect(soldierLod(set, 5, 5 + r + 0.01, 1)).toBe(1);
    expect(soldierLod(set, 5, 30, 1)).toBe(2);
    expect(soldierLod(set, 5, 45, 1)).toBe(3);
    expect(soldierLod(set, 5, 70, 1)).toBe(4);
    expect(soldierLod(set, 5, 80 + r + 0.01, 1)).toBe(-1);
    // Zoom (smaller tan) refines the LOD: 200 m through a 4x zoom.
    expect(soldierLod(set, 5, 200, 0.25)).toBe(3);
    // Fewer variants: clamped to the last one.
    expect(soldierLod(set, 2, 45, 1)).toBe(1);
    expect(soldierLod(null, 5, 500, 1)).toBe(0);
  });
});

describe.skipIf(!HAVE_ANIMS)("soldier motor on 001.iff", () => {
  let anim: AnimationFile;
  const gun: GunSpec = { weaponId: "WEAPON_ID_AK47", roundsPerClip: 30, maxRoundsPerBurst: 30, roundsPerMinute: 600, grenade: false };
  const ch = (...pairs: Array<[number, number]>) => {
    const c = new Float32Array(40);
    for (const [k, v] of pairs) c[k] = v;
    return c;
  };
  const make = async (standAnimation = -1, rand = 0) => {
    anim ??= readAnimations(await readRaw("common/anims/001.iff"));
    const body = new ClipPlayer(anim);
    let shots = 0;
    const motor = new SoldierMotor(body, 0, standAnimation, gun, null, { shot: () => shots++ }, () => rand);
    motor.step(new Float32Array(40)); // first run: state 0's entry
    return { body, motor, shots: () => shots };
  };

  it("raise 53 -> aim 54 -> fire 56 (shots only while firing) -> lower 55 -> idle 2", async () => {
    const { body, motor, shots } = await make();
    const seen: Array<[number, number]> = [];
    const note = () => {
      const last = seen[seen.length - 1];
      if (!last || last[0] !== motor.state) seen.push([motor.state, body.currentClip]);
    };
    for (let i = 0; i < 30; i++) {
      motor.step(ch([27, 1]));
      note();
    }
    expect(seen).toEqual([[11, 53], [10, 54]]);
    expect(shots()).toBe(0);
    for (let i = 0; i < 30; i++) {
      motor.step(ch([27, 1], [6, 1]));
      note();
    }
    expect(motor.state).toBe(S.FIRE);
    expect(shots()).toBeGreaterThan(5);
    for (let i = 0; i < 60; i++) {
      motor.step(new Float32Array(40));
      note();
    }
    expect(seen.map((s) => s[0])).toEqual([11, 10, 6, 12, 0]);
    expect(seen.map((s) => s[1])).toEqual([53, 54, 56, 55, 2]);
    // Every state switch restarts the clip at once (blend 0); 53 lasts 14 ticks.
    expect(anim.clips.get(53)!.duration / 160).toBe(14);
  });

  it("walk <-> run keep the stride phase (FUN_00459cc0 / 00459f80)", async () => {
    const { body, motor } = await make();
    for (let i = 0; i < 37; i++) motor.step(ch([4, 1]));
    expect([motor.state, body.currentClip]).toEqual([S.WALK, 57]);
    const phase = body.phase();
    motor.step(ch([4, 1], [20, 1])); // the toggle applies after this tick's graph run
    motor.step(ch([4, 1]));
    expect([motor.state, body.currentClip]).toEqual([S.RUN, 3]);
    const dur57 = anim.clips.get(57)!.duration;
    const expected = phaseTime(phase + 160 / dur57, anim.clips.get(3)!.duration) + 160;
    expect(body.clip!.time).toBeCloseTo(expected, 0);
  });

  it("flinch: damage since the last flinch above the recoil threshold plays the zone's clip", async () => {
    const { body, motor } = await make();
    motor.step(new Float32Array(40));
    motor.hit({ amount: 0.2, zone: 12, deathType: 2, direction: [0, 1, 0], lethal: false });
    motor.step(new Float32Array(40));
    expect(motor.state).toBe(S.STAND);
    motor.hit({ amount: 0.2, zone: 4, deathType: 2, direction: [0, 1, 0], lethal: false });
    expect(motor.recoilAccum).toBe(0);
    motor.step(new Float32Array(40));
    expect([motor.state, body.currentClip, motor.aimEnabled]).toEqual([S.FLINCH, 47, false]);
    for (let i = 0; i < 200 && motor.state === S.FLINCH; i++) motor.step(new Float32Array(40));
    expect([motor.state, motor.aimEnabled]).toEqual([S.STAND, true]);
  });

  it("standing deaths: head zones use the zone table, others {23, 22}[r]; blown deaths turn the body", async () => {
    const head = await make(-1, 0);
    head.motor.hit({ amount: 100, zone: 16, deathType: 2, direction: [0, 1, 0], lethal: true });
    head.motor.step(new Float32Array(40));
    expect([head.motor.state, head.body.currentClip]).toEqual([S.DEATH_STAND, 22]);
    const front = await make(-1, 0);
    front.motor.hit({ amount: 1, zone: 15, deathType: 2, direction: [0, -1, 0], lethal: true });
    front.motor.step(new Float32Array(40));
    expect(front.body.currentClip).toBe(30);
    const torso = await make(-1, 1);
    torso.motor.hit({ amount: 1, zone: 12, deathType: 2, direction: [0, -1, 0], lethal: true });
    torso.motor.step(new Float32Array(40));
    expect(torso.body.currentClip).toBe(22);
    // Explosion behind (blast pushes along +y = the body's forward): clip 71, heading = the blast.
    const behind = await make();
    behind.motor.hit({ amount: 1, zone: 13, deathType: 0, direction: [1, 1, 0], lethal: true });
    behind.motor.step(new Float32Array(40));
    expect(behind.body.currentClip).toBe(71);
    expect(behind.motor.yaw).toBeCloseTo(-Math.PI / 4, 6);
    // Shotgun from the front (travel -y): clip 28, the body faces the shooter.
    const shotgun = await make();
    shotgun.motor.hit({ amount: 1, zone: 12, deathType: 1, direction: [0, -1, 0], lethal: true });
    shotgun.motor.step(new Float32Array(40));
    expect(shotgun.body.currentClip).toBe(28);
    expect(Math.cos(shotgun.motor.yaw)).toBeCloseTo(1, 6);
    expect(shotgun.motor.weaponDropped).toBe(true);
  });

  it("scripted animation (channel 23) plays once and ends at its last frame", async () => {
    const { body, motor } = await make();
    motor.step(ch([23, 41]));
    expect([motor.state, body.currentClip]).toEqual([S.ANIMATION, 41]);
    const ticks = anim.clips.get(41)!.duration / 160;
    for (let i = 0; i < ticks + 2 && motor.state === S.ANIMATION; i++) motor.step(new Float32Array(40));
    expect(motor.state).toBe(S.STAND);
  });

  it("root motion: the delta is sampled before the advance and is continuous across loop wraps", async () => {
    const { body, motor } = await make();
    for (let i = 0; i < 3; i++) motor.step(ch([4, 1]));
    expect(body.currentClip).toBe(57);
    let y = 0;
    const clip = anim.clips.get(57)!;
    const ticks = clip.duration / 160;
    for (let i = 0; i < 2 * ticks; i++) y += motor.step(ch([4, 1])).delta[1];
    // Two cycles of the patrol walk: ~1.26 m/s for 2 x 6.77 s.
    expect(y / 4096 / (2 * clip.seconds)).toBeGreaterThan(1.2);
    expect(y / 4096 / (2 * clip.seconds)).toBeLessThan(1.32);
  });

  it("upper-body aim turns bones 1..22 about the right axis through bone 1 (FUN_00488390 / FUN_004cd700)", async () => {
    anim ??= readAnimations(await readRaw("common/anims/001.iff"));
    const sk = anim.skeleton;
    const yaw = 0.3;
    const root = [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
    const a = poseSkeleton(sk, null, root);
    const b = poseSkeleton(sk, null, root);
    applyUpperBodyAim(b, sk.parents, 0.5, 0, yaw);
    const pos = (m: Float32Array, i: number) => [m[16 * i + 12], m[16 * i + 13], m[16 * i + 14]];
    // Bone 1 stays, the legs stay, bone 22 turns 0.5 rad about the right axis through bone 1.
    expect(pos(b, 1)).toEqual(pos(a, 1));
    expect(pos(b, 25)).toEqual(pos(a, 25));
    const right = [Math.cos(yaw), Math.sin(yaw), 0];
    const p1 = pos(a, 1);
    const va = pos(a, 22).map((v, k) => v - p1[k]);
    const vb = pos(b, 22).map((v, k) => v - p1[k]);
    const along = (v: number[]) => v[0] * right[0] + v[1] * right[1] + v[2] * right[2];
    expect(along(vb)).toBeCloseTo(along(va), 3);
    const perp = (v: number[]) => v.map((x, k) => x - along(v) * right[k]);
    const pa = perp(va), pb = perp(vb);
    const cos = (pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2]) / (Math.hypot(...pa) * Math.hypot(...pb));
    expect(Math.acos(Math.min(1, cos))).toBeCloseTo(0.5, 4);
    // Up is positive: the forward-pointing gun bone rises.
    expect(pos(b, 22)[2]).toBeGreaterThan(pos(a, 22)[2]);
  });
});

describe.skipIf(!HAVE_MODELS)("soldier LOD sets on level-1 data", () => {
  it("003_01_1 has variants _2.._5, lod.qvm distances 5/9/40/50/80 m and an HSEM sphere of 3778 units", async () => {
    const { readIlffMembers } = await import("../src/loaders");
    const members = readIlffMembers(await readRaw("missions/location0/level1/models/level1.res"));
    const own = members.find((m) => m.name.endsWith("003_01_1.mef"))!;
    expect(mefSphere(own.payload)?.radius).toBeCloseTo(3778.28, 2);
    const level = {
      textures: new Map(),
      boneModels: new Map([["003_01_1", { name: "003_01_1", buffer: own.payload, textureKeys: [] }]]),
      soldiers: [],
    } as unknown as IgiLevel;
    const lods = await loadSoldierLods(createFsAssetSource(RAW_ROOT), level, ["003_01_1"]);
    const set = lods.get("003_01_1")!;
    expect(set.variants.map((v) => v.name)).toEqual(["003_01_2", "003_01_3", "003_01_4", "003_01_5"]);
    expect(set.explicit).toEqual([5, 9, 40, 50, 80]);
    expect(set.radius).toBeCloseTo(3778.28, 2);
  });
});
