"""Reading the home: resolving subjects to entities and checking whether a clause holds right now.

A "predicate" answers for one entity state whether it is in the wanted state (window open, light on …).
Events are transitions into a predicate (opens = into "open"), optionally held for a duration.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from homeassistant.const import STATE_HOME, STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import State
from homeassistant.util import dt as dt_util
from homeassistant.util.location import distance

from .i18n import tr
from .logic import holds as logic_holds, predicate as logic_predicate
from .vocab import kinds as vocab_kinds, seconds, verb as find_verb

# i18n: complete

CHANGE_VERBS = ("changes", "pressed", "activated")
# person verbs read from the places module (places.py): rules watch its updates instead of state changes
PLACE_VERBS = ("heading_home", "is_heading_home", "arrives_within", "is_arriving_within", "moving_for", "is_moving_for", "coming_home", "is_near")
ZONE_VERBS = ("enters_zone", "leaves_zone", "in_zone", "not_in_zone")
# "alle sind auf dem Heimweg": persons already at home do not count
HOMEWARD_VERBS = ("heading_home", "is_heading_home", "arrives_within", "is_arriving_within", "coming_home", "is_near")


def uses_places(clause: dict[str, Any]) -> bool:
    """Does a person clause depend on the places module (predictions, learned places)?"""
    verb = clause.get("verb", "")
    return verb in PLACE_VERBS or (verb in ZONE_VERBS and str(clause.get("zone") or "").startswith("lp_"))

if TYPE_CHECKING:
    from .core import HouseRules

Pred = Callable[[State | None], bool]

INACTIVE = (STATE_OFF, "standby", STATE_UNAVAILABLE, STATE_UNKNOWN)
PLACEHOLDER = re.compile(r"^(any|all):([a-z_]+)(?:@([a-z0-9_]+))?$")
# seconds a presence sensor may drop out without ending "belegt seit …" (someone lying still in bed)
PRESENCE_DROPOUT = 60.0

# kinds whose "off" is the quiet state: an unavailable one is as good as off for "alle … sind aus"
PASSIVE_OFF_KINDS = ("light", "media", "outlet", "switch", "fan", "purifier")


def _num(st: State | None) -> float | None:
    try:
        return float(st.state) if st else None
    except ValueError:
        return None


def _is(*states: str) -> Pred:
    return lambda st: bool(st and st.state in states)


def _not(*states: str) -> Pred:
    return lambda st: bool(st and st.state not in (*states, STATE_UNAVAILABLE, STATE_UNKNOWN))


def predicate(core: HouseRules, kind: str, verb: str, clause: dict[str, Any]) -> Pred | None:
    """The wanted state of one entity for a state verb, or for the state an event verb leads to."""
    on, off = _is(STATE_ON), _is(STATE_OFF)
    specs = (find_verb(kind, verb) or {}).get("params") or [{}]
    value = clause.get("value", specs[0].get("default"))
    table: dict[str, Pred] = {}
    if kind in ("window", "door"):
        table = {"opens": on, "is_open": on, "open_for": on, "closes": off, "is_closed": off}
    elif kind in ("light", "switch", "outlet", "fan", "purifier", "script", "input_boolean", "siren", "humidifier", "automation", "camera", "binary_sensor", "water_heater"):
        active: Pred = lambda st: bool(st and st.state not in (STATE_OFF, "idle", STATE_UNAVAILABLE, STATE_UNKNOWN))  # noqa: E731
        is_on = on if kind not in ("camera", "water_heater") else active
        table = {"turns_on": is_on, "is_on": is_on, "on_for": is_on, "turns_off": off, "is_off": off, "off_for": off, "ran": on}
        if kind == "light":
            try:
                pct = float(clause.get("brightness", 50))
            except (TypeError, ValueError):
                pct = 50.0

            def level(st: State | None) -> float | None:
                if not st or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
                    return None
                return (st.attributes.get("brightness") or 0) / 2.55 if st.state == STATE_ON else 0.0

            table["is_brighter"] = table["brighter"] = lambda st: (level(st) is not None and level(st) > pct)  # type: ignore[operator]
            table["is_dimmer"] = table["dimmer"] = lambda st: (level(st) is not None and level(st) < pct)  # type: ignore[operator]
    elif kind == "motion":
        table = {"detected": on, "is_active": on, "clear_for": off, "is_clear": off}
    elif kind in ("zone", "presence"):
        table = {"occupied": on, "is_occupied": on, "free_for": off, "is_free": off}
    elif kind == "leak":
        table = {"wet": on, "is_wet": on}
    elif kind == "climate":
        heating: Pred = lambda st: bool(st and st.attributes.get("hvac_action") == "heating")  # noqa: E731
        table = {"starts_heating": heating, "is_heating": heating}
    elif kind == "cover":
        table = {"opens": _is("open", "opening"), "is_open": _is("open", "opening"), "closes": _is("closed", "closing")}
    elif kind == "media":
        is_on: Pred = lambda st: bool(st and st.state not in INACTIVE)  # noqa: E731
        table = {"turns_on": is_on, "is_on": is_on, "starts_playing": _is("playing", STATE_ON), "is_playing": _is("playing", STATE_ON), "stops": _not("playing", STATE_ON)}
    elif kind == "lock":
        table = {"unlocked": _is("unlocked", "open", "opening"), "is_locked": _is("locked")}
    elif kind == "vacuum":
        table = {"starts": _is("cleaning"), "done": _is("docked", "returning"), "is_docked": _is("docked")}
        today = dt_util.now().date().isoformat()
        cleaned = core.data.setdefault("runtime", {}).setdefault("cleaned", {})
        table["cleaned_today"] = lambda st: bool(st and cleaned.get(st.entity_id) == today)
        table["not_cleaned_today"] = lambda st: bool(st and cleaned.get(st.entity_id) != today)
    elif kind in ("temperature", "illuminance"):
        try:
            limit = float(value)
        except (TypeError, ValueError):
            return None
        below: Pred = lambda st: (_num(st) is not None and _num(st) < limit)  # type: ignore[operator]  # noqa: E731
        above: Pred = lambda st: (_num(st) is not None and _num(st) > limit)  # type: ignore[operator]  # noqa: E731
        table = {"below": below, "is_below": below, "above": above, "is_above": above}
    elif kind == "person":
        home: Pred = lambda st: bool(st and st.state == STATE_HOME)  # noqa: E731
        away: Pred = lambda st: bool(st and st.state not in (STATE_HOME, STATE_UNKNOWN, STATE_UNAVAILABLE))  # noqa: E731

        places = getattr(core, "places", None)
        try:
            near_m = float(clause.get("distance", 2)) * 1000 if verb in ("coming_home", "is_near") else 2000.0
        except (TypeError, ValueError):
            near_m = 2000.0

        def near(st: State | None) -> bool:
            # closer than 2 km (or the set distance) and not moving away (places.py knows the trend)
            if not st or st.state == STATE_HOME:
                return False
            lat, lon = st.attributes.get("latitude"), st.attributes.get("longitude")
            if lat is None or lon is None:
                return False
            d = distance(core.hass.config.latitude, core.hass.config.longitude, lat, lon)
            if d is None or d >= near_m:
                return False
            s = places.sync(st) if places else None
            return not (s and s.get("trend") == "away")

        def status(st: State | None) -> dict[str, Any] | None:
            return places.sync(st) if places and st else None

        try:
            num = float(clause.get("value", specs[0].get("default") if specs else 0) or 0)
        except (TypeError, ValueError):
            num = 0.0

        def heading_home(st: State | None) -> bool:
            # the prediction says home, at least as sure as wanted (percent, default 60)
            s = status(st)
            p = (s or {}).get("prediction") or {}
            return bool(s and s["kind"] == "moving" and p.get("destination") == "home" and p.get("probability", 0) * 100 >= (num or 60))

        def arriving(st: State | None) -> bool:
            # home in less than N minutes (prediction home with at least 50 %)
            s = status(st)
            p = (s or {}).get("prediction") or {}
            return bool(s and s["kind"] == "moving" and p.get("destination") == "home" and p.get("probability", 0) >= 0.5 and p.get("eta_min") is not None and p["eta_min"] <= (num or 10))

        def moving_for(st: State | None) -> bool:
            s = status(st)
            return bool(s and s["kind"] == "moving" and s.get("since") and time.time() - s["since"] >= (num or 30) * 60)

        zid = str(clause.get("zone") or "home")
        zst = core.hass.states.get(f"zone.{zid}")
        names = {zid.lower(), str(zst.attributes.get("friendly_name", "")).lower() if zst else zid.lower()}

        def in_zone(st: State | None) -> bool:
            if not st:
                return False
            if zid.startswith("lp_"):
                # a learned place (places.py)
                return bool(places and status(st) is not None and places.at(st.entity_id, zid))
            return st.state == STATE_HOME if zid == "home" else st.state.lower() in names

        def out_zone(st: State | None) -> bool:
            return bool(st and st.state not in (STATE_UNKNOWN, STATE_UNAVAILABLE) and not in_zone(st))

        try:
            km = float(clause.get("distance", 100))
        except (TypeError, ValueError):
            km = 100.0
        fz = str(clause.get("zone") or "home")
        zst = core.hass.states.get(f"zone.{fz}")
        zlat = zst.attributes.get("latitude") if zst else core.hass.config.latitude
        zlon = zst.attributes.get("longitude") if zst else core.hass.config.longitude

        def far(st: State | None) -> bool:
            # far away from a place (by the phone's location), e.g. for the vacation mode
            if not st or (st.state == STATE_HOME and fz == "home"):
                return False
            lat, lon = st.attributes.get("latitude"), st.attributes.get("longitude")
            if lat is None or lon is None or zlat is None or zlon is None:
                return False
            d = distance(zlat, zlon, lat, lon)
            return d is not None and d > km * 1000

        table = {
            "far_from": far,
            "is_far": far,
            "arrives": home,
            "is_home": home,
            "leaves": away,
            "is_away": away,
            "is_near": near,
            "coming_home": near,
            "heading_home": heading_home,
            "is_heading_home": heading_home,
            "arrives_within": arriving,
            "is_arriving_within": arriving,
            "moving_for": moving_for,
            "is_moving_for": moving_for,
            "enters_zone": in_zone,
            "in_zone": in_zone,
            "leaves_zone": out_zone,
            "not_in_zone": out_zone,
        }
    elif kind in ("sensor", "number", "input_number", "select", "input_select", "input_text", "entity", "event", "button", "input_button", "scene"):
        want = str(clause.get("state", "")).strip().lower()
        try:
            want_num: float | None = float(want.replace(",", "."))
        except ValueError:
            want_num = None

        def equal(st: State) -> bool:
            # numbers by value: a sensor reports "800.0" for the "800" in the rule
            if want_num is not None and (n := _num(st)) is not None:
                return n == want_num
            return st.state.lower() == want

        same: Pred = lambda st: bool(st and equal(st))  # noqa: E731
        other: Pred = lambda st: bool(st and st.state not in (STATE_UNAVAILABLE, STATE_UNKNOWN) and not equal(st))  # noqa: E731
        try:
            limit = float(clause.get("value", 0))
        except (TypeError, ValueError):
            limit = 0.0
        hi: Pred = lambda st: (_num(st) is not None and _num(st) > limit)  # type: ignore[operator]  # noqa: E731
        lo: Pred = lambda st: (_num(st) is not None and _num(st) < limit)  # type: ignore[operator]  # noqa: E731
        anything: Pred = lambda st: st is not None  # noqa: E731
        table = {"becomes": same, "is": same, "is_not": other, "above": hi, "is_above": hi, "below": lo, "is_below": lo, **dict.fromkeys(CHANGE_VERBS, anything)}
    elif kind in ("device_tracker", "vehicle"):
        table = {"arrives": _is(STATE_HOME), "is_home": _is(STATE_HOME), "leaves": _not(STATE_HOME), "is_away": _not(STATE_HOME)}
    elif kind == "group":
        # a group of different devices: "on" = anything but off/standby/closed
        g_on: Pred = lambda st: bool(st and st.state not in (*INACTIVE, "closed", "locked", "docked"))  # noqa: E731
        g_off: Pred = lambda st: bool(st and st.state in (STATE_OFF, "standby", "closed", "locked", "docked"))  # noqa: E731
        table = {"turns_on": g_on, "is_on": g_on, "on_for": g_on, "turns_off": g_off, "is_off": g_off, "off_for": g_off}
    # numbers between two values and other building blocks of the advanced logic (logic.py)
    return table.get(verb) or logic_predicate(kind, verb, clause)


def duration_of(kind: str, verb: str, clause: dict[str, Any]) -> float | None:
    """How long the state must hold: the verb's own duration (open_for …) or a 'for' on the clause."""
    v = find_verb(kind, verb) or {}
    if any(p["key"] == "for" for p in v.get("params", [])):
        return seconds(clause.get("for") or next(p.get("default") for p in v["params"] if p["key"] == "for"))
    return seconds(clause.get("for"))


