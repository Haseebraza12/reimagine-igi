# re-igi

**Project I.G.I. in a web browser: a hobby project by Haseeb ur Rehman.**

Research toward a desktop-browser reimplementation of Project I.G.I., using the
owner's installation as the reference. The aim is to preserve the original
visual style and play the game's missions in a browser.

## About this project

re-igi is a personal, non-commercial hobby project by **Haseeb ur Rehman**.
It studies how the 2000 PC game *Project I.G.I.: I'm Going In* works and
rebuilds its missions so that they run in a web browser. It is made for
learning and for fun, not for sale.

It is an unofficial fan project. It is not affiliated with, endorsed by or
supported by Innerloop Studios, Eidos Interactive or any current owner of the
*Project I.G.I.* rights.

## Legal notice

- *Project I.G.I.* and all of its content (names, characters, levels,
  artwork, models, textures, sounds, music, video and program code) belong to
  their copyright and trademark owners.
- To play, you need **your own legally obtained copy** of the game. The port
  reads that copy's files at runtime; it does not need to be distributed with
  any of them.
- **Copying, uploading, sharing or selling the original game's files, or
  anything extracted or converted from them, without the rights holders'
  permission is copyright infringement and is illegal.** Do not put them in a
  repository, a download or a published build of this project.
- Do not use this project, or any build of it, for commercial purposes.
- The source code written for re-igi is © 2026 Haseeb ur Rehman. All rights
  reserved. Apart from what GitHub's Terms of Service allow (viewing and
  forking on GitHub), no permission is given to copy, republish, modify or
  sell it, in whole or in part, without the author's written permission.

## Status

All 14 missions of the full game load and play in the browser, decoded at
runtime from your own installation (Trainyard, SAM Base, Military Airbase,
GOD, Radar Base, Get Priboi, Border Crossing, Re-supply, Missile Trainyard,
Defend Priboi, Eagle's Nest I and II, Nuclear Infiltration, Finding the
bomb). The port follows igi.exe's own rules, recovered by static analysis
and recorded with their evidence in
[docs/evidence-ledger.md](docs/evidence-ledger.md):

- **World**: the octree terrain with the exe's per-frame LOD walk, vertex
  geomorph, relief, ground textures and baked lightmaps; every placed object
  with its attached parts, model LODs, baked lightmaps or vertex lighting;
  the sky dome, cloud layers and exponential fog; the railway embankment on
  the game's own spline and the overhead wires; security cameras that sweep;
  weapon and ammo pickups; the original 4:3 camera (90° × 73.74°).
- **Vehicles**: the trains, helicopters and truck of the intro and outro,
  driven by the recovered vehicle physics; standing on a moving train carries
  the player.
- **Player**: the game's 49-state movement graph (walk / run, hold-to-crouch,
  jump, fall, landing, lean, map computer, death), body-animation root
  motion, fall damage, slopes and steps, the three-ray character sweep
  against the models' collision hulls; ladders, fences, zip wires, doors,
  switches and terminal hacking with the third-person camera the game uses
  for them (and after death).
- **Combat**: the weapon state machine, rate of fire, bursts, the exe's
  pellet spread, recoil and reload; ricochet and penetration; per-zone
  damage on the posed body meshes; grenades, glass, explosive barrels,
  terminals and security-camera lenses with the recovered explosions; bullet
  holes, dust, fragments, tracers, blood, shell casings and muzzle flashes.
- **AI**: the soldiers run their original AI scripts on a reimplementation
  of the game's script VM, with the recovered state graph, perception,
  hearing, route graphs (opening doors on their way), combat decisions and
  burst firing.
- **Mission logic**: the task runtime of `objects.qvm` (intro and outro
  cut-scenes with letterbox, subtitles and the camera filters, doors,
  alarms, security cameras, radio messages, objectives, mission complete /
  failed).
- **Missions 2–14** add their own object types, each from the exe's code
  ([docs/objects.md](docs/objects.md), [docs/world.md](docs/world.md),
  [docs/combat.md](docs/combat.md), [docs/vehicles.md](docs/vehicles.md)):
  elevators that carry you between floors, generators and radios, cabinets
  to search, C4 to pick up and plant, the binocular view of the mission 5
  intro; rain and snow, turning radar dishes, alarm lights and sirens,
  terrain cut away under buildings; mounted machine guns you can man (and
  soldiers who man them), ceiling turrets, minefields, guard posts that send
  reinforcements, the M16A2's M203 grenades, the SPAS-12, the RPG soldier and
  the female soldiers of the last mission; SU-27 jets with their landing gear
  and flight physics, AI-driven APCs, tanks and cars with their turrets, the
  Mil helicopter's gun and rocket pods, rockets on their recovered flight
  physics, wrecks, and the trains of missions 9 and 10.
- **HUD, menus and sound**: the original fonts, sprites, menus and their
  sub-screens, the map computer, radio messages; the game's software 3D
  sound mixer with its sample bank.
- **Timing and arithmetic**: a fixed 30 Hz logic tick, the game's random
  number generators, and the x87 chop rounding mode where the game converts
  or stores numbers (docs/gameplay.md "FPU rounding mode").

