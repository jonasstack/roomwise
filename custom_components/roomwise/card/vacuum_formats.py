"""Map formats of robot vacuum integrations — pure parsing, no Home Assistant needed (tested on its own).

Two conventions are read here:

* The map camera of the Xiaomi Vacuum Map Card world (Dreame Vacuum, Xiaomi Cloud Map Extractor and others): a
  camera / image entity whose attributes carry `calibration_points` (three points, vacuum ↔ image pixels),
  `vacuum_position` {x, y, a}, `charger_position` (Dreame) or `charger` (Map Extractor), `rooms` {id: {x0, y0,
  x1, y1, name, …}}, `path` {path: [[{x, y}, …], …]} (Map Extractor). Coordinates are the robot's own (mm).
  Inside Home Assistant these values are often objects with `as_dict()` (that is how they reach the frontend), so
  everything here accepts dicts, objects and lists alike.
* Valetudo's "Map data" camera: a tiny PNG with the whole ValetudoMap JSON deflated in a zTXt chunk named
  "ValetudoMap". Coordinates and pixel size are in cm; layers (floor / segment / wall) hold pixels as runs
  [x, y, count, …] (`compressedPixels`), entities (robot_position, charger_location, path …) hold flat point
  lists [x0, y0, x1, y1, …].

Everything returned is in robot millimetres, so the rest (learning, trail, alignment) does not care which kind
of robot it is.
"""

from __future__ import annotations

from io import BytesIO
import json
import math
from typing import Any
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
VALETUDO_KEY = b"ValetudoMap"
FLOOR_STEP = 100  # mm between two floor points of the map
WALL_STEP = 50  # mm between two wall points