class Resolver:
    """Subjects → entities, with "@same" (the room the rule was set off in) and room scoping."""

    def __init__(self, core: HouseRules) -> None:
        self.core = core

    def kind_of(self, subject: str) -> str:
        m = PLACEHOLDER.match(subject)
        if m:
            return m.group(2)
        for prefix, kind in (("room:", "room"), ("zone:", "zone"), ("person:", "person"), ("notify:", "notify"), ("rule:", "rule")):
            if subject.startswith(prefix):
                return kind
        if subject.startswith("group:"):
            inv = self.core.inventory
            kinds = {inv.devices[e]["kind"] for e in self.entities(subject) if e in inv.devices}
            return kinds.pop() if len(kinds) == 1 else "group"
        if subject in ("time", "sun", "mode", "wait", "alarm"):
            return subject
        dev = self.core.inventory.devices.get(subject)
        if dev:
            return str(dev["kind"])
        # any other entity: its domain, if the vocabulary knows it, else "entity"
        domain = subject.split(".")[0]
        return domain if domain in vocab_kinds() or "." not in subject else "entity"

    def mode_of(self, subject: str) -> str:
        """'all' when every entity must match (alle …), else 'any'."""
        if subject.startswith("group:"):
            g = self.core.group(subject[6:])
            return "all" if g and g.get("match") == "all" else "any"
        return "all" if subject.startswith("all:") or subject == "person:everyone" else "any"

    def counted(self, subject: str, ents: list[str], verb: str | None = None) -> list[str]:
        """For "jemand"/"alle": persons without a location (unknown, e.g. no tracker) do not count, unless nobody has one.
        "alle … auf dem Heimweg": who is already at home does not count either (unless everybody is).
        "alle Lichter … sind aus": a lamp that is unavailable (unplugged, off at the wall switch) gives no light and
        must not keep "all off" from ever holding; it counts only when every one of them is unavailable."""
        m = PLACEHOLDER.match(subject)
        if m and m.group(1) == "all" and m.group(2) in PASSIVE_OFF_KINDS and verb in ("is_off", "off_for", "turns_off"):
            there = [e for e in ents if (st := self.core.hass.states.get(e)) and st.state not in (STATE_UNKNOWN, STATE_UNAVAILABLE)]
            return there or ents
        if subject not in ("person:everyone", "person:someone"):
            return ents
        known = [e for e in ents if (st := self.core.hass.states.get(e)) and st.state not in (STATE_UNKNOWN, STATE_UNAVAILABLE)]
        known = known or ents
        if subject == "person:everyone" and verb in HOMEWARD_VERBS:
            out = [e for e in known if (st := self.core.hass.states.get(e)) and st.state != STATE_HOME]
            return out or known
        return known

    def entities(self, subject: str, room: str | None = None, scope: str | None = None) -> list[str]:
        """room = the room the rule was set off in (for @same); scope = restrict placeholders without a room."""
        inv = self.core.inventory
        m = PLACEHOLDER.match(subject)
        if m:
            where = m.group(3)
            if where == "same":
                where = room or scope
                if where is None:
                    return []
            elif where is None and scope:
                where = scope
            return inv.in_room(m.group(2), where)
        if subject.startswith("zone:"):
            return [subject[5:]]
        if subject.startswith("group:"):
            g = self.core.group(subject[6:])
            return [e for e in (g or {}).get("members", []) if self.core.hass.states.get(e) is not None]
        if subject.startswith("person:"):
            pid = subject[7:]
            if pid in ("someone", "everyone"):
                return [p["entity_id"] for p in inv.persons.values()]
            p = inv.persons.get(pid)
            return [p["entity_id"]] if p else []
        if "." in subject:
            return [subject]
        return []

    def uses_same(self, rule: dict[str, Any]) -> bool:
        return any(c.get("subject", "").endswith("@same") for s in ("when", "and", "then", "only", "else") for c in rule.get(s, []))


