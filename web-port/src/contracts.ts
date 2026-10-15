/**
 * Shared types between the loader layer (binary format readers) and the
 * engine layer. The engine imports only this module and src/loaders/index.ts;
 * level data types (IgiLevel and friends) are exported by the loaders.
 *
 * Confidence vocabulary used across the port (docs/evidence-ledger.md):
 *  "observed"   = measured directly from original game data/files
 *  "recovered"  = supported by static analysis of formats/executable
 *  "inferred"   = reasonable interpretation, still needs testing
 */

/** Abstraction over "where game files come from" (HTTP, local folder, tests). */
export interface IAssetSource {
  /** True if a file exists in this source. */
  exists(path: string): Promise<boolean>;
  /** Read a file as an ArrayBuffer. Paths use forward slashes, no leading slash. */
  readBinary(path: string): Promise<ArrayBuffer>;
}

/** An RGBA texture decoded from an IGI .tex (LOOP) bitmap. */
export interface DecodedTexture {
  width: number;
  height: number;
  /** RGBA8888, length === width * height * 4, row-major, top-down. */
  rgba: Uint8ClampedArray;
  /** Provenance of the pixel interpretation, e.g. "inferred A1R5G5B5". */
  format: string;
}

export type Vec3 = [number, number, number];

/**
 * Player movement tuning. INFERRED placeholders: IGI's own values live in
 * humanplayer.qvm (DefineHumanPlayerGeneral, 43 positional arguments, all
 * recovered by tools/igi_qvm.py) but their meanings and units are not
 * established yet (docs/qvm.md).
 */
export interface PlayerTuning {
  walkSpeed: number;
  runSpeed: number;
  crouchSpeed: number;
  jumpVelocity: number;
  /** m/s^2. */
  gravity: number;
  /** Eye height standing, metres. */
  eyeHeight: number;
  /** Eye height crouching, metres. */
  crouchEyeHeight: number;
  pitchMinDeg: number;
  pitchMaxDeg: number;
  /** Ground acceleration (m/s^2). */
  acceleration: number;
  /** Ground friction (m/s^2 of deceleration with no input). */
  friction: number;
}

/**
 * LEGACY, unused by the engine: the early port's guessed movement values.
 * Player movement now follows the recovered rules (animation root motion x
 * 1.75, jump/air control/gravity from humanplayer.qvm and igi.exe; see
 * engine/player/player.ts and docs/gameplay.md). Kept only so the
 * GameContext.tuning field keeps a value.
 */
export const DEFAULT_PLAYER_TUNING: PlayerTuning = {
  walkSpeed: 3.4,
  runSpeed: 6.2,
  crouchSpeed: 1.8,
  jumpVelocity: 5.0,
  gravity: 14.0,
  eyeHeight: 1.7,
  crouchEyeHeight: 1.1,
  pitchMinDeg: -85,
  pitchMaxDeg: 85,
  acceleration: 20,
  friction: 8,
};
