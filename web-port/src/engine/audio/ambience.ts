/**
 * Level sound tasks from objects.qvm (docs/audio.md §5):
 *
 * - AmbientArea (FUN_0044b1b0): music, ambience beds, random one-shots.
 * - ConditionalSound (FUN_004246a0 / FUN_004247d0 / FUN_004248b0): sounds
 *   started on the rising edge of a task condition (cut-scene effects, the
 *   intro voice-over, the alarm).
 * - ConditionalContainer gating: a task under a container whose condition is
 *   false is not ticked, so its sounds are neither updated nor refreshed (and
 *   therefore stop, inferred from the tick dispatch).
 *
 * Conditions are evaluated through ctx.systems.tasks. Level 1 puts every
 * AmbientArea (music included) under ConditionalContainer 1495
 * "!ConditionalContainer_4001.isRun && !ConditionalContainer_4007.isRun":
 * in-game ambience runs only outside the intro / outro cut-scenes. Without a
 * task runtime, containers are treated as running (so gameplay still has its
 * ambience) and ConditionalSounds stay inactive (port fallback).
 */
import type { Vec3 } from "../../contracts";
import { IGI_AUDIO, ambientPick, igiPointToEngine, x87Fistp, type IgiTask, type TaskParam } from "../../loaders";
import type { TaskRuntimeApi } from "../context";
import type { AudioListener, SoundHandle, SoundMixer, SoundOwner } from "./mixer";

const UNITS = IGI_AUDIO.unitsPerMetre;

type M3 = [number, number, number, number, number, number, number, number, number];

/** IGI task orientation -> rotation (IGI axes), Rz(gamma) Ry(beta) Rx(alpha) as loaders/coords.ts (order inferred there). */
function eulerIgi(alpha: number, beta: number, gamma: number): M3 {
  const [ca, sa, cb, sb, cg, sg] = [Math.cos(alpha), Math.sin(alpha), Math.cos(beta), Math.sin(beta), Math.cos(gamma), Math.sin(gamma)];
  // Rz * Ry * Rx, row-major.
  return [
    cg * cb, cg * sb * sa - sg * ca, cg * sb * ca + sg * sa,
    sg * cb, sg * sb * sa + cg * ca, sg * sb * ca - cg * sa,
    -sb, cb * sa, cb * ca,
  ];
}

/** Engine metres -> IGI world units (inverse of loaders/coords.ts igiPointToEngine). */
export function engineToIgiPoint(p: Vec3, originIgi: Vec3): Vec3 {
  return [originIgi[0] + p[0] * UNITS, originIgi[1] - p[2] * UNITS, originIgi[2] + p[1] * UNITS];
}

const num = (v: TaskParam | undefined, fallback = 0): number => (typeof v === "number" ? v : fallback);
const str = (v: TaskParam | undefined): string => (typeof v === "string" ? v : "");
const bool = (v: TaskParam | undefined): boolean => v === true;
const vec3 = (v: TaskParam | undefined): Vec3 =>
  Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number") ? [v[0] as number, v[1] as number, v[2] as number] : [0, 0, 0];

/** The task's own name in conditions ("ConditionalSound_96"). */
export const taskSelfName = (t: IgiTask) => `${t.type}_${t.id}`;

/** True when a condition value counts as set: the low byte of the truncated value (0x4246cc: (char)fistp(x), chop mode). */
export const conditionTrue = (v: number) => Number.isFinite(v) && (x87Fistp(v) & 0xff) !== 0;

interface Container {
  task: IgiTask;
  expr: string;
  parent: Container | null;
  /** Tick the value was computed for, and the value. */
  at: number;
  active: boolean;
}

export interface AmbientAreaState {
  task: IgiTask;
  name: string;
  position: Vec3;
  /** Rotation (IGI axes, row-major). */
  rotation: M3;
  /** Half extents, metres. */
  size: Vec3;
  minDelay: number;
  randomWait: number;
  names: string[];
  /** +0x78 (double), moves 0.05 per tick. */
  fade: number;
  /** +0x90 delay counter (ticks). */
  delay: number;
  /** +0x1b8 weak handle. */
  handle: SoundHandle | null;
  container: Container | null;
  owner: SoundOwner;
}

