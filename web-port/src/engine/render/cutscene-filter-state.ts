/**
 * Cut-scene camera filters of igi.exe (EditCamera FILTER): LineFilter,
 * BandFilter (BAND / BAND_UPDATE) and HandiCamFilter, as state machines and
 * the exact 2-D geometry they draw each frame (docs/mission.md "Camera
 * filters", docs/rendering.md section 5). Pure: no Three.js; the WebGL side
 * is cutscene-filters.ts.
 *
 * Recovered (igi.exe, addresses in docs):
 *   - Classes and handlers are registered once at start-up by FUN_00499900,
 *     which also seeds the filters' own RNG DAT_006c62c8 (FUN_004aaa00, the
 *     unseeded init) and draws the HandiCam time code start
 *     DAT_006c6710 = rand * 21600 frames.
 *   - FUN_004ec230 (CutScene apply) at a cut destroys the cut-scene's three
 *     overlay slots (+0x25c line, +0x264 band, +0x268 handicam) and creates the
 *     one the current key (k1) asks for, with k1's own Filter color:
 *       1 LINE      FUN_004992e0(colour, depth 614.4, deferred 1)
 *       2/3 BAND    FUN_00499390(depth 614.4, colour, 60, 90, noise); 3 first
 *                   advances the global camera number DAT_00541b80 (1..9)
 *       4 HANDICAM  FUN_00499810(colour, depth 614.4)
 *     and on every apply: band colour = the colour interpolated k1 -> k2,
 *     clamped to [0, 1] (FUN_00499700); line noise = the interpolated Noise
 *     (FUN_0049bef0).
 *   - FUN_004ebe30: the tick a cut-scene stops it remembers the render frame
 *     (DAT_007ef148); on a later tick in another frame it destroys its
 *     overlays. Leaving the world destroys them at once (FUN_004ed0f0).
 *   - Per tick (class slot 1): BandFilter LAB_0049a7a0, HandiCamFilter
 *     LAB_0049bbb0 (real-time ms, GetTickCount). LineFilter: none.
 *   - Per frame (slot 0 + deferred draw at depth 614.4): DrawLineFilter
 *     LAB_00499bd0, FUN_0049a5d0 + DrawBandFilter LAB_0049a840,
 *     FUN_0049bc10 + DrawHandiCamFilter LAB_0049b200.
 *
 * Coordinates: the 3-D viewport (DAT_00b708f8 x, y, w, h; the full 640x480
 * frame in the port). Pre-transformed primitives (lines, bands) follow D3D7
 * pixel centres at integer coordinates; the primitives returned here are
 * already resolved to whole virtual pixels ([x0, x1) x [y0, y1)) so the
 * renderer can draw them at any resolution. 2-D TL primitives (text, the
 * battery sprite) keep the exe's float coordinates: their -0.5 vertex offset
 * (FUN_00504300) is equivalent to drawing them unshifted with pixel centres at
 * +0.5 (docs/hud.md section 3).
 */
import type { Vec3 } from "../../contracts";
import { x87Add, x87Div, x87Fistp, x87Mul, x87StoreF32, x87Sub } from "../../loaders/x87";
import { LevelRng } from "../ai/rng";

/** CAMERAFILTER_TYPE_* (FUN_00499900). */
export const CAMERA_FILTER = { NONE: 0, LINE: 1, BAND: 2, BAND_UPDATE: 3, HANDICAM: 4 } as const;

