/**
 * Dev-only audio harness (dev/audio.html): loads the original sounds from
 * /raw/ (worker and inline decoders, with a main-thread stall probe), renders
 * representative scenarios through the real WebAudio backend into an
 * OfflineAudioContext at 22050 Hz (ticks driven by context.suspend at 30 Hz)
 * and reports levels, voice counts and timing in window.__audioHarness.
 */
import type { Vec3 } from "../src/contracts";
import {
  computeVoice,
  createHttpAssetSource,
  flattenTasks,
  igiPointToEngine,
  readQvmCallTree,
  readTaskTree,
  type IgiTask,
  type LevelWeapon,
} from "../src/loaders";
import { EventBus, GameEvent } from "../src/engine/events";
import { loadIgiAudio, type IgiAudioData } from "../src/engine/audio/igi-audio";
import { createIgiAudio, type IgiAudioSystem } from "../src/engine/audio/igi-audio-system";
import type { AudioHostContext } from "../src/engine/audio/sound-events";
import type { AudioListener } from "../src/engine/audio/mixer";
import type { TaskRuntimeApi } from "../src/engine/context";

declare global {
  interface Window {
    __audioHarness?: { done: boolean; error?: string; results: Record<string, unknown> };
  }
}

const out = document.getElementById("out")!;
const results: Record<string, unknown> = {};
window.__audioHarness = { done: false, results };
const log = (line: string) => {
  out.textContent = (out.textContent === "running…" ? "" : out.textContent) + line + "\n";
};

const RATE = 22050;
const BASE_IGI: Vec3 = [24532436, -56171048, 174413120];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const listenerAt = (p: Vec3, right: Vec3 = [1, 0, 0]): AudioListener => ({
  position: p,
  right,
  forward: [0, 0, -1],
  up: [0, 1, 0],
});

/** Main-thread stall probe: largest gap between 4 ms timers while `work` runs (stalls > 30 ms listed with the last progress text). */
async function probeStalls<T>(
  work: (mark: (text: string) => void) => Promise<T>,
): Promise<{ value: T; maxStallMs: number; ms: number; stalls: string[] }> {
  const t0 = performance.now();
  let last = t0;
  let maxStall = 0;
  let running = true;
  let phase = "start";
  const stalls: string[] = [];
  const loop = () => {
    const t = performance.now();
    const gap = t - last;
    maxStall = Math.max(maxStall, gap);
    if (gap > 30) stalls.push(`${Math.round(t - t0)} ms: ${Math.round(gap)} ms after "${phase}"`);
    last = t;
    if (running) setTimeout(loop, 4);
  };
  setTimeout(loop, 4);
  const value = await work((text) => (phase = text));
  const ms = performance.now() - t0;
  running = false;
  return { value, maxStallMs: maxStall, ms, stalls };
}

function weaponsFrom(buffer: ArrayBuffer): Map<string, LevelWeapon> {
  const map = new Map<string, LevelWeapon>();
  for (const t of flattenTasks(readTaskTree(readQvmCallTree(buffer)))) {
    const id = t.params["Script ID"];
    if (typeof id !== "string") continue;
    const s = (k: string) => (typeof t.params[k] === "string" ? (t.params[k] as string) : null);
    const n = (k: string) => (typeof t.params[k] === "number" ? (t.params[k] as number) : 0);
    map.set(id, {
      scriptId: id,
      name: id,
      fireSound: s("Fire Sound Loop/Single Sample"),
      fireSoundEnd: s("Fire Sound Loop End Sample"),
      maxRoundsPerBurst: n("Maximum Rounds/Burst"),
      roundsPerMinute: n("Rounds/Minute"),
    } as unknown as LevelWeapon);
  }
  return map;
}

interface Env {
  data: IgiAudioData;
  weapons: Map<string, LevelWeapon>;
  tasks: IgiTask[];
}

function host(env: Env, opts: { tasks?: IgiTask[]; runtime?: TaskRuntimeApi | null } = {}): AudioHostContext {
  return {
    events: new EventBus(),
    player: { position: [0, 0, 0], maxHealth: 100 },
    enemies: [{ id: 7, position: [15, 0, -10], weapon: env.weapons.get("WEAPON_ID_AK47") ?? null }],
    weapon: { spec: env.weapons.get("WEAPON_ID_MP5SD")! },
    level: { weapons: env.weapons, tasks: opts.tasks ?? [], originIgi: BASE_IGI },
    systems: { tasks: opts.runtime ?? null },
  };
}

interface Scenario {
  name: string;
  seconds: number;
  tasks?: IgiTask[];
  runtime?: TaskRuntimeApi | null;
  listener?: AudioListener;
  setup?(sys: IgiAudioSystem, h: AudioHostContext): void;
  /** Called before the audio tick; may return a listener for this tick. */
  perTick?(tick: number, sys: IgiAudioSystem, h: AudioHostContext): AudioListener | void;
}

const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const peakOf = (a: Float32Array) => {
  let p = 0;
  for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
};
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

