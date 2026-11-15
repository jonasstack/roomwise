"""Test-only devices for the companion integration on the isolated test Home Assistant (container fp-test-ha from
tools/companion/testha/start.sh, never in a real home).

* Records service calls (tts, light, scene, notify, mqtt, segment cleaning) for `fp_fake/calls`; registers
  stand-ins for the services the bare test instance does not have (tts.speak, light.*, scene.*, the phones
  notify.fake_alex / notify.fake_sam, mqtt.publish).
* A Roborock stand-in: `roborock.get_vacuum_current_position` answers for `vacuum.fake` (a state set over REST)
  with a robot driving lanes through a 4 × 3 m room (robot mm, x = 25000 + 10·px, y = 28000 − 10·py).
* A Dreame-like robot (`vacuum.demo_dreame` + map camera `camera.demo_dreame_map` on the same device, attributes
  exactly as Dreame Vacuum writes them — positions as objects with as_dict()) and a Valetudo-like one
  (`vacuum.demo_valetudo` + `camera.demo_valetudo_map_data`, a PNG with the ValetudoMap JSON inside, its MQTT
  topic like Valetudo's). Both drive through the demo flat of world.py; `fp_fake/vacuum` starts / docks them.
"""

from __future__ import annotations

from datetime import timedelta
import math
import time
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.const import EVENT_CALL_SERVICE
from homeassistant.core import Event, HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.event import async_track_time_interval

from . import world

DOMAIN = "fp_fake"
PLATFORMS = ["vacuum", "camera"]
RECORD = {"tts", "light", "scene", "notify", "mqtt", DOMAIN, "dreame_vacuum", "xiaomi_miio"}


