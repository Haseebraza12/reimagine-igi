/**
 * Explosion visuals recovered from igi.exe (docs/damage.md section 3,
 * docs/rendering.md 7.10): FireBall frame / scale / basis, ExplosionSmoke
 * particles and their level-RNG order, GlassShatter (private generator,
 * subdivision, update), the particle blend flags, the scorch decal, and the
 * fx/explosion.ts integration. Real-data checks skip when the staged files
 * are missing.
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import type { Vec3 } from "../src/contracts";
import { LEVEL1_PATHS, loadIgiLevel, type IgiLevel } from "../src/loaders";
import { loadDamageModelData, type DamageModelData } from "../src/loaders/damage-data";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { x87Div, x87Mul, x87StoreF32 } from "../src/loaders/x87";
import { LevelRng } from "../src/engine/ai/rng";
import type { GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import * as R from "../src/engine/combat/explosion-rules";
import { DAMAGE_EVENTS, createDamageSystem, damageModelNames, type ExplosionFxSink } from "../src/engine/combat/object-damage";
import { rotX, rotZYX, type Mat3 } from "../src/engine/fx/bullet-effects";
import { createEffects } from "../src/engine/fx/effects";
import { createExplosionFx, hitFaceNormal, paneFaces } from "../src/engine/fx/explosion";
import {
  GLASS_SHATTER,
  SHARD_COLOUR_BYTE,
  glassRngDraws,
  glassRotationTable,
  resetGlassShatterState,
  shardAlphaByte,
  shatterByBullet,
  shatterByExplosion,
  stepGlassShatter,
  type PaneFaces,
} from "../src/engine/fx/glass-shatter";
import { createParticleManager, particleBlend } from "../src/engine/fx/particles";
import { CollisionWorldBuilder, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } from "../src/engine/world/collision";
import { RAW_ROOT } from "./helpers";

const col = (m: Mat3, j: number): Vec3 => [m[j], m[3 + j], m[6 + j]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("FireBall (FUN_0047ea50 / LAB_0047eb00)", () => {
  it("picks frame trunc((life - left) / period x 26) mod 26 in chop mode", () => {
    expect(R.fireballFrame(75, 75, 75, 26)).toBe(0);
    expect(R.fireballFrame(75, 1, 75, 26)).toBe(25);
    expect(R.fireballFrame(75, 0, 75, 26)).toBe(0); // the update that deletes it
    // 2 / 52 x 26 is 1 exactly, but the chopped quotient makes it 0.99999...: frame 0.
    expect(x87Mul(x87Div(2, 52), 26)).toBeLessThan(1);
    expect(R.fireballFrame(52, 50, 52, 26)).toBe(0);
    expect(R.fireballFrame(52, 26, 52, 26)).toBe(13);
    expect(R.fireballFrame(75, 75, 75, 0)).toBe(-1);
  });

  it("draws life frames (and one more, frame -1, for a delayed one)", () => {
    const run = (life: number, delay: number) => {
      const f = { left: life, delay, frame: -1 };
      const drawn: number[] = [];
      for (let tick = 0; tick < 200; tick++) {
        // FUN_0047ea50
        let alive = true;
        if (f.delay > 0) f.delay--;
        else {
          f.frame = R.fireballFrame(life, f.left, life, 26);
          if (f.left !== 0) f.left--;
          else alive = false;
        }
        if (!alive) break;
        if (f.delay <= 0) drawn.push(f.frame); // LAB_0047eb00 draws once the delay is 0
      }
      return drawn;
    };
    const main = run(75, 0);
    expect(main).toHaveLength(75);
    expect(main[0]).toBe(0);
    expect(main[74]).toBe(25);
    const extra = run(40, 30);
    expect(extra).toHaveLength(41);
    expect(extra[0]).toBe(-1);
    expect(extra[1]).toBe(0);
  });

  it("scales x, y by size / 2048 and grows the camera axis from 0.01", () => {
    const [x, y, z] = R.fireballScale(6144, 74, 75);
    expect(x).toBe(3);
    expect(y).toBe(3);
    expect(z).toBeCloseTo(3 / 75 + 0.01, 6);
    expect(R.fireballScale(6144, 75, 75)[2]).toBeCloseTo(0.01, 7);
    expect(R.fireballScale(6144, 0, 75)[2]).toBeCloseTo(3.01, 5);
  });

  it("turns the dome's z axis to the camera with x horizontal (a proper rotation)", () => {
    for (const d of [[1, 2, 3], [-5, 0.5, -1], [0, 1, 0], [3, -4, 0.1]] as Vec3[]) {
      const m = R.fireballBasis(d);
      const len = Math.hypot(...d);
      const c = col(m, 2);
      for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(d[k] / len, 5);
      expect(col(m, 0)[2]).toBe(0);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(dot(col(m, i), col(m, j))).toBeCloseTo(i === j ? 1 : 0, 5);
      const det = new THREE.Matrix3().set(...(m as [number, number, number, number, number, number, number, number, number])).determinant();
      expect(det).toBeCloseTo(1, 5);
    }
    expect(R.fireballBasis([0, 0, 5])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe("ExplosionSmoke particles (FUN_0047e790 -> FUN_0047ce40)", () => {
  it("emits the glow on the first update with four draws: fade, alpha, angle, spin", () => {
    const rng = new LevelRng();
    const p = R.smokeGlow(rng, 150, 7372.8);
    expect(rng.draws).toBe(4);
    const r = new LevelRng();
    const fade = Math.trunc((r.float() * Math.fround(0.2) + Math.fround(0.8)) * 150);
    const alpha = Math.fround((r.float() + 1) * Math.fround(0.1));
    const angle = r.float() * Math.fround(Math.PI * 2);
    const spin = (0.5 - r.float()) * Math.fround(0.018849557265639305);
    expect(p).toMatchObject({ flags: 0x1000008, halfSize: 7372.8, life: 15, fadeTicks: fade });
    expect(p.alpha).toBeCloseTo(alpha, 6);
    expect(p.angle).toBeCloseTo(angle, 5);
    expect(p.spin).toBeCloseTo(spin, 7);
    expect(p.growth).toBe(x87StoreF32(1 / 150)); // chopped store: 0.0066666663
  });

  it("adds the shade at trunc(0.9 T) (chop: 134 for T = 150) and fades it as a triangle peaking at T / 2", () => {
    expect(R.smokeShadeTick(150)).toBe(134);
    const rng = new LevelRng();
    const p = R.smokeShade(rng, 150, 100);
    expect(rng.draws).toBe(2);
    expect(p).toMatchObject({ flags: 0x1000010, life: 150, fadeTicks: 0, alpha: Math.fround(0.001) });
    expect(R.smokeShadeAlpha(75, 150)).toBe(Math.fround(0.3));
    expect(R.smokeShadeAlpha(134, 150)).toBeCloseTo(0.3 * (1 - 59 / 60), 5);
    expect(R.smokeShadeAlpha(1, 150)).toBeCloseTo(0.3 / 75, 6);
    expect(R.smokeShadeAlpha(100, 150)).toBeGreaterThan(R.smokeShadeAlpha(120, 150));
  });

  it("FlashBang: three particles, three draws each", () => {
    const rng = new LevelRng();
    const puff = R.flashbangPuff(rng);
    expect(rng.draws).toBe(9);
    expect(puff).toHaveLength(3);
    for (const q of puff) {
      expect(q.speed).toBeGreaterThanOrEqual(56.8);
      expect(q.speed).toBeLessThan(113.8);
      expect(q.alpha).toBeGreaterThanOrEqual(0.25);
      expect(q.alpha).toBeLessThan(0.5);
    }
  });
});

describe("TL particle blend flags (FUN_00504300)", () => {
  it("maps 0x8 / 0x10 / 0x80000000 and gives each its own batch", () => {
    expect(particleBlend(0x1040008)).toBe("add");
    expect(particleBlend(0x1040010)).toBe("invsrc");
    expect(particleBlend(0x80000000)).toBe("srccolor");
    expect(particleBlend(0x1080000)).toBe("alpha");
    const sprite = { version: 9 as const, width: 8, height: 8, format: 3, frames: [{ width: 8, height: 8, x: 0, y: 0, advance: 0, format: 3 as const, flags: 0, rgba: new Uint8ClampedArray(256).fill(255) }], tiles: null };
    const pm = createParticleManager(new Map([["smoke2.spr", sprite]]), null);
    const spec = (flags: number) => ({ sprite: "smoke2.spr", accel: [0, 0, 0] as Vec3, colour: 12.7, halfSize: [100, 100] as [number, number], far: 819200, flags, frameDelay: 0, growth: 0, maxParticles: 1 });
    pm.create(spec(0x1040008));
    pm.create(spec(0x1040010));
    const meshes = (pm.object as THREE.Group).children as THREE.Mesh[];
    expect(meshes).toHaveLength(2);
    const mats = meshes.map((m) => m.material as THREE.ShaderMaterial);
    expect([mats[0].blendSrc, mats[0].blendDst]).toEqual([THREE.SrcAlphaFactor, THREE.OneFactor]);
    expect([mats[1].blendSrc, mats[1].blendDst]).toEqual([THREE.ZeroFactor, THREE.OneMinusSrcColorFactor]);
    pm.dispose();
  });
});

/** A two-sided 1 m x 0.6 m pane in the x = 0 plane (as 418_03_1: both windings). */
function pane(halfY = 2015, halfZ = 1216): PaneFaces {
  const positions = new Float32Array([0, halfY, -halfZ, 0, -halfY, -halfZ, 0, -halfY, halfZ, 0, halfY, halfZ]);
  // (0, 1, 2), (0, 2, 3): (b - a) x (c - a) along +x; then the reversed pair.
  return { positions, indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]) };
}
const ID: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("GlassShatter (FUN_00448b70, FUN_00449010, FUN_0044abb0, FUN_004494b0, LAB_00448c90)", () => {
  it("draws its 30-entry rotation table from the private generator at registration", () => {
    resetGlassShatterState();
    const table = glassRotationTable();
    expect(glassRngDraws()).toBe(90);
    expect(table).toHaveLength(30);
    expect(table[0].map((v) => v + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const r = new LevelRng(0); // FUN_004aaa00 state
    for (let k = 0; k < 3; k++) {
      const a1 = Math.fround(r.float() * 40 - 20);
      const a2 = Math.fround(r.float() * 40 - 20);
      const a3 = r.float() * 40 - 20;
      if (k !== 2) continue;
      const k9 = Math.fround(0.0011111111380159855);
      const want = rotZYX(2 * a1 * k9, 2 * a2 * k9, a3 * 2 * k9);
      for (let i = 0; i < 9; i++) expect(table[2][i]).toBeCloseTo(want[i], 5);
    }
  });

  it("cuts only the faces whose (b - a) x (c - a) runs along the push, finer near the impact", () => {
    resetGlassShatterState();
    const faces = pane();
    const st = shatterByBullet(faces, ID, [1, 0, 0], [0, 0, 0], [1, 0, 0]);
    expect(st.shards.length).toBeGreaterThan(10);
    expect(st.left).toBe(30);
    for (const s of st.shards) {
      const [a, b, c] = s.vertices;
      const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1])];
      expect(n[0]).toBeGreaterThan(0); // the +x faces only
      for (const v of s.vertices) {
        expect(Math.abs(v[1])).toBeLessThanOrEqual(2015.01);
        expect(Math.abs(v[2])).toBeLessThanOrEqual(1216.01);
      }
      expect(s.spin).toBeGreaterThanOrEqual(0);
      expect(s.spin).toBeLessThan(30);
    }
    // Near the impact the shards are small: the edge limit is 409.6 units there.
    const near = st.shards.filter((s) => Math.hypot(...s.centre) < 300);
    for (const s of near) {
      const [a, b] = s.vertices;
      expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeLessThan(1300);
    }
    // Deterministic from start-up; the other push picks the other faces.
    resetGlassShatterState();
    const again = shatterByBullet(faces, ID, [1, 0, 0], [0, 0, 0], [1, 0, 0]);
    expect(again.shards).toEqual(st.shards);
    resetGlassShatterState();
    const back = shatterByBullet(faces, ID, [-1, 0, 0], [0, 0, 0], [1, 0, 0]);
    expect(back.shards.length).toBeGreaterThan(10);
    expect(back.shards.every((s) => {
      const [a, b, c] = s.vertices;
      return (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]) < 0;
    })).toBe(true);
  });

  it("moves shards with gravity along world -z in the pane frame and fades over 30 updates", () => {
    resetGlassShatterState();
    // A pane turned 90 degrees about x: world -z is pane -y.
    const r = rotX(Math.PI / 2) as Mat3;
    const st = shatterByBullet(pane(), r, [1, 0, 0], [0, 0, 0], [1, 0, 0]);
    expect(st.gravity[0]).toBeCloseTo(0, 6);
    expect(st.gravity[1]).toBeCloseTo(GLASS_SHATTER.gravity, 3); // pane +y is world up
    expect(st.gravity[2]).toBeCloseTo(0, 3);
    const v0 = st.shards[0].velocity[1];
    const alphas: number[] = [];
    let updates = 0;
    while (true) {
      const alive = stepGlassShatter(st);
      updates++;
      if (!alive) break;
      alphas.push(st.alpha);
    }
    expect(updates).toBe(30);
    expect(alphas).toHaveLength(29); // the 30th update deletes it before a draw
    expect(alphas[0]).toBeCloseTo(1, 6);
    expect(alphas[28]).toBeCloseTo(2 / 30, 6);
    expect(shardAlphaByte(alphas[0])).toBe(255);
    expect(SHARD_COLOUR_BYTE).toBe(178);
    expect(st.shards[0].velocity[1]).toBeCloseTo(v0 + 30 * st.gravity[1], 1);
  });

  it("explosions cut around the last bullet impact (globals) and push shards out at 409.6", () => {
    const faces = pane();
    resetGlassShatterState();
    const fresh = shatterByExplosion(faces, ID, [-8192, 0, 0]);
    resetGlassShatterState();
    shatterByBullet(faces, ID, [1, 0, 0], [0, 1500, 900], [1, 0, 0]);
    const stale = shatterByExplosion(faces, ID, [-8192, 0, 0]);
    expect(stale.shards.length).toBeGreaterThan(0);
    // The cut follows the remembered impact, not the explosion: the two differ.
    expect(stale.shards.map((s) => s.centre)).not.toEqual(fresh.shards.map((s) => s.centre));
    // Radial speed 409.6 from the centre, plus at most 68.27 units/tick per axis.
    for (const s of stale.shards) {
      const radial = Math.hypot(...s.velocity);
      expect(radial).toBeGreaterThan(409.6 - 3 * 68.3);
      expect(radial).toBeLessThan(409.6 + 3 * 68.3);
    }
  });

  it("stops at 1000 shards", () => {
    resetGlassShatterState();
    const st = shatterByBullet(pane(400000, 400000), ID, [1, 0, 0], [0, 0, 0], [1, 0, 0]);
    expect(st.shards).toHaveLength(1000);
  });

  it("reads the pane's face normal at the hit point", () => {
    expect(hitFaceNormal(pane(), [0, 10, 10]).map(Math.abs)).toEqual([1, 0, 0]);
  });
});

