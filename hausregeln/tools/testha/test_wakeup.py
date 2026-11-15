"""Aufstehen erkennen (wakeup.py) on a fake core with a clock the test drives: a night trip never ends sleep, a real
morning does, feedback moves the threshold, a restart at night keeps the night, buttons only from recipients.
Needs Home Assistant (imports), so it runs inside the test HA container:
    docker exec -i hr-test-ha python3 - < tools/testha/test_wakeup.py
"""

import asyncio
import os
import sys
from datetime import datetime
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG_DIR", "/config"))  # CI: a folder whose custom_components/ holds house_rules
from homeassistant.util import dt as dt_util  # noqa: E402

from custom_components.house_rules import wakeup as W  # noqa: E402

dt_util.set_default_time_zone(dt_util.get_time_zone("Europe/Berlin"))
fails = 0


def ok(c, m, *extra):
    global fails
    fails += not c
    print("  ok:" if c else "• FAIL:", m, *(extra if not c else ()))


def at(day, hh, mm=0):
    """A timestamp: day of November 2026 (9 = Monday), local time."""
    return datetime(2026, 11, day, hh, mm, tzinfo=dt_util.DEFAULT_TIME_ZONE).timestamp()


# ---------------------------------------------------------------------- pure logic
m = W.default_model()
r = W.decide({"empty": 15, "hours": 4, "rooms": ["Bad", "Flur"], "strong": False}, m, "work", 3 * 60)
ok(not r["ok"], "Nachts 3 Uhr, Bett 15 Min. leer, Bad + Flur → kein Aufstehen", r)
r = W.decide({"empty": 40, "hours": 4, "rooms": ["Küche"], "strong": True}, m, "work", 3 * 60)
ok(not r["ok"] and r["reason"] == "window", "Nachts 3 Uhr, sogar 40 Min. in der Küche → außerhalb des Morgenfensters", r)
r = W.decide({"empty": 14, "hours": 8.5, "rooms": ["Küche"], "strong": True}, m, "work", 7 * 60 + 12)
ok(r["ok"] and r["conf"] >= 0.8, "Werktag 7:12, Bett 14 Min. leer, Küche belegt → aufgestanden", r)
r = W.decide({"empty": 9, "hours": 8.5, "rooms": ["Küche"], "strong": True}, m, "work", 7 * 60 + 12)
ok(not r["ok"] and r["reason"] == "wait", "nur 9 Min. leer (unter der Schwelle 10) → noch nicht", r)
r = W.decide({"empty": 14, "hours": 2, "rooms": ["Küche"], "strong": True}, m, "work", 7 * 60)
ok(not r["ok"] and r["reason"] == "early_night", "erst 2 h geschlafen → nicht (außer sehr sicher)", r)
r = W.decide({"empty": 14, "hours": 8, "rooms": [], "strong": False}, m, "work", 7 * 60)
ok(not r["ok"], "ohne jedes andere Zeichen reicht die normale Schwelle nicht", r)
r = W.decide({"empty": 14, "hours": 8, "rooms": ["Küche"], "strong": True}, m, "free", 6 * 60 + 40)
ok(not r["ok"], "freier Tag 6:40 (üblich 8:30): früher als sonst → braucht länger leer", r)
r = W.decide({"empty": 6, "hours": 8.5, "rooms": ["Küche", "Wohnzimmer"], "strong": True}, m, "work", 7 * 60 + 12)
ok(r["ok"] and r["req"] == 5, "Küche und Wohnzimmer seit dem Aufstehen: halbe Wartezeit (6 Min. reichen)", r)
r = W.decide({"empty": 6, "hours": 8.5, "rooms": ["Küche"], "strong": True}, m, "work", 7 * 60 + 12)
ok(not r["ok"] and r["req"] == 10, "nur die Küche: volle Wartezeit", r)

# night trips raise the threshold above them
m2 = W.default_model()
for t in (3, 5, 14, 16, 15):
    W.add_trip(m2, t)
ok(W.need_of(m2, "work") > 16, f"lange Nachtgänge (bis 16 Min.) → Schwelle darüber ({W.need_of(m2, 'work'):.1f})")

# learned get-up times move the window
m3 = W.default_model()
for d, up in enumerate((5 * 60 + 30, 5 * 60 + 35, 5 * 60 + 25, 5 * 60 + 40)):
    W.add_sample(m3, {"day": f"2026-10-0{d + 1}", "kind": "work", "up": up, "src": "yes"})
