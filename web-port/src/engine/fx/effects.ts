/**
 * Gun and bullet-impact effects, from the recovered igi.exe rules
 * (docs/rendering.md section 7; rules in bullet-effects.ts):
 *
 *   - bullet(report): what one bullet leaves (FUN_00479e30): tracers for the
 *     casts that qualify (tracers.ts), then for each recorded impact (front
 *     faces with an entry-A texture, back faces = exits; at most 10) the
 *     material's GunShotEffect (FUN_004376c0): fragments of the impact model
 *     (debris.ts), a bullet hole on objects that accept them (decals.ts) and
 *     dust puffs (particles.ts), in the level-RNG order of the exe;
 *   - humanHit(hit): blood (FUN_00462710): a splat on the wall up to 3 m
 *     behind, the blood1.spr puff and blood2.spr droplets whose hits leave
 *     hole_blood3/4 (particles.ts);
 *   - ejectCasing(...): the player's shell casing (debris.ts casings), drawn
 *     with the first-person gun (casingLayer);
 *   - muzzle flashes: the gun's GUNFLAME model (muzzle-flash.ts);
 *   - blob shadows: createBlobShadow() (blob-shadow.ts);
 *   - scorch decals: game:scorch places burn1.tex through the hit object's
 *     bullet-hole list (FUN_0047f410 0x47f51f; terrain gets none);
 *   - `particles` / `particleRng`: the shared particle manager and generator
 *     for fx/explosion.ts (explosion smoke) and fx/smoke-emitter.ts.
 * Legacy entries kept for callers not yet sending reports: GameEvent.Impact
 * places entry A's last-impact texture (ignored once bullet() has been
 * called), impact(point) finds the surface from the camera, tracer() is a
 * no-op.
 * Textures and tables arrive with the level (setLevelResources, called by
 * engine/level.ts).
 */
import * as THREE from "three";
import type { DecodedTexture, Vec3 } from "../../contracts";
import type { AmmoType, IgiLevel, ImpactMaterial } from "../../loaders";
import { LevelRng } from "../ai/rng";
import type { GameContext } from "../context";
import { GameEvent, type ImpactPayload } from "../events";
import { sharedFogUniforms, type FogUniforms } from "../render/fog";
import { addSceneHook } from "../render/scene-hooks";
import { TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN, type RayHit } from "../world/collision";
import { DESTRUCTIBLE_BODY_ID } from "../world/world-builder";
import { DAMAGE_EVENTS } from "../combat/object-damage";
import { createBlobShadowPool, type BlobShadow } from "./blob-shadow";
import {
  BLOOD,
  GUNSHOT_EFFECT,
  PARTICLE_RNG_SEED,
  UNITS,
  dustPositions,
  gunshotEffectCalls,
  gunshotEffectPlan,
  igiDir,
  igiPoint,
  particleSpin,
  type AmmoTracer,
  type BulletReport,
  type EffectRng,
  type HitSurface,
} from "./bullet-effects";
import { createCasingSystem, createFragmentSystem, type CasingSystem, type FragmentSystem } from "./debris";
import { createDecalSystem, defaultImpactMaterial, type DecalSystem, type DecalTarget } from "./decals";
import type { EffectAssets } from "./effect-assets";
import { createMuzzleFlash, resetMuzzleFlashRng, type MuzzleFlash } from "./muzzle-flash";
import { createParticleManager, type ParticleHit, type ParticleManager, type ParticleSystem } from "./particles";
import { createTracerSystem, type TracerSystem } from "./tracers";
import { ALARM_LIGHT_SPRITE, createAlarmLightRenderer, type AlarmLightQuad, type AlarmLightRenderer } from "./alarm-lights";
import { worldTasksOf } from "../world/world-tasks";

export type { BulletReport, BulletHitReport, BulletSegmentReport } from "./bullet-effects";

