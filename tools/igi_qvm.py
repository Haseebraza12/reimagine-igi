"""Conservative, static LOOP v8 reader; never executes bytecode or host calls.

Only encodings corroborated by shipped evidence are named:
 - 0x00/03/04/05/09/0d/0f/10/12/14/18 are corroborated by the paired
   config.qsc + config.qas + config.qvm triad (see docs/qvm.md).
 - 0x0a (PUSHS16) is corroborated by objects.qvm blocks whose u16 literal
   indices start at exactly 256 and match DConv-decompiled strings.
 - 0x2c (MINUS, unary negate) is corroborated by objects.qvm: all 2,380
   `<number>; 2c; BRK` blocks decompile as the negated number in
   objects.qsc, and a full call-tree parse of objects.qvm agrees with that
   decompile on 18,105 of 18,127 nodes (the rest are later text edits).
   constant_argument() folds exactly `<number literal>; MINUS; BRK` into a
   negative value and records `negated: true`; see docs/qvm.md.
 - 0x02 (PUSH_U32) is recovered, not paired-validated: config.qvm never
   contains it. Every occurrence (humanplayer.qvm `02 a0 86 01 00 00`,
   weaponconfig.qvm `02 70 94 00 00 00`) is an argument block that ends
   with BRK exactly when the operand is four bytes, and QVM_REFERENCE names
   the same encoding. Values read as unsigned 32-bit integers.
"""
import argparse
import json
import math
from pathlib import Path
import re
import struct

from igi_formats import FormatError, qvm_symbols, u32


