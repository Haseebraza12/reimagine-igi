/**
 * The full game (all 14 missions), staged in web-port/game-data by
 * `IGI_GAME_DIR=<full game> npm run stage`. Skipped when it is not there.
 * The other tests read the one-mission build (game-data-demo, tests/helpers.ts).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { LEVEL1_PATHS, levelPathsFor, loadIgiLevel, readIlffMembers, readQvmCallTree, readSoundDefinitions } from "../src/loaders";
import { AI_GRAPH_MAGIC, aiGraphNodeWorld, readAiGraph } from "../src/loaders/ai-graph";
import { loadAiLevelData } from "../src/engine/ai/data";
import { fitCreditsScreen, portCreditsScript } from "../src/engine/ui/port-credits";
import { numberParam, readTaskTree, vec3Param } from "../src/loaders/tasks";
import { readAnyFont } from "../src/loaders/ui";
import { readMissionDefinition } from "../src/engine/ui/assets";

const FULL = fileURLToPath(new URL("../game-data", import.meta.url));
const DEMO = fileURLToPath(new URL("../game-data-demo", import.meta.url));
const haveFull = existsSync(`${FULL}/missions/location0/level14/mission.qvm`);
const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const NAMES = [
  "Trainyard", "SAM Base", "Military Airbase", "GOD", "Radar Base", "Get Priboi", "Border Crossing",
  "Re-supply", "Missile Trainyard", "Defend Priboi", "Eagle's Nest I", "Eagle's Nest II", "Nuclear Infiltration", "Finding the bomb",
];

describe.skipIf(!haveFull)("full game data", () => {
  it("ILFF fonts (FNTH / TRAN / ANMF / TEXH / BODY) decode to the one-mission build's LOOP glyphs", () => {
    const fontOf = (root: string, res: string, name: string) => {
      const m = readIlffMembers(bytes(`${root}/${res}`)).find((x) => x.name.toLowerCase().endsWith(name))!;
      return readAnyFont(m.payload, name);
    };
    for (const [res, name] of [["computer/computer.res", "font3.fnt"], ["menusystem/menusystem.res", "font3.fnt"], ["menusystem/menusystem.res", "font4.fnt"], ["menusystem/ingamemenu.res", "font1.fnt"]]) {
      const full = fontOf(FULL, res, name);
      expect(full.glyphs.length).toBeGreaterThan(90);
      if (!existsSync(`${DEMO}/${res}`)) continue;
      const demo = fontOf(DEMO, res, name);
      expect([full.proportional, full.spaceAdvance, full.lineHeight, full.cellWidth]).toEqual([demo.proportional, demo.spaceAdvance, demo.lineHeight, demo.cellWidth]);
      for (let c = 33; c < 127; c++) {
        const a = demo.glyphs[demo.charMap[c] - 1];
        const b = full.glyphs[full.charMap[c] - 1];
        expect([b.width, b.height, b.x, b.y]).toEqual([a.width, a.height, a.x, a.y]);
        for (let i = 3; i < a.rgba.length; i += 4) expect(b.rgba[i] > 127).toBe(a.rgba[i] > 127);
      }
    }
  });

  it("sounds.qvm: DefineGraph has 34 arguments in the full game and its curves are read after the extra one", () => {
    const calls = readQvmCallTree(bytes(`${FULL}/common/sounds/sounds.qvm`));
    const graphs: Array<{ args: unknown[] }> = [];
    const walk = (c: { fn: string; args: unknown[] }) => {
      if (c.fn === "DefineGraph") graphs.push(c);
      if (c.fn === "DefineGroup") for (const a of c.args.slice(1)) walk(a as { fn: string; args: unknown[] });
    };
    calls.forEach(walk);
    expect(graphs.length).toBeGreaterThan(0);
    for (const g of graphs) expect(g.args.length).toBe(34);
    const defs = readSoundDefinitions(bytes(`${FULL}/common/sounds/sounds.qvm`), "common");
    const graph = defs.find((d) => d.kind === "graph") as { volumeCurve: number[]; pitchCurve: number[] } | undefined;
    expect(graph?.volumeCurve.length).toBe(11);
    expect(graph?.pitchCurve).toEqual((graphs[0].args.slice(23) as number[]).map(Number));
  });

  it("all 14 missions load from their DefineMission folders", async () => {
    const raw = createFsAssetSource(FULL);
    const strings = new Map(NAMES.map((n, i) => [`mission ${i + 1} name`, n]));
    for (let id = 1; id <= 14; id++) {
      const [def] = readMissionDefinition(bytes(`${FULL}/missions/location0/level${id}/mission.qvm`), strings);
      expect(def.id).toBe(id);
      expect(def.name).toBe(NAMES[id - 1]);
      expect(def.nextMission).toBe(id < 14 ? id + 1 : -1);
      const level = await loadIgiLevel(raw, levelPathsFor(def.location));
      expect(level.name).toBe(NAMES[id - 1]);
      expect(level.soldiers.length).toBeGreaterThan(20);
      expect(level.paths).toEqual(id === 1 ? LEVEL1_PATHS : levelPathsFor(def.location));
    }
  }, 120_000);

  it("every AI graph file of every mission reads (mission 8 has 7 untagged ones); next hops are neighbours", () => {
    let legacy = 0;
    for (let id = 1; id <= 14; id++) {
      const dir = `${FULL}/missions/location0/level${id}/graphs`;
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".dat"))) {
        const buffer = bytes(`${dir}/${f}`);
        if (new DataView(buffer).getUint32(0, true) !== AI_GRAPH_MAGIC) legacy++;
        const g = readAiGraph(buffer);
        for (const from of g.nodes) {
          for (const to of g.nodes) {
            const next = g.routeNext[g.maxNodes * to.id + from.id];
            if (next !== -1 && from.id !== to.id) expect(from.neighbours).toContain(next);
          }
        }
      }
    }
    expect(legacy).toBe(7);
  });

  it("L14 AIGraph 36 is attached to Building_-1: its one node sits under Anya's desk position (E199)", async () => {
    const raw = createFsAssetSource(FULL);
    const [def] = readMissionDefinition(bytes(`${FULL}/missions/location0/level14/mission.qvm`), new Map());
    const level = await loadIgiLevel(raw, levelPathsFor(def.location));
    const data = await loadAiLevelData(raw, level);
    const g = data.graphs.get(36)!;
    expect(g.position.parent).toBeTruthy();
    const anya = level.tasks.find((t) => t.type === "HumanSoldier" && t.params.Model === "015_01_1")!;
    const placed = vec3Param(anya, "Position")!;
    const w = aiGraphNodeWorld(g.graph.nodes[0], g.position);
    expect(Math.hypot(w[0] - placed[0], w[1] - placed[1])).toBeLessThan(4096);
    expect(placed[2] - w[2]).toBeGreaterThan(0);
    expect(placed[2] - w[2]).toBeLessThan(4096);
    // Graphs under Container / ConditionalContainer stay unattached.
    expect([...data.graphs.values()].some((x) => !x.position.parent)).toBe(true);
  }, 60_000);

  it("credits: the port's own pages only; the Credits box gets the Read Me box's size inside the window", () => {
    const script = portCreditsScript();
    expect(script[0].text).toBe("Project IGI - Web Port");
    const texts = script.map((l) => l.text);
    expect(texts).toContain("Haseeb ur Rehman");
    expect(texts).toContain("CS Graduate");
    expect(texts).toContain("munibhaseeb2@gmail.com");
    expect(texts).not.toContain("Andrew Wensley");
    const breaks = script.filter((l) => l.y === -1);
    expect(breaks.every((l) => l.pause === -1)).toBe(true);
    expect(script.filter((l) => l.pageStart).length).toBe(breaks.length);
    const tree = readTaskTree(readQvmCallTree(bytes(`${FULL}/menusystem/mainmenu.qvm`)));
    expect(fitCreditsScreen(tree)).toBe(true);
    const all: Array<{ type: string; params: Record<string, unknown> }> = [];
    const walk = (t: { type: string; params: Record<string, unknown>; children: unknown[] }) => {
      all.push(t);
      (t.children as never[]).forEach(walk);
    };
    tree.forEach(walk as never);
    const box = all.find((t) => t.type === "TypeWriterBox")!;
    const ascii = all.find((t) => t.type === "AsciiBox")!;
    expect([box.params.Width, box.params.Height]).toEqual([ascii.params.Width, ascii.params.Height]);
    expect(box.params.Width as number).toBeLessThanOrEqual(455); // the frame's width
  });

  it("DiscardTerrain: no collision terrain is left inside a discard cube (mission 3)", async () => {
    const raw = createFsAssetSource(FULL);
    const [def] = readMissionDefinition(bytes(`${FULL}/missions/location0/level3/mission.qvm`), new Map());
    const level = await loadIgiLevel(raw, levelPathsFor(def.location));
    const cubes = level.tasks.filter((t) => t.type === "DiscardTerrain").map((t) => {
      const p = vec3Param(t, "Position")!;
      const side = 2 ** (31 - (numberParam(t, "Level") ?? 10));
      const min = p.map((v) => Math.floor(Math.trunc(v) / side) * side);
      return { min, max: min.map((v) => v + side) };
    });
    expect(cubes.length).toBe(14);
    const o = level.originIgi;
    const P = level.terrain.detail.positions;
    const I = level.terrain.detail.indices;
    let inside = 0;
    for (let k = 0; k < I.length; k += 3) {
      const c = [0, 0, 0];
      for (let j = 0; j < 3; j++) {
        const v = I[k + j] * 3;
        c[0] += (o[0] + P[v] * 4096) / 3;
        c[1] += (o[1] - P[v + 2] * 4096) / 3;
        c[2] += (o[2] + P[v + 1] * 4096) / 3;
      }
      if (cubes.some((b) => [0, 1, 2].every((a) => b.min[a] < c[a] && c[a] <= b.max[a]))) inside++;
    }
    expect(inside).toBe(0);
  }, 60_000);
});