/** float32 constants read from igi.exe (.rdata) and the call sites (bit patterns = Math.fround of the decimal). */
export const FILTER_CONST = {
  /** Depth of every filter overlay, IGI units (0x4419999a pushed at 0x4ecc84 / 0x4ecd0a / 0x4ecd51). */
  depth: Math.fround(614.4),
  /** Line / scan-line pitch, px (0x53158c). */
  linePitch: 4,
  /** Alpha byte of the LINE and HANDICAM scan lines (`or ch,0x4c` at 0x499f0c / 0x49b532). */
  lineAlpha: 0x4c,
  /** Noise segments: count = noise x 10 (0x531480), max length 50 px (0x531920). */
  noiseScale: 10,
  noiseLength: 50,
  /** Colour byte scale 255 (0x5316d4). */
  byteScale: 255,
  /** Band height = viewport height x 0.05 (0x531590); 1 texel per pixel (u, v x 0.0625, 0x5315cc). */
  bandHeightFactor: Math.fround(0.05),
  texelScale: 0.0625,
  /** Bands shift down by half a band while the roll counter > 45 (double at 0x5322e0). */
  rollThreshold: 45,
  /** FUN_00499390 arguments pushed at 0x4eccf8 / 0x4eccfa: roll period 60 ticks, burst period 90 ticks. */
  rollPeriod: 60,
  burstPeriod: 90,
  /** Burst decay -4 / rollPeriod per tick (0x5322d8), re-arm = trunc(rand x 90 x 0.7) (0x5316c4). */
  burstDecay: -4,
  burstRearm: Math.fround(0.7),
  /** Speckles = trunc(burst x 256) per texture (0x5322d0), pixel index trunc(rand x -256) (0x5322cc). */
  speckleScale: 256,
  /** Band texture: 16 x 16 BGRA, half-colour rows x 128 (0x5322c8 = -128), full x 255 (0x5322c0 = -255). */
  bandTexSize: 16,
  /** "CAMERA %d" (0x541c7c) at (w x 0.9 - 50, h x 0.2), FUN_004997b0 args from FUN_004148b0. */
  cameraText: { fx: Math.fround(0.9), fy: Math.fround(0.2), dx: -50, dy: 0 },
  /** Time code "%2.2d : %2.2d : %2.2d : %2.2d" (0x541c88) at (w x 0.9 - 117, h x 0.8 - 20) (0x5315bc, 0x5316cc, FUN_004998e0). */
  timecodeText: { fx: Math.fround(0.9), fy: Math.fround(0.8), dx: 117, dy: 20 },
  /** Time code: 24 frames per second (0.024 per ms, 0x5322e8), start = rand x 21600 (0x5322d4). */
  timecodePerMs: Math.fround(0.024),
  timecodeStartRange: 21600,
  /** Battery: (w x 0.1 + 4, h x 0.2 + 2), width w x 0.07 (0x5313c8, 0x5313c4, 0x5322ec; FUN_004998c0 offsets 4, 2). */
  battery: { fx: Math.fround(0.1), fy: Math.fround(0.2), dx: 4, dy: 2, fw: Math.fround(0.07) },
  /** Battery blink: phase += ms x 0.001 (0x5316c0), shown while >= 0.75 (0x531524), reset above 1.5 (0x531544). */
  blinkPerMs: Math.fround(0.001),
  blinkOn: 0.75,
  blinkWrap: 1.5,
  /** Corner brackets: at (0.1|0.9 w, 0.2|0.8 h), 50 px arms, 2 px thick, white (LAB_0049b200). */
  bracketArm: 50,
  /** Text colour (100, 100, 100) in the 128 = neutral scale: byte trunc(100 / 128 x 255) = 199. */
  textColourByte: 199,
} as const;

/** Assets the exe loads for the filters (FUN_004148b0 -> FUN_004997b0 / FUN_004998e0 / FUN_004998c0). */
export const FILTER_ASSETS = {
  /** "LOCAL:computer/font1.fnt": CAMERA %d and the time code. */
  font: { archive: "computer/computer.res", member: "font1.fnt" },
  /** "LOCAL:common/sprites/battery.spr": blinking HandiCam battery. */
  battery: { archive: "common/sprites/sprites.res", member: "battery.spr" },
} as const;

export interface FilterViewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The port's 3-D viewport: the whole 640 x 480 frame (configured display mode). */
export const FILTER_VIEWPORT: FilterViewport = { x: 0, y: 0, w: 640, h: 480 };

export interface LineOverlay {
  kind: "line";
  cutSceneId: number;
  /** k1's Filter color at the cut (+0x20..+0x28). */
  colour: Vec3;
  /** Interpolated Noise, refreshed on every apply (+0x30). */
  noise: number;
}

