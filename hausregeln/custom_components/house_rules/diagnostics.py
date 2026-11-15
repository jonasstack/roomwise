"""Diagnostics download (Einstellungen → Geräte & Dienste → Hausregeln → Diagnose herunterladen).

Meant to be attached to a GitHub issue, so nothing private stays in it:
  * secrets and free text are replaced by "**REDACTED**" (PIN hashes, passkeys, API keys, URLs, SMTP and
    messenger accounts, rule and room names, messages, spoken texts);
  * every entity id, area, person, zone and device name of this home is replaced by a stable pseudonym
    (e.g. "light.e3b0c4", "area_9f86d0"), so the structure (which rule uses which device) still shows.
The download stays on the user's computer until they attach it somewhere themselves.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er

from .const import DOMAIN, VERSION

# keys whose values are secret or free text
REDACT = {
    "name", "names", "title", "message", "messages", "text", "texts", "sentence", "why", "note", "label",
    "code", "code_hash", "pin", "salt", "hash", "key", "api_key", "apikey", "token", "secret", "password", "user", "username",
    "email", "phone", "chat_id", "url", "base_url", "host", "server", "sender", "recipient", "recipients", "from_addr",
    "latitude", "longitude", "location", "credential", "credentials", "credential_id", "public_key", "devices", "ollama",
    "created_by", "by", "install_id", "tts",
}
_ENTITY = re.compile(r"\b([a-z_]+)\.([a-z0-9_]+)\b")


class Pseudonymizer:
    """Replaces identifiers of this home by short stable hashes (same input → same pseudonym within one file)."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.entities = set(hass.states.async_entity_ids()) | {e.entity_id for e in er.async_get(hass).entities.values()}
        words: dict[str, str] = {}
        for a in ar.async_get(hass).areas.values():
            words[a.id] = self._h("area", a.id)
            words[a.name] = self._h("area", a.id)
        for d in dr.async_get(hass).devices.values():
            for n in (d.name, d.name_by_user):
                if n:
                    words[n] = self._h("device", d.id)
        for st in hass.states.async_all(("person", "zone")):
            words[st.object_id] = self._h(st.domain, st.object_id)
            if fn := st.attributes.get("friendly_name"):
                words[str(fn)] = self._h(st.domain, st.object_id)
        # longest first, whole words only (a room "bad" must not touch "badge")
        keys = sorted((w for w in words if len(w) >= 2), key=len, reverse=True)
        self._words = words
        self._re = re.compile(r"(?<![\w])(" + "|".join(re.escape(k) for k in keys) + r")(?![\w])") if keys else None

    @staticmethod
    def _h(kind: str, value: str) -> str:
        return f"{kind}_{hashlib.sha256(value.encode()).hexdigest()[:6]}"

    def text(self, s: str) -> str:
        s = _ENTITY.sub(lambda m: f"{m.group(1)}.{hashlib.sha256(m.group(0).encode()).hexdigest()[:6]}" if m.group(0) in self.entities else m.group(0), s)
        if self._re:
            s = self._re.sub(lambda m: self._words[m.group(1)], s)
        return s

    def walk(self, x: Any) -> Any:
        if isinstance(x, dict):
            return {self.text(k) if isinstance(k, str) else k: self.walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [self.walk(v) for v in x]
        if isinstance(x, str):
            return self.text(x)
        return x


def _alarm(core: Any) -> dict[str, Any]:
    """The alarm settings without PIN hash, passkeys and messenger / mail accounts (only which channel is on)."""
    cfg = {k: v for k, v in core.alarm.public_config().items() if k not in ("channels", "devices")}
    cfg["channels"] = {k: bool(v.get("on")) for k, v in (core.alarm.config.get("channels") or {}).items() if isinstance(v, dict)}
    cfg["devices"] = len(core.alarm.config.get("devices") or [])
    return cfg


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    core = hass.data.get(DOMAIN)
    out: dict[str, Any] = {"version": VERSION, "ha_version": HA_VERSION, "loaded": core is not None, "entry": {"version": entry.version, "options": dict(entry.options)}}
    if core is None:
        return out
    data = core.data
    inv = core.inventory
    kinds: dict[str, int] = {}
    for d in inv.devices.values():
        kinds[d["kind"]] = kinds.get(d["kind"], 0) + 1
    out |= {
        "features": core.features.view(),
        "setup": {k: v for k, v in core.setup.view().items() if k != "answers"},
        "mode": core.mode,
        "counts": {
            "rules": len(core.rules()),
            "groups": len(data.get("groups", [])),
            "rooms": len(core.rooms),
            "devices": len(inv.devices),
            "persons": len(inv.persons),
            "history": len(core.history.recent(1000)),
        },
        "device_kinds": kinds,
        "rules": [{k: v for k, v in r.items() if k not in ("name",)} for r in core.rules()],
        "groups": data.get("groups", []),
        "rooms": data.get("rooms", {}),
        "plans": data.get("plans", {}),
        "alarm": {"config": _alarm(core), "state": core.alarm.view().get("state")},
        "mode_auto": data.get("mode_auto", {}),
        "cleaning": data.get("cleaning", {}),
        "heating": data.get("heating", {}),
        "window_warning": core.window_warning.view().get("config", {}),
        "settings": {k: v for k, v in data.get("settings", {}).items() if k != "ollama"},
        "ai": {"provider": core.ai.public().get("provider"), "model": core.ai.public().get("model"), "connected": core.ai.connected},
        "telemetry": core.telemetry.view(False),
        "recent_errors": core.telemetry.recent,
    }
    return Pseudonymizer(hass).walk(async_redact_data(out, REDACT))
