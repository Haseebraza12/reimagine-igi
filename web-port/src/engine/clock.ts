/**
 * Frame clock with an optional fixed-timestep accumulator.
 *
 * The reference engine's true timing model is not yet established (docs/
 * roadmap Phase 3 notes a fixed timestep is an *initial implementation choice*
 * to be validated against the original). We therefore default to a variable
 * real-time step clamped against tab-switch spikes, and expose an accumulator
 * so gameplay can opt into a fixed step later without rewriting call sites.
 * Confidence: inferred (implementation choice, not recovered behaviour).
 */

/** Largest single-frame delta we honour (guards against background-tab jumps). */
const MAX_DELTA_SECONDS = 0.1;

export class Clock {
  /** Seconds since start(), smoothed by the frame delta. */
  elapsed = 0;

  private lastMs: number | null = null;
  private accumulator = 0;

  constructor(private readonly fixedStep = 1 / 60) {}

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
