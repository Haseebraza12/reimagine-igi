/**
 * The player-profile configuration behind the menu scripts' Config_* calls
 * (igi.exe FUN_00402ab0 registers them; profile array at 0xb680c8, 0x564
 * bytes each, active index DAT_00b680c4, count DAT_00b680c0). Pure; no DOM.
 * Evidence: docs/hud.md section 12.
 *
 * Recovered semantics (addresses = the script function handlers):
 *   Config_GameOptionsInputGetInvertMouse 403c90  = (profile+0x538 == 0)  (!)
 *   Config_GameOptionsInputSetInvertMouse 403c20  profile+0x538 = (v == 0)
 *     config.qvm GOInMouInv(v) stores v into +0x538 directly (403330), so the
 *     shipped GOInMouInv(1) shows "Invert Mouse: No".
 *   Get/SetMouseSensitivity 403d50 / 403cf0: float +0x53c (GOInMouSens 0.4), slider 0..1.
 *   Get/SetBloodEnabled 403e00 / 403da0: byte +0x8 (GOIsBlood).
 *   Get/SetSoundsEffectsVolume 404600 / 4045a0: float +0x224 (GOSoundFX volume).
 *   Get/SetMusicVolume 404760 / 404700: float +0x228 (GOSoundMusic volume).
 *   Game_UpdateVolume 414bf0: FUN_00494150(music) -> Windows mixer (mixerSetControlDetails),
 *     FUN_00494210(fx) -> DAT_005417ec, the DirectSound master scale (audio.md).
 *   Get/SetGamma 4043d0 / 404370: float graphics+0x214 (GOGfxGamma).
 *   Get/SetPerformanceFlags 404a20 / 4049c0: graphics+0xc; NumPerfLevels 4050e0 = 7;
 *     GetPerfFlagsFromLevel 405080 = table 0x535bd4 {0, 0x41, 0x4d, 0xd, 0x60, 0xae, 0x9e};
 *     GetPerfLevelFromFlags 404ff0 = first table entry with the fewest differing bits.
 *   FillScreenResolutionListBox 403f10: "%dx%dx%d" (w, h, bpp), id = (bpp<<13|w)<<13|h;
 *   GetResolution 404070: the closest mode (|dw|*|dh| + |dbpp| * 0x1000000); SetResolution 403fd0.
 *   Profiles: Fill 404a60 (names), Get/SetActive 404ad0 / 404b10, Create 404b60 (at most 16,
 *     the name trimmed of trailing blanks, empty or duplicate (strcmpi) rejected, copies the
 *     active profile, then name / difficulty / active mission), Delete 404ec0,
 *     PlayerGetActiveMission 405290, GetNumberOfPlayerProfiles 404fb0.
 *   ControlsMenu_ConvertFloatFromOffset 422850 = off / (27 - 10);
 *   ControlsMenu_ConvertOffsetFromFloat 4228b0 = fistp(17 v + 0.5).
 */
import { isQvmSymbol, readQvmCallTree, x87Fistp } from "../../loaders";

/** The 27 actions of the controls table at 0x5345b8 (row order of the ControlsMenu). */
export const CONTROL_ACTIONS: readonly string[] = [
  "MoveLeft", "MoveRight", "MoveUp", "MoveDown", "Fire", "AlternateFire", "Reload", "Activate", "Crouch", "Jump",
  "NextWeapon", "PrevWeapon", "Peek", "Binoculars", "MapComputer", "ToggleWalkRun", "ZoomIn", "ZoomOut",
  "WeaponCategory1", "WeaponCategory2", "WeaponCategory3", "WeaponCategory4", "WeaponCategory5",
  "WeaponCategory6", "WeaponCategory7", "WeaponCategory8", "WeaponCategory9",
];

