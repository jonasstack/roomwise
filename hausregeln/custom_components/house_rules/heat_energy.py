"""Heating consumption and cost: an estimate, always labelled as such.

Real meter (if there is one): gas meter, heat pump electricity or heat meter from the Home Assistant energy
dashboard (read through the energy manager, nothing is configured twice) or chosen by hand. Its consumption is
taken from the recorder statistics (days before we started) and from the meter readings we see (since), and
split between the rooms by their valve-hours (valve opening × time).

No meter: per room radiator power (entered, else about 80 W per m² of the room – the area comes from the floor
plan card or the heating assistant –, else 1 kW per thermostat) × valve-hours = heat, divided by the efficiency of
the heating (gas/oil ~92 %, heat pump: COP) = what you pay for.

Price: from the energy dashboard (per meter unit) or entered (€ per kWh). Savings: compared with keeping the
comfort temperature all the time – the heat a room loses is proportional to how much warmer it is than
outside, so the ratio of the degree-hours (comfort vs. what really was) gives the share saved.

Data per day and room are kept for 45 days in the smart heating store: valve-hours, degree-hours (real and
comfort), hours, and the meter's consumption per day.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

if TYPE_CHECKING:
    from .smart_heat import SmartHeating

_LOGGER = logging.getLogger(__name__)

KEEP_DAYS = 45
HP_NAME = re.compile(r"wärmepumpe|waermepumpe|heat.?pump|\bwp\b|heizstab|heizung|heating", re.I)
HEAT_NAME = re.compile(r"wärmemenge|waermemenge|heat.?meter|fernwärme|fernwaerme|district", re.I)
KINDS = ("auto", "gas", "oil", "heat_pump", "heat", "electric")
KIND_LABEL = {"gas": "Gas", "oil": "Öl", "heat_pump": "Wärmepumpe", "heat": "Fernwärme / Wärmezähler", "electric": "Strom (Direktheizung)"}


def default_config() -> dict[str, Any]:
    # kind auto: from the energy dashboard, else gas; meter None: from the energy dashboard; price None: from there
    return {"kind": "auto", "meter": None, "price": None, "gas_kwh_m3": 10.3, "cop": 3.2, "efficiency": 0.92}


def to_kwh(value: float, unit: str, gas_kwh_m3: float) -> float | None:
    u = (unit or "").strip()
    if u in ("m³", "m3"):
        return value * gas_kwh_m3
    if u == "kWh":
        return value
    if u == "Wh":
        return value / 1000
    if u == "MWh":
        return value * 1000
    if u == "GJ":
        return value * 277.78
    if u == "L":
        return value * 10.0  # heating oil: about 10 kWh per litre
    return None


class HeatEnergy:
    def __init__(self, smart: SmartHeating) -> None:
        self.smart = smart
        self.hass = smart.hass
        self._prefs: dict[str, Any] = {}
        self._prefs_at = 0.0
        self._stats: dict[str, float] = {}
        self._stats_at = 0.0
        self._stats_meter: str | None = None

    @property
    def data(self) -> dict[str, Any]:
        e = self.smart.d.setdefault("energy", {})
        e.setdefault("days", {})
        e.setdefault("meter", {})
        return e

    def cfg(self) -> dict[str, Any]:
        raw = (self.smart.h.cfg.get("smart") or {}).get("energy") or {}
        return {**default_config(), **{k: v for k, v in raw.items() if k in default_config()}}

    # ------------------------------------------------------------------ energy dashboard
    async def refresh_prefs(self, force: bool = False) -> dict[str, Any]:
        if not force and time.time() - self._prefs_at < 600:
            return self._prefs
        self._prefs_at = time.time()
        found: dict[str, Any] = {}
        try:
            from homeassistant.components.energy.data import async_get_manager  # noqa: PLC0415

            mgr = await async_get_manager(self.hass)
            data = mgr.data or {}
        except Exception as err:  # noqa: BLE001 — no energy dashboard is fine
            _LOGGER.debug("Energie-Einstellungen: %s", err)
            data = {}
        grid_price = None
        for src in data.get("energy_sources") or []:
            if src.get("type") == "grid":
                for f in src.get("flow_from") or []:
                    grid_price = grid_price or self._price(f)
                grid_price = grid_price or self._price(src)
        for src in data.get("energy_sources") or []:
            if src.get("type") == "gas" and src.get("stat_energy_from"):
                found = {"kind": "gas", "meter": src["stat_energy_from"], "price": self._price(src), "source": "energy"}
                break
        if not found:
            for dev in data.get("device_consumption") or []:
                ent = dev.get("stat_consumption") or ""
                st = self.hass.states.get(ent)
                name = f"{ent} {dev.get('name') or ''} {st.attributes.get('friendly_name', '') if st else ''}"
                if HEAT_NAME.search(name):
                    found = {"kind": "heat", "meter": ent, "price": None, "source": "energy"}
                    break
                if HP_NAME.search(name):
                    found = {"kind": "heat_pump", "meter": ent, "price": grid_price, "source": "energy"}
                    break
        found["grid_price"] = grid_price
        self._prefs = found
        return found

    def _price(self, src: dict[str, Any]) -> float | None:
        if src.get("number_energy_price") is not None:
            try:
                return float(src["number_energy_price"])
            except (TypeError, ValueError):
                return None
        ent = src.get("entity_energy_price")
        st = self.hass.states.get(ent) if ent else None
        try:
            return float(st.state) if st else None
        except (TypeError, ValueError):
            return None

    def meter(self) -> dict[str, Any]:
        """{kind, entity, unit, price, price_unit ('unit' = per meter unit, 'kWh' = per kWh fuel), source}."""
        c = self.cfg()
        prefs = self._prefs
        ent = c["meter"] or prefs.get("meter")
        kind = c["kind"] if c["kind"] != "auto" else (prefs.get("kind") if not c["meter"] or c["meter"] == prefs.get("meter") else None) or "gas"
        st = self.hass.states.get(ent) if ent else None
        unit = str(st.attributes.get("unit_of_measurement") or "") if st else ""
        price, price_unit = None, "kWh"
        if c["price"] is not None:
            price = float(c["price"])
        elif ent and ent == prefs.get("meter") and prefs.get("price") is not None:
            price, price_unit = float(prefs["price"]), "unit"
        elif kind in ("heat_pump", "electric") and prefs.get("grid_price") is not None:
            price = float(prefs["grid_price"])
        return {"kind": kind, "entity": ent if st else None, "unit": unit, "price": price, "price_unit": price_unit, "source": ("energy" if ent and ent == prefs.get("meter") and not c["meter"] else "manual" if c["meter"] else None), "label": KIND_LABEL.get(kind, kind)}

    # ------------------------------------------------------------------ sampling
    def sample_meter(self) -> None:
        m = self.meter()
        ent = m["entity"]
        st = self.hass.states.get(ent) if ent else None
        try:
            val = float(st.state) if st else None
        except (TypeError, ValueError):
            val = None
        d = self.data
        if val is None:
            return
        last = d.get("meter_last")
        if last and last.get("entity") == ent:
            delta = val - float(last["value"])
            # a reset (new meter, total_increasing restarts) or nonsense: just take the new reading as the base
            if 0 < delta < 1000:
                today = dt_util.now().date().isoformat()
                d["meter"][today] = round(d["meter"].get(today, 0.0) + delta, 4)
        d["meter_last"] = {"entity": ent, "value": val}

    def account(self, rid: str, dt_h: float, u: float | None, temp: float | None, tout: float | None, comfort: float) -> None:
        if dt_h <= 0 or dt_h > 0.5:
            return
        today = dt_util.now().date().isoformat()
        days = self.data["days"]
        e = days.setdefault(today, {}).setdefault(rid, {"vh": 0.0, "dh": 0.0, "dc": 0.0, "h": 0.0})
        e["vh"] = round(e["vh"] + (u or 0.0) * dt_h, 5)
        if temp is not None and tout is not None:
            e["dh"] = round(e["dh"] + max(0.0, temp - tout) * dt_h, 4)
            e["dc"] = round(e["dc"] + max(0.0, comfort - tout) * dt_h, 4)
        e["h"] = round(e["h"] + dt_h, 5)
        if len(days) > KEEP_DAYS:
            for k in sorted(days)[:-KEEP_DAYS]:
                days.pop(k, None)
        meter = self.data["meter"]
        if len(meter) > KEEP_DAYS:
            for k in sorted(meter)[:-KEEP_DAYS]:
                meter.pop(k, None)

    async def refresh_stats(self) -> None:
        """Daily consumption of the meter from the recorder statistics (for the days before we saw it), hourly."""
        m = self.meter()
        if not m["entity"] or (time.time() - self._stats_at < 3600 and self._stats_meter == m["entity"]):
            return
        self._stats_at, self._stats_meter = time.time(), m["entity"]
        try:
            from homeassistant.components.recorder import get_instance  # noqa: PLC0415
            from homeassistant.components.recorder.statistics import statistics_during_period  # noqa: PLC0415

            end = dt_util.utcnow()
            start = end - timedelta(days=31)
            res = await get_instance(self.hass).async_add_executor_job(statistics_during_period, self.hass, start, end, {m["entity"]}, "day", None, {"change"})
            out: dict[str, float] = {}
            for row in res.get(m["entity"], []):
                ts = row.get("start")
                ts = ts if isinstance(ts, (int, float)) else ts.timestamp() if isinstance(ts, datetime) else None
                if ts is None or row.get("change") is None:
                    continue
                out[dt_util.as_local(dt_util.utc_from_timestamp(ts)).date().isoformat()] = float(row["change"])
            self._stats = out
        except Exception as err:  # noqa: BLE001 — statistics are a bonus
            _LOGGER.debug("Zähler-Statistik: %s", err)
            self._stats = {}

    # ------------------------------------------------------------------ results
    def radiator_w(self, rid: str) -> float:
        p = self.smart.h.room(rid)
        s = p.get("smart") or {}
        if s.get("radiator_w"):
            return float(s["radiator_w"])
        area = self.smart.area(rid)
        if area:
            return round(area * 80)
        return 1000.0 * max(1, len(self.smart.h.thermostats(rid, p)))

    def summary(self, rid: str | None = None) -> dict[str, Any]:
        c = self.cfg()
        m = self.meter()
        today = dt_util.now().date()
        days = self.data["days"]
        meter_days = {**self._stats, **self.data["meter"]}
        rooms = [r for r in self.smart.core.rooms if self.smart.h.room(r)["on"]]
        has_meter = bool(m["entity"])
        eff = c["cop"] if m["kind"] == "heat_pump" else 1.0 if m["kind"] in ("heat", "electric") else c["efficiency"]

        def period(n: int) -> dict[str, Any]:
            res: dict[str, dict[str, float]] = {r: {"kwh": 0.0, "cost": 0.0, "saved_kwh": 0.0, "saved_cost": 0.0} for r in rooms}
            total_fuel = total_cost = 0.0
            have_cost = m["price"] is not None
            total_w = max(1.0, sum(self.radiator_w(x) for x in rooms))
            for k in range(n):
                day = (today - timedelta(days=k)).isoformat()
                per = days.get(day) or {}
                vh = {r: float((per.get(r) or {}).get("vh", 0.0)) for r in rooms}
                units = meter_days.get(day) if has_meter else None
                heat: dict[str, float] = {}
                cost: dict[str, float] = {}
                if units is not None:
                    fuel = to_kwh(units, m["unit"], c["gas_kwh_m3"]) or 0.0
                    heat_total = fuel * eff if m["kind"] in ("gas", "oil", "heat_pump") else fuel
                    s = sum(vh.values())
                    day_cost = (units * m["price"]) if have_cost and m["price_unit"] == "unit" else (fuel * m["price"]) if have_cost else 0.0
                    for r in rooms:
                        share = (vh[r] / s) if s > 0 else self.radiator_w(r) / total_w
                        heat[r], cost[r] = heat_total * share, day_cost * share
                    total_fuel += fuel
                    total_cost += day_cost
                else:
                    for r in rooms:
                        heat[r] = self.radiator_w(r) / 1000 * vh[r]
                        fuel = heat[r] / eff if eff else heat[r]
                        cost[r] = fuel * m["price"] if have_cost else 0.0
                        total_fuel += fuel
                        total_cost += cost[r]
                for r in rooms:
                    res[r]["kwh"] += heat[r]
                    res[r]["cost"] += cost[r]
                    # saved compared with comfort all the time: degree-hours ratio
                    e = per.get(r) or {}
                    dh, dc = float(e.get("dh", 0.0)), float(e.get("dc", 0.0))
                    if dh > 0.5 and dc > dh and heat[r] > 0:
                        extra = heat[r] * (dc / dh - 1)
                        res[r]["saved_kwh"] += extra
                        res[r]["saved_cost"] += cost[r] * (dc / dh - 1)
            out_rooms = {r: {k: round(v, 2) for k, v in x.items()} for r, x in res.items()}
            heat = sum(x["kwh"] for x in res.values())
            return {
                "kwh": round(heat, 2),
                "fuel_kwh": round(total_fuel, 2),
                "cost": round(total_cost, 2) if have_cost else None,
                "saved_kwh": round(sum(x["saved_kwh"] for x in res.values()), 2),
                "saved_cost": round(sum(x["saved_cost"] for x in res.values()), 2) if have_cost else None,
                "rooms": out_rooms if rid is None else {rid: out_rooms.get(rid, {"kwh": 0.0, "cost": 0.0, "saved_kwh": 0.0, "saved_cost": 0.0})},
            }

        return {
            "estimate": True,
            "meter": m,
            "from_meter": has_meter,
            "efficiency": eff,
            "today": period(1),
            "week": period(7),
            "month": period(30),
            "radiator_w": {r: self.radiator_w(r) for r in rooms} if rid is None else {rid: self.radiator_w(rid)},
        }