export interface EffectResources {
  level: IgiLevel;
  /** Decoded common/textures/textures.res members by file name ("shadow1.tex", "bullethole_concrete.tex", ...). */
  textures: Map<string, DecodedTexture>;
  /** material/material.qvm (readImpactMaterials). */
  impactMaterials: ImpactMaterial[];
  fog?: FogUniforms;
  mipBias?: THREE.IUniform<number>;
  /** fx/effect-assets.ts loadEffectAssets: sprites, ammo types, fragment / casing models, ejection points. */
  assets?: EffectAssets;
  /** config.qsc GOIsBlood (TRUE in the shipped config). */
  blood?: boolean;
}

/** A bullet hit a human (FUN_0045e5b0 -> FUN_00462710). */
export interface HumanHit {
  /** Identity of the human (its blood particle systems persist per human, +0x838 / +0x83c). */
  key: unknown;
  /** Hit point on the body, engine metres. */
  point: Vec3;
  /** Bullet direction (engine, any length). */
  direction: Vec3;
}

export interface Effects {
  /**
   * Per game tick: particles, fragments, casings, tracer ageing. Pass
   * `running = false` while the world is paused (igi.exe does not tick then).
   */
  update(dt: number, running?: boolean): void;
  /**
   * A shot left a muzzle (world space). Draws the shooter's GUNFLAME there with
   * the recovered frame rule. `weaponId` names the gun; when omitted the
   * shooter is inferred (nearest soldier). Shots from the player's eye are
   * ignored: attach createMuzzleFlash(level, weaponId) to the first-person gun.
   */
  muzzleFlash(position: Vec3, direction: Vec3, weaponId?: string): void;
  /** Legacy no-op: tracers come from bullet(). */
  tracer(from: Vec3, to: Vec3): void;
  /** Legacy impact entry; prefer bullet(). */
  impact(point: Vec3, normal?: Vec3, material?: string | null): void;
  /** Everything one traced bullet leaves (FUN_00479e30 tail). */
  bullet(report: BulletReport): void;
  /** Blood for a bullet hit on a human. */
  humanHit(hit: HumanHit): void;
  /**
   * The player's gun fired: eject its WeaponConfig "Casing Model" from the gun
   * model's XTVM point 3. `gunMatrix` = the first-person gun model's world
   * matrix. Returns false when the weapon has no casing.
   */
  ejectCasing(weaponId: string, gunModel: string, gunMatrix: THREE.Matrix4, shooterVelocity?: Vec3): boolean;
  /** Casings, to be added to the first-person gun scene (drawn in the gun layer). */
  readonly casingLayer: THREE.Object3D;
  /** Remove holes, particles, fragments, tracers, casings, flashes (mission restart). Blob shadows stay with their owners. */
  clear(): void;
  /** A blob shadow for one character (see fx/blob-shadow.ts BlobShadow.update). */
  createBlobShadow(): BlobShadow;
  /** Level textures/material tables (engine/level.ts); null releases them. */
  setLevelResources(resources: EffectResources | null): void;
  /** The active profile's blood flag (+0x8, Content Control), read by FUN_00462710 at every hit; null = the level's GOIsBlood. */
  setBlood(enabled: boolean | null): void;
  /** Diagnostics for tests. */
  stats(): { holes: number; drawnHoles: number; holeLists: number; particles: number; fragments: number; tracers: number; casings: number };
  /**
   * The sprite particle systems (Particle2DDynCubeObjTask), shared by every
   * emitter (one collision counter, DAT_0080abc4); null before
   * setLevelResources with assets. fx/explosion.ts creates the explosion
   * smoke here.
   */
  readonly particles: ParticleManager | null;
  /** DAT_0080aba8, the particle generator (FUN_004f4e30 cone draws), seeded once at start-up. */
  readonly particleRng: EffectRng;
}