/** Default bindings (DAT_00534470, "Reset to Default"): identical to the shipped config.qvm GOInRemap list. */
export const DEFAULT_BINDINGS: Readonly<Record<string, string>> = {
  MoveLeft: "KEY_LEFT", MoveRight: "KEY_RIGHT", MoveUp: "KEY_UP", MoveDown: "KEY_DOWN", Fire: "MOUSE_BUTTON_1",
  AlternateFire: "KEY_BACKSPACE", Reload: "KEY_RETURN", Activate: "KEY_RIGHT_SHIFT", Crouch: "KEY_RIGHT_CTRL",
  Jump: "KEY_NUMPAD0", NextWeapon: "MOUSE_BUTTON_2", PrevWeapon: "KEY_O", Peek: "KEY_NUMPAD1", Binoculars: "KEY_SPACE",
  MapComputer: "KEY_C", ToggleWalkRun: "KEY_W", ZoomIn: "KEY_PAGEUP", ZoomOut: "KEY_PAGEDOWN",
  WeaponCategory1: "KEY_1", WeaponCategory2: "KEY_2", WeaponCategory3: "KEY_3", WeaponCategory4: "KEY_4",
  WeaponCategory5: "KEY_5", WeaponCategory6: "KEY_6", WeaponCategory7: "KEY_7", WeaponCategory8: "KEY_8",
  WeaponCategory9: "KEY_9",
};

/** The 127 bindable keys and buttons of the table at 0x5349f8 (index order; the ControlsMenu scans them in this order). */
export const CONTROL_KEYS: readonly string[] = [
  "KEY_ANGLE", "KEY_ESC", "KEY_A", "KEY_B", "KEY_C", "KEY_D", "KEY_E", "KEY_F", "KEY_G", "KEY_H", "KEY_I", "KEY_J", "KEY_K",
  "KEY_L", "KEY_M", "KEY_N", "KEY_O", "KEY_P", "KEY_Q", "KEY_R", "KEY_S", "KEY_T", "KEY_U", "KEY_V", "KEY_W", "KEY_X",
  "KEY_Y", "KEY_Z", "KEY_0", "KEY_1", "KEY_2", "KEY_3", "KEY_4", "KEY_5", "KEY_6", "KEY_7", "KEY_8", "KEY_9",
  "KEY_SEPARATOR", "KEY_DECIMAL", "KEY_COMMA", "KEY_COLON", "KEY_SLASH", "KEY_CAPITAL", "KEY_BACKSLASH",
  "KEY_BACKSPACE", "KEY_UNDERLINE", "KEY_CAPSLOCK", "KEY_NUMLOCK", "KEY_SCROLL", "KEY_TAB", "KEY_RETURN",
  "KEY_LEFT_SHIFT", "KEY_RIGHT_SHIFT", "KEY_LEFT_CTRL", "KEY_RIGHT_CTRL", "KEY_LEFT_ALT", "KEY_RIGHT_ALT",
  "KEY_DIVIDE", "KEY_MULTIPLY", "KEY_SUBTRACT", "KEY_ADD", "KEY_MINUS", "KEY_EQUALS", "KEY_LEFT_BRACKET",
  "KEY_RIGHT_BRACKET", "KEY_SEMICOLON", "KEY_APOSTROPHE", "KEY_GRAVE", "KEY_LEFT_MENU", "KEY_RIGHT_MENU",
  "KEY_LEFT_WIN", "KEY_RIGHT_WIN", "KEY_SPACE", "KEY_END", "KEY_HOME", "KEY_LEFT", "KEY_UP", "KEY_RIGHT", "KEY_DOWN",
  "KEY_INSERT", "KEY_DELETE", "KEY_PAGEUP", "KEY_PAGEDOWN", "KEY_F1", "KEY_F2", "KEY_F3", "KEY_F4", "KEY_F5", "KEY_F6",
  "KEY_F7", "KEY_F8", "KEY_F9", "KEY_F10", "KEY_F11", "KEY_F12", "KEY_F13", "KEY_F14", "KEY_F15", "KEY_NUMPAD0",
  "KEY_NUMPAD1", "KEY_NUMPAD2", "KEY_NUMPAD3", "KEY_NUMPAD4", "KEY_NUMPAD5", "KEY_NUMPAD6", "KEY_NUMPAD7",
  "KEY_NUMPAD8", "KEY_NUMPAD9", "KEY_NUMPADENTER", "KEY_NUMPADCOMMA", "KEY_NUMPADEQUALS", "KEY_NUMPADSTAR",
  "KEY_NUMPADMINUS", "KEY_NUMPADPLUS", "KEY_NUMPADPERIOD", "KEY_NUMPADSLASH", "MOUSE_BUTTON_1", "MOUSE_BUTTON_2",
  "MOUSE_BUTTON_3", "MOUSE_BUTTON_4", "MOUSE_BUTTON_5", "MOUSE_BUTTON_6", "MOUSE_BUTTON_7", "MOUSE_BUTTON_8",
  "MOUSE_WHEEL_UP", "MOUSE_WHEEL_DOWN",
];

