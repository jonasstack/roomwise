"""A small demo flat for the fake robots (test only): two rooms side by side with a door between them.

Plan coordinates (cm): living room 0..400 × 0..300, kitchen 400..700 × 0..300, door in the shared wall at
y 100..190, dock in the living room's lower left corner. The robot drives lanes through both rooms.

Each fake robot has its own coordinates, as the real ones do:
  * Dreame-like (mm, y up):     x = 10·px − 2000, y = 1500 − 10·py
  * Valetudo-like (cm, y down): x = px + 200,     y = py + 300
"""

from __future__ import annotations

from io import BytesIO
import json
import math
import struct
import zlib

ROOMS = [
    {"id": 1, "name": "Wohnzimmer", "box": (0, 0, 400, 300), "colour": (171, 199, 248)},
    {"id": 2, "name": "Küche", "box": (400, 0, 700, 300), "colour": (249, 224, 125)},
]
DOOR = (100, 190)  # y range of the door at x = 400
DOCK = (25, 275)  # plan cm
SPEED = 60.0  # cm/s along the lanes (faster than a real robot, so a test run is short)
LANE = 30  # cm between two lanes


def lanes() -> list[tuple[float, float]]:
    """The way through the flat (plan cm): lanes in the living room, through the door, lanes in the kitchen,
    back through the door to the dock"""
    pts: list[tuple[float, float]] = [DOCK]
    y = 270.0
    left = True
    while y >= 30:
        pts += [(30, y), (370, y)] if left else [(370, y), (30, y)]
        left = not left
        y -= LANE
    pts += [(370, 145), (430, 145)]
    y = 30.0
    while y <= 270:
        pts += [(430, y), (670, y)] if left else [(670, y), (430, y)]
        left = not left
        y += LANE
    pts += [(430, 145), (370, 145), DOCK]
    return pts


WAY = lanes()
LENGTHS = [math.hypot(WAY[i][0] - WAY[i - 1][0], WAY[i][1] - WAY[i - 1][1]) for i in range(1, len(WAY))]


def where(t: float) -> tuple[float, float, float]:
    """Plan position (cm) and heading (degrees) after t seconds of cleaning (stays at the dock at the end)"""
    d = max(0.0, t) * SPEED
    for i, seg in enumerate(LENGTHS):
        if d <= seg:
            a, b = WAY[i], WAY[i + 1]
            f = d / seg if seg else 0
            return a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        d -= seg
    return DOCK[0], DOCK[1], 0.0


# ---------- Dreame-like: mm, y up; map camera picture 25 mm per pixel ----------

def dreame_xy(px: float, py: float) -> tuple[int, int]:
    return round(10 * px - 2000), round(1500 - 10 * py)


D_LEFT, D_TOP, D_MM = -2500, 2000, 25  # picture: x = (rx − left) / 25, y = (top − ry) / 25
D_W, D_H = 320, 160


def dreame_px(rx: float, ry: float) -> tuple[float, float]:
    return (rx - D_LEFT) / D_MM, (D_TOP - ry) / D_MM


def dreame_calibration() -> list[dict]:
    out = []
    for vx, vy in ((0, 0), (1000, 0), (0, 1000)):
        i, j = dreame_px(vx, vy)
        out.append({"vacuum": {"x": vx, "y": vy}, "map": {"x": int(i), "y": int(j)}})
    return out


