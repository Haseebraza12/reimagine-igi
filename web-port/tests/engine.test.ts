/**
 * Backbone unit tests for the pure-logic engine modules (no DOM/WebGL needed):
 * frame Clock, typed EventBus, and bilinear TerrainField.
 */
import { describe, expect, it, vi } from "vitest";
import { Clock } from "../src/engine/clock";
import { EventBus, GameEvent } from "../src/engine/events";
import { TerrainField } from "../src/engine/terrain";
import type { TerrainData } from "../src/contracts";

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

// ---------------------------------------------------------------------------
describe("TerrainField", () => {
  // Grid where h[x,z] = z*size + x (bilinear-friendly increasing field).
  const size = 3;
  const heights = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const terrain: TerrainData = { size, cellSize: 1, heights };
  const field = new TerrainField(terrain);

  it("returns exact heights at integer vertices", () => {
    expect(field.heightAt(0, 0)).toBeCloseTo(0, 5);
    expect(field.heightAt(1, 0)).toBeCloseTo(1, 5);
    expect(field.heightAt(0, 1)).toBeCloseTo(3, 5);
    expect(field.heightAt(1, 1)).toBeCloseTo(4, 5);
  });

  it("bilinearly interpolates between vertices", () => {
    expect(field.heightAt(0.5, 0)).toBeCloseTo(0.5, 5);
    expect(field.heightAt(0.5, 0.5)).toBeCloseTo(2, 5); // avg(0,1,3,4)
  });

  it("clamps sampling outside the grid to the nearest edge height", () => {
    expect(field.heightAt(-10, -10)).toBeCloseTo(0, 5);
    expect(field.heightAt(99, 99)).toBeCloseTo(8, 5);
  });

  it("computeVertexNormals-free normalAt points up on a flat field", () => {
    const flat = new TerrainField({ size, cellSize: 1, heights: new Float32Array(9).fill(5) });
    const [nx, ny, nz] = flat.normalAt(1, 1);
    expect(ny).toBeGreaterThan(0.9);
    expect(Math.abs(nx)).toBeLessThan(1e-6);
    expect(Math.abs(nz)).toBeLessThan(1e-6);
  });

  it("groundHeightAfterMove blocks a step that exceeds maxStep, allows smaller", () => {
    // Standing at height 0 near the z=1 edge (heights 3); a 1-step jump.
    const allowed = field.groundHeightAfterMove(0, 0, 0, 1.2); // h=0 within 1.2 of 0
    expect(allowed).toBeCloseTo(0, 5);
    // Moving onto the z=1 edge (h=3) from currentY=0: 3-0 > 1.2 -> blocked.
    const blocked = field.groundHeightAfterMove(0, 1, 0, 1.2);
    expect(blocked).toBe(0);
    // A tall maxStep allows it.
    const stepped = field.groundHeightAfterMove(0, 1, 0, 3.0);
    expect(stepped).toBeCloseTo(3, 5);
  });

  it("respects a world offset when mapping world XZ to grid vertices", () => {
    const offset = new TerrainField(terrain, [-256, 0, -256]);
    // World (0,0) maps to grid vertex (0,0) after subtracting offset -256 / cellSize 1.
    expect(offset.heightAt(-256, -256)).toBeCloseTo(0, 5);
    expect(offset.heightAt(-255, -255)).toBeCloseTo(4, 5); // vertex (1,1) -> 4
  });
});
