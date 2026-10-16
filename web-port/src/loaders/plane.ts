/**
 * The Plane task of the full igi.exe (SU-27 702_02_1 and the cut-scene
 * missile 714_01_1, missions 3, 7, 8 and 10): its AnimTask input, its own
 * aerodynamic physics on the shared rigid body, the landing-gear ground
 * contact and the animated sub-parts (gear, gear-bay hatch, canopy, rudders /
 * tailerons) [recovered from the full exe; addresses are FULL-exe FUN_ names].
 *
 * Evidence labels: [recovered] read from igi.exe code (constants from .rdata),
 * [observed] measured on the shipped files, [inferred] reasoning only.
 *
 * Class `Plane` (registration FUN_004330f0, 0x888-byte objects): create
 * FUN_00433410 (Original Thrust 1, Canopy 0, Gear 1, sound block
 * FUN_004e6ab0(2)), update FUN_00433690 ("Play sound" + group "su27", task
 * children; no motion, no explosion), compile FUN_00434770, AnimTask input
 * FUN_004337e0, physics FUN_00433b50, gear contact FUN_00434310, reset
 * FUN_00433530 / FUN_00433580. No damage handler and no script members:
 * planes cannot be destroyed [recovered].
 *
 * Units: 4096 = 1 m, z up, 30 ticks/s; matrices row-major with world = M
 * local (columns are the local axes); forward = local +y.
 */
import { x87Fistp, x87StoreF32 } from "./x87";
import type { Mat3, Vec3 } from "./mission";
import {
  PhysicsVehicle,
  VEHICLE_GRAVITY,
  HELI_DAMPING,
  applyDrag,
  attaMatrix,
  eulerF,
  physicsTypeForModel,
  rotX,
  rotZ,
  type DragElement,
  type MagicObjectDef,
  type PhysicsObjType,
  type VehicleBaseConfig,
  type VehicleModelData,
  type VehicleTaskParams,
  type VehicleWorld,
} from "./vehicles";

const f32 = x87StoreF32;

// ---------------------------------------------------------------------------
// Constants [recovered: full-exe .rdata]
// ---------------------------------------------------------------------------