describe("damage system -> explosion fx (smoke draws in Dynamic-list order)", () => {
  const level = {
    originIgi: [0, 0, 0],
    tasks: [],
    instances: [],
    models: new Map(),
    textures: new Map(),
    difficulty: "GD_2",
  } as unknown as IgiLevel;
  const data = { bounds: new Map(), models: new Map(), modelTextures: new Map(), modelArchive: new Map(), explodeMagic: new Map(), warnings: [] } as unknown as DamageModelData;
  const ctx = () =>
    ({
      events: new EventBus(),
      rng: new LevelRng(),
      level,
      scene: new THREE.Scene(),
      player: { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, alive: true, eyeHeight: 1.6 },
      systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: null },
    }) as unknown as GameContext;

  it("creates the glow on the first update and the shade at trunc(0.9 T), rewriting its alpha", () => {
    const c = ctx();
    const sys = createDamageSystem(c, { fx: false });
    sys.attach(level, null, data);
    const calls: Array<{ tick: number; kind: string; v: number }> = [];
    let tick = 0;
    const sink: ExplosionFxSink = {
      explosion: () => calls.push({ tick, kind: "explosion", v: 0 }),
      glassShatter: () => {},
      smoke: (_id, _p, q) => calls.push({ tick, kind: q.flags === R.SMOKE.glowFlags ? "glow" : "shade", v: q.alpha }),
      smokeAlpha: (_id, a) => calls.push({ tick, kind: "alpha", v: a }),
      tick: () => {},
    };
    sys.setFx(sink);
    sys.explode(sys.makeExplosion({ position: [10 * 4096, 0, 0], interval: 0, damage: 0, radius: 8192, falloff: 0, scorch: 0, fragments: 0, fireballs: 1, sound: "", aiRange: null }));
    for (tick = 0; tick < 160; tick++) {
      sys.beginTick();
      sys.endTick();
    }
    expect(calls.filter((x) => x.kind === "explosion").map((x) => x.tick)).toEqual([0]);
    expect(calls.filter((x) => x.kind === "glow").map((x) => x.tick)).toEqual([0]);
    // T = 150: left 150 on tick 0, 134 on tick 16.
    expect(calls.filter((x) => x.kind === "shade").map((x) => x.tick)).toEqual([16]);
    const alphas = calls.filter((x) => x.kind === "alpha");
    expect(alphas[0].tick).toBe(16);
    expect(alphas.at(-1)!.tick).toBe(149);
    expect(Math.max(...alphas.map((x) => x.v))).toBe(Math.fround(0.3));
  });

  it("updates smokes of earlier ticks before this tick's Explosion0s", () => {
    const c = ctx();
    const sys = createDamageSystem(c, { fx: false });
    sys.attach(level, null, data);
    const shades: number[] = [];
    sys.setFx({ explosion: () => {}, glassShatter: () => {}, smoke: (_i, _p, q) => q.flags === R.SMOKE.shadeFlags && shades.push(q.angle), tick: () => {} });
    const make = () => sys.makeExplosion({ position: [0, 0, 0], interval: 0, damage: 0, radius: 8192, falloff: 0, scorch: 0, fragments: 0, fireballs: 1, sound: "", aiRange: null });
    sys.explode(make());
    for (let t = 0; t < 16; t++) {
      sys.beginTick();
      sys.endTick();
    }
    // Tick 16: a second explosion is queued; the first smoke's shade (2 draws) comes first.
    const spec = make();
    sys.explode(spec);
    const before = c.rng.draws;
    const replay = new LevelRng();
    for (let k = 0; k < before; k++) replay.step();
    sys.beginTick();
    sys.endTick();
    expect(shades).toHaveLength(1);
    expect(shades[0]).toBeCloseTo(replay.float() * R.SMOKE.angleScale, 5);
  });
});

