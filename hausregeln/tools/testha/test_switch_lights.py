"""Lichtschalter as lamps: switch.* / input_boolean.* named after a light count as a lamp (kind "light"), a socket or a
mode toggle stays what it is; light calls for them go by their own domain, on / off only (actions.as_switch,
call_together); the light plan sees them as reached when they are on (lightspec.matches) and takes them in its lists.
Needs Home Assistant (imports), so it runs inside the test HA container:
    docker exec -i hr-test-ha python3 - < tools/testha/test_switch_lights.py
"""

import asyncio
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG_DIR", "/config"))  # CI: a folder whose custom_components/ holds roomwise

from custom_components.roomwise.house_rules import actions as A  # noqa: E402
from custom_components.roomwise.house_rules import inventory as I  # noqa: E402
from custom_components.roomwise.house_rules import lightspec as S  # noqa: E402

fails = 0


def ok(c, m, *extra):
    global fails
    fails += not c
    print("  ok:" if c else "• FAIL:", m, *(extra if not c else ()))


def st(state="off", **attrs):
    return SimpleNamespace(state=state, attributes=attrs, context=SimpleNamespace(id="c0"), domain="switch")


print("Erkennen")
for eid, name, want in [
    ("switch.flur_licht", "Flur Licht", "light"),
    ("switch.relais_1", "Deckenlampe Küche", "light"),
    ("switch.kueche_led", "Küche", "light"),
    ("switch.garten_lichterkette", "Lichterkette", "light"),
    ("input_boolean.spiegelleuchte", "Spiegelleuchte", "light"),
    ("switch.steckdose_tv", "Steckdose Fernseher", "outlet"),
    ("switch.plug_2", "Plug 2", "outlet"),
    ("switch.steckdose_stehlampe", "Steckdose Stehlampe", "light"),
    ("input_boolean.licht_automatik", "Licht Automatik", "switch"),
    ("switch.flurlicht_timer", "Flurlicht Timer", "switch"),
    ("switch.spotify_connect", "Spotify", "switch"),
    ("switch.bedroom_fan", "Bedroom Fan", "switch"),
    ("light.wohnzimmer", "Wohnzimmer", "light"),
]:
    kind, _ = I.classify(eid, st(device_class="outlet" if "plug" in eid or "steckdose" in eid else None), name)
    ok(kind == want, f"{name} ({eid}) → {want}", kind)

print("Schalten")
ok(A.as_switch("light", "turn_on", "switch.flur_licht", {"brightness_pct": 40, "rgb_color": [255, 0, 0], "transition": 2}) == ("switch", "turn_on", {}), "an: switch.turn_on ohne Helligkeit und Farbe")
ok(A.as_switch("light", "turn_on", "switch.flur_licht", {"brightness_pct": 0}) == ("switch", "turn_off", {}), "Helligkeit 0: aus")
ok(A.as_switch("light", "turn_off", "input_boolean.spiegelleuchte", {"transition": 1}) == ("input_boolean", "turn_off", {}), "aus: input_boolean.turn_off")
ok(A.as_switch("light", "toggle", "switch.flur_licht", {}) == ("switch", "toggle", {}), "umschalten")
ok(A.as_switch("light", "turn_on", "light.wohnzimmer", {"brightness_pct": 40}) == ("light", "turn_on", {"brightness_pct": 40}), "echte Lampe unverändert")


class FakeServices:
    def __init__(self):
        self.calls = []

    async def async_call(self, domain, service, data, blocking=True, context=None):
        self.calls.append((domain, service, data))


states = {"light.wohnzimmer": st("on", brightness=200, color_mode="brightness", supported_color_modes=["brightness"]), "switch.flur_licht": st("off")}
hass = SimpleNamespace(services=FakeServices(), states=SimpleNamespace(get=lambda e: states.get(e)))
asyncio.run(A.call_together(hass, [("light", "turn_on", "light.wohnzimmer", {"brightness_pct": 50}), ("light", "turn_on", "switch.flur_licht", {"brightness_pct": 50})], None))
calls = hass.services.calls
ok(("switch", "turn_on", {"entity_id": "switch.flur_licht"}) in calls, "call_together: der Schalter über switch.turn_on", calls)
ok(any(c[0] == "light" and c[2].get("entity_id") == "light.wohnzimmer" and c[2].get("brightness_pct") == 50 for c in calls), "call_together: die Lampe wie gehabt", calls)
ok(not any(c[0] == "light" and "switch.flur_licht" in str(c[2]) for c in calls), "kein light.turn_on an einen Schalter", calls)

print("Lichtplan")
ok(S.is_lightlike("switch.flur_licht") and S.is_lightlike("input_boolean.x") and S.is_lightlike("light.y") and not S.is_lightlike("sensor.z"), "is_lightlike")
spec = S.clean_action({"mode": "on", "brightness": 40, "color": "warm"})
ok(S.matches("on", {}, spec), "Schalter an = Einstellung erreicht (keine Helligkeit, keine Farbe)")
ok(not S.matches("off", {}, spec), "Schalter aus = nicht erreicht")
ok(S.matches("off", {}, {"mode": "off"}), "aus gewollt, aus = erreicht")

print("\n" + ("ALLES OK" if not fails else f"{fails} FEHLER"))
sys.exit(1 if fails else 0)
