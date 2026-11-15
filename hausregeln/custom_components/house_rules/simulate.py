"""Vacation: look lived-in, learned from everyday life.

Learning: every night the occupancy of the rooms (the "… belegt" sensors of this integration) and which lights were
on how bright are read from Home Assistant's recorder and kept as a compact summary per day (6 weeks). From that:
per room and quarter hour how likely someone is there (workdays and weekends apart), when you usually get up and go
to bed, how long you stay in a room, whether you get up at night (and where to), which lights you use there at what
time of day and how bright, and which rooms follow each other (ways through the flat).

Neighbouring rooms: from the floor plan card (a door on the wall between two rooms), from the learned room changes,
or by name (a hallway connects). That gives the ways: going from the bedroom to the kitchen lights the hallway
for a few seconds on the way.

Simulation: for every day and every simulated person (one per resident, at most two) a timeline is drawn by
chance from what was learned: up in the morning (bedroom dim, bathroom, kitchen …), rooms during the day/evening
with their usual times and stays, away when you are usually away, bed in the evening (bedroom a while, then dark),
sometimes a trip at night. A light only goes on where it is dark right then (the room's light sensor, else the sun),
so in the morning in winter, but not in summer; in a dark room earlier than in a bright one.
The same day always gives the same timeline (seeded), the next day a different one.
"""

from __future__ import annotations

import logging
import math
import random
from collections import Counter, defaultdict, deque
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later, async_track_time_change, async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import DOMAIN

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

DAY_START = 4 * 60  # a "day" runs from 04:00 to 04:00, so a late evening belongs to its day
SLOT = 15  # minutes per slot
SLOTS = 1440 // SLOT
KEEP_DAYS = 42
BUCKETS = (("morning", 4 * 60, 10 * 60), ("day", 10 * 60, 17 * 60), ("evening", 17 * 60, 22 * 60), ("night", 22 * 60, 28 * 60))


def default_config() -> dict[str, Any]:
    return {
        "smart": True,
        "people": 0,
        "morning": True,
        "night": True,
        # when is it dark enough for a light? every check that is on must agree
        "dark": {
            "sun": True,  # the sun lower than … degrees above the horizon
            "sun_below": 3,
            "lux": True,  # the room's light sensor below … lx (0 = learned: where you usually switch on, else the room's limit)
            "lux_below": 0,
            "habits": True,  # only at times of day you use the light in that room (rooms you light by day: sun does not count)
            "never": False,  # never between … and …
            "never_from": "09:00",
            "never_to": "16:00",
        },
    }


def _hm(v: Any) -> int | None:
    try:
        h, m = str(v).split(":")[:2]
        return int(h) % 24 * 60 + int(m) % 60
    except (ValueError, AttributeError):
        return None


def sim_minute(now: datetime) -> tuple[date, float]:
    """(day it belongs to, minutes since 04:00 of that day)."""
    local = dt_util.as_local(now)
    shifted = local - timedelta(minutes=DAY_START)
    return shifted.date(), shifted.hour * 60 + shifted.minute + shifted.second / 60


def clock(m: float) -> str:
    t = int(round(m + DAY_START)) % 1440
    return f"{t // 60:02d}:{t % 60:02d}"


def bucket_of(m: float) -> str:
    t = m + DAY_START
    for name, a, b in BUCKETS:
        if a <= t < b:
            return name
    return "night"


MIN_DAYS = 4
LEARN_VERSION = 3  # 2: from the rooms' own sensors, 3: with the light level at switching on  # fewer learned days: sensible defaults instead


def default_weight(name: str, m: float) -> float:
    """Without learned data: how likely someone is in a room of this kind at this time (minutes since 04:00)."""
    n = name.lower()
    t = (m + DAY_START) % 1440
    meal = any(a <= t < b for a, b in ((6 * 60 + 30, 8 * 60), (12 * 60, 13 * 60 + 30), (18 * 60, 20 * 60)))
    if any(w in n for w in ("wohn", "living", "lounge")):
        return 0.5 if t >= 17 * 60 else 0.25
    if any(w in n for w in ("küche", "kuche", "kitchen", "ess")):
        return 0.45 if meal else 0.12
    if any(w in n for w in ("arbeit", "büro", "buero", "office")):
        return 0.3 if 9 * 60 <= t < 18 * 60 else 0.08
    if any(w in n for w in ("bad", "wc", "bath", "toilet")):
        return 0.08
    if any(w in n for w in ("flur", "diele", "gang", "hall", "eingang")):
        return 0.0  # passed on the way, not a place to stay
    if any(w in n for w in ("schlaf", "bed")):
        return 0.02
    return 0.1