/** Performance flag table 0x535bd4 (7 levels). */
export const PERF_FLAG_TABLE: readonly number[] = [0x0, 0x41, 0x4d, 0xd, 0x60, 0xae, 0x9e];

export interface MenuProfile {
  name: string;
  /** GOGameDiff: 0 easy, 1 medium, 2 hard (GD_1..GD_3). */
  difficulty: number;
  /** Highest mission the profile may play (+0x560 / GOActiveMission). */
  activeMission: number;
  /** +0x538 as stored (config.qvm GOInMouInv); the menu shows "Invert Mouse: Yes" when it is 0. */
  invertField: number;
  /** GOInMouSens, 0..1 on the slider. */
  mouseSensitivity: number;
  bloodEnabled: boolean;
  fxVolume: number;
  musicVolume: number;
  gamma: number;
  performanceFlags: number;
  resolution: { w: number; h: number; bpp: number };
  device: number;
  /** Action -> KEY_* / MOUSE_* name. */
  bindings: Record<string, string>;
}

export interface MenuSettingsSnapshot {
  profileName: string;
  difficulty: number;
  activeMission: number;
  /** "Invert Mouse" as the menu shows it (Config_GameOptionsInputGetInvertMouse). */
  invertMouse: boolean;
  /** The raw GOInMouInv field (+0x538); the map computer pointer negates the vertical channel when it is non-zero. */
  invertField: number;
  mouseSensitivity: number;
  bloodEnabled: boolean;
  fxVolume: number;
  musicVolume: number;
  gamma: number;
  performanceFlags: number;
  bindings: Array<{ action: string; device: "INPUTPORT_DEVICE_KEYBOARD" | "INPUTPORT_DEVICE_MOUSE"; key: string }>;
}

export type SettingsChange = "volume" | "controls" | "graphics" | "profile" | "content";

/** The screen modes the port offers in "Resolution" (the exe lists the display adapter's modes; inferred list). */
export const PORT_RESOLUTIONS: ReadonlyArray<readonly [number, number, number]> = [
  [640, 480, 16], [640, 480, 32], [800, 600, 16], [800, 600, 32], [1024, 768, 16], [1024, 768, 32],
];

function newProfile(): MenuProfile {
  return {
    name: "Joe",
    difficulty: 1,
    activeMission: 1,
    invertField: 1,
    mouseSensitivity: 0.4000000059604645,
    bloodEnabled: true,
    fxVolume: 1,
    musicVolume: 1,
    gamma: 1,
    performanceFlags: 0,
    resolution: { w: 640, h: 480, bpp: 32 },
    device: 0,
    bindings: { ...DEFAULT_BINDINGS },
  };
}

function cloneProfile(p: MenuProfile): MenuProfile {
  return { ...p, resolution: { ...p.resolution }, bindings: { ...p.bindings } };
}

