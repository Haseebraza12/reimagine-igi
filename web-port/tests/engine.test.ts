/**
 * Backbone unit tests for the pure-logic engine modules (no DOM/WebGL needed):
 * frame Clock and typed EventBus.
 */
import { describe, expect, it, vi } from "vitest";
import { Clock } from "../src/engine/clock";
import { EventBus, GameEvent } from "../src/engine/events";

// ---------------------------------------------------------------------------
describe("Clock", () => {
  it("returns 0 on the first tick (no delta known yet)", () => {
    const clock = new Clock();
    expect(clock.tick(1000)).toBe(0);
  });

  it("accumulates elapsed time from successive ticks", () => {
    const clock = new Clock();
    clock.tick(0);
    // 100 ms then 250 ms -> deltas 0.1 s and 0.25 s (clamped to 0.1 s).
    expect(clock.tick(100)).toBeCloseTo(0.1, 6);
    expect(clock.tick(350)).toBeCloseTo(0.1, 6); // 0.25 clamped to MAX_DELTA 0.1
    expect(clock.elapsed).toBeCloseTo(0.2, 6);
  });

  it("never returns a negative delta and clamps huge gaps (tab switch)", () => {
    const clock = new Clock();
    clock.tick(0);
    expect(clock.tick(-50)).toBe(0); // clock went backwards -> 0
    expect(clock.tick(10_000)).toBeCloseTo(0.1, 6); // 10 s gap clamped
  });

  it("consumeFixedSteps emits whole steps and keeps the remainder", () => {
    const clock = new Clock(1 / 60);
    clock.tick(0);
    clock.tick(50); // 0.05 s -> ~3 steps of 1/60 (0.05s = 3.0 steps)
    const steps = clock.consumeFixedSteps();
    expect(steps).toBe(3);
    // Remainder carried: 0.05 - 3*(1/60) ~ tiny.
    expect(clock.interpolationAlpha).toBeGreaterThanOrEqual(0);
    expect(clock.interpolationAlpha).toBeLessThan(1);
    // No new time -> nothing to consume.
    expect(clock.consumeFixedSteps()).toBe(0);
  });

  it("reset clears elapsed and the accumulator", () => {
    const clock = new Clock();
    clock.tick(0);
    clock.tick(500);
    clock.reset();
    expect(clock.elapsed).toBe(0);
    expect(clock.consumeFixedSteps()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("EventBus", () => {
  it("delivers payloads to every handler", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("x", a);
    bus.on("x", b);
    bus.emit("x", 42);
    expect(a).toHaveBeenCalledWith(42);
    expect(b).toHaveBeenCalledWith(42);
  });

  it("off removes a handler; unsubscribe return works too", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const on = bus.on("x", a);
    on(); // unsubscribe
    bus.emit("x", 1);
    expect(a).not.toHaveBeenCalled();
  });

  it("a throwing handler does not stop the others", () => {
    const bus = new EventBus();
    const good = vi.fn();
    const bad = () => {
      throw new Error("boom");
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.on("x", bad);
    bus.on("x", good);
    expect(() => bus.emit("x")).not.toThrow();
    expect(good).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("clear drops all handlers", () => {
    const bus = new EventBus();
    const a = vi.fn();
    bus.on(GameEvent.Fire, a);
    bus.clear();
    bus.emit(GameEvent.Fire);
    expect(a).not.toHaveBeenCalled();
  });
});
