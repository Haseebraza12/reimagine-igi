/**
 * Terrain rendering as igi.exe draws it, every frame (docs/terrain.md
 * section "Rendering"; all recovered from igi.exe unless marked):
 *
 *  1. Cell selection (FUN_004c6530 via TerrainOctree.selectCells): which
 *     octree cells to draw and at which level, from the camera position, view
 *     frustum and LOD threshold T (163 at GOGfxPerformance(0), raised when
 *     zooming in). Levels 7..16; coarser cells are dropped (far field ~25 km).
 *  2. Geomorphing (FUN_0050be70): per vertex lod = clamp((Chebyshev distance
 *     x 0.375 / 2^(25-L) - offset) * slope, 0, 1) computed at the vertex's
 *     morph target; extra vertices slide to their target base vertex, level-14
 *     base vertices fade the HeightMap relief in with (1 - lod), texture
 *     coordinates morph with the positions.
 *  3. Texturing: per material of the cell a detail "B" layer weighted
 *     W = trunc(255 (1 - lod)) and a coarse "A" layer weighted 255 - W (split
 *     with W2 = trunc(255 (1 - lod)^2) where a vertex morphs to another
 *     material), Gouraud-interpolated vertex colours x texture (MODULATE),
 *     summed over passes (first list opaque, the rest ONE/ONE).
 *  4. Lightmap pass (ZERO/SRCCOLOR): the TerrainLightMap texture (palette
 *     min(255, trunc(i sun + 255 ambient)), bilinear, no mipmaps, CLAMP)
 *     sampled per pixel.
 *  5. Fog: per vertex f = trunc(255 exp(-k view depth)) / 255 in the
 *     specular alpha; base pass fogged to the terrain fog colour (bytes),
 *     additive passes to black, lightmap to white:
 *     colour = (f layers + (1 - f) fog) (f lightmap + 1 - f).
 *  6. States: back faces culled on the CPU (the strip-ordered signed screen
 *     area, which equals the stored winding: front = counter-clockwise seen
 *     from +z), Z LESS, stage 0 LINEAR + MIPFILTER POINT + CLAMP over the 5
 *     generated mip levels (128..8), MipMapControl LOD bias [inferred: stage
 *     0 state left set].
 *
 * GPU layout: cells live in fixed 48-vertex slots (<= 16 triangles per cell,
 * three vertices per triangle) of one set of buffers; a cell keeps its slot
 * while it stays cached; one index buffer lists the slots drawn this frame,
 * so the whole terrain is a single draw call.
 */
import * as THREE from "three";
import type { DecodedTexture, Vec3 } from "../../contracts";
import type { LevelTerrainRenderMesh } from "../../loaders";
import {
  TERRAIN_LOD_BASE,
  terrainLodScale,
  terrainLodThreshold,
  terrainMorphParams,
  type TerrainCell,
  type TerrainOctree,
} from "../../loaders/terrain-octree";
import type { TerrainLook } from "../../loaders/terrain-look";
import type { FogUniforms } from "../render/fog";

const IGI_UNITS_PER_METRE = 4096;
/** Vertices per cell slot: at most 16 triangles per cell (observed over all 11,021 level-1 records). */
const SLOT_VERTICES = 48;
const INITIAL_SLOTS = 2048;
/** Layer value meaning "no morph-target material" in the per-corner layer attributes. */
const NO_LAYER = 255;

export interface TerrainRender {
  group: THREE.Group;
  /** Draw calls of the terrain (1). */
  tiles: number;
  /** Select this frame's cells for `camera` (as igi.exe does every frame) and upload new ones. */
  update(camera: THREE.Camera): void;
  /** Cells and triangles drawn by the last update, cached slots, cells built so far. */
  stats(): TerrainRenderStats;
  dispose(): void;
}

export interface TerrainRenderStats {
  cells: number;
  triangles: number;
  slots: number;
  built: number;
  /** Cells per level (index = level) in the last update. */
  perLevel: number[];
}

