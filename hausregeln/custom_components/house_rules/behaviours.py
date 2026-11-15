"""Room behaviours ("Raumverhalten", "Für alle Räume"): until the redesign of the panel they were switched on once
and became hidden rules ("b_…") for every room that can tell whether someone is in it. They are gone now: migrate()
turns what was switched on into ordinary rules once. The list stays for older backups and the stored choices.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .i18n import tr

if TYPE_CHECKING:
    from .core import HouseRules

# i18n: complete

# all off after installing: nothing switches until the user turns a behaviour on; title and detail: texts/home.json
BEHAVIOURS: list[dict[str, Any]] = [
    {"id": "light_on_enter", "icon": "light", "all": False},
    {"id": "light_off_empty", "icon": "light", "all": False},
    {"id": "night_dim", "icon": "night", "all": False},
    {"id": "heat_eco_empty", "icon": "heating", "all": False},
    {"id": "media_pause_empty", "icon": "media", "all": False},
]


def behaviour_list(core: HouseRules) -> list[dict[str, Any]]:
    defaults = core.data.get("behaviours", {})
    return [
        {**b, "title": tr(core, f"home.behaviour_{b['id']}"), "detail": tr(core, f"home.behaviour_{b['id']}_detail"), "all": bool(defaults.get(b["id"], b["all"]))}
        for b in BEHAVIOURS
    ]


def is_on(core: HouseRules, bid: str, room: dict[str, Any]) -> bool:
    own = room.get("behaviours", {}).get(bid)
    if own is not None:
        return bool(own)
    default = next(b["all"] for b in BEHAVIOURS if b["id"] == bid)
    return bool(core.data.get("behaviours", {}).get(bid, default))


def _rule(name: str, **parts: Any) -> dict[str, Any]:
    return {
        "name": name,
        "type": parts.pop("type", "when"),
        "when": parts.pop("when", []),
        "and": parts.pop("and", []),
        "then": parts.pop("then", []),
        "only": parts.pop("only", []),
        "enabled": parts.pop("enabled", True),
        "options": {"manual_pause": "1h", **parts.pop("options", {})},
    }


def _old_rules(core: HouseRules, flag_on: bool) -> list[tuple[dict[str, Any], bool]]:
    """The rules the room behaviours made until the redesign, with whether each one really ran (the feature
    "Raumverhalten" on, light/heating on, no light or heat plan of its own in the room)."""
    out: list[tuple[dict[str, Any], bool]] = []
    light_ok, heat_ok = core.feature("light"), core.feature("heating")
    inv = core.inventory
    for rid, room in core.rooms.items():
        if not (room["presence"] or room["motion"] or room["door_logic"]):
            continue
        name = room["name"]
        lights = inv.in_room("light", rid)
        light_runs = flag_on and light_ok and not core.plans.plan_on("light", rid)
        if lights and is_on(core, "light_on_enter", room):
            rule = _rule(
                tr(core, "home.rule_light_on_enter", name=name),
                when=[{"subject": f"room:{rid}", "verb": "entered"}],
                **{"and": [{"subject": f"room:{rid}", "verb": "is_dark"}]},
                then=[{"subject": f"all:light@{rid}", "verb": "turn_on", "night_dim": is_on(core, "night_dim", room)}],
                # switched by hand while someone is in the room: leave it until the room was empty
                options={"manual_pause": "room_empty"},
            )
            out.append((rule, light_runs))
        if lights and is_on(core, "light_off_empty", room):
            rule = _rule(
                tr(core, "home.rule_light_off_empty", name=name),
                when=[{"subject": f"room:{rid}", "verb": "empty"}],
                then=[{"subject": f"all:light@{rid}", "verb": "turn_off"}],
                options={"manual_pause": ""},
            )
            out.append((rule, light_runs))
        if inv.in_room("climate", rid) and is_on(core, "heat_eco_empty", room):
            rule = _rule(
                tr(core, "home.rule_heat_eco_empty", name=name),
                type="while",
                when=[{"subject": f"room:{rid}", "verb": "is_empty", "for": "1h"}],
                then=[{"subject": f"all:climate@{rid}", "verb": "eco"}],
            )
            out.append((rule, flag_on and heat_ok and not core.plans.plan_on("heat", rid)))
        if inv.in_room("media", rid) and is_on(core, "media_pause_empty", room):
            rule = _rule(
                tr(core, "home.rule_media_pause_empty", name=name),
                type="while",
                when=[{"subject": f"room:{rid}", "verb": "is_empty", "for": "2m"}],
                then=[{"subject": f"all:media@{rid}", "verb": "pause"}],
            )
            out.append((rule, flag_on))
    return out


def migrate(core: HouseRules) -> int:
    """Once, after the rooms are known: the room behaviours ("Raumverhalten", gone since the redesign of the panel)
    become ordinary rules of the house, so nothing stops switching. A behaviour that ran becomes a rule that is on;
    one that was switched on for a room but did not run (feature or light/heating off, the room has its own plan)
    becomes a rule that is off, so it can be switched on by hand. Returns how many rules were made."""
    if core.data.get("behaviours_migrated"):
        return 0
    core.data["behaviours_migrated"] = True
    flag_on = (core.data.get("settings", {}).get("features") or {}).get("behaviours", True) is not False
    made = 0
    for raw, runs in _old_rules(core, flag_on):
        try:
            rule = core.sanitize({**raw, "enabled": runs})
        except ValueError:
            continue
        rule["meta"] = {**rule.get("meta", {}), "origin": "room"}
        core.data["rules"].append(rule)
        made += 1
    core.save()
    return made
