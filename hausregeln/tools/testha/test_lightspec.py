"""Offline test of the light settings (lightspec.py): colour strings, conversions between colour modes,
what each kind of lamp gets sent, "already like this?" and snapshots. Needs no Home Assistant:
  python3 tools/testha/test_lightspec.py
"""

import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location("lightspec", pathlib.Path(__file__).resolve().parents[2] / "custom_components/house_rules/lightspec.py")
L = importlib.util.module_from_spec(spec)
spec.loader.exec_module(L)

FAIL = []


def ok(cond, what, extra=""):
    print(("  ok: " if cond else "• FAIL: ") + what, "" if cond else extra)
    if not cond:
        FAIL.append(what)


def lamp(modes, **kw):
    return {"supported_color_modes": modes, "min_color_temp_kelvin": 2200, "max_color_temp_kelvin": 6500, "supported_features": 4 | 8 | 32, **kw}


RGB, RGBW, RGBWW, HS, XY = lamp(["rgb"]), lamp(["rgbw", "color_temp"]), lamp(["rgbww"]), lamp(["hs", "color_temp"]), lamp(["xy"])
CT, DIM, ONOFF, WHITE = lamp(["color_temp"]), lamp(["brightness"]), lamp(["onoff"]), lamp(["hs", "white"])

print("colour strings")
ok(L.parse_color("warm") == ("kelvin", (2700,)), "Vorgabe warm = 2700 K")
ok(L.parse_color("k:3200") == ("kelvin", (3200,)), "k:3200")
ok(L.parse_color("#FF8800") == ("rgb", (255, 136, 0)), "Hex groß/klein")
ok(L.parse_color("rgbw:255,0,0,40") == ("rgbw", (255, 0, 0, 40)), "rgbw")
ok(L.parse_color("rgbww:1,2,3,4,5") == ("rgbww", (1, 2, 3, 4, 5)), "rgbww")
ok(L.parse_color("hs:390,150") == ("hs", (30, 100)), "hs wird begrenzt")
ok(L.parse_color("xy:0.7,0.3") == ("xy", (0.7, 0.3)), "xy")
ok(L.parse_color("rgbw:1,2,3") is None and L.parse_color("blau") is None, "Unsinn = keine Farbe")
ok(L.color_ok("none") and L.color_ok("white") and not L.color_ok("#12"), "color_ok")

print("conversions")
ok(L.rgb_to_hs(255, 0, 0) == (0.0, 100.0) and L.hs_to_rgb(120, 100) == (0, 255, 0), "rgb ↔ hs")
# exactly Home Assistant's color_RGB_to_xy / color_xy_to_RGB (values from its tests/util/test_color.py): a colour sent
# as xy_color then looks the same as the same colour sent as rgb_color (the live preview sends rgb_color)
HA_XY = {(255, 255, 255): (0.323, 0.329), (0, 0, 255): (0.136, 0.04), (0, 255, 0): (0.172, 0.747), (255, 0, 0): (0.701, 0.299), (128, 0, 0): (0.701, 0.299)}
ok(all(L.rgb_to_xy(*c) == xy for c, xy in HA_XY.items()), "rgb → xy wie Home Assistant (Wide RGB D65)", {c: L.rgb_to_xy(*c) for c in HA_XY})
HA_RGB = {(0.35, 0.35): (255, 243, 222), (1, 0): (255, 0, 60), (0, 1): (0, 255, 0), (0, 0): (0, 63, 255)}
ok(all(L.xy_to_rgb(*xy) == c for xy, c in HA_RGB.items()), "xy → rgb wie Home Assistant", {xy: L.xy_to_rgb(*xy) for xy in HA_RGB})
ok(L.rgb_to_xy(0, 0, 0) == (0.3127, 0.329), "schwarz → Weißpunkt (statt 0, 0)")
d = L.service_data(XY, {"brightness": 50, "color": "#ff8a3d"})
ok(d["xy_color"] == list(L.rgb_to_xy(255, 138, 61)) == [0.577, 0.37], "XY-Lampe bekommt dieselben xy-Werte wie Home Assistant aus rgb_color", d)
r, g, b = L.xy_to_rgb(*L.rgb_to_xy(255, 0, 0))
ok(r == 255 and g < 10 and b < 10, "rot über xy und zurück", (r, g, b))
ok(L.rgb_to_rgbw(255, 128, 128) == (255, 0, 0, 255) or L.rgb_to_rgbw(255, 128, 128)[3] > 0, "rgb → rgbw nutzt den Weißkanal", L.rgb_to_rgbw(255, 128, 128))
ok(L.rgbw_to_rgb(*L.rgb_to_rgbw(255, 136, 0)) == (255, 136, 0), "rgb → rgbw → rgb ohne Weiß bleibt", L.rgbw_to_rgb(*L.rgb_to_rgbw(255, 136, 0)))
ok(L.kelvin_to_rgb(2700)[2] < L.kelvin_to_rgb(6500)[2], "2700 K ist wärmer als 6500 K")
ok(2500 < L.xy_to_kelvin(*L._srgb_xy(*L.kelvin_to_rgb(3000))) < 3500, "xy → Kelvin um 3000 K", L.xy_to_kelvin(*L._srgb_xy(*L.kelvin_to_rgb(3000))))

