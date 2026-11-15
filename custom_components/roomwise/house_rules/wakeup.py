"""Aufstehen erkennen: ends the house mode "Schlafen" when the residents got up for the day – not on a night trip.

Signals while the house sleeps: the bed (zones or presence sensors named "Bett"/"Bed", or the ones chosen) is empty
for a while, other rooms are occupied (kitchen, living room … count more than hall or bath), lights switched on by
hand and doors opened since the bed became empty, the time of day against the learned get-up time per kind of day
(workday or free day), and how long the night has lasted. A short return to the bed (under REBED_S, a sensor that
flickers) does not start the empty time again.

Guardrails: never before the plausible morning window of that kind of day, never in the first MIN_HOURS after
sleep began unless the evidence is very strong, and the earlier than usual, the longer the bed must be empty. A
night trip shorter than the learned threshold never ends sleep; the threshold grows above the longest usual
night trips by itself. As a last resort sleep ends when the bed has been empty for FALLBACK_MIN (without learning).

Action ("action"): "direct" ends sleep right away, "ask" asks the admins on their phones first ("Schlafen beenden?").
Feedback ("feedback"): after a direct end, now and then (the first ASK_FIRST times, when unsure, else about once a
week) the admins get "Aufstehen erkannt um 07:12 – stimmt das?" with Ja / Nein, zu früh / Nein, war schon früher
wach. Answers, ending or restarting sleep by hand and going back to bed right after a detection all adjust what
was learned (the bed-empty threshold per kind of day and the get-up times). Buttons count only from a user the
question went to.

Everything lives in the store: settings in mode_auto.wakeup, the night and what was learned in runtime.wakeup
(never in a backup, never sent anywhere). The pure functions below (decide, window, need_of, learn_*) hold the logic
and are tested without Home Assistant (tools/testha/test_wakeup.py).
"""

from __future__ import annotations

import logging
import math
import re
import time
import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.const import STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.util import dt as dt_util

from .i18n import tr

# i18n: complete

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

ACTION_PREFIX = "HR_WAKE_"
DEFAULT_NEED = 10.0  # minutes the bed is empty (with activity elsewhere) before "up"
MIN_NEED, MAX_NEED = 4.0, 45.0
REBED_S = 90  # back in bed at least this long: the empty time starts again
MIN_HOURS = 4.0  # never this soon after sleep began, unless very sure
FALLBACK_MIN = 90  # bed empty this long: sleep ends anyway (no learning)
MAX_NIGHT_H = 16  # sleep longer than this: the detection no longer holds it
ASK_FIRST = 7  # the first detections always ask for feedback
ASK_EVERY = 7 * 86400  # afterwards about once a week (or when unsure)
UNSURE = 0.6
VERY_SURE = 0.85
AFTER_S = 45 * 60  # after a detection: back in bed within this time …
BACK_S = 20 * 60  # … for this long = it was too early
ANSWER_S = 3 * 3600  # buttons older than this do nothing
KEEP_SAMPLES = 60
KEEP_TRIPS = 40
STATUS = {"wait": "wakeup.st_wait", "window": "wakeup.st_window", "early_night": "wakeup.st_early_night", "unsure": "wakeup.st_unsure"}
BED_RE = re.compile(r"(?<![a-zäöüß])(bett|bed|betten)(?![a-zäöüß])", re.I)  # i18n-ignore (names in both languages)
# rooms where the day starts (strong signal); hall, bath and the like count less
DAY_ROOM_RE = re.compile(r"küche|kueche|kuche|kitchen|wohn|living|lounge|esszimmer|essbereich|dining|büro|buero|office|arbeit|study", re.I)  # i18n-ignore


def default_config() -> dict[str, Any]:
    return {"on": False, "action": "direct", "feedback": True, "beds": [], "rooms": []}


def default_model() -> dict[str, Any]:
    return {"need": {"work": DEFAULT_NEED, "free": DEFAULT_NEED}, "samples": [], "trips": [], "detections": 0, "last_ask": 0.0, "last": None}


def clean_config(raw: Any, cur: dict[str, Any]) -> dict[str, Any]:
    out = {**default_config(), **cur}
    if not isinstance(raw, dict):
        return out
    for k in ("on", "feedback"):
        if isinstance(raw.get(k), bool):
            out[k] = raw[k]
    if raw.get("action") in ("direct", "ask"):
        out["action"] = raw["action"]
    if isinstance(raw.get("beds"), list):
        out["beds"] = [e for e in raw["beds"] if isinstance(e, str) and e.startswith("binary_sensor.")][:8]
    if isinstance(raw.get("rooms"), list):
        out["rooms"] = [r for r in raw["rooms"] if isinstance(r, str)][:30]
    return out