export interface BandOverlay {
  kind: "band";
  cutSceneId: number;
  /** Clamped colour, interpolated k1 -> k2 on every apply (+0x64..+0x6c). */
  colour: Vec3;
  /** Interpolated Noise at the cut (+0x28): 0 = plain multiply tint, else bands + "CAMERA n". */
  noise: number;
  /** Speckle burst (+0x24), decays 4/60 per tick. */
  burst: number;
  /** Roll counter (+0x50), 0..60. */
  roll: number;
  /** Burst counter (+0x58), counts up to 90. */
  burstCounter: number;
  /** Camera number at creation (+0x60, DAT_00541b80). */
  camera: number;
}

export interface HandiCamOverlay {
  kind: "handicam";
  cutSceneId: number;
  colour: Vec3;
  /** Blink phase in seconds (+0x44). */
  blink: number;
  /** Real-time ms of the last update (+0x48). */
  lastMs: number;
}

export type CutsceneOverlay = LineOverlay | BandOverlay | HandiCamOverlay;

/** What one CutScene apply passes to the filters (FUN_004ec230). */
export interface CutsceneFilterApply {
  /** The key index changed this apply (FUN_004ec060 "cut"). */
  cut: boolean;
  /** CAMERAFILTER_TYPE of the current key k1. */
  filter: number;
  /** k1's own Filter color. */
  keyColour: Vec3;
  /** Filter color interpolated linearly between k1 and k2. */
  colour: Vec3;
  /** Noise channel (cubic Hermite, float32). */
  noise: number;
}

/** One draw primitive in the 640 x 480 virtual frame, in draw order. */
export type FilterPrimitive =
  /** Flat rectangle on whole virtual pixels; `multiply` = ZERO/SRCCOLOR (alpha ignored), else SRCALPHA/INVSRCALPHA. */
  | { kind: "rect"; x0: number; y0: number; x1: number; y1: number; rgba: [number, number, number, number]; blend: "alpha" | "multiply" }
  /** Band strip: frame *= texture colour (DESTCOLOR/ZERO), 16 x 16 RGBA texture repeated 1 texel per pixel from (0, y0). */
  | { kind: "band"; x0: number; y0: number; x1: number; y1: number; texture: Uint8Array }
  /** Left-aligned text line in font1.fnt, glyph colour x byte/255, opaque vertex alpha. */
  | { kind: "text"; text: string; x: number; y: number; colourByte: number }
  /** Battery sprite quad: corners in the exe's vertex order, uv (0,0) (1,0) (0,1) (1,1); vertex alpha byte. */
  | { kind: "battery"; quad: [number, number, number, number, number, number, number, number]; alpha: number };

const f32 = x87StoreF32;
const clamp01 = (v: number): number => (0 <= v ? (1 < v ? 1 : v) : 0);

/** D3D7 LINELIST horizontal segment at row y from x0 to x1 (x1 >= x0): pixel centres in [x0, x1) [inferred: last pixel off]. */
function hline(out: FilterPrimitive[], x0: number, x1: number, y: number, rgba: [number, number, number, number]): void {
  const a = Math.ceil(x0);
  const b = Math.ceil(x1);
  if (b > a) out.push({ kind: "rect", x0: a, y0: y, x1: b, y1: y + 1, rgba, blend: "alpha" });
}

/** Axis-aligned D3D line between integer points (start pixel drawn, end pixel not) [inferred]. */
function axisLine(out: FilterPrimitive[], ax: number, ay: number, bx: number, by: number, rgba: [number, number, number, number]): void {
  if (ay === by) {
    const [x0, x1] = bx >= ax ? [ax, bx] : [bx + 1, ax + 1];
    if (x1 > x0) out.push({ kind: "rect", x0, y0: ay, x1, y1: ay + 1, rgba, blend: "alpha" });
  } else if (ax === bx) {
    const [y0, y1] = by >= ay ? [ay, by] : [by + 1, ay + 1];
    if (y1 > y0) out.push({ kind: "rect", x0: ax, y0, x1: ax + 1, y1, rgba, blend: "alpha" });
  }
}

