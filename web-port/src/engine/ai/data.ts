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
  flattenTasks,
  loadQvmProgram,
  readAiGraph,
  readGameMaterials,
  readQvmCallTree,
  readTaskTree,
  type AiGraph,
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
  /** AIGraph "Graph position" (IGI world units). */
  position: V3;
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

export async function loadAiLevelData(source: IAssetSource, level: IgiLevel, paths: IgiLevelPaths = LEVEL1_PATHS): Promise<AiLevelData> {
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
    const position: V3 = Array.isArray(p) && p.length === 3 ? [Number(p[0]), Number(p[1]), Number(p[2])] : [0, 0, 0];
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
