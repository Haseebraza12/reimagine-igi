"""Boundary tests for untrusted binary parsing; no proprietary fixtures."""
import struct
import unittest

from igi_formats import FormatError, ilff_chunks, qvm_symbols, resource_members, texture_preview


def archive(alignment=4):
    data = bytearray(b"ILFF" + struct.pack("<3I", 0, alignment, 0) + b"IRES")
    data.extend(b"\0" * (-len(data) % alignment))
    for tag, payload, align, last in ((b"NAME", b"LOCAL:test.tex\0", 4, False),
                                       (b"BODY", b"abc", alignment, True)):
        start = len(data)
        payload_start = (start + 16 + align - 1) & -align
        delta = 0 if last else payload_start + len(payload) + (-len(payload) % 4) - start
        data.extend(tag + struct.pack("<3I", len(payload), align, delta))
        data.extend(b"\0" * (payload_start - len(data)))
        data.extend(payload)
        if not last:
            data.extend(b"\0" * (-len(data) % 4))
    struct.pack_into("<I", data, 4, len(data))
    return data


class FormatTests(unittest.TestCase):
    def test_resource_alignment_and_terminal_unpadded_payload(self):
        for alignment in (4, 32):
            data = archive(alignment)
            members = list(resource_members(data))
            self.assertEqual(len(members), 1)
            self.assertEqual(members[0][0], "LOCAL:test.tex")
            self.assertEqual(members[0][1].payload(data), b"abc")
            self.assertEqual(members[0][1].payload_offset % alignment, 0)

    def test_truncated_archive_is_rejected(self):
        data = archive()
        del data[-1]
        struct.pack_into("<I", data, 4, len(data))
        with self.assertRaises(FormatError):
            list(resource_members(data))

    def test_backward_link_is_rejected(self):
        data = archive()
        struct.pack_into("<I", data, 32, 4)
        with self.assertRaises(FormatError):
            list(ilff_chunks(data))

    def test_invalid_alignment_is_rejected(self):
        data = archive()
        struct.pack_into("<I", data, 8, 3)
        with self.assertRaises(FormatError):
            list(ilff_chunks(data))

    def test_texture_known_colors_and_tail_reporting(self):
        data = bytearray(32)
        data[:4] = b"LOOP"
        struct.pack_into("<II", data, 4, 11, 2)
        struct.pack_into("<5H", data, 22, 2, 1, 2, 1, 2)
        data.extend(struct.pack("<HH", 0xFC00, 0x03E0) + b"tail")
        meta, pixels = texture_preview(data)
        self.assertEqual(pixels, bytes((255, 0, 0, 255, 0, 255, 0, 0)))
        self.assertEqual(meta["tail_bytes"], 4)
        with self.assertRaises(FormatError):
            texture_preview(data[:34])

    def test_qvm_valid_and_out_of_bounds_symbol(self):
        data = bytearray(60)
        data[:4] = b"LOOP"
        struct.pack_into("<II", data, 4, 8, 5)
        struct.pack_into("<4I", data, 12, 60, 64, 4, 4)
        struct.pack_into("<2I", data, 44, 68, 1)
        data.extend(struct.pack("<I", 0) + b"Foo\0" + b"\x00")
        self.assertEqual(qvm_symbols(data)["symbols"][0]["name"], "Foo")
        struct.pack_into("<I", data, 60, 4)
        with self.assertRaises(FormatError):
            qvm_symbols(data)


if __name__ == "__main__":
    unittest.main()
