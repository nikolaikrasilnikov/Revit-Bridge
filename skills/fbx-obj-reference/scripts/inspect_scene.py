"""Read-only inventory of binary FBX 7.x and polygonal OBJ. Requires NumPy."""
import argparse
from collections import Counter
import json
from pathlib import Path
import struct
import zlib
import numpy as np


MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"


def read_fbx(path):
    data = Path(path).read_bytes()
    if not data.startswith(MAGIC) or len(data) < 27:
        raise ValueError("Expected binary FBX; ASCII FBX needs another reader")
    version = struct.unpack_from("<I", data, 23)[0]
    if not 7000 <= version < 8000:
        raise ValueError("Only FBX 7.x is supported")
    header_fmt = "<QQQB" if version >= 7500 else "<IIIB"
    header_size = struct.calcsize(header_fmt)

    def unpack(fmt, pos, limit):
        size = struct.calcsize(fmt)
        if pos + size > limit:
            raise ValueError("Truncated FBX property or node")
        return struct.unpack_from(fmt, data, pos), pos + size

    def node(pos, limit):
        (end, count, prop_size, name_len), pos = unpack(header_fmt, pos, limit)
        if end == 0:
            if count or prop_size or name_len:
                raise ValueError("Invalid FBX null record")
            return None, pos
        if not pos <= end <= limit or pos + name_len + prop_size > end:
            raise ValueError("FBX node extends outside its parent")
        name = data[pos:pos + name_len].decode("utf-8", errors="replace")
        pos += name_len
        prop_end = pos + prop_size
        props = []
        for _ in range(count):
            (raw_type,), pos = unpack("<c", pos, prop_end)
            kind = raw_type.decode("ascii")
            if kind in "YCFDIL":
                fmt = {"Y": "h", "C": "?", "F": "f", "D": "d", "I": "i", "L": "q"}[kind]
                (value,), pos = unpack("<" + fmt, pos, prop_end)
            elif kind in "SR":
                (size,), pos = unpack("<I", pos, prop_end)
                if pos + size > prop_end:
                    raise ValueError("Truncated FBX string/raw data")
                value = data[pos:pos + size]
                pos += size
                if kind == "S":
                    value = value.decode("utf-8", errors="replace")
            elif kind in "fdilbc":
                (length, encoding, size), pos = unpack("<III", pos, prop_end)
                dtype = np.dtype({"f": "<f4", "d": "<f8", "i": "<i4", "l": "<i8", "b": "?", "c": "i1"}[kind])
                expected = length * dtype.itemsize
                if expected > 512 * 1024 * 1024 or pos + size > prop_end:
                    raise ValueError("Oversized or truncated FBX array")
                raw = data[pos:pos + size]
                pos += size
                if encoding == 1:
                    decoder = zlib.decompressobj()
                    raw = decoder.decompress(raw, expected + 1)
                    if not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
                        raise ValueError("Invalid compressed FBX array")
                elif encoding != 0:
                    raise ValueError("Unknown FBX array encoding")
                if len(raw) != expected:
                    raise ValueError("FBX array size mismatch")
                value = np.frombuffer(raw, dtype=dtype)
            else:
                raise ValueError("Unsupported FBX property type: " + kind)
            props.append(value)
        if pos != prop_end:
            raise ValueError("FBX property-list size mismatch")
        children = []
        while pos < end:
            child, pos = node(pos, end)
            if child is None:
                if pos != end:
                    raise ValueError("Unexpected bytes after FBX node terminator")
                break
            children.append(child)
        return {"name": name, "props": props, "children": children}, end

    nodes, pos = [], 27
    while pos < len(data):
        item, pos = node(pos, len(data))
        if item is None:
            break
        nodes.append(item)
    return version, nodes


def children_named(node, name):
    return [c for c in node["children"] if c["name"] == name]


def bounds(points):
    points = np.asarray(points, dtype=float)
    if not len(points):
        return None
    if not np.isfinite(points).all():
        raise ValueError("Non-finite coordinate")
    return {"min": points.min(axis=0).tolist(), "max": points.max(axis=0).tolist()}


def properties70(node):
    result = {}
    for group in children_named(node, "Properties70"):
        for p in group["children"]:
            if p["name"] == "P" and len(p["props"]) >= 4:
                result[str(p["props"][0])] = p["props"][4:]
    return result


