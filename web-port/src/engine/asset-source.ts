/**
 * Where the engine reads the original game files: the dev / preview servers'
 * "/raw/" (staged game-data/) or, on a static host such as Vercel, the folder
 * the player picked (loaders/local-source.ts, ui/folder-picker.ts). main.ts
 * sets it before the game starts; every subsystem's default source is this one.
 */
import type { IAssetSource } from "../contracts";
import { createHttpAssetSource } from "../loaders";

let current: IAssetSource | null = null;

export function setGameAssetSource(source: IAssetSource): void {
  current = source;
}

/** The active source ("/raw/" when none was set). */
export function gameAssetSource(): IAssetSource {
  if (!current) current = createHttpAssetSource("/raw/");
  return current;
}
