"""Reinschau-Licht: a room glows softly while someone is next door (or the light is on there) and the door between is
open – so you can look in before entering. Set per room in Licht → Reinschau-Licht (on the floor plan's map).

The setting of a room (plan["glow"]) becomes two ordinary light rules of the room's light plan, rebuilt on every save:
  * "glowauto" (Solange): while one of the sources holds and the room itself is empty (and it is night / dark, not
    sleeping …): the chosen lamps at the chosen brightness. Afterwards "what the other rules say" without the room's
    own dimming – entering is not held up.
  * "glowautok" (bleibt an, linked to it): keeps the glow on in the empty room ("nobody there" would switch it off
    at once); when the glow ends in the empty room it goes off.
A source is another room: someone in it, or a light on in it, or either – optionally only while a door is open or
closed. The light plan runs the rules as any other (priorities, by hand, blocks); nothing else needs to know.

Colour "rules": the glow takes the colour the room's own light rules have right now – the colour of the rule that
switches the room's light on when someone comes in, with its "je nach …" variants (evening warm, night candle …),
only at the glow's brightness.
"""

from __future__ import annotations

import re
from typing import Any

from .lightspec import color_ok

RULE_ID = "glowauto"
KEEP_ID = "glowautok"
IDS = (RULE_ID, KEEP_ID)
# occupied / light / either: what happens next door (optionally with a door); door: only the door (open / closed)
BY = ("occupied", "light", "either", "door")
DARK = ("night", "dark", "time", "always")
HM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def default_global() -> dict[str, Any]:
    """When the Reinschau-Licht may glow at all – one setting for every room (core.data["glow"])."""
    return {
        # night (the sun well below the horizon) | dark (each room's "dark") | time (from – to) | always
        "dark": "night",
        "from": "20:00",
        "to": "06:00",
        "not_sleep": True,
        "not_guests": False,
    }


def clean_global(raw: Any, cur: dict[str, Any] | None) -> dict[str, Any]:
    out = {**default_global(), **(cur or {})}
    if not isinstance(raw, dict):
        return out
    if raw.get("dark") in DARK:
        out["dark"] = raw["dark"]
    for k in ("from", "to"):
        if isinstance(raw.get(k), str) and HM.match(raw[k]):
            out[k] = raw[k]
    for k in ("not_sleep", "not_guests"):
        if isinstance(raw.get(k), bool):
            out[k] = raw[k]
    return out
# rules made by hand (before this setting existed) that do the same: offered to be replaced
HANDMADE = re.compile(r"reinschau|glimmt|glow", re.I)


def default_glow() -> dict[str, Any]:
    return {
        "on": False,
        # [{room, by: occupied | light | either, door: entity or None, door_state: open | closed}]
        "sources": [],
        "lights": [],
        "brightness": 5,
        # {light: brightness} for lamps that glow brighter or darker than the rest
        "per_light": {},
        # a colour string (lightspec.py) or "rules": like the room's own light rules right now
        "color": "rules",
        # night (the sun well below the horizon) | dark (the room's "dark") | always
        "dark": "night",
        "not_sleep": True,
        "not_guests": False,
        # only while these are off (e.g. the TV)
        "only_off": [],
    }


def _int(v: Any, d: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(round(float(v)))))
    except (TypeError, ValueError):
        return d


def clean_glow(raw: Any, cur: dict[str, Any] | None, rooms: set[str]) -> dict[str, Any]:
    out = {**default_glow(), **(cur or {})}
    if not isinstance(raw, dict):
        return out
    if isinstance(raw.get("on"), bool):
        out["on"] = raw["on"]
    if isinstance(raw.get("sources"), list):
        srcs = []
        for s in raw["sources"][:12]:
            if not isinstance(s, dict) or s.get("room") not in rooms:
                continue
            door = s.get("door") if isinstance(s.get("door"), str) and s["door"].startswith("binary_sensor.") else None
            if s.get("by") == "door" and not door:
                continue  # "only the door" without a door says nothing
            srcs.append({"room": s["room"], "by": s.get("by") if s.get("by") in BY else "occupied", "door": door, "door_state": "closed" if s.get("door_state") == "closed" else "open"})
        out["sources"] = srcs
    if isinstance(raw.get("lights"), list):
        out["lights"] = [e for e in raw["lights"] if isinstance(e, str) and e.startswith("light.")][:20]
    if "brightness" in raw:
        out["brightness"] = _int(raw["brightness"], 5, 1, 100)
    if isinstance(raw.get("per_light"), dict):
        out["per_light"] = {e: _int(b, out["brightness"], 1, 100) for e, b in list(raw["per_light"].items())[:20] if isinstance(e, str) and e.startswith("light.")}
    if raw.get("color") == "rules" or color_ok(raw.get("color")):
        out["color"] = str(raw["color"]).lower()
    if raw.get("dark") in DARK:
        out["dark"] = raw["dark"]
    for k in ("not_sleep", "not_guests"):
        if isinstance(raw.get(k), bool):
            out[k] = raw[k]
    if isinstance(raw.get("only_off"), list):
        out["only_off"] = [e for e in raw["only_off"] if isinstance(e, str) and "." in e][:6]
    return out


