/**
 * Menu sub-screen widgets and the profile configuration (src/engine/ui
 * menu-widgets.ts, menu-config.ts, menu-model.ts): SlideBar, ToggleBox,
 * ListBox, ControlsMenu, data load / commit, Config_* semantics, the idle
 * attract timer and the igi.exe credits table reader (synthetic PE).
 * Evidence: docs/hud.md section 12.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readExeCredits, CREDITS_TABLE_VA } from "../src/loaders/exe-credits";
import { loadUiAssets } from "../src/engine/ui/assets";
import { CONTROL_ACTIONS, CONTROL_KEYS, MenuConfig, PERF_FLAG_TABLE, resolutionId } from "../src/engine/ui/menu-config";
import { MENU_KEY, MenuManager, type MenuEnvironment, type MenuItem } from "../src/engine/ui/menu-model";
import { submitMenu } from "../src/engine/ui/menu-draw";
import { PrimList } from "../src/engine/ui/painter";
import { wrapAscii } from "../src/engine/ui/menu-widgets";
import { RAW_ROOT, readRaw } from "./helpers";

const have = (...paths: string[]) => paths.every((p) => existsSync(`${RAW_ROOT}/${p}`));
const rawSource = { exists: async (p: string) => existsSync(`${RAW_ROOT}/${p}`), readBinary: (p: string) => readRaw(p) };
const args = (...v: Array<number | string>) => ({
  int: (i: number) => (typeof v[i] === "number" ? Math.trunc(v[i] as number) : 0),
  float: (i: number) => (typeof v[i] === "number" ? (v[i] as number) : 0),
  string: (i: number) => (typeof v[i] === "string" ? (v[i] as string) : ""),
});

describe("MenuConfig (Config_* script functions)", () => {
  it("invert mouse is shown as (field == 0); sensitivity and volumes are 0..1 floats", () => {
    const c = new MenuConfig();
    c.profile.invertField = 1;
    expect(c.call("Config_GameOptionsInputGetInvertMouse", args(), () => {})).toBe(0);
    c.call("Config_GameOptionsInputSetInvertMouse", args(1), () => {});
    expect(c.profile.invertField).toBe(0);
    expect(c.snapshot().invertMouse).toBe(true);
    c.call("Config_SoundOptionsSetSoundsEffectsVolume", args(0.25), () => {});
    expect(c.call("Config_SoundOptionsGetSoundsEffectsVolume", args(), () => {})).toBe(0.25);
  });

  it("performance levels: table 0x535bd4, level from flags = fewest differing bits", () => {
    const c = new MenuConfig();
    expect(c.call("Config_GraphicOptionsNumPerfLevels", args(), () => {})).toBe(7);
    PERF_FLAG_TABLE.forEach((f, i) => {
      expect(c.call("Config_GraphicOptionsGetPerfFlagsFromLevel", args(i), () => {})).toBe(f);
      expect(c.call("Config_GraphicOptionsGetPerfLevelFromFlags", args(f), () => {})).toBe(i);
    });
  });

  it("resolutions: \"%dx%dx%d\" with id (bpp<<13|w)<<13|h; Set decodes it", () => {
    const c = new MenuConfig();
    const list: Array<[string, number]> = [];
    c.call("Config_FillScreenResolutionListBox", args(0), (t, id) => list.push([t, id]));
    expect(list[1]).toEqual(["640x480x32", resolutionId(640, 480, 32)]);
    c.call("Config_GraphicOptionsSetResolution", args(resolutionId(800, 600, 16)), () => {});
    expect(c.profile.resolution).toEqual({ w: 800, h: 600, bpp: 16 });
    expect(c.call("Config_GraphicOptionsGetResolution", args(0), () => {})).toBe(resolutionId(800, 600, 16));
  });

  it("profiles: create (trimmed, unique, copies settings), delete, at most 16", () => {
    const c = new MenuConfig();
    c.profile.mouseSensitivity = 0.7;
    expect(c.call("Config_CreateNewPlayerProfile", args("Anna  ", 2), () => {})).toBe(1);
    expect(c.profile).toMatchObject({ name: "Anna", difficulty: 2, mouseSensitivity: 0.7 });
    expect(c.call("Config_CreateNewPlayerProfile", args("anna", 0), () => {})).toBe(0);
    expect(c.call("Config_CreateNewPlayerProfile", args("   ", 0), () => {})).toBe(0);
    expect(c.call("Config_GetNumberOfPlayerProfiles", args(), () => {})).toBe(2);
    c.call("Config_DeletePlayerProfile", args(0), () => {});
    expect(c.profiles.map((p) => p.name)).toEqual(["Anna"]);
    expect(c.active).toBe(0);
  });

  it("ControlsMenu offset <-> slider value over 27 - 10 rows", () => {
    const c = new MenuConfig();
    expect(c.call("ControlsMenu_ConvertFloatFromOffset", args(17), () => {})).toBe(1);
    expect(c.call("ControlsMenu_ConvertOffsetFromFloat", args(0.5), () => {})).toBe(9);
    expect(CONTROL_ACTIONS.length).toBe(27);
    expect(CONTROL_KEYS.length).toBe(127);
  });

  it.skipIf(!have("config.qvm"))("config.qvm: one profile Joe, GOInMouInv 0 (menu: Invert Mouse Yes), sensitivity 0.4, the 27 bindings", async () => {
    const c = new MenuConfig();
    c.loadConfigQvm(await readRaw("config.qvm"));
    const s = c.snapshot();
    expect(s.profileName).toBe("Joe");
    expect(s.invertField).toBe(0);
    expect(s.invertMouse).toBe(true);
    expect(s.mouseSensitivity).toBeCloseTo(0.4, 6);
    expect(s.bindings.find((b) => b.action === "MapComputer")).toEqual({ action: "MapComputer", device: "INPUTPORT_DEVICE_KEYBOARD", key: "KEY_C" });
    expect(s.bindings.find((b) => b.action === "Fire")?.device).toBe("INPUTPORT_DEVICE_MOUSE");
  });
});

const IG = ["menusystem/ingamemenu.res", "menusystem/ingamemenu.qvm", "menusystem/menusystem.res", "menusystem/mainmenu.qvm", "language/english/menusystem.res"];

describe.skipIf(!have(...IG))("menu widgets on the original screens", () => {
  async function manager(main = false, extra: Partial<MenuEnvironment> = {}) {
    const a = await loadUiAssets(rawSource);
    const archive = main ? a.main : a.ingame;
    const config = new MenuConfig();
    const changes: string[] = [];
    config.onChange = (w) => changes.push(w);
    const held = new Set<string>();
    const sounds: string[] = [];
    const env: MenuEnvironment = {
      text: (k) => a.menuStrings.get(k.toLowerCase()) ?? `RM: ${k}`,
      measure: (f, t) => {
        const font = archive.fonts.get(f);
        return font ? { w: t.length * 9, h: font.lineHeight } : null;
      },
      picture: (n) => {
        const p = archive.pictures.get(n);
        return p ? { w: p.width, h: p.height } : null;
      },
      missions: () => [],
      activeMission: () => 1,
      levelFailed: () => false,
      playerDead: () => false,
      sound: (n) => sounds.push(n),
      setMission: () => {},
      leave: () => {},
      setPaused: () => {},
      opened: () => {},
      config,
      spriteSize: (n) => {
        const s = archive.sprites.get(n.toLowerCase());
        return s ? { w: s.width, h: s.height } : null;
      },
      font: (n) => archive.fonts.get(n.toLowerCase()) ?? null,
      heldKeys: () => held,
      ...extra,
    };
    const m = new MenuManager(main ? a.mainMenu : a.ingameMenu, env, { ownDisplay: main, ticksPerSecond: main ? 60 : 30, startOpen: main });
    return { m, config, changes, held, sounds, a };
  }

  const widgets = (root: MenuItem | null) => {
    const out: MenuItem[] = [];
    const walk = (i: MenuItem) => {
      if (i.widget) out.push(i);
      i.children.forEach(walk);
    };
    if (root) walk(root);
    return out;
  };

  const run = (m: MenuManager, n: number) => {
    for (let i = 0; i < n; i++) m.tick();
  };

  it("in-game Sound: sliders load the volumes; RIGHT steps 0.05 and applies at once (Modify Data + Game_UpdateVolume)", async () => {
    const { m, config, changes } = await manager();
    config.profile.fxVolume = 0.5;
    config.profile.musicVolume = 0.25;
    m.openScreen(902);
    run(m, 12);
    const sliders = widgets(m.screen).map((w) => w.widget!);
    expect(sliders.map((w) => w.kind === "slide" && w.value)).toEqual([0.25, 0.5]);
    m.key(MENU_KEY.DOWN); // select FX Volume
    m.key(MENU_KEY.RIGHT);
    run(m, 1);
    expect(config.profile.fxVolume).toBeCloseTo(0.55, 6);
    expect(changes).toContain("volume");
  });

  it("in-game Controls: toggle = Get Invert, ControlsMenu shows the bindings; capture swaps keys; OK commits", async () => {
    const { m, config, held } = await manager();
    config.profile.invertField = 0;
    m.openScreen(903);
    run(m, 12);
    const [toggle, slider, controls] = widgets(m.screen);
    expect(toggle.widget).toMatchObject({ kind: "toggle", isOn: true });
    expect(slider.widget).toMatchObject({ kind: "slide", horizontal: true });
    const c = controls.widget!;
    expect(c.kind).toBe("controls");
    if (c.kind !== "controls") return;
    expect(c.rows.map((k) => CONTROL_KEYS[k]).slice(0, 4)).toEqual(["KEY_LEFT", "KEY_RIGHT", "KEY_UP", "KEY_DOWN"]);
    // Click row 1 (Move Right): press + release inside the list.
    m.pointerMove(controls.x + 20, controls.y + 25);
    m.pointerButton(true);
    run(m, 1);
    m.pointerButton(false);
    run(m, 1);
    expect(c.waiting).toBe(true);
    expect(m.state).toBe(3);
    held.add("KEY_LEFT");
    run(m, 1);
    held.clear();
    expect(c.waiting).toBe(false);
    expect(m.state).toBe(2);
    expect(CONTROL_KEYS[c.rows[1]]).toBe("KEY_LEFT");
    expect(CONTROL_KEYS[c.rows[0]]).toBe("KEY_RIGHT"); // swapped
    expect(config.profile.bindings.MoveRight).toBe("KEY_RIGHT"); // not committed yet
    // OK = PopScreen(TRUE): commit.
    const ok = (() => {
      let f: MenuItem | null = null;
      const walk = (i: MenuItem) => {
        if (i.textKey === "OK") f = i;
        i.children.forEach(walk);
      };
      walk(m.screen!);
      return f as unknown as MenuItem;
    })();
    m.pointerMove(ok.x + 2, ok.y + 2);
    m.pointerButton(true);
    run(m, 1);
    m.pointerButton(false);
    run(m, 1);
    expect(config.profile.bindings.MoveRight).toBe("KEY_LEFT");
    expect(config.profile.bindings.MoveLeft).toBe("KEY_RIGHT");
    expect(config.profile.invertField).toBe(0);
  });

  it("main menu Graphics: device / resolution lists and the 7-level performance slider; draw submits widget primitives", async () => {
    const { m } = await manager(true);
    run(m, 20);
    m.key(MENU_KEY.DOWN);
    m.key(MENU_KEY.RETURN); // Configuration
    run(m, 30);
    m.key(MENU_KEY.RETURN); // Graphics
    run(m, 30);
    expect(m.screenId).toBe(905);
    const [device, res, perf] = widgets(m.screen);
    expect(device.widget).toMatchObject({ kind: "list", entries: [{ id: 0, text: "WebGL" }] });
    expect(res.widget?.kind === "list" && res.widget.entries[res.widget.index].text).toBe("640x480x32");
    expect(perf.widget).toMatchObject({ kind: "slide", options: 7, value: 0, nValue: 0 });
    const p = new PrimList();
    submitMenu(m, { archive: (await loadUiAssets(rawSource)).main, missionSprites: { sprites: new Map(), fonts: new Map(), pictures: new Map() }, usa: false, bgfx: null }, p);
    expect(p.labels.filter((l) => l === "sprite").length).toBeGreaterThanOrEqual(7);
  });

  it("Select Player: type a name in the InputBox, Return -> difficulty dialog -> Easy creates the profile and refreshes the list", async () => {
    const { m, config } = await manager(true);
    run(m, 20);
    m.key(MENU_KEY.DOWN);
    m.key(MENU_KEY.DOWN);
    m.key(MENU_KEY.RETURN); // Select Player -> 912
    run(m, 30);
    expect(m.screenId).toBe(912);
    m.key(MENU_KEY.DOWN);
    m.key(MENU_KEY.DOWN); // the "Add Player" frame
    m.key(MENU_KEY.RETURN);
    run(m, 1);
    expect(m.state).toBe(3);
    for (const ch of "Bob") m.key(ch.charCodeAt(0));
    m.key(MENU_KEY.RETURN);
    run(m, 1);
    run(m, 30); // popup 933 fades in
    expect(m.popup?.id).toBe(933);
    m.key(MENU_KEY.RETURN); // Easy
    run(m, 30);
    expect(config.profiles.map((p) => p.name)).toEqual(["Joe", "Bob"]);
    expect(config.profile).toMatchObject({ name: "Bob", difficulty: 0 });
    const list = widgets(m.screen).find((w) => w.widget?.kind === "list")!.widget!;
    expect(list.kind === "list" && list.entries.map((e) => e.text)).toEqual(["Joe", "Bob"]);
  });

  it("main menu idles into the attract mode after 3600 + 1 updates at 60 Hz (60 s); a key press resets the timer", async () => {
    let attract = 0;
    const { m } = await manager(true, { attract: () => attract++ });
    run(m, 30);
    run(m, 3500);
    expect(attract).toBe(0);
    m.key(MENU_KEY.UP);
    run(m, 1);
    expect(m.idleTicks).toBe(0);
    run(m, 3590);
    expect(attract).toBe(0);
    run(m, 20);
    expect(attract).toBe(1);
  });
});

describe("AsciiBox word wrap (FUN_0041d9c0)", () => {
  it("breaks at spaces when the line is wider than the box, keeps paragraphs", () => {
    const font = { proportional: false, cellWidth: 10, spaceAdvance: 10, charMap: new Uint8Array(256).fill(1), glyphs: [{ advance: 10 }], lineHeight: 15 } as never;
    expect(wrapAscii(font, "aaa bbb ccc\r\nd", 75)).toEqual(["aaa bbb", "ccc", "d"]);
  });
});

describe("igi.exe credits table reader", () => {
  it("reads 130 entries of 36 bytes at VA 0x537cd8 through the PE section table (synthetic image)", () => {
    // A minimal PE: one section mapping RVA 0x137000.. to file offset 0x400.
    const base = 0x400000;
    const secVa = 0x137000;
    const buf = new ArrayBuffer(0x400 + 0x3000);
    const v = new DataView(buf);
    v.setUint16(0, 0x5a4d, true);
    v.setUint32(0x3c, 0x80, true);
    v.setUint32(0x80, 0x4550, true);
    v.setUint16(0x80 + 6, 1, true);
    v.setUint16(0x80 + 20, 0xe0, true);
    v.setUint32(0x80 + 24 + 28, base, true);
    const sec = 0x80 + 24 + 0xe0;
    v.setUint32(sec + 8, 0x3000, true);
    v.setUint32(sec + 12, secVa, true);
    v.setUint32(sec + 16, 0x3000, true);
    v.setUint32(sec + 20, 0x400, true);
    const tableOff = 0x400 + (CREDITS_TABLE_VA - base - secVa);
    const textVa = base + secVa + 0x2800;
    new Uint8Array(buf, 0x400 + 0x2800, 4).set([0x41, 0x42, 0x43, 0]);
    for (let i = 0; i < 130; i++) {
      const o = tableOff + i * 36;
      v.setInt32(o + 4, i % 10 === 9 ? -1 : 20 * i, true);
      v.setInt32(o + 12, i % 4, true);
      v.setUint32(o + 0x1c, textVa, true);
    }
    const lines = readExeCredits(buf);
    expect(lines.length).toBe(130);
    expect(lines[1]).toMatchObject({ y: 20, font: 1, text: "ABC" });
    expect(lines[9].y).toBe(-1);
  });
});
