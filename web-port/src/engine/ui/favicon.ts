/**
 * The browser tab's icon: the main menu's logo (logo.pic / logo_us.pic, the picture FUN_004210e0
 * draws above the menu), taken from the game files the port reads at run time. Nothing is
 * stored with the port; index.html carries an empty icon until the menu archive is decoded.
 * The gunman in the logo is a cut-out (alpha 0) that the menu's dark backdrop fills, so the
 * icon gets a dark backing too: on a light tab strip the figure would vanish.
 */
import type { DecodedTexture } from "../../contracts";

/** Icon edge in pixels (browsers scale it down for the tab). */
const SIZE = 64;
/** The backing: a near-black green rounded square (the menu backdrop's tone) and the margin inside it. */
const BACKING = { colour: "#06140a", radius: 10, margin: 3 } as const;

/** The bounding box of the picture's opaque pixels, or null when it has none. */
export function opaqueBounds(pic: DecodedTexture): { x: number; y: number; w: number; h: number } | null {
  let x0 = pic.width;
  let y0 = pic.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < pic.height; y++) {
    for (let x = 0; x < pic.width; x++) {
      if (pic.rgba[(y * pic.width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The emblem of logo.pic (295 x 107, measured): the "G" with the gunman and his rifle, columns
 * 95..206 and rows 10..103 (under the "P R O J E C T" row), nearly square. The whole logo is
 * about 3:1 and shrinks to a strip in a square tab icon; the emblem stays readable at 16 px.
 */
export const LOGO_EMBLEM = { width: 295, height: 107, x: 95, y: 10, w: 112, h: 94 } as const;

/** The part of the logo shown as the icon: the emblem when `pic` is logo.pic, else its opaque pixels. */
export function iconRegion(pic: DecodedTexture): { x: number; y: number; w: number; h: number } | null {
  const e = LOGO_EMBLEM;
  if (pic.width === e.width && pic.height === e.height) return { x: e.x, y: e.y, w: e.w, h: e.h };
  return opaqueBounds(pic);
}

/** Set the tab icon to `pic` (iconRegion, centred in a square). False when the page has no canvas. */
export function setFaviconFromPicture(pic: DecodedTexture): boolean {
  if (typeof document === "undefined") return false;
  const box = iconRegion(pic);
  if (!box) return false;
  const src = document.createElement("canvas");
  src.width = pic.width;
  src.height = pic.height;
  const sctx = src.getContext("2d");
  const out = document.createElement("canvas");
  out.width = SIZE;
  out.height = SIZE;
  const octx = out.getContext("2d");
  if (!sctx || !octx) return false;
  sctx.putImageData(new ImageData(new Uint8ClampedArray(pic.rgba), pic.width, pic.height), 0, 0);
  octx.fillStyle = BACKING.colour;
  octx.beginPath();
  if (typeof octx.roundRect === "function") octx.roundRect(0, 0, SIZE, SIZE, BACKING.radius);
  else octx.rect(0, 0, SIZE, SIZE);
  octx.fill();
  const inner = SIZE - 2 * BACKING.margin;
  const scale = Math.min(inner / box.w, inner / box.h);
  const w = box.w * scale;
  const h = box.h * scale;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(src, box.x, box.y, box.w, box.h, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/png";
  link.href = out.toDataURL("image/png");
  return true;
}