class QVM:
    def __init__(self, data):
        self.data = data
        self.meta = qvm_symbols(data)
        self.base = self.meta["code_offset"]
        self.code = data[self.base:]
        self.symbols = self.meta["symbols"]
        table, strings, table_size, strings_size = struct.unpack_from("<4I", data, 28)
        symbol_end = u32(data, 16) + u32(data, 24)
        if (table < symbol_end or table_size % 4 or table + table_size != strings
                or strings + strings_size != self.base):
            raise FormatError("invalid literal-string section bounds")
        self.strings = []
        for pos in range(table, strings, 4):
            relative = u32(data, pos)
            if relative >= strings_size:
                raise FormatError("literal-string offset outside section")
            start = strings + relative
            end = data.find(b"\0", start, strings + strings_size)
            if end < 0:
                raise FormatError("unterminated literal string")
            self.strings.append({"value": data[start:end].decode("latin1"),
                                 "literal_file_offset": start})

    def instruction(self, offset, limit=None):
        """Decode one instruction. Unknown means stop, never guess its size."""
        limit = len(self.code) if limit is None else limit
        if not 0 <= offset < limit <= len(self.code):
            raise FormatError("instruction outside code bounds")
        opcode = self.code[offset]
        item = {"code_offset": offset, "file_offset": self.base + offset,
                "opcode": opcode}

        def operand(fmt):
            size = struct.calcsize(fmt)
            if offset + 1 + size > limit:
                raise FormatError(f"truncated instruction at code {offset:#x}")
            return struct.unpack_from(fmt, self.code, offset + 1)[0], size + 1

        if opcode in (0x00, 0x12):
            item.update(mnemonic="BRK" if opcode == 0 else "POP", size=1)
        elif opcode in (0x0f, 0x10):
            # Paired source proves 0x10 can stand for PUSH 1 AND PUSHF 1.0.
            item.update(mnemonic="PUSH_CONST", size=1, kind="number",
                        value=0 if opcode == 0x0f else 1,
                        numeric_type="not encoded by observed instruction")
        elif opcode in (0x02, 0x03, 0x04, 0x05):
            fmt, mnemonic = {2: ("<I", "PUSH_U32"), 3: ("<B", "PUSH_U8"),
                             4: ("<H", "PUSH_U16"), 5: ("<f", "PUSHF")}[opcode]
            value, size = operand(fmt)
            if isinstance(value, float) and not math.isfinite(value):
                raise FormatError("non-finite float literal is unsupported")
            item.update(mnemonic=mnemonic, size=size, kind="number", value=value)
        elif opcode in (0x09, 0x0a, 0x0d):
            # 0x09/0x0a index the literal-string table (u8/u16); 0x0d the
            # identifier table (u8). objects.qvm uses 0x0a for every string
            # index >= 256 (first is 256 -> "Playback").
            fmt = "<H" if opcode == 0x0a else "<B"
            index, size = operand(fmt)
            entries = self.symbols if opcode == 0x0d else self.strings
            if index >= len(entries):
                raise FormatError(f"reference index outside table at code {offset:#x}")
            mnemonic = {0x09: "PUSHS", 0x0a: "PUSHS16", 0x0d: "PUSHI"}[opcode]
            item.update(mnemonic=mnemonic, size=size, index=index,
                        kind="symbol" if opcode == 0x0d else "string")
            if opcode == 0x0d:
                item.update(value=entries[index]["name"],
                            symbol_file_offset=entries[index]["offset"])
            else:
                item.update(entries[index])
        elif opcode == 0x14:
            displacement, size = operand("<i")
            target = offset + size + displacement
            if not 0 <= target < len(self.code):
                raise FormatError("branch target outside code")
            item.update(mnemonic="BRA", size=size, displacement=displacement,
                        target_code_offset=target)
        elif opcode == 0x18:
            count, _ = operand("<I")
            size = 5 + count * 4
            if offset + size > limit:
                raise FormatError("CALL argument-offset table exceeds code bounds")
            targets = list(struct.unpack_from(f"<{count}I", self.code, offset + 5))
            if any(target >= len(self.code) for target in targets):
                raise FormatError("CALL argument target outside code")
            item.update(mnemonic="CALL", size=size, argument_code_offsets=targets)
        elif opcode == 0x2c:
            # Unary negate (QVM_REFERENCE V5 MINUS). Paired evidence:
            # objects.qvm code 0x23704 (`05 c4 0f 55 4c 2c 00` = PUSHF
            # 55852816.0; MINUS; BRK) pairs with objects.qsc:1175, which
            # prints -55852816.0 for the HumanPlayer Y position. The
            # instruction is named and sized here, but constant_argument
            # still refuses to fold literal+MINUS into a value.
            item.update(mnemonic="MINUS", size=1, role="unary negate")
        else:
            item.update(mnemonic="UNKNOWN", status="unsupported opcode; size unknown")
        if "size" in item:
            item["bytes"] = self.code[offset:offset + item["size"]].hex(" ")
        return item

    def disassemble(self, start=0, end=None):
        end = len(self.code) if end is None else end
        if not 0 <= start <= end <= len(self.code):
            raise FormatError("disassembly range outside code")
        instructions = []
        pos = start
        while pos < end:
            item = self.instruction(pos, end)
            instructions.append(item)
            if item["mnemonic"] == "UNKNOWN":
                break
            pos += item["size"]
        return {"status": "complete" if pos == end else "partial",
                "stop_code_offset": pos, "instructions": instructions}

    def constant_argument(self, start, end, index):
        decoded = self.disassemble(start, end)
        instructions = decoded["instructions"]
        item = {"index": index, "code_offset": start, "file_offset": self.base + start,
                "byte_count": end - start, "bytes": self.code[start:end].hex(" "),
                "status": "unresolved", "instructions": instructions}
        negated = (decoded["status"] == "complete" and len(instructions) == 3
                   and instructions[0].get("kind") == "number"
                   and instructions[1]["mnemonic"] == "MINUS"
                   and instructions[2]["mnemonic"] == "BRK")
        if negated or (decoded["status"] == "complete" and len(instructions) == 2
                       and instructions[0].get("kind") in ("number", "symbol", "string")
                       and instructions[1]["mnemonic"] == "BRK"):
            literal = instructions[0]
            value = -literal["value"] if negated else literal["value"]
            item.update(status="recovered", kind=literal["kind"], value=value)
            if negated:
                item["negated"] = True
            for key in ("literal_file_offset", "symbol_file_offset", "numeric_type"):
                if key in literal:
                    item[key] = literal[key]
        else:
            item["reason"] = "argument is not a supported single literal followed by BRK"
        return item

    def calls(self):
        """Recognize only the source-validated top-level constant-call layout.

        CALL's listed argument offsets let us inspect independent blocks even
        when an opcode inside another argument is unsupported. No guessed
        instruction sizes or scan-for-byte resynchronization is involved.
        """
        calls = []
        pos = 0
        reason = None
        while pos < len(self.code):
            function = self.instruction(pos)
            if function["mnemonic"] == "BRK" and pos + 1 == len(self.code):
                pos += 1
                break
            if function["mnemonic"] != "PUSHI":
                reason = "unsupported top-level layout: expected PUSHI function reference"
                break
            call_pos = pos + function["size"]
            call = self.instruction(call_pos)
            if call["mnemonic"] != "CALL":
                reason = "unsupported top-level layout: expected CALL"
                break
            branch_pos = call_pos + call["size"]
            branch = self.instruction(branch_pos)
            if branch["mnemonic"] != "BRA":
                reason = "unsupported top-level layout: expected BRA over argument blocks"
                break
            start = branch_pos + branch["size"]
            end = branch["target_code_offset"]
            targets = call["argument_code_offsets"]
            if (end < start or (targets and targets[0] != start)
                    or any(a >= b for a, b in zip(targets, targets[1:]))
                    or any(not start <= target < end for target in targets)
                    or (not targets and start != end)):
                raise FormatError("CALL arguments do not partition the skipped region")
            pop = self.instruction(end)
            if pop["mnemonic"] != "POP":
                reason = "unsupported top-level layout: branch target is not POP"
                break
            arguments = [self.constant_argument(a, b, index)
                         for index, (a, b) in enumerate(zip(targets, targets[1:] + [end]))]
            calls.append({"function": function["value"], "function_kind": "symbol reference",
                          "code_offset": pos, "file_offset": self.base + pos,
                          "call_code_offset": call_pos, "call_file_offset": self.base + call_pos,
                          "symbol_file_offset": function["symbol_file_offset"],
                          "arguments": arguments})
            pos = end + pop["size"]
        recovered = sum(arg["status"] == "recovered" for c in calls for arg in c["arguments"])
        total = sum(len(c["arguments"]) for c in calls)
        return {"version": 8, "code_offset": self.base, "code_size": len(self.code),
                "status": "complete" if pos == len(self.code) and recovered == total else "partial",
                "top_level_complete": pos == len(self.code), "stop_code_offset": pos,
                "stop_reason": reason, "call_count": len(calls), "argument_count": total,
                "recovered_argument_count": recovered, "calls": calls,
                "limitations": "Static symbolic call sites only; host behavior and numeric parameter meanings unknown."}

    def call_tree(self):
        """Every top-level statement as a nested call tree (no execution).

        Grammar recovered from objects.qvm (all 1,418 calls; matches the
        community decompile on 18,105 of 18,127 nodes, the rest being later
        text edits):
            statement := PUSHI fn; CALL offsets; BRA end; arg*; end: POP
            nested    := PUSHI fn; CALL offsets; BRA end; arg*; end: BRK
            arg       := (literal [MINUS] | nested) BRK
        Returns [{"fn": name, "args": [...]}, ...]; literals become numbers or
        strings, TRUE/FALSE booleans, other identifiers {"symbol": name}.
        Raises FormatError on anything outside that grammar.
        """
        def call_at(pos, terminator):
            name = self.instruction(pos)
            if name["mnemonic"] != "PUSHI":
                raise FormatError(f"expected PUSHI function at code {pos:#x}")
            call = self.instruction(pos + name["size"])
            if call["mnemonic"] != "CALL":
                raise FormatError(f"expected CALL at code {pos + name['size']:#x}")
            branch = self.instruction(pos + name["size"] + call["size"])
            if branch["mnemonic"] != "BRA":
                raise FormatError(f"expected BRA at code {pos + name['size'] + call['size']:#x}")
            start = pos + name["size"] + call["size"] + branch["size"]
            end = branch["target_code_offset"]
            targets = call["argument_code_offsets"]
            if not ((not targets and start == end) or (
                    targets[0] == start and all(a < b for a, b in zip(targets, targets[1:]))
                    and targets[-1] < end)):
                raise FormatError(f"CALL arguments do not partition the skipped region at code {pos:#x}")
            args = [argument(a, b) for a, b in zip(targets, targets[1:] + [end])]
            if self.instruction(end)["mnemonic"] != terminator:
                raise FormatError(f"call at code {pos:#x} does not end with {terminator}")
            return {"fn": name["value"], "args": args}, end + 1

        def argument(start, end):
            first = self.instruction(start, end)
            if (first["mnemonic"] == "PUSHI" and first["value"] not in ("TRUE", "FALSE")
                    and start + first["size"] < end
                    and self.instruction(start + first["size"])["mnemonic"] == "CALL"):
                node, after = call_at(start, "BRK")
                if after != end:
                    raise FormatError(f"nested call at code {start:#x} does not fill its argument")
                return node
            item = self.constant_argument(start, end, 0)
            if item["status"] != "recovered":
                raise FormatError(f"unsupported argument expression at code {start:#x}")
            if item["kind"] == "symbol":
                return {"TRUE": True, "FALSE": False}.get(item["value"], {"symbol": item["value"]})
            return item["value"]

        statements = []
        pos = 0
        while pos < len(self.code):
            if self.code[pos] == 0 and pos + 1 == len(self.code):
                return statements
            node, pos = call_at(pos, "POP")
            statements.append(node)
        raise FormatError("bytecode does not end with BRK")


