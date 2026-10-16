/**
 * CarAI of the full igi.exe (missions 6, 7, 8, 10, 14): the task that drives
 * its parent Car along an AIGraph following a PatrolPath route, and toward
 * a perceived target ("attack") [recovered; addresses are FULL-exe FUN_
 * names; spec vehicles §2].
 *
 * Class `CarAI` (registration FUN_00425c80, 0x84 bytes): create LAB_00425d90,
 * update FUN_00425de0 (once per tick, at its node: a child of the Car, so
 * after the Car's "Can fire" perception), compile FUN_004265a0. No AnimTask,
 * no damage, no members. Its output is the Car's AnimTask input message
 * (FUN_00426510): ch0 = steer, ch1 = thrust, ch2 = an uninitialised stack
 * word (the car never reads ch2), ch3 = brake or -1 when the brake is 0.
 *
 * Evidence labels: [recovered] read from igi.exe, [observed] shipped data,
 * [inferred] reasoning only.
 */
import { aiGraphClosestNode, aiGraphNodeWorld, aiGraphRoute, type AiGraph, type AiGraphNode } from "./ai-graph";
import { AiPatrolCursor, PATROL_COMMAND, type PatrolCommand } from "./ai-rules";
import type { Mat3, Vec3 } from "./mission";
import { x87StoreF32 } from "./x87";

const f32 = x87StoreF32;

// Constants [recovered: full-exe .rdata]
/** 0x533648 (double): a WALKTO / RUNTO node is reached within 3 m (squared). */
export const CAR_AI_ARRIVED_D2 = 150994944;
/** 0x533620 (double): (10 m)^2, the heading-based speed applies beyond it. */
const NEAR_D2 = 1677721600;
/** 0x533640 (double): (14 m)^2 for the attack speed. */
const ATTACK_NEAR_D2 = 3288334336;
/** 0x533618 / 0x533610 (doubles): the speed formula's pi and 1/pi (as stored). */
const PI_D = 3.1415926535897944;
const INV_PI_D = 0.3183098861837905;
/** 0x533608 (double) / 0x5335f8 (float): the minimum (turning) speed, 5 km/h. */
const MIN_KMH_D = 5;
const MIN_KMH_F = f32(5);
/** 0x533600 (double): 1 / 40960^2, speed x d^2 / (10 m)^2 before an END. */
const END_SLOWDOWN = 5.960464477539063e-10;
/** 0x533638 / 0x533630 / 0x533628 (doubles): 10 deg, 170 deg, 1 / 170 deg (attack approach). */
const ATTACK_TURN = 0.17453293005625406;
const ATTACK_170 = 2.9670597235335405;
const ATTACK_INV_170 = 0.33703399768747383;
/** 0x53366c: units/tick -> km/h (108 / 4096). */
const UNITS_TO_KMH = f32(0.0263671875);
/** 0x533668: thrust change per km/h of speed error. */
const THRUST_PER_KMH = f32(0.009999999776482582);
/** 0x533660 (double): braking when 5 km/h too fast. */
const BRAKE_ERROR = -5;
/** 0x533658 / 0x533654 (floats): +-10 deg full steering lock; 0x533650 = -6 / pi. */
const STEER_FULL = f32(0.1745329350233078);
const STEER_FULL_NEG = f32(-0.1745329350233078);
const STEER_K = f32(-1.909859299659729);
/** 0x533574 / 0x5335ac: patrol steering x ((1 - thrust) 0.95 + 0.05). */
const STEER_THRUST_K = f32(0.949999988079071);
const STEER_MIN = f32(0.05000000074505806);
/** 0x533670: stopped attack: desired km/h = |a| x this (180 / (2 pi)). */
const PIVOT_KMH = f32(28.64788818359375);
/** Immediate 0x41a00000: attack approach speed, km/h. */
export const CAR_AI_ATTACK_KMH = 20;
/** FUN_00426000: the target is kept 600 ticks (20 s) after it was last seen. */
export const CAR_AI_TARGET_MEMORY = 600;

/** The graph a CarAI drives on: AIGraph task "Graph position" + graph file. */
export interface CarAiGraph {
  graph: AiGraph;
  position: Vec3;
}

