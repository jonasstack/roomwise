"""The engine: one runtime per rule.

"when" rules wait for one of their triggers, check the conditions and run the steps.
"while" rules are re-checked whenever something they read changes; when they start to hold the
devices they touch are remembered, when they stop holding everything is put back (except what
someone changed by hand meanwhile). A rule that mentions "@same" runs once per room.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import CALLBACK_TYPE, Context, Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers.event import (
    async_call_later,
    async_track_state_change_event,
    async_track_sunrise,
    async_track_sunset,
    async_track_time_change,
    async_track_time_interval,
)
from homeassistant.util import dt as dt_util

from .actions import StopRun
from .i18n import quote, tr
from .conditions import CHANGE_VERBS, Checker, Resolver, duration_of, predicate, uses_places
from . import logic
from .logic import leaves
from .vocab import seconds

if TYPE_CHECKING:
    from .core import HouseRules

# i18n: complete

_LOGGER = logging.getLogger(__name__)

# after a start: rules that were on before keep on this long while sensors come back (see Runtime.evaluate)
STARTUP_GRACE = 90
# a start this soon after an end takes the states the end put back as "before" (lamps report late)
RECENT_END = 15

# an active "while" rule whose sensors became unavailable stays on this long before it ends (radio drop-outs)
UNAVAILABLE_GRACE = 600

SKIP_LOG_INTERVAL = 3600  # log "did not run because …" at most once per hour and rule


class Runtime:
    def __init__(self, engine: Engine, rule: dict[str, Any]) -> None:
        self.engine = engine
        self.core = engine.core
        self.hass = engine.hass
        self.rule = rule
        self.res = Resolver(self.core)
        self._unsubs: list[Callable[[], None]] = []
        self._timers: dict[Any, CALLBACK_TYPE] = {}
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._last_skip_log = 0.0
        # while rules: instance ("*" or room) → active
        self.active: dict[str, bool] = {}
        self._restored: set[str] = set()  # instances that were on before a restart and are not confirmed yet
        self._reeval: CALLBACK_TYPE | None = None
        # one start or end per instance at a time: an end waits for a start still switching (and the other way
        # round), so a sensor that flickers (mmWave presence, motion back at once) never mixes up the order
        self._locks: dict[str, asyncio.Lock] = {}
        # what an end just put back (instance → (time, snapshots)): lamps report their new state late (Zigbee), so a
        # start right after it must remember these states as "before", not what the lamp still shows
        self._ended: dict[str, tuple[float, dict[str, Any]]] = {}
        self._rerun: set[str] = set()  # active instances whose steps are to run again (cut off, or after a restart)
        self._unsure_since: dict[str, float] = {}  # active instances kept on while their sensors are unavailable

    @property
    def rid(self) -> str:
        return self.rule["id"]

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self.rule.get("type") == "while":
            self._start_while()
        else:
            for i, clause in enumerate(self.rule.get("when", [])):
                try:
                    self._watch(i, clause)
                except Exception:  # noqa: BLE001 — one broken trigger must not stop the others
                    _LOGGER.exception("House rules: trigger %s of rule %s", clause, self.rule.get("name"))

    def stop(self, keep_runs: bool = False) -> list[str]:
        """Stops listening. Returns the instances that were active (to restore them, see Engine.reload).
        Engine.start hands the live state to the next runtime of the rule (see adopt).
        keep_runs: runs of a "when" rule go on (Engine.start after a change of rooms or devices: a step that waits
        must not be cut off by it); the next runtime takes them over (logic.adopt_runs)."""
        for u in self._unsubs:
            u()
        self._unsubs.clear()
        for t in self._timers.values():
            t()
        self._timers.clear()
        if self._reeval:
            self._reeval()
            self._reeval = None
        if keep_runs and self.rule.get("type") != "while":
            self._tasks = {}
            self.__dict__.pop("_more_tasks", None)
        for t in self._tasks.values():
            t.cancel()
        self._tasks.clear()
        logic.stop(self)
        was = [inst for inst, on in self.active.items() if on]
        self.active = {}
        return was

    def carry(self) -> dict[str, Any]:
        """The live state for the next runtime of this rule (see Engine.start)."""
        # a start still switching is cut off by the restart: the next runtime runs it again (snapshots stay)
        busy = {i for i, t in self._tasks.items() if not t.done()}
        return {
            "active": [i for i, on in self.active.items() if on],
            "restored": set(self._restored),
            "ended": dict(self._ended),
            "rerun": busy,
            # "when" rules: runs still going (they go on, see stop(keep_runs))
            "runs": logic.running(self),
        }

    def adopt(self, state: dict[str, Any]) -> None:
        """Takes over the live state of the rule's previous runtime (the engine restarts all rules after a change of
        rooms, devices or groups): what was on stays on without the start-up grace of a real restart, and what
        held at the last check is not run again."""
        self.active = dict.fromkeys(state["active"], True)
        self._restored = state["restored"] & set(self.active)
        self._ended = state["ended"]
        self._rerun = state["rerun"] & set(self.active)

    # ------------------------------------------------------------------ "when" triggers
    def _watch(self, index: int, clause: dict[str, Any]) -> None:
        subject = clause.get("subject", "")
        verb = clause.get("verb", "")
        hass = self.hass
        if logic.watch(self, index, clause):
            return  # HA events, event entities with a type (logic.py)

        if subject == "time" and verb == "at":
            h, m = (str(clause.get("time", "07:00")).split(":") + ["0"])[:2]
            self._unsubs.append(
                async_track_time_change(hass, callback(lambda _now: self.trigger(clause, None, None, tr(self.core, "engine.why_time", time=f"{int(h)}:{int(m):02d}"))), hour=int(h), minute=int(m), second=0)
            )
            return
        if subject == "sun" and verb in ("sets", "rises"):
            offset = timedelta(seconds=_signed_seconds(clause.get("offset")))
            track = async_track_sunset if verb == "sets" else async_track_sunrise
            why = tr(self.core, "engine.why_sunset" if verb == "sets" else "engine.why_sunrise")
            self._unsubs.append(track(hass, callback(lambda: self.trigger(clause, None, None, why)), offset))
            return
        if subject == "mode" and verb == "changes_to":
            want = clause.get("mode")
            self._unsubs.append(self.engine.on_mode(lambda mode, ctx: mode == want and self.trigger(clause, None, ctx, tr(self.core, "engine.why_mode", mode=self.core.mode_label(mode)))))
            return
        if subject.startswith("rule:") and verb == "ran":
            other = subject[5:]
            self._unsubs.append(
                self.engine.on_fired(lambda rid, ctx: rid == other and self.trigger(clause, None, ctx, tr(self.core, "engine.why_rule_ran", name=quote(self.core, (self.core.rule(rid) or {}).get("name", rid)))))
            )
            return
        if subject.startswith("room:"):
            self._watch_room(index, clause, subject[5:], verb)
            return
        if subject == "alarm":
            prev = {"state": self.core.alarm.state}
            why = {"triggered": tr(self.core, "engine.why_alarm_triggered"), "armed": tr(self.core, "engine.why_alarm_armed"), "disarmed": tr(self.core, "engine.why_alarm_disarmed")}

            def _alarm(state: str) -> None:
                old, prev["state"] = prev["state"], state
                if old == state:
                    return
                hit = (verb == "triggered" and state == "triggered") or (verb == "armed" and state.startswith("armed_") and old in ("disarmed", "arming")) or (
                    verb == "disarmed" and state == "disarmed"
                )
                if hit:
                    self.trigger(clause, None, None, why.get(verb, ""))

            self._unsubs.append(self.core.alarm.add_listener(_alarm))
            return
        if subject.startswith("person:") and uses_places(clause):
            self._watch_places(index, clause)
            return
        self._watch_entities(index, clause)

    def _watch_places(self, index: int, clause: dict[str, Any]) -> None:
        """Person clauses about predictions, time under way or learned places: they change with the tracks of the
        places module (every processed GPS update and once a minute), not only with the person's state."""
        subject = clause["subject"]
        verb = clause.get("verb", "")
        pred = predicate(self.core, "person", verb, clause)
        ents = self.res.entities(subject)
        if pred is None or not ents:
            return
        need = seconds(clause.get("for")) or 0
        mode = self.res.mode_of(subject)
        label = self.core.describer.clause(clause, "when")

        def holds(e: str) -> bool:
            return pred(self.hass.states.get(e))

        def holds_all() -> bool:
            return all(holds(e) for e in self.res.counted(subject, ents, verb))

        prev: dict[str, bool] = {e: holds(e) for e in ents}
        prev_all = {"*": holds_all()}

        def fire(entity: str) -> None:
            self.trigger(clause, None, None, label[:1].upper() + label[1:] + ".", entity)

        def went_true(key: Any, check: Callable[[], bool], entity: str) -> None:
            if not need:
                fire(entity)
                return
            if (t := self._timers.pop(key, None)) is not None:
                t()

            @callback
            def _later(_now: datetime) -> None:
                self._timers.pop(key, None)
                if check():
                    fire(entity)

            self._timers[key] = async_call_later(self.hass, need, _later)

        def changed(entity: str) -> None:
            if entity not in prev:
                return
            if mode == "any":
                now = holds(entity)
                was, prev[entity] = prev[entity], now
                if now and not was:
                    went_true((index, entity), lambda: holds(entity), entity)
                elif not now and (t := self._timers.pop((index, entity), None)) is not None:
                    t()
                return
            now_all = holds_all()
            was_all, prev_all["*"] = prev_all["*"], now_all
            if now_all and not was_all:
                went_true((index, "*"), holds_all, entity)
            elif not now_all and (t := self._timers.pop((index, "*"), None)) is not None:
                t()

        self._unsubs.append(self.core.places.add_listener(changed))

    def _watch_room(self, index: int, clause: dict[str, Any], rid: str, verb: str) -> None:
        want = verb == "entered"
        need = duration_of("room", verb, clause) or 0
        name = (self.core.rooms.get(rid) or {}).get("name", rid)

        def _cb(room: str, occupied: bool) -> None:
            if room != rid:
                return
            key = ("room", index)
            if (t := self._timers.pop(key, None)) is not None:
                t()
            if occupied != want:
                return
            why = tr(self.core, "engine.why_room_entered" if want else "engine.why_room_empty", name=name)
            if need:

                @callback
                def _later(_now: datetime) -> None:
                    self._timers.pop(key, None)
                    if self.core.room_tracker.occupied(rid) == want:
                        self.trigger(clause, rid, None, tr(self.core, "engine.why_room_occupied_for" if want else "engine.why_room_empty_for", name=name, d=_fmt(self.core, need)))

                self._timers[key] = async_call_later(self.hass, need, _later)
            else:
                self.trigger(clause, rid, None, why)

        self._unsubs.append(self.core.room_tracker.add_listener(_cb))

    def _watch_entities(self, index: int, clause: dict[str, Any]) -> None:
        subject = clause["subject"]
        kind = self.res.kind_of(subject)
        verb = clause.get("verb", "")
        pred = predicate(self.core, kind, verb, clause)
        ents = self.res.entities(subject)
        if pred is None or not ents:
            return
        need = duration_of(kind, verb, clause) or 0
        mode = self.res.mode_of(subject)
        label = self.core.describer.clause(clause, "when")

        def fire(entity: str | None) -> None:
            room = self.core.inventory.room_of(entity) if entity else None
            name = self.core.inventory.devices.get(entity or "", {}).get("name") if entity else None
            why = label[:1].upper() + label[1:] + "."
            if name and subject.startswith("any:"):
                why = f"{name}: {self.core.describer.clause({**clause, 'subject': entity}, 'when')}."
            self.trigger(clause, room, None, why, entity)

        def schedule(key: Any, delay: float, check: Callable[[], bool], entity: str | None) -> None:
            if (t := self._timers.pop(key, None)) is not None:
                t()

            @callback
            def _later(_now: datetime) -> None:
                self._timers.pop(key, None)
                if check():
                    fire(entity)

            self._timers[key] = async_call_later(self.hass, delay, _later)

        def holds_all() -> bool:
            return all(pred(self.hass.states.get(e)) for e in self.res.counted(subject, ents))

        @callback
        def _changed(event: Event[EventStateChangedData]) -> None:
            e = event.data["entity_id"]
            old: State | None = event.data["old_state"]
            new: State | None = event.data["new_state"]
            if verb in CHANGE_VERBS:
                # "sich ändert", a button pressed, a scene activated: every new state (a button's state is the time it was pressed)
                if new is not None and new.state not in ("unavailable", "unknown") and (old is None or old.state != new.state):
                    fire(e)
                return
            if new is None or new.state in ("unavailable", "unknown"):
                return
            if old is None or old.state in ("unavailable", "unknown"):
                # back after a radio drop-out: no event (it may have been like this before), but a "for …" whose
                # time ran out meanwhile counts anew from now – else "on for 10 minutes" would never fire
                if need and old is not None:
                    key = (index, e) if mode == "any" else (index, "*")
                    if key not in self._timers and (pred(new) if mode == "any" else holds_all()):
                        schedule(key, need, (lambda: pred(self.hass.states.get(e))) if mode == "any" else holds_all, e)
                return
            if self.core.cleaning.ignores(e, new):
                self.core.cleaning.note(e, tr(self.core, "engine.cleaning_no_trigger"))
                return
            if kind == "vacuum" and new.state == "cleaning":
                self.core.mark_cleaned(e)
            if mode == "any":
                was, now = pred(old), pred(new)
                key = (index, e)
                if was == now:
                    return
                if not now:
                    if (t := self._timers.pop(key, None)) is not None:
                        t()
                    return
                if kind == "vacuum" and clause.get("verb") == "done" and old.state not in ("cleaning", "returning", "paused"):
                    return
                if need:
                    schedule(key, need, lambda: pred(self.hass.states.get(e)), e)
                else:
                    fire(e)
            else:
                states = {x: self.hass.states.get(x) for x in ents}
                now_ents = self.res.counted(subject, ents)
                before = all(pred(old if x == e else states[x]) for x in now_ents)
                after = all(pred(states[x]) for x in now_ents)
                key = (index, "*")
                if before == after:
                    return
                if not after:
                    if (t := self._timers.pop(key, None)) is not None:
                        t()
                    return
                if need:
                    schedule(key, need, holds_all, e)
                else:
                    fire(e)

        self._unsubs.append(async_track_state_change_event(self.hass, ents, _changed))
        # durations already running before a restart: schedule the rest
        if need:
            now = time.time()
            if mode == "any":
                for e in ents:
                    st = self.hass.states.get(e)
                    if st and pred(st):
                        rest = need - (now - st.last_changed.timestamp())
                        if rest > 0:
                            schedule((index, e), rest, lambda e=e: pred(self.hass.states.get(e)), e)
            elif holds_all():
                last = max((s.last_changed.timestamp() for x in ents if (s := self.hass.states.get(x))), default=now)
                rest = need - (now - last)
                if rest > 0:
                    schedule((index, "*"), rest, holds_all, None)

    # ------------------------------------------------------------------ running
    def _blocked(self) -> str | None:
        """Why the rule does not run now, as a sentence ("Die Regel ist aus."), or None."""
        r = self.rule
        if not r.get("enabled", True):
            return tr(self.core, "engine.rule_off")
        until = r.get("paused_until")
        if until:
            ts = dt_util.parse_datetime(until)
            if ts and ts.timestamp() > time.time():
                return tr(self.core, "engine.rule_paused_until", time=f"{dt_util.as_local(ts):%H:%M}")
        return None

    def trigger(self, clause: dict[str, Any], room: str | None, parent: Context | None, why: str, entity: str | None = None, info: dict[str, Any] | None = None) -> None:
        if self._blocked():
            if r := self._blocked():
                self._skip(r, why)
            return
        cd = seconds(self.rule.get("options", {}).get("cooldown"))
        last = self.rule.get("meta", {}).get("last_run")
        if cd and last and (ts := dt_util.parse_datetime(last)) and time.time() - ts.timestamp() < cd:
            return
        failed = self._failed_condition(room)
        if failed:
            self._skip(tr(self.core, "engine.condition_false", clause=quote(self.core, failed)), why, quiet=True)
            return
        key = room or "*"
        ctx = self.core.history.new_context(self.rid, parent)
        # single (not while it runs), restart, queued or parallel, with what set it off (trigger id, values): logic.py
        logic.launch(self, key, clause, entity, lambda: self._run(ctx, room, why, entity), info)

    def _failed_condition(self, room: str | None, scope: str | None = None) -> str | None:
        for section in ("and", "only"):
            for c in self.rule.get(section, []):
                ok, _now, _wait = self.core.checker.holds(c, room, scope)
                if not ok:
                    return self.core.describer.clause(c, section)
        return None

    def _skip(self, reason: str, why: str, quiet: bool = False) -> None:
        if quiet and time.time() - self._last_skip_log < SKIP_LOG_INTERVAL:
            return
        self._last_skip_log = time.time()
        self.core.history.add("skipped", tr(self.core, "engine.skipped", name=quote(self.core, str(self.rule.get("name")))), f"{why} {reason}", rule=self.rule)

    async def _run(self, ctx: Context, room: str | None, why: str, entity: str | None, scope: str | None = None, snapshots: dict[str, Any] | None = None) -> None:
        stopped = False
        if self.rule.get("options", {}).get("ai_check") and self.core.ai.connected and snapshots is None:
            from .ai import AiError  # noqa: PLC0415

            try:
                ok, reason = await self.core.text.guard(self.rule, why)
            except AiError as err:
                ok, reason = True, tr(self.core, "engine.ai_unreachable", error=err)
            if not ok:
                self.core.history.add("skipped", tr(self.core, "engine.ai_declined", name=quote(self.core, str(self.rule.get("name")))), tr(self.core, "engine.ai_reason", why=why, reason=reason), rule=self.rule)
                return
            why = tr(self.core, "engine.ai_note", why=why, reason=reason) if reason else why
        try:
            done = await self.core.executor.run(self.rule, ctx, room, scope, snapshots=snapshots)
        except StopRun as stop:
            done = stop.args[0] if stop.args else []
            stopped = True
        except asyncio.CancelledError:
            raise
        except Exception:
            _LOGGER.exception("House rules: rule %s", self.rule.get("name"))
            done = [{"text": tr(self.core, "engine.run_error"), "entities": []}]
        self.engine.ran(self.rule, ctx, done, why, stopped)

    # ------------------------------------------------------------------ "while" rules
    def _instances(self) -> list[str]:
        if self.res.uses_same(self.rule):
            return list(self.core.rooms)
        return ["*"]

    def _start_while(self) -> None:
        subjects = [x.get("subject", "") for s in ("when", "and", "only") for c in self.rule.get(s, []) for x in leaves(c)]
        ents: set[str] = set()
        for inst in self._instances():
            scope = None if inst == "*" else inst
            for s in subjects:
                ents.update(self.res.entities(s, scope, scope))
        if ents:
            self._unsubs.append(async_track_state_change_event(self.hass, list(ents), callback(lambda _e: self.evaluate())))
        if any(s.startswith("room:") for s in subjects) or self._instances() != ["*"]:
            self._unsubs.append(self.core.room_tracker.add_listener(lambda _r, _o: self.evaluate()))
            self._unsubs.append(self.core.room_tracker.add_dark_listener(lambda _r, _d: self.evaluate()))
        if "mode" in subjects:
            self._unsubs.append(self.engine.on_mode(lambda _m, _c: self.evaluate()))
        if any(s.startswith("rule:") for s in subjects):
            self._unsubs.append(self.engine.on_active(self.evaluate))
        if "alarm" in subjects:
            self._unsubs.append(self.core.alarm.add_listener(lambda _s: self.evaluate()))
        if any(x.get("subject", "").startswith("person:") and uses_places(x) for s in ("when", "and", "only") for c in self.rule.get(s, []) for x in leaves(c)):
            self._unsubs.append(self.core.places.add_listener(lambda _e: self.evaluate()))
        if any(s in ("time", "sun") for s in subjects):
            self._unsubs.append(async_track_time_interval(self.hass, callback(lambda _now: self.evaluate()), timedelta(minutes=1)))
        # a pause that ends: check again then
        until = dt_util.parse_datetime(self.rule.get("paused_until") or "")
        if until and until.timestamp() > time.time():
            self._unsubs.append(async_call_later(self.hass, until.timestamp() - time.time() + 1, callback(lambda _now: self.evaluate())))
        # stored snapshots from before a restart
        stored = self.core.data.setdefault("runtime", {}).setdefault("active", {}).get(self.rid, {})
        for inst in stored:
            if not self.active.get(inst):
                self.active[inst] = True
                self._restored.add(inst)
        self.evaluate()

    def _holds(self, inst: str) -> tuple[bool, float | None]:
        scope = None if inst == "*" else inst
        wait: float | None = None
        for section in ("when", "and", "only"):
            for c in self.rule.get(section, []):
                ok, _now, w = self.core.checker.holds(c, scope, scope)
                if not ok:
                    if w is not None:
                        wait = w if wait is None else min(wait, w)
                    return False, wait
        return True, None

    def _unsure(self, inst: str) -> bool:
        """Does the rule fail only because the devices of the failing conditions are unavailable right now?"""
        scope = None if inst == "*" else inst
        for section in ("when", "and", "only"):
            for c in self.rule.get(section, []):
                if self.core.checker.holds(c, scope, scope)[0]:
                    continue
                ents = [e for x in (c, *(c.get("or") or [])) for e in self.res.entities(x.get("subject", ""), scope, scope)]
                if not ents or any((s := self.hass.states.get(e)) is not None and s.state not in ("unavailable", "unknown") for e in ents):
                    return False
        return True

    @callback
    def evaluate(self) -> None:
        blocked = self._blocked()
        next_check: float | None = None
        for inst in self._instances():
            ok, wait = self._holds(inst)
            if blocked:
                ok = False
            if wait is not None:
                next_check = wait if next_check is None else min(next_check, wait)
            was = self.active.get(inst, False)
            if not ok and was and inst in self._restored and (wait is not None or time.time() - self.engine.started < STARTUP_GRACE):
                # active before a restart: right after the start sensors are not back yet and every "for …" counts
                # anew; it only ends once it really no longer holds (not because the clock started again)
                left = STARTUP_GRACE - (time.time() - self.engine.started)
                nxt = min(x for x in (wait, left if left > 0 else None) if x is not None) if (wait is not None or left > 0) else 1
                next_check = nxt if next_check is None else min(next_check, nxt)
                continue
            if not ok and was and not blocked and self._unsure(inst):
                # it only "no longer holds" because its sensor dropped off the network (Zigbee, Wi-Fi): keep it on
                # for a while instead of switching the light off while someone sits there
                left = UNAVAILABLE_GRACE - (time.time() - self._unsure_since.setdefault(inst, time.time()))
                if left > 0:
                    next_check = left if next_check is None else min(next_check, left)
                    continue
            self._unsure_since.pop(inst, None)
            if ok or not was:
                self._restored.discard(inst)
            if ok and (not was or inst in self._rerun):
                self._rerun.discard(inst)
                self.active[inst] = True
                self.hass.async_create_task(self._activate(inst))
            elif not ok and was:
                self.active[inst] = False
                self._restored.discard(inst)
                self.hass.async_create_task(self._deactivate(inst, tr(self.core, "engine.no_longer") if not blocked else blocked))
        if self._reeval:
            self._reeval()
            self._reeval = None
        if next_check is not None:
            self._reeval = async_call_later(self.hass, next_check + 0.5, callback(lambda _now: self.evaluate()))

    def _why_while(self, inst: str) -> str:
        parts = [self.core.describer.clause(c, "when") for c in self.rule.get("when", [])]
        where = f" ({self.core.rooms[inst]['name']})" if inst in self.core.rooms else ""
        return tr(self.core, "engine.why_while", parts=f" {tr(self.core, 'common.and')} ".join(parts), where=where) if parts else tr(self.core, "engine.holds")

    def _lock(self, inst: str) -> asyncio.Lock:
        return self._locks.setdefault(inst, asyncio.Lock())

    async def _activate(self, inst: str) -> None:
        task = asyncio.current_task()
        if task:
            self._tasks[inst] = task
        self.engine.active_changed()
        async with self._lock(inst):
            if not self.active.get(inst):
                return  # ended again before it could start (its end has run meanwhile)
            scope = None if inst == "*" else inst
            store = self.core.data.setdefault("runtime", {}).setdefault("active", {}).setdefault(self.rid, {})
            entry = store.get(inst)
            if entry is None:
                entry = store[inst] = {"snapshots": {}, "since": time.time()}
                at, snaps = self._ended.pop(inst, (0.0, {}))
                if time.time() - at < RECENT_END:
                    # (what a person changed since then counts as it is now)
                    manual = self.core.history.manual
                    entry["snapshots"].update({e: s for e, s in snaps.items() if not (m := manual.get(e)) or m[0] < at})
            self._else_done(inst, False)
            ctx = self.core.history.new_context(self.rid)
            try:
                await self._run(ctx, scope, self._why_while(inst), None, scope, entry["snapshots"])
            finally:
                if self._tasks.get(inst) is task:
                    self._tasks.pop(inst, None)
                self.core.save()

    def _else_done(self, inst: str, done: bool) -> None:
        """Remembers (in the store) which "Wechselnd" instances last ran their "sonst" steps: after a restart these
        are applied again (see reapply)."""
        rt = self.core.data.setdefault("runtime", {}).setdefault("else_done", {})
        cur = set(rt.get(self.rid, []))
        if (inst in cur) == done:
            return
        (cur.add if done else cur.discard)(inst)
        if cur:
            rt[self.rid] = sorted(cur)
        else:
            rt.pop(self.rid, None)

    async def reapply(self, why: str) -> None:
        """After a restart: puts the devices back into the state the rule stands for right now – the steps of an
        active instance, the "sonst" steps of a "Wechselnd" instance that ended before – as far as they describe a
        state (on, off, a temperature …). Messages, waits, button presses, toggles and timed steps do not run
        again. Devices someone changed by hand stay as they are (the rule's own "Pause" setting)."""
        if self._blocked():
            return  # off or paused: puts nothing back – neither its steps nor its "sonst" steps
        else_done = set(self.core.data.get("runtime", {}).get("else_done", {}).get(self.rid, []))
        for inst in self._instances():
            if self._tasks.get(inst) is not None and not self._tasks[inst].done():
                continue
            holds = self._holds(inst)[0] and not self._blocked()
            if self.active.get(inst) and holds:
                steps = [c for c in self.rule.get("then", []) if steady(c)]
            elif not self.active.get(inst) and inst in else_done and self.rule.get("else") and not holds:
                steps = [c for c in self.rule.get("else", []) if steady(c)]
            else:
                continue
            if not steps:
                continue
            async with self._lock(inst):
                scope = None if inst == "*" else inst
                entry = self.core.data.get("runtime", {}).get("active", {}).get(self.rid, {}).get(inst) if self.active.get(inst) else None
                ctx = self.core.history.new_context(self.rid)
                try:
                    done = await self.core.executor.run({**self.rule, "then": steps}, ctx, scope, scope, snapshots=entry["snapshots"] if entry else None, only_changes=True)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 — one rule must not stop the check of the others
                    _LOGGER.exception("House rules: rule %s (check after the start)", self.rule.get("name"))
                    continue
            if done:
                self.engine.ran(self.rule, ctx, done, why, False)

    async def _deactivate(self, inst: str, reason: str) -> None:
        if (t := self._tasks.pop(inst, None)) is not None and t is not asyncio.current_task():
            t.cancel()  # a start still switching (or waiting): stop it, then put back what it changed so far
        async with self._lock(inst):
            if self.active.get(inst):
                return  # holds again already (a sensor flickered): nothing to put back, the snapshots stay
            await self._end(inst, reason)

    async def _end(self, inst: str, reason: str) -> None:
        runtime = self.core.data.setdefault("runtime", {}).setdefault("active", {})
        entry = runtime.get(self.rid, {}).pop(inst, None)
        if not runtime.get(self.rid):
            runtime.pop(self.rid, None)
        self.core.save()
        self.engine.active_changed()
        if not entry:
            return
        since = float(entry.get("since", 0))
        ctx = self.core.history.new_context(self.rid)
        if self.rule.get("else"):
            self._else_done(inst, True)
            # "Wechselnd": the steps for "no longer" instead of putting things back
            scope = None if inst == "*" else inst
            try:
                done = await self.core.executor.run({**self.rule, "then": self.rule["else"]}, ctx, scope, scope)
            except StopRun as stop:
                done = stop.args[0] if stop.args else []
            except asyncio.CancelledError:
                raise
            except Exception:
                _LOGGER.exception("House rules: rule %s (otherwise)", self.rule.get("name"))
                done = [{"text": tr(self.core, "engine.run_error"), "entities": []}]
            self.engine.ran(self.rule, ctx, done, tr(self.core, "engine.why_else", reason=reason), False)
            return
        if self.rule.get("options", {}).get("restore", True) is False:
            return
        restored: list[str] = []
        kept: list[str] = []
        back: dict[str, Any] = {}
        self._ended[inst] = (time.time(), {e: s for e, s in entry.get("snapshots", {}).items() if e != "mode"})
        for eid, snap in entry.get("snapshots", {}).items():
            if eid == "mode":
                if self.core.mode != snap.get("state"):
                    await self.core.set_mode(snap["state"], ctx)
                    restored.append(tr(self.core, "engine.house_mode"))
                continue
            manual = self.core.history.manual.get(eid)
            name = self.core.inventory.devices.get(eid, {}).get("name", eid)
            if manual and manual[0] > since:
                kept.append(name)
                continue
            back[eid] = snap
            restored.append(name)
        # all at the same time, not one lamp after the other
        await self.core.executor.restore_many(back, ctx)
        if restored or kept:
            what = tr(self.core, "engine.restored", names=", ".join(restored)) if restored else tr(self.core, "engine.nothing_restored")
            why = reason + (" " + tr(self.core, "engine.kept_manual", names=", ".join(kept)) if kept else "")
            self.core.history.add("rule", what, why, rule=self.rule, entity_id=next(iter(entry.get("snapshots", {})), None))


