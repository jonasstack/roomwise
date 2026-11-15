"""Automatic house mode: for every mode a list of conditions ("Schlafen, wenn nachts und alle zuhause und …").

Order of precedence: Urlaub > Weg > Schlafen > Gäste > Zuhause. The first mode whose conditions all hold
(for the set time) wins; if none holds, the house is "Zuhause" when someone is home.
A mode set by hand stays until the automatic choice changes again.

Optionally a mode has its own end ("end": {on, when, for}): then it does not end as soon as one of its conditions
stops holding, but stays until the end conditions hold (for the set time), e.g. "Schlafen endet, wenn das Bett seit
15 Min. leer ist und es morgens ist". That also ends the mode when it was switched on by hand. End conditions that
already hold when the mode starts count only once they stopped holding in between.

The waiting times ("for") are for starting a mode: the running mode stays as long as its conditions hold without
them, so a restart (all timers from zero, sensors report "changed just now") never ends it, and "Schlafen" also
outlives a short drop-out of a sensor (LEAVE_GRACE, e.g. a bed zone that flickers off for seconds). In the
start-up phase of Home Assistant nothing switches by itself: devices come back one by one.

With "Aufstehen erkennen" (wakeup.py) on, "Schlafen" ends when getting up for the day was detected (or
confirmed), never because a start condition such as "bed occupied" stopped holding during a night trip.
A mode that ended by its own end or by getting up does not start again by itself until its start conditions
stopped holding once. "Gäste" set by hand comes back after the night when "Schlafen" took over from it.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval

from .i18n import tr
from .vocab import seconds

# i18n: complete

if TYPE_CHECKING:
    from .core import HouseRules

ORDER = ["vacation", "away", "sleep", "guests"]
LEAVE_GRACE = {"sleep": 60}  # seconds the running mode's start conditions may fail before it ends (sensor flicker)


def _no_wait(clause: dict[str, Any]) -> dict[str, Any]:
    """The clause without its waiting time: for a mode that already runs."""
    return {k: v for k, v in clause.items() if k != "for"} if clause.get("for") else clause


def default_mode_auto() -> dict[str, Any]:
    return {
        "enabled": True,
        "modes": {
            "away": {"on": True, "when": [{"subject": "person:everyone", "verb": "is_away"}], "for": ""},
            "sleep": {"on": False, "when": [{"subject": "time", "verb": "night"}, {"subject": "person:someone", "verb": "is_home"}], "for": "10m"},
            "guests": {"on": False, "when": [], "for": ""},
            "vacation": {"on": False, "when": [{"subject": "person:everyone", "verb": "is_away", "for": "1d"}], "for": ""},
        },
    }


class ModeAuto:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._unsub: list[Callable[[], None]] = []
        self._since: dict[str, float] = {}  # mode → since when its conditions hold
        self.target: str | None = None
        self.why = ""
        self._manual_target: str | None = None  # automatic choice at the moment of a manual change
        self._ended: str | None = None
        self._end: dict[str, dict[str, Any]] = {}  # mode → {armed, since} while the mode runs and has an end of its own
        self._fail: dict[str, float] = {}  # running mode → since when its start conditions fail (LEAVE_GRACE)
        self._why_next: str | None = None  # the reason for the next automatic change (e.g. getting up was detected)

    @property
    def _rt(self) -> dict[str, Any]:
        """What must outlive a restart: modes held off until their start conditions failed once, the mode to return to."""
        rt = self.core.data.setdefault("runtime", {}).setdefault("mode_auto", {})
        rt.setdefault("hold_off", [])
        return rt

    @property
    def config(self) -> dict[str, Any]:
        cfg = self.core.data.setdefault("mode_auto", default_mode_auto())
        # older installs: "auto_mode" switch in the settings
        if "auto_mode" in self.core.data.get("settings", {}):
            cfg["enabled"] = bool(self.core.data["settings"].pop("auto_mode"))
        for m, v in default_mode_auto()["modes"].items():
            cfg["modes"].setdefault(m, v)
        return cfg

    def save(self, mode: str, raw: dict[str, Any]) -> None:
        cfg = self.config
        if mode == "_enabled":
            cfg["enabled"] = bool(raw.get("enabled"))
        elif mode in ORDER:
            dst = cfg["modes"][mode]
            if isinstance(raw.get("on"), bool):
                dst["on"] = raw["on"]
            if isinstance(raw.get("when"), list):
                dst["when"] = [x for x in (self.core.sanitize_clause(c) for c in raw["when"][:12]) if x]
            if "for" in raw:
                dst["for"] = str(raw.get("for") or "")
            if isinstance(raw.get("end"), dict):
                e = raw["end"]
                cur = dst.get("end") or {"on": False, "when": [], "for": ""}
                if isinstance(e.get("on"), bool):
                    cur["on"] = e["on"]
                if isinstance(e.get("when"), list):
                    cur["when"] = [x for x in (self.core.sanitize_clause(c) for c in e["when"][:12]) if x]
                if "for" in e:
                    cur["for"] = str(e.get("for") or "")
                dst["end"] = cur
        self.core.save()
        self.start()
        self.evaluate()

    # ------------------------------------------------------------------ runtime
    def start(self) -> None:
        self.stop()
        if not self.config.get("enabled", True):
            self.target, self.why = None, tr(self.core, "home.auto_off")
            return  # feature "mode_auto" off: nothing listens
        res = self.core.checker.res
        ents: set[str] = set()
        for m in self.config["modes"].values():
            for c in [*m.get("when", []), *((m.get("end") or {}).get("when") or [])]:
                ents.update(res.entities(c.get("subject", "")))
        ents.update(p["entity_id"] for p in self.core.inventory.persons.values())
        ents.update(self.core.wakeup.entities())
        if ents:
            self._unsub.append(async_track_state_change_event(self.hass, list(ents), callback(lambda _e: self.evaluate())))
        self._unsub.append(self.core.room_tracker.add_listener(lambda _r, _o: self.evaluate()))
        self._unsub.append(async_track_time_interval(self.hass, callback(lambda _now: self.evaluate()), timedelta(seconds=30)))
        self.hass.loop.call_soon(self.evaluate)  # right away, not only after the first 30 s

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()

    def manual(self) -> None:
        """The mode was set by hand: keep it until the automatic choice changes."""
        self._manual_target = self.target
        rt = self._rt
        rt.pop("resume", None)  # a choice by hand: nothing to go back to after the night
        rt["hold_off"] = []

    def hold_off(self, mode: str) -> None:
        """The mode ended (own end, getting up): it does not start by itself until its start conditions failed once."""
        if mode not in self._rt["hold_off"]:
            self._rt["hold_off"].append(mode)
            self.core.save()

    def end_now(self, mode: str, why: str) -> None:
        """Ends the running mode right away (wakeup.py: getting up was detected or confirmed)."""
        self.hold_off(mode)
        self._why_next = why
        self._manual_target = None  # also when "Schlafen" was set by hand
        self.hass.loop.call_soon(self.evaluate)  # not inside the evaluation that asked (wakeup.tick)

    def _holds(self, mode: str) -> tuple[bool, str]:
        m = self.config["modes"].get(mode, {})
        if not m.get("on") or not m.get("when"):
            self._since.pop(mode, None)
            self._fail.pop(mode, None)
            return False, ""
        parts = f" {tr(self.core, 'common.and')} ".join(self.core.describer.clause(c, "only") for c in m["when"])
        check = self.core.checker.holds
        if mode in self._rt["hold_off"]:
            if self.core.mode == mode or all(check(_no_wait(c))[0] for c in m["when"]):
                # still running = being ended right now (getting up was detected: its start conditions fail at the
                # same moment – that must not lift the hold, or the mode would stay); "failed once" counts after it
                return False, ""
            self._rt["hold_off"].remove(mode)  # failed once: may start again (with its waiting times)
            self.core.save()
        if self.core.mode == mode:
            # running: stays while the conditions hold without their waiting times, and over a short drop-out
            if all(check(_no_wait(c))[0] for c in m["when"]):
                self._fail.pop(mode, None)
                self._since.setdefault(mode, time.time())
                return True, parts
            self._since.pop(mode, None)
            failed = self._fail.setdefault(mode, time.time())
            return time.time() - failed < LEAVE_GRACE.get(mode, 0), parts
        self._fail.pop(mode, None)
        for c in m["when"]:
            ok, _now, _w = check(c)
            if not ok:
                self._since.pop(mode, None)
                return False, ""
        since = self._since.setdefault(mode, time.time())
        need = seconds(m.get("for")) or 0
        return time.time() - since >= need, parts

    def _runs_on(self, mode: str) -> tuple[bool, str]:
        """The mode is the current one and has an end of its own that has not come yet: it stays."""
        if mode == "sleep" and self.core.wakeup.ends_sleep():
            # "Aufstehen erkennen" is the end of the night (the own end does not count then)
            self._end.pop(mode, None)
            return self.core.mode == mode and mode not in self._rt["hold_off"], tr(self.core, "home.until_wakeup")
        end = self.config["modes"].get(mode, {}).get("end") or {}
        if not end.get("on") or not end.get("when") or self.core.mode != mode:
            self._end.pop(mode, None)
            return False, ""
        holds = all(self.core.checker.holds(c)[0] for c in end["when"])
        st = self._end.get(mode)
        if st is None:
            # already true at the start (e.g. set by hand while the bed is still empty): wait until it changed once
            st = self._end[mode] = {"armed": not holds, "since": None}
        text = f" {tr(self.core, 'common.and')} ".join(self.core.describer.clause(c, "only") for c in end["when"])
        if not st["armed"]:
            if not holds:
                st["armed"] = True
            return True, tr(self.core, "home.until", text=text)
        if not holds:
            st["since"] = None
            return True, tr(self.core, "home.until", text=text)
        st["since"] = st["since"] or time.time()
        if time.time() - st["since"] >= (seconds(end.get("for")) or 0):
            # the end has come: start conditions must hold anew (with their time), a manual hold no longer counts
            self._end.pop(mode, None)
            self._since.pop(mode, None)
            self._manual_target = None
            self._ended = mode
            self.hold_off(mode)
            return False, ""
        return True, tr(self.core, "home.until", text=text)

    @callback
    def evaluate(self) -> None:
        if not self.config.get("enabled", True):
            self.target, self.why = None, tr(self.core, "home.auto_off")
            return
        self.core.wakeup.tick()
        target, why = None, ""
        self._ended: str | None = None
        for mode in ORDER:
            ok, parts = self._holds(mode)
            if not ok:
                ok, parts = self._runs_on(mode)
            elif self.core.mode == mode:
                self._runs_on(mode)  # keep the end state current (from the start: the end may come any time)
            if ok:
                target, why = mode, parts
                break
        if self._ended and target == self._ended:
            target = None  # ended: not right back in because the start conditions happen to hold (they need their time)
        if target is None:
            someone = any(self.core.inventory.person_home(p) for p in self.core.inventory.persons)
            target, why = ("home", tr(self.core, "home.someone_home")) if someone else (None, "")
        rt = self._rt
        cur = self.core.mode
        if target == "sleep" and cur == "sleep" and self.core.wakeup.ends_sleep():
            why = tr(self.core, "home.until_wakeup")  # what ends it now: getting up, not the start conditions
        if target == "home" and rt.get("resume") and cur in ("sleep", rt["resume"]):
            target, why = rt["resume"], tr(self.core, "home.resume", mode=self.core.mode_label(rt["resume"]))
        elif target not in ("sleep", "home", None) or (target == "home" and cur == "home"):
            rt.pop("resume", None)
        changed = target != self.target
        self.target, self.why = target, why
        if changed:
            self.core.push("mode_auto")
        if target is None or target == cur:
            self._why_next = None
            return
        if self.core.starting():
            return  # devices come back one by one: nothing switches by itself before the start-up phase is over
        if self._manual_target is not None and target == self._manual_target:
            return  # set by hand, nothing new since then
        self._manual_target = None
        if target == "sleep" and cur == "guests":
            rt["resume"] = "guests"  # the guests stay overnight: after the night the house is "Gäste" again
        text = self._why_next or (tr(self.core, "home.because", why=why) if why else tr(self.core, "home.automatic"))
        self._why_next = None
        self.hass.async_create_task(self.core.auto_mode(target, text))

    def view(self) -> dict[str, Any]:
        return {
            **self.config,
            "target": self.target,
            "why": self.why,
            "held": self._manual_target is not None and self.target != self.core.mode,
            "wakeup": self.core.wakeup.view(),
        }