async function render(env: Env, sc: Scenario) {
  const frames = Math.ceil(sc.seconds * RATE);
  const ac = new OfflineAudioContext(2, frames, RATE);
  const h = host(env, { tasks: sc.tasks, runtime: sc.runtime });
  const sys = createIgiAudio(h, { context: ac, alwaysReady: true, random: mulberry32(1234) });
  sys.setData(env.data);
  sc.setup?.(sys, h);
  const ticks = Math.floor(sc.seconds * 30);
  const voices: number[] = [];
  const names = new Set<string>();
  let listener = sc.listener ?? listenerAt([0, 1.7, 0]);
  for (let k = 0; k < ticks; k++) {
    void ac.suspend(k / 30).then(() => {
      const l = sc.perTick?.(k, sys, h);
      if (l) listener = l;
      sys.tick(listener);
      voices.push(sys.mixer.voiceCount);
      for (const i of sys.mixer.liveInstances) if (i.voice) names.add(i.name);
      void ac.resume();
    });
  }
  const t0 = performance.now();
  const buffer = await ac.startRendering();
  const renderMs = performance.now() - t0;
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const win = Math.floor(RATE / 2);
  const windows: Array<[number, number]> = [];
  for (let i = 0; i + win <= frames; i += win) windows.push([r4(rms(L, i, i + win)), r4(rms(R, i, i + win))]);
  const stats = sys.stats;
  sys.dispose();
  return {
    name: sc.name,
    seconds: sc.seconds,
    renderMs: Math.round(renderMs),
    rmsL: r4(rms(L)),
    rmsR: r4(rms(R)),
    peak: r4(Math.max(peakOf(L), peakOf(R))),
    windowsHalfSecond: windows,
    maxVoices: Math.max(0, ...voices),
    started: stats.started,
    dropped: stats.dropped,
    playedNames: [...names].sort(),
  };
}

