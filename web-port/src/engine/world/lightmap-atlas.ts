/**
 * Packs the baked object lightmaps (.olm) into a few large textures so the
 * batched world geometry keeps a small number of draw calls (one material per
 * texture and page). Level 1: the LOD-1 lightmaps plus those of the LOD
 * variants fit in one 2048 x 2048 page (all 1,308 .olm files would fill ~14 %).
 *
 * Each lightmap gets a 2-texel border that replicates its edge texels: the
 * original samples every lightmap with CLAMP addressing and bilinear
 * filtering (no mipmaps), and model lightmap UVs stay within half-texel
 * insets, so a replicated border reproduces that sampling inside an atlas.
 */
import * as THREE from "three";
import type { DecodedTexture } from "../../contracts";

const PAGE = 2048;
const PAD = 2;

export interface AtlasRect {
  page: number;
  /** Texel rectangle of the lightmap itself (excluding the border). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LightmapAtlas {
  pages: THREE.DataTexture[];
  rects: Map<string, AtlasRect>;
  /** Map a lightmap uv (0..1 within the lightmap) to atlas uv. */
  remap(rect: AtlasRect, u: number, v: number): [number, number];
  dispose(): void;
}

export function buildLightmapAtlas(lightmaps: Map<string, DecodedTexture>): LightmapAtlas {
  // Shelf packing, tallest first.
  const items = [...lightmaps.entries()].sort((a, b) => b[1].height - a[1].height || b[1].width - a[1].width);
  const rects = new Map<string, AtlasRect>();
  const pageData: Uint8Array<ArrayBuffer>[] = [];
  let page = -1;
  let cursorX = 0;
  let cursorY = 0;
  let shelf = 0;
  const newPage = () => {
    pageData.push(new Uint8Array(PAGE * PAGE * 4));
    page++;
    cursorX = 0;
    cursorY = 0;
    shelf = 0;
  };
  newPage();
  for (const [name, tex] of items) {
    const w = tex.width + PAD * 2;
    const h = tex.height + PAD * 2;
    if (w > PAGE || h > PAGE) throw new Error(`lightmap ${name} (${tex.width}x${tex.height}) exceeds the atlas page`);
    if (cursorX + w > PAGE) {
      cursorX = 0;
      cursorY += shelf;
      shelf = 0;
    }
    if (cursorY + h > PAGE) newPage();
    const x0 = cursorX + PAD;
    const y0 = cursorY + PAD;
    const data = pageData[page];
    // Copy with replicated borders.
    for (let y = -PAD; y < tex.height + PAD; y++) {
      const sy = Math.min(Math.max(y, 0), tex.height - 1);
      for (let x = -PAD; x < tex.width + PAD; x++) {
        const sx = Math.min(Math.max(x, 0), tex.width - 1);
        const s = (sy * tex.width + sx) * 4;
        const d = ((y0 + y) * PAGE + (x0 + x)) * 4;
        data[d] = tex.rgba[s];
        data[d + 1] = tex.rgba[s + 1];
        data[d + 2] = tex.rgba[s + 2];
        data[d + 3] = 255;
      }
    }
    rects.set(name, { page, x: x0, y: y0, width: tex.width, height: tex.height });
    cursorX += w;
    shelf = Math.max(shelf, h);
  }
  const pages = pageData.map((data) => {
    const texture = new THREE.DataTexture(data, PAGE, PAGE, THREE.RGBAFormat);
    texture.flipY = false; // row 0 = first stored row = lightmap v 0
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter; // the original uses no mipmaps for lightmaps
    texture.generateMipmaps = false;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.channel = 1; // sampled with the "uv1" attribute
    texture.needsUpdate = true;
    return texture;
  });
  return {
    pages,
    rects,
    remap(rect, u, v) {
      const cu = Math.min(Math.max(u, 0), 1);
      const cv = Math.min(Math.max(v, 0), 1);
      return [(rect.x + cu * rect.width) / PAGE, (rect.y + cv * rect.height) / PAGE];
    },
    dispose() {
      for (const p of pages) p.dispose();
    },
  };
}
