"""Habits: weekly occupancy profiles per room and per person, learned locally (nothing leaves Home Assistant).

Per key (a room id, "p:<person id>" for being at home, "_house" for any activity at home) eight day profiles of
96 quarter hours: Monday … Sunday and one for public holidays (a weekday that the workday sensor
`binary_sensor.workday*` calls a day off). Each slot holds how often the key was active then; new observations
move it with an exponential average (the first days count fully, later each day 20 %), so the profile adapts in a
few weeks. Asking for a probability blends the weekday's own profile with its group (workdays or days off), so
two weeks of data already give a useful answer; without any data a sensible default by room name is used.

A room counts as active in a quarter hour when the room is occupied (its presence / motion sensors, door logic),
one of its lights is on, a media player in it plays, or the power of a TV / PC plug in it is above 15 W.

From the "_house" key: when you usually get up (first activity in the morning) and go to bed (house mode
"sleep", else the last activity of the evening), separately for workdays and days off.

Airing: for rooms with window contacts a key "w:<room id>" learns when a window of the room is usually open (same
weekly profile), and every opening is kept as an event (start, how long) for the airing pattern (Stoßlüften or a
window tilted for hours). The smart heating uses both to not preheat into the usual airing.

Learning: every minute the current activity is sampled (no extra listeners), at the end of a quarter hour it is
folded into the profiles. Shortly after the start the last days that are still in the recorder are read once (in
the executor, one bounded query per day, like the vacation simulation) – the recorder forgets after about ten
days, the profiles are kept in an own small store (`house_rules.habits`).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .simulate import DAY_START, default_weight

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

STORE_KEY = "house_rules.habits"
SLOT = 15
SLOTS = 96
HOLIDAY = 7
# a bedtime is learned only between 18:00 and 03:45 (minutes since DAY_START, 04:00)
BED_REL = (14 * 60, 23 * 60 + 45)
WORK = (0, 1, 2, 3, 4)
FREE = (5, 6, HOLIDAY)
ALPHA_MIN = 0.2  # later days: each new day counts 20 % (about five weeks of memory)
PRIOR_K = 2.0  # how strongly the group profile pulls a weekday with few days of its own
MAX_N = 31
WARM_DAYS = 10
POWER_ON = 15.0
AIR_KEEP = 150  # airing events kept per room
AIR_MIN = 2.0  # minutes a window must be open to count as airing
POWER_NAME = re.compile(r"\btv\b|fernseh|television|\bpc\b|computer|rechner|monitor|konsole|console|playstation|xbox|beamer|projector|media", re.I)


def _pack(v: float, n: int) -> int:
    return int(round(max(0.0, min(1.0, v)) * 1000)) * 32 + min(MAX_N, n)


def _unpack(x: int) -> tuple[float, int]:
    return (x // 32) / 1000, x % 32


def slot_of(dt: datetime) -> int:
    return (dt.hour * 60 + dt.minute) // SLOT


class Habits:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._store: Store[dict[str, Any]] = Store(hass, 1, STORE_KEY)
        self.d: dict[str, Any] = self._empty()
        self._unsub: list[Callable[[], None]] = []
        self._cur_slot: tuple[str, int] | None = None
        self._cur: dict[str, bool] = {}
        self._ents: dict[str, list[tuple[str, str]]] = {}
        self._ents_at = 0.0
        self._mode_prev: str | None = None
        self._open: dict[str, float] = {}
        self.warming = False
        self.loaded = False

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"v": 1, "bed_v": 2, "prof": {}, "days": {}, "wake": {}, "sleep": {}, "warm": [], "first_live": None, "house": {"day": None, "bits": [0] * SLOTS}, "mode": {}, "air": {}}

    async def async_load(self) -> None:
        try:
            raw = await self._store.async_load()
        except Exception as err:  # noqa: BLE001 — a broken file must not stop the integration
            _LOGGER.warning("Gewohnheiten laden: %s", err)
            raw = None
        if isinstance(raw, dict) and raw.get("v") == 1:
            self.d = {**self._empty(), **raw}
            # an evening activity until 04:00 used to count as "bedtime 04:00" and pulled the learned bedtime into the
            # afternoon: such a bedtime is forgotten and learned again
            for kind, cur in list((self.d.get("sleep") or {}).items()):
                if not isinstance(cur, dict) or not BED_REL[0] <= float(cur.get("m", -1)) < BED_REL[1]:
                    self.d["sleep"].pop(kind, None)
            # until 2026-11: an evening out (house empty from the afternoon) counted its last activity as bedtime and
            # pulled it into the early evening: the bedtimes learned so far are forgotten once and learned again
            if raw.get("bed_v", 1) < 2:
                self.d["sleep"] = {}
                self.d["bed_v"] = 2
        self.loaded = True

    def save(self) -> None:
        self._store.async_delay_save(lambda: self.d, 60)

    async def async_save_now(self) -> None:
        await self._store.async_save(self.d)

    # ------------------------------------------------------------------ runtime
    def start(self) -> None:
        self.stop()
        self._unsub.append(async_track_time_interval(self.hass, callback(lambda _now: self.sample()), timedelta(seconds=60)))
        self._unsub.append(async_call_later(self.hass, 150, callback(lambda _now: self.hass.async_create_background_task(self.warm_start(), "house_rules_habits_warm"))))
        keys = set(self.keys())
        for k in list(self.d["prof"]):
            if k not in keys:
                self.d["prof"].pop(k, None)
                self.d["days"].pop(k, None)

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()

    def keys(self) -> list[str]:
        return [*self.core.rooms, *(f"p:{pid}" for pid in self.core.inventory.persons), "_house", *(f"w:{rid}" for rid in self.core.rooms if self.windows(rid))]

    def windows(self, rid: str) -> list[str]:
        """The room's own window contacts (as chosen in its heating plan, else all window contacts of the room)."""
        heating = getattr(self.core, "heating", None)
        try:
            if heating is not None:
                return list(heating.room(rid)["window"]["contacts"] or self.core.inventory.in_room("window", rid))
        except Exception:  # noqa: BLE001 — learning must never break anything
            pass
        return self.core.inventory.in_room("window", rid)

    # ------------------------------------------------------------------ day types
    def _workday_entity(self) -> str | None:
        if self.hass.states.get("binary_sensor.workday_sensor"):
            return "binary_sensor.workday_sensor"
        return next((e for e in self.hass.states.async_entity_ids("binary_sensor") if e.startswith("binary_sensor.workday")), None)

    def workday(self, day: date) -> bool:
        """Today: the workday sensor if there is one (knows public holidays), other days: Monday to Friday."""
        if day == dt_util.now().date():
            e = self._workday_entity()
            st = self.hass.states.get(e) if e else None
            if st and st.state in ("on", "off"):
                return st.state == "on"
        return day.weekday() < 5

    def day_index(self, day: date, workday: bool | None = None) -> int:
        wd = self.workday(day) if workday is None else workday
        return HOLIDAY if day.weekday() < 5 and not wd else day.weekday()

    # ------------------------------------------------------------------ what is active now
    def _entities(self) -> dict[str, list[tuple[str, str]]]:
        """key → [(entity, how)] with how = light / media / power (rooms: occupancy comes from the room tracker)."""
        now = dt_util.utcnow().timestamp()
        if self._ents and now - self._ents_at < 600:
            return self._ents
        inv = self.core.inventory
        out: dict[str, list[tuple[str, str]]] = {}
        for rid in self.core.rooms:
            ents = [(e, "light") for e in inv.in_room("light", rid)] + [(e, "media") for e in inv.in_room("media", rid)]
            for d in inv.devices.values():
                if d.get("room") != rid or not d["entity_id"].startswith("sensor."):
                    continue
                st = self.hass.states.get(d["entity_id"])
                if st and st.attributes.get("device_class") == "power" and POWER_NAME.search(f"{d['entity_id']} {d.get('name', '')}"):
                    ents.append((d["entity_id"], "power"))
            out[rid] = ents
            if wins := self.windows(rid):
                out[f"w:{rid}"] = [(e, "occupancy") for e in wins]
        self._ents, self._ents_at = out, now
        return out

    @staticmethod
    def _on(how: str, state: str | None) -> bool:
        if state is None:
            return False
        if how == "light":
            return state == "on"
        if how == "media":
            return state in ("playing", "on")
        if how == "person":
            return state == "home"
        if how == "occupancy":
            return state == "on"
        try:
            return float(state) > POWER_ON
        except (TypeError, ValueError):
            return False

    def active_now(self) -> dict[str, bool]:
        out: dict[str, bool] = {}
        ents = self._entities()
        for rid in self.core.rooms:
            act = self.core.room_tracker.occupied(rid)
            if not act:
                for e, how in ents.get(rid, []):
                    st = self.hass.states.get(e)
                    if st and self._on(how, st.state):
                        act = True
                        break
            out[rid] = act
        inv = self.core.inventory
        for pid in inv.persons:
            out[f"p:{pid}"] = inv.person_home(pid)
        out["_house"] = any(out.get(r) for r in self.core.rooms)
        for key, lst in ents.items():
            if key.startswith("w:"):
                out[key] = any((st := self.hass.states.get(e)) is not None and st.state == "on" for e, _how in lst)
        return out

    def _airing(self, active: dict[str, bool]) -> None:
        """Window of a room opened / closed: an airing event (start minute, minutes open) when it was open long enough."""
        now = dt_util.now()
        ts = now.timestamp()
        for key, is_open in active.items():
            if not key.startswith("w:"):
                continue
            rid = key[2:]
            if is_open:
                self._open.setdefault(rid, ts)
                continue
            since = self._open.pop(rid, None)
            if since is None or (ts - since) / 60 < AIR_MIN:
                continue
            start = dt_util.as_local(dt_util.utc_from_timestamp(since))
            lst = self.d.setdefault("air", {}).setdefault(rid, [])
            lst.append([round(since), 1 if self.workday(start.date()) else 0, start.hour * 60 + start.minute, round((ts - since) / 60, 1)])
            del lst[: max(0, len(lst) - AIR_KEEP)]
            self.save()

    def air_events(self, rid: str) -> list[list[float]]:
        return list((self.d.get("air") or {}).get(rid) or [])

    @callback
    def sample(self) -> None:
        """Every minute: remember what is active in this quarter hour; at the end of it, learn."""
        try:
            now = dt_util.now()
            key = (now.date().isoformat(), slot_of(now))
            if self._cur_slot and key != self._cur_slot:
                day = date.fromisoformat(self._cur_slot[0])
                for k, v in self._cur.items():
                    self.fold(k, day, self._cur_slot[1], v)
                if not self.d["first_live"]:
                    self.d["first_live"] = self._cur_slot[0]
                self._cur = {}
                self.save()
            self._cur_slot = key
            active = self.active_now()
            for k, v in active.items():
                self._cur[k] = self._cur.get(k, False) or v
            self._airing(active)
            self._mode(now)
        except Exception as err:  # noqa: BLE001 — learning must never break anything
            _LOGGER.debug("Gewohnheiten: %s", err)

    def _mode(self, now: datetime) -> None:
        """House mode "sleep" starting / ending: bedtime and wake-up of the day (better than the last light)."""
        mode = self.core.mode
        if self._mode_prev is not None and mode != self._mode_prev:
            m = now.hour * 60 + now.minute
            day = (now - timedelta(minutes=DAY_START)).date().isoformat()
            # bedtime belongs to the evening's day, the wake-up to the morning's day: each keeps its own day
            if mode == "sleep" and (m >= 19 * 60 or m < 4 * 60):
                self.d["mode"] = {**self.d.get("mode", {}), "sleep_day": day, "sleep": m}
            elif self._mode_prev == "sleep" and 4 * 60 <= m < 12 * 60:
                self.d["mode"] = {**self.d.get("mode", {}), "wake_day": day, "wake": m}
            # everyone away in the evening: the last activity of that day is when they left, not a bedtime
            if mode in ("away", "vacation") and (m >= 14 * 60 or m < 4 * 60):
                self.d["mode"] = {**self.d.get("mode", {}), "away_day": day}
        self._mode_prev = mode

    # ------------------------------------------------------------------ learning
    def _rows(self, key: str) -> list[list[int]]:
        prof = self.d["prof"].get(key)
        if not prof:
            prof = self.d["prof"][key] = [[0] * SLOTS for _ in range(8)]
        return prof

    def fold(self, key: str, day: date, slot: int, obs: bool, workday: bool | None = None) -> None:
        di = self.day_index(day, workday)
        rows = self._rows(key)
        v, n = _unpack(rows[di][slot])
        a = max(ALPHA_MIN, 1.0 / (n + 1))
        rows[di][slot] = _pack(v + a * ((1.0 if obs else 0.0) - v), n + 1)
        if key == "_house":
            self._house_bit(day, slot, obs)

    def _house_bit(self, day: date, slot: int, obs: bool) -> None:
        """Activity of a "day" from 04:00 to 04:00 → wake-up and bedtime when the day is over."""
        clock = slot * SLOT
        hday = (day - timedelta(days=1)) if clock < DAY_START else day
        h = self.d["house"]
        if h.get("day") != hday.isoformat():
            if h.get("day"):
                self._learn_day(date.fromisoformat(h["day"]), h["bits"])
            h["day"], h["bits"] = hday.isoformat(), [0] * SLOTS
        idx = ((clock - DAY_START) % 1440) // SLOT
        if obs:
            h["bits"][idx] = 1

    def _learn_day(self, day: date, bits: list[int]) -> None:
        if sum(bits) < 4:
            return  # nobody home that day
        mode = self.d.get("mode") or {}
        iso = day.isoformat()
        wake = mode.get("wake") if mode.get("wake_day", mode.get("day")) == iso and mode.get("wake") is not None else next(((DAY_START + i * SLOT) for i in range(0, 32) if bits[i]), None)
        last = next((i for i in range(SLOTS - 1, 55, -1) if bits[i]), None)
        if mode.get("sleep_day", mode.get("day")) == iso and mode.get("sleep") is not None:
            sleep = mode["sleep"]
        elif last is not None and last < SLOTS - 1 and mode.get("away_day") != iso:
            sleep = (DAY_START + (last + 1) * SLOT) % 1440
        else:
            sleep = None  # active until 04:00 (guests, a sensor that never goes quiet): no bedtime to learn from
        kind = "work" if self.day_index(day, day.weekday() < 5) in WORK else "free"
        for what, val in (("wake", wake), ("sleep", sleep)):
            if val is None:
                continue
            # keep times after midnight comparable with the evening (minutes since 04:00)
            rel = (val - DAY_START) % 1440
            if what == "sleep" and not BED_REL[0] <= rel < BED_REL[1]:
                continue
            cur = self.d[what].get(kind)
            if cur is None:
                self.d[what][kind] = {"m": rel, "n": 1}
            else:
                n = int(cur.get("n", 1))
                self.d[what][kind] = {"m": round(cur["m"] + max(0.3, 1 / (n + 1)) * (rel - cur["m"]), 1), "n": min(99, n + 1)}

    def ingest(self, key: str, intervals: list[tuple[float, float]], days: list[date] | None = None) -> int:
        """Learn whole days from intervals (timestamps) when `key` was active – warm start and tests use the same
        path. Days without any interval in `days` count as "never active"."""
        tz = dt_util.get_default_time_zone()
        by_day: dict[date, list[int]] = {}
        for d in days or []:
            by_day.setdefault(d, [0] * SLOTS)
        for a, b in intervals:
            t = datetime.fromtimestamp(a, tz)
            t = t.replace(minute=(t.minute // SLOT) * SLOT, second=0, microsecond=0)
            while t.timestamp() < b:
                by_day.setdefault(t.date(), [0] * SLOTS)[slot_of(t)] = 1
                t += timedelta(minutes=SLOT)
        for d in sorted(by_day):
            for s, v in enumerate(by_day[d]):
                self.fold(key, d, s, bool(v), d.weekday() < 5)
        self.save()
        return len(by_day)

    async def warm_start(self) -> None:
        """Read the days the recorder still has (before live learning began), once per day."""
        if self.warming:
            return
        self.warming = True
        try:
            await self._warm()
        except Exception as err:  # noqa: BLE001 — learning must never break anything
            _LOGGER.warning("Gewohnheiten aus dem Verlauf: %s", err)
        finally:
            self.warming = False

    def _history_entities(self) -> dict[str, tuple[str, str, float]]:
        """entity → (key, how, minutes it keeps counting after it goes off)."""
        out: dict[str, tuple[str, str, float]] = {}
        for rid, room in self.core.rooms.items():
            after = float(room.get("empty_after") or 0)
            for e in room.get("presence") or []:
                out[e] = (rid, "occupancy", 0.0)
            for e in room.get("zones") or []:
                out.setdefault(e, (rid, "occupancy", 0.0))
            for e in room.get("motion") or []:
                out[e] = (rid, "occupancy", max(after, 1.0))
            for e, how in self._entities().get(rid, []):
                out.setdefault(e, (rid, how, 0.0))
            for e, how in self._entities().get(f"w:{rid}", []):
                out.setdefault(e, (f"w:{rid}", how, 0.0))
        for pid, p in self.core.inventory.persons.items():
            out[p["entity_id"]] = (f"p:{pid}", "person", 0.0)
        return out

    async def _warm(self) -> None:
        try:
            from homeassistant.components.recorder import get_instance, history  # noqa: PLC0415
        except ImportError:
            return
        ents = self._history_entities()
        if not ents:
            return
        rec = get_instance(self.hass)
        today = dt_util.now().date()
        first_live = date.fromisoformat(self.d["first_live"]) if self.d.get("first_live") else today
        done = set(self.d.get("warm") or [])
        tz = dt_util.get_default_time_zone()
        for back in range(WARM_DAYS, 0, -1):
            day = today - timedelta(days=back)
            if day >= first_live or day.isoformat() in done:
                continue
            start = datetime.combine(day, datetime.min.time(), tzinfo=tz)
            end = start + timedelta(days=1)
            try:
                states = await rec.async_add_executor_job(history.get_significant_states, self.hass, dt_util.as_utc(start), dt_util.as_utc(end), list(ents), None, True, True, False, True)
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("Gewohnheiten %s: %s", day, err)
                continue
            if not any(len(v) > 1 for v in states.values()):
                continue  # the recorder has nothing for that day
            bits: dict[str, list[int]] = {}
            s0, s1 = start.timestamp(), end.timestamp()
            for eid, seq in states.items():
                key, how, hold = ents.get(eid, (None, "", 0.0))
                if not key:
                    continue
                row = bits.setdefault(key, [0] * SLOTS)
                on_at: float | None = None
                for st in [*seq, None]:
                    t = st.last_changed.timestamp() if st is not None else s1
                    active = st is not None and self._on(how, st.state)
                    if active and on_at is None:
                        on_at = max(s0, t)
                    elif not active and on_at is not None:
                        a, b = on_at, min(s1, t + hold * 60)
                        for s in range(int((a - s0) // (SLOT * 60)), min(SLOTS, int((b - s0 - 1) // (SLOT * 60)) + 1)):
                            row[max(0, s)] = 1
                        on_at = None
            house = [0] * SLOTS
            for rid in self.core.rooms:
                for s, v in enumerate(bits.get(rid) or []):
                    house[s] |= v
            bits["_house"] = house
            for key in self.keys():
                row = bits.get(key)
                if row is None:
                    continue
                for s, v in enumerate(row):
                    self.fold(key, day, s, bool(v), day.weekday() < 5)
            done.add(day.isoformat())
            self.d["warm"] = sorted(done)[-20:]
        self.save()

    # ------------------------------------------------------------------ asking
    def _prior(self, key: str, slot: int) -> float:
        m = (slot * SLOT + SLOT // 2 - DAY_START) % 1440
        if key.startswith("p:"):
            clock = slot * SLOT
            return 0.9 if clock < 7 * 60 or clock >= 19 * 60 else 0.5
        if key == "_house":
            return 0.6
        if key.startswith("w:"):
            return 0.0  # airing without learned data: the prior from the heating assistant is used instead
        name = (self.core.rooms.get(key) or {}).get("name", key)
        return default_weight(name, m)

    def _blend(self, key: str, di: int, slot: int) -> tuple[float, int]:
        """(probability, days behind it) of one slot of one day profile."""
        rows = self.d["prof"].get(key)
        if not rows:
            return self._prior(key, slot), 0
        v, n = _unpack(rows[di][slot])
        group = WORK if di in WORK else FREE
        gs = gn = 0.0
        for g in group:
            gv, gnn = _unpack(rows[g][slot])
            gs += gv * gnn
            gn += gnn
        if gn <= 0:
            return self._prior(key, slot), 0
        gp = gs / gn
        return (v * n + PRIOR_K * gp) / (n + PRIOR_K), int(gn)

    def prob(self, key: str, dt: datetime) -> float:
        """How likely `key` is active in the quarter hour of `dt` (0…1), lightly smoothed with the neighbours."""
        di = self.day_index(dt.date())
        s = slot_of(dt)
        mid, _n = self._blend(key, di, s)
        before, _ = self._blend(key, di, max(0, s - 1))
        after, _ = self._blend(key, di, min(SLOTS - 1, s + 1))
        return round(0.6 * mid + 0.2 * before + 0.2 * after, 3)

    def day_probs(self, key: str, day: date) -> list[float]:
        """The 96 quarter-hour probabilities of `key` on that day (its weekday, holidays as days off), smoothed like prob()."""
        di = self.day_index(day)
        raw = [self._blend(key, di, s)[0] for s in range(SLOTS)]
        return [round(0.6 * raw[s] + 0.2 * raw[max(0, s - 1)] + 0.2 * raw[min(SLOTS - 1, s + 1)], 3) for s in range(SLOTS)]

    def day_days(self, key: str, day: date) -> int:
        """Days behind the profile group of that day (workdays or days off)."""
        rows = self.d["prof"].get(key)
        if not rows:
            return 0
        di = self.day_index(day)
        group = WORK if di in WORK else FREE
        return max(sum(_unpack(rows[g][s])[1] for g in group) for s in range(SLOTS))

    def confidence(self, key: str, dt: datetime) -> float:
        """0…1: how many days back the answer (a few weeks = sure)."""
        _p, n = self._blend(key, self.day_index(dt.date()), slot_of(dt))
        return round(n / (n + 4), 2)

    def days(self, key: str) -> int:
        rows = self.d["prof"].get(key)
        if not rows:
            return 0
        return max(sum(_unpack(rows[di][s])[1] for di in range(8)) for s in range(SLOTS))

    def home_prob(self, dt: datetime) -> float:
        """Someone (of the people who live here) is at home."""
        persons = list(self.core.inventory.persons)
        if not persons:
            return 1.0
        none = 1.0
        for pid in persons:
            none *= 1 - self.prob(f"p:{pid}", dt)
        return 1 - none

    def profile(self, key: str) -> list[list[int]]:
        """Monday … Sunday × 96 quarter hours in % (for the weekly heat map)."""
        return [[round(self._blend(key, di, s)[0] * 100) for s in range(SLOTS)] for di in range(7)]

    def sleep_window(self, day: date) -> tuple[int, int] | None:
        """(bedtime, wake-up) in minutes of the clock for the night before `day` ends, if learned."""
        kind = "work" if self.workday(day) else "free"
        s, w = self.d["sleep"].get(kind), self.d["wake"].get(kind)
        if not s or not w or s.get("n", 0) < 2 or w.get("n", 0) < 2:
            return None
        return int((s["m"] + DAY_START) % 1440), int((w["m"] + DAY_START) % 1440)

    def view(self) -> dict[str, Any]:
        def clock(x: dict[str, Any] | None) -> str | None:
            if not x:
                return None
            m = int(round(x["m"] + DAY_START)) % 1440
            return f"{m // 60:02d}:{m % 60:02d}"

        return {
            "wake": {k: clock(self.d["wake"].get(k)) for k in ("work", "free")},
            "sleep": {k: clock(self.d["sleep"].get(k)) for k in ("work", "free")},
            "days": {k: self.days(k) for k in self.keys()},
            "warm": len(self.d.get("warm") or []),
            "since": self.d.get("first_live"),
        }
