"""Light per room ("Licht" tab): a few room settings and the room's own light rules, set up step by step.

Room settings: guests (never off by itself), vacation (which lights, from when to when, how bright), hand
(switched by a person: leave it until the room was empty / 30 min / not at all), "nobody there any more"
(after how many minutes: off, dim first, or leave on). Who is there and the light sensor are the room's own
sensors (tab "Räume"), so "room occupied" means the same everywhere.

Light rules, four kinds:
  * when      – something happens (a condition becomes true: room entered, sofa occupied, TV on, a time …),
                optionally only if …: switch lights, "je nach …" variants (first matching variant wins)
  * while     – as long as something holds: lights like this; afterwards: back as before / off / unchanged /
                whatever the other rules say
  * never_on  – these lights never go on while …
  * keep_on   – these lights never go off while … (e.g. TV on: you only fetch a drink); afterwards, if the
                room is empty: off / dim / leave on

A lamp that a person, a house rule or another automation set counts as set by hand: the plan leaves it (the room's
"by hand" setting), and a "when" rule that fired before does not take it back later – it sets its lights once when
it fires. Only users set up as automations (Node-RED …), the minutes right after a start and what a "never on"
forbids are put back right away. Several rules for one light: never-on/keep-on win, then the more specific
"while" rule (more conditions), then the last "when" rule that fired.

What the plan sends is sent once and given time (fade, late radios) before it is sent again, at most MAX_SENDS
times: a lamp that reports its colour or brightness its own way is not spammed. A lamp that is off and gets a
colour powers up in that colour (actions.call_together, lightspec.power_up).
"""

from __future__ import annotations

import logging
import random
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.const import STATE_ON
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers.event import async_call_later, async_track_state_change_event, async_track_time_interval
from homeassistant.util import dt as dt_util

from . import lightspec
from .actions import call_together
from .glow import IDS as GLOW_IDS, clean_glow, clean_global as clean_glow_global, default_glow, glow_rules
from .lightlearn import clean_smart, default_smart
from .lightspec import clean_action, color_ok, for_light
from .logic import leaves

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

KINDS = ("when", "while", "never_on", "keep_on")
# a lamp reports a call of Hausregeln this long afterwards at most (late radios, the steps of a fade)
LATE_REPORT = 15
# a lamp switched on by a command: its other lamps and the conditions depending on them settle this long
# before a "never on" switches it off again (a command sets several lamps; they report one after another)
SETTLE = 3.0
# after sending a lamp a setting: wait this long (plus the fade) for its report before sending it again …
RESEND_WAIT = 2.5
# … and send the same setting at most this often: a lamp that reports it differently is left alone, not spammed
MAX_SENDS = 3


def default_plan() -> dict[str, Any]:
    return {
        "on": False,
        "rules": [],
        # nobody there any more: after `delay` minutes off / dim first (dim %, off after dim_for minutes, 0 = stays) / keep
        "empty": {"mode": "off", "delay": 2, "dim": 10, "dim_for": 5},
        "manual": "room_empty",  # room_empty | 30m | none
        "guests_keep": True,
        # vacation: look lived-in
        "vacation": {"on": False, "lights": [], "start": "sunset", "offset": 15, "time": "19:00", "end": "23:00", "brightness": 70, "color": "warm", "random": True},
        # intelligent light (lightlearn.py): learns from hand changes; off | shadow (only shows) | on
        "smart": default_smart(),
        # Reinschau-Licht (glow.py): glows softly while someone is next door; becomes two rules of this plan
        "glow": default_glow(),
    }


def _num(v: Any, d: float, lo: float, hi: float) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return d


def _hm(s: Any) -> int | None:
    try:
        h, m = str(s).split(":")[:2]
        return (int(h) % 24) * 60 + int(m) % 60
    except (ValueError, AttributeError):
        return None