const bitCount = (v: number): number => {
  let n = 0;
  for (let i = 0; i < 32; i++) n += (v >>> i) & 1;
  return n;
};

export class MenuConfig {
  profiles: MenuProfile[] = [newProfile()];
  active = 0;
  contentPassword = "";
  /** Called after a change that matters to the game (wire to input / audio / storage). */
  onChange: ((what: SettingsChange, config: MenuConfig) => void) | null = null;

  get profile(): MenuProfile {
    return this.profiles[this.active] ?? this.profiles[0];
  }

  /**
   * Read the GO* calls of config.qvm (the shipped defaults: one profile "Joe",
   * GOInMouInv(1), GOInMouSens(0.4), GOGfxGamma(1), GOGameDiff(GD_2), sounds 1.0, ...).
   * Every GOPlayer starts a new profile (the loader writes into profile[count]).
   */
  loadConfigQvm(buffer: ArrayBuffer): void {
    const calls = readQvmCallTree(buffer);
    const profiles: MenuProfile[] = [];
    let p: MenuProfile | null = null;
    const cur = () => (p ??= newProfile());
    const n = (v: unknown, d: number) => (typeof v === "number" ? v : d);
    for (const c of calls) {
      const a = c.args;
      switch (c.fn) {
        case "GOStart":
          this.active = n(a[0], 0);
          break;
        case "GOContentControlPW":
          this.contentPassword = typeof a[0] === "string" ? a[0] : "";
          break;
        case "GOPlayer":
          p = newProfile();
          p.name = typeof a[0] === "string" ? a[0] : "Player";
          profiles.push(p);
          break;
        case "GOActiveMission":
          cur().activeMission = n(a[0], 1);
          break;
        case "GOInMouInv":
          cur().invertField = n(a[0], 1);
          break;
        case "GOInMouSens":
          cur().mouseSensitivity = n(a[0], 0.4);
          break;
        case "GOInRemap": {
          const action = isQvmSymbol(a[0]) ? a[0].symbol : String(a[0]);
          const key = isQvmSymbol(a[2]) ? a[2].symbol : String(a[2]);
          if (CONTROL_ACTIONS.includes(action)) cur().bindings[action] = key;
          break;
        }
        case "GOGfxDisp":
          cur().resolution = { w: n(a[0], 640), h: n(a[1], 480), bpp: n(a[2], 32) };
          break;
        case "GOGfxGamma":
          cur().gamma = n(a[0], 1);
          break;
        case "GOGfxPerformance":
          cur().performanceFlags = n(a[0], 0);
          break;
        case "GOGameDiff": {
          const s = isQvmSymbol(a[0]) ? a[0].symbol : "";
          const m = /^GD_(\d)$/.exec(s);
          cur().difficulty = m ? Number(m[1]) - 1 : n(a[0], 1);
          break;
        }
        case "GOIsBlood":
          cur().bloodEnabled = isQvmSymbol(a[0]) ? a[0].symbol === "TRUE" : n(a[0], 1) !== 0;
          break;
        case "GOSoundFX":
          cur().fxVolume = n(a[1], 1);
          break;
        case "GOSoundMusic":
          cur().musicVolume = n(a[1], 1);
          break;
        default:
          break;
      }
    }
    if (profiles.length) this.profiles = profiles;
    if (this.active < 0 || this.active >= this.profiles.length) this.active = 0;
  }

  snapshot(): MenuSettingsSnapshot {
    const p = this.profile;
    return {
      profileName: p.name,
      difficulty: p.difficulty,
      activeMission: p.activeMission,
      invertMouse: p.invertField === 0,
      invertField: p.invertField,
      mouseSensitivity: p.mouseSensitivity,
      bloodEnabled: p.bloodEnabled,
      fxVolume: p.fxVolume,
      musicVolume: p.musicVolume,
      gamma: p.gamma,
      performanceFlags: p.performanceFlags,
      bindings: CONTROL_ACTIONS.map((action) => {
        const key = p.bindings[action] ?? DEFAULT_BINDINGS[action];
        return { action, device: key.startsWith("MOUSE") ? "INPUTPORT_DEVICE_MOUSE" : "INPUTPORT_DEVICE_KEYBOARD", key };
      }),
    };
  }

