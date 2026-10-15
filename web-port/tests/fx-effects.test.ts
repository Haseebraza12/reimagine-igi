/**
 * Bullet-impact and gun effects (src/engine/fx/*; rules recovered from
 * igi.exe, docs/rendering.md section 7). Pure rules are tested with synthetic
 * inputs; the data checks read the staged original files and skip when they
 * are missing.
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "../src/contracts";
import { readImpactMaterials, readQvmCallTree, readAmmoTypes, readIlffMembers, readUiSprite, type ImpactMaterial } from "../src/loaders";
import { LevelRng } from "../src/engine/ai/rng";
import type { GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import {
  BULLET_HOLE,
  CASING,
  FRAGMENTS,
  FRAGMENT_GRAVITY,
  GUNSHOT_EFFECT,
  HoleRing,
  TRACER,
  TracerCounter,
  bulletHoleCorners,
  casingLaunch,
  casingStep,
  coneVelocity,
  dustPositions,
  fragmentLaunch,
  frameOf,
  gunshotEffectCalls,
  gunshotEffectPlan,
  isDuplicateHole,
  stepParticle,
  tracerAlpha,
  tracerColour,
  type BulletHitReport,
  type BulletReport,
  type EffectRng,
  type ParticleState,
} from "../src/engine/fx/bullet-effects";
import { createDecalSystem, bulletHoleQuad } from "../src/engine/fx/decals";
import { createEffects, decalTarget } from "../src/engine/fx/effects";
import { loadEffectAssets, readMefPoints } from "../src/engine/fx/effect-assets";
import { particleCorners, spriteSequence } from "../src/engine/fx/particles";
import { NO_FOG } from "../src/engine/render/fog";
import { CollisionWorldBuilder, TRI_BULLET, TRI_SIGHT, TRI_SOLID } from "../src/engine/world/collision";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { RAW_ROOT, readRaw } from "./helpers";

const effect = (t1: string, t2: string, size: number, model: string, dust: boolean, debris: boolean) => ({
  effectTask: "TASKTYPE_GUNSHOTEFFECT",
  flagA: dust,
  flagB: debris,
  decalTextures: [t1, t2] as [string, string],
  size: Math.fround(size), // material.qvm stores float32
  model,
});
const MATERIALS: ImpactMaterial[] = [
  { index: 0, name: "Air", effects: [effect("", "", 0.03, "1009_01_1", true, true), effect("", "", 0.03, "1009_01_1", false, false)] },
  {
    index: 10,
    name: "Concrete",
    effects: [effect("bullethole_concrete.tex", "dent_concrete.tex", 0.05, "1012_01_1", true, true), effect("bullethole_concrete.tex", "bullethole_concrete.tex", 0.06, "1012_01_1", false, false)],
  },
  { index: 8, name: "Flesh", effects: [effect("hole_concrete1.tex", "hole_concrete1.tex", 0.03, "1009_01_1", true, true), effect("hole_concrete1.tex", "hole_concrete1.tex", 0.03, "1009_01_1", false, false)] },
];

/** Scripted generator: floats and ints from lists, raw steps from a list. */
function scripted(floats: number[], ints: number[] = [], steps: number[] = []): EffectRng & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    float() {
      log.push("f");
      return floats.shift() ?? 0;
    },
    int(n: number) {
      log.push(`i${n}`);
      return (ints.shift() ?? 0) % n;
    },
    step() {
      log.push("s");
      return steps.shift() ?? 0;
    },
  };
}

const front = (material: string, point: Vec3, normal: Vec3, segment: Vec3, extra: Partial<BulletHitReport> = {}): BulletHitReport => ({
  front: true,
  material,
  point,
  faceNormal: normal,
  segment,
  terrain: false,
  owner: 3,
  body: null,
  human: false,
  ...extra,
});

