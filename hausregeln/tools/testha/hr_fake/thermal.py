"""Thermal room model for the fake thermostats (tests of the smart heating, never in a real home).

Per simulated thermostat a room temperature T follows
    dT/dt = k_h · u − k_l · (T − T_out) − k_win · (T − T_out) · window + sun
with u the valve opening: like a Sonoff TRVZB when the device has valve_opening_degree / valve_closing_degree
numbers (the thermostat opens below its target, closes above it, the numbers limit how far), otherwise a simple
proportional thermostat valve (fully open 1 °C below the target). T_out comes from sensor.temp_aussen.

The model runs `factor` times faster than real time (one step per real second), so tests can watch hours of
heating in a minute; hr_fake/thermal configures it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval

DOMAIN = "hr_fake"


def setup(hass: HomeAssistant) -> None:
    hass.data[DOMAIN]["thermal"] = {"factor": 1.0, "rooms": {}}

    @websocket_api.websocket_command(
        {
            vol.Required("type"): "hr_fake/thermal",
            vol.Optional("entity_id"): str,
            vol.Optional("on"): bool,
            vol.Optional("factor"): vol.Coerce(float),
            vol.Optional("temp"): vol.Coerce(float),
            vol.Optional("k_l"): vol.Coerce(float),
            vol.Optional("k_h"): vol.Coerce(float),
            vol.Optional("sun"): vol.Coerce(float),
            vol.Optional("window"): vol.Any(str, None),
        }
    )
    @callback
    def ws_thermal(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        th = hass.data[DOMAIN]["thermal"]
        if "factor" in msg:
            th["factor"] = max(1.0, min(600.0, msg["factor"]))
        if e := msg.get("entity_id"):
            r = th["rooms"].setdefault(e, {"on": False, "temp": 20.0, "k_l": 0.08, "k_h": 3.0, "sun": 0.0, "window": None, "open": False, "u": 0.0})
            for k in ("on", "temp", "k_l", "k_h", "sun", "window"):
                if k in msg:
                    r[k] = msg[k]
            _write(hass, e, r)
        connection.send_result(msg["id"], {"factor": th["factor"], "rooms": th["rooms"]})

    websocket_api.async_register_command(hass, ws_thermal)
    async_track_time_interval(hass, callback(lambda _now: _step(hass)), timedelta(seconds=1))


def _num(hass: HomeAssistant, entity_id: str) -> float | None:
    ent = hass.data[DOMAIN]["entities"].get(entity_id)
    if ent is None or not getattr(ent, "available", True):
        return None
    v = getattr(ent, "native_value", None)
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _valve(hass: HomeAssistant, e: str, r: dict[str, Any], clim: Any) -> float:
    if str(clim.hvac_mode) == "off":
        r["open"] = False
        return 0.0
    sp = float(clim.target_temperature or 5)
    t = r["temp"]
    # the thermostat's own two-point decision with a little hysteresis
    if r["open"] and t >= sp + 0.2:
        r["open"] = False
    elif not r["open"] and t <= sp - 0.2:
        r["open"] = True
    uid = e.split(".", 1)[1]
    opening = _num(hass, f"number.{uid}_valve_opening_degree")
    closing = _num(hass, f"number.{uid}_valve_closing_degree")
    if opening is not None and closing is not None:
        return (opening if r["open"] else 100 - closing) / 100
    return max(0.0, min(1.0, sp - t))


def _step(hass: HomeAssistant) -> None:
    th = hass.data[DOMAIN]["thermal"]
    out_ent = hass.data[DOMAIN]["entities"].get("sensor.temp_aussen")
    tout = float(getattr(out_ent, "native_value", 5.0) or 5.0)
    for e, r in th["rooms"].items():
        if not r["on"]:
            continue
        clim = hass.data[DOMAIN]["entities"].get(e)
        if clim is None:
            continue
        dt_h = th["factor"] / 3600
        sub = max(1, int(th["factor"] // 30))
        win = r.get("window")
        wst = hass.states.get(win) if win else None
        k_win = 1.5 if wst is not None and wst.state == "on" else 0.0
        for _ in range(sub):
            u = _valve(hass, e, r, clim)
            r["u"] = u
            r["temp"] += (r["k_h"] * u - (r["k_l"] + k_win) * (r["temp"] - tout) + r["sun"]) * dt_h / sub
        _write(hass, e, r)


def _write(hass: HomeAssistant, e: str, r: dict[str, Any]) -> None:
    clim = hass.data[DOMAIN]["entities"].get(e)
    if clim is None:
        return
    shown = round(r["temp"], 1)
    if clim.sim_update(shown, round(r["u"] * 100), r["open"]):
        clim.async_write_ha_state()
