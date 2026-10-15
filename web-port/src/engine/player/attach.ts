/**
 * The player's attached states: ladders, fences and wires (zip lines), as
 * igi.exe runs them (docs/interactions.md §3-5). IGI space throughout
 * (units, z up); the body heading is the port's PlayerState.yaw.
 *
 * Recovered, player tick FUN_00410a30 while attached:
 *   1. the state handler (table 0x53660c) reads the input flags of
 *      FUN_004106b0 (0x80 MoveUp, 0x100 MoveDown, 1 = body clip finished,
 *      4 = grounded, 0x20000 = dead) and the first animation event of the
 *      previous advance (human+0x538 trigger, +0x540 time);
 *   2. the attach functions (FUN_00411380 ladder, FUN_00411710 fence,
 *      FUN_00411a80 traverse, FUN_00411ec0 slide) attach or detach;
 *   3. the root change of the body clip, NOT scaled by 1.75 (+0x52c = 1),
 *      rotated by the body yaw; the yaw and the view pitch are locked
 *      (+0x510, camera +0x138; FUN_00463390 zeroes the pitch on attach);
 *   4. FUN_004600f0 with +0x694 = 1: position += root change + air velocity
 *      + knock-back (x0.9), no sweep and no ground probe (ladder slide
 *      excepted: +0x694 = 0 there, so it collides and lands);
 *   5. the weapon is holstered (+0xd44 = 1, FUN_0040c600) until detach.
 *
 * Ladder (Ladder type FUN_0043f5a0; states 37-40, clips from 0x5368c8):
 *   37 climb (FUN_0040d760/0x40d7b0, clip 168 loop): on a trigger-8 event
 *      with a new time the clip stops (speed 0), rung += step, a rung sound
 *      walk_ladder_1..4 (sequence 0x536c70: 1 2 3 4 2 3 2 3 4 3 2 1) at the
 *      human and an AI LADDER noise (type 14, flags 0x46, 5 m); idle: MoveUp
 *      climbs one rung (speed +1) or, at rung rungs - 6, starts the top exit
 *      (38 -> 39); MoveDown climbs down (speed -1) or, at rung 0, steps off
 *      (state 0); an Activate press slides down (40).
 *   38 mount from the top (clip 170 reversed, one shot): rung sounds; when
 *      finished -> 37 at rung rungs - 6.
 *   39 exit at the top (clip 170 forward, one shot): rung sounds; when
 *      finished -> detach (state 0).
 *   40 slide down (FUN_0040dca0/FUN_0040dcf0, clip 169): collision back on,
 *      looping wire_slide_1; air x 0.99, vz = (vz - 44.6) x 0.99 per tick;
 *      when grounded -> detach (state 0); no fall damage.
 * Fence (state 41, FUN_0040dda0/0x40de00, clip 171 one shot, 6 s counter):
 *   AI FENCE noise (type 13) every tick; when the clip finished -> fall (29).
 * Wire traverse (state 42, FUN_0040de60/0x40dea0, clip 172 loop): trigger-8
 *   events stop the hand step; idle: MoveUp / MoveDown start a step
 *   (+1 / -1) with wire_drag_1 / wire_drag_2 alternating (0x536ca0).
 * Wire slide (state 43, FUN_0040df90/FUN_0040dff0, clip 173): speed s =
 *   0.99 s - dir.z x 88.31 (0x531470, 0x531474) per tick, air = dir x s;
 *   looping wire_slide_1 from the attach.
 * Wires detach (back to the fall state 29, air = last root change) on an
 *   Activate press, when the hold point leaves [p0.y + m, p1.y - m], or on
 *   death; the slide stops its loop sound.
 */
import type { AnimClip, AnimEvent } from "../../loaders";
import { x87Fistp, x87StoreF32 } from "../../loaders/x87";
import { ClipTrack } from "./clip-track";
import {
  fenceMount,
  ladderMount,
  wireInRange,
  wireMount,
  type FenceTarget,
  type Ladder,
  type V3,
  type Wire,
} from "./use-objects";

