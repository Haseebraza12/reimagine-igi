/**
 * Shot and blown-up objects (docs/damage.md): glass panes, explosive
 * barrels (TASKTYPE_EXPLODEMAGICOBJ), ExplodeObject and the Terminal family
 * (Terminal, AlarmControl, SCameraControl), security-camera lenses, switches,
 * cars, and the explosion itself (fireballs, fragments, smoke, sound, AI
 * event, damage to every object and human of the damage list).
 *
 * Recovered from igi.exe (addresses in docs/damage.md):
 *   - A bullet's front-face hit on an object calls the object's method
 *     DAT_00537431 with {hit record, damage, segment, ...} before the impact
 *     sound and the penetration test (FUN_00479e30 0x47a0dd).
 *   - Explosions call method DAT_00537433 on every object of the damage list
 *     DAT_00577b68 (glass, explode-magic objects, ExplodeObject family, camera
 *     lenses, cars, helis, humans) in registration order.
 *   - Glass (LAB_00448940 / LAB_004489e0): damage accumulates; a bullet
 *     breaks it once the sum reaches its threshold 0.75 + rand x 0.75 (drawn
 *     at creation); any non-zero explosion damage breaks it. Breaking spawns
 *     the shards and plays glass_crush_rand(3) at once; the pane is deleted
 *     (render and collision) at its next update (FUN_004488c0).
 *   - ExplodeMagicObj (LAB_0043b470 / FUN_0043b490 / FUN_0043b270): bullets
 *     and explosions add damage; its update explodes it once damage >=
 *     "hit points": destroyed model, explosion at its origin.
 *   - ExplodeObject (LAB_00480520 / LAB_00480560 / FUN_0047fdd0): damage
 *     accumulates against "Damage scale"; a bullet reaching it sets the
 *     countdown to 0, an explosion to trunc("Explosion delay" x 30); the task
 *     update explodes at countdown 0 (the task runtime's job), then: destroyed
 *     model, explosion at magic vertex 0 of the (new) model.
 *   - SCamera lens (LAB_00441470 / FUN_004414b0): 0.5 damage destroys it; its
 *     next update sets SCamera.isExploded, swaps "Camera Destroyed Model" and
 *     explodes (0.25 damage, 0.5 m, 7 fragments, 3 fireballs, explo_camera).
 *     The lens is the turning camera head (LevelInstance.part "scameraLens",
 *     its own dynamic body world-builder scameraLensKey): bullets hit its
 *     "Camera Model" faces at the current pose; the swapped model keeps
 *     turning (it droops to -75 deg once the camera is off).
 *   - Switch (LAB_00444610): a bullet sets isDestroyed when "Destructable".
 *   - Car (0x42ede0): only explosions from weapon 12 (LAW 80) set its
 *     destroyed flag. Buildings, doors, EditRigidObj, trains: no handlers.
 *
 * Tick order (igi.exe walks the task tree; the objects above sit in their
 * buildings before the humans, explosions are appended to the Dynamic task):
 *   beginTick() - before the player / soldiers update: object updates (glass
 *                 removal, barrels and lenses going off);
 *   endTick()   - after the mission runtime's tick: pending runtime writes,
 *                 runtime ExplodeObject explosions, then every queued
 *                 explosion (the end of the Dynamic walk).
 */
import * as THREE from "three";
import type { IAssetSource, Vec3 } from "../../contracts";
import type { IgiLevel, IgiTask, LevelInstance, LevelModel } from "../../loaders";
import { loadDamageModelData, type DamageModelData, type ExplodeMagicDef, type MefBounds } from "../../loaders/damage-data";
import { x87Fistp, x87StoreF32 } from "../../loaders/x87";
import { LevelRng } from "../ai/rng";
import type { GameContext } from "../context";
import { GameEvent } from "../events";
import * as R from "./explosion-rules";
import { createExplosionFx, type ExplosionFx } from "../fx/explosion";

type V3 = R.V3;
const UNITS = R.UNITS_PER_METRE;

/** Events this module emits (payloads documented per entry). */
export const DAMAGE_EVENTS = {
  /** An explosion went off. payload: ExplosionEventPayload */
  Explosion: "game:explosion",
  /** A glass pane broke. payload: { instance: number; position: Vec3; sound: string } */
  GlassBreak: "game:glass-break",
  /** An object was destroyed or swapped to its destroyed model. payload: { node: number; type: string; instance: number; destroyedModel: string | null } */
  ObjectDestroyed: "game:object-destroyed",
  /** An explosion reached the player. payload: PlayerExplosionPayload */
  PlayerExplosion: "game:player-explosion",
  /** Scorch decal under a grenade. payload: { point: Vec3; sizeM: number; texture: "burn1" } */
  Scorch: "game:scorch",
  /** A car's destroyed flag (+0x91c) was set. payload: { node: number } */
  CarDestroyed: "game:car-destroyed",
} as const;

export interface ExplosionEventPayload {
  /** Engine space. */
  position: Vec3;
  radiusM: number;
  falloffM: number;
  damage: number;
  sound: string;
  fireballs: number;
  fragments: number;
}

/** Everything the player's systems need from one explosion (FUN_00412930). */
export interface PlayerExplosionPayload {
  damage: number;
  /** Knock-back to add, engine m/tick (x, 0, z), or null. Decays x0.9 per tick like bullet knock-back. */
  knock: Vec3 | null;
  /** View shake: amplitude metres, angle radians, duration ticks (FUN_004645e0). */
  shake: { amplitudeM: number; angle: number; ticks: number } | null;
  /** Ear ringing to add to the "earcandy" level (0..1, -1/150 per tick). */
  earcandy: number;
  /** Damage-direction indicators (front, back, left, right order not established), when damaged. */
  indicators: [number, number, number, number] | null;
  /** Explosion centre, engine space. */
  from: Vec3;
}