print("what each lamp gets")
d = L.service_data(RGB, {"mode": "on", "brightness": 50, "color": "#ff8800"})
ok(d == {"brightness_pct": 50, "rgb_color": [255, 136, 0]}, "RGB-Lampe: rgb_color", d)
d = L.service_data(RGBW, {"brightness": 50, "color": "rgbw:255,0,0,40"})
ok(d.get("rgbw_color") == [255, 0, 0, 40], "RGBW-Lampe: rgbw_color genau", d)
d = L.service_data(RGBW, {"brightness": 50, "color": "#ff0000"})
ok(d.get("rgbw_color") == [255, 0, 0, 0], "RGBW-Lampe: Hex → rgbw", d)
d = L.service_data(RGBWW, {"brightness": 50, "color": "#ffffff"})
ok(d.get("rgbww_color") and d["rgbww_color"][3] + d["rgbww_color"][4] > 200, "RGBWW-Lampe: Weiß über die Weißkanäle", d)
d = L.service_data(HS, {"brightness": 50, "color": "#ff0000"})
ok(d.get("hs_color") == [0.0, 100.0], "HS-Lampe: hs_color", d)
d = L.service_data(XY, {"brightness": 50, "color": "hs:240,100"})
ok(d.get("xy_color") and d["xy_color"][1] < 0.1, "XY-Lampe: blau als xy", d)
d = L.service_data(HS, {"brightness": 50, "color": "k:3000"})
ok(d.get("color_temp_kelvin") == 3000, "Farb+Weiß-Lampe: Kelvin direkt", d)
d = L.service_data(XY, {"brightness": 50, "color": "k:3000"})
ok("xy_color" in d and "color_temp_kelvin" not in d, "Nur-Farb-Lampe: Kelvin als Farbe", d)
d = L.service_data(CT, {"brightness": 40, "color": "#ff6600"})
ok(d.get("color_temp_kelvin") == 2200, "Nur-Weiß-Lampe: Orange → wärmstes Weiß", d)
d = L.service_data(CT, {"brightness": 40, "color": "k:9000"})
ok(d.get("color_temp_kelvin") == 6500, "Kelvin auf den Bereich der Lampe begrenzt", d)
d = L.service_data(DIM, {"brightness": 40, "color": "#ff0000"})
ok(d == {"brightness_pct": 40}, "Nur-Helligkeit-Lampe: nur Helligkeit", d)
d = L.service_data(ONOFF, {"brightness": 40, "color": "#ff0000", "transition": 3})
ok(d == {"transition": 3}, "An/aus-Lampe: nur an (ohne Helligkeit und Farbe)", d)
d = L.service_data(DIM, {"bri": 128})
ok(d == {"brightness": 128}, "Helligkeit 0–255 genau", d)
d = L.service_data(WHITE, {"brightness": 60, "color": "white"})
ok(d == {"white": 153}, "Weißkanal (white) mit der Helligkeit", d)
d = L.service_data(lamp(["hs"], effect_list=["colorloop", "candle"]), {"color": "none", "brightness": 80, "effect": "candle", "transition": 2.5, "flash": "short"})
ok(d == {"brightness_pct": 80, "effect": "candle", "transition": 2.5, "flash": "short"}, "Effekt, Übergang, Blitz; Farbe bleibt", d)
d = L.service_data(lamp(["hs"], effect_list=["colorloop"], supported_features=0), {"effect": "candle", "transition": 2, "flash": "long"})
ok(d == {"brightness_pct": 100}, "Effekt/Übergang/Blitz nur, wenn die Lampe es kann", d)

