/**
 * The Smoke task (TASKTYPE_SMOKE, level 1: the locomotive exhausts, nodes
 * 817 / 867 / 879 under Trains 814 / 846 / 870) [recovered: class
 * FUN_00436790, create LAB_00436e10, init FUN_00437280 + FUN_004374c0,
 * update FUN_00437030, parent-moved handler FUN_00436d50, in-world handlers
 * LAB_00436f20 / LAB_00436f80; docs/rendering.md 7.11]:
 *
 *   - Parameters (21, table DAT_0057f348) -> fields: Position +0x28, Alpha
 *     +0x7c, Gamma +0x80, Number of Particles +0xf8, Radius +0x94, Maximum
 *     Random Angle +0x90, Minimum / Maximum Velocity +0x88 / +0x8c, Colour
 *     +0x104, Life Time +0xfc, Fade Time +0x100, Fade Mode +0x110, Sprite
 *     index +0x118, Particle Size +0x84, Particle Size Delta +0x114, Minimum /
 *     Maximum Rotation Speed +0x120 / +0x11c, Intensity +0x124, Initial
 *     generate factor value +0x98 (double), Generate factor +0xa4
 *     (expression), Move Particles +0x170.
 *   - Create resets the class generator DAT_0057f320 (FUN_004aaa00), so after
 *     the level loads the three smokes share one generator in its initial
 *     state (= LevelRng seed 0).
 *   - Init: emission direction = third column of Rz(Gamma) Rx(Alpha); one
 *     particle system, the Smoke task's child, kept when empty
 *     (FUN_004f51f0(sys, 0)): sprite by index (0 fireball.spr, 1 blood1.spr,
 *     2 smoke2.spr, else smoke1.spr), colour x 63 (1/128 scale), half-size
 *     Particle Size x 4096, growth Size Delta / 30 per tick, far 409600
 *     units, Number of Particles, no acceleration, flags by Fade Mode (0:
 *     0x1080000 alpha blend with the particle alpha, 1: 0x1000008 SRCALPHA /
 *     ONE, 2: 0x1000010 ZERO / INVSRCCOLOR). The offset from the nearest
 *     object ancestor (the Train) is kept in its frame: local = R^T (pos - P).
 *   - Parent moved (message DAT_00545d24): position = R local + P, so the
 *     emitter rides the locomotive; the emission direction stays in world
 *     space.
 *   - Update (only while the task tree updates it: its ConditionalContainers
 *     run): Move Particles shifts every particle by the emitter's motion since
 *     the last update; then the children (its particle system steps); the
 *     Generate factor expression, when compiled, replaces +0x98; acc += factor
 *     (float), and while acc > 30: one particle, acc -= 30 (factor 30 = one
 *     per tick from the second update).
 *   - A particle: class generator r1 angle (x 2 pi), r2 radius (x Radius x
 *     4096), r3 spin; at (x + cos a rad, y + sin a rad, z); FUN_004f4e30 with
 *     the particle generator DAT_0080aba8 (tilt, azimuth, speed): cone =
 *     Maximum Random Angle, speed from Maximum x 136 to Minimum x 136
 *     units/tick, alpha = Intensity, spin ((Max - Min) r3 + Min) / 30 rad per
 *     tick, life trunc(Life Time x 30), then fade over trunc(Fade Time x 30 /
 *     Intensity) ticks.
 *   - Out of the world (a ConditionalContainer removed it): not drawn.
 * Draw: the shared particle path (fx/particles.ts; no fog).
 */
import type { Vec3 } from "../../contracts";
import type { IgiTask, MissionRuntime, TaskPose } from "../../loaders";
import { x87Add, x87Div, x87F32Mul, x87Fistp, x87Mul, x87StoreF32, x87Sub } from "../../loaders/x87";
import { LevelRng } from "../ai/rng";
import { coneVelocity, mulMat3, rotX, rotZ, type EffectRng, type Mat3 } from "./bullet-effects";
import type { ParticleManager, ParticleSystem } from "./particles";