/** The AI event an explosion broadcasts when it is created (FUN_0047f410 -> FUN_0044fab0). IGI units. */
export interface ExplosionAiEvent {
  type: number;
  team: number;
  flags: number;
  range: number;
  position: V3;
  source: null;
  other: null;
}

/** A front-face bullet hit on an object face, as the bullet tracer reports it. */
export interface BulletObjectHit {
  /** Placed instance index of the face (RayHit.owner). */
  owner: number;
  /** Hit point, engine space. */
  point: Vec3;
  /** Unit ray direction, engine space. */
  dir: Vec3;
  /** Length of this cast (the remaining range when it was cast), metres: the hit record's segment. */
  remaining: number;
}

/** What the damage system needs from the built world (world/world-builder.ts BuiltWorld). */
export interface DamageWorld {
  readonly destructibleInstances: ReadonlySet<number>;
  setInstanceModel(i: number, model: LevelModel | null): boolean;
  resetInstanceModels(): void;
  instanceWorldMatrix(i: number): number[] | null;
}

/**
 * Task-runtime state the damage system reads and writes (the mission
 * system's MissionRuntime owns it). Node = pre-order task index.
 */
export interface ExplosiveBridge {
  /** ExplodeObject / Terminal family +0x190 isExploded; SCamera +0x170. */
  isExploded(node: number): boolean;
  /** ExplodeObject countdown (+0x1f4). */
  setCountdown(node: number, ticks: number): void;
  /** SCamera +0x170 = 1 (its lens was destroyed). */
  setCameraExploded(node: number): void;
  /** Switch isDestroyed (+0x1c2). */
  setSwitchDestroyed?(node: number): void;
  /** The task is in the world (+0x234; ConditionalContainers). */
  inWorld(node: number): boolean;
}

/** One human the explosions can reach. Positions in IGI units. */
export interface ExplosionHuman {
  /** Damage-list order (the human task's pre-order index). */
  order: number;
  /** +0xcf6: present / active (out-of-world and inactive humans are skipped). */
  active: boolean;
  /** Origin (+0x20), IGI units. */
  origin: V3;
  /** View position (HumanView +0xe0), IGI units: knock-back, shake and ear ringing use it. */
  eye: V3;
  /** +0xa0: the body model's origin radius, units. */
  modelRadius: number;
  /** Zone 13 multiplier (+0x2cc). */
  zoneMultiplier: number;
  /** Soldiers: AI SetInvulnerability (+0x3ab8): skipped entirely. */
  invulnerable?: boolean;
  /** Apply a soldier hit (players use the built-in target). */
  apply(hit: R.SoldierExplosionHit, rec: R.ExplosionRecord): void;
}

/** Visual effects sink (fx/explosion.ts implements it). */
export interface ExplosionFxSink {
  explosion(spec: R.ExplosionSpec, plan: { fireballs: R.FireballSpec[]; smoke: { life: number; size: number } | null; fragments: R.ExplosionFragment[] }): void;
  /**
   * Glass shards of instance `i` (its model and current world matrix), pushed
   * by `push` (engine m/tick). `from` (engine space): the bullet's hit point,
   * or the explosion centre when `fromExplosion`.
   */
  glassShatter(i: number, model: LevelModel | null, matrix: number[] | null, push: Vec3, fromExplosion: boolean, from?: Vec3 | null): void;
  /**
   * An ExplosionSmoke update created one of its particle systems
   * (FUN_0047ce40): `smoke` = the smoke task's id, `position` = its centre
   * (IGI units, absolute), `particle` = the drawn values.
   */
  smoke?(smoke: number, position: V3, particle: R.SmokeParticle): void;
  /** FUN_004f5200 on the smoke's shade system: every particle's alpha. */
  smokeAlpha?(smoke: number, alpha: number): void;
  /** Mission restart: drop every live fireball, fragment and shard. */
  clear?(): void;
  tick(): void;
}

/** An ExplosionSmoke task (FUN_0047d520: +0x20 left, +0x24 total, +0x28 centre, +0x40 size, +0x44 shade system). */
interface SmokeTask {
  id: number;
  remaining: number;
  total: number;
  size: number;
  position: V3;
  shade: boolean;
}

export type DamageKind = "glass" | "explodeMagic" | "explodeObject" | "scameraLens" | "switch" | "car";

interface DamageObject {
  kind: DamageKind;
  /** Owning task's pre-order index. */
  node: number;
  /** Placed instance index (render / collision entry), -1 when not placed. */
  instance: number;
  /** Damage-list order. */
  order: number;
  /** Accumulated damage (+0x13c glass / magic, +0x1e8 ExplodeObject, +0x104 lens). */
  damage: number;
  /** Break / explode limit. */
  threshold: number;
  /** Glass broken (+0x144) / magic exploded (+0x148) / lens destroy request (+0x25cc) / car destroyed (+0x91c). */
  flag: boolean;
  /** Removed from the damage list (deleted task or exploded for good). */
  done: boolean;
  /** Model name the handlers measure (origin radius / bounds). */
  model: string;
  /** Explode-magic definition. */
  def?: ExplodeMagicDef;
  /** ExplodeObject: the task parameters, the runtime's isExploded as last seen, and the deferred bullet write. */
  task?: IgiTask;
  exploded?: boolean;
  countdownWrite?: number;
  /** Internal countdown when no task runtime is attached. */
  countdown?: number;
  /** SCamera holder instance (lens position); the lens instance (when placed) is `instance`. */
  holder?: number;
}

