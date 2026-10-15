/**
 * Soldier AI: graph files (GraphStream + RouteTable), patrol cursor, combat
 * configuration and the recovered rule functions. Synthetic cases run
 * always; the staged level-1 files are used when present.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AI_GRAPH_FIELDS,
  AI_GRAPH_MAGIC,
  AI_NODE_DOOR,
  AI_NODE_STAIR,
  AI_NODE_VIEW,
  aiGraphClosestNode,
  aiGraphLegPoint,
  aiGraphNodeContains,
  aiGraphPath,
  aiGraphRoute,
  aiGraphWaypoints,
  graphStreamHash,
  readAiGraph,
  type AiGraph,
} from "../src/loaders/ai-graph";
import {
  AIEVENT,
  AI_COMBAT_DECISION,
  AI_EVENT_PRODUCERS,
  AiNodeOccupancy,
  AiPatrolCursor,
  PATROL_COMMAND,
  aiApplyViewCall,
  aiBulletMayHitPlayer,
  aiCombatConfig,
  aiCombatDecision,
  aiDefaultView,
  aiEventAccepted,
  aiEvasiveChoice,
  aiHitProbability,
  aiInViewCone,
  aiLineOfSightClear,
  aiNewPerceptionSlot,
  aiPerceptionStep,
  aiReactionDelayTicks,
  aiRoundsPerSequence,
  aiShotDelayTicks,
  aiSteerValue,
  x87Round,
  type AiCombatConfig,
  type AiEyeFrame,
  type PatrolCommand,
} from "../src/loaders/ai-rules";
import { readQvmCallTree } from "../src/loaders/qvm";
import { flattenTasks, readTaskTree, type IgiTask } from "../src/loaders/tasks";
import { RAW_ROOT, readRaw } from "./helpers";

// ---------------------------------------------------------------------------
// Synthetic GraphStream writer (mirrors FUN_004f0a80)
// ---------------------------------------------------------------------------

class StreamWriter {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 255); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); }
  f32(v: number) { new Uint8Array(new Float32Array([v]).buffer).forEach((b) => this.u8(b)); }
  f64(v: number) { new Uint8Array(new Float64Array([v]).buffer).forEach((b) => this.u8(b)); }
  field(name: string) {
    this.u8(4);
    this.u32(graphStreamHash(name));
    this.u8(0);
    this.u8(AI_GRAPH_FIELDS[name]);
  }
  int(name: string, v: number) { this.field(name); this.u8(5); this.u32(v); }
  real(name: string, v: number) { this.field(name); this.u8(6); this.f32(v); }
  vec(name: string, v: [number, number, number]) { this.field(name); this.u8(8); v.forEach((x) => this.f64(x)); }
  text(name: string, s: string) {
    this.field(name);
    this.u8(9);
    this.u8(s.length + 1);
    for (const c of s) this.u8(c.charCodeAt(0));
    this.u8(0);
  }
  blob(name: string, data: number[]) {
    this.field(name);
    this.u8(0);
    this.u8(10);
    this.u8(5);
    this.u32(data.length);
    data.forEach((b) => this.u8(b));
  }
  buffer(): ArrayBuffer {
    const out = new ArrayBuffer(this.bytes.length);
    new Uint8Array(out).set(this.bytes);
    return out;
  }
}

/** A 3-node chain 0 - 1 - 2 with a correct route table. */
function syntheticGraph(): ArrayBuffer {
  const cap = 4;
  const w = new StreamWriter();
  w.u32(AI_GRAPH_MAGIC);
  w.int("nMaxNodes", cap);
  const pos: Array<[number, number, number]> = [[0, 0, 0], [4096, 0, 0], [4096, 8192, 0]];
  const route: number[] = [];
  const entry = (next: number, cost: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setInt32(0, next, true);
    new DataView(b.buffer).setFloat32(4, cost, true);
    route.push(...b);
  };
  // index cap*to + from
  for (let to = 0; to < cap; to++) {
    for (let from = 0; from < cap; from++) {
      if (from === to || from > 2 || to > 2) entry(-1, -1);
      else if (to > from) entry(from + 1, to === from + 1 ? (from === 0 ? 4096 : 8192) : 12288);
      else entry(from - 1, from === to + 1 ? (to === 0 ? 4096 : 8192) : 12288);
    }
  }
  w.blob("RouteTable", route);
  pos.forEach((p, id) => {
    w.int("nNodeID", id);
    w.vec("tNodePosition", p);
    w.real("vNodeGamma", 0);
    w.real("vNodeRadius", id === 1 ? 2 : 0.5);
    w.int("nNodeMaterial", -1);
    w.text("nNodeCriteria", id === 2 ? "NODECRITERIA_DOOR" : "");
  });
  for (const [a, b] of [[1, 0], [2, 1]]) {
    w.int("nLinkID1", a);
    w.int("nLinkID2", b);
    w.int("eLinkType", 1);
  }
  return w.buffer();
}

