"""Suggestions from what exists in the home: ready rules and housekeeping tasks."""

from __future__ import annotations

import re
import uuid
from typing import TYPE_CHECKING, Any

from .i18n import quote, tr, trn

if TYPE_CHECKING:
    from .core import HouseRules

# i18n: complete


def _rule(name: str, **parts: Any) -> dict[str, Any]:
    return {
        "id": "r_" + uuid.uuid4().hex[:6],
        "name": name,
        "type": parts.pop("type", "when"),
        "when": parts.pop("when", []),
        "and": parts.pop("and", []),
        "then": parts.pop("then", []),
        "only": parts.pop("only", []),
        "enabled": True,
        "options": {"manual_pause": "1h"},
        "meta": {"origin": "suggestion", **parts.pop("meta", {})},
    }


def _uses(core: HouseRules, pattern: str) -> bool:
    rx = re.compile(pattern)
    return any(rx.search(c.get("subject", "")) for r in core.data.get("rules", []) for s in ("when", "and", "then", "only", "else") for c in r.get(s, []))


STATE_VERB = {
    "window": "is_open",
    "door": "is_open",
    "light": "is_on",
    "switch": "is_on",
    "outlet": "is_on",
    "presence": "is_occupied",
    "zone": "is_occupied",
    "motion": "is_active",
    "media": "is_on",
    "fan": "is_on",
    "purifier": "is_on",
}
ACTION_VERB = {"light": "turn_on", "switch": "turn_on", "outlet": "turn_on", "fan": "turn_on", "purifier": "turn_on", "script": "run", "media": "turn_on", "climate": "eco"}


