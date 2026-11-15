"""Walks of the dogs, run by the server.

Per dog: its walk times, an optional presence entity (home / out) and the reminder settings — sent by the card.
The server keeps today's outings (recorder history + live state changes), knows when a walk is due (a due walk
stays due until it is done: an outing of at least 5 minutes, a tap on a card, or "Done" in a notification) and
pushes the state to every card. Reminders, all optional and set in the card:
  * phone notifications — to chosen people; with a zone: only to those inside it, and when nobody is inside,
    to everyone (or nobody) — with a "Done" button,
  * an announcement on a speaker,
  * first after N minutes, repeated every M minutes, at most K times; cleared from the phones once done.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
import logging
import re
from typing import Any

from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

EARLY = 60 * 60  # a walk up to an hour before a walk time counts for it (s)
MIN_OUTING = 5 * 60  # an outing counts from five minutes on (s)
HOME_WORDS = ("home", "on", "true", "zuhause", "daheim", "anwesend", "drinnen")
ACTION_PREFIX = "FP_WALK"


def is_home(state: State | None) -> bool | None:
    if state is None or state.state in ("unavailable", "unknown"):
        return None
    domain = state.entity_id.split(".")[0]
    if domain in ("device_tracker", "person"):
        return state.state == "home"
    if domain in ("binary_sensor", "input_boolean", "switch"):
        return state.state == "on"
    return state.state.lower() in HOME_WORDS


def _minutes(hhmm: str) -> int | None:
    m = re.match(r"^\s*(\d{1,2}):(\d{2})", hhmm or "")
    if not m:
        return None
    v = int(m.group(1)) * 60 + int(m.group(2))
    return v if 0 <= v < 24 * 60 else None


def _norm(hhmm: str) -> str | None:
    v = _minutes(hhmm)
    return None if v is None else f"{v // 60:02d}:{v % 60:02d}"


def walk_state(slots: list[str], now: datetime, home: bool | None, away: list[tuple[float, float]], manual: set[str]) -> dict[str, Any]:
    """Same rules as the card: the latest walk time that has begun and is not done is due"""
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    t = now.timestamp()
    sorted_slots = sorted({s for s in (_norm(x) for x in slots) if s})
    starts = [day.timestamp() + (_minutes(s) or 0) * 60 for s in sorted_slots]
    settled = -1
    for i, s in enumerate(sorted_slots):
        start = starts[i]
        walked = any(b - a >= MIN_OUTING and b > start - EARLY and a < t for a, b in away)
        if s in manual or (walked and start - EARLY <= t):
            settled = i
    done: list[str] = []
    slot: str | None = None
    nxt: str | None = None
    for i, s in enumerate(sorted_slots):
        if i <= settled:
            done.append(s)
        elif starts[i] <= t:
            slot = s
        elif nxt is None:
            nxt = s
    if home is False:
        last = away[-1] if away else None
        return {"mode": "away", "done": done, "next": nxt, "awaySince": int(last[0] * 1000) if last and last[1] >= t - 60 else None}
    return {"mode": "due" if slot else "idle", "slot": slot, "next": nxt, "done": done}


class PetTracker:
    """One card's dogs"""

    def __init__(self, hass: HomeAssistant, card_id: str, pets: list[dict[str, Any]], manual: Callable[[str], set[str]], on_change: Callable[[str], None], remind_store: dict[str, Any], save: Callable[[], None]) -> None:
        self.hass = hass
        self.card_id = card_id
        self.pets = pets
        self._manual = manual
        self._on_change = on_change
        self._rem = remind_store  # pet id → {"date", "slot", "n", "last", "sent": [services]}
        self._save = save
        self._changes: dict[str, list[tuple[float, bool | None]]] = {}
        self._day = ""
        self.states: dict[str, dict[str, Any]] = {}
        self._unsubs: list[CALLBACK_TYPE] = []

    async def async_start(self) -> None:
        await self._load_history()
        presence = [p["presence"] for p in self.pets if p.get("presence")]
        if presence:
            self._unsubs.append(async_track_state_change_event(self.hass, presence, self._presence_changed))
        self._unsubs.append(async_track_time_interval(self.hass, self._tick, timedelta(seconds=30)))
        self.evaluate()

    def stop(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()

    # ---------- today's outings ----------

    async def _load_history(self) -> None:
        now = dt_util.now()
        self._day = now.date().isoformat()
        start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(hours=3)
        for p in self.pets:
            ent = p.get("presence")
            if not ent:
                continue
            changes: list[tuple[float, bool | None]] = []
            try:
                from homeassistant.components.recorder import get_instance, history

                rows = await get_instance(self.hass).async_add_executor_job(history.state_changes_during_period, self.hass, start, None, ent, True, False, None, True)
                for st in rows.get(ent, []):
                    changes.append((st.last_changed.timestamp(), is_home(st)))
            except Exception:  # noqa: BLE001 — no recorder: the current state is all we know
                st = self.hass.states.get(ent)
                if st is not None:
                    changes.append((st.last_changed.timestamp(), is_home(st)))
            self._changes[ent] = changes

    @callback
    def _presence_changed(self, event: Event[EventStateChangedData]) -> None:
        new = event.data["new_state"]
        if new is None:
            return
        self._changes.setdefault(new.entity_id, []).append((new.last_changed.timestamp(), is_home(new)))
        self.evaluate()

    def _away(self, ent: str, now: float) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        start: float | None = None
        for ts, home in self._changes.get(ent, []):
            if home is False and start is None:
                start = ts
            elif home is True and start is not None:
                out.append((start, ts))
                start = None
        if start is not None:
            out.append((start, now))
        return out

    # ---------- state + reminders ----------

    @callback
    def _tick(self, _now: Any = None) -> None:
        if dt_util.now().date().isoformat() != self._day:
            self.hass.async_create_task(self._new_day())
            return
        self.evaluate()

    async def _new_day(self) -> None:
        await self._load_history()
        self.evaluate()

    @callback
    def evaluate(self) -> None:
        now = dt_util.now()
        states: dict[str, dict[str, Any]] = {}
        for p in self.pets:
            ent = p.get("presence")
            home = is_home(self.hass.states.get(ent)) if ent else None
            states[p["id"]] = walk_state(p.get("walks", []), now, home, self._away(ent, now.timestamp()) if ent else [], self._manual(p["id"]))
        if states != self.states:
            self.states = states
            self._on_change(self.card_id)
        for p in self.pets:
            self._remind(p, states[p["id"]], now)

    def _remind(self, pet: dict[str, Any], st: dict[str, Any], now: datetime) -> None:
        r = pet.get("remind") or {}
        if not (r.get("notify") or r.get("speak")):
            return
        pid = pet["id"]
        today = now.date().isoformat()
        rec = self._rem.get(pid)
        slot = st.get("slot") if st["mode"] == "due" else None
        if rec and (rec.get("date") != today or rec.get("slot") != slot):
            # done, out for the walk, or the next walk time: phones forget the old reminder
            if rec.get("sent"):
                self.hass.async_create_task(self._clear(rec["sent"], pid))
            self._rem.pop(pid, None)
            self._save()
            rec = None
        if not slot:
            return
        start = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(minutes=_minutes(slot) or 0)
        after = max(0, int(r.get("after", 0)))
        repeat = max(0, int(r.get("repeat", 0)))
        count = max(1, int(r.get("count", 1 if not repeat else 3)))
        if now < start + timedelta(minutes=after):
            return
        rec = rec or {"date": today, "slot": slot, "n": 0, "last": 0, "sent": []}
        if rec["n"] >= count or (rec["n"] and (not repeat or now.timestamp() - rec["last"] < repeat * 60)):
            self._rem[pid] = rec
            return
        rec["n"] += 1
        rec["last"] = now.timestamp()
        self._rem[pid] = rec
        self._save()
        self.hass.async_create_task(self._send(pet, slot, rec))

    def _text(self, pet: dict[str, Any], slot: str) -> str:
        r = pet.get("remind") or {}
        tpl = r.get("text") or "{name} muss raus! (Gassi um {zeit})"
        return tpl.replace("{name}", pet.get("name") or "").replace("{zeit}", slot)

    def recipients(self, notify: dict[str, Any]) -> list[str]:
        """Notify services: with a zone only the people inside it; nobody inside → everyone (or nobody)"""
        targets = [t for t in notify.get("targets", []) if isinstance(t, dict) and t.get("service")]
        zone = notify.get("zone")
        if not zone:
            return [t["service"] for t in targets]

        def inside(person: str | None) -> bool:
            st = self.hass.states.get(person) if person else None
            if st is None:
                return False
            if zone == "zone.home":
                return st.state == "home"
            z = self.hass.states.get(zone)
            return z is not None and st.state in (z.name, z.object_id, zone)

        chosen = [t["service"] for t in targets if inside(t.get("person"))]
        if not chosen and notify.get("fallback", "all") == "all":
            chosen = [t["service"] for t in targets]
        return chosen

    async def _send(self, pet: dict[str, Any], slot: str, rec: dict[str, Any]) -> None:
        r = pet.get("remind") or {}
        msg = self._text(pet, slot)
        tag = f"fp-walk-{self.card_id}-{pet['id']}"
        notify = r.get("notify")
        if notify:
            for service in self.recipients(notify):
                domain, _, name = service.partition(".")
                if domain != "notify" or not name:
                    continue
                data: dict[str, Any] = {"tag": tag}
                if r.get("done_button", True):
                    data["actions"] = [{"action": f"{ACTION_PREFIX}|{self.card_id}|{pet['id']}|{slot}", "title": r.get("done_label") or "Erledigt"}]
                if r.get("important"):
                    # iOS: time sensitive (breaks through Focus); Android: high priority, delivered at once
                    data.update({"push": {"interruption-level": "time-sensitive"}, "priority": "high", "ttl": 0})
                try:
                    await self.hass.services.async_call("notify", name, {"title": r.get("title") or pet.get("name") or "Gassi", "message": msg, "data": data}, blocking=True)
                except Exception:  # noqa: BLE001 — not every notify service knows actions: plain message
                    try:
                        await self.hass.services.async_call("notify", name, {"title": r.get("title") or pet.get("name") or "Gassi", "message": msg}, blocking=True)
                    except Exception:  # noqa: BLE001
                        _LOGGER.warning("Walk reminder: %s failed", service, exc_info=True)
                        continue
                if service not in rec["sent"]:
                    rec["sent"].append(service)
            self._save()
        speak = r.get("speak")
        if speak and speak.get("tts_entity") and speak.get("media_player"):
            data2: dict[str, Any] = {"media_player_entity_id": speak["media_player"], "message": msg, "cache": True}
            if speak.get("language"):
                data2["language"] = speak["language"]
            try:
                await self.hass.services.async_call("tts", "speak", data2, target={"entity_id": speak["tts_entity"]}, blocking=False)
            except Exception:  # noqa: BLE001
                _LOGGER.warning("Walk reminder: announcement failed", exc_info=True)

    async def _clear(self, services: list[str], pid: str) -> None:
        tag = f"fp-walk-{self.card_id}-{pid}"
        for service in services:
            domain, _, name = service.partition(".")
            if domain != "notify":
                continue
            try:
                await self.hass.services.async_call("notify", name, {"message": "clear_notification", "data": {"tag": tag}}, blocking=True)
            except Exception:  # noqa: BLE001 — services without clearing: nothing to do
                pass


def sanitize_pets(pets: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in pets if isinstance(pets, list) else []:
        if not isinstance(p, dict) or not isinstance(p.get("id"), str):
            continue
        r = p.get("remind") if isinstance(p.get("remind"), dict) else {}
        notify = r.get("notify") if isinstance(r.get("notify"), dict) else None
        speak = r.get("speak") if isinstance(r.get("speak"), dict) else None
        out.append(
            {
                "id": p["id"],
                "name": str(p.get("name") or ""),
                "walks": [s for s in (_norm(str(x)) for x in p.get("walks", []) or []) if s],
                "presence": p.get("presence") if isinstance(p.get("presence"), str) else None,
                "remind": {
                    "after": int(r.get("after", 0) or 0),
                    "repeat": int(r.get("repeat", 0) or 0),
                    "count": int(r.get("count", 0) or 0) or None,
                    "text": str(r["text"]) if r.get("text") else None,
                    "title": str(r["title"]) if r.get("title") else None,
                    "done_label": str(r["done_label"]) if r.get("done_label") else None,
                    "done_button": r.get("done_button", True) is not False,
                    "important": bool(r.get("important")),
                    "notify": {
                        "targets": [{"service": str(t["service"]), "person": t.get("person") if isinstance(t.get("person"), str) else None} for t in notify.get("targets", []) if isinstance(t, dict) and t.get("service")],
                        "zone": notify.get("zone") if isinstance(notify.get("zone"), str) else None,
                        "fallback": "none" if notify.get("fallback") == "none" else "all",
                    }
                    if notify
                    else None,
                    "speak": {k: str(speak[k]) for k in ("tts_entity", "media_player", "language") if speak.get(k)} if speak else None,
                },
            }
        )
    for p in out:
        if p["remind"]["count"] is None:
            del p["remind"]["count"]
    return out