export interface ConditionalSoundState {
  task: IgiTask;
  self: string;
  expr: string;
  soundDef: string;
  simple: boolean;
  oneShot: boolean;
  relative: boolean;
  /** Engine position for 3D sounds. */
  position: Vec3;
  cur: boolean;
  prev: boolean;
  started: boolean;
  playing: boolean;
  handle: SoundHandle | null;
  raw: SoundHandle | null;
  /** Ticked this tick (container active). */
  ticked: boolean;
  /** Ticked its children this tick. */
  ticksChildren: boolean;
  container: Container | null;
}

export interface AmbienceOptions {
  random?: () => number;
}

export class AmbienceRuntime {
  readonly areas: AmbientAreaState[] = [];
  readonly sounds: ConditionalSoundState[] = [];
  private readonly containers = new Map<IgiTask, Container>();
  private readonly random: () => number;
  private tickNo = 0;

  constructor(
    private readonly mixer: SoundMixer,
    tasks: readonly IgiTask[],
    private readonly originIgi: Vec3,
    private readonly runtime: () => TaskRuntimeApi | null,
    options: AmbienceOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    const parentOf = new Map<IgiTask, IgiTask>();
    for (const t of tasks) for (const c of t.children) parentOf.set(c, t);
    const containerOf = (t: IgiTask): Container | null => {
      for (let p = parentOf.get(t); p; p = parentOf.get(p)) {
        if (p.type !== "ConditionalContainer") continue;
        let c = this.containers.get(p);
        if (!c) {
          c = { task: p, expr: str(p.params["Condition"]), parent: containerOf(p), at: -1, active: false };
          this.containers.set(p, c);
        }
        return c;
      }
      return null;
    };
    for (const t of tasks) {
      if (t.type === "AmbientArea") {
        const container = containerOf(t);
        const orientation = vec3(t.params["Orientation"]);
        const area: AmbientAreaState = {
          task: t,
          name: t.name,
          position: vec3(t.params["Position"]),
          rotation: eulerIgi(orientation[0], orientation[1], orientation[2]),
          size: vec3(t.params["Size"]),
          minDelay: num(t.params["Min Delay"]),
          randomWait: num(t.params["Random wait"]),
          names: str(t.params["SoundDef"]).split(/\s+/).filter(Boolean).slice(0, 8),
          fade: 0,
          delay: 0,
          handle: null,
          container,
          owner: { active: () => this.containerActive(container) },
        };
        this.areas.push(area);
      } else if (t.type === "ConditionalSound") {
        this.sounds.push({
          task: t,
          self: taskSelfName(t),
          expr: str(t.params["Condition"]),
          soundDef: str(t.params["SoundDef"]),
          simple: bool(t.params["Simple"]),
          oneShot: bool(t.params["OneShot"]),
          relative: bool(t.params["Relative to microphone"]),
          position: igiPointToEngine(vec3(t.params["Position"]), originIgi),
          cur: false,
          prev: false,
          started: false,
          playing: false,
          handle: null,
          raw: null,
          ticked: false,
          ticksChildren: false,
          container: containerOf(t),
        });
      }
    }
  }

  /** Evaluated once per tick; an ancestor container that is off switches its subtree off. */
  private containerActive(c: Container | null): boolean {
    if (!c) return true;
    if (c.at === this.tickNo) return c.active;
    const rt = this.runtime();
    let active = false;
    if (this.containerActive(c.parent)) {
      if (!rt || c.expr.trim() === "") active = true;
      else {
        try {
          active = conditionTrue(rt.condition(c.expr, taskSelfName(c.task)));
        } catch {
          active = false;
        }
      }
    }
    c.at = this.tickNo;
    c.active = active;
    return active;
  }

  private rand(): number {
    const r = this.random();
    return r >= 1 ? 0.9999999 : r < 0 ? 0 : r;
  }

  /** One 30 Hz tick, before the mixer tick. */
  tick(listener: AudioListener): void {
    this.tickNo++;
    for (const a of this.areas) if (this.containerActive(a.container)) this.tickArea(a, listener);
    const rt = this.runtime();
    for (const s of this.sounds) this.tickSound(s, rt);
  }

  /** Back to the level-start state (handles are dropped; the mixer is cleared separately). */
  reset(): void {
    for (const a of this.areas) {
      a.fade = 0;
      a.delay = 0;
      a.handle = null;
    }
    for (const s of this.sounds) {
      s.cur = s.prev = s.started = s.playing = false;
      s.handle = s.raw = null;
      s.ticked = s.ticksChildren = false;
    }
    for (const c of this.containers.values()) c.at = -1;
  }

