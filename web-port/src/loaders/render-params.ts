/**
 * Renderer parameters of Project I.G.I. (igi.exe, DirectDraw + Direct3D 7
 * fixed function), recovered so the browser renderer can reproduce frames.
 *
 * Evidence (details and addresses: docs/rendering.md; every executable
 * constant is re-read from igi.exe by tools/igi_render_params.py):
 *   - recovered: read from igi.exe code (function addresses below);
 *   - observed:  measured from the game data;
 *   - inferred:  consistent with code and data, not confirmed.
 *
 * Units: IGI world units (4096 = 1 m, z up) unless a name ends in M (metres).
 * igi.exe draws in "D3D units" = IGI units * 0.001 (DAT_00b7092c, init at
 * 0x491ad3) [recovered].
 *
 * Camera [recovered FUN_00495c70 (SetActiveTransContext), FUN_00495fe0
 * (camera build), FUN_00462fe0/FUN_00464650 (FOV), FUN_00464490 (eye)]:
 *   projection _11 = 1/tanX, _22 = -1/tanY, _33 = f/(f-n), _43 = -n f/(f-n),
 *   tanY = 0.75 tanX for every full-screen view (the 4:3 ratio is hard-wired:
 *   aspect() = 4h/(3w) at FUN_00490130 cancels the window size). Player
 *   tanX = tan(pi/4) = 1 (90 deg x 73.74 deg); the first-person gun is drawn
 *   in its own depth layer with tanX = tan(pi/6) (60 deg x 46.83 deg).
 *
 * Fog [recovered FUN_00521280, FUN_0050be70, FUN_0052daf0..FUN_0052e460]:
 *   exponential, f = exp(-d_D3D * density * 0.0005) = exp(-d_m * 0.002048 *
 *   density); terrain computes f per vertex on the CPU from view depth,
 *   objects use D3D vertex fog EXP (RANGEFOGENABLE is left TRUE after the
 *   first terrain draw, so objects use radial distance where the device
 *   supports range fog [inferred]). Only GlobalLightKeyframe "terrain" and
 *   "object category 1" are read; categories 2-4 are interpolated and unused.
 *
 * Sky [recovered FUN_00517d20, FUN_00518670, FUN_005269c0, FUN_00526d20,
 * FUN_00526de0]: frame cleared to FlatSky "Fog Color"; a 321-vertex Gouraud
 * dome (no fog, no depth test) rotated toward the first directional light;
 * then each FlatSkyLayer as a textured plane "Z Pos" metres above the camera
 * (camera-relative, no parallax), alpha-faded with view depth, alpha blended,
 * no depth test, no fog. No lens flare exists in level 1 (no Lensflare task).
 */
import type { DecodedTexture, IAssetSource } from "../contracts";
import { readQvmCallTree, type QvmCall, type QvmValue } from "./qvm";
import type { IgiTask } from "./tasks";
import { x87Fistp, x87StoreF32 } from "./x87";

export type Rgb = [number, number, number];

/** IGI units per metre (docs/formats.md). */
export const IGI_PER_METRE = 4096;
/** IGI units per Direct3D unit: world matrices scale by 0.001 (DAT_00b7092c) [recovered]. */
export const IGI_PER_D3D_UNIT = 1000;
/** Fixed simulation rate: FUN_004020b0 calls FUN_004029a0(0x1e); FUN_00402250 runs "tick" handlers at this rate [recovered]. */
export const GAME_TICKS_PER_SECOND = 30;

// ---------------------------------------------------------------------------
// Camera and depth layers
// ---------------------------------------------------------------------------

/** One of the three transform contexts of FUN_00495c70 (near/far and D3DVIEWPORT7 MinZ/MaxZ). */
export interface DepthLayer {
  nearM: number;
  farM: number;
  /** Viewport depth range: the layer's z is mapped into [depthMin, depthMax]. */
  depthMin: number;
  depthMax: number;
}

/**
 * Layer 0 = first-person gun (objects with field +0xec == 0), layer 1 = world,
 * layer 2 = unused (near == far). Values set at 0x491b23..0x491b91 [recovered].
 * The gun layer's depth range [0, 0.05] lies in front of the world's
 * [0.06, 1], so the gun never intersects world geometry.
 */
export const DEPTH_LAYERS: { gun: DepthLayer; world: DepthLayer; unused: DepthLayer } = {
  gun: { nearM: 204.8 / IGI_PER_METRE, farM: 6144 / IGI_PER_METRE, depthMin: 0, depthMax: 0.05 },
  world: { nearM: 409.6 / IGI_PER_METRE, farM: 409_600_000 / IGI_PER_METRE, depthMin: 0.06, depthMax: 1 },
  unused: { nearM: 100_000, farM: 100_000, depthMin: 1, depthMax: 1 },
};

export const CAMERA = {
  /** tan(horizontal half-FOV) of the player view: fptan(pi/4) (double at 0x5315f0) [recovered]. */
  worldTanHalfFovX: Math.tan(Math.PI / 4),
  /** tan(horizontal half-FOV) of the first-person gun layer: fptan(pi/6) (double at 0x5319b8) [recovered]. */
  gunTanHalfFovX: Math.tan(Math.PI / 6),
  /** tan(vertical half-FOV) / tan(horizontal half-FOV) for full-screen views [recovered FUN_00495fe0]. */
  tanYOverTanX: 0.75,
  /** Eye above the human's origin (+0x20..0x30): standing 2826.24 IGI, crouched 1433.6 IGI [recovered FUN_00464490]. */
  eyeAboveOriginStandM: 2826.24 / IGI_PER_METRE,
  eyeAboveOriginCrouchM: 1433.6 / IGI_PER_METRE,
  /** While a zoom input is held both FOV tangents are multiplied by this per tick [recovered FUN_00463470]. */
  zoomInPerTick: 0.96,
  zoomOutPerTick: 1.0416667,
  /** Pitch is clamped to +-pi/2 [recovered FUN_00463470]. */
  pitchLimitRad: Math.PI / 2,
  /** Binocular FOV limits/default in degrees: BINOCULARS/weapon.qvm DefineWeaponType trailing values 5, 90, 70 [observed; meaning from exe strings]. */
  binocularFovDeg: { min: 5, max: 90, default: 70 },
} as const;

