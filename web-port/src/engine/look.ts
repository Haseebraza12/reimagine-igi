/**
 * Mouse look as igi.exe does it, once per 30 Hz tick (docs/gameplay.md
 * "Look (mouse and keys)") [recovered]:
 *
 *   - FUN_004e40e0 polls DirectInput once per InputPort update (per tick);
 *     FUN_0048e030 stores lX and lY x 1/255 (f64 0x532240) as float32.
 *   - FUN_004e3c41 adds the turn / look key ramps (no turn keys are bound in
 *     the shipped config) and clamps each axis to [-1, 1]; the record lands
 *     on the human's controller channels (turn +0x1b0, look +0x1b4).
 *   - FUN_00463470 (pitch): unless zoomed the channel is averaged with the
 *     previous tick's, c = (c + c_prev) x 0.5 (the zoom test compares the
 *     view's float tanX with fptan(pi/4) stored as float32 = 1.0). The yaw
 *     test in FUN_0045fd00 (0x45ff17) compares with the unrounded extended
 *     fptan result (1.0000000437), which never equals the float 1.0: yaw is
 *     never smoothed. The step is c x pi x tanX (yaw negative: a
 *     positive lX turns right), divided by (2 - 16.667 |c|) while
 *     |c| < 0.06; pitch is clamped to +-pi/2 (f32).
 *   - FUN_0045cde0 builds the human's channels from the clamped port values:
 *     channel 1 negated while config +0x538 is set ("Invert Mouse: No";
 *     `invertY = false`), then both scaled by the sensitivity clamp(config
 *     +0x53c, 0.05 (0x5315c0), 1.0) - GOInMouSens, shipped 0.4. A positive lY
 *     (mouse moved toward the player) raises the view without the negation.
 * The view only turns on ticks, as in the exe (no per-frame interpolation).
 */
import { x87StoreF32 } from "../loaders/x87";

/** DirectInput counts -> channel units (f64 1/255 at 0x532240). */
const COUNT_SCALE = 0.00392156862745098;
const SMOOTH = 0.5; // f64 0x531580
const SMALL = Math.fround(0.05999999865889549); // 0x531938
const SMALL_A = Math.fround(2); // (float)f64 0x531928
const SMALL_B = Math.fround(16.666666666666668); // (float)f64 0x531930
const PI_F = Math.fround(3.1415927410125732); // 0x531400
const PITCH_LIMIT = Math.fround(1.5707963705062866); // 0x531468 / 0x5319c8
const SENS_MIN = Math.fround(0.05000000074505806); // 0x5315c0

/** FUN_0048e030 + FUN_004e3c41: one axis, counts -> clamped float channel. */
export function lookChannel(counts: number): number {
  const v = x87StoreF32(counts * COUNT_SCALE);
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** FUN_0045cde0: the sensitivity factor clamp(GOInMouSens, 0.05, 1.0) as float32. */
export function lookSensitivity(sens: number): number {
  const s = Math.fround(sens);
  return s < SENS_MIN ? SENS_MIN : s > 1 ? 1 : s;
}

/** The angle step for channel `c` (already smoothed): c pi tanX, eased below |c| 0.06. */
export function lookStep(c: number, tanX: number): number {
  let step = x87StoreF32(c * PI_F * tanX);
  const a = Math.abs(c);
  if (a < SMALL) step = x87StoreF32(step / (SMALL_A - a * SMALL_B));
  return step;
}

export class LookController {
  private prevLook = 0;

  /** Forget the previous tick's channels (mission start, regaining control). */
  reset(): void {
    this.prevLook = 0;
  }

  /**
   * One tick. `dx`, `dy`: mouse counts since the last tick (browser
   * movementX / movementY, positive right / down like lX / lY); `tanX`: the
   * view's horizontal half-FOV tangent (1 unzoomed). Returns the new engine
   * yaw (radians, CCW from above like IGI gamma) and pitch (up positive).
   */
  tick(dx: number, dy: number, tanX: number, yaw: number, pitch: number, invertY = true, sensitivity = 1): { yaw: number; pitch: number } {
    const k = lookSensitivity(sensitivity);
    const turn = x87StoreF32(k * lookChannel(dx));
    const look = x87StoreF32(k * lookChannel(invertY ? dy : -dy));
    const unzoomed = tanX === 1;
    const t = turn; // never smoothed (0x45ff17: extended fptan vs float tanX)
    const l = unzoomed ? x87StoreF32((look + this.prevLook) * SMOOTH) : look;
    this.prevLook = look;
    const newYaw = x87StoreF32(yaw - lookStep(t, tanX));
    let newPitch = x87StoreF32(pitch + lookStep(l, tanX));
    if (newPitch < -PITCH_LIMIT) newPitch = -PITCH_LIMIT;
    else if (newPitch > PITCH_LIMIT) newPitch = PITCH_LIMIT;
    return { yaw: newYaw, pitch: newPitch };
  }
}
