/**
 * Whole-level assembly from the staged original files (skipped when absent).
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { decodeLevelTexture, loadIgiLevel, type IgiLevel } from "../src/loaders/level";
import { RAW_ROOT } from "./helpers";

const haveRaw = existsSync(`${RAW_ROOT}/missions/location0/level1/objects.qvm`) &&
  existsSync(`${RAW_ROOT}/magicobj/magicobj.qvm`) &&
  existsSync(`${RAW_ROOT}/language/english/objectives.res`);

describe.skipIf(!haveRaw)("loadIgiLevel (level 1)", () => {
  let level: IgiLevel;
  beforeAll(async () => {
    level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
  });

  it("names the mission from the language files", () => {
    expect(level.name).toBe("Trainyard");
    expect(level.description).toBe("Small coastline trainyard");
  });

  it("places the player at the origin (x/z) at the recorded heading", () => {
    expect(level.player.position[0]).toBeCloseTo(0, 6);
    expect(level.player.position[2]).toBeCloseTo(0, 6);
    // HumanPlayer z is 8,544 units (2.09 m) above the base ground (building z).
    expect(level.player.position[1]).toBeCloseTo(8544 / 4096, 6);
    expect(level.player.yaw).toBeCloseTo(3.09598708152771, 6);
    expect(level.player.weapons).toContain("WEAPON_ID_MP5SD");
    expect(level.player.ammo.AMMO_ID_919).toBe(49);
  });

  it("instantiates buildings with verified transforms", () => {
    // Four LargeFuelContainers stand 65,536 units (16 m) apart.
    const tanks = level.instances.filter((i) => i.model === "438_01_1" && i.magicType === null);
    expect(tanks).toHaveLength(4);
    const zs = tanks.map((t) => t.matrix[14]).sort((a, b) => a - b);
    expect(zs[1] - zs[0]).toBeCloseTo(16, 1);
    // Buildings sit on the base ground (engine y = 0).
    for (const t of tanks) expect(t.matrix[13]).toBeCloseTo(0, 6);
    // Every instance matrix is a proper rotation, except wires: stretched along
    // model y by length / 4096 (FUN_0043e590, docs/wire.md), rigid for collision.
    const det3 = (m: number[]) =>
      m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    const wires = level.instances.filter((i) => i.taskType === "Wire");
    expect(wires).toHaveLength(3);
    for (const i of level.instances) {
      if (i.taskType === "Wire") {
        // Model IGI y is engine -z (column 2 of the engine matrix).
        const stretch = Math.hypot(i.matrix[8], i.matrix[9], i.matrix[10]);
        expect(det3(i.matrix)).toBeCloseTo(stretch, 4);
        expect(det3(i.collisionMatrix!)).toBeCloseTo(1, 5);
      } else {
        expect(det3(i.matrix)).toBeCloseTo(1, 5);
      }
    }
    // The longest wire (3501) is 85.04 m (the model spans 1 m along y).
    expect(Math.max(...wires.map((w) => Math.hypot(w.matrix[8], w.matrix[9], w.matrix[10])))).toBeCloseTo(85.04, 1);
  });

  it("expands attachments (water tower stairs) and skips hidden helpers", () => {
    expect(level.instances.some((i) => i.model === "435_02_1")).toBe(true);
    expect(level.instances.some((i) => i.magicType === "TASKTYPE_DEATHZONE")).toBe(false);
    expect(level.instances.some((i) => i.glass)).toBe(true);
  });

  it("resolves every render group to a texture", () => {
    for (const model of level.models.values()) {
      for (const g of model.groups) {
        if (g.noMaterial) continue; // material 0xffff: drawn untextured (FUN_0052e5d0), e.g. 4 faces of the locomotive 605_01_1
        expect(g.texture).not.toBeNull();
        expect(level.textures.has(g.texture!)).toBe(true);
      }
    }
    const first = [...level.models.values()][0].groups[0].texture!;
    expect(decodeLevelTexture(level, first).rgba.length).toBeGreaterThan(0);
  });

  it("wires the real objective to the area beside the truck", () => {
    expect(level.objectives).toHaveLength(1);
    const objective = level.objectives[0];
    expect(objective.id).toBe("M1_OBJ1");
    expect(objective.text).toBe("Steal the truck near the main entrance.");
    expect(objective.area.taskId).toBe(200);
    const truck = level.instances.find((i) => i.taskId === 1099)!;
    const dx = objective.area.center[0] - truck.matrix[12];
    const dz = objective.area.center[2] - truck.matrix[14];
    expect(Math.hypot(dx, dz)).toBeLessThan(4);
  });

  it("wires Anya's area messages", () => {
    const ids = level.messages.map((m) => m.id).sort();
    expect(ids).toEqual(["M1_MSG_4", "M1_MSG_6", "M1_MSG_7"]);
    expect(level.messages.find((m) => m.id === "M1_MSG_4")!.text).toBe(
      "ANYA: The truck is in the garage on the far side of the base.",
    );
  });

  it("reads soldiers, weapons and sounds", () => {
    expect(level.soldiers).toHaveLength(29);
    expect(level.soldiers.filter((s) => s.team !== 0)).toHaveLength(28);
    const mp5 = level.weapons.get("WEAPON_ID_MP5SD")!;
    expect(mp5.roundsPerMinute).toBe(700);
    expect(mp5.roundsPerClip).toBe(32);
    expect(level.sounds.get("mp5sd_loop")?.sampleRate).toBe(44100);
    expect(mp5.reloadSounds).toEqual(["mp5_reload_1", "mp5_reload_2", "mp5_reload_3", "mp5_reload_4", "mp5_reload_5"]);
    expect(level.weapons.get("WEAPON_ID_GLOCK")!.reloadSounds).toEqual(["glock_reload_1", "glock_reload_2", "glock_reload_3"]);
    for (const name of [...mp5.reloadSounds, "guns_dry_1"]) expect(level.sounds.has(name)).toBe(true);
  });

  it("decodes the terrain around the mission area", () => {
    expect(level.terrain.detail.indices.length / 3).toBeGreaterThan(400000);
    // Render: the cells igi.exe draws from the spawn (all directions), each
    // with layers inside terrain.tex (18 layers) and, in the base, a lightmap.
    const [ground] = level.terrain.octree.heightsAt(level.origin[0], level.origin[1]);
    const cells = level.terrain.octree.selectCells({
      position: [level.origin[0], level.origin[1], ground + 1.7 * 4096],
      tanX: 1,
      tanY: 0.75,
      threshold: 163,
    });
    expect(cells.length).toBeGreaterThan(1000);
    expect(Math.min(...cells.map((c) => c.level))).toBe(7);
    for (const cell of cells.filter((c) => c.level === 16)) {
      const look = level.terrain.look.cellLook(cell, level.terrain.octree.cellGeometry(cell));
      for (const [b, a] of look.layers.values()) {
        expect(b).toBeLessThan(18);
        expect(a).toBeLessThan(18);
      }
      expect(look.lightmap).toBeGreaterThanOrEqual(0);
    }
    // The base ground decodes to the buildings' height (engine y ~ 0).
    const [h] = level.terrain.octree.heightsAt(level.origin[0], level.origin[1]);
    expect((h - level.origin[2]) / 4096).toBeCloseTo(0, 2);
    // Every engine-space terrain vertex is finite.
    expect(level.terrain.detail.positions.every(Number.isFinite)).toBe(true);
  });

  it("assigns baked .olm lightmaps per the recovered building instance lists", () => {
    // obj00014 is SecurityBuilding (400_20_1); entry 0 is the building model itself.
    const security = level.instances.find((i) => i.taskName === "SecurityBuilding" && i.model === "400_20_1")!;
    expect(security.lightmap).toBe("obj00014_00000");
    expect(level.lightmaps.get("obj00014_00000")).toMatchObject({ width: 256, height: 64 });
    expect(level.lightmaps.size).toBe(533); // LOD-1 entries of rendered parts
    const lit = level.instances.filter((i) => i.lightmap);
    expect(lit.every((i) => level.models.get(i.model)!.lightmapUv !== null)).toBe(true);
    // The four LargeFuelContainers have no LightmapInfo: vertex-lit.
    expect(level.instances.filter((i) => i.model === "438_01_1").every((i) => i.lightmap === null)).toBe(true);
  });

  it("uses the recovered sun direction (cos G cos B, -sin G cos B, sin B)", () => {
    const [x, y, z] = level.objectLight.sunDirection; // engine axes (IGI x, z, -y)
    expect(x).toBeCloseTo(0.1801, 3);
    expect(y).toBeCloseTo(0.5, 3);
    expect(z).toBeCloseTo(0.8471, 3);
  });

  it("gives soldiers the view and combat settings of their AI scripts at the configured difficulty", () => {
    expect(level.difficulty).toBe("GD_2");
    const enemies = level.soldiers.filter((s) => s.team !== 0);
    for (const s of enemies) {
      expect(s.view, `${s.taskId} ${s.aiType}`).not.toBeNull();
      expect(s.combat, `${s.taskId} ${s.aiType}`).not.toBeNull();
    }
    const guard = enemies.find((s) => s.aiType === "AITYPE_GUARD_AK" && s.view?.length === 40)!;
    expect(guard.view).toEqual({ length: 40, alarmLength: 50, alpha: 50, gamma: 45 });
    expect(guard.combat).toMatchObject({ damageScale: 1, hitProbabilityMinRange: 1, maxRoundsPerSequence: 30, minDelay: 0.5 });
    expect(guard.combat!.hitProbabilityMaxRange).toBeCloseTo(0.4, 6);
    const sniper = enemies.find((s) => s.aiType === "AITYPE_SNIPER")!;
    expect(sniper.view).toEqual({ length: 100, alarmLength: 110, alpha: 30, gamma: 15 });
    expect(sniper.combat).toMatchObject({ maxRoundsPerSequence: 10, trackingDistance: 70 });
    // Mission script 2209.qvm overrides one soldier's view length after the default handler.
    expect(enemies.filter((s) => s.view?.length === 20)).toHaveLength(1);
  });

  it("reports no unexpected decoding problems", () => {
    const unexpected = level.warnings.filter((w) => !/extra condition ignored|313_04_1/.test(w));
    expect(unexpected).toEqual([]);
  });
});
