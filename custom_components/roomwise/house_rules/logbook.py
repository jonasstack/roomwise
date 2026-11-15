"""Hausregeln in Home Assistant's logbook: a rule ran (and what it switched), and the lines Hausregeln marks as
worth it there (history.add(…, logbook=…)): alarm, window warning, heating and light plan decisions, the automatic
house mode. Everything else (skipped runs, tests, small adjustments) stays in Hausregeln's own history."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from homeassistant.components.logbook import LOGBOOK_ENTRY_ENTITY_ID, LOGBOOK_ENTRY_MESSAGE, LOGBOOK_ENTRY_NAME
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .const import EVENT_FIRED, EVENT_LOGBOOK, INTEGRATION
from .i18n import tr

# i18n: complete

NAME = "Hausregeln"


@callback
def async_describe_events(hass: HomeAssistant, async_describe_event: Callable[[str, str, Callable[[Event], dict[str, Any]]], None]) -> None:
    @callback
    def describe_fired(event: Event) -> dict[str, Any]:
        d = event.data
        what = ", ".join(str(t) for t in (d.get("what") or []))[:300]
        why = str(d.get("why") or "")
        out = {LOGBOOK_ENTRY_NAME: str(d.get("name") or NAME), LOGBOOK_ENTRY_MESSAGE: tr(hass, "rel.lb_ran", what=what, why=why).strip() if what else why or tr(hass, "rel.lb_ran_plain")}
        # the rule's own switch: the logbook links the line to it
        if eid := er.async_get(hass).async_get_entity_id("switch", INTEGRATION, f"rule_{d.get('rule_id')}"):
            out[LOGBOOK_ENTRY_ENTITY_ID] = eid
        return out

    @callback
    def describe_line(event: Event) -> dict[str, Any]:
        d = event.data
        what, why = str(d.get("what") or ""), str(d.get("why") or "")
        out = {LOGBOOK_ENTRY_NAME: NAME, LOGBOOK_ENTRY_MESSAGE: f"{what} – {why}" if why else what}
        if d.get("entity_id"):
            out[LOGBOOK_ENTRY_ENTITY_ID] = d["entity_id"]
        return out

    async_describe_event(INTEGRATION, EVENT_FIRED, describe_fired)
    async_describe_event(INTEGRATION, EVENT_LOGBOOK, describe_line)
