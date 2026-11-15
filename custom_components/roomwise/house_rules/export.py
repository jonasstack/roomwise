"""A rule as a Home Assistant automation ("Als Home-Assistant-Automation exportieren").

export(core, rule) maps a rule to an equivalent automation: triggers, conditions and actions, with placeholders
("irgendein Fenster", "alle Lichter im selben Raum") expanded into entity lists of today. What an automation
cannot express is marked in place: a step or condition with the alias "Nicht übertragbar: …" that does nothing,
and a sentence in `notes` (and in the automation's description). Hausregeln's own entities (house mode, room
occupancy, alarm) are used where the rule needs them, so those parts keep working while Hausregeln is installed.

Answer: {automation, yaml, notes: [sentence], complete, id}. The panel offers the YAML to copy or download; an
admin can also create it through Home Assistant's automation config API, after which the rule is switched off
here (house_rules/rule/exported), not deleted.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from homeassistant.helpers import entity_registry as er
from homeassistant.util.yaml import dump as yaml_dump

from .actions import COLORS, NIGHT_LIGHT
from .conditions import duration_of
from .engine import _signed_seconds
from .const import INTEGRATION
from .select import OPTIONS as SELECT_OPTIONS
from .i18n import num, quote, tr
from . import logic_export
from .logic import leaves
from .vocab import seconds

# i18n: complete

if TYPE_CHECKING:
    from .core import HouseRules

BAD = ["unavailable", "unknown"]
ON_KINDS = ("light", "switch", "outlet", "fan", "purifier", "script", "input_boolean", "siren", "humidifier", "automation", "binary_sensor")
VALUE_KINDS = ("sensor", "number", "input_number", "select", "input_select", "input_text", "entity", "event", "button", "input_button", "scene")
GROUP_OFF = ["off", "standby", "closed", "locked", "docked"]


def _hms(sec: float | None) -> str:
    s = int(sec or 0)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def _hm(value: Any, default: str) -> str:
    m = re.match(r"^(\d{1,2}):(\d{2})", str(value or default))
    return f"{int(m.group(1)):02d}:{m.group(2)}:00" if m else f"{default}:00"


def _one(v: list[str]) -> str | list[str]:
    return v[0] if len(v) == 1 else v


class _Export:
    def __init__(self, core: HouseRules, rule: dict[str, Any]) -> None:
        self.core = core
        self.rule = rule
        self.res = core.checker.res
        self.notes: list[str] = []
        self.todo = 0
        self._reg = er.async_get(core.hass)

    # ------------------------------------------------------------------ helpers
    def own(self, platform: str, uid: str) -> str | None:
        return self._reg.async_get_entity_id(platform, INTEGRATION, uid)

    def text(self, c: dict[str, Any], section: str) -> str:
        t = self.core.describer.clause(c, section)
        return t[:1].upper() + t[1:] if t else f"{c.get('subject')} {c.get('verb')}"

    def note(self, sentence: str) -> None:
        if sentence not in self.notes:
            self.notes.append(sentence)

    def t(self, k: str, **kw: Any) -> str:
        return tr(self.core, f"export.{k}", **kw)

    def todo_action(self, what: str, why: str) -> dict[str, Any]:
        self.todo += 1
        self.note(self.t("not_carried", what=quote(self.core, what), why=why))
        return {"alias": self.t("alias", what=what), "variables": {"hausregeln_not_carried_over": what}}

    def todo_condition(self, what: str, why: str) -> dict[str, Any]:
        self.todo += 1
        self.note(self.t("not_carried", what=quote(self.core, what), why=why))
        return {"alias": self.t("alias", what=what), "condition": "template", "value_template": "{{ true }}"}

    def todo_trigger(self, what: str, why: str) -> None:
        self.todo += 1
        self.note(self.t("trigger_not_carried", what=quote(self.core, what), why=why))

    def room_sensor(self, rid: str) -> str | None:
        return self.own("binary_sensor", f"room_{rid}_occupied")

    # ------------------------------------------------------------------ what a clause wants of one entity
    def spec(self, kind: str, verb: str, c: dict[str, Any]) -> dict[str, Any] | None:  # noqa: C901, PLR0911, PLR0912 — one branch per kind
        """{"to": [states]} | {"not": [states]} | {"num": (above|below, value, attribute)} | {"attr": (attribute, value)}
        | {"any": True} | {"zone": (zone entity, enter|leave)}; "from": states the trigger must come from."""
        on, off = {"to": ["on"]}, {"to": ["off"]}
        if kind in ("window", "door"):
            return {"opens": on, "is_open": on, "open_for": on, "closes": off, "is_closed": off}.get(verb)
        if kind in ON_KINDS:
            if kind == "light" and verb in ("brighter", "is_brighter", "dimmer", "is_dimmer"):
                pct = float(c.get("brightness", 50) or 50)
                return {"num": ("above" if "bright" in verb else "below", round(pct * 2.55), "brightness")}
            return {"turns_on": on, "is_on": on, "on_for": on, "ran": on, "turns_off": off, "is_off": off, "off_for": off}.get(verb)
        if kind in ("camera", "water_heater"):
            active = {"not": ["off", "idle", *BAD]}
            return {"turns_on": active, "is_on": active, "on_for": active, "turns_off": off, "is_off": off, "off_for": off}.get(verb)
        if kind == "motion":
            return {"detected": on, "is_active": on, "clear_for": off, "is_clear": off}.get(verb)
        if kind in ("zone", "presence"):
            return {"occupied": on, "is_occupied": on, "free_for": off, "is_free": off}.get(verb)
        if kind == "leak":
            return on if verb in ("wet", "is_wet") else None
        if kind == "climate":
            return {"attr": ("hvac_action", "heating")} if verb in ("starts_heating", "is_heating") else None
        if kind == "cover":
            return {"opens": {"to": ["open", "opening"]}, "is_open": {"to": ["open", "opening"]}, "closes": {"to": ["closed", "closing"]}}.get(verb)
        if kind in ("media", "media_player"):
            playing = ["playing", "on"]
            return {
                "turns_on": {"not": ["off", "standby", *BAD]},
                "is_on": {"not": ["off", "standby", *BAD]},
                "starts_playing": {"to": playing},
                "is_playing": {"to": playing},
                "stops": {"not": [*playing, *BAD], "from": playing},
            }.get(verb)
        if kind == "lock":
            return {"unlocked": {"to": ["unlocked", "open", "opening"]}, "is_locked": {"to": ["locked"]}}.get(verb)
        if kind == "vacuum":
            return {"starts": {"to": ["cleaning"]}, "done": {"to": ["docked", "returning"], "from": ["cleaning", "returning", "paused"]}, "is_docked": {"to": ["docked"]}}.get(verb)
        if kind in ("temperature", "illuminance"):
            try:
                v = float(c.get("value"))
            except (TypeError, ValueError):
                return None
            return {"num": ("below" if "below" in verb else "above", v, None)} if verb in ("below", "is_below", "above", "is_above") else None
        if kind == "person":
            zone = f"zone.{c.get('zone') or 'home'}"
            return {
                "arrives": {"to": ["home"]},
                "is_home": {"to": ["home"]},
                "leaves": {"not": ["home", *BAD], "from": ["home"]},
                "is_away": {"not": ["home", *BAD]},
                "enters_zone": {"zone": (zone, "enter")},
                "in_zone": {"zone": (zone, "enter")},
                "leaves_zone": {"zone": (zone, "leave")},
                "not_in_zone": {"zone": (zone, "leave")},
            }.get(verb)
        if kind == "device_tracker":
            return {"arrives": {"to": ["home"]}, "is_home": {"to": ["home"]}, "leaves": {"not": ["home", *BAD], "from": ["home"]}, "is_away": {"not": ["home", *BAD]}}.get(verb)
        if kind in VALUE_KINDS:
            if verb in ("changes", "pressed", "activated"):
                return {"any": True}
            if verb in ("becomes", "is"):
                return {"to": [str(c.get("state", ""))]}
            if verb == "is_not":
                return {"not": [str(c.get("state", "")), *BAD]}
            if verb in ("above", "is_above", "below", "is_below"):
                try:
                    return {"num": ("below" if "below" in verb else "above", float(c.get("value", 0)), None)}
                except (TypeError, ValueError):
                    return None
            return None
        if kind == "group":
            return {
                "turns_on": {"not": [*GROUP_OFF, *BAD]},
                "is_on": {"not": [*GROUP_OFF, *BAD]},
                "on_for": {"not": [*GROUP_OFF, *BAD]},
                "turns_off": {"to": GROUP_OFF},
                "is_off": {"to": GROUP_OFF},
                "off_for": {"to": GROUP_OFF},
            }.get(verb)
        return None

    @staticmethod
    def inverse(sp: dict[str, Any]) -> dict[str, Any]:
        """The opposite (for "while" rules: the moment it stops holding)."""
        if "to" in sp:
            return {"not": [*sp["to"], *BAD]}
        if "not" in sp:
            return {"to": [s for s in sp["not"] if s not in BAD]}
        if "num" in sp:
            way, v, attr = sp["num"]
            return {"num": ("below" if way == "above" else "above", v, attr)}
        if "zone" in sp:
            z, ev = sp["zone"]
            return {"zone": (z, "leave" if ev == "enter" else "enter")}
        return {"any": True}

    # ------------------------------------------------------------------ triggers / conditions of one spec
    def trigger(self, sp: dict[str, Any], ents: list[str], need: float | None) -> dict[str, Any]:
        t: dict[str, Any]
        if "to" in sp:
            t = {"trigger": "state", "entity_id": _one(ents), "to": _one(sp["to"])}
        elif "not" in sp:
            t = {"trigger": "state", "entity_id": _one(ents), "not_to": sp["not"]}
            if "from" not in sp:
                t["from"] = [s for s in self.inverse(sp)["to"]] or None
        elif "num" in sp:
            way, v, attr = sp["num"]
            t = {"trigger": "numeric_state", "entity_id": _one(ents), way: v}
            if attr:
                t["attribute"] = attr
        elif "attr" in sp:
            t = {"trigger": "state", "entity_id": _one(ents), "attribute": sp["attr"][0], "to": sp["attr"][1]}
        elif "zone" in sp:
            t = {"trigger": "zone", "entity_id": _one(ents), "zone": sp["zone"][0], "event": sp["zone"][1]}
        else:
            t = {"trigger": "state", "entity_id": _one(ents), "not_to": BAD}
        if "from" in sp:
            t["from"] = _one(sp["from"])
        if t.get("from") is None:
            t.pop("from", None)
        if need and "zone" not in sp:
            t["for"] = _hms(need)
        return t

    def condition(self, sp: dict[str, Any], ents: list[str], mode: str, need: float | None) -> dict[str, Any] | None:
        many = len(ents) > 1
        cond: dict[str, Any] | None
        if "to" in sp:
            cond = {"condition": "state", "entity_id": _one(ents), "state": _one(sp["to"])}
            if many and mode == "any":
                cond["match"] = "any"
            if need:
                cond["for"] = _hms(need)
            return cond
        if "attr" in sp:
            cond = {"condition": "state", "entity_id": _one(ents), "attribute": sp["attr"][0], "state": sp["attr"][1]}
            if many and mode == "any":
                cond["match"] = "any"
            if need:
                cond["for"] = _hms(need)
            return cond
        if "not" in sp:
            # "some entity not in these states" = not (all in them); "all not in them" = not (any in them)
            inner = {"condition": "state", "entity_id": _one(ents), "state": _one(sp["not"])}
            if many and mode == "all":
                inner["match"] = "any"
            if need:
                self.note(self.t("not_for"))
            return {"condition": "not", "conditions": [inner]}
        if "num" in sp:
            way, v, attr = sp["num"]

            def one(e: str | list[str]) -> dict[str, Any]:
                c = {"condition": "numeric_state", "entity_id": e, way: v}
                if attr:
                    c["attribute"] = attr
                return c

            if need:
                self.note(self.t("num_for"))
            return {"condition": "or", "conditions": [one(e) for e in ents]} if many and mode == "any" else one(_one(ents))
        if "zone" in sp:
            z, ev = sp["zone"]
            parts = [{"condition": "zone", "entity_id": e, "zone": z} for e in ents]
            if ev == "leave":
                parts = [{"condition": "not", "conditions": [p]} for p in parts]
            if len(parts) == 1:
                return parts[0]
            return {"condition": "or" if mode == "any" else "and", "conditions": parts}
        return None

    # ------------------------------------------------------------------ clauses
    def clause_triggers(self, c: dict[str, Any], *, edges: bool = False) -> list[dict[str, Any]]:  # noqa: C901, PLR0911, PLR0912
        """Triggers for one "when" clause. edges: also when it stops holding ("while" rules)."""
        extra = logic_export.trigger(self, c)  # HA events, event entities (logic.py)
        if extra is not None:
            return extra
        subject, verb = str(c.get("subject", "")), str(c.get("verb", ""))
        what = self.text(c, "when")
        if subject == "time":
            if verb == "at":
                return [{"trigger": "time", "at": _hm(c.get("time"), "07:00")}]
            if verb in ("night", "morning", "evening", "between"):
                a, b = self._window(c)
                return [{"trigger": "time", "at": a}, {"trigger": "time", "at": b}]
            if verb in ("workdays", "weekend"):
                return [{"trigger": "time", "at": "00:00:00"}]
            self.todo_trigger(what, self.t("unknown_time"))
            return []
        if subject == "sun":
            if verb in ("sets", "rises"):
                off = _signed_seconds(c.get("offset"))
                t: dict[str, Any] = {"trigger": "sun", "event": "sunset" if verb == "sets" else "sunrise"}
                if off:
                    t["offset"] = ("-" if off < 0 else "") + _hms(abs(off))
                return [t]
            return [{"trigger": "state", "entity_id": "sun.sun", "not_to": BAD}]
        if subject == "mode":
            sensor = self.own("sensor", "house_mode_state")
            if not sensor:
                self.todo_trigger(what, self.t("no_mode_sensor"))
                return []
            if verb == "changes_to":
                return [{"trigger": "state", "entity_id": sensor, "to": str(c.get("mode", "home"))}]
            return [{"trigger": "state", "entity_id": sensor, "not_to": BAD}]
        if subject == "alarm":
            panel = self.own("alarm_control_panel", "alarm")
            if not panel:
                self.todo_trigger(what, self.t("no_alarm"))
                return []
            to = {"triggered": ["triggered"], "armed": ["armed_away", "armed_night", "armed_home"], "disarmed": ["disarmed"]}.get(verb)
            if to and not edges:
                t = {"trigger": "state", "entity_id": panel, "to": _one(to)}
                if verb == "armed":
                    t["from"] = ["disarmed", "arming"]
                return [t]
            return [{"trigger": "state", "entity_id": panel, "not_to": BAD}]
        if subject.startswith("rule:"):
            if verb == "ran":
                return [{"trigger": "event", "event_type": "house_rules_fired", "event_data": {"rule_id": subject[5:]}}]
            self.todo_trigger(what, self.t("rule_active"))
            return []
        if subject.startswith("room:"):
            sensor = self.room_sensor(subject[5:])
            if not sensor:
                self.todo_trigger(what, self.t("no_room_sensor"))
                return []
            if verb in ("is_dark", "is_bright"):
                self.todo_trigger(what, self.t("dark"))
                return []
            want = "on" if verb in ("entered", "is_occupied") else "off"
            need = duration_of("room", verb, c) if verb in ("empty_for",) or c.get("for") else None
            out = [{"trigger": "state", "entity_id": sensor, "to": want, **({"for": _hms(need)} if need else {})}]
            if edges:
                out.append({"trigger": "state", "entity_id": sensor, "to": "off" if want == "on" else "on"})
            return out
        kind = self.res.kind_of(subject)
        sp = self.spec(kind, verb, c)
        ents = self.res.entities(subject)
        if sp is None:
            self.todo_trigger(what, self.t("unknown_trigger"))
            return []
        if not ents:
            self.todo_trigger(what, self.t("no_device"))
            return []
        need = duration_of(kind, verb, c)
        out = [self.trigger(sp, ents, need)]
        if edges:
            out.append(self.trigger(self.inverse(sp), ents, None))
        return out

    def _window(self, c: dict[str, Any]) -> tuple[str, str]:
        verb = c.get("verb")
        if verb == "between":
            return _hm(c.get("from"), "08:00"), _hm(c.get("to"), "20:00")
        a, b = self.core.checker.window(str(verb))
        return f"{a:02d}:00:00", f"{b:02d}:00:00"

    def clause_condition(self, c: dict[str, Any], room: str | None = None) -> dict[str, Any] | None:  # noqa: C901, PLR0911, PLR0912
        extra = logic_export.condition(self, c, room)  # groups, weekdays, sun with offset, between (logic.py)
        if not logic_export.unhandled(extra):
            return extra
        if c.get("or"):
            base = {k: v for k, v in c.items() if k != "or"}
            parts = [p for p in (self.clause_condition(x, room) for x in (base, *c["or"])) if p]
            return {"condition": "or", "conditions": parts} if parts else None
        subject, verb = str(c.get("subject", "")), str(c.get("verb", ""))
        what = self.text(c, "and")
        if subject == "time":
            if verb in ("night", "morning", "evening", "between"):
                a, b = self._window(c)
                return {"condition": "time", "after": a, "before": b}
            if verb == "workdays":
                wd = next((e.entity_id for e in self._reg.entities.values() if e.platform == "workday" and e.domain == "binary_sensor" and not e.disabled), None)
                return {"condition": "state", "entity_id": wd, "state": "on"} if wd else {"condition": "time", "weekday": ["mon", "tue", "wed", "thu", "fri"]}
            if verb == "weekend":
                return {"condition": "time", "weekday": ["sat", "sun"]}
            return None
        if subject == "sun":
            if verb in ("is_down", "is_up"):
                return {"condition": "state", "entity_id": "sun.sun", "state": "below_horizon" if verb == "is_down" else "above_horizon"}
            return None
        if subject == "mode":
            sensor = self.own("sensor", "house_mode_state")
            if not sensor:
                return self.todo_condition(what, self.t("no_mode_sensor"))
            cond = {"condition": "state", "entity_id": sensor, "state": str(c.get("mode", "home"))}
            return {"condition": "not", "conditions": [cond]} if verb == "is_not" else cond
        if subject == "alarm":
            panel = self.own("alarm_control_panel", "alarm")
            if not panel:
                return self.todo_condition(what, self.t("no_alarm"))
            states = {"is_armed": ["armed_away", "armed_night", "armed_home", "pending", "triggered"], "is_disarmed": ["disarmed"], "is_triggered": ["triggered"]}.get(verb)
            return {"condition": "state", "entity_id": panel, "state": _one(states)} if states else None
        if subject.startswith("rule:"):
            return self.todo_condition(what, self.t("rule_active"))
        if subject.startswith("room:"):
            if verb in ("is_dark", "is_bright"):
                return self.todo_condition(what, self.t("dark"))
            sensor = self.room_sensor(subject[5:])
            if not sensor:
                return self.todo_condition(what, self.t("no_room_sensor"))
            need = seconds(c.get("for"))
            return {"condition": "state", "entity_id": sensor, "state": "on" if verb in ("is_occupied", "entered") else "off", **({"for": _hms(need)} if need else {})}
        kind = self.res.kind_of(subject)
        if kind == "vacuum" and verb in ("cleaned_today", "not_cleaned_today"):
            return self.todo_condition(what, self.t("cleaned"))
        if kind == "person" and verb in ("is_far", "is_near", "far_from", "coming_home"):
            return self.todo_condition(what, self.t("distance"))
        sp = self.spec(kind, verb, c)
        if sp is None or "any" in sp:
            return self.todo_condition(what, self.t("unknown_condition"))
        ents = self.res.entities(subject, room, room)
        if not ents:
            return self.todo_condition(what, self.t("no_device"))
        return self.condition(sp, ents, self.res.mode_of(subject), seconds(c.get("for")))

    # ------------------------------------------------------------------ actions
    def steps(self, clauses: list[dict[str, Any]], room: str | None) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for c in clauses:
            out += self.step(c, room)
        return out

    def step(self, c: dict[str, Any], room: str | None) -> list[dict[str, Any]]:  # noqa: C901, PLR0911, PLR0912
        extra = logic_export.step(self, c, room)  # if/choose/repeat/parallel/wait/variables/stop, light settings
        if extra is not None:
            return extra
        subject, verb = str(c.get("subject", "")), str(c.get("verb", ""))
        what = self.text(c, "then")
        opts = self.rule.get("options") or {}
        if subject == "wait":
            if verb == "wait_until_empty":
                rid = room or next((x["subject"][5:] for s in ("when", "and") for x in self.rule.get(s, []) if str(x.get("subject", "")).startswith("room:")), None)
                sensor = self.room_sensor(rid) if rid else None
                if not sensor:
                    return [self.todo_action(what, self.t("which_room"))]
                return [{"wait_for_trigger": [{"trigger": "state", "entity_id": sensor, "to": "off"}], "timeout": "04:00:00", "continue_on_timeout": True}]
            return [{"delay": _hms(seconds(c.get("for")))}]
        if subject.startswith("notify:"):
            return self._notify(c, what)
        if subject == "mode":
            select = self.own("select", "house_mode")
            if not select:
                return [self.todo_action(what, self.t("no_mode_select"))]
            return [{"action": "select.select_option", "target": {"entity_id": select}, "data": {"option": SELECT_OPTIONS.get(str(c.get("mode", "home")), SELECT_OPTIONS["home"])}}]
        if subject == "alarm":
            panel = self.own("alarm_control_panel", "alarm")
            if not panel:
                return [self.todo_action(what, self.t("no_alarm"))]
            if verb in ("arm_away", "arm_night", "arm_home"):
                return [{"action": f"alarm_control_panel.alarm_{verb}", "target": {"entity_id": panel}}]
            if verb == "trigger":
                return [{"action": "alarm_control_panel.alarm_trigger", "target": {"entity_id": panel}}]
            return [self.todo_action(what, self.t("no_disarm"))]
        if subject.startswith("rule:"):
            if verb == "run":
                return [{"action": f"{INTEGRATION}.run", "data": {"rule_id": subject[5:]}}]
            if verb == "pause":
                return [{"action": f"{INTEGRATION}.pause", "data": {"rule_id": subject[5:], "minutes": round((seconds(c.get("for")) or 3600) / 60)}}]
            return [self.todo_action(what, self.t("unknown_step"))]
        ents = self.res.entities(subject, room, room)
        if not ents:
            return [self.todo_action(what, self.t("no_device"))]
        kind = self.res.kind_of(subject)
        if kind == "lock" and verb == "unlock" and not opts.get("allow_sensitive"):
            return [self.todo_action(what, self.t("no_unlock"))]
        out = self._device(verb, c, ents, what)
        revert = seconds(c.get("for")) if verb not in ("boost", "blink") else None
        if revert and out:
            out.append(self.todo_action(self.t("revert_after", time=_hms(revert)), self.t("restore")))
        return out

    def _notify(self, c: dict[str, Any], what: str) -> list[dict[str, Any]]:
        services = self.core.executor.phones(str(c["subject"]))
        if not services:
            return [self.todo_action(what, self.t("no_phone"))]
        verb = c.get("verb", "send")
        rule = self.rule
        data: dict[str, Any] = {"tag": f"house_rules_{rule['id']}"}
        yes = f"HR_{rule['id']}_YES".upper()
        if verb == "alarm":
            data.update({"push": {"interruption-level": "critical", "sound": {"name": "default", "critical": 1, "volume": 1.0}}, "ttl": 0, "priority": "high", "channel": "alarm_stream"})
        if verb == "ask":
            data["actions"] = [{"action": yes, "title": "Ja"}, {"action": f"HR_{rule['id']}_NO".upper(), "title": "Nein"}]
        msg = {"title": rule.get("name") or "Hausregeln", "message": str(c.get("message") or rule.get("name") or "Hausregeln"), "data": data}
        out: list[dict[str, Any]] = [{"action": f"notify.{s}", "data": msg} for s in services]
        if verb == "ask":
            out.append(
                {
                    "wait_for_trigger": [{"trigger": "event", "event_type": "mobile_app_notification_action", "event_data": {"action": yes}}],
                    "timeout": _hms(seconds(c.get("timeout")) or 900),
                    "continue_on_timeout": False,
                }
            )
        return out

    def _device(self, verb: str, c: dict[str, Any], ents: list[str], what: str) -> list[dict[str, Any]]:  # noqa: C901, PLR0911, PLR0912
        by_domain: dict[str, list[str]] = {}
        for e in ents:
            by_domain.setdefault(e.split(".")[0], []).append(e)
        out: list[dict[str, Any]] = []

        def call(service: str, ids: list[str], data: dict[str, Any] | None = None) -> None:
            a: dict[str, Any] = {"action": service, "target": {"entity_id": _one(ids)}}
            if data:
                a["data"] = data
            out.append(a)

        for domain, ids in by_domain.items():
            if verb == "press":
                call(f"{domain if domain in ('button', 'input_button') else 'button'}.press", ids)
            elif verb == "activate":
                call("scene.turn_on", ids)
            elif verb == "select":
                call(f"{domain if domain in ('select', 'input_select') else 'select'}.select_option", ids, {"option": str(c.get("state", ""))})
            elif verb == "set_value":
                call(f"{domain if domain in ('number', 'input_number') else 'number'}.set_value", ids, {"value": c.get("value", 0)})
            elif verb == "set_text":
                call("input_text.set_value", ids, {"value": str(c.get("state", ""))})
            elif verb == "trigger" and domain == "automation":
                call("automation.trigger", ids)
            elif verb in ("turn_on", "turn_off", "toggle") and domain not in ("light", "climate", "media_player"):
                call(f"{'script' if domain == 'script' else 'homeassistant'}.{verb}", ids)
            elif domain == "light":
                if verb in ("turn_off", "toggle"):
                    call(f"light.{verb}", ids)
                elif verb == "blink":
                    scene = f"hausregeln_{self.rule['id']}_vorher"
                    out.append({"action": "scene.create", "data": {"scene_id": scene, "snapshot_entities": ids}})
                    out.append(
                        {
                            "repeat": {
                                "count": 3,
                                "sequence": [
                                    {"action": "light.turn_on", "target": {"entity_id": _one(ids)}, "data": {"brightness_pct": 100}},
                                    {"delay": {"milliseconds": 1200}},
                                    {"action": "light.turn_off", "target": {"entity_id": _one(ids)}},
                                    {"delay": {"milliseconds": 1200}},
                                ],
                            }
                        }
                    )
                    out.append({"action": "scene.turn_on", "target": {"entity_id": f"scene.{scene}"}})
                else:
                    data: dict[str, Any] = {}
                    if verb == "dim" or c.get("brightness") is not None:
                        data["brightness_pct"] = int(c.get("brightness", 50))
                    if verb == "color":
                        data.update(COLORS.get(str(c.get("color", "warmweiß")), {}))  # i18n-ignore (stored colour name)
                    if c.get("night_dim"):
                        a, b = self.core.checker.window("night")
                        out.append(
                            {
                                "choose": [
                                    {
                                        "conditions": [{"condition": "time", "after": f"{a:02d}:00:00", "before": f"{b:02d}:00:00"}],
                                        "sequence": [{"action": "light.turn_on", "target": {"entity_id": _one(ids)}, "data": {**data, **NIGHT_LIGHT}}],
                                    }
                                ],
                                "default": [{"action": "light.turn_on", "target": {"entity_id": _one(ids)}, **({"data": data} if data else {})}],
                            }
                        )
                    else:
                        call("light.turn_on", ids, data)
            elif domain == "climate":
                if verb == "turn_off":
                    call("climate.set_hvac_mode", ids, {"hvac_mode": "off"})
                elif verb == "turn_on":
                    call("climate.set_hvac_mode", ids, {"hvac_mode": "heat"})
                elif verb == "eco":
                    call("climate.set_temperature", ids, {"temperature": float(self.core.data.get("settings", {}).get("eco_temp", 17))})
                elif verb == "set_temp":
                    if c.get("plan"):
                        temp = float(self.core.plans.heat_target(str(c["plan"]), bool(c.get("preheat")))["temp"])
                        self.note(self.t("heat_plan", what=quote(self.core, what), temp=num(self.core, temp)))
                    else:
                        temp = float(c.get("temperature", 21))
                    call("climate.set_temperature", ids, {"temperature": temp})
                elif verb == "boost":
                    out.append(self.todo_action(what, self.t("boost")))
            elif domain == "cover":
                if verb == "open":
                    call("cover.open_cover", ids)
                elif verb == "close":
                    call("cover.close_cover", ids)
                elif verb == "position":
                    call("cover.set_cover_position", ids, {"position": int(c.get("position", 30))})
            elif domain == "media_player":
                if verb == "pause":
                    call("media_player.media_pause", ids)
                elif verb == "play":
                    call("media_player.media_play", ids)
                elif verb == "volume":
                    call("media_player.volume_set", ids, {"volume_level": max(0, min(1, int(c.get("volume", 20)) / 100))})
                elif verb in ("turn_off", "turn_on"):
                    call(f"media_player.{verb}", ids)
                elif verb == "announce":
                    engines = [s.entity_id for s in self.core.hass.states.async_all("tts")]
                    if not engines:
                        out.append(self.todo_action(what, self.t("no_tts")))
                    else:
                        engine = next((e for e in engines if "cloud" in e), engines[0])
                        out.append({"action": "tts.speak", "target": {"entity_id": engine}, "data": {"media_player_entity_id": _one(ids), "message": str(c.get("message", "")), "cache": True}})
            elif domain == "vacuum":
                if verb in ("start", "clean_rooms"):
                    call("vacuum.start", ids)
                    if verb == "clean_rooms":
                        self.note(self.t("clean_rooms", what=quote(self.core, what)))
                elif verb == "dock":
                    call("vacuum.return_to_base", ids)
            elif domain == "lock" and verb in ("lock", "unlock"):
                call(f"lock.{verb}", ids)
            elif domain == "script" and verb == "run":
                call("script.turn_on", ids)
        if not out:
            out.append(self.todo_action(what, self.t("unknown_step")))
        return out

    # ------------------------------------------------------------------ the whole rule
    def build(self) -> dict[str, Any]:  # noqa: C901, PLR0912
        rule = self.rule
        opts = rule.get("options") or {}
        is_while = rule.get("type") == "while"
        triggers: list[dict[str, Any]] = []
        for c in rule.get("when", []):
            for x in leaves(c):
                # trigger ids stay (for "choose" by trigger)
                triggers += [{**t, "id": x["id"]} if x.get("id") else t for t in self.clause_triggers(x, edges=is_while)]
        if is_while:
            for s in ("and", "only"):
                for c in rule.get(s, []):
                    for x in leaves(c):
                        triggers += self.clause_triggers(x, edges=True)
        # the same trigger twice (e.g. two clauses on one sensor) once
        seen: list[dict[str, Any]] = []
        for t in triggers:
            if t not in seen:
                seen.append(t)
        triggers = seen

        conditions: list[dict[str, Any]] = []
        cd = seconds(opts.get("cooldown"))
        if cd:
            conditions.append(
                {
                    "alias": self.t("cooldown"),
                    "condition": "template",
                    "value_template": f"{{{{ this.attributes.last_triggered is none or (now() - this.attributes.last_triggered).total_seconds() > {int(cd)} }}}}",
                }
            )
        if opts.get("manual_pause"):
            self.note(self.t("manual"))
        if opts.get("notify_me"):
            self.note(self.t("notify_me"))

        same = self.res.uses_same(rule)
        actions: list[dict[str, Any]]
        if is_while:
            holds = [x for s in ("when", "and", "only") for c in rule.get(s, []) if (x := self.clause_condition(c))]
            default = self.steps(rule["else"], None) if rule.get("else") else []
            if not rule.get("else") and opts.get("restore", True):
                default = [self.todo_action(self.t("back"), self.t("restore"))]
            self.note(self.t("while"))
            actions = [{"choose": [{"conditions": holds, "sequence": self.steps(rule["then"], None)}], **({"default": default} if default else {})}]
            if same:
                self.note(self.t("while_same"))
        elif same:
            # one option per room: the room the trigger came from decides the devices
            options = []
            for rid, room in self.core.rooms.items():
                trig_ents = [e for c in rule.get("when", []) for e in self.res.entities(str(c.get("subject", ""))) if self.core.inventory.room_of(e) == rid]
                room_subjects = [str(c.get("subject")) for c in rule.get("when", []) if str(c.get("subject")) == f"room:{rid}"]
                if not trig_ents and not room_subjects:
                    continue
                checks = [x for s in ("and", "only") for c in rule.get(s, []) if (x := self.clause_condition(c, rid))]
                ids = [*trig_ents, *([self.room_sensor(rid)] if room_subjects else [])]
                options.append(
                    {
                        "alias": room.get("name", rid),
                        "conditions": [{"condition": "template", "value_template": f"{{{{ trigger.entity_id in {sorted(set(filter(None, ids)))!r} }}}}"}, *checks],
                        "sequence": self.steps(rule["then"], rid),
                    }
                )
            actions = [{"choose": options}] if options else [self.todo_action(self.t("same_room"), self.t("no_room"))]
        else:
            conditions += [x for s in ("and", "only") for c in rule.get(s, []) if (x := self.clause_condition(c))]
            actions = self.steps(rule["then"], None)

        if not triggers:
            self.note(self.t("no_trigger"))
        description = self.t("description") + (" " + " ".join(self.notes) if self.notes else "")
        return {
            "id": f"hausregeln_{rule['id']}",
            "alias": rule.get("name") or self.t("rule"),
            "description": description[:2000],
            "mode": "restart" if is_while else ("parallel" if same else logic_export.mode(rule, "single")),
            **({"max_exceeded": "silent"} if not is_while and not same else {}),
            "triggers": triggers,
            "conditions": conditions,
            "actions": actions,
        }


def export(core: HouseRules, rule: dict[str, Any]) -> dict[str, Any]:
    ex = _Export(core, rule)
    automation = ex.build()
    head = [tr(core, "export.yaml_head", name=quote(core, str(automation["alias"])))]
    if ex.notes:
        head.append(tr(core, "export.check_head"))
        head += [f"#  - {n}" for n in ex.notes]
    text = "\n".join(head) + "\n" + yaml_dump(automation)
    return {"id": automation["id"], "automation": automation, "yaml": text, "notes": ex.notes, "complete": ex.todo == 0 and bool(automation["triggers"])}