/** game:scorch payload (combat/object-damage.ts DAMAGE_EVENTS.Scorch); normal / owner / body when the sender has the hit. */
interface ScorchPayload {
  point: Vec3;
  sizeM: number;
  texture?: string;
  normal?: Vec3;
  owner?: number;
  body?: number | null;
}
/** Half-length of the ray that re-finds a scorch's face from its point (m). */
const SCORCH_REFIND_M = 0.05;

/** Same-tick legacy impacts closer than this (m) are one impact. */
const DEDUPE_M = 0.02;
/** A muzzle within this distance (m) of the camera is the player's own shot. */
const PLAYER_MUZZLE_M = 1.0;
/** Soldier muzzle -> shooter search radius (m). */
const SHOOTER_RADIUS_M = 3.0;

/** Classes whose bullet-hole slot is cleared (FUN_0047ca60 callers storing 0) [recovered]. */
const NO_HOLE_TASK_TYPES = new Set(["Wire", "Rotor", "Switch", "ElevatorFloorIndicator", "Gun", "GunFlame", "GunClip", "GunMovingPart"]);
const NO_HOLE_MAGIC_TYPES = new Set(["TASKTYPE_GUNFLAME", "TASKTYPE_GUNCLIP", "TASKTYPE_GUNMOVINGPART", "TASKTYPE_GUN", "TASKTYPE_WIRE", "TASKTYPE_ROTOR", "TASKTYPE_SWITCH"]);

/**
 * Which hole list a surface belongs to, or null when it takes no holes (pure;
 * exported for tests) [recovered]: terrain hits carry no object in the hit
 * record (FUN_004c24c0 0x4c29e9 stores 0 at +0), so FUN_004376c0 sends no
 * hole there; humans and the cleared classes have no handler. One list per
 * placed object: each placed instance (model + its LODs; ATTA sub-models are
 * objects of their own) [inferred granularity].
 */
export function decalTarget(level: Pick<IgiLevel, "instances"> | null, s: HitSurface): DecalTarget | null {
  if (s.human || s.terrain) return null;
  const inst = level && s.owner >= 0 ? level.instances[s.owner] : undefined;
  if (inst && (NO_HOLE_TASK_TYPES.has(inst.taskType) || (inst.magicType !== null && NO_HOLE_MAGIC_TYPES.has(inst.magicType)))) return null;
  // Static destructibles (glass, barrels, ...) share one rebuildable collision body that never moves:
  // their holes stay per object (world/world-builder.ts DESTRUCTIBLE_BODY_ID).
  if (s.body !== null && s.body !== DESTRUCTIBLE_BODY_ID) return { key: `body:${s.body}`, terrain: false, body: s.body };
  return { key: `inst:${s.owner}`, terrain: false, body: null };
}

function rayHitSurface(hit: RayHit): HitSurface {
  return { terrain: hit.terrain, owner: hit.owner, body: hit.triangle < 0 ? -1 - hit.triangle : null, human: false };
}

