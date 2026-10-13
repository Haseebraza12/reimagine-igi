# Loader API contract (integration backbone)

This is the exact API boundary between the parser layer and the engine layer.
Both sides MUST match these signatures. Source of truth types: `web-port/src/contracts.ts`.

## `web-port/src/loaders/index.ts` (owned by the loaders agent)

```ts
import type { DecodedTexture, IAssetSource, LevelManifest, TerrainData, Vec3 } from "../contracts";

/** HTTP asset source rooted at baseUrl (default "/raw/"). exists() uses HEAD. */
export function createHttpAssetSource(baseUrl?: string): IAssetSource;

/** Parse an IGI ILFF/IRES .res container. Throws Error on malformed input. */
export function readIlffMembers(buffer: ArrayBuffer): Array<{ name: string; offset: number; size: number; payload: ArrayBuffer }>;

/** Decode a LOOP .tex bitmap (v11 observed: A1R5G5B5 / BGRA8888). Throws on unknown variants. */
export function decodeTex(buffer: ArrayBuffer): DecodedTexture;

/** Parse a .hmp heightfield. size = vertices per side. heights normalized to 0..1 (raw/65535). */
export function readHmp(buffer: ArrayBuffer): { size: number; heights: Float32Array };

/** Parse a .lmp lightmap: uint8 intensities, size*size. */
export function readLmp(buffer: ArrayBuffer): { size: number; intensities: Uint8Array };

/** Filesystem-backed source for vitest (Node only). Lives in its own module so the
 *  browser bundle never pulls in node:fs. Tests import it directly:
 *  `import { createFsAssetSource } from "../src/loaders/fs-source";` */
// src/loaders/fs-source.ts
export function createFsAssetSource(rootDir: string): IAssetSource;

/**
 * Load terrain for the level described by `spec`.
 * Order: heightsBin via `assetsSource` -> raw hmp via `rawSource`.
 * `heightsBin` = Float32 LE, size*size, row-major (index = z*size + x), **already
 * scaled to world units by the pipeline** (loaders use values as-is).
 * Raw `.hmp` path: values are raw/65535 normalized; loaders apply `heightScale`.
 * Attaches lightmap when available (lightmapBin: uint8 size*size, or raw .lmp).
 */
export function loadTerrain(
  rawSource: IAssetSource,
  assetsSource: IAssetSource,
  spec: LevelManifest["terrain"],
): Promise<TerrainData>;

/** Fetch "assets/<name>/manifest.json" from the assets source; null when absent. */
export function loadLevelManifest(assetsSource: IAssetSource, name: string): Promise<LevelManifest | null>;
```

## Runtime asset locations served by Vite

| URL root      | Content                                                            | Producer          |
|---------------|--------------------------------------------------------------------|-------------------|
| `/raw/`       | Original game files (local only, gitignored)                       | staging (already) |
| `/assets/`    | Converted PNG/glTF/JSON/bin, incl. `level1/manifest.json`          | tools/pipeline    |
| `/generated/` | Gameplay JSON (`player.json`, `weapons.json`, `level1-gameplay.json`) | tools/igi_qvm.py |

## Engine consumption rules

- Engine imports ONLY `src/contracts.ts` + `src/loaders/index.ts`.
- Engine must boot without any assets: procedural synthetic terrain + defaults.
- Generated JSON (if present) overrides `DEFAULT_PLAYER_TUNING` / `DEFAULT_WEAPONS` and
  supplies objectives/spawn/patrols; schema: `GeneratedData<T>` from contracts.ts.