/** The 0x4c-alpha scan-line colour: ((fistp(r*255) | 0x4c00) << 8 | fistp(g*255)) << 8 | fistp(b*255) (0x499efb). */
export function scanLineColour(c: Vec3): [number, number, number, number] {
  const r = x87Fistp(x87Mul(c[0], FILTER_CONST.byteScale));
  const g = x87Fistp(x87Mul(c[1], FILTER_CONST.byteScale));
  const b = x87Fistp(x87Mul(c[2], FILTER_CONST.byteScale));
  const v = ((((r | (FILTER_CONST.lineAlpha << 8)) << 8) | g) << 8) | b;
  return [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, v >>> 24];
}

/** BGRA dword (format 3) -> RGBA bytes. */
function dwordRgba(p: number, out: Uint8Array, i: number): void {
  out[i] = (p >>> 16) & 0xff;
  out[i + 1] = (p >>> 8) & 0xff;
  out[i + 2] = p & 0xff;
  out[i + 3] = (p >>> 24) & 0xff;
}

/** FUN_00499500 / FUN_004995c0 colour dword: trunc(c x scale) per channel, R << 16 | G << 8 | B. */
function bandDword(c: Vec3, scale: number): number {
  const r = x87Fistp(x87Mul(c[0], -scale));
  const g = x87Fistp(x87Mul(c[1], -scale));
  const b = x87Fistp(x87Mul(c[2], scale));
  // sub esi, ((R << 8) + G) << 8 with R, G negative (0x49954b).
  return (b - ((((r << 8) + g) << 8) | 0)) | 0;
}

/** HandiCam time code text from DAT_006c6710 (0x49bc4a): hours are minutes / 60 of minutes % 60, i.e. always 00. */
export function timecodeText(timecode: number): string {
  const t = x87Fistp(timecode);
  const seconds = Math.trunc(t / 24);
  const minutes = Math.trunc(seconds / 60) % 60;
  const hours = Math.trunc(minutes / 60);
  // printf "%2.2d": at least two digits.
  const p2 = (v: number) => (v < 0 ? `-${String(-v).padStart(2, "0")}` : String(v).padStart(2, "0"));
  return `${p2(hours)} : ${p2(minutes)} : ${p2(seconds % 60)} : ${p2(t % 24)}`;
}

interface CutSceneSlots {
  line: LineOverlay | null;
  band: BandOverlay | null;
  handicam: HandiCamOverlay | null;
  /** Render frame remembered the tick the cut-scene stopped (+0x270; -1 at compile). */
  stopFrame: number;
}

/**
 * The filter overlays of all cut-scenes plus the exe's globals the filters
 * share: RNG DAT_006c62c8, time code DAT_006c6710, camera number DAT_00541b80
 * and the render frame counter DAT_007ef148. One instance per game session
 * (FUN_00499900 runs once at start-up).
 */
export class CutsceneFilters {
  /** DAT_006c62c8: FUN_004aaa00 init (= LevelRng seeded with 0). */
  readonly rng = new LevelRng(0);
  /** DAT_006c6710: time code in 1/24 s frames (float32). */
  timecode: number;
  /** DAT_00541b80: CAMERA number, 1..9 (initial data value 1). */
  cameraNumber = 1;
  /** DAT_007ef148: render frames drawn (advanced by buildFrame). */
  frame = 0;
  private readonly slots = new Map<number, CutSceneSlots>();
  /** Children of the overlay root in creation order (= submit / draw order). */
  private list: CutsceneOverlay[] = [];

  constructor() {
    // FUN_00499900 tail: FUN_004aaa00(&DAT_006c62c8); DAT_006c6710 = rand * 21600.
    this.timecode = f32(x87Mul(this.rng.float(), FILTER_CONST.timecodeStartRange));
  }

  /** Live overlays in draw order. */
  overlays(): readonly CutsceneOverlay[] {
    return this.list;
  }

  private slotsOf(id: number): CutSceneSlots {
    let s = this.slots.get(id);
    if (!s) {
      s = { line: null, band: null, handicam: null, stopFrame: -1 };
      this.slots.set(id, s);
    }
    return s;
  }

