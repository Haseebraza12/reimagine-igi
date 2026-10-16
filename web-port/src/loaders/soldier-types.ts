/**
 * The objects.qvm task types igi.exe treats as soldiers (subclasses of Human
 * with the HumanSoldier schema "Position, Gamma, Model, Team, Bone Heirachy,
 * Stand Animation", a HumanAI child and Gun children) [recovered, full exe]:
 *   - HumanSoldier (FUN_0045cab0): create FUN_0045cc50, skeleton 1, Stand
 *     Animation -1, body graph 0x53ec10 (engine/ai/soldier-graph.ts);
 *   - HumanSoldierFemale (FUN_00454970, 5 tasks in mission 14): create
 *     0x454b10, skeleton 6, Stand Animation -1, its own graph 0x53e400;
 *   - HumanSoldierRPG (FUN_00456ad0, mission 10 #431): create FUN_00456c70,
 *     skeleton 2, Stand Animation 2, its own graph 0x53e6a8.
 * (HumanSoldierPistol, FUN_00459880, is registered but placed in no mission.)
 * engine/ai/soldier-variants.ts runs the variants' graphs.
 */
export const SOLDIER_TASK_TYPES: ReadonlySet<string> = new Set(["HumanSoldier", "HumanSoldierFemale", "HumanSoldierRPG"]);

/** Create defaults of "Bone Heirachy" (+0xcf8) and "Stand Animation" (+0xcfc) per soldier type. */
export const SOLDIER_TYPE_DEFAULTS: Readonly<Record<string, { skeleton: number; standAnimation: number }>> = {
  HumanSoldier: { skeleton: 1, standAnimation: -1 },
  HumanSoldierFemale: { skeleton: 6, standAnimation: -1 },
  HumanSoldierRPG: { skeleton: 2, standAnimation: 2 },
};

export function isSoldierTaskType(type: string): boolean {
  return SOLDIER_TASK_TYPES.has(type);
}
