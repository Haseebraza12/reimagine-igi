# Evidence ledger

Every recovered value used by the web port, with its source and confidence.
Confidence: `observed` (measured from original data), `recovered` (static
analysis), `inferred` (assumption pending verification).

| ID | Behavior / value | Source | Confidence | Unknowns |
|----|------------------|--------|------------|----------|
| E001 | EXE is PE32, imports DDRAW/DINPUT/DSOUND/WINMM (no D3D8/9) | `objdump -p Game Files/igi.exe` | observed | renderer may be DirectDraw-only or D3D7 via surfaces |
| E002 | `.res` = ILFF/IRES container (4-byte tag + size + align + delta chain) | `tools/igi_formats.py:ilff_chunks` on all 53 .res | observed | nested-archive edge cases |
| E003 | LOOP v11 textures: 32-byte header; fmt2/bpp2 = A1R5G5B5 (inferred bit order); fmt3,67/bpp4 = BGRA8888 (inferred) | `tools/igi_formats.py:texture_preview` on level1.res members | recovered (pixel layout inferred) | mip tail interpretation, fmt 3 vs 67 difference |
| E004 | `.qvm` = LOOP-tagged bytecode VM; config.qvm has .qsc source + .qas disassembly as ground truth | Game Files/config.qsc, config.qas | observed | most opcodes still unmapped |
| E005 | `igi.exe` sha256 2b1673443e2635d97787344da5fab9d1ac6b717d34d18c5bab7f30749b1174c2 | hashes/igi.exe.sha256 | observed | n/a |

Add rows as work proceeds. Never record a value as observed without a file+method.
