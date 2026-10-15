/**
 * Draws the cut-scene camera filters (LineFilter, BandFilter, HandiCamFilter;
 * cutscene-filter-state.ts, docs/mission.md "Camera filters") over the world
 * frame with WebGL, in the 640 x 480 virtual frame of the 4:3 viewport.
 *
 * Render states recovered from the draw functions (D3D7, docs/rendering.md 5):
 *   - DrawLineFilter / DrawHandiCamFilter: no texture, COLOROP/ALPHAOP
 *     SELECTARG2(DIFFUSE), SRCALPHA / INVSRCALPHA, z test LESSEQUAL without z
 *     write at depth 614.4 units (0.15 m: nothing in a cut-scene is nearer, so
 *     the port draws without a depth test), LINELIST.
 *   - DrawBandFilter: SELECTARG1(TEXTURE), WRAP, no mip, z off, blend
 *     DESTCOLOR / ZERO (frame x texture colour), TRIANGLELIST.
 *   - Band tint (FUN_004aabf0 flag 0x80000000): ZERO / SRCCOLOR.
 *   - Text (font1.fnt) and the battery sprite: the 2-D path (FUN_00504300),
 *     texture x vertex colour, point sampling, SRCALPHA / INVSRCALPHA.
 * Call `draw` once per rendered frame after the world and before the
 * letterbox: the filters are deferred 3-D-pass draws, the WideScreenFilter
 * bars and the HUD are 2-D overlays drawn after them. `draw` also advances
 * the filters' render-frame counter (the exe's DAT_007ef148), which their
 * lifetime rule needs, so call it every frame even when nothing is shown.
 */
import * as THREE from "three";
import type { IAssetSource } from "../../contracts";
import { buildFontAtlas, layoutText, readUiArchive, type FontAtlas, type UiFont, type UiFrame } from "../../loaders/ui";
import { FILTER_ASSETS, FILTER_VIEWPORT, type CutsceneFilters, type FilterPrimitive } from "./cutscene-filter-state";

export interface CutsceneFilterAssets {
  /** computer/font1.fnt (CAMERA n, time code). */
  font: UiFont | null;
  /** common/sprites/battery.spr frame 0 (64 x 32). */
  battery: UiFrame | null;
}

/** Read font1.fnt and battery.spr from the user's installation (FUN_004148b0 paths). */
export async function loadCutsceneFilterAssets(source: IAssetSource): Promise<CutsceneFilterAssets> {
  const member = async (archive: string, name: string) => {
    try {
      return readUiArchive(await source.readBinary(archive)).get(name) ?? null;
    } catch (e) {
      console.warn(`[cutscene-filters] ${archive}: ${(e as Error).message}`);
      return null;
    }
  };
  const font = await member(FILTER_ASSETS.font.archive, FILTER_ASSETS.font.member);
  const battery = await member(FILTER_ASSETS.battery.archive, FILTER_ASSETS.battery.member);
  return {
    font: font?.kind === "font" ? font.font : null,
    battery: battery?.kind === "sprite" ? battery.sprite.frames[0] ?? null : null,
  };
}

export interface CutsceneFilterRenderer {
  /** Build this frame's filter primitives (advancing the filter RNG / frame counter) and draw them. */
  draw(filters: CutsceneFilters | null): void;
  dispose(): void;
}

type Pipe = "alpha" | "multiply" | "band" | "text" | "battery";

const VERTEX = /* glsl */ `
attribute vec4 rgba;
varying vec4 vRgba;
varying vec2 vUv;
void main() {
  vRgba = rgba;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FLAT = /* glsl */ `
varying vec4 vRgba;
void main() { gl_FragColor = vRgba; }`;
const TEXTURED = /* glsl */ `
uniform sampler2D map;
varying vec4 vRgba;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(map, vUv) * vRgba; }`;
const BAND = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0); }`;