/** Vertical FOV in degrees for a full-screen view with the given tan(horizontal half-FOV). */
export function verticalFovDeg(tanHalfFovX: number): number {
  return (2 * Math.atan(CAMERA.tanYOverTanX * tanHalfFovX) * 180) / Math.PI;
}

/** Horizontal FOV in degrees. */
export function horizontalFovDeg(tanHalfFovX: number): number {
  return (2 * Math.atan(tanHalfFovX) * 180) / Math.PI;
}

/**
 * The D3D projection matrix of FUN_00495c70 (row-major, row-vector convention,
 * as passed to SetTransform(D3DTRANSFORMSTATE_PROJECTION)). The camera basis of
 * igi.exe is x = right, y = DOWN, z = forward, hence the negative _22.
 */
export function d3dProjection(tanHalfFovX: number, nearM: number, farM: number): number[] {
  const q = farM / (farM - nearM);
  return [
    1 / tanHalfFovX, 0, 0, 0,
    0, -1 / (CAMERA.tanYOverTanX * tanHalfFovX), 0, 0,
    0, 0, q, 1,
    0, 0, -q * nearM, 0,
  ];
}

/**
 * Three.js PerspectiveCamera settings.
 *  - "stretch": the original image exactly (tanX across the full width, tanY
 *    across the full height, so a non-4:3 window stretches like the game did).
 *  - "horPlus": keep the original vertical FOV and widen horizontally.
 */
export function threeCameraParams(
  tanHalfFovX: number,
  viewportAspect: number,
  mode: "stretch" | "horPlus" = "horPlus",
): { fovYDeg: number; aspect: number } {
  return { fovYDeg: verticalFovDeg(tanHalfFovX), aspect: mode === "stretch" ? 4 / 3 : viewportAspect };
}

// ---------------------------------------------------------------------------
// Light keyframes and fog
// ---------------------------------------------------------------------------

/** Per-metre coefficient k of f = exp(-k d) for a GlobalLightKeyframe "Fog density" value. */
export function fogDensityPerMetre(keyframeDensity: number): number {
  return (keyframeDensity * 0.0005 * IGI_PER_METRE) / IGI_PER_D3D_UNIT;
}

/** Fraction of the surface colour kept at distance d (1 = no fog); colour = mix(fog, surface, f). */
export function fogFactor(keyframeDensity: number, distanceM: number): number {
  return Math.exp(-distanceM * fogDensityPerMetre(keyframeDensity));
}

/**
 * Final terrain colour of igi.exe's three fogged passes (FUN_0050d6a0):
 * pass 0 opaque, fogged to the fog colour; pass 1 additive (ONE/ONE), fogged
 * to black; pass 2 lightmap multiply (ZERO/SRCCOLOR), fogged to white. All
 * passes share the per-vertex fog factor f, so the result is
 *   (f * layers + (1 - f) * fog) * (f * lightmap + 1 - f),
 * not mix(fog, layers * lightmap, f) [recovered]. Per channel, values 0..1.
 */
export function terrainFoggedColour(layers: number, lightmap: number, fog: number, f: number): number {
  return (f * layers + (1 - f) * fog) * (f * lightmap + 1 - f);
}

export interface LightCategory {
  ambient: Rgb;
  fogColour: Rgb;
  /** Keyframe "Fog density" (D3D FOGDENSITY = value * 0.0005). */
  fogDensity: number;
  /** k of exp(-k d_m). */
  fogPerMetre: number;
}

export interface GlobalLightState {
  /** Keyframe time used (after interpolation). */
  time: number;
  terrain: LightCategory;
  /** "object category 1": the only object category any draw path reads. */
  objects: LightCategory;
  /** Categories 2-4 for completeness (never read by igi.exe draw code). */
  unusedCategories: LightCategory[];
  /** GlobalLightKeyframe "Sky color": only read by the water renderer (FUN_0050a910) [recovered]. */
  skyColour: Rgb;
}

function num(task: IgiTask, name: string, fallback: number): number {
  const v = task.params[name];
  return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : fallback;
}

function rgb(task: IgiTask, name: string, fallback: Rgb): Rgb {
  const v = task.params[name];
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number")) return [v[0] as number, v[1] as number, v[2] as number];
  return fallback;
}

function str(task: IgiTask, name: string): string | null {
  const v = task.params[name];
  return typeof v === "string" ? v : null;
}

const CATEGORY_NAMES = ["terrain", "object category 1", "object category 2", "object category 3", "object category 4"];

