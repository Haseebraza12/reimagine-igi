/**
 * Loading the soldier-AI data of a level from the original files:
 *   - the 9 common scripts LOCAL:common/ai/{rpg,gunner,sniper,anya,ekk,
 *     priboi,civilian,patrol,guard}.qsc (FUN_0044b710) [recovered];
 *   - MISSION:AI/<HumanAI id>.qsc per soldier (FUN_0044f3a0) [recovered];
 *   - graphs/graph<Graph ID>.dat with its AIGraph task's "Graph position"
 *     and "Node cover midoffset" (FUN_004efe60, docs/ai.md 3) [recovered];
 *   - common/ai/settings.qvm HumanAIConfigItem at the configured difficulty
 *     (FUN_00407080) [recovered];
 *   - material/material.qvm footstep noise ranges (DefineGameMaterial arg 5)
 *     [recovered].
 */
import type { IAssetSource } from "../../contracts";
import {
  LEVEL1_PATHS,
  QVM_AI_TYPE_SCRIPT,
  aiCombatConfig,
  aiGraphPosition,
  eulerToMatrix,
  flattenTasks,
  loadQvmProgram,
  readAiGraph,
  readGameMaterials,
  readQvmCallTree,
  readTaskTree,
  type AiGraph,
  type AiGraphParent,
  type AiGraphPosition,
  type AiRulesCombatConfig,
  type IgiLevel,
  type IgiLevelPaths,
  type IgiTask,
  type QvmProgram,
} from "../../loaders";
import type { V3 } from "./types";

export interface AiGraphInfo {
  id: number;
  graph: AiGraph;
  /**
   * AIGraph "Graph position" (IGI units), with the parent object when the graph is attached
   * (loaders/ai-graph.ts aiGraphNodeWorld): world = P (graph position + node) + parent position.
   */
  position: AiGraphPosition;
  /** "Node cover midoffset" (metres) [recovered schema FUN_004ffe00]. */
  midOffset: number;
}

export interface AiExtraConfig {
  closeCombatHitProbability: number;
  closeCombatDamage: number;
  grenadeFlySeconds: [number, number];
  grenadeExplodeSeconds: [number, number];
  recoilThreshold: number;
}

export interface AiLevelData {
  level: IgiLevel;
  /** Common scripts by name ("guard", "patrol", ...). */
  common: Map<string, QvmProgram>;
  /** Mission scripts by HumanAI task id. */
  mission: Map<number, QvmProgram>;
  graphs: Map<number, AiGraphInfo>;
  /** HumanAIConfigItem per AI type name at the configured difficulty. */
  combat: Map<string, AiRulesCombatConfig>;
  extra: Map<string, AiExtraConfig>;
  /** Footstep noise range per ground material name, IGI units. */
  footstepRange: Map<string, number>;
  taskById: Map<number, IgiTask>;
  warnings: string[];
}

const COMMON_SCRIPTS = ["rpg", "gunner", "sniper", "anya", "ekk", "priboi", "civilian", "patrol", "guard"];

async function tryRead(source: IAssetSource, path: string): Promise<ArrayBuffer | null> {
  try {
    if (!(await source.exists(path))) return null;
    return await source.readBinary(path);
  } catch {
    return null;
  }
}

/**
 * Task types whose class derives from RigidDynCubeObj, so an AIGraph under them is attached
 * (FUN_004efc80) [recovered class chains: Building > SectorObject, EditRigidObj >
 * SectorInteriorObject, Elevator, Heli / Train / Plane > Vehicle > PhysicsObject, StationaryGun;
 * Car inferred as a Vehicle].
 */
export const GRAPH_ATTACHING_TYPES: ReadonlySet<string> = new Set([
  "Building", "EditRigidObj", "Elevator", "Heli", "Train", "Plane", "Car", "StationaryGun",
]);

/** The parent's pose at load from its placement parameters (Position, Orientation / Gamma). */
function parentPoseFromTask(task: IgiTask): { position: [number, number, number]; matrix: number[] } | null {
  const pos = task.params.Position;
  if (!Array.isArray(pos) || pos.length !== 3) return null;
  const o = task.params.Orientation;
  const g = task.params.Gamma;
  const matrix = Array.isArray(o) && o.length === 3
    ? eulerToMatrix(Number(o[0]), Number(o[1]), Number(o[2]))
    : eulerToMatrix(0, 0, typeof g === "number" ? g : 0);
  return { position: [Number(pos[0]), Number(pos[1]), Number(pos[2])], matrix: [...matrix] };
}

