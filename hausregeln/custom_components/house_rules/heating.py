"""Heating per room ("Heizung" tab): a controller like the light plan (lightplan.py), not a set of rules.

Per room: thermostats (empty = all of the room), optionally an own room thermometer, temperature levels
(comfort, base, eco, night, frost), time blocks (comfort/eco/night or an own temperature, daily / workdays /
weekend), presence (house mode "away" or everyone away for N min → eco, room empty for N min → eco,
someone on the way home → back to the plan), sleep, guests, vacation, window/airing logic, ventilation
reminders, valves, calibration, preheating and how a change by hand counts.

What decides the target of a room, from the top (the first that applies wins):
  1. heating switched off in the features, or the room's plan off      → hands off
  2. valve exercise running                                            → valves fully open for a few minutes
  3. a window open longer than the wait time (0 = at once) / airing detected from a fast temperature drop, and
     after closing until the air has settled (seconds are fine; a window opened again and again within a few
     minutes waits at least WINDOW_FLAP_SETTLE, so the thermostats do not flap) → off (or frost protection)
     the thermostat detects an open window itself                      → hands off (never fight it)
  4. summer (outside warmer than X for some time)                      → off
  5. house mode "vacation"                                             → frost protection
  6. changed by hand at the thermostat or in the app                   → kept (until the next block / X hours /
                                                                          the room was empty / not at all)
  7. house mode "away" or everyone away for N min                      → eco (unless someone is on the way home)
  8. house mode "sleep"                                                → night
  9. house mode "guests"                                               → comfort the whole day
 10. room empty for N min                                              → eco
 11. time block now, or the next one soon enough to preheat           → its temperature (learned heat-up rate)
 12. otherwise                                                         → base temperature

Commands are sent only when something really differs (hysteresis); small corrections wait a minimum time per
thermostat (battery), big changes (a new block, window, mode) go out right away. Unreachable thermostats are
skipped. Every command gets a line in the history with the reason; each room has a plain German status line.

House-wide (stored in data["heating"]): outside thermometer, summer mode, heat demand ("Wärmeanforderung": a
boiler / heat pump switch on while any valve is open more than X %, with minimum on/off times), weekly valve
exercise, who gets the ventilation reminders and quiet hours.
"""

from __future__ import annotations

import copy
import json
import logging
import math
import re
import time
import uuid
from collections import Counter, deque
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.const import ATTR_ENTITY_ID, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.event import async_call_later, async_track_state_change_event, async_track_time_interval
from homeassistant.util import dt as dt_util

from . import heat_model as hm
from .heat_energy import KINDS as ENERGY_KINDS, default_config as energy_default
from .i18n import tr
from .smart_heat import SmartHeating, clean_guard, clean_room as clean_smart, default_global as smart_global, default_room as smart_room

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

EVENT_VENTILATE = "house_rules_ventilate"
SETTINGS_SILENCE = 600  # a reason over the limit since a change of settings (never below since) stays silent this long
# a window opened this often within WINDOW_FLAP_MINUTES counts as flapping: after closing it waits at least
# WINDOW_FLAP_SETTLE seconds before heating again (instead of a short "resume" of a few seconds)
WINDOW_FLAPS = 3
WINDOW_FLAP_MINUTES = 10
WINDOW_FLAP_SETTLE = 120
DAYS = ("all", "workdays", "weekend")
LEVELS = ("comfort", "base", "eco", "night", "frost")
BLOCK_LEVELS = ("comfort", "eco", "night", "custom")
LABEL = {"comfort": "Komfort", "base": "Grundtemperatur", "eco": "Sparen", "night": "Nacht", "frost": "Frostschutz", "custom": "eigene Temperatur"}
MANUAL = ("smart", "next_block", "hours", "room_empty", "never")
# "smart" manual mode: a room with presence sensing that has been empty this long ends a change by hand
MANUAL_EMPTY_MINUTES = 45
# a change by hand older than this is never brought back after a restart
MANUAL_KEEP_HOURS = 48
BAD = (STATE_UNAVAILABLE, STATE_UNKNOWN, "", None)
VALVE_ATTRS = ("valve_position", "pi_heating_demand", "valve_opening", "valve_opening_degree", "heating_demand", "running_valve_position", "valve", "position")
VALVE_NAME = re.compile(r"valve|ventil|pi_heating|heating_demand|heizbedarf|opening|öffnung|position", re.I)
CALIB_NAME = re.compile(r"calibrat|kalibr|temperature_offset|temp_offset|local_temperature_offset|offset", re.I)
OUTSIDE_NAME = re.compile(r"au(ß|ss)en|outdoor|outside|draußen|draussen|balkon|terrasse|garten|wetter", re.I)


def default_room() -> dict[str, Any]:
    return {
        "v": 2,
        "on": False,
        # empty = all thermostats of the room
        "thermostats": [],
        # own room thermometer (more accurate than the one in the thermostat at the radiator); None = the thermostat's
        "sensor": None,
        # with an own thermometer: auto (offset of the thermostat if it has one, else correct the target) | offset | target | off
        "calibrate": "auto",
        "temps": {"comfort": 21.0, "base": 18.0, "eco": 17.0, "night": 17.0, "frost": 12.0},
        "blocks": [{"from": "06:00", "to": "22:00", "days": "all", "level": "comfort", "temp": 21.0}],
        # minutes
        "presence": {"away": True, "away_after": 15, "empty": False, "empty_after": 30, "home_soon": True},
        "sleep": True,
        "guests": True,
        # smart: until the circumstances really change (house mode, everyone leaves, room long empty, next change of
        # the plan), at most manual_max hours; next_block | hours (manual_hours) | room_empty | never
        "manual": "smart",
        "manual_hours": 2.0,
        "manual_max": 4.0,
        # contacts: empty = all window contacts of the room; extra: further contacts (doors, windows of the next room)
        # delay / resume in minutes; action off | frost; drop: detect airing from a fast temperature drop (K in 5 min)
        "window": {"on": True, "contacts": [], "extra": [], "delay": 2.0, "resume": 5.0, "action": "off", "drop": False, "drop_k": 1.0},
        # warm at the start of a block: begin earlier by the learned heat-up rate, at most `max` minutes
        "preheat": {"on": True, "max": 90, "learn": True, "rate": 1.5},
        # ventilation reminders; sensors None = found in the room; close_after 0 = from the outside temperature
        "vent": {
            "on": False,
            "times": [],
            "humidity_on": True,
            "humidity": 65,
            "humidity_sensor": None,
            "co2_on": True,
            "co2": 1000,
            "co2_sensor": None,
            "mould": True,
            "close": True,
            "close_after": 0,
            # minutes a value must stay over the limit before a reminder
            "wait": 5,
        },
        "valves": {"stuck": True},
        # smart heating (smart_heat.py): mode schedule | smart, style, ramp, shadow mode, guardrails, valve control
        "smart": smart_room(),
        # sections (SECTIONS) with an own setting; all others follow the house-wide defaults
        "own": [],
    }


# Settings a room takes from the house-wide defaults ("wie im ganzen Haus") unless it has its own: section → fields.
# Per room only, always: thermostats, thermometer, calibration, window contacts, time blocks, vent sensors and times,
# valve checks, guardrail overrides (smart.guard), radiator power and area.
SECTIONS: dict[str, tuple[str, ...]] = {
    "comfort": ("comfort",),
    "temps": ("base", "eco", "night", "frost"),
    "presence": ("away", "away_after", "empty", "empty_after", "home_soon"),
    "modes": ("sleep", "guests"),
    "manual": ("manual", "manual_hours", "manual_max"),
    "window": ("on", "delay", "resume", "action", "drop", "drop_k"),
    "vent": ("on", "humidity_on", "humidity", "co2_on", "co2", "mould", "close", "close_after", "wait"),
    "preheat": ("on", "max", "learn", "rate"),
    "style": ("style", "ramp"),
    "valve": ("valve",),
    "building": ("building",),
    "shadow": ("shadow_days",),
}


def _sec_base(p: dict[str, Any], sec: str) -> dict[str, Any]:
    if sec in ("comfort", "temps"):
        return p["temps"]
    if sec in ("presence", "window", "vent", "preheat"):
        return p[sec]
    if sec in ("modes", "manual"):
        return p
    return p["smart"]


def sec_get(p: dict[str, Any], sec: str) -> dict[str, Any]:
    """The values of one section of a plan."""
    base = _sec_base(p, sec)
    return {k: copy.deepcopy(base.get(k)) for k in SECTIONS[sec]}


def sec_set(p: dict[str, Any], sec: str, vals: dict[str, Any]) -> None:
    base = _sec_base(p, sec)
    for k in SECTIONS[sec]:
        if k in vals:
            base[k] = copy.deepcopy(vals[k])


def is_factory_block(b: dict[str, Any]) -> bool:
    """The time block every new room starts with (comfort 06–22 every day): no real "fixed time" for a smart room."""
    return b.get("from") == "06:00" and b.get("to") == "22:00" and b.get("days") == "all" and b.get("level") == "comfort"


def factory_defaults() -> dict[str, dict[str, Any]]:
    p = default_room()
    return {sec: sec_get(p, sec) for sec in SECTIONS}


def default_global() -> dict[str, Any]:
    return {
        # None = found by itself (a thermometer named "außen …", else the weather)
        "outside": None,
        # hold in minutes
        "summer": {"on": False, "above": 18.0, "hold": 60},
        # minutes
        "demand": {"on": False, "entity": None, "above": 20, "min_on": 10, "min_off": 10},
        "exercise": {"on": False, "weekday": 0, "time": "11:00", "minutes": 5},
        # person ids that get the reminders (only while they are at home), and quiet hours
        "notify": [],
        "quiet": {"on": True, "from": "22:00", "to": "07:00"},
        # minutes between small corrections per thermostat (battery)
        "gap": 5,
        # smart heating: house-wide guardrails, energy source and price, airing prior, heating assistant done
        "smart": smart_global(),
        # house-wide defaults of the room settings (SECTIONS); rooms follow them unless they have their own
        "defaults": factory_defaults(),
        # 1 = rooms were split into "own" and "like the house" once (migration of older installations)
        "defaults_v": 0,
        # 1 = "Von Hand: bis zur nächsten Zeit" became the smart manual mode once
        "manual_v": 0,
    }


def _num(v: Any, d: float, lo: float, hi: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return d
    if math.isnan(x):
        return d
    return max(lo, min(hi, x))


def _hm(s: Any) -> int | None:
    try:
        h, m = str(s).split(":")[:2]
        return (int(h) % 24) * 60 + int(m) % 60
    except (ValueError, AttributeError):
        return None


def _clean_time(v: Any, d: str) -> str:
    m = _hm(v)
    return f"{m // 60:02d}:{m % 60:02d}" if m is not None else d


def deg(x: float | None) -> str:
    """21 → '21 °C', 21.5 → '21,5 °C'."""
    if x is None:
        return "–"
    r = round(float(x) * 10) / 10
    s = str(int(r)) if r == int(r) else f"{r:.1f}".replace(".", ",")
    return f"{s}\u00a0°C"


def dur(sec: float) -> str:
    s = max(0, int(round(sec)))
    if s < 60:
        return f"{s} Sek."
    m = round(s / 60)
    if m < 60:
        return f"{m} Min."
    h, m = divmod(m, 60)
    return f"{h} Std. {m} Min." if m else f"{h} Std."


def fval(st: State | None, attr: str | None = None) -> float | None:
    if st is None:
        return None
    v = st.attributes.get(attr) if attr else st.state
    if v in BAD:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) else x


def psat(t: float) -> float:
    """Saturation vapour pressure (hPa, Magnus)."""
    return 6.112 * math.exp(17.62 * t / (243.12 + t))


def vent_minutes(outside: float | None, month: int) -> int:
    """How long to air with the window wide open (Stoßlüften): the colder outside, the shorter."""
    if outside is None:
        return {12: 5, 1: 5, 2: 5, 3: 10, 11: 10, 4: 15, 10: 15, 5: 20, 9: 20}.get(month, 25)
    for limit, m in ((0, 5), (5, 7), (10, 10), (15, 15), (20, 20)):
        if outside <= limit:
            return m
    return 25


def mould_rh(room_t: float | None, rh: float | None, outside: float | None) -> float | None:
    """Relative humidity at the coldest spot of an outside wall (temperature factor 0.7, DIN 4108-2)."""
    if room_t is None or rh is None:
        return None
    surface = outside + 0.7 * (room_t - outside) if outside is not None and outside < room_t else room_t - 3.0
    return min(100.0, rh * psat(room_t) / psat(surface))


