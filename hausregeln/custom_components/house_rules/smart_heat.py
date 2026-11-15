"""Smart heating ("Intelligent"): a room heats when it is usually used, learned from your habits.

Per room the user chooses "Zeitplan" (the controller in heating.py as before) or "Intelligent". An intelligent
room first runs in shadow mode for N days (default 7): the time plan keeps heating, next to it the room shows
what it would have done ("so hätte ich geheizt"); one button takes over (or 0 days: it acts right away). Then,
instead of the time blocks:

  1. house mode "sleep" → night, house mode "guests" → comfort (as before)
  2. everyone away → set back, but only if it is worth it until you are usually back (or someone is on the
     way home: the location module `core.places` if there is one, else "on the way home" of the rules)
  3. someone in the room right now → comfort
  4. a fixed time (your blocks, e.g. from accepted proposals) → its temperature
  5. learned occupancy (habits.py) at least the style's threshold → comfort
  6. otherwise: the next time the room is usually used; preheat in time with the learned room model
     (heat_model.py: heat-up and cool-down rates by outside temperature and valve opening); until then set
     back – only if the setback really saves something for the length of the pause, else keep comfort
  then the style's ramp and boost, then the guardrails, which always win (never above / below, never heat
  in a time window, at least X with someone in the room, max. setback; house-wide with per-room overrides).

Learning phase: while the room has fewer than heat_model.MIN_DAYS learned days (of today's kind, workday or day
off), steps 5 and 6 are replaced by presence – comfort while someone is at home, the eco temperature once everyone
is away (with "everyone away" on), eco in a hall, the room's eco temperature when it has been empty for long (with
"room empty" on); house mode sleep still gives night. So an intelligent room heats sensibly from the first day and
the learned habits take over day by day.

Heating styles Komfort / Eco / Sportlich change thresholds, preheat margin, setback depth, ramp and valve
opening (heat_model.STYLES); the ramp can also be set by hand.

Direct valve control (optional per room, only for thermostats with writable valve entities, e.g. Sonoff TRVZB
`number.*_valve_opening_degree` / `_valve_closing_degree`): a PI controller per room with gains from the room
model and a learned feed-forward (per outside temperature and door open / closed), active from the first minute
with the building prior; commands only now and then (deadband, minimum interval – battery and radio). A window
open (action "off") closes the valves at once, and they follow the controller again as soon as the window logic
resumes. The room model learns all the time: heating up, cooling down, and the extra loss with a door to the rest
of the home or a window open. Implausible data or unavailable entities → back to normal setpoint control;
switching it off restores the thermostat's own valve behaviour. Read-only demand values (e.g. `pi_heating_demand`)
are only an input.

Also here: the learning signal of manual changes and the heating's own proposals ("Werktags ab 17:15
Wohnzimmer 21,5 °C – übernehmen?", through the suggestions), the "So denkt deine Heizung" view and the
consumption and cost estimate (heat_energy.py). Learned data live in an own store (`house_rules.smart_heat`).
"""

from __future__ import annotations

import logging
import math
import re
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er, label_registry as lr
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from . import heat_model as hm
from .habits import SLOT, SLOTS, Habits, slot_of
from .heat_energy import HeatEnergy, default_config as energy_default
from .i18n import tr

if TYPE_CHECKING:
    from .core import HouseRules
    from .heating import HeatingController

_LOGGER = logging.getLogger(__name__)

STORE_KEY = "house_rules.smart_heat"
OPEN_NAME = re.compile(r"valve_opening_degree|opening_degree|ventil.?öffnungsgrad|ventil.?oeffnungsgrad", re.I)
CLOSE_NAME = re.compile(r"valve_closing_degree|closing_degree|ventil.?schlie(ß|ss)grad", re.I)
POS_NAME = re.compile(r"valve_position|valve_opening(?!_degree)|ventilposition|ventil_position|ventilöffnung|ventiloeffnung", re.I)
LOG_KEEP = 40
VISITS_KEEP = 60  # learned visits per room for the room kind
HUMID_KEEP = 10  # days with a quick humidity rise per room
ROOM_TYPES = ("auto", "normal", "short", "pass")
SHADOW_KEEP = 7 * 96
LEVEL_LABEL = {"comfort": "Komfort", "setback": "Absenken", "night": "Nacht", "preheat": "Vorheizen", "custom": "feste Zeit", "eco": "Sparen"}


def default_room() -> dict[str, Any]:
    return {
        # schedule = the time plan (as before) | smart = learned
        "mode": "schedule",
        "style": "comfort",
        # own ramp (None = the style's): °C per step, minutes per step
        "ramp": {"step": None, "minutes": None},
        "shadow_days": 7,
        # timestamp: shadow mode since / None = not in shadow mode (active or schedule)
        "shadow_since": None,
        # per-room overrides of the house-wide guardrails (only the keys set)
        "guard": {},
        "valve": {"on": False},
        # radiator power (W, all radiators of the room) and area (m²); None = from the floor plan / estimated
        "radiator_w": None,
        "area": None,
        # building type (heat_model.BUILDINGS): prior for heating up and cooling down until the room model knows enough
        "building": "unknown",
        # version of the heating styles (2 = re-scaled: the old "Eco" is "Komfort" now)
        "sv": hm.STYLE_VERSION,
        # room kind ("Raumart"): auto = detected (SmartHeating.kind_info) | normal | short (bath, WC) | pass (hall)
        "room_type": "auto",
        # "Abends ausklingen": from `from` (None = an hour before the learned bedtime, else 22:00) until the night
        # at most `temp` – the room cools down slowly while people are still up instead of being heated to the end
        "evening": {"on": False, "temp": 20.0, "from": None},
        # "Kurz daheim": when the usual stay in the room is short (at most `hours`, e.g. an hour or two in the evening)
        # it is heated only to `temp` instead of the full comfort temperature
        "short": {"on": False, "temp": 19.5, "hours": 2.0},
    }


def default_global() -> dict[str, Any]:
    return {
        "guard": {"max": 24.0, "min": 15.0, "occupied_min": 18.0, "max_setback": 4.0, "never": {"on": False, "from": "00:00", "to": "05:00"}},
        "energy": energy_default(),
        # airing prior until the window contacts taught the habit: aired in the morning after getting up (None = not
        # asked yet), for how many minutes, in which rooms (empty = all)
        "airing": {"morning": None, "minutes": 10, "rooms": []},
        "setup_done": False,
    }


def _num(v: Any, d: float | None, lo: float, hi: float) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return d
    if math.isnan(x):
        return d
    return max(lo, min(hi, x))


def clean_room(raw: Any, cur: dict[str, Any]) -> dict[str, Any]:
    """Checks the "smart" part of a room's plan."""
    out = {**default_room(), **cur}
    if not isinstance(raw, dict):
        return out
    if raw.get("mode") in ("schedule", "smart"):
        if raw["mode"] == "smart" and out["mode"] != "smart":
            # switched to smart: shadow mode first (unless 0 days)
            days = _num(raw.get("shadow_days", out["shadow_days"]), 7, 0, 60)
            out["shadow_since"] = time.time() if days else None
        if raw["mode"] == "schedule":
            out["shadow_since"] = None
        out["mode"] = raw["mode"]
    if raw.get("style") in hm.STYLES:
        out["style"] = raw["style"]
        out["sv"] = hm.STYLE_VERSION
    if raw.get("building") in hm.BUILDINGS:
        out["building"] = raw["building"]
    if raw.get("room_type") in ROOM_TYPES:
        out["room_type"] = raw["room_type"]
    if isinstance(r := raw.get("ramp"), dict):
        out["ramp"] = {"step": _num(r.get("step"), None, 0, 5) if r.get("step") is not None else None, "minutes": _num(r.get("minutes"), None, 0, 240) if r.get("minutes") is not None else None}
    if "shadow_days" in raw:
        out["shadow_days"] = int(_num(raw["shadow_days"], 7, 0, 60) or 0)
        if out["mode"] == "smart" and not out["shadow_days"]:
            # no observation wanted: the room acts right away (also when it was observing until now)
            out["shadow_since"] = None
    if isinstance(g := raw.get("guard"), dict):
        out["guard"] = clean_guard(g, partial=True)
    if isinstance(v := raw.get("valve"), dict):
        out["valve"] = {"on": bool(v.get("on", out["valve"].get("on")))}
    if isinstance(ev := raw.get("evening"), dict):
        cur_ev = {**default_room()["evening"], **(out.get("evening") or {})}
        frm = ev.get("from", cur_ev["from"])
        out["evening"] = {
            "on": bool(ev.get("on", cur_ev["on"])),
            "temp": _num(ev.get("temp", cur_ev["temp"]), 20.0, 10, 25),
            "from": hm_clean(frm, "22:00") if frm else None,
        }
    if isinstance(sh := raw.get("short"), dict):
        cur_sh = {**default_room()["short"], **(out.get("short") or {})}
        out["short"] = {
            "on": bool(sh.get("on", cur_sh["on"])),
            "temp": _num(sh.get("temp", cur_sh["temp"]), 19.5, 10, 25),
            "hours": _num(sh.get("hours", cur_sh["hours"]), 2.0, 0.5, 4),
        }
    for k, lo, hi in (("radiator_w", 50, 20000), ("area", 1, 500)):
        if k in raw:
            out[k] = _num(raw[k], None, lo, hi) if raw[k] is not None else None
    return out


def clean_guard(g: dict[str, Any], partial: bool = False) -> dict[str, Any]:
    d = default_global()["guard"]
    out: dict[str, Any] = {} if partial else dict(d)
    for k, lo, hi in (("max", 10, 30), ("min", 5, 25), ("occupied_min", 5, 28), ("max_setback", 0, 10)):
        if k in g:
            if g[k] is None and partial:
                continue
            out[k] = _num(g[k], d[k], lo, hi)
    if isinstance(nv := g.get("never"), dict):
        out["never"] = {"on": bool(nv.get("on")), "from": hm_clean(nv.get("from"), "00:00"), "to": hm_clean(nv.get("to"), "05:00")}
    return out


def hm_clean(v: Any, d: str) -> str:
    m = hm.hm(v)
    return f"{m // 60:02d}:{m % 60:02d}" if m is not None else d


def clock(m: int) -> str:
    m %= 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def deg(x: float | None) -> str:
    if x is None:
        return "–"
    r = round(float(x) * 10) / 10
    s = str(int(r)) if r == int(r) else f"{r:.1f}".replace(".", ",")
    return f"{s} °C"