/** What the CarAI reads from its Car (CarSim + task state). */
export interface CarAiCar {
  /** Position (+0x20) and matrix (+0x70). */
  position: Vec3;
  matrix: Mat3;
  /** Body speed (+0xf8, approximate |v|, units/tick). */
  speed: number;
  /** Current smoothed thrust (+0x720). */
  thrust: number;
  /** "Can fire" result (+0x91d). */
  canFire: boolean;
  /** First visible entry of the car's perception list (+0xaa8): its key and position, or null. */
  seen(): { key: string | number; position: Vec3 } | null;
}

/** A remembered target (+0x74): its key; the host answers alive / position. */
export interface CarAiTargetHost {
  /** FUN_00463170: is the target dead? */
  dead(key: string | number): boolean;
  /** FUN_004c3440: the target's position (+0x20). */
  position(key: string | number): Vec3 | null;
}

/**
 * FUN_00414950: acos(unit(v).y), negated when v.x > 0 (0 for a zero vector). turrets: the
 * function zeroes z first (0x414954 / 0x41495d store 0 into the argument's z double, full exe)
 * [recovered], so it is the horizontal heading of (x, y, 0), not the 3D angle from +y.
 */
export function headingFromY(v: readonly number[]): number {
  const n = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  if (n === 0) return 0;
  const a = Math.acos(Math.max(-1, Math.min(1, v[1] / n)));
  return v[0] > 0 ? -a : a;
}

/** FUN_004b31f0: angle between two vectors (acos of the unit dot, clamped; 0 for a zero vector). */
export function angleOf(a: readonly number[], b: readonly number[]): number {
  const na = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  const nb = Math.sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
  if (na === 0 || nb === 0) return 0;
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  if (d >= 1) return 0;
  if (d <= -1) return Math.PI;
  return Math.acos(d);
}

/** M^T d (doubles, float matrix): a world vector in the car's frame. */
function toLocal(m: Mat3, d: readonly number[]): Vec3 {
  return [m[0] * d[0] + m[3] * d[1] + m[6] * d[2], m[1] * d[0] + m[4] * d[1] + m[7] * d[2], m[2] * d[0] + m[5] * d[1] + m[8] * d[2]];
}

/** The commands of a PatrolPath task (its PatrolPathCommand children, "Command" / "Command Parameter"). */
export function patrolCommandsOf(children: ReadonlyArray<{ type: string; params: Readonly<Record<string, unknown>> }>): PatrolCommand[] {
  return children.filter((c) => c.type === "PatrolPathCommand")
    .map((c) => ({ command: Number(c.params["Command"]), parameter: Number(c.params["Command Parameter"]) }));
}

/**
 * One CarAI task. `update` = FUN_00425de0; it returns the channel buffer sent
 * to the car this tick (nTick, channels), or null when the CarAI does
 * nothing (no car, graph or route).
 */
export class CarAi {
  /** +0x30: patrol cursor (FUN_004537e0 on the first update), null before. */
  cursor: AiPatrolCursor | null = null;
  cursorInit = false;
  /** +0x50: nTick sent with the next input (0 on the first update: a second reset). */
  nTick = 0;
  /** +0x58 thrust, +0x5c steer, +0x60 brake (outputs, kept between ticks). */
  thrust = 0;
  steer = 0;
  brake = 0;
  /** +0x64: desired speed (km/h). */
  desired = 0;
  /** +0x68: next graph node to drive to. */
  next: AiGraphNode | null = null;
  /** +0x6c: speed for this tick (km/h); +0x70: brake request. */
  speed = 0;
  brakeRequest = 0;
  /** +0x74 / +0x78: target and its memory (ticks). */
  target: string | number | null = null;
  memory = 0;
  /** +0x7c: DELAY counter; +0x80: SETSPEED value (km/h). */
  delay = 0;
  setSpeed = 0;
  /** True while the last update attacked (diagnostics). */
  attacking = false;

  constructor(readonly id: number, readonly graph: CarAiGraph | null, readonly route: readonly PatrolCommand[] | null, readonly log?: (message: string) => void) {}

  /** FUN_004265a0 (compile): the reset message (nTick 0, thrust 0, steer 0, brake 0 -> ch3 -1). */
  static compileInput(): Float32Array {
    return CarAi.channels(0, 0, 0);
  }

