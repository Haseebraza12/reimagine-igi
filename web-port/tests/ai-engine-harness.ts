/**
 * Headless harness for the soldier-AI engine tests: the real level-1 tasks,
 * scripts, graphs and settings, real soldier clips (001.iff) through the
 * same ClipPlayer the browser bodies use, and a stub world (no geometry by
 * default). Soldiers move by their root motion in IGI units (no collision).
 */
import { existsSync } from "node:fs";
import { readAnimations, type AnimationFile } from "../src/loaders/anim";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { readQvmCallTree } from "../src/loaders/qvm";
import { flattenTasks, readTaskTree, type IgiTask } from "../src/loaders/tasks";
import { readWeaponRules } from "../src/loaders/gameplay-params";
import type { IgiLevel, LevelSoldier } from "../src/loaders/level";
import { ClipPlayer } from "../src/engine/ai/clip-player";
import { loadAiLevelData, type AiLevelData } from "../src/engine/ai/data";
import { HumanAi } from "../src/engine/ai/human-ai";
import { SoldierMotor, type GunSpec } from "../src/engine/ai/motor";
import { PLAYER_KEY, type AiHuman, type V3 } from "../src/engine/ai/types";
import { AiWorld, type AiHooks } from "../src/engine/ai/world";
import { RAW_ROOT, readRaw } from "./helpers";

export const HAVE_LEVEL = existsSync(`${RAW_ROOT}/missions/location0/level1/objects.qvm`) && existsSync(`${RAW_ROOT}/common/anims/001.iff`);

export interface HarnessSoldier {
  task: IgiTask;
  ai: HumanAi;
  motor: SoldierMotor;
  human: AiHuman;
  feet: V3;
  alive: boolean;
  present: boolean;
  shots: number;
}

export interface Harness {
  world: AiWorld;
  data: AiLevelData;
  soldiers: HarnessSoldier[];
  byTask: Map<number, HarnessSoldier>;
  /** By HumanAI task id (several soldiers have task id -1). */
  byAi: Map<number, HarnessSoldier>;
  player: { feet: V3; alive: boolean; crouched: boolean; team: number };
  members: Map<string, number>;
  rays: number;
  /** Optional line-of-sight override (default: always clear). */
  ray: ((a: readonly number[], b: readonly number[]) => boolean) | null;
  step(): void;
  tasks: IgiTask[];
}

let cache: { tasks: IgiTask[]; anims: Map<number, AnimationFile>; weapons: ReturnType<typeof readWeaponRules> } | null = null;

async function shared() {
  if (cache) return cache;
  const tasks = flattenTasks(readTaskTree(readQvmCallTree(await readRaw("missions/location0/level1/objects.qvm"))));
  const anims = new Map<number, AnimationFile>();
  for (const id of [0, 1, 6]) anims.set(id, readAnimations(await readRaw(`common/anims/00${id}.iff`)));
  const weapons = readWeaponRules(await readRaw("weapons/weaponconfig.qvm"));
  cache = { tasks, anims, weapons };
  return cache;
}

function num(t: IgiTask, k: string, d: number): number {
  const v = t.params[k];
  return typeof v === "number" ? v : d;
}

/**
 * Build a harness. `only` limits the soldiers (HumanSoldier task ids); the
 * player starts far away unless `playerAt` is given.
 */