Output is not bit-identical to the PC game: WebGL is not Direct3D 7 and the
browser mixes the sound. The data, parameters and logic are the game's own.

**Missions.** Each mission loads from its own `mission.qvm` (DefineMission:
level folder, location folder, name, picture). `npm run stage` copies every
`missions/locationN/levelM` folder of the installation it is pointed at and
lists them in `game-data/missions.json`; Select Mission then offers them. A
one-mission installation shows the others as "Mission Not Installed".

Not yet reproduced (see [docs/roadmap.md](docs/roadmap.md)):
- the intro movies (Indeo 5 video) are skipped;
- the credits text (compiled into igi.exe, which is not staged);
- a few details listed under "Open" in the docs above (for example the
  drawer's collision);
- nothing has been compared frame by frame with the running original.

Original game files stay under `Game Files/`; tools only read them. Do not
put original game files or anything derived from them into a repository or
a published build without a redistribution arrangement.

## Run the web port

The browser engine lives in `web-port/` (TypeScript + Vite + Three.js). It
reads the **original** game files at runtime; nothing is pre-converted.

```bash
cd web-port
npm install          # first time only
npm run stage        # copy the needed files from ../Game Files into game-data/
                     # (or: IGI_GAME_DIR=/path/to/IGI npm run stage)
npm run dev          # http://localhost:5173
```

Open the page and choose **Play Project IGI**. A dialog in the game's own
style asks for **Story Mode** (the missions you have reached, as in the
original) or **Free Mode** (all 14 missions of the game, with their own
pictures and descriptions, to play in any order; finishing one there does not
move the story on; a mission whose files are not installed shows "Mission Not
Installed" instead of starting). Then **Select Mission** →
**OK**, and **click** to capture the mouse. Esc breaks a cut-scene;
otherwise it opens the pause menu.

The keys are the game's own defaults, read from `config.qvm` (or from the
profile as the Controls menu leaves it), plus a few port additions: **W A S D
move** as well as the arrow keys, **R reloads** as well as Enter, the
**middle mouse button** is alternate fire (the Dragunov scope, the MP5SD
zoom) as well as Backspace, and the **mouse wheel zooms** the binoculars and
the Dragunov scope.

| Input | Action |
|-------|--------|
| Arrow keys or `W` `A` `S` `D` | move |
| Mouse | look (inverted vertical axis by default, as the shipped config sets it; the menu's "Invert Mouse" and `?look=normal` change it) |
| Left mouse | fire (hold for automatic weapons) · right mouse: next weapon (as in the original) |
| `Enter` or `R` reload (an empty gun also reloads by itself when you release Fire) · `Right Shift` use (doors, ladders, wires, switches, terminals) · `Right Ctrl` crouch (hold) | |
| `Numpad 0` jump · `Numpad 1` peek (lean) · `Caps Lock` walk / run (the shipped `W`, moved for WASD) · `C` map computer | |
| `Space` binoculars · `Page Up` / `Page Down` or the wheel: zoom · `Backspace` or the middle button (alternate fire): Dragunov scope on / off (hold to zoom in), MP5SD zoom on / off, binoculars: hold to zoom in, click again to reset | |
| `1`–`9` weapon groups · `Esc` pause | |

The binoculars behave as in igi.exe (`FUN_0046f500`): each tick of zoom in or
out multiplies the view tangent by 0.96 or 1.04, from 70° down to 5° and up to 90°.

`?keys=original` uses only the profile's bindings (no WASD, R, middle button
or wheel).

**Quit** on the main menu ends the game as igi.exe does: the page closes
itself. Browsers allow that only for a tab opened by a script or one with no
browsing history; otherwise the page goes black with "Project I.G.I. has
quit" and you close the tab yourself.
`?keys=wasd` is a full modern layout (E use, C crouch, Space jump, Shift
walk / run, M map computer, B binoculars, wheel zoom).

**Cheats** (port addition): Configuration → **Cheats** on the main menu, or
**Cheats** in the pause menu during a mission. Every cheat is off until you
switch it on; a change applies when you press OK (Cancel discards it).

| Cheat | Effect |
|-------|--------|
| Unlimited Ammo | Firing, throwing grenades and using medipacks use nothing: the clip and the reserve stay as they are. A reload fills the clip without using the reserve. |
| Unlimited Health | You take no damage: your health stays where it is. Falling out of the world still ends the game. |
| One Shot Kills | Your bullets and knife kill any soldier with one hit (a soldier the mission keeps alive on purpose still survives). |
| Invisible To Enemies | Soldiers and security cameras do not see you, and soldiers do not hear your shots, steps, landings, doors or ladders. A soldier you hit still knows he was hit. Mission triggers (reaching an area) work as normal. |
| All Weapons | At every mission start, and at once when switched on during a mission: every weapon the level can show (Glock, MP5SD, Uzi, AK-47, Minimi, Dragunov, grenades, medipacks) with a full clip and a full reserve. Switching it off keeps what you carry until the next start. |

The original igi.exe has one hidden cheat of its own, the command-line word
`UnlimitedAmmo` (the clip still empties, but reloads are free). See
[docs/weapons-view.md](docs/weapons-view.md).

Settings made in the menus (profiles, controls, volumes, resolution,
performance level, cheats) are kept in this browser's storage, as igi.exe keeps them
in `config.qsc`; clearing the site data restores the shipped `config.qvm`
defaults. The menus play `menu_music` from the menu sound archive once the
page has had a click or key press (browsers block audio before that).

Checks and build:

```bash
cd web-port
npm run check        # strict typecheck
npm test             # vitest: format readers, recovered rules, level assembly, engine systems
npm run build        # production bundle in web-port/dist (contains no game files)
```

The loader layer (`src/loaders/**`) reads the IGI formats; the engine layer
(`src/engine/**`) consumes only `src/contracts.ts` and `src/loaders/index.ts`.
See [docs/loader-api.md](docs/loader-api.md), [docs/formats.md](docs/formats.md),
[docs/terrain.md](docs/terrain.md) and [docs/roadmap.md](docs/roadmap.md).

## Run the research tools

Python 3 is sufficient for the format tools; GNU `objdump` is used for PE triage.
Run these from the project root:

```bash
python3 tools/igi.py scan
python3 tools/igi.py triage
python3 tools/igi.py textures \
  'Game Files/missions/location0/level1/textures/level1.res' \
  --out research/previews/level1
python3 tools/igi.py verify
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

`scan` hashes every source file, inventories all resources, and recovers QVM
symbol tables. The first scan writes `research/baseline.json`; later scans do
not replace that baseline. `verify` detects changed, missing, or added files.
It detects changes after the first scan, not authenticity of the installation.

`textures` creates experimental PNG previews with source offsets, hashes,
format interpretation, and ignored tail-byte counts in `manifest.json`.
These previews are for local inspection. Pixel layouts still require renderer
validation. Original resource names are never used as output paths.

List any supported resource archive without extracting it:

```bash
python3 tools/igi.py resources 'Game Files/missions/location0/level1/models/level1.res'
```

See [the findings](docs/findings.md), [format notes](docs/formats.md), and
[the implementation roadmap](docs/roadmap.md).

Recover constant script-call arguments without executing the VM:

```bash
python3 tools/igi_qvm.py 'Game Files/config.qvm' --validate-config
python3 tools/igi_qvm.py 'Game Files/humanplayer/humanplayer.qvm'
python3 tools/igi_qvm.py 'Game Files/weapons/AK47/weapon.qvm'
```

The [QVM evidence ledger](docs/qvm.md) records the opcode evidence, the
call-tree grammar and a real mouse-inversion discrepancy between compiled and
readable config files. Mission tasks and the terrain have reference decoders
with built-in validation:

```bash
python3 tools/level_tasks.py 'Game Files/missions/location0/level1/objects.qvm'
python3 tools/terrain_ctr.py     # terrain surface vs 1,084 placed samples
python3 tools/terrain_tex.py     # terrain texturing/lighting self-checks
python3 tools/object_lighting.py # building lightmaps: 1,308 .olm vs instance lists
```

## Native analysis with REA

The project pins REA to 6.4.0. Its CLI can be used without registering an MCP
server or changing your personal agent settings. Reinstall dependencies with:

```bash
npm ci --prefix tools/rea --ignore-scripts
```

The local wrapper expects Ghidra 12.1.4 in
`tools/native/ghidra_12.1.4_PUBLIC`, or an explicit `GHIDRA_INSTALL_DIR` override,
and a full JDK 21 through `JAVA_HOME`. This workspace provides the matching
Ubuntu JDK compiler tools in `tools/native/jdk-21`, alongside the installed
runtime; the wrapper selects them automatically. Commands:

```bash
bash tools/rea-run.sh doctor --provider ghidra --json
bash tools/rea-run.sh inspect "$PWD/Game Files/igi.exe" --provider ghidra --json
```

For the candidate player-setup function, explicitly seed the entry points
supported by the saved registration disassembly:

```bash
REA_GHIDRA_SEED_FILE="$PWD/tools/igi-seeds.tsv" \
  bash tools/rea-run.sh function "$PWD/Game Files/igi.exe" 0x410160 \
  --provider ghidra --json
```

Seeds are analyst assertions, not automatically discovered function identities.
Some restricted environments require allowing Java subprocesses and local
provider communication before native analysis can start.

REA supplies decompiler and evidence tools; the browser engine that consumes
their output is implemented in `web-port/` (see [Run the web port](#run-the-web-port)).
Consult the [REA CLI guide](https://github.com/morluto/rea/blob/main/docs/cli.md)
and [provider setup](https://github.com/morluto/rea/blob/main/docs/installation.md#ghidra).

Do not put original game files or anything derived from them into a
repository or a published build without a redistribution arrangement. The web
port reads the player's own staged files from `web-port/game-data/` (served
at `/raw/` by the dev/preview servers), which is gitignored and outside
`public/`, so the production build contains none of them.