/** Constants of the Smoke class [recovered addresses in the header]. */
export const SMOKE_TASK = {
  /** Emission accumulator threshold and step (f32 0x5313bc). */
  generateStep: 30,
  /** Radius / particle size -> units (f32 0x5313b8). */
  unitsPerMetre: 4096,
  /** Velocity m/s -> units/tick (f32 0x5317e8: 136, not 4096 / 30). */
  velocityScale: 136,
  /** Colour x 63 (f32 0x5317ec) in the 1/128 scale. */
  colourScale: 63,
  /** Far draw limit 409600 units (0x48c80000). */
  far: 409600,
  /** Seconds -> ticks (x 30) and per-tick (x 1/30, f32 0x531680). */
  ticksPerSecond: 30,
  perTick: Math.fround(0.03333333507180214),
  angleScale: Math.fround(6.2831854820251465),
  /** TL flags per Fade Mode. */
  fadeModeFlags: [0x1080000, 0x1000008, 0x1000010] as const,
  /** Sprite index -> sprite (DAT_0057f300, 0x57f37c, 0x57f380, 0x57f384). */
  sprites: ["fireball.spr", "blood1.spr", "smoke2.spr", "smoke1.spr"] as const,
} as const;

/** One Smoke task's parameters as the exe stores them (float32). */
export interface SmokeParams {
  position: Vec3;
  alpha: number;
  gamma: number;
  count: number;
  radius: number;
  maxAngle: number;
  minVelocity: number;
  maxVelocity: number;
  colour: Vec3;
  lifeTime: number;
  fadeTime: number;
  fadeMode: number;
  sprite: number;
  size: number;
  sizeDelta: number;
  minRotation: number;
  maxRotation: number;
  intensity: number;
  generate: number;
  /** "Generate factor" expression text ("" = none). */
  generateExpression: string;
  moveParticles: boolean;
}

const f32 = Math.fround;
const num = (t: IgiTask, k: string, d: number): number => {
  const v = t.params[k];
  return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : d;
};
const vec = (t: IgiTask, k: string, d: Vec3): Vec3 => {
  const v = t.params[k];
  return Array.isArray(v) && v.length === 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : d;
};

/** The task's parameters with the create defaults (LAB_00436e10) for missing ones. */
export function smokeParams(t: IgiTask): SmokeParams {
  const g = t.params["Generate factor"];
  return {
    position: vec(t, "Position", [0, 0, 0]),
    alpha: f32(num(t, "Alpha", 0)),
    gamma: f32(num(t, "Gamma", 0)),
    count: Math.trunc(num(t, "Number of Particles", 100)),
    radius: f32(num(t, "Radius", 0)),
    maxAngle: f32(num(t, "Maximum Random Angle", 0.7853981852531433)),
    minVelocity: f32(num(t, "Minimum Velocity", 4.5)),
    maxVelocity: f32(num(t, "Maximum Velocity", 6)),
    colour: vec(t, "Colour", [2, 2, 2]).map(f32) as Vec3,
    lifeTime: f32(num(t, "Life Time", 0.5)),
    fadeTime: f32(num(t, "Fade Time", 1)),
    fadeMode: Math.trunc(num(t, "Fade Mode", 0)),
    sprite: Math.trunc(num(t, "Sprite index", 3)),
    size: f32(num(t, "Particle Size", 0.5)),
    sizeDelta: f32(num(t, "Particle Size Delta", 2.6666667461395264)),
    minRotation: f32(num(t, "Minimum Rotation Speed", 0)),
    maxRotation: f32(num(t, "Maximum Rotation Speed", 0)),
    intensity: f32(num(t, "Intensity", 1)),
    generate: num(t, "Initial generate factor value", 30),
    generateExpression: typeof g === "string" ? g : "",
    moveParticles: num(t, "Move Particles", 0) !== 0,
  };
}

/** Init (FUN_00437280): the emission direction, third column of Rz(Gamma) Rx(Alpha). */
export function smokeDirection(alpha: number, gamma: number): Vec3 {
  const m = mulMat3(rotZ(gamma), rotX(alpha));
  return [f32(m[2]), f32(m[5]), f32(m[8])];
}

/** One particle of FUN_00437030's loop: class-generator draws (angle, radius, spin) then FUN_004f4e30's three. */
export interface SmokeParticleLaunch {
  position: Vec3;
  velocity: Vec3;
  spin: number;
  alpha: number;
  life: number;
  fadeTicks: number;
}