export interface TerrainRenderOptions {
  fog: FogUniforms;
  /** Shared MipMapControl LOD bias uniform. */
  mipBias: THREE.IUniform<number>;
  /** IGI world position mapped to engine (0, 0, 0). */
  origin: Vec3;
  /** LOD threshold base (TERRAIN_LOD_BASE = GOGfxPerformance(0)). */
  lodBase?: number;
  /** Water-plane z floor of the selection (IGI units); level 1 has none. */
  zFloor?: number;
}

/**
 * Vertex colour bytes of one corner (FUN_0050be70 colour table + FUN_00509250
 * column choice) [recovered]: [own B, own A, target B, target A] for a vertex
 * whose morph target has the same material (`split` false) or another one.
 * w = 1 - lod (float32); W = trunc(255 w), W2 = trunc(255 w w). Each list
 * sums to 255 (up to the byte truncation). Mirrors the vertex shader.
 */
export function terrainCornerWeights(lod: number, split: boolean): [number, number, number, number] {
  const w = Math.fround(1 - lod);
  const W = Math.trunc(w * 255);
  const W2 = Math.trunc(w * 255 * w);
  return split ? [W2, W - W2, W - W2, Math.max(0, 255 - 2 * W + W2)] : [W, 255 - W, 0, 0];
}

