/**
 * One body animation track with igi.exe's speed control, as the ladder and
 * wire states drive it (docs/interactions.md §3) [recovered]:
 *
 *   - Start (FUN_004cb5f0 via FUN_004cc860 / FUN_004882c0): forward from
 *     time 0 at +160 ticks per game tick, or with flag 2 ("reverse") from
 *     the clip's duration at -160; flag 0x8000 ("just started") is set.
 *   - Speed (FUN_004ccc10): speed = 160 x s; FUN_004ccbe0 sets the reverse
 *     flag for s < 0 and clears it otherwise (so speed 0 counts as forward).
 *   - Advance (FUN_004cb1f0): t' = t + speed (float32). Events (FUN_004cb450,
 *     the clip's events in file order, stopping at the first one later than
 *     the window): if just started and t != t', the events exactly at t;
 *     then forward (t, t'], reverse [t', t); with t == t' the events exactly
 *     at t. At the end (forward t' >= duration, reverse t' <= 0) the
 *     "finished" flag (0x100) is raised; a looping track wraps (forward
 *     t' - duration with the events in (-1, t'], reverse t' + duration with
 *     [t', duration + 1)); a one-shot clamps (forward to the duration,
 *     reverse to 0).
 *   - Root translation: the per-tick change of the Hermite-sampled root
 *     track (sampleTranslation), continuous across a wrap; its absolute z
 *     is the pelvis height above the feet.
 *
 * Port simplification [inferred]: igi.exe reads the root change of the
 * previous tick's advance (FUN_004c9650 runs before FUN_00460010 advances
 * the track); here the change of this tick's advance is returned, i.e. the
 * same motion one tick earlier.
 */
import { sampleTranslation, type AnimClip, type AnimEvent } from "../../loaders";
import { x87StoreF32 } from "../../loaders/x87";

/** Animation ticks per game tick (4800 / 30, FUN_004c93d0(30) -> DAT_007e4d68) [recovered]. */
export const ANIM_SPEED = 160;

export interface TrackStep {
  /** Events fired by this advance, in firing order (the human keeps the first one: +0x538 / +0x540). */
  events: AnimEvent[];
  /** Root translation change (IGI model space: x right, y forward, z up; units). */
  delta: [number, number, number];
  /** The finished flag (0x100) was raised by this advance. */
  finished: boolean;
}

export class ClipTrack {
  time = 0;
  speed = ANIM_SPEED;
  loop = false;
  reverse = false;
  private justStarted = true;

  constructor(public clip: AnimClip) {}

  /** FUN_004882c0(human, clip, flags): flags bit 0 = loop, bit 1 = reverse. */
  start(clip: AnimClip, flags: number): void {
    this.clip = clip;
    this.loop = (flags & 1) !== 0;
    this.reverse = (flags & 2) !== 0;
    this.time = this.reverse ? clip.duration : 0;
    this.speed = this.reverse ? -ANIM_SPEED : ANIM_SPEED;
    this.justStarted = true;
  }

  /** FUN_004ccc10(anim, 0, s) + FUN_004ccbe0. */
  setSpeed(s: number): void {
    this.speed = x87StoreF32(ANIM_SPEED * s);
    this.reverse = this.speed < 0;
  }

  /** Pelvis height above the feet at the current time (root translation z, units). */
  get rootZ(): number {
    return sampleTranslation(this.clip, this.time)[2];
  }

  /** FUN_004cb450: append the events of the window to `out`. */
  private fire(out: AnimEvent[], from: number, to: number): void {
    const forward = from <= to;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (const e of this.clip.events) {
      if (hi < e.time) return;
      if (lo === hi) {
        if (e.time === lo) out.push(e);
      } else if (forward) {
        if (lo < e.time) out.push(e);
      } else if (lo <= e.time && e.time < hi) {
        out.push(e);
      }
    }
  }

  /** FUN_004cb1f0: one game tick. */
  advance(): TrackStep {
    const clip = this.clip;
    const dur = clip.duration;
    const events: AnimEvent[] = [];
    const t0 = this.time;
    let t1 = x87StoreF32(t0 + this.speed);
    if (this.justStarted && t0 !== t1) this.fire(events, t0, t0);
    this.fire(events, t0, t1);
    let finished = false;
    let delta: [number, number, number];
    const a = sampleTranslation(clip, t0);
    if ((!this.reverse && dur <= t1) || (this.reverse && t1 <= 0)) {
      finished = true;
      if (!this.loop) {
        t1 = this.reverse ? 0 : dur;
        const b = sampleTranslation(clip, t1);
        delta = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      } else if (!this.reverse) {
        const end = sampleTranslation(clip, dur);
        const start = sampleTranslation(clip, 0);
        t1 = x87StoreF32(t1 - dur);
        this.fire(events, -1, t1);
        const b = sampleTranslation(clip, t1);
        delta = [end[0] - a[0] + b[0] - start[0], end[1] - a[1] + b[1] - start[1], end[2] - a[2] + b[2] - start[2]];
      } else {
        const start = sampleTranslation(clip, 0);
        const end = sampleTranslation(clip, dur);
        t1 = x87StoreF32(t1 + dur);
        this.fire(events, dur + 1, t1);
        const b = sampleTranslation(clip, t1);
        delta = [start[0] - a[0] + b[0] - end[0], start[1] - a[1] + b[1] - end[1], start[2] - a[2] + b[2] - end[2]];
      }
    } else {
      const b = sampleTranslation(clip, t1);
      delta = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    }
    this.time = t1;
    this.justStarted = false;
    return { events, delta, finished };
  }
}
