# Findings from the supplied installation

Analysis date: 13 October 2026. Scope: the local `Game Files/` directory.
This is an initial investigation, not a completed engine reconstruction.

## Confirmed from file bytes

| Finding | Evidence |
| --- | --- |
| 266 files, 77,754,361 bytes (74.15 MiB) | `research/inventory.json` |
| One mission directory: `missions/location0/level1` | directory inventory and its `mission.qvm` |
| 53 ILFF/IRES resource archives, 8,786 named records | `research/resources.json`; all parse without errors |
| 118 LOOP v8 QVM files with recoverable symbol tables | `research/qvm-symbols.json`; all parse without errors |
| First-level archive: 393 texture payloads | `missions/location0/level1/textures/level1.res` |
| First-level archive: 417 model payloads | `missions/location0/level1/models/level1.res` |
| Shared location archives: 270 textures and 184 models | `missions/location0/common/{textures,models}/location0.res` |
| First-level lightmap archive: 1,308 payloads | `missions/location0/level1/lightmaps/lightmaps.res` |
| Native x86 PE32 executable; image base `0x00400000`, entry `0x0049bff5` | `research/native-triage.json` and `research/pe-imports.txt` |
| Imports include DDRAW, DINPUT, DSOUND, WINMM, AVIFIL32 and MSVFW32 | `research/pe-imports.txt` |
| Direct3D device/interface diagnostics exist in the executable | string anchors in `research/native-triage.json` |
| Readable config source and assembly accompany compiled config | `config.qsc`, `config.qas`, `config.qvm` |

`igi.exe` SHA-256:
`2b1673443e2635d97787344da5fab9d1ac6b717d34d18c5bab7f30749b1174c2`.
The original readme identifies version 1.0, but that text alone does not
authenticate the executable's release or modification history. A single
mission's presence does not prove this is a complete retail installation.

Counts of resource records include `PATH` records and localized text. They
are not counts of distinct renderable assets. Model counts are indexed opaque
payloads, not successfully imported meshes.

## Experimental results

All 393 first-level textures produce PNG base-level previews. The decoder uses
inferred A1R5G5B5 for 365 textures and inferred BGRA8888 for 28. The latter have
uninterpreted tail bytes. Visual inspection of
`research/previews/level1-contact-sheet.png` shows coherent original imagery.
This does not yet validate scene fidelity, alpha, mipmaps or lighting.

The native disassembly contains candidate host-function registration sequences:

| Script host name | Candidate native function | Registration call |
| --- | --- | --- |
| `DefineHumanPlayerGeneral` | `0x00410160` | `0x00410101` |
| `CreateTerrainMaterial` | `0x004bc890` | `0x004bc7a0` |
| `CreateTerrainTileMap` | `0x004bc980` | `0x004bc7b3` |

Each sequence passes a matching string address and candidate code address to
`0x004aead0`. These are static registration inferences, not observed runtime
calls. Bounded disassembly is saved in `research/native/`; semantic meanings
and units of the host arguments still need tracing.

Static QVM call recovery yields 43 config calls / 102 arguments, four player
calls / 98 arguments (96 resolved), and one AK47 call / 49 arguments (46
resolved). All 377 config instructions structurally align with the supplied
assembly. The compiled `GOInMouInv` argument is zero at file offset `0x539`,
while both readable files say one. The discrepancy is preserved, not silently
reconciled. See [the QVM ledger](qvm.md) and `research/qvm/` for exact evidence.

## Toolchain and unresolved work

REA 6.4.0 is installed locally under `tools/rea/` with a dependency lockfile.
The host has a Java 21 runtime; matching full JDK compiler tools were added
locally because REA requires `javac`. Ghidra 12.1.4 was downloaded from the
official NSA GitHub release and its SHA-256 was verified before extraction:
`ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db`.
The matching Ubuntu compiler-package SHA-256 was verified as
`1a00b1e7c66ae36fbe0ad7e7521b7b5895b3cc934afcff987849d0719dafdd48`.
Native analysis uses this separately installed Ghidra engine;
see the saved readiness and native analysis records under `research/` for
the completed run's results.

Still unresolved: model vertex/index/UV layouts, terrain, placements,
collision, animation, camera/player units, AI, mission logic, full texture
semantics, reference runtime comparisons and all browser implementation.
There is currently no browser game, measured frame rate, memory budget or
validated graphics-parity claim.

The next visible milestone is an original textured model in a browser,
followed by the real first-level scene. See [the roadmap](roadmap.md).