/** Player body clips of the attached states (table 0x5368c8: clip, flags) [recovered]. */
export const ATTACH_CLIPS = {
  ladderClimb: { clip: 168, flags: 1 },
  ladderMountTop: { clip: 170, flags: 2 },
  ladderExitTop: { clip: 170, flags: 0 },
  ladderSlide: { clip: 169, flags: 1 },
  fence: { clip: 171, flags: 0 },
  wireTraverse: { clip: 172, flags: 1 },
  wireSlide: { clip: 173, flags: 1 },
} as const;

/** Animation trigger that ends a rung / hand step (human+0x538 == 8) [recovered]. */
export const STEP_TRIGGER = 8;
/** walk_ladder_N sequence (0x536c70, + 1) [recovered]. */
export const LADDER_SOUND_SEQUENCE = [0, 1, 2, 3, 1, 2, 1, 2, 3, 2, 1, 0];
/** wire_drag_N alternation (0x536ca0) [recovered]. */
export const WIRE_DRAG_SEQUENCE = [0, 1];
/** AI noise types (AIEVENT_FENCE 13, AIEVENT_LADDER 14), flags 0x46, range 20480 units (0x46a00000) [recovered]. */
export const AI_NOISE = { FENCE: 13, LADDER: 14, DOOR: 12, flags: 0x46, range: 20480 } as const;
/** Ladder slide: x 0.99 (f32 0x531470) and gravity 44.600887 units/tick^2 (f32 0x53146c) [recovered]. */
export const SLIDE_DAMPING = Math.fround(0.99);
export const SLIDE_GRAVITY = Math.fround(44.600887298583984);
/** Wire slide: s = 0.99 s - dir.z x 88.30976 (f32 0x531474) [recovered]. */
export const WIRE_SLIDE_GRAVITY = Math.fround(88.30976104736328);
/** Fence climb counter: 6.0 s (f32 0x531530) x 30, FISTP [recovered]. */
export const FENCE_SECONDS = 6;

export type AttachState =
  | "ladder-climb" // 37
  | "ladder-mount-top" // 38
  | "ladder-exit-top" // 39
  | "ladder-slide" // 40
  | "fence" // 41
  | "wire-traverse" // 42
  | "wire-slide"; // 43

/** Input flags the state handlers read (FUN_004106b0) and the Activate edge (+0x1d4 / +0x134). */
export interface AttachInput {
  up: boolean;
  down: boolean;
  /** Activate went down this tick (held now, not on the previous tick). */
  activatePressed: boolean;
  /** The last move ended on the ground (flag 4). */
  grounded: boolean;
  /** Flag 0x20000: damage reached the capacity. */
  dead: boolean;
}

export interface LoopSound {
  stop(): void;
}

/** What the attached states need from the game. */
export interface AttachHost {
  clip(id: number): AnimClip | null;
  /** One-shot 3-D sound at a point (walk_ladder_N: FUN_004dd750 + FUN_004dd880 at the human). */
  soundAt(name: string, position: V3): void;
  /** One-shot sound attached to the player (wire_drag_N: FUN_004dd750(human, name)). */
  soundOnPlayer(name: string): void;
  /** Looping sound attached to the player (wire_slide_1); null when unavailable. */
  loopOnPlayer(name: string): LoopSound | null;
  /** AI noise event (FUN_0044fab0) at a point. */
  noise(type: number, position: V3): void;
}

/** Result of one attached tick. */
export interface AttachTick {
  /** World root change this tick (IGI units): the clip's root change rotated by the body yaw (no 1.75 factor). */
  root: V3;
  /** Root change in body axes (IGI units: x right, y forward, z up). */
  rootDelta: V3;
  /** Air velocity (+0x664, IGI units / tick) the move adds. */
  air: V3;
  /** Pelvis height above the feet (root translation z, units) after the advance. */
  rootZ: number;
  /**
   * The move collides (ladder slide: +0x694 = 0, a normal FUN_004600f0).
   * Otherwise position += root + air + knock-back (x0.9) with no sweep and no
   * ground probe; the caller performs the move.
   */
  collide: boolean;
  /** Detached this tick: back to the ground state (0), the fall state (29) or death. */
  detach: null | "ground" | "fall" | "dead";
}

type Target = { kind: "ladder"; ladder: Ladder } | { kind: "fence"; fence: FenceTarget } | { kind: "wire"; wire: Wire; mode: "traverse" | "slide" };