def _dist_point_segment(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _dist_polygon(p: tuple[float, float], pts: list[list[float]]) -> float:
    return min(_dist_point_segment(p, tuple(pts[i]), tuple(pts[(i + 1) % len(pts)])) for i in range(len(pts)))  # type: ignore[arg-type]


class Simulator:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._unsub: list[Any] = []
        self._plans: dict[tuple[str, int], list[dict[str, Any]]] = {}
        self._active: dict[str, str] = {}  # room → key of the segment that is on right now (to notice changes)
        self._floor: dict[str, Any] = {"pairs": [], "entrance": [], "found": False}
        self.learning = False

    # ------------------------------------------------------------------ data
    @property
    def data(self) -> dict[str, Any]:
        d = self.core.data.setdefault("sim", {})
        d.setdefault("config", default_config())
        d.setdefault("days", {})
        d.setdefault("model", {})
        return d

    @property
    def config(self) -> dict[str, Any]:
        cfg = {**default_config(), **self.data["config"]}
        cfg["dark"] = {**default_config()["dark"], **(self.data["config"].get("dark") or {})}
        return cfg

    def save_config(self, raw: dict[str, Any]) -> None:
        cfg = self.config
        for k in ("smart", "morning", "night"):
            if isinstance(raw.get(k), bool):
                cfg[k] = raw[k]
        if isinstance(raw.get("people"), int):
            cfg["people"] = max(0, min(3, raw["people"]))
        if isinstance(raw.get("dark"), dict):
            d = {**default_config()["dark"], **(cfg.get("dark") or {})}
            for k in ("sun", "lux", "habits", "never"):
                if isinstance(raw["dark"].get(k), bool):
                    d[k] = raw["dark"][k]
            if isinstance(raw["dark"].get("sun_below"), (int, float)):
                d["sun_below"] = max(-8, min(20, round(float(raw["dark"]["sun_below"]))))
            if isinstance(raw["dark"].get("lux_below"), (int, float)):
                d["lux_below"] = max(0, min(2000, round(float(raw["dark"]["lux_below"]))))
            for k in ("never_from", "never_to"):
                if _hm(raw["dark"].get(k)) is not None:
                    m = _hm(raw["dark"][k]) or 0
                    d[k] = f"{m // 60:02d}:{m % 60:02d}"
            cfg["dark"] = d
        self.data["config"] = cfg
        self._plans.clear()
        self.core.save()
        self.tick()

    # ------------------------------------------------------------------ runtime
    def start(self) -> None:
        self.stop()
        if not self.active_feature():
            return  # feature "vacation" (or "light") off: no ticks, no learning
        self._unsub.append(async_track_time_interval(self.hass, callback(lambda _now: self.tick()), timedelta(seconds=10)))
        self._unsub.append(async_track_time_change(self.hass, callback(lambda _now: self.hass.async_create_task(self.learn())), hour=4, minute=20, second=0))
        # learn once shortly after the start (the recorder needs a moment)
        self._unsub.append(async_call_later(self.hass, 90, callback(lambda _now: self.hass.async_create_task(self.learn()))))

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()

    def active_feature(self) -> bool:
        return self.core.feature("vacation") and self.core.feature("light")

    def enabled(self) -> bool:
        return self.core.mode == "vacation" and bool(self.config["smart"]) and self.active_feature()

    @callback
    def tick(self) -> None:
        """While on vacation: tell the light plan of every room whose simulated state changed."""
        if not self.enabled():
            if self._active:
                rooms = list(self._active)
                self._active.clear()
                for rid in rooms:
                    self.core.lightplan.schedule(rid, 0.1)
            return
        now = dt_util.now()
        for rid in self.core.rooms:
            seg = self.current(rid, now)
            key = f"{seg['from']}-{seg['kind']}" if seg else ""
            if self._active.get(rid, "") != key:
                if key:
                    self._active[rid] = key
                else:
                    self._active.pop(rid, None)
                self.core.lightplan.schedule(rid, 0.1)

    # ------------------------------------------------------------------ what a room should look like now
    def people(self) -> int:
        n = int(self.config["people"])
        if n:
            return n
        res = [r for r in self.core.residents() if r["counts"]]
        return max(1, min(2, len(res)))

    def current(self, rid: str, now: datetime | None = None) -> dict[str, Any] | None:
        """The simulated stay in this room right now (any simulated person), or None."""
        day, m = sim_minute(now or dt_util.now())
        best = None
        for w in range(self.people()):
            for seg in self.plan_for(day, w):
                if seg["room"] == rid and seg["from"] <= m < seg["to"]:
                    # the brighter use wins (a stay over a pass)
                    if best is None or (best["kind"] in ("pass", "bed", "wake", "night") and seg["kind"] == "stay"):
                        best = seg
        return best

    def want(self, rid: str, room_lights: list[str], fallback_brightness: int, color: str, is_on: dict[str, bool]) -> dict[str, dict[str, Any]]:
        """Desired state of the room's vacation lights right now."""
        seg = self.current(rid)
        out: dict[str, dict[str, Any]] = {}
        if not seg:
            return {e: {"mode": "off", "why": "Urlaub: niemand (simuliert)"} for e in room_lights}
        already = any(is_on.get(e) for e in room_lights)
        dark, reason = self.dark(rid, seg, already)
        if not dark:
            return {e: {"mode": "off", "why": f"Urlaub: {reason}"} for e in room_lights}
        learned = ((self.data["model"].get("lights") or {}).get(rid, {})).get(bucket_of(seg["from"])) or {}
        use = [e for e in (learned.get("lights") or []) if e in room_lights] or room_lights
        b = int(learned.get("brightness") or fallback_brightness)
        if seg["kind"] in ("bed", "wake", "night"):
            b = min(b, 25)
        why = {"stay": f"Urlaub: simuliert {seg['who']} hier", "pass": "Urlaub: simuliert vorbeigehen", "bed": "Urlaub: simuliert ins Bett", "wake": "Urlaub: simuliert aufstehen", "night": "Urlaub: simuliert nachts auf"}[seg["kind"]]
        for e in room_lights:
            out[e] = {"mode": "on", "brightness": max(1, b), "color": color, "why": why} if e in use else {"mode": "off", "why": "Urlaub"}
        return out

    def lux_limit(self, rid: str) -> tuple[float, str]:
        """Below how many lx a light makes sense here: set by hand, learned (where you switch on), or the room's limit."""
        d = self.config["dark"]
        if d.get("lux_below"):
            return float(d["lux_below"]), "eingestellt"
        learned = (self.data["model"].get("lux_on") or {}).get(rid)
        if learned:
            return float(learned), "gelernt"
        return float((self.core.rooms.get(rid) or {}).get("dark_below") or 80), "Raum"

    def dark(self, rid: str, seg: dict[str, Any] | None = None, already: bool = False, now: datetime | None = None) -> tuple[bool, str]:
        """Is it dark enough for a light in this room right now? (yes/no, why in words)"""
        d = self.config["dark"]
        now = now or dt_util.now()
        model = self.data["model"]
        enough = int(model.get("days") or 0) >= MIN_DAYS
        bucket = bucket_of(seg["from"]) if seg else bucket_of(sim_minute(now)[1])
        room_learned = (model.get("lights") or {}).get(rid, {})
        if d.get("never"):
            a, b = _hm(d.get("never_from")), _hm(d.get("never_to"))
            m = dt_util.as_local(now).hour * 60 + dt_util.as_local(now).minute
            if a is not None and b is not None and (a <= m < b if a <= b else (m >= a or m < b)):
                return False, f"nie zwischen {d['never_from']} und {d['never_to']} Uhr"
        by_day = False  # you light this room by day as well (no window …): the sun does not count here
        if d.get("habits") and enough and room_learned:

            def used(bk: str, at_least: float) -> bool:
                x = room_learned.get(bk) or {}
                share = x.get("share")
                return bool(x) and (share is None or share >= at_least)

            if not used(bucket, 0.25) and (not seg or seg["kind"] == "stay"):
                return False, "um diese Zeit macht ihr hier sonst kein Licht an"
            # light on most of the time someone is there by day (no window …): the sun does not count here
            by_day = used("day", 0.6)
        if d.get("sun") and not by_day:
            sun = self.hass.states.get("sun.sun")
            elev = sun.attributes.get("elevation") if sun else None
            if isinstance(elev, (int, float)) and elev > float(d.get("sun_below", 3)):
                return False, f"Sonne noch {elev:.0f}° hoch"
        if d.get("lux") and not already:
            lux = self.core.room_tracker.lux(rid)
            if lux is not None:
                limit, _src = self.lux_limit(rid)
                if lux >= limit:
                    return False, f"hell genug ({lux:.0f} lx)"
        return True, "dunkel"

    # ------------------------------------------------------------------ the timeline of a day
    def plan_for(self, day: date, walker: int) -> list[dict[str, Any]]:
        key = (day.isoformat(), walker)
        if key not in self._plans:
            if len(self._plans) > 20:
                self._plans.clear()
            self._plans[key] = self._generate(day, walker)
        return self._plans[key]

    def _daytype(self, day: date) -> str:
        wd = self.core.checker._workday(datetime.combine(day, datetime.min.time()))  # noqa: SLF001
        return "workday" if wd else "weekend"

    def _rooms(self) -> list[str]:
        """Rooms that take part: their light plan is on and "Urlaub" is on there."""
        lp = self.core.lightplan
        return [rid for rid in self.core.rooms if lp.store.get(rid, {}).get("on") and lp.plan(rid)["vacation"]["on"]]

    def _generate(self, day: date, walker: int) -> list[dict[str, Any]]:
        rng = random.Random(f"{day.isoformat()}#{walker}")
        model = self.data["model"]
        dt = self._daytype(day)
        typ = (model.get("types") or {}).get(dt) or (model.get("types") or {}).get("all") or {}
        if int(typ.get("days") or 0) < MIN_DAYS:
            typ = {}  # too little learned yet: a usual day
        # rooms someone can be in: with a sensor, learned occupancy or lights
        occ_known = {r for r, v in (((model.get("types") or {}).get("all") or {}).get("occ") or {}).items() if sum(v) > 0}
        rooms = [r for r, room in self.core.rooms.items() if room["presence"] or room["motion"] or room["zones"] or room["door_logic"] or r in occ_known]
        if not rooms:
            return []
        bedroom = model.get("bedroom") or self._guess(rooms, ("schlaf", "bed"))
        bath = model.get("night_room") or self._guess(rooms, ("bad", "wc", "toilet", "bath"))
        entrance = (model.get("entrance") or [None])[0] or self._guess(rooms, ("flur", "diele", "eingang", "gang", "hall"))
        who = ["jemand", "jemand Zweites", "jemand Drittes"][min(walker, 2)]
        out: list[dict[str, Any]] = []

        def add(rid: str | None, a: float, b: float, kind: str) -> None:
            if rid and b > a:
                out.append({"room": rid, "from": round(a, 2), "to": round(b, 2), "kind": kind, "who": who})

        def walk(src: str | None, dst: str | None, t: float) -> float:
            """Pass through the rooms between; returns the time of arrival."""
            for mid in self.path(src, dst)[1:-1]:
                d = rng.uniform(0.25, 0.7)
                add(mid, t, t + d, "pass")
                t += d
            return t

        def pick(values: list[float], default: float, spread: float) -> float:
            base = rng.choice(values) if values else default
            return base + rng.gauss(0, spread)

        # only plausible learned times (up between 4:30 and 12:00, to bed between 20:00 and 3:00)
        wakes = [x for x in typ.get("wake") or [] if 30 <= x <= 8 * 60]
        beds = [x for x in typ.get("bed") or [] if 16 * 60 <= x <= 23 * 60]
        wake = pick(wakes, (6.75 if dt == "workday" else 8.5) * 60 - DAY_START, 10)
        bed = pick(beds, 23 * 60 - DAY_START, 12)
        if walker:
            wake += rng.uniform(-25, 25)
            bed += rng.uniform(-30, 30)
        wake = max(30.0, min(wake, 13 * 60.0))
        bed = max(wake + 6 * 60, min(bed, 1440 - 30.0))
        occ: dict[str, list[float]] = typ.get("occ") or {}
        home: list[float] = typ.get("home") or [1.0] * SLOTS
        stays: dict[str, list[float]] = typ.get("stays") or {}

        cur: str | None = bedroom
        t = wake
        if self.config["morning"] and bedroom:
            add(bedroom, wake - rng.uniform(2, 6), wake, "wake")
        while t < bed - 5:
            slot = int(t // SLOT) % SLOTS
            if home[slot] < 0.35:
                # usually nobody home now: leave (through the entrance) until people usually come back
                end = t
                while end < bed and home[int(end // SLOT) % SLOTS] < 0.5:
                    end += SLOT
                end += rng.uniform(-10, 10)
                if end - t >= 30:
                    t = walk(cur, entrance, t)
                    if entrance:
                        add(entrance, t, t + rng.uniform(0.5, 1.5), "pass")
                    cur, t = entrance, max(end, t + 1.5)
                    if entrance:
                        add(entrance, t, t + rng.uniform(0.5, 1.5), "pass")
                    continue
            weights = []
            # a new room each time (staying longer is a longer stay); the bedroom only shortly before bed
            cand = [r for r in rooms if (r != bedroom or bed - t < 60) and r != cur] or [r for r in rooms if r != bedroom] or rooms
            for r in cand:
                p = (occ.get(r) or [0.0] * SLOTS)[slot] + 0.01 if occ else default_weight(self.core.rooms[r]["name"], t)
                weights.append(p)
            if sum(weights) <= 0:
                weights = [1.0] * len(cand)
            nxt = rng.choices(cand, weights=weights)[0] if cand else cur
            length = pick(stays.get(nxt or "", []), 25, 0) * math.exp(rng.gauss(0, 0.35))
            length = max(3.0, min(length, 120.0, bed - t))
            t = walk(cur, nxt, t)
            add(nxt, t, t + length, "stay")
            cur, t = nxt, t + length
        # to bed: the bedroom a while (reading), then dark
        t = walk(cur, bedroom, max(t, bed))
        if bedroom:
            add(bedroom, t, t + rng.uniform(5, 20), "bed")
        # at night now and then
        if self.config["night"] and bath and bedroom and rng.random() < float(typ.get("night_p", 0.25)):
            at = rng.uniform(t + 60, max(t + 61, 1440 - 20))
            if at < 1440 - 10:
                b0 = walk(bedroom, bath, at)
                stay = rng.uniform(2, 6)
                add(bath, b0, b0 + stay, "night")
                walk(bath, bedroom, b0 + stay)
        out.sort(key=lambda s: s["from"])
        return out

    @staticmethod
    def _guess(rooms: list[str], words: tuple[str, ...]) -> str | None:
        return next((r for r in rooms if any(w in r.lower() for w in words)), None)

    # ------------------------------------------------------------------ neighbours
    def neighbours(self) -> dict[str, dict[str, str]]:
        """room → {neighbour: source} (karte / gelernt / Flur)."""
        out: dict[str, dict[str, str]] = defaultdict(dict)
        for a, b in self._floor["pairs"]:
            out[a][b] = out[b][a] = "Karte"
        for pair, n in (self.data["model"].get("trans") or {}).items():
            a, b = pair.split(">")
            back = (self.data["model"].get("trans") or {}).get(f"{b}>{a}", 0)
            if n + back >= 3 and a in self.core.rooms and b in self.core.rooms:
                out[a].setdefault(b, "gelernt")
                out[b].setdefault(a, "gelernt")
        # a room nobody connected: through the hallway (or the room most often used)
        rooms = list(self.core.rooms)
        hub = self._guess(rooms, ("flur", "diele", "gang", "hall")) or (rooms[0] if rooms else None)
        for r in rooms:
            if r != hub and hub and not out.get(r):
                out[r][hub] = out[hub][r] = "angenommen"
        return dict(out)

    def path(self, src: str | None, dst: str | None) -> list[str]:
        if not src or not dst:
            return [x for x in (src, dst) if x]
        if src == dst:
            return [src]
        nb = self.neighbours()
        prev: dict[str, str | None] = {src: None}
        q = deque([src])
        while q:
            x = q.popleft()
            if x == dst:
                break
            for y in nb.get(x, {}):
                if y not in prev:
                    prev[y] = x
                    q.append(y)
        if dst not in prev:
            return [src, dst]
        way = [dst]
        while prev[way[-1]] is not None:
            way.append(prev[way[-1]])  # type: ignore[arg-type]
        return list(reversed(way))

    async def read_floorplan(self) -> None:
        """Doors of the floor plan card → which rooms are connected, which room has the front door."""
        configs: list[Any] = []
        try:
            from homeassistant.components.lovelace.const import LOVELACE_DATA  # noqa: PLC0415

            ld = self.hass.data.get(LOVELACE_DATA)
            boards = list(getattr(ld, "dashboards", {}).values()) if ld else []
        except ImportError:
            ld = self.hass.data.get("lovelace")
            boards = list((ld or {}).get("dashboards", {}).values()) if isinstance(ld, dict) else []
        for b in boards:
            try:
                configs.append(await b.async_load(False))
            except Exception:  # noqa: BLE001 — YAML dashboards, empty ones …
                continue
        cards: list[dict[str, Any]] = []

        def walk(o: Any) -> None:
            if isinstance(o, dict):
                if o.get("type") == "custom:floorplan-card":
                    cards.append(o)
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)

        for c in configs:
            walk(c)
        # a card showing a shared floor plan (`plan: <id>`) keeps its rooms in the floor plan card's companion
        fp = self.hass.data.get("floorplan_card")
        shared = getattr(fp, "plans", None)
        for i, card in enumerate(cards):
            rec = shared.get(card["plan"]) if shared and isinstance(card.get("plan"), str) and not card.get("floors") else None
            if rec:
                cards[i] = {**card, **rec.get("plan", {})}
        pairs: set[tuple[str, str]] = set()
        entrance: list[str] = []
        areas: dict[str, float] = {}
        names = {r["name"].casefold(): rid for rid, r in self.core.rooms.items()}
        for card in cards:
            for fl in card.get("floors") or [card]:
                rooms = []
                for r in fl.get("rooms") or []:
                    rid = r.get("area") if r.get("area") in self.core.rooms else names.get(str(r.get("name") or "").casefold())
                    pts = r.get("points") or []
                    if rid and len(pts) >= 3 and not r.get("outdoor"):
                        rooms.append((rid, pts))
                        # plan units are cm: shoelace area in m² (for the smart heating's energy estimate)
                        shoelace = sum(float(pts[i][0]) * float(pts[(i + 1) % len(pts)][1]) - float(pts[(i + 1) % len(pts)][0]) * float(pts[i][1]) for i in range(len(pts)))
                        areas[rid] = round(areas.get(rid, 0.0) + abs(shoelace) / 2 / 10000, 1)
                for o in fl.get("openings") or []:
                    if o.get("type") != "door" or not o.get("a") or not o.get("b"):
                        continue
                    a, b = (float(o["a"][0]), float(o["a"][1])), (float(o["b"][0]), float(o["b"][1]))
                    samples = [(a[0] + (b[0] - a[0]) * i / 10, a[1] + (b[1] - a[1]) * i / 10) for i in range(11)]
                    # on each side of the wall the room along which most of the door lies (a door drawn a bit too
                    # long reaches over the corner of the next room)
                    best: dict[int, tuple[float, str]] = {}
                    for rid, pts in rooms:
                        share = sum(_dist_polygon(p, pts) <= 20 for p in samples) / len(samples)
                        if share < 0.3:
                            continue
                        cx, cy = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
                        side = 1 if (b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]) > 0 else -1
                        if share > best.get(side, (0.0, ""))[0]:
                            best[side] = (share, rid)
                    found = sorted(v[1] for v in best.values())
                    if len(found) == 2 and found[0] != found[1]:
                        pairs.add((found[0], found[1]))
                    elif len(found) == 1 and found[0] not in entrance:
                        entrance.append(found[0])
        self._floor = {"pairs": sorted(pairs), "entrance": entrance, "found": bool(cards), "areas": areas}
        if entrance:
            self.data["model"]["entrance"] = entrance

    # ------------------------------------------------------------------ learning
    async def learn(self) -> None:
        if self.learning:
            return
        self.learning = True
        try:
            await self.read_floorplan()
            await self._backfill()
            self._aggregate()
            self._plans.clear()
            self.core.save()
        except Exception as err:  # noqa: BLE001 — learning must never break anything
            _LOGGER.warning("Urlaub lernen: %s", err)
        finally:
            self.learning = False

    def _occupancy_entities(self) -> dict[str, tuple[str, float]]:
        """entity → (room, minutes it keeps counting after it goes off). The room's own sensors (recorded much
        longer than this integration's "… belegt" sensors); rooms with door logic only: their "belegt" sensor."""
        reg = er.async_get(self.hass)
        out: dict[str, tuple[str, float]] = {}
        for rid, room in self.core.rooms.items():
            after = float(room.get("empty_after") or 0)
            for e in room.get("presence") or []:
                out[e] = (rid, 0.0)
            for e in room.get("zones") or []:
                out.setdefault(e, (rid, 0.0))
            for e in room.get("motion") or []:
                out[e] = (rid, max(after, 1.0))  # motion only sees movement: like the room, it counts a while longer
            if not (room.get("presence") or room.get("zones") or room.get("motion")):
                eid = reg.async_get_entity_id("binary_sensor", DOMAIN, f"room_{rid}_occupied")
                if eid:
                    out[eid] = (rid, 0.0)
        return out

    async def _backfill(self) -> None:
        """Summaries of the last days that are not stored yet (as far as the recorder goes back)."""
        try:
            from homeassistant.components.recorder import get_instance, history  # noqa: PLC0415
        except ImportError:
            return
        if self.data.get("version") != LEARN_VERSION:
            # learned the old way: learn those days again
            self.data["days"] = {}
            self.data["version"] = LEARN_VERSION
        days = self.data["days"]
        today, _m = sim_minute(dt_util.now())
        occ_ents = self._occupancy_entities()
        lights = sorted({e for rid in self.core.rooms for e in self.core.lightplan.room_lights(rid)})
        light_room = {e: rid for rid in self.core.rooms for e in self.core.lightplan.room_lights(rid)}
        lux_room = {room["lux"]: rid for rid, room in self.core.rooms.items() if room.get("lux")}
        rec = get_instance(self.hass)
        for back in range(1, 15):
            d = today - timedelta(days=back)
            if d.isoformat() in days:
                continue
            start = dt_util.as_utc(datetime.combine(d, datetime.min.time(), tzinfo=dt_util.get_default_time_zone()) + timedelta(minutes=DAY_START))
            end = start + timedelta(days=1)
            try:
                occ = await rec.async_add_executor_job(history.get_significant_states, self.hass, start, end, list(occ_ents), None, True, True, False, True)
                lst = await rec.async_add_executor_job(history.get_significant_states, self.hass, start, end, lights, None, True, False, False, False) if lights else {}
                lux = await rec.async_add_executor_job(history.get_significant_states, self.hass, start, end, list(lux_room), None, True, False, False, True) if lux_room else {}
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("Urlaub lernen %s: %s", d, err)
                continue
            if not any(len(v) > 1 for v in occ.values()):
                continue  # recorder has nothing for this day (or it does not go back that far)
            summary = self._summarise(start, occ, occ_ents, lst, light_room)
            if summary:
                summary["lux_on"] = self._lux_on(lst, light_room, lux, lux_room)
            if summary:
                days[d.isoformat()] = summary
        for k in sorted(days)[:-KEEP_DAYS]:
            days.pop(k, None)

    @staticmethod
    def _intervals(seq: list[Any], start: datetime, end: datetime, on: Any) -> list[tuple[float, float, Any]]:
        """(from, to, state) in minutes since `start` for the times `on(state)` held."""
        out = []
        cur: tuple[float, Any] | None = None
        s0 = start.timestamp()
        for st in seq:
            t = max(0.0, (st.last_changed.timestamp() - s0) / 60)
            if on(st):
                if cur is None:
                    cur = (t, st)
                else:
                    out.append((cur[0], t, cur[1]))
                    cur = (t, st)
            elif cur is not None:
                out.append((cur[0], t, cur[1]))
                cur = None
        if cur is not None:
            out.append((cur[0], (end.timestamp() - s0) / 60, cur[1]))
        return [x for x in out if x[1] > x[0]]

    @staticmethod
    def _lux_on(lst: dict[str, list[Any]], light_room: dict[str, str], lux: dict[str, list[Any]], lux_room: dict[str, str]) -> dict[str, list[float]]:
        """The room's light level right before you switched a light on (= when it is dark enough for you)."""
        by_room: dict[str, list[tuple[float, float]]] = defaultdict(list)
        for eid, seq in lux.items():
            rid = lux_room.get(eid)
            for st in seq:
                try:
                    by_room[rid].append((st.last_changed.timestamp(), float(st.state)))  # type: ignore[index]
                except (TypeError, ValueError):
                    continue
        out: dict[str, list[float]] = defaultdict(list)
        for eid, seq in lst.items():
            rid = light_room.get(eid)
            values = by_room.get(rid or "")
            if not values:
                continue
            prev = None
            for st in seq:
                if st.state == "on" and prev not in (None, "on"):
                    t = st.last_changed.timestamp() - 5
                    before = [v for ts, v in values if ts <= t]
                    if before:
                        out[rid].append(round(before[-1], 1))  # type: ignore[index]
                prev = st.state
        return {r: v[:30] for r, v in out.items()}

    def _summarise(self, start: datetime, occ: dict[str, list[Any]], occ_ents: dict[str, tuple[str, float]], lst: dict[str, list[Any]], light_room: dict[str, str]) -> dict[str, Any] | None:
        end = start + timedelta(days=1)
        per_room: dict[str, list[tuple[float, float]]] = defaultdict(list)
        for eid, seq in occ.items():
            rid, after = occ_ents.get(eid, (None, 0.0))
            if not rid:
                continue
            per_room[rid] += [(a, min(1440.0, b + after)) for a, b, _s in self._intervals(seq, start, end, lambda st: st.state == "on")]
        segs: dict[str, list[list[float]]] = {}
        total = 0.0
        for rid, iv in per_room.items():
            # all sensors of the room together; gaps under a minute closed (a sensor flickering)
            merged: list[list[float]] = []
            for a, b in sorted(iv):
                if merged and a - merged[-1][1] < 1:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            segs[rid] = [[round(a, 1), round(b, 1)] for a, b in merged][:120]
            total += sum(b - a for a, b in merged)
        if total < 60:
            return None  # nobody home that day (or no sensors): nothing to learn
        lights: dict[str, dict[str, dict[str, list[float]]]] = {}
        for eid, seq in lst.items():
            rid = light_room.get(eid)
            if not rid:
                continue
            # merge the light's "on" intervals, split by brightness changes
            for a, b, st in self._intervals(seq, start, end, lambda st: st.state == "on"):
                pct = round((st.attributes.get("brightness") or 255) / 2.55)
                t = a
                while t < b:
                    bk = bucket_of(t)
                    edge = next(e - DAY_START for n, s, e in BUCKETS if n == bk)
                    piece = min(b, edge if edge > t else b) - t
                    if piece <= 0:
                        break
                    rec = lights.setdefault(rid, {}).setdefault(bk, {}).setdefault(eid, [0.0, 0.0])
                    rec[0] += piece
                    rec[1] += piece * pct
                    t += piece
        return {"segs": segs, "lights": {r: {bk: {e: [round(v[0], 1), round(v[1])] for e, v in x.items()} for bk, x in b.items()} for r, b in lights.items()}}

    def _aggregate(self) -> None:
        days = self.data["days"]
        model = self.data["model"]
        rooms = list(self.core.rooms)
        if not days:
            model.update({"days": 0})
            return
        # bedroom: where someone is between midnight and 4 (slots 80–95 of the day from 4:00)
        night_occ: Counter[str] = Counter()
        for d in days.values():
            for rid, segs in d["segs"].items():
                night_occ[rid] += sum(max(0.0, min(b, 1440) - max(a, 1200)) for a, b in segs)
        # at least an hour a night on average, else by name
        top = night_occ.most_common(1)[0] if night_occ else None
        bedroom = top[0] if top and top[1] >= 60 * len(days) else self._guess(rooms, ("schlaf", "bed"))
        model["bedroom"] = bedroom
        trans: Counter[str] = Counter()
        night_rooms: Counter[str] = Counter()
        by_type: dict[str, list[tuple[str, dict[str, Any]]]] = {"workday": [], "weekend": []}
        for k, d in days.items():
            by_type[self._daytype(date.fromisoformat(k))].append((k, d))
        types: dict[str, Any] = {}
        for name, lst in [*by_type.items(), ("all", list(days.items()))]:
            if name != "all" and len(lst) < 3:
                continue
            occ: dict[str, list[float]] = {r: [0.0] * SLOTS for r in rooms}
            home = [0.0] * SLOTS
            stays: dict[str, list[float]] = defaultdict(list)
            wakes, beds, nights = [], [], 0
            for _k, d in lst:
                anyone = [False] * SLOTS
                for rid, segs in d["segs"].items():
                    if rid not in occ:
                        continue
                    hit = [False] * SLOTS
                    for a, b in segs:
                        for s in range(int(a // SLOT), min(SLOTS, int(math.ceil(b / SLOT)))):
                            if min(b, (s + 1) * SLOT) - max(a, s * SLOT) >= 4:
                                hit[s] = True
                        if b - a >= 2:
                            stays[rid].append(round(b - a, 1))
                    for s in range(SLOTS):
                        if hit[s]:
                            occ[rid][s] += 1
                            anyone[s] = True
                for s in range(SLOTS):
                    home[s] += anyone[s]
                # up and to bed: the first / last real stay outside the bedroom
                outside = sorted((a, b, rid) for rid, segs in d["segs"].items() if rid != bedroom for a, b in segs)
                long = [x for x in outside if x[1] - x[0] >= 5]
                if long:
                    wakes.append(long[0][0])
                    beds.append(long[-1][1])
                    after = [x for x in outside if x[0] > long[-1][1] + 30 and x[1] - x[0] < 15]
                    if after:
                        nights += 1
                        # where to, not what you pass on the way (a minute or more)
                        night_rooms.update(x[2] for x in after if x[1] - x[0] >= 1)
                if name == "all":
                    seq = sorted((a, b, rid) for rid, segs in d["segs"].items() for a, b in segs)
                    for i, (a, _b, rid) in enumerate(seq):
                        prev = [x for x in seq[:i] if x[2] != rid and a - 2 <= x[1] <= a + 1]
                        if prev:
                            trans[f"{prev[-1][2]}>{rid}"] += 1
            n = len(lst)
            types[name] = {
                "days": n,
                "occ": {r: [round(v / n, 2) for v in vals] for r, vals in occ.items()},
                "home": [round(v / n, 2) for v in home],
                "stays": {r: sorted(v)[-200:] for r, v in stays.items()},
                "wake": [round(x, 1) for x in wakes],
                "bed": [round(x, 1) for x in beds],
                "night_p": round(nights / n, 2),
            }
        # lights: per room and time of day the lights you use and how bright
        light_use: dict[str, dict[str, dict[str, list[float]]]] = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [0.0, 0.0])))
        for d in days.values():
            for rid, bks in (d.get("lights") or {}).items():
                for bk, ents in bks.items():
                    for e, (mins, bsum) in ents.items():
                        light_use[rid][bk][e][0] += mins
                        light_use[rid][bk][e][1] += bsum
        lux_on_all: dict[str, list[float]] = defaultdict(list)
        for d in days.values():
            for rid, v in (d.get("lux_on") or {}).items():
                lux_on_all[rid] += v
        # where you usually switch on: a bit above the median (so it is not darker than you are used to)
        lux_on = {}
        for rid, v in lux_on_all.items():
            v = sorted(v)
            if len(v) < 3:
                continue
            # the darker half: switching on in bright light (a motion light in daytime) says nothing about "dark"
            low = v[: max(3, len(v) // 2)]
            lux_on[rid] = round(low[min(len(low) - 1, int(len(low) * 0.75))] * 1.2 + 3)
        # how much of the time someone was in the room the light was on, per time of day
        occ_bk: dict[str, Counter[str]] = defaultdict(Counter)
        for d in days.values():
            for rid, segs in d["segs"].items():
                for a, b in segs:
                    for name, s0, e0 in BUCKETS:
                        lo, hi = s0 - DAY_START, e0 - DAY_START
                        occ_bk[rid][name] += max(0.0, min(b, hi) - max(a, lo))
        lights: dict[str, dict[str, Any]] = {}
        for rid, bks in light_use.items():
            for bk, ents in bks.items():
                top = max(v[0] for v in ents.values())
                if top < 10:
                    continue
                use = [e for e, v in ents.items() if v[0] >= 0.4 * top]
                mins = sum(ents[e][0] for e in use)
                occ_min = occ_bk[rid][bk]
                share = round(min(1.0, top / occ_min), 2) if occ_min >= 30 else None
                lights.setdefault(rid, {})[bk] = {"lights": use, "brightness": round(sum(ents[e][1] for e in use) / mins) if mins else None, "share": share}
        model.update(
            {
                "days": len(days),
                "first": min(days),
                "last": max(days),
                "types": types,
                "trans": dict(trans),
                "night_room": night_rooms.most_common(1)[0][0] if night_rooms else None,
                "lights": lights,
                "lux_on": lux_on,
            }
        )

    # ------------------------------------------------------------------ for the panel
    def view(self, day: date | None = None) -> dict[str, Any]:
        model = self.data["model"]
        today = day or sim_minute(dt_util.now())[0]
        typ = model.get("types") or {}

        def median(v: list[float]) -> str | None:
            return clock(sorted(v)[len(v) // 2]) if v else None

        timeline = []
        for w in range(self.people()):
            for s in self.plan_for(today, w):
                timeline.append({**s, "start": clock(s["from"]), "end": clock(s["to"]), "walker": w})
        nb = self.neighbours()
        return {
            "config": self.config,
            "enabled": self.enabled(),
            "learning": self.learning,
            "days": model.get("days", 0),
            "first": model.get("first"),
            "last": model.get("last"),
            "bedroom": model.get("bedroom"),
            "night_room": model.get("night_room"),
            "entrance": (model.get("entrance") or [None])[0],
            "floorplan": self._floor["found"],
            "neighbours": {r: [{"room": k, "source": v} for k, v in sorted(x.items())] for r, x in nb.items()},
            "times": {k: {"wake": median(v.get("wake") or []), "bed": median(v.get("bed") or []), "night_p": v.get("night_p"), "days": v.get("days")} for k, v in typ.items()},
            "rooms": self._rooms(),
            "lux": {rid: {"limit": self.lux_limit(rid)[0], "source": self.lux_limit(rid)[1], "now": self.core.room_tracker.lux(rid)} for rid, room in self.core.rooms.items() if room.get("lux")},
            "now": {rid: {"dark": ok, "why": why} for rid in self._rooms() for ok, why in [self.dark(rid)]},
            "habits": {rid: sorted(bk for bk, x in v.items() if (x.get("share") is None or x["share"] >= 0.25)) for rid, v in (model.get("lights") or {}).items()},
            "sun": (self.hass.states.get("sun.sun").attributes.get("elevation") if self.hass.states.get("sun.sun") else None),
            "people": self.people(),
            "day": today.isoformat(),
            "timeline": timeline,
        }