  // ------------------------------------------------------------ AmbientArea

  /** Listener inside the area's rotated box: -size < local < size on every axis (constants +-4096 per metre). */
  isInside(a: AmbientAreaState, listener: AudioListener): boolean {
    const p = engineToIgiPoint(listener.position, this.originIgi);
    const d = [p[0] - a.position[0], p[1] - a.position[1], p[2] - a.position[2]];
    const r = a.rotation;
    // local = R^T d (columns of the task matrix, 0x44b1fb).
    const local = [
      r[0] * d[0] + r[3] * d[1] + r[6] * d[2],
      r[1] * d[0] + r[4] * d[1] + r[7] * d[2],
      r[2] * d[0] + r[5] * d[1] + r[8] * d[2],
    ];
    for (let i = 0; i < 3; i++) {
      const s = a.size[i] * UNITS;
      if (local[i] <= -s || s <= local[i]) return false;
    }
    return true;
  }

  /** FUN_0044b1b0, step by step. */
  private tickArea(a: AmbientAreaState, listener: AudioListener): void {
    const step = IGI_AUDIO.ambientFadePerTick;
    const inside = this.isInside(a, listener);
    a.fade += inside ? step : -step;
    if (a.fade < 0) a.fade = 0;
    else if (a.fade > 1) a.fade = 1;
    if (a.fade !== 0) {
      if (a.handle === null) {
        if (inside) {
          const idx = ambientPick(this.rand(), a.names.length);
          if (a.delay === 0) {
            const name = a.names[idx] ?? "";
            const h = name ? this.mixer.spawn(name, { owner: a.owner }) : null;
            if (h) {
              h.setPosition(listener.position);
              a.handle = h;
              h.setVolume(a.fade);
            }
          }
        }
        if (a.delay !== 0) a.delay--;
        return;
      }
      if (a.handle.alive) {
        if (inside) a.handle.setPosition(listener.position);
        a.handle.setVolume(a.fade);
        if (a.delay !== 0) a.delay--;
        return;
      }
    }
    // Fully faded out, or the one-shot ended: roll the next delay and drop the instance.
    a.delay = x87Fistp((this.rand() * a.randomWait + a.minDelay) * IGI_AUDIO.tickHz); // 0x44b48d: fistp, truncated
    if (a.handle) {
      if (a.handle.alive) a.handle.kill();
      a.handle = null;
    }
    if (a.delay !== 0) a.delay--;
  }

  // ------------------------------------------------------------ ConditionalSound

  private tickSound(s: ConditionalSoundState, rt: TaskRuntimeApi | null): void {
    s.ticked = rt !== null && this.containerActive(s.container);
    s.ticksChildren = false;
    if (!s.ticked || !rt) return;
    if (s.expr.trim() !== "") {
      s.prev = s.cur;
      let v = 0;
      try {
        v = rt.condition(s.expr, s.self);
      } catch {
        v = 0;
      }
      s.cur = conditionTrue(v);
    }
    // FUN_004248b0: is it still playing? (the mixer refreshes a Simple voice while its owner ticks)
    if (s.simple) s.playing = s.raw !== null && s.raw.alive;
    else if (s.handle) s.playing = s.handle.alive;
    if (s.oneShot && s.started) return;
    if (!s.cur) this.stopSound(s);
    else if (!s.prev) this.startSound(s);
    s.ticksChildren = true;
  }

  /** FUN_00424790: destroy the definition instance (Simple raw voices are left to finish). */
  private stopSound(s: ConditionalSoundState): void {
    if (!s.handle) return;
    if (s.handle.alive) s.handle.kill();
    s.handle = null;
    s.playing = false;
  }

  /** FUN_004247d0. */
  private startSound(s: ConditionalSoundState): void {
    this.stopSound(s);
    if (s.simple) {
      s.raw = this.mixer.spawnRaw(s.soundDef, { active: () => s.ticked });
      s.started = true;
      s.playing = true;
      return;
    }
    const h = this.mixer.spawn(s.soundDef, { owner: { active: () => s.ticked && s.ticksChildren } });
    if (!h) return;
    s.handle = h;
    if (s.relative) h.setRelativeToMicrophone(true);
    else h.setPosition(s.position);
    s.started = true;
    s.playing = true;
  }
}
