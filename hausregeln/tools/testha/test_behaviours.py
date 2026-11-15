"""Offline test: the room behaviours ("Raumverhalten", dissolved in the redesign) become ordinary rules once
(behaviours.migrate).

Runs inside the test container (Home Assistant installed):
  docker cp tools/testha/test_behaviours.py hr-test-ha:/tmp/ && docker exec hr-test-ha python3 /tmp/test_behaviours.py
"""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG_DIR", "/config"))  # CI: a folder whose custom_components/ holds roomwise
from custom_components.roomwise.house_rules import behaviours as B  # noqa: E402

FAIL = []


def ok(cond, what, extra=""):
    print(("  ok: " if cond else "• FAIL: ") + what, extra if not cond else "")
    if not cond:
        FAIL.append(what)


def room(rid, name, **more):
    return {"id": rid, "name": name, "presence": ["binary_sensor.p_" + rid], "motion": [], "door_logic": False, "behaviours": {}, **more}


def core(data, rooms, devices, features=None, plans=()):
    """a stand-in for HouseRules with what migrate() reads"""
    feats = {"light": True, "heating": True, **(features or {})}
    n = iter(range(100))
    c = SimpleNamespace(data=data, rooms=rooms, saved=0)
    c.feature = lambda f: feats.get(f, False)
    c.inventory = SimpleNamespace(in_room=lambda kind, rid: [e for e, (k, r) in devices.items() if k == kind and r == rid])
    c.plans = SimpleNamespace(plan_on=lambda kind, rid: (kind, rid) in plans)
    c.sanitize = lambda raw: {**raw, "id": f"r_m{next(n)}", "meta": {"origin": "user"}}

    def save():
        c.saved += 1

    c.save = save
    return c


DEV = {
    "light.flur": ("light", "flur"),
    "light.bad": ("light", "bad"),
    "climate.bad": ("climate", "bad"),
    "media_player.wz": ("media", "wz"),
    "light.wz": ("light", "wz"),
}
ROOMS = {
    "flur": room("flur", "Flur", behaviours={"light_on_enter": True, "light_off_empty": True}),
    "bad": room("bad", "Bad", behaviours={"heat_eco_empty": True}),
    "wz": room("wz", "Wohnzimmer", behaviours={"media_pause_empty": True, "light_on_enter": True}),
    "keller": room("keller", "Keller", presence=[], behaviours={"light_on_enter": True}),
}

print("Raumverhalten → Regeln")
data = {"rules": [], "behaviours": {}, "settings": {"features": {"behaviours": True}}}
c = core(data, ROOMS, DEV, plans={("light", "wz")})
made = B.migrate(c)
rules = data["rules"]
names = sorted(r["name"] for r in rules)
ok(made == 5 and len(rules) == 5, "5 Regeln gemacht (Flur 2, Bad 1, Wohnzimmer 2; Keller ohne Sensor keine)", names)
flur_on = next((r for r in rules if r["when"][0] == {"subject": "room:flur", "verb": "entered"}), None)
ok(flur_on and flur_on["enabled"] and flur_on["and"] == [{"subject": "room:flur", "verb": "is_dark"}], "Flur: Licht an beim Reinkommen, an, nur im Dunkeln", flur_on)
ok(flur_on and flur_on["then"][0]["subject"] == "all:light@flur" and flur_on["options"]["manual_pause"] == "room_empty", "… alle Lichter im Flur, Handschaltung bis der Raum leer ist", flur_on)
ok(all(r["meta"]["origin"] == "room" for r in rules), "Herkunft: Raum")
wz_light = next((r for r in rules if r["when"][0]["subject"] == "room:wz" and r["type"] == "when"), None)
ok(wz_light and not wz_light["enabled"], "Wohnzimmer hat einen Lichtplan: Regel kommt aus (lief bisher nicht)", wz_light)
wz_media = next((r for r in rules if r["then"][0]["subject"] == "all:media@wz"), None)
ok(wz_media and wz_media["enabled"] and wz_media["type"] == "while", "Wohnzimmer: Musik pausieren als Solange-Regel, an", wz_media)
bad = next((r for r in rules if r["then"][0]["subject"] == "all:climate@bad"), None)
ok(bad and bad["enabled"] and bad["when"][0].get("for") == "1h", "Bad: Heizung sparen nach 1 Std. leer, an", bad)
ok(data.get("behaviours_migrated") is True and c.saved == 1, "gemerkt und gespeichert")
ok(B.migrate(c) == 0 and len(data["rules"]) == 5, "zweiter Start: nichts doppelt")

print("Raumverhalten war aus")
data = {"rules": [], "behaviours": {"light_off_empty": True}, "settings": {"features": {"behaviours": False}}}
c = core(data, {"flur": room("flur", "Flur")}, DEV)
ok(B.migrate(c) == 1 and data["rules"][0]["enabled"] is False, "Funktion aus: Regel (Grundeinstellung für alle Räume) kommt aus", data["rules"])

print("Licht aus")
data = {"rules": [], "behaviours": {}, "settings": {"features": {"behaviours": True}}}
c = core(data, {"flur": room("flur", "Flur", behaviours={"light_on_enter": True})}, DEV, features={"light": False})
ok(B.migrate(c) == 1 and data["rules"][0]["enabled"] is False, "Licht aus: Regel kommt aus", data["rules"])

print("nichts eingeschaltet")
data = {"rules": [], "behaviours": {}, "settings": {"features": {"behaviours": True}}}
c = core(data, {"flur": room("flur", "Flur")}, {"light.flur": ("light", "flur")})
ok(B.migrate(c) == 0 and data["rules"] == [] and data["behaviours_migrated"], "keine Regeln, nur gemerkt")

print("\n" + ("ALLES OK" if not FAIL else f"{len(FAIL)} FEHLER: " + "; ".join(FAIL)))
sys.exit(1 if FAIL else 0)
