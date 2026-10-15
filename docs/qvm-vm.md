# LOOP v8 QVM: the script virtual machine

This document describes how `igi.exe` executes `.qvm` bytecode, and how the
port reproduces it. It covers the opcode table, the VM's semantics, the
host-call convention, the AI event loop, and the run-time string-expression
language used for task conditions. It extends [qvm.md](qvm.md), which
covers the static, declarative reading of the same files.

- Implementation: `web-port/src/loaders/qvm-vm.ts` (`loadQvmProgram`,
  `runQvm`, `evaluateQvmExpression`).
- Python reference: `tools/igi_qvm_vm.py`. It is stdlib only and validates
  every `.qvm` file.
- Tests: `web-port/tests/qvm-vm.test.ts`.

Evidence labels:

- **[recovered]**: read from `igi.exe` code, with the function addresses
  cited. Image base is 0x400000, and the addresses are Ghidra `FUN_` names.
- **[observed]**: measured on the shipped files with `tools/igi_qvm_vm.py`.
- **[inferred]**: reasoning only.

Input identity (SHA-256):

| File | SHA-256 |
| --- | --- |
| `igi.exe` | `2b1673443e2635d97787344da5fab9d1ac6b717d34d18c5bab7f30749b1174c2` |
| `common/ai/guard.qvm` | `6e5640024e18c3c4c91f85a4321fcac743b2e85a777e6906ca38c51bd9ff3dc5` |
| `missions/location0/level1/ai/2209.qvm` | `8e37626ffef9a55fda1a301c9cd3509c0cc56e33bb5fbdbc7414473d5a283e6a` |