export function smokeLaunch(p: SmokeParams, at: Vec3, dir: Vec3, smokeRng: EffectRng, particleRng: EffectRng): SmokeParticleLaunch {
  const S = SMOKE_TASK;
  const a = x87StoreF32(x87Mul(smokeRng.float(), S.angleScale));
  const rad = x87StoreF32(x87Mul(x87Mul(smokeRng.float(), p.radius), S.unitsPerMetre));
  const r3 = smokeRng.float();
  const position: Vec3 = [x87Add(Math.cos(a) * rad, at[0]), x87Add(Math.sin(a) * rad, at[1]), at[2]];
  const spin = x87StoreF32(x87Mul(x87Add(x87Mul(p.maxRotation - p.minRotation, r3), p.minRotation), S.perTick));
  const life = x87Fistp(x87Mul(p.lifeTime, S.ticksPerSecond));
  const fadeTicks = x87Fistp(x87Div(x87Mul(p.fadeTime, S.ticksPerSecond), p.intensity));
  const velocity = coneVelocity(dir, p.maxAngle, x87F32Mul(p.maxVelocity, S.velocityScale), x87F32Mul(p.minVelocity, S.velocityScale), particleRng);
  return { position, velocity, spin, alpha: p.intensity, life, fadeTicks };
}

/** The particle system FUN_00437280 creates (fx/particles.ts spec). */
export function smokeSystemSpec(p: SmokeParams) {
  const S = SMOKE_TASK;
  const flags = S.fadeModeFlags[p.fadeMode] ?? 0;
  const c = p.colour.map((v) => x87F32Mul(v, S.colourScale));
  return {
    sprite: S.sprites[p.sprite] ?? "smoke1.spr",
    accel: [0, 0, 0] as Vec3,
    // particles.ts takes one grey value in the 1/128 scale (level 1: (2, 2, 2) x 63 = 126).
    colour: c[0],
    halfSize: [x87F32Mul(p.size, S.unitsPerMetre), x87F32Mul(p.size, S.unitsPerMetre)] as [number, number],
    far: S.far,
    flags: flags | 0x40000,
    frameDelay: 0,
    growth: x87F32Mul(p.sizeDelta, S.perTick),
    maxParticles: p.count,
    owned: true,
  };
}

/** One Smoke task. */
export interface SmokeEmitter {
  node: number;
  params: SmokeParams;
  /** Nearest Train ancestor (the parent object), or -1. */
  parent: number;
  /** ConditionalContainer ancestors (the tree updates the task only while they run). */
  containers: number[];
  /** Offset in the parent's frame (+0x130), IGI units. */
  local: Vec3;
  /** Current position (+0x40) and the one of the last update (+0x58). */
  position: Vec3;
  previous: Vec3;
  updated: boolean;
  direction: Vec3;
  /** +0x98 (double) and the emission accumulator +0xa0 (float). */
  factor: number;
  acc: number;
  system: ParticleSystem | null;
}

export interface SmokeEmitterHost {
  runtime(): MissionRuntime | null;
  /** Current IGI pose of a Train node's locomotive (its Train object), or null. */
  trainPose(trainNode: number): TaskPose | null;
  particles(): ParticleManager | null;
  particleRng(): EffectRng | null;
  /** Level origin (IGI units): particle positions are relative to it. */
  originIgi(): readonly number[];
}

export interface SmokeEmitters {
  readonly emitters: readonly SmokeEmitter[];
  /** DAT_0057f320 (reset by every Smoke create). */
  readonly rng: LevelRng;
  /** Build the emitters of the current runtime (done automatically when the runtime changes). */
  reset(): void;
  /** One game tick, after the mission runtime ticked (the trains have moved). */
  tick(): void;
  dispose(): void;
}

/** R^T v for a row-major world = R local rotation. */
const tmul = (m: Mat3, v: readonly number[]): Vec3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];