  /** FUN_00426510: ch0 steer, ch1 thrust, ch2 (unread), ch3 brake or -1. */
  static channels(steer: number, thrust: number, brake: number): Float32Array {
    const ch = new Float32Array(34);
    ch[0] = steer;
    ch[1] = thrust;
    ch[2] = 0;
    ch[3] = brake === 0 ? -1 : brake;
    return ch;
  }

  private nodeWorld(n: AiGraphNode): Vec3 {
    return aiGraphNodeWorld(n, this.graph!.position);
  }

  /** FUN_005096f0: nearest node to p (VIEW nodes skipped). */
  private nearest(p: readonly number[]): AiGraphNode | null {
    return aiGraphClosestNode(this.graph!.graph, this.graph!.position, [p[0], p[1], p[2]])?.node ?? null;
  }

  private node(id: number): AiGraphNode | null {
    return this.graph!.graph.nodeById.get(id) ?? null;
  }

  /** FUN_00425c10: from the node nearest p, the next hop toward `dest` (no link: an error and the nearest node itself). */
  private hop(p: readonly number[], dest: number): AiGraphNode | null {
    const a = this.nearest(p);
    if (!a || a.id === dest) return a;
    const r = aiGraphRoute(this.graph!.graph, a.id, dest);
    if (r) return this.node(r.next);
    this.log?.(`CarAI: Error in graph. No link between nodes ${a.id} and ${dest}.`);
    return a;
  }

  /** FUN_004260c0: the car is within 3 m of node `id`. */
  private arrived(car: CarAiCar, id: number): boolean {
    const n = this.node(id);
    if (!n) return false;
    const w = this.nodeWorld(n);
    const d = [w[0] - car.position[0], w[1] - car.position[1], w[2] - car.position[2]];
    return d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < CAR_AI_ARRIVED_D2;
  }

  /**
   * FUN_00426000: no "Can fire" or a dead target -> no target; the car's
   * attacker slot (+0x2ed0, never written in the port: its writer is
   * unknown) or the first visible perception entry -> target, memory 600;
   * else the old target for memory ticks.
   */
  private targetTest(car: CarAiCar, host: CarAiTargetHost): boolean {
    if (!car.canFire) {
      this.target = null;
      this.memory = 0;
      return false;
    }
    if (this.target !== null && host.dead(this.target)) {
      this.target = null;
      this.memory = 0;
      return false;
    }
    const seen = car.seen();
    if (seen) {
      this.memory = CAR_AI_TARGET_MEMORY;
      this.target = seen.key;
      return true;
    }
    if (this.memory === 0) {
      this.target = null;
      return false;
    }
    this.memory -= 1;
    return true;
  }

  /** FUN_00425de0. */
  update(car: CarAiCar | null, host: CarAiTargetHost): { nTick: number; channels: Float32Array } | null {
    if (!this.cursorInit && this.route !== null) {
      this.cursor = new AiPatrolCursor(this.route, 0);
      this.cursorInit = true;
    }
    if (!car || !this.graph || !this.cursor) return null;
    this.attacking = this.targetTest(car, host);
    if (!this.attacking) {
      const cmd = this.cursor.command();
      if (cmd) this.patrolCommand(car, cmd);
    } else {
      const tp = host.position(this.target!) ?? car.position;
      const t = this.nearest(tp);
      if (t && !this.arrived(car, t.id)) {
        this.next = this.hop(car.position, t.id);
        this.speed = CAR_AI_ATTACK_KMH;
        this.brakeRequest = 0;
      } else {
        this.speed = 0;
        this.brakeRequest = 1;
      }
      this.attackDrive(car, tp);
    }
    const out = { nTick: this.nTick, channels: CarAi.channels(this.steer, this.thrust, this.brake) };
    this.nTick += 1;
    return out;
  }

