# re-igi

Research toward a desktop-browser reimplementation of Project I.G.I., using the
supplied installation as the reference. The aim is to preserve the original
visual style and eventually play one mission in a browser. **There is no
playable browser port yet.**

The current milestone is a reproducible asset and executable investigation.
Original game files stay under `Game Files/`; tools only read them. Game data,
converted previews, and installed analysis engines are excluded from Git.

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

The [QVM evidence ledger](docs/qvm.md) records unsupported expressions and a
real mouse-inversion discrepancy between compiled and readable config files.

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

REA supplies decompiler and evidence tools; the browser engine must be written
separately. Consult the [REA CLI guide](https://github.com/morluto/rea/blob/main/docs/cli.md)
and [provider setup](https://github.com/morluto/rea/blob/main/docs/installation.md#ghidra).

Do not put original game files or converted assets into a published build
without a redistribution arrangement. A browser build can instead load files
selected locally by the player; this project has not implemented that yet.
