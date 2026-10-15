/**
 * Filesystem-backed `IAssetSource` for vitest (Node only).
 *
 * Lives in its own module so the browser bundle never pulls in `node:fs`:
 * `src/loaders/index.ts` deliberately does NOT re-export this file; tests
 * import it directly:
 *
 *   import { createFsAssetSource } from "../src/loaders/fs-source";
 *
 * (Verified: `npx vite build` succeeds without this module in the graph,
 * because only tests/** reference it and vite builds from index.html.)
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IAssetSource } from "../contracts";

/** Map an IAssetSource path ("a/b.bin") onto a filesystem path under rootDir. */
function resolveUnder(rootDir: string, path: string): string {
  const clean = path.replace(/^\/+/, "");
  return join(rootDir, ...clean.split("/"));
}

/**
 * Create an asset source rooted at a local directory (e.g. the repo's
 * `web-port/game-data`). Paths use forward slashes, no leading slash.
 */
export function createFsAssetSource(rootDir: string): IAssetSource {
  return {
    async exists(path: string): Promise<boolean> {
      try {
        const info = await stat(resolveUnder(rootDir, path));
        return info.isFile();
      } catch {
        return false;
      }
    },

    async readBinary(path: string): Promise<ArrayBuffer> {
      const buffer = await readFile(resolveUnder(rootDir, path));
      // Copy into a plain ArrayBuffer so the result type matches the browser
      // contract exactly (Node Buffers are Uint8Array views on pooled memory).
      const out = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(out).set(buffer);
      return out;
    },
  };
}