  private remove(o: CutsceneOverlay | null): null {
    if (o) this.list = this.list.filter((x) => x !== o);
    return null;
  }

  /** FUN_004ec230 tail: rebuild at a cut, then the per-apply refreshes. */
  apply(cutSceneId: number, a: CutsceneFilterApply, nowMs: number): void {
    const s = this.slotsOf(cutSceneId);
    if (a.cut) {
      s.line = this.remove(s.line);
      if (a.filter === CAMERA_FILTER.LINE) {
        s.line = { kind: "line", cutSceneId, colour: [...a.keyColour] as Vec3, noise: 0 };
        this.list.push(s.line);
      }
      if (a.filter === CAMERA_FILTER.BAND_UPDATE) this.cameraNumber = this.cameraNumber < 9 ? this.cameraNumber + 1 : 1; // FUN_004997f0
      s.band = this.remove(s.band);
      if (a.filter === CAMERA_FILTER.BAND || a.filter === CAMERA_FILTER.BAND_UPDATE) {
        // FUN_00499390: +0x58 = +0x5c = 90, +0x50 = 0, +0x24 = 0, colour clamped.
        s.band = {
          kind: "band", cutSceneId, colour: a.keyColour.map(clamp01) as Vec3, noise: a.noise, burst: 0, roll: 0,
          burstCounter: FILTER_CONST.burstPeriod, camera: this.cameraNumber,
        };
        this.list.push(s.band);
      }
      s.handicam = this.remove(s.handicam);
      if (a.filter === CAMERA_FILTER.HANDICAM) {
        // FUN_00499810: +0x44 = 0, +0x48 = FUN_0048e780() (GetTickCount ms).
        s.handicam = { kind: "handicam", cutSceneId, colour: [...a.keyColour] as Vec3, blink: 0, lastMs: Math.trunc(nowMs) };
        this.list.push(s.handicam);
      }
    }
    if (s.band) s.band.colour = a.colour.map(clamp01) as Vec3; // FUN_00499700
    if (s.line) s.line.noise = a.noise; // FUN_0049bef0
  }

  /** FUN_004ed0f0: destroy a cut-scene's overlays (its subtree left the world, or a mission restart). */
  destroy(cutSceneId: number): void {
    const s = this.slots.get(cutSceneId);
    if (!s) return;
    s.line = this.remove(s.line);
    s.band = this.remove(s.band);
    s.handicam = this.remove(s.handicam);
  }

  /** Mission (re)start: drop every overlay; the session globals (RNG, time code, camera number) persist. */
  clear(): void {
    this.slots.clear();
    this.list = [];
  }

  /**
   * End of one game tick. `applied`: cut-scenes that applied their camera this
   * tick; `stopped`: cut-scenes on their stop tick. FUN_004ebe30 destroys the
   * overlays of a cut-scene that is not running on a later tick in another
   * render frame; then every overlay runs its slot-1 update.
   */
  endTick(applied: ReadonlySet<number>, stopped: ReadonlySet<number>, nowMs: number): void {
    for (const [id, s] of this.slots) {
      if (applied.has(id)) continue;
      if (stopped.has(id)) s.stopFrame = this.frame;
      else if (s.stopFrame !== this.frame) this.destroy(id);
    }
    for (const o of this.list) {
      if (o.kind === "band") updateBand(o, this.rng);
      else if (o.kind === "handicam") this.updateHandiCam(o, nowMs);
    }
  }

  /** LAB_0049bbb0: real-time ms since the last update advance the time code and the blink phase. */
  private updateHandiCam(o: HandiCamOverlay, nowMs: number): void {
    const now = Math.trunc(nowMs);
    const dt = now - o.lastMs;
    this.timecode = f32(x87Add(x87Mul(dt, FILTER_CONST.timecodePerMs), this.timecode));
    const blink = x87Add(x87Mul(dt, FILTER_CONST.blinkPerMs), o.blink);
    o.blink = blink > FILTER_CONST.blinkWrap ? 0 : f32(blink);
    o.lastMs = now;
  }