/** 0x5336c8: km/h -> units/tick (4096000 / 108000). */
const KMH = f32(37.925926208496094);
/** 0x533778 = 37.925926 x 0.8: initial speed per km/h of cfg[0] x thrust. */
export const PLANE_V0_K = f32(30.340740203857422);
/** 0x5336cc: thrust step switch (cfg[8] at or above, cfg[9] below). */
const FAST_THRUST = f32(0.8);
/** 0x53369c: the target is lowered by this while on the ground below full target (contacts only; never for the shipped planes). */
const GROUND_TARGET_DROP = f32(0.6);
/** 0x5336c0: thrust below this snaps to 0 (always). */
const ZERO_THRUST = f32(0.001);
/** 0x533790 / 0x533794: control decay 0.995 - 0.00083 f. */
const CONTROL_DECAY = f32(0.995);
const CONTROL_DECAY_SPEED = f32(0.0008299999753944576);
/** 0x533480: control surfaces work on the ground only from this speed. */
const SURFACE_MIN_SPEED = f32(10);
/** 0x53378c: pi / 360 (float) for the taileron angles. */
const HALF_DEG = f32(0.008726646192371845);
/** 0x533780 (double) pi / 360 for the thrust yaw, passed as (float) to FUN_004b3be0. */
const HALF_DEG_D = f32(0.008726646259971651);
/** 0x53352c, 0x533558, 0x53351c: Break factors of the forward drag, tailerons and wing. */
const BREAK_FORWARD = f32(3);
const BREAK_TAILERON = f32(0.375);
const BREAK_WING = f32(0.75);
/** 0x533504: tailerons get half the wing coefficient at reset. */
const TAILERON_SHARE = f32(0.5);
/** +-16384 (immediate 0x46800000 / 0xc6800000): taileron span 4 m. */
const TAILERON_X = 16384;
/** 0x533788: catapult force per mass (about 145 g per tick). */
const CATAPULT_K = f32(6489.42919921875);
/** Immediate 40960: the thrust acts 10 m ahead of the origin. */
const THRUST_ARM = 40960;
/** 0x53377c: drag on the ground only above 30 km/h. */
const GROUND_DRAG_SPEED = f32(1137.77783203125);
/** 0x533708 (double): gear ray from 2 m above the gear vertex down to it. */
const GEAR_RAY = 8192;
/** 0x5337b8 (double) / 0x5337b0 (float): 2 m - 0.15 m, the stiff zone. */
const GEAR_STIFF_D = 7577.6;
const GEAR_STIFF_F = f32(7577.60009765625);
/** 0x5337a0 (double) 1 / 614.4, 0x5337ac (float) 1 / 7577.6, 0x5337a8 (float) 0.4 g. */
const GEAR_SPRING_K = 0.0016276041666666667;
const GEAR_STIFF_K = f32(0.0001319678995059803);
const GEAR_FORCE_K = f32(17.840354919433594);
/** 0x533798: horizontal velocity x thrust x this per contacting gear. */
const GEAR_ROLL_K = f32(0.800000011920929);
/** 0x5336dc: angular momentum x this per contacting gear. */
const GEAR_SPIN_K = f32(0.9800000190734863);
/** 0x53367c: degrees -> radians (float). */
const DEG = f32(0.01745329238474369);
/** 0x5336d8 / 0x5336dc: sub-part angle smoothing a = 0.02 a* + 0.98 a. */
const PART_NEW = f32(0.019999980926513672);
const PART_OLD = f32(0.9800000190734863);
/** 0x533714: snap to the target within this. */
const PART_SNAP = f32(0.009999999776482582);
/** 0x5333c8 (float) / 0x5337c8 (double, compared as (float)): "at 0" and "at target" thresholds of the gear / hatch states. */
const PART_AT_ZERO = f32(0.10000000149011612);
const PART_MOVING = f32(0.1);
/** 0x5337d0 / 0x533760: hatch smoothing 0.03 a* + 0.97 a. */
const HATCH_NEW = f32(0.029999971389770508);
const HATCH_OLD = f32(0.9700000286102295);
/** 0x5337c0: nose-wheel steering pi / 4 x c2. */
const GEAR_STEER_K = f32(0.7853981852531433);
/** 0x533714: the sound block's "playing" flag is thrust > this. */
const SOUND_ON_THRUST = f32(0.009999999776482582);

/** AnimTask channel names of the plane (table 0x53bef0) [recovered]. */
export const PLANE_CHANNELS = ["dAlpha", "dBeta", "dGamma", "Thrust", "Fire", "Cockpit", "Gear", "Break", "Catapult", "Force Z"] as const;

// ---------------------------------------------------------------------------
// Sub-parts (0x140-byte magic objects attached through the model's ATTA)
// ---------------------------------------------------------------------------

export type PlanePartKind = "gear" | "hatch" | "cockpit" | "rudder" | "afterburner";

/** Rudder roles (RUDDER_* symbols registered by FUN_004361d0) [recovered]. */
export const RUDDER = { AILERON: 0, TAILERON_LEFT: 1, TAILERON_RIGHT: 2, GAMMA: 3 } as const;

export interface PlanePart {
  kind: PlanePartKind;
  /** Index in the plane model's ATTA list (= placed instance attachment path). */
  atta: number;
  model: string;
  /** ATTA offset (float, +0xf0) and rotation (column form of the ATTA matrix, +0x108). */
  offset: Vec3;
  local: Mat3;
  /** Magic parameters (magicobj.qvm DefineMagicObj arguments after the type). */
  params: number[];
  /** +0x13c: current angle (rad). */
  angle: number;
  /** Gear only: magic vertex 0 of the gear model (its local frame), or null. */
  vertex: Vec3 | null;
}