function category(task: IgiTask, name: string): LightCategory {
  const fogDensity = num(task, `Fog density ${name}`, 0);
  return {
    ambient: rgb(task, `Ambient color ${name}`, [0, 0, 0]),
    fogColour: rgb(task, `Fog color ${name}`, [0, 0, 0]),
    fogDensity,
    fogPerMetre: fogDensityPerMetre(fogDensity),
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function lerpCategory(a: LightCategory, b: LightCategory, t: number): LightCategory {
  const fogDensity = lerp(a.fogDensity, b.fogDensity, t);
  return { ambient: lerpRgb(a.ambient, b.ambient, t), fogColour: lerpRgb(a.fogColour, b.fogColour, t), fogDensity, fogPerMetre: fogDensityPerMetre(fogDensity) };
}

/**
 * GlobalLightKeyframe state at a time of day, as FUN_00521280 computes it:
 * exact match, else linear interpolation between the nearest lower and upper
 * keyframes, else the only side that exists. igi.exe starts the clock at 0
 * and never advances it, so level 1 uses its earliest keyframe (Time 12).
 * Terrain fog colour is clamped to [0, 1] (FUN_00508f60) [recovered].
 */
export function readGlobalLight(tasks: IgiTask[], timeOfDay = 0): GlobalLightState | null {
  const frames = tasks.filter((t) => t.type === "GlobalLightKeyframe");
  if (frames.length === 0) return null;
  const time = (t: IgiTask) => num(t, "Time", 0);
  let lower: IgiTask | null = null;
  let upper: IgiTask | null = null;
  for (const f of frames) {
    const ft = time(f);
    if (ft === timeOfDay) {
      lower = f;
      upper = null;
      break;
    }
    if (ft < timeOfDay && (!lower || time(lower) <= ft)) lower = f;
    if (ft > timeOfDay && (!upper || ft < time(upper))) upper = f;
  }
  const state = (f: IgiTask): GlobalLightState => {
    const cats = CATEGORY_NAMES.map((n) => category(f, n));
    return { time: time(f), terrain: cats[0], objects: cats[1], unusedCategories: cats.slice(2), skyColour: rgb(f, "Sky color", [0, 0, 0]) };
  };
  let out: GlobalLightState;
  if (lower && upper && time(lower) !== time(upper)) {
    const t = (timeOfDay - time(lower)) / (time(upper) - time(lower));
    const a = state(lower);
    const b = state(upper);
    out = {
      time: timeOfDay,
      terrain: lerpCategory(a.terrain, b.terrain, t),
      objects: lerpCategory(a.objects, b.objects, t),
      unusedCategories: a.unusedCategories.map((c, i) => lerpCategory(c, b.unusedCategories[i], t)),
      skyColour: lerpRgb(a.skyColour, b.skyColour, t),
    };
  } else {
    out = state((lower ?? upper) as IgiTask);
  }
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  out.terrain.fogColour = out.terrain.fogColour.map(clamp01) as Rgb;
  return out;
}

/**
 * D3DCOLOR byte of a 0..1 channel as igi.exe converts it (FUN_00526c10
 * 0x526cab..0x526cf0: the lerped channel is stored as float32, then fmul
 * 255.0f; fistp; >= 255 -> 255). The FPU runs in chop mode (docs/gameplay.md
 * "FPU rounding mode"): both the float32 store and the FISTP truncate, so
 * 0.5 -> 127 and 0.9 -> 229.
 */
export function colourByte(x: number): number {
  const v = x87Fistp(x87StoreF32(x) * 255);
  return v > 254 ? 255 : v;
}

// ---------------------------------------------------------------------------
// Sky: FlatSky dome and FlatSkyLayer clouds
// ---------------------------------------------------------------------------

export interface FlatSkyParams {
  /** "Fog Color": the frame clear colour (FUN_00518670 -> FUN_00490260 -> Clear at FUN_00490840). */
  clearColour: Rgb;
  /** Cloud plane height above the camera (m). */
  zPosM: number;
  /** Cloud fade-out depth (m). */
  distanceM: number;
  /** Fraction of [0.1 m, Distance] over which clouds fade. */
  fogAmount: number;
  angleDeg: number;
  snapColours: boolean;
  top: Rgb;
  middle1: Rgb;
  middle2: Rgb;
  bottom1: Rgb;
  bottom2: Rgb;
}

/** FlatSky task; defaults are the FUN_00518540 constructor values [recovered]. */
export function readFlatSky(tasks: IgiTask[]): FlatSkyParams | null {
  const t = tasks.find((x) => x.type === "FlatSky");
  if (!t) return null;
  const d: Rgb = [0.19, 0.3, 0.43];
  return {
    clearColour: rgb(t, "Fog Color", [0, 0, 0]),
    zPosM: num(t, "Z Pos", 5),
    distanceM: num(t, "Distance", 100),
    fogAmount: num(t, "Fog Amount", 0.5),
    angleDeg: num(t, "SkyDome Angle", 15),
    snapColours: t.params["SkyDome Snap Colours"] === true,
    top: rgb(t, "SkyDome Top Colour", d),
    middle1: rgb(t, "SkyDome Middle Colour 1", d),
    middle2: rgb(t, "SkyDome Middle Colour 2", d),
    bottom1: rgb(t, "SkyDome Bottom Colour 1", d),
    bottom2: rgb(t, "SkyDome Bottom Colour 2", d),
  };
}

export interface SkyDomeMesh {
  /** xyz per vertex in dome space (z up, unit radius; the skirt ring is at z = -0.5). 321 vertices. */
  positions: Float32Array;
  /** RGB bytes per vertex (D3DCOLOR, Gouraud-interpolated by the original). */
  colours: Uint8Array;
  /** 620 triangles in the original index order (FUN_00526d20). */
  indices: Uint16Array;
}

/**
 * The sky dome vertex buffer (FVF XYZ|DIFFUSE, 0x141 vertices, 0x744 indices):
 * pole + 15 rings 6 deg apart (84 .. 0 deg elevation) x 20 vertices 18 deg
 * apart + a skirt ring at z = -0.5 R under the horizon ring. Real radius
 * R = 0.8 * 4.096e8 IGI (80 km); depth test is off, so any radius works.
 * Elevation blend (A = SkyDome Angle): above A from Middle (b=1) to Top at
 * the pole; between A/2 and A from Bottom to Middle; below A/2 Bottom.
 * Azimuth blend: colour "1" toward the sun, colour "2" opposite (weight
 * |0.1 j - 1|); "Snap Colours" copies 1 into 2 [recovered FUN_005269c0,
 * FUN_00526c10, FUN_00518670].
 * Positions are in IGI axes (z up): map (x, y, z) to engine (x, z, -y)
 * (loaders/coords.ts convention); the IGI yaw of skyDomeYawRad() is then
 * rotation.y in Three.js.
 */
export function buildSkyDome(p: FlatSkyParams): SkyDomeMesh {
  const mid2 = p.snapColours ? p.middle1 : p.middle2;
  const bot2 = p.snapColours ? p.bottom1 : p.bottom2;
  const cols: Rgb[] = [p.top, p.top, p.middle1, mid2, p.bottom1, bot2];
  const A = (p.angleDeg * Math.PI) / 180;
  const positions = new Float32Array(321 * 3);
  const colours = new Uint8Array(321 * 3);
  const put = (i: number, x: number, y: number, z: number, c: Rgb) => {
    positions.set([x, y, z], i * 3);
    colours.set([colourByte(c[0]), colourByte(c[1]), colourByte(c[2])], i * 3);
  };
  put(0, 0, 0, 1, p.top);
  let phi = Math.PI / 2;
  for (let ring = 0; ring < 15; ring++) {
    phi -= (6 * Math.PI) / 180;
    let base = 0;
    let b: number;
    if (phi < A) {
      base = 2;
      b = A * 0.5 <= phi ? phi / (A * 0.5) - 1 : 0;
    } else {
      b = (phi - A) / (Math.PI / 2 - A);
    }
    b = 1 - b;
    for (let j = 0; j < 20; j++) {
      const th = (18 * j * Math.PI) / 180;
      const a = Math.abs(0.1 * j - 1);
      const c = lerpRgb(lerpRgb(cols[base], cols[base + 1], a), lerpRgb(cols[base + 2], cols[base + 3], a), b);
      put(1 + ring * 20 + j, Math.cos(th) * Math.cos(phi), Math.sin(th) * Math.cos(phi), Math.sin(phi), c);
    }
  }
  for (let j = 0; j < 20; j++) {
    const src = 1 + 14 * 20 + j;
    positions.set([positions[src * 3], positions[src * 3 + 1], -0.5], (301 + j) * 3);
    colours.set(colours.subarray(src * 3, src * 3 + 3), (301 + j) * 3);
  }
  const indices: number[] = [];
  let prev = 19;
  for (let j = 0; j < 20; j++) {
    indices.push(0, prev + 1, j + 1);
    prev = j;
  }
  for (let ring = 0; ring < 15; ring++) {
    const s = ring * 20;
    prev = 19;
    for (let j = 0; j < 20; j++) {
      indices.push(j + 1 + s, prev + 1 + s, j + 21 + s, prev + 1 + s, prev + 21 + s, j + 21 + s);
      prev = j;
    }
  }
  return { positions, colours, indices: Uint16Array.from(indices) };
}

/**
 * Rotation of the dome about IGI +z (counter-clockwise, radians) so that
 * colour "1" faces the sun. The world matrix of FUN_00526de0 uses
 * alpha = atan2(l.x, l.y) + pi/2 of the first directional light's
 * toward-the-light vector l; a dome vertex at azimuth t ends up at t - alpha.
 */
export function skyDomeYawRad(sunTowardX: number, sunTowardY: number): number {
  return -(Math.atan2(sunTowardX, sunTowardY) + Math.PI / 2);
}

export interface SkyLayerParams {
  texturePath: string | null;
  /** Texture repeats per IGI unit on the plane. */
  scale: number;
  /** UV offset added per 30 Hz game tick, wrapped to [0, 1] (FUN_00518760). */
  speedPerTick: [number, number];
  alpha: number;
  /** Vertex colour (clamped to [0, 1] by FUN_00518850), MODULATE with the texture. */
  colour: Rgb;
}

/** FlatSkyLayer tasks in task order (drawn in this order); defaults from FUN_00517830 [recovered]. */
export function readSkyLayers(tasks: IgiTask[]): SkyLayerParams[] {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return tasks
    .filter((t) => t.type === "FlatSkyLayer")
    .map((t) => ({
      texturePath: str(t, "Texture File Name"),
      scale: num(t, "Scale", 1e-4),
      speedPerTick: [num(t, "X Speed", 0), num(t, "Y Speed", 0)] as [number, number],
      alpha: num(t, "Alpha", 1),
      colour: rgb(t, "Color", [1, 1, 1]).map(clamp01) as Rgb,
    }));
}

/** Camera depth (m) where the cloud fade starts: D - (D - 0.1 m) * FogAmount [recovered FUN_00517d20]. */
export function cloudFadeStartM(p: FlatSkyParams): number {
  const D = p.distanceM * IGI_PER_METRE;
  return (D - (D - 409.6) * p.fogAmount) / IGI_PER_METRE;
}

/**
 * Vertex alpha of a cloud-plane point at camera depth (distance along the
 * view axis) depthM: 1 before the fade start s, then
 * (s - s D / depth) / (s - D) clamped to [0, 0.999] (0 from depth D on),
 * times the layer Alpha [recovered FUN_00517d20].
 */
export function cloudLayerAlpha(depthM: number, p: FlatSkyParams, layerAlpha = 1): number {
  const D = p.distanceM * IGI_PER_METRE;
  const s = D - (D - 409.6) * p.fogAmount;
  const z = depthM * IGI_PER_METRE;
  let a = 1;
  if (z >= s) {
    a = (s - (1 / z) * s * D) / (s - D);
    a = a <= 0 ? 0 : a > 0.999 ? 0.999 : a;
  }
  return a * layerAlpha;
}

/**
 * Cloud texture coordinate of the plane point straight along view ray dir
 * (IGI axes, any length, dir z > 0): hit = dir * (zPos / dir.z) relative to
 * the camera; u = hit.x * scale + offsetU, v = hit.y * scale + offsetV.
 */
export function cloudUv(dirIgi: [number, number, number], p: FlatSkyParams, layer: SkyLayerParams, offset: [number, number]): [number, number] {
  const k = (p.zPosM * IGI_PER_METRE) / dirIgi[2];
  return [dirIgi[0] * k * layer.scale + offset[0], dirIgi[1] * k * layer.scale + offset[1]];
}

// ---------------------------------------------------------------------------
// Texture filtering and model LOD
// ---------------------------------------------------------------------------

export interface MipMapControl {
  /** D3DTSS_MIPMAPLODBIAS on stage 0 ("LOD bias (Standard MipMapping)") [recovered FUN_00518bb0]. */
  lodBias: number;
  lodBiasTrilinear: number;
  /** 0 GR_MIPMAP_DISABLE, 1 GR_MIPMAP_NEAREST, 2 GR_MIPMAP_NEAREST_DITHER (not applied by the handler). */
  mode: number;
  lodBlend: boolean;
}

export function readMipMapControl(tasks: IgiTask[]): MipMapControl | null {
  const t = tasks.find((x) => x.type === "MipMapControl");
  if (!t) return null;
  return {
    lodBias: num(t, "LOD bias (Standard MipMapping)", 0),
    lodBiasTrilinear: num(t, "LOD bias (Trilinear MipMapping)", 0),
    mode: num(t, "MipMap mode", 1),
    lodBlend: t.params["LOD blend"] === true,
  };
}

export interface LodSettings {
  /** Raw task values; igi.exe multiplies the first five pairs by 0.02 (FUN_004e4620). */
  firstSwitch: { spline: number; rigid: number; bone: number };
  cutoff: { spline: number; rigid: number; bone: number };
  /** "Degree to which radius affects LOD" (k). */
  radiusWeight: number;
  idealRadiusM: number;
}

export function readLodSettings(tasks: IgiTask[]): LodSettings | null {
  const t = tasks.find((x) => x.type === "LODSettings");
  if (!t) return null;
  const f = (kind: string) => num(t, `Distance to first switch, relative to object radius (${kind} Objects)`, 0);
  const c = (kind: string) => num(t, `Cutoff distance, relative to object radius (${kind} Objects)`, 0);
  return {
    firstSwitch: { spline: f("Spline"), rigid: f("Rigid"), bone: f("Bone") },
    cutoff: { spline: c("Spline"), rigid: c("Rigid"), bone: c("Bone") },
    radiusWeight: num(t, "Degree to which radius affects LOD", 0.25),
    idealRadiusM: num(t, "Ideal radius", 15),
  };
}

/** Per-model explicit LOD distances from lod.qvm ModelLODSettings (metres; FUN_004e46e0 makes them non-decreasing). */
export function readModelLodTable(tasks: IgiTask[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const t of tasks) {
    if (t.type !== "ModelLODSettings") continue;
    const model = str(t, "Model") ?? t.name;
    const d = [1, 2, 3, 4].map((i) => num(t, `Distance to LOD ${i}`, 0)).concat([num(t, "Distance to cutoff", 0)]);
    for (let i = 1; i < d.length; i++) if (d[i] < d[i - 1]) d[i] = d[i - 1];
    out.set(model, d);
  }
  return out;
}

/**
 * LOD index (0 = finest) or -1 (not drawn) for a rigid model without explicit
 * distances [recovered FUN_004c4d00]. depthM = view-space depth of the model's
 * bounding-sphere centre; radiusM = model radius * max(scale); faceCounts =
 * triangles per LOD variant (_1 .. _n); tanHalfFovX = current camera (zoom
 * makes distant objects finer); detail = 1.0 (GOGfxPerformance 0; 1.5 / 2.0
 * for the lower detail flags, FUN_00405e50).
 */
export function selectLodRelative(
  depthM: number,
  radiusM: number,
  faceCounts: number[],
  firstSwitch: number,
  cutoff: number,
  radiusWeight: number,
  idealRadiusM: number,
  tanHalfFovX: number = CAMERA.worldTanHalfFovX,
  detail = 1,
): number {
  const rEff = (1 - radiusWeight) * (idealRadiusM - radiusM) + radiusM;
  const d = depthM * detail - rEff;
  if (!(d > 0)) return 0;
  const S = firstSwitch * 0.02;
  const C = cutoff * 0.02;
  const thresholds = faceCounts.map((n, i) => (i === 0 ? 1 : (n / faceCounts[0]) ** 2) / (S * rEff));
  const inv = 1 / d;
  let i = 0;
  if (inv < tanHalfFovX * thresholds[0]) {
    while (i < faceCounts.length - 1 && inv < tanHalfFovX * thresholds[i]) i++;
  }
  if (i === faceCounts.length - 1 && C * rEff < tanHalfFovX * d) return -1;
  return i;
}

/** LOD index or -1 for a model with lod.qvm distances (metres, non-decreasing, [LOD1..LOD4, cutoff]) [recovered FUN_004c4d00]. */
export function selectLodExplicit(
  depthM: number,
  radiusM: number,
  distancesM: number[],
  lodCount: number,
  tanHalfFovX: number = CAMERA.worldTanHalfFovX,
  detail = 1,
): number {
  const d = tanHalfFovX * (depthM * detail - radiusM);
  if (distancesM[4] < d) return -1;
  let i = 0;
  if (distancesM[0] === 0 && lodCount - 1 > 0) i = Math.min(lodCount - 1, 1);
  while (distancesM[i] < d && i < lodCount - 1) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Render states (D3D7 values as set by igi.exe)
// ---------------------------------------------------------------------------

/** D3D7 blend factor names used below. */
export type D3DBlend = "ZERO" | "ONE" | "SRCCOLOR" | "INVSRCCOLOR" | "SRCALPHA" | "INVSRCALPHA";

export interface DrawStates {
  zTest: boolean;
  zWrite: boolean;
  /** D3DCMP: LESSEQUAL unless noted. */
  zFunc: "LESSEQUAL" | "LESS";
  /** D3DRENDERSTATE_ZBIAS (objects 3, everything else 0). */
  zBias: number;
  /** Culled winding (D3D screen space): "CCW" = D3DCULL_CCW; "NONE". */
  cull: "CCW" | "CW" | "NONE";
  blend: null | { src: D3DBlend; dst: D3DBlend };
  /** Alpha test GREATER than this reference (0..255), or null. */
  alphaGreaterThan: number | null;
  fog: "terrain" | "objects" | "none";
  /** Stage-0 MIN/MAG filter and MIP filter (D3DTFN/D3DTFP): "POINT" mip = nearest mip level. */
  filter: { minMag: "LINEAR" | "POINT"; mip: "POINT" | "NONE" };
  address: "WRAP" | "CLAMP";
  /** Function that sets these states [recovered]. */
  source: string;
}

/**
 * Draw states by path. Common to all 3D paths: DITHERENABLE TRUE,
 * SPECULARENABLE FALSE, ZENABLE D3DZB_TRUE (DAT_00b70ab8 = 1), mip LOD bias
 * from MipMapControl [recovered].
 */
export const DRAW_STATES: Record<string, DrawStates> = {
  objectOpaqueVertexLit: {
    zTest: true, zWrite: true, zFunc: "LESSEQUAL", zBias: 3, cull: "CCW", blend: null, alphaGreaterThan: null,
    fog: "objects", filter: { minMag: "LINEAR", mip: "POINT" }, address: "WRAP", source: "FUN_0052daf0 + FUN_0052dda0",
  },
  objectOpaqueLightmapped: {
    zTest: true, zWrite: true, zFunc: "LESSEQUAL", zBias: 3, cull: "CCW", blend: null, alphaGreaterThan: null,
    fog: "objects", filter: { minMag: "LINEAR", mip: "POINT" }, address: "WRAP",
    source: "FUN_0052de80 + FUN_0052dfd0 (lightmap stage 1: CLAMP, LINEAR, no mip)",
  },
  /** DNER block flag (s16 at +0x16 type 0 / +0x18 type 3) != 0: deferred, depth-sorted back to front (FUN_004ad570). */
  objectAlphaBlended: {
    zTest: true, zWrite: false, zFunc: "LESSEQUAL", zBias: 3, cull: "CCW", blend: { src: "SRCALPHA", dst: "INVSRCALPHA" }, alphaGreaterThan: 1,
    fog: "objects", filter: { minMag: "LINEAR", mip: "POINT" }, address: "WRAP", source: "FUN_0052f2c0 / FUN_0052f780 (+ FUN_0052e190 / FUN_0052e460)",
  },
  /** Deferred block with flag byte bit 0 (+0x18 type 0 / +0x1c type 3): muzzle flashes, explosion sprite. Unlit, texture only, no fog. */
  objectAdditive: {
    zTest: true, zWrite: false, zFunc: "LESSEQUAL", zBias: 3, cull: "CCW", blend: { src: "ONE", dst: "ONE" }, alphaGreaterThan: 1,
    fog: "none", filter: { minMag: "LINEAR", mip: "POINT" }, address: "WRAP", source: "FUN_0052f2c0 / FUN_0052f780",
  },
  terrainBase: {
    zTest: true, zWrite: true, zFunc: "LESS", zBias: 0, cull: "NONE", blend: null, alphaGreaterThan: null,
    fog: "terrain", filter: { minMag: "LINEAR", mip: "POINT" }, address: "CLAMP", source: "FUN_0050be70 + FUN_0050d7cc (fog colour = terrain fog)",
  },
  terrainAdditiveLayer: {
    zTest: true, zWrite: false, zFunc: "LESSEQUAL", zBias: 0, cull: "NONE", blend: { src: "ONE", dst: "ONE" }, alphaGreaterThan: null,
    fog: "terrain", filter: { minMag: "LINEAR", mip: "POINT" }, address: "CLAMP", source: "FUN_0050d749 (fog colour black)",
  },
  terrainLightmapMultiply: {
    zTest: true, zWrite: false, zFunc: "LESSEQUAL", zBias: 0, cull: "NONE", blend: { src: "ZERO", dst: "SRCCOLOR" }, alphaGreaterThan: null,
    fog: "terrain", filter: { minMag: "LINEAR", mip: "POINT" }, address: "CLAMP", source: "FUN_0050d6a0 (fog colour white)",
  },
  skyDome: {
    zTest: false, zWrite: false, zFunc: "LESS", zBias: 0, cull: "CCW", blend: null, alphaGreaterThan: null,
    fog: "none", filter: { minMag: "LINEAR", mip: "NONE" }, address: "WRAP", source: "FUN_00526de0 (vertex colour only)",
  },
  cloudLayer: {
    zTest: false, zWrite: false, zFunc: "LESSEQUAL", zBias: 0, cull: "NONE", blend: { src: "SRCALPHA", dst: "INVSRCALPHA" }, alphaGreaterThan: null,
    fog: "none", filter: { minMag: "LINEAR", mip: "NONE" }, address: "WRAP",
    source: "FUN_00517d20 -> TL primitive flags 0x41480000 (FUN_00504b00, FUN_00504c40, FUN_00504e40)",
  },
  /** PolyListDynCubeObj: blob shadows and bullet-hole decals; drawn with the near plane * 1.01 (depth nudge). */
  decal: {
    zTest: true, zWrite: false, zFunc: "LESSEQUAL", zBias: 0, cull: "CW", blend: { src: "SRCALPHA", dst: "INVSRCALPHA" }, alphaGreaterThan: 0,
    fog: "objects", filter: { minMag: "LINEAR", mip: "POINT" }, address: "WRAP", source: "FUN_00498840 + FUN_00498940 + FUN_00498c10 (flags 0)",
  },
};

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * Blob shadow under each human [recovered FUN_0045d850 -> FUN_004d7960,
 * draw FUN_004d7670 as a PolyListDynCubeObj with flags 0 (alpha blend)]:
 * textures.res "shadow1.tex" (32x32 black, soft alpha <= 199), one quad of
 * half-size 0.45 m on the ground under the human, oriented to the ground
 * normal and lifted 10 IGI units along it. Vertex colour 0.9 * f with
 * f = clamp(0.8 (1 - h / 1000 m), 0.3, 1), h = height above the ground hit;
 * because the texture is black and alpha comes from the texture, f does not
 * change the result [inferred].
 */
export const BLOB_SHADOW = {
  texture: "LOCAL:common/textures/shadow1.tex",
  halfSizeM: 1843.2 / IGI_PER_METRE,
  liftM: 10 / IGI_PER_METRE,
  fadeHeightM: 1000,
  baseGrey: 0.9,
  intensity: (heightM: number): number => Math.min(1, Math.max(0.3, 0.8 * (1 - heightM / 1000))),
} as const;

/**
 * Muzzle flash = the gun model's GUNFLAME attachment (magicobj.qvm
 * TASKTYPE_GUNFLAME: 1000_01_1, 1005_01_1, 1007_01_1, 1008_01_1, 1010_01_1)
 * drawn as a deferred additive block (ONE/ONE, unlit, unfogged) [observed DNER
 * flags; recovered FUN_0052f2c0]. FUN_00476000 shows it only while the gun's
 * last-shot render frame >= current frame - 1, and only on frames an even
 * number of frames after it first appeared; each shown frame it rolls about
 * the barrel axis by a random 0, 4 or 7 degrees (cumulative) [recovered].
 * The silenced MP5SD model (103_01_1) has no GUNFLAME attachment [observed].
 */
export const MUZZLE_FLASH = {
  models: ["1000_01_1", "1005_01_1", "1007_01_1", "1008_01_1", "1010_01_1"],
  rollStepsDeg: [0, 4, 7],
  blend: { src: "ONE", dst: "ONE" } as { src: D3DBlend; dst: D3DBlend },
} as const;

/** Whether the GUNFLAME is drawn on render frame `frame` (FUN_00476000). */
export function muzzleFlashVisible(frame: number, lastShotFrame: number, firstShownFrame: number): boolean {
  if (lastShotFrame < frame - 1) return false;
  return ((frame - firstShownFrame) & 1) === 0;
}

/**
 * One TASKTYPE_GUNSHOTEFFECT record of DefineGameMaterial (parsed by
 * FUN_00437a30 into 0x60 bytes; used by FUN_004376c0) [recovered]. Entry A
 * (args 22-28, material +0x254 / +0x258) serves front-face hits, entry B
 * (args 29-35, +0x25c / +0x260) back-face (exit) hits.
 */
export interface ImpactEffect {
  effectTask: string | null;
  /** Record +0: dust puffs (2 x concrete1.spr particles, 50 % chance). */
  flagA: boolean;
  /** Record +1: the impact model thrown as 2-4 fragments. */
  flagB: boolean;
  /**
   * Bullet-hole textures: [0] used when the bullet went on (FUN_004084d0 flag
   * 1: every impact but the last of a bullet that did not ricochet), [1]
   * otherwise and as the fallback; a front hit records no effect at all when
   * [0] is empty.
   */
  decalTextures: [string, string];
  /** Bullet-hole HALF-size in metres (x 4096 = units, double 0x531498). */
  size: number;
  /** Fragment model (e.g. 1012_01_1), drawn at scale 0.1. */
  model: string;
}

export interface ImpactMaterial {
  index: number;
  name: string;
  /** [entry A: front faces, entry B: back faces]. */
  effects: [ImpactEffect, ImpactEffect];
}

function valueString(v: QvmValue | undefined): string {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "symbol" in v) return v.symbol;
  return "";
}

function valueNumber(v: QvmValue | undefined): number {
  return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0;
}

/**
 * Bullet-impact decals per game material from material/material.qvm
 * (SetActiveMaterial(i); DefineGameMaterial(name, ..., args 22-28 and 29-35))
 * [observed values: e.g. Concrete -> bullethole_concrete.tex / dent_concrete.tex,
 * size 0.05, impact model 1012_01_1; Glass -> hole_plexi1.tex, 0.08].
 */
export function readImpactMaterials(calls: QvmCall[]): ImpactMaterial[] {
  const out: ImpactMaterial[] = [];
  let active = -1;
  for (const call of calls) {
    if (call.fn === "SetActiveMaterial") active = valueNumber(call.args[0]);
    if (call.fn !== "DefineGameMaterial") continue;
    const a = call.args;
    if (a.length < 36) throw new Error(`render-params: DefineGameMaterial has ${a.length} arguments, expected 36`);
    const effect = (o: number): ImpactEffect => ({
      effectTask: valueString(a[o]) || null,
      flagA: a[o + 1] === true,
      flagB: a[o + 2] === true,
      decalTextures: [valueString(a[o + 3]), valueString(a[o + 4])],
      size: valueNumber(a[o + 5]),
      model: valueString(a[o + 6]),
    });
    out.push({ index: active, name: valueString(a[0]), effects: [effect(22), effect(29)] });
  }
  return out;
}

/**
 * One DefineAmmoType call (ammo/<dir>/ammo.qvm; handler FUN_0047b1b0, record
 * 0x168 bytes at DAT_005c1790, count DAT_005c4494) [recovered layout, observed
 * values]. A gun's ammo type is the one whose `calibre` equals the WeaponConfig
 * "Calibre ID" (FUN_0047b450 -> gun +0x12c); a pickup's / pool's is the one
 * whose `index` equals the AMMO_ID value (FUN_0047b420), and arg 1 defines that
 * AMMO_ID symbol with the value `index` (FUN_004aea50(arg 1, arg 0)).
 */
export interface AmmoType {
  /** Arg 0 (+0x00): the AMMO_ID_* value (FUN_0047b420 matches it). */
  index: number;
  /** Arg 1, e.g. "AMMO_ID_919": symbol defined with the value `index`. */
  id: string;
  /** Arg 2 (+0x28, 32 bytes), e.g. "<919>" [observed; no reader found in the traced code]. */
  name?: string;
  /** Arg 3 (+0x48, 256 bytes), e.g. "<919DESC>" [observed; no reader found]. */
  description?: string;
  /** Arg 4 (+0x04): calibre number matched against WeaponConfig "Calibre ID". */
  calibre: number;
  /**
   * Arg 5 (+0x24, f32): 919 / 556 / .44 3.5, .357 9.7, 7.62 12, every other
   * type 2 [observed]. No reader found in the gun, GunShot, tracer or pickup
   * code (meaning unresolved).
   */
  arg5?: number;
  /** Args 6-8 (+0x08..+0x10): tracer colour at the muzzle end, 0-255. */
  tracerNear: [number, number, number];
  /** Args 9-11 (+0x14..+0x1c): tracer colour at full range, 0-255. */
  tracerFar: [number, number, number];
  /** Arg 12 (+0x20): bullets of this calibre draw tracers (FUN_00479e30 0x47a7c0). */
  tracer: boolean;
  /**
   * Arg 13 (+0x148, 16 bytes): the model an AmmoPickup of this type draws and
   * takes its touch radius from (AmmoPickup compile FUN_0046c350:
   * FUN_004c82b0(ammo +0x148) -> FUN_004baaf0 = object +0x6c). "" = none
   * (.50 cal).
   */
  model: string;
  /** Arg 14 (+0x158, 16 bytes), "Sound0" in every file [observed; no reader found]. */
  sound?: string;
}

/** DefineAmmoType calls of one ammo.qvm (FUN_0047b1b0 argument order). */
export function readAmmoTypes(calls: QvmCall[]): AmmoType[] {
  const out: AmmoType[] = [];
  for (const call of calls) {
    if (call.fn !== "DefineAmmoType") continue;
    const a = call.args;
    if (a.length < 15) throw new Error(`render-params: DefineAmmoType has ${a.length} arguments, expected 15`);
    out.push({
      index: valueNumber(a[0]),
      id: valueString(a[1]),
      name: valueString(a[2]),
      description: valueString(a[3]),
      calibre: valueNumber(a[4]),
      arg5: valueNumber(a[5]),
      tracerNear: [valueNumber(a[6]), valueNumber(a[7]), valueNumber(a[8])],
      tracerFar: [valueNumber(a[9]), valueNumber(a[10]), valueNumber(a[11])],
      tracer: valueNumber(a[12]) !== 0,
      model: valueString(a[13]),
      sound: valueString(a[14]),
    });
  }
  return out;
}

/**
 * The ammo directories. igi.exe walks every directory of "LOCAL:ammo" and runs
 * its "ammo.qsc" (FUN_0047b3d0 -> FUN_004a7890 with callback FUN_0047b120)
 * [recovered]; a browser asset source cannot list directories, so these are
 * the directory names of the shipped game [observed].
 */
export const AMMO_DIRS = ["12", "127", "357", "44", "556", "762", "919", "DRAGUNOV", "FLASHBANG", "GRENADE", "M203", "MEDIPACK", "PROXIMITYMINE"] as const;

/** Path of one ammo directory's compiled script. */
export const ammoTypePath = (dir: string): string => `ammo/${dir}/ammo.qvm`;

/**
 * Every DefineAmmoType of the ammo directories, keyed by AMMO_ID ("AMMO_ID_919").
 * Missing files are skipped; unreadable ones are reported in `warnings`.
 */
export async function loadAmmoTypes(raw: IAssetSource, warnings: string[] = [], dirs: readonly string[] = AMMO_DIRS): Promise<Map<string, AmmoType>> {
  const out = new Map<string, AmmoType>();
  for (const dir of dirs) {
    const path = ammoTypePath(dir);
    if (!(await raw.exists(path))) continue; // not staged: no ammo types (as effect-assets.ts)
    try {
      for (const type of readAmmoTypes(readQvmCallTree(await raw.readBinary(path)))) if (type.id) out.set(type.id, type);
    } catch (error) {
      warnings.push(`ammo type ${path}: ${(error as Error).message}`);
    }
  }
  return out;
}

/**
 * Decode the LOOP v2 bitmaps (common/textures/flare00-07.tex, shadow00-01.tex):
 * "LOOP", u32 2, 8 zero bytes, u16 row bytes (= 2 w), u16 w, u16 h, u16 2,
 * then w*h A1R5G5B5 from 0x18 to EOF [observed on all 10 files]. No string in
 * igi.exe names these files and level 1 has no Lensflare task: unused by
 * level 1 [observed]. The flares hold one quadrant (bright centre at the
 * bottom-right corner) [observed].
 */
export function decodeLoopV2Tex(buffer: ArrayBuffer): DecodedTexture {
  const view = new DataView(buffer);
  const b = new Uint8Array(buffer);
  if (buffer.byteLength < 0x18 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== "LOOP" || view.getUint32(4, true) !== 2) {
    throw new Error("render-params: not a LOOP v2 texture");
  }
  const rowBytes = view.getUint16(0x10, true);
  const width = view.getUint16(0x12, true);
  const height = view.getUint16(0x14, true);
  if (width < 1 || height < 1 || rowBytes !== width * 2 || 0x18 + rowBytes * height !== buffer.byteLength) {
    throw new Error(`render-params: LOOP v2 size mismatch (${width}x${height}, ${buffer.byteLength} bytes)`);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const v = view.getUint16(0x18 + p * 2, true);
    const r = (v >> 10) & 31;
    const g = (v >> 5) & 31;
    const bl = v & 31;
    rgba[p * 4] = (r << 3) | (r >> 2);
    rgba[p * 4 + 1] = (g << 3) | (g >> 2);
    rgba[p * 4 + 2] = (bl << 3) | (bl >> 2);
    rgba[p * 4 + 3] = v & 0x8000 ? 255 : 0;
  }
  return { width, height, rgba, format: "LOOP v2 A1R5G5B5 (inferred bit order)" };
}