function makeMaterial(pipe: Pipe): THREE.ShaderMaterial {
  const textured = pipe !== "alpha" && pipe !== "multiply";
  const m = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: pipe === "band" ? BAND : textured ? TEXTURED : FLAT,
    uniforms: textured ? { map: { value: null } } : {},
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide, // D3DRENDERSTATE_CULLMODE = NONE in every filter draw
  });
  if (pipe === "multiply") {
    m.blending = THREE.CustomBlending; // ZERO / SRCCOLOR
    m.blendSrc = THREE.ZeroFactor;
    m.blendDst = THREE.SrcColorFactor;
  } else if (pipe === "band") {
    m.blending = THREE.CustomBlending; // DESTCOLOR / ZERO
    m.blendSrc = THREE.DstColorFactor;
    m.blendDst = THREE.ZeroFactor;
  } else {
    m.blending = THREE.NormalBlending; // SRCALPHA / INVSRCALPHA
    m.premultipliedAlpha = false;
  }
  return m;
}

function dataTexture(width: number, height: number, data: Uint8Array<ArrayBuffer>, wrap: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Copy into an ArrayBuffer-backed Uint8Array (DataTexture upload). */
const bytes = (a: Uint8ClampedArray | Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(a);

/** Growing vertex arrays of one draw call. */
class Batch {
  pos = new Float32Array(6 * 3 * 64);
  uv = new Float32Array(6 * 2 * 64);
  rgba = new Uint8Array(6 * 4 * 64);
  count = 0;
  pipe: Pipe = "alpha";
  texture: THREE.Texture | null = null;
  readonly geometry = new THREE.BufferGeometry();
  readonly meshes = new Map<Pipe, THREE.Mesh>();
  readonly materials = new Map<Pipe, THREE.ShaderMaterial>();

  reset(pipe: Pipe, texture: THREE.Texture | null): void {
    this.pipe = pipe;
    this.texture = texture;
    this.count = 0;
  }

  private grow(): void {
    const g = <T extends Float32Array | Uint8Array>(a: T, make: (n: number) => T): T => {
      const b = make(a.length * 2);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos, (n) => new Float32Array(n));
    this.uv = g(this.uv, (n) => new Float32Array(n));
    this.rgba = g(this.rgba, (n) => new Uint8Array(n));
  }

  /** Quad in triangle-strip corner order a, b, c, d (triangles a b c, c b d). */
  quad(corners: readonly number[], uvs: readonly number[], rgba: readonly number[]): void {
    if ((this.count + 6) * 3 > this.pos.length) this.grow();
    for (const k of [0, 1, 2, 2, 1, 3]) {
      const i = this.count++;
      this.pos[i * 3] = corners[k * 2];
      this.pos[i * 3 + 1] = corners[k * 2 + 1];
      this.pos[i * 3 + 2] = 0;
      this.uv[i * 2] = uvs[k * 2];
      this.uv[i * 2 + 1] = uvs[k * 2 + 1];
      this.rgba.set(rgba, i * 4);
    }
  }

  /** Upload and return the mesh for this frame (its own material: textured pipes carry their texture). */
  mesh(): THREE.Mesh {
    let material = this.materials.get(this.pipe);
    if (!material) {
      material = makeMaterial(this.pipe);
      this.materials.set(this.pipe, material);
    }
    if (material.uniforms.map) material.uniforms.map.value = this.texture;
    const g = this.geometry;
    const pos = g.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos || pos.array !== this.pos) {
      g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(this.uv, 2));
      g.setAttribute("rgba", new THREE.BufferAttribute(this.rgba, 4, true));
    } else {
      for (const name of ["position", "uv", "rgba"]) {
        const a = g.getAttribute(name) as THREE.BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, this.count * a.itemSize);
        a.needsUpdate = true;
      }
    }
    g.setDrawRange(0, this.count);
    let mesh = this.meshes.get(this.pipe);
    if (!mesh) {
      mesh = new THREE.Mesh(g, material);
      mesh.frustumCulled = false;
      this.meshes.set(this.pipe, mesh);
    }
    mesh.material = material;
    return mesh;
  }
}