describe("ai graph stream (synthetic)", () => {
  it("field tags are FUN_004f0a40 hashes of the field names", () => {
    expect(graphStreamHash("nMaxNodes")).toBe(0x000d3ae6);
    expect(graphStreamHash("RouteTable")).toBe(0x000fde0d);
    expect(graphStreamHash("tNodePosition")).toBe(0x001d4295);
    expect(graphStreamHash("eLinkType")).toBe(0x000da923);
    expect(graphStreamHash("nmaxnodes")).toBe(graphStreamHash("NMAXNODES"));
  });

  it("parses nodes, links and the route table", () => {
    const g = readAiGraph(syntheticGraph());
    expect(g.maxNodes).toBe(4);
    expect(g.nodes.map((n) => n.id)).toEqual([0, 1, 2]);
    expect(g.nodeById.get(1)!.neighbours.sort()).toEqual([0, 2]);
    expect(g.nodeById.get(2)!.flags).toBe(AI_NODE_DOOR);
    expect(aiGraphRoute(g, 0, 2)).toEqual({ next: 1, cost: 12288 });
    expect(aiGraphPath(g, 0, 2)).toEqual([0, 1, 2]);
    expect(aiGraphPath(g, 2, 0)).toEqual([2, 1, 0]);
    expect(aiGraphPath(g, 0, 3)).toBeNull();
  });

  it("throws naming the offset on corrupt input", () => {
    const good = new Uint8Array(syntheticGraph());
    const badMagic = good.slice();
    badMagic[0] = 0;
    expect(() => readAiGraph(badMagic.buffer)).toThrow(/magic at 0x0/);
    const badTag = good.slice();
    badTag[5] = 0x7f;
    expect(() => readAiGraph(badTag.buffer)).toThrow(/0x4: unknown tag/);
    expect(() => readAiGraph(good.slice(0, good.length - 3).buffer)).toThrow(/0x[0-9a-f]+/);
  });

  it("node square tests, closest node and leg points follow FUN_004f0610 / FUN_00500550 / FUN_00450e90", () => {
    const g = readAiGraph(syntheticGraph());
    const origin: [number, number, number] = [1000, 2000, 0];
    const n1 = g.nodeById.get(1)!;
    expect(aiGraphNodeContains(n1, origin, [1000 + 4096 + 8000, 2000 + 8000, 0], 0, true)).toBe(true); // radius 2 m = 8192
    expect(aiGraphNodeContains(n1, origin, [1000 + 4096 + 9000, 2000, 0], 0, true)).toBe(false);
    expect(aiGraphNodeContains(n1, origin, [1000 + 4096 + 9000, 2000, 0], 0.3, true)).toBe(true);
    expect(aiGraphNodeContains(n1, origin, [1000 + 4096, 2000 + 10, 5000], 0, true)).toBe(false);
    const c = aiGraphClosestNode(g, origin, [1000 + 4096 + 100, 2000, 0])!;
    expect(c.node.id).toBe(1);
    expect(c.inside).toBe(true);
    // leg 1 -> 2 is along +y; node 1 is 8192 half-size: exit at +8192 y
    expect(aiGraphLegPoint(n1, [4096, 0, 0], [0, 8192 * 3, 0], true)).toEqual([4096, 8192, 0]);
    expect(aiGraphLegPoint(n1, [4096, 0, 0], [0, 8192 * 3, 0], false)).toEqual([4096, -8192, 0]);
    const wp = aiGraphWaypoints(g, [0, 0, 0], 0, 2, true)!;
    expect(wp.map((w) => w.node)).toEqual([0, 1, 2]); // exit of 0, entry of 1, centre of 2 (no exit point on the last leg)
    expect(wp[wp.length - 1].point).toEqual([4096, 8192, 0]);
  });
});

