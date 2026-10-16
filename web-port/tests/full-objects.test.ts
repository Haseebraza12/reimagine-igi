/**
 * The object tasks on the full game's missions (game-data; skipped without it):
 * every mission's runtime runs with the registered behaviours, the elevators
 * find their splines, and the data-driven rules of docs/objects.md hold.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MissionRuntime, elevatorRig, readMissionTasks } from "../src/loaders";
import { LevelRng } from "../src/engine/ai/rng";

const FULL = fileURLToPath(new URL("../game-data", import.meta.url));
const haveFull = existsSync(`${FULL}/missions/location0/level14/objects.qvm`);
const tasksOf = (id: number) => {
  const b = readFileSync(`${FULL}/missions/location0/level${id}/objects.qvm`);
  return readMissionTasks(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

describe.skipIf(!haveFull)("object tasks on the full game", () => {
  it("every mission ticks with the behaviours; every elevator has its floors", () => {
    let elevators = 0;
    for (let id = 1; id <= 14; id++) {
      const rng = new LevelRng();
      const warnings: string[] = [];
      const rt = new MissionRuntime(tasksOf(id), { randomInt: (n) => rng.int(n), random: () => rng.float(), warn: (m) => warnings.push(m) });
      for (let i = 0; i < 90; i++) rt.tick();
      for (const n of rt.tasks.nodes) {
        if (n.type !== "Elevator") continue;
        elevators++;
        const rig = elevatorRig(rt, n.index)!;
        expect(rig.rail).not.toBeNull();
        expect(rig.floors.length).toBeGreaterThanOrEqual(2);
        expect(rig.total).toBeGreaterThan(0);
        const s = rt.nodeState(n.index);
        expect(s.pos).toBeGreaterThanOrEqual(0);
        expect(s.pos).toBeLessThanOrEqual(rig.total);
      }
    }
    expect(elevators).toBe(16);
  });

  it("L3 Elevator_698 rises 30.5 m in two floors; L5 / L8 lifts have three", () => {
    const l3 = new MissionRuntime(tasksOf(3));
    const rig = elevatorRig(l3, l3.tasks.byId.get(698)!)!;
    expect(rig.floors.length).toBe(2);
    // "Linear Segments" false: the Hermite polyline with horizontal tangents is longer than the 30.5 m chord.
    expect(rig.total).toBeGreaterThan(174546368 - 174421536);
    for (const [level, id] of [[5, 51], [8, 811]] as const) {
      const rt = new MissionRuntime(tasksOf(level));
      expect(elevatorRig(rt, rt.tasks.byId.get(id)!)!.floors.length).toBe(3);
    }
  });

  it("L12 Generator_99 (no On expression, 10 s backup) is off for 300 ticks, then on", () => {
    const rt = new MissionRuntime(tasksOf(12));
    const node = rt.tasks.byId.get(99)!;
    expect(rt.tasks.nodes[node].type).toBe("Generator");
    for (let i = 0; i < 300; i++) {
      rt.tick();
      expect(rt.nodeState(node).isOn).toBe(0);
    }
    rt.tick();
    expect(rt.nodeState(node).isOn).toBe(1);
  });
});