export function createEffects(ctx: GameContext): Effects {
  const scene: THREE.Scene | null = ctx.scene ?? null;
  let resources: EffectResources | null = null;
  /** The profile's blood flag (setBlood), overriding the level's GOIsBlood when set. */
  let profileBlood: boolean | null = null;
  let decals: DecalSystem | null = null;
  /** Hole lists to delete at a tick (broken panes). */
  const pendingDrops: Array<{ key: string; tick: number }> = [];
  let particles: ParticleManager | null = null;
  let fragments: FragmentSystem | null = null;
  let casings: CasingSystem | null = null;
  let tracers: TracerSystem | null = null;
  /** SCamera alarm lights (fx/alarm-lights.ts); their quads come from the mission system (ctx.systems.tasks). */
  let alarmLights: AlarmLightRenderer | null = null;
  let ammo: AmmoType[] = [];
  let reportsSeen = false;
  const casingLayer = new THREE.Group();
  casingLayer.name = "casing-layer";
  const blobs = createBlobShadowPool();
  scene?.add(blobs.mesh);
  const recent: Array<{ p: Vec3; tick: number }> = [];
  /** DAT_0080aba8: the particle generator, seeded once (FUN_004f3b70). */
  const particleRng = new LevelRng(PARTICLE_RNG_SEED);
  const levelRng = (): EffectRng => ctx.rng;
  /** Blood systems per human (+0x838 puff, +0x83c droplets). */
  const blood = new Map<unknown, { puff: ParticleSystem | null; drops: ParticleSystem | null }>();

  /** World-space flashes per shooter key. */
  const worldFlashes = new Map<string, { flash: MuzzleFlash; holder: THREE.Group }>();
  const flashFailures = new Set<string>();

  if (scene) {
    addSceneHook(scene, (renderer, _scene, camera) => {
      // One render-frame step per world render (FUN_00476000 counts render frames).
      for (const w of worldFlashes.values()) w.flash.update();
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      particles?.draw(camera, size.x, size.y);
      tracers?.draw(camera);
      if (alarmLights) {
        // LAB_00441c50: each lens draws its light with the current camera (every render of the world).
        const tasks = ctx.systems.tasks as unknown as { securityCameraLights?(): AlarmLightQuad[] } | null;
        // The AlarmLight reflectors' glows (FUN_00439f10) share the sprite and the pipeline.
        const glows = worldTasksOf(ctx)?.alarmLightGlows() ?? [];
        const lights = tasks?.securityCameraLights?.() ?? [];
        alarmLights.draw(camera, glows.length > 0 ? [...lights, ...glows] : lights);
      }
      decals?.sync((id) => ctx.world?.bodyMatrix(id) ?? null);
    });
  }

  const ammoTracer = (calibre: number): AmmoTracer | null => {
    const a = ammo.find((t) => t.calibre === calibre);
    return a ? { tracer: a.tracer, near: a.tracerNear, far: a.tracerFar } : null;
  };

  const probe = (from: Vec3, to: Vec3): boolean => {
    const world = ctx.world;
    if (!world) return true;
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return true;
    return world.raycast(from[0], from[1], from[2], dx / len, dy / len, dz / len, len, TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN) !== null;
  };

  /**
   * Objects-only ray (FUN_004c24c0 with filter 0x20000000: the terrain is
   * tested only with bit 0x80000000): terrain hits are stepped over.
   */
  const objectRay = (o: Vec3, d: Vec3, length: number): RayHit | null => {
    const world = ctx.world;
    if (!world) return null;
    let start = 0;
    for (let guard = 0; guard < 8 && start < length; guard++) {
      const hit = world.raycast(o[0] + d[0] * start, o[1] + d[1] * start, o[2] + d[2] * start, d[0], d[1], d[2], length - start, TRI_BULLET);
      if (!hit) return null;
      if (!hit.terrain) return { ...hit, distance: hit.distance + start };
      start += hit.distance + 1e-4;
    }
    return null;
  };

  /** Particle path test (FUN_004c24c0 with filter 0x20000000): positions in IGI units. */
  const castParticle = (from: Vec3, to: Vec3): ParticleHit | null => {
    const a: Vec3 = [from[0] / UNITS, from[2] / UNITS, -from[1] / UNITS];
    const b: Vec3 = [to[0] / UNITS, to[2] / UNITS, -to[1] / UNITS];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return null;
    const hit = objectRay(a, [dx / len, dy / len, dz / len], len);
    if (!hit) return null;
    const n: Vec3 = hit.front ? hit.normal : [-hit.normal[0], -hit.normal[1], -hit.normal[2]];
    return { point: [...hit.point], normal: n, terrain: false, owner: hit.owner, body: hit.triangle < 0 ? -1 - hit.triangle : null };
  };

  const placeHole = (s: HitSurface, point: Vec3, normal: Vec3, texture: string, halfSizeUnits: number) => {
    const target = decalTarget(resources?.level ?? null, s);
    if (!target || !decals) return;
    decals.place(target, point, normal, texture, halfSizeUnits);
  };

  const placeLegacy = (point: Vec3, normal: Vec3, material: string | null): void => {
    if (!decals) return;
    for (const r of recent) {
      if (r.tick === ctx.tick && Math.hypot(r.p[0] - point[0], r.p[1] - point[1], r.p[2] - point[2]) < DEDUPE_M) return;
    }
    recent.push({ p: [point[0], point[1], point[2]], tick: ctx.tick });
    if (recent.length > 16) recent.shift();
    decals.add(point, normal, material ?? defaultImpactMaterial(normal));
  };

  const offImpact = ctx.events.on(GameEvent.Impact, (payload) => {
    if (reportsSeen) return;
    const p = payload as ImpactPayload | undefined;
    if (!p?.point || !p.normal || p.human) return;
    placeLegacy(p.point, p.normal, p.material);
  });
  void offImpact; // lives as long as the bus (cleared by game.stop)
  // A broken pane is deleted at its next update (the tick after the shot) and its hole list with it
  // (holes are kept per object; inferred).
  const offGlass = ctx.events.on(DAMAGE_EVENTS.GlassBreak, (payload) => {
    const instance = (payload as { instance?: number } | undefined)?.instance;
    if (instance !== undefined) pendingDrops.push({ key: `inst:${instance}`, tick: ctx.tick + 1 });
  });
  void offGlass;
  // Scorch (FUN_0047f410 0x47f51f / FlashBang FUN_0047cd10): burn1.tex sent through the hit object's
  // bullet-hole slot (DAT_0053e894), half-size = the scorch size, on the object the 0.5 m downward ray
  // hit (a terrain hit carries no object: no scorch) [recovered]; placed when the explosion is created.
  const offScorch = ctx.events.on(DAMAGE_EVENTS.Scorch, (payload) => {
    const p = payload as ScorchPayload | undefined;
    if (!p?.point || !resources || !decals) return;
    let surface: HitSurface | null = null;
    let normal = p.normal ?? null;
    if (p.owner !== undefined && p.owner >= 0 && normal) {
      surface = { terrain: false, owner: p.owner, body: p.body ?? null, human: false };
    } else {
      // The payload has only the point: re-find its face with a short ray down through it [inferred equivalent].
      const world = ctx.world;
      if (!world) return;
      const hit = world.raycast(p.point[0], p.point[1] + SCORCH_REFIND_M, p.point[2], 0, -1, 0, 2 * SCORCH_REFIND_M, TRI_BULLET);
      if (!hit || hit.terrain) return;
      surface = rayHitSurface(hit);
      normal = hit.front ? hit.normal : [-hit.normal[0], -hit.normal[1], -hit.normal[2]];
    }
    const file = (p.texture ?? "burn1").toLowerCase();
    placeHole(surface, p.point, normal, file.endsWith(".tex") ? file : `${file}.tex`, Math.fround(p.sizeM * UNITS));
  });
  void offScorch;

  function bullet(report: BulletReport): void {
    reportsSeen = true;
    if (!resources) return;
    tracers?.bullet(report, ammoTracer(report.calibreId));
    const calls = gunshotEffectCalls(report.hits, report.ricocheted, resources.impactMaterials);
    for (const call of calls) {
      const plan = gunshotEffectPlan(call, levelRng());
      const hitIgi = igiPoint(call.hit.point);
      if (plan.debris) fragments?.spawn(plan.debris, hitIgi);
      if (plan.decal) placeHole(call.hit, call.hit.point, call.hit.faceNormal, plan.decal.texture, plan.decal.halfSizeUnits);
      if (plan.dust && particles) {
        const sys = particles.create({
          sprite: "concrete1.spr",
          accel: [0, 0, 0],
          colour: GUNSHOT_EFFECT.dustColour,
          halfSize: [GUNSHOT_EFFECT.dustHalfSize, GUNSHOT_EFFECT.dustHalfSize],
          far: GUNSHOT_EFFECT.particleFar,
          flags: GUNSHOT_EFFECT.dustFlags | 0x40000,
          frameDelay: 0,
          growth: GUNSHOT_EFFECT.dustGrowth,
          maxParticles: GUNSHOT_EFFECT.dustMaxParticles,
        });
        if (sys) {
          const [p1, p2] = dustPositions(hitIgi, igiDir(call.hit.faceNormal));
          const d = plan.dust;
          sys.emit(p1, [0, 0, d.speeds[0]], d.alpha, d.spins[0], 0, 1, GUNSHOT_EFFECT.dustLife, GUNSHOT_EFFECT.dustFadeTicks);
          sys.emit(p2, [0, 0, d.speeds[1]], d.alpha, d.spins[1], 0, 1, GUNSHOT_EFFECT.dustLife, GUNSHOT_EFFECT.dustFadeTicks);
        }
      }
    }
  }

  function humanHit(hit: HumanHit): void {
    if (!resources || (profileBlood ?? resources.blood) === false) return;
    const rng = levelRng();
    const d = hit.direction;
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 0)) return;
    const dir: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
    // 1. Splat on an object up to 3 m behind (front face whose material has an entry-A texture; objects only).
    {
      const w = objectRay(hit.point, dir, BLOOD.wallRayUnits / UNITS);
      if (w && w.front) {
        const mats = resources.impactMaterials;
        const name = w.material >= 0 ? (ctx.level?.surfaceMaterials?.[w.material]?.name ?? null) : "Ground";
        const m = mats.find((x) => x.name.toLowerCase() === (name ?? "").toLowerCase());
        if (m && m.effects[0].decalTextures[0]) {
          const size = Math.fround((rng.float() + 1) * BLOOD.wallSize);
          const texture = BLOOD.wallTextures[rng.int(2)];
          placeHole(rayHitSurface(w), w.point, w.normal, texture, size);
        }
      }
    }
    if (!particles) return;
    let sys = blood.get(hit.key);
    if (!sys) blood.set(hit.key, (sys = { puff: null, drops: null }));
    const pointIgi = igiPoint(hit.point);
    // 2. Puff: blood1.spr, frame every trunc(15 / frames) ticks.
    if (!particles.alive(sys.puff)) {
      const frames = resources.assets?.sprites.get("blood1.spr");
      const count = frames?.tiles ? frames.tiles.cells.filter((c) => c > 0).length || 1 : 1;
      sys.puff = particles.create({
        sprite: "blood1.spr",
        accel: [0, 0, 0],
        colour: 127,
        halfSize: [BLOOD.puffHalfSize, BLOOD.puffHalfSize],
        far: GUNSHOT_EFFECT.particleFar,
        flags: BLOOD.puffFlags | 0x40000,
        frameDelay: Math.trunc(15 / count),
        growth: 0,
        maxParticles: BLOOD.puffMaxParticles,
      });
    }
    sys.puff?.emit(pointIgi, [0, 0, 0], 1, 0, 0, 1, BLOOD.puffLife, 0);
    // 3. Droplets: blood2.spr with gravity; their hits leave hole_blood3/4.
    if (!particles.alive(sys.drops)) {
      sys.drops = particles.create({
        sprite: "blood2.spr",
        accel: [0, 0, BLOOD.dropGravity],
        colour: 127,
        halfSize: [BLOOD.dropHalfSize, BLOOD.dropHalfSize],
        far: GUNSHOT_EFFECT.particleFar,
        flags: BLOOD.dropFlags | 0x40000,
        frameDelay: 0,
        growth: 0,
        maxParticles: BLOOD.dropMaxParticles,
        onHit: (h, previous, current) => {
          // FUN_00462cf0: only when (previous - current) . n < 0, n = the face's outward normal [recovered sign].
          const n = igiDir(h.normal);
          const m = (previous[0] - current[0]) * n[0] + (previous[1] - current[1]) * n[1] + (previous[2] - current[2]) * n[2];
          if (!(m < 0)) return;
          const target = decalTarget(resources?.level ?? null, { terrain: h.terrain, owner: h.owner, body: h.body, human: false });
          if (!target) return;
          const size = Math.fround(levelRng().float() * BLOOD.dropDecalRange + BLOOD.dropDecalBase);
          const texture = BLOOD.dropTextures[levelRng().int(2)];
          decals?.place(target, h.point, h.normal, texture, size);
        },
      });
    }
    const dirIgi = igiDir(dir);
    const back: Vec3 = [-dirIgi[0], -dirIgi[1], -dirIgi[2]];
    for (const [axis, spec] of [
      [dirIgi, BLOOD.forward],
      [back, BLOOD.backward],
    ] as const) {
      const n = rng.int(3) + spec.base;
      for (let i = 0; i < n; i++) {
        const spin = particleSpin(rng.float());
        sys.drops?.emitCone(pointIgi, axis, spec.cone, spec.vmin, spec.vmax, particleRng, 1, spin, 0, 1, BLOOD.dropLife, BLOOD.dropFadeTicks);
      }
    }
  }

  function ejectCasing(weaponId: string, gunModel: string, gunMatrix: THREE.Matrix4, shooterVelocity?: Vec3): boolean {
    const assets = resources?.assets;
    if (!assets || !casings) return false;
    const model = assets.casingModels.get(weaponId);
    if (!model) return false;
    const ejection = assets.ejectionPoints.get(gunModel) ?? [0, 0, 0];
    return casings.eject(model, gunMatrix, ejection, levelRng(), shooterVelocity);
  }

  function shooterWeapon(position: Vec3): { key: string; weaponId: string } | null {
    let best: { key: string; weaponId: string; d: number } | null = null;
    for (const e of ctx.enemies) {
      const w = e.weapon?.scriptId;
      if (!w) continue;
      const d = Math.hypot(e.position[0] - position[0], e.position[2] - position[2]);
      if (d < SHOOTER_RADIUS_M && (!best || d < best.d)) best = { key: `enemy:${e.id}`, weaponId: w, d };
    }
    return best;
  }

  function muzzleFlash(position: Vec3, direction: Vec3, weaponId?: string): void {
    const level = resources?.level;
    if (!scene || !level) return;
    const cam = ctx.camera.position;
    if (Math.hypot(position[0] - cam.x, position[1] - cam.y, position[2] - cam.z) < PLAYER_MUZZLE_M) return;
    const shooter = weaponId ? { key: `weapon:${weaponId}`, weaponId } : shooterWeapon(position);
    if (!shooter) return;
    const key = `${shooter.key}|${shooter.weaponId}`;
    let entry = worldFlashes.get(key);
    if (!entry) {
      if (flashFailures.has(key)) return;
      const flash = createMuzzleFlash(level, shooter.weaponId, resources?.mipBias);
      if (!flash) {
        flashFailures.add(key); // no GUNFLAME (MP5SD, Dragunov)
        return;
      }
      const holder = new THREE.Group();
      holder.name = `world-flash:${key}`;
      holder.add(flash.object);
      scene.add(holder);
      entry = { flash, holder };
      worldFlashes.set(key, entry);
    }
    // Gun-local barrel (engine -z) along the shot direction, flame origin at the muzzle.
    const dir = new THREE.Vector3(direction[0], direction[1], direction[2]);
    if (dir.lengthSq() < 1e-12) return;
    dir.normalize();
    entry.holder.position.set(position[0], position[1], position[2]);
    entry.holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    entry.flash.fire();
  }

  function impact(point: Vec3, normal?: Vec3, material?: string | null): void {
    if (reportsSeen) return;
    let n = normal;
    if (!n) {
      // Legacy call without a normal: re-find the surface from the camera.
      const o = ctx.camera.position;
      const d = new THREE.Vector3(point[0] - o.x, point[1] - o.y, point[2] - o.z);
      const len = d.length();
      if (!(len > 1e-4) || !ctx.world) return;
      d.divideScalar(len);
      const hit = ctx.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, len + 0.05, TRI_BULLET);
      // The point must be ON that surface (a hit on a character is not a wall hit).
      if (!hit || Math.abs(hit.distance - len) > 0.05) return;
      n = hit.normal;
    }
    placeLegacy(point, n, material ?? null);
  }

  function clearFlashes(): void {
    for (const w of worldFlashes.values()) {
      w.holder.removeFromParent();
      w.flash.dispose();
    }
    worldFlashes.clear();
    flashFailures.clear();
  }

  function disposeSystems(): void {
    decals?.dispose();
    particles?.dispose();
    fragments?.dispose();
    casings?.dispose();
    tracers?.dispose();
    alarmLights?.dispose();
    alarmLights = null;
    decals = null;
    particles = null;
    fragments = null;
    casings = null;
    tracers = null;
    blood.clear();
  }

  return {
    update(_dt, running = true) {
      if (!running) return;
      for (let i = pendingDrops.length - 1; i >= 0; i--) {
        if (ctx.tick < pendingDrops[i].tick) continue;
        decals?.drop(pendingDrops[i].key);
        pendingDrops.splice(i, 1);
      }
      particles?.tick();
      fragments?.tick(levelRng());
      casings?.tick();
      tracers?.tick();
    },
    muzzleFlash,
    tracer() {
      /* tracers come from bullet() */
    },
    impact,
    bullet,
    humanHit,
    ejectCasing,
    casingLayer,
    clear() {
      decals?.clear();
      particles?.clear();
      fragments?.clear();
      casings?.clear();
      tracers?.clear();
      blood.clear();
      recent.length = 0;
      for (const w of worldFlashes.values()) w.flash.reset();
    },
    createBlobShadow: () => blobs.create(),
    setBlood(enabled) {
      profileBlood = enabled;
    },
    setLevelResources(next) {
      disposeSystems();
      clearFlashes();
      resources = next;
      reportsSeen = false;
      if (!next) {
        ammo = [];
        blobs.setTexture(null, sharedFogUniforms(), { value: 0 });
        return;
      }
      resetMuzzleFlashRng();
      const fog = next.fog ?? sharedFogUniforms();
      const mipBias = next.mipBias ?? { value: 0 };
      decals = createDecalSystem(next.impactMaterials, next.textures, fog, mipBias, {
        probe,
        bodyMatrix: (id) => ctx.world?.bodyMatrix(id) ?? null,
      });
      scene?.add(decals.group);
      const assets = next.assets;
      ammo = assets?.ammo ?? [];
      tracers = createTracerSystem(fog);
      scene?.add(tracers.object);
      if (assets) {
        particles = createParticleManager(assets.sprites, castParticle);
        scene?.add(particles.object);
        const light = assets.sprites.get(ALARM_LIGHT_SPRITE);
        alarmLights = light ? createAlarmLightRenderer(light) : null;
        if (alarmLights) scene?.add(alarmLights.object);
        fragments = createFragmentSystem(assets.models, { level: next.level, fog });
        scene?.add(fragments.object);
        casings = createCasingSystem(assets.models, { level: next.level, fog: null });
        casingLayer.add(casings.object);
      }
      blobs.setTexture(next.textures.get("shadow1.tex") ?? null, fog, mipBias);
    },
    get particles() {
      return particles;
    },
    get particleRng() {
      return particleRng;
    },
    stats() {
      const d = decals?.stats() ?? { lists: 0, holes: 0, drawn: 0 };
      return {
        holes: d.holes,
        drawnHoles: d.drawn,
        holeLists: d.lists,
        particles: particles?.systems.reduce((n, s) => n + s.particles.length, 0) ?? 0,
        fragments: fragments?.count() ?? 0,
        tracers: tracers?.count() ?? 0,
        casings: casings?.count() ?? 0,
      };
    },
  };
}
