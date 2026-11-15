"""Map formats of the vacuum adapters, without Home Assistant: python3 tools/companion/test_vacuum_formats.py

Feeds custom_components/floorplan_card/vacuum_formats.py with the attribute shapes of Dreame Vacuum, Xiaomi Cloud
Map Extractor and Valetudo (built by the fake robots of testha/fp_fake/world.py) and checks that floor, walls, dock,
position and path come out in robot millimetres where they belong.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


F = load("vacuum_formats", ROOT / "custom_components/floorplan_card/vacuum_formats.py")
W = load("world", ROOT / "tools/companion/testha/fp_fake/world.py")
fails = 0


def ok(cond: bool, msg: str) -> None:
    global fails
    print("  ok:" if cond else "• FAIL:", msg)
    fails += 0 if cond else 1


class Obj:
    """A position object with as_dict(), as Dreame Vacuum / Map Extractor put them into the attributes"""

    def __init__(self, **kw):
        self.__dict__.update(kw)

    def as_dict(self):
        return dict(self.__dict__)


# ---- small pieces ----
ok(F.point(Obj(x=1, y=2, a=90)) == (1.0, 2.0), "point from an object with x / y")
ok(F.point({"x": 3, "y": 4}) == (3.0, 4.0) and F.point([5, 6]) == (5.0, 6.0), "point from a dict and a list")
ok(F.point(None) is None and F.point({"x": "a", "y": 1}) is None, "no point from nothing or text")
ok(F.calibration([{"vacuum": {"x": 0, "y": 0}, "map": {"x": 0, "y": 0}}] * 3) is None, "all-zero calibration (Dreame before it has a map) is ignored")
cal = F.calibration(W.dreame_calibration())
ok(cal is not None and abs(cal.units_per_px - 25) < 0.01, f"Dreame calibration: {cal.units_per_px if cal else None} mm per pixel")
rx, ry = cal.to_robot(*cal.to_px(1234, -567))
ok(abs(rx - 1234) < 1e-6 and abs(ry + 567) < 1e-6, "pixel ↔ robot round trip")
ok(F.calibration('[{"vacuum":{"x":0,"y":0},"map":{"x":10,"y":20}},{"vacuum":{"x":100,"y":0},"map":{"x":30,"y":20}},{"vacuum":{"x":100,"y":100},"map":{"x":30,"y":40}}]') is not None, "calibration as a JSON string (Valetudo renderer sensor)")

# ---- Dreame Vacuum attributes ----
attrs = {"calibration_points": W.dreame_calibration(), "rooms": W.dreame_rooms(), "vacuum_position": Obj(x=100, y=200, a=0), "charger_position": Obj(x=-1750, y=-1250, a=90)}
rooms = F.rooms_of(attrs)
ok(sorted(rooms) == ["1", "2"] and rooms["1"]["name"] == "Wohnzimmer" and rooms["2"]["box"] == (2000.0, -1500.0, 5000.0, 1500.0), f"Dreame rooms: {rooms}")
m = F.map_from_image(W.dreame_png((0, 0)), cal, rooms, F.charger_of(attrs))
by = {r["id"]: r for r in (m or {}).get("rooms", [])}
ok(m is not None and set(by) == {"1", "2"} and by["1"]["name"] == "Wohnzimmer", f"Dreame map: rooms {sorted(by)}")
inside = all(-2100 <= x <= 2100 and -1600 <= y <= 1600 for x, y in by.get("1", {"pts": []})["pts"])
area1 = len(by.get("1", {"pts": []})["pts"]) * 0.01
ok(inside and 9 <= area1 <= 13.5, f"living room floor in its box: {area1:.1f} m² (room 12 m², the robot icon and the door shift a little)")
ok(all(1900 <= x <= 5100 for x, _ in by.get("2", {"pts": []})["pts"]), "kitchen floor in its box")
ok(len(m["walls"]) > 100 and m["charger"] == [-1750, -1250], f"walls ({len(m['walls'])}) and dock")
boxes = F.map_from_image(None, cal, rooms, None)
ok(boxes is not None and len(boxes["rooms"]) == 2 and not boxes["walls"], "without a picture the room boxes stand in")

# ---- Xiaomi Cloud Map Extractor attributes ----
xcme = {
    "calibration_points": [{"vacuum": {"x": 25500, "y": 25500}, "map": {"x": 100, "y": 100}}, {"vacuum": {"x": 26500, "y": 25500}, "map": {"x": 120, "y": 100}}, {"vacuum": {"x": 25500, "y": 26500}, "map": {"x": 100, "y": 80}}],
    "charger": Obj(x=25000, y=25100, a=None),
    "rooms": {16: Obj(x0=25000, y0=25000, x1=28000, y1=27000, name="Bad", x=None, y=None), 17: Obj(x0=28000, y0=25000, x1=30000, y1=27000)},
    "room_numbers": {16: "Bad", 17: None},
    "path": Obj(point_length=2, point_size=1, angle=0, path=[[Obj(x=25600, y=25600), Obj(x=25700, y=25600)], [Obj(x=25800, y=25650)]]),
}
xr = F.rooms_of(xcme)
ok(xr["16"]["name"] == "Bad" and xr["17"]["name"] is None and xr["17"]["box"] == (28000.0, 25000.0, 30000.0, 27000.0), "Map Extractor rooms and room_numbers")
ok(F.path_of(xcme) == [(25600.0, 25600.0), (25700.0, 25600.0), (25800.0, 25650.0)], "Map Extractor path (several pieces)")
ok(F.charger_of(xcme) == (25000.0, 25100.0), "Map Extractor dock ('charger')")
ok(F.path_of({"path": None}) == [] and F.path_of({}) == [], "no path: empty")

# ---- Valetudo ----
path = [W.where(t)[:2] for t in range(0, 20, 2)]
vm = W.valetudo_map(W.where(10), path)
png = W.valetudo_png(vm)
back = F.valetudo_json(png)
ok(back is not None and back["pixelSize"] == 5 and len(back["layers"]) == 3, "ValetudoMap read back from the zTXt chunk of the PNG")
ok(F.valetudo_json(b"\x89PNG\r\n\x1a\n" + b"\0" * 20) is None and F.valetudo_json(W.dreame_png(None)) is None, "an ordinary picture is no Valetudo map")
s = F.valetudo_summary(back)
rp = W.valetudo_xy(*W.where(10)[:2])
ok(s["robot"] == (float(rp[0]), float(rp[1])) and s["charger"] == tuple(map(float, W.valetudo_xy(*W.DOCK))), f"robot {s['robot']} and dock {s['charger']} (cm)")
ok([x["name"] for x in s["segments"]] == ["Wohnzimmer", "Küche"] and s["segments"][0]["id"] == "1", f"segments {s['segments']}")
ok(len(s["path"]) == len(path), "path points")
vmap = F.valetudo_map(back)
vb = {r["id"]: r for r in vmap["rooms"]}
area = len(vb["1"]["pts"]) * (vmap["floor_res"] / 1000) ** 2
ok(abs(area - 12) < 1.0, f"living room floor {area:.1f} m² (12 m²)")
ok(all(2000 <= x <= 6050 and 3000 <= y <= 6000 for x, y in vb["1"]["pts"]), "living room floor where it is (mm)")
ok(len(vmap["walls"]) > 100 and vmap["charger"] == [W.valetudo_xy(*W.DOCK)[0] * 10, W.valetudo_xy(*W.DOCK)[1] * 10], f"walls ({len(vmap['walls'])}) and dock in mm")
old = {"pixelSize": 5, "layers": [{"type": "floor", "pixels": [10, 10, 12, 10, 14, 10]}], "entities": []}
ok(F.valetudo_map(old)["rooms"][0]["id"] == "floor", "older Valetudo (plain pixels, no segments): one floor")
raw = F.valetudo_json(__import__("zlib").compress(__import__("json").dumps(vm).encode()))
ok(raw is not None and raw["pixelSize"] == 5, "deflated JSON (raw map-data topic) works too")

print("FAILED:", fails) if fails else print("all ok")
sys.exit(1 if fails else 0)
