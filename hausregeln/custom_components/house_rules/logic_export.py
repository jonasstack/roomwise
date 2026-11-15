"""The advanced logic (logic.py) and light settings (lightspec.py) as a Home Assistant automation (export.py).

Groups become and/or/not conditions, blocks become if/choose/repeat/parallel/wait_for_trigger/variables/stop,
trigger ids are kept, a light setting becomes one light.turn_on per lamp with what that lamp understands.
Only "wait until a condition holds" has no template-free counterpart: it is marked as not carried over.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .lightspec import for_light, service_data
from .logic import DAYS, _event_data
from .vocab import seconds

if TYPE_CHECKING:
    from .export import _Export

# i18n: complete

_UNHANDLED: Any = object()


def _hms(value: Any) -> str:
    s = str(value or "").strip()
    neg = s.startswith("-")
    sec = int(seconds(s.lstrip("+-")) or 0)
    return f"{'-' if neg else ''}{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def trigger(exp: _Export, c: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Triggers only logic.py knows; None = not one of them."""
    subject, verb = str(c.get("subject", "")), c.get("verb")
    if subject == "ha_event" and verb == "fired":
        data = _event_data(c.get("event_data"))
        return [{"trigger": "event", "event_type": str(c.get("event_type") or ""), **({"event_data": data} if data else {})}]
    if subject.startswith("event.") and verb == "fired":
        out: dict[str, Any] = {"trigger": "state", "entity_id": subject, "not_to": ["unavailable", "unknown"]}
        if c.get("event_type"):
            exp.note(exp.t("event_type", what=str(c["event_type"])))
        return [out]
    return None


def condition(exp: _Export, c: dict[str, Any], room: str | None) -> Any:
    """Conditions only logic.py knows; _UNHANDLED = not one of them."""
    subject, verb = str(c.get("subject", "")), str(c.get("verb", ""))
    if subject == "logic" and verb in ("all", "any", "not"):
        parts = [p for p in (exp.clause_condition(x, room) for x in c.get("items") or []) if p]
        if verb == "not":
            return {"condition": "not", "conditions": [{"condition": "or", "conditions": parts}] if len(parts) > 1 else parts}
        return {"condition": "and" if verb == "all" else "or", "conditions": parts}
    if subject == "time" and verb == "weekdays":
        days = [d for d in str(c.get("days") or "").split(",") if d.strip()[:3] in DAYS]
        return {"condition": "time", "weekday": [d.strip()[:3] for d in days]}
    if subject == "sun" and verb in ("after_sunset", "before_sunset", "after_sunrise", "before_sunrise"):
        side, event = verb.split("_")
        out: dict[str, Any] = {"condition": "sun", side: event}
        if c.get("offset") and seconds(str(c["offset"]).lstrip("+-")):
            out[f"{side}_offset"] = _hms(c["offset"])
        return out
    if verb == "is_between" and "." in subject:
        ents = exp.res.entities(subject, room)
        if subject.startswith("light."):
            return {"condition": "template", "value_template": f"{{{{ {float(c.get('min', 0))} <= (state_attr('{subject}', 'brightness') or 0) / 2.55 <= {float(c.get('max', 100))} }}}}"}
        return {"condition": "numeric_state", "entity_id": ents or [subject], "above": float(c.get("min", 0)) - 1e-6, "below": float(c.get("max", 100)) + 1e-6}
    return _UNHANDLED


def step(exp: _Export, c: dict[str, Any], room: str | None) -> list[dict[str, Any]] | None:
    """Steps only logic.py knows (and "light: set"); None = not one of them."""
    subject, verb = str(c.get("subject", "")), str(c.get("verb", ""))
    if subject != "logic":
        if verb == "set" and (subject.startswith("light.") or ":light" in subject):
            return _light(exp, c, room)
        return None

    def conds(xs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [p for p in (exp.clause_condition(x, room) for x in xs) if p]

    if verb == "if":
        return [{"if": conds(c.get("if") or []), "then": exp.steps(c.get("then") or [], room), **({"else": exp.steps(c["else"], room)} if c.get("else") else {})}]
    if verb == "choose":
        options = []
        for case in c.get("cases") or []:
            cc = conds(case.get("when") or [])
            if case.get("trigger"):
                cc.insert(0, {"condition": "trigger", "id": list(case["trigger"])})
            options.append({"conditions": cc, "sequence": exp.steps(case.get("then") or [], room)})
        return [{"choose": options, **({"default": exp.steps(c["else"], room)} if c.get("else") else {})}]
    if verb == "repeat":
        body = exp.steps(c.get("then") or [], room)
        if "while" in c:
            return [{"repeat": {"while": conds(c["while"]), "sequence": body}}]
        if "until" in c:
            return [{"repeat": {"until": conds(c["until"]), "sequence": body}}]
        return [{"repeat": {"count": int(c.get("count", 2)), "sequence": body}}]
    if verb == "parallel":
        return [{"parallel": exp.steps(c.get("then") or [], room)}]
    if verb == "wait_trigger":
        trig = [t for x in c.get("items") or [] for t in exp.clause_triggers(x)]
        out: dict[str, Any] = {"wait_for_trigger": trig, "continue_on_timeout": bool(c.get("continue", True))}
        if c.get("timeout"):
            out["timeout"] = _hms(c["timeout"])
        return [out]
    if verb == "wait_until":
        return [exp.todo_action(exp.text(c, "then"), exp.t("wait_until"))]
    if verb == "set":
        src = c.get("from", "trigger")
        attr = c.get("attr")
        if src == "trigger":
            val = f"trigger.to_state.attributes['{attr}']" if attr else "trigger.to_state.state"
        else:
            val = f"state_attr('{src}', '{attr}')" if attr else f"states('{src}')"
        if all(isinstance(c.get(k), (int, float)) for k in ("in_min", "in_max", "out_min", "out_max")) and c["in_max"] != c["in_min"]:
            a, b, x, y = c["in_min"], c["in_max"], c["out_min"], c["out_max"]
            val = f"{x} + ({y} - {x}) * ([0, [1, (({val} | float(0)) - {a}) / ({b} - {a})] | min] | max)"
        return [{"variables": {c["name"]: f"{{{{ {val} }}}}"}}]
    if verb == "stop":
        return [{"stop": exp.text(c, "then")}]
    return None


def _light(exp: _Export, c: dict[str, Any], room: str | None) -> list[dict[str, Any]]:
    spec = c.get("light") or {}
    out = []
    for e in exp.res.entities(str(c.get("subject", "")), room):
        s = for_light(spec, e) or {}
        if s.get("mode") == "off":
            out.append({"action": "light.turn_off", "target": {"entity_id": e}})
        elif s.get("mode") == "scene":
            if s.get("scene") and not any(a.get("target", {}).get("entity_id") == s["scene"] for a in out):
                out.append({"action": "scene.turn_on", "target": {"entity_id": s["scene"]}})
        else:
            st = exp.core.hass.states.get(e)
            out.append({"action": "light.turn_on", "target": {"entity_id": e}, "data": service_data(st.attributes if st else None, s)})
    return out


def mode(rule: dict[str, Any], default: str) -> str:
    m = (rule.get("options") or {}).get("mode")
    return m if m in ("single", "restart", "queued", "parallel") else default


def unhandled(value: Any) -> bool:
    return value is _UNHANDLED