async function main(): Promise<void> {
  const raw = createHttpAssetSource("/raw/");

  // ---- decode timing: worker first, then inline for comparison.
  const worker = await probeStalls((mark) => loadIgiAudio(raw, { decoder: "auto", onProgress: (_f, text) => mark(text) }));
  const data = worker.value;
  results.load = {
    decoder: data.stats.decoder,
    files: data.stats.files,
    megabytes: r4(data.stats.bytes / 1e6),
    megasamples: r4(data.stats.samples / 1e6),
    fetchMs: Math.round(data.stats.fetchMs),
    decodeMs: Math.round(data.stats.decodeMs),
    totalMs: Math.round(worker.ms),
    maxMainThreadStallMs: Math.round(worker.maxStallMs),
    stalls: worker.stalls,
    levelSamples: data.samples.size,
    menuSamples: data.menuSamples.size,
    definitions: data.bank.entries.length,
    volumes: data.volumes,
    warnings: data.warnings,
  };
  log(`load (${data.stats.decoder}): ${JSON.stringify(results.load)}`);
  const inline = await probeStalls((mark) => loadIgiAudio(raw, { decoder: "inline", onProgress: (_f, text) => mark(text) }));
  results.loadInline = {
    decodeMs: Math.round(inline.value.stats.decodeMs),
    maxBlockMs: Math.round(inline.value.stats.maxBlockMs),
    totalMs: Math.round(inline.ms),
    maxMainThreadStallMs: Math.round(inline.maxStallMs),
    stalls: inline.stalls,
  };
  log(`load (inline): ${JSON.stringify(results.loadInline)}`);

  // ---- live context: does the browser give us 22050 Hz?
  try {
    const live = new AudioContext({ sampleRate: RATE });
    results.liveContext = { sampleRate: live.sampleRate, state: live.state, baseLatency: live.baseLatency };
    await live.close();
  } catch (error) {
    results.liveContext = { error: (error as Error).message };
  }
  log(`live context: ${JSON.stringify(results.liveContext)}`);

  const [weaponBuf, objectsBuf] = await Promise.all([
    raw.readBinary("weapons/weaponconfig.qvm"),
    raw.readBinary("missions/location0/level1/objects.qvm"),
  ]);
  const env: Env = {
    data,
    weapons: weaponsFrom(weaponBuf),
    tasks: flattenTasks(readTaskTree(readQvmCallTree(objectsBuf))),
  };
  const base = listenerAt([0, 2, 0]);

  const scenarios: Scenario[] = [
    { name: "ambience-at-base", seconds: 8, tasks: env.tasks, listener: base },
    {
      name: "mp5sd-burst-then-release",
      seconds: 2,
      perTick(k, _s, h) {
        if (k < 30 && k % 3 === 0) h.events.emit(GameEvent.Fire, { weaponId: "WEAPON_ID_MP5SD", shooter: "player", position: [0.2, 1.5, -0.4] });
        if (k === 30) h.events.emit(GameEvent.FireStopped, { weaponId: "WEAPON_ID_MP5SD", shooter: "player", position: [0.2, 1.5, -0.4] });
      },
    },
    {
      name: "glock-single-shots",
      seconds: 1.5,
      perTick(k, _s, h) {
        if (k % 10 === 0 && k < 40) h.events.emit(GameEvent.Fire, { weaponId: "WEAPON_ID_GLOCK", shooter: "player", position: [0.2, 1.5, -0.4] });
      },
    },
    {
      name: "pan-20m-right-then-left",
      seconds: 2,
      setup(sys) {
        sys.playAt("mp5sd_loop", [20, 1.7, 0]);
      },
      perTick(k) {
        return k < 30 ? listenerAt([0, 1.7, 0], [1, 0, 0]) : listenerAt([0, 1.7, 0], [-1, 0, 0]);
      },
    },
    {
      name: "voice-cap-40-requests",
      seconds: 0.5,
      perTick(k, sys) {
        if (k === 0) for (let i = 0; i < 40; i++) sys.playAt("glock_shot_1", [1, 1.7, 0]);
      },
    },
    {
      name: "events-mix",
      seconds: 4,
      perTick(k, sys, h) {
        if (k % 10 === 0) h.events.emit(GameEvent.Footstep, { actor: "player", position: [0, 0, 0], material: "Gravel", quiet: false });
        if (k < 30) h.events.emit(GameEvent.Impact, { point: [5, 0, -5], normal: [0, 1, 0], material: "Concrete", shooter: 7 });
        if (k % 40 === 5) h.events.emit(GameEvent.Detected, { enemyId: 7, position: [15, 0, -10] });
        if (k % 20 === 3) h.events.emit(GameEvent.PlayerHit, { amount: 5 });
        if (k === 60) h.events.emit(GameEvent.StatusMessage, { text: "x", sprite: null, sound: "message", durationSeconds: 2, cutscene: false });
        if (k === 90) h.events.emit(GameEvent.Pickup, { kind: "weapon", name: "AK47" });
        if (k === 100) h.events.emit(GameEvent.EnemyKilled, { enemyId: 7, taskId: 1 });
        void sys;
      },
    },
    {
      name: "intro-voice-over",
      seconds: 5,
      tasks: env.tasks,
      runtime: {
        member: () => undefined,
        condition: (expr: string) => (expr === "1" || expr.startsWith("!CutScene_1203.isFinished") ? 1 : 0),
      },
    },
    {
      name: "menu-high",
      seconds: 0.5,
      setup(sys) {
        sys.playMenu("menu_high");
      },
    },
  ];

  const rendered: Record<string, unknown> = {};
  for (const sc of scenarios) {
    const r = await render(env, sc);
    rendered[sc.name] = r;
    log(`${sc.name}: ${JSON.stringify(r)}`);
  }
  results.scenarios = rendered;

  // ---- reference values for the checks.
  const pan = computeVoice({ volume: 1, sampleRate: RATE, positional: true, source: [20 * 4096, 1.7 * 4096, 0], listener: [0, 1.7 * 4096, 0], listenerRight: [1, 0, 0], minDistance: 0, maxDistance: 65 });
  const vo = data.samples.get("_CUT01_01")!;
  const voRms = rms(vo.data[0], 0, Math.min(vo.frames, Math.floor((5 - 1 / 30) * RATE)));
  const menu = data.menuSamples.get("MENU_HIGH")!;
  results.expected = {
    panGainLeft: r4(pan.gainLeft),
    panGainRight: r4(pan.gainRight),
    panRatioRightOverLeft: r4(pan.gainRight / pan.gainLeft),
    voiceOverSampleRms: r4(voRms),
    menuHighSampleRms: r4(rms(menu.data[0])),
    originEngineCheck: igiPointToEngine(BASE_IGI, BASE_IGI),
  };
  log(`expected: ${JSON.stringify(results.expected)}`);

  // ---- live buttons (manual listening).
  const liveDiv = document.getElementById("live")!;
  let liveSys: IgiAudioSystem | null = null;
  let liveHost: AudioHostContext | null = null;
  const ensureLive = () => {
    if (!liveSys) {
      liveHost = host(env, { tasks: env.tasks });
      liveSys = createIgiAudio(liveHost);
      liveSys.setData(data);
      setInterval(() => liveSys!.tick(base), 1000 / 30);
    }
    liveSys.resume();
    return { sys: liveSys, h: liveHost! };
  };
  const button = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = fn;
    liveDiv.appendChild(b);
  };
  button("Start ambience + music", () => ensureLive());
  button("MP5SD burst", () => {
    const { h } = ensureLive();
    let n = 0;
    const id = setInterval(() => {
      h.events.emit(GameEvent.Fire, { weaponId: "WEAPON_ID_MP5SD", shooter: "player", position: [0.2, 1.5, -0.4] });
      if (++n === 12) {
        clearInterval(id);
        h.events.emit(GameEvent.FireStopped, { weaponId: "WEAPON_ID_MP5SD", shooter: "player", position: [0.2, 1.5, -0.4] });
      }
    }, 86);
  });
  button("Menu high", () => ensureLive().sys.playMenu("menu_high"));
  button("Status message", () => ensureLive().sys.play2D("message"));
}

main()
  .then(() => {
    window.__audioHarness!.done = true;
    log("done");
  })
  .catch((error: Error) => {
    window.__audioHarness!.error = `${error.message}\n${error.stack ?? ""}`;
    window.__audioHarness!.done = true;
    log(`ERROR ${error.message}`);
  });
