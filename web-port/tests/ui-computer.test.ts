/**
 * The map computer of src/engine/ui (computer.ts, computer-draw.ts,
 * computer-world.ts) and the binocular target squares: recovered rules from
 * docs/hud.md section 11 checked on a synthetic world, plus the level-1 task
 * data when web-port/game-data is staged.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenTasks, readQvmCallTree, readTaskTree } from "../src/loaders";
import type { Vec3 } from "../src/contracts";
import { BinocularTargets } from "../src/engine/ui/binocular-targets";
import {
  ComputerLog,
  layoutComputerText,
  MAP_CAMERA_HEIGHT_M,
  MAP_PAN_UNITS,
  MapComputer,
  mapTan,
  PAGE,
  STARTUP_MARKER_FLAGS,
  type ComputerEnv,
  type ComputerHuman,
  type ComputerInput,
  type ComputerWorld,
} from "../src/engine/ui/computer";
import { createComputerWorld, parseTaskIdList } from "../src/engine/ui/computer-world";
import { drawComputer } from "../src/engine/ui/computer-draw";
import { PrimList } from "../src/engine/ui/painter";
import { RAW_ROOT, readRaw } from "./helpers";

const idle = (over: Partial<ComputerInput> = {}): ComputerInput => ({ dx: 0, dy: 0, left: false, right: false, wheelUp: false, wheelDown: false, ...over });

function world(over: Partial<ComputerWorld> = {}, ground = 10): ComputerWorld {
  const soldiers: ComputerHuman[] = [
    { id: 7, position: [60, ground, 150], yaw: 0, team: 1, alive: true },
    { id: 8, position: [-10, ground, 5], yaw: 1, team: 1, alive: false },
  ];
  return {
    player: () => ({ id: 0, position: [100, ground, 200], yaw: 0.5, team: 0, alive: true }),
    soldiers: () => soldiers,
    cameras: () => [],
    hilights: () => [{ taskId: 1120, position: [120, ground, 180], sprite: "h_1.spr", marker: -1, markerColour: -1, title: "Garage", info: "The garage" }],
    objectives: () => [
      { text: "Steal the truck near the main entrance.", link: 1120, complete: false, failed: false },
      ...Array.from({ length: 5 }, () => ({ text: "", link: -1, complete: false, failed: false })),
    ],
    taskPosition: (id) => (id === 1120 ? [120, ground, 180] : null),
    // A flat ground plane at y = ground.
    ray: (o: Vec3, d: Vec3, max: number) => {
      if (d[1] >= 0) return null;
      const t = (ground - o[1]) / d[1];
      return t >= 0 && t <= max ? [o[0] + d[0] * t, ground, o[2] + d[2] * t] : null;
    },
    ...over,
  };
}

function env(w = world(), log: string[] = []): ComputerEnv & { log: string[] } {
  let seed = 1;
  return {
    log,
    world: w,
    res: {
      spriteSize: (name) => (name.startsWith("arrow") || name.startsWith("plus") || name.startsWith("minus") ? { w: 16, h: 16 } : name.startsWith("sphere") ? { w: 34, h: 34 } : { w: 30, h: 30 }),
      measure: (_f, t) => ({ w: t.length * 8, h: 21 }),
      buttonLabelHeight: 0,
      text: (k) => ({ OBJECTIVES: "Objectives", LOG: "Log", MAP: "Map" } as Record<string, string>)[k] ?? k,
    },
    rng: {
      float: () => ((seed = (seed * 1103515245 + 12345) >>> 0) & 0xffff) / 65536,
      int: (n) => (seed = (seed * 1103515245 + 12345) >>> 0) % n,
    },
    sound: (n) => log.push(n),
    mapEnabled: () => true,
  };
}

/** Move the pointer onto (x, y) from wherever it is. */
function moveTo(c: MapComputer, x: number, y: number): void {
  c.tick(idle({ dx: x - c.pointer.x, dy: y - c.pointer.y }));
}