# ---------------------------------------------------------------------- the logic (pure, testable)
def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def need_of(model: dict[str, Any], kind: str) -> float:
    """Minutes the bed must be empty: the learned value, but always above the usual night trips."""
    need = float((model.get("need") or {}).get(kind, DEFAULT_NEED))
    trips = sorted(float(t) for t in model.get("trips") or [])
    if len(trips) >= 3:
        p90 = trips[min(len(trips) - 1, int(math.ceil(0.9 * len(trips))) - 1)]
        need = max(need, p90 * 1.25 + 1)
    return _clamp(need, MIN_NEED, MAX_NEED)


def window(model: dict[str, Any], kind: str, morning_h: float = 6) -> tuple[float, float, float]:
    """The usual get-up time (minute of the day), its spread and how many examples back it."""
    weight = {"yes": 1.0, "manual": 1.0, "late": 1.0, "auto": 0.5}
    ss = [(float(s["up"]), weight[s["src"]]) for s in model.get("samples") or [] if s.get("kind") == kind and s.get("src") in weight]
    n = sum(w for _u, w in ss)
    if n >= 2.5:
        mean = sum(u * w for u, w in ss) / n
        var = sum(w * (u - mean) ** 2 for u, w in ss) / n
        return mean, _clamp(math.sqrt(var), 20, 120), n
    return morning_h * 60 + (60 if kind == "work" else 150), 60.0, n


def activity(sig: dict[str, Any]) -> float:
    """0 … 1: how much the rest of the house says "the day has begun"."""
    extra = bool(sig.get("lights") or sig.get("doors"))
    if sig.get("strong"):
        return 1.0 if extra else 0.8
    if sig.get("rooms"):
        return 0.6 if extra else 0.4
    return 0.4 if extra else 0.0


def decide(sig: dict[str, Any], model: dict[str, Any], kind: str, minute: float, morning_h: float = 6) -> dict[str, Any]:
    """Got up for the day? sig: empty (minutes the bed is empty, None = in bed), hours (since sleep began),
    rooms / strong / lights / doors (activity elsewhere). Returns ok, conf, need, req and why not ("reason")."""
    need = need_of(model, kind)
    out: dict[str, Any] = {"ok": False, "conf": 0.0, "need": need, "req": need, "reason": "in_bed"}
    empty = sig.get("empty")
    if empty is None:
        return out
    act = activity(sig)
    mean, sd, _n = window(model, kind, morning_h)
    d = ((minute - mean + 720) % 1440) - 720  # minutes from the usual time, -720 … 720
    z = d / sd
    req = need if act >= 0.6 else (need * 2 if act > 0 else max(need * 2, 25))
    if sig.get("strong") and (sig.get("lights") or sig.get("doors") or len(sig.get("rooms") or []) >= 2):
        # the day has clearly begun (kitchen or living room and more): half the time is enough
        req = max(MIN_NEED, need * 0.5)
    if z < -0.5:
        req *= 1 + (-z - 0.5) * 0.5  # earlier than usual: more evidence
    hours = float(sig.get("hours") or 0)
    conf = 0.35 * min(1.0, empty / (1.5 * need)) + 0.25 * act + 0.25 * math.exp(-z * z / 2) + 0.15 * min(1.0, hours / 6)
    in_window = -max(45.0, 2 * sd) <= d <= max(3 * sd, 14 * 60 - mean)
    very = conf >= VERY_SURE and act >= 0.6 and empty >= 2 * need
    out.update(conf=round(conf, 2), req=req)
    if empty < req:
        out["reason"] = "wait"
    elif not in_window:
        out["reason"] = "window"
    elif hours < MIN_HOURS and not very:
        out["reason"] = "early_night"
    elif conf < 0.5:
        out["reason"] = "unsure"
    else:
        out.update(ok=True, reason="")
    return out


def should_ask(model: dict[str, Any], conf: float, now: float) -> bool:
    return int(model.get("detections") or 0) <= ASK_FIRST or conf < UNSURE or now - float(model.get("last_ask") or 0) >= ASK_EVERY


