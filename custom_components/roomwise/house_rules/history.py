"""What happened and why: rule runs, HA automations, changes by hand, skipped runs.
Also keeps when each room was occupied (today and yesterday) for the timeline.
"""

from __future__ import annotations

import time
import uuid
from collections import deque
from typing import TYPE_CHECKING, Any

from homeassistant.core import Context, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import EVENT_LOGBOOK, INTEGRATION, STORAGE_KEY_HISTORY, STORAGE_VERSION
from .i18n import quote, tr

# i18n: complete

if TYPE_CHECKING:
    from .core import HouseRules

MAX_ENTRIES = 400
# a device that reports this long after a call of Hausregeln still reports that call (not a change by hand)
LATE_REPORT = 30
# switchable devices whose changes are worth a line in the history (media players and vacuums change by themselves)
ACTUATOR_KINDS = {"light", "switch", "outlet", "climate", "cover", "fan", "purifier", "lock"}
# Hausregeln's own entities a logbook line can belong to: key → (platform, unique id)
OWN_ENTITIES = {"alarm": ("alarm_control_panel", "alarm"), "window_warning": ("binary_sensor", "window_warning"), "mode": ("select", "house_mode")}


class History:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.entries: deque[dict[str, Any]] = deque(maxlen=MAX_ENTRIES)
        self.occupancy: dict[str, list[list[float | None]]] = {}
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY_HISTORY)
        # context ids created by Hausregeln, and contexts of HA automation runs (id → name)
        self.ours: dict[str, str] = {}
        self.automation_contexts: dict[str, str] = {}
        self._auto_order: deque[str] = deque(maxlen=500)
        # entity → (time, who) of the last change by hand
        self.manual: dict[str, tuple[float, str]] = {}
        # entity → (time, service) of Hausregeln's last call that the device has not reported back yet
        self._sent: dict[str, tuple[float, str]] = {}
        # entity → (time, service, rule id, context id) of Hausregeln's last call to it (not cleared by the first
        # report: a fading lamp reports several steps, some later than 5 s; see addressed_by)
        self._addressed: dict[str, tuple[float, str, str, str]] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        for e in data.get("entries", [])[-MAX_ENTRIES:]:
            self.entries.append(e)
        self.occupancy = data.get("occupancy", {})
        self._trim()

    def _save(self) -> None:
        self._trim()
        self._store.async_delay_save(lambda: {"entries": list(self.entries), "occupancy": self.occupancy}, 15)

    async def async_flush(self) -> None:
        self._trim()
        await self._store.async_save({"entries": list(self.entries), "occupancy": self.occupancy})

    def _trim(self) -> None:
        cutoff = time.time() - 2 * 86400
        for rid in list(self.occupancy):
            self.occupancy[rid] = [s for s in self.occupancy[rid] if s[1] is None or (s[1] or 0) > cutoff][-200:]

    # ------------------------------------------------------------------ entries
    def add(
        self,
        kind: str,
        what: str,
        why: str,
        *,
        rule: dict[str, Any] | None = None,
        automation: str | None = None,
        entity_id: str | None = None,
        logbook: bool | str = False,
        context: Context | None = None,
    ) -> dict[str, Any]:
        """A line in Hausregeln's history. logbook: also a line in Home Assistant's logbook (only for what is worth
        it there: alarm, window warning, heating and light plan decisions); True = for entity_id, or the key of one
        of Hausregeln's own entities (OWN_ENTITIES)."""
        entry = {
            "id": uuid.uuid4().hex[:10],
            "at": dt_util.utcnow().isoformat(),
            "kind": kind,
            "what": what,
            "why": why,
        }
        if rule:
            entry["rule"] = rule["id"]
            entry["rule_name"] = rule.get("name", "")
        if automation:
            entry["automation"] = automation
        if entity_id:
            entry["entity_id"] = entity_id
        self.entries.append(entry)
        self._save()
        self.core.push("history", entry)
        if logbook:
            self._logbook(kind, what, why, self.own_entity(logbook) if isinstance(logbook, str) else entity_id, context)
        return entry

    def own_entity(self, key: str) -> str | None:
        platform, uid = OWN_ENTITIES.get(key, ("", ""))
        return er.async_get(self.hass).async_get_entity_id(platform, INTEGRATION, uid) if platform else None

    def _logbook(self, kind: str, what: str, why: str, entity_id: str | None, context: Context | None) -> None:
        data = {"kind": kind, "what": what[:200], "why": why[:300]}
        if entity_id:
            data["entity_id"] = entity_id
        self.hass.bus.async_fire(EVENT_LOGBOOK, data, context=context)

    def recent(self, limit: int = 120, entity_id: str | None = None) -> list[dict[str, Any]]:
        items = [e for e in reversed(self.entries) if entity_id is None or e.get("entity_id") == entity_id or entity_id in e.get("entities", [])]
        return items[:limit]

    # ------------------------------------------------------------------ occupancy log
    def open_segment(self, rid: str) -> None:
        segs = self.occupancy.setdefault(rid, [])
        if not segs or segs[-1][1] is not None:
            segs.append([time.time(), None])
            self._save()

    def close_segment(self, rid: str) -> None:
        segs = self.occupancy.get(rid)
        if segs and segs[-1][1] is None:
            segs[-1][1] = time.time()
            self._save()

    def today(self, rid: str) -> list[list[float]]:
        """Occupied ranges of today in hours (0–24, local time)."""
        start = dt_util.start_of_local_day().timestamp()
        now = time.time()
        out = []
        for a, b in self.occupancy.get(rid, []):
            b = now if b is None else b
            if b <= start:
                continue
            out.append([round((max(a or start, start) - start) / 3600, 3), round((b - start) / 3600, 3)])
        return out

    # ------------------------------------------------------------------ attribution
    def new_context(self, rule_id: str, parent: Context | None = None) -> Context:
        ctx = Context(parent_id=parent.id if parent else None)
        self.ours[ctx.id] = rule_id
        while len(self.ours) > 2000:
            self.ours.pop(next(iter(self.ours)))
        return ctx

    def is_ours(self, ctx: Context | None) -> bool:
        return bool(ctx and (ctx.id in self.ours or (ctx.parent_id and ctx.parent_id in self.ours)))

    @callback
    def service_called(self, event: Event) -> None:
        """Remembers which devices a service call of Hausregeln addressed: cloud lamps, long transitions and sleepy
        thermostats report the result late, and after 5 s Home Assistant no longer gives that report our context."""
        if not self.is_ours(event.context):
            return
        ids = (event.data.get("service_data") or {}).get("entity_id")
        now = time.time()
        if len(self._sent) > 500:
            self._sent = {e: v for e, v in self._sent.items() if now - v[0] < LATE_REPORT}
        if len(self._addressed) > 500:
            self._addressed = {e: v for e, v in self._addressed.items() if now - v[0] < LATE_REPORT}
        ctx = event.context
        rule = self.ours.get(ctx.id) or self.ours.get(ctx.parent_id or "") or ""
        service = str(event.data.get("service", ""))
        for e in [ids] if isinstance(ids, str) else ids or []:
            self._sent[e] = (now, service)
            self._addressed[e] = (now, service, rule, ctx.id)
            st = self.hass.states.get(e) if e.startswith("light.") else None
            for member in (st.attributes.get("entity_id") or []) if st else []:
                # a light group: its lamps report themselves
                if isinstance(member, str):
                    self._addressed[member] = (now, service, rule, ctx.id)

    def addressed_by(self, entity_id: str, on: bool, within: float) -> tuple[str, str] | None:
        """(rule id, context id) of the Hausregeln call that asked this device for the state it now reports, if that
        was at most `within` seconds ago – a late report or a step of a fade (Home Assistant drops the call's context
        after 5 s, the report then looks like a press at the device)."""
        a = self._addressed.get(entity_id)
        if not a or time.time() - a[0] > within or a[1] not in ("turn_on", "turn_off", "toggle"):
            return None
        if (a[1] == "turn_on" and not on) or (a[1] == "turn_off" and on):
            return None  # the other way round than asked: someone else
        return (a[2], a[3])

    @callback
    def automation_triggered(self, event: Event) -> None:
        self.automation_contexts[event.context.id] = event.data.get("name") or event.data.get("entity_id", "")
        self._auto_order.append(event.context.id)
        if len(self.automation_contexts) > 500:
            self.automation_contexts.pop(self._auto_order.popleft(), None)

    @callback
    def state_changed(self, event: Event[EventStateChangedData]) -> None:
        """Log changes of switchable devices that did not come from a house rule."""
        new = event.data["new_state"]
        old = event.data["old_state"]
        if not new or not old or new.state == old.state or new.state in ("unavailable", "unknown") or old.state in ("unavailable", "unknown"):
            return
        if new.domain == "vacuum":
            if new.state == "cleaning":
                self.core.mark_cleaned(new.entity_id)
            return
        dev = self.core.inventory.devices.get(new.entity_id)
        if not dev or dev["kind"] not in ACTUATOR_KINDS:
            return
        ctx = new.context
        sent = self._sent.pop(new.entity_id, None)
        if self.is_ours(ctx):
            return
        if sent and time.time() - sent[0] < LATE_REPORT and (sent[1] != "turn_off" or new.state == "off") and (sent[1] != "turn_on" or new.state != "off"):
            return  # the device reports what Hausregeln sent, but late (HA drops the call's context after 5 s)
        what = f"{dev['name']}: {_state_word(self.core, new.state)}"
        auto = self.automation_contexts.get(ctx.id) or (self.automation_contexts.get(ctx.parent_id) if ctx.parent_id else None)
        if auto:
            self.add("automation", what, tr(self.core, "history.by_automation", name=quote(self.core, auto)), automation=auto, entity_id=new.entity_id)
            return
        if self.core.starting():
            # right after a start: devices come back and other flows switch things – nobody's wish to keep
            self.add("automation", what, tr(self.core, "engine.during_start"), entity_id=new.entity_id)
            return
        if self.core.automation_user(ctx.user_id):
            # another automation system (Node-RED …) logged in as this user: no person
            self.add("automation", what, tr(self.core, "history.by_automation_user", name=self.core.users.get(ctx.user_id or "", "")), entity_id=new.entity_id)
            return
        who = None
        if ctx.user_id:
            user = self.core.users.get(ctx.user_id)
            who = tr(self.core, "history.in_app_user", user=user) if user else tr(self.core, "history.in_app")
        elif ctx.parent_id is None:
            who = tr(self.core, "history.on_device")
        if who:
            self.manual[new.entity_id] = (time.time(), who)
            self.add("manual", what, tr(self.core, "history.by_hand", who=who), entity_id=new.entity_id)


# states with a word of their own in the history ("Flurlicht: an")
STATE_WORDS = ("on", "off", "open", "closed", "playing", "paused", "idle", "heat", "cleaning", "docked", "returning", "locked", "unlocked", "standby")


def _state_word(where: Any, state: str) -> str:
    return tr(where, f"history.state_{state}") if state in STATE_WORDS else state