export function createCutsceneFilterRenderer(renderer: THREE.WebGLRenderer, source: IAssetSource | null): CutsceneFilterRenderer {
  const vp = FILTER_VIEWPORT;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(vp.x, vp.x + vp.w, vp.y, vp.y + vp.h, -1, 1);
  const batches: Batch[] = [];
  const bandTextures: THREE.DataTexture[] = [];
  let font: { font: UiFont; atlas: FontAtlas; texture: THREE.DataTexture } | null = null;
  let battery: THREE.DataTexture | null = null;
  let disposed = false;

  if (source) {
    void loadCutsceneFilterAssets(source).then((a) => {
      if (disposed) return;
      if (a.font) {
        const atlas = buildFontAtlas(a.font);
        font = { font: a.font, atlas, texture: dataTexture(atlas.texture.width, atlas.texture.height, bytes(atlas.texture.rgba), false) };
      }
      if (a.battery) battery = dataTexture(a.battery.width, a.battery.height, bytes(a.battery.rgba), false);
    });
  }

  function draw(filters: CutsceneFilters | null): void {
    if (!filters) return;
    const prims = filters.buildFrame(vp);
    if (prims.length === 0) return;
    let used = 0;
    let bandUsed = 0;
    let current: Batch | null = null;
    let lastBandData: Uint8Array | null = null;
    const begin = (pipe: Pipe, texture: THREE.Texture | null): Batch => {
      if (current && current.pipe === pipe && current.texture === texture) return current;
      if (used === batches.length) batches.push(new Batch());
      current = batches[used++];
      current.reset(pipe, texture);
      return current;
    };
    for (const p of prims) addPrimitive(p);

    function addPrimitive(p: FilterPrimitive): void {
      switch (p.kind) {
        case "rect": {
          const b = begin(p.blend === "multiply" ? "multiply" : "alpha", null);
          b.quad([p.x0, p.y0, p.x1, p.y0, p.x0, p.y1, p.x1, p.y1], [0, 0, 0, 0, 0, 0, 0, 0], p.rgba);
          return;
        }
        case "band": {
          if (p.texture !== lastBandData) {
            if (bandUsed === bandTextures.length) bandTextures.push(dataTexture(16, 16, new Uint8Array(16 * 16 * 4), true));
            const t = bandTextures[bandUsed++];
            (t.image.data as Uint8Array).set(p.texture);
            t.needsUpdate = true;
            lastBandData = p.texture;
          }
          const b = begin("band", bandTextures[bandUsed - 1]);
          // 1 texel per pixel: u = x / 16 from x = 0, v = (y - y0) / 16 (u, v x 0.0625 at 0x49acd5).
          const u1 = (p.x1 - p.x0) / 16;
          const v1 = (p.y1 - p.y0) / 16;
          b.quad([p.x0, p.y0, p.x1, p.y0, p.x0, p.y1, p.x1, p.y1], [0, 0, u1, 0, 0, v1, u1, v1], [255, 255, 255, 255]);
          return;
        }
        case "text": {
          if (!font) return;
          const f = font;
          const b = begin("text", f.texture);
          const W = f.atlas.texture.width;
          const H = f.atlas.texture.height;
          const c = p.colourByte;
          for (const g of layoutText(f.font, p.text, p.x, p.y, "left")) {
            const r = f.atlas.rects[g.glyph];
            const x1 = g.x + r.width;
            const y1 = g.y + r.height;
            b.quad(
              [g.x, g.y, x1, g.y, g.x, y1, x1, y1],
              [r.x / W, r.y / H, (r.x + r.width) / W, r.y / H, r.x / W, (r.y + r.height) / H, (r.x + r.width) / W, (r.y + r.height) / H],
              [c, c, c, 255],
            );
          }
          return;
        }
        case "battery": {
          if (!battery || p.alpha === 0) return;
          const b = begin("battery", battery);
          // Vertex order and uv exactly as FUN_0049bc10 passes them to FUN_004ab6b0.
          b.quad(p.quad, [0, 0, 1, 0, 0, 1, 1, 1], [255, 255, 255, p.alpha]);
          return;
        }
      }
    }

    scene.clear();
    for (let i = 0; i < used; i++) {
      const b = batches[i];
      if (b.count === 0) continue;
      const mesh = b.mesh();
      mesh.renderOrder = i;
      scene.add(mesh);
    }
    renderer.render(scene, camera);
  }

  return {
    draw,
    dispose() {
      disposed = true;
      scene.clear();
      for (const b of batches) {
        b.geometry.dispose();
        for (const m of b.materials.values()) m.dispose();
      }
      for (const t of bandTextures) t.dispose();
      font?.texture.dispose();
      battery?.dispose();
    },
  };
}