  /**
   * One rendered frame: the overlays' slot-0 submissions and deferred draws in
   * creation order (all at depth 614.4), drawing from the filter RNG exactly
   * as the exe does. Advances the render frame counter.
   */
  buildFrame(vp: FilterViewport = FILTER_VIEWPORT): FilterPrimitive[] {
    const out: FilterPrimitive[] = [];
    for (const o of this.list) {
      if (o.kind === "line") drawLine(out, o, vp, this.rng);
      else if (o.kind === "band") drawBand(out, o, vp, this.rng);
      else drawHandiCam(out, o, vp, this.timecode);
    }
    this.frame++;
    return out;
  }
}

/** LAB_0049a7a0: burst decay, roll counter, burst re-arm. */
export function updateBand(o: BandOverlay, rng: LevelRng): void {
  const d = f32(x87Div(FILTER_CONST.burstDecay, FILTER_CONST.rollPeriod));
  const neg = -o.burst;
  o.burst = f32(x87Add(neg > d ? neg : d, o.burst));
  o.roll = o.roll < FILTER_CONST.rollPeriod ? o.roll + 1 : 0;
  if (o.burstCounter < FILTER_CONST.burstPeriod) {
    o.burstCounter++;
    return;
  }
  o.burstCounter = x87Fistp(x87Mul(x87Mul(rng.float(), FILTER_CONST.burstPeriod), FILTER_CONST.burstRearm));
  o.burst = f32(x87Mul(rng.float(), o.noise));
}

/** DrawLineFilter (LAB_00499bd0). */
export function drawLine(out: FilterPrimitive[], o: LineOverlay, vp: FilterViewport, rng: LevelRng): void {
  const bottom = x87Add(vp.h, vp.y);
  const left = x87Fistp(vp.x);
  const right = x87Fistp(x87Add(vp.w, vp.x));
  const lineRgba = scanLineColour(o.colour);
  for (let y = f32(vp.y); x87Add(y, FILTER_CONST.linePitch) <= bottom; y = f32(x87Add(y, FILTER_CONST.linePitch))) {
    hline(out, left, right, x87Fistp(y), lineRgba);
  }
  if (!(o.noise > 0)) return;
  // Noise: n = noise x 10; below 1 the rows spread out (1/n px apart, 1 segment each).
  let n = x87Mul(o.noise, FILTER_CONST.noiseScale);
  let step = 1;
  if (n < 1) {
    step = f32(x87Div(1, n));
    n = 1;
  }
  const count = x87Fistp(n);
  const alpha = x87Fistp(x87Mul(o.noise, FILTER_CONST.byteScale));
  const xMax = x87Add(vp.w, vp.x);
  let vertices = 0; // the 200-vertex lock: at 200 the iteration only flushes (0x49a1f7)
  let y = f32(vp.y);
  let next = f32(x87Add(step, y));
  while (!(bottom < next)) {
    const row = x87Fistp(y);
    for (let k = 0; k < count; k++) {
      if (vertices >= 200) {
        vertices = 0;
        continue;
      }
      const x0 = f32(x87Add(x87Mul(rng.float(), vp.w), vp.x));
      const grey = x87Fistp(x87Mul(rng.float(), FILTER_CONST.byteScale));
      const v = ((((alpha << 8) | grey) << 8 | grey) << 8) | grey;
      let x1 = f32(x87Add(x87Mul(rng.float(), FILTER_CONST.noiseLength), x0));
      if (xMax <= x1) x1 = f32(xMax);
      hline(out, x0, x1, row, [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, v >>> 24]);
      vertices += 2;
    }
    y = next;
    next = f32(x87Add(step, y));
  }
}

/** Band texture of FUN_00499500 (scan-line: 2 rows half colour, 2 rows full) or FUN_004995c0 (flat full colour). */
export function bandTexture(colour: Vec3, scanLines: boolean): Uint32Array {
  const tex = new Uint32Array(FILTER_CONST.bandTexSize * FILTER_CONST.bandTexSize);
  const half = bandDword(colour, 128);
  const full = bandDword(colour, 255);
  if (scanLines) for (let i = 0; i < tex.length; i++) tex[i] = (i >> 5) & 1 ? full : half;
  else tex.fill(full);
  return tex;
}