/**
 * Sub-part rotation after the ATTA rotation [recovered]: gear FUN_004355a0 =
 * FUN_004b38e0(a, 0, steer) = Rz(steer) Rx(a); hatch / canopy / rudder
 * FUN_00434f50 / FUN_004362c0 = Rx(a). World matrix = M_plane L_atta R.
 */
export function planePartRotation(part: PlanePart, plane: PlaneSim): Mat3 {
  if (part.kind === "gear") {
    const steer = part.params[1] !== 0 && plane.gear ? f32(plane.controls[2] * GEAR_STEER_K) : 0;
    return eulerF(part.angle, 0, steer);
  }
  if (part.kind === "rudder") return rotX(plane.rudderAngle(part));
  if (part.kind === "afterburner") return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return rotX(part.angle);
}

// ---------------------------------------------------------------------------
// PlaneSim
// ---------------------------------------------------------------------------

/**
 * One Plane task. The AnimTask channels are recorded stick inputs (ch0..2
 * in {-1, 0, 1}, ch3 thrust presets): the trajectory comes only from the
 * physics below [inferred from the data, spec vehicles §1.3].
 */
export class PlaneSim extends PhysicsVehicle {
  readonly config: VehicleBaseConfig;
  /** +0x724..: smoothed controls c0..c2; +0x734..: inputs (ch0..ch2). */
  controls: Vec3 = [0, 0, 0];
  inputs: Vec3 = [0, 0, 0];
  /** Task "Canopy" (+0x830) / "Gear" (+0x831). */
  readonly canopyParam: boolean;
  readonly gearParam: boolean;
  /** +0x82c canopy open, +0x82d gear down, +0x832 gear state, +0x833 hatch state (1 at 0, 0 at target, 0xff moving). */
  canopy = false;
  gear = true;
  gearState = 1;
  hatchState = 1;
  /** +0x744 Break (ch7), +0x82e Catapult (ch8), +0x82f "Force Z" toggle (ch9; no reader). */
  brake = false;
  catapult = false;
  forceZToggle = false;
  /** +0x748: the object's copy of the type's drag elements (taileron normals / coefficients rewritten per tick). */
  elements: DragElement[] = [];
  /** The type's elements 3 / 4 as FUN_00433580 writes them back (+0x80 / +0x9c of the type config). */
  private typeTail: [DragElement, DragElement] | null = null;
  readonly parts: PlanePart[] = [];
  /** +0x828 sound parameter block [1] thrust, [2] playing. */
  sound: [number, number] = [0, 0];

  constructor(task: VehicleTaskParams, types: readonly PhysicsObjType[], model: VehicleModelData, magic: ReadonlyMap<string, MagicObjectDef>,
    modelData: (name: string) => VehicleModelData | undefined, flags: { canopy: boolean; gear: boolean }) {
    super(task, physicsTypeForModel(types, task.model));
    this.config = this.type.config as VehicleBaseConfig;
    this.canopyParam = flags.canopy;
    this.gearParam = flags.gear;
    const kinds: Record<string, PlanePartKind> = {
      TASKTYPE_GEAR: "gear", TASKTYPE_HATCH: "hatch", TASKTYPE_COCKPITSHIELD: "cockpit", TASKTYPE_RUDDER: "rudder", TASKTYPE_AFTERBURNER: "afterburner",
    };
    model.attachments.forEach((a, i) => {
      const mo = magic.get(a.name.toLowerCase());
      const kind = mo ? kinds[mo.taskType] : undefined;
      if (!mo || !kind) return;
      const local = attaMatrix(a.matrix);
      const vertex = kind === "gear" ? modelData(a.name)?.magicVertices[0] ?? null : null;
      this.parts.push({ kind, atta: i, model: a.name, offset: a.position.map(f32) as Vec3, local, params: [...mo.params], angle: 0, vertex: vertex ? vertex.map(f32) as Vec3 : null });
    });
    // Compile FUN_00434770: model, body, reset (FUN_00433530: the task's Gear / Canopy), then the
    // ATTA children are created (FUN_004f4820 / FUN_004f4800 -> FUN_004c4950) and read those flags.
    this.setupBody();
    this.reset();
    this.createParts();
    this.thrust = this.target = this.originalThrust;
    this.body.velocity = this.initialVelocity();
    this.body.updateSpeed();
  }