describe("GunShotEffect records and flags (FUN_00479e30 tail)", () => {
  it("records front hits only with an entry-A texture, back hits always, flag 1 except the last", () => {
    const hits = [
      front("Air", [0, 0, -1], [0, 0, 1], [0, 0, -10]),
      front("Concrete", [0, 0, -2], [0, 0, 1], [0, 0, -10]),
      { ...front("Concrete", [0, 0, -2.2], [0, 0, -1], [0, 0, -8]), front: false },
      front("Concrete", [0, 0, -5], [0, 0, 1], [0, 0, -7]),
    ];
    const calls = gunshotEffectCalls(hits, false, MATERIALS);
    expect(calls.map((c) => [c.entry, c.flag])).toEqual([
      [0, true],
      [1, true],
      [0, false],
    ]);
    // Front: the segment mirrored about the face (IGI axes): engine -z = IGI +y, mirrored to -y.
    expect(calls[0].direction[1]).toBeCloseTo(-1, 12);
    // Back: the segment itself.
    expect(calls[1].direction[1]).toBeCloseTo(1, 12);
    expect(gunshotEffectCalls(hits, true, MATERIALS).every((c) => !c.flag)).toBe(true);
  });

  it("caps the records at 10 per bullet", () => {
    const hits = Array.from({ length: 14 }, (_, i) => front("Concrete", [0, 0, -i], [0, 0, 1], [0, 0, -20]));
    expect(gunshotEffectCalls(hits, false, MATERIALS)).toHaveLength(10);
  });

  it("FUN_004376c0 draws: rand(3) + 2 fragments, 3 spin floats, then a raw step and 4 floats for dust", () => {
    const [call] = gunshotEffectCalls([front("Concrete", [0, 0, -2], [0, 0, 1], [0, 0, -10])], false, MATERIALS);
    const rng = scripted([0.5, 0.25, 1 - 2 ** -16, 0.5, 0.0, 0.5, 0.5], [2], [3]);
    const plan = gunshotEffectPlan(call, rng);
    expect(rng.log).toEqual(["i3", "f", "f", "f", "s", "f", "f", "f", "f"]);
    expect(plan.debris?.count).toBe(4);
    expect(plan.debris?.model).toBe("1012_01_1");
    expect(plan.debris?.spin[0]).toBeCloseTo(0.5 * 0.6283185, 6);
    // Last record (flag 0): texture 2; half-size 0.05 m = 204.8 units.
    expect(plan.decal).toEqual({ texture: "dent_concrete.tex", halfSizeUnits: Math.fround(Math.fround(0.05) * 4096) });
    // Dust: speed (0.5 x 0.75 + 0.15) x 4096000 / 108000 units/tick, alpha 0.75, second puff x 1.25.
    expect(plan.dust?.speeds[0]).toBeCloseTo(0.525 * 37.925925, 3);
    expect(plan.dust?.speeds[1]).toBeCloseTo(plan.dust!.speeds[0] * 1.25, 4);
    expect(plan.dust?.alpha).toBeCloseTo(0.75, 6);
    // Even raw step: no dust.
    const even = gunshotEffectPlan(call, scripted([0, 0, 0], [0], [2]));
    expect(even.dust).toBeNull();
  });

  it("humans get no fragments and no dust; texture 1 when the bullet went on", () => {
    const hits = [front("Flesh", [0, 0, -2], [0, 0, 1], [0, 0, -10], { human: true }), front("Concrete", [0, 0, -4], [0, 0, 1], [0, 0, -8])];
    const calls = gunshotEffectCalls(hits, false, MATERIALS);
    const rng = scripted([], [], [1]);
    const p = gunshotEffectPlan(calls[0], rng);
    expect(p.debris).toBeNull();
    expect(p.dust).toBeNull();
    expect(rng.log).toEqual([]);
    expect(decalTarget(null, calls[0].hit)).toBeNull();
    expect(calls[1].flag).toBe(false);
    const through = gunshotEffectCalls([front("Concrete", [0, 0, -2], [0, 0, 1], [0, 0, -10]), front("Concrete", [0, 0, -3], [0, 0, 1], [0, 0, -9])], false, MATERIALS);
    expect(gunshotEffectPlan(through[0], scripted([], [], [0])).decal?.texture).toBe("bullethole_concrete.tex");
  });

  it("dust sits 491.52 units out along the normal, the second puff 40.96 higher", () => {
    const [a, b] = dustPositions([100, 200, 300], [0, 0, 2]);
    expect(a).toEqual([100, 200, 300 + GUNSHOT_EFFECT.dustHalfSize * 3]);
    expect(b[2] - a[2]).toBeCloseTo(40.96, 4);
  });
});

