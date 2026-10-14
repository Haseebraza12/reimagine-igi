"""Static parser boundary and conservative recovery tests, using synthetic data."""
from pathlib import Path
import struct
import unittest

from igi_formats import FormatError
from igi_qvm import QVM, validate_config


def fixture(code, symbols=("Host", "CONST"), strings=("hello",)):
    data = bytearray(60)
    data[:4] = b"LOOP"
    struct.pack_into("<II", data, 4, 8, 5)

    def section(values):
        table = len(data)
        raw = bytearray()
        for value in values:
            data.extend(struct.pack("<I", len(raw)))
            raw.extend(value.encode("latin1") + b"\0")
        strings_start = len(data)
        data.extend(raw)
        return table, strings_start, len(values) * 4, len(raw)

    struct.pack_into("<4I", data, 12, *section(symbols))
    struct.pack_into("<4I", data, 28, *section(strings))
    struct.pack_into("<2I", data, 44, len(data), len(code))
    data.extend(code)
    return data


def call_code(arguments):
    start = 12 + 4 * len(arguments)
    targets = []
    for arg in arguments:
        targets.append(start)
        start += len(arg)
    blocks = b"".join(arguments)
    return (b"\x0d\x00\x18" + struct.pack("<I", len(arguments))
            + b"".join(struct.pack("<I", value) for value in targets)
            + b"\x14" + struct.pack("<i", len(blocks)) + blocks + b"\x12\x00")


class QVMTests(unittest.TestCase):
    def test_literal_recovery_and_evidence_offsets(self):
        args = [b"\x0f\x00", b"\x10\x00", b"\x03\x20\x00",
                b"\x04\x80\x02\x00", b"\x05" + struct.pack("<f", .4) + b"\x00",
                b"\x0d\x01\x00", b"\x09\x00\x00"]
        qvm = QVM(fixture(call_code(args)))
        report = qvm.calls()
        self.assertEqual(report["status"], "complete")
        recovered = report["calls"][0]["arguments"]
        self.assertEqual([a["value"] for a in recovered],
                         [0, 1, 32, 640, struct.unpack("<f", struct.pack("<f", .4))[0], "CONST", "hello"])
        self.assertIn("numeric_type", recovered[1])
        for arg, raw in zip(recovered, args):
            self.assertEqual(qvm.data[arg["file_offset"]:arg["file_offset"] + arg["byte_count"]], raw)

    def test_push_u32_reads_four_byte_immediate(self):
        # Same bytes as humanplayer.qvm general-argument positions 41 and 42.
        qvm = QVM(fixture(call_code([b"\x02\xa0\x86\x01\x00\x00", b"\x03\x20\x00"])))
        report = qvm.calls()
        self.assertEqual(report["status"], "complete")
        first, second = report["calls"][0]["arguments"]
        self.assertEqual(first["instructions"][0]["mnemonic"], "PUSH_U32")
        self.assertEqual(first["value"], 100000)
        self.assertEqual(second["value"], 32)

    def test_unknown_argument_does_not_guess_or_hide_later_constants(self):
        qvm = QVM(fixture(call_code([b"\x7e\xa0\x86\x01\x00\x00", b"\x03\x20\x00"])))
        report = qvm.calls()
        self.assertTrue(report["top_level_complete"])
        self.assertEqual(report["status"], "partial")
        first, second = report["calls"][0]["arguments"]
        self.assertEqual(first["instructions"][0]["mnemonic"], "UNKNOWN")
        self.assertNotIn("value", first)
        self.assertEqual(second["value"], 32)
        self.assertEqual(qvm.disassemble()["status"], "partial")

    def test_minus_negates_a_numeric_literal(self):
        argument = b"\x05" + struct.pack("<f", 3.5) + b"\x2c\x00"
        arg = QVM(fixture(call_code([argument]))).calls()["calls"][0]["arguments"][0]
        self.assertEqual(arg["status"], "recovered")
        self.assertEqual(arg["value"], -3.5)
        self.assertTrue(arg["negated"])

    def test_minus_on_a_string_is_not_folded(self):
        arg = QVM(fixture(call_code([b"\x09\x00\x2c\x00"]))).calls()["calls"][0]["arguments"][0]
        self.assertEqual(arg["status"], "unresolved")
        self.assertNotIn("value", arg)

    def test_truncated_operand_and_bad_reference_rejected(self):
        for code in (b"\x05\x00", b"\x0d\xff", b"\x09\xff", b"\x18\xff\xff\xff\xff"):
            with self.subTest(code=code), self.assertRaises(FormatError):
                QVM(fixture(code)).disassemble()

    def test_argument_targets_must_partition_branch_region(self):
        code = bytearray(call_code([b"\x10\x00", b"\x10\x00"]))
        struct.pack_into("<I", code, 7, 21)  # Actual first argument starts at 20.
        with self.assertRaises(FormatError):
            QVM(fixture(code)).calls()

    def test_literal_table_boundaries_and_termination(self):
        data = fixture(b"\x00")
        struct.pack_into("<I", data, struct.unpack_from("<I", data, 28)[0], 100)
        with self.assertRaises(FormatError):
            QVM(data)
        data = fixture(b"\x00")
        data[-2] = ord("x")
        with self.assertRaises(FormatError):
            QVM(data)

    def test_branch_target_outside_code_rejected(self):
        with self.assertRaises(FormatError):
            QVM(fixture(b"\x14" + struct.pack("<i", -6))).disassemble()

    def test_paired_config_when_local_game_files_available(self):
        path = Path(__file__).resolve().parents[1] / "Game Files/config.qvm"
        if not path.exists():
            self.skipTest("optional user-owned paired config fixtures are absent")
        report = validate_config(path.read_bytes(), path.with_suffix(".qsc").read_text(),
                                 path.with_suffix(".qas").read_text())
        self.assertEqual(report["calls"], 43)
        self.assertEqual(report["arguments"], 102)
        self.assertEqual(report["status"], "paired evidence differs")
        self.assertEqual([d["evidence"] for d in report["differences"]], ["qsc", "qas"])
        self.assertTrue(all(d["file_offset"] == 1337 and d["actual"] == 0
                            for d in report["differences"]))


if __name__ == "__main__":
    unittest.main()