def dreame_rooms() -> dict[int, dict]:
    """The `rooms` attribute as Dreame Vacuum writes it (segment as_dict + localized name)"""
    out = {}
    for k, r in enumerate(ROOMS):
        x0, y0 = dreame_xy(r["box"][0], r["box"][3])
        x1, y1 = dreame_xy(r["box"][2], r["box"][1])
        out[r["id"]] = {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "room_id": r["id"], "name": r["name"], "type": 0, "index": k, "color_index": k, "x": (x0 + x1) // 2, "y": (y0 + y1) // 2}
    return out


def dreame_png(robot: tuple[float, float] | None) -> bytes:
    from PIL import Image, ImageDraw

    im = Image.new("RGBA", (D_W, D_H), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    wall = (110, 110, 110, 255)
    for r in ROOMS:
        a = dreame_px(*dreame_xy(r["box"][0], r["box"][1]))
        b = dreame_px(*dreame_xy(r["box"][2], r["box"][3]))
        dr.rectangle([a[0], a[1], b[0] - 1, b[1] - 1], fill=(*r["colour"], 255))
    for r in ROOMS:
        a = dreame_px(*dreame_xy(r["box"][0], r["box"][1]))
        b = dreame_px(*dreame_xy(r["box"][2], r["box"][3]))
        dr.rectangle([a[0] - 2, a[1] - 2, b[0] + 1, b[1] + 1], outline=wall, width=2)
    # the door
    d0 = dreame_px(*dreame_xy(400, DOOR[0]))
    d1 = dreame_px(*dreame_xy(400, DOOR[1]))
    dr.rectangle([d0[0] - 2, d0[1], d0[0] + 1, d1[1]], fill=(*ROOMS[0]["colour"], 255))
    c = dreame_px(*dreame_xy(*DOCK))
    dr.ellipse([c[0] - 3, c[1] - 3, c[0] + 3, c[1] + 3], fill=(60, 200, 90, 255))
    if robot:
        p = dreame_px(*robot)
        dr.ellipse([p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], fill=(255, 255, 255, 255), outline=(40, 40, 40, 255))
    buf = BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


# ---------- Valetudo-like: cm, y down; ValetudoMap JSON in a PNG ----------

PIXEL = 5  # cm


def valetudo_xy(px: float, py: float) -> tuple[int, int]:
    return round(px + 200), round(py + 300)


def _runs(cells: set[tuple[int, int]]) -> list[int]:
    out: list[int] = []
    for y in sorted({c[1] for c in cells}):
        xs = sorted(c[0] for c in cells if c[1] == y)
        start = prev = xs[0]
        for x in xs[1:] + [None]:
            if x is not None and x == prev + 1:
                prev = x
                continue
            out += [start, y, prev - start + 1]
            if x is not None:
                start = prev = x
    return out


def valetudo_map(robot: tuple[float, float, float] | None, path: list[tuple[float, float]]) -> dict:
    layers = []
    floor_all: set[tuple[int, int]] = set()
    for r in ROOMS:
        x0, y0 = valetudo_xy(r["box"][0], r["box"][1])
        x1, y1 = valetudo_xy(r["box"][2], r["box"][3])
        cells = {(i, j) for i in range(x0 // PIXEL + 1, x1 // PIXEL) for j in range(y0 // PIXEL + 1, y1 // PIXEL)}
        floor_all |= cells
        layers.append({"__class": "MapLayer", "metaData": {"segmentId": str(r["id"]), "active": False, "name": r["name"], "area": len(cells) * PIXEL * PIXEL}, "type": "segment", "pixels": [], "dimensions": {}, "compressedPixels": _runs(cells)})
    # the door between them is floor of the living room
    dx = valetudo_xy(400, 0)[0] // PIXEL
    door = {(dx, j) for j in range(valetudo_xy(0, DOOR[0])[1] // PIXEL, valetudo_xy(0, DOOR[1])[1] // PIXEL + 1)}
    layers[0]["compressedPixels"] = _runs({*{(i, j) for i, j in _expand(layers[0]["compressedPixels"])}, *door})
    floor_all |= door
    walls = set()
    for i, j in floor_all:
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                q = (i + di, j + dj)
                if q not in floor_all:
                    walls.add(q)
    layers.append({"__class": "MapLayer", "metaData": {}, "type": "wall", "pixels": [], "dimensions": {}, "compressedPixels": _runs(walls)})
    entities = []
    ch = valetudo_xy(*DOCK)
    entities.append({"__class": "PointMapEntity", "metaData": {"angle": 0}, "points": [ch[0], ch[1]], "type": "charger_location"})
    if robot:
        rp = valetudo_xy(robot[0], robot[1])
        entities.append({"__class": "PointMapEntity", "metaData": {"angle": round((robot[2] + 90) % 360)}, "points": [rp[0], rp[1]], "type": "robot_position"})
    if path:
        flat: list[int] = []
        for p in path:
            flat += list(valetudo_xy(*p))
        entities.append({"__class": "PathMapEntity", "metaData": {}, "points": flat, "type": "path"})
    return {"__class": "ValetudoMap", "metaData": {"version": 2, "nonce": "00000000-0000-0000-0000-000000000000", "totalLayerArea": 0}, "size": {"x": 5000, "y": 5000}, "pixelSize": PIXEL, "layers": layers, "entities": entities}


def _expand(runs: list[int]):
    for k in range(0, len(runs), 3):
        for i in range(runs[k + 2]):
            yield runs[k] + i, runs[k + 1]


def _chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def valetudo_png(vm: dict) -> bytes:
    """Like Valetudo's map-data-hass: a small PNG, its IEND moved behind a zTXt chunk "ValetudoMap" with the
    deflated map JSON"""
    from PIL import Image

    buf = BytesIO()
    Image.new("RGBA", (16, 16), (0, 0, 0, 0)).save(buf, "PNG")
    base = buf.getvalue()[:-12]
    data = zlib.compress(json.dumps(vm).encode())
    return base + _chunk(b"zTXt", b"ValetudoMap\0\0" + data) + _chunk(b"IEND", b"")
