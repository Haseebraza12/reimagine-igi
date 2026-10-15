/**
 * Frame clock with the original's fixed game tick.
 *
 * igi.exe runs all game logic at a fixed 30 ticks per second (GAME_FREQUENCY =
 * 30; FUN_004020b0 -> FUN_004029a0(0x1e)) and renders between ticks
 * [recovered: docs/rendering.md, docs/qvm-vm.md]. The engine accumulates real
 * time and runs whole ticks; rendering shows the latest tick's state.
 */

/** Game logic rate of igi.exe [recovered]. */
export const TICKS_PER_SECOND = 30;
/** Seconds per game tick. */
export const TICK_SECONDS = 1 / TICKS_PER_SECOND;

/** Largest single-frame delta we honour (guards against background-tab jumps). */
const MAX_DELTA_SECONDS = 0.1;

export class Clock {
  /** Seconds since start(), smoothed by the frame delta. */
  elapsed = 0;

  private lastMs: number | null = null;
  private accumulator = 0;

  constructor(private readonly fixedStep = TICK_SECONDS) {}

  /** Reset the clock (call when the level restarts). */
  reset(): void {
    this.lastMs = null;
    this.elapsed = 0;
    this.accumulator = 0;
  }

  /**
   * Advance the clock to wall-clock time `nowMs` (performance.now() domain).
   * @returns the clamped frame delta in seconds (never larger than MAX_DELTA).
   */
  tick(nowMs: number): number {
    if (this.lastMs === null) {
      this.lastMs = nowMs;
      return 0;
    }
    const rawSeconds = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    const delta = Math.min(Math.max(rawSeconds, 0), MAX_DELTA_SECONDS);
    this.elapsed += delta;
    this.accumulator += delta;
    return delta;
  }

  /**
   * Consume the accumulated time in fixed steps. Calls `step(fixedStep)` once
   * per whole step and returns how many ran. Use for deterministic gameplay;
   * ignore this and use `tick()`'s delta directly for a variable step.
   */
  consumeFixedSteps(): number {
    const steps = Math.floor(this.accumulator / this.fixedStep);
    this.accumulator -= steps * this.fixedStep;
    return steps;
  }

  /** Seconds carried over that did not fill a whole fixed step. */
  get interpolationAlpha(): number {
    return this.accumulator / this.fixedStep;
  }
}