  /**
   * The sub-part creates read the plane's flags [recovered]: gear FUN_00435460 and hatch
   * FUN_00435c50 start at 0 with the gear down, else at param0 deg (retracted / closed); the
   * canopy FUN_00434e10 at param0 deg when open, else 0.
   */
  createParts(): void {
    for (const p of this.parts) {
      if (p.kind === "gear" || p.kind === "hatch") p.angle = this.gear ? 0 : f32(p.params[0] * DEG);
      else if (p.kind === "cockpit") p.angle = this.canopy ? f32(p.params[0] * DEG) : 0;
    }
  }

  /** FUN_00433530 + FUN_00433580: flags from the task, then the drag elements with the two rebuilt tailerons. */
  reset(): void {
    this.canopy = this.canopyParam;
    this.gear = this.gearParam;
    this.gearState = this.hatchState = this.gearParam ? 1 : 0;
    this.brake = this.catapult = this.forceZToggle = false;
    const type = this.config.drag;
    this.elements = type.map((e) => ({ coef: e.coef, normal: [...e.normal] as Vec3, point: [...e.point] as Vec3 }));
    const wing = this.elements[2];
    if (wing && this.elements.length > 4) {
      const coef = f32(wing.coef * TAILERON_SHARE);
      const right: DragElement = { coef, normal: [...wing.normal] as Vec3, point: [TAILERON_X, -wing.point[1], wing.point[2]] };
      const left: DragElement = { coef, normal: [...wing.normal] as Vec3, point: [-TAILERON_X, -wing.point[1], wing.point[2]] };
      this.elements[3] = right;
      this.elements[4] = left;
      // Written back into the shared type config (+0x80 / +0x9c): the per-tick code reads them there.
      this.typeTail = [{ coef, normal: [...right.normal] as Vec3, point: [...right.point] as Vec3 }, { coef, normal: [...left.normal] as Vec3, point: [...left.point] as Vec3 }];
    }
  }

  /** v0 = "Speed" when non-zero, else Original Thrust x cfg[0] x 30.34 along local +y (column 1) [recovered FUN_004337e0 / FUN_00434770]. */
  private initialVelocity(): Vec3 {
    const s = this.initSpeed;
    if (s[0] !== 0 || s[1] !== 0 || s[2] !== 0) return [s[0], s[1], s[2]];
    const k = f32(this.config.c[0] * this.thrust * PLANE_V0_K);
    const m = this.matrix;
    return [f32(k * m[1]), f32(k * m[4]), f32(k * m[7])];
  }

  /**
   * FUN_004337e0, every AnimTask step: ch0..2 -> inputs (always), ch3 ->
   * target (-1 keeps), ch5 / ch6 / ch9 XOR canopy / gear / Force Z with
   * round(ch) whenever != -1 (every tick the channel holds 1), Break = ch7 !=
   * -1, Catapult = ch8 != -1. Nothing is written back. nTick 0: pose, body,
   * thrust = target = Original Thrust, inputs / controls 0, reset, v0.
   * nTick > 0: physics FUN_00433b50.
   */
  animInput(nTick: number, ch: Float32Array, world: VehicleWorld): void {
    if (ch[3] !== -1) this.target = f32(ch[3]);
    this.inputs = [f32(ch[0]), f32(ch[1]), f32(ch[2])];
    // (byte) ^= (char)fistp(ch): chop-mode FPU, so the channel value is truncated.
    const xor = (on: boolean, v: number) => (((on ? 1 : 0) ^ (x87Fistp(v) & 0xff)) & 0xff) !== 0;
    if (ch[5] !== -1) this.canopy = xor(this.canopy, ch[5]);
    if (ch[6] !== -1) this.gear = xor(this.gear, ch[6]);
    this.brake = ch[7] !== -1;
    this.catapult = ch[8] !== -1;
    if (ch[9] !== -1) this.forceZToggle = xor(this.forceZToggle, ch[9]);
    if (nTick === 0) {
      this.position = [...this.initPosition];
      this.matrix = [...this.initMatrix];
      this.setupBody();
      this.thrust = this.target = this.originalThrust;
      this.inputs = [0, 0, 0];
      this.controls = [0, 0, 0];
      // FUN_004f4820 / FUN_004f4800: the children are re-created with the flags before the reset.
      this.createParts();
      this.reset();
      this.body.velocity = this.initialVelocity();
      this.body.updateSpeed();
    }
    if (nTick > 0) this.physics(world);
  }