export function createSmokeEmitters(host: SmokeEmitterHost): SmokeEmitters {
  let emitters: SmokeEmitter[] = [];
  let runtime: MissionRuntime | null = null;
  let manager: ParticleManager | null = null;
  const rng = new LevelRng(0);
  /** isRun of each watched container after the last tick (its update's "previous"). */
  const lastRun = new Map<number, number>();

  const removeSystems = () => {
    for (const e of emitters) if (e.system && manager) manager.remove(e.system);
  };

  function build(): void {
    removeSystems();
    emitters = [];
    lastRun.clear();
    runtime = host.runtime();
    manager = host.particles();
    // Every Smoke create resets the class generator: after loading it is in its initial state.
    rng.seed(0);
    if (!runtime) return;
    const nodes = runtime.tasks.nodes;
    for (const n of nodes) {
      if (n.type !== "Smoke") continue;
      const params = smokeParams(n.task);
      let parent = -1;
      const containers: number[] = [];
      for (let a = n.parent; a >= 0; a = nodes[a].parent) {
        if (parent < 0 && (nodes[a].type === "Train" || nodes[a].type === "Heli" || nodes[a].type === "Car" || nodes[a].type === "Plane")) parent = a;
        if (nodes[a].type === "ConditionalContainer") containers.push(a);
      }
      // FUN_004374c0: the offset in the parent's frame at load.
      const pose = parent >= 0 ? host.trainPose(parent) : null;
      const local: Vec3 = pose
        ? tmul(pose.matrix, [params.position[0] - pose.position[0], params.position[1] - pose.position[1], params.position[2] - pose.position[2]])
        : [0, 0, 0];
      const system = manager?.create(smokeSystemSpec(params)) ?? null;
      emitters.push({
        node: n.index,
        params,
        parent,
        containers,
        local,
        position: [...params.position],
        previous: [...params.position],
        updated: false,
        direction: smokeDirection(params.alpha, params.gamma),
        factor: params.generate,
        acc: 0,
        system,
      });
      for (const c of containers) lastRun.set(c, runtime.nodeState(c).isRun ?? 0);
    }
  }

  /** FUN_00437030. */
  function update(e: SmokeEmitter, prng: EffectRng | null): void {
    const sys = e.system;
    if (e.updated && e.params.moveParticles && sys) {
      // FUN_004f5230: every particle moves with the emitter.
      const d: Vec3 = [e.position[0] - e.previous[0], e.position[1] - e.previous[1], e.position[2] - e.previous[2]];
      for (const q of sys.particles) q.position = [q.position[0] + d[0], q.position[1] + d[1], q.position[2] + d[2]];
    }
    e.updated = true;
    e.previous = [...e.position];
    // Children: the particle system steps before this update's emission.
    sys?.tick(null);
    // "Generate factor" expressions are not evaluated (level 1 has none): +0x98 keeps its initial value.
    // fld QWORD factor; fadd DWORD acc; fst DWORD acc; fcomp 30: the comparison sees the unrounded sum.
    let sum = x87Add(e.factor, e.acc);
    e.acc = x87StoreF32(sum);
    const o = host.originIgi();
    while (SMOKE_TASK.generateStep < sum) {
      if (sys && prng) {
        const at: Vec3 = [e.position[0] - o[0], e.position[1] - o[1], e.position[2] - o[2]];
        const p = smokeLaunch(e.params, at, e.direction, rng, prng);
        sys.emit(p.position, p.velocity, p.alpha, p.spin, 0, 1, p.life, p.fadeTicks);
      } else {
        // Without a particle manager the class generator still advances (3 draws).
        rng.float();
        rng.float();
        rng.float();
      }
      sum = x87Sub(e.acc, SMOKE_TASK.generateStep);
      e.acc = x87StoreF32(sum);
    }
  }

  return {
    get emitters() {
      return emitters;
    },
    rng,
    reset: build,
    tick() {
      if (host.runtime() !== runtime || host.particles() !== manager) build();
      const rt = runtime;
      if (!rt) return;
      const prng = host.particleRng();
      for (const e of emitters) {
        // The tree reached the node this tick: every ConditionalContainer above ran its children
        // (isRun now or on the previous tick: the falling-edge tick still updates them).
        let reached = true;
        let inWorld = true;
        for (const c of e.containers) {
          const st = rt.nodeState(c);
          if (!(st.isRun || lastRun.get(c))) reached = false;
          if (st.inWorld === 0) inWorld = false;
        }
        if (e.system) e.system.visible = inWorld;
        if (!reached) continue;
        // FUN_00436d50: ride the parent object (position = R local + P).
        const pose = e.parent >= 0 ? host.trainPose(e.parent) : null;
        if (pose) {
          const l: Vec3 = [f32(e.local[0]), f32(e.local[1]), f32(e.local[2])];
          const m = pose.matrix;
          e.position = [
            pose.position[0] + (m[0] * l[0] + m[1] * l[1] + m[2] * l[2]),
            pose.position[1] + (m[3] * l[0] + m[4] * l[1] + m[5] * l[2]),
            pose.position[2] + (m[6] * l[0] + m[7] * l[1] + m[8] * l[2]),
          ];
        }
        update(e, prng);
      }
      for (const c of lastRun.keys()) lastRun.set(c, rt.nodeState(c).isRun ?? 0);
    },
    dispose() {
      removeSystems();
      emitters = [];
    },
  };
}