class Engine:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.runtimes: dict[str, Runtime] = {}
        self.started = time.time()
        self._ran = False  # the first start (when Home Assistant runs) sets `started`
        self._mode_listeners: list[Callable[[str, Context | None], Any]] = []
        self._fired_listeners: list[Callable[[str, Context | None], Any]] = []
        self._active_listeners: list[Callable[[], Any]] = []

    def start(self) -> None:
        """Starts every rule. Called again after changes of rooms, devices, groups or plans: rules that run keep
        their live state then (a registry update must not make a running "while" rule wait or start anew)."""
        carry = {rid: rt.carry() for rid, rt in self.runtimes.items()}
        for rt in self.runtimes.values():
            rt.stop(keep_runs=True)
        self.runtimes.clear()
        if not self._ran:
            self._ran = True
            self.started = time.time()
        for rule in self.core.all_rules():
            self._start(rule, carry.get(rule["id"]))

    def _start(self, rule: dict[str, Any], carry: dict[str, Any] | None = None) -> None:
        rt = Runtime(self, rule)
        if carry and rule.get("type") == "while":
            rt.adopt(carry)
        elif carry:
            logic.adopt_runs(rt, carry.get("runs"))
        self.runtimes[rule["id"]] = rt
        try:
            rt.start()
        except Exception:  # noqa: BLE001
            _LOGGER.exception("House rules: rule %s could not start", rule.get("name"))

    def stop(self) -> None:
        for rt in self.runtimes.values():
            rt.stop()
        self.runtimes.clear()

    async def reload(self, rule: dict[str, Any] | None, rule_id: str | None = None, *, restore: bool = True) -> None:
        """(Re)starts a rule after a change. Active "while" instances are put back first."""
        rid = rule["id"] if rule else rule_id
        old = self.runtimes.pop(rid, None) if rid else None
        if old:
            was = old.stop()
            self.core.executor.cancel_reverts(rid or "")
            if restore:
                for inst in was:
                    await old._deactivate(inst, tr(self.core, "engine.rule_changed"))
        if rule:
            self._start(rule, {"active": [], "restored": set(), "ended": old._ended, "rerun": set()} if old else None)

    async def recheck(self) -> None:
        """After a restart (end of the start-up phase): every "while" rule looks at the house as it is now and puts
        its devices back where something else changed them while Home Assistant was down or starting."""
        why = tr(self.core, "engine.why_restart_check")
        for rt in list(self.runtimes.values()):
            if rt.rule.get("type") != "while":
                continue
            await rt.reapply(why)
            rt.evaluate()

    # listeners between rules
    def on_mode(self, cb: Callable[[str, Context | None], Any]) -> Callable[[], None]:
        self._mode_listeners.append(cb)
        return lambda: self._mode_listeners.remove(cb) if cb in self._mode_listeners else None

    def on_fired(self, cb: Callable[[str, Context | None], Any]) -> Callable[[], None]:
        self._fired_listeners.append(cb)
        return lambda: self._fired_listeners.remove(cb) if cb in self._fired_listeners else None

    def on_active(self, cb: Callable[[], Any]) -> Callable[[], None]:
        self._active_listeners.append(cb)
        return lambda: self._active_listeners.remove(cb) if cb in self._active_listeners else None

    def mode_changed(self, mode: str, ctx: Context | None) -> None:
        for cb in list(self._mode_listeners):
            cb(mode, ctx)

    def active_changed(self) -> None:
        self.core.push("active")
        for cb in list(self._active_listeners):
            cb()

    def is_active(self, rule_id: str) -> bool:
        rt = self.runtimes.get(rule_id)
        return bool(rt and any(rt.active.values()))

    def active_map(self) -> dict[str, list[str]]:
        return {rid: [i for i, on in rt.active.items() if on] for rid, rt in self.runtimes.items() if any(rt.active.values())}

    def ran(self, rule: dict[str, Any], ctx: Context, done: list[dict[str, Any]], why: str, stopped: bool) -> None:
        texts = [d["text"] for d in done]
        ents = [e for d in done for e in d.get("entities", [])]
        acted = [d for d in done if not d.get("skipped")]
        if not acted:
            # nothing was switched (e.g. every device was left alone after a change by hand): not a run
            if done:
                self.core.history.add("skipped", tr(self.core, "engine.nothing_switched", name=quote(self.core, str(rule.get("name")))), f"{why} {'; '.join(texts)}"[:400], rule=rule)
            return
        entry = self.core.history.add("rule", ", ".join(texts)[:300], why, rule=rule, entity_id=ents[0] if ents else None)
        entry["entities"] = ents[:30]
        self.core.rule_ran(rule["id"])
        self.hass.bus.async_fire("house_rules_fired", {"rule_id": rule["id"], "name": rule.get("name"), "what": texts, "why": why, "entities": ents[:30]}, context=ctx)
        if rule.get("options", {}).get("notify_me") and not rule["id"].startswith("b_"):
            self.hass.async_create_task(self.core.notify_admins(rule, ", ".join(texts), why))
        for cb in list(self._fired_listeners):
            cb(rule["id"], ctx)

    async def run_now(self, rule_id: str, parent: Context | None = None, *, why: str | None = None, ignore_manual: bool = False) -> bool:
        rt = self.runtimes.get(rule_id)
        rule = self.core.rule(rule_id)
        if not rule:
            return False
        if ignore_manual:
            # e.g. a plan that was just saved: it counts now, even if someone turned a knob a moment ago
            rt = Runtime(self, {**rule, "options": {**rule.get("options", {}), "manual_pause": ""}})
        elif rt is None:
            rt = Runtime(self, rule)
        ctx = self.core.history.new_context(rule_id, parent)
        await rt._run(ctx, None, why or tr(self.core, "engine.started_by_hand"), None)
        return True

    def test(self, rule: dict[str, Any]) -> dict[str, Any]:
        checker: Checker = self.core.checker
        res = Resolver(self.core)
        instances = list(self.core.rooms) if res.uses_same(rule) else [None]
        best: dict[str, Any] | None = None
        for inst in instances:
            checks = []
            for section in ("when", "and", "only"):
                for i, c in enumerate(rule.get(section, [])):
                    ok, now, _w = checker.holds(c, inst, inst)
                    checks.append({"section": section, "index": i, "ok": ok, "now": now})
            relevant = [c for c in checks if c["section"] != "when" or rule.get("type") == "while"]
            blocked = next((c for c in relevant if not c["ok"]), None)
            cand = {"checks": checks, "blocked": blocked, "room": inst}
            if best is None or (blocked is None and best["blocked"] is not None):
                best = cand
        assert best is not None
        would = [self.core.describer.clause(c, "then") for c in rule.get("then", [])]
        where = f" ({self.core.rooms[best['room']]['name']})" if best["room"] in self.core.rooms else ""
        if best["blocked"]:
            b = best["blocked"]
            clause = rule[b["section"]][b["index"]]
            verdict = tr(self.core, "engine.test_blocked", clause=quote(self.core, self.core.describer.clause(clause, b["section"])))
        elif rule.get("type") == "while":
            verdict = tr(self.core, "engine.test_while", where=where)
        else:
            verdict = tr(self.core, "engine.test_ok")
        return {"checks": best["checks"], "would": would, "verdict": verdict}


# step verbs that describe a state (doing them again changes nothing when the device is already like this)
STEADY_VERBS = ("turn_on", "turn_off", "dim", "color", "set", "set_temp", "eco", "open", "close", "position", "volume", "select", "set_value", "set_text", "lock")


def steady(clause: dict[str, Any]) -> bool:
    """A step that can run again after a restart without side effects (no message, no wait, no timed revert)."""
    subject = str(clause.get("subject", ""))
    if subject == "mode":
        return True
    if subject.startswith(("notify:", "rule:")) or subject in ("wait", "alarm", "logic") or clause.get("for"):
        return False
    return clause.get("verb") in STEADY_VERBS


def _signed_seconds(value: Any) -> float:
    s = str(value or "0m")
    neg = s.startswith("-")
    return -(seconds(s.lstrip("+-")) or 0) if neg else (seconds(s.lstrip("+-")) or 0)


def _fmt(where: Any, sec: float) -> str:
    return tr(where, "dur.h", n=int(sec // 3600)) if sec >= 3600 and sec % 3600 == 0 else tr(where, "dur.m", n=int(sec // 60))