  /** FUN_00433b50. */
  private physics(world: VehicleWorld): void {
    const c = this.config.c;
    const mass = this.type.mass;
    const b = this.body;
    let f = b.speed / (c[7] * KMH);
    f = 0 <= f ? (1 < f ? 1 : f) : 0;
    // Thrust ramp (contacts stay 0 for the shipped planes: no contact points, spec §1.7).
    const step = FAST_THRUST <= this.thrust ? c[8] : c[9];
    const goal = this.contacts === 0 || 1 <= this.target ? this.target : f32(this.target - GROUND_TARGET_DROP);
    let t = this.thrust;
    if (goal <= t) {
      if (!(t <= goal)) {
        t = f32(t - step);
        if (!(goal <= t)) t = goal;
      }
    } else {
      t = f32(t + step);
      if (!(t <= goal)) t = goal;
    }
    if (t < ZERO_THRUST) t = 0;
    this.thrust = t;
    // Controls with the speed-dependent decay.
    const decay = CONTROL_DECAY - f * CONTROL_DECAY_SPEED;
    const s = [c[2], c[4], c[6]];
    for (let k = 0; k < 3; k++) this.controls[k] = f32((s[k] * this.controls[k] + (1 - s[k]) * this.inputs[k]) * decay);
    const [c0, c1, c2] = this.controls;
    // Tailerons: the type's taileron normals turned about x (upper clamp only).
    if ((c0 !== 0 || c1 !== 0 || c2 !== 0) && (this.contacts === 0 || SURFACE_MIN_SPEED <= b.speed) && this.typeTail && this.elements.length > 4) {
      const pitch = f32(c0 * c[1] * HALF_DEG);
      const roll = f32(c1 * c[3] * HALF_DEG);
      let a3 = f32(-(roll + pitch));
      if (c[1] <= a3) a3 = c[1];
      let a4 = f32(roll - pitch);
      if (c[1] <= a4) a4 = c[1];
      this.elements[3].normal = rotateF(rotX(a3), this.typeTail[0].normal);
      this.elements[4].normal = rotateF(rotX(a4), this.typeTail[1].normal);
    }
    // Break: forward drag x3, tailerons and wing reduced; otherwise the type's coefficients.
    const type = this.config.drag;
    if (type.length > 4 && this.typeTail) {
      if (!this.brake) {
        this.elements[1].coef = type[1].coef;
        this.elements[3].coef = this.typeTail[0].coef;
        this.elements[4].coef = this.typeTail[1].coef;
        this.elements[2].coef = type[2].coef;
      } else {
        this.elements[1].coef = f32(type[1].coef * BREAK_FORWARD);
        this.elements[3].coef = f32(type[2].coef * BREAK_TAILERON);
        this.elements[4].coef = f32(type[2].coef * BREAK_TAILERON);
        this.elements[2].coef = f32(type[2].coef * BREAK_WING);
      }
    }
    if (this.catapult) b.add([0, f32(mass * CATAPULT_K), 0], [0, 0, 0]);
    if (this.thrust !== 0) {
      let force: Vec3 = [0, f32(mass * this.thrust * VEHICLE_GRAVITY), 0];
      if (this.contacts === 0) force = rotateF(rotZ(f32(c[5] * c2 * HALF_DEG_D)), force);
      b.add(force, [0, THRUST_ARM, 0]);
    }
    this.gearContact(world);
    if (!this.atRest()) {
      if (this.elements.length && (this.contacts === 0 || GROUND_DRAG_SPEED < b.speed)) applyDrag(b, this.elements, this.matrix);
      this.integrate(HELI_DAMPING.linear, HELI_DAMPING.angular);
    }
    this.updateParts();
    this.sound = [this.thrust, SOUND_ON_THRUST < this.thrust ? 1 : 0];
  }