def inspect_fbx(path, limit=100):
    version, nodes = read_fbx(path)
    objects = [o for n in nodes if n["name"] == "Objects" for o in n["children"]]
    records = []
    for obj in objects:
        if obj["name"] != "Geometry":
            continue
        props = obj["props"]
        record = {"id": props[0], "name": str(props[1]).split("\x00")[0], "kind": props[-1]}
        for field, stride in (("Vertices", 3), ("Points", 4)):
            matches = children_named(obj, field)
            if matches:
                array = np.asarray(matches[0]["props"][0]).reshape(-1, stride)
                record[field + "Count"] = len(array)
                record[field + "LocalBounds"] = bounds(array[:, :3])
        indices = children_named(obj, "PolygonVertexIndex")
        if indices:
            ix = np.asarray(indices[0]["props"][0])
            record["polygonCount"] = int(np.count_nonzero(ix < 0))
            record["polygonStreamTerminated"] = not len(ix) or bool(ix[-1] < 0)
        records.append(record)
    models = [{"id": o["props"][0], "name": str(o["props"][1]).split("\x00")[0],
               "kind": o["props"][-1], "properties": properties70(o)}
              for o in objects if o["name"] == "Model"]
    connections = [c["props"] for n in nodes if n["name"] == "Connections" for c in n["children"] if c["name"] == "C"]
    report = {
        "format": "binary FBX", "version": version, "source": str(Path(path).resolve()),
        "coordinates": "Local geometry only; scene transforms, units and axes NOT applied",
        "nurbsBounds": "Bounds of control points, NOT evaluated trimmed surfaces",
        "settings": [properties70(n) for n in nodes if n["name"] == "GlobalSettings"],
        "objectCounts": dict(Counter(o["name"] for o in objects)),
        "geometryKinds": dict(Counter(str(r["kind"]) for r in records)),
        "geometryCount": len(records), "geometries": records[:limit],
        "modelCount": len(models), "models": models[:limit],
        "connectionCount": len(connections), "connections": connections[:limit],
        "listLimit": limit,
    }
    return report, nodes


def inspect_obj(path):
    vertices, objects, freeform = [], {}, Counter()
    current_object, current_group = "(default)", "(default)"
    polygon_sizes, extra_vertex_fields = Counter(), Counter()
    with Path(path).open(encoding="utf-8-sig", errors="replace") as stream:
        for line_number, line in enumerate(stream, 1):
            fields = line.partition("#")[0].split()
            if not fields:
                continue
            kind, values = fields[0], fields[1:]
            if kind == "v":
                if len(values) < 3:
                    raise ValueError(f"Line {line_number}: vertex requires XYZ")
                vertices.append([float(v) for v in values[:3]])
                if len(values) != 3:
                    extra_vertex_fields[len(values)] += 1
            elif kind == "o":
                current_object = " ".join(values) or "(unnamed)"
            elif kind == "g":
                current_group = " ".join(values) or "(default)"
            elif kind == "f":
                if len(values) < 3:
                    raise ValueError(f"Line {line_number}: face requires at least three vertices")
                record = objects.setdefault((current_object, current_group), {"faces": 0, "vertices": set()})
                for value in values:
                    index = int(value.split("/")[0])
                    if index == 0 or (index < 0 and -index > len(vertices)):
                        raise ValueError(f"Line {line_number}: invalid OBJ index")
                    record["vertices"].add(index - 1 if index > 0 else len(vertices) + index)
                record["faces"] += 1
                polygon_sizes[len(values)] += 1
            elif kind in ("curv", "curv2", "surf", "cstype", "deg", "trim", "hole", "l", "p"):
                freeform[kind] += 1
    verts = np.asarray(vertices, dtype=float).reshape(-1, 3)
    records = []
    for (name, group), record in objects.items():
        ix = sorted(record["vertices"])
        if ix and (ix[0] < 0 or ix[-1] >= len(verts)):
            raise ValueError("OBJ face references a missing vertex")
        records.append({"object": name, "group": group, "faceCount": record["faces"],
                        "referencedVertexCount": len(ix), "bounds": bounds(verts[ix])})
    return {"format": "OBJ", "source": str(Path(path).resolve()), "units": "unspecified",
            "coordinates": "Raw XYZ; no axis/scale transform; optional vertex fields not applied",
            "vertexCount": len(verts), "faceCount": sum(polygon_sizes.values()),
            "faceSizes": dict(polygon_sizes), "bounds": bounds(verts), "objects": records,
            "extraVertexFieldCounts": dict(extra_vertex_fields), "nonPolygonRecords": dict(freeform)}


def json_default(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, bytes):
        return {"rawHex": value.hex()}
    raise TypeError(type(value).__name__)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--nodes", type=Path, help="Optional full FBX tree (may be large)")
    parser.add_argument("--limit", type=int, default=100, help="Maximum entries per FBX summary list")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    targets = [p.resolve() for p in (args.out, args.nodes) if p]
    if args.source.resolve() in targets or len(set(targets)) != len(targets):
        parser.error("Source and output paths must be distinct")
    if args.source.suffix.lower() == ".fbx":
        report, nodes = inspect_fbx(args.source, args.limit)
        if args.nodes:
            args.nodes.write_text(json.dumps(nodes, default=json_default), encoding="utf-8")
    elif args.source.suffix.lower() == ".obj":
        if args.nodes:
            parser.error("--nodes is available only for FBX")
        report = inspect_obj(args.source)
    else:
        parser.error("Expected .fbx or .obj")
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=json_default), encoding="utf-8")
    print("Inventory saved:", args.out)


if __name__ == "__main__":
    main()