const ZERO: V3 = [0, 0, 0];

/** Rz(heading) * v: body axes -> world (FUN_004a9ec0 body matrix) [recovered]. */
export function bodyToWorld(heading: number, v: readonly number[]): V3 {
  const c = Math.cos(heading), s = Math.sin(heading);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

export class AttachController {
  state: AttachState | null = null;
  /** Pelvis position, IGI units (human+0x20). */
  position: V3 = [0, 0, 0];
  /** Body heading (+0x50c), the port's yaw. */
  heading = 0;
  /** Air velocity (+0x664), IGI units / tick. */
  air: V3 = [0, 0, 0];
  /** Current rung (+0xd80), rung count (+0xd7c). */
  rung = 0;
  rungs = 0;
  /** Fence counter (+0xd64 / +0xd60). */
  ticks = 0;
  tickLimit = 0;
  private target: Target | null = null;
  private track: ClipTrack | null = null;
  /** Step direction (+0xd84). */
  private step = 0;
  /** Last trigger-8 time seen (+0xd88 ladder, +0xd98 wire). */
  private lastEventTime = -1;
  private ladderSoundIndex = 0; // +0xd8c
  private dragIndex = 0; // +0xd9c
  /** Wire slide speed (+0xdb0) and downhill direction (+0xda4). */
  private slideSpeed = 0;
  private slideDir: V3 = [0, 0, 0];
  private loop: LoopSound | null = null;
  /** First event of the previous advance (+0x538 / +0x540). */
  private event: AnimEvent | null = null;
  private finished = false;
  private lastRoot: V3 = [0, 0, 0];

  constructor(private readonly host: AttachHost) {}

  get attached(): boolean {
    return this.state !== null;
  }

  /** Body clip of the current state and its loop flag (for posing the body). */
  get clip(): { id: number; loop: boolean; time: number } | null {
    return this.track ? { id: this.track.clip.id, loop: this.track.loop, time: this.track.time } : null;
  }

  get ladder(): Ladder | null {
    return this.target?.kind === "ladder" ? this.target.ladder : null;
  }

  get wire(): Wire | null {
    return this.target?.kind === "wire" ? this.target.wire : null;
  }

  /** The world root change of the last attached tick (for the fall state's air velocity on detach). */
  get lastRootMove(): V3 {
    return [...this.lastRoot] as V3;
  }

  /** Drop everything (mission restart). */
  reset(): void {
    this.loop?.stop();
    this.loop = null;
    this.state = null;
    this.target = null;
    this.track = null;
    this.event = null;
    this.step = 0;
  }

  private enter(state: AttachState): void {
    this.state = state;
    this.event = null;
    this.finished = false;
    const spec = {
      "ladder-climb": ATTACH_CLIPS.ladderClimb,
      "ladder-mount-top": ATTACH_CLIPS.ladderMountTop,
      "ladder-exit-top": ATTACH_CLIPS.ladderExitTop,
      "ladder-slide": ATTACH_CLIPS.ladderSlide,
      fence: ATTACH_CLIPS.fence,
      "wire-traverse": ATTACH_CLIPS.wireTraverse,
      "wire-slide": ATTACH_CLIPS.wireSlide,
    }[state];
    const clip = this.host.clip(spec.clip);
    if (clip) {
      if (!this.track) this.track = new ClipTrack(clip);
      this.track.start(clip, spec.flags);
    } else {
      this.track = null;
    }
    if (state === "ladder-climb") {
      // FUN_0040d760: step 0, last event time -1.
      this.step = 0;
      this.lastEventTime = -1;
    } else if (state === "wire-traverse") {
      this.lastEventTime = -1; // FUN_0040de60: +0xd98 = -1
    } else if (state === "ladder-slide") {
      // FUN_0040dca0: collision back on, looping wire_slide_1.
      this.loop?.stop();
      this.loop = this.host.loopOnPlayer("wire_slide_1");
    }
  }

  /**
   * The attach tick's own advance: FUN_00460010 runs after the attach
   * functions in the same player tick, so the new clip has already advanced
   * once (and fired its start events) when the state handler first runs.
   * The root change moves the body (no collision).
   */
  private prime(): void {
    if (!this.track) return;
    const step = this.track.advance();
    this.event = step.events[0] ?? null;
    this.finished = step.finished;
    const root = bodyToWorld(this.heading, step.delta);
    this.lastRoot = root;
    this.position = [this.position[0] + root[0] + this.air[0], this.position[1] + root[1] + this.air[1], this.position[2] + root[2] + this.air[2]];
  }

  private place(position: V3, heading: number): void {
    // FUN_00461de0 (+ FUN_00461e60): position, slide and knock-back cleared; velocities cleared by the attach.
    this.position = [...position] as V3;
    this.heading = heading;
    this.air = [0, 0, 0];
    this.lastRoot = [0, 0, 0];
  }

  /** FUN_00411380 attach branch [recovered]. */
  attachLadder(ladder: Ladder, side: "bottom" | "top"): void {
    const m = ladderMount(ladder, side);
    this.target = { kind: "ladder", ladder };
    this.place(m.position, m.heading);
    this.rung = m.rung;
    this.rungs = ladder.rungs;
    this.enter(side === "bottom" ? "ladder-climb" : "ladder-mount-top");
    this.prime();
  }

  /** FUN_00411710 attach branch [recovered]. */
  attachFence(fence: FenceTarget, pelvis: V3): void {
    const m = fenceMount(fence, pelvis);
    this.target = { kind: "fence", fence };
    this.place(m.position, m.heading);
    // FUN_0040dda0: counter limit = fistp(6.0 x 30), counter 0.
    this.ticks = 0;
    this.tickLimit = x87Fistp(FENCE_SECONDS * 30);
    this.enter("fence");
    this.prime();
  }

  /** FUN_00411a80 / FUN_00411ec0 attach branches [recovered]. */
  attachWire(wire: Wire, pelvis: V3): void {
    const mode = wire.mode;
    const m = wireMount(wire, pelvis, mode);
    this.target = { kind: "wire", wire, mode };
    this.place(m.position, m.heading);
    if (mode === "slide") {
      this.slideSpeed = 0;
      this.slideDir = m.slideDir;
      this.loop?.stop();
      this.loop = this.host.loopOnPlayer("wire_slide_1");
      this.enter("wire-slide");
    } else {
      this.enter("wire-traverse");
    }
    this.prime();
  }

  private ladderStepSound(): void {
    const n = LADDER_SOUND_SEQUENCE[this.ladderSoundIndex] + 1;
    this.ladderSoundIndex = (this.ladderSoundIndex + 1) % LADDER_SOUND_SEQUENCE.length;
    this.host.soundAt(`walk_ladder_${n}`, [...this.position] as V3);
    this.host.noise(AI_NOISE.LADDER, [...this.position] as V3);
  }

  /** A trigger-8 event with a new time from the previous advance (the handlers' first test). */
  private stepEvent(): AnimEvent | null {
    const e = this.event;
    return e && e.trigger === STEP_TRIGGER && e.time !== this.lastEventTime ? e : null;
  }

  private stopSound(): void {
    this.loop?.stop();
    this.loop = null;
  }

  /** Run the state handler; returns a detach request. */
  private handler(input: AttachInput): "ground" | "fall" | null {
    const track = this.track;
    switch (this.state) {
      case "ladder-climb": {
        // 0x40d7b0
        const e = this.stepEvent();
        if (e) {
          track?.setSpeed(0);
          this.lastEventTime = e.time;
          this.rung += this.step;
          this.step = 0;
          this.ladderStepSound();
        }
        if (this.step === 0) {
          if (input.up) {
            if (this.rung === this.rungs - 6) {
              this.enter("ladder-exit-top");
              return null;
            }
            this.step = 1;
            track?.setSpeed(1);
          }
          if (input.down) {
            if (this.rung === 0) return "ground";
            this.step = -1;
            track?.setSpeed(-1);
          }
        }
        if (input.activatePressed) {
          this.enter("ladder-slide");
          return null;
        }
        return null;
      }
      case "ladder-mount-top":
      case "ladder-exit-top": {
        // 0x40da20 / 0x40db80: rung sounds; the finished one-shot ends the state.
        const e = this.stepEvent();
        if (e) {
          this.lastEventTime = e.time;
          this.ladderStepSound();
        }
        if (this.finished) {
          if (this.state === "ladder-mount-top") {
            this.enter("ladder-climb");
            return null;
          }
          return "ground";
        }
        return null;
      }
      case "ladder-slide": {
        // FUN_0040dcf0
        this.air = [
          x87StoreF32(this.air[0] * SLIDE_DAMPING),
          x87StoreF32(this.air[1] * SLIDE_DAMPING),
          x87StoreF32(x87StoreF32(this.air[2] - SLIDE_GRAVITY) * SLIDE_DAMPING),
        ];
        if (input.grounded) {
          this.air = [0, 0, 0];
          this.stopSound();
          return "ground";
        }
        return null;
      }
      case "fence": {
        // 0x40de00
        if (this.ticks < this.tickLimit) this.ticks += 1;
        if (this.finished) return "fall";
        return null;
      }
      case "wire-traverse": {
        // 0x40dea0
        const e = this.stepEvent();
        if (e) {
          track?.setSpeed(0);
          this.lastEventTime = e.time;
          this.step = 0;
        }
        if (this.step === 0) {
          if (input.up) {
            this.step = 1;
            track?.setSpeed(1);
          }
          if (input.down) {
            this.step = -1;
            track?.setSpeed(-1);
          }
          if (this.step !== 0) {
            const n = WIRE_DRAG_SEQUENCE[this.dragIndex] + 1;
            this.dragIndex = (this.dragIndex - 1) & 1;
            this.host.soundOnPlayer(`wire_drag_${n}`);
          }
        }
        return null;
      }
      case "wire-slide": {
        // FUN_0040dff0
        const d = this.slideDir;
        this.slideSpeed = x87StoreF32(this.slideSpeed * SLIDE_DAMPING + -d[2] * WIRE_SLIDE_GRAVITY);
        this.air = [x87StoreF32(this.slideSpeed * d[0]), x87StoreF32(this.slideSpeed * d[1]), x87StoreF32(this.slideSpeed * d[2])];
        return null;
      }
      default:
        return null;
    }
  }

  /** Release everything the attach set (the detach branches) and report how the player continues. */
  private detach(how: "ground" | "fall" | "dead"): "ground" | "fall" | "dead" {
    this.stopSound();
    this.state = null;
    this.target = null;
    this.track = null;
    this.event = null;
    this.step = 0;
    return how;
  }

  /**
   * One attached tick (steps 1-3 of the header). `pelvis` is the current
   * pelvis position (IGI units); the caller performs the move (step 4) with
   * the returned root change and air velocity and the knock-back it keeps.
   */
  tick(input: AttachInput, pelvis: readonly number[]): AttachTick {
    const none = (detach: AttachTick["detach"]): AttachTick => ({ root: ZERO, rootDelta: ZERO, air: ZERO, rootZ: 0, collide: false, detach });
    if (!this.state) return none(null);
    this.position = [pelvis[0], pelvis[1], pelvis[2]];
    // 1. state handler (dead: the handlers set the detach request, 0x20000)
    let request = this.handler(input);
    if (input.dead) request = request ?? "fall";
    // 2. attach functions: wires detach on an Activate press or out of range.
    const target = this.target;
    if (target?.kind === "wire") {
      const out = !wireInRange(target.wire, this.position, target.mode);
      if (input.activatePressed || out || input.dead) request = "fall";
    }
    if (request) return none(this.detach(input.dead ? "dead" : request));
    // FUN_00411710 while climbing a fence: an AI FENCE noise every tick.
    if (target?.kind === "fence") this.host.noise(AI_NOISE.FENCE, [...this.position] as V3);
    // 3. root change of the clip, rotated by the body yaw (no 1.75 factor).
    const step = this.track ? this.track.advance() : { events: [], delta: [0, 0, 0] as [number, number, number], finished: false };
    this.event = step.events[0] ?? null;
    this.finished = step.finished;
    const root = bodyToWorld(this.heading, step.delta);
    this.lastRoot = root;
    return { root, rootDelta: step.delta as V3, air: [...this.air] as V3, rootZ: this.track?.rootZ ?? 0, collide: this.state === "ladder-slide", detach: null };
  }
}