  /**
   * FUN_00434310: per Gear child (at most 4), a vertical ray from its magic
   * vertex 0 (in the world, with the gear's current pose) + 2 m down to the
   * vertex. A hit at d <= 2 m pushes along body z at (ATTA offset + vertex):
   * spring (2 m - d) / 0.15 m x 0.4 m g from 1.85 m down, else stiff ((1.85
   * m - d) / 1.85 m + 1) x 0.4 m g and the plane is lifted by the deepest
   * penetration; each contacting gear multiplies v.x, v.y by thrust x 0.8 and
   * L by 0.98 (on the ground a plane only keeps rolling with thrust >= 1.25).
   */
  private gearContact(world: VehicleWorld): void {
    const b = this.body;
    const mass = this.type.mass;
    let stiff = false;
    let lift = -Number.MAX_VALUE;
    let n = 0;
    for (const part of this.parts) {
      if (part.kind !== "gear" || n >= 4) continue;
      n++;
      const v = part.vertex ?? [0, 0, 0];
      const w = this.partWorld(part);
      const r = mulF(w.matrix, v);
      const x = w.position[0] + r[0];
      const y = w.position[1] + r[1];
      const top = w.position[2] + r[2] + GEAR_RAY;
      const hit = world.castDown(x, y, top, top - GEAR_RAY);
      if (!hit || !(hit.distance <= GEAR_RAY)) continue;
      const d = hit.distance;
      let force: number;
      if (GEAR_STIFF_D <= d) {
        force = f32((GEAR_RAY - d) * GEAR_SPRING_K * mass * GEAR_FORCE_K);
      } else {
        force = f32(((GEAR_STIFF_F - f32(d)) * GEAR_STIFF_K + 1) * mass * GEAR_FORCE_K);
        stiff = true;
        lift = Math.max(lift, GEAR_STIFF_D - d);
      }
      const point: Vec3 = [f32(part.offset[0] + v[0]), f32(part.offset[1] + v[1]), f32(part.offset[2] + v[2])];
      b.add([0, 0, force], point);
      b.velocity = [f32(b.velocity[0] * this.thrust * GEAR_ROLL_K), f32(b.velocity[1] * this.thrust * GEAR_ROLL_K), b.velocity[2]];
      b.angularMomentum = b.angularMomentum.map((k) => f32(k * GEAR_SPIN_K)) as Vec3;
    }
    if (stiff) this.position = [this.position[0], this.position[1], this.position[2] + lift];
  }

