/**
 * One pellet's direction as igi.exe's gun fire computes it (FUN_004772c0)
 * [recovered]:
 *
 *   spread = |("Minimum" for the first 4 shots of a hold, else "Maximum"
 *             random spread) x 0.017453292 (f32 0x531684)|
 *   only while spread != 0, per pellet (level RNG, FUN_00415c20 ->
 *   FUN_004aaa50):
 *     c = 1; three times c = f32(r x c)             (cube of uniforms)
 *     b = f32(r x 6.2831855 (f32 0x531594))         (azimuth)
 *     D = F . Rz(0) Ry(b) Rx(c x spread)            (FUN_004a9bc0)
 *   F = FUN_00486a60(aim): columns x, y = aim, z (below); the bullet flies
 *   along D's column y (the gun matrix +0x74/+0x80/+0x8c is its aim):
 *     dir = cos a . aim + sin a . (sin b . x + cos b . z)
 *
 * Frame FUN_00486a60 (docs/wire.md "Frame"): |aim.z| <= 0.95 (f32 0x531658):
 * x = normalize(aim x Z), z = normalize(x x aim); otherwise
 * z = normalize(X x aim), x = normalize(aim x z). Engine space (x, y up,
 * z = -north) is a proper rotation of IGI space, so the cross products carry
 * over with IGI Z = engine +y and IGI X = engine +x.
 */
import type { Vec3 } from "../../contracts";
import { x87StoreF32 } from "../../loaders/x87";

const DEG_TO_RAD_F = Math.fround(0.01745329238474369); // 0x531684
const TWO_PI_F = Math.fround(6.2831854820251465); // 0x531594
const STEEP_F = Math.fround(0.949999988079071); // 0x531658

/** The spread angle unit of a shot: |spreadDeg x 0.017453292| (f32), 0 means no draws. */
export function spreadRadians(spreadDeg: number): number {
  return Math.abs(x87StoreF32(Math.fround(spreadDeg) * DEG_TO_RAD_F));
}

/** The four RNG draws of one pellet: the cone angle (radians) and the azimuth. */
export function drawPellet(spreadRad: number, random: () => number): { angle: number; azimuth: number } {
  let c = 1;
  for (let i = 0; i < 3; i++) c = x87StoreF32(random() * c);
  const azimuth = x87StoreF32(random() * TWO_PI_F);
  return { angle: x87StoreF32(c * spreadRad), azimuth };
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : v;
}

function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** FUN_00486a60's x and z axes for the unit `aim` (engine space). */
export function aimFrame(aim: readonly number[]): { x: Vec3; z: Vec3 } {
  if (Math.abs(aim[1]) <= STEEP_F) {
    const x = normalize(cross(aim, [0, 1, 0]));
    return { x, z: normalize(cross(x, aim)) };
  }
  const z = normalize(cross([1, 0, 0], aim));
  return { x: normalize(cross(aim, z)), z };
}

/** The pellet direction for cone angle `angle` at azimuth `azimuth` around the unit `aim` (engine space). */
export function pelletDirection(aim: readonly number[], angle: number, azimuth: number): Vec3 {
  const { x, z } = aimFrame(aim);
  const ca = Math.fround(Math.cos(angle));
  const sa = Math.fround(Math.sin(angle));
  const sb = Math.fround(Math.sin(azimuth));
  const cb = Math.fround(Math.cos(azimuth));
  return normalize([
    ca * aim[0] + sa * (sb * x[0] + cb * z[0]),
    ca * aim[1] + sa * (sb * x[1] + cb * z[1]),
    ca * aim[2] + sa * (sb * x[2] + cb * z[2]),
  ]);
}
