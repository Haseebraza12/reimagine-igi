/**
 * The level random-number generator of igi.exe (DAT_00577b78 + 0x2c).
 *
 * Recovered (read from igi.exe for this port):
 *   - FUN_004aaa00 initialises the three-word state to
 *     {0xc8fb1a07, 0x39ea7756, 0x7ff13ccd}.
 *   - FUN_004aaac0(state, seed): init, then s0 ^= seed, s1 += seed << 15,
 *     s2 -= seed << 9.
 *   - FUN_00415c90 seeds both level generators (+0x2c and +0x38) with the
 *     constant 0x19111911 at level start.
 *   - FUN_004aaa20 steps: s2 ^= s0 >> 7 (logical); s1 ^= s2; s0 += s1;
 *     returns s0.
 *   - FUN_004aaa50 = step, then (s0 & 0xffff) * 2^-16 (double 0x532a88).
 *   - FUN_004aaaa0(n) = step, then s0 % n (unsigned div).
 * Users of +0x2c in the AI: AIFunction_GetRandomValue (FUN_0044ce40), the
 * reaction delay of every pushed action (FUN_0044fc40 / FUN_0044fce0), the
 * animation interval (FUN_0044e260), the bullet-vs-player filter
 * (FUN_0045d100), the evasive / fire-sequence / grenade draws (docs/ai.md).
 *
 * Port note: other port subsystems (sound selection, spread) draw from their
 * own sources, so the global draw order matches the exe only within the AI.
 */
export const LEVEL_RNG_INIT: readonly [number, number, number] = [0xc8fb1a07, 0x39ea7756, 0x7ff13ccd];
export const LEVEL_RNG_SEED = 0x19111911;

export class LevelRng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  /** Number of steps taken since the last seed (diagnostics / tests). */
  draws = 0;

  constructor(seed = LEVEL_RNG_SEED) {
    this.seed(seed);
  }

  /** FUN_004aaac0. */
  seed(seed: number): void {
    const s = seed >>> 0;
    this.s0 = (LEVEL_RNG_INIT[0] ^ s) >>> 0;
    this.s1 = (LEVEL_RNG_INIT[1] + ((s << 15) >>> 0)) >>> 0;
    this.s2 = (LEVEL_RNG_INIT[2] - ((s << 9) >>> 0)) >>> 0;
    this.draws = 0;
  }

  /** FUN_004aaa20: one step, returns the new s0 (u32). */
  step(): number {
    this.s2 = (this.s2 ^ (this.s0 >>> 7)) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 + this.s1) >>> 0;
    this.draws++;
    return this.s0;
  }

  /** FUN_004aaa50: uniform in [0, 1) with 16-bit resolution. */
  float(): number {
    return (this.step() & 0xffff) / 65536;
  }

  /** FUN_004aaaa0: s0 % n (n > 0). */
  int(n: number): number {
    const v = this.step();
    return n > 0 ? v % n : 0;
  }

  state(): [number, number, number] {
    return [this.s0, this.s1, this.s2];
  }
}