print("per light")
s = L.clean_action({"mode": "on", "brightness": 60, "color": "warm", "per_light": {"light.a": {"color": "#ff0000"}, "light.b": {"brightness": 10, "mode": "off"}, "switch.x": {}}})
ok(set(s["per_light"]) == {"light.a", "light.b"}, "per_light nur für Lichter", s)
ok(L.for_light(s, "light.a") == {"mode": "on", "brightness": 60, "color": "#ff0000"}, "Lampe a: eigene Farbe, sonst wie alle", L.for_light(s, "light.a"))
ok(L.for_light(s, "light.b")["mode"] == "off" and L.for_light(s, "light.c")["color"] == "warm", "Lampe b aus, c wie alle")
ok(L.clean_action({"mode": "scene", "scene": "scene.abend"})["scene"] == "scene.abend", "Szene")
ok(L.clean_action({"brightness": "$hell"})["brightness"] == "$hell", "Wert aus Variable bleibt stehen")
ok(L.clean_action({"color": "lila"})["color"] == "warm", "unbekannte Farbe → warm")

print("already like this?")
on = lambda **a: ("on", {"supported_color_modes": ["hs", "color_temp"], "min_color_temp_kelvin": 2200, "max_color_temp_kelvin": 6500, **a})
st, a = on(brightness=128, color_mode="hs", hs_color=[0, 100])
ok(L.matches(st, a, {"mode": "on", "brightness": 50, "color": "#ff0000"}), "rot 50 % = rot 50 %")
ok(not L.matches(st, a, {"mode": "on", "brightness": 50, "color": "#0000ff"}), "rot ≠ blau")
ok(not L.matches(st, a, {"mode": "on", "brightness": 90, "color": "#ff0000"}), "50 % ≠ 90 %")
ok(not L.matches(st, a, {"mode": "on", "brightness": 50, "color": "warm"}), "Farbe ≠ Weißton")
st, a = on(brightness=128, color_mode="color_temp", color_temp_kelvin=2700)
ok(L.matches(st, a, {"mode": "on", "brightness": 50, "color": "warm"}), "warm = 2700 K")
ok(L.matches(st, a, {"mode": "on", "brightness": 50, "color": "none"}), "Farbe egal")
ok(L.matches("off", {}, {"mode": "off"}) and not L.matches("off", {}, {"mode": "on"}), "aus/an")
st, a = on(brightness=128, color_mode="hs", hs_color=[30, 80], effect_list=["candle"], effect="none")
ok(not L.matches(st, a, {"mode": "on", "brightness": 50, "color": "none", "effect": "candle"}), "Effekt fehlt noch")

st, a = "on", {"supported_color_modes": ["xy"], "brightness": 128, "color_mode": "xy", "xy_color": [0.701, 0.299], "hs_color": [0.0, 100.0]}
ok(L.matches(st, a, {"mode": "on", "brightness": 50, "color": "#ff0000"}), "XY-Lampe: eigene xy-Werte zählen (nicht HAs hs-Umrechnung)")
ok(not L.matches(st, a, {"mode": "on", "brightness": 50, "color": "#00ff00"}), "XY-Lampe: grün ≠ rot")
st, a = "on", {"supported_color_modes": ["rgbw"], "brightness": 128, "color_mode": "rgbw", "rgbw_color": [0, 0, 255, 80], "hs_color": [240, 70]}
ok(L.matches(st, a, {"mode": "on", "brightness": 50, "color": "rgbw:0,0,255,80"}) and not L.matches(st, a, {"mode": "on", "brightness": 50, "color": "rgbw:0,0,255,0"}), "RGBW-Lampe: Weißkanal zählt mit")