def _c(subject: str, verb: str, **extra: Any) -> dict[str, Any]:
    return {"subject": subject, "verb": verb, **extra}


def _all(items: list[dict[str, Any]]) -> dict[str, Any]:
    return items[0] if len(items) == 1 else {"subject": "logic", "verb": "all", "items": items}


def _any(items: list[dict[str, Any]]) -> dict[str, Any]:
    return items[0] if len(items) == 1 else {"subject": "logic", "verb": "any", "items": items}


def source_clause(s: dict[str, Any]) -> dict[str, Any]:
    door = _c(s["door"], "is_open" if s.get("door_state") != "closed" else "is_closed") if s.get("door") else None
    if s["by"] == "door" and door:
        # only the door: glows while it is open (or closed), whoever is next door
        return door
    occ = _c(f"room:{s['room']}", "is_occupied")
    lit = _c(f"any:light@{s['room']}", "is_on")
    what = occ if s["by"] == "occupied" else lit if s["by"] == "light" else _any([occ, lit])
    if door:
        return _all([what, door])
    return what


def _colour_rule(rid: str, rules: list[dict[str, Any]], lights: list[str]) -> dict[str, Any] | None:
    """The room's rule whose colour the glow follows: one that switches its lights on, best when someone comes in."""
    def on(r: dict[str, Any]) -> bool:
        return r.get("enabled", True) and r.get("id") not in IDS and r.get("kind") in ("when", "while") and (r.get("action") or {}).get("mode", "on") == "on" and (not r.get("lights") or bool(set(r["lights"]) & set(lights)))

    cands = [r for r in rules if on(r)]
    entering = [r for r in cands if any(str(c.get("subject")) == f"room:{rid}" for c in (r.get("trigger") or []) + (r.get("when") or []))]
    return (entering or cands or [None])[0]


def glow_rules(rid: str, g: dict[str, Any], name: str, rules: list[dict[str, Any]] | None = None, glob: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """The two light rules of a room's Reinschau-Licht (empty when it is off or incomplete). rules: the room's other
    light rules (for the colour "rules"); glob: when it may glow at all (the same for every room)."""
    glob = {**default_global(), **(glob or {})}
    if not g.get("on") or not g.get("sources") or not g.get("lights"):
        return []
    when = [_any([source_clause(s) for s in g["sources"]]), _c(f"room:{rid}", "is_empty")]
    if glob["dark"] == "night":
        # "really night": the sun well below the horizon (≈ −6°, about 45 min after sunset / before sunrise)
        when.append(_any([_c("sun", "after_sunset", offset="45m"), _c("sun", "before_sunrise", offset="-45m")]))
    elif glob["dark"] == "dark":
        when.append(_c(f"room:{rid}", "is_dark"))
    elif glob["dark"] == "time":
        when.append(_c("time", "between", **{"from": glob["from"], "to": glob["to"]}))
    if glob["not_sleep"]:
        when.append(_c("mode", "is_not", mode="sleep"))
    if glob["not_guests"]:
        when.append(_c("mode", "is_not", mode="guests"))
    for e in g.get("only_off") or []:
        when.append(_c(e, "is_off", **{"for": "1m"}))
    per = {e: {"brightness": b} for e, b in (g.get("per_light") or {}).items() if e in g["lights"] and b != g["brightness"]}
    variants: list[dict[str, Any]] = []
    color = g["color"]
    if color == "rules":
        src = _colour_rule(rid, rules or [], g["lights"])
        color = str((src or {}).get("action", {}).get("color") or "warm") if src else "warm"
        if color in ("none", ""):
            color = "warm"
        for v in (src or {}).get("variants") or []:
            if v.get("when") and v.get("color") and v.get("color") != "none":
                variants.append({"id": f"g{v.get('id', '')}"[:12], "when": v["when"], "mode": "on", "brightness": g["brightness"], "color": v["color"], "transition": 2, **({"per_light": per} if per else {})})
    action: dict[str, Any] = {"mode": "on", "brightness": g["brightness"], "color": color, "transition": 2}
    if per:
        action["per_light"] = per
    title = f"Reinschau-Licht ({name})"[:60]
    return [
        {"id": RULE_ID, "name": title, "enabled": True, "kind": "while", "when": when, "lights": list(g["lights"]), "action": action, "variants": variants, "after": "others", "follow_empty": False, "own_end": {"delay": 0, "dim": 0, "dim_for": 0}},
        {"id": KEEP_ID, "name": f"{title[:44]} (bleibt an)", "enabled": True, "kind": "keep_on", "when": [], "linked": [RULE_ID], "lights": list(g["lights"]), "empty_after": "off"},
    ]


def handmade(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rules made by hand earlier that do the same (by name or id): the panel offers to replace them."""
    return [r for r in rules if r.get("id") not in IDS and (HANDMADE.search(str(r.get("name") or "")) or HANDMADE.search(str(r.get("id") or "")))]