export interface DamageSystemOptions {
  /** Level RNG (DAT_00577b78 + 0x2c). Default ctx.rng. */
  rng?: LevelRng;
  /** Create the explosion / glass visuals (fx/explosion.ts) on load (default true). */
  fx?: boolean;
}

export interface DamageSystem {
  /** Read the model bounds / destroyed models and build the damage objects (mission start). */
  load(raw: IAssetSource, level: IgiLevel, world: DamageWorld): Promise<void>;
  /** Build from already loaded data (tests, or a second start of the same level). */
  attach(level: IgiLevel, world: DamageWorld | null, data: DamageModelData): void;
  /** Mission restart: every object intact, thresholds redrawn, pending explosions dropped. */
  reset(): void;
  setMissionBridge(bridge: ExplosiveBridge | null): void;
  setFx(fx: ExplosionFxSink | null): void;
  /** Where the AI EXPLOSION events go (enemy.ts: the AI world's broadcast, FUN_0044fab0). */
  setAiEvents(sink: ((ev: ExplosionAiEvent) => void) | null): void;
  /** Soldiers (and any other humans) the explosions can reach; replaces the provider of the same name. */
  setHumanTargets(name: string, provider: (() => Iterable<ExplosionHuman>) | null): void;
  /**
   * Placed SCamera lens instance of an SCamera node: bullets can then hit it. attach()/reset()
   * already take the lens the loader placed (LevelInstance.part "scameraLens"); this overrides it.
   */
  registerCameraLens(node: number, instance: number): void;
  /**
   * A bullet's front-face hit on an object face (call before the impact
   * sound and the ricochet / penetration test). `damage` = the weapon's
   * Damage Factor. Returns true when the face belongs to a damage object.
   */
  bulletHit(hit: BulletObjectHit, damage: number): boolean;
  /** Queue an explosion (it goes off at the next endTick). */
  explode(spec: R.ExplosionSpec): void;
  /** FUN_0047f350 with the level RNG: a new explosion spec (draws six randoms, broadcasts nothing). */
  makeExplosion(args: Parameters<typeof R.makeExplosion>[1]): R.ExplosionSpec;
  beginTick(): void;
  endTick(): void;
  /** Origin radius (+0x78 / FUN_004c59a0) of a model, units; 0 when unknown. */
  modelRadius(model: string): number;
  /** Damage object state for diagnostics / tests. */
  objectAt(instance: number): Readonly<{ kind: DamageKind; node: number; damage: number; threshold: number; flag: boolean; done: boolean }> | null;
  readonly objects: ReadonlyArray<Readonly<{ kind: DamageKind; node: number; instance: number; damage: number; threshold: number; flag: boolean; done: boolean }>>;
  /** Ear ringing level of the player (+0xdc8): the player / audio systems may read it. */
  readonly earcandy: number;
  /** The loaded model data (bounds, destroyed models, explosion models). */
  readonly data: DamageModelData | null;
  /** Remove the visuals (level unload). */
  dispose(): void;
}

const registry = new WeakMap<object, DamageSystem>();

/** The damage system attached to a GameContext (game.ts creates and attaches it). */
export function damageSystemOf(ctx: object): DamageSystem | null {
  return registry.get(ctx) ?? null;
}

export function attachDamageSystem(ctx: object, system: DamageSystem | null): void {
  if (system) registry.set(ctx, system);
  else registry.delete(ctx);
}

/** Models whose bounds the handlers read: placed destructibles, their destroyed models, humans. */
export function damageModelNames(level: IgiLevel): { bounds: Set<string>; build: Set<string> } {
  const bounds = new Set<string>();
  const build = new Set<string>([R.FIREBALL_MODEL, R.FRAGMENT_MODEL]);
  for (const inst of level.instances) {
    if (inst.glass || inst.magicType === "TASKTYPE_EXPLODEMAGICOBJ" || ["ExplodeObject", "Terminal", "AlarmControl", "SCameraControl", "SCamera", "Car"].includes(inst.taskType)) {
      bounds.add(inst.model.toLowerCase());
    }
  }
  for (const task of level.tasks) {
    const p = task.params;
    for (const key of ["Model", "Destroyed model", "Camera Model", "Camera Destroyed Model", "Holder Model"]) {
      const v = p[key];
      if (typeof v === "string" && v) bounds.add(v.toLowerCase());
    }
    if (["ExplodeObject", "Terminal", "AlarmControl", "SCameraControl"].includes(task.type)) {
      const d = p["Destroyed model"];
      if (typeof d === "string" && d) build.add(d.toLowerCase());
    }
    if (task.type === "SCamera") {
      const d = p["Camera Destroyed Model"];
      if (typeof d === "string" && d) build.add(d.toLowerCase());
    }
  }
  for (const s of level.soldiers) bounds.add(s.model.toLowerCase());
  // Thrown grenades (combat/grenade.ts): contact points = magic vertices, explosion radius = origin radius.
  for (const t of level.vehicles?.types ?? []) if (t.taskType === "TASKTYPE_GRENADE" && t.model) bounds.add(t.model.toLowerCase());
  return { bounds, build };
}

const num = (task: IgiTask | undefined, key: string, fallback = 0): number => {
  const v = task?.params[key];
  return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : fallback;
};
const str = (task: IgiTask | undefined, key: string): string => {
  const v = task?.params[key];
  return typeof v === "string" ? v : "";
};

