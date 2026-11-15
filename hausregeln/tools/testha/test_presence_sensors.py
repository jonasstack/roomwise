"""Presence / motion sensors of a room: a binary_sensor without a fitting device class counts by its name (radar,
Anwesenheit, Bewegung …), battery / link / status sensors never; a room takes by hand any sensor of Home Assistant
(not only the device list); a sensor counting targets (a number above 0) or an input_boolean shows someone there.
Needs Home Assistant (imports): run inside a HA container with custom_components mounted, e.g.
    docker run --rm -v $PWD/custom_components:/config/custom_components:ro -v $PWD/hausregeln/tools:/t:ro \\
      ghcr.io/home-assistant/home-assistant:stable python3 /t/testha/test_presence_sensors.py
"""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG", "/config"))

from custom_components.roomwise.house_rules import inventory as I  # noqa: E402
from custom_components.roomwise.house_rules.core import HouseRules  # noqa: E402
from custom_components.roomwise.house_rules.rooms import RoomTracker, seen  # noqa: E402

fails = 0


def ok(c, m, *extra):
    global fails
    if not c:
        fails += 1
    print(("  ok: " if c else "  FEHLER: ") + m, *(extra if not c else ()))


def st(eid, state="off", **attrs):
    return SimpleNamespace(entity_id=eid, state=state, attributes=attrs)


print("Erkennung über den Namen")
cases = [
    ("binary_sensor.radar_flur", "Radar Flur", "", "presence"),
    ("binary_sensor.esp_kueche_anwesenheit", "Küche Anwesenheit", "", "presence"),
    ("binary_sensor.fp2_wohnzimmer_bereich_1", "Wohnzimmer Bereich 1", "", "presence"),
    ("binary_sensor.praesenz_bad", "Präsenz Bad", "", "presence"),
    ("binary_sensor.flur_bewegung", "Flur Bewegung", "", "motion"),
    ("binary_sensor.pir_keller", "PIR Keller", "", "motion"),
    ("binary_sensor.radar_flur_batterie", "Radar Flur Batterie", "", None),
    ("binary_sensor.anwesenheit_flur_verbunden", "Anwesenheit Flur verbunden", "", None),
    ("binary_sensor.radar_flur_status", "Radar Flur Status", "", None),
    ("binary_sensor.radar_flur_conn", "Radar Flur", "connectivity", None),
    ("binary_sensor.bewegung_tamper", "Bewegungsmelder Sabotage", "tamper", None),
    ("binary_sensor.waschmaschine_laeuft", "Waschmaschine läuft", "", None),
]
for eid, name, dc, want in cases:
    got, _hint = I.classify(eid, st(eid, device_class=dc) if dc else st(eid), name)
    ok(got == want, f"{name} ({dc or 'ohne Klasse'}) → {want}", got)
ok(I.classify("binary_sensor.x", st("binary_sensor.x", device_class="occupancy"), "Irgendwas")[0] == "presence", "Geräteklasse occupancy bleibt presence")
ok(I.classify("binary_sensor.x", st("binary_sensor.x", device_class="window"), "Radar Fenster")[0] == "window", "ein Fenster bleibt Fenster, auch mit 'Radar' im Namen")

print("Raum speichern: auch Sensoren außerhalb der Geräteliste")
states = {
    "binary_sensor.radar_bad": st("binary_sensor.radar_bad", "off"),
    "sensor.radar_bad_ziele": st("sensor.radar_bad_ziele", "0"),
    "input_boolean.gaeste_da": st("input_boolean.gaeste_da", "off"),
    "switch.licht": st("switch.licht", "off"),
    "binary_sensor.tuer_bad": st("binary_sensor.tuer_bad", "off"),
}
states["binary_sensor.bad_belegt"] = st("binary_sensor.bad_belegt", "on")
own = {"binary_sensor.bad_belegt": SimpleNamespace(platform="roomwise")}
import custom_components.roomwise.house_rules.core as C  # noqa: E402

C.er = SimpleNamespace(async_get=lambda _h: SimpleNamespace(async_get=lambda e: own.get(e)))
core = SimpleNamespace(
    data={"rooms": {}},
    inventory=SimpleNamespace(devices={"binary_sensor.tuer_bad": {"kind": "door"}}),
    hass=SimpleNamespace(states=SimpleNamespace(get=lambda e: states.get(e))),
)
HouseRules.room_patch(
    core,
    {
        "id": "bad",
        "presence": ["binary_sensor.radar_bad", "sensor.radar_bad_ziele", "binary_sensor.gibt_es_nicht", "switch.licht", "binary_sensor.bad_belegt"],
        "motion": ["input_boolean.gaeste_da"],
        "doors": ["binary_sensor.tuer_bad", "binary_sensor.radar_bad"],
    },
)
r = core.data["rooms"]["bad"]
ok(r["presence"] == ["binary_sensor.radar_bad", "sensor.radar_bad_ziele"], "Anwesenheit: Radar und Zähler angenommen, Unbekanntes, Schalter und das eigene „Bad belegt“ nicht", r["presence"])
ok(r["motion"] == ["input_boolean.gaeste_da"], "Bewegung: input_boolean angenommen", r["motion"])
ok(r["doors"] == ["binary_sensor.tuer_bad"], "Türen: weiter nur aus der Geräteliste", r["doors"])

print("Belegung")
ok(seen("binary_sensor.x", "on") and not seen("binary_sensor.x", "off"), "binary_sensor an/aus")
ok(seen("input_boolean.x", "on"), "input_boolean an")
ok(seen("sensor.ziele", "2") and not seen("sensor.ziele", "0") and not seen("sensor.ziele", "unavailable"), "Zähler: über 0 = jemand da")
ok(seen("sensor.zustand", "detected") and not seen("sensor.zustand", "clear"), "Text-Zustand detected / clear")
states["sensor.radar_bad_ziele"] = st("sensor.radar_bad_ziele", "1")
tracker = SimpleNamespace(
    hass=core.hass,
    core=SimpleNamespace(cleaning=SimpleNamespace(ignores=lambda _e, _s: False), inventory=SimpleNamespace(devices={})),
)
room = {"presence": ["binary_sensor.radar_bad", "sensor.radar_bad_ziele"], "motion": ["input_boolean.gaeste_da"], "zones": [], "door_logic": False, "id": "bad"}
tracker._on = lambda e: RoomTracker._on(tracker, e)
ok(RoomTracker._raw(tracker, room), "ein Zähler über 0 belegt den Raum")
ok(RoomTracker._by(tracker, room) == "sensor.radar_bad_ziele", "„erkannt durch“ nennt den Sensor (ohne Gerät: seinen Namen bzw. die Entität)", RoomTracker._by(tracker, room))
states["sensor.radar_bad_ziele"] = st("sensor.radar_bad_ziele", "0")
ok(not RoomTracker._raw(tracker, room), "alle aus → leer")

print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