def _set_need(model: dict[str, Any], kind: str, value: float) -> None:
    model.setdefault("need", {})[kind] = round(_clamp(value, MIN_NEED, MAX_NEED), 1)


def add_sample(model: dict[str, Any], sample: dict[str, Any]) -> None:
    ss = [s for s in model.setdefault("samples", []) if s.get("day") != sample["day"]]  # one per morning
    ss.append(sample)
    model["samples"] = ss[-KEEP_SAMPLES:]


def add_trip(model: dict[str, Any], minutes: float) -> None:
    model["trips"] = [*(model.get("trips") or []), round(minutes, 1)][-KEEP_TRIPS:]


def learn_answer(model: dict[str, Any], answer: str) -> None:
    """Feedback on the last detection: yes, early ("Nein, zu früh"), late ("war schon früher wach")."""
    last = model.get("last") or {}
    kind, day = last.get("kind", "work"), last.get("day")
    need = need_of(model, kind)
    last["answer"] = answer
    if answer == "yes":
        _set_need(model, kind, need * 0.97)
        for s in model.get("samples") or []:
            if s.get("day") == day:
                s["src"] = "yes"
    elif answer == "early":
        # not up yet: the threshold grows, the time was no get-up time
        _set_need(model, kind, need * 1.35 + 2)
        model["samples"] = [s for s in model.get("samples") or [] if s.get("day") != day]
    elif answer == "late":
        _set_need(model, kind, need * 0.75)
        for s in model.get("samples") or []:
            if s.get("day") == day:
                s["src"] = "late"


def learn_manual_end(model: dict[str, Any], kind: str, day: str, up_minute: float, empty: float | None) -> None:
    """Sleep was ended by hand before a detection: a get-up time, and the threshold may come down a little."""
    add_sample(model, {"day": day, "kind": kind, "up": round(up_minute), "src": "manual", "empty": round(empty or 0, 1)})
    need = need_of(model, kind)
    if empty is not None and empty < need:
        _set_need(model, kind, max(empty + 1, need * 0.85))


def hm(minute: float) -> str:
    m = int(round(minute)) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