The [config triplet hashes](qvm.md#input-identity-and-validation) are listed
in qvm.md.

## 1. Where the VM lives

The exe ships a complete toolchain: a source parser and interpreter, a code
generator that writes `.qas`, an assembler that writes `.qvm`, and the VM
itself.

**Loading.** `Script_Load` is `FUN_004ae2f0`. It takes a `*.qsc` path and
looks for a `.qvm` beside it. If the `.qvm` exists and is not older than the
source, the exe loads it with `FUN_004b3430`. Otherwise it compiles the
source: `FUN_004b1ed0` writes the `.qas`, then the assembler `FUN_004b1490`
writes the `.qvm`. If neither step applies, it interprets the parsed source
tree directly. [recovered]

**Running.** `Script_Run` is `FUN_004ae7f0`. A loaded program runs through
`FUN_004b3290`, and a source program runs through the tree interpreter
`FUN_004b5c90`. [recovered]

## 2. File header and loader

The loader is `FUN_004b3430`. [recovered]

- The file must be at least 0x3c bytes. It must start with `LOOP` and the
  u32 version 8.
- The u32 at +8 must be **> 4**. Every shipped file has 5. [observed]
- The symbol and literal tables are laid out as in [qvm.md](qvm.md).
- The bytecode is at +0x2c, and its length is at +0x30.
- +0x34 is the data-stack size in bytes. 0 means 0x800, which is 512
  words.
- +0x38 is the type-stack size in entries. 0 means 0x100.
- Every shipped file has 0 at both +0x34 and +0x38, so the defaults apply.
  [observed]

The loader builds a per-program VM block with these fields:

| Offset | Field |
| --- | --- |
| [0] | code pointer |
| [1] | code size |
| [5] | pc |
| [6] / [7] | data / type stack index (the stacks grow downward) |
| [8] | error code |
| [9] / [10] | data / type stack base |
| [0xb] | halt flag |
| [0x18] / [0x19] | per-program caches of resolved symbol pointers |

## 3. VM model

**Starting a run** [recovered]. `FUN_004b3290` resets these fields and then
calls `FUN_004b31f0`:

- pc = 0
- both stacks empty
- error = 0

`FUN_004b31f0` loops on `handler = *(0x00a3be48 + op*0x18)` until the halt
flag (set by BRK) or an error code is set. `FUN_004b3640` fills the handler
table:

- 49 opcodes (0x00..0x30) by 6 slots each.
- Slot 0 executes the opcode.
- Slot 1 prints its mnemonic (`FUN_004b4ec0`).
- Slot 2 assembles it (`FUN_004b6b40`).

**Two parallel stacks** [recovered]:

- **The type stack** holds one entry per value. The tags are:
  - 1 int
  - 2 float
  - 3 string
  - 4 identifier text
  - 5 address
  - 6 symbol pointer
  - 7 data block
- **The data stack** holds 32-bit words. Ints, floats, symbols and addresses
  take one word each. A string takes a length word followed by its
  NUL-terminated text, padded to whole words. See `FUN_004b3060` and
  `FUN_004b2ee0`.

**Errors** [recovered]. Each error code maps to a message in `FUN_004b3290`.
On an error the run stops, and `FUN_004ae7f0` logs `Error in QVM program: %s
%s`. The error codes are:

| Code | Message |
| --- | --- |
| 1 | Stack underflow |
| 2 | Stack overflow |
| 3 | Internal error |
| 5 | Illegal instruction |
| 6 | Illegal operand(s) |
| 7 | Unknown identifier |
| 8 | Not a variable |
| 9 | Not a function |
| 10 | No function on stack |
| 11 | Syntax error |
| 12 | Undefined error, raised when BF/BT pops a non-number |
| 13 | Function argument overflow |
| 14 | Datablock not present |
| 15 | Index out of range |

The push helpers (`FUN_004b3c10`, `FUN_004b3c40`, `FUN_004b4b60`) do not
check for overflow. The port raises an error at the declared stack sizes
instead. [recovered / port choice]

**No VM state survives a run.** There are no variables, locals or
subroutines in the VM: `RET` and `JSR` are illegal opcodes. All
persistent state lives in host symbols, for example:

- `AIFunction_SetScriptIntegerValue` slots on the soldier
- task member variables such as `CutScene_1200.nTick`

The only thing kept between runs is the per-program symbol-pointer cache.
[recovered]

## 4. Opcode table

The mnemonics are the strings at 0x545a28..0x545b40, indexed by the switch
in `FUN_004b4ec0`. The handlers are as registered by `FUN_004b3640`.
[recovered]

The "Uses" column counts occurrences in all 118 shipped files. [observed]

| Op | Mnemonic | Operand | Semantics | Handler | Uses |
| --- | --- | --- | --- | --- | --- |
| 00 | BRK | none | Set the halt flag. This ends the run, or ends an argument block. | 4b4e90 | 46,478 |
| 01 | NOP | none | Does nothing; pc += 1. | 4b4e80 | 0 |
| 02 | PUSH | i32 | Push int. | 4b4b00 | 8 |
| 03 | PUSHB | **s8** | Push the sign-extended byte as int (`movsx`). | 4b4a80 | 3,845 |
| 04 | PUSHW | **s16** | Push the sign-extended short as int. | 4b4ac0 | 1,676 |
| 05 | PUSHF | f32 | Push float. | 4b4bb0 | 10,611 |
| 06 | PUSHA | u32 | Push an address (type 5). It is not a number. | 4b4b00 | 0 |
| 07 | PUSHS | inline C string | Push a string (type 3); pc += len+2. | 4b4be0 | 0 |
| 08/09/0a | PUSHSI/SIB/SIW | u32/u8/u16 literal index | Push the literal-table string. | 4b4c40 | 0 / 7,107 / 4,480 |
| 0b | PUSHI | inline C string | Push identifier text (type 4), resolved by name when popped. | 4b4be0 | 0 |
| 0c/0d/0e | PUSHII/IIB/IIW | u32/u8/u16 symbol index | Resolve the symbol now and push a symbol pointer (type 6). An unknown name is error 7. | 4b4c40 | 0 / 7,845 / 0 |
| 0f/10/11 | PUSH0/PUSH1/PUSHM | none | Push int 0, 1 or −1. | 4b4a40/4a20/4a60 | 6,506 / 7,131 / 0 |
| 12 | POP | none | Drop one value. | 4b3a70 | 1,948 |
| 13 | RET | none | Illegal (error 5). | 4b4ea0 | 0 |
| 14 | BRA | rel32 | pc = pc + 5 + rel. | 4b3940 | 4,971 |
| 15 | BF | rel32 | Pop a number; branch if it is 0 or 0.0. | 4b3940 | 426 |
| 16 | BT | rel32 | Pop a number; branch if it is non-zero. | 4b3940 | 0 |
| 17 | JSR | rel32 | Illegal (error 5). | 4b4ea0 | 0 |
| 18 | CALL | u32 n, n × u32 | Host call; see §5. | 4b3a90 | 4,545 |
| 19..29 | ADD SUB MUL DIV SHL SHR AND OR XOR LAND LOR EQ NE LT LE GT GE | none | Pop B (top), then A; push A op B. | 4b3e50 | ADD 5, MUL 19, LAND 26, EQ 337, NE 42, LT 31, GT 15 |
| 2a | ASSIGN | none | Pop a value, then a variable symbol; store the value (char/short/int/double/string by the variable's kind) and push the stored value. | 4b3c70 | 0 |
| 2b/2c/2d/2e | PLUS/MINUS/INV/NOT | none | Unary operators. INV and NOT accept an int only. | 4b48b0 | MINUS 5,139, NOT 12 |
| 2f | BLK | u32 len + bytes | Skip the inline data block. | 4b4b90 | 0 |
| 30 | ILLEGAL | none | Error 5. | 4b4ea0 | 0 |

Shipped files use 23 of the 49 opcodes. [observed]

### Correction to qvm.md

qvm.md reads `03` and `04` as unsigned. The VM sign-extends them. No
shipped operand reaches the sign bit, so both readings give the same
values on the shipped data. [observed]

- PUSHB values range from 2 to 127.
- PUSHW values range from 128 to 27,536.
- PUSH values range from 38,000 to 100,000.

### How the assembler chooses encodings

The assembler is `FUN_004b6c50`. [recovered]

**Integer `PUSH n`:**

| Value of n | Encoding |
| --- | --- |
| 0 | PUSH0 |
| 1 | PUSH1 |
| −1 | PUSHM |
| −128..127 | PUSHB |
| −32768..32767 | PUSHW |
| anything else | PUSH |

**Float `PUSHF x`:**

| Value of x | Encoding |
| --- | --- |
| 0.0 | PUSH0 |
| 1.0 | PUSH1 |
| −1.0 | PUSHM |
| anything else | PUSHF |

The float values 0.0, 1.0 and −1.0 therefore run as **ints**. This
explains why `config.qas` prints `PUSHF 1.000000` where the bytecode has
`10`.

**Strings and identifiers.** `PUSHS` and `PUSHI` get a u8, u16 or u32
table index by size.

The same handler (registered for opcodes 7 and 0x0b too) turns `PUSHS` /
`PUSHI` operands into table indices, so the inline-string forms 07 and 0b
are not produced by this assembler. [recovered] PUSHA, BLK, RET, JSR and the
other opcodes go through the generic slot-2 handler 0x4b7190, which was not
traced. None of them appears in a shipped file. [observed]

The compiler writes −1 as `PUSH1; MINUS`. It emits `&&` and `||` as LAND
and LOR, with no short circuit. It lowers if / else-if / else to
`cond; BF next; body; BRA end`. [observed]

The exe embeds the template source for `MISSION:AI/<id>.qsc` at 0x53ad08.
It begins:

```
if (AIFunction_GetCurrentEventType() == AIEVENT_CREATE) { AIFunction_DefaultHandler(); ... }
else if (... == AIEVENT_IDLE) {...}
else if (... == AIEVENT_ALARMON) {...}
else if (... == AIEVENT_COMBAT) { AIFunction_DefaultHandler(); }
else { AIFunction_DefaultHandler(); }
```

All 37 level-1 soldier scripts follow this template. Some fill in the IDLE,
ALARMON or CREATE branches. [observed]

### Arithmetic

These rules come from `FUN_004b3e50`, `FUN_004b4830`, `FUN_004b30e0` and
`FUN_004b48b0`. [recovered]

**Popping operands.** A symbol operand (type 6) is replaced by its getter's
value. The symbol's kind must be 0 (variable) or 2 (constant).

**Both operands int.** 32-bit wrap-around for `+ - *`. `/` is `idiv`, which
truncates toward zero; a divide by 0, or INT_MIN / −1, raises the CPU
divide fault. `<<` uses the count & 31, and `>>` is arithmetic. The bit
operators work as usual. `&&` and `||` give 0 or 1. Comparisons are signed
and give 0 or 1.

**Either operand float.** Both operands are converted to float32 (an int
by `fild; fstp DWORD`, `FUN_004b30e0`). `+ - * /` are `fld DWORD; f<op>
DWORD; fstp DWORD` (0x4b41ad–0x4b422b). In the exe's chop mode this gives
the exact result truncated to float32. Comparisons, `&&` and `||` give int
0 or 1. `<< >> & | ^` on floats are error 6. [recovered]

**Both operands strings.** `+` concatenates A then B. The comparisons use
`strcmp` byte order. Any other operator, or a string mixed with a number,
is an error.

**Unary operators.** `-` and `+` work on int or float. `~` and `!` accept
an int only; a float operand is error 6.

**Float to int.** Every float-to-int conversion is `fistp QWORD` followed
by a read of the low dword. Sites: GetArgInt 0x4b3139, 0x4b31c3,
`FUN_004ae220` 0x4ae234, int stores 0x4b3d47, and the evaluators 0x4af3bc
and 0x4af992. [recovered]

- igi.exe runs the FPU in **chop** mode: `FUN_004966d0` is applied, and
  checked with `fistp(−1.75) == −1`, on every main-loop pass (0x48dbc1).
  See gameplay.md "FPU rounding mode".
- So every conversion **truncates toward zero**: 2.9 → 2, −2.9 → −2,
  0.5 → 0.
- Values outside int32 keep their low 32 bits: 3e9 → −1294967296.
- NaN and ±∞ give 0, the low dword of the integer indefinite.
- `qvmRoundToInt` (qvm-vm.ts) and `fist` (tools/igi_qvm_vm.py) implement
  this; the first name is historical.

## 5. Host calls

The code layout of a call is [observed on all 4,545 CALLs]:

```
PUSHII fn; CALL n, off0..offn-1; BRA end; [argument block ending in BRK]*; end:
```

The instruction at `end:` is `POP` for a statement, or the BRK of the
enclosing argument block for a nested call. The argument offsets partition
`[after BRA, end)`.

### CALL

CALL is `FUN_004b3a90`. [recovered] It works in these steps:

1. Pop the symbol. If its kind is not 1 (function), that is error 9.
2. Build `args = {argc = n, mode = 1, 0, vm, &off0}`.
3. Call `handler(result24, symbol.userdata, &args)`.

**Arguments are not evaluated by CALL.** The handler pulls each argument
when it needs it, through one of three accessors:

- `Script_GetArgInt(args, i)`: `FUN_004aec60` → `FUN_004b2cd0`
- `Script_GetArgFloat`: `FUN_004aec90` → `FUN_004b3230`
- `Script_GetArgString(args, i, buf, size)`: `FUN_004aecc0` → `FUN_004b3260`

All three go through `FUN_004b2d00`. It saves pc and both stack pointers,
sets pc = off[i], and runs `FUN_004b31f0` until the block's BRK. It then
pops the value converted to the requested type, and restores pc and the
stacks.

The conversions are:

| Accessor | int | float | string |
| --- | --- | --- | --- |
| Int | the int | the float truncated (`fistp`, chop mode) | 0 |
| Float | the int as float32 (chopped) | the float | 0.0 |
| String | "" | "" | `strncpy` to size−1 |

When the arguments are in source mode (`mode = 0`) the same accessors
evaluate parse trees instead.

After the handler returns, CALL does the following:

1. Clear the halt flag.
2. Restore the stack pointers to their value just after the function symbol
   was popped.
3. Set pc to just past the offset table.
4. Push the handler's result.

The result is a 24-byte struct `{int i; double d @+8; char *s @+0x10}`.
The symbol's return type selects which field is pushed: float → `d`, string
→ `s`, anything else → `i`. The BRA then skips the argument blocks.

### Why lazy evaluation matters

Some handlers set a "symbol context" before they evaluate their child
arguments, using `Script_SetSymbolContext` (`FUN_004aeb70`, which sets
`symbol.userdata`):

- `Task_New` (`FUN_004e7420`) creates its task, then points `Task_New`'s
  context at the new task, then evaluates the remaining arguments. Those
  arguments are nested `Task_New` children.
- `DefineGroup` (`FUN_004e2610`) does the same for the `Define*` functions.

So the exe builds parent tasks before their children: pre-order. Eager
argument evaluation would give post-order. The test `lazy Task_New builds
parents before children` checks this on `mainmenu.qvm`.

`runQvm` evaluates arguments eagerly by default. A host can return true
from `lazyArgs(name)` to read arguments through `QvmCallContext` instead.
The AI handlers read each argument once, in order 0..n−1, so eager
evaluation is exact for them. [recovered]

### Result of a void function

For a void function, CALL pushes whatever int the handler left in its
result. Examples:

- `AIAction_Patrol` returns 3.
- `AIFunction_DefaultHandler` returns 1.

No shipped script uses the result of a void call: every such call is
followed by POP, or is a child argument. [observed] The port pushes 0.

### Symbol registration

All registration goes through `FUN_004b0d00`. It builds a 0x1c-byte symbol
`{kind, type, dynamic, size_or_arity, getter_or_handler, hash, userdata}`
in the global hash table `DAT_007d4560`. [recovered]

The registration wrappers are:

| Wrapper | Registers |
| --- | --- |
| `FUN_004aead0` | function returning void (kind 1, type 0) |
| `FUN_004aeb00` | function returning int (kind 1, type 1) |
| `FUN_004aeb30` | function returning float (kind 1, type 2) |
| `FUN_004aea50` | int constant (kind 2) |
| `FUN_004ae0c0` / `FUN_004ae1e0` | int variable |
| `FUN_004ae180` | short variable |
| `FUN_004ae120` | char variable |
| `FUN_004aeab0` / `FUN_004ae200` | double variable |
| `FUN_004ae270` | string variable |

Variables are kind 0. Their getters are at 4ae0e0, 4ae1a0, 4ae140, 4ae220
and 4ae2a0. Unregistering is `FUN_004aeb60` → `FUN_004b0d70`.

**Arity.** The 4th argument of a function registration is its arity, and −1
means variadic. The compiler enforces it with the errors "Too few / many
arguments". All 1,159 shipped calls to functions of known arity match.
[observed]

**Task members.** Tasks register their members as variables named
`<Type>_<id>.<member>`. For example `AreaActivate` does
`sprintf("%s.nActive")` and then calls `FUN_004ae0c0` at 0x4fb203.
[recovered] This is how AI bytecode reads `CutScene_1200.nTick` and
`AnimTask_1599.isRun`. Identifiers may contain `.`.

## 6. How scripts are entered

### Soldier AI

`HumanAI` creation is `FUN_0044f3a0`. It loads `MISSION:AI/<task id>.qsc`
into `human+0x3c68`. It also evaluates the soldier's AI-type string as an
int expression with `FUN_004ae9b0`, and stores the result in `human+0x3d30`.
[recovered]

At start-up, `FUN_0044b710` registers the AI functions (`FUN_0044bae0`) and
the constants (`FUN_0044dd00`). It then loads the 9 common scripts
`LOCAL:common/ai/{rpg,gunner,sniper,anya,ekk,priboi,civilian,patrol,guard}.qsc`.
[recovered]

**Which common script a type runs.** AITYPE → script is the table 0x53a8fc,
recovered (not inferred, as formats.md says):

| Script | AI types |
| --- | --- |
| rpg | 0 |
| gunner | 1 |
| sniper | 2 |
| anya | 3 |
| ekk | 4 |
| priboi | 5 |
| civilian | 6 |
| patrol | `*_PATROL_*` (7–10, 15–19, 23–25) |
| guard | `*_GUARD_*` (11–14, 20–22, 26–28) |

`observer.qvm` and `radioguard.qvm` are never loaded. Their names appear
nowhere in the exe.

**Per frame.** `FUN_0044e260` does the following [recovered]:

1. **First update.** It runs the soldier script once with event CREATE
   (slot 0) through `FUN_0044eac0(human, 0, -1)`.
2. **Death.** When the soldier dies, it runs the script once with DEAD (2).
3. **Otherwise it queues events** with `FUN_0044fb20` / `FUN_0044fb50`:
   - ENEMYDETECTION (22) and FRIENDLYDETECTION (23) from vision
   - ALARMON (8) and ALARMOFF (9) from the AlarmControl
   - ANIMATION (3) when the animation interval expires
   - IDLE (4) when the action stack is empty
4. **Event dispatch.** `FUN_0044eb80` walks the soldier's event-priority list
   `human+0x81c[]`. That list is filled, in call order, by
   `AIFunction_SetEventPriority`; an event type already present is ignored.
   - For each type that has queued events, and whose priority index is
     better than the current top action's priority, it runs the script
     with that event current, through `FUN_0044eac0`. This stops at the
     first run that produces an action.
   - It then clears that type's queue.
5. **Running the action.** `FUN_0044ecf0` runs the top of the action stack.

**One script run** is `FUN_0044eac0`. [recovered]

1. It sets the current human (`DAT_005c0f90`), the current event list
   (`DAT_005c0f98`) and the current priority (`DAT_005c0f9c`).
2. It empties the pending-action list (`DAT_005c0f94`).
3. It calls `Script_Run`.
4. `AIAction_*` handlers append `{fn, data, flags, priority}` records to the
   pending list (`FUN_0044fbe0`).

What happens after the run depends on how many actions are pending:

- **One action.** `FUN_0044fc40` first pops every top action that is not
  `AIACTIONFLAG_PUSHABLE`. It then pushes the new action, computes a
  reaction delay of (rand + 1) × 0.2 × 30 ticks, and starts it. Nothing ever
  reads that delay, so it has no effect ([ai.md](ai.md)); the random number
  is still drawn, which matters for the RNG order.
- **Several actions.** `FUN_0044fce0` pushes them as a sequence, all with
  the first one's flags.

**Default handler.** `AIFunction_DefaultHandler` (`FUN_0044cea0`) runs the
type's common script within the same event context. This is a nested
`Script_Run` of another program.

**Random numbers.** `GetRandomValue`, the reaction delays and
`GetAnimationToPlay` use the level RNG (`FUN_004aaa50` / `FUN_004aaa20`,
state at `DAT_00577b78+0x2c`). Each step updates the three-word state and
returns a value:

```
s2 ^= s0 >> 7;  s1 ^= s2;  s0 += s1
float = (s0 & 0xffff) / 65536
int   = s0 % n
```

### Mission, menus and sounds

These scripts are declarative: a straight-line list of calls.

- `mission.qvm` makes one `DefineMission` call.
- The menus use `Task_DeclareParameters` and `Task_New` trees.
- The sound files use `DefineGroup`, `DefineSound`, `DefineGraph` and
  `DefineTriggerOnce` trees.

Each is run once at load time with `Script_Run`. [recovered]

- **Tasks.** `objects.qsc` and the task scripts are run by `FUN_004e79e0`
  (Level_Load) and `FUN_004e7990`. Both set the `Task_New` context first.
- **Missions.** `DefineMission` is registered by `FUN_0041ab20`.
  `FUN_0041ad40` then scans `LOCAL:missions` with the callback 0x41aa50.
- **Sounds.** The `Define*` functions are registered by `FUN_004dcd10`, and
  the sound script is run at 0x4dcb9c–0x4dcbd7 after their contexts are set.

## 7. Host functions used by the mission-1 scripts

The return type in the "Args → ret" column is the native one. The
"Address" column is the handler. All entries are [recovered] from the cited
handler.

These terms are used throughout the table:

- **H** is the current soldier, `DAT_005c0f90`.
- **E** is the current event record, the head of `DAT_005c0f98`. Its type is
  at +8, its position (doubles) at +0x10, and its source at +0x28.
- **"queues action X"** means that `FUN_0044fe00` takes a record from the
  soldier's free list, the handler fills it, and `FUN_0044fbe0(X, rec,
  flags)` appends it. The last argument is always the AIACTIONFLAG.

**Unit conversions.** `WORLD_METER` = 4096 units per metre. Angles are
multiplied by 0.0174533 (π/180). Times are multiplied by 30 (`GAME_FREQUENCY`).

### Actions (`FUN_0044bae0`, all void)

| Function | Args → ret | Exe behaviour | Address |
| --- | --- | --- | --- |
| AIAction_Patrol | (pathId int, start int, flags) | Queues patrol action 0x48cc40; rec+8 = path, rec+0xc = start. | 44bf20 |
| AIAction_Combat | (flags) | Queues a combat action chosen by AI type (H+0x3d30): 0x48af60 for RPG, 0x48b6e0 for GUNNER, 0x48b420 for SNIPER, PRIBOI and every `*_GUARD_*` type, 0x489080 for ANYA / EKK, 0x488fc0 for every `*_PATROL_*` type. For CIVILIAN (6) it reads the flags argument but queues **nothing**, and returns 1. | 44bfa0 |
| AIAction_Dead | (flags) | Queues death action 0x488f90. | 44c0a0 |
| AIAction_FallFlat | (time float, flags) | Queues 0x48cec0. It returns early, reading no arguments, if the graph-node check `FUN_005006f0` succeeds (the soldier's current node has the STAIR criteria flag, [ai.md](ai.md)), or if E's target object (E+0x2c) is closer to H than the double at H+0x3db0 ("Combat liedown min distance"). | 44c100 |
| AIAction_Activate | (taskId int, bool, flags) | Queues 0x48ca40, which activates a task (switch or alarm). | 44c260 |
| AIAction_WalkToNode / RunToNode | (node int, flags) | Queues 0x48cf60 / 0x48cfc0. | 44c2e0 / 44c350 |
| AIAction_FireAtNode / FireAtTask | (target int, t0 float, t1 float, bool, flags) | Queues 0x48d020 / 0x48d160; times × 30 ticks. | 44c3c0 / 44c470 |
| AIAction_PlayAnimation | (anim int, flags) | Queues 0x48c2c0. | 44c520 |
| AIAction_PlaySound | (name string[32], bool, flags) | Queues 0x48c390. | 44c590 |
| AIAction_MoveToEvent | (bool, flags) | Copies E's position; queues 0x48c400. | 44c610 |
| AIAction_LookAtEvent | (float, flags) | Copies E's position; queues 0x48c4a0. | 44c6b0 |
| AIAction_Stunned | (time float, flags) | Queues 0x48c550. | 44c730 |
| AIAction_KickGrenade | (flags) | If E has a source object, queues 0x48c600. | 44c7a0 |
| AIAction_RunPanicking | (radius float, flags) | Copies E's position; queues 0x48c690. The argument is a flee radius in metres, not a time: the soldier panic-runs to a node outside that radius of the event ([ai.md](ai.md)). | 44c840 |
| AIAction_Idle | (flags) | Queues 0x48c930. | 44c8c0 |
| AIAction_SetCombat | (flags) | If E has a source, queues 0x48c960 with E's position and source / target. | 44c920 |
| ~~AIAction_LookAtToEvent~~ | — | **Not registered by the exe.** The string is absent. `sniper.qvm` calls it on DOOR / FENCE / LADDER when the event is not behind, which makes the run fail with error 7, so no action is queued. [observed + recovered] | — |

### Functions (`FUN_0044bae0`)

| Function | Args → ret | Exe behaviour | Address |
| --- | --- | --- | --- |
| AIFunction_GetCurrentEventType | () → int | E's type. A fatal error if there is no event. | 44cde0 |
| AIFunction_DefaultHandler | () → void (pushes 1) | Runs common script `[AITYPE_SCRIPT[H.aiType]]` in the same context. | 44cea0 |
| AIFunction_SetEventPriority | (event int) | Appends the event to H's priority list if absent. The first call is the highest priority. | 44cf00 |
| AIFunction_SetViewLength | (metres float) | H+0xb0 = v × 4096. Raises the alarm view length (H+0xb8) if it is smaller. | 44ca80 |
| AIFunction_SetAlarmViewLength | (metres float) | H+0xb8 = v × 4096. | 44cb10 |
| AIFunction_SetViewAlpha / SetViewGamma | (degrees float) | H+0xa0 / H+0xa8 = v × π/180. | 44cb70 / 44cbd0 |
| AIFunction_SetSecondary{ViewLength, AlarmViewLength, ViewAlpha, ViewGamma} | (float) | The same for the second view cone, at H+0xd0 / 0xd8 / 0xc0 / 0xc8. | 44cc30 / 44ccc0 / 44cd20 / 44cd80 |
| AIFunction_SetInvulnerability | (bool) | H+0x3ab8. | 44cf90 |
| AIFunction_SetInstantDeath | (bool) | H+0x3ab9 = (arg == 0). Note the inversion. | 44cff0 |
| AIFunction_SetDeathAnimation | (anim int) | H+0x3acc. | 44d050 |
| AIFunction_SetAlarmTriggerID / ControlID / Access / GunnerID | (int) | H+0x3abc / 0x3ac0 / 0x3ac8 / 0x3ac4. | 44d0b0 / 44d110 / 44d170 / 44d1d0 |
| AIFunction_GetAlarmTriggerID / ControlID / Access / GunnerID | () → int | Reads the same fields. | 44d230 / 44d270 / 44d2b0 / 44d2f0 |
| AIFunction_GetAlarmControlStatus | () → int | 0 if there is no control. Otherwise AlarmControl task `FUN_0043fdc0` (alarm on). | 44d330 |
| AIFunction_GetGunnerStatus | () → int | StationaryGun task `FUN_00473be0`, or 0. | 44d420 |
| AIFunction_SetScriptIntegerValue / GetScriptIntegerValue | (slot int, v int) / (slot) → int | H+0x3ad0 + 4 × slot. | 44d510 / 44d580 |
| AIFunction_SetScriptRealValue / GetScriptRealValue | (slot int, v float) / (slot) → float | H+0x3ae0 + 8 × slot, stored as doubles. | 44d5d0 / 44d640 |
| AIFunction_RemoveAlarmActions | () | Pops every action-stack entry whose priority index equals the int at H+0x83c. That int is entry 8 of the priority list, i.e. `list[AIEVENT_ALARMON]`. It reads like an exe bug that meant "the priority of ALARMON" [inferred]; the port should reproduce the literal comparison. | 44ca00 |
| AIFunction_GetRandomValue | (max float) → float | RNG float × max. | 44ce40 |
| AIFunction_IsEventBehind | () → int | 1 if any queued event of the current type has dot(eventPos − H.pos, H.forward) < 0. | 44d6a0 |
| AIFunction_GetEventDistance | () → float | Distance from E's position to H's position, in world units. A fatal error with no event. | 44d770 |
| AIFunction_GetAlarmTriggerDistance | () → float | Distance to the AlarmTrigger task, or −1. | 44d7f0 |
| AIFunction_SetAnimationInterval | (min s, rand s) | Times × 30 ticks. Countdown = min + rand % randTicks. On expiry the update queues AIEVENT_ANIMATION. | 44d930 |
| AIFunction_AddAnimationEntry | (anim int, weight float) | Up to 5 entries. | 44d9f0 |
| AIFunction_GetAnimationToPlay | () → int | Weighted random pick, or −1 with a warning if there are no entries. | 44daf0 |
| AIFunction_SendResponse | () | Posts ALERT_RESPONSE (6) with parameter 0x24 to E's source soldier. | 44dc90 |

### Other host functions

| Function | Used by | Behaviour | Address |
| --- | --- | --- | --- |
| DefineMission | mission.qvm | 11 arguments: (id int, name[32], desc[256], s[32], next int, path[256] ×3, s[32] ×3). It appends to the mission list at 0x577be0 and fails on a duplicate id. Registered with `FUN_0041ab20`. | 41ab50 |
| Task_New | menus, settings.qvm, objects.qvm | Variadic: (id, type, name, declared params..., children...). It creates the task, reads the params per the type's schema, sets the `Task_New` context to the new task, evaluates the children, then restores the context. | 4e7420 |
| Task_DeclareParameters | menus, settings.qvm, objects.qvm | A no-op at run time; editor schema only. | 4e73e0 |
| DefineGroup | sounds.qvm | Variadic: (name[32], children...). It sets the context of all four `Define*` functions to the new group. | 4e2610 |
| DefineSound / DefineGraph / DefineTriggerOnce | sounds.qvm | Sound definitions: two strings[32], then float and int parameters. | 4df830 / 4e18c0 / 4e0ab0 |
| _Script_SetWarningLevel, BreakScript | built-in | Set the warning level. BreakScript only sets a flag that the *source* interpreter checks; it is a no-op for `.qvm` programs. | 4aeea0 / 4aee50 |

### Constants (recovered values)

| Name | Value | Registered by |
| --- | --- | --- |
| AIEVENT_CREATE … FRIENDLYDETECTION | 0 … 23, in the order CREATE, DELETE, DEAD, ANIMATION, IDLE, ALERT, ALERT_RESPONSE, COMBAT, ALARMON, ALARMOFF, WALK, GROUNDIMPACT, DOOR, FENCE, LADDER, TAKINGDAMAGE, GUNSHOT, GRENADETHROWN, GRENADELAND, FLASHBANG, GUNSHOTMISS, EXPLOSION, ENEMYDETECTION, FRIENDLYDETECTION | `FUN_0044dd00` |
| AIACTIONFLAG_NONE / PUSHABLE | 0 / 1 | `FUN_0044dd00` |
| AIALARMACCESS_BEFORECOMBAT / AFTERCOMBAT | 0 / 1 | `FUN_0044dd00` |
| HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE / _SILENCED_RANGE | 0x1e000 / 0x1000 | `FUN_0044dd00` |
| AITYPE_RPG … SPETNAZ_GUARD_SPAS | 0 … 28, from the table at 0x53a970 | `FUN_0044dd00` |
| TRUE, ON / FALSE, OFF | 1 / 0 | `FUN_004aed60` |
| SCRIPT_WARNINGLEVEL_NO_WARNINGS / NORMAL / HIGH | 0 / 1 / 2 | `FUN_004aed60` |
| GAME_FREQUENCY | 30 | `FUN_004148b0` |
| WORLD_METER (double variable) | 4096.0 | `FUN_004148b0` |
| MATH_PI (double variable) | π | `FUN_004148b0` |
| MISSION_NEXT_MISSION_UNDEFINED | −1 | `FUN_0041ab20` |

### Behaviour of the shipped scripts [observed]

**guard.qvm on CREATE.** It calls `SetEventPriority` in this order:

```
DEAD, ALARMOFF, FLASHBANG, GRENADETHROWN, GRENADELAND, COMBAT, ALERT,
ENEMYDETECTION, GUNSHOT, TAKINGDAMAGE, GUNSHOTMISS, WALK, GROUNDIMPACT,
DOOR, FENCE, ALARMON, EXPLOSION, ANIMATION, IDLE, CREATE
```

It then calls `SetViewLength(40)`, `SetAlarmViewLength(50)`,
`SetViewAlpha(50)` and `SetViewGamma(45)`.

**2209.qvm on CREATE.** It calls `DefaultHandler`, `SetAlarmControlID(98)`
and `SetViewLength(20)`.

**3201.qvm.** It calls `SetEventPriority(AIEVENT_IDLE)` *before*
`DefaultHandler`. That makes IDLE its highest-priority event. This is the one
level-1 script that does not call `DefaultHandler` first, which corrects
formats.md.

## 8. String-expression language (task conditions)

`objects.qvm` stores task conditions as strings. There are 77 of them in
level 1, for example `AreaActivate_303.nActive && (Door_402.isClosed &&
Door_403.isClosed)`. The exe compiles them at run time with its own
source-script front end; this is not bytecode. [recovered]

### Rewriting

`FUN_004e80a0` rewrites the condition text before compiling it:

1. Each token is re-emitted with all whitespace dropped.
2. Take the decimal digits just before an identifier's first `.`, or at its
   end. If the identifier does not start with a digit, those digits are a
   task id (`FUN_004e8470`). If that task does not exist, the identifier
   becomes `0`. Otherwise the task is recorded as a dependency.
3. `this.` becomes `<own name>.`.
4. Any token containing `.isExists` becomes `1`.

The result, with `;` appended, is compiled by `FUN_004ae920`. It is
recompiled when a dependency is deleted (`FUN_004e83e0`).

### Lexer

The lexer is `FUN_004b5e80` with `FUN_00510f70`.

- **Operators:** `+ - * / << >> < > <= >= == != & ^ | && || ! ~ ? : = , ( ) ;`
- **Identifiers:** `[0-9A-Za-z_.]+`. Dots are part of the name.
- **Numbers:** decimal (int), or float with `.` / `e`. Hex is `0x…` or
  `$…`; hex numbers are parsed by `FUN_00511220`.
- **Strings:** double-quoted, with the escapes `\x \b \n \r \t`. Adjacent
  strings concatenate.

### Parser

The parser is `FUN_004aff10`. It is a precedence-climbing parser driven by
`FUN_004b0610`, where a lower number binds tighter:

| Level | Operators |
| --- | --- |
| 2 | unary `+ - ! ~`, right-associative |
| 3 | `* /` |
| 4 | `+ -` |
| 5 | `<< >>` |
| 6 | `< > <= >=` |
| 7 | `== !=` |
| 8 | `&` |
| 9 | `^` |
| 10 | `|` |
| 11 | `&&` |
| 12 | `||` |
| 13 | `?:`, right-associative |
| 14 | `=`, right-associative |
| 15 | `,` |

`name(args)` is a function call. There is no `%`, no `++` or `--`, and no
compound assignment.

### Evaluation

Task conditions are evaluated in **float** mode (`FUN_004af8a0`, called from
`FUN_004e8380`). The int mode is `FUN_004af360`.

| | Float mode | Int mode |
| --- | --- | --- |
| Arithmetic | Doubles; `+ − × ÷` round toward zero (chop mode, 0x4afa30–0x4afaa9) | Int; float literals truncated (0x4af3b9) |
| Comparisons | Give 1.0 / 0.0 | Give 1 / 0 |
| `&&` `\|\|` | **Short-circuit** | **Short-circuit** |
| `?:` | The condition is *converted to int by fistp* (0x4af992), which truncates, so 0.9 is false | As usual |
| `x / 0` | 0, with an error flag | 0, with an error flag |
| `& \| ^ << >> ~` | **Evaluate to 0** (no float case) | Supported |
| `,` | Evaluates both sides in int mode | As usual |
| Unknown identifier | Warns "Unknown identifier '%s' in expression", then 0 | Same |

An identifier calls its symbol getter, which gives an int / double pair. A
call `f(a)` passes argument parse trees, which the getter evaluates through
the same `Script_GetArg*` accessors in source mode.

Float and int modes can disagree. For example, `CutScene_1204.nTick >
11.35*GAME_FREQUENCY` compares against 340.5 in float mode but against 330
in int mode.

The port provides:

- `prepareQvmTaskExpression` for the rewriting
- `parseQvmExpression` and `evaluateQvmExpression(expr, scope, "float" |
  "int")` for parsing and evaluation

All 77 level-1 conditions parse and evaluate. [observed]

## 9. Validation

`python tools/igi_qvm_vm.py` (run from the repository root) prints:

```
qas cross-check config.qas: 377 instructions agree; operand differences: [{'code': 94, 'qas': 1.0, 'qvm': 0}]
files: 118  instructions: 113203  code bytes: 411996  CALLs: 4545  branches: 5397
decoding: every file decodes completely, ends with BRK, all branch/argument targets on instruction boundaries, every CALL in PUSHII/CALL/BRA/arg*/end layout
arity: 1159 calls to functions of known arity checked, mismatches: none
execution: 1222 complete runs (10813 host calls); aborted runs: 0
opcode usage: BRK 46478, PUSHF 10611, PUSHIIB 7845, PUSH1 7131, PUSHSIB 7107, PUSH0 6506, MINUS 5139, BRA 4971, CALL 4545, PUSHSIW 4480, PUSHB 3845, POP 1948, PUSHW 1676, BF 426, EQ 337, NE 42, LT 31, LAND 26, MUL 19, GT 15, NOT 12, PUSH 8, ADD 5
```

What the runs cover:

- **Execution runs:** 24 per AI script (48 scripts) plus 1 per other
  file, using a permissive recording host.
- **Cross-check:** the Python and TypeScript interpreters produce identical
  host-call traces on all 1,222 runs.
- **Assembler listing:** `config.qas` is the only `.qas` shipped, and
  `config.qsc` the only `.qsc`. The only operand difference is the known
  `GOInMouInv` value (see qvm.md).

`npx vitest run tests/qvm-vm.test.ts` passes 24 tests. They cover:

- the synthetic opcode semantics
- every staged `.qvm` running
- guard / 2209 / 1566 / 1667 / sniper / mission traces
- lazy `Task_New` order against the call-tree pre-order
- all `objects.qvm` conditions

## 10. Integration notes for the engine

**Programs.** Load each program once with `loadQvmProgram`:

- the 9 common scripts
- `MISSION:AI/<id>.qvm` for each `HumanAI`

**Soldier state.** Keep this per soldier:

- an event queue for each AIEVENT type
- the priority list
- an action stack of `{fn, data, flags, priority, delay}`
- the script slots
- the view parameters
- the alarm, gunner and trigger ids
- the animation table

**Per soldier, per frame**, follow `FUN_0044e260`:

1. **First frame.** Run the soldier script with CREATE.
2. **On death.** Run it once with DEAD.
3. **Queue events.** Queue the detection, alarm, animation-timer and
   IDLE-if-nothing-else events.
4. **Dispatch in priority order.** For each type in priority order: if it has
   queued events and its index is better than the top action's priority,
   run the script with that event current, and stop after the first run
   that queued an action. Clear that type's queue.
5. **Commit the actions.** After a run that queued exactly one action, pop
   the non-PUSHABLE actions from the top of the stack, then push the new
   one. Several queued actions are pushed as a sequence.

**Host implementation.** `call()` dispatches on the name.

- `AIFunction_GetCurrentEventType` returns the current event's type.
- `AIFunction_DefaultHandler` is `runQvm(commonScripts[QVM_AI_TYPE_SCRIPT[aiType]], sameHost)`.
- `value()` serves task members such as `CutScene_1200.nTick` and
  `AnimTask_1599.isRun`. `QVM_CONSTANTS` supplies the rest.

**Errors.** Treat a thrown `QvmError` as the exe does: log it and drop the
run's pending actions. Example: sniper's `AIAction_LookAtToEvent`.

**Implement these first for mission 1.** They are the functions the 48 AI
scripts call, ordered by their static call-site count. [observed]

| Function | Call sites |
| --- | --- |
| GetCurrentEventType | 325 |
| SetEventPriority | 177 |
| DefaultHandler | 111 |
| GetAlarmTriggerID | 64 |
| PlayAnimation | 60 |
| SetCombat | 56 |
| Patrol | 42 |
| Activate | 35 |
| GetRandomValue | 33 |
| GetScriptIntegerValue | 22 |
| RunPanicking | 17 |
| GetScriptRealValue | 16 |
| LookAtEvent | 15 |
| SetAlarmControlID | 13 |
| GetAlarmAccess | 12 |
| IsEventBehind | 12 |
| SetViewLength | 12 |
| SetViewAlpha | 11 |
| SetViewGamma | 11 |
| SetScriptIntegerValue | 11 |
| GetAlarmControlStatus | 10 |
| Dead | 9 |
| Idle | 9 |
| SetAlarmViewLength | 9 |
| GetAnimationToPlay | 9 |
| Combat | 8 |
| FallFlat | 8 |
| RemoveAlarmActions | 8 |
| SendResponse | 8 |
| SetScriptRealValue | 8 |
| SetInvulnerability | 5 |
| GetAlarmTriggerDistance | 4 |
| GetGunnerID | 4 |
| GetEventDistance | 3 |
| GetGunnerStatus | 2 |

**Units.** View lengths are metres × 4096 world units. Angles are degrees.
Script times are seconds × 30 ticks.

**Task conditions.** For task conditions, call `prepareQvmTaskExpression`
with the level's task-id set, then evaluate in float mode against the live
task members.

## 11. Open questions

**Native internals not traced.** The action implementations (0x488f90 …
0x48d160) and the event producers (vision, sound and alarm) were not
traced. Section 7 gives only their entry points.

**Float handling** [inferred]:

- The rounding mode is chop (recovered, gameplay.md "FPU rounding mode").
- Float literals are assumed to parse to the nearest double. The CRT
  `strtod` path uses integer arithmetic, so the FPU mode does not affect it.
- Float comparisons involving NaN are not modelled.

**Exe quirks not reproduced.** Neither affects any shipped script.
[recovered]

- Exact behaviour when a string-typed *variable* symbol is used as an
  operand. The exe pops it, then fails.
- In the expression parser, an argument list containing a `?:` lets the
  else-branch swallow later commas.

**Stack overflow.** The exe writes past its 512-word / 256-entry stacks;
the port throws instead.

**Hardcoded parser rules.** `prepareQvmTaskExpression` reproduces the
rewriting rules. Whether the task-id lookup (`FUN_004e7cd0`) uses the level
task id or a global id was not checked.

**Header +8.** Its meaning beyond "must exceed 4" is unknown. It may be a
compiler revision.
