/**
 * `loadLevelManifest` — fetch and parse a level's `manifest.json`.
 *
 * Path convention (docs/loader-api.md): the manifest lives under the ASSETS
 * root at "assets/<name>/manifest.json". The assets `IAssetSource` is itself
 * rooted at the assets root (e.g. createHttpAssetSource("/assets/")), so the
 * path handed to the source is "<name>/manifest.json".
 *
 * Returns null when the manifest does not exist; throws when it exists but
 * is not valid JSON or not a JSON object (so pipeline breakage is loud).
 */
import type { IAssetSource, LevelManifest } from "../contracts";

export async function loadLevelManifest(
  assetsSource: IAssetSource,
  name: string,
): Promise<LevelManifest | null> {
  const path = `${name}/manifest.json`;
  if (!(await assetsSource.exists(path))) {
    return null;
  }
  const buffer = await assetsSource.readBinary(path);
  const text = new TextDecoder().decode(buffer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`manifest: invalid JSON in ${path}: ${reason}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`manifest: ${path} is not a JSON object`);
  }
  return parsed as LevelManifest;
}