export function createDamageSystem(ctx: GameContext, options: DamageSystemOptions = {}): DamageSystem {
  const rng = () => options.rng ?? ctx.rng;
  let level: IgiLevel | null = null;
  let world: DamageWorld | null = null;
  let data: DamageModelData | null = null;
  let bridge: ExplosiveBridge | null = null;
  let fx: ExplosionFxSink | null = null;
  let ownFx: ExplosionFx | null = null;
  let aiEvents: ((ev: ExplosionAiEvent) => void) | null = null;
  /** ExplosionSmoke tasks alive (their updates draw from the level RNG, FUN_0047e790), in Dynamic-list order. */
  let smokes: SmokeTask[] = [];
  let smokeIds = 0;
  const providers = new Map<string, () => Iterable<ExplosionHuman>>();
  let objects: DamageObject[] = [];
  const byInstance = new Map<number, DamageObject>();
  const lensOf = new Map<number, DamageObject>();
  let pending: R.ExplosionSpec[] = [];
  let earcandy = 0;
  let playerOrder = 0;

  // --- Coordinates --------------------------------------------------------------
  const origin = (): Vec3 => level?.originIgi ?? [0, 0, 0];
  const toIgi = (e: readonly number[]): V3 => {
    const o = origin();
    return [o[0] + e[0] * UNITS, o[1] - e[2] * UNITS, o[2] + e[1] * UNITS];
  };
  const toEngine = (p: readonly number[]): Vec3 => {
    const o = origin();
    return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
  };
  /** Model-space IGI point -> IGI world through instance i's current matrix. */
  const instancePoint = (i: number, local: readonly number[] = [0, 0, 0]): V3 => {
    const inst = level!.instances[i];
    const m = world?.instanceWorldMatrix(i) ?? inst.matrix;
    // IGI model axes -> engine model axes (x, z, -y), metres.
    const ex = local[0] / UNITS;
    const ey = local[2] / UNITS;
    const ez = -local[1] / UNITS;
    return toIgi([
      m[0] * ex + m[4] * ey + m[8] * ez + m[12],
      m[1] * ex + m[5] * ey + m[9] * ez + m[13],
      m[2] * ex + m[6] * ey + m[10] * ez + m[14],
    ]);
  };
  const bounds = (model: string): MefBounds | undefined => data?.bounds.get(model.toLowerCase());
  const modelRadius = (model: string): number => bounds(model)?.originRadius ?? 0;
  const destroyedModel = (name: string): LevelModel | null => (name ? data?.models.get(name.toLowerCase()) ?? null : null);

  // --- Build --------------------------------------------------------------------
  function build(): void {
    objects = [];
    byInstance.clear();
    lensOf.clear();
    pending = [];
    smokes = [];
    earcandy = 0;
    const lvl = level;
    if (!lvl || !data) return;
    const rootOf = new Map<number, number>();
    /** Placed SCamera lens (the "Camera Model" the loader places, LevelInstance.part) per SCamera node. */
    const lensInstanceOf = new Map<number, number>();
    lvl.instances.forEach((inst: LevelInstance, i) => {
      if (inst.taskIndex === undefined) return;
      if (inst.part === "scameraLens") {
        if (!lensInstanceOf.has(inst.taskIndex)) lensInstanceOf.set(inst.taskIndex, i);
      } else if ((inst.attachmentPath ?? "") === "" && !rootOf.has(inst.taskIndex)) rootOf.set(inst.taskIndex, i);
    });
    const add = (o: DamageObject) => {
      objects.push(o);
      if (o.instance >= 0) byInstance.set(o.instance, o);
    };
    // Magic objects: created with their building, in ATTA order (FUN_00448630 draws the glass
    // threshold). objects.qsc creates every building before LevelFlow, whose create seeds the
    // level RNG (FUN_004872f0 -> FUN_00415c90): the thresholds come from the generator's state
    // before that seed and take no draw from the seeded sequence. The port uses the generator's
    // initial state (FUN_004aaa00) for them [inferred: the exe's pre-seed state depends on what ran before].
    const creation = new LevelRng(0);
    lvl.instances.forEach((inst, i) => {
      const node = inst.taskIndex ?? -1;
      const order = node * 1000 + i;
      if (inst.glass) {
        add({ kind: "glass", node, instance: i, order, damage: 0, threshold: R.glassThreshold(creation), flag: false, done: false, model: inst.model });
      } else if (inst.magicType === "TASKTYPE_EXPLODEMAGICOBJ") {
        const def = data!.explodeMagic.get(inst.model.toLowerCase());
        if (def) add({ kind: "explodeMagic", node, instance: i, order, damage: 0, threshold: def.hitPoints, flag: false, done: false, model: inst.model, def });
      }
    });
    lvl.tasks.forEach((task, node) => {
      const order = node * 1000;
      switch (task.type) {
        case "ExplodeObject": case "Terminal": case "AlarmControl": case "SCameraControl":
          add({
            kind: "explodeObject", node, instance: rootOf.get(node) ?? -1, order, damage: 0,
            // Compile (LAB_0047ffb0): +0x1ec = "Damage scale" (+0x1f0).
            threshold: Math.fround(num(task, "Damage scale", 1)), flag: false, done: false, model: str(task, "Model"), task, exploded: false, countdown: -1,
          });
          break;
        case "SCamera": {
          // The lens object (SCameraLens, LAB_00440780) is in the damage list; bullets hit its placed
          // "Camera Model" (the loader places it, the mission system turns it every tick).
          const lens: DamageObject = {
            kind: "scameraLens", node, instance: lensInstanceOf.get(node) ?? -1, order, damage: 0, threshold: R.SCAMERA_LENS_HIT_POINTS, flag: false, done: false,
            model: str(task, "Camera Model"), task, holder: rootOf.get(node) ?? -1,
          };
          lensOf.set(node, lens);
          add(lens);
          break;
        }
        case "Switch":
          if (task.params["Destructable"] === true) add({ kind: "switch", node, instance: rootOf.get(node) ?? -1, order, damage: 0, threshold: 0, flag: false, done: false, model: str(task, "Off model"), task });
          break;
        case "Car":
          add({ kind: "car", node, instance: rootOf.get(node) ?? -1, order, damage: 0, threshold: 0, flag: false, done: false, model: str(task, "Model"), task });
          break;
        case "HumanPlayer":
          playerOrder = order;
          break;
        default:
          break;
      }
    });
    objects.sort((a, b) => a.order - b.order);
  }

  // --- Explosions -----------------------------------------------------------------
  function queue(spec: R.ExplosionSpec): void {
    pending.push(spec);
    // FUN_0047f410 broadcasts the AI event when the explosion is created.
    if (spec.aiRange !== null) {
      aiEvents?.({
        type: R.EXPLOSION_AI_EVENT.type, team: R.EXPLOSION_AI_EVENT.team, flags: R.EXPLOSION_AI_EVENT.flags,
        range: spec.aiRange, position: [...spec.position] as V3, source: null, other: null,
      });
    }
  }

  function objectExplosion(position: V3, a: { damage: number; radiusM: number; falloffM: number; fragments: number; fireballs: number; sound: string }): void {
    queue(R.makeExplosion(rng(), {
      position, interval: 0, damage: a.damage, radius: x87StoreF32(a.radiusM * UNITS), falloff: x87StoreF32(a.falloffM * UNITS),
      scorch: R.EXPLOSION_SCORCH, fragments: a.fragments, fireballs: a.fireballs, sound: a.sound, aiRange: R.EXPLOSION_AI_RANGE,
    }));
  }

  /** FUN_0047fdd0: destroyed model, explosion at magic vertex 0 of the current model, isExploded. */
  function explodeObject(o: DamageObject): void {
    const task = o.task;
    const destroyed = str(task, "Destroyed model");
    const model = destroyedModel(destroyed);
    if (model && o.instance >= 0) {
      world?.setInstanceModel(o.instance, model);
      o.model = destroyed;
    }
    ctx.events.emit(DAMAGE_EVENTS.ObjectDestroyed, { node: o.node, type: task?.type ?? "ExplodeObject", instance: o.instance, destroyedModel: model ? destroyed : null });
    const magic = bounds(o.model)?.magic ?? [];
    const position = o.instance >= 0 ? instancePoint(o.instance, magic[0] ?? [0, 0, 0]) : taskPosition(task);
    objectExplosion(position, {
      damage: Math.fround(num(task, "Explosion damage scale", 1)),
      radiusM: Math.fround(num(task, "Explosion radius", 2)),
      falloffM: Math.fround(num(task, "Explosion falloff radius", 1.5)),
      fragments: Math.trunc(num(task, "Explosion fragments", 3)),
      fireballs: Math.trunc(num(task, "Explosion fireballs", 3)),
      sound: str(task, "Explosion sound"),
    });
    o.exploded = true;
    o.done = true;
  }

  function taskPosition(task: IgiTask | undefined): V3 {
    const p = task?.params["Position"] ?? task?.params["Holder Position"];
    return Array.isArray(p) && p.length === 3 ? [Number(p[0]), Number(p[1]), Number(p[2])] : [0, 0, 0];
  }

  /**
   * The lens origin (+0x20): the placed lens's pivot, else the holder + Rz(Holder Gamma) x magic
   * vertex 0 of the holder model (FUN_00441290 0x4412d2) [recovered].
   */
  function lensPosition(o: DamageObject): V3 {
    if (o.instance >= 0) return instancePoint(o.instance);
    if (o.holder !== undefined && o.holder >= 0) {
      const holderModel = level!.instances[o.holder].model;
      return instancePoint(o.holder, bounds(holderModel)?.magic[0] ?? [0, 0, 0]);
    }
    return taskPosition(o.task);
  }

  /** FUN_0047d570: fireballs, smoke, fragments, sound, then the damage list. */
  function detonate(spec: R.ExplosionSpec): void {
    if (spec.radius === 0) return;
    const r = rng();
    const fireballs = R.fireballPlan(r, spec.radius, spec.fireballs);
    const smoke = R.smokePlan(spec.radius, spec.fireballs);
    const fragments = R.fragmentPlan(r, spec);
    fx?.explosion(spec, { fireballs, smoke, fragments });
    if (smoke) smokes.push({ id: ++smokeIds, remaining: smoke.life, total: smoke.life, size: smoke.size, position: [...spec.position] as V3, shade: false });
    const position = toEngine(spec.position);
    if (spec.sound) playAt(spec.sound, position);
    ctx.events.emit(DAMAGE_EVENTS.Explosion, {
      position, radiusM: spec.radius / UNITS, falloffM: spec.falloff / UNITS, damage: spec.damage, sound: spec.sound, fireballs: spec.fireballs, fragments: spec.fragments,
    } satisfies ExplosionEventPayload);
    if (spec.damage === 0) return;
    const rec = R.recordOf(spec);
    // Damage list in registration order: objects and humans by their task's place in the tree.
    const humans: ExplosionHuman[] = [];
    for (const p of providers.values()) for (const h of p()) humans.push(h);
    const list: Array<{ order: number; run: () => void }> = [];
    for (const o of objects) if (!o.done) list.push({ order: o.order, run: () => explosionHit(o, rec) });
    for (const h of humans) list.push({ order: h.order, run: () => humanHit(h, rec) });
    list.push({ order: playerOrder, run: () => playerHit(rec) });
    list.sort((a, b) => a.order - b.order);
    for (const item of list) item.run();
  }

  function explosionHit(o: DamageObject, rec: R.ExplosionRecord): void {
    switch (o.kind) {
      case "glass": { // LAB_004489e0
        if (o.instance < 0) return;
        const b = bounds(o.model);
        const centre = instancePoint(o.instance, b?.sphereCentre ?? [0, 0, 0]);
        const f = R.explosionFactor(rec, centre, b?.sphereRadius ?? 0);
        o.damage = x87StoreF32(f + o.damage);
        if (f !== 0 && !o.flag) {
          o.flag = true;
          shatter(o, rec.position, true);
        }
        return;
      }
      case "explodeMagic": { // FUN_0043b490
        if (o.flag || o.instance < 0) return;
        const f = R.explosionFactor(rec, instancePoint(o.instance), modelRadius(o.model));
        o.damage = x87StoreF32(f + o.damage);
        return;
      }
      case "explodeObject": { // LAB_00480560
        if (isExploded(o) || !inWorld(o)) return;
        const position = o.instance >= 0 ? instancePoint(o.instance) : taskPosition(o.task);
        const f = R.explosionFactor(rec, position, modelRadius(o.model));
        const acc = R.accumulate(o.damage, f, o.threshold);
        o.damage = acc.stored;
        if (acc.reached) setCountdown(o, x87Fistp(Math.fround(num(o.task, "Explosion delay", 1)) * 30), true);
        return;
      }
      case "scameraLens": { // FUN_004414b0
        if (isExploded(o)) return;
        const f = R.explosionFactor(rec, lensPosition(o), modelRadius(o.model));
        const acc = R.accumulate(o.damage, f, o.threshold);
        o.damage = acc.stored;
        if (acc.reached) o.flag = true;
        return;
      }
      case "car": { // 0x42ede0: only explosions of weapon 12 count
        if (rec.sourceWeaponId !== R.CAR_KILLER_WEAPON_ID || o.flag) return;
        const position = o.instance >= 0 ? instancePoint(o.instance) : taskPosition(o.task);
        if (R.explosionFactor(rec, position, modelRadius(o.model)) !== 0) {
          o.flag = true;
          ctx.events.emit(DAMAGE_EVENTS.CarDestroyed, { node: o.node });
        }
        return;
      }
      default:
        return; // switches have no explosion handler
    }
  }

  function humanHit(h: ExplosionHuman, rec: R.ExplosionRecord): void {
    if (!h.active || h.invulnerable) return;
    h.apply(R.soldierExplosionHit(rec, h.eye, h.origin, h.modelRadius, h.zoneMultiplier), rec);
  }

  /** FUN_00412930 for the player. */
  function playerHit(rec: R.ExplosionRecord): void {
    const lvl = level;
    const p = ctx.player;
    if (!lvl) return;
    const inWorldPlayer = ctx.systems.tasks?.inWorld ? ctx.systems.tasks.inWorld(0) : true;
    if (!inWorldPlayer) return;
    const playerTask = lvl.tasks.find((t) => t.type === "HumanPlayer");
    const radius = modelRadius(str(playerTask, "Model") || "000_01_1");
    const feet = p.position;
    // Origin (+0x20) = eye - 0.69 m standing / 0.35 m crouched (FUN_00464490).
    const originAbove = p.eyeHeight - (p.crouching ? 1433.6 : 2826.24) / UNITS;
    const originIgi = toIgi([feet[0], feet[1] + originAbove, feet[2]]);
    const eyeIgi = toIgi([feet[0], feet[1] + p.eyeHeight, feet[2]]);
    const difficulty = lvl.difficulty === "GD_1" ? 0 : lvl.difficulty === "GD_3" ? 2 : 1;
    const hit = R.playerExplosionHit(rec, eyeIgi, originIgi, radius, 1, difficulty, false, rng());
    earcandy = Math.min(1, Math.max(0, earcandy + hit.earcandy));
    const from = toEngine(rec.position);
    const payload: PlayerExplosionPayload = {
      damage: hit.damage,
      knock: hit.knock ? [hit.knock[0] / UNITS, 0, -hit.knock[1] / UNITS] : null,
      shake: hit.shake ? { amplitudeM: hit.shake.amplitude / UNITS, angle: hit.shake.angle, ticks: hit.shake.ticks } : null,
      earcandy: hit.earcandy,
      indicators: hit.indicators,
      from,
    };
    const player = ctx.systems.player as unknown as { damage(amount: number): void; addKnock?(v: Vec3): void } | null;
    if (payload.knock) player?.addKnock?.(payload.knock);
    if (hit.damage > 0 && p.alive) {
      player?.damage(hit.damage);
      ctx.events.emit(GameEvent.PlayerHit, { amount: hit.damage, from, explosion: true, dead: !p.alive });
    }
    ctx.events.emit(DAMAGE_EVENTS.PlayerExplosion, payload);
  }

  // --- Runtime bridge -------------------------------------------------------------
  function isExploded(o: DamageObject): boolean {
    if (bridge) return bridge.isExploded(o.node);
    return o.exploded === true;
  }
  function inWorld(o: DamageObject): boolean {
    return bridge ? bridge.inWorld(o.node) : true;
  }
  /** Countdown write: from a bullet (deferred to endTick when a runtime is attached) or an explosion (immediate). */
  function setCountdown(o: DamageObject, ticks: number, immediate: boolean): void {
    if (bridge) {
      if (immediate) bridge.setCountdown(o.node, ticks);
      else o.countdownWrite = ticks;
    } else {
      o.countdown = ticks;
    }
  }

  /** FUN_0047e790: one ExplosionSmoke update (its particle systems go to the fx sink). */
  function smokeUpdate(sm: SmokeTask, r: LevelRng): void {
    if (sm.remaining <= 0) return;
    if (sm.remaining === sm.total) fx?.smoke?.(sm.id, sm.position, R.smokeGlow(r, sm.total, sm.size));
    if (sm.remaining === R.smokeShadeTick(sm.total)) {
      fx?.smoke?.(sm.id, sm.position, R.smokeShade(r, sm.total, sm.size));
      sm.shade = true;
    }
    if (sm.shade) fx?.smokeAlpha?.(sm.id, R.smokeShadeAlpha(sm.remaining, sm.total));
    sm.remaining -= 1;
  }

  // --- Glass ----------------------------------------------------------------------
  function shatter(o: DamageObject, from: V3 | null, fromExplosion: boolean, push?: Vec3, hitPoint?: Vec3): void {
    const position = instancePoint(o.instance);
    const model = level?.models.get(level.instances[o.instance].model) ?? null;
    fx?.glassShatter(o.instance, model, world?.instanceWorldMatrix(o.instance) ?? level!.instances[o.instance].matrix, push ?? [0, 0, 0], fromExplosion, from ? toEngine(from) : (hitPoint ?? null));
    const sound = R.glassSound(rng());
    playAt(sound, toEngine(position));
    ctx.events.emit(DAMAGE_EVENTS.GlassBreak, { instance: o.instance, position: toEngine(position), sound });
    void from;
  }

  function playAt(name: string, position: Vec3): void {
    const audio = ctx.systems.audio as unknown as { playAt?(n: string, p: Vec3): unknown } | null;
    audio?.playAt?.(name, position);
  }

  // --- Public ---------------------------------------------------------------------------
  const system: DamageSystem = {
    async load(raw, lvl, w) {
      const names = damageModelNames(lvl);
      const loaded = await loadDamageModelData(raw, names.bounds, names.build, (key) => lvl.textures.has(key));
      for (const warning of loaded.warnings) console.info(`[damage] ${warning}`);
      system.attach(lvl, w, loaded);
      if (options.fx !== false) {
        ownFx?.dispose();
        ownFx = createExplosionFx(ctx, lvl, loaded);
        fx = ownFx;
      }
    },
    attach(lvl, w, d) {
      level = lvl;
      world = w;
      data = d;
      build();
    },
    reset() {
      world?.resetInstanceModels();
      build();
      fx?.clear?.();
    },
    setMissionBridge(b) {
      bridge = b;
    },
    setFx(f) {
      fx = f;
    },
    setAiEvents(sink) {
      aiEvents = sink;
    },
    setHumanTargets(name, provider) {
      if (provider) providers.set(name, provider);
      else providers.delete(name);
    },
    registerCameraLens(node, instance) {
      const lens = lensOf.get(node);
      if (!lens) return;
      if (lens.instance >= 0 && byInstance.get(lens.instance) === lens) byInstance.delete(lens.instance);
      lens.instance = instance;
      byInstance.set(instance, lens);
    },
    bulletHit(hit, damage) {
      const o = byInstance.get(hit.owner);
      if (!o || o.done) return false;
      const dmg = Math.fround(damage);
      switch (o.kind) {
        case "glass": { // LAB_00448940
          const acc = R.accumulate(o.damage, dmg, o.threshold);
          o.damage = acc.stored;
          if (acc.reached && !o.flag) {
            o.flag = true;
            // Shard push: the cast segment (units) x 0.007, normalised to 10 units by FUN_00449010.
            const len = hit.remaining * UNITS * R.GLASS_BULLET_PUSH;
            shatter(o, null, false, [hit.dir[0] * len / UNITS, hit.dir[1] * len / UNITS, hit.dir[2] * len / UNITS], hit.point);
          }
          return true;
        }
        case "explodeMagic": // LAB_0043b470: no check, the update tests the sum
          o.damage = x87StoreF32(dmg + o.damage);
          return true;
        case "explodeObject": { // LAB_00480520
          if (isExploded(o)) return true;
          const acc = R.accumulate(o.damage, dmg, o.threshold);
          o.damage = acc.stored;
          if (acc.reached) setCountdown(o, 0, false);
          return true;
        }
        case "scameraLens": { // LAB_00441470
          if (isExploded(o)) return true;
          const acc = R.accumulate(o.damage, dmg, o.threshold);
          o.damage = acc.stored;
          if (acc.reached) o.flag = true;
          return true;
        }
        case "switch": // LAB_00444610: "Destructable" sets isDestroyed
          bridge?.setSwitchDestroyed?.(o.node);
          return true;
        default:
          return true; // cars: no bullet handler
      }
    },
    explode(spec) {
      queue(spec);
    },
    makeExplosion(args) {
      return R.makeExplosion(rng(), args);
    },
    beginTick() {
      if (!level) return;
      // Object updates at their place in the tree (before the humans).
      for (const o of objects) {
        if (o.done) continue;
        switch (o.kind) {
          case "glass": // FUN_004488c0: a broken pane deletes itself
            if (o.flag) {
              world?.setInstanceModel(o.instance, null);
              o.done = true;
            }
            break;
          case "explodeMagic": // FUN_0043b270
            if (!o.flag && o.threshold <= o.damage) {
              const def = o.def!;
              const model = destroyedModel(def.destroyedModel);
              if (o.instance >= 0) world?.setInstanceModel(o.instance, model);
              ctx.events.emit(DAMAGE_EVENTS.ObjectDestroyed, { node: o.node, type: "ExplodeMagicObj", instance: o.instance, destroyedModel: model ? def.destroyedModel : null });
              objectExplosion(instancePoint(o.instance), { damage: def.damage, radiusM: def.radiusM, falloffM: def.falloffM, fragments: def.fragments, fireballs: def.fireballs, sound: def.sound });
              o.flag = true;
              o.done = true;
            }
            break;
          case "explodeObject": // FUN_0047fce0 without a task runtime
            if (!bridge && !o.exploded) {
              if (o.countdown === 0) explodeObject(o);
              else if ((o.countdown ?? -1) > 0) o.countdown = (o.countdown ?? 0) - 1;
            }
            break;
          case "scameraLens": // lens update (0x440b9d): a destroy request goes off
            if (o.flag) {
              o.flag = false;
              if (bridge) bridge.setCameraExploded(o.node);
              o.exploded = true;
              const destroyed = str(o.task, "Camera Destroyed Model");
              const model = destroyedModel(destroyed);
              if (o.instance >= 0) world?.setInstanceModel(o.instance, model);
              ctx.events.emit(DAMAGE_EVENTS.ObjectDestroyed, { node: o.node, type: "SCamera", instance: o.instance, destroyedModel: model ? destroyed : null });
              queue(R.makeExplosion(rng(), {
                position: lensPosition(o), interval: 0, damage: 0.25, radius: 2048, falloff: 0, scorch: 0,
                fragments: 7, fireballs: 3, sound: "explo_camera", aiRange: R.EXPLOSION_AI_RANGE,
              }));
              o.done = true;
            }
            break;
          default:
            break;
        }
      }
    },
    endTick() {
      if (!level) return;
      // Bullet writes of this tick, then the runtime's ExplodeObject explosions.
      for (const o of objects) {
        if (o.kind !== "explodeObject" || o.done) continue;
        if (bridge && o.countdownWrite !== undefined) {
          if (!bridge.isExploded(o.node)) bridge.setCountdown(o.node, o.countdownWrite);
          o.countdownWrite = undefined;
        }
        if (bridge && !o.exploded && bridge.isExploded(o.node)) explodeObject(o);
      }
      // The tail of the Dynamic task in list order: ExplosionSmoke tasks of earlier ticks, then this
      // tick's Explosion0s (appended when created; interval 0 / 1: their first update), then the
      // smokes they append. Smoke updates (FUN_0047e790) draw from the level RNG on their first
      // update (4) and at trunc(0.9 T) (2) [recovered order].
      const r = rng();
      const older = smokes;
      for (const sm of older) smokeUpdate(sm, r);
      const now = pending;
      pending = [];
      smokes = [];
      for (const spec of now) detonate(spec);
      const fresh = smokes;
      for (const sm of fresh) smokeUpdate(sm, r);
      smokes = [...older, ...fresh].filter((sm) => sm.remaining > 0);
      // Player ear ringing decays 1/150 per tick (FUN_004111e0).
      earcandy = Math.max(0, earcandy - R.EARCANDY_DECAY);
      fx?.tick();
    },
    modelRadius,
    objectAt(instance) {
      return byInstance.get(instance) ?? null;
    },
    get objects() {
      return objects;
    },
    get earcandy() {
      return earcandy;
    },
    get data() {
      return data;
    },
    dispose() {
      if (fx === ownFx) fx = null;
      ownFx?.dispose();
      ownFx = null;
    },
  };
  return system;
}