class LightPlanner:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._unsub: list[Callable[[], None]] = []
        self._pending: dict[str, CALLBACK_TYPE] = {}
        self._pending_at: dict[str, float] = {}
        self._ours: dict[str, float] = {}  # context ids of our own calls
        self._rt: dict[str, dict[str, Any]] = {}  # room → runtime state
        self._on_src: dict[str, tuple[str, float]] = {}  # light → who switched it on last (manual / rule:<id> / automation / ours)
        self._gone: dict[str, dict[str, Any]] = {}  # light → its setting right before it became unreachable

    # ------------------------------------------------------------------ data
    @property
    def store(self) -> dict[str, Any]:
        return self.core.data.setdefault("plans", {}).setdefault("light", {})

    def plan(self, rid: str) -> dict[str, Any]:
        raw = self.store.get(rid, {})
        d = default_plan()
        p = {**d, **{k: v for k, v in raw.items() if k in d}}
        for k in ("empty", "vacation", "glow"):
            p[k] = {**d[k], **(raw.get(k) if isinstance(raw.get(k), dict) else {})}
        sm = raw.get("smart") if isinstance(raw.get("smart"), dict) else {}
        p["smart"] = {**d["smart"], **sm, "guards": {**d["smart"]["guards"], **(sm.get("guards") or {})}}
        if isinstance(raw.get("empty"), dict) and "mode" not in raw["empty"]:
            # second version: {dim, after}
            e = raw["empty"]
            p["empty"] = {**d["empty"], "mode": "dim" if e.get("dim") else ("off" if raw.get("off_empty", True) else "keep"), "dim": e.get("dim") or 10, "dim_for": e.get("after", 5)}
        if not raw.get("rules") and (raw.get("situations") or raw.get("blocks")):
            p["rules"] = self._migrate(raw)
        return p

    @staticmethod
    def _migrate(raw: dict[str, Any]) -> list[dict[str, Any]]:
        """Second version (situations, blocks) → light rules."""
        out: list[dict[str, Any]] = []
        base = {"enabled": True, "trigger": [], "variants": [], "after": "others", "empty_after": "off"}
        for s in raw.get("situations") or []:
            out.append(
                {
                    **base,
                    "id": s.get("id") or uuid.uuid4().hex[:6],
                    "name": s.get("name", "Situation"),
                    "kind": "while",
                    "when": s.get("when") or [],
                    "lights": s.get("lights") or raw.get("lights") or [],
                    "action": {"mode": "off" if s.get("off") else "on", "brightness": s.get("brightness", 60), "color": s.get("color", "warm")},
                }
            )
        for b in raw.get("blocks") or []:
            out.append(
                {
                    **base,
                    "id": b.get("id") or uuid.uuid4().hex[:6],
                    "name": b.get("name", "Nie an"),
                    "kind": "never_on",
                    "when": b.get("when") or [],
                    "lights": b.get("lights") or [],
                    "action": {"mode": "on", "brightness": 50, "color": "warm"},
                }
            )
        return out

    def _clean_rule(self, r: Any) -> dict[str, Any] | None:
        if not isinstance(r, dict) or r.get("kind") not in KINDS:
            return None
        sanitize = self.core.sanitize_clause

        def clauses(v: Any) -> list[dict[str, Any]]:
            return [c for c in (sanitize(x) for x in (v or [])[:10]) if c]

        def lights(v: Any) -> list[str]:
            return [e for e in (v or []) if isinstance(e, str) and e.startswith("light.")][:40]

        def action(a: Any) -> dict[str, Any]:
            # on/off/scene, brightness, colour (any colour mode), effect, fade, flash, each lamp its own (lightspec.py)
            return clean_action(a)

        return {
            "id": str(r.get("id") or uuid.uuid4().hex[:6])[:12],
            "name": str(r.get("name") or "Lichtregel")[:60],
            "enabled": bool(r.get("enabled", True)),
            "kind": r["kind"],
            "trigger": clauses(r.get("trigger")) if r["kind"] == "when" else [],
            "when": clauses(r.get("when")),
            "lights": lights(r.get("lights")),
            "action": action(r.get("action")),
            "variants": [{"id": str(v.get("id") or uuid.uuid4().hex[:6])[:12], "when": clauses(v.get("when")), **action({k: x for k, x in v.items() if k not in ("id", "when")})} for v in (r.get("variants") or [])[:8] if isinstance(v, dict)],
            "after": r.get("after") if r.get("after") in ("restore", "off", "nothing", "others") else "others",
            "empty_after": r.get("empty_after") if r.get("empty_after") in ("off", "dim", "keep") else "off",
            # while: before "afterwards" first wait the room's "nobody there any more" time and dim as set there
            "follow_empty": bool(r.get("follow_empty", True)),
            # while, follow_empty off: an own cool-down instead (wait, optionally dim; 0 = right away)
            "own_end": {
                "delay": _num((r.get("own_end") or {}).get("delay", 0), 0, 0, 240),
                "dim": int(_num((r.get("own_end") or {}).get("dim", 0), 0, 0, 100)),
                "dim_for": _num((r.get("own_end") or {}).get("dim_for", 0), 0, 0, 240),
            },
            # while: these lights may not go on while it holds ("Sperren")
            "block_lights": lights(r.get("block_lights")) if r["kind"] == "while" else [],
            # never_on / keep_on / the block of a while rule: not when one of these holds ("außer wenn …")
            "except": clauses(r.get("except")),
            # never_on / the block of a while rule: these rules may switch the light on anyway
            # ("light:<id>" = a light rule of this room, "rule:<id>" = a house rule)
            "allow": [str(x)[:60] for x in (r.get("allow") or []) if isinstance(x, str) and x.startswith(("light:", "rule:"))][:20],
            # never_on / keep_on: only while these light rules (while) hold
            "linked": [str(x)[:12] for x in (r.get("linked") or []) if isinstance(x, str)][:10] if r["kind"] in ("never_on", "keep_on") else [],
        }

    def save(self, rid: str, raw: dict[str, Any]) -> None:
        if rid not in self.core.rooms:
            raise ValueError("Unbekannter Raum")
        p = self.plan(rid)
        if isinstance(raw.get("on"), bool):
            p["on"] = raw["on"]
        if isinstance(raw.get("guests_keep"), bool):
            p["guests_keep"] = raw["guests_keep"]
        if raw.get("manual") in ("room_empty", "30m", "none"):
            p["manual"] = raw["manual"]
        if isinstance(e := raw.get("empty"), dict):
            p["empty"] = {
                "mode": e.get("mode") if e.get("mode") in ("off", "dim", "keep") else p["empty"]["mode"],
                "delay": _num(e.get("delay", p["empty"]["delay"]), 2, 0, 240),
                "dim": int(_num(e.get("dim", p["empty"]["dim"]), 10, 1, 100)),
                "dim_for": _num(e.get("dim_for", p["empty"]["dim_for"]), 5, 0, 240),
            }
        if isinstance(v := raw.get("vacation"), dict):
            cur = p["vacation"]
            p["vacation"] = {
                "on": bool(v.get("on", cur["on"])),
                "lights": [x for x in (v.get("lights", cur["lights"]) or []) if isinstance(x, str) and x.startswith("light.")][:40],
                "start": v.get("start") if v.get("start") in ("sunset", "time") else cur["start"],
                "offset": int(_num(v.get("offset", cur["offset"]), 15, -120, 240)),
                "time": str(v.get("time") or cur["time"])[:5],
                "end": str(v.get("end") or cur["end"])[:5],
                "brightness": int(_num(v.get("brightness", cur["brightness"]), 70, 1, 100)),
                "color": str(v.get("color")).lower() if color_ok(v.get("color")) else cur["color"],
                "random": bool(v.get("random", cur["random"])),
            }
        if isinstance(raw.get("rules"), list):
            p["rules"] = [r for r in (self._clean_rule(x) for x in raw["rules"][:30]) if r]
        if isinstance(raw.get("smart"), dict):
            p["smart"] = clean_smart(raw["smart"], p["smart"], self.core.sanitize_clause)
        if isinstance(raw.get("glow"), dict) or isinstance(raw.get("rules"), list):
            # Reinschau-Licht: its two rules are rebuilt from the setting (rules made by hand for the same may go)
            if isinstance(raw.get("glow"), dict):
                p["glow"] = clean_glow(raw["glow"], p.get("glow"), set(self.core.rooms))
            drop = {x for x in (raw.get("glow_replace") or []) if isinstance(x, str)} if p["glow"].get("on") else set()
            made = [r for r in (self._clean_rule(x) for x in glow_rules(rid, p["glow"], (self.core.rooms.get(rid) or {}).get("name", rid), p["rules"], self.glow_global)) if r]
            p["rules"] = [r for r in p["rules"] if r["id"] not in GLOW_IDS and r["id"] not in drop][: 30 - len(made)] + made
        self.store[rid] = p
        self.core.save()
        self._rt.pop(rid, None)
        self.start()

    @property
    def glow_global(self) -> dict[str, Any]:
        """When the Reinschau-Licht may glow at all (one setting for every room, glow.py)."""
        return clean_glow_global(None, self.core.data.get("glow"))

    def save_glow_global(self, raw: dict[str, Any]) -> None:
        """Change when the Reinschau-Licht may glow; the glow rules of every room are built again."""
        self.core.data["glow"] = clean_glow_global(raw, self.core.data.get("glow"))
        for rid in list(self.store):
            if rid in self.core.rooms and (self.plan(rid).get("glow") or {}).get("on"):
                self.save(rid, {"glow": {}})
        self.core.save()

    # ------------------------------------------------------------------ helpers
    def room_lights(self, rid: str) -> list[str]:
        return self.core.inventory.in_room("light", rid)

    def all_lights(self, rid: str, p: dict[str, Any]) -> list[str]:
        out = list(self.room_lights(rid))
        for r in p["rules"]:
            out += r["lights"] + (r.get("block_lights") or [])
        out += p["vacation"]["lights"]
        return [e for e in dict.fromkeys(out) if self.hass.states.get(e)]

    def _lights_of(self, rid: str, r: dict[str, Any]) -> list[str]:
        return r["lights"] or self.room_lights(rid)

    def _watched(self, rid: str, p: dict[str, Any]) -> set[str]:
        res = self.core.checker.res
        ents: set[str] = set(self.all_lights(rid, p))
        ents.add("sun.sun")
        room = self.core.rooms.get(rid) or {}
        if room.get("lux"):
            ents.add(room["lux"])
        guards = [*(p["smart"]["guards"].get("off_while") or [])] if p["smart"]["mode"] != "off" else []
        for c in guards:
            for x in leaves(c):
                ents.update(res.entities(str(x.get("subject", "")), rid, rid))
        for r in p["rules"]:
            for c in [*r["trigger"], *r["when"], *(r.get("except") or []), *(c for v in r["variants"] for c in v["when"])]:
                for x in leaves(c):
                    ents.update(res.entities(str(x.get("subject", "")), rid, rid))
        return {e for e in ents if "." in e}

    def _holds(self, rid: str, clauses: list[dict[str, Any]]) -> bool:
        ok = True
        for c in clauses:
            hit, _now, wait = self.core.checker.holds(c, rid, rid)
            if not hit:
                ok = False
                if wait is not None:
                    self.schedule(rid, wait + 0.5)  # "seit …" not long enough yet: look again then
        return ok

    @staticmethod
    def _specific(r: dict[str, Any]) -> int:
        return len(r["trigger"]) + len(r["when"])

    def _result(self, rid: str, r: dict[str, Any]) -> dict[str, Any]:
        """What a rule wants for its lights right now: the first matching variant, else its action."""
        for v in r["variants"]:
            if v["when"] and self._holds(rid, v["when"]):
                spec = {k: x for k, x in v.items() if k not in ("id", "when")}
                return {**spec, "why": f"{r['name']} ({self.core.describer.clause(v['when'][0], 'and')})", "rule": r["id"]}
        return {**r["action"], "why": r["name"], "rule": r["id"]}

    # ------------------------------------------------------------------ runtime
    def start(self) -> None:
        self.stop()
        if not self.core.feature("light"):
            return  # feature "light" off: no listeners, nothing is switched
        rooms = [rid for rid in self.core.rooms if self.store.get(rid, {}).get("on")]
        if not rooms:
            return
        ents: set[str] = set()
        for rid in rooms:
            ents |= self._watched(rid, self.plan(rid))
        if ents:
            self._unsub.append(async_track_state_change_event(self.hass, list(ents), self._changed))
        self._unsub.append(self.core.room_tracker.add_listener(self._room_changed))
        # the dark signal of a room changed (hysteresis, sun, evening window): every plan may ask "dark?"
        self._unsub.append(self.core.room_tracker.add_dark_listener(lambda _r, _d: self.schedule_all()))
        self._unsub.append(self.core.engine.on_mode(lambda _m, _c: self.schedule_all()))
        self._unsub.append(self.core.cleaning.add_listener(self.schedule_all))
        self._unsub.append(async_track_time_interval(self.hass, callback(lambda _now: self.schedule_all()), timedelta(seconds=30)))
        # after an alarm (it switched lights): look again at once
        self._unsub.append(self.core.alarm.add_listener(lambda state: self.schedule_all() if state != "triggered" else None))
        self.schedule_all()

    def _room_changed(self, rid: str, occupied: bool) -> None:
        if not occupied:
            self.core.lightlearn.room_left(rid)  # "off" right before leaving is no wish
        self.schedule(rid)

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()
        for t in self._pending.values():
            t()
        self._pending.clear()
        self._pending_at.clear()

    def schedule_all(self) -> None:
        for rid in self.core.rooms:
            if self.store.get(rid, {}).get("on"):
                self.schedule(rid)

    def mark_manual(self, lights: list[str]) -> None:
        """These lamps count as set by hand (a live preview left as shown): the plan leaves them alone like after a
        person, by the room's setting; nothing is learned from it."""
        now = time.time()
        for rid in self.core.rooms:
            if self.store.get(rid, {}).get("on"):
                mine = set(self.all_lights(rid, self.plan(rid)))
                for e in lights:
                    if e in mine:
                        self._rt.setdefault(rid, {}).setdefault("manual", {})[e] = now
                        self._rt[rid].setdefault("smart_owned", set()).discard(e)

    def schedule(self, rid: str, delay: float = 0.3) -> None:
        if not self.store.get(rid, {}).get("on") or not self.core.feature("light"):
            return
        at = time.time() + max(0.1, delay)
        if rid in self._pending and self._pending_at.get(rid, 0) <= at:
            return  # an earlier look is planned anyway; it plans the next one
        if (t := self._pending.pop(rid, None)) is not None:
            t()

        @callback
        def go(_now: Any = None) -> None:
            self._pending.pop(rid, None)
            self._pending_at.pop(rid, None)
            self.hass.async_create_task(self.evaluate(rid))

        self._pending[rid] = async_call_later(self.hass, max(0.1, delay), go)
        self._pending_at[rid] = at

    @callback
    def _changed(self, event: Event[EventStateChangedData]) -> None:
        eid = event.data["entity_id"]
        new = event.data["new_state"]
        old = event.data["old_state"]
        if eid.startswith("light.") and new is not None and old is not None and new.state in ("unavailable", "unknown"):
            if old.state not in ("unavailable", "unknown"):
                self._gone[eid] = lightspec.snapshot(old.state, old.attributes)
        elif eid.startswith("light.") and new is not None and old is not None:
            ctx = new.context
            # a live preview of the panel (lightpreview.py) counts like the plan's own change: no person, no rule
            preview = self.core.lightpreview.is_preview(ctx)
            ours = preview or ctx.id in self._ours or (ctx.parent_id is not None and ctx.parent_id in self._ours)
            hist = self.core.history.ours
            house_rule = None if ours else hist.get(ctx.id) or (hist.get(ctx.parent_id) if ctx.parent_id else None)
            if not ours and not house_rule and ctx.user_id is None and ctx.parent_id is None:
                # a fresh context: a press at the device – or a late report / a fade step of a call of Hausregeln
                # (after 5 s Home Assistant no longer gives it the call's context)
                late = self.core.history.addressed_by(eid, new.state == STATE_ON, LATE_REPORT)
                if late:
                    ours = late[1] in self._ours
                    house_rule = None if ours else late[0] or None
            changed = old.state != new.state or old.attributes.get("brightness") != new.attributes.get("brightness")
            # who changed it: a person (in the app, at the device, by voice – no parent context, like in the history),
            # a house rule (a button, "reading mode" …), another automation or script – or something the plan puts
            # back: right after a start other flows switch lights (e.g. once at every start; a house rule is meant
            # even then), a user set up as an automation (Node-RED, AppDaemon …, Einstellungen → Rollen), Hausregeln'
            # own alarm/warnings (they put the lights back themselves)
            rule_of_house = bool(house_rule and self.core.rule(house_rule))
            # a lamp that comes back after being unreachable (power cut, Wi-Fi, a restart of its integration) reports
            # its own state: nobody switched it – the plan puts its target back instead of treating it as by hand
            back = old.state in ("unavailable", "unknown")
            put_back = back or ours or (house_rule and not rule_of_house) or (not rule_of_house and (self.core.automation_user(ctx.user_id) or self.core.starting()))
            person = not put_back and not house_rule and bool(ctx.user_id or ctx.parent_id is None)
            if back and (was := self._gone.pop(eid, None)) is not None:
                # back again: unless a rule wants something else, it goes back to how it was before (a lamp that
                # switches itself on after a power cut does not stay on in the night)
                for rid in self.core.rooms:
                    if self.store.get(rid, {}).get("on") and eid in self.all_lights(rid, self.plan(rid)):
                        self._rt.setdefault(rid, {}).setdefault("events", {})[eid] = ({**was, "why": "wieder erreichbar: wie vor dem Ausfall"}, "back")
            if new.state == STATE_ON and old.state != STATE_ON:
                self._on_src[eid] = ("back" if back else "ours" if ours else "manual" if person else f"rule:{house_rule}" if house_rule else "automation", time.time())
            # another white tone or colour (a lamp that rounds its colour differently in a later report is no change)
            tone = new.state == STATE_ON and (old.attributes.get("color_temp_kelvin") != new.attributes.get("color_temp_kelvin") or not lightspec.same_hs(old.attributes.get("hs_color"), new.attributes.get("hs_color")))
            if not put_back and (changed or tone):
                # like by hand: the plan leaves the lamp as it was set (the room's "by hand" setting: until the room
                # was empty / 30 min / not at all), and a "when" rule that fired before does not take it back
                # later – that change is newer ("never on" still switches off what it forbids)
                for rid in self.core.rooms:
                    if self.store.get(rid, {}).get("on") and eid in self.all_lights(rid, self.plan(rid)):
                        rt = self._rt.setdefault(rid, {})
                        rt.setdefault("manual", {})[eid] = time.time()
                        rt.setdefault("events", {}).pop(eid, None)
                        rt.setdefault("smart_owned", set()).discard(eid)
                        sm = self.plan(rid)["smart"]
                        if person and sm["mode"] != "off" and eid in (sm["lights"] or self.room_lights(rid)):
                            # intelligent light: a person set it like this → one example to learn from
                            self.core.lightlearn.observe(rid, eid, new, (rt.get("smart_want") or {}).get(eid))
        for rid in self.core.rooms:
            if self.store.get(rid, {}).get("on"):
                self.schedule(rid, 0.2)

    def _vacation_window(self, p: dict[str, Any], now: datetime) -> bool:
        v = p["vacation"]
        today = now.date().isoformat()
        r1 = random.Random(today).randint(-15, 15) if v["random"] else 0  # the same for the whole day
        r2 = random.Random(today + "e").randint(-15, 15) if v["random"] else 0
        if v["start"] == "sunset":
            sun = self.hass.states.get("sun.sun")
            nxt = sun.attributes.get("next_setting") if sun else None
            setting = dt_util.parse_datetime(nxt) if isinstance(nxt, str) else None
            if setting is None:
                start = 19 * 60
            else:
                local = dt_util.as_local(setting)
                start = local.hour * 60 + local.minute
            start += int(v["offset"])
        else:
            start = _hm(v["time"]) or 19 * 60
        end = _hm(v["end"]) or 23 * 60
        m = now.hour * 60 + now.minute
        return start + r1 <= m < end + r2

    async def evaluate(self, rid: str) -> None:  # noqa: C901 — one place that decides every light of the room
        p = self.plan(rid)
        if not p["on"]:
            return
        if self.core.alarm.state == "triggered":
            return  # the alarm switches lights (on, blinking): hands off until it is over
        if self.core.window_warning.flashing:
            return  # the window warning flashes and then puts everything back: hands off meanwhile
        rt = self._rt.setdefault(rid, {})
        rt.setdefault("events", {})  # light → (result, rule id): what the last "when" rule (or the end of a "while") said
        rt.setdefault("trig", {})  # rule id → did its trigger hold last time
        rt.setdefault("active", {})  # while/never/keep rule id → snapshot of its lights when it started
        rt.setdefault("manual", {})
        rt.setdefault("ending", {})  # while rule id → {at, rule, snap}: ended, waiting / dimming before "afterwards"
        lights = self.all_lights(rid, p)
        if not lights:
            return
        now = time.time()
        state = {e: self.hass.states.get(e) for e in lights}
        is_on = {e: bool(st and st.state == STATE_ON) for e, st in state.items()}
        mode = self.core.mode
        occupied = self.core.room_tracker.occupied(rid)
        if occupied:
            rt.pop("empty_since", None)
        else:
            rt.setdefault("empty_since", now)
        empty_for = 0.0 if occupied else now - rt["empty_since"]
        empty = not occupied and empty_for >= float(p["empty"]["delay"]) * 60
        desired: dict[str, dict[str, Any] | None] = {e: None for e in lights}
        why: dict[str, str] = {}
        protected_on: set[str] = set()
        blocked_on: set[str] = set()
        rules = [r for r in p["rules"] if r["enabled"]]

        # which while rules hold right now (never on / keep on can be tied to them)
        while_now = {r["id"]: bool(r["when"]) and self._holds(rid, r["when"]) for r in rules if r["kind"] == "while"}

        def excepted(r: dict[str, Any]) -> bool:
            return any(self.core.checker.holds(c, rid, rid)[0] for c in r.get("except") or [])

        block_info: dict[str, list[tuple[str, set[str], float]]] = {}  # light → (rule name, allowed rules, since)

        # never on / keep on
        for r in rules:
            if r["kind"] not in ("never_on", "keep_on"):
                continue
            linked = r.get("linked") or []
            holds = (bool(r["when"]) or bool(linked)) and (not r["when"] or self._holds(rid, r["when"])) and all(while_now.get(x) for x in linked) and not excepted(r)
            was = r["id"] in rt["active"]
            if holds and not was:
                rt["active"][r["id"]] = {}
                rt.setdefault("since", {})[r["id"]] = now
            if not holds and was:
                rt["active"].pop(r["id"], None)
                rt.setdefault("since", {}).pop(r["id"], None)
                if r["kind"] == "keep_on":
                    rt.setdefault("released", {})[r["id"]] = r
            if holds:
                (blocked_on if r["kind"] == "never_on" else protected_on).update(self._lights_of(rid, r))
                if r["kind"] == "never_on":
                    for e in self._lights_of(rid, r):
                        block_info.setdefault(e, []).append((r["name"], set(r.get("allow") or []), rt.get("since", {}).get(r["id"], now)))
        # "Sperren" of a while rule: while it holds, these lights may not go on (unless an exception holds)
        blockers: dict[str, list[str]] = {}
        for r in rules:
            if r["kind"] == "while" and r.get("block_lights") and while_now.get(r["id"]) and not excepted(r):
                since = rt.setdefault("since", {}).setdefault(f"block_{r['id']}", now)
                blocked_on.update(r["block_lights"])
                for e in r["block_lights"]:
                    blockers.setdefault(e, []).append(r["name"])
                    block_info.setdefault(e, []).append((r["name"], set(r.get("allow") or []), since))
            elif r["kind"] == "while":
                rt.setdefault("since", {}).pop(f"block_{r['id']}", None)

        # when: a condition became true, only if …
        for r in rules:
            if r["kind"] != "when" or not r["trigger"]:
                continue
            trig = any(self.core.checker.holds(c, rid, rid)[0] for c in r["trigger"])
            prev = rt["trig"].get(r["id"])
            rt["trig"][r["id"]] = trig
            # fires when it becomes true; right after a start or a change of the rules, what already holds counts, too
            if trig and not prev and (not r["when"] or self._holds(rid, r["when"])):
                res = {**self._result(rid, r), "at": now}  # "at": a scene of this firing is activated once
                for e in self._lights_of(rid, r):
                    if e in desired:
                        rt["events"][e] = (for_light(res, e), r["id"])

        # while: as long as it holds; the most specific wins
        actives: list[dict[str, Any]] = []
        for r in rules:
            if r["kind"] != "while":
                continue
            holds = bool(r["when"]) and self._holds(rid, r["when"])
            was = r["id"] in rt["active"]
            if holds:
                rt["ending"].pop(r["id"], None)
                if not was:
                    rt["active"][r["id"]] = {
                        e: {"on": is_on[e], "b": state[e].attributes.get("brightness") if state[e] else None, "s": lightspec.snapshot(state[e].state, state[e].attributes) if state[e] else None}
                        for e in self._lights_of(rid, r)
                        if e in state
                    }
                    rt.setdefault("act_at", {})[r["id"]] = now
                actives.append(r)
            elif was:
                snap = rt["active"].pop(r["id"], {})
                own = r.get("own_end") or {}
                if r.get("follow_empty", True) or own.get("delay") or own.get("dim"):
                    rt["ending"][r["id"]] = {"at": now, "rule": r, "snap": snap}
                else:
                    self._afterwards(rid, r, snap, desired, rt)
        actives.sort(key=lambda r: -self._specific(r))
        for r in actives:
            res = {**self._result(rid, r), "at": rt.get("act_at", {}).get(r["id"], 0)}
            for e in self._lights_of(rid, r):
                if e in desired and desired[e] is None:
                    desired[e] = for_light(res, e)
        # ended while rules: first the "nobody there any more" time (and dimming), then "afterwards"
        for rule_id, end in list(rt["ending"].items()):
            r = end["rule"]
            if r.get("follow_empty", True):
                em = p["empty"]
            else:
                own = r.get("own_end") or {}
                em = {"mode": "dim" if own.get("dim") else "off", "delay": own.get("delay", 0), "dim": own.get("dim") or 10, "dim_for": own.get("dim_for", 0)}
            delay, dim_for = float(em["delay"]) * 60, float(em["dim_for"]) * 60
            elapsed = now - end["at"]
            mine = [e for e in self._lights_of(rid, r) if e in desired and desired[e] is None]
            if elapsed < delay:
                for e in mine:
                    desired[e] = {"mode": "keep", "why": f"{r['name']} vorbei, wartet {round(delay - elapsed)} Sek."}
                self.schedule(rid, delay - elapsed + 0.5)
            elif em["mode"] == "dim" and (not dim_for or elapsed < delay + dim_for):
                for e in mine:
                    desired[e] = {**self._dimmed(state[e], em["dim"]), "why": f"{r['name']} vorbei: gedimmt"} if is_on[e] else {"mode": "keep"}
                if dim_for:
                    self.schedule(rid, delay + dim_for - elapsed + 0.5)
            elif em["mode"] == "keep":
                rt["ending"].pop(rule_id, None)
            else:
                rt["ending"].pop(rule_id, None)
                self._afterwards(rid, r, end["snap"], desired, rt)
        # lights in the own cool-down of a rule: the room's "nobody there any more" waits for it
        own_ending = {e for end in rt["ending"].values() if not end["rule"].get("follow_empty", True) for e in self._lights_of(rid, end["rule"])}
        for e, (res, _rid) in list(rt["events"].items()):
            if e in desired and desired[e] is None:
                desired[e] = res

        # intelligent light (lightlearn.py): while someone is there, only the lights no rule decided right now
        sm = p["smart"]
        smart_view: dict[str, Any] | None = None
        owned: set[str] = rt.setdefault("smart_owned", set())
        if sm["mode"] in ("shadow", "on"):
            owned &= {e for e in lights if is_on[e]}  # off again: no longer switched by it
            scope = [e for e in (sm["lights"] or self.room_lights(rid)) if e in desired]
            wants = self.core.lightlearn.decide(rid, sm, scope, state, owned) if occupied else {}
            if sm["mode"] == "on":
                for e, d in wants.items():
                    if desired[e] is None and d["act"] != "keep":
                        desired[e] = {"mode": d["act"], "brightness": d.get("brightness"), "color": d.get("color"), "why": "Intelligent: " + d["why"][0].rstrip("."), "smart": True}
            rt["smart_want"] = {e: {k: v for k, v in d.items() if k != "act"} for e, d in wants.items()}
            smart_view = {"mode": sm["mode"], "lights": rt["smart_want"], "agree": self.core.lightlearn.agreement(rid), "samples": self.core.lightlearn.samples(rid)}
        else:
            owned.clear()
            rt.pop("smart_want", None)

        # nobody there any more (after the delay); lights that a "keep on" rule holds stay
        guests = mode == "guests" and p["guests_keep"]
        if empty and not guests:
            em = p["empty"]
            for e in lights:
                if e in protected_on or e in own_ending:
                    continue
                if (rt["events"].get(e) or ({},))[0].get("mode") == "off":
                    continue  # a rule just switched it off after its own cool-down: no dimming again
                released = [r for r in rt.get("released", {}).values() if e in self._lights_of(rid, r)]
                how = released[-1]["empty_after"] if released else em["mode"]
                rt["events"].pop(e, None)
                if how == "off":
                    desired[e] = {"mode": "off", "why": "niemand mehr da"}
                elif how == "dim" and is_on[e]:
                    dim_for = float(em["dim_for"]) * 60
                    since = empty_for - float(em["delay"]) * 60
                    if dim_for and since >= dim_for:
                        desired[e] = {"mode": "off", "why": "niemand mehr da"}
                    else:
                        desired[e] = {**self._dimmed(state[e], em["dim"]), "why": f"niemand mehr da: {em['dim']} %"}
                        if dim_for:
                            self.schedule(rid, dim_for - since + 1)
                elif how == "keep":
                    desired[e] = None
            rt.pop("released", None)
        elif not occupied and not guests:
            self.schedule(rid, float(p["empty"]["delay"]) * 60 - empty_for + 1)
        if occupied:
            rt.pop("released", None)

        # vacation: look lived-in
        if mode == "vacation" and p["vacation"]["on"]:
            v = p["vacation"]
            vlights = [e for e in (v["lights"] or self.room_lights(rid)) if e in desired]
            if self.core.sim.config["smart"]:
                # learned from everyday life: rooms, times and ways (simulate.py)
                desired.update(self.core.sim.want(rid, vlights, v["brightness"], v["color"], is_on))
            else:
                inside = self._vacation_window(p, dt_util.now())
                for e in vlights:
                    desired[e] = {"mode": "on", "brightness": v["brightness"], "color": v["color"], "why": "Urlaub: bewohnt wirken"} if inside else {"mode": "off", "why": "Urlaub"}

        def allowed(e: str, src: str) -> bool:
            return bool(block_info.get(e)) and all(src in allow for _n, allow, _s in block_info[e])

        # never on / keep on win
        forbidden: set[str] = set()  # switched on against a "never on": off again, whoever holds it
        for e in lights:
            d = desired[e]
            if d and d.get("mode") in ("on", "scene") and e in blocked_on and not is_on[e] and d.get("rule") and allowed(e, f"light:{d['rule']}"):
                continue  # this light rule is an exception of the block
            if e in blocked_on and is_on[e] and e in block_info:
                # switched on while blocked by another rule or automation: off again (people and allowed rules excepted)
                src, at = self._on_src.get(e, ("", 0.0))
                started = min(sn for _n, _a, sn in block_info[e])
                if src not in ("", "manual", "ours") and at >= started - 1 and now - at < SETTLE:
                    # the command is still under way: its other lamps (a "never on" may depend on them, e.g. "while
                    # the lamp is off") and late reports first – then decide on the settled state
                    self.schedule(rid, SETTLE - (now - at) + 0.2)
                    desired[e] = None
                    continue
                if src not in ("", "manual", "ours") and at >= started - 1 and not allowed(e, src):
                    desired[e] = {"mode": "off", "why": "gesperrt: " + ", ".join(n for n, _a, _s in block_info[e])}
                    self._on_src.pop(e, None)
                    forbidden.add(e)
                    continue
            if d and d.get("mode") in ("on", "scene") and e in blocked_on and not is_on[e]:
                desired[e] = None
                why[e] = "gesperrt: " + ", ".join([*(r["name"] for r in rules if r["kind"] == "never_on" and r["id"] in rt["active"] and e in self._lights_of(rid, r)), *blockers.get(e, [])])
            elif d and d.get("mode") == "off" and e in protected_on and is_on[e]:
                desired[e] = None
                why[e] = "bleibt an: " + ", ".join(r["name"] for r in rules if r["kind"] == "keep_on" and r["id"] in rt["active"] and e in self._lights_of(rid, r))
            elif e in blocked_on and not is_on[e]:
                why[e] = "gesperrt: " + ", ".join([*(r["name"] for r in rules if r["kind"] == "never_on" and r["id"] in rt["active"] and e in self._lights_of(rid, r)), *blockers.get(e, [])])

        # a person, a house rule or another automation set it: leave it (as by hand)
        held: list[str] = []
        for e in lights:
            t = rt["manual"].pop(e, None) if e in forbidden else rt["manual"].get(e)
            if not t or p["manual"] == "none" or e in forbidden:
                continue
            # "until the room was empty" means: entered and left again *after* it was set. Switched on while the room
            # counted as empty (the sensor lost someone lying still, or by voice from another room) it stays on until
            # someone came in and went out again – never switched off right away
            left_since = not occupied and self.core.room_tracker.changed_at(rid) > t
            if (p["manual"] == "room_empty" and not (empty and left_since)) or (p["manual"] == "30m" and now - t < 1800):
                held.append(e)
            else:
                rt["manual"].pop(e, None)

        # switch what differs from what the rules say (also back after another automation)
        changes = []
        sent: dict[str, dict[str, Any]] = rt.setdefault("sent", {})  # light → what was sent last, how often, until when to wait
        for e in lights:
            d = desired[e]
            if not d or d.get("mode") == "keep" or e in held or self.core.lightpreview.holds(e):
                continue  # (a live preview runs on it: hands off until it ended)
            st = state[e]
            if not st or st.state in ("unavailable", "unknown"):
                continue  # not reachable: trying again and again only fills the history
            if d["mode"] == "scene":
                # a scene is activated once per firing; afterwards the lamps are left as the scene set them
                key = f"{d.get('rule')}|{d.get('scene')}|{d.get('at')}"
                if d.get("scene") and rt.setdefault("scene_done", {}).get(e) != key:
                    rt["scene_done"][e] = key
                    changes.append((e, d))
                continue
            rt.get("scene_done", {}).pop(e, None)
            if (not is_on[e]) if d["mode"] == "off" else lightspec.matches(st.state, st.attributes, self.core.lightcal.adjust(e, d)):
                sent.pop(e, None)
                continue
            # not yet like this: the same setting again only after its report had time (a fade reports steps, radios
            # report late), and only a few times – a lamp that reports a colour or brightness its own way stays as it is
            key = repr(sorted((k, v) for k, v in d.items() if k in ("mode", "brightness", "bri", "color", "effect", "transition", "flash")))
            last = sent.get(e)
            if last and last["key"] == key:
                if now < last["until"]:
                    self.schedule(rid, last["until"] - now + 0.1)
                    continue
                if last["n"] >= MAX_SENDS:
                    if last.setdefault("seen", st.last_changed) == st.last_changed:
                        continue  # given up for this setting – until something else switches the lamp on or off
                    last = None
            n = last["n"] + 1 if last and last["key"] == key else 1
            fade = d.get("transition") if isinstance(d.get("transition"), (int, float)) else 0
            sent[e] = {"key": key, "n": n, "until": now + RESEND_WAIT + float(fade)}
            changes.append((e, d))
        if changes:
            for e, d in changes:
                (owned.add if d.get("smart") and d["mode"] == "on" else owned.discard)(e)
            await self._apply(rid, changes)
        status = {
            "occupied": occupied,
            "empty": empty,
            "lux": self._lux(rid),
            "dark": self.core.room_tracker.is_dark(rid),  # the room's dark signal (with hysteresis, rooms.py)
            "active": [r["name"] for r in rules if r["id"] in rt["active"]],
            "lights": {e: (desired[e] or {}).get("why") or why.get(e) or ("von Hand" if e in held else "") for e in lights},
            "held": held,
            "smart": smart_view,
        }
        old = rt.get("status") or {}
        rt["status"] = status
        # only tell the screens when something they show changed (the light sensor only on a clear change)
        lux_old, lux_new = old.get("lux"), status["lux"]
        lux_moved = (lux_old is None) != (lux_new is None) or (lux_old is not None and lux_new is not None and abs(lux_new - lux_old) > max(5.0, 0.2 * abs(lux_old)))
        if changes or lux_moved or {k: v for k, v in old.items() if k != "lux"} != {k: v for k, v in status.items() if k != "lux"}:
            self.core.push("plans")

    def _afterwards(self, rid: str, r: dict[str, Any], snap: dict[str, Any], desired: dict[str, Any], rt: dict[str, Any]) -> None:
        """A while rule no longer holds: what its "afterwards" says (as the latest result for its lights)."""
        for e in self._lights_of(rid, r):
            if e not in desired:
                continue
            if r["after"] == "off":
                rt["events"][e] = ({"mode": "off", "why": f"{r['name']} vorbei"}, r["id"])
            elif r["after"] == "restore" and e in snap:
                s = snap[e]
                # exactly as before: brightness, colour (in the lamp's own colour mode) and effect
                was = s.get("s") or {"mode": "on" if s["on"] else "off", "brightness": round((s["b"] or 255) / 2.55), "color": "none"}
                rt["events"][e] = ({**was, "why": f"{r['name']} vorbei: wie vorher"}, r["id"])
            elif r["after"] == "nothing":
                rt["events"][e] = ({"mode": "keep", "why": f"{r['name']} vorbei"}, r["id"])
            else:
                rt["events"].pop(e, None) if rt["events"].get(e, (None, None))[1] == r["id"] else None

    @staticmethod
    def _dimmed(st: State | None, pct: float) -> dict[str, Any]:
        """Dim to pct %, but keep the colour and colour mode (a red night light stays red) and never brighter
        than the lamp is now."""
        want = int(round(max(1.0, min(100.0, float(pct))) * 2.55))
        cur = st.attributes.get("brightness") if st else None
        if isinstance(cur, (int, float)) and cur > 0:
            want = min(want, int(cur))
        return {"mode": "on", "bri": max(1, want), "color": "none"}

    def _lux(self, rid: str) -> float | None:
        room = self.core.rooms.get(rid) or {}
        st = self.hass.states.get(room["lux"]) if room.get("lux") else None
        try:
            return float(st.state) if st else None
        except ValueError:
            return None

    async def _apply(self, rid: str, changes: list[tuple[str, dict[str, Any]]]) -> None:
        # registered in the history, so the change counts as Hausregeln, not "by hand", for everything else
        ctx = self.core.history.new_context(f"light_{rid}")
        self._ours[ctx.id] = time.time()
        for k, t in list(self._ours.items()):
            if time.time() - t > 3600:
                self._ours.pop(k, None)
        name = self.core.rooms.get(rid, {}).get("name", rid)
        # all lamps at the same time: the same settings in one call, the rest side by side (actions.call_together)
        calls: list[tuple[str, str, str, dict[str, Any]]] = []
        said: dict[str, str] = {}
        for e, d in changes:
            if d["mode"] == "off":
                calls.append(("light", "turn_off", e, {}))
                said[e] = f"{self._name(e)} aus"
            elif d["mode"] == "scene":
                if d["scene"] in said:
                    continue
                extra = {"transition": d["transition"]} if isinstance(d.get("transition"), (int, float)) else {}
                calls.append(("scene", "turn_on", d["scene"], extra))
                said[d["scene"]] = self._name(d["scene"])
            else:
                st: State | None = self.hass.states.get(e)
                # what this lamp understands: its colour mode, its effects, 0-255 or % (lightspec.py)
                data: dict[str, Any] = lightspec.service_data(st.attributes if st else None, self.core.lightcal.adjust(e, d))
                calls.append(("light", "turn_on", e, data))
                pct = data.get("brightness_pct") or (round(data["brightness"] / 2.55) if data.get("brightness") else None)
                said[e] = f"{self._name(e)} {pct} %" if pct else f"{self._name(e)} an"
        failed: set[str] = set()
        for ids, err in await call_together(self.hass, calls, ctx):
            if err:
                failed.update(ids)
                _LOGGER.warning("Licht %s: %s", ", ".join(ids), err)
        texts = [t for k, t in said.items() if k not in failed]
        if texts:
            whys = sorted({d.get("why", "") for _e, d in changes if d.get("why")})
            self.core.history.add("rule", f"Licht {name}: " + ", ".join(texts)[:200], ("; ".join(whys) or "Lichtregeln") + ".", entity_id=changes[0][0], logbook=True, context=ctx)

    def _name(self, e: str) -> str:
        d = self.core.inventory.devices.get(e)
        st = self.hass.states.get(e)
        return d["name"] if d else (str(st.attributes.get("friendly_name")) if st else e)

    def view(self) -> dict[str, Any]:
        return {
            "glow": self.glow_global,
            "plans": {rid: self.plan(rid) for rid in self.core.rooms},
            "now": {rid: self._rt.get(rid, {}).get("status") for rid in self.core.rooms},
        }
