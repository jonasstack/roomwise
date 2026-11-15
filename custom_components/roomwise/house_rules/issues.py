"""Hints in Home Assistant's Repairs panel (Einstellungen → Reparaturen) for real problems Hausregeln detects.

  * a device used by an active rule or a switched-on part (plans, alarm, window warning …) no longer exists
    → fixable: replace it everywhere with another device (repairs.py)
  * such a device has been unavailable for more than 24 hours (counted across restarts) → fixable the same way
  * a notify service the alarm sends to is gone
  * the alarm is on but nobody would get a message
  * a heating plan is on for a room without any thermostat
  * a dashboard uses the floor plan card, but nothing loads it (companion integration not set up, no resource)

Checked shortly after start, after registry changes and saves (debounced) and every 30 minutes. Every hint
disappears by itself once the problem is gone; nothing here changes the user's setup.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.event import async_call_later, async_track_time_interval

from .backup import collect, exists, sections_of
from .const import INTEGRATION

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)
# hints of roomwise that are not Hausregeln's (the card part, migrate.py): never cleared here
OTHER_ISSUES = ("frontend_missing", "old_integrations")

UNAVAILABLE_HOURS = 24
CHECK_EVERY = 30 * 60
PANEL = "/hausregeln"
CARD = "custom:floorplan-card"


def _join(items: list[str], n: int = 3) -> str:
    return ", ".join(items[:n]) + (" …" if len(items) > n else "")


class Issues:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._timer: CALLBACK_TYPE | None = None
        self._unsubs: list[Callable[[], None]] = []
        self._card_cache: tuple[float, bool] | None = None
        # issue id → what the fix flow needs (repairs.py); only ids raised by this run
        self.active: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self.stop()
        self._unsubs.append(async_track_time_interval(self.hass, self._interval, timedelta(seconds=CHECK_EVERY)))
        self._unsubs.append(self.hass.bus.async_listen("lovelace_updated", self._dashboard_saved))
        self.schedule(20)

    def stop(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()
        if self._timer:
            self._timer()
            self._timer = None

    @callback
    def schedule(self, delay: float = 10) -> None:
        """Check again soon (many saves in a row: once)."""
        if self._timer:
            self._timer()
        self._timer = async_call_later(self.hass, delay, self._run)

    @callback
    def _interval(self, _now: Any) -> None:
        self._card_cache = None
        self.hass.async_create_background_task(self.check(), "house_rules_issues")

    @callback
    def _run(self, _now: Any) -> None:
        self._timer = None
        self.hass.async_create_background_task(self.check(), "house_rules_issues")

    # ------------------------------------------------------------------ the checks
    async def check(self) -> dict[str, dict[str, Any]]:
        """Raises what is wrong now, removes what was raised before and is fine again. → the active issues."""
        found: dict[str, dict[str, Any]] = {}
        try:
            self._entities(found)
            self._alarm(found)
            self._heating(found)
            if await self._card_not_loaded():
                found["card_not_loaded"] = {"key": "card_not_loaded", "placeholders": {}}
        except Exception:  # noqa: BLE001 — a hint must never break Hausregeln
            _LOGGER.exception("Hausregeln: checking for problems failed")
            return self.active
        reg = ir.async_get(self.hass)
        for (domain, issue_id), _issue in list(reg.issues.items()):
            if domain == INTEGRATION and issue_id not in found and issue_id not in OTHER_ISSUES:
                ir.async_delete_issue(self.hass, INTEGRATION, issue_id)
        for issue_id, f in found.items():
            ir.async_create_issue(
                self.hass,
                INTEGRATION,
                issue_id,
                is_fixable=bool(f.get("fixable")),
                is_persistent=False,
                severity=ir.IssueSeverity.ERROR if f.get("error") else ir.IssueSeverity.WARNING,
                translation_key=f["key"],
                translation_placeholders={"panel": PANEL, **f["placeholders"]},
                data=f.get("data"),
            )
        self.active = found
        return found

    def _used(self) -> dict[str, list[str]]:
        """Entities that matter right now: enabled rules and the parts that are switched on."""
        core = self.core
        data = sections_of(core)
        data["rules"] = [r for r in data["rules"] if r.get("enabled", True)]
        off = {
            "light": not core.feature("light"),
            "heating": not core.feature("heating"),
            "alarm": not core.feature("alarm"),
            "window_warning": not core.feature("window_warning"),
            "mode_auto": not core.feature("mode_auto"),
            "cleaning": not core.feature("vacuum"),
            "vacation": not core.feature("vacation"),
        }
        for key, is_off in off.items():
            if is_off:
                data.pop(key, None)
        if "light" in data:
            data["light"] = {rid: p for rid, p in data["light"].items() if isinstance(p, dict) and p.get("on")}
        if "heating" in data:
            data["heating"]["rooms"] = {rid: p for rid, p in data["heating"]["rooms"].items() if isinstance(p, dict) and p.get("on")}
        # own device settings and the resident list are harmless when a device is gone
        return collect(core, data, skip=("setup", "dismissed", "devices", "settings", "features", "behaviours"))

    def _entities(self, found: dict[str, dict[str, Any]]) -> None:
        hass = self.hass
        runtime = self.core.data.setdefault("runtime", {})
        since: dict[str, float] = runtime.setdefault("unavailable_since", {})
        now = time.time()
        seen: set[str] = set()
        for eid, where in self._used().items():
            if eid.startswith(("zone.home", "sun.")):
                continue
            placeholders = {"entity_id": eid, "used_in": _join(where)}
            if not exists(hass, eid):
                found[f"missing_{eid}"] = {"key": "entity_missing", "placeholders": placeholders, "fixable": True, "data": placeholders}
                continue
            st = hass.states.get(eid)
            if st is None or st.state != "unavailable":
                continue
            seen.add(eid)
            first = min(since.get(eid, now), st.last_changed.timestamp())
            since[eid] = first
            hours = (now - first) / 3600
            if hours >= UNAVAILABLE_HOURS:
                found[f"unavailable_{eid}"] = {
                    "key": "entity_unavailable",
                    "placeholders": {**placeholders, "hours": str(int(hours))},
                    "fixable": True,
                    "data": {**placeholders, "hours": str(int(hours))},
                }
        for eid in [e for e in since if e not in seen]:
            del since[eid]

    def _alarm(self, found: dict[str, dict[str, Any]]) -> None:
        alarm = self.core.alarm
        cfg = alarm.config
        if not cfg.get("enabled"):
            return
        ch = cfg.get("channels") or {}
        services = set(self.hass.services.async_services_for_domain("notify"))
        svc = ch.get("services") or {}
        gone = [s for s in svc.get("list", []) if s not in services] if svc.get("on") else []
        if gone:
            found["alarm_notify_missing"] = {"key": "alarm_notify_missing", "placeholders": {"services": _join([f"notify.{s}" for s in gone], 5)}}
        phones = alarm._phones("triggered")  # noqa: SLF001 — the same list the alarm sends to
        reach = bool(phones) or any(
            (c := ch.get(k) or {}).get("on") and c.get(field)
            for k, field in (("email", "to"), ("telegram", "users"), ("signal", "numbers"))
        ) or bool(svc.get("on") and [s for s in svc.get("list", []) if s in services])
        if not reach:
            found["alarm_no_target"] = {"key": "alarm_no_target", "placeholders": {}, "error": True}

    def _heating(self, found: dict[str, dict[str, Any]]) -> None:
        core = self.core
        if not core.feature("heating"):
            return
        h = core.heating
        for rid in list(h.store):
            if rid not in core.rooms:
                continue
            p = h.room(rid)
            if p.get("on") and not h.thermostats(rid, p):
                found[f"heating_no_thermostat_{rid}"] = {"key": "heating_no_thermostat", "placeholders": {"room": str(core.rooms[rid].get("name") or rid)}}

    async def _card_not_loaded(self) -> bool:
        """A dashboard shows the floor plan card, but neither its companion integration nor a resource loads it."""
        if self.hass.data.get("floorplan_card") is not None:
            return False
        try:
            from homeassistant.components.lovelace.const import LOVELACE_DATA  # noqa: PLC0415

            ld = self.hass.data.get(LOVELACE_DATA)
        except ImportError:
            ld = None
        if ld is None:
            return False
        # reading every dashboard is the expensive part: remembered until a dashboard is saved (or 30 min)
        if self._card_cache and time.time() - self._card_cache[0] < CHECK_EVERY:
            used = self._card_cache[1]
        else:
            used = False
            for board in list(getattr(ld, "dashboards", {}).values()):
                try:
                    cfg = await board.async_load(False)
                except Exception:  # noqa: BLE001 — YAML dashboards, empty ones …
                    continue
                if CARD in str(cfg):
                    used = True
                    break
            self._card_cache = (time.time(), used)
        if not used:
            return False
        res = getattr(ld, "resources", None)
        try:
            if res is not None and not getattr(res, "loaded", True):
                await res.async_load()
            items = res.async_items() if res is not None else []
        except Exception:  # noqa: BLE001
            items = []
        return not any("floorplan-card" in str(i.get("url", "")) or "floorplan_card" in str(i.get("url", "")) for i in items or [])

    @callback
    def _dashboard_saved(self, _event: Any) -> None:
        self._card_cache = None
        self.schedule(5)

    # ------------------------------------------------------------------ fixing
    def replace_entity(self, old: str, new: str) -> None:
        """Repairs: put another device wherever the missing / unavailable one was used."""
        self.core.replace_entities({old: new})
        self.core.data.get("runtime", {}).get("unavailable_since", {}).pop(old, None)
        self.schedule(2)