  private patrolCommand(car: CarAiCar, cmd: PatrolCommand): void {
    switch (cmd.command) {
      case PATROL_COMMAND.WALKTO:
      case PATROL_COMMAND.RUNTO:
        if (!this.arrived(car, cmd.parameter)) {
          this.next = this.hop(car.position, cmd.parameter);
          this.speed = this.setSpeed;
          this.brakeRequest = 0;
          this.drivePatrol(car);
        } else {
          this.cursor!.advance();
        }
        return;
      case PATROL_COMMAND.DELAY: {
        this.speed = 0;
        const old = this.delay;
        this.brakeRequest = 1;
        this.delay = old + 1;
        if (cmd.parameter < old) {
          this.cursor!.advance();
          this.delay = 0;
        }
        return;
      }
      case PATROL_COMMAND.END:
      case PATROL_COMMAND.QUIT:
        this.speed = 0;
        this.brakeRequest = 1;
        this.brake = 1;
        this.desired = 0;
        this.steer = 0;
        return;
      case PATROL_COMMAND.SETSPEED:
        this.brakeRequest = 0;
        this.setSpeed = f32(cmd.parameter | 0);
        this.cursor!.advance();
        return;
      default:
        this.log?.(`Command not supported by CARAI: ${cmd.command}`);
        this.cursor!.advance();
    }
  }

  /** FUN_00426260: thrust = clamp(error x 0.01 + car thrust, 0, 1); brake unless (no request and error >= -5). */
  private thrustBrake(car: CarAiCar): void {
    const e = f32(this.desired - car.speed * UNITS_TO_KMH);
    const t = f32(e * THRUST_PER_KMH + car.thrust);
    this.thrust = 0 <= t ? (1 < t ? 1 : t) : 0;
    this.brake = this.brakeRequest === 0 && BRAKE_ERROR <= e ? 0 : 1;
  }

  /** The steering of FUN_00426140 / FUN_004262f0: +-1 beyond +-10 deg, else a x (-6 / pi). */
  private static steerOf(a: number): number {
    if (!(a <= STEER_FULL)) return -1;
    const af = f32(a);
    return STEER_FULL_NEG <= af ? f32(af * STEER_K) : 1;
  }

  /** FUN_00426140: desired speed, thrust / brake, steering toward the next node (scaled down with thrust). */
  private drivePatrol(car: CarAiCar): void {
    this.desired = f32(this.patrolSpeed(car));
    this.thrustBrake(car);
    const n = this.next ? this.nodeWorld(this.next) : car.position;
    const a = headingFromY(toLocal(car.matrix, [n[0] - car.position[0], n[1] - car.position[1], n[2] - car.position[2]]));
    const s = CarAi.steerOf(a);
    this.steer = f32(((1 - this.thrust) * STEER_THRUST_K + STEER_MIN) * s);
  }

  /** FUN_004255a0: the desired speed on patrol. */
  private patrolSpeed(car: CarAiCar): number {
    const S = this.speed;
    const N = this.next ? this.nodeWorld(this.next) : car.position;
    const D = [car.position[0] - N[0], car.position[1] - N[1], car.position[2] - N[2]];
    const d2 = D[0] * D[0] + D[1] * D[1] + D[2] * D[2];
    let alpha: number;
    if (d2 <= NEAR_D2) {
      const cmd = this.cursor!.command();
      const dest = cmd ? this.node(cmd.parameter) : null;
      if (dest && dest === this.next) {
        const nextCmd = this.peek();
        if (!nextCmd) return S;
        const t = nextCmd.command;
        if (t !== PATROL_COMMAND.WALKTO && t !== PATROL_COMMAND.RUNTO) {
          if (t === PATROL_COMMAND.END || t === PATROL_COMMAND.QUIT) return S * d2 * END_SLOWDOWN;
          return S;
        }
        const n2 = this.node(nextCmd.parameter);
        const p2 = this.adjust(n2 ? this.nodeWorld(n2) : [0, 0, 0], nextCmd.parameter);
        alpha = angleOf(D, [p2[0] - N[0], p2[1] - N[1], p2[2] - N[2]]);
      } else {
        const destWorld = dest ? this.nodeWorld(dest) : [0, 0, 0];
        const nd = this.nearest(destWorld);
        const h = nd ? this.hop(car.position, nd.id) : null;
        const p = h ? this.adjust(this.nodeWorld(h), h.id) : [0, 0, 0];
        alpha = angleOf(D, [p[0] - N[0], p[1] - N[1], p[2] - N[2]]);
      }
      if (S < MIN_KMH_F) return S;
    } else {
      alpha = Math.abs(headingFromY(toLocal(car.matrix, [-D[0], -D[1], -D[2]])));
    }
    return (PI_D - alpha) * (S - MIN_KMH_F) * INV_PI_D + MIN_KMH_D;
  }