// ---------------------------------------------------------------------------
// Level 1 graphs
// ---------------------------------------------------------------------------

const LEVEL = "missions/location0/level1";
const haveLevel = existsSync(`${RAW_ROOT}/${LEVEL}/graphs/graph4019.dat`) && existsSync(`${RAW_ROOT}/${LEVEL}/objects.qvm`);

async function levelTasks(): Promise<IgiTask[]> {
  return flattenTasks(readTaskTree(readQvmCallTree(await readRaw(`${LEVEL}/objects.qvm`))));
}

function dijkstra(g: AiGraph, from: number): Map<number, number> {
  const dist = new Map<number, number>([[from, 0]]);
  const done = new Set<number>();
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (const [k, v] of dist) if (!done.has(k) && v < best) { best = v; u = k; }
    if (u < 0) return dist;
    done.add(u);
    const pu = g.nodeById.get(u)!.position;
    for (const v of g.nodeById.get(u)!.neighbours) {
      const pv = g.nodeById.get(v)!.position;
      const d = best + Math.hypot(pu[0] - pv[0], pu[1] - pv[1], pu[2] - pv[2]);
      if (d < (dist.get(v) ?? Infinity)) dist.set(v, d);
    }
  }
}

describe.skipIf(!haveLevel)("ai graphs (level 1, staged files)", () => {
  it("every graph file parses to EOF and matches its AIGraph task's Graphdata", async () => {
    const tasks = await levelTasks();
    const aiGraphs = tasks.filter((t) => t.type === "AIGraph");
    expect(aiGraphs.length).toBe(11);
    for (const t of aiGraphs) {
      const g = readAiGraph(await readRaw(`${LEVEL}/graphs/graph${t.id}.dat`));
      expect([g.nodes.length, g.maxNodes, g.links.length]).toEqual(t.params["Graphdata"]);
    }
    const humans = tasks.filter((t) => t.type === "HumanAI");
    expect(humans.length).toBe(29);
    for (const h of humans) expect(aiGraphs.some((a) => a.id === h.params["Graph ID"])).toBe(true);
  });

  it("graph 4019: 264 nodes, criteria flags, next == to on every link, next hops are neighbours", async () => {
    const g = readAiGraph(await readRaw(`${LEVEL}/graphs/graph4019.dat`));
    expect([g.nodes.length, g.maxNodes, g.links.length]).toEqual([264, 300, 876]);
    expect(g.nodes.filter((n) => n.flags & AI_NODE_DOOR).length).toBe(32);
    expect(g.nodes.filter((n) => n.flags & AI_NODE_STAIR).length).toBe(51);
    expect(g.nodes.filter((n) => n.flags & AI_NODE_VIEW).length).toBe(1);
    expect(g.nodes.every((n) => n.gamma === 0)).toBe(true);
    for (const l of g.links) {
      expect(aiGraphRoute(g, l.a, l.b)!.next).toBe(l.b);
      expect(aiGraphRoute(g, l.b, l.a)!.next).toBe(l.a);
    }
    for (const a of g.nodes) {
      for (const b of g.nodes) {
        const r = aiGraphRoute(g, a.id, b.id);
        if (r) expect(a.neighbours).toContain(r.next);
      }
    }
    expect(aiGraphPath(g, 1, 200)).toEqual([1, 2, 3, 8, 13, 14, 15, 18, 17, 57, 114, 68, 70, 185, 176, 183, 205, 199, 200]);
  });

  it("graphs 7 and 13 store Dijkstra costs; graph 4019 keeps 46 stale link costs", async () => {
    for (const id of [7, 13]) {
      const g = readAiGraph(await readRaw(`${LEVEL}/graphs/graph${id}.dat`));
      for (const a of g.nodes) {
        const d = dijkstra(g, a.id);
        for (const b of g.nodes) {
          if (a.id === b.id) continue;
          const r = aiGraphRoute(g, a.id, b.id);
          if (d.has(b.id)) expect(r!.cost).toBeCloseTo(d.get(b.id)!, 1);
          else expect(r).toBeNull();
        }
      }
    }
    const g = readAiGraph(await readRaw(`${LEVEL}/graphs/graph4019.dat`));
    const stale = g.links.filter((l) => {
      const pa = g.nodeById.get(l.a)!.position;
      const pb = g.nodeById.get(l.b)!.position;
      return Math.abs(aiGraphRoute(g, l.a, l.b)!.cost - Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])) > 1;
    });
    expect(stale.length).toBe(46);
  });

  it("patrol paths run as the exe's cursor runs them", async () => {
    const tasks = await levelTasks();
    const path = (id: number): PatrolCommand[] =>
      tasks.find((t) => t.type === "PatrolPath" && t.id === id)!.children
        .filter((c) => c.type === "PatrolPathCommand")
        .map((c) => ({ command: c.params["Command"] as number, parameter: c.params["Command Parameter"] as number }));
    const run = (id: number, steps: number) => {
      const c = new AiPatrolCursor(path(id));
      const out: string[] = [];
      for (let i = 0; i < steps; i++) {
        const cmd = c.command()!;
        out.push(`${cmd.command}:${cmd.parameter}`);
        if (cmd.command === PATROL_COMMAND.QUIT || !c.advance()) break;
      }
      return out;
    };
    expect(run(2605, 10)).toEqual(["3:20", "5:166"]); // RUNTO 20, END, LOOKATNODE 166 repeated
    expect(run(2401, 20)).toEqual(["2:2", "5:5", "1:300", "2:3", "5:6", "1:300", "2:4", "5:8", "1:300", "2:1", "5:7", "1:300", "7:0"]);
    expect(run(1504, 5)).toEqual(["0:240", "0:240"]); // END first, then ANIMATION 240 forever
    expect(run(3030, 13).slice(10)).toEqual(["2:4", "1:1700", "2:4"]); // no QUIT: wraps to the first command
  });

  it("settings.qvm HumanAIConfigItem maps to engine units", async () => {
    const items = flattenTasks(readTaskTree(readQvmCallTree(await readRaw("common/ai/settings.qvm"))))
      .filter((t) => t.type === "HumanAIConfigItem" && t.params["Difficulty"] === "GD_2");
    expect(items.length).toBe(29);
    const ak = aiCombatConfig(items.find((t) => t.params["AI Type"] === "AITYPE_PATROL_AK")!.params);
    expect(ak.targetingTimeoutTicks).toBe(450);
    expect(ak.trackingDistance).toBe(20 * 4096);
    expect(ak.liedownMinDistance).toBe(15 * 4096);
    expect(ak.maxRoundsPerSequence).toBe(30);
    expect(ak.unused.movementDelayTicks).toBe(30);
    expect(ak.unused.initialMovementDelayTicks).toBe(9); // fistp(0.33f * 30 = 9.9000004) truncates (chop mode)
    expect(aiRoundsPerSequence(ak, 32, 32, 0)).toBe(9); // fistp(32 * 0.3f) = trunc(9.6000004)
    expect(aiRoundsPerSequence(ak, 32, 32, 0.999)).toBe(19);
  });
});