mean, sd, n = W.window(m3, "work")
ok(abs(mean - 332) < 5 and n >= 4, f"gelernt: werktags um 5:32 auf ({W.hm(mean)}, ±{sd:.0f})")
r = W.decide({"empty": 14, "hours": 6, "rooms": ["Küche"], "strong": True}, m3, "work", 5 * 60 + 45)
ok(r["ok"], "Frühaufsteher 5:45 nach dem Lernen → erkannt", r)

# feedback
m4 = W.default_model()
m4["last"] = {"kind": "work", "day": "2026-11-09"}
W.learn_answer(m4, "early")
n1 = W.need_of(m4, "work")
ok(n1 > 14, f"„Nein, zu früh“ → Schwelle steigt (10 → {n1:.1f})")
m4["last"] = {"kind": "work", "day": "2026-11-10"}
W.learn_answer(m4, "late")
ok(W.need_of(m4, "work") < n1, f"„war schon früher wach“ → Schwelle sinkt ({W.need_of(m4, 'work'):.1f})")
ok(W.need_of(m4, "free") == 10, "freie Tage lernen getrennt")
ok(W.should_ask({"detections": 3}, 0.9, 0) and not W.should_ask({"detections": 9, "last_ask": 100}, 0.9, 200) and W.should_ask({"detections": 9, "last_ask": 0}, 0.9, 8 * 86400), "Rückfrage: die ersten 7, dann ~1× pro Woche")
ok(W.should_ask({"detections": 30, "last_ask": 100}, 0.5, 200), "Rückfrage, wenn unsicher")


# ---------------------------------------------------------------------- the class on a fake core
class St(SimpleNamespace):
    pass


class FakeCore(SimpleNamespace):
    @property
    def mode(self):
        return self.data["mode"]


def world(day=9):
    clock = {"t": at(day - 1, 23)}
    states = {}
    class Occ(set):
        """occupied rooms, with the time each became occupied (room_tracker.changed_at)"""

        times: dict = {}

        def add(self, rid):
            if rid not in self:
                self.times[rid] = clock["t"]
            super().add(rid)

        def discard(self, rid):
            if rid in self:
                self.times[rid] = clock["t"]
            super().discard(rid)

    occupied = Occ()
    occupied.times = {}
    tasks = []
    history = []
    sent = []
    ended = []

    def setst(eid, state, t=None):
        states[eid] = St(entity_id=eid, state=state, attributes={}, last_changed=dt_util.utc_from_timestamp(t or clock["t"]))

    admin = SimpleNamespace(id="u_admin", is_active=True, is_admin=True)

    async def get_user(uid):
        return admin if uid == "u_admin" else None

    hass = SimpleNamespace(
        states=SimpleNamespace(get=states.get),
        bus=SimpleNamespace(async_listen=lambda *_a, **_k: (lambda: None)),
        async_create_task=lambda c: tasks.append(c),
        auth=SimpleNamespace(async_get_user=get_user),
        data={},
    )
    devices = {
        "binary_sensor.bett": {"entity_id": "binary_sensor.bett", "name": "Bett", "kind": "zone", "room": "schlafzimmer"},
        "binary_sensor.bettkante": {"entity_id": "binary_sensor.bettkante", "name": "Bettkante", "kind": "zone", "room": "schlafzimmer"},
        "light.kueche": {"entity_id": "light.kueche", "name": "Küchenlicht", "kind": "light", "room": "kueche"},
    }
    rooms = {
        "schlafzimmer": {"id": "schlafzimmer", "name": "Schlafzimmer", "presence": ["binary_sensor.sz"], "doors": []},
        "kueche": {"id": "kueche", "name": "Küche", "presence": ["binary_sensor.k"], "doors": []},
        "bad": {"id": "bad", "name": "Bad", "presence": [], "door_logic": True, "doors": ["binary_sensor.badtuer"]},
    }
    core = FakeCore(
        data={"mode": "home"},
        save=lambda: None,
        push=lambda *_a: None,
        starting=lambda: False,
        users={"u_admin": "Admin"},
        checker=SimpleNamespace(_workday=lambda now: now.weekday() < 5, window=lambda name: (6, 10)),
        inventory=SimpleNamespace(devices=devices, persons={"p": {"id": "p", "entity_id": "person.p", "phones": ["mobile_app_x"]}}, room_of=lambda e: devices.get(e, {}).get("room")),
        room_tracker=SimpleNamespace(rooms=rooms, occupied=lambda rid: rid in occupied, changed_at=lambda rid: occupied.times.get(rid, 0.0)),
        history=SimpleNamespace(manual={}, add=lambda kind, what, why, **_k: history.append(f"{what} | {why}")),
        notifier=SimpleNamespace(),
    )
    core.mode_auto = SimpleNamespace(end_now=lambda mode, why: (ended.append(why), core.data.update(mode="home"), w.mode_set("sleep", "home", False)))

    async def send(kind, key, title, message, **kw):
        sent.append((kind, key, message, [a["action"] for a in kw.get("data", {}).get("actions", [])]))
        return kw.get("services", [])

    core.notifier.send = send
    setst("person.p", "home")
    states["person.p"].attributes = {"user_id": "u_admin"}
    w = W.WakeUp(hass, core, clock=lambda: clock["t"])
    core.wakeup = w
    w.config.update(on=True)

    def run(until, step=30):
        while clock["t"] < until:
            clock["t"] += step
            w.tick()
        while tasks:
            asyncio.run(tasks.pop(0))

    def sleep_now():
        setst("binary_sensor.bett", "on")
        setst("binary_sensor.bettkante", "off")
        core.data["mode"] = "sleep"
        w.mode_set("home", "sleep", False)

    return SimpleNamespace(w=w, core=core, clock=clock, setst=setst, occupied=occupied, run=run, history=history, sent=sent, ended=ended, sleep_now=sleep_now, states=states)