class HeatingController:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._unsub: list[Callable[[], None]] = []
        self._pending: dict[str, CALLBACK_TYPE] = {}
        self._pending_at: dict[str, float] = {}
        self._rt: dict[str, dict[str, Any]] = {}
        self._g: dict[str, Any] = {"demand": {"on": False, "since": 0.0}, "summer": False}
        self._ent_rooms: dict[str, set[str]] = {}
        self._found: dict[str, Any] = {}
        self._found_at = 0.0
        self._listeners: list[Callable[[str | None], None]] = []
        self._ours: dict[str, float] = {}
        self._feat_unsub: Callable[[], None] | None = None
        self._settings_at = 0.0  # last change of heating settings (a reason that appears right after it stays silent)
        self._restored = False  # changes by hand were brought back from the store (once per start of the integration)
        self.smart = SmartHeating(hass, core, self)

    # ------------------------------------------------------------------ data
    @property
    def store(self) -> dict[str, Any]:
        return self.core.data.setdefault("plans", {}).setdefault("heat", {})

    @property
    def cfg(self) -> dict[str, Any]:
        raw = self.core.data.get("heating") or {}
        d = default_global()
        out = {**d, **{k: v for k, v in raw.items() if k in d}}
        for k in ("summer", "demand", "exercise", "quiet"):
            out[k] = {**d[k], **(raw.get(k) if isinstance(raw.get(k), dict) else {})}
        sm = raw.get("smart") if isinstance(raw.get("smart"), dict) else {}
        out["smart"] = {
            "guard": {**d["smart"]["guard"], **(sm.get("guard") or {})},
            "energy": {**d["smart"]["energy"], **(sm.get("energy") or {})},
            "airing": {**d["smart"]["airing"], **(sm.get("airing") or {})},
            "setup_done": bool(sm.get("setup_done", False)),
        }
        dd = raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {}
        out["defaults"] = {sec: {**vals, **{k: v for k, v in (dd.get(sec) or {}).items() if k in vals}} for sec, vals in d["defaults"].items()}
        return out

    def defaults(self) -> dict[str, dict[str, Any]]:
        return self.cfg["defaults"]

    def enabled(self) -> bool:
        """Global feature switch (Einstellungen → Funktionen → Heizung, setup.py), default on."""
        try:
            return bool(self.core.feature("heating"))
        except AttributeError:
            f = self.core.data.get("settings", {}).get("features")
            return not (isinstance(f, dict) and f.get("heating") is False)

    def room(self, rid: str) -> dict[str, Any]:
        raw = self.store.get(rid) or {}
        if raw and raw.get("v") != 2:
            return self._migrate(raw)
        d = default_room()
        p = {**d, **{k: v for k, v in raw.items() if k in d}}
        for k in ("temps", "presence", "window", "preheat", "vent", "valves", "smart"):
            p[k] = {**d[k], **(raw.get(k) if isinstance(raw.get(k), dict) else {})}
        own = raw.get("own")
        # a room saved before the house-wide defaults existed keeps all of its settings until the migration ran
        p["own"] = [s for s in (own if isinstance(own, list) else (list(SECTIONS) if raw else [])) if s in SECTIONS]
        dflt = self.defaults()
        for sec in SECTIONS:
            if sec not in p["own"]:
                sec_set(p, sec, dflt[sec])
        return p

    def _migrate_defaults(self) -> None:
        """Once: house-wide defaults from what the rooms have in common, each room keeps only what differs; and the
        re-scaled heating styles (the old "Eco" is now called "Komfort")."""
        raw_cfg = self.core.data.setdefault("heating", {})
        if raw_cfg.get("defaults_v") == 1:
            return
        rooms = {rid: raw for rid, raw in self.store.items() if isinstance(raw, dict) and raw.get("v") == 2}
        for raw in rooms.values():
            sm = raw.get("smart")
            if isinstance(sm, dict) and sm.get("sv") != hm.STYLE_VERSION:
                sm["style"] = hm.migrate_style(sm.get("style"), sm.get("sv"))
                sm["sv"] = hm.STYLE_VERSION
            # an intelligent room that still has the factory block heated 06–22 every day: that was no learned plan
            if isinstance(sm, dict) and sm.get("mode") == "smart" and isinstance(raw.get("blocks"), list):
                raw["blocks"] = [b for b in raw["blocks"] if not (isinstance(b, dict) and is_factory_block(b))]
        plans = {rid: self.room(rid) for rid in rooms}
        dflt = factory_defaults()
        for sec in SECTIONS:
            pool = [p for p in plans.values() if p["on"]] or list(plans.values())
            if pool:
                common = Counter(json.dumps(sec_get(p, sec), sort_keys=True) for p in pool).most_common(1)[0][0]
                dflt[sec] = json.loads(common)
        for rid, raw in rooms.items():
            raw["own"] = [sec for sec in SECTIONS if sec_get(plans[rid], sec) != dflt[sec]]
        raw_cfg["defaults"] = dflt
        raw_cfg["defaults_v"] = 1
        self.core.save()

    def _migrate_manual(self) -> None:
        """Once: "Von Hand: bis zur nächsten Zeit" becomes "Intelligent" (it ended within minutes in a smart room, where
        presence changes the plan); an explicit other choice (hours, room empty, never) stays."""
        raw_cfg = self.core.data.setdefault("heating", {})
        if raw_cfg.get("manual_v") == 1:
            return
        for raw in self.store.values():
            if isinstance(raw, dict) and raw.get("manual") == "next_block":
                raw["manual"] = "smart"
        dd = raw_cfg.get("defaults")
        if isinstance(dd, dict) and isinstance(dd.get("manual"), dict) and dd["manual"].get("manual") == "next_block":
            dd["manual"]["manual"] = "smart"
        raw_cfg["manual_v"] = 1
        self.core.save()

    def _migrate(self, raw: dict[str, Any]) -> dict[str, Any]:
        """First version (plans.py: base, windows, away_eco, sleep, vacation, window_off, preheat) → controller."""
        p = default_room()
        p["on"] = bool(raw.get("on"))
        old = [w for w in raw.get("windows") or [] if isinstance(w, dict)]
        temps = [float(w.get("temp") or 21) for w in old]
        comfort = max(set(temps), key=temps.count) if temps else 21.0
        sleep = raw.get("sleep") if isinstance(raw.get("sleep"), dict) else {}
        p["temps"] = {
            "comfort": comfort,
            "base": _num(raw.get("base"), 18.0, 5, 28),
            "eco": _num(self.core.data.get("settings", {}).get("eco_temp"), 17.0, 5, 25),
            "night": _num(sleep.get("temp"), 17.0, 5, 28),
            "frost": _num(raw.get("vacation"), 12.0, 5, 20),
        }
        p["blocks"] = self._blocks_from_windows(old, comfort)
        p["presence"]["away"] = bool(raw.get("away_eco", True))
        p["presence"]["away_after"] = 0
        p["presence"]["home_soon"] = bool(raw.get("preheat", True))
        p["sleep"] = bool(sleep.get("on", False))
        p["window"]["on"] = bool(raw.get("window_off", True))
        p["window"]["delay"] = 1.0
        return p

    @staticmethod
    def _blocks_from_windows(old: list[dict[str, Any]], comfort: float) -> list[dict[str, Any]]:
        out = []
        for w in old[:12]:
            t = _num(w.get("temp"), 21.0, 5, 28)
            out.append(
                {
                    "from": _clean_time(w.get("from"), "06:00"),
                    "to": _clean_time(w.get("to"), "22:00"),
                    "days": w.get("days") if w.get("days") in DAYS else "all",
                    "level": "comfort" if t == comfort else "custom",
                    "temp": t,
                }
            )
        return out

    def save_room(self, rid: str, raw: dict[str, Any]) -> None:
        """Saves a room's plan. A section (SECTIONS) becomes the room's own setting when its values differ from the
        house-wide defaults (or `own` lists it); `reset: [sections]` goes back to "wie im ganzen Haus"."""
        if rid not in self.core.rooms:
            raise ValueError("Unbekannter Raum")
        p = self.room(rid)
        was_smart = p["smart"]["mode"] == "smart"
        self._clean_into(p, raw)
        dflt = self.defaults()
        own = {s for s in (raw["own"] if isinstance(raw.get("own"), list) else p["own"]) if s in SECTIONS}
        reset = {s for s in (raw.get("reset") or []) if s in SECTIONS} if isinstance(raw.get("reset"), list) else set()
        for sec in SECTIONS:
            if sec in reset:
                own.discard(sec)
                sec_set(p, sec, dflt[sec])
            elif sec not in own and sec_get(p, sec) != dflt[sec]:
                own.add(sec)
        p["own"] = [s for s in SECTIONS if s in own]
        # switched to intelligent: the untouched factory time block (06–22 every day) is not a "fixed time"
        if p["smart"]["mode"] == "smart" and not was_smart:
            p["blocks"] = [b for b in p["blocks"] if not is_factory_block(b)]
        self.store[rid] = p
        self.core.save()
        rt = self._rt.setdefault(rid, {})
        self._drop_manual(rid)
        rt.pop("corr", None)
        # the ventilation memory stays (what was reminded, since when a value is over the limit): saving settings
        # must never remind again; a reason that only appears through the new settings stays silent (_vent)
        self._settings_at = time.time()
        rt.pop("calib_at", None)
        rt.pop("ramp", None)
        rt.pop("ramp_s", None)
        self.smart._sugg = None  # noqa: SLF001
        self.smart.forget(rid)
        self.start()

    def _clean_into(self, p: dict[str, Any], raw: dict[str, Any]) -> None:  # noqa: C901 — one place that checks every field
        """Checks every field of `raw` and writes it into the plan `p` (rooms and the house-wide defaults)."""
        if isinstance(raw.get("on"), bool):
            p["on"] = raw["on"]
        ents = lambda v, pre: [e for e in (v or []) if isinstance(e, str) and e.startswith(pre)][:20]  # noqa: E731
        if isinstance(raw.get("thermostats"), list):
            p["thermostats"] = ents(raw["thermostats"], ("climate.",))
        if "sensor" in raw:
            p["sensor"] = raw["sensor"] if isinstance(raw["sensor"], str) and raw["sensor"].startswith(("sensor.", "climate.", "weather.")) else None
        if raw.get("calibrate") in ("auto", "offset", "target", "off"):
            p["calibrate"] = raw["calibrate"]
        # legacy fields of the first version (API clients, old tests)
        t = dict(p["temps"])
        if isinstance(raw.get("base"), (int, float)):
            t["base"] = raw["base"]
        if isinstance(raw.get("vacation"), (int, float)):
            t["frost"] = raw["vacation"]
        if isinstance(raw.get("temps"), dict):
            t.update({k: v for k, v in raw["temps"].items() if k in LEVELS})
        p["temps"] = {k: _num(t.get(k), default_room()["temps"][k], 5, 28 if k != "frost" else 20) for k in LEVELS}
        if isinstance(raw.get("away_eco"), bool):
            p["presence"]["away"] = raw["away_eco"]
        if isinstance(raw.get("preheat"), bool):
            p["presence"]["home_soon"] = raw["preheat"]
        if isinstance(raw.get("window_off"), bool):
            p["window"]["on"] = raw["window_off"]
        if isinstance(raw.get("sleep"), dict):
            p["sleep"] = bool(raw["sleep"].get("on", p["sleep"]))
            if isinstance(raw["sleep"].get("temp"), (int, float)):
                p["temps"]["night"] = _num(raw["sleep"]["temp"], 17, 5, 28)
        elif isinstance(raw.get("sleep"), bool):
            p["sleep"] = raw["sleep"]
        if isinstance(raw.get("guests"), bool):
            p["guests"] = raw["guests"]
        if isinstance(raw.get("windows"), list) and all(isinstance(w, dict) and "from" in w for w in raw["windows"]):
            p["blocks"] = self._blocks_from_windows(raw["windows"], p["temps"]["comfort"])
        elif isinstance(raw.get("blocks"), list):
            p["blocks"] = [
                {
                    "from": _clean_time(b.get("from"), "06:00"),
                    "to": _clean_time(b.get("to"), "22:00"),
                    "days": b.get("days") if b.get("days") in DAYS else "all",
                    "level": b.get("level") if b.get("level") in BLOCK_LEVELS else "comfort",
                    "temp": _num(b.get("temp"), 21.0, 5, 28),
                }
                for b in raw["blocks"][:12]
                if isinstance(b, dict)
            ]
        if isinstance(pr := raw.get("presence"), dict):
            cur = p["presence"]
            p["presence"] = {
                "away": bool(pr.get("away", cur["away"])),
                "away_after": _num(pr.get("away_after", cur["away_after"]), 15, 0, 1440),
                "empty": bool(pr.get("empty", cur["empty"])),
                "empty_after": _num(pr.get("empty_after", cur["empty_after"]), 30, 0, 1440),
                "home_soon": bool(pr.get("home_soon", cur["home_soon"])),
            }
        if raw.get("manual") in MANUAL:
            p["manual"] = raw["manual"]
        if "manual_hours" in raw:
            p["manual_hours"] = _num(raw["manual_hours"], 2, 0.001, 48)
        if "manual_max" in raw:
            # the screens offer 1–12 hours; fractions are for the tests
            p["manual_max"] = _num(raw["manual_max"], 4, 0.001, 12)
        if isinstance(w := raw.get("window"), dict):
            cur = p["window"]
            p["window"] = {
                "on": bool(w.get("on", cur["on"])),
                "contacts": ents(w.get("contacts", cur["contacts"]), ("binary_sensor.", "input_boolean.")),
                "extra": ents(w.get("extra", cur["extra"]), ("binary_sensor.", "input_boolean.")),
                "delay": _num(w.get("delay", cur["delay"]), 2, 0, 60),
                "resume": _num(w.get("resume", cur["resume"]), 5, 0, 120),
                "action": w.get("action") if w.get("action") in ("off", "frost") else cur["action"],
                "drop": bool(w.get("drop", cur["drop"])),
                "drop_k": _num(w.get("drop_k", cur["drop_k"]), 1.0, 0.3, 5),
            }
        if isinstance(ph := raw.get("preheat_cfg") or (raw.get("preheat") if isinstance(raw.get("preheat"), dict) else None), dict):
            p["preheat"] = {
                "on": bool(ph.get("on", p["preheat"]["on"])),
                "max": _num(ph.get("max", p["preheat"]["max"]), 90, 0, 360),
                # heat-up rate: learned from the room (default) or a fixed value set by the user
                "learn": bool(ph.get("learn", p["preheat"].get("learn", True))),
                "rate": _num(ph.get("rate", p["preheat"].get("rate", 1.5)), 1.5, 0.2, 6),
            }
        if isinstance(v := raw.get("vent"), dict):
            cur = p["vent"]
            sensor = lambda k: v[k] if isinstance(v.get(k), str) and v[k].startswith("sensor.") else (None if k in v else cur[k])  # noqa: E731
            p["vent"] = {
                "on": bool(v.get("on", cur["on"])),
                "times": sorted({_clean_time(x, "08:00") for x in (v.get("times", cur["times"]) or []) if _hm(x) is not None})[:8],
                "humidity_on": bool(v.get("humidity_on", cur["humidity_on"])),
                "humidity": _num(v.get("humidity", cur["humidity"]), 65, 30, 95),
                "humidity_sensor": sensor("humidity_sensor"),
                "co2_on": bool(v.get("co2_on", cur["co2_on"])),
                "co2": _num(v.get("co2", cur["co2"]), 1000, 400, 5000),
                "co2_sensor": sensor("co2_sensor"),
                "mould": bool(v.get("mould", cur["mould"])),
                "close": bool(v.get("close", cur["close"])),
                "close_after": _num(v.get("close_after", cur["close_after"]), 0, 0, 240),
                "wait": _num(v.get("wait", cur["wait"]), 5, 0, 120),
            }
        if isinstance(va := raw.get("valves"), dict):
            p["valves"] = {"stuck": bool(va.get("stuck", p["valves"]["stuck"]))}
        if isinstance(raw.get("smart"), dict):
            p["smart"] = clean_smart(raw["smart"], p["smart"])

    def save_global(self, raw: dict[str, Any]) -> None:
        g = self.cfg
        if "outside" in raw:
            g["outside"] = raw["outside"] if isinstance(raw["outside"], str) and raw["outside"].startswith(("sensor.", "weather.")) else None
        if isinstance(s := raw.get("summer"), dict):
            g["summer"] = {"on": bool(s.get("on", g["summer"]["on"])), "above": _num(s.get("above", g["summer"]["above"]), 18, 10, 30), "hold": _num(s.get("hold", g["summer"]["hold"]), 60, 0, 1440)}
        if isinstance(d := raw.get("demand"), dict):
            ent = d.get("entity", g["demand"]["entity"])
            g["demand"] = {
                "on": bool(d.get("on", g["demand"]["on"])),
                "entity": ent if isinstance(ent, str) and ent.split(".")[0] in ("switch", "input_boolean", "climate", "fan", "light") else None,
                "above": _num(d.get("above", g["demand"]["above"]), 20, 1, 100),
                "min_on": _num(d.get("min_on", g["demand"]["min_on"]), 10, 0, 240),
                "min_off": _num(d.get("min_off", g["demand"]["min_off"]), 10, 0, 240),
            }
        if isinstance(x := raw.get("exercise"), dict):
            g["exercise"] = {
                "on": bool(x.get("on", g["exercise"]["on"])),
                "weekday": int(_num(x.get("weekday", g["exercise"]["weekday"]), 0, 0, 6)),
                "time": _clean_time(x.get("time", g["exercise"]["time"]), "11:00"),
                "minutes": _num(x.get("minutes", g["exercise"]["minutes"]), 5, 0.05, 30),
            }
        if isinstance(raw.get("notify"), list):
            g["notify"] = [str(x)[:60] for x in raw["notify"] if isinstance(x, str)][:10]
        if isinstance(q := raw.get("quiet"), dict):
            g["quiet"] = {"on": bool(q.get("on", g["quiet"]["on"])), "from": _clean_time(q.get("from", g["quiet"]["from"]), "22:00"), "to": _clean_time(q.get("to", g["quiet"]["to"]), "07:00")}
        if "gap" in raw:
            g["gap"] = _num(raw["gap"], 5, 0, 120)
        if isinstance(sm := raw.get("smart"), dict):
            cur = g["smart"]
            if isinstance(sm.get("guard"), dict):
                cur["guard"] = clean_guard({**cur["guard"], **sm["guard"]})
            if isinstance(en := sm.get("energy"), dict):
                e = {**energy_default(), **cur["energy"]}
                if en.get("kind") in ENERGY_KINDS:
                    e["kind"] = en["kind"]
                if "meter" in en:
                    e["meter"] = en["meter"] if isinstance(en["meter"], str) and en["meter"].startswith(("sensor.", "input_number.")) else None
                if "price" in en:
                    e["price"] = _num(en["price"], 0.0, 0, 10) if en["price"] is not None else None
                for k, d0, lo, hi in (("gas_kwh_m3", 10.3, 5, 15), ("cop", 3.2, 1, 7), ("efficiency", 0.92, 0.5, 1.1)):
                    if k in en:
                        e[k] = _num(en[k], d0, lo, hi)
                cur["energy"] = e
            if isinstance(ai := sm.get("airing"), dict):
                a = dict(cur["airing"])
                if "morning" in ai:
                    a["morning"] = None if ai["morning"] is None else bool(ai["morning"])
                if "minutes" in ai:
                    a["minutes"] = _num(ai["minutes"], 10, 1, 60)
                if isinstance(ai.get("rooms"), list):
                    a["rooms"] = [r for r in ai["rooms"] if isinstance(r, str) and r in self.core.rooms][:50]
                cur["airing"] = a
            if isinstance(sm.get("setup_done"), bool):
                cur["setup_done"] = sm["setup_done"]
            g["smart"] = cur
        if isinstance(dd := raw.get("defaults"), dict):
            # the same checks as a room; every room without an own setting follows right away
            tmp = default_room()
            for sec in SECTIONS:
                sec_set(tmp, sec, g["defaults"][sec])
            self._clean_into(tmp, dd)
            g["defaults"] = {sec: sec_get(tmp, sec) for sec in SECTIONS}
        self.core.data["heating"] = g
        self.core.save()
        self._settings_at = time.time()
        self.smart.forget(None)
        self.start()

    # ------------------------------------------------------------------ devices of a room
    def _area_entities(self, rid: str) -> list[str]:
        ent_reg = er.async_get(self.hass)
        dev_reg = dr.async_get(self.hass)
        ids = {e.entity_id for e in er.async_entries_for_area(ent_reg, rid) if not e.disabled_by}
        for dev in dr.async_entries_for_area(dev_reg, rid):
            ids.update(e.entity_id for e in er.async_entries_for_device(ent_reg, dev.id) if not e.disabled_by and e.area_id in (None, rid))
        inv = self.core.inventory
        ids.update(d["entity_id"] for d in inv.devices.values() if d.get("room") == rid)
        # the user's choice counts (inventory.py): excluded entities and vehicle parts never, devices moved to another room there
        return sorted(i for i in ids if self.hass.states.get(i) and inv.usable(i) and (i not in inv.devices or inv.devices[i].get("room") == rid))

    def _device_entities(self, entity_id: str) -> list[str]:
        ent_reg = er.async_get(self.hass)
        e = ent_reg.async_get(entity_id)
        if not e or not e.device_id:
            return []
        return [x.entity_id for x in er.async_entries_for_device(ent_reg, e.device_id) if not x.disabled_by and x.entity_id != entity_id]

    def _name(self, e: str | None) -> str:
        if not e:
            return ""
        d = self.core.inventory.devices.get(e)
        st = self.hass.states.get(e)
        return d["name"] if d else (str(st.attributes.get("friendly_name")) if st else e)

    def found(self, rid: str) -> dict[str, Any]:
        """What the room has (suggestions for the settings; the user confirms)."""
        now = time.time()
        if now - self._found_at > 60:
            self._found = {}
            self._found_at = now
        if rid in self._found:
            return self._found[rid]
        inv = self.core.inventory
        area = self._area_entities(rid)
        therms = inv.in_room("climate", rid)
        trv_devs: set[str] = set()
        for t in therms:
            trv_devs.update(self._device_entities(t))

        def dc(e: str) -> str:
            st = self.hass.states.get(e)
            return str(st.attributes.get("device_class") or "") if st else ""

        def unit(e: str) -> str:
            st = self.hass.states.get(e)
            return str(st.attributes.get("unit_of_measurement") or "") if st else ""

        temps = [e for e in area if e.startswith("sensor.") and (dc(e) == "temperature" or unit(e) in ("°C", "°F")) and e not in trv_devs and not OUTSIDE_NAME.search(self._name(e) + e)]
        out = {
            "thermostats": therms,
            "sensors": temps,
            "contacts": inv.in_room("window", rid),
            "doors": inv.in_room("door", rid),
            "humidity": [e for e in area if e.startswith("sensor.") and dc(e) == "humidity"],
            "co2": [e for e in area if e.startswith("sensor.") and (dc(e) == "carbon_dioxide" or (unit(e) == "ppm" and "co2" in e.lower()))],
            "valves": {t: self._valve_source(t) for t in therms},
            "calibration": {t: self._calib_entity(t) for t in therms},
            "own_window": {t: self._own_window_source(t) for t in therms},
        }
        self._found[rid] = out
        return out

    def outside_entity(self) -> str | None:
        g = self.cfg
        if g["outside"] and self.hass.states.get(g["outside"]):
            return g["outside"]
        if "outside" in self._found:
            return self._found["outside"]
        best = None
        for st in self.hass.states.async_all("sensor"):
            if not self.core.inventory.usable(st.entity_id):
                continue
            if (st.attributes.get("device_class") == "temperature" or st.attributes.get("unit_of_measurement") == "°C") and OUTSIDE_NAME.search(f"{st.entity_id} {st.attributes.get('friendly_name', '')}"):
                best = st.entity_id
                break
        if not best:
            w = [st.entity_id for st in self.hass.states.async_all("weather") if fval(st, "temperature") is not None]
            best = w[0] if w else None
        self._found["outside"] = best
        return best

    def outside(self) -> float | None:
        e = self.outside_entity()
        st = self.hass.states.get(e) if e else None
        if not st:
            return None
        return self.ctemp(st, "temperature") if e.startswith("weather.") else self.ctemp(st)

    def thermostats(self, rid: str, p: dict[str, Any]) -> list[str]:
        ids = p["thermostats"] or self.core.inventory.in_room("climate", rid)
        return [e for e in ids if self.hass.states.get(e)]

    def contacts(self, rid: str, p: dict[str, Any]) -> list[str]:
        ids = list(p["window"]["contacts"] or self.core.inventory.in_room("window", rid)) + list(p["window"]["extra"])
        return [e for e in dict.fromkeys(ids) if self.hass.states.get(e)]

    def _vent_sensor(self, rid: str, p: dict[str, Any], kind: str) -> str | None:
        e = p["vent"][f"{kind}_sensor"]
        if e and self.hass.states.get(e):
            return e
        f = self.found(rid)[kind]
        return f[0] if f else None

    def _valve_source(self, e: str) -> str | None:
        st = self.hass.states.get(e)
        if st:
            for a in VALVE_ATTRS:
                if fval(st, a) is not None:
                    return f"attr:{a}"
        for x in sorted(self._device_entities(e), key=lambda i: not i.startswith("sensor.")):
            if not x.startswith(("sensor.", "number.")):
                continue
            xs = self.hass.states.get(x)
            if xs and xs.attributes.get("unit_of_measurement") == "%" and VALVE_NAME.search(x + " " + str(xs.attributes.get("friendly_name", ""))) and not re.search(r"batter|humid|feucht|_degree|grad", x, re.I):
                return x
        return None

    def valve(self, e: str) -> float | None:
        src = self.found_valve(e)
        if not src:
            return None
        if src.startswith("attr:"):
            return fval(self.hass.states.get(e), src[5:])
        return fval(self.hass.states.get(src))

    def found_valve(self, e: str) -> str | None:
        rid = self.core.inventory.room_of(e)
        if rid and e in (f := self.found(rid))["valves"]:
            return f["valves"][e]
        return self._valve_source(e)

    def _calib_entity(self, e: str) -> str | None:
        for x in self._device_entities(e):
            if x.startswith("number.") and CALIB_NAME.search(x):
                st = self.hass.states.get(x)
                if st and fval(st) is not None:
                    return x
        return None

    def _own_window_source(self, e: str) -> str | None:
        st = self.hass.states.get(e)
        if st and any(k in st.attributes for k in ("window_open", "window_state", "open_window")):
            return "attr"
        for x in self._device_entities(e):
            if x.startswith("binary_sensor.") and re.search(r"window|fenster", x, re.I):
                return x
        return None

    def own_window_open(self, e: str) -> bool:
        st = self.hass.states.get(e)
        if st:
            for k in ("window_open", "window_state", "open_window"):
                v = st.attributes.get(k)
                if v is True or str(v).lower() in ("on", "open", "true", "opened"):
                    return True
        rid = self.core.inventory.room_of(e)
        src = self.found(rid)["own_window"].get(e) if rid else None
        if src and src != "attr":
            xs = self.hass.states.get(src)
            return bool(xs and xs.state == "on")
        return False

    # ------------------------------------------------------------------ units: inside everything is °C
    def fahrenheit(self) -> bool:
        return str(self.hass.config.units.temperature_unit) == "°F"

    def ctemp(self, st: State | None, attr: str | None = None) -> float | None:
        """A temperature in °C, whatever the entity reports (°F systems, sensors in °F, weather in °F)."""
        v = fval(st, attr)
        if v is None or st is None:
            return None
        if attr is None:
            f = st.attributes.get("unit_of_measurement") == "°F"
        elif st.domain == "weather":
            f = st.attributes.get("temperature_unit") == "°F"
        else:
            f = self.fahrenheit()
        return round((v - 32) * 5 / 9, 2) if f else v

    def room_temp(self, rid: str, p: dict[str, Any]) -> tuple[float | None, str]:
        if p["sensor"]:
            st = self.hass.states.get(p["sensor"])
            v = self.ctemp(st, "current_temperature") if p["sensor"].startswith("climate.") else self.ctemp(st, "temperature") if p["sensor"].startswith("weather.") else self.ctemp(st)
            if v is not None:
                return v, "sensor"
        vals = [v for e in self.thermostats(rid, p) if (v := self.ctemp(self.hass.states.get(e), "current_temperature")) is not None]
        return (round(sum(vals) / len(vals), 2) if vals else None), "thermostat"

    # ------------------------------------------------------------------ runtime
    def add_listener(self, cb: Callable[[str | None], None]) -> Callable[[], None]:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb) if cb in self._listeners else None

    def _active_rooms(self) -> list[str]:
        out = []
        for rid in self.core.rooms:
            raw = self.store.get(rid) or {}
            if raw.get("on") or (isinstance(raw.get("vent"), dict) and raw["vent"].get("on")):
                out.append(rid)
        return out

    def start(self) -> None:
        self.stop()
        self._found = {}
        self._ent_rooms = {}
        try:
            self._migrate_defaults()
        except Exception as err:  # noqa: BLE001 — a broken old plan must not stop the heating
            _LOGGER.warning("Heizung: Übernahme der Hausvorgaben: %s", err)
        try:
            self._migrate_manual()
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Heizung: Umstellung „Von Hand“: %s", err)
        feats = getattr(self.core, "features", None)
        if feats is not None and not self._feat_unsub:
            # the feature switch: off = no listeners, nothing is sent, entities unavailable
            self._feat_unsub = feats.add_listener(lambda _f: self.start())
        if not self.enabled():
            for rid, rt in self._rt.items():
                rt.pop("status", None)
                self._drop_manual(rid)
            self._g["demand"] = {"on": False, "since": 0.0}
            self.smart.stop()
            for cb in list(self._listeners):
                cb(None)
            if hook := self.core.entity_hooks.get("heating"):
                hook()
            return
        if not self._restored:
            self._restored = True
            self._restore_manual()
        ents: set[str] = set()
        for rid in self._active_rooms():
            p = self.room(rid)
            mine = set(self.thermostats(rid, p)) | set(self.contacts(rid, p))
            for t in self.thermostats(rid, p):
                mine.update(x for x in self._device_entities(t) if x.startswith(("sensor.", "number.", "binary_sensor.")))
            for k in ("humidity", "co2"):
                if s := self._vent_sensor(rid, p, k):
                    mine.add(s)
            if p["sensor"]:
                mine.add(p["sensor"])
            for e in mine:
                self._ent_rooms.setdefault(e, set()).add(rid)
            ents |= mine
        g = self.cfg
        glob = {e for e in (self.outside_entity(), g["demand"]["entity"]) if e}
        glob |= {p["entity_id"] for p in self.core.inventory.persons.values()}
        ents |= glob
        if ents:
            self._unsub.append(async_track_state_change_event(self.hass, list(ents), self._changed))
        self._unsub.append(self.core.room_tracker.add_listener(lambda r, _o: self.schedule(r)))
        self._unsub.append(self.core.engine.on_mode(lambda _m, _c: self.schedule_all()))
        self._unsub.append(async_track_time_interval(self.hass, callback(lambda _now: self._tick()), timedelta(seconds=30)))
        self.smart.start()
        if hook := self.core.entity_hooks.get("heating"):
            hook()
        self.schedule_all()

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()
        for t in self._pending.values():
            t()
        self._pending.clear()
        self._pending_at.clear()

    @callback
    def _tick(self) -> None:
        self.schedule_all()

    def schedule_all(self, delay: float = 0.3) -> None:
        for rid in self._active_rooms():
            self.schedule(rid, delay)
        self.schedule("_global", delay + 0.5)

    def schedule(self, rid: str, delay: float = 0.3) -> None:
        if not self.enabled() or (rid != "_global" and rid not in self._active_rooms()):
            return
        at = time.time() + max(0.1, delay)
        if rid in self._pending and self._pending_at.get(rid, 0) <= at:
            return
        if (t := self._pending.pop(rid, None)) is not None:
            t()

        @callback
        def go(_now: Any = None) -> None:
            self._pending.pop(rid, None)
            self._pending_at.pop(rid, None)
            if rid == "_global":
                self.hass.async_create_task(self._global())
            else:
                self.hass.async_create_task(self.evaluate(rid))

        self._pending[rid] = async_call_later(self.hass, max(0.1, delay), go)
        self._pending_at[rid] = at

    @callback
    def _changed(self, event: Event[EventStateChangedData]) -> None:
        eid = event.data["entity_id"]
        new, old = event.data["new_state"], event.data["old_state"]
        rooms = self._ent_rooms.get(eid, set())
        if eid.startswith("climate.") and new is not None and old is not None:
            for rid in rooms:
                self._maybe_manual(rid, eid, old, new)
            # learn / show valve changes for the house-wide heat demand
            self.schedule("_global", 1.0)
        if eid.startswith(("sensor.", "number.")) and rooms:
            self.schedule("_global", 1.0)
        if rooms:
            for rid in rooms:
                self.schedule(rid, 0.2)
        else:
            self.schedule_all(0.5)

    def _maybe_manual(self, rid: str, eid: str, old: State, new: State) -> None:
        """A person changed the target or switched it off/on: keep it, as set in "Von Hand"."""
        ot, nt = old.attributes.get("temperature"), new.attributes.get("temperature")
        if ot == nt and old.state == new.state:
            return
        if new.state in BAD or old.state in BAD:
            return
        ctx = new.context
        ours = ctx.id in self._ours or (ctx.parent_id is not None and ctx.parent_id in self._ours) or self.core.history.is_ours(ctx)
        rt = self._rt.setdefault(rid, {})
        sent = rt.get("sent", {}).get(eid)
        # the device reports back what we sent (often later, with a context of its own)
        echo = bool(sent and time.time() - sent["t"] < 600 and ((sent.get("temp") is not None and nt is not None and abs(float(nt) - float(sent["temp"])) < 0.1 and new.state == old.state) or (sent.get("mode") == new.state and ot == nt)))
        person = not ours and not echo and not self.core.automation_user(ctx.user_id) and bool(ctx.user_id or ctx.parent_id is None)
        if not person or self.own_window_open(eid):
            return
        if self.core.starting() and not ctx.user_id:
            # right after a start other flows switch thermostats (off, a fixed value) and devices report old values:
            # not a person's wish, the room goes back to its target (evaluate runs right after this). A change by a
            # signed-in person (app, dashboard; not a user set up as an automation) always counts.
            self.core.history.add("automation", f"Heizung {self.core.rooms.get(rid, {}).get('name', rid)}: {'aus' if new.state == 'off' else deg(self.ctemp(new, 'temperature'))}", "Während des Starts verstellt – wird auf den Plan zurückgesetzt.", entity_id=eid)
            return
        p = self.room(rid)
        if p["manual"] == "never":
            return
        manual: dict[str, Any] = {
            "entity": eid,
            "temp": self.ctemp(new, "temperature") if nt is not None else None,
            "off": new.state == "off",
            "at": time.time(),
            "key": f"{self.core.mode}:{self.schedule_target(rid, p, self.room_temp(rid, p)[0])['key']}",
            "who": f"in der App ({self.core.users.get(ctx.user_id, '')})".replace(" ()", "") if ctx.user_id else "am Thermostat",
        }
        if p["manual"] == "smart":
            inv = self.core.inventory
            manual["mode"] = self.core.mode
            # "everyone left" only ends a change made while someone was at home (not one made on the way home)
            manual["home"] = bool(inv.persons) and any(inv.person_home(pid) for pid in inv.persons)
            try:
                manual["edge"] = self._manual_edge(rid, p, dt_util.now(), p["manual_max"])
            except Exception as err:  # noqa: BLE001 — without a known plan change the safety limit still ends it
                _LOGGER.debug("Heizung %s: nächster Planwechsel: %s", rid, err)
                manual["edge"] = None
        self._set_manual(rid, manual)
        if nt is not None and new.state != "off":
            d = rt.get("status") or {}
            self.smart.manual(rid, manual["temp"], d.get("temp") if d.get("mode") == "heat" else None)
        name = self.core.rooms.get(rid, {}).get("name", rid)
        self.core.history.add("manual", f"Heizung {name}: von Hand {'aus' if new.state == 'off' else deg(manual['temp'])}", f"{manual['who']}; {self._manual_until_text(p, rid, manual)}.", entity_id=eid)

    def _manual_until_text(self, p: dict[str, Any], rid: str, manual: dict[str, Any] | None = None) -> str:
        m = p["manual"]
        if m == "smart" and manual:
            return tr(self.core, "heat.m_set_smart", until=self._manual_until(p, manual))
        if m == "next_block":
            nxt = self._next_change(p)
            return f"bleibt bis zum nächsten Zeitwechsel{f' ({nxt})' if nxt else ''}"
        if m == "hours":
            return f"bleibt {dur(p['manual_hours'] * 3600)}"
        if m == "room_empty":
            return "bleibt, bis der Raum leer ist"
        return "wird zurückgestellt"

    # ------------------------------------------------------------------ changes by hand: kept across restarts
    def _manual_store(self) -> dict[str, Any]:
        return self.core.data.setdefault("runtime", {}).setdefault("heat_manual", {})

    def _set_manual(self, rid: str, manual: dict[str, Any]) -> None:
        self._rt.setdefault(rid, {})["manual"] = manual
        self._manual_store()[rid] = manual
        self.core.save()

    def _drop_manual(self, rid: str) -> dict[str, Any] | None:
        m = self._rt.get(rid, {}).pop("manual", None)
        if self._manual_store().pop(rid, None) is not None:
            self.core.save()
        return m

    def _restore_manual(self) -> None:
        """After a restart: the changes by hand that still hold come back (a restart is no change of circumstances);
        the ones whose time ran out while Home Assistant was down are dropped."""
        store = self._manual_store()
        now = time.time()
        for rid, m in list(store.items()):
            keep = isinstance(m, dict) and isinstance(m.get("at"), (int, float)) and rid in self.core.rooms and now - m["at"] < MANUAL_KEEP_HOURS * 3600
            if keep:
                p = self.room(rid)
                edge = m.get("edge") if isinstance(m.get("edge"), dict) else None
                keep = p["on"] and p["manual"] != "never"
                if keep and p["manual"] == "hours":
                    keep = now - m["at"] < p["manual_hours"] * 3600
                if keep and p["manual"] == "smart":
                    keep = now < m["at"] + p["manual_max"] * 3600 and not (edge and now >= float(edge.get("at") or 0))
            if keep:
                self._rt.setdefault(rid, {})["manual"] = m
            else:
                store.pop(rid, None)
                self.core.save()

    @staticmethod
    def _cls(p: dict[str, Any], level: str, temp: float) -> str | None:
        """The kind of a plan step for "Von Hand: intelligent": comfort | low | night; None = airing (no real change)."""
        if level == "airing":
            return None
        if level == "night":
            return "night"
        if level in ("comfort", "preheat") or (level == "custom" and temp >= float(p["temps"]["comfort"]) - 0.5):
            return "comfort"
        return "low"

    def _manual_edge(self, rid: str, p: dict[str, Any], now_dt: datetime, hours: float) -> dict[str, Any] | None:
        """The next real change of the plan within `hours`: comfort ↔ setback ↔ night of the time plan (a smart room:
        of its learned day). Presence changes nothing here – it is no change of the plan."""
        end = now_dt + timedelta(hours=hours)
        steps: list[tuple[datetime, str | None]] = []
        if self.smart.active(p):
            for day in (now_dt.date(), (now_dt + timedelta(days=1)).date()):
                start = dt_util.start_of_local_day(day)
                for s in self.smart.today_plan(rid, p, day):
                    a = _hm(s["from"])
                    if a is not None:
                        steps.append((start + timedelta(minutes=a), self._cls(p, s["level"], float(s["temp"]))))
        else:
            days = [dt_util.start_of_local_day((now_dt + timedelta(days=d)).date()) for d in (0, 1)]
            times = sorted({day + timedelta(minutes=m) for day in days for b in p["blocks"] for m in (_hm(b["from"]), _hm(b["to"])) if m is not None})
            for t in [now_dt, *[x for x in times if now_dt < x <= end]]:
                b = self.block_now(p, t)
                steps.append((t, self._cls(p, b["level"], self._block_temp(p, b)) if b else "low"))
        cur: str | None = None
        for t, c in sorted(steps, key=lambda x: x[0]):
            if c is None:
                continue
            if t <= now_dt:
                cur = c
                continue
            if t > end:
                break
            if cur is None:
                cur = c
            elif c != cur:
                return {"at": t.timestamp(), "cls": c}
        return None

    def _manual_until(self, p: dict[str, Any], manual: dict[str, Any]) -> str:
        """Until when a smart change by hand holds at the latest: the next change of the plan or the safety limit."""
        max_at = float(manual["at"]) + p["manual_max"] * 3600
        edge = manual.get("edge") if isinstance(manual.get("edge"), dict) else None

        def hhmm(ts: float) -> str:
            return dt_util.as_local(dt_util.utc_from_timestamp(ts)).strftime("%H:%M")

        if edge and float(edge["at"]) <= max_at:
            return tr(self.core, f"heat.m_until_{edge.get('cls', 'low')}", time=hhmm(float(edge["at"])))
        return tr(self.core, "heat.m_until_max", time=hhmm(max_at))

    def _manual_end(self, rid: str, p: dict[str, Any], manual: dict[str, Any], now: float) -> str | None:
        """Why a smart change by hand ends now (a sentence for the history), or None: it holds."""
        mode = self.core.mode
        if manual.get("mode") and mode != manual["mode"]:
            return tr(self.core, "heat.m_end_mode", mode=self.core.mode_label(mode))
        edge = manual.get("edge") if isinstance(manual.get("edge"), dict) else None
        max_at = float(manual["at"]) + p["manual_max"] * 3600
        if edge and now >= float(edge["at"]):
            return tr(self.core, f"heat.m_end_plan_{edge.get('cls', 'low')}")
        if now >= max_at:
            return tr(self.core, "heat.m_end_max", d=dur(p["manual_max"] * 3600))
        self.schedule(rid, min(max_at, float(edge["at"]) if edge else max_at) - now + 0.5)
        if self.core.starting():
            # persons and rooms are not known yet right after a start: no "everyone left" or "room empty" from that
            return None
        inv = self.core.inventory
        if manual.get("home") and inv.persons and not any(inv.person_home(pid) for pid in inv.persons):
            since = max([float(manual["at"])] + [self._person_since(pid) for pid in inv.persons])
            wait = p["presence"]["away_after"] * 60
            if now - since >= wait:
                return tr(self.core, "heat.m_end_away")
            self.schedule(rid, wait - (now - since) + 1)
        room = self.core.rooms.get(rid) or {}
        senses = bool(room.get("presence") or room.get("motion") or room.get("door_logic"))
        if senses and not self.core.room_tracker.occupied(rid):
            # (tests run the smart heating faster: the same factor shortens the wait)
            empty_for = (now - max(float(manual["at"]), self.core.room_tracker.changed_at(rid))) * self.smart.factor
            if empty_for >= MANUAL_EMPTY_MINUTES * 60:
                return tr(self.core, "heat.m_end_empty", minutes=round(empty_for / 60))
        return None

    def _manual_restored(self, rid: str, p: dict[str, Any], manual: dict[str, Any]) -> bool:
        """After a window: every reachable thermostat has the value set by hand again."""
        for e in self.thermostats(rid, p):
            st = self.hass.states.get(e)
            if st is None or st.state in BAD:
                continue
            if manual["off"]:
                if st.state != "off":
                    return False
                continue
            t = self.ctemp(st, "temperature")
            if st.state == "off" or t is None or abs(t - float(manual["temp"])) > 0.3:
                return False
        return True

    # ------------------------------------------------------------------ schedule
    def _day_ok(self, days: str, now: datetime) -> bool:
        if days == "all":
            return True
        wd = self.core.checker._workday(now)  # noqa: SLF001 — same rule as "werktags" in sentences
        return wd if days == "workdays" else not wd

    def _block_temp(self, p: dict[str, Any], b: dict[str, Any]) -> float:
        return float(b["temp"]) if b["level"] == "custom" else float(p["temps"][b["level"]])

    def block_now(self, p: dict[str, Any], now: datetime) -> dict[str, Any] | None:
        m = now.hour * 60 + now.minute
        for b in p["blocks"]:
            a, z = _hm(b["from"]), _hm(b["to"])
            if a is None or z is None:
                continue
            if a <= z:
                if a <= m < z and self._day_ok(b["days"], now):
                    return b
            elif (m >= a and self._day_ok(b["days"], now)) or (m < z and self._day_ok(b["days"], now - timedelta(days=1))):
                return b
        return None

    def next_block(self, p: dict[str, Any], now: datetime, within: int = 24 * 60) -> tuple[dict[str, Any], datetime] | None:
        """The next block that starts after now (within `within` minutes)."""
        best: tuple[dict[str, Any], datetime] | None = None
        for b in p["blocks"]:
            a = _hm(b["from"])
            if a is None:
                continue
            for d in (0, 1):
                day = (now + timedelta(days=d)).replace(hour=a // 60, minute=a % 60, second=0, microsecond=0)
                if day <= now or (day - now).total_seconds() > within * 60 or not self._day_ok(b["days"], day):
                    continue
                if best is None or day < best[1]:
                    best = (b, day)
        return best

    def _next_change(self, p: dict[str, Any]) -> str | None:
        now = dt_util.now()
        b = self.block_now(p, now)
        if b:
            return b["to"]
        nb = self.next_block(p, now)
        return nb[0]["from"] if nb else None

    def rate(self, rid: str) -> float:
        ph = self.room(rid)["preheat"]
        if not ph.get("learn", True):
            return float(ph.get("rate") or 1.5)
        # the learned room model knows the rate at today's outside temperature (once it has enough samples)
        mr = self.smart.model_rate(rid, self.room_temp(rid, self.room(rid))[0], self.outside())
        if mr is not None:
            return mr
        r = (self.core.data.get("runtime", {}).get("heat_rate") or {}).get(rid) or {}
        if r.get("rate"):
            return float(r["rate"])
        # nothing learned yet: what the building type suggests (old building, floor heating: slow)
        cur, tout = self.room_temp(rid, self.room(rid))[0], self.outside()
        return max(0.2, round(self.smart.model(rid).rate(cur if cur is not None else 19.0, tout if tout is not None else 5.0), 2))

    def rate_learned(self, rid: str) -> bool:
        return bool(self.room(rid)["preheat"].get("learn", True) and (self.core.data.get("runtime", {}).get("heat_rate") or {}).get(rid))

    def schedule_target(self, rid: str, p: dict[str, Any], current: float | None, preheat: bool = True) -> dict[str, Any]:
        now = dt_util.now()
        b = self.block_now(p, now)
        base = {"temp": p["temps"]["base"], "level": "base", "why": LABEL["base"], "until": None, "key": "base"}
        if b:
            t = self._block_temp(p, b)
            base = {"temp": t, "level": b["level"], "why": f"{LABEL[b['level']] if b['level'] != 'custom' else deg(t)} {b['from']}–{b['to']}", "until": b["to"], "key": f"b:{b['from']}-{b['to']}-{b['level']}"}
        else:
            nb = self.next_block(p, now)
            if nb:
                base["until"] = nb[0]["from"]
        if preheat and p["preheat"]["on"] and p["preheat"]["max"] > 0:
            # a slow room (floor heating, old building) reacts late: its lag counts, and it may start earlier
            lag = self.smart.model(rid).lag * 60
            cap = max(float(p["preheat"]["max"]), lag + 60) if lag >= 30 else float(p["preheat"]["max"])
            nb = self.next_block(p, now, int(cap))
            if nb:
                nt = self._block_temp(p, nb[0])
                if nt > base["temp"] + 0.4:
                    cur = current if current is not None else base["temp"]
                    lead = min(cap, max(0.0, lag + (nt - cur) / max(0.3, self.rate(rid)) * 60))
                    left = (nb[1] - now).total_seconds() / 60
                    if left <= lead:
                        return {"temp": nt, "level": nb[0]["level"], "why": f"vorheizen, damit es um {nb[0]['from']} warm ist", "until": nb[0]["to"], "key": f"b:{nb[0]['from']}-{nb[0]['to']}-{nb[0]['level']}", "preheat": nb[0]["from"]}
        return base

    def _fmt_rate(self, rid: str) -> str:
        v = f"{self.rate(rid):.1f}".replace(".", ",")
        fixed = not self.room(rid)["preheat"].get("learn", True)
        return f"heizt etwa {v} °C pro Std." + (", fest eingestellt" if fixed else "" if self.rate_learned(rid) else ", geschätzt")

    # ------------------------------------------------------------------ deciding
    def _window(self, rid: str, p: dict[str, Any], rt: dict[str, Any], now: float, current: float | None) -> dict[str, Any]:
        w = p["window"]
        out: dict[str, Any] = {"state": "closed"}
        if not w["on"]:
            return out
        contacts = self.contacts(rid, p)
        opened = [self.hass.states.get(e) for e in contacts]
        opened = [s for s in opened if s and s.state == "on"]
        delay, resume = w["delay"] * 60, w["resume"] * 60
        # airing without contacts: a fast drop of the room temperature
        if w["drop"] and current is not None:
            samples: deque[tuple[float, float]] = rt.setdefault("samples", deque(maxlen=40))
            if not samples or samples[-1][1] != current or now - samples[-1][0] > 60:
                samples.append((now, current))
            recent = [t for ts, t in samples if now - ts <= 300]
            if recent and max(recent) - current >= w["drop_k"] and not rt.get("drop"):
                rt["drop"] = {"since": now, "min": current, "min_at": now}
                rt["win_active"] = True
                rt["win_src"] = "drop"
            if rt.get("drop"):
                d = rt["drop"]
                if current < d["min"] - 0.05:
                    d["min"], d["min_at"] = current, now
                if now - d["min_at"] >= 300 or now - d["since"] > 1800 or current > d["min"] + 0.3:
                    rt.pop("drop", None)
                    rt["closed_at"] = now
        if opened:
            since = min(s.last_changed.timestamp() for s in opened)
            names = ", ".join(self._name(s.entity_id) for s in opened[:2])
            out.update(since=since, names=names)
            if now - since < delay and not rt.get("win_active"):
                out.update(state="waiting", left=delay - (now - since))
                self.schedule(rid, delay - (now - since) + 0.5)
                return out
            if not rt.get("win_active") or rt.get("closed_at") is not None:
                # a new opening (or opened again while the air settles): remember it against flapping
                opens = [t for t in rt.get("win_opens") or [] if now - t < WINDOW_FLAP_MINUTES * 60]
                rt["win_opens"] = [*opens, now][-WINDOW_FLAPS * 2 :]
            rt["win_active"] = True
            rt["win_src"] = "contact"
            rt.pop("closed_at", None)
            out["state"] = "open"
            return out
        if rt.get("drop"):
            out.update(state="open", since=rt["drop"]["since"], names="Temperatursturz (Lüften erkannt)")
            self.schedule(rid, 30)
            return out
        if rt.get("win_active"):
            closed = rt.get("closed_at")
            if closed is None:
                closed = max((s.last_changed.timestamp() for e in contacts if (s := self.hass.states.get(e))), default=now) if rt.get("win_src") == "contact" else now
                rt["closed_at"] = closed
            if len([t for t in rt.get("win_opens") or [] if now - t < WINDOW_FLAP_MINUTES * 60]) >= WINDOW_FLAPS:
                resume = max(resume, WINDOW_FLAP_SETTLE)
                out["flapping"] = True
            if now - closed < resume:
                out.update(state="settling", left=resume - (now - closed), since=closed)
                self.schedule(rid, resume - (now - closed) + 0.5)
                return out
            rt.pop("win_active", None)
            rt.pop("closed_at", None)
            out["state"] = "resumed"
        return out

    def _summer(self, now: float) -> tuple[bool, str]:
        s = self.cfg["summer"]
        g = self._g
        if not s["on"]:
            g["summer"] = False
            return False, ""
        out = self.outside()
        if out is None:
            return bool(g["summer"]), "kein Außenfühler"
        hold = s["hold"] * 60
        if not g["summer"]:
            g.pop("cold_since", None)
            if out >= s["above"]:
                g.setdefault("warm_since", now)
                if now - g["warm_since"] >= hold:
                    g["summer"] = True
                    g.pop("warm_since", None)
                    self.core.history.add("rule", "Heizung: Sommerbetrieb", f"Draußen {deg(out)}, wärmer als {deg(s['above'])}: Heizungen aus.", logbook=True)
            else:
                g.pop("warm_since", None)
        else:
            g.pop("warm_since", None)
            if out < s["above"] - 1:
                g.setdefault("cold_since", now)
                if now - g["cold_since"] >= hold:
                    g["summer"] = False
                    g.pop("cold_since", None)
                    self.core.history.add("rule", "Heizung: Heizbetrieb", f"Draußen {deg(out)}, kälter als {deg(s['above'] - 1)}: es wird wieder geheizt.", logbook=True)
            else:
                g.pop("cold_since", None)
        return bool(g["summer"]), f"draußen {deg(out)}"

    def decide(self, rid: str) -> dict[str, Any]:
        """What the room wants right now; a smart room in shadow mode also notes what it would do ("would")."""
        d = self._decide(rid)
        p = self.room(rid)
        rt = self._rt.setdefault(rid, {})
        if p["on"] and self.smart.phase(p) == "shadow" and d["mode"] != "hands_off":
            if d["mode"] == "heat" and d["level"] not in ("window", "exercise", "frost", "summer", "manual"):
                res = {k: d.get(k) for k in ("current", "current_src", "window")}
                try:
                    rt["would"] = self.smart.decide(rid, p, rt, res, d.get("plan") or {}, shadow=True)
                except Exception as err:  # noqa: BLE001 — the shadow must never disturb the real control
                    _LOGGER.debug("Schattenbetrieb %s: %s", rid, err)
                    rt.pop("would", None)
            else:
                rt["would"] = {"temp": d.get("temp"), "level": d["level"], "why": f"wie jetzt ({d['why']})"}
        else:
            rt.pop("would", None)
        return d

    def _decide(self, rid: str) -> dict[str, Any]:  # noqa: C901 — the one place that decides a room's target
        """What the room wants right now: {mode heat|off|hands_off, temp, level, why, until, …} and the window state."""
        p = self.room(rid)
        rt = self._rt.setdefault(rid, {})
        now = time.time()
        current, src = self.room_temp(rid, p)
        therms = self.thermostats(rid, p)
        res: dict[str, Any] = {"current": current, "current_src": src, "window": {"state": "closed"}}

        def want(mode: str, temp: float | None, level: str, why: str, until: str | None = None, **kw: Any) -> dict[str, Any]:
            return {**res, "mode": mode, "temp": temp, "level": level, "why": why, "until": until, **kw}

        if not self.enabled():
            return want("hands_off", None, "off", "Funktion Heizung ist ausgeschaltet")
        if not p["on"]:
            return want("hands_off", None, "off", "Heizplan aus")
        if not therms:
            return want("hands_off", None, "off", "kein Thermostat")
        mode = self.core.mode
        plan = self.schedule_target(rid, p, current)
        rt["plan_key"] = f"{mode}:{plan['key']}"
        # exercise
        ex = self._g.get("exercise_until")
        if ex and now < ex:
            return want("heat", 30.0, "exercise", "Ventilschutz: Ventile einmal ganz auf", None, exercise=True)
        win = self._window(rid, p, rt, now, current)
        res["window"] = win
        manual = rt.get("manual")
        # held by hand?
        if manual:
            keep = True
            occupied = self.core.room_tracker.occupied(rid)
            if p["manual"] == "next_block" and manual["key"] and manual["key"] != rt["plan_key"]:
                keep = False
            elif p["manual"] == "hours" and now - manual["at"] >= p["manual_hours"] * 3600:
                keep = False
            elif p["manual"] == "hours":
                self.schedule(rid, p["manual_hours"] * 3600 - (now - manual["at"]) + 0.5)
            elif p["manual"] == "room_empty":
                room = self.core.rooms.get(rid) or {}
                senses = bool(room.get("presence") or room.get("motion") or room.get("door_logic"))
                if not occupied and senses and now - self.core.room_tracker.changed_at(rid) > 60:
                    keep = False
            elif p["manual"] == "never":
                keep = False
            ended = None
            if p["manual"] == "smart" and keep:
                ended = self._manual_end(rid, p, manual, now)
                keep = ended is None
            if not keep:
                self._drop_manual(rid)
                manual = None
                self.core.history.add("rule", f"Heizung {self.core.rooms.get(rid, {}).get('name', rid)}: zurück zum Plan", ended or "Die Änderung von Hand gilt nicht mehr.")
        manual_after_window = bool(manual and win.get("since") and manual["at"] > win["since"])
        if manual and not manual_after_window and win["state"] in ("open", "settling") and not manual.get("win"):
            # the window wins for now; afterwards the value set by hand comes back (an airing is no new situation)
            manual["win"] = True
            self._set_manual(rid, manual)
        if any(self.own_window_open(e) for e in therms) and not manual_after_window:
            return want("hands_off", None, "window", "das Thermostat hat selbst ein offenes Fenster erkannt", None, own_window=True)
        if win["state"] in ("open", "settling") and not manual_after_window:
            off = p["window"]["action"] == "off"
            names = win.get("names") or "Fenster"
            if win["state"] == "open":
                why = f"{names} offen seit {dur(now - win['since'])}"
            else:
                why = f"Fenster zu, die Luft beruhigt sich noch {dur(win['left'])}"
            return want("off" if off else "heat", None if off else p["temps"]["frost"], "window", why, None, plan=plan)
        summer, stext = self._summer(now)
        if summer:
            return want("off", None, "summer", f"Sommer ({stext})", None, plan=plan)
        if mode == "vacation":
            return want("heat", p["temps"]["frost"], "frost", "Urlaub", None, plan=plan)
        if manual:
            until = {"next_block": self._next_change(p), "hours": dt_util.as_local(dt_util.utc_from_timestamp(manual["at"] + p["manual_hours"] * 3600)).strftime("%H:%M"), "room_empty": "Raum leer"}.get(p["manual"])
            if p["manual"] == "smart":
                until = self._manual_until(p, manual)
            why = f"von Hand {'aus' if manual['off'] else deg(manual['temp'])}"
            if manual.get("win"):
                if (manual["temp"] is None and not manual["off"]) or self._manual_restored(rid, p, manual):
                    manual.pop("win", None)
                    self._set_manual(rid, manual)
                else:
                    # after the window: put the value set by hand back once (as it was set, no correction)
                    return want("off" if manual["off"] else "heat", manual["temp"], "manual", why, until, plan=plan, raw=True)
            return want("hands_off", manual["temp"], "manual", why, until, plan=plan)
        if self.smart.active(p):
            return self.smart.decide(rid, p, rt, res, plan)
        inv = self.core.inventory
        pr = p["presence"]
        if pr["away"]:
            away_mode = mode == "away"
            nobody = bool(inv.persons) and not any(inv.person_home(pid) for pid in inv.persons)
            if nobody:
                rt.setdefault("away_since", max((self._person_since(pid) for pid in inv.persons), default=now))
            else:
                rt.pop("away_since", None)
            away_long = nobody and now - rt.get("away_since", now) >= pr["away_after"] * 60
            if nobody and not away_long:
                self.schedule(rid, pr["away_after"] * 60 - (now - rt["away_since"]) + 1)
            if away_mode or away_long:
                coming = pr["home_soon"] and self.core.checker.holds({"subject": "person:someone", "verb": "coming_home"})[0]
                if coming:
                    return want("heat", plan["temp"], plan["level"], "jemand ist auf dem Heimweg", plan["until"], plan=plan)
                return want("heat", min(p["temps"]["eco"], plan["temp"]), "eco", "Hausmodus Weg" if away_mode else f"alle weg seit {dur(now - rt['away_since'])}", None, plan=plan)
        if mode == "sleep" and p["sleep"]:
            return want("heat", p["temps"]["night"], "night", "Hausmodus Schlafen", None, plan=plan)
        if mode == "guests" and p["guests"]:
            t = max(plan["temp"], p["temps"]["comfort"])
            return want("heat", t, "comfort", "Gäste da", None, plan=plan)
        if pr["empty"]:
            room = self.core.rooms.get(rid) or {}
            senses = bool(room.get("presence") or room.get("motion") or room.get("door_logic"))
            if senses and not self.core.room_tracker.occupied(rid):
                empty_for = now - self.core.room_tracker.changed_at(rid)
                if empty_for >= pr["empty_after"] * 60 and plan["temp"] > p["temps"]["eco"]:
                    return want("heat", p["temps"]["eco"], "eco", f"Raum seit {dur(empty_for)} leer", None, plan=plan)
                if empty_for < pr["empty_after"] * 60:
                    self.schedule(rid, pr["empty_after"] * 60 - empty_for + 1)
        return want("heat", plan["temp"], plan["level"], plan["why"], plan["until"], plan=plan, preheat=plan.get("preheat"))

    def _person_since(self, pid: str) -> float:
        p = self.core.inventory.persons.get(pid)
        st = self.hass.states.get(p["entity_id"]) if p else None
        return st.last_changed.timestamp() if st else time.time()

    def target(self, rid: str, preheat: bool = False) -> dict[str, Any]:
        """For rules ("Heizung nach Plan"): the temperature the room's plan wants now."""
        p = self.room(rid)
        if self.core.mode == "vacation":
            return {"temp": p["temps"]["frost"], "why": "Urlaub"}
        current, _src = self.room_temp(rid, p)
        plan = self.schedule_target(rid, p, current)
        if preheat:
            return {"temp": plan["temp"], "why": plan["why"]}
        d = self.decide(rid) if p["on"] else {"temp": plan["temp"], "why": plan["why"], "mode": "heat"}
        return {"temp": d.get("temp") if d.get("temp") is not None else plan["temp"], "why": d.get("why", plan["why"])}

    # ------------------------------------------------------------------ applying
    async def evaluate(self, rid: str) -> None:
        p = self.room(rid)
        rt = self._rt.setdefault(rid, {})
        d = self.decide(rid)
        changes: list[tuple[str, str, Any]] = []
        therms = self.thermostats(rid, p)
        now = time.time()
        unreachable = [e for e in therms if (st := self.hass.states.get(e)) is None or st.state in BAD]
        if d["mode"] != "hands_off":
            gap = self.cfg["gap"] * 60
            for e in therms:
                if e in unreachable:
                    continue
                st = self.hass.states.get(e)
                assert st is not None
                c = self._command(rid, p, rt, e, st, d, now, gap)
                if c:
                    changes += c
        if changes:
            await self._apply(rid, changes, d)
        if p["on"]:
            # direct valve control: a window shuts the valves at once, after it they follow the controller again
            self.smart.react(rid, p, d)
        if d.get("smart") and d["smart"].get("phase") == "active":
            self.smart.log_decision(rid, d)
        if p["preheat"].get("learn", True):
            self._learn(rid, p, rt, d, now)
        self._calibrate_offsets(rid, p, rt, now)
        vent = await self._vent(rid, p, rt, d, now)
        self._hints(rid, p, rt, d, now)
        status = self._status(rid, p, rt, d, unreachable, vent)
        old = rt.get("status")
        rt["status"] = status
        if old != status:
            for cb in list(self._listeners):
                cb(rid)
            if not old or {k: v for k, v in old.items() if k not in ("current", "line", "thermostats")} != {k: v for k, v in status.items() if k not in ("current", "line", "thermostats")} or old.get("line") != status["line"]:
                self.core.push("plans")

    def _step(self, st: State) -> float:
        return float(st.attributes.get("target_temp_step") or 0.5)

    def _correction(self, rid: str, p: dict[str, Any], rt: dict[str, Any], e: str, st: State) -> float:
        """Target correction for a thermostat whose own reading differs from the room thermometer (when it has no offset)."""
        if not p["sensor"] or p["calibrate"] in ("off", "offset"):
            return 0.0
        if p["calibrate"] == "auto" and self.found(rid)["calibration"].get(e):
            return 0.0
        room_t, src = self.room_temp(rid, p)
        own = self.ctemp(st, "current_temperature")
        corr = rt.setdefault("corr", {})
        if room_t is None or own is None or src != "sensor":
            return float(corr.get(e, 0.0))
        raw = max(-3.0, min(3.0, own - room_t))
        old = float(corr.get(e, 0.0))
        if abs(raw - old) >= 0.5:  # hysteresis: only clear changes move the correction
            corr[e] = round(raw * 2) / 2
        return float(corr.get(e, 0.0))

    def _command(self, rid: str, p: dict[str, Any], rt: dict[str, Any], e: str, st: State, d: dict[str, Any], now: float, gap: float) -> list[tuple[str, str, Any]]:
        modes = st.attributes.get("hvac_modes") or []
        sent = rt.setdefault("sent", {}).get(e)
        recent = bool(sent and now - sent["t"] < 2)
        if d["mode"] == "off":
            if "off" in modes:
                if st.state == "off":
                    return []
                if recent:
                    self.schedule(rid, 2 - (now - sent["t"]) + 0.2)
                    return []
                return [(e, "mode", "off")]
            t = float(st.attributes.get("min_temp") or 5)
            cur = fval(st, "temperature")
            if cur is not None and abs(cur - t) < 0.05:
                return []
            return [(e, "temp", t)]
        want = float(d["temp"]) + (0.0 if d.get("raw") else self._correction(rid, p, rt, e, st))
        out: list[tuple[str, str, Any]] = []
        heat = "heat" if "heat" in modes else next((m for m in modes if m not in ("off", "auto", "cool", "dry", "fan_only")), None)
        need_mode = bool(heat and st.state != heat and st.state in ("off", "auto", "heat_cool") )
        if "temperature" not in st.attributes and st.attributes.get("preset_modes"):
            # a thermostat that only knows presets (comfort / eco / away …): the nearest preset
            preset = self._preset(p, st, want, d["level"])
            if not preset or (st.attributes.get("preset_mode") == preset and not need_mode):
                return []
            if recent:
                self.schedule(rid, 2 - (now - sent["t"]) + 0.2)
                return []
            return ([(e, "mode", heat)] if need_mode else []) + [(e, "preset", preset)]
        if self.fahrenheit():
            want = want * 9 / 5 + 32
        step = self._step(st)
        want = round(want / step) * step
        want = max(float(st.attributes.get("min_temp") or 5), min(float(st.attributes.get("max_temp") or 30), want))
        cur = fval(st, "temperature")
        diff = abs(cur - want) if cur is not None else 99.0
        if diff < 0.05 and not need_mode:
            return []
        if recent:
            self.schedule(rid, 2 - (now - sent["t"]) + 0.2)
            return []
        small = diff < (1.8 if self.fahrenheit() else 1.0) and not need_mode
        if small and sent and now - sent["t"] < gap:
            self.schedule(rid, gap - (now - sent["t"]) + 0.5)
            return []
        if need_mode:
            out.append((e, "mode", heat))
        out.append((e, "temp", want))
        return out

    @staticmethod
    def _preset(p: dict[str, Any], st: State, want: float, level: str) -> str | None:
        presets = [str(x) for x in st.attributes.get("preset_modes") or []]
        low = {x.lower(): x for x in presets}

        def first(*names: str) -> str | None:
            return next((low[n] for n in names if n in low), None)

        t = p["temps"]
        if level == "exercise":
            return first("boost", "comfort", "home")
        if want >= t["comfort"] - 0.5:
            return first("comfort", "home", "manual", "heat", "none")
        if want <= t["frost"] + 0.5:
            return first("frost", "frost_protection", "away", "eco")
        if level == "night":
            return first("sleep", "night", "eco", "away")
        return first("eco", "away", "sleep")

    async def _apply(self, rid: str, changes: list[tuple[str, str, Any]], d: dict[str, Any]) -> None:
        ctx = self.core.history.new_context(f"heat_{rid}")
        self._ours[ctx.id] = time.time()
        for k, t in list(self._ours.items()):
            if time.time() - t > 3600:
                self._ours.pop(k, None)
        rt = self._rt.setdefault(rid, {})
        sent = rt.setdefault("sent", {})
        name = self.core.rooms.get(rid, {}).get("name", rid)
        texts: list[str] = []
        for e, what, val in changes:
            try:
                if what == "preset":
                    await self.hass.services.async_call("climate", "set_preset_mode", {ATTR_ENTITY_ID: e, "preset_mode": val}, blocking=True, context=ctx)
                    sent[e] = {"t": time.time(), "mode": (sent.get(e) or {}).get("mode"), "temp": None, "preset": val}
                    texts.append(f"{self._name(e)} {val}")
                elif what == "mode":
                    await self.hass.services.async_call("climate", "set_hvac_mode", {ATTR_ENTITY_ID: e, "hvac_mode": val}, blocking=True, context=ctx)
                    sent[e] = {"t": time.time(), "mode": val, "temp": (sent.get(e) or {}).get("temp")}
                    if val == "off":
                        texts.append(f"{self._name(e)} aus")
                else:
                    await self.hass.services.async_call("climate", "set_temperature", {ATTR_ENTITY_ID: e, "temperature": val}, blocking=True, context=ctx)
                    sent[e] = {"t": time.time(), "temp": val, "mode": (sent.get(e) or {}).get("mode")}
                    texts.append(f"{self._name(e)} {deg((val - 32) * 5 / 9 if self.fahrenheit() else val)}")
            except Exception as err:  # noqa: BLE001 — one thermostat must not stop the others
                _LOGGER.warning("Heizung %s: %s", e, err)
        if texts:
            if len({e for e, _w, _v in changes}) == 1 and len(self.thermostats(rid, self.room(rid))) == 1:
                texts = [t.replace(f"{self._name(changes[0][0])} ", "", 1) for t in texts]
            self.core.history.add("rule", f"Heizung {name}: " + ", ".join(texts)[:200], f"{d['why'][:1].upper()}{d['why'][1:]}.", entity_id=changes[0][0], logbook=True, context=ctx)

    def _calibrate_offsets(self, rid: str, p: dict[str, Any], rt: dict[str, Any], now: float) -> None:
        """Own room thermometer + a thermostat with a calibration number: move the offset (at most every 30 min)."""
        if not p["on"] or not p["sensor"] or p["calibrate"] not in ("auto", "offset") or not self.enabled():
            return
        room_t, src = self.room_temp(rid, p)
        if room_t is None or src != "sensor":
            return
        last = rt.setdefault("calib_at", {})
        for e in self.thermostats(rid, p):
            num = self.found(rid)["calibration"].get(e)
            st, ns = self.hass.states.get(e), self.hass.states.get(num) if num else None
            if not num or not st or not ns or now - last.get(e, 0) < 1800:
                continue
            own, off = fval(st, "current_temperature"), fval(ns)
            if own is None or off is None or abs(room_t - own) < 0.5:
                continue
            step = float(ns.attributes.get("step") or 0.1)
            new = round((off + room_t - own) / step) * step
            new = max(float(ns.attributes.get("min", -10)), min(float(ns.attributes.get("max", 10)), new))
            if abs(new - off) < step / 2:
                continue
            last[e] = now
            ctx = self.core.history.new_context(f"heat_{rid}")
            self.hass.async_create_task(self.hass.services.async_call("number", "set_value", {ATTR_ENTITY_ID: num, "value": round(new, 2)}, blocking=False, context=ctx))
            self.core.history.add("rule", f"Heizung {self.core.rooms.get(rid, {}).get('name', rid)}: {self._name(e)} abgeglichen", f"Das Thermostat misst {deg(own)}, der Raum {deg(room_t)}: Ausgleich jetzt {str(round(new, 1)).replace('.', ',')} °C.", entity_id=e)

    def _learn(self, rid: str, p: dict[str, Any], rt: dict[str, Any], d: dict[str, Any], now: float) -> None:
        """Learn how fast the room warms up (°C per hour) whenever the target jumps up by at least 1 °C."""
        cur, temp = d.get("current"), d.get("temp")
        lr = rt.get("learn")
        if d["mode"] != "heat" or cur is None or temp is None or d["level"] in ("window", "exercise"):
            rt.pop("learn", None)
            rt["last_target"] = None
            return
        last = rt.get("last_target")
        if last is not None and temp - last >= 1.0 and cur < temp - 0.5:
            rt["learn"] = {"t": now, "temp": cur, "target": temp}
        elif lr:
            if abs(lr["target"] - temp) > 0.4 or now - lr["t"] > 6 * 3600:
                rt.pop("learn", None)
            elif cur >= lr["target"] - 0.3 and now - lr["t"] >= 600:
                r = (cur - lr["temp"]) / ((now - lr["t"]) / 3600)
                if 0.2 <= r <= 10:
                    store = self.core.data.setdefault("runtime", {}).setdefault("heat_rate", {})
                    old = store.get(rid) or {}
                    n = int(old.get("n", 0))
                    store[rid] = {"rate": round(r if not n else 0.7 * float(old["rate"]) + 0.3 * r, 2), "n": n + 1}
                    self.core.save()
                rt.pop("learn", None)
        rt["last_target"] = temp

    def _hints(self, rid: str, p: dict[str, Any], rt: dict[str, Any], d: dict[str, Any], now: float) -> None:
        """Valves that never open although it is too cold, or stay wide open without the room getting warmer."""
        hints: list[str] = []
        track = rt.setdefault("valve_track", {})
        if p["on"] and p["valves"]["stuck"] and d["mode"] == "heat" and d["level"] not in ("window", "exercise"):
            for e in self.thermostats(rid, p):
                st = self.hass.states.get(e)
                v = self.valve(e)
                own = self.ctemp(st, "current_temperature")
                tgt = self.ctemp(st, "temperature")
                if v is None or own is None or tgt is None:
                    track.pop(e, None)
                    continue
                t = track.setdefault(e, {})
                if tgt - own >= 1.5 and v <= 1:
                    t.setdefault("closed", now)
                    if now - t["closed"] >= 2 * 3600:
                        hints.append(f"{self._name(e)}: Ventil öffnet nicht, obwohl es {deg(tgt - own)} zu kalt ist. Ventil festgesetzt? Ventilschutz hilft oft.")
                else:
                    t.pop("closed", None)
                if v >= 80:
                    if "open" not in t:
                        t["open"], t["open_temp"] = now, own
                    if now - t["open"] >= 3 * 3600 and own - t["open_temp"] < 0.5:
                        hints.append(f"{self._name(e)}: Ventil seit Stunden offen, aber der Raum wird nicht wärmer. Heizkörper kalt (Vorlauf aus, Luft im Heizkörper)?")
                else:
                    t.pop("open", None)
                    t.pop("open_temp", None)
        for h in hints:
            if h not in (rt.get("hints") or []):
                self.core.history.add("rule", f"Heizung {self.core.rooms.get(rid, {}).get('name', rid)}: bitte prüfen", h, logbook=True)
        rt["hints"] = hints

    # ------------------------------------------------------------------ ventilation
    def _quiet(self) -> bool:
        q = self.cfg["quiet"]
        if not q["on"]:
            return False
        a, z = _hm(q["from"]) or 0, _hm(q["to"]) or 0
        now = dt_util.now()
        m = now.hour * 60 + now.minute
        return a <= m < z if a <= z else (m >= a or m < z)

    def heating_season(self, now: float) -> bool:
        if self._g.get("summer"):
            return False
        out = self.outside()
        if out is not None:
            return out < 16
        return dt_util.now().month in (10, 11, 12, 1, 2, 3, 4)

    def _occasion(self, vr: dict[str, Any], reason: str, active: bool, release: bool, now: float) -> float | None:
        """An occasion of a reminder reason (humidity over the limit, CO₂, mould risk): since when it holds, or None.
        `release` = clearly below again (with some margin), only then a new occasion can start. An occasion that only
        exists because of a change of settings (a lower limit, reminders switched on while the value is already
        over it) is silent: it shows, but does not remind. A value that rises later reminds as usual."""
        key = f"{reason}_since"
        ok_seen = vr.setdefault("ok_seen", {})
        if active:
            if key not in vr:
                vr[key] = now
                if now - self._settings_at < SETTINGS_SILENCE and ok_seen.get(reason, 0) < self._settings_at:
                    vr.setdefault("silent", {})[reason] = vr[key]
            return float(vr[key])
        ok_seen[reason] = now
        if release:
            vr.pop(key, None)
            vr.get("silent", {}).pop(reason, None)
        return None

    async def _vent(self, rid: str, p: dict[str, Any], rt: dict[str, Any], d: dict[str, Any], now: float) -> dict[str, Any]:  # noqa: C901
        v = p["vent"]
        vr = rt.setdefault("vent", {"notified": {}, "times_done": {}})
        vr.setdefault("notified", {})
        vr.setdefault("times_done", {})
        out_t = self.outside()
        minutes = vent_minutes(out_t, dt_util.now().month)
        hum_e, co2_e = self._vent_sensor(rid, p, "humidity"), self._vent_sensor(rid, p, "co2")
        hum = fval(self.hass.states.get(hum_e)) if hum_e else None
        co2 = fval(self.hass.states.get(co2_e)) if co2_e else None
        room_t = d.get("current")
        res: dict[str, Any] = {"state": "ok", "reason": "", "minutes": minutes, "humidity": hum, "co2": co2, "outside": out_t, "mould": None}
        if not v["on"] or not self.enabled():
            res["state"] = "off"
            return res
        contacts = self.contacts(rid, p)
        open_states = [s for e in contacts if (s := self.hass.states.get(e)) and s.state == "on"]
        open_since = min((s.last_changed.timestamp() for s in open_states), default=None)
        if open_since and now - open_since >= 120:
            vr["aired_at"] = now
        # (kind, text, occasion key)
        reasons: list[tuple[str, str, str]] = []
        hold = v["wait"] * 60
        if v["humidity_on"] and hum is not None:
            since = self._occasion(vr, "humidity", hum >= v["humidity"], hum < v["humidity"] - 5, now)
            if since is not None:
                if now - since >= hold:
                    reasons.append(("humidity", f"Luftfeuchte {hum:.0f}\u00a0%", f"humidity:{since:.0f}"))
                else:
                    self.schedule(rid, hold - (now - since) + 0.5)
        if v["co2_on"] and co2 is not None:
            since = self._occasion(vr, "co2", co2 >= v["co2"], co2 < v["co2"] - 150, now)
            if since is not None:
                if now - since >= hold:
                    reasons.append(("co2", f"CO₂ {co2:.0f}\u00a0ppm", f"co2:{since:.0f}"))
                else:
                    self.schedule(rid, hold - (now - since) + 0.5)
        m_rh = mould_rh(room_t, hum, out_t)
        res["mould"] = round(m_rh) if m_rh is not None else None
        if v["mould"] and m_rh is not None:
            since = self._occasion(vr, "mould", m_rh >= 80, m_rh < 75, now)
            if since is not None:
                reasons.append(("mould", f"Schimmelgefahr an kalten Wänden ({m_rh:.0f}\u00a0%)", f"mould:{since:.0f}"))
        today = dt_util.now().date().isoformat()
        nowl = dt_util.now()
        mnow = nowl.hour * 60 + nowl.minute
        for t in v["times"]:
            a = _hm(t)
            if a is None or not (a <= mnow < a + 60):
                continue
            key = f"{today} {t}"
            start_ts = nowl.replace(hour=a // 60, minute=a % 60, second=0, microsecond=0).timestamp()
            if (vr.get("aired_at") or 0) >= start_ts - 3600:
                vr["times_done"][key] = True
            if not vr["times_done"].get(key):
                reasons.append(("time", f"Lüftungsplan {t}", f"time:{key}"))
        vr["times_done"] = {k: x for k, x in vr["times_done"].items() if k.startswith(today)}
        name = self.core.rooms.get(rid, {}).get("name", rid)
        close_after = (v["close_after"] or (minutes + 5)) * 60
        if open_since:
            if v["close"] and self.heating_season(now) and p["on"] and now - open_since >= close_after:
                res.update(state="close_window", reason=f"Fenster seit {dur(now - open_since)} offen")
                msg = f"{name}: Fenster seit {dur(now - open_since)} offen" + (f", draußen {deg(out_t)}" if out_t is not None else "") + ". Bitte wieder schließen."
                await self._remind(rid, "close_window", msg, minutes, f"open:{open_since:.0f}")
            else:
                res.update(state="airing", reason=f"wird gelüftet (seit {dur(now - open_since)}, empfohlen {minutes} Min.)")
                if v["close"] and p["on"] and self.heating_season(now):
                    self.schedule(rid, close_after - (now - open_since) + 1)
            return res
        if reasons:
            res.update(state="ventilate", reason=" · ".join(t for _k, t, _o in reasons))
            msg = f"{name}: bitte lüften – {res['reason']}. Stoßlüften etwa {minutes} Min." + (f" (draußen {deg(out_t)})" if out_t is not None else "") + "."
            # silent: every reason of now began with a change of settings or the start-up (nothing new for a person)
            kinds = [k for k, _t, _o in reasons]
            silent = "time" not in kinds and all(k in vr.get("silent", {}) for k in kinds)
            await self._remind(rid, reasons[0][0], msg, minutes, "|".join(o for _k, _t, o in reasons), silent=silent)
        return res

    async def _remind(self, rid: str, reason: str, message: str, minutes: int, key: str, *, silent: bool = False) -> None:
        """A reminder once per occasion: event and history; to the phones of the chosen people at home within the
        limits of notify.py (at most every 2 h per room and person, 3 a day, not in the quiet hours, without sound,
        replacing the room's last reminder). Saving settings never starts a new occasion (see _occasion)."""
        vr = self._rt.setdefault(rid, {}).setdefault("vent", {"notified": {}, "times_done": {}})
        last = vr.setdefault("notified", {}).get(reason)
        if last and last["key"] == key:
            return
        vr["notified"][reason] = {"t": time.time(), "key": key}
        name = self.core.rooms.get(rid, {}).get("name", rid)
        self.hass.bus.async_fire(EVENT_VENTILATE, {"room": rid, "room_name": name, "reason": reason, "message": message, "minutes": minutes})
        self.core.history.add("rule", f"Lüften {name}" if reason != "close_window" else f"Fenster {name}", message + (" (ohne Nachricht: nach einer Änderung der Einstellungen)" if silent else ""), logbook=True)
        if silent or self._quiet():
            return
        inv = self.core.inventory
        persons = [pid for pid in self.cfg["notify"] if inv.persons.get(pid) and inv.person_home(pid)]
        if persons:
            await self.core.notifier.send(
                "vent", rid, "Lüften" if reason != "close_window" else "Fenster offen", message, persons=persons, tag=f"hr_vent_{rid}", data={"group": "house_rules_vent"}
            )

    # ------------------------------------------------------------------ house-wide: demand, exercise
    async def _global(self) -> None:
        if not self.enabled():
            return
        g = self.cfg
        now = time.time()
        self._summer(now)
        # weekly valve exercise
        ex = g["exercise"]
        until = self._g.get("exercise_until")
        if until and now >= until:
            self._g.pop("exercise_until", None)
            self.schedule_all(0.2)
        if ex["on"] and not until:
            nowl = dt_util.now()
            at = _hm(ex["time"]) or 0
            today = nowl.date().isoformat()
            last = self.core.data.get("runtime", {}).get("valve_exercise")
            if nowl.weekday() == ex["weekday"] and at <= nowl.hour * 60 + nowl.minute < at + 120 and last != today and (not g["summer"]["on"] or self._g.get("summer")):
                self.exercise(why=f"wöchentlich ({ex['time']})")
        # heat demand
        d = g["demand"]
        dem = self._g["demand"]
        want, why = self._demand_wanted(d["above"], dem["on"])
        if self._g.get("exercise_until") or self._g.get("summer"):
            want, why = False, "Ventilschutz läuft" if self._g.get("exercise_until") else "Sommer"
        dem["why"] = why
        if want != dem["on"]:
            hold = (d["min_off"] if not dem["on"] else d["min_on"]) * 60
            if now - dem["since"] >= hold or not dem["since"]:
                dem["on"], dem["since"] = want, now
                self.core.history.add("rule", f"Wärmeanforderung {'an' if want else 'aus'}", why)
                for cb in list(self._listeners):
                    cb(None)
                self.core.push("plans")
            else:
                dem["wait"] = hold - (now - dem["since"])
                self.schedule("_global", hold - (now - dem["since"]) + 0.5)
        else:
            dem.pop("wait", None)
        if d["on"] and d["entity"]:
            await self._drive_demand(d["entity"], dem["on"])

    def _demand_wanted(self, above: float, is_on: bool) -> tuple[bool, str]:
        """Any valve open more than X % (off again only below X − 10 %); thermostats without valve info: "heats"."""
        best: tuple[float, str] | None = None
        heating: list[str] = []
        for rid in self._active_rooms():
            p = self.room(rid)
            if not p["on"]:
                continue
            for e in self.thermostats(rid, p):
                st = self.hass.states.get(e)
                if not st or st.state in BAD or st.state == "off":
                    continue
                v = self.valve(e)
                if v is None:
                    if st.attributes.get("hvac_action") == "heating":
                        heating.append(self._name(e))
                    continue
                if best is None or v > best[0]:
                    best = (v, self._name(e))
        limit = above if not is_on else max(0.0, above - 10)
        if best and best[0] > limit:
            return True, f"{best[1]}: Ventil {best[0]:.0f} %"
        if heating:
            return True, f"{heating[0]} heizt"
        return False, "kein Ventil offen" if best else "kein Raum heizt"

    async def _drive_demand(self, entity: str, on: bool) -> None:
        st = self.hass.states.get(entity)
        if not st or st.state in BAD:
            return
        domain = entity.split(".")[0]
        ctx = self.core.history.new_context("heat_demand")
        try:
            if domain == "climate":
                if (st.state != "off") != on:
                    modes = st.attributes.get("hvac_modes") or []
                    await self.hass.services.async_call("climate", "set_hvac_mode", {ATTR_ENTITY_ID: entity, "hvac_mode": ("heat" if "heat" in modes else "auto") if on else "off"}, blocking=True, context=ctx)
            elif (st.state == "on") != on:
                await self.hass.services.async_call(domain, "turn_on" if on else "turn_off", {ATTR_ENTITY_ID: entity}, blocking=True, context=ctx)
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Wärmeanforderung %s: %s", entity, err)

    def exercise(self, why: str = "von Hand gestartet") -> None:
        minutes = self.cfg["exercise"]["minutes"]
        self._g["exercise_until"] = time.time() + minutes * 60
        self.core.data.setdefault("runtime", {})["valve_exercise"] = dt_util.now().date().isoformat()
        self.core.save()
        self.core.history.add("rule", "Heizung: Ventilschutz", f"Alle Ventile {dur(minutes * 60)} ganz auf, damit sie nicht festsitzen ({why}).", logbook=True)
        self.schedule_all(0.1)
        self.schedule("_global", minutes * 60 + 0.5)

    def clear_manual(self, rid: str) -> None:
        if self._drop_manual(rid):
            self.core.history.add("rule", f"Heizung {self.core.rooms.get(rid, {}).get('name', rid)}: zurück zum Plan", "Von Hand zurückgesetzt.")
        self.schedule(rid, 0.1)

    @property
    def demand_on(self) -> bool:
        return bool(self._g["demand"]["on"])

    @property
    def demand_why(self) -> str:
        return str(self._g["demand"].get("why", ""))

    @property
    def summer(self) -> bool:
        return bool(self._g.get("summer"))

    # ------------------------------------------------------------------ status for the screens
    def _status(self, rid: str, p: dict[str, Any], rt: dict[str, Any], d: dict[str, Any], unreachable: list[str], vent: dict[str, Any]) -> dict[str, Any]:
        therms = []
        valves: list[float] = []
        heating = False
        for e in self.thermostats(rid, p):
            st = self.hass.states.get(e)
            v = self.valve(e)
            if v is not None:
                valves.append(v)
            act = st.attributes.get("hvac_action") if st else None
            h = (v > 0) if v is not None else act == "heating"
            heating = heating or bool(h and st and st.state != "off")
            num = self.found(rid)["calibration"].get(e)
            therms.append(
                {
                    "entity_id": e,
                    "name": self._name(e),
                    "available": bool(st and st.state not in BAD),
                    "mode": st.state if st else None,
                    "target": self.ctemp(st, "temperature"),
                    "current": self.ctemp(st, "current_temperature"),
                    "valve": v,
                    "valve_source": self.found_valve(e),
                    "action": act,
                    "own_window": self._own_window_source(e) is not None,
                    "calibration": {"entity": num, "value": fval(self.hass.states.get(num))} if num else None,
                    "correction": (rt.get("corr") or {}).get(e, 0.0),
                }
            )
        cur, tgt = d.get("current"), d.get("temp")
        reached = bool(cur is not None and tgt is not None and cur >= tgt - 0.2)
        win = d.get("window") or {"state": "closed"}
        line = self._line(rid, p, d, win, cur, valves, heating, reached, unreachable, vent)
        return {
            "line": line,
            "mode": d["mode"],
            "temp": tgt,
            "level": d["level"],
            "why": d["why"],
            "until": d.get("until"),
            "current": cur,
            "current_src": d.get("current_src"),
            "window": {k: (round(v) if isinstance(v, float) else v) for k, v in win.items()},
            "valve": max(valves) if valves else None,
            "heating": heating,
            "reached": reached,
            "manual": rt.get("manual"),
            "unreachable": unreachable,
            "thermostats": therms,
            "hints": rt.get("hints") or [],
            "vent": vent,
            "rate": self.rate(rid),
            "rate_learned": self.rate_learned(rid),
            "preheat": d.get("preheat"),
            "plan": {k: d["plan"][k] for k in ("temp", "level", "why", "until")} if d.get("plan") else None,
            "smart": self.smart.status(rid, p, d),
        }

    def _line(self, rid: str, p: dict[str, Any], d: dict[str, Any], win: dict[str, Any], cur: float | None, valves: list[float], heating: bool, reached: bool, unreachable: list[str], vent: dict[str, Any]) -> str:
        now = time.time()
        parts: list[str] = []
        lvl, why = d["level"], d["why"]
        if d["mode"] == "hands_off" and lvl == "off":
            parts.append(why[:1].upper() + why[1:])
        elif lvl == "manual":
            parts.append(f"{why[:1].upper()}{why[1:]}" + (f" bis {d['until']}" if d.get("until") and d["until"] != "Raum leer" else " bis der Raum leer ist" if d.get("until") == "Raum leer" else ""))
        elif lvl == "window" and d.get("own_window"):
            parts.append("Thermostat erkennt ein offenes Fenster selbst → lässt es in Ruhe")
        elif lvl == "window":
            act = "Heizung aus" if d["mode"] == "off" else f"Frostschutz {deg(d['temp'])}"
            if win.get("state") == "open":
                parts.append(f"{win.get('names') or 'Fenster'} offen seit {dur(now - win['since'])} → {act}")
            else:
                parts.append(f"Fenster zu → Luft beruhigt sich, Heizung wartet noch {dur(win.get('left', 0))}")
        elif lvl == "summer":
            parts.append(f"{why} → Heizung aus")
        elif lvl == "exercise":
            parts.append(why)
        else:
            label = {"comfort": "Komfort", "eco": "Sparen", "night": "Nacht", "base": "Grundtemperatur", "frost": "Frostschutz", "custom": ""}.get(lvl, "")
            main = f"{deg(d['temp'])} {label}".strip()
            extra = "" if why == (d.get("plan") or {}).get("why") and not d.get("preheat") else why
            if extra.startswith(LABEL.get(lvl, "@")):
                extra = ""
            if d.get("until") and not d.get("preheat"):
                main += f" bis {d['until']}"
            parts.append(main + (f" ({extra})" if extra else ""))
        if win.get("state") == "waiting":
            parts.append(f"{win.get('names') or 'Fenster'} offen seit {dur(now - win['since'])} → wartet noch {dur(win['left'])}")
        if cur is not None:
            parts.append(f"jetzt {deg(cur)}")
        if d["mode"] != "off" and lvl not in ("window", "summer"):
            if valves:
                parts.append(f"Ventil {max(valves):.0f}\u00a0%" + (" · heizt" if heating and not reached else ""))
            elif heating:
                parts.append("heizt")
            elif reached and d["mode"] == "heat":
                parts.append("erreicht")
        if unreachable:
            parts.append(f"{', '.join(self._name(e) for e in unreachable)} nicht erreichbar")
        if vent.get("state") == "ventilate":
            parts.append(f"bitte lüften ({vent['reason']})")
        elif vent.get("state") == "close_window":
            parts.append("Fenster bitte schließen")
        return f"{self.core.rooms.get(rid, {}).get('name', rid)}: " + " · ".join(parts)

    def status(self, rid: str) -> dict[str, Any] | None:
        return self._rt.get(rid, {}).get("status")

    def global_view(self) -> dict[str, Any]:
        g = self.cfg
        dem = self._g["demand"]
        out_e = self.outside_entity()
        return {
            "config": g,
            "enabled": self.enabled(),
            "outside": {"entity": out_e, "name": self._name(out_e), "value": self.outside(), "auto": not g["outside"]},
            "summer": bool(self._g.get("summer")),
            "demand": {"on": dem["on"], "why": dem.get("why", ""), "wait": round(dem["wait"]) if dem.get("wait") else None},
            "exercise_until": self._g.get("exercise_until"),
            "last_exercise": self.core.data.get("runtime", {}).get("valve_exercise"),
            "rooms": {rid: self.found_view(rid) for rid in self.core.rooms if self.core.inventory.in_room("climate", rid) or self.store.get(rid)},
        }

    def found_view(self, rid: str) -> dict[str, Any]:
        f = self.found(rid)
        return {k: f[k] for k in ("thermostats", "sensors", "contacts", "doors", "humidity", "co2")} | {
            "valves": {k: v for k, v in f["valves"].items() if v},
            "calibration": {k: v for k, v in f["calibration"].items() if v},
            "own_window": {k: v for k, v in f["own_window"].items() if v},
        }

    def rooms_view(self) -> dict[str, Any]:
        return {rid: self.room(rid) for rid in self.core.rooms}

    def new_id(self) -> str:
        return uuid.uuid4().hex[:6]
