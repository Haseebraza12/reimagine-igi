"""Mission task decoding (tools/level_tasks.py) on the local level-1 files.

Skips when the user-owned game files are absent.
"""
from pathlib import Path
import unittest

from level_tasks import read_tasks, terrain_inputs

LEVEL = Path(__file__).resolve().parents[1] / "Game Files" / "missions" / "location0" / "level1"


@unittest.skipUnless((LEVEL / "objects.qvm").exists(), "optional user-owned game files are absent")
class LevelTaskTests(unittest.TestCase):
    def test_every_task_decodes_with_its_schema(self):
        tasks = read_tasks((LEVEL / "objects.qvm").read_bytes())
        self.assertEqual(len(tasks), 1362)
        player = next(t for t in tasks if t["type"] == "HumanPlayer")
        self.assertEqual(player["name"], "TheGoodGuy")
        self.assertEqual(player["params"]["Position"], [24578514.0, -55852816.0, 174421680.0])
        truck = next(t for t in tasks if t["id"] == 1099)
        self.assertEqual((truck["type"], truck["params"]["Model"]), ("Car", "622_01_1"))
        graph = next(t for t in tasks if t["type"] == "AIGraph" and t["id"] == 4019)
        self.assertEqual(graph["params"]["Graphdata"], [264, 300, 876])

    def test_terrain_inputs(self):
        data = terrain_inputs((LEVEL / "objects.qvm").read_bytes(),
                              (LEVEL / "terrain" / "terrain.qvm").read_bytes())
        self.assertEqual(sorted(data["materials"]), [0, 1, 2, 3, 4, 5])
        self.assertTrue(all(len(m["levels"]) == 32 for m in data["materials"].values()))
        self.assertEqual(len(data["tilemaps"]), 8)
        self.assertEqual(data["tilemaps"][2][:4], [3, 4, 3, 4])
        self.assertEqual(len(data["texture_modifiers"]), 9)
        self.assertEqual(len(data["terrain_lightmaps"]), 268)
        self.assertEqual(len(data["heightmaps"]), 3)
        self.assertEqual(sorted(k["time"] for k in data["dirlight_keyframes"]), [12.0, 100.0])


if __name__ == "__main__":
    unittest.main()