print("Klasse: eine Nacht")
X = world()
ok(X.w.beds() == ["binary_sensor.bett"], "Bett automatisch gefunden (Bettkante zählt nicht)", X.w.beds())
X.sleep_now()
X.run(at(9, 3))
# night trip: 15 minutes in the bathroom, then back
X.setst("binary_sensor.bett", "off")
X.occupied.add("bad")
X.run(at(9, 3, 15))
X.occupied.discard("bad")
X.setst("binary_sensor.bett", "on")
X.run(at(9, 3, 25))
ok(X.core.data["mode"] == "sleep" and not X.ended, "Nachtgang 15 Min. (Bad) → Schlafen bleibt", X.ended)
ok(X.w.model["trips"] == [15.0], "Nachtgang gemerkt", X.w.model["trips"])
# a sensor flicker in the morning does not start the empty time again
X.run(at(9, 6, 58))
X.setst("binary_sensor.bett", "off")
X.run(at(9, 7, 3))
X.setst("binary_sensor.bett", "on")
X.run(at(9, 7, 3) + 20)
X.setst("binary_sensor.bett", "off")
X.occupied.add("kueche")
X.run(at(9, 7, 6))
ok(not X.ended, "7:06, Bett 8 Min. leer → noch nicht", X.w.status)
X.run(at(9, 7, 20))
ok(X.ended and X.core.data["mode"] == "home", "Bett über 10 Min. leer + Küche → Schlafen aus", X.w.status)
ok(abs(X.w.model["last"]["up"] - (6 * 60 + 58)) <= 1, f"aufgestanden um 6:58: das kurze Zurück ins Bett (20 s) zählt nicht ({W.hm(X.w.model['last']['up'])})")
ok(any("Aufstehen erkannt: Bett" in h and "Küche belegt" in h for h in X.history), "Verlauf auf Deutsch mit den Gründen", X.history)
ok(X.sent and X.sent[0][0] == "wakeup" and len(X.sent[0][3]) == 3, "Rückfrage „stimmt das?“ mit 3 Knöpfen", X.sent)
last = X.w.model["last"]
need0 = W.need_of(X.w.model, "work")
ok(not X.w.answer(f"EARLY_{last['id']}", "u_other"), "Knopf von jemand anderem → ignoriert")
ok(any("ignoriert" in h for h in X.history), "… und im Verlauf vermerkt")
ok(not X.w.answer("EARLY_falsch", "u_admin"), "Knopf einer alten Meldung → ignoriert")
ok(X.w.answer(f"EARLY_{last['id']}", "u_admin") and W.need_of(X.w.model, "work") > need0, f"„Nein, zu früh“ → Schwelle {need0:.0f} → {W.need_of(X.w.model, 'work'):.0f}")
ok(not X.w.answer(f"YES_{last['id']}", "u_admin"), "zweite Antwort zählt nicht")