// ---------------------------------------------------------------------------
// Rules (synthetic)
// ---------------------------------------------------------------------------

const cfg: AiCombatConfig = aiCombatConfig({
  "Damage scale": 1, "Combat initial movement delay (in seconds)": 0.33, "Combat movement delay (in seconds)": 1,
  "Combat targeting timeout (in seconds)": 15, "Combat tracking distance (in meters)": 20,
  "Combat liedown mim distance (in meters)": 15, "Combat evasive action probability": 0.3,
  "Combat evasive stand roll / liedown probability": 0.5, "Combat evasive kneel roll / liedown probability": 0.5,
  "Combat evasive stand roll side probability": 0.5, "Combat evasive kneel roll side probability": 0.5,
  "Combat firing hit probability at minimum range": 1, "Combat firing hit probability at maximum range": 0.4,
  "Combat Firing Max Number Of Rounds per sequence": 30, "Combat firing Aim precision": 0.6,
  "Combat firing minimum clip percentage": 0.3, "Combat firing random clip percentage": 0.3,
  "Combat firing minimum delay (in seconds)": 0.5, "Combat firing random delay (in seconds)": 0.5,
  "Combat firing minimum shot delay (in seconds)": 0.1, "Combat firing random shot delay (in seconds)": 0,
  "Combat grenade throw probability": 0.33, "Combat grenade throw when reload probability": 0.1,
  "Combat grenade minimum distance (in meters)": 10, "Combat grenade maximum distance (in meters)": 60,
});

