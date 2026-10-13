/**
 * Loader layer — IGI binary format parsers exposed to the engine.
 *
 * NOTE: This is a STUB created at scaffold time so the engine compiles while
 * the real implementation is built in parallel. The loaders agent replaces the
 * body of every function here; signatures are frozen by docs/loader-api.md.
 */
import type {
  DecodedTexture,
  IAssetSource,
  LevelManifest,
  TerrainData,
} from "../contracts";

function notImplemented(name: string): never {
  throw new Error(`loaders/${name} not implemented yet`);
}

export function createHttpAssetSource(baseUrl?: string): IAssetSource {
  void baseUrl;
  notImplemented("createHttpAssetSource");
}

export function readIlffMembers(
  _buffer: ArrayBuffer,
): Array<{ name: string; offset: number; size: number; payload: ArrayBuffer }> {
  notImplemented("readIlffMembers");
}

export function decodeTex(_buffer: ArrayBuffer): DecodedTexture {
  notImplemented("decodeTex");
}

export function readHmp(_buffer: ArrayBuffer): {
  size: number;
  heights: Float32Array;
} {
  notImplemented("readHmp");
}

export function readLmp(_buffer: ArrayBuffer): {
  size: number;
  intensities: Uint8Array;
} {
  notImplemented("readLmp");
}

export function loadTerrain(
  _rawSource: IAssetSource,
  _assetsSource: IAssetSource,
  _spec: LevelManifest["terrain"],
): Promise<TerrainData> {
  notImplemented("loadTerrain");
}

export function loadLevelManifest(
  _assetsSource: IAssetSource,
  _name: string,
): Promise<LevelManifest | null> {
  notImplemented("loadLevelManifest");
}