/** Split a non-indexed triangle mesh into square tiles (by triangle centroid, x/z). Pure; exported for tests. */
export function tileTriangles(mesh: LevelTerrainRenderMesh, tileM: number): LevelTerrainRenderMesh[] {
  const triangles = mesh.positions.length / 9;
  const keyOf = new Int32Array(triangles);
  const counts = new Map<number, number>();
  for (let t = 0; t < triangles; t++) {
    const p = t * 9;
    const cx = (mesh.positions[p] + mesh.positions[p + 3] + mesh.positions[p + 6]) / 3;
    const cz = (mesh.positions[p + 2] + mesh.positions[p + 5] + mesh.positions[p + 8]) / 3;
    const key = ((Math.floor(cx / tileM) + 32768) << 16) | ((Math.floor(cz / tileM) + 32768) & 0xffff);
    keyOf[t] = key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Map<number, { mesh: LevelTerrainRenderMesh; next: number }>();
  for (const [key, n] of counts) {
    out.set(key, {
      mesh: {
        positions: new Float32Array(n * 9),
        uv: new Float32Array(n * 6),
        layers: new Uint8Array(n * 9),
        light: new Float32Array(n * 3),
      },
      next: 0,
    });
  }
  for (let t = 0; t < triangles; t++) {
    const tile = out.get(keyOf[t])!;
    const k = tile.next++;
    tile.mesh.positions.set(mesh.positions.subarray(t * 9, t * 9 + 9), k * 9);
    tile.mesh.uv.set(mesh.uv.subarray(t * 6, t * 6 + 6), k * 6);
    tile.mesh.layers.set(mesh.layers.subarray(t * 9, t * 9 + 9), k * 9);
    tile.mesh.light.set(mesh.light.subarray(t * 3, t * 3 + 3), k * 3);
  }
  return [...out.values()].map((v) => v.mesh);
}

/** Square power-of-two images packed into an atlas `width` wide (quadtree split, largest first). Pure; exported for tests. */
export function packSquares(sides: number[], width = 1024): { width: number; height: number; at: Array<[number, number]> } {
  const order = sides.map((_, i) => i).sort((a, b) => sides[b] - sides[a]);
  const top = Math.max(1, ...sides);
  width = Math.max(width, top);
  const free = new Map<number, Array<[number, number]>>();
  const at: Array<[number, number]> = new Array(sides.length);
  let height = 0;
  for (const i of order) {
    const s = sides[i];
    if (s & (s - 1)) throw new Error(`terrain: lightmap side ${s} is not a power of two`);
    let size = s;
    while (size <= top && !free.get(size)?.length) size *= 2;
    if (size > top) {
      // New row of top-sized squares.
      const row = free.get(top) ?? [];
      for (let x = 0; x + top <= width; x += top) row.push([x, height]);
      free.set(top, row);
      height += top;
      size = top;
    }
    let [x, y] = free.get(size)!.pop()!;
    while (size > s) {
      size /= 2;
      const list = free.get(size) ?? [];
      list.push([x + size, y], [x, y + size], [x + size, y + size]);
      free.set(size, list);
    }
    at[i] = [x, y];
  }
  return { width, height: Math.max(height, 1), at };
}

/** The lightmaps of TerrainLook as one RGBA atlas of palette colours. */
function buildLightmapAtlas(look: TerrainLook): { texture: THREE.DataTexture; rects: Float32Array } {
  const images = look.lightmaps;
  const pack = packSquares(images.map((i) => i.side));
  const data = new Uint8Array(pack.width * pack.height * 4);
  const rects = new Float32Array(images.length * 4);
  const pal = look.palette;
  images.forEach((image, i) => {
    const [ax, ay] = pack.at[i];
    for (let ty = 0; ty < image.side; ty++) {
      for (let tx = 0; tx < image.side; tx++) {
        const value = image.data[ty * image.side + tx];
        const o = ((ay + ty) * pack.width + ax + tx) * 4;
        data[o] = pal[value * 3];
        data[o + 1] = pal[value * 3 + 1];
        data[o + 2] = pal[value * 3 + 2];
        data[o + 3] = 255;
      }
    }
    rects.set([ax / pack.width, ay / pack.height, image.side / pack.width, image.side / pack.height], i * 4);
  });
  const texture = new THREE.DataTexture(data, pack.width, pack.height, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter; // no mip levels (FUN_004bc120 creates them with 0) [recovered 0x4bc31a]
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, rects };
}

const VERTEX = /* glsl */ `
attribute vec4 aTarget;
attribute float aScale;
attribute vec4 aUvB;
attribute vec4 aUvA;
attribute vec4 aUvL;
attribute vec4 aLmRect;
attribute vec4 aL0;
attribute vec4 aL1;
attribute vec4 aL2;
uniform vec3 uCam;
uniform vec2 uMorph;
uniform float uFogK;
varying vec2 vUvB;
varying vec2 vUvA;
varying vec2 vUvL;
flat varying vec4 vLmRect;
flat varying vec4 vL0;
flat varying vec4 vL1;
flat varying vec4 vL2;
varying vec4 vW0;
varying vec4 vW1;
varying vec4 vW2;
varying float vFog;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
	// lod of the morph target (a base vertex is its own target) [FUN_0050be70].
	vec3 d = abs( aTarget.xyz - uCam );
	float lod = clamp( ( max( d.x, max( d.y, d.z ) ) * aScale - uMorph.x ) * uMorph.y, 0.0, 1.0 );
	vec3 p = mix( position, aTarget.xyz, lod );
	p.y += ( 1.0 - lod ) * aTarget.w; // level-14 HeightMap relief
	vUvB = mix( aUvB.xy, aUvB.zw, lod );
	vUvA = mix( aUvA.xy, aUvA.zw, lod );
	vUvL = mix( aUvL.xy, aUvL.zw, lod );
	// Vertex colours (bytes): W = trunc(255 w), W2 = trunc(255 w w), w = 1 - lod.
	float w = 1.0 - lod;
	float W = floor( w * 255.0 );
	float W2 = floor( w * 255.0 * w );
	int corner = gl_VertexID % 3; // three vertices per triangle
	vec4 L = corner == 0 ? aL0 : ( corner == 1 ? aL1 : aL2 );
	vec4 wt = L.z < 254.5
		? vec4( W2, W - W2, W - W2, 255.0 - 2.0 * W + W2 ) // own B, own A, target B, target A
		: vec4( W, 255.0 - W, 0.0, 0.0 );
	wt = max( wt, 0.0 ) / 255.0;
	vW0 = corner == 0 ? wt : vec4( 0.0 );
	vW1 = corner == 1 ? wt : vec4( 0.0 );
	vW2 = corner == 2 ? wt : vec4( 0.0 );
	vL0 = aL0;
	vL1 = aL1;
	vL2 = aL2;
	vLmRect = aLmRect;
	vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	// Fog factor from VIEW DEPTH, stored as a byte in the specular alpha.
	vFog = floor( exp( - uFogK * max( - mvPosition.z, 0.0 ) ) * 255.0 ) / 255.0;
}
`;

const FRAGMENT = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray terrainLayersMap;
uniform sampler2D uLightAtlas;
uniform vec2 uAtlasSize;
uniform vec3 uFogColour;
uniform float uMipBias;
varying vec2 vUvB;
varying vec2 vUvA;
varying vec2 vUvL;
flat varying vec4 vLmRect;
flat varying vec4 vL0;
flat varying vec4 vL1;
flat varying vec4 vL2;
varying vec4 vW0;
varying vec4 vW1;
varying vec4 vW2;
varying float vFog;
#include <common>
#include <logdepthbuf_pars_fragment>
// MIPFILTER POINT over the 5 mip levels the game creates (128..8 texels).
float mipOf( vec2 uv ) {
	vec2 dx = dFdx( uv ) * 128.0;
	vec2 dy = dFdy( uv ) * 128.0;
	float lambda = 0.5 * log2( max( max( dot( dx, dx ), dot( dy, dy ) ), 1e-20 ) ) + uMipBias;
	return lambda <= 0.5 ? 0.0 : min( ceil( lambda + 0.5 ) - 1.0, 4.0 );
}
vec3 tap( vec2 uv, float layer, float mip ) {
	return textureLod( terrainLayersMap, vec3( uv, layer ), mip ).rgb;
}
void main() {
	#include <logdepthbuf_fragment>
	float mipB = mipOf( vUvB );
	float mipA = mipOf( vUvA );
	vec3 layers;
	if ( vL0.x == vL1.x && vL1.x == vL2.x ) {
		layers = ( vW0.x + vW1.x + vW2.x ) * tap( vUvB, vL0.x, mipB );
	} else {
		layers = vW0.x * tap( vUvB, vL0.x, mipB ) + vW1.x * tap( vUvB, vL1.x, mipB ) + vW2.x * tap( vUvB, vL2.x, mipB );
	}
	if ( vL0.y == vL1.y && vL1.y == vL2.y ) {
		layers += ( vW0.y + vW1.y + vW2.y ) * tap( vUvA, vL0.y, mipA );
	} else {
		layers += vW0.y * tap( vUvA, vL0.y, mipA ) + vW1.y * tap( vUvA, vL1.y, mipA ) + vW2.y * tap( vUvA, vL2.y, mipA );
	}
	if ( vL0.z < 254.5 ) layers += vW0.z * tap( vUvB, vL0.z, mipB ) + vW0.w * tap( vUvA, vL0.w, mipA );
	if ( vL1.z < 254.5 ) layers += vW1.z * tap( vUvB, vL1.z, mipB ) + vW1.w * tap( vUvA, vL1.w, mipA );
	if ( vL2.z < 254.5 ) layers += vW2.z * tap( vUvB, vL2.z, mipB ) + vW2.w * tap( vUvA, vL2.w, mipA );
	vec3 lightmap = vec3( 1.0 );
	if ( vLmRect.z > 0.0 ) {
		// D3DTADDRESS_CLAMP + bilinear inside this lightmap's atlas square.
		vec2 side = vLmRect.zw * uAtlasSize;
		vec2 uv = clamp( vUvL, 0.5 / side, 1.0 - 0.5 / side );
		lightmap = textureLod( uLightAtlas, vLmRect.xy + uv * vLmRect.zw, 0.0 ).rgb;
	}
	float f = vFog;
	// Base pass fogged to the fog colour, additive passes to black, lightmap
	// multiply to white [recovered FUN_0050d6a0].
	vec3 colour = ( f * layers + ( 1.0 - f ) * uFogColour ) * ( f * lightmap + 1.0 - f );
	gl_FragColor = vec4( colour, 1.0 );
}
`;

interface Slot {
  slot: number;
  triangles: number;
  frame: number;
}

const ATTRIBUTES: Array<[string, number, "f32" | "u8"]> = [
  ["position", 3, "f32"],
  ["aTarget", 4, "f32"],
  ["aScale", 1, "f32"],
  ["aUvB", 4, "f32"],
  ["aUvA", 4, "f32"],
  ["aUvL", 4, "f32"],
  ["aLmRect", 4, "f32"],
  ["aL0", 4, "u8"],
  ["aL1", 4, "u8"],
  ["aL2", 4, "u8"],
];

/** Chop-mode byte of a 0..1 colour channel (fld; fmul -255; fistp; recombined at 0x50bf43). */
function colourByte(c: number): number {
  return Math.trunc(Math.min(1, Math.max(0, c)) * 255);
}

export function buildTerrain(
  octree: TerrainOctree,
  look: TerrainLook,
  layers: DecodedTexture[],
  options: TerrainRenderOptions,
): TerrainRender {
  const width = layers[0].width;
  const height = layers[0].height;
  if (layers.some((l) => l.width !== width || l.height !== height)) throw new Error("terrain layers differ in size");
  const data = new Uint8Array(width * height * 4 * layers.length);
  layers.forEach((layer, i) => data.set(layer.rgba, i * width * height * 4));
  const array = new THREE.DataArrayTexture(data, width, height, layers.length);
  array.format = THREE.RGBAFormat;
  array.wrapS = array.wrapT = THREE.ClampToEdgeWrapping; // D3DTADDRESS_CLAMP
  array.magFilter = THREE.LinearFilter;
  array.minFilter = THREE.LinearMipmapNearestFilter; // MIPFILTER POINT [recovered]
  array.generateMipmaps = true; // the game generates its 5 levels at load (mip count 5 at terrain.tex 0x12)
  array.anisotropy = 1;
  array.needsUpdate = true;

  const atlas = buildLightmapAtlas(look);
  const origin = options.origin;
  const fogColour = new THREE.Color();
  const uniforms = {
    terrainLayersMap: { value: array },
    uLightAtlas: { value: atlas.texture },
    uAtlasSize: { value: new THREE.Vector2(atlas.texture.image.width, atlas.texture.image.height) },
    uFogColour: { value: fogColour },
    uFogK: options.fog.terrainFogK,
    uMipBias: options.mipBias,
    uCam: { value: new THREE.Vector3() },
    uMorph: { value: new THREE.Vector2() },
  };
  const material = new THREE.ShaderMaterial({
    name: "igi-terrain",
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    fog: false,
    side: THREE.FrontSide, // CPU back-face cull on the stored winding [recovered 0x50cc26]
    depthFunc: THREE.LessDepth, // base pass ZFUNC LESS
  });

  // ---- slot buffers ----------------------------------------------------------
  let capacity = 0;
  let geometry = new THREE.BufferGeometry();
  const arrays = new Map<string, Float32Array | Uint8Array>();
  let index = new THREE.BufferAttribute(new Uint32Array(0), 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  mesh.frustumCulled = false; // the cell selection culls (sphere-vs-frustum per cell)
  mesh.matrixAutoUpdate = false;

  const allocate = (slots: number) => {
    const old = new Map(arrays);
    const next = new THREE.BufferGeometry();
    for (const [name, size, type] of ATTRIBUTES) {
      const n = slots * SLOT_VERTICES * size;
      const fresh = type === "f32" ? new Float32Array(n) : new Uint8Array(n);
      const prev = old.get(name);
      if (prev) fresh.set(prev);
      arrays.set(name, fresh);
      const attribute = new THREE.BufferAttribute(fresh, size);
      attribute.setUsage(THREE.DynamicDrawUsage);
      next.setAttribute(name, attribute);
    }
    index = new THREE.BufferAttribute(new Uint32Array(slots * SLOT_VERTICES), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    next.setIndex(index);
    next.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    geometry.dispose();
    geometry = next;
    mesh.geometry = next;
    capacity = slots;
    drawnSlots = []; // the new index buffer is empty: rebuild it
  };
  let drawnSlots: number[] = [];
  allocate(INITIAL_SLOTS);

  const cache = new Map<string, Slot>(); // insertion order = least recently used first
  const free: number[] = [];
  for (let s = INITIAL_SLOTS - 1; s >= 0; s--) free.push(s);
  let frame = 0;
  let built = 0;
  let last: TerrainRenderStats = { cells: 0, triangles: 0, slots: 0, built: 0, perLevel: [] };

  const toEngine = (x: number, y: number, z: number, out: Float32Array, at: number) => {
    out[at] = (x - origin[0]) / IGI_UNITS_PER_METRE;
    out[at + 1] = (z - origin[2]) / IGI_UNITS_PER_METRE;
    out[at + 2] = -(y - origin[1]) / IGI_UNITS_PER_METRE;
  };

  /** Write one cell into slot `slot`; returns its triangle count. */
  const writeCell = (cell: TerrainCell, slot: number): number => {
    const g = octree.cellGeometry(cell);
    const l = look.cellLook(cell, g);
    const pos = arrays.get("position") as Float32Array;
    const tgt = arrays.get("aTarget") as Float32Array;
    const scl = arrays.get("aScale") as Float32Array;
    const uvB = arrays.get("aUvB") as Float32Array;
    const uvA = arrays.get("aUvA") as Float32Array;
    const uvL = arrays.get("aUvL") as Float32Array;
    const rect = arrays.get("aLmRect") as Float32Array;
    const lay = [arrays.get("aL0") as Uint8Array, arrays.get("aL1") as Uint8Array, arrays.get("aL2") as Uint8Array];
    const scale = terrainLodScale(cell.level) * IGI_UNITS_PER_METRE; // per metre
    const lm = l.lightmap >= 0 ? atlas.rects.subarray(l.lightmap * 4, l.lightmap * 4 + 4) : null;
    const tris = g.triangles;
    const p = g.positions;
    const base = slot * SLOT_VERTICES;
    for (let k = 0; k < tris.length; k += 3) {
      // Per-corner layers (flat over the triangle): own B, own A, target B, target A.
      const corners = [tris[k], tris[k + 1], tris[k + 2]].map((v) => {
        const own = l.layers.get(l.material[v])!;
        const tm = l.targetMaterial[v];
        const other = tm >= 0 ? l.layers.get(tm)! : [NO_LAYER, NO_LAYER];
        return [own[0], own[1], other[0], other[1]];
      });
      for (let j = 0; j < 3; j++) {
        const v = tris[k + j];
        const t = g.target[v];
        const o = base + k + j;
        toEngine(p[v * 3], p[v * 3 + 1], p[v * 3 + 2], pos, o * 3);
        toEngine(p[t * 3], p[t * 3 + 1], p[t * 3 + 2], tgt, o * 4);
        tgt[o * 4 + 3] = g.relief[v] / IGI_UNITS_PER_METRE;
        scl[o] = scale;
        uvB.set(l.uvB.subarray(v * 4, v * 4 + 4), o * 4);
        uvA.set(l.uvA.subarray(v * 4, v * 4 + 4), o * 4);
        uvL.set(l.uvLight.subarray(v * 4, v * 4 + 4), o * 4);
        if (lm) rect.set(lm, o * 4);
        else rect.fill(0, o * 4, o * 4 + 4);
        for (let c = 0; c < 3; c++) lay[c].set(corners[c], o * 4);
      }
    }
    for (const [name, size] of ATTRIBUTES) {
      (geometry.getAttribute(name) as THREE.BufferAttribute).addUpdateRange(base * size, tris.length * size);
    }
    built++;
    return tris.length / 3;
  };

  const take = (): number => {
    const s = free.pop();
    if (s !== undefined) return s;
    for (const [key, entry] of cache) {
      if (entry.frame === frame) break; // everything after this was used this frame too
      cache.delete(key);
      return entry.slot;
    }
    const old = capacity;
    allocate(capacity * 2);
    for (let s2 = capacity - 1; s2 > old; s2--) free.push(s2);
    return old;
  };

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scaleV = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const rotation = new Float64Array(9);
  const igiPos: [number, number, number] = [0, 0, 0];

  const group = new THREE.Group();
  group.name = "terrain";
  group.add(mesh);
  // Diagnostics (tests / automation): scene.getObjectByName("terrain").userData.stats().
  group.userData.stats = () => last;
  return {
    group,
    tiles: 1,
    update(camera: THREE.Camera) {
      const persp = camera as THREE.PerspectiveCamera;
      if (!persp.isPerspectiveCamera) return;
      frame++;
      camera.matrixWorld.decompose(position, quaternion, scaleV);
      basis.makeRotationFromQuaternion(quaternion);
      const e = basis.elements;
      // Engine -> IGI direction (a, b, c) -> (a, -c, b); rows right, down, forward.
      const right = [e[0], -e[2], e[1]];
      const up = [e[4], -e[6], e[5]];
      const back = [e[8], -e[10], e[9]];
      rotation.set([right[0], right[1], right[2], -up[0], -up[1], -up[2], -back[0], -back[1], -back[2]]);
      igiPos[0] = origin[0] + position.x * IGI_UNITS_PER_METRE;
      igiPos[1] = origin[1] - position.z * IGI_UNITS_PER_METRE;
      igiPos[2] = origin[2] + position.y * IGI_UNITS_PER_METRE;
      const pm = persp.projectionMatrix.elements;
      const tanX = 1 / pm[0];
      const tanY = 1 / pm[5];
      const threshold = terrainLodThreshold(tanX, options.lodBase ?? TERRAIN_LOD_BASE);
      const morph = terrainMorphParams(threshold);
      const cells = octree.selectCells({ position: igiPos, rotation, tanX, tanY, threshold, zFloor: options.zFloor });

      const slots: number[] = [];
      const counts: number[] = [];
      const perLevel: number[] = [];
      let triangles = 0;
      for (const cell of cells) {
        const key = `${cell.cx},${cell.cy},${cell.cz},${cell.level}`;
        let entry = cache.get(key);
        if (entry) {
          cache.delete(key); // move to the most recently used end
        } else {
          const slot = take();
          entry = { slot, triangles: 0, frame };
          entry.triangles = writeCell(cell, slot);
        }
        entry.frame = frame;
        cache.set(key, entry);
        slots.push(entry.slot);
        counts.push(entry.triangles);
        triangles += entry.triangles;
        perLevel[cell.level] = (perLevel[cell.level] ?? 0) + 1;
      }
      for (const [name] of ATTRIBUTES) {
        const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
        if (attribute.updateRanges.length) attribute.needsUpdate = true;
      }
      const changed = slots.length !== drawnSlots.length || slots.some((s, i) => s !== drawnSlots[i]);
      if (changed) {
        const indices = index.array as Uint32Array;
        let n = 0;
        slots.forEach((slot, i) => {
          const start = slot * SLOT_VERTICES;
          for (let v = 0; v < counts[i] * 3; v++) indices[n++] = start + v;
        });
        index.clearUpdateRanges();
        index.addUpdateRange(0, Math.max(n, 1));
        index.needsUpdate = true;
        geometry.setDrawRange(0, n);
        drawnSlots = slots;
      }
      uniforms.uCam.value.copy(position);
      uniforms.uMorph.value.set(morph.offset, morph.slope);
      const c = options.fog.terrainFogColour.value;
      fogColour.setRGB(colourByte(c.r) / 255, colourByte(c.g) / 255, colourByte(c.b) / 255);
      last = { cells: cells.length, triangles, slots: cache.size, built, perLevel };
    },
    stats() {
      return last;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      array.dispose();
      atlas.texture.dispose();
    },
  };
}