describe("map computer (FUN_0046a690 / ComputerMap)", () => {
  it("opens on the map page centred 225 m above the player, zoom 0 = 90 degrees", () => {
    const c = new MapComputer(env());
    expect(c.page).toBe(PAGE.map);
    const v = c.view()!;
    expect(v.position).toEqual([100, 10 + MAP_CAMERA_HEIGHT_M, 200]);
    expect(MAP_CAMERA_HEIGHT_M).toBe(225);
    expect(v.tanX).toBe(Math.fround(Math.tan(0.7853981852531433)));
    expect(v.fovYDegrees).toBeCloseTo((2 * Math.atan(0.75 * v.tanX) * 180) / Math.PI, 9);
    expect(c.pointer).toEqual({ x: 320, y: 240 });
  });

  it("zoom tangents: fptan of the float32 angles at 0x53d700", () => {
    expect(mapTan(0)).toBeCloseTo(1, 6);
    expect(mapTan(1)).toBeCloseTo(0.339, 3);
    expect(mapTan(2)).toBeCloseTo(0.1405, 4);
    expect(mapTan(3)).toBeCloseTo(0.0096, 4);
  });

  it("startup: INITIALIZING 10 ticks, CONNECTING 5, DOWNLOADING 10; markers 4 -> 0x15 -> 0x1f", () => {
    const c = new MapComputer(env());
    const seen: Array<[number, number]> = [];
    for (let i = 0; i < 30; i++) {
      c.tick(idle());
      seen.push([c.map.startup.running ? c.map.startup.step : -1, c.map.markerFlags]);
    }
    expect(seen[8]).toEqual([0, 0]);
    expect(seen[9]).toEqual([1, STARTUP_MARKER_FLAGS[0]]); // tick 10: 9 < 10
    expect(seen[13]).toEqual([1, 4]);
    expect(seen[14]).toEqual([2, 0x15]); // 4.5 < 5
    expect(seen[24]).toEqual([-1, 0x1f]);
  });

  it("interference: starts at 1.0, falls 1/30 per tick, then random bursts 0.1..0.5 every 15..89 ticks", () => {
    const c = new MapComputer(env());
    expect(c.map.noise).toBe(1);
    c.tick(idle());
    expect(c.map.noise).toBe(Math.fround(1 - 0.03333333507180214));
    for (let i = 0; i < 70; i++) c.tick(idle());
    // 60 ticks after the start a burst came; it decays again.
    expect(c.map.noise).toBeLessThan(0.5);
  });

  it("pointer moves by the mouse and is clamped to the recovered margins", () => {
    const c = new MapComputer(env());
    c.tick(idle({ dx: -1000, dy: -1000 }));
    expect(c.pointer.x).toBeCloseTo(640 * 0.04843749850988388, 4);
    expect(c.pointer.y).toBeCloseTo(480 * 0.05416666716337204, 4);
    c.tick(idle({ dx: 2000, dy: 2000 }));
    expect(c.pointer.x).toBeCloseTo(640 - 640 * 0.04531250149011612, 4);
    expect(c.pointer.y).toBeCloseTo(480 - 480 * 0.09583333134651184, 4);
  });

  it("+ button: zoom in on the press edge, mapcomp_01 click, burst + mapcomp_05 / mapcomp_03, markers hidden, startup restarts", () => {
    const log: string[] = [];
    const c = new MapComputer(env(world(), log));
    for (let i = 0; i < 30; i++) c.tick(idle());
    expect(c.map.markerFlags).toBe(0x1f);
    moveTo(c, 486 + 4, 390 + 4);
    c.tick(idle({ left: true }));
    expect(c.zoom).toBe(1);
    expect(log).toEqual(["mapcomp_01", "mapcomp_05", "mapcomp_03"]);
    expect(c.map.markerFlags).toBe(0);
    expect(c.map.startup).toMatchObject({ running: true, step: 0 });
    expect(c.map.noise).toBeGreaterThan(0.9);
    // Held: no repeat.
    c.tick(idle({ left: true }));
    expect(c.zoom).toBe(1);
  });

  it("up arrow pans north (-z) by 27306.666 x tan^0.7 units per held tick and stops tracking", () => {
    const c = new MapComputer(env());
    moveTo(c, 511 + 4, 295 + 4);
    const z0 = c.view()!.position[2];
    c.tick(idle({ left: true }));
    const z1 = c.view()!.position[2];
    expect(z0 - z1).toBeCloseTo(MAP_PAN_UNITS / 4096, 6);
  });

  it("wheel up zooms in; a double left click zooms in; a double right click zooms out", () => {
    const c = new MapComputer(env());
    moveTo(c, 200, 200);
    c.tick(idle({ wheelUp: true }));
    expect(c.zoom).toBe(1);
    c.tick(idle({ left: true }));
    c.tick(idle());
    c.tick(idle({ left: true }));
    expect(c.zoom).toBe(2);
    c.tick(idle());
    c.tick(idle({ right: true }));
    c.tick(idle());
    expect(c.zoom).toBe(2);
    c.tick(idle({ right: true }));
    expect(c.zoom).toBe(1);
  });

  it("a single click on the ground recentres the map on the clicked point", () => {
    const c = new MapComputer(env());
    for (let i = 0; i < 20; i++) c.tick(idle());
    moveTo(c, 320 + 64, 240);
    c.tick(idle({ left: true }));
    const v = c.view()!;
    // 64 px right of centre at zoom 0 (tan 1, 225 m): 64 / 320 x 225 = 45 m east.
    expect(v.position[0]).toBeCloseTo(100 + 45, 3);
    expect(v.position[2]).toBeCloseTo(200, 3);
  });

  it("clicking near a soldier tracks it (within 10 m x sqrt(tan))", () => {
    const c = new MapComputer(env());
    for (let i = 0; i < 20; i++) c.tick(idle());
    // Soldier 7 at (60, 150): screen = 320 + 320 (60-100)/225, 240 + 320 (150-200)/225.
    moveTo(c, 320 + (320 * (60 - 100)) / 225, 240 + (320 * (150 - 200)) / 225);
    c.tick(idle({ left: true }));
    expect(c.map.tracking).toEqual({ kind: "soldier", id: 7 });
    expect(c.view()!.position[0]).toBeCloseTo(60, 3);
  });

  it("markers: player triangle always; soldiers (alive) only at zoom 1 and 2, red for team 1; hilight titles at zoom 1", () => {
    const c = new MapComputer(env());
    for (let i = 0; i < 30; i++) c.tick(idle());
    let m = c.markers();
    expect(m.filter((x) => x.kind === "shape").map((x) => x.kind === "shape" && [x.shape, x.colour])).toEqual([[2, 3]]);
    expect(m.find((x) => x.kind === "sprite")).toMatchObject({ sprite: "h_1.spr" });
    expect(m.some((x) => x.kind === "text")).toBe(false);
    c.tick(idle({ wheelUp: true }));
    for (let i = 0; i < 30; i++) c.tick(idle());
    m = c.markers();
    expect(m.filter((x) => x.kind === "shape").map((x) => x.kind === "shape" && [x.shape, x.colour])).toEqual([[2, 3], [1, 0]]);
    expect(m.find((x) => x.kind === "text")).toMatchObject({ text: "Garage" });
  });

  it("page texts switch pages on the next tick; objective buttons jump to the linked task on the map", () => {
    const c = new MapComputer(env());
    moveTo(c, 64 + 3, 388 + 15);
    c.tick(idle({ left: true }));
    expect(c.page).toBe(PAGE.map);
    c.tick(idle());
    expect(c.page).toBe(PAGE.objectives);
    expect(c.view()).toBeNull();
    // The objectives draw places button 3 next to objective 1.
    drawComputer(new PrimList(), c, { computer: { sprites: new Map(), fonts: new Map(), pictures: new Map() }, ingame: { sprites: new Map(), fonts: new Map(), pictures: new Map() }, text: (k) => k },
      { log: new ComputerLog(), objectives: env().world.objectives(), mapEnabled: true, filterRandom: () => 0.5 });
    const b = c.itemList.find((i) => i.id === 3)!;
    expect([b.x, b.y]).toEqual([96 - 34, 48 + 2]);
    moveTo(c, b.x + 5, b.y + 5);
    c.tick(idle({ left: true }));
    c.tick(idle());
    expect(c.page).toBe(PAGE.map);
    expect(c.view()!.position[0]).toBeCloseTo(120, 6);
  });

  it("log: 50 entries, oldest dropped", () => {
    const log = new ComputerLog();
    for (let i = 0; i < 55; i++) log.add(`m${i}`);
    expect(log.entries.length).toBe(50);
    expect(log.entries[0]).toBe("m5");
  });

  it("FUN_00467fe0 word layout: words keep their space, wrap when the word does not fit the room left", () => {
    const lay = layoutComputerText("aaa bbb ccc", 10, 20, 90, (w) => w.length * 10, 11);
    expect(lay.words).toEqual([
      { text: "aaa ", x: 10, y: 20 },
      { text: "bbb ", x: 50, y: 20 },
      { text: "ccc", x: 10, y: 31 },
    ]);
    expect(lay.bottom).toBe(42);
  });
});