def source_calls(source):
    """Parse only the simple call statements supplied in config.qsc."""
    calls = []
    for line in source.splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r"\s*([A-Za-z_]\w*)\((.*)\);\s*", line)
        if not match:
            raise FormatError("unsupported source statement")
        args = []
        for token in re.split(r',(?=(?:[^"]*"[^"]*")*[^"]*$)', match[2]):
            token = token.strip()
            if token.startswith('"'):
                args.append(("string", json.loads(token)))
            elif re.fullmatch(r"[A-Za-z_]\w*", token):
                args.append(("symbol", token))
            elif re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", token):
                args.append(("number", float(token)))
            elif token:
                raise FormatError("unsupported source argument")
        calls.append((match[1], args))
    return calls


def validate_config(data, source, assembly):
    """Cross-check all paired evidence, preserving stale source discrepancies.

    The shipped text prints floats at six decimals. Compare that precision,
    while retaining the exact float32 value in the bytecode report.
    """
    qvm = QVM(data)
    report = qvm.calls()
    expected = source_calls(source)
    differences = []

    def agrees(expected_value, actual_value, float_literal=False):
        if float_literal:
            return math.isclose(expected_value, actual_value, rel_tol=0, abs_tol=0.0000005)
        return expected_value == actual_value

    if not report["top_level_complete"] or len(expected) != len(report["calls"]):
        raise FormatError("source call count/layout mismatch")
    for (function, args), call in zip(expected, report["calls"]):
        if function != call["function"] or len(args) != len(call["arguments"]):
            raise FormatError("source function/arity mismatch")
        for (kind, value), arg in zip(args, call["arguments"]):
            if arg["status"] != "recovered" or arg["kind"] != kind:
                raise FormatError("source argument kind mismatch")
            if not agrees(value, arg["value"], arg["instructions"][0]["mnemonic"] == "PUSHF"):
                differences.append({"evidence": "qsc", "function": function,
                                    "argument_index": arg["index"], "expected": value,
                                    "actual": arg["value"], "file_offset": arg["file_offset"]})
    decoded = qvm.disassemble()
    if decoded["status"] != "complete":
        raise FormatError("unsupported opcode in paired assembly fixture")
    instructions = decoded["instructions"]
    rows = []
    labels = {}
    for line in assembly.splitlines():
        text = line.strip()
        if not text:
            continue
        if text.endswith(":"):
            labels[text[:-1]] = instructions[len(rows)]["code_offset"] if len(rows) < len(instructions) else len(qvm.code)
        else:
            rows.append(text.split(None, 1))
    if len(rows) != len(instructions):
        raise FormatError("assembly instruction count mismatch")
    aliases = {"PUSH_U8": "PUSH", "PUSH_U16": "PUSH", "PUSH_U32": "PUSH", "PUSHS16": "PUSHS"}
    for row, ins in zip(rows, instructions):
        mnemonic, operand = row[0], row[1] if len(row) == 2 else ""
        actual = ins["mnemonic"]
        if actual == "PUSH_CONST":
            if mnemonic not in ("PUSH", "PUSHF"):
                raise FormatError("assembly compact constant mnemonic mismatch")
            if float(operand) != ins["value"]:
                differences.append({"evidence": "qas", "expected": float(operand),
                                    "actual": ins["value"], "file_offset": ins["file_offset"]})
        elif mnemonic != aliases.get(actual, actual):
            raise FormatError("assembly mnemonic mismatch")
        elif mnemonic in ("PUSH", "PUSHF"):
            value = float(operand)
            if not agrees(value, ins["value"], mnemonic == "PUSHF"):
                differences.append({"evidence": "qas", "expected": value,
                                    "actual": ins["value"], "file_offset": ins["file_offset"]})
        elif mnemonic in ("PUSHI", "PUSHS"):
            value = json.loads(operand) if mnemonic == "PUSHS" else operand
            if value != ins["value"]:
                raise FormatError("assembly reference operand mismatch")
        elif mnemonic == "CALL":
            names = [name.strip() for name in operand.strip("()").split(",") if name.strip()]
            if [labels[name] for name in names] != ins["argument_code_offsets"]:
                raise FormatError("assembly CALL target mismatch")
        elif mnemonic == "BRA" and labels[operand] != ins["target_code_offset"]:
            raise FormatError("assembly branch target mismatch")
    return {"status": "paired evidence differs" if differences else "paired evidence agrees",
            "calls": len(expected), "arguments": report["argument_count"],
            "instructions": len(instructions), "code_bytes": len(qvm.code),
            "differences": differences, "float_comparison": "within six-decimal source precision"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--disassemble", action="store_true")
    parser.add_argument("--validate-config", action="store_true",
                        help="validate against adjacent .qsc and .qas files")
    args = parser.parse_args()
    data = args.file.read_bytes()
    if args.validate_config:
        report = validate_config(data, args.file.with_suffix(".qsc").read_text(),
                                 args.file.with_suffix(".qas").read_text())
    else:
        qvm = QVM(data)
        report = qvm.disassemble() if args.disassemble else qvm.calls()
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