describe("ai rules", () => {
  it("x87 conversions truncate (igi.exe runs the FPU in chop mode, FUN_004966d0)", () => {
    expect([x87Round(0.5), x87Round(1.5), x87Round(2.5), x87Round(9.6), x87Round(3.5), x87Round(-1.75)]).toEqual([0, 1, 2, 9, 3, -1]);
    expect(aiReactionDelayTicks(0)).toBe(6);
    expect(aiReactionDelayTicks(0.99)).toBe(11); // trunc(11.94)
    expect(aiReactionDelayTicks(65535 / 65536)).toBe(11); // the RNG's maximum: 6..11 ticks
  });

  it("hit probability: lerp over the view length, halved on the first sequence", () => {
    expect(aiHitProbability(0, 40 * 4096, cfg, false)).toBe(1);
    expect(aiHitProbability(20 * 4096, 40 * 4096, cfg, false)).toBeCloseTo(0.7, 6);
    expect(aiHitProbability(80 * 4096, 40 * 4096, cfg, false)).toBeCloseTo(0.4, 6);
    expect(aiHitProbability(20 * 4096, 40 * 4096, cfg, true)).toBeCloseTo(0.35, 6);
    expect(aiBulletMayHitPlayer(0.69, 0.7)).toBe(true);
    expect(aiBulletMayHitPlayer(0.71, 0.7)).toBe(false);
  });

  it("rounds per sequence and shot delays", () => {
    const sniper = { ...cfg, minClipFraction: Math.fround(0.1), randomClipFraction: Math.fround(0.2), maxRoundsPerSequence: 10 };
    expect(aiRoundsPerSequence(sniper, 10, 1, 0)).toBe(1); // Dragunov: clip 10, burst 1
    expect(aiRoundsPerSequence(sniper, 10, 1, 0.99)).toBe(2); // trunc(10 * 0.298)
    expect(aiRoundsPerSequence(cfg, 12, 6, 0.5)).toBe(6); // burst != clip and >= 2: one burst
    expect(aiRoundsPerSequence(cfg, 1, 1, 0.5, true)).toBe(1);
    expect(aiShotDelayTicks(cfg, 1, 0.5)).toBe(3);
    expect(aiShotDelayTicks(cfg, 32, 0.5)).toBe(0);
  });

  it("view cones: alpha vertical, gamma horizontal, secondary 80 deg / 10 m", () => {
    const view = aiDefaultView();
    aiApplyViewCall(view, "AIFunction_SetViewLength", 40);
    aiApplyViewCall(view, "AIFunction_SetAlarmViewLength", 50);
    aiApplyViewCall(view, "AIFunction_SetViewAlpha", 50);
    aiApplyViewCall(view, "AIFunction_SetViewGamma", 45);
    const eye: AiEyeFrame = { position: [0, 0, 0], right: [1, 0, 0], forward: [0, 1, 0], up: [0, 0, 1] };
    const at = (deg: number, m: number, elev = 0): [number, number, number] =>
      [Math.sin((deg * Math.PI) / 180) * m * 4096, Math.cos((deg * Math.PI) / 180) * m * 4096, elev * 4096];
    expect(aiInViewCone(eye, at(30, 35), view, false)).toBe(true);
    expect(aiInViewCone(eye, at(30, 45), view, false)).toBe(false);
    expect(aiInViewCone(eye, at(30, 45), view, true)).toBe(true); // alarm length 50 m
    expect(aiInViewCone(eye, at(60, 8), view, false)).toBe(true); // secondary cone
    expect(aiInViewCone(eye, at(60, 12), view, false)).toBe(false);
    expect(aiInViewCone(eye, at(0, 10, 10), view, false)).toBe(true); // 45 deg up < alpha 50
    expect(aiInViewCone(eye, at(180, 3), view, false)).toBe(false);
    expect(aiLineOfSightClear(null)).toBe(true);
    expect(aiLineOfSightClear(0.8)).toBe(true);
    expect(aiLineOfSightClear(0.5)).toBe(false);
  });

  it("perception schedule: cone every 2nd run, line of sight every 3rd run while in the cone", () => {
    const slot = aiNewPerceptionSlot();
    let cones = 0;
    let rays = 0;
    for (let run = 0; run < 12; run++) aiPerceptionStep(slot, () => (cones++, true), () => (rays++, true));
    expect([cones, rays, slot.visible]).toEqual([6, 4, true]);
    aiPerceptionStep(slot, () => false, () => true);
    aiPerceptionStep(slot, () => false, () => true);
    expect(slot.visible).toBe(false);
  });

  it("event filter: enemy gunshots are heard through walls inside the weapon range", () => {
    const gunshot = AI_EVENT_PRODUCERS.find((p) => p.type === AIEVENT.GUNSHOT)!;
    expect(gunshot.flags).toBe(0x46);
    const listener = { self: 1, team: 1, position: [0, 0, 0] as const, dead: false, created: true, registered: new Set([16]) };
    const ev = { type: 16, team: 0, flags: 0x46, range: 0x1e000, position: [25 * 4096, 0, 0] as const, source: 7, other: 8 };
    const human = { isHuman: true, dead: false };
    expect(aiEventAccepted(listener, ev, () => false, human)).toBe(true);
    expect(aiEventAccepted(listener, { ...ev, team: 1 }, () => false, human)).toBe(false);
    expect(aiEventAccepted(listener, { ...ev, position: [31 * 4096, 0, 0] }, () => false, human)).toBe(false);
    expect(aiEventAccepted(listener, { ...ev, range: 0x1000 }, () => false, human)).toBe(false);
    expect(aiEventAccepted({ ...listener, registered: new Set<number>() }, ev, () => false, human)).toBe(false);
  });

  it("evasive choice (FUN_0048a250)", () => {
    const seq = (...v: number[]) => () => v.shift() ?? 0;
    const base = { now: 100, threatenedThisFrame: true, onStairNode: false, freeSides: 3, cfg };
    expect(aiEvasiveChoice({ ...base, rand: seq(0.9, 0.1), distance: 20 * 4096, state: { nextAllowed: -1, lastRollDir: 0 } })).toBe(0);
    expect(aiEvasiveChoice({ ...base, rand: seq(0.1, 0.1, 0.9), distance: 20 * 4096, state: { nextAllowed: -1, lastRollDir: 0 } })).toBe(1);
    expect(aiEvasiveChoice({ ...base, rand: seq(0.1, 0.1, 0.2), distance: 20 * 4096, state: { nextAllowed: -1, lastRollDir: 0 } })).toBe(2);
    expect(aiEvasiveChoice({ ...base, rand: seq(0.1, 0.5), distance: 20 * 4096, state: { nextAllowed: -1, lastRollDir: 0 } })).toBe(-1);
    const st = { nextAllowed: -1, lastRollDir: 0 };
    aiEvasiveChoice({ ...base, rand: seq(0.1, 0.9), distance: 0, state: st });
    expect(st.nextAllowed).toBe(110);
    expect(aiEvasiveChoice({ ...base, now: 105, rand: seq(0.1, 0.1, 0.9), distance: 0, state: st })).toBe(-1);
  });

  it("combat decision (FUN_0048a3f0)", () => {
    const D = AI_COMBAT_DECISION;
    const make = (over: Partial<Parameters<typeof aiCombatDecision>[0]> = {}) => ({
      cfg, rand: () => 0.5, memory: { destinationNode: -1, notVisibleCount: 0 }, currentNode: 3, onCurrentNode: true,
      targetVisible: true, distance: 15 * 4096, clipLoaded: true, hasGrenade: false, shooters: 0,
      closeCombatDistance: 6144, findNode: () => 9, ...over,
    });
    expect(aiCombatDecision(make())).toEqual({ code: D.FIRE, status: 0 });
    expect(aiCombatDecision(make({ shooters: 3 })).code).toBe(D.LOOK);
    expect(aiCombatDecision(make({ onCurrentNode: false })).code).toBe(D.REPOSITION);
    expect(aiCombatDecision(make({ distance: 1000 })).code).toBe(D.CLOSE);
    expect(aiCombatDecision(make({ clipLoaded: false }))).toEqual({ code: D.RELOAD, status: 1 });
    expect(aiCombatDecision(make({ clipLoaded: false, hasGrenade: true, rand: () => 0.2 })).code).toBe(D.GRENADE);
    const far = make({ distance: 30 * 4096 });
    expect(aiCombatDecision(far).code).toBe(D.MOVE);
    expect(far.memory.destinationNode).toBe(9);
    const lost = make({ targetVisible: false, findNode: () => null });
    lost.memory.notVisibleCount = 450;
    expect(aiCombatDecision(lost).code).toBe(D.GIVE_UP);
    expect(aiCombatDecision(make({ targetVisible: false })).code).toBe(D.LOOK); // count 1: 1 % 30 <= 15
    expect(aiCombatDecision(make({ female: true, distance: 1000 })).code).toBe(D.FIRE);
  });

  it("node occupancy: 0.5 m nodes hold one soldier, 2 m cells keep reservations 3 cells apart", () => {
    const small = new AiNodeOccupancy(0.5);
    expect(small.size).toBe(0);
    expect(small.hasRoom()).toBe(true);
    small.reserve(0, 0);
    expect(small.hasRoom()).toBe(false);
    const big = new AiNodeOccupancy(8);
    expect(big.size).toBe(8);
    big.reserve(4, 4);
    expect(big.isFree(6, 4)).toBe(false);
    expect(big.isFree(7, 4)).toBe(true);
    expect(big.cellOf(0, 0)).toEqual([4, 4]);
    expect(big.cellOf(8191, -1)).toEqual([4, 3]); // fistp truncates: the cell containing the point (0x451d56)
    expect(new AiNodeOccupancy(1.5).size).toBe(1); // trunc(1.5) (0x451adf), not 2
    big.release(4, 4);
    expect(big.isFree(4, 4)).toBe(true);
  });

  it("steering value is the clamped error over pi", () => {
    expect(aiSteerValue(Math.PI / 2, Math.PI)).toBeCloseTo(0.5, 6);
    expect(aiSteerValue(1, 0.025926)).toBeCloseTo(0.025926 / Math.PI, 6);
  });
});
