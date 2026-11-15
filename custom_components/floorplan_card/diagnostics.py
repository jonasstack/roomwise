"""Diagnostics download (Einstellungen → Geräte & Dienste → Grundriss-Karte → Diagnose herunterladen).

Meant to be attached to a GitHub issue, so nothing private stays in it: names, texts, notification targets and
announcement texts are replaced by "**REDACTED**"; every entity id, area, person and device name of this home by
a stable pseudonym (e.g. "binary_sensor.3fa1c2"), so the structure still shows. The vacuums' learned map and
trails (they draw the home's layout) are reduced to counts, and so are the shared floor plans and trace images. Of the Wi-Fi networks only their number is kept.
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

REDACT = {"name", "n", "names", "text", "texts", "title", "message", "done_label", "service", "targets", "person", "and", "language"}
_ENTITY = re.compile(r"\b([a-z_]+)\.([a-z0-9_]+)\b")


def _pseudonymize(hass: HomeAssistant, x: Any) -> Any:
    """Entity ids and names of areas, devices, persons and zones → short stable hashes."""
    entities = set(hass.states.async_entity_ids()) | {e.entity_id for e in er.async_get(hass).entities.values()}
    words: dict[str, str] = {}
    h = lambda kind, v: f"{kind}_{hashlib.sha256(v.encode()).hexdigest()[:6]}"  # noqa: E731
    for a in ar.async_get(hass).areas.values():
        words[a.id] = words[a.name] = h("area", a.id)
    for d in dr.async_get(hass).devices.values():
        for n in (d.name, d.name_by_user):
            if n:
                words[n] = h("device", d.id)
    for st in hass.states.async_all(("person", "zone")):
        words[st.object_id] = h(st.domain, st.object_id)
        if fn := st.attributes.get("friendly_name"):
            words[str(fn)] = h(st.domain, st.object_id)
    keys = sorted((w for w in words if len(w) >= 2), key=len, reverse=True)
    rx = re.compile(r"(?<![\w])(" + "|".join(re.escape(k) for k in keys) + r")(?![\w])") if keys else None

    def text(s: str) -> str:
        s = _ENTITY.sub(lambda m: f"{m.group(1)}.{hashlib.sha256(m.group(0).encode()).hexdigest()[:6]}" if m.group(0) in entities else m.group(0), s)
        return rx.sub(lambda m: words[m.group(1)], s) if rx else s

    def walk(v: Any) -> Any:
        if isinstance(v, dict):
            return {text(k) if isinstance(k, str) else k: walk(w) for k, w in v.items()}
        if isinstance(v, list):
            return [walk(w) for w in v]
        return text(v) if isinstance(v, str) else v

    return walk(x)


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    data = hass.data.get(DOMAIN)
    out: dict[str, Any] = {
        "version": VERSION,
        "ha_version": HA_VERSION,
        "loaded": data is not None,
        "frontend_served": bool(hass.data.get(f"{DOMAIN}_frontend")),
        "house_rules": "house_rules" in hass.config.components,
    }
    if data is None:
        return out
    cards = {}
    for card_id, card in data.cards.items():
        cards[card_id] = {
            "entry_alert": card.get("entry_alert"),
            "entry_alert_state": (data.alert_state(card_id) or {}).get("phase") if card.get("entry_alert") else None,
            "pets": card.get("pets") or [],
            "vacuums": card.get("vacuums") or [],
        }
    out |= {
        "cards": cards,
        "vacuums": {
            entity: {"learned_keys": sorted(v.keys()) if isinstance(v, dict) else [], "runs": v.get("runs") if isinstance(v, dict) else None, "trail_points": len((data.paths.get(entity) or {}).get("points", []) if isinstance(data.paths.get(entity), dict) else [])}
            for entity, v in data.learned.items()
        },
        "plans": [{k: s[k] for k in ("rev", "floors", "rooms")} for s in data.plans.summaries()],
        "images": {"count": len(data.plans.images), "bytes": sum(i.get("bytes", 0) for i in data.plans.images.values())},
        # Wi-Fi for the QR codes: how many networks, never names, SSIDs or passwords
        "wifi": data.wifi.summary(),
        # song recognition: whether it is set up, never the key or what was played
        "songs": {"api_key_set": bool(data.song_options()[0]), "own_server": bool((entry.options or {}).get("acoustid_url")), "devices": len(data.songs)},
    }
    return _pseudonymize(hass, async_redact_data(out, REDACT))
