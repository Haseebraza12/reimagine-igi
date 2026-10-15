/**
 * Loader layer — IGI binary format readers exposed to the engine.
 *
 * The engine imports ONLY this module plus src/contracts.ts (docs/loader-api.md).
 * Each module documents its measured layout and confidence:
 *
 *   ilff.ts      ILFF/IRES .res containers (port of tools/igi_formats.py)
 *   loop-tex.ts  LOOP v11 .tex bitmaps
 *   qvm.ts       LOOP v8 script call trees (objects.qvm, magicobj.qvm, ...)
 *   tasks.ts     mission task tree (Task_DeclareParameters / Task_New)
 *   mef.ts       .mef models (render mesh, attachments, collision)
 *   mtp.ts       .mtp model -> texture tables
 *   ilsf.ts      ILSF PCM sounds
 *   coords.ts    IGI -> engine coordinate conversion
 *   terrain-octree.ts  terrain.ctr/.cmd/.hmp runtime terrain surface
 *   terrain-look.ts    terrain texturing (terrain.qvm/.bit/.tex) and lightmaps (.lmp)
 *   level.ts     whole-level assembly from the original files
 *   http-source.ts  HTTP asset source ("/raw/")
 *   qvm-vm.ts        complete LOOP v8 script VM + task-condition expressions (docs/qvm-vm.md)
 *   audio.ts         ILSF (PCM + IMA ADPCM), sound definitions, the software 3D mixer rules (docs/audio.md)
 *   ui.ts            HUD/menu sprites, fonts, HUD layout and timing rules (docs/hud.md)
 *   render-params.ts camera, fog, sky, LOD and draw-state rules (docs/rendering.md)
 *   gameplay-params.ts player movement, damage, weapon and detection rules (docs/gameplay.md)
 *   anim.ts / skeleton.ts  .iff animations, bone models and skinning (docs/characters.md)
 *   x87.ts           igi.exe's FPU state: chop-mode FISTP and arithmetic (docs/gameplay.md "FPU rounding mode")
 *
 * fs-source.ts (Node only) is intentionally NOT re-exported so the browser
 * bundle never pulls in node:fs; tests import it directly.
 */
export type { IlffMember } from "./ilff";
export { readIlffMembers } from "./ilff";
export { decodeTex, decodeTexLayers } from "./loop-tex";
export type { QvmCall, QvmSymbol, QvmValue } from "./qvm";
export { readQvmCallTree, readQvmFile, readQvmLiteralCalls, isQvmCall, isQvmSymbol } from "./qvm";
export type { IgiTask, TaskParam } from "./tasks";
export { readTaskTree, flattenTasks } from "./tasks";
export type { MefAttachment, MefCollisionMesh, MefGroup, MefModel } from "./mef";
export { readMef } from "./mef";
export type { MtpTable } from "./mtp";
export { readMtp } from "./mtp";
export type { DecodedSound } from "./ilsf";
export { decodeIlsf } from "./ilsf";
export { decodeOlm } from "./olm";
export { IGI_UNITS_PER_METRE, igiPointToEngine, igiDirToEngine } from "./coords";
export type {
  IgiLevel,
  IgiLevelPaths,
  LevelArea,
  LevelEnvironment,
  LevelInstance,
  LevelMessage,
  LevelModel,
  LevelModelGroup,
  LevelCollisionSet,
  LevelObjective,
  LevelSoldier,
  LevelAiView,
  LevelAiCombat,
  LevelTerrain,
  LevelTerrainMesh,
  LevelTerrainRenderMesh,
  LevelWeapon,
  LevelGunPart,
  LevelBoneModel,
} from "./level";
export type { TerrainLookInput, TerrainMaterialLevel, TerrainRenderMesh } from "./terrain-look";
export { TerrainLook, readTerrainBit, readTerrainLmp, NO_LIGHTMAP } from "./terrain-look";
export type { HeightMapTask, TerrainMesh } from "./terrain-octree";
export { TerrainOctree } from "./terrain-octree";
export { LEVEL1_PATHS, loadIgiLevel, decodeLevelTexture } from "./level";
export { createHttpAssetSource } from "./http-source";

// Recovered subsystems (each module documents its evidence).
export * from "./qvm-vm";
export * from "./audio";
export * from "./ui";
export * from "./render-params";
export * from "./gameplay-params";
export * from "./anim";
export * from "./skeleton";
// Same meaning in both modules (both now truncate, see x87.ts); pick one explicitly.
export { roundHalfEven } from "./ui";
// The FPU conversion/arithmetic rules every float -> int site uses.
export * from "./x87";
export { GAME_TICKS_PER_SECOND } from "./render-params";
// Shared types (contracts.ts), re-exported for engine modules. Vec3 is pinned
// here because several loaders declare the same tuple type.
export type { DecodedTexture, Vec3 } from "../contracts";
// Mission task runtime (docs/mission.md).
export * from "./mission";
// Soldier AI (docs/ai.md): walk graphs and the recovered rule functions.
// ai-rules shares three names with gameplay-params (AiView, AiCombatConfig,
// aiHitProbability); they are re-exported here with an "AiRules"/"aiRules" prefix.
export * from "./ai-graph";
export {
  AI_TICKS_PER_SECOND, AI_UNITS_PER_METRE, x87Round, AIEVENT, AI_EVENT_FILTER, AI_EVENT_PRODUCERS,
  aiEventAccepted, AI_ALERT, AI_GUNSHOT_RANGE, AI_GUNSHOT_SILENCED_RANGE, aiDefaultView, aiApplyViewCall,
  aiViewAngles, aiInViewCone, AI_LOS_MIN_HIT_FRACTION, aiLineOfSightClear, AI_VISION_TARGET_HEIGHT,
  AI_AIM_HEIGHT, AI_PERCEPTION, aiNewPerceptionSlot, aiPerceptionStep, aiCombatConfig,
  aiHitProbability as aiRulesHitProbability, aiRoundsPerSequence, aiShotDelayTicks, aiAimStep,
  AI_AIM_TOLERANCE, aiBulletMayHitPlayer, AI_MAX_SHOOTERS, AI_CLOSE_COMBAT_DISTANCE,
  AI_FIRE_WHILE_RUNNING_COS, aiEvasiveChoice, AI_COMBAT_DECISION, aiCombatDecision, PATROL_COMMAND,
  AiPatrolCursor, AI_TURN_CLAMP, AI_LOOKAT_NODE_TOLERANCE, AI_WAYPOINT_REACHED, aiSteerValue, AI_CHANNEL,
  AI_BODY_STATE, AI_OCCUPANCY_CELL, AI_OCCUPANCY_KERNEL, AiNodeOccupancy, aiReactionDelayTicks,
  AI_EMPTY_STACK_PRIORITY, AI_DEATH_COUNTDOWN_TICKS,
} from "./ai-rules";
export type {
  AiEventProducer, AiEventRecord, AiListener, AiViewCone, AiView as AiRulesView, AiEyeFrame,
  AiPerceptionSlot, AiCombatConfig as AiRulesCombatConfig, AiEvasiveInput, AiCombatDecisionInput,
  PatrolCommand,
} from "./ai-rules";
// Collision meshes and surface materials (docs/collision.md).
export * from "./collision-mesh";