class Robot:
    """One fake robot driving through the demo flat"""

    def __init__(self, key: str, every: float) -> None:
        self.key = key
        self.every = every  # s between two map updates (like the real integration)
        self.state = "docked"
        self.start: float | None = None
        self.pos = world.where(0)
        self.path: list[tuple[float, float]] = []
        self.listeners: list = []
        self._last = 0.0

    def set(self, state: str) -> None:
        if state == "cleaning" and self.state != "cleaning":
            self.start = time.monotonic() - (0 if self.state == "docked" else self._elapsed())
            if self.state == "docked":
                self.path = []
        self.state = state
        if state == "docked":
            self.start = None
            self.pos = world.where(0)
        self.notify()

    def _elapsed(self) -> float:
        return time.monotonic() - self.start if self.start is not None else 0.0

    def tick(self) -> None:
        if self.state != "cleaning":
            return
        t = self._elapsed()
        if t * world.SPEED > sum(world.LENGTHS):
            self.set("docked")
            return
        if time.monotonic() - self._last < self.every:
            return
        self._last = time.monotonic()
        self.pos = world.where(t)
        self.path.append(self.pos[:2])
        self.notify()

    def notify(self) -> None:
        for cb in list(self.listeners):
            cb()


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    data = hass.data[DOMAIN] = {"calls": [], "robots": {"dreame": Robot("dreame", 1.5), "valetudo": Robot("valetudo", 2.0)}, "roborock_start": None}
    if not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(hass.config_entries.flow.async_init(DOMAIN, context={"source": "import"}, data={}))

    @callback
    def on_call(event: Event) -> None:
        if event.data.get("domain") in RECORD:
            data["calls"].append({"domain": event.data["domain"], "service": event.data["service"], "data": dict(event.data.get("service_data") or {})})

    hass.bus.async_listen(EVENT_CALL_SERVICE, on_call)

    async def nothing(call: ServiceCall) -> None:
        return None

    # stand-ins for services the bare test instance does not have (the calls are recorded above)
    stand_ins = (("tts", "speak"), ("light", "turn_on"), ("light", "turn_off"), ("light", "toggle"), ("scene", "create"), ("scene", "turn_on"), ("notify", "fake_alex"), ("notify", "fake_sam"), ("mqtt", "publish"))
    for domain, service in stand_ins:
        if not hass.services.has_service(domain, service):
            hass.services.async_register(domain, service, nothing)

    # ---------- Roborock stand-in for vacuum.fake ----------

    @callback
    def fake_state(event: Event) -> None:
        new, old = event.data.get("new_state"), event.data.get("old_state")
        if event.data.get("entity_id") != "vacuum.fake" or new is None:
            return
        if new.state == "cleaning" and (old is None or old.state != "cleaning"):
            data["roborock_start"] = time.monotonic()
        elif new.state not in ("cleaning", "returning"):
            # back in the dock: a new run starts there (the companion may read the position before this listener
            # has set the new start — it must not get a spot of the previous run then)
            data["roborock_start"] = None

    hass.bus.async_listen("state_changed", fake_state)

    def roborock_lanes(t: float) -> tuple[float, float]:
        """4 × 3 m room, lanes 30 cm apart at 60 cm/s (plan cm), 20 cm from every wall; at the end it drives the
        same way back (never a jump back to the start)"""
        ys = [280.0 - 30 * k for k in range(9)] + [20.0]
        way = [(20.0, 280.0)]
        for k, y in enumerate(ys):
            way += [(20.0, y), (380.0, y)] if k % 2 == 0 else [(380.0, y), (20.0, y)]
        total = sum(math.hypot(way[i][0] - way[i - 1][0], way[i][1] - way[i - 1][1]) for i in range(1, len(way)))
        d = (t * 60) % (2 * total)
        d = d if d <= total else 2 * total - d
        for i in range(1, len(way)):
            seg = math.hypot(way[i][0] - way[i - 1][0], way[i][1] - way[i - 1][1])
            if d <= seg:
                f = d / seg if seg else 0
                return way[i - 1][0] + (way[i][0] - way[i - 1][0]) * f, way[i - 1][1] + (way[i][1] - way[i - 1][1]) * f
            d -= seg
        return way[-1]

    async def current_position(call: ServiceCall) -> ServiceResponse:
        out = {}
        for eid in call.data.get("entity_id") or []:
            st = hass.states.get(eid)
            if st and st.state in ("cleaning", "returning") and data["roborock_start"] is not None:
                px, py = roborock_lanes(time.monotonic() - data["roborock_start"])
            else:
                px, py = 15.0, 285.0
            out[eid] = {"x": round(25000 + 10 * px), "y": round(28000 - 10 * py)}
        return out

    if not hass.services.has_service("roborock", "get_vacuum_current_position"):
        hass.services.async_register("roborock", "get_vacuum_current_position", current_position, schema=vol.Schema({vol.Optional("entity_id"): cv.ensure_list}, extra=vol.ALLOW_EXTRA), supports_response=SupportsResponse.ONLY)

    # ---------- the Dreame-like robot's own segment cleaning (like dreame_vacuum.vacuum_clean_segment) ----------

    async def clean_segment(call: ServiceCall) -> None:
        data["robots"]["dreame"].set("cleaning")

    hass.services.async_register(DOMAIN, "vacuum_clean_segment", clean_segment, schema=vol.Schema({vol.Required("segments"): object}, extra=vol.ALLOW_EXTRA))

    @callback
    def tick(_now: Any) -> None:
        for r in data["robots"].values():
            r.tick()

    async_track_time_interval(hass, tick, timedelta(seconds=0.5))

    @websocket_api.websocket_command({vol.Required("type"): "fp_fake/calls", vol.Optional("clear", default=False): bool})
    @callback
    def ws_calls(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        calls = list(data["calls"])
        if msg["clear"]:
            data["calls"].clear()
        connection.send_result(msg["id"], calls)

    @websocket_api.websocket_command({vol.Required("type"): "fp_fake/vacuum", vol.Required("robot"): vol.In(["dreame", "valetudo"]), vol.Required("state"): vol.In(["cleaning", "paused", "returning", "docked"])})
    @callback
    def ws_vacuum(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        data["robots"][msg["robot"]].set(msg["state"])
        connection.send_result(msg["id"], {"ok": True})

    websocket_api.async_register_command(hass, ws_calls)
    websocket_api.async_register_command(hass, ws_vacuum)
    return True


async def async_setup_entry(hass: HomeAssistant, entry) -> bool:
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True