describe("bullet holes (FUN_0047b9d0 / FUN_0047bf10)", () => {
  it("frame of a normal: a = |(n.y, -n.x, 0)|, b = |a x n|, rows b, a, n", () => {
    const m = frameOf([1, 0, 0]);
    expect(m.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 0, 1, 0, -1, 0, 1, 0, 0]);
    expect(frameOf([0, 0, 1]).map((v) => v + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("quad: corners (+-s, +-s) in the normal's frame, lifted 12.288 units", () => {
    const c = bulletHoleCorners([0, 0, 0], [0, 0, 1], 204.8);
    expect(c[0][0]).toBeCloseTo(204.8, 9);
    expect(c[0][1]).toBeCloseTo(204.8, 9);
    expect(c[3][0]).toBeCloseTo(-204.8, 9);
    for (const p of c) expect(p[2]).toBeCloseTo(BULLET_HOLE.liftUnits, 9);
    // Engine helper: a wall facing +x (engine) at x = 2.
    const q = bulletHoleQuad([2, 1, 0], [1, 0, 0], 204.8);
    for (const p of q) expect(p[0]).toBeCloseTo(2 + 12.288 / 4096, 9);
    // Triangles (c0, c1, c2) face the normal (counter-clockwise seen from +n).
    const e1 = new THREE.Vector3(...q[1]).sub(new THREE.Vector3(...q[0]));
    const e2 = new THREE.Vector3(...q[2]).sub(new THREE.Vector3(...q[0]));
    expect(e1.cross(e2).x).toBeGreaterThan(0);
  });

  it("ring of 200 slots reuses the oldest; duplicates within 1.5 x half-size and dot > 0.9", () => {
    const r = new HoleRing();
    for (let i = 0; i < 200; i++) expect(r.take()).toBe(i);
    expect([r.take(), r.take(), r.take()]).toEqual([0, 1, 2]);
    const holes = [{ centre: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3, halfSize: 100, invalid: false }];
    expect(isDuplicateHole(holes, [149, 0, 0], [0, 0, 1], false)).toBe(true);
    expect(isDuplicateHole(holes, [151, 0, 0], [0, 0, 1], false)).toBe(false);
    expect(isDuplicateHole(holes, [10, 0, 0], [0, 1, 0], false)).toBe(false); // other face
    expect(isDuplicateHole(holes, [10, 0, 0], [0, 1, 0], true)).toBe(true); // terrain: distance only
    expect(isDuplicateHole([{ ...holes[0], invalid: true }], [10, 0, 0], [0, 0, 1], false)).toBe(false);
  });

  it("decal system: per-object lists, invalid overhangs keep their slot, at most 100 objects", () => {
    const tex = { width: 4, height: 4, rgba: new Uint8ClampedArray(64).fill(255), format: "test" };
    const textures = new Map([["dent_concrete.tex", tex]]);
    // A 1 m wall square at z = -5 (engine), facing +z: corners near the edge overhang.
    const b = new CollisionWorldBuilder();
    b.addIndexed([-0.5, 0, -5, 0.5, 0, -5, 0.5, 1, -5, -0.5, 1, -5], [0, 1, 2, 0, 2, 3]);
    const world = b.build();
    const probe = (from: Vec3, to: Vec3) => {
      const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const l = Math.hypot(d[0], d[1], d[2]);
      return world.raycast(from[0], from[1], from[2], d[0] / l, d[1] / l, d[2] / l, l, TRI_SOLID | TRI_BULLET | TRI_SIGHT) !== null;
    };
    const decals = createDecalSystem(MATERIALS, textures, NO_FOG, { value: 0 }, { probe });
    const target = { key: "task:1", terrain: false, body: null };
    expect(decals.place(target, [0, 0.5, -5], [0, 0, 1], "dent_concrete.tex", 204.8)).toBe("placed");
    expect(decals.place(target, [0.01, 0.5, -5], [0, 0, 1], "dent_concrete.tex", 204.8)).toBe("duplicate");
    expect(decals.place(target, [0.49, 0.5, -5], [0, 0, 1], "dent_concrete.tex", 204.8)).toBe("invalid");
    expect(decals.stats()).toEqual({ lists: 1, holes: 2, drawn: 1 });
    for (let i = 2; i <= 100; i++) decals.place({ key: `task:${i}`, terrain: false, body: null }, [0, 0.5, -5], [0, 0, 1], "dent_concrete.tex", 204.8);
    expect(decals.place({ key: "task:101", terrain: false, body: null }, [0, 0.5, -5], [0, 0, 1], "dent_concrete.tex", 204.8)).toBe("full");
    expect(decals.place(target, [0, 0.2, -5], [0, 0, 1], "missing.tex", 204.8)).toBe("no-texture");
    decals.dispose();
  });

  it("no holes on humans, wires or the terrain (no object in its hit record); one list per placed object", () => {
    const level = { instances: [{ taskType: "Wire", magicType: null }, { taskType: "Building", magicType: null, taskIndex: 7 }] } as never;
    expect(decalTarget(level, { terrain: false, owner: 0, body: null, human: false })).toBeNull();
    expect(decalTarget(level, { terrain: false, owner: 1, body: null, human: false })?.key).toBe("inst:1");
    expect(decalTarget(level, { terrain: true, owner: -1, body: null, human: false })).toBeNull();
    expect(decalTarget(level, { terrain: false, owner: 1, body: 4, human: false })).toEqual({ key: "body:4", terrain: false, body: 4 });
  });
});

describe("fragments, casings, particles", () => {
  it("fragment launch: 340..680 units/tick in a 30-degree half cone around the direction", () => {
    const dir: Vec3 = [0.3, -0.4, 0.866];
    const rng = new LevelRng(0x1234);
    const n = Math.hypot(...dir);
    const f = frameOf([dir[0] / n, dir[1] / n, dir[2] / n]);
    for (let i = 0; i < 200; i++) {
      const { velocity } = fragmentLaunch(dir, rng);
      const speed = Math.hypot(...velocity);
      expect(speed).toBeGreaterThanOrEqual(339.99);
      expect(speed).toBeLessThanOrEqual(680.01);
      const cos = (velocity[0] * dir[0] + velocity[1] * dir[1] + velocity[2] * dir[2]) / (speed * n);
      expect(cos).toBeGreaterThanOrEqual(Math.cos(GUNSHOT_EFFECT.debrisConeRad) - 1e-6);
      // Half cone: never on the negative side of the frame's first row.
      expect(velocity[0] * f[0] + velocity[1] * f[1] + velocity[2] * f[2]).toBeGreaterThanOrEqual(-1e-3);
    }
    expect(FRAGMENTS.scale).toBeCloseTo(0.1, 6);
    expect(FRAGMENT_GRAVITY).toBeCloseTo(0.45 * 44.6009 * 0.98, 3);
  });

  it("casings: 151/189/227/265 units/tick, up 0..29 degrees, 19 ticks of drag and gravity", () => {
    const speeds = new Set<number>();
    const rng = new LevelRng(99);
    for (let i = 0; i < 400; i++) {
      const { localVelocity: v } = casingLaunch(rng);
      speeds.add(Math.round(Math.hypot(...v)));
      expect(v[1]).toBe(0);
      expect(v[2]).toBeGreaterThanOrEqual(0);
      expect(Math.atan2(v[2], v[0])).toBeLessThan((30 * Math.PI) / 180);
    }
    expect([...speeds].sort((a, b) => a - b)).toEqual([151, 189, 227, 265]);
    const s = casingStep([0, 0, 0], [100, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(s.velocity[0]).toBeCloseTo(98.5, 4);
    expect(s.velocity[2]).toBeCloseTo(-CASING.gravity * CASING.drag, 4);
  });

  it("particle life: hold for `life` ticks, then fade 1/30 per tick; frames every trunc(15/7) ticks", () => {
    const p: ParticleState = { position: [0, 0, 0], velocity: [0, 0, 10], collide: 3, life: 15, frame: 0, frameTicks: 0, spin: 0.01, alpha: 1, fade: Math.fround(1 / 30), angle: 0, scale: 1, previous: [0, 0, 0] };
    const rules = { accel: [0, 0, 0] as Vec3, growth: GUNSHOT_EFFECT.dustGrowth, frameDelay: 0, lastFrame: 0 };
    let ticks = 0;
    while (stepParticle(p, rules)) ticks++;
    expect(ticks).toBe(15 + 29);
    expect(p.position[2]).toBeCloseTo(450, 6);
    const puff: ParticleState = { ...p, life: 15, alpha: 1, fade: 1, frame: 0, frameTicks: 0, scale: 1 };
    const puffRules = { accel: [0, 0, 0] as Vec3, growth: 0, frameDelay: Math.trunc(15 / 7), lastFrame: 6 };
    const frames: number[] = [];
    while (stepParticle(puff, puffRules)) frames.push(puff.frame);
    expect(frames.length).toBe(15);
    expect(frames.indexOf(6)).toBe(11);
  });

  it("cone emit: speed in range, within half the cone of the axis", () => {
    const rng = new LevelRng(0x12332153);
    for (let i = 0; i < 200; i++) {
      const v = coneVelocity([1, 0, 0], 0.17453299462795258, 378, 606, rng);
      const s = Math.hypot(...v);
      expect(s).toBeGreaterThanOrEqual(377.99);
      expect(s).toBeLessThanOrEqual(606.01);
      expect(Math.acos(v[0] / s)).toBeLessThanOrEqual(0.0873 + 1e-4);
    }
  });

  it("sprite quad corners rotate in screen space (FUN_004f3c40)", () => {
    expect(particleCorners(2, 1, 0, false)).toEqual([
      [-2, -1],
      [2, -1],
      [-2, 1],
      [2, 1],
    ]);
    const r = particleCorners(2, 1, Math.PI / 2, true);
    expect(r[0][0]).toBeCloseTo(-1, 6);
    expect(r[0][1]).toBeCloseTo(2, 6);
  });
});

describe("tracers (GunShot)", () => {
  const seg = (passed = false, ricocheted = false) => ({ start: [0, 0, 0] as Vec3, end: [0, 0, -10] as Vec3, passed, ricocheted });
  it("one cast in 11, plus every cast after a ricochet or through a face", () => {
    const c = new TracerCounter();
    const drawn: number[] = [];
    for (let i = 0; i < 25; i++) if (c.cast(true, seg(), 4096)) drawn.push(i);
    expect(drawn).toEqual([10, 21]);
    expect(c.cast(true, seg(true), 4096)).toBe(true);
    expect(c.cast(true, seg(false, true), 4096)).toBe(true);
    expect(c.cast(false, seg(true), 4096)).toBe(false);
    expect(TRACER.counterReset).toBe(10);
  });

  it("colour lerps args 6-8 to 9-11 by the distance fraction; alpha floor 0.2, depth fade", () => {
    const ammo = { tracer: true, near: [250, 200, 0] as Vec3, far: [255, 255, 0] as Vec3 };
    const c0 = tracerColour(ammo, 0);
    expect(Math.trunc(c0[0] * 255)).toBe(250);
    expect(Math.trunc(c0[1] * 255)).toBe(200);
    expect(tracerColour(ammo, 1)[1]).toBeCloseTo(1, 6);
    expect(tracerAlpha(0.05, 1000)).toBeCloseTo(0.2, 6);
    expect(tracerAlpha(0.9, 0)).toBeCloseTo(0.9, 6);
    expect(tracerAlpha(1, 2048000)).toBeCloseTo(0.9, 6);
  });
});

describe("effects integration", () => {
  it("a bullet through a concrete wall leaves holes, fragments, tracers; blood on a human hit", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 4 / 3, 0.1, 1000);
    const b = new CollisionWorldBuilder();
    // Wall at z = -5 facing the origin, 4 m square (material 10 = Concrete).
    b.addIndexed([-2, -2, -5, 2, -2, -5, 2, 2, -5, -2, 2, -5], [0, 1, 2, 0, 2, 3], TRI_SOLID | TRI_BULLET | TRI_SIGHT, 10, 0);
    const world = b.build();
    const ctx = {
      scene,
      camera,
      events: new EventBus(),
      world,
      tick: 0,
      rng: new LevelRng(),
      enemies: [],
      level: { surfaceMaterials: [] },
    } as unknown as GameContext;
    const fx = createEffects(ctx);
    const tex = { width: 4, height: 4, rgba: new Uint8ClampedArray(64).fill(200), format: "test" };
    const textures = new Map(["bullethole_concrete.tex", "dent_concrete.tex", "hole_blood1.tex", "hole_blood2.tex"].map((n) => [n, tex] as const));
    const level = {
      instances: [{ taskType: "Building", magicType: null, taskIndex: 5 }],
      objectLight: { sunDirection: [0, 1, 0], front: [1, 1, 1], ambient: [0.3, 0.3, 0.3] },
      textures: new Map(),
    } as never;
    const model = {
      name: "1012_01_1",
      positions: new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: new Float32Array(6),
      indices: new Uint32Array([0, 1, 2]),
      groups: [{ start: 0, count: 3, texture: null, deferred: false, additive: false }],
    };
    const sprite = (frames: number) => ({ version: 9 as const, width: 8, height: 8, format: 3, frames: Array.from({ length: frames }, () => ({ width: 8, height: 8, x: 0, y: 0, advance: 0, format: 3 as const, flags: 0, rgba: new Uint8ClampedArray(256).fill(255) })), tiles: null });
    fx.setLevelResources({
      level,
      textures,
      impactMaterials: MATERIALS,
      assets: {
        sprites: new Map([
          ["concrete1.spr", sprite(1)],
          ["blood1.spr", sprite(7)],
          ["blood2.spr", sprite(1)],
        ]),
        ammo: [{ index: 4, id: "AMMO_ID_919", calibre: 919, tracerNear: [250, 200, 0], tracerFar: [255, 255, 0], tracer: true, model: "" }],
        models: new Map([["1012_01_1", model]]),
        casingModels: new Map(),
        ejectionPoints: new Map(),
      },
    });
    const report: BulletReport = {
      shooter: "player",
      weaponId: "WEAPON_ID_GLOCK",
      calibreId: 919,
      rangeMetres: 60,
      ricocheted: false,
      hits: [front("Concrete", [0, 0, -5], [0, 0, 1], [0, 0, -60], { owner: 0 })],
      segments: [{ start: [0, 0, 0], end: [0, 0, -5], passed: false, ricocheted: false }],
    };
    for (let i = 0; i < 11; i++) fx.bullet(report);
    let s = fx.stats();
    expect(s.holes).toBe(1); // all the same point: duplicates
    expect(s.tracers).toBe(1); // the 11th cast
    fx.update(1 / 30);
    s = fx.stats();
    expect(s.fragments).toBeGreaterThanOrEqual(2); // bursts on the next tick
    // A drawn tracer disappears at the next tick.
    scene.onBeforeRender({ getDrawingBufferSize: (v: THREE.Vector2) => v.set(640, 480) } as never, scene, camera, null as never, null as never, null as never);
    fx.update(1 / 30);
    expect(fx.stats().tracers).toBe(0);
    // Blood: a splat on the wall 3 m behind the human, puff + droplets.
    fx.humanHit({ key: "soldier", point: [0, 0, -3], direction: [0, 0, -1] });
    s = fx.stats();
    expect(s.particles).toBeGreaterThanOrEqual(1 + 5);
    for (let i = 0; i < 60; i++) fx.update(1 / 30);
    expect(fx.stats().fragments).toBe(0); // 45-tick life
    fx.setLevelResources(null);
  });
});

const haveSprites = existsSync(`${RAW_ROOT}/common/sprites/sprites.res`);
describe.skipIf(!haveSprites)("effect sprites (staged)", () => {
  it("concrete1.spr 8x8, blood1.spr 7 frames in sequence, blood2.spr 8x8", async () => {
    const members = readIlffMembers(await readRaw("common/sprites/sprites.res"));
    const get = (n: string) => readUiSprite(members.find((m) => m.name.toLowerCase().endsWith(n))!.payload, n);
    expect([get("concrete1.spr").width, get("concrete1.spr").frames.length]).toEqual([8, 1]);
    expect(spriteSequence(get("blood1.spr"))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(get("blood2.spr").frames[0].width).toBe(8);
  });
});

const haveMaterial = existsSync(`${RAW_ROOT}/material/material.qvm`);
describe.skipIf(!haveMaterial)("material.qvm GunShotEffect records (staged)", () => {
  it("entry A: dust + fragments; entry B: exit holes only", async () => {
    const mats = readImpactMaterials(readQvmCallTree(await readRaw("material/material.qvm")));
    const concrete = mats.find((m) => m.name === "Concrete")!;
    expect([concrete.effects[0].flagA, concrete.effects[0].flagB, concrete.effects[1].flagA, concrete.effects[1].flagB]).toEqual([true, true, false, false]);
    expect(concrete.effects[1].decalTextures).toEqual(["bullethole_concrete.tex", "bullethole_concrete.tex"]);
    expect(concrete.effects[1].size).toBeCloseTo(0.06, 6);
    const glass = mats.find((m) => m.name === "Glass")!;
    expect([glass.effects[0].flagA, glass.effects[0].flagB]).toEqual([false, false]);
    expect(mats.filter((m) => !m.effects[0].decalTextures[0]).map((m) => m.name)).toEqual(["Air", "Water", "Fence", "HumanCollision", "MetalLadder", "MetalFence"]);
  });
});

const haveModels = existsSync(`${RAW_ROOT}/missions/location0/common/models/location0.res`) && haveMaterial;
describe.skipIf(!haveModels)("effect models (staged)", () => {
  it("fragment and casing models load; gun XTVM point 3 is the ejection port", async () => {
    const raw = createFsAssetSource(RAW_ROOT);
    const mats = readImpactMaterials(readQvmCallTree(await readRaw("material/material.qvm")));
    const weapons = new Map([["WEAPON_ID_AK47", {}]]) as never;
    const assets = await loadEffectAssets(raw, { weapons }, mats);
    for (const m of ["1009_01_1", "1011_01_1", "1012_01_1", "1013_01_1", "113_01_1"]) expect(assets.models.has(m)).toBe(true);
    expect(assets.casingModels.get("WEAPON_ID_AK47")).toBe("113_01_1");
    const p = assets.ejectionPoints.get("100_01_1")!;
    expect(p[2]).toBeCloseTo(-767.4 / 4096, 3); // 0.187 m forward of the gun origin
    const ak = readIlffMembers(await readRaw("missions/location0/common/models/location0.res")).find((m) => m.name.endsWith("100_01_1.mef"))!;
    expect(readMefPoints(ak.payload)).toHaveLength(4);
  });
});

const haveAmmo = existsSync(`${RAW_ROOT}/ammo/919/ammo.qvm`);
describe.skipIf(!haveAmmo)("ammo.qvm tracers (staged ammo/)", () => {
  it("9 mm has tracers (250,200,0) -> (255,255,0); 12-gauge none", async () => {
    const t919 = readAmmoTypes(readQvmCallTree(await readRaw("ammo/919/ammo.qvm")))[0];
    expect([t919.calibre, t919.tracer, t919.tracerNear, t919.tracerFar]).toEqual([919, true, [250, 200, 0], [255, 255, 0]]);
    const t12 = readAmmoTypes(readQvmCallTree(await readRaw("ammo/12/ammo.qvm")))[0];
    expect(t12.tracer).toBe(false);
  });
});
