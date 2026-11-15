"""Existing Home Assistant automations, read-only: which devices they use and a short summary (German or English)."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .i18n import tr

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

# i18n: complete

# states with a word of their own in the summary (texts/home.json home.native_state_*)
WORDS = ("on", "off", "open", "closed", "home", "not_home", "playing")


def _list(v: Any) -> list[Any]:
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


class Native:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._ent = er.async_get(hass)
        self._dev = dr.async_get(hass)

    def _name(self, eid: str) -> str:
        d = self.core.inventory.devices.get(eid)
        if d:
            return d["name"]
        st = self.hass.states.get(eid)
        return str(st.attributes.get("friendly_name") or eid) if st else eid

    def _entities(self, node: Any) -> list[str]:
        """Every entity id mentioned in a trigger/condition/action (device ids and registry ids resolved)."""
        found: list[str] = []

        def walk(x: Any) -> None:
            if isinstance(x, dict):
                for k, v in x.items():
                    if k == "entity_id":
                        for e in _list(v):
                            if isinstance(e, str):
                                if "." in e:
                                    found.append(e)
                                elif (entry := self._ent.async_get(e)) is not None:  # registry id (device automations)
                                    found.append(entry.entity_id)
                    elif k == "device_id" and "entity_id" not in x:
                        for d in _list(v):
                            if isinstance(d, str):
                                found.extend(en.entity_id for en in er.async_entries_for_device(self._ent, d)[:1])
                    else:
                        walk(v)
            elif isinstance(x, list):
                for i in x:
                    walk(i)

        walk(node)
        return list(dict.fromkeys(found))

    def _trigger_text(self, t: dict[str, Any]) -> str:
        kind = t.get("trigger") or t.get("platform") or ""
        ents = self._entities(t)
        names = ", ".join(self._name(e) for e in ents[:3]) + (" …" if len(ents) > 3 else "")
        c = self.core
        if kind == "time":
            return tr(c, "home.native_at", time=str(t.get("at", "?"))[:5])
        if kind == "time_pattern":
            return tr(c, "home.native_pattern")
        if kind == "sun":
            return tr(c, "home.native_sunset" if t.get("event") == "sunset" else "home.native_sunrise")
        if kind == "state":
            to = _list(t.get("to"))
            if not to:
                return tr(c, "home.native_changes", names=names)
            state = tr(c, f"home.native_state_{to[0]}") if str(to[0]) in WORDS else to[0]
            return tr(c, "home.native_state", names=names, state=state)
        if kind == "device":
            return tr(c, "home.native_event", names=names, what=t.get("type") or tr(c, "home.native_an_event"))
        if kind.endswith((".detected", ".opened", ".started_heating", ".turned_on")) or "." in kind:
            return tr(c, "home.native_event", names=names, what=kind.split(".")[-1].replace("_", " "))
        if kind == "numeric_state":
            return tr(c, "home.native_numeric", names=names)
        return tr(c, "home.native_on", what=kind or tr(c, "home.native_an_event")) + (f" ({names})" if names else "")

    def _action_text(self, a: dict[str, Any]) -> str:
        c = self.core
        if "delay" in a:
            return tr(c, "home.native_wait")
        if "wait_for_trigger" in a or "wait_template" in a:
            return tr(c, "home.native_wait_event")
        if "repeat" in a:
            return tr(c, "home.native_repeat")
        if "if" in a or "choose" in a:
            return tr(c, "home.native_choose")
        svc = a.get("action") or a.get("service") or (f"{a.get('domain')}.{a.get('type')}" if a.get("type") else "")
        ents = self._entities(a)
        names = ", ".join(self._name(e) for e in ents[:3]) + (" …" if len(ents) > 3 else "")
        verb = str(svc).split(".")[-1].replace("_", " ") if svc else tr(c, "home.native_action")
        return f"{names}: {verb}" if names else verb

    def list(self) -> list[dict[str, Any]]:
        try:
            from homeassistant.components.automation import DATA_COMPONENT  # noqa: PLC0415
        except ImportError:
            return []
        comp = self.hass.data.get(DATA_COMPONENT)
        if comp is None:
            return []
        out: list[dict[str, Any]] = []
        for ent in comp.entities:
            cfg = getattr(ent, "raw_config", None) or {}
            st = self.hass.states.get(ent.entity_id)
            triggers = _list(cfg.get("triggers") or cfg.get("trigger"))
            conditions = _list(cfg.get("conditions") or cfg.get("condition"))
            actions = _list(cfg.get("actions") or cfg.get("action"))
            uses: list[dict[str, str]] = []
            for part, kind in ((triggers, "trigger"), (conditions, "condition"), (actions, "action")):
                for e in self._entities(part):
                    uses.append({"entity_id": e, "as": kind})
            c = self.core
            t_txt = f" {tr(c, 'common.or')} ".join(self._trigger_text(t) for t in triggers[:3] if isinstance(t, dict)) or tr(c, "home.native_by_hand")
            a_txt = ", ".join(self._action_text(a) for a in actions[:4] if isinstance(a, dict)) or tr(c, "home.native_no_action")
            summary = tr(c, "home.native_summary_cond" if conditions else "home.native_summary", trigger=t_txt[:1].upper() + t_txt[1:], actions=a_txt)
            out.append(
                {
                    "entity_id": ent.entity_id,
                    "id": cfg.get("id"),
                    "name": (st.attributes.get("friendly_name") if st else None) or cfg.get("alias") or ent.entity_id,
                    "enabled": bool(st and st.state == "on"),
                    "last": st.attributes.get("last_triggered").isoformat() if st and st.attributes.get("last_triggered") else None,
                    "uses": uses,
                    "summary": summary,
                }
            )
        return out
