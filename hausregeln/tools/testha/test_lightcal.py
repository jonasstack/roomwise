"""Lampen abgleichen (lightcal.py) without Home Assistant: corrections per lamp and reference colour, interpolation on
the hue circle and between whites, brightness factor, cleaning of stored values, and what reaches light.turn_on.
    python3 tools/testha/test_lightcal.py
"""

import importlib.util
import sys
import types

ROOT = "../custom_components/roomwise/house_rules"
pkg = types.ModuleType("hr")
pkg.__path__ = [ROOT]
sys.modules["hr"] = pkg
for m in ("lightspec", "lightcal"):
    spec = importlib.util.spec_from_file_location(f"hr.{m}", f"{ROOT}/{m}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"hr.{m}"] = mod
    spec.loader.exec_module(mod)
C = sys.modules["hr.lightcal"]
S = sys.modules["hr.lightspec"]
fails = 0


def ok(c, m, *extra):
    global fails
    if not c:
        fails += 1
    print(("  ok: " if c else "• FAIL: ") + m, *([] if c else extra))


# a lamp whose red looks orange-ish: it needs hue 350 for "red"; its blue is too purple: 215 instead of 225
e = C.clean_entry({"hs": {"rot": [350, 100], "blau": [215, 90]}, "k": {"warmweiss": 2500, "kaltweiss": 5800}, "bri": 1.2})
ok(e["hs"] == {"rot": [350.0, 100.0], "blau": [215.0, 90.0]} and e["k"] == {"warmweiss": 2500, "kaltweiss": 5800} and e["bri"] == 1.2, "Eintrag bereinigt", e)
ok(C.correct_hs(e, 0, 100) == (350.0, 100.0), "Rot → genau die abgeglichene Farbe", C.correct_hs(e, 0, 100))
ok(C.correct_hs(e, 225, 100) == (215.0, 90.0), "Blau → genau die abgeglichene Farbe", C.correct_hs(e, 225, 100))
mid = C.correct_hs(e, 112.5, 100)
ok(abs(mid[0] - (112.5 - 10)) < 0.2 and abs(mid[1] - 95) < 0.2, "dazwischen (Grün-Gelb): Versatz gemischt", mid)
wrap = C.correct_hs(e, 300, 100)
ok(abs(wrap[0] - 290) < 0.5 and 90 < wrap[1] < 100, "über den Kreis hinweg (Lila zwischen Blau und Rot: beide −10°, Sättigung gemischt)", wrap)
ok(C.correct_hs(e, 40, 3) == (40, 3), "fast weiß: keine Farbkorrektur")
ok(C.correct_hs({"hs": {}}, 40, 80) == (40, 80), "nicht abgeglichen: unverändert")
ok(C.correct_kelvin(e, 2700) == 2500 and C.correct_kelvin(e, 5500) == 5800, "Weiß: genau die abgeglichenen Werte")
ok(abs(C.correct_kelvin(e, 4100) - 4150) < 1, "Weiß dazwischen linear", C.correct_kelvin(e, 4100))
ok(C.correct_kelvin(e, 2200) == 2000, "unter dem wärmsten: dessen Versatz", C.correct_kelvin(e, 2200))

a = C.adjust({"mode": "on", "brightness": 50, "color": "#ff0000"}, e)
ok(a["color"] == "hs:350.0,100.0" and a["brightness"] == 60, "Regel „rot 50 %“ → diese Lampe hs 350 und 60 %", a)
ok(C.adjust({"mode": "on", "brightness": 90, "color": "warm"}, e)["color"] == "k:2500", "„warm“ (2700 K) → 2500 K")
ok(C.adjust({"mode": "on", "brightness": 95, "color": "none"}, e)["brightness"] == 100, "Helligkeit begrenzt auf 100 %")
ok(C.adjust({"mode": "off"}, e) == {"mode": "off"}, "aus bleibt aus")
ok(C.adjust({"mode": "on", "color": "#ff0000"}, None) == {"mode": "on", "color": "#ff0000"}, "ohne Abgleich: unverändert")

attrs = {"supported_color_modes": ["hs", "color_temp"], "min_color_temp_kelvin": 2000, "max_color_temp_kelvin": 6500, "supported_features": 32}
d = S.service_data(attrs, C.adjust({"mode": "on", "brightness": 50, "color": "#ff0000"}, e))
ok(d.get("hs_color") == [350.0, 100.0] and d.get("brightness_pct") == 60, "light.turn_on bekommt die korrigierten Werte", d)

all_ = C.clean({"light.a": {"hs": {"rot": [10, 100]}}, "light.b": {"bri": 1.0}, "switch.x": {"bri": 2}, "light.c": None}, {"light.c": {"bri": 2}})
ok(set(all_) == {"light.a"}, "leere Einträge, andere Geräte und null werden entfernt", all_)
ok(C.clean_entry({"hs": {"rot": [10, 200], "grau": [1, 1]}, "k": {"warmweiss": 50000}, "bri": 9})["bri"] == 3.0, "Werte begrenzt")
ok(C.ref_color("rot") == "hs:0.0,100.0" and C.ref_color("neutralweiss") == "k:4000", "Referenzfarben für die Vorschau")
print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
