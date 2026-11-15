"""Reinschau-Licht (glow.py) without Home Assistant: the colour "like the light rules" takes the colour of the rule that
switches the room on when someone comes in, with its "je nach …" variants, at the glow's brightness; the global
"when" (time window, sleep, guests) goes into every room's rule; an own colour has no variants.
    python3 tools/testha/test_glow.py
"""

import importlib.util
import sys
import types

ROOT = "custom_components/house_rules"
pkg = types.ModuleType("hr")
pkg.__path__ = [ROOT]
sys.modules["hr"] = pkg
for m in ("lightspec", "glow"):
    spec = importlib.util.spec_from_file_location(f"hr.{m}", f"{ROOT}/{m}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"hr.{m}"] = mod
    spec.loader.exec_module(mod)
G = sys.modules["hr.glow"]
fails = 0


def ok(c, m, *extra):
    global fails
    if not c:
        fails += 1
    print(("  ok: " if c else "• FAIL: ") + m, *([] if c else extra))


rules = [
    {
        "id": "in", "kind": "when", "enabled": True, "trigger": [{"subject": "room:flur", "verb": "is_occupied"}], "when": [], "lights": [],
        "action": {"mode": "on", "brightness": 80, "color": "neutral"},
        "variants": [
            {"id": "abd", "when": [{"subject": "time", "verb": "evening"}], "mode": "on", "brightness": 50, "color": "warm"},
            {"id": "nt", "when": [{"subject": "time", "verb": "night"}], "mode": "on", "brightness": 5, "color": "kerze"},
        ],
    }
]
g = G.clean_glow({"on": True, "sources": [{"room": "kuche", "by": "occupied", "door": "binary_sensor.k", "door_state": "open"}], "lights": ["light.flur"], "brightness": 7}, None, {"flur", "kuche"})
ok(g["color"] == "rules", "neu: Farbe wie die Lichtregeln", g)
r = G.glow_rules("flur", g, "Flur", rules, {"dark": "time", "from": "21:00", "to": "06:00", "not_sleep": False})
a = r[0]
ok(a["action"]["color"] == "neutral" and a["action"]["brightness"] == 7, "Grundfarbe der Betreten-Regel, Helligkeit des Glimmens", a["action"])
ok([v["color"] for v in a["variants"]] == ["warm", "kerze"] and all(v["brightness"] == 7 for v in a["variants"]), "„je nach …“: abends warm, nachts Kerze – mit 7 %", a["variants"])
ok(any(c.get("subject") == "time" and c.get("from") == "21:00" for c in a["when"]), "globale Zeit (21–6 Uhr) in der Regel", a["when"])
ok(not any(c.get("subject") == "mode" for c in a["when"]), "global „nicht bei Schlafen“ aus: keine Hausmodus-Bedingung", a["when"])
r2 = G.glow_rules("flur", {**g, "color": "#ff0000"}, "Flur", rules, None)
ok(r2[0]["action"]["color"] == "#ff0000" and not r2[0]["variants"], "eigene Farbe: genau diese, ohne Varianten", r2[0]["action"])
ok(any(c.get("subject") == "mode" for c in r2[0]["when"]), "Standard: nicht bei Schlafen")
ok(G.clean_global({"dark": "time", "from": "25:00", "to": "05:30"}, None) == {"dark": "time", "from": "20:00", "to": "05:30", "not_sleep": True, "not_guests": False}, "falsche Uhrzeit wird nicht übernommen")
# a door with a sensor: someone next door + door open / only the door / only someone next door
both = G.source_clause({"room": "kuche", "by": "occupied", "door": "binary_sensor.k", "door_state": "open"})
ok(both["verb"] == "all" and {c["verb"] for c in both["items"]} == {"is_occupied", "is_open"}, "belegt + Tür offen", both)
door = G.source_clause({"room": "kuche", "by": "door", "door": "binary_sensor.k", "door_state": "open"})
ok(door == {"subject": "binary_sensor.k", "verb": "is_open"}, "nur Tür offen: ohne Belegung", door)
occ = G.source_clause({"room": "kuche", "by": "occupied", "door": None, "door_state": "open"})
ok(occ == {"subject": "room:kuche", "verb": "is_occupied"}, "nur belegt: ohne Tür", occ)
c = G.clean_glow({"sources": [{"room": "kuche", "by": "door", "door": None}, {"room": "kuche", "by": "door", "door": "binary_sensor.k"}]}, None, {"flur", "kuche"})
ok(len(c["sources"]) == 1 and c["sources"][0]["by"] == "door", "„nur Tür“ ohne Tür fällt weg", c["sources"])
print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
