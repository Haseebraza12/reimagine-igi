/**
 * Shared helpers for loader tests: real-raw-file access and an in-memory
 * IAssetSource implementation (no network, no disk).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IAssetSource } from "../src/contracts";

/** Absolute path of web-port/public/raw (staged original game files). */
export const RAW_ROOT = fileURLToPath(new URL("../public/raw", import.meta.url));

/** Read a file under public/raw as an ArrayBuffer (throws when missing). */
export async function readRaw(relativePath: string): Promise<ArrayBuffer> {
  const buffer = await readFile(`${RAW_ROOT}/${relativePath}`);
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(buffer);
  return out;
}

/**
 * Build an IAssetSource over an in-memory file map. Paths are keys with
 * forward slashes, no leading slash (IAssetSource rule).
 */
export function memorySource(files: Record<string, ArrayBuffer | Uint8Array>): IAssetSource {
  const map = new Map<string, ArrayBuffer>();
  for (const [key, value] of Object.entries(files)) {
    if (value instanceof Uint8Array) {
      const copy = new ArrayBuffer(value.byteLength);
      new Uint8Array(copy).set(value);
      map.set(key, copy);
    } else {
      map.set(key, value);
    }
  }
  return {
    async exists(path: string): Promise<boolean> {
      return map.has(path);
    },
    async readBinary(path: string): Promise<ArrayBuffer> {
      const found = map.get(path);
      if (!found) throw new Error(`memorySource: missing ${path}`);
      return found;
    },
  };
}

/** An IAssetSource that throws when anything tries to read from it. */
export function explodingSource(): IAssetSource {
  return {
    async exists(): Promise<boolean> {
      return true; // Pretends everything exists, but reads must never happen.
    },
    async readBinary(path: string): Promise<ArrayBuffer> {
      throw new Error(`explodingSource: readBinary("${path}") must not be called`);
    },
  };
}