class SmartHeating:
    def __init__(self, hass: HomeAssistant, core: HouseRules, heating: HeatingController) -> None:
        self.hass = hass
        self.core = core
        self.h = heating
        self.habits = Habits(hass, core)
        self.energy = HeatEnergy(self)
        self._store: Store[dict[str, Any]] = Store(hass, 1, STORE_KEY)
        self.d: dict[str, Any] = self._empty()
        self._unsub: list[Callable[[], None]] = []
        self.started = False
        # test helper only (house_rules/heating/test): learning and the valve controller run faster than real time
        self.factor = 1.0
        self._c0 = (time.time(), time.time())
        self._last: float | None = None
        self._samp: dict[str, dict[str, Any]] = {}
        self._valve_rt: dict[str, dict[str, Any]] = {}
        self._writable: dict[str, Any] = {}
        self._writable_at = 0.0
        self._slot_key: str | None = None
        self._sugg: tuple[float, list[dict[str, Any]]] | None = None
        self._areas: dict[str, float] = {}
        self._humid: dict[str, list[tuple[float, float]]] = {}  # humidity sensor → [(time, %)] of the last minutes
        self._kind_gen = 0
        # (what, room, day) → (time, value): day profiles, usage and airing windows (recomputed every 10 min)
        self._cache: dict[tuple[Any, ...], tuple[float, Any]] = {}

    @staticmethod
    def _empty() -> dict[str, Any]:
        # kinds: per room the learned hints for the room kind {visits: [[end, minutes]], at: last visit taken, humid: [days]}
        return {"v": 1, "models": {}, "pi": {}, "log": {}, "guards": {}, "shadow": {}, "energy": {"days": {}, "meter": {}}, "manual": {}, "restore": {}, "kinds": {}}

    async def async_load(self) -> None:
        await self.habits.async_load()
        try:
            raw = await self._store.async_load()
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Intelligente Heizung laden: %s", err)
            raw = None
        if isinstance(raw, dict) and raw.get("v") == 1:
            self.d = {**self._empty(), **raw}

    def save(self) -> None:
        self._store.async_delay_save(lambda: self.d, 30)

    async def async_stop(self) -> None:
        self.stop()
        await self._store.async_save(self.d)
        await self.habits.async_save_now()

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self.started:
            return
        self.started = True
        self.habits.start()
        self._schedule_tick()

    def _schedule_tick(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()
        sec = max(2.0, min(60.0, 60.0 / self.factor))
        self._unsub.append(async_track_time_interval(self.hass, callback(lambda _now: self.tick()), timedelta(seconds=sec)))

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()
        self.habits.stop()
        self.started = False

    def clock(self) -> float:
        """Seconds; runs `factor` times faster than real time (tests only, otherwise = time.time())."""
        return self._c0[1] + (time.time() - self._c0[0]) * self.factor

    def set_factor(self, f: float) -> None:
        self._c0 = (time.time(), self.clock())
        self.factor = max(1.0, min(600.0, float(f)))
        self._last = None
        self._samp.clear()
        if self.started:
            self._schedule_tick()

    # ------------------------------------------------------------------ configuration
    def room_cfg(self, p: dict[str, Any]) -> dict[str, Any]:
        s = p.get("smart") if isinstance(p.get("smart"), dict) else {}
        return {**default_room(), **s}

    def gcfg(self) -> dict[str, Any]:
        raw = self.h.cfg.get("smart") or {}
        d = default_global()
        return {
            "guard": {**d["guard"], **(raw.get("guard") or {})},
            "energy": {**d["energy"], **(raw.get("energy") or {})},
            "airing": {**d["airing"], **(raw.get("airing") or {})},
            "setup_done": bool(raw.get("setup_done", False)),
        }

    def guard(self, p: dict[str, Any]) -> dict[str, Any]:
        g = dict(self.gcfg()["guard"])
        g.update({k: v for k, v in (self.room_cfg(p).get("guard") or {}).items() if v is not None})
        if g["min"] > g["max"]:
            g["min"] = g["max"]
        return g

    def style(self, p: dict[str, Any]) -> dict[str, Any]:
        c = self.room_cfg(p)
        st = dict(hm.style(c["style"]))
        r = c.get("ramp") or {}
        if r.get("step") is not None:
            st["step"] = float(r["step"])
        if r.get("minutes") is not None:
            st["minutes"] = float(r["minutes"])
        return st

    def phase(self, p: dict[str, Any]) -> str:
        """schedule | shadow | active"""
        c = self.room_cfg(p)
        if c["mode"] != "smart":
            return "schedule"
        return "shadow" if c.get("shadow_since") else "active"

    def active(self, p: dict[str, Any]) -> bool:
        return self.phase(p) == "active"

    def model(self, rid: str) -> hm.RoomModel:
        rate = (self.core.data.get("runtime", {}).get("heat_rate") or {}).get(rid) or {}
        prior = hm.building(self.room_cfg(self.h.room(rid)).get("building")) if rid in self.core.rooms else None
        return hm.RoomModel.from_dict(self.d["models"].get(rid), float(rate["rate"]) if rate.get("rate") else None, prior)

    def kind(self, rid: str) -> str:
        """normal | short (bathroom, shower, WC) | pass (hall, stairs): the setting of the room, else detected."""
        return self.kind_info(rid)["kind"]

    def kind_info(self, rid: str) -> dict[str, Any]:
        """The room kind ("Raumart") with its reason: {kind, setting: auto|normal|short|pass, auto (detected),
        source: label|icon|name|devices|humidity|usage|default, detail}. Recomputed at most every 10 minutes and after
        every rebuild of the inventory (an area's name, icon or labels changed in Home Assistant)."""
        gen = id(self.core.inventory.devices)  # a new dict with every rebuild
        if gen != self._kind_gen:
            self._kind_gen = gen
            for k in [k for k in self._cache if k[0] == "kind"]:
                self._cache.pop(k, None)
        return self._cached(("kind", rid), lambda: self._kind_info(rid))

    def _kind_info(self, rid: str) -> dict[str, Any]:
        room = self.core.rooms.get(rid) or {}
        setting = self.room_cfg(self.h.room(rid)).get("room_type", "auto") if rid in self.core.rooms else "auto"
        area = ar.async_get(self.hass).async_get_area(rid)
        labels: list[dict[str, str | None]] = []
        devices: list[str] = []
        if area is not None:
            lab_reg = lr.async_get(self.hass)
            for lid in sorted(area.labels):
                lab = lab_reg.async_get_label(lid)
                if lab is not None:
                    labels.append({"name": lab.name, "icon": lab.icon})
            dev_reg, ent_reg = dr.async_get(self.hass), er.async_get(self.hass)
            devices = [d.name_by_user or d.name or "" for d in dr.async_entries_for_area(dev_reg, rid)]
            devices += [e.entity_id for e in er.async_entries_for_area(ent_reg, rid)]
            devices += [d["name"] for d in self.core.inventory.devices.values() if d.get("room") == rid]  # names as the user sees them
        kd = self._kind_data(rid)
        auto = hm.detect_room_kind(
            room.get("name") or (area.name if area else rid),
            area.icon if area else None,
            labels,
            [d for d in devices if d],
            len(kd.get("humid") or []),
            kd.get("visits") or [],
        )
        return {"kind": setting if setting in hm.KINDS_ORDER else auto["kind"], "setting": setting, "auto": auto["kind"], "source": auto["source"], "detail": auto["detail"]}

    def _kind_data(self, rid: str) -> dict[str, Any]:
        """The learned hints of a room, with the visits since the last look taken from the occupancy log (history.py
        keeps two days; here the last VISITS_KEEP stay). A visit's length is without the room's "empty after" delay."""
        kd = self.d.setdefault("kinds", {}).setdefault(rid, {"visits": [], "at": 0.0, "humid": []})
        delay = float((self.core.rooms.get(rid) or {}).get("empty_after", 5) or 0)
        at = float(kd.get("at") or 0)
        segs = [(a, b) for a, b in self.core.history.occupancy.get(rid, []) if b is not None and b > at and b > a]
        if segs:
            kd["visits"] = ((kd.get("visits") or []) + [[round(b), round(max(0.0, (b - a) / 60 - delay), 1)] for a, b in segs])[-VISITS_KEEP:]
            kd["at"] = max(b for _a, b in segs)
            self.save()
        return kd

    def _learn_humidity(self, now: float) -> None:
        """A quick humidity rise in a room (a shower): remembered once per day, for the room kind."""
        today = dt_util.now().date().isoformat()
        for rid in self.core.rooms:
            if not self.h.room(rid)["on"]:
                continue
            for e in self.h.found(rid).get("humidity") or []:
                st = self.hass.states.get(e)
                try:
                    val = float(st.state) if st else None
                except (TypeError, ValueError):
                    val = None
                if val is None or not 0 <= val <= 100:
                    continue
                samples = [(t, v) for t, v in self._humid.get(e, []) if now - t <= hm.HUMID_MINUTES * 60]
                if hm.humid_rise(samples, now, val):
                    kd = self._kind_data(rid)
                    if today not in kd["humid"]:
                        kd["humid"] = [*kd["humid"], today][-HUMID_KEEP:]
                        self.forget(rid)
                    samples = []  # one rise counts once
                samples.append((now, val))
                self._humid[e] = samples

    def forget(self, rid: str | None) -> None:
        """Drop the cached day profiles and windows (a room's plan or the house-wide settings changed)."""
        if rid is None:
            self._cache.clear()
        else:
            for k in [k for k in self._cache if k[1] == rid]:
                self._cache.pop(k, None)

    def _cached(self, key: tuple[Any, ...], make: Callable[[], Any]) -> Any:
        hit = self._cache.get(key)
        now = time.time()
        if hit and now - hit[0] < 600:
            return hit[1]
        if len(self._cache) > 400:
            self._cache.clear()
        val = make()
        self._cache[key] = (now, val)
        return val

    def model_rate(self, rid: str, temp: float | None, tout: float | None) -> float | None:
        """Heat-up rate (°C/h) of the learned model, only when it knows enough (used by the time plan's preheating)."""
        raw = self.d["models"].get(rid)
        if not raw or int(raw.get("n_h", 0)) < 6 or temp is None or tout is None:
            return None
        return max(0.2, round(self.model(rid).rate(temp, tout), 2))

    def area(self, rid: str) -> float | None:
        p = self.h.room(rid)
        a = self.room_cfg(p).get("area")
        if a:
            return float(a)
        if not self._areas:
            f = getattr(self.core.sim, "_floor", {}) or {}
            self._areas = dict(f.get("areas") or {})
        return self._areas.get(rid)

    # ------------------------------------------------------------------ what the room usually does
    def _home_probs(self, day: date) -> list[float] | None:
        """Probability that anyone of the household is at home, per quarter hour of that day – only once every
        person's profile has enough days (else None: unknown, no cap)."""
        pids = list(self.core.inventory.persons)
        if not pids or any(self.habits.day_days(f"p:{pid}", day) < hm.MIN_DAYS for pid in pids):
            return None
        rows = [self.habits.day_probs(f"p:{pid}", day) for pid in pids]
        return [round(1 - math.prod(1 - r[s] for r in rows), 3) for s in range(SLOTS)]

    def day_probs(self, rid: str, day: date) -> tuple[list[float], list[float] | None]:
        """(room probabilities, home probabilities or None) for the 96 quarter hours. While the room itself has learned
        too little (its default by room name counts), "anyone at home" caps it: nobody home on workdays = not used.
        A room with enough days of its own is trusted – activity there proves someone is home (also people without
        a tracked phone)."""

        def make() -> tuple[list[float], list[float] | None]:
            room = self.habits.day_probs(rid, day)
            home = self._home_probs(day)
            if home is None or self.habits.day_days(rid, day) >= hm.MIN_DAYS:
                return room, home
            return [min(a, b) for a, b in zip(room, home, strict=True)], home

        return self._cached(("probs", rid, day.isoformat()), make)

    def windows(self, rid: str, p: dict[str, Any], day: date) -> list[dict[str, Any]]:
        """Learned comfort windows of a room on that day (minutes of the clock): real occupancy peaks with enough
        days behind them, cut to the kind of room (a bathroom gets short windows before its usual use), checked for
        cost and benefit with the room model's lead time. [{a, z, mean, joined}]"""

        def make() -> list[dict[str, Any]]:
            probs, _home = self.day_probs(rid, day)
            st, g, m = self.style(p), self.guard(p), self.model(rid)
            comfort = float(p["temps"]["comfort"])
            low = max(float(g["min"]), comfort - min(float(st["depth"]), float(g["max_setback"])))
            tout = self.h.outside()
            lead = m.lead(low, comfort, tout if tout is not None else 5.0, st["margin"])
            return [{"a": w["a"] * SLOT, "z": w["z"] * SLOT, "mean": w["mean"], "joined": w["joined"]} for w in hm.use_windows(probs, self.habits.day_days(rid, day), self.kind(rid), lead)]

        return self._cached(("win", rid, day.isoformat()), make)

    def airing(self, rid: str, p: dict[str, Any], day: date) -> list[dict[str, Any]]:
        """Usual airing of a room on that day (minutes of the clock): learned from its window contacts, else the
        prior from the heating assistant ("aired in the morning after getting up"). [{a, z, mean, source}]"""

        def make() -> list[dict[str, Any]]:
            key = f"w:{rid}"
            if key in self.habits.d["prof"]:
                probs = self.habits.day_probs(key, day)
                got = hm.airing_windows(probs, self.habits.day_days(key, day))
                if got:
                    return [{"a": w["a"] * SLOT, "z": w["z"] * SLOT, "mean": w["mean"], "source": "learned"} for w in got]
            a = self.gcfg()["airing"]
            if a.get("morning") and (not a.get("rooms") or rid in a["rooms"]):
                sw = self.habits.sleep_window(day)
                wake = sw[1] if sw else (6 * 60 + 30 if self.habits.workday(day) else 8 * 60)
                start = wake + 10
                return [{"a": start, "z": start + int(a.get("minutes") or 10), "mean": 0.5, "source": "prior"}]
            return []

        return self._cached(("air", rid, day.isoformat()), make)

    def airing_at(self, rid: str, p: dict[str, Any], t: datetime) -> dict[str, Any] | None:
        m = t.hour * 60 + t.minute
        return next((w for w in self.airing(rid, p, t.date()) if w["a"] <= m < w["z"]), None)

    def in_use(self, rid: str, p: dict[str, Any], t: datetime, st: dict[str, Any]) -> tuple[bool, float]:
        """Is the room usually used at t? Bathrooms and halls: only inside a learned window; other rooms: the
        probability (capped by "anyone at home") reaches the style's threshold. (in use, probability)"""
        probs, _home = self.day_probs(rid, t.date())
        prob = probs[slot_of(t)]
        if self.kind(rid) != "normal":
            m = t.hour * 60 + t.minute
            w = next((w for w in self.windows(rid, p, t.date()) if w["a"] <= m < w["z"]), None)
            return (w is not None, w["mean"] if w else prob)
        return (prob >= st["threshold"], prob)

    # ------------------------------------------------------------------ deciding
    def decide(self, rid: str, p: dict[str, Any], rt: dict[str, Any], res: dict[str, Any], plan: dict[str, Any], shadow: bool = False) -> dict[str, Any]:  # noqa: C901 — one place for the smart decision
        """The smart target of a room (after window, summer, vacation and manual have been checked)."""
        now_dt = dt_util.now()
        now = time.time()
        current = res.get("current")
        tout = self.h.outside()
        st = self.style(p)
        g = self.guard(p)
        m = self.model(rid)
        temps = p["temps"]
        comfort = float(temps["comfort"])
        setback = max(float(g["min"]), comfort - min(float(st["depth"]), float(g["max_setback"])))
        room = self.core.rooms.get(rid) or {}
        senses = bool(room.get("presence") or room.get("motion") or room.get("door_logic"))
        occupied = senses and self.core.room_tracker.occupied(rid)
        minute = now_dt.hour * 60 + now_dt.minute
        kind = self.kind(rid)
        chain: list[str] = ["Werktag" if self.habits.workday(now_dt.date()) else "freier Tag"]
        info: dict[str, Any] = {"phase": "shadow" if shadow else "active", "style": self.room_cfg(p)["style"], "confidence": 1.0, "kind": kind}
        mode = self.core.mode
        pr = p["presence"]
        tout_v = tout if tout is not None else 5.0
        learning = self.learning(rid, now_dt)
        # eco while learning: the room's eco temperature, never deeper than "max. absenken" below comfort
        eco = min(comfort, max(float(temps["eco"]), comfort - float(g["max_setback"])))
        # "Abends ausklingen" (not with guests: they get the warm room)
        ev = self.evening(p, now_dt) if mode != "guests" else None
        # "Kurz daheim": the usual stay right now is short, it does not need the full comfort temperature
        short = self.short_stay(rid, p, now_dt, st) if mode != "guests" else None

        def fin(temp: float, level: str, why: str, until: str | None = None, conf: float | None = None, **kw: Any) -> dict[str, Any]:
            t = float(temp)
            c = conf if conf is not None else info["confidence"]
            if st.get("uncertain") and level in ("comfort", "preheat") and c < 0.5 and t > setback:
                # Eco: while the learned habit is still unsure, a bit cooler
                t = max(setback, t - float(st["uncertain"]))
                chain.append(tr(self.core, "heat.c_uncertain", pct=round(c * 100), deg=deg(float(st["uncertain"]))))
            if short is not None and level == "comfort" and t > short[0]:
                t = short[0]
                chain.append(tr(self.core, "heat.c_short_stay", **{"from": short[1], "to": short[2], "deg": deg(short[0])}))
                why = tr(self.core, "heat.w_short_stay", **{"from": short[1], "to": short[2], "deg": deg(short[0])})
            if ev is not None and level in ("comfort", "preheat") and t > ev[0]:
                # "Abends ausklingen": the room only cools down slowly anyway, so it is not heated up to the end
                t = ev[0]
                chain.append(tr(self.core, "heat.c_evening", **{"from": ev[1], "deg": deg(ev[0])}) + (" " + tr(self.core, "heat.c_evening_auto") if ev[2] else ""))
                why = tr(self.core, "heat.w_evening", **{"from": ev[1], "deg": deg(ev[0])})
            elif st.get("boost") and current is not None and current < t - 1 and level in ("comfort", "preheat", "custom"):
                t += float(st["boost"])
                chain.append(f"Sportlich: kurz {deg(t)}, damit es schneller warm wird")
            key = "ramp_s" if shadow else "ramp"
            prev = rt.get(key)
            if prev and st["step"] > 0 and level != "night" and t > float(prev["v"]) + 0.05:
                base = max(float(prev["v"]), min(t, current - 0.5)) if current is not None else float(prev["v"])
                r = hm.ramp(base, prev["t"] if base == prev["v"] else self.clock(), t, self.clock(), st["step"], st["minutes"])
                if r < t:
                    chain.append(f"sanft hoch: {deg(st['step'])} alle {int(st['minutes'])} Min.")
                if r != prev["v"]:
                    rt[key] = {"v": r, "t": self.clock()}
                t = r
            else:
                rt[key] = {"v": t, "t": self.clock()}
            t, prevented = hm.apply_guards(t, g, occupied, minute)
            for x in prevented:
                chain.append(GUARD_TEXT[x["guard"]].format(wanted=deg(x["wanted"]), got=deg(x["got"])))
            info.update(chain=chain, guards=prevented, confidence=round(c, 2), **kw)
            return {**res, "mode": "heat", "temp": round(t, 1), "level": level, "why": why, "until": until, "plan": plan, "smart": info}

        if mode == "sleep" and p["sleep"]:
            chain.append("Hausmodus Schlafen")
            return fin(float(temps["night"]), "night", "Hausmodus Schlafen")
        if mode == "guests" and p["guests"]:
            chain.append("Gäste da")
            return fin(max(comfort, float(plan.get("temp") or comfort)), "comfort", "Gäste da")

        # everyone away
        if pr["away"]:
            inv = self.core.inventory
            nobody = bool(inv.persons) and not any(inv.person_home(pid) for pid in inv.persons)
            if nobody:
                rt.setdefault("away_since", max((self.h._person_since(pid) for pid in inv.persons), default=now))  # noqa: SLF001
            else:
                rt.pop("away_since", None)
            away = mode == "away" or (nobody and now - rt.get("away_since", now) >= pr["away_after"] * 60)
            if away:
                chain.append("Hausmodus Weg" if mode == "away" else "alle weg")
                eta = self._eta(pr)
                lead_h = self._lead(m, current, comfort, tout_v, st, self._gentle(rid, p))
                if eta is not None and eta[0] <= lead_h * 60 + 15:
                    chain.append(eta[1])
                    chain.append(f"Aufheizen dauert etwa {round(lead_h * 60)} Min.")
                    return fin(comfort, "preheat", eta[1], None, eta[2])
                if learning:
                    chain.append(self._learning_text(rid, now_dt))
                    return fin(eco, "eco", tr(self.core, "heat.w_learning_away"), None, self.habits.confidence(rid, now_dt), learning=True)
                return self._until_next(rid, p, m, current, tout_v, st, now_dt, comfort, setback, chain, fin, away=True)
        if occupied:
            # a short visit to the bathroom is no reason to heat it up – a shower or a bath is
            occ_min = (now - self.core.room_tracker.changed_at(rid)) / 60
            near = any(w["a"] - 30 <= minute < w["z"] + 30 for w in self.windows(rid, p, now_dt.date()))
            if kind == "normal" or near or occ_min >= 10:
                chain.append("jemand ist im Raum")
                return fin(comfort, "comfort", "jemand ist im Raum", None, 1.0)
            chain.append(tr(self.core, "heat.c_short_visit"))
        b = self.h.block_now(p, now_dt)
        if b:
            t = self.h._block_temp(p, b)  # noqa: SLF001
            chain.append(f"feste Zeit {b['from']}–{b['to']}")
            return fin(t, "custom" if b["level"] == "custom" else b["level"] if b["level"] != "comfort" else "comfort", f"feste Zeit {b['from']}–{b['to']}", b["to"], 1.0)
        air = self.airing_at(rid, p, now_dt)
        if air and not occupied and (res.get("window") or {}).get("state", "closed") in ("closed", "resumed"):
            # do not heat into the usual airing: keep it low until the windows are usually closed again
            frm, to = clock(air["a"]), clock(air["z"])
            why = tr(self.core, "heat.w_airing_now", **{"from": frm, "to": to})
            chain.append(tr(self.core, "heat.c_airing_learned" if air["source"] == "learned" else "heat.c_airing_prior", **{"from": frm, "to": to}))
            return fin(setback, "airing", why, to, air["mean"], airing={"from": frm, "to": to, "source": air["source"]})
        if learning:
            return self._learning_target(rid, p, rt, now, now_dt, comfort, eco, kind, senses, chain, fin)
        use, prob = self.room_prob(rid, p, now_dt, st)
        conf = self.habits.confidence(rid, now_dt)
        if use:
            if kind == "short":
                why = tr(self.core, "heat.w_short_window", pct=round(prob * 100))
            else:
                why = f"um diese Zeit meist jemand da ({round(prob * 100)} %)"
            chain.append(why)
            return fin(comfort, "comfort", why, None, conf)
        _probs, home = self.day_probs(rid, now_dt.date())
        if home is not None and home[slot_of(now_dt)] < 0.3 and self.habits.day_days(rid, now_dt.date()) < hm.MIN_DAYS and self.habits.prob(rid, now_dt) >= st["threshold"]:
            chain.append(tr(self.core, "heat.c_nobody_home", pct=round(home[slot_of(now_dt)] * 100)))
        elif kind == "short":
            chain.append(tr(self.core, "heat.c_short_room"))
        elif kind == "pass":
            chain.append(tr(self.core, "heat.c_pass_room"))
        else:
            chain.append(f"um diese Zeit selten jemand da ({round(prob * 100)} %)")
        return self._until_next(rid, p, m, current, tout_v, st, now_dt, comfort, setback, chain, fin)

    def learning(self, rid: str, now_dt: datetime) -> bool:
        """Learning phase: the room has too few learned days of today's kind (workday / day off) for its habits."""
        return self.habits.day_days(rid, now_dt.date()) < hm.MIN_DAYS

    def _learning_text(self, rid: str, now_dt: datetime) -> str:
        return tr(self.core, "heat.c_learning", n=min(hm.MIN_DAYS, self.habits.day_days(rid, now_dt.date())), min=hm.MIN_DAYS)

    def _learning_target(self, rid: str, p: dict[str, Any], rt: dict[str, Any], now: float, now_dt: datetime, comfort: float, eco: float, kind: str, senses: bool, chain: list[str], fin: Callable[..., dict[str, Any]]) -> dict[str, Any]:
        """Before the habits are learned: by presence. Comfort while someone is at home, eco in a hall and in a room
        that has been empty for long (with "room empty" on), night in the learned sleeping time."""
        chain.append(self._learning_text(rid, now_dt))
        conf = self.habits.confidence(rid, now_dt)
        pr = p["presence"]
        if self._asleep(now_dt):
            chain.append("Schlafenszeit (gelernt)")
            return fin(min(comfort, float(p["temps"]["night"])), "night", tr(self.core, "heat.w_learning_sleep"), None, conf, learning=True)
        if kind == "pass":
            chain.append(tr(self.core, "heat.c_pass_room"))
            return fin(eco, "eco", tr(self.core, "heat.w_pass"), None, conf, learning=True)
        if pr.get("empty") and senses and not self.core.room_tracker.occupied(rid):
            empty_for = now - self.core.room_tracker.changed_at(rid)
            if empty_for >= pr["empty_after"] * 60:
                why = tr(self.core, "heat.w_learning_empty", minutes=round(empty_for / 60))
                chain.append(why)
                return fin(eco, "eco", why, None, conf, learning=True)
            self.h.schedule(rid, pr["empty_after"] * 60 - empty_for + 1)
        inv = self.core.inventory
        if not inv.persons:
            why = tr(self.core, "heat.w_learning_untracked")
        elif any(inv.person_home(pid) for pid in inv.persons):
            why = tr(self.core, "heat.w_learning_home")
        elif pr.get("away"):
            # everyone left a moment ago: eco follows after "away after" (the away branch above)
            why = tr(self.core, "heat.w_learning_away_soon")
            since = rt.get("away_since")
            if since is not None:
                self.h.schedule(rid, max(1.0, pr["away_after"] * 60 - (now - since) + 1))
        else:
            why = tr(self.core, "heat.w_learning_away_off")
        chain.append(why)
        return fin(comfort, "comfort", why, None, conf, learning=True)

    def _until_next(self, rid: str, p: dict[str, Any], m: hm.RoomModel, current: float | None, tout: float, st: dict[str, Any], now_dt: datetime, comfort: float, setback: float, chain: list[str], fin: Callable[..., dict[str, Any]], away: bool = False) -> dict[str, Any]:
        """Until the next time the room is used: preheat in time (after the usual airing), else set back if worth it."""
        nxt = self.next_use(rid, p, now_dt, st, skip_now=True)
        night = self._asleep(now_dt)
        low = min(setback, float(p["temps"]["night"])) if night else setback
        if night:
            chain.append("Schlafenszeit (gelernt)")
        if nxt is None:
            chain.append("heute niemand mehr erwartet")
            return fin(low, "night" if night else "setback", "heute wird der Raum nicht mehr genutzt", None, self.habits.confidence(rid, now_dt))
        at, target, why_next = nxt
        hours = (at - now_dt).total_seconds() / 3600
        lead_h = self._lead(m, current, target, tout, st, self._gentle(rid, p))
        conf = self.habits.confidence(rid, at)
        start = at - timedelta(hours=lead_h)
        air = self._airing_between(rid, p, start, at)
        if air is not None:
            air_start, air_end, frm, to = air
            if now_dt < air_end and now_dt >= start:
                # preheating now would go out of the usual open window: start right after the airing
                chain.append(tr(self.core, "heat.c_preheat_after_airing", **{"from": frm, "to": to}))
                level = "airing" if now_dt >= air_start else "night" if night else "setback"
                return fin(low, level, tr(self.core, "heat.w_preheat_after_airing", to=to), to, conf, next={"at": at.strftime("%H:%M"), "temp": target, "preheat": to})
            start = max(start, air_end)
        if hours <= lead_h or now_dt >= start:
            chain.append(f"{why_next} ab {at.strftime('%H:%M')}")
            chain.append(f"Raum heizt etwa {str(round(m.rate(current if current is not None else low, tout), 1)).replace('.', ',')} °C/Std., braucht {round(lead_h * 60)} Min.")
            if m.lag >= 0.5:
                chain.append(tr(self.core, "heat.c_lag", minutes=round(m.lag * 60)))
            if st.get("late"):
                chain.append(tr(self.core, "heat.c_late", minutes=int(st["late"])))
            if self._gentle(rid, p):
                chain.append(tr(self.core, "heat.c_gentle", pct=int(st["umax"])))
            return fin(target, "preheat", f"vorheizen, damit es um {at.strftime('%H:%M')} warm ist", at.strftime("%H:%M"), conf, next={"at": at.strftime("%H:%M"), "temp": target})
        sb = hm.setback_plan(m, target, low, tout, hours, current, st["margin"], st["worth_kh"])
        # "not worth setting back" keeps a warm room warm; a room that is cold already just waits for its preheat
        if not sb["worth"] and not (current is not None and current <= low + 0.5):
            chain.append(f"bis {at.strftime('%H:%M')} frei, Absenken lohnt sich nicht ({sb['why']})")
            if sb.get("inert"):
                chain.append(tr(self.core, "heat.c_inert"))
            return fin(target, "comfort", f"Absenken lohnt sich bis {at.strftime('%H:%M')} nicht", at.strftime("%H:%M"), conf, setback=sb, next={"at": at.strftime("%H:%M"), "temp": target})
        chain.append(f"{'zurück' if away else why_next} meist gegen {at.strftime('%H:%M')}")
        chain.append(f"absenken auf {deg(low)} spart etwa {str(sb['saved_kh']).replace('.', ',')} Gradstunden")
        chain.append(f"vorheizen ab {start.strftime('%H:%M')}")
        why = f"alle weg, zurück meist gegen {at.strftime('%H:%M')}" if away else f"bis {at.strftime('%H:%M')} meist niemand da"
        return fin(low, "night" if night else "setback", why, start.strftime("%H:%M"), conf, setback=sb, next={"at": at.strftime("%H:%M"), "temp": target, "preheat": start.strftime("%H:%M")})

    def _airing_between(self, rid: str, p: dict[str, Any], start: datetime, at: datetime) -> tuple[datetime, datetime, str, str] | None:
        """The usual airing that lies between the start of preheating and the use: (its start, its end, from, to)."""
        for day in sorted({start.date(), at.date()}):
            base = datetime.combine(day, datetime.min.time(), tzinfo=at.tzinfo)
            for w in self.airing(rid, p, day):
                a, z = base + timedelta(minutes=w["a"]), base + timedelta(minutes=w["z"])
                if a < at and z > start:
                    return a, z, clock(w["a"]), clock(w["z"])
        return None

    def evening(self, p: dict[str, Any], now_dt: datetime) -> tuple[float, str, bool] | None:
        """"Abends ausklingen" right now: (at most °C, from, from the learned bedtime) – from its start until 04:00."""
        ev = (p.get("smart") or {}).get("evening") or {}
        if not ev.get("on"):
            return None
        start, auto = hm.hm(ev.get("from")), False
        if start is None:
            day = now_dt.date() if now_dt.hour >= 4 else now_dt.date() - timedelta(days=1)
            sw = self.habits.sleep_window(day)
            start, auto = ((sw[0] - 60) % 1440, True) if sw else (22 * 60, False)
            if 4 * 60 <= start < 18 * 60:
                start, auto = 22 * 60, False
        if not hm.in_window(now_dt.hour * 60 + now_dt.minute, clock(start), "04:00"):
            return None
        return float(ev.get("temp") or 20.0), clock(start), auto

    def _gentle(self, rid: str, p: dict[str, Any]) -> bool:
        """The valve is controlled directly (opens at most the style's opening): preheating is planned with that."""
        return bool(self.room_cfg(p)["valve"].get("on")) and bool(self.valves(rid, p))

    def _lead(self, m: hm.RoomModel, current: float | None, target: float, tout: float, st: dict[str, Any], gentle: bool = True) -> float:
        """Hours needed to be warm in time: lag of the room plus heat-up time × margin (at least the ramp), plus the
        style's early minutes, minus the minutes the style accepts to still be warming up (Eco). Planned with the
        style's valve opening (gentle: starts earlier with the valve half open instead of late and wide open)."""
        cur = current if current is not None else target - 2
        need = m.lead(cur, target, tout, st["margin"], st["umax"] / 100 if gentle else 1.0)
        return max(0.0, min(16.0, max(need, hm.ramp_hours(target - cur, st["step"], st["minutes"])) + (st["early"] - st.get("late", 0)) / 60))

    def _eta(self, pr: dict[str, Any]) -> tuple[float, str, float] | None:
        """(minutes, reason, probability) someone arrives: the location module if there is one, else "on the way home"."""
        places = getattr(self.core, "places", None)
        if places is not None and hasattr(places, "predict"):
            best: tuple[float, str, float] | None = None
            for pid, person in self.core.inventory.persons.items():
                try:
                    pred = places.predict(pid) or {}
                except Exception:  # noqa: BLE001 — another module, never trust it blindly
                    continue
                if str(pred.get("destination", "")).lower() not in ("home", "zuhause") or pred.get("eta_min") is None:
                    continue
                prob = float(pred.get("probability") or 0)
                if prob < 0.5:
                    continue
                eta = float(pred["eta_min"])
                if best is None or eta < best[0]:
                    best = (eta, f"{person.get('name', 'jemand')} ist in etwa {round(eta)} Min. zuhause ({round(prob * 100)} %)", prob)
            if best:
                return best
        if pr.get("home_soon") and self.core.checker.holds({"subject": "person:someone", "verb": "coming_home"})[0]:
            return (0.0, "jemand ist auf dem Heimweg", 0.8)
        return None

    def room_prob(self, rid: str, p: dict[str, Any], at: datetime, st: dict[str, Any]) -> tuple[bool, float]:
        """Is the room usually used now, corrected by what the room's sensors see right now: a room with sensors that
        has been empty for an hour is probably not used (stronger with "Raum lange leer: sparen")."""
        use, prob = self.in_use(rid, p, at, st)
        pr = p["presence"]
        room = self.core.rooms.get(rid) or {}
        senses = bool(room.get("presence") or room.get("motion") or room.get("door_logic"))
        if senses and abs((at - dt_util.now()).total_seconds()) < SLOT * 60 and not self.core.room_tracker.occupied(rid):
            empty_for = time.time() - self.core.room_tracker.changed_at(rid)
            factor = 0.3 if pr.get("empty") and empty_for >= pr["empty_after"] * 60 else 0.5 if empty_for >= 3600 else 1.0
            if factor < 1:
                prob *= factor
                if self.kind(rid) == "normal":
                    use = prob >= st["threshold"]
        return use, prob

    def stay(self, rid: str, p: dict[str, Any], t: datetime, st: dict[str, Any]) -> tuple[int, int] | None:
        """The usual stay around t in a normal room: the run of quarter hours in use, (from, to) in minutes of the clock."""
        probs, _home = self.day_probs(rid, t.date())
        s = slot_of(t)
        thr = float(st["threshold"])
        if not probs[s] >= thr:
            return None
        a, z = s, s + 1
        while a > 0 and probs[a - 1] >= thr:
            a -= 1
        while z < len(probs) and probs[z] >= thr:
            z += 1
        return a * SLOT, z * SLOT

    def short_stay(self, rid: str, p: dict[str, Any], t: datetime, st: dict[str, Any]) -> tuple[float, str, str] | None:
        """"Kurz daheim": the usual stay at t is short (at most the set hours) → (at most °C, from, to). Only normal
        rooms (a bathroom is always used briefly, it has its own windows)."""
        sh = (p.get("smart") or {}).get("short") or {}
        if not sh.get("on") or self.kind(rid) != "normal":
            return None
        s = self.stay(rid, p, t, st)
        if s is None or s[1] - s[0] > float(sh.get("hours") or 2.0) * 60:
            return None
        return float(sh.get("temp") or 19.5), clock(s[0]), clock(s[1] % 1440)

    def next_use(self, rid: str, p: dict[str, Any], now_dt: datetime, st: dict[str, Any], skip_now: bool = False, horizon: int = SLOTS) -> tuple[datetime, float, str] | None:
        """The next quarter hour (within 24 h) the room is usually used, or a fixed time starts: (time, temp, why)."""
        base = now_dt.replace(minute=(now_dt.minute // SLOT) * SLOT, second=0, microsecond=0)
        comfort = float(p["temps"]["comfort"])
        nb = self.h.next_block(p, now_dt, horizon * SLOT)
        for i in range(1 if skip_now else 0, horizon):
            t = base + timedelta(minutes=SLOT * i)
            if nb and nb[1] <= t:
                return nb[1], self.h._block_temp(p, nb[0]), "feste Zeit"  # noqa: SLF001
            if self.in_use(rid, p, t, st)[0]:
                sh = self.short_stay(rid, p, t, st)
                if sh is not None and sh[0] < comfort:
                    return t, sh[0], tr(self.core, "heat.n_short_stay", **{"from": sh[1], "to": sh[2]})
                return t, comfort, "meist jemand da" if self.kind(rid) == "normal" else tr(self.core, "heat.n_usual_use")
        return None

    def _asleep(self, now_dt: datetime) -> bool:
        w = self.habits.sleep_window(now_dt.date())
        if not w:
            return False
        return hm.in_window(now_dt.hour * 60 + now_dt.minute, clock(w[0]), clock(w[1]))

    # ------------------------------------------------------------------ learning signals
    def manual(self, rid: str, temp: float | None, plan_temp: float | None) -> None:
        """A person turned the heating up or down: remember it (→ proposals)."""
        if temp is None or plan_temp is None:
            return
        now = dt_util.now()
        lst = self.d["manual"].setdefault(rid, [])
        lst.append([round(time.time()), "work" if self.habits.workday(now.date()) else "free", now.hour * 60 + now.minute, round(temp - plan_temp, 1)])
        cut = time.time() - 35 * 86400
        self.d["manual"][rid] = [x for x in lst if x[0] >= cut][-60:]
        self._sugg = None
        self.save()

    # ------------------------------------------------------------------ the tick: model, energy, valves, shadow
    @callback
    def tick(self) -> None:
        if not self.h.enabled():
            return
        try:
            self._tick()
        except Exception as err:  # noqa: BLE001 — never break the controller
            _LOGGER.warning("Intelligente Heizung: %s", err)

    def _tick(self) -> None:
        now = self.clock()
        dt_h = 0.0 if self._last is None else (now - self._last) / 3600
        self._last = now
        tout = self.h.outside()
        now_dt = dt_util.now()
        slot = f"{now_dt.date().isoformat()}:{slot_of(now_dt)}"
        new_slot = slot != self._slot_key
        self._slot_key = slot
        self.energy.sample_meter()
        self._learn_humidity(time.time())
        if time.time() - self.energy._prefs_at > 600:  # noqa: SLF001
            self.hass.async_create_background_task(self.energy.refresh_prefs(), "house_rules_energy_prefs")
        for rid in self.core.rooms:
            p = self.h.room(rid)
            if not p["on"]:
                self._valve_off(rid, "Heizplan aus")
                continue
            d = self.h.status(rid) or {}
            current, _src = self.h.room_temp(rid, p)
            u = self._u(rid, p, d)
            self._sample_model(rid, p, d, current, tout, u, now)
            self.energy.account(rid, dt_h, u, current, tout, float(p["temps"]["comfort"]))
            self._valve(rid, p, d, current, tout, dt_h, now)
            if new_slot and self.phase(p) == "shadow":
                self._shadow_log(rid, d, current)
        self.save()

    def _u(self, rid: str, p: dict[str, Any], d: dict[str, Any]) -> float | None:
        """Valve opening 0…1 now: our own command, else what the thermostats report, else heating yes/no."""
        rv = self._valve_rt.get(rid) or {}
        if rv.get("state") == "on" and rv.get("u") is not None:
            return rv["u"] / 100
        vals: list[float] = []
        acts: list[str] = []
        for e in self.h.thermostats(rid, p):
            v = self.h.valve(e)
            st = self.hass.states.get(e)
            if v is not None:
                vals.append(v)
            elif st is not None:
                if st.state == "off":
                    acts.append("off")
                elif st.attributes.get("hvac_action"):
                    acts.append(str(st.attributes["hvac_action"]))
        if vals:
            return max(0.0, min(1.0, sum(vals) / len(vals) / 100))
        if acts:
            return sum(1.0 for a in acts if a == "heating") / len(acts)
        return None

    def openings(self, rid: str, p: dict[str, Any]) -> tuple[float, float]:
        """(door, window) right now, 1 = open: a door of the room to the rest of the home (the room's door contacts
        that are no window contacts of the heating) / a window contact of the room."""
        contacts = self.h.contacts(rid, p)
        window = 1.0 if any((s := self.hass.states.get(e)) is not None and s.state == "on" for e in contacts) else 0.0
        doors = [e for e in (self.core.rooms.get(rid) or {}).get("doors") or [] if e not in contacts]
        door = 1.0 if any((s := self.hass.states.get(e)) is not None and s.state == "on" for e in doors) else 0.0
        return door, window

    def _sample_model(self, rid: str, p: dict[str, Any], d: dict[str, Any], current: float | None, tout: float | None, u: float | None, now: float) -> None:
        """Learns the room model from intervals of the real room: heating up, cooling down, with a door or a window
        open. A window opening or closing ends the interval (an airing of a few minutes is a sample of its own)."""
        door, window = self.openings(rid, p)
        wst = (d.get("window") or {}).get("state")
        # the air settling after a window, a drop without a contact (airing detected from the temperature), the valve
        # exercise, summer: nothing to learn
        bad = d.get("level") in ("exercise", "summer") or wst == "settling" or (wst == "open" and not window)
        if current is None or tout is None or u is None or bad:
            self._samp.pop(rid, None)
            return
        a = self._samp.get(rid)
        if a is not None and (window > 0) != (a["w0"] > 0):
            self._learn_interval(rid, a, current, now)
            a = None
        if a is None or abs(u - a["u0"]) > 0.3 or (now - a["t"]) > 3 * 3600:
            self._samp[rid] = {"t": now, "temp": current, "u0": u, "w0": window, "us": 0.0, "ts": 0.0, "ds": 0.0, "ws": 0.0, "dur": 0.0, "last": now}
            return
        dt = now - a["last"]
        a["last"] = now
        a["us"] += u * dt
        a["ts"] += tout * dt
        a["ds"] += door * dt
        a["ws"] += window * dt
        a["dur"] += dt
        el = (now - a["t"]) / 3600
        if el >= 0.25 and a["dur"] > 0 and (abs(current - a["temp"]) >= 0.3 or el >= 0.75):
            self._learn_interval(rid, a, current, now)
            self._samp[rid] = {"t": now, "temp": current, "u0": u, "w0": window, "us": 0.0, "ts": 0.0, "ds": 0.0, "ws": 0.0, "dur": 0.0, "last": now}

    def _learn_interval(self, rid: str, a: dict[str, Any], current: float, now: float) -> None:
        if a["dur"] <= 0:
            return
        m = self.model(rid)
        dur = a["dur"]
        got = m.add_interval(0.0, (now - a["t"]) / 3600, a["temp"], current, a["us"] / dur, a["ts"] / dur, a["ds"] / dur, a["ws"] / dur)
        if got:
            self.d["models"][rid] = m.to_dict()

    def _shadow_log(self, rid: str, d: dict[str, Any], current: float | None) -> None:
        would = (self.h._rt.get(rid) or {}).get("would") or {}  # noqa: SLF001
        real = d.get("temp") if d.get("mode") == "heat" else None
        row = [round(time.time()), real, would.get("temp"), current]
        lst = self.d["shadow"].setdefault(rid, [])
        lst.append(row)
        if len(lst) > SHADOW_KEEP:
            del lst[: len(lst) - SHADOW_KEEP]

    def log_decision(self, rid: str, d: dict[str, Any]) -> None:
        """Remember the last decisions with their reason chain (only when something changes)."""
        sm = d.get("smart") or {}
        lst = self.d["log"].setdefault(rid, [])
        key = (d.get("temp"), d.get("level"), d.get("why"))
        if lst and (lst[-1].get("temp"), lst[-1].get("level"), lst[-1].get("why")) == key:
            return
        lst.append({"t": round(time.time()), "temp": d.get("temp"), "level": d.get("level"), "why": d.get("why"), "chain": list(sm.get("chain") or [])[:8], "confidence": sm.get("confidence")})
        if len(lst) > LOG_KEEP:
            del lst[: len(lst) - LOG_KEEP]
        if sm.get("guards"):
            gl = self.d["guards"].setdefault(rid, [])
            entry = {"t": round(time.time()), "guards": sm["guards"]}
            if not gl or gl[-1]["guards"] != entry["guards"]:
                gl.append(entry)
                del gl[: max(0, len(gl) - 20)]
        self.save()

    # ------------------------------------------------------------------ direct valve control
    def writable(self, therm: str) -> dict[str, Any] | None:
        """Writable valve entities on the thermostat's device: an opening/closing pair (Sonoff TRVZB style) or one position."""
        if time.time() - self._writable_at > 120:
            self._writable, self._writable_at = {}, time.time()
        if therm in self._writable:
            return self._writable[therm]
        opening = closing = pos = None
        for x in self.h._device_entities(therm):  # noqa: SLF001
            if not x.startswith("number."):
                continue
            st = self.hass.states.get(x)
            name = f"{x} {st.attributes.get('friendly_name', '') if st else ''}"
            if OPEN_NAME.search(name):
                opening = x
            elif CLOSE_NAME.search(name):
                closing = x
            elif POS_NAME.search(name):
                pos = x
        out = {"kind": "pair", "open": opening, "close": closing} if opening and closing else {"kind": "single", "entity": pos} if pos else {"kind": "single", "entity": opening} if opening else None
        self._writable[therm] = out
        return out

    def valves(self, rid: str, p: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {e: w for e in self.h.thermostats(rid, p) if (w := self.writable(e))}

    def _ents_of(self, w: dict[str, Any]) -> list[str]:
        return [x for x in (w.get("open"), w.get("close"), w.get("entity")) if x]

    def _valve(self, rid: str, p: dict[str, Any], d: dict[str, Any], current: float | None, tout: float | None, dt_h: float, now: float) -> None:  # noqa: C901
        c = self.room_cfg(p)
        rv = self._valve_rt.setdefault(rid, {"state": "off", "why": "", "u": None, "sent": {}, "fb_until": 0.0, "track": None, "cmds": 0})
        if not c["valve"].get("on"):
            self._valve_off(rid, "aus")
            return
        if self.phase(p) != "active":
            self._valve_off(rid, "Beobachtung (Schattenbetrieb): nur das Thermostat regelt", state="shadow")
            return
        vs = self.valves(rid, p)
        if not vs:
            self._valve_off(rid, "kein steuerbares Ventil gefunden", state="none")
            return
        if d.get("level") == "window" and d.get("mode") == "off":
            # window open (or the air still settling): valves shut right away; the controller's state stays for later
            self._valve_close(rid, vs, now)
            return
        if d.get("mode") != "heat" or d.get("level") in ("window", "exercise", "manual", "frost") or d.get("temp") is None:
            self._valve_off(rid, "das Thermostat regelt selbst (Fenster, von Hand, Ventilschutz …)", state="setpoint")
            return
        if now < rv["fb_until"]:
            return
        problem = None
        if current is None:
            problem = "keine Raumtemperatur"
        elif not (0 < current < 40):
            problem = "Raumtemperatur unplausibel"
        else:
            for e, w in vs.items():
                for x in self._ents_of(w):
                    st = self.hass.states.get(x)
                    if st is None or st.state in ("unavailable", "unknown"):
                        problem = f"{self.h._name(x)} nicht erreichbar"  # noqa: SLF001
        target = float(d["temp"])
        # implausible: valve wide open for 3 h but the room does not get warmer
        tr = rv.get("track")
        if problem is None and rv.get("u") is not None and rv["u"] >= 80 and current is not None and current < target - 1:
            if not tr:
                rv["track"] = {"t": now, "temp": current}
            elif now - tr["t"] >= 3 * 3600 and current - tr["temp"] < 0.3:
                problem = "der Raum wird trotz offenem Ventil nicht wärmer"
        else:
            rv["track"] = None
        if problem:
            self._valve_off(rid, f"zurück zur normalen Regelung: {problem}", state="fallback")
            rv["fb_until"] = now + 1800 * (1 if "nicht erreichbar" in problem or "keine" in problem else 2)
            return
        st = self.style(p)
        pi = hm.ValvePI(self.d["pi"].get(rid))
        door, _window = self.openings(rid, p)
        u = pi.step(self.model(rid), st, target, float(current), tout if tout is not None else 5.0, dt_h, door, now)
        self.d["pi"][rid] = pi.to_dict()
        pct = int(round(u * 100))
        rv["state"], rv["why"] = "on", f"Ventil direkt: {pct} %"
        for e, w in vs.items():
            last = rv["sent"].get(e)
            big = last is None or abs(pct - last["pct"]) >= 30 or ((pct == 0) != (last["pct"] == 0))
            if big or (abs(pct - last["pct"]) >= st["deadband"] and (now - last["t"]) / 60 >= st["gap"]):
                self._remember_restore(e, w)
                self._send_valve(rid, e, w, pct)
                rv["sent"][e] = {"pct": pct, "t": now}
                rv["cmds"] += 1
        rv["u"] = pct

    def _valve_close(self, rid: str, vs: dict[str, dict[str, Any]], now: float) -> None:
        rv = self._valve_rt[rid]
        for e, w in vs.items():
            last = rv["sent"].get(e)
            if last is not None and last["pct"] == 0:
                continue
            self._remember_restore(e, w)
            self._send_valve(rid, e, w, 0)
            rv["sent"][e] = {"pct": 0, "t": now}
            rv["cmds"] += 1
        rv["u"] = 0
        rv["track"] = None
        rv["state"], rv["why"] = "window", "Fenster offen: Ventil zu"

    def react(self, rid: str, p: dict[str, Any], d: dict[str, Any]) -> None:
        """Right after a decision of the controller: a window opened, or the room just came back from one – the
        valves follow at once instead of at the next tick."""
        rv = self._valve_rt.get(rid)
        if d.get("level") != "window" and not (rv and rv.get("state") == "window"):
            return
        if not self.room_cfg(p)["valve"].get("on"):
            return
        try:
            current, _src = self.h.room_temp(rid, p)
            self._valve(rid, p, d, current, self.h.outside(), 0.0, self.clock())
        except Exception as err:  # noqa: BLE001 — never break the controller
            _LOGGER.warning("Intelligente Heizung (Ventil): %s", err)

    def _scaled(self, ent: str, pct: float) -> float:
        st = self.hass.states.get(ent)
        lo = float(st.attributes.get("min", 0)) if st else 0.0
        hi = float(st.attributes.get("max", 100)) if st else 100.0
        step = float(st.attributes.get("step", 1)) if st else 1.0
        v = lo + (hi - lo) * pct / 100
        return round(round(v / step) * step, 2)

    def _send_valve(self, rid: str, therm: str, w: dict[str, Any], pct: int) -> None:
        ctx = self.core.history.new_context(f"heat_{rid}")
        self.h._ours[ctx.id] = time.time()  # noqa: SLF001
        calls: list[tuple[str, float]] = []
        if w["kind"] == "pair":
            # opening degree when the thermostat opens, closing degree when it closes: both mean "pct % open"
            calls = [(w["open"], self._scaled(w["open"], pct)), (w["close"], self._scaled(w["close"], 100 - pct))]
        else:
            calls = [(w["entity"], self._scaled(w["entity"], pct))]
        for ent, val in calls:
            st = self.hass.states.get(ent)
            try:
                if st and abs(float(st.state) - val) < 0.5:
                    continue
            except (TypeError, ValueError):
                pass
            self.hass.async_create_task(self.hass.services.async_call("number", "set_value", {ATTR_ENTITY_ID: ent, "value": val}, blocking=False, context=ctx))

    def _remember_restore(self, therm: str, w: dict[str, Any]) -> None:
        r = self.d["restore"]
        if therm in r:
            return
        vals: dict[str, float] = {}
        for x in self._ents_of(w):
            st = self.hass.states.get(x)
            try:
                vals[x] = float(st.state) if st else 100.0
            except (TypeError, ValueError):
                vals[x] = 100.0
        r[therm] = vals

    def _valve_off(self, rid: str, why: str, state: str = "off") -> None:
        """Back to the thermostat's own valve behaviour (restores the values from before)."""
        rv = self._valve_rt.setdefault(rid, {"state": "off", "why": "", "u": None, "sent": {}, "fb_until": 0.0, "track": None, "cmds": 0})
        restore = self.d["restore"]
        p = self.h.room(rid)
        for e in self.h.thermostats(rid, p):
            if e not in restore:
                continue
            w = self.writable(e)
            vals = restore.pop(e)
            if not w:
                continue
            ctx = self.core.history.new_context(f"heat_{rid}")
            self.h._ours[ctx.id] = time.time()  # noqa: SLF001
            for ent in self._ents_of(w):
                st = self.hass.states.get(ent)
                if st is None or st.state in ("unavailable", "unknown"):
                    continue
                # the values from before we took over (pair: usually 100/100 = the thermostat decides again)
                val = vals.get(ent, 100.0)
                self.hass.async_create_task(self.hass.services.async_call("number", "set_value", {ATTR_ENTITY_ID: ent, "value": self._scaled(ent, val)}, blocking=False, context=ctx))
            self.core.history.add("rule", f"Heizung {self.core.rooms.get(rid, {}).get('name', rid)}: Ventil wieder vom Thermostat geregelt", why[:1].upper() + why[1:] + ".", entity_id=e)
            self.save()
        rv["sent"] = {}
        rv["u"] = None
        rv["state"], rv["why"] = state, why

    # ------------------------------------------------------------------ status (snapshot) and explanation
    def status(self, rid: str, p: dict[str, Any], d: dict[str, Any]) -> dict[str, Any]:
        c = self.room_cfg(p)
        ph = self.phase(p)
        ki = self.kind_info(rid)
        out: dict[str, Any] = {"mode": c["mode"], "phase": ph, "style": c["style"], "building": c.get("building", "unknown"), "kind": ki["kind"], "room_type": ki}
        rv = self._valve_rt.get(rid)
        vs = self.valves(rid, p)
        out["valve"] = {"available": bool(vs), "on": bool(c["valve"].get("on")), "state": rv["state"] if rv else "off", "why": rv["why"] if rv else "", "u": rv["u"] if rv else None, "commands": rv["cmds"] if rv else 0}
        if ph == "schedule":
            return out
        if ph == "shadow":
            since = float(c.get("shadow_since") or time.time())
            days = max(0, int(c.get("shadow_days") or 7))
            out["shadow"] = {"since": since, "days": days, "left": max(0.0, round(days - (time.time() - since) / 86400, 1)), "ready": time.time() - since >= days * 86400}
            would = (self.h._rt.get(rid) or {}).get("would")  # noqa: SLF001
            if would:
                out["would"] = {"temp": would.get("temp"), "why": would.get("why"), "level": would.get("level")}
        sm = d.get("smart") or ((self.h._rt.get(rid) or {}).get("would") or {}).get("smart") or {}  # noqa: SLF001
        out["confidence"] = sm.get("confidence")
        out["chain"] = sm.get("chain") or []
        out["guards"] = sm.get("guards") or []
        out["next"] = sm.get("next")
        out["learned_days"] = self.habits.days(rid)
        out["learning"] = self.learning(rid, dt_util.now())
        return out

    def _profile_target(self, rid: str, p: dict[str, Any], t: datetime, st: dict[str, Any], m: hm.RoomModel, tout: float, prev: float | None = None) -> tuple[float, str, str, float]:  # noqa: C901
        """What the room would want at time t on a usual day (no live presence): (temp, level, why, confidence).
        `prev`: the target just before (a room that is already set back is cold: the pause is judged from there)."""
        g = self.guard(p)
        comfort = float(p["temps"]["comfort"])
        setback = max(float(g["min"]), comfort - min(float(st["depth"]), float(g["max_setback"])))
        b = self.h.block_now(p, t)
        conf = self.habits.confidence(rid, t)
        minute = t.hour * 60 + t.minute
        kind = self.kind(rid)
        if b:
            temp, level, why, conf = self.h._block_temp(p, b), "custom", f"feste Zeit {b['from']}–{b['to']}", 1.0  # noqa: SLF001
        else:
            air = self.airing_at(rid, p, t)
            use, prob = self.in_use(rid, p, t, st)
            night = self._asleep(t)
            low = min(setback, float(p["temps"]["night"])) if night else setback
            if air:
                temp, level, why = low, "airing", tr(self.core, "heat.w_airing_plan", **{"from": clock(air["a"]), "to": clock(air["z"])})
            elif use:
                why = tr(self.core, "heat.w_short_window", pct=round(prob * 100)) if kind == "short" else f"meist jemand da ({round(prob * 100)} %)"
                temp, level = comfort, "comfort"
                sh = self.short_stay(rid, p, t, st)
                if sh is not None and sh[0] < temp:
                    temp, why = sh[0], tr(self.core, "heat.w_short_stay", **{"from": sh[1], "to": sh[2], "deg": deg(sh[0])})
            else:
                why = tr(self.core, "heat.w_short_rest") if kind == "short" else tr(self.core, "heat.w_pass") if kind == "pass" else f"selten jemand da ({round(prob * 100)} %)"
                temp, level = low, "night" if night else "setback"
                # preheat window before the next use (after the usual airing)
                nxt = self.next_use(rid, p, t, st, skip_now=True, horizon=40)
                if nxt:
                    lead = self._lead(m, low, nxt[1], tout, st, self._gentle(rid, p))
                    start = nxt[0] - timedelta(hours=lead)
                    air2 = self._airing_between(rid, p, start, nxt[0])
                    if air2:
                        start = max(start, air2[1])
                    hours = (nxt[0] - t).total_seconds() / 3600
                    if t >= start:
                        temp, level, why = nxt[1], "preheat", f"vorheizen für {nxt[0].strftime('%H:%M')}"
                    elif (prev is None or prev > low + 0.5) and not hm.setback_plan(m, nxt[1], low, tout, hours, nxt[1] if prev is None else prev, st["margin"], st["worth_kh"])["worth"]:
                        temp, level, why = nxt[1], "comfort", "kurze Pause, Absenken lohnt nicht"
            if st.get("uncertain") and level in ("comfort", "preheat") and conf < 0.5 and temp > setback:
                temp = max(setback, temp - float(st["uncertain"]))
            ev = self.evening(p, t)
            if ev is not None and level in ("comfort", "preheat") and temp > ev[0]:
                temp, why = ev[0], tr(self.core, "heat.w_evening", **{"from": ev[1], "deg": deg(ev[0])})
        temp, _g = hm.apply_guards(temp, g, False, minute)
        return temp, level, why, conf

    def today_plan(self, rid: str, p: dict[str, Any], day: date | None = None) -> list[dict[str, Any]]:
        """A usual day of the room (default today) as segments with temperature, level, reason and how sure."""
        st, m = self.style(p), self.model(rid)
        tout = self.h.outside()
        tout = tout if tout is not None else 5.0
        start = dt_util.start_of_local_day(day) if day else dt_util.start_of_local_day()
        segs: list[dict[str, Any]] = []
        for i in range(SLOTS):
            t = start + timedelta(minutes=SLOT * i)
            temp, level, why, conf = self._profile_target(rid, p, t, st, m, tout, segs[-1]["temp"] if segs else None)
            if segs and segs[-1]["temp"] == temp and segs[-1]["level"] == level:
                segs[-1]["to"] = clock((i + 1) * SLOT)
                segs[-1]["_c"].append(conf)
                continue
            segs.append({"from": clock(i * SLOT), "to": clock((i + 1) * SLOT), "temp": temp, "level": level, "why": why, "_c": [conf]})
        for s in segs:
            c = s.pop("_c")
            s["confidence"] = round(sum(c) / len(c), 2)
            if s["to"] == "00:00":
                s["to"] = "24:00"
        return segs

    def plan_view(self, rid: str) -> dict[str, Any]:
        """The learned plan of a room for the "Zeiten" tab: what the heating intends today and tomorrow and why,
        the learned comfort and airing windows, the lead time of the room and how sure it is."""
        if rid not in self.core.rooms:
            raise ValueError("Unbekannter Raum")
        p = self.h.room(rid)
        st, g, m = self.style(p), self.guard(p), self.model(rid)
        tout = self.h.outside()
        tout_v = tout if tout is not None else 5.0
        comfort = float(p["temps"]["comfort"])
        low = max(float(g["min"]), comfort - min(float(st["depth"]), float(g["max_setback"])))
        today = dt_util.now().date()
        tomorrow = today + timedelta(days=1)
        win = lambda ws: [{"from": clock(w["a"]), "to": clock(w["z"]) if w["z"] < 1440 else "24:00", "mean": w["mean"], **({"joined": w["joined"]} if "joined" in w else {}), **({"source": w["source"]} if "source" in w else {})} for w in ws]  # noqa: E731
        _probs, home = self.day_probs(rid, today)
        segs = self.today_plan(rid, p, today)
        return {
            "room": rid,
            "kind": self.kind(rid),
            "room_type": self.kind_info(rid),
            "phase": self.phase(p),
            "style": self.room_cfg(p)["style"],
            "building": self.room_cfg(p).get("building", "unknown"),
            "today": segs,
            "tomorrow": self.today_plan(rid, p, tomorrow),
            "windows": {"today": win(self.windows(rid, p, today)), "tomorrow": win(self.windows(rid, p, tomorrow))},
            "airing": {"today": win(self.airing(rid, p, today)), "tomorrow": win(self.airing(rid, p, tomorrow)), "pattern": hm.airing_pattern(self.habits.air_events(rid)), "days": self.habits.days(f"w:{rid}")},
            "model": {"lead_min": round(m.lead(low, comfort, tout_v, st["margin"]) * 60), "lag_min": round(m.lag * 60), "rate_now": round(m.rate(low, tout_v), 2), "learned": m.heat.n >= hm.LEARNED_N, "confidence": m.confidence, "inert": m.inert},
            "learned_days": self.habits.days(rid),
            "min_days": hm.MIN_DAYS,
            "home_known": home is not None,
            "confidence": round(sum(s["confidence"] for s in segs) / len(segs), 2) if segs else 0,
            "blocks": p["blocks"],
        }

    def forecast(self, rid: str, p: dict[str, Any], d: dict[str, Any], hours: int = 12) -> list[dict[str, Any]]:
        """Next hours: target and the temperature the model expects (30-minute steps)."""
        st, m = self.style(p), self.model(rid)
        tout = self.h.outside()
        tout = tout if tout is not None else 5.0
        now = dt_util.now()
        temp = d.get("current")
        out = []
        for i in range(hours * 2 + 1):
            t = now + timedelta(minutes=30 * i)
            if i == 0 and d.get("temp") is not None:
                target = float(d["temp"])
            else:
                target = self._profile_target(rid, p, t, st, m, tout, temp)[0]
            out.append({"t": t.strftime("%H:%M"), "target": round(target, 1), "temp": round(temp, 1) if temp is not None else None})
            if temp is not None:
                for _ in range(6):
                    u = 1.0 if temp < target - 0.1 else m.steady_valve(target, tout) if temp < target + 0.3 else 0.0
                    temp = temp + m.rate(temp, tout, u) * (5 / 60)
                    if u >= 1.0 and temp > target:
                        temp = target
        return out

    async def explain(self, rid: str) -> dict[str, Any]:
        if rid == "_house":
            # house-wide: cost of all rooms and the learned daily rhythm
            await self.energy.refresh_prefs()
            await self.energy.refresh_stats()
            return {"room": rid, "energy": self.energy.summary(), "habits": self.habits.view(), "outside": self.h.outside()}
        if rid not in self.core.rooms:
            raise ValueError("Unbekannter Raum")
        p = self.h.room(rid)
        d = self.h.status(rid) or {}
        m = self.model(rid)
        tout = self.h.outside()
        cur = d.get("current")
        await self.energy.refresh_prefs()
        await self.energy.refresh_stats()
        shadow = self.d["shadow"].get(rid) or []
        kh_real = kh_would = 0.0
        for row in shadow:
            if row[1] is not None and row[2] is not None and tout is not None:
                kh_real += max(0.0, row[1] - tout) * 0.25
                kh_would += max(0.0, row[2] - tout) * 0.25
        return {
            "room": rid,
            "status": d.get("smart") or self.status(rid, p, {}),
            "today": self.today_plan(rid, p),
            "heatmap": self.habits.profile(rid),
            "habits": self.habits.view(),
            "days": self.habits.days(rid),
            "decisions": list(reversed(self.d["log"].get(rid) or []))[:20],
            "guards": list(reversed(self.d["guards"].get(rid) or []))[:10],
            "forecast": self.forecast(rid, p, d),
            "shadow": {"rows": shadow[-96:], "kh_real": round(kh_real, 1), "kh_would": round(kh_would, 1), "saved_pct": round(100 * (1 - kh_would / kh_real)) if kh_real > 1 else None},
            "model": {
                **m.to_dict(),
                # what the decisions use: blended with the building prior until enough samples are learned
                "k_l": round(m.k_l, 4),
                "k_h": round(m.k_h, 3),
                "lag_min": round(m.lag * 60),
                "building": self.room_cfg(p).get("building", "unknown"),
                "confidence": m.confidence,
                "rate_now": round(m.rate(cur if cur is not None else 19.0, tout if tout is not None else 5.0), 2),
                "heat_3k_min": round(m.heat_time(18, 21, tout if tout is not None else 5.0) * 60),
                "cool_per_h": round(m.k_l * ((cur if cur is not None else 20.0) - (tout if tout is not None else 5.0)), 2),
                # extra cooling with a door to the rest of the home / a window open (°C per hour now)
                "door_per_h": round(m.k_d * ((cur if cur is not None else 20.0) - (tout if tout is not None else 5.0)), 2) if m.door.n else None,
                "window_per_h": round(m.k_w * ((cur if cur is not None else 20.0) - (tout if tout is not None else 5.0)), 2) if m.win.n else None,
            },
            "energy": self.energy.summary(rid),
            "outside": tout,
        }

    # ------------------------------------------------------------------ proposals (through the suggestions)
    def suggestions(self, dismissed: set[str]) -> list[dict[str, Any]]:
        if not self.h.enabled():
            return []
        if self._sugg and time.time() - self._sugg[0] < 600:
            return [s for s in self._sugg[1] if s["id"] not in dismissed]
        out: list[dict[str, Any]] = []
        for rid in self.core.rooms:
            p = self.h.room(rid)
            if not p["on"]:
                continue
            try:
                out += self._room_proposals(rid, p)[:2]
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("Heizvorschläge %s: %s", rid, err)
        out = out[:6]
        self._sugg = (time.time(), out)
        return [s for s in out if s["id"] not in dismissed]

    def _covered(self, p: dict[str, Any], days: str, a: int, z: int) -> float:
        hit = 0
        n = 0
        for s in range(a, z):
            n += 1
            mm = s * SLOT
            for b in p["blocks"]:
                ba, bz = hm.hm(b["from"]), hm.hm(b["to"])
                if ba is None or bz is None or (b["days"] not in ("all", days)):
                    continue
                if (ba <= mm < bz) if ba <= bz else (mm >= ba or mm < bz):
                    hit += 1
                    break
        return hit / n if n else 1.0

    def _room_proposals(self, rid: str, p: dict[str, Any]) -> list[dict[str, Any]]:
        name = self.core.rooms[rid]["name"]
        comfort = float(p["temps"]["comfort"])
        out: list[dict[str, Any]] = []
        day_text = {"workdays": ("Werktags", "werktags"), "weekend": ("Am Wochenende", "am Wochenende")}

        def add(days: str, a: int, z: int, temp: float, why: str, kind: str) -> None:
            frm, to = clock(a), clock(min(z, 1439)) if z < 1440 else "23:59"
            sid = f"s_heat_{rid}_{days}_{frm.replace(':', '')}"[:80]
            out.append(
                {
                    "id": sid,
                    "title": f"{day_text[days][0]} ab {frm} {name} {deg(temp)} – übernehmen?",
                    "why": why,
                    "icon": "heating",
                    "badge": "Heizung",
                    "task": "heat_block",
                    "heat": {"room": rid, "kind": kind, "block": {"from": frm, "to": to, "days": days, "level": "comfort" if temp == comfort else "custom", "temp": temp}},
                }
            )

        # 1) manual changes: turned up repeatedly around the same time
        for kind, days in (("work", "workdays"), ("free", "weekend")):
            ups = sorted((x for x in self.d["manual"].get(rid, []) if x[1] == kind and x[3] >= 0.5), key=lambda x: x[2])
            i = 0
            while i < len(ups):
                grp = [x for x in ups if ups[i][2] <= x[2] <= ups[i][2] + 60]
                dates = {dt_util.as_local(dt_util.utc_from_timestamp(x[0])).date() for x in grp}
                if len(dates) >= 3:
                    delta = sum(x[3] for x in grp) / len(grp)
                    temp = round((comfort + delta) * 2) / 2
                    a = (grp[0][2] // SLOT) * SLOT
                    z = min(1440, a + 180)
                    add(days, a, z, temp, f"Du hast {len(grp)}-mal um diese Zeit von Hand höher gedreht, im Schnitt um {str(round(delta, 1)).replace('.', ',')} °C.", "manual")
                    break
                i += 1
        # 2) habits (rooms with a time plan; an intelligent room heats by what it learned anyway): real occupancy peaks
        #    with enough days behind them (hm.use_windows: a bathroom gets short windows, never the whole day),
        #    not covered by a fixed time yet
        if self.phase(p) != "schedule" or not self.habits.d["prof"].get(rid):
            return out
        today = dt_util.now().date()
        st, g, m = self.style(p), self.guard(p), self.model(rid)
        tout = self.h.outside()
        low = max(float(g["min"]), comfort - min(float(st["depth"]), float(g["max_setback"])))
        lead = m.lead(low, comfort, tout if tout is not None else 5.0, st["margin"])
        kind = self.kind(rid)
        for days, want in (("workdays", True), ("weekend", False)):
            dates = [d for d in (today + timedelta(days=i) for i in range(1, 8)) if (d.weekday() < 5) == want]
            rows = [self.day_probs(rid, d)[0] for d in dates]
            probs = [sum(r[s] for r in rows) / len(rows) for s in range(SLOTS)]
            n = min(self.habits.day_days(rid, d) for d in dates)
            for w in hm.use_windows(probs, n, kind, lead):
                s, e = w["a"], w["z"]
                if e * SLOT <= 5 * 60 or self._covered(p, days, s, e) >= 0.7:
                    continue
                avg = round(100 * w["mean"])
                frm, to = clock(s * SLOT), clock(min(e * SLOT, 1439))
                if kind == "short":
                    why = tr(self.core, f"heat.p_short_{days}", **{"from": frm, "to": to}, pct=avg, n=n)
                elif w["joined"]:
                    why = tr(self.core, f"heat.p_joined_{days}", **{"from": frm, "to": to}, pct=avg, minutes=round(lead * 60))
                else:
                    why = f"Der Raum ist {day_text[days][1]} meist von {frm} bis {to} belegt ({avg} % der Tage). Als feste Zeit ist es dann sicher warm."
                add(days, s * SLOT, e * SLOT, comfort, why, "habit")
        return out

    def accept(self, sid: str) -> dict[str, Any]:
        """A proposal accepted: becomes a fixed time of the room; not proposed again."""
        self._sugg = None
        prop = next((s for s in self.suggestions(set()) if s["id"] == sid), None)
        if not prop:
            raise ValueError("Vorschlag nicht mehr aktuell")
        rid = prop["heat"]["room"]
        p = self.h.room(rid)
        blocks = [b for b in p["blocks"] if not (b["from"] == prop["heat"]["block"]["from"] and b["days"] == prop["heat"]["block"]["days"])]
        self.h.save_room(rid, {"blocks": [*blocks, prop["heat"]["block"]][:12]})
        dismissed = self.core.data.setdefault("dismissed", [])
        if sid not in dismissed:
            dismissed.append(sid)
        self.core.history.add("rule", f"Heizung {self.core.rooms[rid]['name']}: Vorschlag übernommen", prop["title"].replace(" – übernehmen?", "") + ".", logbook=True)
        self.core.save()
        self._sugg = None
        return prop

    # ------------------------------------------------------------------ actions
    def takeover(self, rid: str) -> None:
        p = self.h.room(rid)
        s = self.room_cfg(p)
        if s["mode"] != "smart":
            s["mode"] = "smart"
        s["shadow_since"] = None
        self.h.store[rid] = {**p, "smart": s}
        self.core.save()
        self.core.history.add("rule", f"Heizung {self.core.rooms.get(rid, {}).get('name', rid)}: heizt jetzt intelligent", "Nach der Beobachtung übernommen.", logbook=True)
        self.h.schedule(rid, 0.1)

    def restart_shadow(self, rid: str) -> None:
        p = self.h.room(rid)
        s = self.room_cfg(p)
        s["mode"], s["shadow_since"] = "smart", time.time()
        self.h.store[rid] = {**p, "smart": s}
        self.core.save()
        self.h.schedule(rid, 0.1)

    def reset(self, rid: str) -> None:
        for k in ("models", "pi", "log", "guards", "shadow", "manual"):
            self.d[k].pop(rid, None)
        self.habits.d["prof"].pop(rid, None)
        self.habits.d["prof"].pop(f"w:{rid}", None)
        self.habits.d.get("air", {}).pop(rid, None)
        self.forget(rid)
        self._samp.pop(rid, None)
        self._sugg = None
        self.core.data.get("runtime", {}).get("heat_rate", {}).pop(rid, None)
        self.save()
        self.habits.save()

    async def assistant(self) -> dict[str, Any]:
        """Everything the heating assistant needs: rooms with thermostats, writable valves, areas, energy."""
        try:
            await self.core.sim.read_floorplan()
            self._areas = dict((getattr(self.core.sim, "_floor", {}) or {}).get("areas") or {})
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Grundriss: %s", err)
        prefs = await self.energy.refresh_prefs(force=True)
        rooms = []
        for rid, room in self.core.rooms.items():
            therms = self.core.inventory.in_room("climate", rid)
            if not therms:
                continue
            p = self.h.room(rid)
            c = self.room_cfg(p)
            rooms.append(
                {
                    "id": rid,
                    "name": room["name"],
                    "thermostats": therms,
                    "has_temp": any(self.hass.states.get(e) and self.hass.states.get(e).attributes.get("current_temperature") is not None for e in therms),  # type: ignore[union-attr]
                    "valves": {e: w for e in therms if (w := self.writable(e))},
                    "area": self.area(rid),
                    "area_from_plan": rid in self._areas,
                    "comfort": preset_comfort(room["name"]),
                    "on": p["on"],
                    "mode": c["mode"],
                    "style": c["style"],
                    "building": c.get("building", "unknown"),
                    "own": p.get("own", []),
                    "windows": bool(self.habits.windows(rid)),
                    "kind": self.kind(rid),
                    "temps": p["temps"],
                    "senses": bool(room.get("presence") or room.get("motion") or room.get("door_logic")),
                }
            )
        m = self.energy.meter()
        dflt = self.h.defaults()
        return {"rooms": rooms, "energy": {"detected": prefs, "meter": m, "config": self.energy.cfg()}, "guard": self.gcfg()["guard"], "airing": self.gcfg()["airing"], "style": dflt["style"]["style"], "building": dflt["building"]["building"], "wake": self.habits.view()["wake"], "setup_done": self.gcfg()["setup_done"], "persons": len(self.core.inventory.persons)}


GUARD_TEXT = {
    "max": "Grenze: nie über {got} (wollte {wanted})",
    "min": "Grenze: nie unter {got} (wollte {wanted})",
    "never": "Grenze: in dieser Zeit nicht heizen ({got} statt {wanted})",
    "occupied": "Grenze: jemand im Raum, mindestens {got}",
}


def preset_comfort(name: str) -> float:
    """Sensible comfort temperatures by room name (bath warmer, bedroom cooler)."""
    n = name.lower()
    if any(w in n for w in ("bad", "bath", "dusch")):
        return 22.0
    if any(w in n for w in ("schlaf", "bed")):
        return 18.0
    if any(w in n for w in ("kinder", "kids", "baby")):
        return 20.0
    if any(w in n for w in ("küche", "kuche", "kitchen")):
        return 19.5
    if any(w in n for w in ("flur", "diele", "hall", "gang", "treppe", "abstell", "keller", "wc")):
        return 17.0
    if any(w in n for w in ("arbeit", "büro", "buero", "office")):
        return 20.5
    return 21.0