/** FUN_00499620: trunc(burst x 256) random texels darkened by one random factor, shifted one byte up (R' G' B' -> A R G). */
export function speckle(tex: Uint32Array, burst: number, rng: LevelRng): void {
  const n = x87Fistp(x87Mul(burst, FILTER_CONST.speckleScale));
  for (let k = 0; k < n; k++) {
    const i = -x87Fistp(x87Mul(rng.float(), -FILTER_CONST.speckleScale));
    const p = tex[i] | 0;
    const b = p & 0xff;
    const g = (p >> 8) & 0xff;
    const r = (p >> 16) & 0xff;
    const s = rng.float();
    tex[i] = ((((x87Fistp(x87Mul(r, s)) << 8) + x87Fistp(x87Mul(g, s))) << 8) + x87Fistp(x87Mul(b, s))) << 8;
  }
}

function textureRgba(tex: Uint32Array): Uint8Array {
  const out = new Uint8Array(tex.length * 4);
  for (let i = 0; i < tex.length; i++) dwordRgba(tex[i], out, i * 4);
  return out;
}

/** Band boundaries of DrawBandFilter (0x49aa7d): array[0] = top, array[1] = top (+ half a band while rolling), then every band height, last = bottom. */
export function bandEdges(o: BandOverlay, vp: FilterViewport): number[] {
  const h = f32(x87Mul(vp.h, FILTER_CONST.bandHeightFactor));
  const top = f32(x87Fistp(vp.y));
  const edges = [top];
  let y = top;
  if (o.roll > FILTER_CONST.rollThreshold) y = x87Add(y, x87Mul(h, 0.5));
  edges.push(f32(y));
  y = x87Add(y, h);
  const end = f32(x87Add(x87Fistp(vp.h), top));
  while (y < end) {
    edges.push(f32(y));
    y = x87Add(y, h);
  }
  edges.push(end);
  return edges;
}

/** FUN_0049a5d0 (submit) + DrawBandFilter (LAB_0049a840). */
export function drawBand(out: FilterPrimitive[], o: BandOverlay, vp: FilterViewport, rng: LevelRng): void {
  if (o.noise !== 0) {
    // Deferred DrawBandFilter: odd bands (from edge 1) with the scan-line texture, even bands (from edge 0) flat.
    const e = bandEdges(o, vp);
    const n = e.length - 1;
    const x0 = Math.ceil(x87Fistp(vp.x));
    const x1 = Math.ceil(x87Add(x87Fistp(vp.x), vp.w));
    for (const [first, quads, scan] of [[1, n >> 1, true], [0, (n + 1) >> 1, false]] as const) {
      const tex = bandTexture(o.colour, scan);
      speckle(tex, o.burst, rng);
      const rgba = textureRgba(tex);
      for (let q = 0; q < quads; q++) {
        const ya = Math.ceil(e[first + 2 * q]);
        const yb = Math.ceil(e[first + 2 * q + 1]);
        if (yb > ya) out.push({ kind: "band", x0, y0: ya, x1, y1: yb, texture: rgba });
      }
    }
    const c = FILTER_CONST.cameraText;
    out.push({
      kind: "text", text: `CAMERA ${o.camera}`,
      x: f32(x87Add(x87Add(x87Mul(vp.w, c.fx), c.dx), vp.x)), y: f32(x87Add(x87Add(x87Mul(vp.h, c.fy), c.dy), vp.y)),
      colourByte: FILTER_CONST.textColourByte,
    });
  } else {
    // Multiply tint over the viewport: FUN_004aabf0(int x, int y, int w, int h, colour x 128, flag 0x80000000).
    const b = (v: number) => x87Fistp(x87Mul(v, FILTER_CONST.byteScale)) & 0xff;
    const px = (v: number) => Math.ceil(v - 0.5) + 0; // + 0: no -0
    const x = x87Fistp(vp.x);
    const y = x87Fistp(vp.y);
    out.push({
      kind: "rect", x0: px(x), y0: px(y), x1: px(x + x87Fistp(vp.w)), y1: px(y + x87Fistp(vp.h)),
      rgba: [b(o.colour[0]), b(o.colour[1]), b(o.colour[2]), 255], blend: "multiply",
    });
  }
}

