"""Test-only devices for the isolated test Home Assistant (never installed in a real home).

Entities answer service calls like real ones; tests set sensor states with hr_fake/set and read the
recorded notify/tts calls with hr_fake/calls. hr_fake/telemetry points Hausregeln' diagnostics at a mock server
inside this test HA (/api/hr_fake/telemetry/...) and returns what it received.
"""

from __future__ import annotations

import logging
import sys
import time
from typing import Any

from aiohttp import web
import voluptuous as vol

from homeassistant.components.http import HomeAssistantView

from homeassistant.components import websocket_api
from homeassistant.core import Context, HomeAssistant, ServiceCall, callback

DOMAIN = "hr_fake"
_LOGGER = logging.getLogger(__name__)
TELEMETRY_MODULE = "custom_components.house_rules.telemetry"
PLATFORMS = ["light", "switch", "binary_sensor", "sensor", "climate", "media_player", "vacuum", "number", "device_tracker", "lock", "cover", "button", "event"]


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    hass.data[DOMAIN] = {"entities": {}, "calls": []}
    if not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(hass.config_entries.flow.async_init(DOMAIN, context={"source": "import"}, data={}))

    async def record(call: ServiceCall) -> None:
        hass.data[DOMAIN]["calls"].append({"service": f"{call.domain}.{call.service}", "data": dict(call.data)})

    for svc in ("mobile_app_iphone_von_alex", "mobile_app_iphone_von_sam", "sms_test"):
        hass.services.async_register("notify", svc, record)
    hass.services.async_register("tts", "speak", record)

    @websocket_api.websocket_command({vol.Required("type"): "hr_fake/set", vol.Required("entity_id"): str, vol.Required("state"): str, vol.Optional("attributes", default={}): dict})
    @callback
    def ws_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        ent = hass.data[DOMAIN]["entities"].get(msg["entity_id"])
        if not ent:
            connection.send_error(msg["id"], "unknown", msg["entity_id"])
            return
        attrs = dict(msg["attributes"])
        # how real radios behave: "_delay" reports this many seconds later, "_dup" sends the same state again n times
        # (a Zigbee device repeating its report with a new link quality), "_clear_after" turns a binary sensor off
        # again after n seconds (a motion sensor's own timeout); the state "unavailable" takes the device away
        delay, dup, clear = float(attrs.pop("_delay", 0) or 0), int(attrs.pop("_dup", 0) or 0), float(attrs.pop("_clear_after", 0) or 0)

        def apply(state: str = msg["state"], attrs: dict[str, Any] = attrs, first: bool = True) -> None:
            # like a press at the device: a fresh context (no user, no parent), not the one of the last service call
            ent.async_set_context(Context())
            if state == "unavailable" and ent.platform_domain != "number":
                ent._attr_available = False
                ent.async_write_ha_state()
                return
            if ent.platform_domain != "number":
                ent._attr_available = True
            ent.fake_set(state, attrs)
            for i in range(dup if first else 0):
                hass.loop.call_later(0.1 * (i + 1), ent.fake_report)
            if clear and first:
                hass.loop.call_later(clear, lambda: apply("off", {}, False))

        if delay:
            hass.loop.call_later(delay, apply)
        else:
            apply()
        connection.send_result(msg["id"], {"ok": True})

    @websocket_api.websocket_command({vol.Required("type"): "hr_fake/calls", vol.Optional("clear", default=False): bool})
    @callback
    def ws_calls(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        calls = list(hass.data[DOMAIN]["calls"])
        if msg["clear"]:
            hass.data[DOMAIN]["calls"].clear()
        connection.send_result(msg["id"], calls)

    @websocket_api.websocket_command({vol.Required("type"): "hr_fake/burst", vol.Optional("count", default=2000): int, vol.Optional("rounds", default=5): int})
    @websocket_api.async_response
    async def ws_burst(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        """Benchmark: a burst of state changes inside HA. Unrelated entities (nobody tracks them) and the fake
        devices (Hausregeln tracks them); listeners marked @callback run inline, so the time per change includes
        every handler of every integration. Afterwards: how late the event loop runs a scheduled callback."""
        count, rounds = msg["count"], msg["rounds"]
        t0 = time.perf_counter()
        for r in range(rounds):
            for i in range(count):
                hass.states.async_set(f"sensor.hr_bench_{i}", str(r * count + i), {"unit_of_measurement": "W"})
        unrelated = (time.perf_counter() - t0) / (rounds * count)
        fakes = [e for e in hass.data[DOMAIN]["entities"].values() if e.platform_domain in ("light", "binary_sensor", "sensor") and e.hass]
        t1 = time.perf_counter()
        n = 0
        for r in range(rounds * 4):
            for ent in fakes:
                ent.async_set_context(Context())
                if ent.platform_domain == "sensor":
                    ent.fake_set(str(15 + (r % 10)), {})
                else:
                    ent.fake_set("on" if r % 2 == 0 else "off", {})
                n += 1
        tracked = (time.perf_counter() - t1) / max(1, n)
        # everything the burst scheduled (tasks, timers due now) gets its turn; then measure the loop's lag
        t2 = time.perf_counter()
        fut = hass.loop.create_future()
        hass.loop.call_soon(lambda: fut.done() or fut.set_result(time.perf_counter()))
        lag = (await fut) - t2
        connection.send_result(msg["id"], {"unrelated_us": round(unrelated * 1e6, 1), "tracked_us": round(tracked * 1e6, 1), "tracked_changes": n, "loop_lag_ms": round(lag * 1000, 2)})
    hass.data[DOMAIN]["telemetry"] = []
    hass.http.register_view(TelemetryMock())

    @websocket_api.websocket_command({vol.Required("type"): "hr_fake/telemetry", vol.Optional("endpoint"): vol.Any(bool, str), vol.Optional("clear", default=False): bool})
    @callback
    def ws_telemetry(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        """endpoint: true = the mock here, a string = that URL, false = back to "not deployed"; answer: received requests."""
        mod = sys.modules.get(TELEMETRY_MODULE)
        if "endpoint" in msg and mod is not None:
            ep = msg["endpoint"]
            mod.ENDPOINT = "http://127.0.0.1:8123/api/hr_fake/telemetry" if ep is True else ep or ""
        got = list(hass.data[DOMAIN]["telemetry"])
        if msg["clear"]:
            hass.data[DOMAIN]["telemetry"].clear()
        connection.send_result(msg["id"], {"endpoint": getattr(mod, "ENDPOINT", None), "received": got})

    @websocket_api.websocket_command({vol.Required("type"): "hr_fake/raise_in_house_rules"})
    @callback
    def ws_raise(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        """Provoke an exception inside Hausregeln code and log it (for the diagnostics error capture)."""
        core = hass.data.get("house_rules")
        try:
            core.setup.save(None)  # type: ignore[arg-type]  # AttributeError inside setup.py
        except Exception:
            _LOGGER.exception("provoked error for the test")
        connection.send_result(msg["id"], {"ok": True})

    @websocket_api.websocket_command({vol.Required("type"): "hr_fake/notify", vol.Required("name"): str, vol.Required("present"): bool})
    @callback
    def ws_notify(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        """A notify service comes or goes (e.g. an integration was removed)."""
        if msg["present"]:
            hass.services.async_register("notify", msg["name"], record)
        else:
            hass.services.async_remove("notify", msg["name"])
        connection.send_result(msg["id"], {"ok": True})

    @websocket_api.websocket_command(
        {vol.Required("type"): "hr_fake/call_as", vol.Required("user_id"): str, vol.Required("domain"): str, vol.Required("service"): str, vol.Optional("data", default={}): dict}
    )
    @websocket_api.async_response
    async def ws_call_as(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        """A service call as another user, like Node-RED or AppDaemon with its own login (context.user_id)."""
        await hass.services.async_call(msg["domain"], msg["service"], msg["data"], blocking=True, context=Context(user_id=msg["user_id"]))
        connection.send_result(msg["id"], {"ok": True})

    websocket_api.async_register_command(hass, ws_set)
    websocket_api.async_register_command(hass, ws_call_as)
    websocket_api.async_register_command(hass, ws_calls)
    websocket_api.async_register_command(hass, ws_telemetry)
    websocket_api.async_register_command(hass, ws_raise)
    websocket_api.async_register_command(hass, ws_notify)
    websocket_api.async_register_command(hass, ws_burst)

    from . import thermal  # noqa: PLC0415

    thermal.setup(hass)
    return True


class TelemetryMock(HomeAssistantView):
    """Stands in for the diagnostics server: records method, path and JSON body."""

    url = "/api/hr_fake/telemetry/{path:.*}"
    name = "api:hr_fake:telemetry"
    requires_auth = False

    async def _record(self, request: web.Request, path: str) -> web.Response:
        try:
            body = await request.json() if request.can_read_body else None
        except ValueError:
            body = None
        request.app["hass"].data[DOMAIN]["telemetry"].append({"method": request.method, "path": "/" + path, "body": body})
        return web.json_response({"ok": True})

    async def post(self, request: web.Request, path: str) -> web.Response:
        return await self._record(request, path)

    async def delete(self, request: web.Request, path: str) -> web.Response:
        return await self._record(request, path)


async def async_setup_entry(hass: HomeAssistant, entry) -> bool:
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True
