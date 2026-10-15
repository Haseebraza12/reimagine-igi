/**
 * Soldier-AI engine: a patrol walking a real level-1 PatrolPath with the
 * recovered cursor, route following through the stored route table of
 * graph 4019, and the body's turn rule (FUN_0045fd00).
 */
import { describe, expect, it } from "vitest";
import { aiGraphPath } from "../src/loaders/ai-graph";
import { turnFromChannel } from "../src/engine/ai/motor";
import { HAVE_LEVEL, createHarness } from "./ai-engine-harness";

describe("body turn per tick (FUN_0045fd00)", () => {
  it("averages the channel with the previous tick, scales by pi and softens small inputs", () => {
    expect(turnFromChannel(1, 0)).toBeCloseTo(Math.PI / 2, 5);
    expect(turnFromChannel(0.5, 0.5)).toBeCloseTo(Math.PI / 2, 5);
    const x = 0.02;
    expect(turnFromChannel(x, x)).toBeCloseTo((x * Math.PI) / (2 - 16.666666666666668 * x), 6);
    // The LookAtNode clamp 0.025926 rad held steadily turns ~0.0139 rad per tick.
    const v = 0.025926 / Math.PI;
    expect(turnFromChannel(v, v)).toBeCloseTo(0.025926 / (2 - 16.666666666666668 * v), 6);
  });
});

describe.skipIf(!HAVE_LEVEL)("patrols and routes on the level-1 graphs", () => {
  it("guard 2201 walks PatrolPath 2401 command by command (WALKTO, LOOKATNODE, DELAY 300 ticks, ..., QUIT) on graph 8", async () => {
    const h = await createHarness({ only: [2001] });
    const s = h.byTask.get(2001)!;
    const seen: string[] = [];
    const delayStart = new Map<number, number>();
    const delayEnd = new Map<number, number>();
    let last = "";
    for (let tick = 0; tick < 3200 && seen.length < 13; tick++) {
      h.step();
      const top = s.ai.top;
      if (top?.impl.name !== "Patrol") continue;
      const d = top.data as { cursor?: { current: number | null; command(): { command: number; parameter: number } | null } };
      const cmd = d.cursor?.command();
      if (!cmd) continue;
      const key = `${d.cursor!.current}:${cmd.command}:${cmd.parameter}`;
      if (key !== last) {
        if (cmd.command === 1) {
          delayStart.set(seen.length, tick);
          // The walk before the delay ended on its WALKTO node.
          seen.push(`${cmd.command}:${cmd.parameter}@${s.ai.currentNode}`);
        } else {
          if (delayStart.has(seen.length - 1)) delayEnd.set(seen.length - 1, tick);
          seen.push(`${cmd.command}:${cmd.parameter}`);
        }
        last = key;
      }
    }
    // The guard starts on node 2, so the first WALKTO 2 ends on the tick the action starts; after QUIT
    // the IDLE handler queues the patrol again from its first command.
    expect(seen).toEqual([
      "5:5", "1:300@2", "2:3", "5:6", "1:300@3", "2:4", "5:8", "1:300@4", "2:1", "5:7", "1:300@1", "7:0", "2:2",
    ]);
    for (const [i, start] of delayStart) if (delayEnd.has(i)) expect(delayEnd.get(i)! - start).toBe(300);
  });

  it("2203 follows the stored route of graph 4019 node by node (173 -> 188)", async () => {
    const h = await createHarness({ only: [2003] });
    const s = h.byTask.get(2003)!;
    const g = h.data.graphs.get(4019)!.graph;
    const nodes: number[] = [];
    for (let tick = 0; tick < 2400; tick++) {
      h.step();
      if (nodes[nodes.length - 1] !== s.ai.currentNode) nodes.push(s.ai.currentNode);
      if (s.ai.currentNode === 188) break;
    }
    const start = nodes.indexOf(173);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(nodes.slice(start)).toEqual(aiGraphPath(g, 173, 188));
    // Walking speed is the patrol-walk clip's root motion (action 3, clip 57: ~1.26 m/s).
    expect(s.motor.walking).toBe(true);
  });

  it("body: kneel / lie-down requests and roll clips; deaths per stance (32 / 33 / 34)", async () => {
    const h = await createHarness({ only: [2007, 2008, 2009] });
    const [kneel, prone, stand] = [2007, 2008, 2009].map((id) => h.byTask.get(id)!.motor);
    const ch = (k: number) => {
      const c = new Float32Array(40);
      c[k] = 1;
      return c;
    };
    for (let i = 0; i < 40; i++) kneel.step(ch(21));
    expect([kneel.stance, kneel.state]).toEqual(["kneel", 19]);
    for (let i = 0; i < 60; i++) prone.step(ch(22));
    expect([prone.stance, prone.state]).toEqual(["prone", 26]);
    // A stand roll (channel 2) ends kneeling. The graph's first run only
    // enters state 0 (FUN_004e2d10 installs entry 0 as the running function),
    // so the request is taken from the second step on.
    const roller = stand;
    roller.step(new Float32Array(40));
    roller.step(ch(2));
    expect(roller.state).toBe(4);
    for (let i = 0; i < 40 && roller.state === 4; i++) roller.step(new Float32Array(40).fill(0).map((_, k) => (k === 21 ? 1 : 0)));
    expect(roller.stance).toBe("kneel");
    // Kneel without channel 21 goes straight to stand (FUN_00457920: no kneel-to-stand clip).
    for (let i = 0; i < 40; i++) roller.step(new Float32Array(40));
    expect([roller.stance, roller.state]).toEqual(["stand", 0]);
    kneel.kill(false);
    prone.kill(false);
    stand.kill(false);
    // The dead bit is read by the state's next tick (FUN_0045bfe0 sets it; the ticks switch).
    for (const m of [kneel, prone, stand]) m.step(new Float32Array(40));
    expect([kneel.state, prone.state, stand.state]).toEqual([33, 34, 32]);
    expect([kneel.dead, prone.dead, stand.dead]).toEqual([true, true, true]);
  });

  it("every level-1 soldier runs 600 ticks without script errors", async () => {
    const h = await createHarness();
    for (let i = 0; i < 600; i++) h.step();
    expect(h.soldiers.length).toBe(29);
    expect(h.soldiers.filter((s) => s.ai.active).length).toBe(29);
    for (const s of h.soldiers) expect(s.ai.lastError).toBeNull();
  });
});