print("already like this? lamps that report their own way")
# a Matter lamp asked for hs reports rounded hs, or xy (HA converts with its own gamut)
st, a = "on", {"supported_color_modes": ["color_temp", "hs", "xy"], "brightness": 26, "color_mode": "hs", "hs_color": [29.764, 100], "xy_color": [0.614, 0.373]}
ok(L.matches(st, a, {"mode": "on", "bri": 26, "color": "hs:30,100"}), "hs 30/100 = gemeldet 29,76/100")
st, a = "on", {"supported_color_modes": ["color_temp", "hs", "xy"], "brightness": 26, "color_mode": "xy", "xy_color": [0.614, 0.373], "hs_color": [29.6, 100]}
ok(L.matches(st, a, {"mode": "on", "bri": 26, "color": "hs:30,100"}), "hs gewünscht, Lampe meldet xy: HAs hs zählt")
ok(not L.matches(st, a, {"mode": "on", "bri": 26, "color": "hs:200,100"}), "… aber Blau bleibt anders")
# asked for a white tone, the lamp reports it as a colour
warm_hs = list(L.rgb_to_hs(*L.kelvin_to_rgb(2200)))
st, a = "on", {"supported_color_modes": ["color_temp", "hs", "xy"], "brightness": 128, "color_mode": "xy", "xy_color": [0.52, 0.41], "hs_color": warm_hs}
ok(L.matches(st, a, {"mode": "on", "brightness": 50, "color": "kerze"}), "Weißton gewünscht, als Farbe gemeldet: gleicher Ton zählt", warm_hs)
ok(not L.matches(st, a, {"mode": "on", "brightness": 50, "color": "kalt"}), "… kaltweiß ist etwas anderes")
st, a = "on", {"supported_color_modes": ["color_temp", "hs"], "brightness": 128, "color_mode": "hs", "hs_color": [0, 100]}
ok(not L.matches(st, a, {"mode": "on", "brightness": 50, "color": "warm"}), "rot ist kein Warmweiß")
st, a = "on", {"supported_color_modes": ["color_temp"], "brightness": 128, "color_mode": "color_temp", "color_temp_kelvin": 6250}
ok(L.matches(st, a, {"mode": "on", "brightness": 50, "color": "k:6500"}), "kalte Weißtöne: Mired-Rundung zählt nicht")
# the Zigbee xy lamp asked for xy: HA's own xy
st, a = "on", {"supported_color_modes": ["color_temp", "xy"], "brightness": 170, "color_mode": "xy", "xy_color": [0.596, 0.388], "hs_color": [33.176, 100]}
ok(L.matches(st, a, {"mode": "on", "bri": 170, "color": "xy:0.596,0.388"}), "xy genau")
ok(L.matches(st, a, {"mode": "on", "bri": 170, "color": "#ff8c00"}), "Orange als Hex = Orange in xy")

print("power up in the colour (no white flash)")
Z = {"supported_color_modes": ["color_temp", "xy"], "supported_features": 44}
pre, main = L.power_up("off", Z, {"brightness": 170, "xy_color": [0.596, 0.388], "transition": 0.5})
ok(pre == {"xy_color": [0.596, 0.388], "brightness": L.POWER_UP_BRI, "transition": 0}, "aus → erst ganz dunkel in der Farbe, ohne Übergang", pre)
ok(main == {"brightness": 170, "xy_color": [0.596, 0.388], "transition": 0.5}, "dann hoch mit dem gewünschten Übergang", main)
pre, main = L.power_up("on", Z, {"brightness": 170, "xy_color": [0.596, 0.388], "transition": 0.5})
ok(pre is None and main["transition"] == 0.5, "schon an: ein Aufruf wie gewünscht")
pre, main = L.power_up("off", Z, {"brightness": 3, "xy_color": [0.596, 0.388], "transition": 0.5})
ok(pre is None and main == {"xy_color": [0.596, 0.388], "brightness": 3, "transition": 0}, "Ziel fast aus: ein Aufruf ohne Übergang", main)
pre, main = L.power_up("off", Z, {"brightness_pct": 60, "transition": 1})
ok(pre is None, "ohne Farbe: wie gewünscht", pre)
pre, main = L.power_up("off", {"supported_color_modes": ["color_temp"], "supported_features": 0}, {"brightness_pct": 60, "color_temp_kelvin": 2700})
ok(pre == {"color_temp_kelvin": 2700, "brightness": L.POWER_UP_BRI} and main["brightness_pct"] == 60, "Weißton, Lampe ohne Übergang: kein transition-Feld", pre)
pre, main = L.power_up("off", Z, {"brightness_pct": 60, "xy_color": [0.5, 0.4], "effect": "colorloop"})
ok(pre is None, "Effekt: ein Aufruf")

print("snapshots")
s = L.snapshot("on", {"brightness": 200, "color_mode": "rgbw", "rgbw_color": [1, 2, 3, 4]})
ok(s == {"mode": "on", "color": "rgbw:1,2,3,4", "bri": 200, "brightness": 78}, "RGBW-Lampe gemerkt", s)
s = L.snapshot("on", {"brightness": 100, "color_mode": "color_temp", "color_temp_kelvin": 3100})
ok(s["color"] == "k:3100", "Weißton gemerkt", s)
ok(L.snapshot("off", {}) == {"mode": "off"}, "aus gemerkt")
st, a = "on", {"supported_color_modes": ["rgbw"], "brightness": 200, "color_mode": "rgbw", "rgbw_color": [1, 2, 3, 4], "hs_color": list(L.rgb_to_hs(*L.rgbw_to_rgb(1, 2, 3, 4)))}
ok(L.matches(st, a, L.snapshot(st, a)), "Schnappschuss passt zum Zustand")

print(f"\n{len(FAIL)} Fehler" if FAIL else "\nalles ok")
raise SystemExit(1 if FAIL else 0)