/**
 * ExplosiveBridge over the mission runtime's node states (loaders/mission.ts
 * MissionRuntime.nodeState: ExplodeObject family { isExploded, countdown },
 * SCamera { isExploded }, Switch { isDestroyed }, ConditionalContainer
 * { inWorld }). Writes go into the live state records; the mission system may
 * replace this with dedicated runtime methods.
 */
export function missionRuntimeBridge(
  runtime: { nodeState(index: number): Readonly<Record<string, number>>; tasks?: { nodes: ReadonlyArray<{ parent: number; type: string }> } },
  inWorldNode?: (node: number) => boolean,
): ExplosiveBridge {
  const state = (node: number) => runtime.nodeState(node) as Record<string, number> | undefined;
  const inWorld = inWorldNode ?? ((node: number) => {
    const nodes = runtime.tasks?.nodes;
    if (!nodes) return true;
    for (let n = nodes[node]?.parent ?? -1; n >= 0; n = nodes[n].parent) {
      if (nodes[n].type === "ConditionalContainer" && state(n)?.inWorld === 0) return false;
    }
    return true;
  });
  return {
    isExploded: (node) => (state(node)?.isExploded ?? 0) !== 0,
    setCountdown(node, ticks) {
      const s = state(node);
      if (s && !s.isExploded) s.countdown = ticks;
    },
    setCameraExploded(node) {
      const s = state(node);
      if (s) s.isExploded = 1;
    },
    setSwitchDestroyed(node) {
      const s = state(node);
      if (s) s.isDestroyed = 1;
    },
    inWorld,
  };
}

/** Engine-space position helper for tests: a THREE.Vector3 of an IGI point. */
export function igiToEngineVector(p: readonly number[], originIgi: readonly number[]): THREE.Vector3 {
  return new THREE.Vector3((p[0] - originIgi[0]) / UNITS, (p[2] - originIgi[2]) / UNITS, -(p[1] - originIgi[1]) / UNITS);
}
