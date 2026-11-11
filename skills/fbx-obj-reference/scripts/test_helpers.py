"""Offline checks: python -B test_helpers.py. No application or model writes."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
import numpy as np
from inspect_scene import MAGIC, read_fbx, inspect_obj
from fit_plan_transform import fit


class HelpersTest(unittest.TestCase):
    def test_obj_global_negative_indices_and_ngons(self):
        data = "v 0 0 0\nv 4 0 0\nv 4 3 0\nv 0 3 0\no first\nf 1 2 3 4\no second\nf -4/1 -2/2 -1/3\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fixture.obj"
            path.write_text(data)
            result = inspect_obj(path)
        self.assertEqual(result["vertexCount"], 4)
        self.assertEqual(result["faceCount"], 2)
        self.assertEqual(result["faceSizes"], {4: 1, 3: 1})
        self.assertEqual(result["objects"][1]["bounds"]["max"], [4, 3, 0])

    def test_obj_invalid_index_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.obj"
            path.write_text("v 0 0 0\nf 0 1 1\n")
            with self.assertRaises(ValueError):
                inspect_obj(path)

    def test_fbx_narrow_wide_compressed_and_raw_arrays(self):
        # Minimal binary records with known floating-point values; both header formats.
        for version in [7400, 7500]:
            for compressed in [False, True]:
                header_fmt = "<QQQB" if version >= 7500 else "<IIIB"
                size = struct.calcsize(header_fmt)
                raw = struct.pack("<ddd", 1.25, -3.0, 250.0)
                payload = zlib.compress(raw) if compressed else raw
                prop = b"d" + struct.pack("<III", 3, int(compressed), len(payload)) + payload
                name = b"Vertices"
                end = 27 + size + len(name) + len(prop)
                blob = MAGIC + struct.pack("<I", version)
                blob += struct.pack(header_fmt, end, 1, len(prop), len(name)) + name + prop
                blob += b"\0" * size
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "fixture.fbx"
                    path.write_bytes(blob)
                    actual_version, nodes = read_fbx(path)
                    self.assertEqual(actual_version, version)
                    np.testing.assert_allclose(nodes[0]["props"][0], [1.25, -3, 250])
                    path.write_bytes(blob[:35])
                    with self.assertRaises(ValueError):
                        read_fbx(path)

    def test_known_rigid_transform(self):
        source = np.array([[0, 0], [3400, 0], [0, 4500], [3400, 4500]])
        rotation = np.array([[0, 1], [-1, 0]])
        result = fit(source, source @ rotation + [120, -330])
        np.testing.assert_allclose(result["rotation"], rotation, atol=1e-12)
        np.testing.assert_allclose(result["translation"], [120, -330], atol=1e-9)
        self.assertLess(result["maxResidual"], 1e-9)

    def test_reflection_is_not_silently_accepted(self):
        source = np.array([[0, 0], [3400, 0], [0, 4500], [2300, 1700]])
        result = fit(source, source * [-1, 1])
        self.assertAlmostEqual(result["determinant"], 1)
        self.assertGreater(result["maxResidual"], 100)

    def test_degenerate_anchors_rejected(self):
        with self.assertRaises(ValueError):
            fit([[0, 0], [1, 0], [2, 0]], [[1, 1], [2, 1], [3, 1]])

    def test_cli_threshold_reports_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inp, out = root / "anchors.json", root / "fit.json"
            inp.write_text(json.dumps({"source": [[0, 0], [3, 0], [0, 4]],
                                       "target": [[0, 0], [30, 0], [0, 40]], "units": "mm"}))
            proc = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("fit_plan_transform.py")),
                                   str(inp), "--out", str(out), "--max-residual", "0.1"],
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertFalse(json.loads(out.read_text())["accepted"])


if __name__ == "__main__":
    unittest.main()
