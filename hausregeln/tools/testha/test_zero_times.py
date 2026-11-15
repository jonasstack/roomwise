"""Every time setting can be 0 (= at once): a condition "for 0 min" holds at once (not the verb's preset), a door pulse
of 0 s makes no room occupied, "empty after 0" ends at once (a timer of 0 s, no loop), the settings keep 0 (alarm smart
windows, heating airing / manual, door pulse). Needs Home Assistant (imports): run in a HA container with
custom_components mounted, e.g.
    docker run --rm -v $PWD/custom_components:/config/custom_components:ro -v $PWD/hausregeln/tools:/t:ro \\
      ghcr.io/home-assistant/home-assistant:stable python3 /t/testha/test_zero_times.py
"""

import os
import sys
import time
from types import SimpleNamespace

ROOT = os.environ.get("HA_CONFIG", "/config")
sys.path.insert(0, ROOT)

from custom_components.roomwise.house_rules import conditions as C  # noqa: E402
from custom_components.roomwise.house_rules import heating as H  # noqa: E402
from custom_components.roomwise.house_rules import rooms as R  # noqa: E402

fails = 0


def ok(c, m, *extra):
    global fails
    if not c:
        fails += 1
    print(("  ok: " if c else "  FEHLER: ") + m, *(extra if not c else ()))


def src(name):
    with open(os.path.join(ROOT, "custom_components/roomwise/house_rules", name), encoding="utf-8") as f:
        return f.read()


print("Bedingungen")
ok(C.duration_of("window", "open_for", {"for": "0s"}) == 0, "„offen seit 0 Sek.“ gilt sofort (nicht die Vorgabe 10 Min.)")
ok(C.duration_of("window", "open_for", {"for": 0}) == 0, "auch als Zahl 0")
ok(C.duration_of("window", "open_for", {}) == 600, "ohne Angabe weiter die Vorgabe")

print("Raum: Tür-Puls 0 und leer nach 0")
calls = []
R.async_call_later = lambda _hass, delay, cb: (calls.append(delay), (lambda: None))[1]
tracker = SimpleNamespace(
    hass=None,
    _timers={},
    _pulse={},
    _pulse_only=set(),
    _empty_at={},
    rooms={"r": {"empty_after": 0, "door_pulse_for": 0, "presence": [], "motion": [], "zones": [], "door_logic": False}},
    occupied=lambda _rid: False,
    _evaluate=lambda _rid: calls.append("eval"),
    core=SimpleNamespace(push=lambda *_a: None),
)
R.RoomTracker._door_pulse(tracker, "r", tracker.rooms["r"])
ok(not tracker._pulse and not calls, "Tür-Puls 0 Sek.: der Raum wird nicht belegt, kein Timer", calls, tracker._pulse)
calls.clear()
R.RoomTracker._schedule_empty(tracker, "r")
ok(calls == [0.0], "leer nach 0 Min.: ein Timer mit 0 Sek. (sofort, einmal)", calls)
ok(abs(tracker._empty_at["r"] - time.time()) < 2, "Leer-Zeitpunkt ist jetzt")
tracker.rooms["r"]["door_pulse_for"] = None
calls.clear()
R.RoomTracker._door_pulse(tracker, "r", tracker.rooms["r"])
ok(any(isinstance(c, float) and abs(c - 30.05) < 0.01 for c in calls), "ohne Angabe weiter 30 Sek. Puls", calls)

print("Einstellungen behalten 0")
ok(H._num(0, 10, 0, 60) == 0, "Heizung: Lüften 0 Min. bleibt 0")
h = src("heating.py")
ok('_num(raw["manual_hours"], 2, 0, 48)' in h and '_num(raw["manual_max"], 4, 0, 12)' in h, "Heizung: Handbetrieb höchstens / wie lange ab 0")
ok('("door_pulse_for", 0, 600)' in src("core.py") and '("empty_after", 0, 240)' in src("core.py"), "Raum: Tür-Puls und leer nach ab 0")
ok("int(max(0, min(hi, s[unit])))" in src("alarm.py"), "Alarm: kluge Fenster (von innen / heimgekommen) ab 0")
ok("num if given else 10" in src("conditions.py"), "„in unter 0 Min. da“ bleibt 0")

print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
