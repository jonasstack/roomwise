"""Advanced logic of the rules ("Erweitert"), on par with Home Assistant automations and Node-RED.

Everything here is a clause with the subject "logic", so a rule stays a flat list of clauses and old rules
are untouched. Conditions (in "and", "only", the "when" of while rules, the light plan's conditions):

    {"subject": "logic", "verb": "all" | "any" | "not", "items": [clauses]}   and / or / none of them (nested)

Steps (in "then" / "else"):

    if           {"if": [conditions], "then": [steps], "else": [steps]}
    choose       {"cases": [{"trigger": ["id", …], "when": [conditions], "then": [steps]}], "else": [steps]}
                 a case fits when the rule was set off by one of its trigger ids (if given) and its conditions hold
    repeat       {"count": 3 | "while": [conditions] | "until": [conditions], "then": [steps]}
    parallel     {"then": [steps]}  all at the same time
    wait_until   {"items": [conditions], "timeout": "5m", "continue": true}
    wait_trigger {"items": [trigger clauses], "timeout": "5m", "continue": true}
    set          {"name": "level", "from": "trigger" | entity_id, "attr": "", "in_min", "in_max", "out_min", "out_max"}
    stop         ends the run here

More building blocks: triggers {"subject": "ha_event", "verb": "fired", "event_type": "…", "event_data": "k=v, …"}
and {"subject": "event.x", "verb": "fired", "event_type": "double_press"} (an event entity with that type);
"id" on any trigger (for "choose"); numbers between two values (is_between / between with min, max); weekdays
(time "weekdays", days "mon,tue,…"); before/after sunrise or sunset with an offset. A value of a step can be
"$trigger" (the state of what set the rule off), "$trigger.<attribute>" or "$<name>" (a "set" value).
How a rule runs when it is set off again while still running: options.mode = single (default) | restart |
queued | parallel, options.max (queued/parallel, default 10) - the same as an automation's mode.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Callable, Coroutine, Iterator
from contextvars import ContextVar
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import Event, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.util import dt as dt_util

from .i18n import tr
from .vocab import seconds

if TYPE_CHECKING:
    from .actions import Executor
    from .conditions import Checker
    from .engine import Runtime

_LOGGER = logging.getLogger(__name__)

# i18n: complete

GROUPS = ("all", "any", "not")
STEPS = ("if", "choose", "repeat", "parallel", "wait_until", "wait_trigger", "set", "stop")
RUN_MODES = ("single", "restart", "queued", "parallel")
SUN_VERBS = ("after_sunset", "before_sunset", "after_sunrise", "before_sunrise")
BETWEEN_VERBS = ("is_between", "between")
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MAX_DEPTH = 5
MAX_LOOPS = 100
_NAME = re.compile(r"^[a-z0-9_]{1,30}$")

# what set the current run off ({id, entity, state, attributes, event}) and its values ("set"): one per run
TRIGGER: ContextVar[dict[str, Any] | None] = ContextVar("house_rules_trigger", default=None)
VARS: ContextVar[dict[str, Any] | None] = ContextVar("house_rules_vars", default=None)


# ---------------------------------------------------------------------------------------------- structure
def leaves(clause: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """The plain clauses inside a clause: itself, its "or" alternatives and everything in logic groups/blocks
    (to know which entities a rule has to watch)."""
    if clause.get("subject") != "logic":
        yield clause
        for alt in clause.get("or") or []:
            yield alt
        return
    for key in ("items", "if", "while", "until", "then", "else"):
        for c in clause.get(key) or []:
            yield from leaves(c)
    for case in clause.get("cases") or []:
        for c in (*(case.get("when") or []), *(case.get("then") or [])):
            yield from leaves(c)


def clean(sanitize: Callable[[Any], dict[str, Any] | None], c: dict[str, Any], depth: int = 0) -> dict[str, Any] | None:
    """A logic clause from outside → only known keys (nested at most MAX_DEPTH levels)."""
    verb = c.get("verb")
    if verb not in GROUPS + STEPS or depth > MAX_DEPTH:
        return None

    def items(v: Any) -> list[dict[str, Any]]:
        out = []
        for x in (v if isinstance(v, list) else [])[:20]:
            if isinstance(x, dict):
                y = clean(sanitize, x, depth + 1) if x.get("subject") == "logic" else sanitize(x)
                if y:
                    out.append(y)
        return out

    out: dict[str, Any] = {"subject": "logic", "verb": verb}
    if verb in GROUPS:
        out["items"] = items(c.get("items"))
        return out if out["items"] else None
    if verb == "if":
        out["if"], out["then"], out["else"] = items(c.get("if")), items(c.get("then")), items(c.get("else"))
    elif verb == "choose":
        cases = []
        for case in (c.get("cases") if isinstance(c.get("cases"), list) else [])[:10]:
            if not isinstance(case, dict):
                continue
            ids = case.get("trigger") or []
            ids = [ids] if isinstance(ids, str) else ids
            cases.append({"trigger": [str(i)[:30] for i in ids if isinstance(i, (str, int))][:10], "when": items(case.get("when")), "then": items(case.get("then"))})
        out["cases"], out["else"] = cases, items(c.get("else"))
    elif verb == "repeat":
        if c.get("while"):
            out["while"] = items(c.get("while"))
        elif c.get("until"):
            out["until"] = items(c.get("until"))
        else:
            try:
                out["count"] = max(1, min(MAX_LOOPS, int(c.get("count", 2))))
            except (TypeError, ValueError):
                out["count"] = 2
        out["then"] = items(c.get("then"))
    elif verb == "parallel":
        out["then"] = items(c.get("then"))
    elif verb in ("wait_until", "wait_trigger"):
        out["items"] = items(c.get("items"))
        out["timeout"] = str(c.get("timeout") or "")[:10]
        out["continue"] = bool(c.get("continue", True))
    elif verb == "set":
        name = str(c.get("name") or "").strip().lower()
        if not _NAME.match(name):
            return None
        out["name"] = name
        src = str(c.get("from") or "trigger")[:200]
        out["from"] = src if src == "trigger" or "." in src else "trigger"
        if isinstance(c.get("attr"), str) and c["attr"]:
            out["attr"] = c["attr"][:60]
        for k in ("in_min", "in_max", "out_min", "out_max"):
            if isinstance(c.get(k), (int, float)) and not isinstance(c.get(k), bool):
                out[k] = c[k]
    return out


# ---------------------------------------------------------------------------------------------- conditions
def _days(v: Any) -> set[int]:
    words = re.split(r"[,\s]+", str(v or "").lower())
    return {DAYS.index(w[:3]) for w in words if w[:3] in DAYS}


def _sun_time(hass: Any, event: str, now: datetime) -> datetime | None:
    from homeassistant.helpers.sun import get_astral_event_date  # noqa: PLC0415

    try:
        t = get_astral_event_date(hass, event, now.date())
    except Exception:  # noqa: BLE001 — polar day/night or no location
        return None
    return dt_util.as_local(t) if t else None


def holds(checker: Checker, clause: dict[str, Any], room: str | None, scope: str | None) -> tuple[bool, str, float | None] | None:
    """Conditions only this module knows; None = not one of them (the checker goes on)."""
    subject, verb = clause.get("subject"), clause.get("verb")
    core = checker.core
    if subject == "logic":
        results = [checker.holds(c, room, scope) for c in clause.get("items") or []]
        texts = " / ".join(r[1] for r in results if r[1])
        waits = [r[2] for r in results if r[2] is not None]
        if verb == "any":
            ok = any(r[0] for r in results)
        elif verb == "not":
            return (not any(r[0] for r in results)), texts, None
        else:
            ok = all(r[0] for r in results)
        return ok, texts, (None if ok or not waits else min(waits))
    if subject == "time" and verb == "weekdays":
        now = dt_util.now()
        return now.weekday() in _days(clause.get("days")), tr(core, f"logic.day_{DAYS[now.weekday()]}"), None
    if subject == "sun" and verb in SUN_VERBS:
        now = dt_util.now()
        at = _sun_time(core.hass, "sunset" if verb.endswith("sunset") else "sunrise", now)
        if at is None:
            return False, tr(core, "logic.no_sun"), None
        at += timedelta(seconds=_signed(clause.get("offset")))
        after = now >= at
        ok = after if verb.startswith("after") else not after
        return ok, tr(core, "engine.now_time", time=f"{now:%H:%M}"), None
    return None


def _signed(v: Any) -> float:
    s = str(v or "").strip()
    neg = s.startswith("-")
    return -(seconds(s.lstrip("+-")) or 0) if neg else seconds(s.lstrip("+")) or 0


def _number(st: Any) -> float | None:
    try:
        return float(st.state) if st is not None else None
    except (TypeError, ValueError):
        return None


def predicate(kind: str, verb: str, clause: dict[str, Any]) -> Callable[[Any], bool] | None:
    """Predicates only this module knows (numbers between two values); None = unknown."""
    if verb not in BETWEEN_VERBS:
        return None
    try:
        lo, hi = float(clause.get("min", 0)), float(clause.get("max", 100))
    except (TypeError, ValueError):
        return None
    lo, hi = min(lo, hi), max(lo, hi)
    if kind == "light":
        # a light: its brightness in % (off = 0)
        def light(st: Any) -> bool:
            if st is None or st.state in ("unavailable", "unknown"):
                return False
            pct = (st.attributes.get("brightness") or 0) / 2.55 if st.state == "on" else 0
            return lo <= pct <= hi

        return light

    def between(st: Any) -> bool:
        n = _number(st)
        return n is not None and lo <= n <= hi

    return between


# ---------------------------------------------------------------------------------------------- triggers
def _event_data(v: Any) -> dict[str, str]:
    out = {}
    for part in str(v or "").split(","):
        if "=" in part:
            k, _, val = part.partition("=")
            if k.strip():
                out[k.strip()] = val.strip()
    return out


def _data_fits(want: dict[str, str], data: dict[str, Any]) -> bool:
    return all(str(data.get(k, "")).lower() == v.lower() for k, v in want.items())


def watch(rt: Runtime, index: int, clause: dict[str, Any]) -> bool:
    """Triggers only this module knows; True = handled (the runtime does not watch it itself)."""
    subject, verb = str(clause.get("subject", "")), clause.get("verb")
    hass = rt.hass
    if subject == "ha_event" and verb == "fired":
        etype = str(clause.get("event_type") or "").strip()
        if not etype or etype.startswith("state_changed"):
            return True  # every state change: far too many runs, never
        want = _event_data(clause.get("event_data"))

        @callback
        def _fired(event: Event) -> None:
            if _data_fits(want, dict(event.data)):
                info = {"event": {"type": event.event_type, "data": dict(event.data)}}
                rt.trigger(clause, None, event.context, tr(rt.core, "logic.why_event", event=etype), None, info=info)

        rt._unsubs.append(hass.bus.async_listen(etype, _fired))
        return True
    if subject.startswith("event.") and verb == "fired":
        want_type = str(clause.get("event_type") or "").strip().lower()

        @callback
        def _changed(event: Event[Any]) -> None:
            new, old = event.data["new_state"], event.data["old_state"]
            if new is None or new.state in ("unavailable", "unknown") or (old is not None and old.state == new.state):
                return
            if want_type and str(new.attributes.get("event_type", "")).lower() != want_type:
                return
            label = rt.core.describer.clause(clause, "when")
            rt.trigger(clause, rt.core.inventory.room_of(subject), None, label[:1].upper() + label[1:] + ".", subject)

        rt._unsubs.append(async_track_state_change_event(hass, [subject], _changed))
        return True
    return False


def trigger_info(rt: Runtime, clause: dict[str, Any], entity: str | None, extra: dict[str, Any] | None) -> dict[str, Any]:
    st = rt.hass.states.get(entity) if entity else None
    return {"id": str(clause.get("id") or ""), "entity": entity, "state": st.state if st else None, "attributes": dict(st.attributes) if st else {}, **(extra or {})}


# ---------------------------------------------------------------------------------------------- run modes
def launch(rt: Runtime, key: str, clause: dict[str, Any], entity: str | None, factory: Callable[[], Coroutine[Any, Any, None]], extra: dict[str, Any] | None = None) -> None:
    """Starts a run as the rule's mode says. single: not while it runs · restart: the running one stops ·
    queued: after the running one · parallel: at the same time (queued/parallel at most options.max)."""
    opts = rt.rule.get("options") or {}
    mode = opts.get("mode") if opts.get("mode") in RUN_MODES else "single"
    try:
        limit = max(1, min(100, int(opts.get("max") or 10)))
    except (TypeError, ValueError):
        limit = 10
    running = rt._tasks.get(key)
    busy = bool(running and not running.done())
    more: set[asyncio.Task[Any]] = rt.__dict__.setdefault("_more_tasks", set())
    more -= {t for t in more if t.done()}
    if busy and mode == "single":
        return
    if busy and mode == "restart":
        running.cancel()  # type: ignore[union-attr]
    if mode in ("queued", "parallel") and len(more) + (1 if busy else 0) >= limit:
        _LOGGER.debug("House rules: %s already runs %s times", rt.rule.get("name"), limit)
        return

    async def queued(before: asyncio.Task[Any] | None) -> None:
        if before is not None and not before.done():
            try:
                await asyncio.shield(before)
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 — the next one runs anyway
                pass
        await factory()

    t1 = TRIGGER.set(trigger_info(rt, clause, entity, extra))
    t2 = VARS.set({})
    try:
        if mode == "queued":
            task = rt.hass.async_create_task(queued(running if busy else None))
        else:
            task = rt.hass.async_create_task(factory())
    finally:
        TRIGGER.reset(t1)
        VARS.reset(t2)
    if mode in ("queued", "parallel") and busy:
        more.add(task)
        if mode == "queued":
            rt._tasks[key] = task  # the next one waits for this one
    else:
        rt._tasks[key] = task


def running(rt: Runtime) -> dict[str, Any]:
    """Runs of a rule still going (handed to its next runtime when the engine restarts all rules)."""
    return {"tasks": {k: t for k, t in rt._tasks.items() if not t.done()}, "more": {t for t in rt.__dict__.get("_more_tasks", set()) if not t.done()}}


def adopt_runs(rt: Runtime, runs: dict[str, Any] | None) -> None:
    """The next runtime of a rule knows the runs still going: the run mode (single/queued …) keeps counting them."""
    if runs:
        rt._tasks.update(runs.get("tasks") or {})
        if runs.get("more"):
            rt.__dict__["_more_tasks"] = set(runs["more"])


def stop(rt: Runtime) -> None:
    for t in rt.__dict__.pop("_more_tasks", set()):
        t.cancel()


# ---------------------------------------------------------------------------------------------- values
def _value(ref: str) -> Any:
    trig = TRIGGER.get() or {}
    if ref == "trigger":
        return _numeric(trig.get("state"))
    if ref.startswith("trigger."):
        key = ref[8:]
        if key.startswith("event."):
            return _numeric((trig.get("event") or {}).get("data", {}).get(key[6:]))
        return _numeric(trig.get(key) if key in ("id", "entity") else (trig.get("attributes") or {}).get(key))
    return (VARS.get() or {}).get(ref)


def _numeric(v: Any) -> Any:
    if isinstance(v, str):
        try:
            f = float(v)
            return int(f) if f.is_integer() else f
        except ValueError:
            return v
    return v


def resolve(clause: dict[str, Any]) -> dict[str, Any]:
    """A step with its "$…" values filled in (unknown values: the step keeps its default)."""
    if not any(isinstance(v, str) and v.startswith("$") or isinstance(v, dict) for v in clause.values()):
        return clause
    out: dict[str, Any] = {}
    for k, v in clause.items():
        if isinstance(v, str) and v.startswith("$") and k not in ("subject", "verb"):
            val = _value(v[1:])
            if val is not None:
                out[k] = val
        elif isinstance(v, dict) and k == "light":
            out[k] = resolve(v)
        elif isinstance(v, dict) and k == "per_light":
            out[k] = {e: resolve(x) if isinstance(x, dict) else x for e, x in v.items()}
        else:
            out[k] = v
    return out


def _set(ex: Executor, c: dict[str, Any]) -> Any:
    src = c.get("from", "trigger")
    if src == "trigger":
        val = _value(f"trigger.{c['attr']}") if c.get("attr") else _value("trigger")
    else:
        st = ex.hass.states.get(src)
        val = _numeric((st.attributes.get(c["attr"]) if c.get("attr") else st.state) if st else None)
    if isinstance(val, (int, float)) and all(isinstance(c.get(k), (int, float)) for k in ("in_min", "in_max", "out_min", "out_max")):
        a, b, x, y = c["in_min"], c["in_max"], c["out_min"], c["out_max"]
        f = 0.0 if a == b else max(0.0, min(1.0, (val - a) / (b - a)))
        val = round(x + (y - x) * f, 1)
        if float(val).is_integer():
            val = int(val)
    return val


# ---------------------------------------------------------------------------------------------- steps
async def step(ex: Executor, rule: dict[str, Any], c: dict[str, Any], ctx: Any, room: str | None, scope: str | None, snapshots: dict[str, Any] | None, only_changes: bool) -> list[dict[str, Any]]:
    """Runs one logic step; returns what was done (like Executor.run)."""
    from .actions import StopRun  # noqa: PLC0415

    verb = c.get("verb")
    checker = ex.core.checker

    def ok(conds: list[dict[str, Any]]) -> bool:
        return all(checker.holds(x, room, scope)[0] for x in conds)

    async def run(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not steps:
            return []
        return await ex.run({**rule, "then": steps}, ctx, room, scope, snapshots=snapshots, only_changes=only_changes)

    if verb == "if":
        return await run(c.get("then") or [] if ok(c.get("if") or []) else c.get("else") or [])
    if verb == "choose":
        tid = (TRIGGER.get() or {}).get("id") or ""
        for case in c.get("cases") or []:
            ids = case.get("trigger") or []
            if (not ids or tid in ids) and ok(case.get("when") or []):
                return await run(case.get("then") or [])
        return await run(c.get("else") or [])
    if verb == "repeat":
        done: list[dict[str, Any]] = []
        for i in range(MAX_LOOPS):
            if "count" in c and i >= int(c["count"]):
                break
            if "while" in c and not ok(c["while"]):
                break
            done += await run(c.get("then") or [])
            if "until" in c and ok(c["until"]):
                break
            await asyncio.sleep(0)  # let the rest of Home Assistant breathe between rounds
        return done
    if verb == "parallel":
        results = await asyncio.gather(*(run([s]) for s in c.get("then") or []), return_exceptions=True)
        done = []
        for r in results:
            if isinstance(r, StopRun):
                done += r.args[0] if r.args else []
            elif isinstance(r, BaseException):
                if isinstance(r, asyncio.CancelledError):
                    raise r
                _LOGGER.warning("House rules: a parallel step failed: %s", r)
            else:
                done += r
        return done
    if verb in ("wait_until", "wait_trigger"):
        timeout = seconds(c.get("timeout")) or None
        hit = await (_wait_until(ex, c.get("items") or [], timeout, room, scope) if verb == "wait_until" else _wait_trigger(ex, c.get("items") or [], timeout, room, scope))
        if not hit and not c.get("continue", True):
            raise StopRun([{"text": tr(ex.core, "logic.timed_out"), "entities": []}])
        return []
    if verb == "set":
        vars_ = VARS.get()
        if vars_ is None:
            vars_ = {}
            VARS.set(vars_)
        vars_[c["name"]] = _set(ex, c)
        return []
    if verb == "stop":
        raise StopRun([{"text": tr(ex.core, "logic.stopped"), "entities": []}])
    return []


def _watch_ents(ex: Executor, conds: list[dict[str, Any]], room: str | None, scope: str | None) -> list[str]:
    ents: set[str] = set()
    for c in conds:
        for x in leaves(c):
            ents.update(e for e in ex.res.entities(str(x.get("subject", "")), room, scope) if "." in e)
    return list(ents)


async def _wait_for(ex: Executor, done: asyncio.Event, timeout: float | None, check: Callable[[], bool] | None) -> bool:
    end = time.monotonic() + timeout if timeout else None
    while True:
        left = end - time.monotonic() if end else 30
        if left <= 0:
            return False
        try:
            await asyncio.wait_for(done.wait(), timeout=min(30, left))
            return True
        except TimeoutError:
            if check is not None and check():
                return True  # times and the sun change without a state event: look every 30 s


async def _wait_until(ex: Executor, conds: list[dict[str, Any]], timeout: float | None, room: str | None, scope: str | None) -> bool:
    checker = ex.core.checker

    def check() -> bool:
        return all(checker.holds(x, room, scope)[0] for x in conds)

    if check():
        return True
    done = asyncio.Event()
    unsubs = [
        async_track_state_change_event(ex.hass, _watch_ents(ex, conds, room, scope), callback(lambda _e: check() and done.set())),
        ex.core.room_tracker.add_listener(lambda _r, _o: check() and done.set()),
    ]
    try:
        return await _wait_for(ex, done, timeout, check)
    finally:
        for u in unsubs:
            u()


async def _wait_trigger(ex: Executor, triggers: list[dict[str, Any]], timeout: float | None, room: str | None, scope: str | None) -> bool:
    from .conditions import CHANGE_VERBS, predicate  # noqa: PLC0415

    done = asyncio.Event()
    unsubs: list[Callable[[], None]] = []
    for c in triggers:
        subject, verb = str(c.get("subject", "")), str(c.get("verb", ""))
        if subject == "ha_event":
            want = _event_data(c.get("event_data"))
            etype = str(c.get("event_type") or "")
            if etype and etype != "state_changed":

                @callback
                def _fired(event: Event, want: dict[str, str] = want) -> None:
                    if _data_fits(want, dict(event.data)):
                        done.set()

                unsubs.append(ex.hass.bus.async_listen(etype, _fired))
            continue
        if subject.startswith("room:"):
            rid, want_occ = subject[5:], verb in ("entered", "occupied", "is_occupied")
            unsubs.append(ex.core.room_tracker.add_listener(lambda r, occ, rid=rid, w=want_occ: r == rid and occ == w and done.set()))
            continue
        pred = predicate(ex.core, ex.res.kind_of(subject), verb, c)
        ents = [e for e in ex.res.entities(subject, room, scope) if "." in e]
        if pred is None or not ents:
            continue

        @callback
        def _changed(event: Event[Any], pred: Callable[[Any], bool] = pred, change: bool = verb in CHANGE_VERBS or verb == "fired") -> None:
            new, old = event.data["new_state"], event.data["old_state"]
            if new is None or new.state in ("unavailable", "unknown"):
                return
            if change:
                if old is None or old.state != new.state:
                    done.set()
            elif pred(new) and not (old is not None and pred(old)):
                done.set()

        unsubs.append(async_track_state_change_event(ex.hass, ents, _changed))
    try:
        return await _wait_for(ex, done, timeout, None)
    finally:
        for u in unsubs:
            u()


# ---------------------------------------------------------------------------------------------- sentences
def describe(describer: Any, c: dict[str, Any], section: str) -> str:
    """A logic clause as part of the rule's sentence."""
    from .vocab import format_duration  # noqa: PLC0415

    lang = describer.lang

    def t(key: str, **kw: Any) -> str:
        return tr(lang, key, **kw)

    verb = c.get("verb")
    cond = "and" if section in ("then", "else") else section

    def conds(xs: list[dict[str, Any]], join: str = "and") -> str:
        parts = [describer.clause(x, cond) for x in xs]
        return f" {t('join.' + join)} ".join(parts) or "…"

    def steps(xs: list[dict[str, Any]]) -> str:
        return ", ".join(describer.clause(x, "then") for x in xs) or "…"

    if verb in GROUPS:
        return t({"all": "logic.all", "any": "logic.any", "not": "logic.not"}[verb], items=conds(c.get("items") or [], "or" if verb != "all" else "and"))
    if verb == "if":
        txt = t("logic.if", cond=conds(c.get("if") or []), then=steps(c.get("then") or []))
        return txt + (t("logic.else", steps=steps(c["else"])) if c.get("else") else "")
    if verb == "choose":
        parts = []
        for case in c.get("cases") or []:
            when = " ".join(x for x in (t("logic.trigger_ids", ids=", ".join(case["trigger"])) if case.get("trigger") else "", conds(case["when"]) if case.get("when") else "") if x)
            parts.append(t("logic.case", cond=when or t("logic.always"), then=steps(case.get("then") or [])))
        if c.get("else"):
            parts.append(t("logic.case_else", steps=steps(c["else"])))
        return t("logic.choose", cases="; ".join(parts))
    if verb == "repeat":
        body = steps(c.get("then") or [])
        if "while" in c:
            return t("logic.repeat_while", cond=conds(c["while"]), steps=body)
        if "until" in c:
            return t("logic.repeat_until", cond=conds(c["until"]), steps=body)
        return t("logic.repeat_count", n=c.get("count", 2), steps=body)
    if verb == "parallel":
        return t("logic.parallel", steps=steps(c.get("then") or []))
    if verb in ("wait_until", "wait_trigger"):
        what = conds(c.get("items") or []) if verb == "wait_until" else f" {t('join.or')} ".join(describer.clause(x, "when") for x in c.get("items") or []) or "…"
        txt = t("logic.wait_until" if verb == "wait_until" else "logic.wait_trigger", cond=what)
        if c.get("timeout"):
            txt += t("logic.timeout_stop" if not c.get("continue", True) else "logic.timeout", d=format_duration(c["timeout"], lang))
        return txt
    if verb == "set":
        src = t("logic.from_trigger") if c.get("from") == "trigger" else str(c.get("from"))
        return t("logic.set", name=c.get("name", ""), source=src + (f" ({c['attr']})" if c.get("attr") else ""))
    if verb == "stop":
        return t("logic.stop")
    return str(verb)
