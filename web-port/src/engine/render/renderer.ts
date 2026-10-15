/**
 * Three.js renderer, scene and world camera, set up like igi.exe's display.
 *
 * Recovered (docs/rendering.md, loaders/render-params.ts):
 *   - The projection is hard-wired to 4:3 (tanY = 0.75 tanX, FUN_00495fe0) with
 *     a 90 degree horizontal FOV (tan(pi/4)), near 0.1 m and far 100 km for the
 *     world layer. The configured display is 640x480 (config.qvm GOGfxDisp), so
 *     the port draws a 4:3 frame centred in the window (black bars outside it)
 *     instead of widening or stretching the view.
 *   - All blending and lighting happened on 8-bit gamma-space values (D3D7
 *     fixed function), so colour management is off: textures, vertex colours
 *     and fog colours are used as stored and written to the screen unchanged.
 *   - No anti-aliasing (the original renders without multisampling).
 *
 * Resolution: the frame is drawn at the profile's display mode (GOGfxDisp /
 * the Graphics menu's Resolution, shipped 640x480) and scaled to the window,
 * as the original's fullscreen mode is scaled by the monitor. `?res=native`
 * draws at the window's resolution instead (port option); `?res=original`
 * forces 640x480 with blocky pixels.
 *
 * The world spans 100 km, so a logarithmic depth buffer keeps it free of
 * z-fighting (the original used a 16/24-bit hardware z-buffer with ZBIAS).
 */
import * as THREE from "three";
import { CAMERA, DEPTH_LAYERS, verticalFovDeg } from "../../loaders";

/** The 4:3 game frame inside the canvas, in CSS pixels from the canvas' top-left. */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RendererBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Current 4:3 frame (updated by resize()). */
  readonly frame: FrameRect;
  /** Clear the whole canvas (bars) and restrict drawing to the frame. Call once per frame before rendering. */
  beginFrame(): void;
  /**
   * Cut-scene letterbox (WideScreenFilter, docs/mission.md): black bars at the
   * top and bottom of the frame, each `fraction` of the frame height.
   */
  letterbox(fraction: number): void;
  resize(): void;
  /** The display mode the frame is rendered at (Graphics > Resolution), or null for the window's resolution. */
  setRenderResolution(size: { width: number; height: number } | null): void;
  dispose(): void;
}

/** The original display mode (config.qvm GOGfxDisp(640, 480, 32)) [observed]. */
export const ORIGINAL_WIDTH = 640;
export const ORIGINAL_HEIGHT = 480;
const ASPECT = 4 / 3;

export function createRenderer(canvas: HTMLCanvasElement): RendererBundle {
  THREE.ColorManagement.enabled = false;
  const params = new URLSearchParams(location.search);
  const originalResolution = params.get("res") === "original";
  const nativeResolution = params.get("res") === "native";
  /** The profile's display mode (null = the window's resolution). */
  let renderSize: { width: number; height: number } | null = nativeResolution ? null : { width: ORIGINAL_WIDTH, height: ORIGINAL_HEIGHT };
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
    logarithmicDepthBuffer: true,
    preserveDrawingBuffer: params.has("shot"),
  });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // no output transform
  renderer.shadowMap.enabled = false;
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const world = DEPTH_LAYERS.world;
  const camera = new THREE.PerspectiveCamera(verticalFovDeg(CAMERA.worldTanHalfFovX), ASPECT, world.nearM, world.farM);

  const frame: FrameRect = { x: 0, y: 0, width: ORIGINAL_WIDTH, height: ORIGINAL_HEIGHT };
  /** Frame in drawing-buffer pixels (origin bottom-left, as WebGL expects). */
  const bufferFrame = { x: 0, y: 0, width: ORIGINAL_WIDTH, height: ORIGINAL_HEIGHT };

  const resize = () => {
    const cssWidth = canvas.clientWidth || window.innerWidth;
    const cssHeight = canvas.clientHeight || window.innerHeight;
    // Largest 4:3 rectangle centred in the canvas.
    const width = Math.min(cssWidth, Math.floor(cssHeight * ASPECT));
    const height = Math.min(cssHeight, Math.floor(width / ASPECT));
    frame.x = Math.floor((cssWidth - width) / 2);
    frame.y = Math.floor((cssHeight - height) / 2);
    frame.width = width;
    frame.height = height;
    if (originalResolution || renderSize) {
      // The display mode's pixels for the frame, upscaled by CSS (blocky only for ?res=original).
      const modeWidth = originalResolution ? ORIGINAL_WIDTH : renderSize!.width;
      const scale = modeWidth / Math.max(width, 1);
      renderer.setPixelRatio(1);
      renderer.setSize(Math.round(cssWidth * scale), Math.round(cssHeight * scale), false);
      canvas.style.imageRendering = originalResolution ? "pixelated" : "";
    } else {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(cssWidth, cssHeight, false);
      canvas.style.imageRendering = "";
    }
    const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
    const sx = buffer.x / Math.max(cssWidth, 1);
    const sy = buffer.y / Math.max(cssHeight, 1);
    bufferFrame.x = Math.round(frame.x * sx);
    bufferFrame.width = Math.round(frame.width * sx);
    bufferFrame.height = Math.round(frame.height * sy);
    bufferFrame.y = buffer.y - Math.round(frame.y * sy) - bufferFrame.height;
    // setViewport/setScissor take CSS pixels (multiplied by the pixel ratio).
    const ratio = renderer.getPixelRatio();
    renderer.setViewport(bufferFrame.x / ratio, bufferFrame.y / ratio, bufferFrame.width / ratio, bufferFrame.height / ratio);
    renderer.setScissor(bufferFrame.x / ratio, bufferFrame.y / ratio, bufferFrame.width / ratio, bufferFrame.height / ratio);
    camera.aspect = ASPECT;
    camera.updateProjectionMatrix();
  };
  resize();

  const black = new THREE.Color(0x000000);
  return {
    renderer,
    scene,
    camera,
    frame,
    beginFrame() {
      // Bars outside the frame stay black; everything else draws inside it.
      renderer.setScissorTest(false);
      renderer.setClearColor(black, 1);
      renderer.clear(true, true, true);
      renderer.setScissorTest(true);
    },
    letterbox(fraction: number) {
      if (fraction <= 0) return;
      const ratio = renderer.getPixelRatio();
      const bar = Math.round(bufferFrame.height * Math.min(0.5, fraction));
      renderer.setClearColor(black, 1);
      for (const y of [bufferFrame.y, bufferFrame.y + bufferFrame.height - bar]) {
        renderer.setScissor(bufferFrame.x / ratio, y / ratio, bufferFrame.width / ratio, bar / ratio);
        renderer.clear(true, false, false);
      }
      renderer.setScissor(bufferFrame.x / ratio, bufferFrame.y / ratio, bufferFrame.width / ratio, bufferFrame.height / ratio);
    },
    resize,
    setRenderResolution(size) {
      if (nativeResolution) return;
      const next = size && size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null;
      if (next?.width === renderSize?.width && next?.height === renderSize?.height) return;
      renderSize = next;
      resize();
    },
    dispose() {
      renderer.dispose();
    },
  };
}
