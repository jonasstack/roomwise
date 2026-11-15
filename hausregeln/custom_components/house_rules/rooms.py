"""Rooms: which sensors belong to a room, and whether someone is in it.

A room is occupied as soon as any of its presence or motion sensors sees someone. It counts as empty
after `empty_after` minutes without anyone. Door logic: someone went in and closed the door → the
room stays occupied until the door opens again. Rooms with only a door contact use the door alone.

Door opens → room briefly occupied (`door_pulse`, any doors of the house, `door_pulse_for` seconds): the light is
already on when someone walks in, before the presence sensor reacts. Nobody seen until then → empty right away.

Dark (`is_dark`): lux below `dark_below` OR the sun below `dark.sun` degrees OR inside the evening window
(`dark.from`–`dark.to`). Bright again only when every source says bright – lux at least `dark.margin` % above
`dark_below`, the sun 3° above its limit, outside the window – for `dark.bright_for` minutes (hysteresis). With
`dark.lux_when` = "lights_off" the lux value only counts while the room's lights are off (sensors that measure
their own light, e.g. presence sensors with a light sensor). Without a light sensor: the sun below the horizon.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.const import STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_state_change_event, async_track_time_interval
from homeassistant.util import dt as dt_util

from .i18n import tr

# i18n: complete

if TYPE_CHECKING:
    from .core import HouseRules

DEFAULTS = {"dark_below": 80, "empty_after": 5, "door_pulse_for": 30}
# the dark signal: sun limit in degrees (None = only without a light sensor: below the horizon), evening window,
# hysteresis (bright again margin % above dark_below, for bright_for minutes), when the lux value counts
DARK_DEFAULTS: dict[str, Any] = {"sun": None, "from": "", "to": "", "margin": 50, "bright_for": 10, "lux_when": "lights_off"}
SUN_MARGIN = 3.0  # degrees above the sun limit before the sun counts as bright again
CONFIG_KEYS = ("presence", "motion", "doors", "zones", "lux", "dark_below", "empty_after", "door_logic", "door_pulse", "door_pulse_for", "dark", "behaviours", "in", "name")


def _hm(s: Any) -> int | None:
    try:
        h, m = (int(x) for x in str(s).split(":")[:2])
    except ValueError:
        return None
    return h * 60 + m if 0 <= h < 24 and 0 <= m < 60 else None


def clean_dark(raw: Any, cur: dict[str, Any] | None = None) -> dict[str, Any]:
    """The dark settings of a room as they are stored (unknown keys dropped, values in range)."""
    out = {**DARK_DEFAULTS, **{k: v for k, v in (cur or {}).items() if k in DARK_DEFAULTS}}
    if not isinstance(raw, dict):
        return out
    if "sun" in raw:
        v = raw["sun"]
        if v is None:
            out["sun"] = None
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out["sun"] = max(-18.0, min(30.0, float(v)))
    for k in ("from", "to"):
        if k in raw:
            v = str(raw[k] or "")[:5]
            out[k] = v if _hm(v) is not None else ""
    for k, lo, hi in (("margin", 0, 500), ("bright_for", 0, 240)):
        if isinstance(raw.get(k), (int, float)) and not isinstance(raw[k], bool):
            out[k] = max(lo, min(hi, raw[k]))
    if raw.get("lux_when") in ("lights_off", "always"):
        out["lux_when"] = raw["lux_when"]
    return out


class RoomTracker:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.rooms: dict[str, dict[str, Any]] = {}
        self.state: dict[str, dict[str, Any]] = {}
        self._unsub: CALLBACK_TYPE | None = None
        self._timers: dict[str, CALLBACK_TYPE] = {}
        self._empty_at: dict[str, float] = {}  # nobody detected any more: the room counts as empty at …
        self._listeners: list[Callable[[str, bool], None]] = []
        # door logic: the door closed while someone was inside
        self._sealed: dict[str, bool] = {}
        # door opens → briefly occupied: until when; rooms the opening alone made occupied (nobody seen yet)
        self._pulse: dict[str, float] = {}
        self._pulse_only: set[str] = set()
        # dark signal with hysteresis: the state, since when every source says bright
        self._dark: dict[str, bool] = {}
        self._bright_since: dict[str, float] = {}
        self._dark_listeners: list[Callable[[str, bool], None]] = []
        self._tick: CALLBACK_TYPE | None = None

    # ------------------------------------------------------------------ config
    def build(self) -> None:
        inv = self.core.inventory
        stored: dict[str, dict[str, Any]] = self.core.data.setdefault("rooms", {})
        rooms: dict[str, dict[str, Any]] = {}
        for aid, area in inv.areas.items():
            ov = stored.get(aid, {})
            presence = inv.in_room("presence", aid)
            motion = inv.in_room("motion", aid)
            doors = inv.in_room("door", aid)
            lux = inv.in_room("illuminance", aid)
            room = {
                "id": aid,
                "name": area["name"],
                "in": area["in"],
                "icon": area["icon"],
                "presence": presence,
                "motion": motion,
                "doors": doors,
                "zones": inv.in_room("zone", aid),
                "lux": lux[0] if lux else None,
                "dark_below": DEFAULTS["dark_below"],
                "empty_after": DEFAULTS["empty_after"],
                "door_logic": not presence and not motion and bool(doors),
                "door_pulse": [],
                "door_pulse_for": DEFAULTS["door_pulse_for"],
                "dark": dict(DARK_DEFAULTS),
                "behaviours": {},
            }
            for k in CONFIG_KEYS:
                if k in ov:
                    room[k] = ov[k]
            room["dark"] = clean_dark(room.get("dark"))
            rooms[aid] = room
        self.rooms = rooms
        self._sealed = {k: v for k, v in self._sealed.items() if k in rooms}

    def sensors(self) -> set[str]:
        out: set[str] = set()
        for r in self.rooms.values():
            out.update(r["presence"], r["motion"], r["doors"], r["zones"], r.get("door_pulse") or [])
            if r.get("lux"):
                out.add(r["lux"])
        return out

    # ------------------------------------------------------------------ runtime
    def start(self) -> None:
        self.stop()
        self.build()
        now = dt_util.utcnow().isoformat()
        log = self.core.history.occupancy
        for rid, room in self.rooms.items():
            prev = self.state.get(rid)
            raw = self._raw(room)
            occupied = raw if prev is None else prev["occupied"] or raw
            # after a restart: an open segment in the log means it was occupied
            if prev is None and not raw:
                segs = log.get(rid, [])
                occupied = bool(segs and segs[-1][1] is None)
            self.state[rid] = prev or {"occupied": occupied, "since": now, "by": self._by(room)}
            if occupied and not raw:
                # restarted after a change of devices or rooms: the "empty after" time runs on, it does not start again
                self._schedule_empty(rid, keep=True)
            else:
                self._empty_at.pop(rid, None)
                if not occupied:
                    self.core.history.close_segment(rid)
        if self.sensors():
            self._unsub = async_track_state_change_event(self.hass, list(self.sensors()), self._changed)
        # the dark signal also changes without a new value (sun, evening window, "bright for 10 minutes")
        self._tick = async_track_time_interval(self.hass, callback(lambda _now: self._update_dark_all()), timedelta(seconds=60))

    def stop(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None
        if self._tick:
            self._tick()
            self._tick = None
        for t in self._timers.values():
            t()
        self._timers.clear()
        # _empty_at stays: a start right after (see start) lets the time run on

    def add_listener(self, cb: Callable[[str, bool], None]) -> Callable[[], None]:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb) if cb in self._listeners else None

    def add_dark_listener(self, cb: Callable[[str, bool], None]) -> Callable[[], None]:
        """cb(room, dark) when a room's dark signal changes (called right after, never inside a check)."""
        self._dark_listeners.append(cb)
        return lambda: self._dark_listeners.remove(cb) if cb in self._dark_listeners else None

    def _on(self, eid: str) -> bool:
        st = self.hass.states.get(eid)
        if st and st.state == STATE_ON and self.core.cleaning.ignores(eid, st):
            return False  # the robot vacuum, not a person
        return bool(st and st.state == STATE_ON)

    def reevaluate(self) -> None:
        """After the robot vacuum is done: look at all rooms again."""
        for rid in list(self.rooms):
            self._evaluate(rid)

    def _raw(self, room: dict[str, Any]) -> bool:
        return any(self._on(e) for e in (*room["presence"], *room["motion"], *room["zones"]))

    def _by(self, room: dict[str, Any]) -> str | None:
        inv = self.core.inventory
        for e in room["zones"]:
            if self._on(e):
                return inv.devices.get(e, {}).get("name")
        for e in (*room["presence"], *room["motion"]):
            if self._on(e):
                return inv.devices.get(e, {}).get("name")
        if room["door_logic"] and self._sealed.get(room["id"]):
            return tr(self.core, "home.door_closed")
        if self._pulsing(room["id"]):
            return tr(self.core, "home.door_opened")
        return None

    def _pulsing(self, rid: str) -> bool:
        return self._pulse.get(rid, 0.0) > time.time()

    @callback
    def _changed(self, event: Event[EventStateChangedData]) -> None:
        eid = event.data["entity_id"]
        new = event.data["new_state"]
        old = event.data["old_state"]
        for rid, room in self.rooms.items():
            if eid in (room.get("door_pulse") or []) and new is not None and old is not None and new.state == STATE_ON and old.state not in (STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN):
                self._door_pulse(rid, room)
            if eid in room["doors"] and room["door_logic"]:
                self._door(rid, room, new.state if new else None, old.state if old else None)
            elif eid in (*room["presence"], *room["motion"], *room["zones"]):
                self._evaluate(rid)
            elif eid == room.get("lux"):
                self._update_dark(rid)
                self.core.push("occupancy")

    def _door_pulse(self, rid: str, room: dict[str, Any]) -> None:
        """A chosen door opened: the room counts as occupied for door_pulse_for seconds."""
        secs = max(1.0, float(room.get("door_pulse_for") or DEFAULTS["door_pulse_for"]))
        if not self.occupied(rid):
            self._pulse_only.add(rid)
        self._pulse[rid] = time.time() + secs
        key = f"pulse:{rid}"
        if t := self._timers.pop(key, None):
            t()

        @callback
        def _end(_now: datetime) -> None:
            self._timers.pop(key, None)
            self._pulse.pop(rid, None)
            self._evaluate(rid)

        self._timers[key] = async_call_later(self.hass, secs + 0.05, _end)
        self._evaluate(rid)

    def _door(self, rid: str, room: dict[str, Any], new: str | None, old: str | None) -> None:
        if new in (None, STATE_UNAVAILABLE, STATE_UNKNOWN) or new == old:
            return
        has_sensor = bool(room["presence"] or room["motion"] or room["zones"])
        st = self.state.get(rid, {})
        if new == STATE_ON:
            # door opens: whoever was inside may leave
            self._sealed[rid] = False
            self._evaluate(rid)
            return
        # door closed
        if has_sensor:
            self._sealed[rid] = self._raw(room) or bool(st.get("occupied"))
        else:
            # without sensors: closing the door behind you means someone is in (was empty before)
            self._sealed[rid] = not st.get("occupied") or bool(self._timers.get(rid))
        self._evaluate(rid)

    def _evaluate(self, rid: str) -> None:
        room = self.rooms.get(rid)
        if not room:
            return
        st = self.state.setdefault(rid, {"occupied": False, "since": dt_util.utcnow().isoformat(), "by": None})
        sensed = self._raw(room) or (room["door_logic"] and self._sealed.get(rid, False))
        if sensed:
            self._pulse_only.discard(rid)  # someone is really there: the usual "empty after" applies
        raw = sensed or self._pulsing(rid)
        if raw:
            if t := self._timers.pop(rid, None):
                t()
            if self._empty_at.pop(rid, None) is not None:
                self.core.push("occupancy")
            by = self._by(room)
            if not st["occupied"]:
                self._set(rid, True, by)
            elif by != st.get("by"):
                st["by"] = by
                self.core.push("occupancy")
        elif st["occupied"] and rid in self._pulse_only:
            # the door opened, but nobody came in: empty again right away (no "empty after")
            self._pulse_only.discard(rid)
            if t := self._timers.pop(rid, None):
                t()
            self._empty_at.pop(rid, None)
            self._set(rid, False, None)
        elif st["occupied"] and rid not in self._timers:
            self._schedule_empty(rid)

    def _schedule_empty(self, rid: str, keep: bool = False) -> None:
        room = self.rooms[rid]
        delay = max(0.0, float(room.get("empty_after", DEFAULTS["empty_after"])) * 60)
        if keep and (at := self._empty_at.get(rid)) is not None:
            delay = min(delay, max(0.0, at - time.time()))

        @callback
        def _empty(_now: datetime) -> None:
            self._timers.pop(rid, None)
            self._empty_at.pop(rid, None)
            if not (self._raw(room) or (room["door_logic"] and self._sealed.get(rid)) or self._pulsing(rid)):
                self._set(rid, False, None)

        self._timers[rid] = async_call_later(self.hass, delay, _empty)
        self._empty_at[rid] = time.time() + delay
        self.core.push("occupancy")

    def _set(self, rid: str, occupied: bool, by: str | None) -> None:
        self.state[rid] = {"occupied": occupied, "since": dt_util.utcnow().isoformat(), "by": by}
        if occupied:
            self.core.history.open_segment(rid)
        else:
            self.core.history.close_segment(rid)
        for cb in list(self._listeners):
            cb(rid, occupied)
        self.core.push("occupancy")

    # ------------------------------------------------------------------ queries
    def occupied(self, rid: str) -> bool:
        return bool(self.state.get(rid, {}).get("occupied"))

    def changed_at(self, rid: str) -> float:
        since = self.state.get(rid, {}).get("since")
        return dt_util.parse_datetime(since).timestamp() if since else time.time()

    def lux(self, rid: str) -> float | None:
        room = self.rooms.get(rid)
        st = self.hass.states.get(room["lux"]) if room and room.get("lux") else None
        try:
            return float(st.state) if st else None
        except ValueError:
            return None

    def _sun_elevation(self) -> float | None:
        sun = self.hass.states.get("sun.sun")
        if not sun:
            return None
        try:
            return float(sun.attributes["elevation"])
        except (KeyError, TypeError, ValueError):
            return -1.0 if sun.state == "below_horizon" else 1.0

    def _lights_on(self, rid: str) -> bool:
        return any((st := self.hass.states.get(e)) is not None and st.state == STATE_ON for e in self.core.inventory.in_room("light", rid))

    def dark_inputs(self, rid: str) -> tuple[bool, bool, list[str]]:
        """(dark now, bright now, which sources say dark): each source on its own, before the hysteresis."""
        room = self.rooms.get(rid) or {}
        cfg = room.get("dark") or DARK_DEFAULTS
        thr = float(room["dark_below"] if room.get("dark_below") is not None else DEFAULTS["dark_below"])
        lux = self.lux(rid)
        why: list[str] = []
        dark, bright = False, True
        if lux is not None:
            if cfg.get("lux_when") == "always" or not self._lights_on(rid):
                if lux < thr:
                    dark = True
                    why.append("lux")
                elif lux < thr * (1 + float(cfg.get("margin", 50)) / 100):
                    bright = False  # between the two limits: stays as it is
            else:
                bright = False  # the room's own light shines on the sensor: its value says nothing
        limit = cfg.get("sun")
        if limit is None and lux is None:
            limit = 0.0  # no light sensor: the sun below the horizon
        if limit is not None and (elev := self._sun_elevation()) is not None:
            if elev < float(limit):
                dark = True
                why.append("sun")
            elif elev < float(limit) + SUN_MARGIN:
                bright = False
        a, b = _hm(cfg.get("from")), _hm(cfg.get("to"))
        if a is not None and b is not None and a != b:
            now = dt_util.now()
            m = now.hour * 60 + now.minute
            if (a <= m < b) if a < b else (m >= a or m < b):
                dark = True
                why.append("time")
        return dark, bright and not dark, why

    def _update_dark(self, rid: str) -> bool:
        dark_now, bright_now, _why = self.dark_inputs(rid)
        was = self._dark.get(rid)
        now = time.time()
        if was is None or dark_now:
            state = dark_now
            self._bright_since.pop(rid, None)
        elif was and bright_now:
            need = float((self.rooms.get(rid, {}).get("dark") or DARK_DEFAULTS).get("bright_for", 10)) * 60
            state = now - self._bright_since.setdefault(rid, now) < need
            if not state:
                self._bright_since.pop(rid, None)
        else:
            state = was
            self._bright_since.pop(rid, None)
        self._dark[rid] = state
        if was is not None and was != state:
            self.core.push("occupancy")
            for cb in list(self._dark_listeners):
                self.hass.loop.call_soon(cb, rid, state)
        return state

    def _update_dark_all(self) -> None:
        for rid in list(self.rooms):
            self._update_dark(rid)

    def is_dark(self, rid: str) -> bool:
        if rid not in self.rooms:
            sun = self.hass.states.get("sun.sun")
            return bool(sun and sun.state == "below_horizon")
        return self._update_dark(rid)

    def dark_view(self, rid: str) -> dict[str, Any]:
        """For the panel: dark or not, which sources say dark now, since when everything says bright."""
        dark = self.is_dark(rid)
        return {"dark": dark, "dark_why": self.dark_inputs(rid)[2], **({"bright_since": self._bright_since[rid]} if rid in self._bright_since else {})}

    def view(self) -> dict[str, Any]:
        # empty_at: nobody is detected any more, the room still counts as occupied until then (the "empty after" time)
        return {rid: {**st, **self.dark_view(rid), **({"empty_at": self._empty_at[rid]} if rid in self._empty_at else {})} for rid, st in self.state.items() if rid in self.rooms}