print("Klasse: Neustart in der Nacht")
X = world()
X.sleep_now()
X.run(at(9, 2))
X.setst("binary_sensor.bett", "off")
X.run(at(9, 2, 5))
data = X.core.data
# a new WakeUp on the same store (= after a restart); the bed sensor comes back "on" with a fresh last_changed
w2 = W.WakeUp(X.w.hass, X.core, clock=X.w.clock)
X.core.wakeup = X.w = w2
X.setst("binary_sensor.bett", "on")
X.run(at(9, 2, 10))
ok(X.core.data["mode"] == "sleep" and not X.ended and w2.night.get("since") == at(8, 23), "nach dem Neustart: dieselbe Nacht, Schlafen bleibt", w2.night)
ok(w2.night.get("empty") is None, "wieder im Bett → leer-Zeit vorbei")

print("Klasse: von Hand")
X = world()
X.sleep_now()
X.run(at(9, 6, 30))
X.setst("binary_sensor.bett", "off")
X.run(at(9, 6, 40))
X.core.data["mode"] = "home"
X.w.mode_set("sleep", "home", True)
s = [x for x in X.w.model["samples"] if x["src"] == "manual"]
ok(s and abs(s[0]["up"] - (6 * 60 + 30)) <= 1, "Schlafen von Hand aus um 6:40 (Bett seit 6:30 leer) → Lernbeispiel „auf um 6:30“", X.w.model["samples"])
ok(W.need_of(X.w.model, "work") < 12, f"… und die Schwelle sinkt etwas ({W.need_of(X.w.model, 'work'):.1f})")
ok(not X.ended, "kein Ende durch die Erkennung selbst (von Hand war schneller)")

print("Klasse: erst fragen")
X = world()
X.w.config.update(action="ask")
X.sleep_now()
X.run(at(9, 6, 50))
X.setst("binary_sensor.bett", "off")
X.occupied.add("kueche")
X.run(at(9, 7, 30))
ok(X.core.data["mode"] == "sleep" and not X.ended, "„erst fragen“: Schlafen bleibt bis zur Antwort")
ok(X.sent and X.sent[0][1] == "ask" and any(a.startswith("HR_WAKE_END_") for a in X.sent[0][3]), "Frage „Schlafen beenden?“ gesendet", X.sent)
last = X.w.model["last"]
X.run(at(9, 7, 40))
ok(X.core.data["mode"] == "sleep" and len(X.sent) == 1, "keine zweite Frage, solange die erste offen ist")
ok(X.w.answer(f"END_{last['id']}", "u_admin") and X.ended, "„Ja, beenden“ → Schlafen aus")

print("Klasse: letzte Rettung")
X = world()
X.sleep_now()
X.run(at(8, 23, 30))
X.setst("binary_sensor.bett", "off")
X.run(at(9, 0, 50))
ok(not X.ended, "nachts 80 Min. aus dem Bett (Sofa) → noch Schlafen")
X.run(at(9, 1, 5))
ok(X.ended and any("seit 90 Min. leer" in h for h in X.history), "nach 90 Min. leerem Bett endet Schlafen in jedem Fall", X.history)
ok(not X.w.model["samples"], "… ohne etwas daraus zu lernen")

print("Klasse: Bett-Sensor weg")
X = world()
X.sleep_now()
ok(X.w.ends_sleep(), "Bett-Sensor da → die Erkennung beendet Schlafen")
X.setst("binary_sensor.bett", "unavailable")
ok(not X.w.ends_sleep(), "Bett-Sensor nicht erreichbar → Schlafen endet wie ohne Erkennung (bleibt nicht ewig)")
X.setst("binary_sensor.bett", "on")
X.clock["t"] = at(9, 16)
ok(not X.w.ends_sleep(), "nach 16 h Schlafen hält die Erkennung nicht mehr")

print("Klasse: aus")
X = world()
X.w.config.update(on=False)
X.sleep_now()
X.setst("binary_sensor.bett", "off")
X.occupied.add("kueche")
X.run(at(9, 9))
ok(not X.ended and not X.w.ends_sleep(), "Funktion aus → nichts")

print("Klasse: Hausmodus-Automatik beendet Schlafen wirklich")
from custom_components.house_rules import modes as M  # noqa: E402