  private changed(what: SettingsChange): void {
    this.onChange?.(what, this);
  }

  /** Key table index of an action's binding (-1 when unbound). */
  bindingIndex(action: string): number {
    return CONTROL_KEYS.indexOf(this.profile.bindings[action] ?? "");
  }

  setBinding(action: string, keyIndex: number): void {
    const key = CONTROL_KEYS[keyIndex];
    if (key) this.profile.bindings[action] = key;
  }

  /**
   * One Config_* / Game_* / ControlsMenu_* script function. Returns undefined
   * for names this store does not implement. List-filling functions call `add`.
   */
  call(name: string, args: { int(i: number): number; float(i: number): number; string(i: number): string },
    add: (text: string, id: number) => void): number | undefined {
    const p = this.profile;
    switch (name) {
      case "Config_GameOptionsInputGetInvertMouse":
        return p.invertField === 0 ? 1 : 0;
      case "Config_GameOptionsInputSetInvertMouse":
        p.invertField = args.float(0) === 0 ? 1 : 0;
        this.changed("controls");
        return 0;
      case "Config_GameOptionsInputGetMouseSensitivity":
        return p.mouseSensitivity;
      case "Config_GameOptionsInputSetMouseSensitivity":
        p.mouseSensitivity = Math.fround(args.float(0));
        this.changed("controls");
        return 0;
      case "Config_GameOptionsInputGetBloodEnabled":
        return p.bloodEnabled ? 1 : 0;
      case "Config_GameOptionsInputSetBloodEnabled":
        p.bloodEnabled = (x87Fistp(args.float(0)) & 0xff) !== 0;
        this.changed("content");
        return 0;
      case "Config_SoundOptionsGetSoundsEffectsVolume":
        return p.fxVolume;
      case "Config_SoundOptionsSetSoundsEffectsVolume":
        p.fxVolume = Math.fround(args.float(0));
        return 0;
      case "Config_SoundOptionsGetMusicVolume":
        return p.musicVolume;
      case "Config_SoundOptionsSetMusicVolume":
        p.musicVolume = Math.fround(args.float(0));
        return 0;
      case "Game_UpdateVolume":
        this.changed("volume");
        return 1;
      case "Config_GraphicOptionsGetGamma":
        return p.gamma;
      case "Config_GraphicOptionsSetGamma":
        p.gamma = Math.fround(args.float(0));
        this.changed("graphics");
        return 0;
      case "Config_GraphicOptionsGetPerformanceFlags":
        return p.performanceFlags;
      case "Config_GraphicOptionsSetPerformanceFlags":
        p.performanceFlags = args.int(0);
        this.changed("graphics");
        return 1;
      case "Config_GraphicOptionsNumPerfLevels":
        return PERF_FLAG_TABLE.length;
      case "Config_GraphicOptionsGetPerfFlagsFromLevel":
        return PERF_FLAG_TABLE[args.int(0)] ?? 0;
      case "Config_GraphicOptionsGetPerfLevelFromFlags": {
        const f = args.int(0);
        let best = 0x1f;
        let level = 0;
        PERF_FLAG_TABLE.forEach((t, i) => {
          const d = bitCount(t ^ f);
          if (d < best) {
            best = d;
            level = i;
          }
        });
        return level;
      }
      case "Config_ResetGraphicOptions":
        p.resolution = { w: 640, h: 480, bpp: 32 };
        p.performanceFlags = 0;
        p.gamma = 1;
        this.changed("graphics");
        return 0;
      case "Config_FillRenderDeviceListBox":
        add("WebGL", 0); // the exe lists the Direct3D devices it enumerated
        return 0;
      case "Config_GraphicOptionsGetDevice":
        return p.device;
      case "Config_GraphicOptionsSetDevice":
        p.device = args.int(0);
        return 0;
      case "Config_FillScreenResolutionListBox":
        for (const [w, h, bpp] of PORT_RESOLUTIONS) add(`${w}x${h}x${bpp}`, resolutionId(w, h, bpp));
        return 0;
      case "Config_GraphicOptionsGetResolution": {
        let best = 0x7fffffff;
        let id = resolutionId(640, 480, 32);
        for (const [w, h, bpp] of PORT_RESOLUTIONS) {
          const d = Math.abs(h - p.resolution.h) * Math.abs(w - p.resolution.w) + Math.abs(bpp - p.resolution.bpp) * 0x1000000;
          if (d < best) {
            best = d;
            id = resolutionId(w, h, bpp);
          }
        }
        return id;
      }
      case "Config_GraphicOptionsSetResolution": {
        const id = args.int(0);
        p.resolution = { bpp: (id >> 26) & 0x3f, w: (id >> 13) & 0x1fff, h: id & 0x1fff };
        this.changed("graphics");
        return 0;
      }
      case "Config_FillPlayerProfileListBox":
        this.profiles.forEach((pr, i) => add(pr.name, i));
        return 0;
      case "Config_GetActivePlayerProfileIndex":
        return this.active;
      case "Config_SetActivePlayerProfileIndex": {
        const i = args.int(0);
        if (i >= 0 && i < this.profiles.length) this.active = i;
        this.changed("profile");
        return 0;
      }
      case "Config_GetNumberOfPlayerProfiles":
        return this.profiles.length;
      case "Config_PlayerGetActiveMission":
        return this.profiles[args.int(0)]?.activeMission ?? 0;
      case "Config_CreateNewPlayerProfile": {
        if (this.profiles.length > 15) return 0;
        const name = args.string(0).replace(/[ \t]+$/, "");
        if (!name || this.profiles.some((x) => x.name.toLowerCase() === name.toLowerCase())) return 0;
        const np = cloneProfile(p);
        np.name = name.slice(0, 31);
        np.difficulty = args.int(1);
        np.activeMission = 1;
        this.profiles.push(np);
        this.active = this.profiles.length - 1;
        this.changed("profile");
        return 1;
      }
      case "Config_DeletePlayerProfile": {
        const i = args.int(0);
        if (i >= this.profiles.length) return 0;
        if (i <= this.active) this.active--;
        this.profiles.splice(i, 1);
        if (this.active < 0) this.active = 0;
        this.changed("profile");
        return 1;
      }
      case "Config_IsGermany":
        return 0;
      case "Config_IsContentControlPasswordEnabled":
        return this.contentPassword.length > 0 ? 1 : 0;
      case "Config_VerifyContentControlPassword":
        return args.string(0) === this.contentPassword ? 1 : 0;
      case "Config_SetContentControlPassword":
        this.contentPassword = args.string(0);
        this.changed("content");
        return 0;
      case "ControlsMenu_ConvertFloatFromOffset":
        return args.int(0) / (CONTROL_ACTIONS.length - 10);
      case "ControlsMenu_ConvertOffsetFromFloat":
        return x87Fistp(Math.fround((CONTROL_ACTIONS.length - 10) * args.float(0) + 0.5));
      default:
        return undefined;
    }
  }

  /** String-valued script functions (Config_GetContentControlPassword). */
  callString(name: string): string | undefined {
    if (name === "Config_GetContentControlPassword") return this.contentPassword;
    return undefined;
  }
}

export function resolutionId(w: number, h: number, bpp: number): number {
  return (((bpp << 13) | w) << 13) | h;
}
