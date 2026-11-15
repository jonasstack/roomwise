"""Going to sleep is recognised: a presence sensor in the bed that drops out for a few seconds does not start
"belegt seit 5 Min." again, and the learned bedtime is not pulled into the afternoon by an evening that went on
until 04:00. Needs Home Assistant (imports), so it runs inside the test HA container:
    docker exec -i hr-test-ha python3 - < tools/testha/test_sleep_start.py
"""

import os
import sys
import time
from datetime import date, datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG_DIR", "/config"))  # CI: a folder whose custom_components/ holds house_rules

from custom_components.house_rules import conditions as C  # noqa: E402
from custom_components.house_rules import habits as H  # noqa: E402

fails = 0


def ok(c, m, *extra):
    global fails
    fails += not c
    print("  ok:" if c else "• FAIL:", m, *(extra if not c else ()))


def state(changed):
    return SimpleNamespace(last_changed=datetime.fromtimestamp(changed, timezone.utc))


print("# Bett belegt seit 5 Min.: kurze Aussetzer des Sensors")
chk = C.Checker.__new__(C.Checker)
chk._stay = {}
now = float(int(time.time()))  # whole seconds: a timestamp survives the round trip through datetime exactly
e = "binary_sensor.bett"
since = chk._occupied_since(e, state(now - 240), True)  # in bed for 4 minutes
ok(since == now - 240, "liegt seit 4 Min. im Bett")
chk._occupied_since(e, state(now - 5), False)  # drop-out 5 s ago …
since = chk._occupied_since(e, state(now - 2), True)  # … back after 3 s
ok(since == now - 240, "Sensor 3 s weg: zählt weiter ab dem Hinlegen (vorher fing es neu an)", since - now)
chk._stay[e][1] = now - 200  # last seen in bed 200 s ago, then gone, back now
since = chk._occupied_since(e, state(now), True)
ok(since == now, "über eine Minute weg: wirklich aufgestanden, die Zeit beginnt neu")
chk2 = C.Checker.__new__(C.Checker)
chk2._stay = {}
ok(chk2._occupied_since(e, state(now - 30), True) == now - 30, "ohne Vorgeschichte: ab dem letzten Wechsel")
ok(chk2._occupied_since(e, state(now - 1), False) == 0.0, "frei: hält nicht")

print("\n# gelernte Schlafenszeit")


def bedtime(hb, kind="work"):
    m = int(round(hb.d["sleep"][kind]["m"] + H.DAY_START)) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


core = SimpleNamespace(mode="home", rooms={}, data={})
hb = H.Habits.__new__(H.Habits)
hb.core = core
hb.d = hb._empty()
hb.workday = lambda d: d.weekday() < 5
hb.day_index = lambda d, w=None: d.weekday()
bits = [0] * H.SLOTS
for i in range(8, 76):  # 06:00 … 23:00 someone active
    bits[i] = 1
hb._learn_day(date(2026, 11, 9), bits)
ok(bedtime(hb) == "23:00", "zuletzt aktiv bis 23:00 → Schlafenszeit 23:00", hb.d["sleep"])
late = [1] * H.SLOTS  # guests until 04:00 (or a sensor that never goes quiet)
for d in (10, 11, 12):
    hb._learn_day(date(2026, 11, d), late)
ok(bedtime(hb) == "23:00", "aktiv bis 04:00 → keine Schlafenszeit daraus (vorher rutschte sie auf den Nachmittag)", hb.d["sleep"])
hb.d["mode"] = {"sleep_day": "2026-11-12", "sleep": 22 * 60 + 30, "wake_day": "2026-11-13", "wake": 6 * 60 + 40}
hb._learn_day(date(2026, 11, 12), bits)
ok(hb.d["sleep"]["work"]["m"] < (23 * 60 - H.DAY_START), "Hausmodus Schlafen um 22:30 zählt für den Abend, an dem er anfing", hb.d["sleep"])
ok(hb.d["wake"].get("work", {}).get("m") != 6 * 60 + 40 - H.DAY_START, "das Aufwachen am nächsten Morgen gehört nicht zu diesem Tag", hb.d["wake"])
# a Saturday evening out: everyone left at 18:00 (house mode "Weg"), came back after 04:00 – no bedtime "18:00"
out = [0] * H.SLOTS
for i in range(8, 56):  # 06:00 … 18:00 someone active
    out[i] = 1
before = dict(hb.d["sleep"])
core.mode = "home"
hb._mode_prev = "home"
core.mode = "away"
hb._mode(datetime(2026, 11, 14, 18, 5))
hb._learn_day(date(2026, 11, 14), out)
ok(hb.d["sleep"] == before, "Abend auswärts (Hausmodus Weg): Zeit des Gehens zählt nicht als Schlafenszeit", hb.d["sleep"])
core.mode = "home"

print("\n# alte, kaputte Schlafenszeit wird beim Laden vergessen")


class Store:
    async def async_load(self):
        return {"v": 1, "bed_v": 2, "sleep": {"work": {"m": 692.7, "n": 12}, "free": {"m": 1180.0, "n": 5}}, "wake": {"work": {"m": 128.1, "n": 12}}}


import asyncio  # noqa: E402

hb2 = H.Habits.__new__(H.Habits)
hb2._store = Store()
hb2.loaded = False
asyncio.run(hb2.async_load())
ok("work" not in hb2.d["sleep"] and hb2.d["sleep"]["free"]["m"] == 1180.0, "15:33 Uhr als Schlafenszeit vergessen, 23:40 bleibt", hb2.d["sleep"])
ok(hb2.d["wake"]["work"]["m"] == 128.1, "Aufstehzeit bleibt")


class OldStore:
    async def async_load(self):
        return {"v": 1, "sleep": {"work": {"m": 1073.6, "n": 17}, "free": {"m": 911.8, "n": 6}}, "wake": {"work": {"m": 199.6, "n": 17}}}


hb3 = H.Habits.__new__(H.Habits)
hb3._store = OldStore()
hb3.loaded = False
asyncio.run(hb3.async_load())
ok(hb3.d["sleep"] == {} and hb3.d["bed_v"] == 2 and hb3.d["wake"]["work"]["m"] == 199.6, "Stand vor 2026-11: gelernte Schlafenszeiten einmal vergessen (Abende auswärts zählten mit), Aufstehzeit bleibt", hb3.d["sleep"])

print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
