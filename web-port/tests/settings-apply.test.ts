/**
 * Settings that change the game: the performance flags applied at level load
 * (FUN_00405e50) and the profile store kept across page loads.
 */
import { describe, expect, it } from "vitest";
import { CONTROL_KEYS, MenuConfig, PERF_FLAG_TABLE } from "../src/engine/ui/menu-config";
import { applyPerformanceFlags, renderDetail } from "../src/engine/world/performance";

const args = (...v: Array<number | string>) => ({
  int: (i: number) => (typeof v[i] === "number" ? Math.trunc(v[i] as number) : 0),
  float: (i: number) => (typeof v[i] === "number" ? (v[i] as number) : 0),
  string: (i: number) => (typeof v[i] === "string" ? (v[i] as string) : ""),
});

describe("performance flags (FUN_00405e50)", () => {
  it("terrain threshold 0x60 / 0x81 / 0xa3 and model LOD scale 2.0 / 1.5 / 1.0 per menu level", () => {
    const expected: Array<[number, number]> = [
      [0xa3, 1], // level 0: flags 0x00
      [0xa3, 1.5], // 0x41
      [0xa3, 1.5], // 0x4d
      [0xa3, 1], // 0x0d
      [0x81, 1.5], // 0x60
      [0x81, 2], // 0xae
      [0x60, 2], // 0x9e
    ];
    PERF_FLAG_TABLE.forEach((flags, level) => {
      applyPerformanceFlags(flags);
      expect([renderDetail.terrainLodBase, renderDetail.modelLodScale], `level ${level}`).toEqual(expected[level]);
    });
    // 0x10 wins over 0x20, 0x80 over 0x40 (the exe tests them in that order).
    applyPerformanceFlags(0x10 | 0x20 | 0x40 | 0x80);
    expect([renderDetail.terrainLodBase, renderDetail.modelLodScale]).toEqual([0x60, 2]);
    applyPerformanceFlags(0);
    expect([renderDetail.terrainLodBase, renderDetail.modelLodScale]).toEqual([0xa3, 1]);
  });
});

describe("MenuConfig save / restore", () => {
  it("round-trips every profile field and the active profile", () => {
    const a = new MenuConfig();
    a.call("Config_CreateNewPlayerProfile", args("Ana", 2), () => {});
    a.call("Config_SoundOptionsSetMusicVolume", args(0.25), () => {});
    a.call("Config_GraphicOptionsSetPerformanceFlags", args(0x60), () => {});
    a.profile.bindings.Fire = "KEY_SPACE";
    a.profile.music = false;
    const b = new MenuConfig();
    expect(b.restore(JSON.parse(JSON.stringify(a.save())))).toBe(true);
    expect(b.profiles.map((p) => p.name)).toEqual(["Joe", "Ana"]);
    expect(b.active).toBe(1);
    expect(b.profile.musicVolume).toBe(Math.fround(0.25));
    expect(b.profile.performanceFlags).toBe(0x60);
    expect(b.profile.bindings.Fire).toBe("KEY_SPACE");
    expect(b.snapshot().music).toBe(false);
  });

  it("rejects malformed data and drops unknown keys", () => {
    const c = new MenuConfig();
    expect(c.restore(null)).toBe(false);
    expect(c.restore({ version: 2, profiles: [] })).toBe(false);
    expect(c.restore({ version: 1, profiles: [{ name: "" }] })).toBe(false);
    expect(c.profiles.map((p) => p.name)).toEqual(["Joe"]);
    expect(c.restore({ version: 1, active: 9, profiles: [{ name: "X", bindings: { Fire: "KEY_NOPE", Jump: CONTROL_KEYS[1] } }] })).toBe(true);
    expect(c.active).toBe(0);
    expect(c.profile.bindings.Fire).not.toBe("KEY_NOPE");
    expect(c.profile.bindings.Jump).toBe(CONTROL_KEYS[1]);
  });
});
