"""Offline test of the vacation simulation (simulate.py) with two weeks of made-up everyday life.

Runs inside the test container (Home Assistant installed):
  docker cp tools/testha/test_sim.py hr-test-ha:/tmp/ && docker exec hr-test-ha python3 /tmp/test_sim.py
"""

import os
import random
import sys
from datetime import date, datetime, timedelta
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG_DIR", "/config"))  # CI: a folder whose custom_components/ holds house_rules
from custom_components.house_rules import simulate as S  # noqa: E402

FAIL = []


def ok(cond, what, extra=""):
    print(("  ok: " if cond else "• FAIL: ") + what, extra if not cond else "")
    if not cond:
        FAIL.append(what)


def m(hh, mm=0):
    """clock time → minutes since 04:00"""
    return ((hh * 60 + mm) - S.DAY_START) % 1440


ROOMS = {
    rid: {"name": name, "presence": ["x"], "motion": [], "zones": [], "door_logic": False, "dark_below": 80}
    for rid, name in (("flur", "Flur"), ("kuche", "Küche"), ("wohnzimmer", "Wohnzimmer"), ("schlafzimmer", "Schlafzimmer"), ("bad", "Bad"))
}


def make_day(d: date, rng: random.Random) -> dict:
    """One day: up, bathroom, kitchen, (work), evening living room/kitchen, bed; the hallway between every change."""
    work = d.weekday() < 5
    segs = {r: [] for r in ROOMS}
    t = m(6, 30) if work else m(8, 30)
    t += rng.uniform(-10, 10)
    segs["schlafzimmer"].append([0, t])  # the night before (from 4:00)

    def go(room, length):
        nonlocal t
        segs["flur"].append([t, t + 0.5])
        t += 0.6
        segs[room].append([t, t + length])
        t += length

    go("bad", 15)
    go("kuche", 25)
    if work:
        segs["flur"].append([t, t + 1])
        t = m(17, 30) + rng.uniform(-15, 15)  # away at work
        segs["flur"].append([t, t + 1])
        t += 1
    while t < m(22, 45):
        go("wohnzimmer", rng.uniform(40, 90))
        go(rng.choice(["kuche", "bad"]), rng.uniform(5, 20))
    go("bad", 10)
    bed = t
    segs["flur"].append([t, t + 0.5])
    segs["schlafzimmer"].append([t + 0.6, 1440])
    if rng.random() < 0.5:  # at night to the bathroom
        at = bed + 180
        segs["flur"].append([at, at + 0.3])
        segs["bad"].append([at + 0.4, at + 4])
    return {"segs": {r: [[round(a, 1), round(b, 1)] for a, b in v] for r, v in segs.items()}, "lights": {"wohnzimmer": {"evening": {"light.sofa": [600, 600 * 60], "light.decke": [100, 100 * 100]}}}}


class Plan(dict):
    pass


def fake_core(days: dict, lux: dict | None = None, elevation: float = -10):
    data = {"sim": {"config": S.default_config(), "days": days, "model": {}}}
    core = SimpleNamespace()
    core.rooms = ROOMS
    core.data = data
    core.mode = "vacation"
    core.save = lambda: None
    core.checker = SimpleNamespace(_workday=lambda dt: dt.weekday() < 5)
    core.residents = lambda: [{"counts": True}]
    core.feature = lambda name: True  # features "vacation" and "light" on
    core.room_tracker = SimpleNamespace(lux=lambda rid: (lux or {}).get(rid))
    core.lightplan = SimpleNamespace(
        store={r: {"on": True} for r in ROOMS},
        plan=lambda rid: {"vacation": {"on": True}},
        room_lights=lambda rid: {"wohnzimmer": ["light.sofa", "light.decke"]}.get(rid, [f"light.{rid}"]),
        schedule=lambda *a: None,
    )
    hass = SimpleNamespace(states=SimpleNamespace(get=lambda e: SimpleNamespace(state="below_horizon", attributes={"elevation": elevation}) if e == "sun.sun" else None), data={})
    return S.Simulator(hass, core)


rng = random.Random(1)
start = date(2026, 9, 28)
days = {(start + timedelta(days=i)).isoformat(): make_day(start + timedelta(days=i), rng) for i in range(14)}
sim = fake_core(days)
sim._aggregate()
model = sim.data["model"]
wd = model["types"]["workday"]
we = model["types"]["weekend"]