  /** FUN_00425b80: world position of the hop from the node nearest p toward `dest` (p itself when there is no link). */
  private adjust(p: readonly number[], dest: number): Vec3 {
    const a = this.nearest(p);
    if (!a) return [p[0], p[1], p[2]];
    if (a.id === dest) return this.nodeWorld(a);
    const r = aiGraphRoute(this.graph!.graph, a.id, dest);
    if (!r) {
      this.log?.(`CarAI: Error in graph. No link between nodes ${a.id} and ${dest}.`);
      return [p[0], p[1], p[2]];
    }
    const n = this.node(r.next);
    return n ? this.nodeWorld(n) : [p[0], p[1], p[2]];
  }

  /** FUN_00453730 on the cursor: the command the next advance would reach (null at the end). */
  private peek(): PatrolCommand | null {
    const c = this.cursor!;
    const cmds = c.commands;
    if (c.current === null) return null;
    const loop = (c as unknown as { loop: number | null }).loop;
    const i = c.current + 1 < cmds.length ? c.current + 1 : loop !== null ? loop : cmds.length ? 0 : null;
    return i === null ? null : cmds[i];
  }

  /** FUN_004262f0: attack driving (toward the next node while moving, toward the target when stopped). */
  private attackDrive(car: CarAiCar, targetPos: Vec3): void {
    const moving = this.speed !== 0;
    const N = this.next ? this.nodeWorld(this.next) : car.position;
    let d = [N[0] - car.position[0], N[1] - car.position[1], N[2] - car.position[2]];
    if (!moving) d = [targetPos[0] - car.position[0], targetPos[1] - car.position[1], targetPos[2] - car.position[2]];
    const m = car.matrix;
    // (float) operands, products summed on the x87 and kept as doubles.
    const df = d.map(f32);
    const local: Vec3 = [m[0] * df[0] + m[3] * df[1] + m[6] * df[2], m[1] * df[0] + m[4] * df[1] + m[7] * df[2], m[2] * df[0] + m[5] * df[1] + m[8] * df[2]];
    const aRaw = headingFromY(local);
    this.steer = CarAi.steerOf(aRaw);
    const abs = Math.abs(f32(aRaw));
    if (moving) this.desired = f32(this.attackSpeed(car, targetPos));
    else this.desired = STEER_FULL < abs ? MIN_KMH_F : f32(abs * PIVOT_KMH);
    this.thrustBrake(car);
    if (!moving && STEER_FULL < abs) {
      this.brake = 0;
      return;
    }
    this.brake = this.brakeRequest;
  }

  /** FUN_00425900: the desired speed while approaching the target. */
  private attackSpeed(car: CarAiCar, targetPos: Vec3): number {
    const S = this.speed;
    const N = this.next ? this.nodeWorld(this.next) : car.position;
    const D = [car.position[0] - N[0], car.position[1] - N[1], car.position[2] - N[2]];
    const d2 = D[0] * D[0] + D[1] * D[1] + D[2] * D[2];
    if (ATTACK_NEAR_D2 < d2) {
      const a = Math.abs(headingFromY(toLocal(car.matrix, [-D[0], -D[1], -D[2]])));
      return (PI_D - a) * (S - MIN_KMH_F) * INV_PI_D + MIN_KMH_D;
    }
    const t = this.nearest(targetPos);
    if (t && t !== this.next) {
      const r = this.next ? aiGraphRoute(this.graph!.graph, this.next.id, t.id) : null;
      const hn = r ? this.node(r.next) : null;
      const p = hn ? this.nodeWorld(hn) : this.nodeWorld(t);
      const beta = angleOf(D, [p[0] - N[0], p[1] - N[1], p[2] - N[2]]);
      if (S < MIN_KMH_F) return S;
      if (beta < ATTACK_TURN) return (ATTACK_170 - beta) * (S - MIN_KMH_F) * ATTACK_INV_170 + MIN_KMH_D;
      return MIN_KMH_F;
    }
    return S * d2 * END_SLOWDOWN;
  }
}

// ---------------------------------------------------------------------------
// Vehicle perception (Car / Heli "Can fire")
// ---------------------------------------------------------------------------