export async function createHarness(options: { only?: number[]; onlyAi?: number[]; playerAt?: V3 } = {}): Promise<Harness> {
  const { tasks, anims, weapons } = await shared();
  const aiId = (t: IgiTask) => t.children.find((c) => c.type === "HumanAI")?.id ?? -2;
  const soldierTasks = tasks.filter((t) => t.type === "HumanSoldier" && (!options.only || options.only.includes(t.id)) && (!options.onlyAi || options.onlyAi.includes(aiId(t))));
  const levelSoldiers: LevelSoldier[] = soldierTasks.map((t) => {
    const ai = t.children.find((c) => c.type === "HumanAI");
    return {
      taskId: t.id, name: t.name, position: [0, 0, 0], yaw: num(t, "Gamma", 0), team: num(t, "Team", 1),
      model: String(t.params["Model"] ?? ""), aiType: ai ? String(ai.params["AI Type"]) : null, weapon: null, view: null, combat: null,
      skeleton: num(t, "Bone Heirachy", 1), standAnimation: num(t, "Stand Animation", -1), aiTaskId: ai ? ai.id : null,
      graphId: ai ? num(ai, "Graph ID", -1) : null,
    };
  });
  const level = { tasks, soldiers: levelSoldiers, difficulty: "GD_2" } as unknown as IgiLevel;
  const data = await loadAiLevelData(createFsAssetSource(RAW_ROOT), level);
  const members = new Map<string, number>();
  const h: Harness = {
    world: null as unknown as AiWorld, data, soldiers: [], byTask: new Map(), byAi: new Map(), tasks,
    player: { feet: options.playerAt ?? [0, 0, 0], alive: true, crouched: false, team: 0 },
    members, rays: 0, ray: null,
    step() {
      h.world.beginTick();
      for (const s of h.soldiers) {
        if (!s.present) continue;
        // The HumanSoldier node runs before its HumanAI node: the body uses
        // the channels the AI wrote on its previous frame (as enemy.ts).
        const step = s.motor.step(s.alive ? s.ai.ch : new Float32Array(40));
        const y = s.motor.bodyYaw;
        const fx = -Math.sin(y), fy = Math.cos(y);
        const rx = Math.cos(y), ry = Math.sin(y);
        s.feet[0] += rx * step.delta[0] + fx * step.delta[1];
        s.feet[1] += ry * step.delta[0] + fy * step.delta[1];
        s.ai.frame();
      }
      h.world.tick++;
      h.world.appTick++; // no pause in the harness: the application tick runs with the level tick
    },
  };
  const hooks: AiHooks = {
    lineOfSight(a, b) {
      h.rays++;
      return h.ray ? h.ray(a, b) : true;
    },
    taskMember: (name) => members.get(name),
    taskPosition(id) {
      const p = data.taskById.get(id)?.params["Position"];
      return Array.isArray(p) ? [Number(p[0]), Number(p[1]), Number(p[2])] : null;
    },
  };
  const world = new AiWorld(data, hooks);
  h.world = world;
  const player: AiHuman = {
    key: PLAYER_KEY, team: 0, isPlayer: true,
    dead: () => !h.player.alive,
    feet: () => [...h.player.feet] as V3,
    origin: () => [h.player.feet[0], h.player.feet[1], h.player.feet[2] + 0.95 * 4096],
    crouched: () => h.player.crouched,
    present: () => true,
  };
  world.addHuman(player);
  let key = 1;
  for (let i = 0; i < soldierTasks.length; i++) {
    const t = soldierTasks[i];
    const l = levelSoldiers[i];
    const p = t.params["Position"] as number[];
    const feet: V3 = [p[0], p[1], p[2]];
    let gun: GunSpec | null = null;
    let grenade: GunSpec | null = null;
    for (const c of t.children) {
      if (!c.type.startsWith("Gun")) continue;
      const w = weapons.get(String(c.params["ID"]));
      if (!w) continue;
      const spec = { weaponId: w.scriptId, roundsPerClip: w.roundsPerClip, maxRoundsPerBurst: w.maxRoundsPerBurst, roundsPerMinute: w.roundsPerMinute, grenade: w.weaponType === "WEAPONTYPE_GRENADE" };
      if (spec.grenade) grenade ??= spec;
      else gun ??= spec;
    }
    const s = { task: t, feet, alive: true, present: true, shots: 0 } as HarnessSoldier;
    const motor = new SoldierMotor(new ClipPlayer(anims.get(l.skeleton) ?? null), l.yaw, l.standAnimation, gun, grenade, {
      shot: () => s.shots++,
    }, (n) => world.rng.int(n));
    const human: AiHuman = {
      key: key++, team: l.team, isPlayer: false,
      dead: () => !s.alive,
      feet: () => [...s.feet] as V3,
      origin: () => [s.feet[0], s.feet[1], s.feet[2] + motor.rootZ],
      crouched: () => motor.crouched,
      present: () => s.present,
    };
    s.motor = motor;
    s.human = human;
    world.addHuman(human);
    s.ai = new HumanAi(world, human, motor, { taskId: t.id, aiTaskId: l.aiTaskId, aiType: l.aiType, graphId: l.graphId, team: l.team });
    world.soldiers.push(s.ai);
    h.soldiers.push(s);
    h.byTask.set(t.id, s);
    if (l.aiTaskId !== null) h.byAi.set(l.aiTaskId, s);
  }
  return h;
}