  /**
   * Sub-part updates (slot 1 of each class) [recovered handlers; that they
   * run once per physics tick is inferred]:
   *  - Gear FUN_00435930: a* = param0 deg, 0 when the gear is down and the
   *    hatch state is 1; a = 0.02 a* + 0.98 a (snap within 0.01); gear state =
   *    1 if |a| < 0.1, 0xff if |a* - |a|| >= 0.1, else 0.
   *  - Hatch FUN_00435e50: gear up and gear state 0 -> a = 0.03 a* + 0.97 a,
   *    else a = 0.97 a; hatch state = 1 if |a| < 0.1, 0 if |a* - |a|| < 0.1,
   *    else 0xff.
   *  - CockpitShield FUN_004352a0: a* = canopy ? param deg : 0; a = 0.02 a*
   *    + 0.98 a when a != a*.
   */
  updateParts(): void {
    for (const p of this.parts) {
      if (p.kind === "gear") {
        const full = f32(p.params[0] * DEG);
        const goal = this.gear && this.hatchState === 1 ? 0 : full;
        if (goal !== p.angle) p.angle = f32(goal * PART_NEW + p.angle * PART_OLD);
        if (Math.abs(f32(p.angle - goal)) < PART_SNAP) p.angle = goal;
        const a = Math.abs(p.angle);
        if (a < PART_AT_ZERO) this.gearState = 1;
        else this.gearState = Math.abs(f32(full - a)) >= PART_MOVING ? 0xff : 0;
      } else if (p.kind === "hatch") {
        const full = f32(p.params[0] * DEG);
        p.angle = !this.gear && this.gearState === 0 ? f32(full * HATCH_NEW + p.angle * HATCH_OLD) : f32(p.angle * HATCH_OLD);
        const a = Math.abs(p.angle);
        if (a < PART_AT_ZERO) this.hatchState = 1;
        else this.hatchState = Math.abs(f32(full - a)) < PART_MOVING ? 0 : 0xff;
      } else if (p.kind === "cockpit") {
        const goal = this.canopy ? f32(p.params[0] * DEG) : 0;
        if (goal !== p.angle) p.angle = f32(goal * PART_NEW + p.angle * PART_OLD);
      }
    }
  }

  /**
   * FUN_004362c0: k = param1 deg; AILERON -k c0; TAILERON_LEFT min(k c1 -
   * k c0, cfg[1]); TAILERON_RIGHT min(k c0 + k c1, cfg[1]); GAMMA -k c2.
   */
  rudderAngle(part: PlanePart): number {
    const k = f32(part.params[1] * DEG);
    const [c0, c1, c2] = this.controls;
    const clamp = this.config.c[1];
    switch (part.params[0]) {
      case RUDDER.TAILERON_LEFT: return Math.min(f32(k * c1 - k * c0), clamp);
      case RUDDER.TAILERON_RIGHT: return Math.min(f32(k * c0 + k * c1), clamp);
      case RUDDER.AILERON: return f32(-(k * c0));
      case RUDDER.GAMMA: return f32(-(k * c2));
      default: return 0;
    }
  }

  /** World pose of a sub-part: position = plane + M offset, matrix = M L_atta R(part) (FUN_00435a80 / FUN_004355a0). */
  partWorld(part: PlanePart): { position: Vec3; matrix: Mat3 } {
    const m = this.matrix;
    const o = part.offset;
    const position: Vec3 = [
      f32(m[0] * o[0] + m[1] * o[1] + m[2] * o[2]) + this.position[0],
      f32(m[3] * o[0] + m[4] * o[1] + m[5] * o[2]) + this.position[1],
      f32(m[6] * o[0] + m[7] * o[1] + m[8] * o[2]) + this.position[2],
    ];
    return { position, matrix: mulMatF(mulMatF(m, part.local), planePartRotation(part, this)) };
  }
}

function rotateF(m: Mat3, v: readonly number[]): Vec3 {
  return [f32(m[0] * v[0] + m[1] * v[1] + m[2] * v[2]), f32(m[3] * v[0] + m[4] * v[1] + m[5] * v[2]), f32(m[6] * v[0] + m[7] * v[1] + m[8] * v[2])];
}

function mulF(m: Mat3, v: readonly number[]): Vec3 {
  return rotateF(m, v);
}

function mulMatF(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = f32(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  }
  return out;
}

/** "Canopy" / "Gear" of an objects.qvm Plane task (FUN_00433248.. schema) [observed names]. */
export function planeFlagsFromTask(params: Readonly<Record<string, unknown>>): { canopy: boolean; gear: boolean } {
  return { canopy: params["Canopy"] === true, gear: params["Gear"] === true };
}
