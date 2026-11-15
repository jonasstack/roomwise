"""Page layout of the panel, kept with the settings ("ui"): own rule groups, the order of the room tiles and which
rooms a page leaves out. Only for the display: nothing here changes what runs (a hidden room keeps its rules)."""

from __future__ import annotations

import re
from typing import Any

# id of an own rule group ("g_abend1"); a rule keeps it in "group"
RULE_GROUP = re.compile(r"^g_[a-z0-9_]{1,30}$")
# pages with room tiles: Licht, Heizung, Räume, Geräte
PAGES = ("light", "heat", "rooms", "devices")
_ROOM = re.compile(r"^[\w.-]{1,64}$")


def _ids(v: Any, limit: int = 80) -> list[str]:
    return [x for x in v if isinstance(x, str) and _ROOM.match(x)][:limit] if isinstance(v, list) else []


def clean_ui(raw: dict[str, Any]) -> dict[str, Any]:
    """{grouping: auto|manual, groups: [{id, name, hidden}], room_order: [...], room_hidden: {page: [...]}}"""
    groups = []
    for g in raw.get("groups", [])[:40] if isinstance(raw.get("groups"), list) else []:
        if isinstance(g, dict) and isinstance(g.get("id"), str) and RULE_GROUP.match(g["id"]) and str(g.get("name") or "").strip():
            groups.append({"id": g["id"], "name": str(g["name"]).strip()[:60], "hidden": bool(g.get("hidden"))})
    hidden = raw.get("room_hidden") if isinstance(raw.get("room_hidden"), dict) else {}
    return {
        "grouping": "manual" if raw.get("grouping") == "manual" else "auto",
        "groups": groups,
        "room_order": _ids(raw.get("room_order")),
        "room_hidden": {p: _ids(hidden.get(p)) for p in PAGES if hidden.get(p)},
    }