# ---------------------------------------------------------------------- in Home Assistant
class WakeUp:
    def __init__(self, hass: HomeAssistant, core: HouseRules, clock: Callable[[], float] = time.time) -> None:
        self.hass = hass
        self.core = core
        self.clock = clock
        self._unsub: list[Callable[[], None]] = []
        self.status = ""  # what the detection waits for right now (the panel shows it)

    # ------------------------------------------------------------------ settings and memory
    @property
    def config(self) -> dict[str, Any]:
        ma = self.core.data.setdefault("mode_auto", {})
        cfg = ma.get("wakeup")
        if not isinstance(cfg, dict):
            cfg = ma["wakeup"] = default_config()
        for k, v in default_config().items():
            cfg.setdefault(k, v)
        return cfg

    @property
    def _mem(self) -> dict[str, Any]:
        mem = self.core.data.setdefault("runtime", {}).setdefault("wakeup", {})
        mem.setdefault("night", {})
        if not isinstance(mem.get("model"), dict):
            mem["model"] = default_model()
        for k, v in default_model().items():
            mem["model"].setdefault(k, v)
        return mem

    @property
    def model(self) -> dict[str, Any]:
        return self._mem["model"]

    @property
    def night(self) -> dict[str, Any]:
        return self._mem["night"]

    def save(self, raw: Any) -> None:
        self.core.data.setdefault("mode_auto", {})["wakeup"] = clean_config(raw, self.config)
        self.core.save()
        self.core.mode_auto.start()

    def reset(self) -> None:
        """Forgets what was learned (the settings stay)."""
        self._mem["model"] = default_model()
        self.core.save()
        self.core.push("mode_auto")

    # ------------------------------------------------------------------ what counts
    def beds(self) -> list[str]:
        own = [e for e in self.config.get("beds") or [] if self.hass.states.get(e) is not None]
        if own:
            return own
        devs = self.core.inventory.devices.values()
        return sorted(d["entity_id"] for d in devs if d["kind"] in ("zone", "presence") and BED_RE.search(d.get("name") or ""))

    def ends_sleep(self) -> bool:
        """On and there is a bed to watch: then this is the end of "Schlafen". Not when the bed sensor reports nothing
        (away, broken) or the night has lasted MAX_NIGHT_H: then sleep ends as without the detection."""
        if not self.config.get("on") or not self.beds() or self._in_bed() is None:
            return False
        since = self.night.get("since")
        return not (since and self.core.mode == "sleep" and self.clock() - float(since) > MAX_NIGHT_H * 3600)

    def entities(self) -> list[str]:
        return self.beds() if self.config.get("on") else []

    def _rooms(self) -> list[dict[str, Any]]:
        """Rooms that tell "up": the chosen ones, else every room with presence (or door logic) that has no bed."""
        rt = self.core.room_tracker.rooms
        bed_rooms = {self.core.inventory.room_of(e) for e in self.beds()}
        own = [rt[r] for r in self.config.get("rooms") or [] if r in rt]
        if own:
            return own
        return [r for rid, r in rt.items() if rid not in bed_rooms and (r.get("presence") or r.get("motion") or r.get("door_logic") or r.get("zones"))]

    def _in_bed(self) -> bool | None:
        states = [self.hass.states.get(e) for e in self.beds()]
        known = [s for s in states if s and s.state not in (STATE_UNAVAILABLE, STATE_UNKNOWN)]
        if not known:
            return None  # no information (sensor away, start-up)
        return any(s.state == STATE_ON for s in known)

    def _busy_now(self, since: float | None = None) -> list[dict[str, Any]]:
        """Rooms occupied right now; `since`: only those that became occupied after that moment – a room that was
        occupied already before the bed became empty (a bathroom held by its door logic, a sensor that never let go)
        says nothing about getting up."""
        rt = self.core.room_tracker
        out = [r for r in self._rooms() if rt.occupied(r["id"])]
        if since is not None:
            out = [r for r in out if rt.changed_at(r["id"]) >= since - 30]
        return out

    def _signals(self, empty_since: float, seen: list[str] | None = None) -> dict[str, Any]:
        rooms = self._rooms()
        # rooms occupied now or at any time since the bed became empty (a walk through the kitchen counts, even when
        # nobody is there at the moment of the check)
        fresh = {r["id"] for r in self._busy_now(empty_since)}
        busy = [r for r in rooms if r["id"] in fresh or r["id"] in (seen or [])]
        ids = {r["id"] for r in rooms}
        lights = 0
        for eid, (t, _who) in list(self.core.history.manual.items()):
            st = self.hass.states.get(eid)
            if t >= empty_since and (eid.startswith("light.") or self.core.inventory.devices.get(eid, {}).get("kind") == "light") and st and st.state == STATE_ON and self.core.inventory.room_of(eid) in ids:
                lights += 1
        doors = 0
        # after a restart every state "changed" at the start: that is no door opened
        since = max(empty_since, float(getattr(self.core, "started_at", None) or 0) + 60)
        for r in rooms:
            for d in r.get("doors") or []:
                st = self.hass.states.get(d)
                if st and st.last_changed.timestamp() >= since:
                    doors += 1
        return {
            "rooms": [r["name"] for r in busy],
            "strong": any(DAY_ROOM_RE.search(r["name"]) for r in busy),
            "lights": lights,
            "doors": doors,
        }

    def _local(self) -> Any:
        """The local time of the clock (a test drives both)."""
        return dt_util.as_local(dt_util.utc_from_timestamp(self.clock()))

    def _kind(self) -> str:
        return "work" if self.core.checker._workday(self._local()) else "free"  # noqa: SLF001

    def _morning_h(self) -> float:
        return float(self.core.checker.window("morning")[0])

    def _signal_text(self, empty: float, sig: dict[str, Any]) -> str:
        parts = [tr(self.core, "wakeup.sig_bed", n=round(empty))]
        if sig["rooms"]:
            parts.append(tr(self.core, "wakeup.sig_rooms", rooms=", ".join(sig["rooms"][:3])))
        if sig["lights"]:
            parts.append(tr(self.core, "wakeup.sig_lights"))
        if sig["doors"]:
            parts.append(tr(self.core, "wakeup.sig_doors"))
        return ", ".join(parts)

    # ------------------------------------------------------------------ runtime
    def start(self) -> None:
        self.stop()
        self._unsub.append(self.hass.bus.async_listen("mobile_app_notification_action", self._action))

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()

    def mode_set(self, old: str, new: str, by_hand: bool) -> None:
        """Every change of the house mode (core.set_mode / core.auto_mode)."""
        now = self.clock()
        model = self.model
        last = model.get("last") or {}
        if new == "sleep" and old != "sleep":
            self._mem["night"] = {"since": now, "seen_bed": bool(self._in_bed()), "empty": None, "back": None, "done": False}
            if by_hand and self.config.get("on") and last and last.get("answer") is None and now - float(last.get("at") or 0) < 3600:
                # back to sleep by hand soon after a detection: it was too early
                learn_answer(model, "early")
                self.core.history.add("rule", tr(self.core, "wakeup.h_learned_early"), tr(self.core, "wakeup.h_learned_early_why"))
            self.core.save()
        elif old == "sleep" and new != "sleep":
            n = self.night
            if by_hand and self.config.get("on") and not n.get("done") and n.get("since") and now - float(n["since"]) >= 3 * 3600:
                local = self._local()
                minute = local.hour * 60 + local.minute
                if 4 * 60 <= minute <= 14 * 60:
                    empty = (now - n["empty"]) / 60 if n.get("empty") else None
                    up = minute - (empty or 0)
                    learn_manual_end(model, self._kind(), local.date().isoformat(), up, empty)
            n["done"] = True
            self.status = ""
            self.core.save()

    @callback
    def tick(self) -> None:
        """Called by the automatic house mode (every 30 s and on every change of a bed or a room)."""
        if not self.config.get("on") or self.core.starting():
            return
        if self.core.mode != "sleep":
            self._after()
            return
        n = self.night
        if not n.get("since"):
            n.update(since=self.clock(), seen_bed=False, empty=None, back=None, done=False)
        if n.get("done"):
            return
        now = self.clock()
        occ = self._in_bed()
        if occ is None:
            self.status = tr(self.core, "wakeup.st_no_bed")
            return
        changed = False
        if n.get("empty"):
            # remember every room that was occupied since the bed became empty
            seen = list(n.get("seen") or [])
            for r in self._busy_now(float(n["empty"])):
                if r["id"] not in seen:
                    seen.append(r["id"])
                    changed = True
            n["seen"] = seen
        if occ and n.get("empty") and self._busy_now(float(n["empty"])):
            # "back in bed" while someone is in another room: the bed sensor still sees a ghost (or the partner
            # stays in), the day has begun anyway – the empty time goes on
            n["back"] = None
        elif occ:
            if not n.get("seen_bed"):
                n["seen_bed"] = changed = True
            if n.get("empty"):
                n["back"] = n.get("back") or now
                if now - n["back"] >= REBED_S:
                    trip = (n["back"] - n["empty"]) / 60
                    if trip >= 0.3:
                        add_trip(self.model, trip)
                    n["empty"] = n["back"] = None
                    n["seen"] = []
                    changed = True
        else:
            n["back"] = None
            if n.get("empty") is None and n.get("seen_bed"):
                n["empty"] = now
                changed = True
        if not n.get("empty"):
            self.status = tr(self.core, "wakeup.st_in_bed") if n.get("seen_bed") else tr(self.core, "wakeup.st_not_yet")
            if changed:
                self.core.save()
            return
        empty = (now - n["empty"]) / 60
        local = self._local()
        minute = local.hour * 60 + local.minute
        sig = self._signals(n["empty"], n.get("seen"))
        hours = (now - float(n["since"])) / 3600
        kind = self._kind()
        res = decide({**sig, "empty": empty, "hours": hours}, self.model, kind, minute, self._morning_h())
        if res["ok"] and not n.get("asked"):
            self._detected(n, res, sig, empty, kind, local, minute)
            return
        if empty >= FALLBACK_MIN:
            n["done"] = True
            self.core.save()
            why = tr(self.core, "wakeup.h_fallback", n=round(empty))
            self.core.history.add("rule", tr(self.core, "wakeup.h_fallback_what"), why)
            self.core.mode_auto.end_now("sleep", why)
            return
        key = "wakeup.st_asked" if n.get("asked") else STATUS.get(res["reason"], "wakeup.st_unsure")
        self.status = tr(self.core, key, n=round(empty), need=round(res["req"]))
        if changed:
            self.core.save()

    def _detected(self, n: dict[str, Any], res: dict[str, Any], sig: dict[str, Any], empty: float, kind: str, local: Any, minute: float) -> None:
        now = self.clock()
        model = self.model
        cfg = self.config
        model["detections"] = int(model.get("detections") or 0) + 1
        up = minute - empty
        det = {"id": uuid.uuid4().hex[:8], "at": now, "up": round(up), "conf": res["conf"], "empty": round(empty, 1), "kind": kind, "day": local.date().isoformat(), "answer": None, "users": [], "ask": cfg.get("action") == "ask", "back": None}
        model["last"] = det
        signals = self._signal_text(empty, sig)
        self.status = ""
        if det["ask"]:
            n["asked"] = True  # waits for the answer; the last resort (bed empty FALLBACK_MIN) still counts
            self.core.save()
            self.hass.async_create_task(self._ask(det, signals))
            return
        n["done"] = True
        add_sample(model, {"day": det["day"], "kind": kind, "up": det["up"], "src": "auto", "empty": det["empty"], "rooms": sig["rooms"][:3]})
        self.core.save()
        why = tr(self.core, "wakeup.h_detected", signals=signals)
        self.core.history.add("rule", tr(self.core, "wakeup.h_detected_what"), why, logbook="mode")
        self.core.mode_auto.end_now("sleep", why)
        if cfg.get("feedback", True) and should_ask(model, res["conf"], now):
            model["last_ask"] = now
            self.hass.async_create_task(self._feedback(det))

    def _after(self) -> None:
        """After a detection: back in bed for a while soon after = it was too early (learned without asking)."""
        last = self.model.get("last") or {}
        now = self.clock()
        if not last or last.get("answer") is not None or last.get("ask") or now - float(last.get("at") or 0) > AFTER_S + BACK_S:
            return
        if self._in_bed():
            last["back"] = last.get("back") or now
            if now - last["back"] >= BACK_S and last["back"] - float(last["at"]) <= AFTER_S:
                learn_answer(self.model, "early")
                self.core.save()
                self.core.history.add("rule", tr(self.core, "wakeup.h_learned_early"), tr(self.core, "wakeup.h_back_to_bed"))
        else:
            last["back"] = None

    # ------------------------------------------------------------------ phones
    async def _admins(self) -> tuple[list[str], list[str]]:
        """Phones and user ids of the persons who are admins in Hausregeln."""
        from .permissions import role_of

        phones: list[str] = []
        users: list[str] = []
        for p in self.core.inventory.persons.values():
            st = self.hass.states.get(p["entity_id"])
            uid = st.attributes.get("user_id") if st else None
            user = await self.hass.auth.async_get_user(uid) if uid else None
            if user and user.is_active and role_of(self.hass, user) == "admin" and p.get("phones"):
                phones += p["phones"]
                users.append(user.id)
        return phones, users

    async def _feedback(self, det: dict[str, Any]) -> None:
        phones, users = await self._admins()
        det["users"] = users
        if not phones:
            return
        p = ACTION_PREFIX
        data = {
            "actions": [
                {"action": f"{p}YES_{det['id']}", "title": tr(self.core, "wakeup.btn_yes")},
                {"action": f"{p}EARLY_{det['id']}", "title": tr(self.core, "wakeup.btn_early")},
                {"action": f"{p}LATE_{det['id']}", "title": tr(self.core, "wakeup.btn_late")},
            ]
        }
        await self.core.notifier.send("wakeup", "feedback", tr(self.core, "wakeup.n_title"), tr(self.core, "wakeup.n_feedback", time=hm(det["up"])), services=phones, tag="house_rules_wakeup", data=data)

    async def _ask(self, det: dict[str, Any], signals: str) -> None:
        phones, users = await self._admins()
        det["users"] = users
        why = tr(self.core, "wakeup.h_detected", signals=signals)
        if not phones:
            # nobody to ask: end it as if "direkt" (said so in the history)
            self.core.history.add("rule", tr(self.core, "wakeup.h_detected_what"), tr(self.core, "wakeup.h_no_phone", why=why))
            add_sample(self.model, {"day": det["day"], "kind": det["kind"], "up": det["up"], "src": "auto", "empty": det["empty"]})
            self.core.save()
            self.core.mode_auto.end_now("sleep", why)
            return
        self.core.history.add("rule", tr(self.core, "wakeup.h_asked_what"), tr(self.core, "wakeup.h_asked", signals=signals))
        p = ACTION_PREFIX
        data = {"actions": [{"action": f"{p}END_{det['id']}", "title": tr(self.core, "wakeup.btn_end")}, {"action": f"{p}KEEP_{det['id']}", "title": tr(self.core, "wakeup.btn_keep")}]}
        self.model["last_ask"] = self.clock()
        self.core.save()
        await self.core.notifier.send("wakeup", "ask", tr(self.core, "wakeup.n_ask_title"), tr(self.core, "wakeup.n_ask", time=hm(det["up"]), signals=signals), services=phones, tag="house_rules_wakeup", data=data)

    @callback
    def _action(self, event: Event) -> None:
        action = str(event.data.get("action") or "")
        if action.startswith(ACTION_PREFIX):
            self.answer(action[len(ACTION_PREFIX) :], event.context.user_id)

    def answer(self, what: str, user_id: str | None) -> bool:
        """A button of a wakeup message ("YES_<id>" …). Only a user the message went to, only for the last detection."""
        verb, _, did = what.partition("_")
        last = self.model.get("last") or {}
        if not last or did != last.get("id") or verb not in ("YES", "EARLY", "LATE", "END", "KEEP"):
            return False
        if not user_id or user_id not in (last.get("users") or []):
            self.core.history.add("rule", tr(self.core, "wakeup.h_refused"), tr(self.core, "wakeup.h_refused_why"))
            _LOGGER.warning("House rules: wakeup button from user %s ignored (not a recipient)", user_id)
            return False
        if last.get("answer") is not None or self.clock() - float(last.get("at") or 0) > ANSWER_S:
            return False
        who = self.core.users.get(user_id, "")
        model = self.model
        if verb == "END":
            last["answer"] = "yes"
            add_sample(model, {"day": last["day"], "kind": last["kind"], "up": last["up"], "src": "yes", "empty": last["empty"]})
            self.core.save()
            if self.core.mode == "sleep":
                self.core.mode_auto.end_now("sleep", tr(self.core, "wakeup.h_confirmed", user=who))
            return True
        if verb == "KEEP":
            learn_answer(model, "early")
            n = self.night
            if self.core.mode == "sleep":
                n.update(asked=False, empty=None, back=None)  # look again from the next time the bed is empty
            self.core.save()
            self.core.history.add("rule", tr(self.core, "wakeup.h_kept"), tr(self.core, "wakeup.h_kept_why", user=who, need=round(need_of(model, last["kind"]))))
            return True
        answer = {"YES": "yes", "EARLY": "early", "LATE": "late"}[verb]
        learn_answer(model, answer)
        self.core.save()
        self.core.history.add("rule", tr(self.core, f"wakeup.h_answer_{answer}"), tr(self.core, "wakeup.h_answer_why", user=who, need=round(need_of(model, last["kind"]))))
        if answer == "early" and self.core.mode != "sleep" and self.clock() - float(last["at"]) < 1800 and self._in_bed():
            # still lying there: back to sleep (until getting up is detected again)
            self.hass.async_create_task(self.core.auto_mode("sleep", tr(self.core, "wakeup.h_back_sleep")))
        return True

    # ------------------------------------------------------------------ panel
    def view(self) -> dict[str, Any]:
        cfg = self.config
        model = self.model
        names = {d["entity_id"]: d.get("name") or d["entity_id"] for d in self.core.inventory.devices.values()}
        learned: dict[str, Any] = {}
        for kind in ("work", "free"):
            mean, sd, n = window(model, kind, self._morning_h())
            rooms: dict[str, int] = {}
            for s in model.get("samples") or []:
                if s.get("kind") == kind:
                    for r in s.get("rooms") or []:
                        rooms[r] = rooms.get(r, 0) + 1
            half = max(10.0, sd / 2)
            learned[kind] = {
                "from": hm(round((mean - half) / 5) * 5),
                "to": hm(round((mean + half) / 5) * 5),
                "n": round(n, 1),
                "need": round(need_of(model, kind)),
                "room": max(rooms, key=lambda k: rooms[k]) if rooms else None,
            }
        last = model.get("last") or None
        return {
            **cfg,
            "found_beds": [{"entity_id": e, "name": names.get(e, e)} for e in self.beds()],
            "found_rooms": [r["name"] for r in self._rooms()],
            "learned": learned,
            "detections": int(model.get("detections") or 0),
            "trips": len(model.get("trips") or []),
            "status": self.status if self.core.mode == "sleep" and cfg.get("on") else "",
            "last": {k: last[k] for k in ("at", "up", "answer", "conf") if k in last} if last else None,
        }
