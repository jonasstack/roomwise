"""Fading: a lamp a light rule switched on with a fade goes off / dims down as slowly (lightplan._apply); its own fade
wins; switched on without a fade, it goes off at once. Needs Home Assistant (imports): run inside a HA container
with custom_components mounted, e.g.
    docker run --rm -v $PWD/custom_components:/config/custom_components:ro -v $PWD/hausregeln/tools:/t:ro \\
      ghcr.io/home-assistant/home-assistant:stable python3 /t/testha/test_light_fade.py
"""

import asyncio
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG", "/config"))

from custom_components.roomwise.house_rules.lightplan import LightPlanner  # noqa: E402

fails = 0


def ok(c, m, *extra):
    global fails
    if not c:
        fails += 1
    print(("  ok: " if c else "  FEHLER: ") + m, *(extra if not c else ()))


class Services:
    def __init__(self):
        self.calls = []

    async def async_call(self, domain, service, data, blocking=True, context=None):
        self.calls.append((domain, service, dict(data)))


def attrs():
    return {"brightness": 200, "color_mode": "brightness", "supported_color_modes": ["brightness"], "supported_features": 32}


states = {"light.a": SimpleNamespace(state="on", attributes=attrs()), "light.b": SimpleNamespace(state="on", attributes=attrs())}
hass = SimpleNamespace(services=Services(), states=SimpleNamespace(get=lambda e: states.get(e)))
core = SimpleNamespace(
    history=SimpleNamespace(new_context=lambda _n: SimpleNamespace(id="ctx"), add=lambda *a, **k: None),
    rooms={"r": {"name": "Raum"}},
    lightcal=SimpleNamespace(adjust=lambda _e, d: d),
    inventory=SimpleNamespace(devices={}),
)
lp = SimpleNamespace(hass=hass, core=core, _ours={}, _fade={}, _name=lambda e: e)


def run(changes):
    hass.services.calls.clear()
    asyncio.run(LightPlanner._apply(lp, "r", changes))
    return list(hass.services.calls)


def data_for(calls, e, service):
    for d, s, data in calls:
        ids = data.get("entity_id")
        if s == service and (ids == e or (isinstance(ids, list) and e in ids)):
            return data
    return None


print("Aufdimmen merkt sich den Übergang")
c = run([("light.a", {"mode": "on", "brightness": 80, "transition": 5}), ("light.b", {"mode": "on", "brightness": 80})])
ok((data_for(c, "light.a", "turn_on") or {}).get("transition") == 5, "an mit 5 s", c)
ok(lp._fade.get("light.a") == 5 and "light.b" not in lp._fade, "gemerkt nur für die Lampe mit Übergang", lp._fade)

print("Ausgehen und Herunterdimmen")
c = run([("light.a", {"mode": "off", "why": "niemand mehr da"}), ("light.b", {"mode": "off", "why": "niemand mehr da"})])
ok((data_for(c, "light.a", "turn_off") or {}).get("transition") == 5, "aus mit denselben 5 s", c)
ok("transition" not in (data_for(c, "light.b", "turn_off") or {}), "ohne Übergang angeschaltet: sofort aus", c)
c = run([("light.a", {"mode": "on", "bri": 25, "color": "none", "why": "niemand mehr da: 10 %"})])
ok((data_for(c, "light.a", "turn_on") or {}).get("transition") == 5, "heruntergedimmt mit 5 s", c)
c = run([("light.a", {"mode": "off", "transition": 1})])
ok((data_for(c, "light.a", "turn_off") or {}).get("transition") == 1, "ein eigener Übergang gewinnt", c)

print("Wieder ohne Übergang angeschaltet")
run([("light.a", {"mode": "on", "brightness": 60})])
c = run([("light.a", {"mode": "off"})])
ok("transition" not in (data_for(c, "light.a", "turn_off") or {}) and "light.a" not in lp._fade, "dann auch sofort aus", c)

print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