def suggestions(core: HouseRules, automations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    inv = core.inventory
    devs = inv.devices
    dismissed = set(core.data.get("dismissed", []))
    out: list[dict[str, Any]] = []

    # 1) two HA automations that switch the same thing on and off → one "while" rule
    by_trigger: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for a in automations:
        trig = tuple(sorted({u["entity_id"] for u in a["uses"] if u["as"] == "trigger"}))
        if trig:
            by_trigger.setdefault(trig, []).append(a)
    for trig, group in by_trigger.items():
        if len(group) != 2 or not all(a["enabled"] for a in group):
            continue
        acts = [{u["entity_id"] for u in a["uses"] if u["as"] == "action"} for a in group]
        if not acts[0] or acts[0] != acts[1]:
            continue
        sid = "s_merge_" + "_".join(sorted(a["entity_id"].split(".")[1] for a in group))[:60]
        kind = devs.get(trig[0], {}).get("kind")
        if sid in dismissed or kind not in STATE_VERB:
            continue
        thens = [{"subject": e, "verb": ACTION_VERB[devs[e]["kind"]]} for e in sorted(acts[0]) if e in devs and devs[e]["kind"] in ACTION_VERB]
        if not thens:
            continue
        name = devs[trig[0]]["name"]
        out.append(
            {
                "id": sid,
                "title": tr(core, "suggest.merge_title", name=name),
                "why": tr(core, "suggest.merge_why", a=quote(core, group[0]["name"]), b=quote(core, group[1]["name"])),
                "icon": "merge",
                "badge": tr(core, "suggest.badge_cleanup"),
                "rule": _rule(
                    tr(core, "suggest.merge_rule_on" if STATE_VERB[kind] == "is_on" else "suggest.merge_rule_active", name=name),
                    type="while",
                    when=[{"subject": trig[0], "verb": STATE_VERB[kind]}],
                    then=thens,
                    meta={"replaces": [a["entity_id"] for a in group]},
                ),
            }
        )

    # 2) housekeeping: kinds that HA got wrong, devices without a room
    wrong = [d for d in devs.values() if d.get("kind_hint")]
    if wrong and "s_kinds" not in dismissed:
        windows = sum(1 for d in wrong if d["kind"] == "window")
        if windows == len(wrong):
            title = trn(core, "suggest.windows_as_doors", windows)
        else:
            title = trn(core, "suggest.wrong_kind", len(wrong))
        out.append(
            {
                "id": "s_kinds",
                "title": title,
                "why": tr(core, "suggest.wrong_kind_why"),
                "icon": "fix",
                "badge": tr(core, "suggest.badge_sort"),
                "task": "fix_kinds",
            }
        )
    roomless = [d for d in devs.values() if not d.get("room") and not d.get("no_room") and d["kind"] in ("light", "window", "door", "presence", "motion", "climate", "media", "outlet", "zone")]
    if roomless and "s_rooms" not in dismissed:
        examples = ", ".join(d["name"] for d in roomless[:3])
        out.append(
            {
                "id": "s_rooms",
                "title": trn(core, "suggest.no_room", len(roomless)),
                "why": tr(core, "suggest.no_room_why", examples=examples),
                "icon": "rooms",
                "badge": tr(core, "suggest.badge_sort"),
                "task": "assign_rooms",
            }
        )

    # 3) windows and heating in the same room
    rooms_both = [r for r in core.rooms if inv.in_room("window", r) and inv.in_room("climate", r)]
    if rooms_both and not _uses(core, r"^any:window") and "s_window_heating" not in dismissed:
        out.append(
            {
                "id": "s_window_heating",
                "title": tr(core, "suggest.window_heating"),
                "why": tr(core, "suggest.window_heating_why", n=len(rooms_both)),
                "icon": "heating",
                "rule": _rule(
                    tr(core, "suggest.window_heating"),
                    type="while",
                    when=[{"subject": "any:window", "verb": "is_open", "for": "2m"}],
                    then=[{"subject": "all:climate@same", "verb": "turn_off"}],
                ),
            }
        )

    # 4) water leak sensors
    if any(d["kind"] == "leak" for d in devs.values()) and not _uses(core, r"leak") and "s_leak" not in dismissed:
        out.append(
            {
                "id": "s_leak",
                "title": tr(core, "suggest.leak"),
                "why": tr(core, "suggest.leak_why"),
                "icon": "leak",
                "rule": _rule(
                    tr(core, "suggest.leak_rule"),
                    when=[{"subject": "any:leak", "verb": "wet"}],
                    then=[{"subject": "notify:everyone", "verb": "alarm", "message": tr(core, "suggest.leak_message")}],
                ),
            }
        )

    # 5) a bed zone and a light in the same room → soft light when getting up at night
    for d in devs.values():
        if d["kind"] == "zone" and re.search(r"bettfu|bettkante|aufsteh|bedside|bed edge|getting up", d["name"].lower()) and d.get("room"):
            lights = inv.in_room("light", d["room"])
            sid = f"s_night_{d['entity_id'].split('.')[-1]}"[:60]
            if lights and sid not in dismissed and not _uses(core, re.escape(d["entity_id"])):
                small = next((l for l in lights if re.search(r"klein|nacht|bett|pilz|small|night|bed", devs[l]["name"].lower())), lights[0])
                out.append(
                    {
                        "id": sid,
                        "title": tr(core, "suggest.night"),
                        "why": tr(core, "suggest.night_why", zone=quote(core, d["name"]), light=devs[small]["name"]),
                        "icon": "light",
                        "rule": _rule(
                            tr(core, "suggest.night_rule"),
                            type="while",
                            when=[{"subject": f"zone:{d['entity_id']}", "verb": "is_occupied"}],
                            then=[{"subject": small, "verb": "dim", "brightness": 5}],
                            only=[{"subject": "time", "verb": "night"}],
                        ),
                    }
                )
                break

    # 6) everyone leaves with a window open
    if any(d["kind"] == "window" for d in devs.values()) and inv.persons and not _uses(core, r"^person:everyone") and "s_leave_window" not in dismissed:
        out.append(
            {
                "id": "s_leave_window",
                "title": tr(core, "suggest.leave_window"),
                "why": tr(core, "suggest.leave_window_why"),
                "icon": "window",
                "rule": _rule(
                    tr(core, "suggest.leave_window"),
                    when=[{"subject": "person:everyone", "verb": "leaves"}],
                    **{"and": [{"subject": "any:window", "verb": "is_open"}]},
                    then=[{"subject": "notify:everyone", "verb": "send", "message": tr(core, "suggest.leave_window_message")}],
                ),
            }
        )

    # 7) music still playing in an empty room: pause it (was the room behaviour "Musik pausieren" until the redesign)
    for rid, room in core.rooms.items():
        sid = f"s_media_pause_{rid}"[:60]
        if not (room["presence"] or room["motion"]) or not inv.in_room("media", rid) or sid in dismissed:
            continue
        if _uses(core, rf"^all:media@{re.escape(rid)}$"):
            continue
        out.append(
            {
                "id": sid,
                "title": tr(core, "suggest.media_pause", room=room["name"]),
                "why": tr(core, "suggest.media_pause_why", room=room["name"]),
                "icon": "media",
                "rule": _rule(
                    tr(core, "home.rule_media_pause_empty", name=room["name"]),
                    type="while",
                    when=[{"subject": f"room:{rid}", "verb": "is_empty", "for": "2m"}],
                    then=[{"subject": f"all:media@{rid}", "verb": "pause"}],
                ),
            }
        )
        break

    # 8) the smart heating's own proposals: learned times, turning up by hand again and again (smart_heat.py)
    heating = getattr(core, "heating", None)
    if heating is not None:
        out += heating.smart.suggestions(dismissed)
    return out
