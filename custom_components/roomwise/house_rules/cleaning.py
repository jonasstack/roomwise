"""Robot vacuum quiet time: while a linked vacuum cleans (and a few minutes after), motion and presence sensors
that start to detect something do not count. No false alarm, no lights for the robot, no "room occupied".

Sensors that already detected someone before the robot started keep counting: people at home stay seen.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers.event import async_call_later, async_track_state_change_event

from .i18n import tr

# i18n: complete

if TYPE_CHECKING:
    from .core import HouseRules

BUSY = ("cleaning", "returning")
KINDS = ("motion", "presence", "zone")


def default_cleaning() -> dict[str, Any]:
    return {"on": False, "vacuums": [], "sensors": "all", "after": 2}


class Cleaning:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.since: float | None = None  # cleaning started
        self.until: float | None = None  # quiet time ends (after the robot is back)
        self._unsub: list[Callable[[], None]] = []
        self._timer: CALLBACK_TYPE | None = None
        self._listeners: list[Callable[[], None]] = []
        self._logged: set[str] = set()

    @property
    def config(self) -> dict[str, Any]:
        cfg = self.core.data.setdefault("cleaning", default_cleaning())
        for k, v in default_cleaning().items():
            cfg.setdefault(k, v)
        return cfg

    def save(self, raw: dict[str, Any]) -> None:
        cfg = self.config
        if isinstance(raw.get("on"), bool):
            cfg["on"] = raw["on"]
        if isinstance(raw.get("vacuums"), list):
            cfg["vacuums"] = [v for v in raw["vacuums"] if isinstance(v, str) and v.startswith("vacuum.")][:5]
        s = raw.get("sensors")
        if s == "all" or isinstance(s, list):
            cfg["sensors"] = "all" if s == "all" else [x for x in s if isinstance(x, str)][:100]
        if isinstance(raw.get("after"), (int, float)):
            cfg["after"] = int(max(0, min(60, raw["after"])))
        self.core.save()
        self.start()
        self.core.push("cleaning")

    # ------------------------------------------------------------------ runtime
    def start(self) -> None:
        self.stop()
        vacs = self.config["vacuums"] if self.config.get("on") else []
        if not vacs:
            self.since = self.until = None
            return
        self._unsub.append(async_track_state_change_event(self.hass, vacs, self._changed))
        busy = [v for v in vacs if (st := self.hass.states.get(v)) and st.state in BUSY]
        if busy and self.since is None:
            self.since = min(st.last_changed.timestamp() for v in busy if (st := self.hass.states.get(v)))

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()
        if self._timer:
            self._timer()
            self._timer = None

    def add_listener(self, cb: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb) if cb in self._listeners else None

    @callback
    def _changed(self, _event: Event[EventStateChangedData]) -> None:
        busy = any((st := self.hass.states.get(v)) and st.state in BUSY for v in self.config["vacuums"])
        if busy:
            if self.since is None:
                self.since = time.time()
                self._logged.clear()
                self.core.history.add("skipped", tr(self.core, "home.vacuum_cleaning"), tr(self.core, "home.vacuum_cleaning_why"))
            self.until = None
            if self._timer:
                self._timer()
                self._timer = None
        elif self.since is not None and self.until is None:
            after = int(self.config.get("after", 2)) * 60
            self.until = time.time() + after
            self._timer = async_call_later(self.hass, after + 1, self._done)
        self._notify()

    @callback
    def _done(self, _now: Any = None) -> None:
        self._timer = None
        self.since = self.until = None
        self.core.history.add("skipped", tr(self.core, "home.vacuum_done"), tr(self.core, "home.vacuum_done_why"))
        self._notify()

    def _notify(self) -> None:
        for cb in list(self._listeners):
            cb()
        self.core.push("cleaning")

    @property
    def active(self) -> bool:
        return self.since is not None and (self.until is None or time.time() < self.until)

    def ignores(self, entity_id: str, state: State | None = None) -> bool:
        """True if this sensor's detection is probably the robot: it started detecting while the robot cleans."""
        if not self.active or not self.config.get("on"):
            return False
        sel = self.config.get("sensors", "all")
        dev = self.core.inventory.devices.get(entity_id)
        if sel == "all":
            if not dev or dev["kind"] not in KINDS:
                return False
        elif entity_id not in sel:
            return False
        st = state or self.hass.states.get(entity_id)
        return bool(st and st.state == "on" and self.since is not None and st.last_changed.timestamp() >= self.since - 1)

    def note(self, entity_id: str, what: str) -> None:
        """One line in the history per sensor and cleaning run."""
        if entity_id in self._logged:
            return
        self._logged.add(entity_id)
        name = self.core.inventory.devices.get(entity_id, {}).get("name", entity_id)
        self.core.history.add("skipped", tr(self.core, "home.ignored", name=name), tr(self.core, "home.ignored_why", what=what), entity_id=entity_id)

    def view(self) -> dict[str, Any]:
        return {**self.config, "active": self.active, "since": self.since, "until": self.until}
