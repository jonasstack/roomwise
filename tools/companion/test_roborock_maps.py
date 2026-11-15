"""Every map of a Roborock (a house: one per floor) — custom_components/roomwise/card/vacuum.py roborock_maps():
names and room names per map, which one is in use, a map without loaded geometry comes without `map`, and the
"selected map" select of the same device. Fakes stand in for the Roborock integration's runtime data (the library
loads all maps once at its start and keeps them in home.home_map_content / home.home_map_info).

Needs Home Assistant (imports), so it runs in a Home Assistant container:
    docker run --rm -v $PWD:/repo:ro -e HA_CONFIG_DIR=/repo ghcr.io/home-assistant/home-assistant:stable \
        python3 /repo/tools/companion/test_roborock_maps.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from types import SimpleNamespace as NS

sys.path.insert(0, os.environ.get("HA_CONFIG_DIR", "/repo"))
from homeassistant.helpers import entity_registry as er  # noqa: E402

from custom_components.roomwise.card import vacuum as V  # noqa: E402

fails = 0


def ok(cond: bool, msg: str, extra=None) -> None:
    global fails
    if not cond:
        fails += 1
    print(("  ok: " if cond else "  FEHLER: ") + msg + ("" if cond or extra is None else f" {extra!r}"))


VAC = NS(entity_id="vacuum.robbi", platform="roborock", config_entry_id="e1", unique_id="roborock_abc", device_id="d1", domain="vacuum")
SEL = NS(entity_id="select.robbi_karte", platform="roborock", unique_id="selected_map_abc", device_id="d1", domain="select")
OTHER = NS(entity_id="select.robbi_modus", platform="roborock", unique_id="mop_mode_abc", device_id="d1", domain="select")


class Reg:
    def async_get(self, eid):
        return {VAC.entity_id: VAC, SEL.entity_id: SEL}.get(eid)


er.async_get = lambda hass: Reg()  # type: ignore[assignment]
er.async_entries_for_device = lambda reg, device_id: [VAC, OTHER, SEL] if device_id == "d1" else []  # type: ignore[assignment]


def content(tag: str):
    md = NS(calibration=lambda: [{"vacuum": {"x": 0, "y": 0}, "map": {"x": 0, "y": 0}}] * 3, rooms={16: NS(x0=0, y0=0, x1=10, y1=10)}, charger=None, vacuum_position=None)
    return NS(map_data=md, image_content=tag.encode())


seen: list[tuple[bytes, dict]] = []


def fake_points(image, cal, rooms_mm, names, charger):
    seen.append((image, dict(names)))
    return {"rooms": [{"id": k, "name": names.get(k), "pts": [[0, 0]]} for k in rooms_mm], "walls": [], "charger": charger}


V.map_points = fake_points  # the picture parsing has its own test; here: which map, which names
home = NS(
    home_map_info={0: NS(name="Erdgeschoss", rooms=[NS(segment_id=16, raw_name="Küche")]), 1: NS(name="Obergeschoss", rooms=[NS(segment_id=16, raw_name="Bad")]), 2: NS(name="Keller", rooms=[])},
    home_map_content={0: content("eg"), 1: content("og"), 2: None},
)
co = NS(duid="abc", properties_api=NS(home=home, maps=NS(current_map=1)))


async def run_job(fn, *args):
    return fn(*args)


calls: list = []


async def service(*a, **k):
    calls.append(a)
    return {}


hass = NS(config_entries=NS(async_get_entry=lambda eid: NS(runtime_data={"abc": co})), async_add_executor_job=run_job, services=NS(async_call=service))


async def main() -> None:
    print("Alle Karten")
    maps = await V.roborock_maps(hass, "vacuum.robbi")
    ok(len(maps) == 3, "drei Karten", maps)
    by = {m["id"]: m for m in maps}
    ok(by["0"]["name"] == "Erdgeschoss" and by["1"]["name"] == "Obergeschoss", "Namen der Karten", maps)
    ok(by["1"]["current"] and not by["0"]["current"], "die Karte, die er gerade nutzt", maps)
    ok(by["0"]["map"]["rooms"][0]["name"] == "Küche" and by["1"]["map"]["rooms"][0]["name"] == "Bad", "Raumnamen je Karte (gleiche Nummer, andere Etage)", maps)
    ok(by["2"]["map"] is None, "Karte ohne geladene Form: ohne map", by["2"])
    ok(not calls, "kein Dienstaufruf nötig (Namen aus den Daten der Integration)", calls)
    print("Die aktuelle Karte")
    seen.clear()
    one = await V.roborock_map(hass, "vacuum.robbi")
    ok(seen and seen[0][0] == b"og" and one["rooms"][0]["name"] == "Bad", "roborock_map liest die Karte in Benutzung", seen)
    print("Karten-Auswahl")
    ok(V.roborock_map_select(hass, "vacuum.robbi") == "select.robbi_karte", "select „Karte“ desselben Geräts")
    print("Ältere Bibliothek ohne Kartenliste")
    home2 = NS(home_map_info=None, home_map_content={5: NS(map_data=NS(**{**vars(content("x").map_data), "vacuum_position": NS(x=1, y=1)}), image_content=b"x")})
    co.properties_api = NS(home=home2, maps=None)
    maps = await V.roborock_maps(hass, "vacuum.robbi")
    ok(len(maps) == 1 and maps[0]["current"] and maps[0]["map"], "eine Karte, als aktuelle", maps)


asyncio.run(main())
print("\nALLES OK" if not fails else f"\n{fails} FEHLER")
sys.exit(1 if fails else 0)