describe("binocular target squares (FUN_00470510)", () => {
  it("keeps 10 slots, shrinks from 11x over 250 ms, forgets after 3 s unseen", () => {
    const t = new BinocularTargets();
    const target = { id: 5, x: 300, y: 200, depth: 50, radius: 0.5, pixelsPerUnitAtUnitDepth: 1000, team: 1, lineOfSight: true };
    t.update([target], 1000);
    const p = new PrimList();
    t.submit(p, 1000);
    expect(p.labels).toEqual(["lines"]);
    expect(t.slots[0]).toMatchObject({ id: 5, halfSize: 10, notTeam1: false, firstSeen: 1000 });
    t.update([], 2000);
    t.submit(new PrimList(), 2000);
    expect(t.slots[0].id).toBe(5);
    t.update([], 4001);
    t.submit(new PrimList(), 4001);
    expect(t.slots[0].id).toBeNull();
  });

  it("a full table replaces the first farther target", () => {
    const t = new BinocularTargets();
    t.update(Array.from({ length: 10 }, (_, i) => ({ id: i, x: 0, y: 0, depth: 100 + i, radius: 1, pixelsPerUnitAtUnitDepth: 1, team: 1, lineOfSight: true })), 0);
    t.update([{ id: 99, x: 0, y: 0, depth: 50, radius: 1, pixelsPerUnitAtUnitDepth: 1, team: 0, lineOfSight: true }], 10);
    expect(t.slots[0].id).toBe(99);
  });
});