print("Gelernt")
ok(model["bedroom"] == "schlafzimmer", "Schlafzimmer erkannt", model["bedroom"])
ok(model["night_room"] == "bad", "nachts ins Bad", model["night_room"])
med = lambda v: sorted(v)[len(v) // 2]  # noqa: E731
ok(abs(med(wd["wake"]) - m(6, 30)) < 15, f"werktags auf um {S.clock(med(wd['wake']))}")
ok(abs(med(we["wake"]) - m(8, 30)) < 15, f"am Wochenende auf um {S.clock(med(we['wake']))}")
ok(m(22, 45) <= med(wd["bed"]) <= m(0, 30), f"ins Bett um {S.clock(med(wd['bed']))} (die erfundenen Abende enden 22:45–0:30)")
ok(0.2 <= wd["night_p"] <= 0.8, f"nachts auf: {wd['night_p']}")
slot = lambda hh, mm=0: int(m(hh, mm) // S.SLOT)  # noqa: E731
ok(wd["home"][slot(12)] < 0.2 and we["home"][slot(12)] > 0.8, "werktags mittags weg, am Wochenende da", (wd["home"][slot(12)], we["home"][slot(12)]))
ok(wd["occ"]["wohnzimmer"][slot(20)] > 0.5, "abends im Wohnzimmer", wd["occ"]["wohnzimmer"][slot(20)])
nb = sim.neighbours()
ok(set(nb.get("flur", {})) >= {"kuche", "bad", "wohnzimmer", "schlafzimmer"}, "Wege gelernt: Flur verbindet alles", nb.get("flur"))
ok(all(src == "gelernt" for src in nb["flur"].values()), "Quelle: gelernt", nb["flur"])
ok(sim.path("schlafzimmer", "kuche") == ["schlafzimmer", "flur", "kuche"], "Weg Schlafzimmer → Küche über den Flur", sim.path("schlafzimmer", "kuche"))
lw = model["lights"]["wohnzimmer"]["evening"]
ok(lw["lights"] == ["light.sofa"] and lw["brightness"] == 60, "abends im Wohnzimmer: Sofalicht mit 60 %", lw)

print("Simuliert")
day = date(2026, 10, 14)  # a Wednesday
tl = sim.plan_for(day, 0)
ok(tl == sim.plan_for(day, 0) and tl != sim.plan_for(day + timedelta(days=7), 0), "gleicher Tag = gleicher Ablauf, anderer Tag anders")
stays = [s for s in tl if s["kind"] == "stay"]
ok(not any(m(9) < s["from"] < m(16) for s in stays), "werktags tagsüber weg (keine Aufenthalte 9–16 Uhr)", [(S.clock(s["from"]), s["room"]) for s in stays if m(9) < s["from"] < m(16)])
ok(any(s["room"] == "wohnzimmer" and m(18) < s["from"] < m(23) for s in stays), "abends im Wohnzimmer")
wake = next(s for s in tl if s["kind"] == "wake")
ok(wake["room"] == "schlafzimmer" and m(6) < wake["from"] < m(7, 45), f"morgens Schlafzimmer an um {S.clock(wake['from'])}")
ok(any(s["kind"] == "bed" and s["room"] == "schlafzimmer" and s["from"] > m(21, 30) for s in tl), "abends ins Bett")
# every change of room passes through the hallway (a pass segment right before)
changes = 0
bad_way = []
for a, b in zip(tl, tl[1:]):
    if a["kind"] != "pass" and b["kind"] != "pass" and a["room"] != b["room"] and b["from"] - a["to"] < 0.01 and "flur" not in (a["room"], b["room"]):
        bad_way.append((S.clock(a["from"]), a["room"], b["room"]))
    if b["kind"] == "pass":
        changes += 1
ok(not bad_way and changes > 5, f"Raumwechsel immer über den Flur ({changes} Wege)", bad_way[:3])
saturday = sim.plan_for(date(2026, 10, 17), 0)
ok(any(s["kind"] == "stay" and m(11) < s["from"] < m(15) for s in saturday), "am Wochenende tagsüber zuhause")
ok(next(s for s in saturday if s["kind"] == "wake")["from"] > m(7, 45), "am Wochenende später auf")

print("Licht")
seg = next(s for s in stays if s["room"] == "wohnzimmer" and s["from"] > m(19))
at = datetime.combine(day, datetime.min.time()) + timedelta(minutes=S.DAY_START + seg["from"] + 1)
S.dt_util.now = lambda: S.dt_util.as_local(at.replace(tzinfo=S.dt_util.get_default_time_zone()))
w = sim.want("wohnzimmer", ["light.sofa", "light.decke"], 70, "warm", {})
ok(w["light.sofa"]["mode"] == "on" and w["light.sofa"]["brightness"] == 60 and w["light.decke"]["mode"] == "off", "simuliert im Wohnzimmer: Sofalicht 60 %, Decke aus", w)
w2 = sim.want("kuche", ["light.kuche"], 70, "warm", {})
ok(w2["light.kuche"]["mode"] == "off", "Küche gerade leer → aus", w2)
bright = fake_core(days, lux={"wohnzimmer": 400})
bright._aggregate()
w3 = bright.want("wohnzimmer", ["light.sofa", "light.decke"], 70, "warm", {})
ok(all(v["mode"] == "off" for v in w3.values()), "Raum hell (400 lx) → kein Licht", w3)
w4 = bright.want("wohnzimmer", ["light.sofa", "light.decke"], 70, "warm", {"light.sofa": True})
ok(w4["light.sofa"]["mode"] == "on", "schon an (eigenes Licht macht hell) → bleibt an", w4)

morning_seg = next((s for s in stays if s["room"] == "wohnzimmer" and m(10) < s["from"] < m(16)), None)
sat = [s for s in sim.plan_for(date(2026, 10, 17), 0) if s["kind"] == "stay" and s["room"] == "wohnzimmer" and m(11) < s["from"] < m(16)]
if sat:
    at2 = datetime.combine(date(2026, 10, 17), datetime.min.time()) + timedelta(minutes=S.DAY_START + sat[0]["from"] + 1)
    S.dt_util.now = lambda: S.dt_util.as_local(at2.replace(tzinfo=S.dt_util.get_default_time_zone()))
    w5 = sim.want("wohnzimmer", ["light.sofa", "light.decke"], 70, "warm", {})
    ok(all(v["mode"] == "off" for v in w5.values()), "tagsüber macht ihr im Wohnzimmer kein Licht an → auch simuliert nicht (trotz dunkel)", w5)

print("Wann ist es dunkel genug")
sunny = fake_core(days, elevation=20)
sunny._aggregate()
S.dt_util.now = lambda: S.dt_util.as_local(at.replace(tzinfo=S.dt_util.get_default_time_zone()))
w6 = sunny.want("wohnzimmer", ["light.sofa", "light.decke"], 70, "warm", {})
ok(all(v["mode"] == "off" for v in w6.values()) and "Sonne" in w6["light.sofa"]["why"], "Sonne 20° hoch → kein Licht (auch wenn der Sensor dunkel meldet)", w6["light.sofa"])
sunny.data["model"]["lights"]["wohnzimmer"]["day"] = {"lights": ["light.sofa"], "brightness": 50}
w7 = sunny.want("wohnzimmer", ["light.sofa", "light.decke"], 70, "warm", {})
ok(w7["light.sofa"]["mode"] == "on", "Raum, den ihr auch tagsüber beleuchtet: Sonne zählt nicht", w7["light.sofa"])
sunny.save_config({"dark": {"never": True, "never_from": "00:00", "never_to": "23:59"}})
w8 = sunny.want("wohnzimmer", ["light.sofa", "light.decke"], 70, "warm", {})
ok(w8["light.sofa"]["mode"] == "off" and "nie zwischen" in w8["light.sofa"]["why"], "„nie zwischen“ gilt", w8["light.sofa"])
sunny.save_config({"dark": {"never": False, "sun": False, "lux": True, "lux_below": 300}})
lux_core = fake_core(days, lux={"wohnzimmer": 200}, elevation=-10)
lux_core._aggregate()
lux_core.save_config({"dark": {"lux_below": 300}})
ok(lux_core.dark("wohnzimmer")[0] is True, "eigener Grenzwert 300 lx: 200 lx gilt als dunkel")
lux_core.save_config({"dark": {"lux_below": 0}})
ok(lux_core.dark("wohnzimmer")[0] is False, "automatisch (Raum 80 lx): 200 lx ist hell")
lux_core.data["model"]["lux_on"] = {"wohnzimmer": 250}
ok(lux_core.dark("wohnzimmer")[0] is True and lux_core.lux_limit("wohnzimmer") == (250.0, "gelernt"), "gelernt: ihr macht unter ~250 lx Licht an → 200 lx gilt als dunkel")

print("Ohne Gelerntes")
fresh = fake_core({})
fresh._aggregate()
tl2 = fresh.plan_for(day, 0)
ok(any(s["kind"] == "stay" for s in tl2) and any(s["kind"] == "bed" for s in tl2), "ohne Daten: ein üblicher Tag", len(tl2))
ok(next(s for s in tl2 if s["kind"] == "wake")["room"] == "schlafzimmer", "ohne Daten: Schlafzimmer nach Name")

print("FEHLER" if FAIL else "alles ok", len(FAIL) or "")
