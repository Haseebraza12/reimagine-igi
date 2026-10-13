/**
 * Shared contracts between the loader layer (binary format parsers) and the
 * engine layer. These interfaces are the integration backbone of the web port:
 *
 *  - src/loaders/**  implements readers for IGI binary formats -> these types
 *  - src/engine/**   consumes only these types (never raw formats)
 *  - tools/igipipe   (Python) emits files that deserialize into these types
 *  - tools/igi_qvm.py emits runtime JSON (public/generated/*.json) that the
 *                    engine fetches, falling back to committed defaults
 *
 * Confidence vocabulary (matches the evidence-ledger workflow):
 *  "observed"   = measured directly from original game data/files
 *  "recovered"  = supported by static analysis of formats/executable
 *  "inferred"   = reasonable interpretation, still needs testing
 */

// ---------------------------------------------------------------------------
// Asset access
// ---------------------------------------------------------------------------

/** Abstraction over "where game files come from" (HTTP, local folder, synthetic). */
export interface IAssetSource {
  /** True if a file exists in this source. */
  exists(path: string): Promise<boolean>;
  /** Read a file as an ArrayBuffer. Paths use forward slashes, no leading slash. */
  readBinary(path: string): Promise<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/** An RGBA texture decoded from an IGI .tex (LOOP) bitmap. */
export interface DecodedTexture {
  width: number;
  height: number;
  /** RGBA8888, length === width * height * 4, row-major, top-down. */
  rgba: Uint8ClampedArray;
  /** Provenance, e.g. "LOOP-type5-rgb565" or "LOOP-type7-palettized". */
  format: string;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/**
 * Heightfield terrain. IGI stores elevation in .hmp (16-bit tile grids),
 * illumination in .lmp, partitioning in .ctr (octree) + .cmd (mesh commands),
 * materials in .bit. The loader layer decodes all of it into this runtime
 * form so the engine never touches the raw formats.
 */
export interface TerrainData {
  /** Vertices per side; the grid is size x size. */
  size: number;
  /** World-space distance between adjacent vertices, in game units (meters-ish). */
  cellSize: number;
  /** Height values, length size*size, row-major (index = z * size + x), y-up. */
  heights: Float32Array;
  /**
   * Optional baked lighting, same resolution as `heights` (size*size),
   * one byte per vertex expanded to 0..1.
   */
  lightmap?: Float32Array;
  /** Terrain diffuse texture if one was resolvable. */
  texture?: DecodedTexture;
}


// ---------------------------------------------------------------------------
// Level / mission manifest
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export interface LevelObjectPlacement {
  id: string;
  /** Logical model key or extracted glTF path, relative to the asset root. */
  model?: string;
  /** Logical texture key or extracted PNG path, relative to the asset root. */
  texture?: string;
  position: Vec3;
  /** Yaw rotation in degrees. */
  yaw: number;
}

export interface ObjectiveSpec {
  id: string;
  type: "reach";
  position: Vec3;
  radius: number;
  description: string;
}

export interface LevelManifest {
  name: string;
  /** Who generated this manifest and how much to trust its values. */
  provenance?: {
    generator: string;
    confidence: "observed" | "recovered" | "inferred";
    notes?: string;
  };
  terrain: {
    /** Path to .hmp relative to raw root, e.g. "missions/location0/level1/terrain/terrain.hmp". */
    hmp: string;
    /** Path to .lmp lightmap (optional). */
    lmp?: string;
    /**
     * Optional pre-decoded Float32 heights (size*size little-endian f32, row-major)
     * relative to the *assets* root (e.g. "level1/terrain/heights.bin").
     * When present, loaders prefer it over parsing `hmp` directly.
     */
    heightsBin?: string;
    /** Optional pre-decoded lightmap bytes (size*size uint8) relative to assets root. */
    lightmapBin?: string;
    cellSize: number;
    /** Multiplier converting raw 16-bit elevation to world units. */
    heightScale: number;
    worldOffset?: Vec3;
  };
  /** Sky layers (bottom->top) as .tex paths, optional. */
  skyLayers?: string[];
  objects: LevelObjectPlacement[];
  playerSpawn: { position: Vec3; yaw: number };
  objectives: ObjectiveSpec[];
  /** Enemy patrol routes: sequences of world positions. */
  enemyPatrols?: Vec3[][];
}

// ---------------------------------------------------------------------------
// Gameplay tuning (recovered from QVM scripts / executable)
// ---------------------------------------------------------------------------

export interface WeaponSpec {
  id: string;
  name: string;
  damage: number;
  /** Rounds per minute (cyclic rate). */
  rpm: number;
  magSize: number;
  reloadSeconds: number;
  /** Cone-of-fire half-angle in degrees at reference range. */
  spreadDeg: number;
  range: number;
  automatic: boolean;
}

export interface PlayerTuning {
  walkSpeed: number;
  runSpeed: number;
  crouchSpeed: number;
  jumpVelocity: number;
  gravity: number;
  /** Eye height standing, game units. */
  eyeHeight: number;
  /** Eye height crouching, game units. */
  crouchEyeHeight: number;
  pitchMinDeg: number;
  pitchMaxDeg: number;
  /** Ground acceleration (units/s^2). */
  acceleration: number;
  /** Ground friction (1/s). */
  friction: number;
}

/** Runtime JSON emitted by tools/igi_qvm.py; sources document how values were obtained. */
export interface GeneratedData<T> {
  data: T;
  source: {
    files: string[];
    method: string;
    confidence: "observed" | "recovered" | "inferred";
    notes?: string;
  };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export interface NavNode {
  position: Vec3;
  /** Indices of connected nodes. */
  links: number[];
}

export interface NavGraph {
  nodes: NavNode[];
}

// ---------------------------------------------------------------------------
// Committed defaults (inferred placeholders; generated JSON overrides at runtime)
// ---------------------------------------------------------------------------

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

export const DEFAULT_WEAPONS: WeaponSpec[] = [
  {
    id: "AK47",
    name: "AK-47",
    damage: 24,
    rpm: 600,
    magSize: 30,
    reloadSeconds: 2.4,
    spreadDeg: 1.2,
    range: 300,
    automatic: true,
  },
];