/** DrawHandiCamFilter (LAB_0049b200) + FUN_0049bc10 (time code, battery). */
export function drawHandiCam(out: FilterPrimitive[], o: HandiCamOverlay, vp: FilterViewport, timecode: number): void {
  const bottom = x87Add(vp.h, vp.y);
  const left = x87Fistp(vp.x);
  const right = x87Fistp(x87Add(vp.w, vp.x));
  const rgba = scanLineColour(o.colour);
  for (let y = f32(vp.y); x87Add(y, FILTER_CONST.linePitch) <= bottom; y = f32(x87Add(y, FILTER_CONST.linePitch))) {
    const row = x87Fistp(y);
    hline(out, left, right, row, rgba);
    hline(out, left, right, row + 1, rgba);
  }
  // Corner brackets: per corner two passes i = 0, 1 (2 px), arms of 50 px pointing inwards.
  const white: [number, number, number, number] = [255, 255, 255, 255];
  // float32 tables written at 0x49b8bb: x 0.1 / 0.9, y 0.2 / 0.8, arm directions +-1.
  const fx = [Math.fround(0.1), Math.fround(0.9), Math.fround(0.1), Math.fround(0.9)];
  const fy = [Math.fround(0.2), Math.fround(0.2), Math.fround(0.8), Math.fround(0.8)];
  const sx = [1, -1, 1, -1];
  const sy = [1, 1, -1, -1];
  for (let c = 0; c < 4; c++) {
    const arm = FILTER_CONST.bracketArm;
    for (let i = 0; i < 2; i++) {
      const cx = x87Fistp(x87Add(x87Mul(vp.w, fx[c]), vp.x));
      const cy = x87Fistp(x87Add(x87Mul(vp.h, fy[c]), vp.y));
      axisLine(out, cx, cy + i * sy[c], cx + sx[c] * arm, cy + i * sy[c], white);
      axisLine(out, cx + i * sx[c], cy, cx + i * sx[c], cy + sy[c] * arm, white);
    }
  }
  const t = FILTER_CONST.timecodeText;
  out.push({
    kind: "text", text: timecodeText(timecode),
    // fld w; fmul 0.9; fadd x; fisub 117 (0x49bceb), likewise y - 20.
    x: f32(x87Sub(x87Add(x87Mul(vp.w, t.fx), vp.x), t.dx)), y: f32(x87Sub(x87Add(x87Mul(vp.h, t.fy), vp.y), t.dy)),
    colourByte: FILTER_CONST.textColourByte,
  });
  out.push({ kind: "battery", quad: batteryQuad(vp), alpha: o.blink >= FILTER_CONST.blinkOn ? 255 : 0 });
}

/**
 * FUN_0049bc10 battery quad for a 64 x 32 sprite (height / width from
 * FUN_004acf70 / FUN_004acf50): vertices (x0, y1) (x1, y1) (x0, y0) (x1, y0)
 * with uv (0,0) (1,0) (0,1) (1,1), so the picture is drawn upside down.
 */
export function batteryQuad(vp: FilterViewport, spriteWidth = 64, spriteHeight = 32): [number, number, number, number, number, number, number, number] {
  const b = FILTER_CONST.battery;
  const w = f32(x87Mul(vp.w, b.fw));
  const x0 = f32(x87Add(x87Add(x87Mul(vp.w, b.fx), b.dx), vp.x));
  const y0 = f32(x87Add(x87Add(x87Mul(vp.h, b.fy), b.dy), vp.y));
  const y1 = f32(x87Add(y0, x87Mul(x87Div(spriteHeight, spriteWidth), w)));
  const x1 = f32(x87Add(x0, w));
  return [x0, y1, x1, y1, x0, y0, x1, y0];
}