describe("level 1 computer data (objects.qvm)", () => {
  const path = "missions/location0/level1/objects.qvm";
  it.skipIf(!existsSync(`${RAW_ROOT}/${path}`))("17 hilights, one objective linked to 1120, the garage carries h_1.spr", async () => {
    const tasks = flattenTasks(readTaskTree(readQvmCallTree(await readRaw(path))));
    const spawn = tasks.find((t) => t.type === "HumanPlayer")!.params.Position as number[];
    const ctx = {
      player: { position: [0, 0, 0] as Vec3, yaw: 0, alive: true },
      level: { tasks, originIgi: [spawn[0], spawn[1], spawn[2]] },
    } as unknown as Parameters<typeof createComputerWorld>[0];
    const w = createComputerWorld(ctx, { lookup: (k) => (k === "M1_OBJ1" ? "Steal the truck near the main entrance." : null) });
    expect(w.mapEnabled()).toBe(true);
    const h = w.hilights();
    expect(h.length).toBe(17);
    expect(h.filter((x) => x.sprite).map((x) => [x.taskId, x.sprite])).toEqual([[1120, "h_1.spr"]]);
    expect(h.find((x) => x.taskId === 1104)).toMatchObject({ title: "RM: WATERTOWER_TITLE" });
    const o = w.objectives()!;
    expect(o[0]).toMatchObject({ text: "Steal the truck near the main entrance.", link: 1120, complete: false });
    expect(o.slice(1).every((x) => x.text === "")).toBe(true);
    expect(w.cameras().length).toBe(5);
  });

  it("TaskID lists: numbers, '-' ranges (FUN_00467200)", () => {
    expect(parseTaskIdList("1120")).toEqual([1120]);
    expect(parseTaskIdList("1104-1107 1120")).toEqual([1104, 1105, 1106, 1107, 1120]);
  });
});
