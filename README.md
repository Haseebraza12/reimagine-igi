# re-igi

Research toward a desktop-browser reimplementation of Project I.G.I., using the
supplied installation as the reference. The aim is to preserve the original
visual style and eventually play one mission in a browser.

**Current status:** Mission 1 ("Trainyard") is playable in the browser,
decoded at runtime from your own installation. The port follows igi.exe's
own rules, recovered by static analysis and recorded with their evidence in
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
- **HUD, menus and sound**: the original fonts, sprites, menus and their
  sub-screens, the map computer, radio messages; the game's software 3D
  sound mixer with its sample bank.
- **Timing and arithmetic**: a fixed 30 Hz logic tick, the game's random
  number generators, and the x87 chop rounding mode where the game converts
  or stores numbers (docs/gameplay.md "FPU rounding mode").

Output is not bit-identical to the PC game: WebGL is not Direct3D 7 and the
browser mixes the sound. The data, parameters and logic are the game's own.

Not yet reproduced (see [docs/roadmap.md](docs/roadmap.md)):
- the intro movies (Indeo 5 video) are skipped;
- the credits text (compiled into igi.exe, which is not staged);
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

Open the page, go through the original main menu (**Select Mission** →
**OK**) and **click** to capture the mouse. Esc breaks a cut-scene;
otherwise it opens the pause menu.

The keys are the game's own defaults, read from `config.qvm`:

| Input | Action |
|-------|--------|
| Arrow keys | move |
| Mouse | look (inverted vertical axis by default, as the shipped config sets it; the menu's "Invert Mouse" and `?look=normal` change it) |
| Left mouse | fire (hold for automatic weapons) · right mouse: next weapon |
| `Enter` reload · `Right Shift` use (doors, ladders, wires, switches, terminals) · `Right Ctrl` crouch (hold) | |
| `Numpad 0` jump · `Numpad 1` peek (lean) · `W` walk / run · `C` map computer | |
| `Space` binoculars · `1`–`9` weapon groups · `Esc` pause | |

Add `?keys=wasd` to the URL for a WASD layout (E use, C crouch, Space jump,
Shift walk / run, M map computer).

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