def plain(v: Any, depth: int = 0) -> Any:
    """Objects with as_dict() (Dreame, Map Extractor) and read-only mappings as plain dicts / lists"""
    if depth > 6:
        return None
    if hasattr(v, "as_dict") and not isinstance(v, dict):
        try:
            v = v.as_dict()
        except Exception:  # noqa: BLE001
            return None
    if isinstance(v, dict) or (hasattr(v, "items") and hasattr(v, "keys")):
        return {k: plain(x, depth + 1) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [plain(x, depth + 1) for x in v]
    return v


def num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def point(v: Any) -> tuple[float, float] | None:
    """{x, y}, an object with x / y, or [x, y]"""
    if v is None:
        return None
    if not isinstance(v, (dict, list, tuple)) and hasattr(v, "x") and hasattr(v, "y"):
        x, y = num(v.x), num(v.y)
    else:
        v = plain(v)
        if isinstance(v, dict):
            x, y = num(v.get("x")), num(v.get("y"))
        elif isinstance(v, list) and len(v) >= 2:
            x, y = num(v[0]), num(v[1])
        else:
            return None
    return (x, y) if x is not None and y is not None else None


class Calibration:
    """Robot coordinates ↔ image pixels from three calibration points (affine)"""

    def __init__(self, vac: list[tuple[float, float]], img: list[tuple[float, float]]) -> None:
        (v0, v1, v2), (p0, p1, p2) = vac, img
        det = (v1[0] - v0[0]) * (v2[1] - v0[1]) - (v2[0] - v0[0]) * (v1[1] - v0[1])
        if not det:
            raise ValueError("degenerate calibration")

        def solve(q0: float, q1: float, q2: float) -> tuple[float, float, float]:
            a = ((q1 - q0) * (v2[1] - v0[1]) - (q2 - q0) * (v1[1] - v0[1])) / det
            b = ((q2 - q0) * (v1[0] - v0[0]) - (q1 - q0) * (v2[0] - v0[0])) / det
            return a, b, q0 - a * v0[0] - b * v0[1]

        self.ax, self.bx, self.cx = solve(p0[0], p1[0], p2[0])
        self.ay, self.by, self.cy = solve(p0[1], p1[1], p2[1])
        self.idet = self.ax * self.by - self.bx * self.ay
        if not self.idet:
            raise ValueError("degenerate calibration")

    def to_px(self, x: float, y: float) -> tuple[float, float]:
        return self.ax * x + self.bx * y + self.cx, self.ay * x + self.by * y + self.cy

    def to_robot(self, i: float, j: float) -> tuple[float, float]:
        dx, dy = i - self.cx, j - self.cy
        return (self.by * dx - self.bx * dy) / self.idet, (-self.ay * dx + self.ax * dy) / self.idet

    @property
    def units_per_px(self) -> float:
        """Robot units per image pixel"""
        return 1 / math.sqrt(abs(self.idet))


def calibration(cal: Any) -> Calibration | None:
    """The `calibration_points` attribute ([{vacuum: {x, y}, map: {x, y}}, …]; also a JSON string, as Valetudo
    renderers publish it in a sensor), or None when missing or degenerate (Dreame sends all zeros before it has
    a map)"""
    if isinstance(cal, str):
        try:
            cal = json.loads(cal)
        except ValueError:
            return None
    cal = plain(cal)
    if not isinstance(cal, list) or len(cal) < 3:
        return None
    vac, img = [], []
    for c in cal[:3]:
        if not isinstance(c, dict):
            return None
        v, m = point(c.get("vacuum")), point(c.get("map"))
        if v is None or m is None:
            return None
        vac.append(v)
        img.append(m)
    try:
        return Calibration(vac, img)
    except ValueError:
        return None


def rooms_of(attrs: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Rooms / segments of a map camera: id → {"box": (x0, y0, x1, y1) or None, "name": str or None}"""
    out: dict[str, dict[str, Any]] = {}
    rooms = plain(attrs.get("rooms"))
    items: list[tuple[Any, Any]] = []
    if isinstance(rooms, dict):
        items = list(rooms.items())
    elif isinstance(rooms, list):
        items = [(r.get("id", r.get("room_id")) if isinstance(r, dict) else None, r) for r in rooms]
    for key, r in items:
        if key is None or not isinstance(r, dict):
            continue
        box = tuple(num(r.get(k)) for k in ("x0", "y0", "x1", "y1"))
        name = r.get("name") or r.get("custom_name")
        out[str(key)] = {"box": box if all(b is not None for b in box) else None, "name": str(name) if name else None}
    # Map Extractor: names (or just numbers) of the rooms in `room_numbers`
    numbers = plain(attrs.get("room_numbers"))
    if isinstance(numbers, dict):
        for key, name in numbers.items():
            out.setdefault(str(key), {"box": None, "name": None})
            if name and not out[str(key)]["name"]:
                out[str(key)]["name"] = str(name)
    elif isinstance(numbers, list):
        for key in numbers:
            if isinstance(key, (int, str)):
                out.setdefault(str(key), {"box": None, "name": None})
    return out


def path_of(attrs: dict[str, Any]) -> list[tuple[float, float]]:
    """The run's path of a map camera (Map Extractor: {path: [[{x, y}, …], …]}); empty when it has none"""
    p = plain(attrs.get("path"))
    if isinstance(p, dict):
        p = p.get("path")
    if not isinstance(p, list):
        return []
    pts: list[tuple[float, float]] = []
    for part in p:
        for q in part if isinstance(part, list) and part and not isinstance(part[0], (int, float)) else [part]:
            xy = point(q)
            if xy is not None:
                pts.append(xy)
    return pts


def charger_of(attrs: dict[str, Any]) -> tuple[float, float] | None:
    return point(attrs.get("charger_position")) or point(attrs.get("charger"))


def map_from_image(image: bytes | None, cal: Calibration, rooms: dict[str, dict[str, Any]], charger: tuple[float, float] | None, unit: float = 1.0) -> dict[str, Any] | None:
    """Floor per room and walls of a rendered map camera image, in robot millimetres.

    Each room's colour is the colour most of its box is painted in (two rooms may share a colour: a point goes
    to the smallest box of that colour around it). Walls are the map's wall grey. Without an image the rooms'
    boxes stand in for their floor (coarse, but enough to align by names).
    """
    upx = cal.units_per_px * unit  # mm per pixel
    boxed = {rid: r for rid, r in rooms.items() if r.get("box")}
    out_rooms: dict[str, list[list[int]]] = {rid: [] for rid in rooms}
    walls: list[list[int]] = []
    floor_res, wall_res = FLOOR_STEP, WALL_STEP

    def smallest(cands: list[str]) -> str:
        return min(cands, key=lambda rid: abs((boxed[rid]["box"][2] - boxed[rid]["box"][0]) * (boxed[rid]["box"][3] - boxed[rid]["box"][1])))

    def inside(rid: str, x: float, y: float, margin: float = 0) -> bool:
        x0, y0, x1, y1 = boxed[rid]["box"]
        return min(x0, x1) - margin <= x <= max(x0, x1) + margin and min(y0, y1) - margin <= y <= max(y0, y1) + margin

    im = None
    if image:
        try:
            from PIL import Image

            im = Image.open(BytesIO(image)).convert("RGBA")
        except Exception:  # noqa: BLE001 — not an image we can read: boxes only
            im = None
    if im is None:
        step = FLOOR_STEP / unit
        for rid, r in boxed.items():
            x0, y0, x1, y1 = r["box"]
            x = min(x0, x1)
            while x <= max(x0, x1):
                y = min(y0, y1)
                while y <= max(y0, y1):
                    if smallest([k for k in boxed if inside(k, x, y)]) == rid:
                        out_rooms[rid].append([round(x * unit), round(y * unit)])
                    y += step
                x += step
    else:
        w, h = im.size
        px = im.load()
        floor_step = max(1, round(FLOOR_STEP / upx))
        wall_step = max(1, round(WALL_STEP / upx))
        floor_res, wall_res = round(floor_step * upx), round(wall_step * upx)

        def rgb(i: int, j: int) -> tuple[int, int, int] | None:
            c = px[i, j]
            return None if c[3] < 128 else (c[0], c[1], c[2])

        # background: what the border is painted in (or transparent)
        border: dict[Any, int] = {}
        for i in range(0, w, 3):
            for j in (0, h - 1):
                c = rgb(i, j)
                border[c] = border.get(c, 0) + 1
        for j in range(0, h, 3):
            for i in (0, w - 1):
                c = rgb(i, j)
                border[c] = border.get(c, 0) + 1
        background = max(border, key=border.get) if border else None
        counts: dict[tuple[int, int, int], int] = {}
        for j in range(0, h, 2):
            for i in range(0, w, 2):
                c = rgb(i, j)
                if c is not None and c != background:
                    counts[c] = counts.get(c, 0) + 1
        total = sum(counts.values()) or 1
        wall: tuple[int, int, int] | None = (93, 109, 126)  # Xiaomi / Map Extractor default
        if wall not in counts:
            greys = [c for c, n in counts.items() if n > total * 0.003 and max(c) - min(c) < 30]
            wall = min(greys, key=sum) if greys else None
        colour: dict[str, tuple[int, int, int]] = {}
        for rid, r in boxed.items():
            x0, y0, x1, y1 = r["box"]
            ia, ja = cal.to_px(x0, y0)
            ib, jb = cal.to_px(x1, y1)
            local: dict[tuple[int, int, int], int] = {}
            for j in range(int(max(0, min(ja, jb))), int(min(h, max(ja, jb))), 2):
                for i in range(int(max(0, min(ia, ib))), int(min(w, max(ia, ib))), 2):
                    c = rgb(i, j)
                    if c is None or c == background or c == wall or min(c) > 235:
                        continue
                    local[c] = local.get(c, 0) + 1
            if local:
                colour[rid] = max(local, key=local.get)
        by_colour: dict[tuple[int, int, int], list[str]] = {}
        for rid, c in colour.items():
            by_colour.setdefault(c, []).append(rid)
        margin = FLOOR_STEP / unit
        if not by_colour:
            # no rooms known: everything painted that is not wall counts as one floor
            out_rooms = {"floor": []}
            rooms = {**rooms, "floor": {"box": None, "name": None}}
        for j in range(0, h, floor_step):
            for i in range(0, w, floor_step):
                c = rgb(i, j)
                if not by_colour:
                    if c is not None and c != background and c != wall and min(c) <= 235:
                        x, y = cal.to_robot(i, j)
                        out_rooms["floor"].append([round(x * unit), round(y * unit)])
                    continue
                cands = by_colour.get(c) if c is not None else None
                if not cands:
                    continue
                x, y = cal.to_robot(i, j)
                fit = [rid for rid in cands if inside(rid, x, y, margin)]
                if fit:
                    out_rooms[smallest(fit)].append([round(x * unit), round(y * unit)])
        if wall is not None:
            for j in range(0, h, wall_step):
                for i in range(0, w, wall_step):
                    if rgb(i, j) == wall:
                        x, y = cal.to_robot(i, j)
                        walls.append([round(x * unit), round(y * unit)])
    rooms_out = [{"id": rid, "name": rooms[rid].get("name"), "pts": pts} for rid, pts in out_rooms.items() if pts]
    if not rooms_out and not walls:
        return None
    return {
        "rooms": rooms_out,
        "walls": walls,
        "charger": [round(charger[0] * unit), round(charger[1] * unit)] if charger else None,
        "floor_res": floor_res,
        "wall_res": wall_res,
    }


# ---------- Valetudo ----------


def valetudo_json(data: bytes | None) -> dict[str, Any] | None:
    """The ValetudoMap inside the PNG of Valetudo's "Map data" camera (zTXt chunk "ValetudoMap"); also plain or
    deflated JSON (the raw map-data topic)"""
    if not data:
        return None
    try:
        if data[:8] != PNG_SIGNATURE:
            raw = data if data[:1] in (b"{", b"[") else zlib.decompress(data)
            vm = json.loads(raw)
            return vm if isinstance(vm, dict) and "layers" in vm else None
        pos = 8
        while pos + 8 <= len(data):
            length = int.from_bytes(data[pos : pos + 4], "big")
            kind = data[pos + 4 : pos + 8]
            body = data[pos + 8 : pos + 8 + length]
            if kind == b"zTXt":
                key, _, rest = body.partition(b"\0")
                # rest: one byte compression method (0 = deflate), then the deflated text
                if key == VALETUDO_KEY and len(rest) > 1:
                    vm = json.loads(zlib.decompress(rest[1:]))
                    return vm if isinstance(vm, dict) else None
            if kind == b"IEND":
                break
            pos += 12 + length
    except (ValueError, zlib.error):
        return None
    return None


def _pairs(flat: Any) -> list[tuple[float, float]]:
    if not isinstance(flat, list):
        return []
    return [(float(flat[k]), float(flat[k + 1])) for k in range(0, len(flat) - 1, 2) if num(flat[k]) is not None and num(flat[k + 1]) is not None]


def _pixels(layer: dict[str, Any]):
    """Pixels (x, y) of a layer: runs [x, y, count, …] or (older Valetudo) a flat list [x, y, …]"""
    comp = layer.get("compressedPixels")
    if isinstance(comp, list) and comp:
        for k in range(0, len(comp) - 2, 3):
            x0, y, n = int(comp[k]), int(comp[k + 1]), int(comp[k + 2])
            for i in range(n):
                yield x0 + i, y
        return
    pix = layer.get("pixels")
    if isinstance(pix, list):
        for k in range(0, len(pix) - 1, 2):
            yield int(pix[k]), int(pix[k + 1])


def valetudo_summary(vm: dict[str, Any]) -> dict[str, Any]:
    """What changes during a run: robot, dock, path (Valetudo cm) and the segments (id, name)"""
    robot = charger = None
    angle = None
    path: list[tuple[float, float]] = []
    for e in vm.get("entities") or []:
        if not isinstance(e, dict):
            continue
        kind = e.get("type")
        pts = _pairs(e.get("points"))
        if kind == "robot_position" and pts:
            robot = pts[0]
            angle = num((e.get("metaData") or {}).get("angle"))
        elif kind == "charger_location" and pts:
            charger = pts[0]
        elif kind == "path":
            path.extend(pts)
    segments = []
    for layer in vm.get("layers") or []:
        if isinstance(layer, dict) and layer.get("type") == "segment":
            meta = layer.get("metaData") or {}
            if meta.get("segmentId") is not None:
                segments.append({"id": str(meta["segmentId"]), "name": meta.get("name") or None})
    return {"robot": robot, "angle": angle, "charger": charger, "path": path, "segments": segments, "pixel": num(vm.get("pixelSize")) or 5.0}


def valetudo_map(vm: dict[str, Any]) -> dict[str, Any] | None:
    """Floor per segment and walls of a ValetudoMap, robot millimetres"""
    ps = num(vm.get("pixelSize")) or 5.0  # cm per pixel
    mm = ps * 10
    floor_step = max(1, round(FLOOR_STEP / mm))
    wall_step = max(1, round(WALL_STEP / mm))
    rooms: list[dict[str, Any]] = []
    floor: list[list[int]] = []
    walls: list[list[int]] = []
    for layer in vm.get("layers") or []:
        if not isinstance(layer, dict):
            continue
        kind = layer.get("type")
        if kind == "wall":
            walls.extend([round((x + 0.5) * mm), round((y + 0.5) * mm)] for x, y in _pixels(layer) if x % wall_step == 0 and y % wall_step == 0)
        elif kind in ("segment", "floor"):
            pts = [[round((x + 0.5) * mm), round((y + 0.5) * mm)] for x, y in _pixels(layer) if x % floor_step == 0 and y % floor_step == 0]
            if kind == "floor":
                floor.extend(pts)
            elif pts:
                meta = layer.get("metaData") or {}
                rooms.append({"id": str(meta.get("segmentId", len(rooms) + 1)), "name": meta.get("name") or None, "pts": pts})
    if not rooms and floor:
        # not segmented yet: the whole floor as one room
        rooms.append({"id": "floor", "name": None, "pts": floor})
    if not rooms and not walls:
        return None
    s = valetudo_summary(vm)
    return {
        "rooms": rooms,
        "walls": walls,
        "charger": [round(s["charger"][0] * 10), round(s["charger"][1] * 10)] if s["charger"] else None,
        "floor_res": round(floor_step * mm),
        "wall_res": round(wall_step * mm),
    }