def mode_world():
    calls = []
    core = SimpleNamespace(data={"mode": "sleep"}, saves=0)
    core.mode = "sleep"
    cfg = M.default_mode_auto()
    for k in cfg["modes"]:
        cfg["modes"][k]["on"] = False
    cfg["modes"]["sleep"].update(on=True, when=[{"subject": "zone:binary_sensor.bett", "verb": "is_occupied", "for": "5m"}], end={"on": True, "when": [{"subject": "zone:binary_sensor.bett", "verb": "is_free", "for": "5m"}]})
    core.data["mode_auto"] = cfg
    bed = {"on": True}
    core.checker = SimpleNamespace(holds=lambda c: ((bed["on"] if c["verb"] == "is_occupied" else not bed["on"]), None, None))
    core.describer = SimpleNamespace(clause=lambda c, _k: c["verb"])
    core.wakeup = SimpleNamespace(tick=lambda: None, ends_sleep=lambda: True)
    core.inventory = SimpleNamespace(persons={"person.a": {}}, person_home=lambda p: True)
    core.starting = lambda: False
    core.save = lambda: None
    core.push = lambda _k: None
    core.mode_label = lambda m: m

    async def auto_mode(target, text):
        calls.append((target, text))
        core.mode = target
    core.auto_mode = auto_mode
    loop = asyncio.new_event_loop()
    hass = SimpleNamespace(loop=loop, async_create_task=lambda co: loop.run_until_complete(co))
    ma = M.ModeAuto(hass, core)
    return ma, core, bed, calls

ma, core, bed, calls = mode_world()
ma.evaluate()
ok(not calls and core.mode == "sleep", "Bett belegt: Schlafen bleibt")
bed["on"] = False  # up: the bed is empty, so the start condition fails at the same moment
ma.evaluate()
ok(not calls and core.mode == "sleep", "Bett leer, Erkennung noch nicht: Schlafen bleibt (wartet aufs Aufstehen)")
ma.end_now("sleep", "Aufstehen erkannt")
ma.evaluate()
ok(calls and calls[-1][0] == "home" and core.mode == "home", "Aufstehen erkannt → wirklich Zuhause (vorher blieb Schlafen)", calls)
ma.evaluate()
ok(core.mode == "home" and "sleep" not in ma._rt["hold_off"], "danach Zuhause, Sperre nach dem Wechsel aufgehoben", ma._rt)
bed["on"] = True
ma.evaluate()
ok(core.mode == "home", "wieder ins Bett: startet erst nach der Wartezeit neu")

print("Klasse: Durchgehen zählt, Bett-Geist setzt nicht zurück")
Y = world(10)
Y.sleep_now()
Y.run(at(10, 6, 30))
Y.setst("binary_sensor.bett", "off")
Y.run(at(10, 6, 30) + 30)
Y.occupied.add("kueche")  # through the kitchen …
Y.run(at(10, 6, 32))
Y.occupied.discard("kueche")  # … and on to the bathroom (only weak)
Y.occupied.add("bad")
Y.setst("binary_sensor.bett", "on")  # the bed sensor still sees a ghost for minutes
Y.run(at(10, 6, 34))
ok(Y.w.night.get("empty") and abs(Y.w.night["empty"] - (at(10, 6, 30) + 30)) < 60, "Bett meldet wieder belegt, während im Bad jemand ist → Leerzeit läuft weiter", Y.w.night)
ok(set(Y.w.night.get("seen") or []) >= {"kueche", "bad"}, "Küche zählt, obwohl gerade niemand mehr drin ist", Y.w.night.get("seen"))
ok(not Y.ended, "nach 3,5 Min. noch nicht", Y.w.status)
Y.run(at(10, 6, 38))
ok(Y.ended, "5 Min. nach dem Aufstehen: Küche + Bad seit dem Aufstehen → Schlafen aus (vorher 25 Min.)", Y.w.status)

print("Klasse: ein Raum, der schon vorher belegt war, zählt nicht")
Z = world(15)
Z.sleep_now()
Z.occupied.add("bad")  # the bathroom held by its door logic since the evening
Z.run(at(15, 6, 36))
Z.setst("binary_sensor.bett", "off")  # up at 06:36 …
Z.run(at(15, 6, 37))
Z.setst("binary_sensor.bett", "on")  # … and back in bed at 06:37
Z.run(at(15, 6, 50))
ok(not Z.ended and Z.core.data["mode"] == "sleep", "zurück im Bett, Bad nur noch von gestern belegt → Schlafen bleibt (vorher nach 10 Min. beendet)", Z.w.status)
ok(not Z.w.night.get("empty"), "Rückkehr ins Bett zählt (Leerzeit vorbei)", Z.w.night)

print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
