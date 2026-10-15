/**
 * Loading screen (FUN_00488860 show, FUN_00488a40 progress; docs/hud.md
 * section 6): loading.pic (loading_us.pic for the Windows country "USA") 1:1 at
 * ((W - 640) / 2, (H - 480) / 2), and a 560 x 10 bar at +40, +440 whose pixels
 * are written directly (no blending): 0x00007F00 empty, 0x0000FF00 filled,
 * filled width trunc(560 * done / total). No text.
 */
import { LOADING_SCREEN, loadingBarFill } from "../../loaders";
import type { UiArchive } from "./assets";
import type { Painter } from "./painter";

export function submitLoading(archive: UiArchive, usa: boolean, done: number, total: number, p: Painter): void {
  const bar = LOADING_SCREEN.bar;
  const fill = loadingBarFill(Math.min(done, total), total);
  // Submitted fill first so the reverse-order draw puts it over the empty bar.
  if (fill > 0) p.rect(bar.x, bar.y, bar.x + fill, bar.y + bar.height, [...LOADING_SCREEN.fillRgb, 255]);
  p.rect(bar.x, bar.y, bar.x + bar.width, bar.y + bar.height, [...LOADING_SCREEN.emptyRgb, 255]);
  const picture = archive.pictures.get(usa ? LOADING_SCREEN.pictureUsa : LOADING_SCREEN.picture);
  if (picture) p.image(picture, 0, 0);
  // The rest of the 4:3 frame is the cleared back buffer (black, inferred).
  p.rect(0, 0, 640, 480, [0, 0, 0, 255]);
}