class Checker:
    """Does a clause hold right now? Returns (ok, what it is now, seconds until it may hold)."""

    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self.res = Resolver(core)
        # "seit …" for values that change all the time (lux, °C, brightness): since when the condition holds,
        # as seen by the checks (the state's last_changed moves with every new value)
        self._true_since: dict[tuple[str, str], float] = {}
        # "belegt seit …" of presence sensors: [start of the stay, last moment seen occupied] per entity, so a short
        # drop-out (an mmWave sensor losing someone lying still for a few seconds) does not start the time again
        self._stay: dict[str, list[float]] = {}

    def _occupied_since(self, entity: str, st: State, ok: bool) -> float:
        changed = st.last_changed.timestamp()
        stay = self._stay.get(entity)
        if not ok:
            if stay:
                stay[1] = changed  # it was occupied until this moment
            return 0.0
        now = time.time()
        if stay and stay[0] <= changed and changed - stay[1] <= PRESENCE_DROPOUT:
            stay[1] = now
            return stay[0]
        if len(self._stay) > 500:
            self._stay.clear()
        self._stay[entity] = [changed, now]
        return changed

    def _since(self, clause: dict[str, Any], entity: str, st: State, ok: bool) -> float:
        key = (repr(sorted((k, v) for k, v in clause.items() if k != "or")), entity)
        if not ok:
            self._true_since.pop(key, None)
            return 0.0
        if len(self._true_since) > 2000:
            self._true_since.clear()
        return self._true_since.setdefault(key, st.last_changed.timestamp())

    def window(self, name: str) -> tuple[int, int]:
        times = self.core.data.get("settings", {}).get("times", {})
        default = {"night": (22, 6), "morning": (6, 10), "evening": (18, 22)}[name]
        t = times.get(name) or default
        return int(t[0]), int(t[1])

    def _in_window(self, start: float, end: float, now: datetime) -> bool:
        h = now.hour + now.minute / 60
        return start <= h < end if start <= end else (h >= start or h < end)

    def holds(self, clause: dict[str, Any], room: str | None = None, scope: str | None = None) -> tuple[bool, str, float | None]:
        extra = logic_holds(self, clause, room, scope)  # and/or/not groups, weekdays, sun with offsets (logic.py)
        if extra is not None:
            return extra
        if clause.get("or"):
            # one of the alternatives is enough
            base = {k: v for k, v in clause.items() if k != "or"}
            texts: list[str] = []
            wait: float | None = None
            for c in (base, *clause["or"]):
                ok, now_text, w = self.holds(c, room, scope)
                if ok:
                    return True, now_text, None
                texts.append(now_text)
                if w is not None:
                    wait = w if wait is None else min(wait, w)
            return False, " / ".join(t for t in texts if t), wait
        core = self.core
        subject = clause.get("subject", "")
        verb = clause.get("verb", "")
        kind = self.res.kind_of(subject)
        now = dt_util.now()

        if subject == "time":
            now_text = tr(core, "engine.now_time", time=f"{now:%H:%M}")
            if verb == "at":
                return True, now_text, None
            if verb in ("night", "morning", "evening"):
                a, b = self.window(verb)
                return self._in_window(a, b, now), now_text, None
            if verb == "between":
                a = _hm(clause.get("from", "08:00"))
                b = _hm(clause.get("to", "20:00"))
                return self._in_window(a, b, now), now_text, None
            if verb in ("workdays", "weekend"):
                wd = self._workday(now)
                return (wd if verb == "workdays" else now.weekday() >= 5), now.strftime("%A"), None
            return True, "", None
        if subject == "sun":
            sun = core.hass.states.get("sun.sun")
            down = bool(sun and sun.state == "below_horizon")
            if verb in ("is_down", "is_up"):
                return (down if verb == "is_down" else not down), tr(core, "engine.dark_outside" if down else "engine.light_outside"), None
            return True, "", None
        if subject == "mode":
            mode = core.mode
            want = clause.get("mode", "home")
            label = core.mode_label(mode)
            if verb == "is":
                return mode == want, tr(core, "engine.now_mode", mode=label), None
            if verb == "is_not":
                return mode != want, tr(core, "engine.now_mode", mode=label), None
            return True, tr(core, "engine.now_mode", mode=label), None
        if subject == "alarm":
            a = core.alarm
            armed = a.state.startswith("armed_") or a.state in ("pending", "triggered")
            ok = {"is_armed": armed, "is_disarmed": a.state == "disarmed", "is_triggered": a.state == "triggered"}.get(verb, True)
            return ok, tr(core, "engine.now_alarm", state=a.view()["label"]), None
        if subject.startswith("rule:"):
            rid = subject[5:]
            if verb == "is_active":
                act = core.engine.is_active(rid)
                return act, tr(core, "engine.rule_active" if act else "engine.rule_inactive"), None
            return True, "", None
        if subject.startswith("room:"):
            rid = subject[5:]
            occ = core.room_tracker.occupied(rid)
            since = time.time() - core.room_tracker.changed_at(rid)
            st = core.room_tracker.state.get(rid, {})
            txt = tr(core, "engine.occupied_by", by=st.get("by")) if occ and st.get("by") else tr(core, "engine.occupied" if occ else "engine.empty")
            if verb in ("is_dark", "is_bright"):
                lux = core.room_tracker.lux(rid)
                dark = core.room_tracker.is_dark(rid)
                ok = dark if verb == "is_dark" else not dark
                txt = f"{lux:.0f} lx" if lux is not None else tr(core, "engine.dark_outside" if dark else "engine.light_outside")
                need = seconds(clause.get("for")) or 0
                key = (repr(sorted((k, v) for k, v in clause.items() if k != "or")), rid)
                if not ok:
                    self._true_since.pop(key, None)
                    return False, txt, None
                t = time.time()
                held = t - self._true_since.setdefault(key, t)
                return (True, txt, None) if held >= need else (False, txt, need - held)
            want = verb in ("is_occupied", "entered")
            need = seconds(clause.get("for")) or 0
            if occ == want:
                if since >= need:
                    return True, txt, None
                return False, txt, need - since
            return False, txt, None

        pred = predicate(core, kind, verb, clause)
        if pred is None:
            return True, tr(core, "engine.not_checkable"), None
        ents = self.res.entities(subject, room, scope)
        if not ents:
            return False, tr(core, "engine.no_device"), None
        ents = self.res.counted(subject, ents, verb)
        need = seconds(clause.get("for")) or 0
        mode = self.res.mode_of(subject)
        oks: list[bool] = []
        wait: float | None = None
        hits: list[str] = []
        for e in ents:
            st = core.hass.states.get(e)
            ok = pred(st)
            if need and st:
                # on/off states: the state's own last change; values and attributes: since when the checks saw it hold
                numeric = _num(st) is not None or verb in ("is_brighter", "is_dimmer", "brighter", "dimmer")
                if kind in ("zone", "presence") and verb in ("is_occupied", "occupied"):
                    since = self._occupied_since(e, st, ok)
                else:
                    since = self._since(clause, e, st, ok) if numeric else st.last_changed.timestamp()
                held = time.time() - since
                if ok and held < need:
                    ok = False
                    wait = need - held if wait is None else min(wait, need - held)
            oks.append(ok)
            if ok:
                hits.append(core.inventory.devices.get(e, {}).get("name") or (st.attributes.get("friendly_name") if st else e))
        result = all(oks) if mode == "all" else any(oks)
        return result, self._now_text(kind, ents, hits, mode), (None if result else wait)

    def _now_text(self, kind: str, ents: list[str], hits: list[str], mode: str) -> str:
        core = self.core
        if kind == "person":
            view = {p["entity_id"]: p["line"] for p in core.places.view()["persons"]} if getattr(core, "places", None) else {}
            return ", ".join(f"{p['name']}: {view.get(p['entity_id']) or core.inventory.person_where(p['id'])}" for p in core.inventory.persons.values() if p["entity_id"] in ents)
        if len(ents) == 1:
            st = core.hass.states.get(ents[0])
            if not st:
                return tr(core, "engine.not_there")
            unit = st.attributes.get("unit_of_measurement")
            return f"{st.state} {unit}" if unit else _word(core, st.state)
        if hits:
            return tr(core, "engine.matching", names=f"{', '.join(hits[:4])}{' …' if len(hits) > 4 else ''}")
        return tr(core, "engine.none_of", n=len(ents))

    def _workday(self, now: datetime) -> bool:
        # the Workday integration's sensor, whatever it is called (its default name depends on the language)
        from homeassistant.helpers import entity_registry as er

        eid, looked = getattr(self, "_workday_eid", (None, -1e9))
        if time.monotonic() - looked > 600:  # looked up again every 10 minutes (added, renamed)
            eid = next((e.entity_id for e in er.async_get(self.core.hass).entities.values() if e.platform == "workday" and e.domain == "binary_sensor" and not e.disabled), "binary_sensor.workday_sensor")
            self._workday_eid = (eid, time.monotonic())
        wd = self.core.hass.states.get(eid)
        if wd and wd.state in (STATE_ON, STATE_OFF):
            return wd.state == STATE_ON
        return now.weekday() < 5


def _hm(value: Any) -> float:
    try:
        h, m = str(value).split(":")[:2]
        return int(h) + int(m) / 60
    except ValueError:
        return 0.0


def _word(where: Any, state: str) -> str:
    return tr(where, f"engine.state_{state}") if state in ("on", "off", "unavailable", "unknown") else state
