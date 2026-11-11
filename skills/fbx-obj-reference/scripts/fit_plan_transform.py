"""Fit a proper rigid XY transform to paired, non-collinear anchors. Requires NumPy."""
import argparse
import json
from pathlib import Path
import numpy as np


def fit(source, target):
    source, target = np.asarray(source, dtype=float), np.asarray(target, dtype=float)
    if source.shape != target.shape or source.ndim != 2 or source.shape[1] != 2 or len(source) < 3:
        raise ValueError("Need matching Nx2 arrays with at least three pairs")
    if not np.isfinite(source).all() or not np.isfinite(target).all():
        raise ValueError("Coordinates must be finite")
    am, bm = source.mean(0), target.mean(0)
    a, b = source - am, target - bm
    if np.linalg.matrix_rank(a) < 2 or np.linalg.matrix_rank(b) < 2:
        raise ValueError("Anchors must not be collinear")
    u, _, vt = np.linalg.svd(a.T @ b)
    sign = np.eye(2)
    sign[-1, -1] = np.linalg.det(u @ vt)
    rotation = u @ sign @ vt
    translation = bm - am @ rotation
    residuals = np.linalg.norm(source @ rotation + translation - target, axis=1)
    return {"convention": "target_xy = source_xy @ rotation + translation",
            "scale": 1, "determinant": float(np.linalg.det(rotation)),
            "rotation": rotation.tolist(), "translation": translation.tolist(),
            "residuals": residuals.tolist(), "rms": float(np.sqrt(np.mean(residuals ** 2))),
            "maxResidual": float(residuals.max()), "pairs": len(source)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("anchors", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-residual", type=float, required=True, help="Tolerance in input units")
    args = parser.parse_args()
    if args.anchors.resolve() == args.out.resolve():
        parser.error("Input and output must differ")
    if not np.isfinite(args.max_residual) or args.max_residual < 0:
        parser.error("Tolerance must be finite and nonnegative")
    data = json.loads(args.anchors.read_text(encoding="utf-8-sig"))
    result = fit(data["source"], data["target"])
    result.update(units=data.get("units", "unspecified"), tolerance=args.max_residual,
                  accepted=result["maxResidual"] <= args.max_residual)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print("accepted=" + str(result["accepted"]), "maxResidual=" + str(result["maxResidual"]))
    raise SystemExit(0 if result["accepted"] else 2)


if __name__ == "__main__":
    main()