/** A human the vehicle perception can track (the detectable registry, task-tree order). */
export interface VehiclePerceivable {
  key: string | number;
  team: number;
  alive: boolean;
  inWorld: boolean;
  /** Detection point (the human's eye point, FUN_00464490), IGI units. */
  point: Vec3;
}

/** The vehicle's eye: position (+0xa18), matrix (+0xa30), cone (+0xa58 alpha, +0xa60 gamma in rad; +0xa68 length in units). */
export interface VehicleEye {
  position: Vec3;
  matrix: Mat3;
  alpha: number;
  gamma: number;
  length: number;
}

/** The car's own team for the perception rule (FUN_00489750 param_4 = 1) [recovered]. */
export const VEHICLE_TEAM = 1;

/**
 * FUN_00489960 for a vehicle eye (no secondary cone, +0xa88 = 0)
 * [recovered]: local = M^T (point - eye); in the cone when |local| <=
 * length, the angle of (0, y, z) from +y (FUN_004148f0) < alpha (float
 * compare) and the horizontal angle of (x, y, 0) from +y (FUN_00414950, z
 * zeroed; turrets fix) < gamma, both as absolute values (FUN_00489960).
 */
export function vehicleInCone(eye: VehicleEye, point: readonly number[]): boolean {
  const d = [point[0] - eye.position[0], point[1] - eye.position[1], point[2] - eye.position[2]];
  const l = toLocal(eye.matrix, d);
  const dist = Math.sqrt(l[2] * l[2] + l[1] * l[1] + l[0] * l[0]);
  const yz = Math.hypot(l[1], l[2]);
  const vertical = yz === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, l[1] / yz)));
  const horizontal = Math.abs(headingFromY(l));
  return dist <= eye.length && f32(vertical) < f32(eye.alpha) && horizontal < eye.gamma;
}

/**
 * The perception of a Car (+0xa90, set up by FUN_004896c0(1, 4, phase) at
 * compile: flags 4 = alive objects of another team, cone every 2nd and
 * sight every 3rd run) run by FUN_00489750 on ticks with (tick & 3) ==
 * phase [recovered]: registry objects in order; the vehicle itself, objects
 * out of the world, dead ones and ones of team 1 lose their slot; a new one
 * is added at the list's tail; each tracked one runs the cone / sight step.
 * `seen()` = the first visible entry of the list (FUN_00426000).
 */
export class VehicleDetector {
  readonly slots = new Map<string | number, { coneCountdown: number; losCountdown: number; inCone: boolean; visible: boolean }>();
  readonly list: Array<string | number> = [];

  constructor(public phase: number) {}

  perceive(tick: number, objects: Iterable<VehiclePerceivable>, cone: (o: VehiclePerceivable) => boolean, sight: (o: VehiclePerceivable) => boolean): void {
    if ((tick & 3) !== this.phase) return;
    for (const o of objects) {
      const tracked = o.inWorld && o.alive && o.team !== VEHICLE_TEAM;
      let slot = this.slots.get(o.key);
      if (!tracked) {
        if (slot) this.remove(o.key);
        continue;
      }
      if (!slot) {
        slot = { coneCountdown: 0, losCountdown: 0, inCone: false, visible: false };
        this.slots.set(o.key, slot);
        this.list.push(o.key);
      }
      // FUN_004898d0 = aiPerceptionStep with the counts 1 + 1 and 2 + 1 (FUN_004896c0 args 4 and 8).
      if (slot.coneCountdown === 0) {
        slot.inCone = cone(o);
        if (!slot.inCone) slot.visible = false;
        slot.coneCountdown = 2;
      }
      if (slot.inCone) {
        if (slot.losCountdown === 0) {
          slot.visible = sight(o);
          slot.losCountdown = 3;
        }
        slot.losCountdown--;
      }
      slot.coneCountdown--;
    }
  }

  /** FUN_00489b90 (the "Can fire" falling edge): every slot dropped. */
  clear(): void {
    this.slots.clear();
    this.list.length = 0;
  }

  seen(): string | number | null {
    return this.list.find((k) => this.slots.get(k)?.visible) ?? null;
  }

  private remove(key: string | number): void {
    this.slots.delete(key);
    const i = this.list.indexOf(key);
    if (i >= 0) this.list.splice(i, 1);
  }
}