export async function loadAiLevelData(source: IAssetSource, level: IgiLevel, paths: IgiLevelPaths = level.paths ?? LEVEL1_PATHS): Promise<AiLevelData> {
  const warnings: string[] = [];
  const common = new Map<string, QvmProgram>();
  await Promise.all(COMMON_SCRIPTS.map(async (name) => {
    const buffer = await tryRead(source, `${paths.aiScripts}${name}.qvm`);
    if (!buffer) {
      warnings.push(`missing common AI script ${name}.qvm`);
      return;
    }
    common.set(name, loadQvmProgram(buffer));
  }));

  const taskById = new Map<number, IgiTask>();
  for (const t of level.tasks) if (t.id >= 0 && !taskById.has(t.id)) taskById.set(t.id, t);
  // Parent task and its pre-order node index (= IgiLevel.tasks index) of every task.
  const parentOf = new Map<IgiTask, { task: IgiTask; node: number }>();
  {
    let index = 0;
    const walk = (t: IgiTask, parent: { task: IgiTask; node: number } | null) => {
      const node = index++;
      if (parent) parentOf.set(t, parent);
      for (const c of t.children) walk(c, { task: t, node });
    };
    for (const r of level.taskRoots ?? []) walk(r, null);
  }
  /** The parent object of an attached AIGraph (pose from its parameters; moving parents are refreshed by the engine). */
  const graphParentOf = (graphTask: IgiTask): AiGraphParent | null => {
    const parent = parentOf.get(graphTask);
    if (!parent || !GRAPH_ATTACHING_TYPES.has(parent.task.type)) return null;
    const pose = parentPoseFromTask(parent.task) ?? { position: [0, 0, 0] as [number, number, number], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
    return { node: parent.node, position: pose.position, matrix: pose.matrix };
  };

  const mission = new Map<number, QvmProgram>();
  const graphs = new Map<number, AiGraphInfo>();
  const graphDir = paths.missionAiScripts.replace(/ai\/?$/, "graphs/");
  const aiIds = new Set<number>();
  const graphIds = new Set<number>();
  for (const s of level.soldiers) {
    if (s.aiTaskId !== null) aiIds.add(s.aiTaskId);
    if (s.graphId !== null) graphIds.add(s.graphId);
  }
  await Promise.all([...aiIds].map(async (id) => {
    const buffer = await tryRead(source, `${paths.missionAiScripts}${id}.qvm`);
    if (buffer) mission.set(id, loadQvmProgram(buffer));
  }));
  await Promise.all([...graphIds].map(async (id) => {
    const buffer = await tryRead(source, `${graphDir}graph${id}.dat`);
    const task = taskById.get(id);
    if (!buffer || !task || task.type !== "AIGraph") {
      warnings.push(`No AI graph ${id}`);
      return;
    }
    const p = task.params["Graph position"];
    const offset: V3 = Array.isArray(p) && p.length === 3 ? [Number(p[0]), Number(p[1]), Number(p[2])] : [0, 0, 0];
    const position = aiGraphPosition(offset, graphParentOf(task));
    const mid = task.params["Node cover midoffset"];
    graphs.set(id, { id, graph: readAiGraph(buffer), position, midOffset: typeof mid === "number" ? mid : 1 });
  }));

  const combat = new Map<string, AiRulesCombatConfig>();
  const extra = new Map<string, AiExtraConfig>();
  const difficulty = level.difficulty ?? "GD_2";
  const settings = await tryRead(source, paths.aiSettings);
  if (settings) {
    for (const item of flattenTasks(readTaskTree(readQvmCallTree(settings)))) {
      if (item.type !== "HumanAIConfigItem" || item.params["Difficulty"] !== difficulty) continue;
      const type = item.params["AI Type"];
      if (typeof type !== "string") continue;
      try {
        combat.set(type, aiCombatConfig(item.params));
        const n = (k: string, d: number) => (typeof item.params[k] === "number" ? (item.params[k] as number) : d);
        extra.set(type, {
          closeCombatHitProbability: n("Close Combat hit probability", 0.7),
          closeCombatDamage: n("Close Combat damage", 0.3),
          grenadeFlySeconds: [n("Combat grenade minimum fly time (in seconds)", 0.5), n("Combat grenade random fly time (in seconds)", 0.5)],
          grenadeExplodeSeconds: [n("Combat grenade minimum explode time (in seconds)", 0.3), n("Combat grenade random explode time (in seconds)", 0.7)],
          recoilThreshold: n("Recoil threshold", 0.33),
        });
      } catch (e) {
        warnings.push(`settings.qvm ${type}: ${(e as Error).message}`);
      }
    }
  } else {
    warnings.push("missing common/ai/settings.qvm");
  }

  const footstepRange = new Map<string, number>();
  const materials = await tryRead(source, "material/material.qvm");
  if (materials) for (const m of readGameMaterials(materials)) footstepRange.set(m.name, m.footstepNoiseM * 4096);

  return { level, common, mission, graphs, combat, extra, footstepRange, taskById, warnings };
}

/** Common script name for an AI type value (table 0x53a8fc) [recovered]. */
export function commonScriptFor(aiType: number): string | null {
  return QVM_AI_TYPE_SCRIPT[aiType] ?? null;
}