describe("scorch decal (game:scorch -> the hit object's bullet-hole list)", () => {
  const setup = (terrain: boolean) => {
    const scene = new THREE.Scene();
    const b = new CollisionWorldBuilder();
    // A 10 m floor at y = 0 (object 0, or the terrain).
    b.addIndexed([-5, 0, -5, -5, 0, 5, 5, 0, 5, 5, 0, -5], [0, 1, 2, 0, 2, 3], TRI_SOLID | TRI_BULLET | TRI_SIGHT | (terrain ? TRI_TERRAIN : 0), 10, terrain ? -1 : 0);
    const world = b.build();
    const ctx = { scene, camera: new THREE.PerspectiveCamera(), events: new EventBus(), world, tick: 0, rng: new LevelRng(), enemies: [], level: { surfaceMaterials: [] } } as unknown as GameContext;
    const fx = createEffects(ctx);
    const tex = { width: 4, height: 4, rgba: new Uint8ClampedArray(64).fill(200), format: "test" };
    fx.setLevelResources({ level: { instances: [{ taskType: "Building", magicType: null }], textures: new Map() } as never, textures: new Map([["burn1.tex", tex]]), impactMaterials: [] });
    return { ctx, fx };
  };

  it("places burn1.tex with the scorch half-size on an object, nothing on the terrain", () => {
    const o = setup(false);
    o.ctx.events.emit(DAMAGE_EVENTS.Scorch, { point: [0, 0, 0], sizeM: R.EXPLOSION_SCORCH / 4096, texture: "burn1" });
    expect(o.fx.stats().holes).toBe(1);
    expect(o.fx.stats().drawnHoles).toBe(1);
    // A second one within 1.5 x 1.5 m: duplicate, dropped.
    o.ctx.events.emit(DAMAGE_EVENTS.Scorch, { point: [1, 0, 0], sizeM: 1.5, texture: "burn1" });
    expect(o.fx.stats().holes).toBe(1);
    const t = setup(true);
    t.ctx.events.emit(DAMAGE_EVENTS.Scorch, { point: [0, 0, 0], sizeM: 1.5, texture: "burn1" });
    expect(t.fx.stats().holes).toBe(0);
  });
});

