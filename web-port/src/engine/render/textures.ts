/**
 * PNG texture loading with a small cache.
 *
 * Loads the pipeline's decoded PNGs (terrain.png, sky layers, .res members)
 * from the web asset root into Three.js textures. Missing files resolve to
 * null so a partially-converted level still renders (with fallback materials).
 */
import * as THREE from "three";
import type { IAssetSource } from "../../contracts";

export class TextureCache {
  private readonly cache = new Map<string, Promise<THREE.Texture | null>>();

  constructor(private readonly assets: IAssetSource) {}

  /**
   * Load `path` (relative to the assets root, e.g. "level1/terrain.png") as an
   * sRGB texture. Returns null when the file is absent or fails to decode.
   */
  load(path: string): Promise<THREE.Texture | null> {
    const existing = this.cache.get(path);
    if (existing) return existing;

    const promise = (async () => {
      if (!(await this.assets.exists(path))) return null;
      try {
        const buffer = await this.assets.readBinary(path);
        const blob = new Blob([buffer], { type: "image/png" });
        const url = URL.createObjectURL(blob);
        const texture = await new Promise<THREE.Texture>((resolve, reject) => {
          new THREE.TextureLoader().load(
            url,
            (tex) => resolve(tex),
            undefined,
            () => reject(new Error(`texture decode failed: ${path}`)),
          );
        });
        URL.revokeObjectURL(url);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = 4;
        return texture;
      } catch (error) {
        console.warn(`[textures] failed to load ${path}:`, error);
        return null;
      }
    })();

    this.cache.set(path, promise);
    return promise;
  }

  /** Drop every cached texture (level teardown). */
  dispose(): void {
    for (const promise of this.cache.values()) {
      void promise.then((tex) => tex?.dispose());
    }
    this.cache.clear();
  }
}
