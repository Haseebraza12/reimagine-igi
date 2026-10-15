/**
 * Binocular target squares (FUN_00470510, called from the BinocularOverlay
 * draw FUN_0046ff00 at 0x47036a after the centre lines; slot update
 * FUN_004708f0). Recovered:
 *
 *   - Every drawn frame the overlay walks every human except its owner that
 *     is in the world (+0xcf6) and not dead (+0xcf5): the origin is moved into
 *     the current (zoomed) camera's frame, tested against the view frustum
 *     with the human's radius (+0xa0, FUN_004c5420), a ray is cast from the
 *     camera to the human's EYE (FUN_00464470) and the origin is projected
 *     (FUN_00496190). Candidates in front of the camera update a 10-slot table.
 *   - Slot choice (FUN_004708f0): the slot already holding that human; else
 *     the first free slot (its first-seen time = now); else the first slot
 *     whose stored depth is greater than the new depth (first-seen = now);
 *     else the human is dropped. The slot stores: visible-this-frame = 1,
 *     the line-of-sight result, team != 1, radius, depth, last-seen = now and
 *     the projected position.
 *   - Draw: a slot not seen this frame is freed 3000 ms after it was last
 *     seen. A slot seen this frame AND with a clear line of sight is drawn as
 *     the square 0x5320a8 (5 points, +-1) at the projected position, rotated by
 *     t x 0.004 x pi/2 and scaled by halfSize x ((1 - t x 0.004) x 10 + 1),
 *     t = clamp(now - firstSeen, 0, 250) ms: it shrinks from 11x to 1x while
 *     turning 90 degrees in 250 ms. halfSize = radius x (W/2)/tanX / depth
 *     (FUN_004962b0).
 *   - Colour: team 1 (the enemy soldiers of level 1) (64,0,0)/128 = (127,0,0);
 *     any other team (0,128,0)/128 = (0,255,0); the (0,0,128) branch needs a dead
 *     human, which never gets this far. Flags 0 -> vertex alpha forced to 255
 *     (the 0.5 passed is ignored). Lines via FUN_004aba40 (two -0.5 offsets).
 *   - Times are GetTickCount milliseconds (FUN_0048e780), i.e. wall time per
 *     drawn frame, not game ticks.
 */
import { colour128 } from "./hud-state";
import type { Painter } from "./painter";

/** One human the zoomed camera sees this frame (the caller does the frustum test and the projection). */
export interface BinocularTargetInput {
  /** Stable id of the human (soldier id). */
  id: number;
  /** Projected position in the 640x480 frame. */
  x: number;
  y: number;
  /** Distance along the view direction (any unit, the same as `radius`). */
  depth: number;
  /** Human radius (+0xa0) in the unit of `depth`. */
  radius: number;
  /** Projection scale of the zoomed camera: (W / 2) / tanX, in pixels (W = 640). */
  pixelsPerUnitAtUnitDepth: number;
  /** HumanSoldier "Team" (level 1 enemies: 1). */
  team: number;
  /** The ray from the camera to the human's eye reaches it (nothing in between). */
  lineOfSight: boolean;
}

interface Slot {
  id: number | null;
  seen: boolean;
  clear: boolean;
  notTeam1: boolean;
  halfSize: number;
  depth: number;
  lastSeen: number;
  firstSeen: number;
  x: number;
  y: number;
}

const SQUARE: readonly number[] = [-1, -1, 1, -1, 1, 1, -1, 1, -1, -1];

export class BinocularTargets {
  readonly slots: Slot[] = Array.from({ length: 10 }, () => ({
    id: null, seen: false, clear: false, notTeam1: false, halfSize: 0, depth: 0, lastSeen: 0, firstSeen: 0, x: 0, y: 0,
  }));

  /** Drop every target (binoculars lowered / mission restart). */
  reset(): void {
    for (const s of this.slots) s.id = null;
  }

  /** The per-frame table update (first half of FUN_00470510). */
  update(candidates: readonly BinocularTargetInput[], nowMs: number): void {
    for (const s of this.slots) s.seen = false;
    for (const c of candidates) {
      if (!(c.depth > 0)) continue;
      let slot = this.slots.find((s) => s.id === c.id) ?? null;
      if (!slot) {
        slot = this.slots.find((s) => s.id === null) ?? this.slots.find((s) => s.depth > c.depth) ?? null;
        if (!slot) continue;
        slot.firstSeen = nowMs;
      }
      slot.id = c.id;
      slot.depth = c.depth;
      slot.seen = true;
      slot.halfSize = (c.radius * c.pixelsPerUnitAtUnitDepth) / c.depth;
      slot.clear = c.lineOfSight;
      slot.lastSeen = nowMs;
      slot.notTeam1 = c.team !== 1;
      slot.x = c.x;
      slot.y = c.y;
    }
  }

  /** Second half of FUN_00470510: forget stale slots and submit the squares. */
  submit(p: Painter, nowMs: number): void {
    for (const s of this.slots) {
      if (s.id === null) continue;
      if (!s.seen) {
        if (nowMs - s.lastSeen > 3000) s.id = null;
        continue;
      }
      if (!s.clear) continue;
      const colour = s.notTeam1 ? colour128(0, 128, 0, 1) : colour128(64, 0, 0, 1);
      let t = nowMs - s.firstSeen;
      t = t < 0 ? 0 : t < 251 ? t : 250;
      const angle = t * 0.004000000189989805 * 1.5707963705062866;
      const scale = (1 - t * 0.004000000189989805) * 10 + 1;
      const k = s.halfSize * scale;
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      const segs: number[] = [];
      for (let i = 0; i + 3 < SQUARE.length; i += 2) {
        const ax = SQUARE[i] * k;
        const ay = SQUARE[i + 1] * k;
        const bx = SQUARE[i + 2] * k;
        const by = SQUARE[i + 3] * k;
        segs.push(ax * c - ay * sn + s.x - 0.5, ax * sn + ay * c + s.y - 0.5, bx * c - by * sn + s.x - 0.5, bx * sn + by * c + s.y - 0.5);
      }
      p.lines(segs, colour);
    }
  }
}
