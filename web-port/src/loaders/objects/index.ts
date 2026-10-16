/**
 * Task types implemented outside loaders/mission.ts (registerTaskBehaviour).
 * Each module registers its behaviour when imported; loaders/index.ts
 * imports this file once for that side effect and re-exports the rules.
 */
export * from "./elevator";
export * from "./power";
export * from "./use-tasks";
export * from "./rotating-object";
export * from "./alarm-light";
export * from "./siren";
export * from "./rain-effect";
// Combat (GuardGenerator, MineField, StationaryGun, AIStationaryGunHolder): registered here, imported
// directly by the engine code that needs their exports.
import "./guard-generator";
import "./mine-field";
import "./stationary-gun";
import "./ai-stationary-gun";