const haveLevel = existsSync(`${RAW_ROOT}/${LEVEL1_PATHS.objects}`);

describe.skipIf(!haveLevel)("explosion fx on level 1", () => {
  let level: IgiLevel;
  let data: DamageModelData;
  beforeAll(async () => {
    const raw = createFsAssetSource(RAW_ROOT);
    level = await loadIgiLevel(raw);
    const names = damageModelNames(level);
    data = await loadDamageModelData(raw, names.bounds, names.build, (key) => level.textures.has(key));
  }, 240_000);

  it("reads the panes' two-sided set 0 in file order", () => {
    const faces = paneFaces(level.models.get("418_03_1") ?? null)!;
    expect(faces.indices.length / 3).toBe(4);
    const normals: number[] = [];
    for (let t = 0; t < 12; t += 3) {
      const p = faces.positions;
      const [a, b, c] = [faces.indices[t] * 3, faces.indices[t + 1] * 3, faces.indices[t + 2] * 3];
      normals.push(Math.sign((p[b + 1] - p[a + 1]) * (p[c + 2] - p[a + 2]) - (p[b + 2] - p[a + 2]) * (p[c + 1] - p[a + 1])));
    }
    expect(normals.sort()).toEqual([-1, -1, 1, 1]);
  });

  it("draws fireballs, fragments, smoke and shards with the recovered timing", () => {
    const scene = new THREE.Scene();
    const sprite = { version: 9 as const, width: 8, height: 8, format: 3, frames: [{ width: 8, height: 8, x: 0, y: 0, advance: 0, format: 3 as const, flags: 0, rgba: new Uint8ClampedArray(256).fill(255) }], tiles: null };
    const particles = createParticleManager(new Map([["smoke2.spr", sprite]]), null);
    const ctx = { scene, events: new EventBus(), rng: new LevelRng(), level, systems: { effects: { particles } } } as unknown as GameContext;
    const fx = createExplosionFx(ctx, level, data);
    const rng = new LevelRng();
    const centre: [number, number, number] = [level.originIgi[0] + 4096 * 10, level.originIgi[1], level.originIgi[2] + 4096];
    const spec = R.makeExplosion(rng, { position: centre, interval: 0, damage: 3, radius: 8192, falloff: 5 * 4096, scorch: 6144, fragments: 5, fireballs: 2, sound: "", aiRange: null });
    const fireballs = R.fireballPlan(rng, spec.radius, 2);
    fx.explosion(spec, { fireballs, smoke: R.smokePlan(spec.radius, 2), fragments: R.fragmentPlan(rng, spec) });
    fx.smoke!(1, centre, R.smokeGlow(rng, 224, 7372.8));
    fx.tick();
    let s = fx.stats();
    expect(s.fireballs).toBe(2);
    expect(s.visibleFireballs).toBe(fireballs[1].delay > 0 ? 1 : 2);
    expect(s.fragments).toBe(5);
    expect(s.smokeSystems).toBe(1);
    // The dome's z axis (engine y of the model) points at the camera.
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    camera.updateMatrixWorld();
    scene.onBeforeRender(null as never, scene, camera, null as never, null as never, null as never);
    const mesh = fx.group.children.find((o) => o.name === "fireball" && o.visible) as THREE.Mesh;
    const axis = new THREE.Vector3().setFromMatrixColumn(mesh.matrix, 1).normalize();
    const pos = new THREE.Vector3().setFromMatrixPosition(mesh.matrix);
    const toCam = camera.position.clone().sub(pos).normalize();
    expect(axis.dot(toCam)).toBeCloseTo(1, 4);
    // 75 drawn frames for the main fireball; fragments live 45 ticks (+1).
    for (let t = 1; t < 46; t++) fx.tick();
    expect(fx.stats().fragments).toBe(0);
    for (let t = 46; t < 75; t++) fx.tick();
    expect(fx.stats().fireballs).toBeGreaterThanOrEqual(1);
    for (let t = 75; t < 200; t++) fx.tick();
    expect(fx.stats().fireballs).toBe(0);
    // A pane shot through its middle: shards for 29 drawn updates.
    const i = level.instances.findIndex((x) => x.model === "418_03_1");
    const model = level.models.get("418_03_1")!;
    const m = new THREE.Matrix4().fromArray(level.instances[i].matrix);
    const hit = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
    const n = new THREE.Vector3(1, 0, 0).transformDirection(m);
    resetGlassShatterState();
    fx.glassShatter(i, model, level.instances[i].matrix, [-n.x * 0.01, -n.y * 0.01, -n.z * 0.01], false, [hit.x, hit.y, hit.z]);
    s = fx.stats();
    expect(s.shatters).toBe(1);
    expect(s.shards).toBeGreaterThan(5);
    for (let t = 0; t < 29; t++) fx.tick();
    expect(fx.stats().shatters).toBe(1);
    fx.tick();
    expect(fx.stats().shatters).toBe(0);
    fx.dispose();
    particles.dispose();
  });
});
