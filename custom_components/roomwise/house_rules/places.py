"""Wo ist wer: where every person is, learned places, trips and where somebody is probably going.

Fed by the person entities (their location comes from the person's device trackers; speed from the tracker
that delivered the fix). Per person a small live state (Track):
  - in a Home Assistant zone (name + since),
  - staying at a spot outside the zones (a learned place, or a street from the phone's geocoded sensor),
  - or moving (since when, speed, heading, getting closer to home or not).

Learning (Learner, pure Python, also runs over the recorder history in an executor):
  - stays of at least 10 minutes outside the zones are clustered into places; a place counts as "gelernter Ort"
    after 3 visits. The user can name it, delete it or turn it into a Home Assistant zone (admin).
  - every way from one place to another is kept as a short trip summary (origin, destination, start, duration,
    initial heading) for 60 days – never the track itself.
  - while somebody moves: the likely destination from the trips that started at the same place on a similar day,
    hour and heading, and an arrival time from their duration, adjusted by the distance left and the speed now.
    `predict(person_id)` returns {destination, name, eta_min, probability} (also used by the heating).
  - how somebody travels (`mode`: walk / bike / car / transit, or None when unsure), in this order: the phone's
    activity sensor from the companion app (Android `*_detected_activity`, iOS `*_activity`), a vehicle tracker that
    moves along with the person, then the speed (walking < 7 km/h, bike up to 25, faster = car; very fast on a
    straight line = train). Every answer carries a confidence; nothing of it is stored.

Names of places: instead of "Gelernter Ort" a place is called what it is – "<Name> <Ortsteil>" for a point of
interest (a sports hall, a supermarket …), else "<Straße Nr>, <Ort>", else the town. The name comes from the
companion app's `sensor.*_geocoded_location` on the person's phone (iOS: Name / Areas Of Interest / Thoroughfare …,
Android: feature_name / thoroughfare / locality …), see `geo_name`. A learned place takes it over on a visit
(`auto`; a better kind of name replaces a weaker one), a name given by the user always wins.

Everything stays local. Reverse geocoding by OpenStreetMap Nominatim is off by default; when switched on (admin) it
is used only for phones without the geocoded sensor, asks at most once per second, only when somebody stops at an
unknown spot, rounds the position to about 10 m, caches the answers and sends an own User-Agent.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
import uuid
from collections import deque
from collections.abc import Callable
from datetime import datetime, timedelta, tzinfo
from typing import TYPE_CHECKING, Any

from homeassistant.const import STATE_HOME, STATE_NOT_HOME, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later, async_track_state_change_event, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import VERSION

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

STORAGE_KEY_PLACES = "house_rules.places"
MIN_STAY = 600  # s at one spot (or in a zone) before it counts as a stay
PASS_THROUGH = 120  # s in a zone that still count as driving through it
STAY_RADIUS = 120  # m a stay may wobble
MAX_ACCURACY = 250  # m: worse fixes are ignored for learning
LEARNED_VISITS = 3  # visits before a spot is shown as a learned place
KEEP_DAYS = 60  # trip summaries
MAX_TRIPS = 1500  # per person
MAX_PLACES = 150
MAX_REPLAY = 60000  # fixes per person from the recorder
WARM_DAYS = 30  # how far the first learning reaches back
THROTTLE_M = 20  # a new fix is processed when it moved this far …
THROTTLE_S = 20  # … or this much time passed
DRIVE = 8.3  # m/s assumed between a stay and the next fix far away (30 km/h)
DETOUR = 1.35  # roads are longer than the straight line
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
LEARN_VERSION = 1

# how somebody travels
WALK_MAX = 7 / 3.6  # m/s: slower is walking
BIKE_MAX = 25 / 3.6  # m/s: up to this a bike, faster a car (or train)
TRAIN_MIN = 160 / 3.6  # m/s: this fast on a straight line is hardly a car
STRAIGHT = 0.97  # straight line / way travelled over the recent fixes
MODE_SPEED = {"walk": 1.4, "bike": 4.5, "car": DRIVE, "transit": DRIVE}  # m/s for the arrival time when no speed is known
MODE_LIMIT = {"walk": 4.5, "bike": 12.5}  # m/s an activity plausibly reaches; faster, the activity is stale
# the speed profile of a trip (segments between fixes): the average alone says "bike" for a car in town (stops,
# lights) or a train with stations – the top speed tells motor from muscle
MOTOR_PEAK = 40 / 3.6  # m/s: reached at least twice → a motor (car, bus, train)
BIKE_PEAK = 30 / 3.6  # m/s: a bike rarely goes faster
WALK_PEAK = 9 / 3.6  # m/s: walking never goes faster
SEG_MIN_S, SEG_MIN_M = 15, 60  # a segment counts with at least this much time and way (GPS jitter)
RAIL_STRAIGHT = 0.93  # a fast motor trip this straight over the recent fixes: rather a train
VEHICLE_NEAR = 300  # m between a vehicle tracker and the person to travel together
VEHICLE_FRESH = 300  # s: the vehicle tracker must have moved (updated) this recently
# companion app activity states: Android detected_activity, iOS activity
ACTIVITY = {
    "in_vehicle": "car",
    "automotive": "car",
    "on_bicycle": "bike",
    "cycling": "bike",
    "on_foot": "walk",
    "walking": "walk",
    "running": "walk",
}
BIKE_NAME = re.compile(r"bike|velo|cycle|pedelec|scooter|rad\b", re.IGNORECASE)  # "Fahrrad", "Lastenrad", "E-Bike" …

# status lines; every sentence is one string so it can be translated
TEXTS = {
    "zone": "{place} · seit {time}",
    "place": "{place} · seit {time}",
    "street": "{street} · seit {time}",
    "stay": "Unbekannter Ort · seit {time}",
    "moving": "Unterwegs",
    "moving_since": "Unterwegs seit {time}",
    "moving_home": "Unterwegs · wahrscheinlich nach Hause · ca. {eta} Min.",
    "moving_home_noeta": "Unterwegs · wahrscheinlich nach Hause",
    "moving_dest": "Unterwegs · wahrscheinlich Richtung {place} · ca. {eta} Min.",
    "moving_dest_noeta": "Unterwegs · wahrscheinlich Richtung {place}",
    "unknown": "Ort unbekannt",
    "yesterday": "gestern {time}",
    "learned": "Gelernter Ort",
}


# ---------------------------------------------------------------------------------------------- geometry
def dist(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    """Metres between two points (haversine)."""
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def bearing(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    """Initial heading from a to b in degrees (0 = north)."""
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dl = math.radians(b_lon - a_lon)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def angle(a: float, b: float) -> float:
    """Smallest difference of two headings in degrees."""
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


# ---------------------------------------------------------------------------------------------- transport mode
def activity_mode(state: str | None) -> str | None:
    """walk / bike / car from a companion app activity state ("still", "Stationary", unknown: None)."""
    if not state:
        return None
    return ACTIVITY.get(state.split(",")[0].strip().lower().replace(" ", "_"))


def straightness(fixes: list[tuple[float, float, float]]) -> float | None:
    """Straight line from the first to the last fix divided by the way along all of them (≥ 4 fixes, ≥ 2 km)."""
    if len(fixes) < 4:
        return None
    way = sum(dist(a[1], a[2], b[1], b[2]) for a, b in zip(fixes, fixes[1:], strict=False))
    if way < 2000:
        return None
    return dist(fixes[0][1], fixes[0][2], fixes[-1][1], fixes[-1][2]) / way


def speeds(fixes: list[tuple[float, float, float]]) -> list[float]:
    """m/s of each segment between the fixes that is long enough to trust (time and way)."""
    out = []
    for a, b in zip(fixes, fixes[1:], strict=False):
        dt, d = b[0] - a[0], dist(a[1], a[2], b[1], b[2])
        if dt >= SEG_MIN_S and d >= SEG_MIN_M:
            out.append(d / dt)
    return out


def detect_mode(v: float | None, activity: str | None = None, vehicle: str | None = None, fixes: list[tuple[float, float, float]] | None = None) -> dict[str, Any]:
    """How somebody travels: {mode: walk/bike/car/transit/None, confidence 0…1, basis: activity/vehicle/speed/None}.

    activity: the phone's activity state (only when it belongs to this trip); vehicle: "car"/"bike" when a vehicle
    tracker moves along with the person; v: speed in m/s; fixes: the recent (t, lat, lon) of the trip."""
    s = straightness(fixes or [])
    train = v is not None and v >= TRAIN_MIN and s is not None and s >= STRAIGHT
    act = activity_mode(activity)
    if act and (v is None or v <= MODE_LIMIT.get(act, math.inf)):
        if act == "car" and train and vehicle is None:
            return {"mode": "transit", "confidence": 0.6, "basis": "activity"}
        return {"mode": act, "confidence": 0.9, "basis": "activity"}
    if vehicle:
        return {"mode": vehicle, "confidence": 0.8, "basis": "vehicle"}
    if train:
        return {"mode": "transit", "confidence": 0.5, "basis": "speed"}
    seg = sorted(speeds(fixes or []), reverse=True)
    if len(seg) >= 2:
        # the second fastest segment: one GPS jump does not make a car
        peak = seg[1]
        if peak >= MOTOR_PEAK:
            if s is not None and s >= RAIL_STRAIGHT and peak >= 60 / 3.6:
                return {"mode": "transit", "confidence": 0.35, "basis": "speed"}
            return {"mode": "car", "confidence": 0.5, "basis": "speed"}
        if peak <= WALK_PEAK and (v is None or v < WALK_MAX):
            return {"mode": "walk", "confidence": 0.55, "basis": "speed"}
        if len(seg) >= 3 and peak <= BIKE_PEAK and seg[-1] >= WALK_MAX and (v is None or WALK_MAX <= v < BIKE_MAX):
            # steadily between walking and a car, never faster than a bike
            return {"mode": "bike", "confidence": 0.35, "basis": "speed"}
        return {"mode": None, "confidence": 0.0, "basis": None}
    # too few fixes for a profile: only what the speed says clearly
    if v is None:
        return {"mode": None, "confidence": 0.0, "basis": None}
    if v < WALK_MAX:
        return {"mode": "walk", "confidence": 0.4, "basis": "speed"}
    if v >= MOTOR_PEAK:
        return {"mode": "car", "confidence": 0.4, "basis": "speed"}
    return {"mode": None, "confidence": 0.0, "basis": None}


# ---------------------------------------------------------------------------------------------- live state
class Track:
    """Movement of one person (pure: fed with fixes and ticks, knows nothing of Home Assistant)."""

    def __init__(self, pid: str) -> None:
        self.pid = pid
        self.fixes: deque[tuple[float, float, float]] = deque(maxlen=40)  # (t, lat, lon), good accuracy only
        self.last: tuple[float, float, float] | None = None  # newest fix of any accuracy
        self.last_t = 0.0
        self.zone: str | None = None  # zone key while in a Home Assistant zone
        self.zone_since: float | None = None
        self.stay: dict[str, float] | None = None  # resting candidate outside the zones: lat, lon, n, since, last
        self.node: str | None = None  # confirmed place (zone key or learned id) the person stays at
        self.node_since: float | None = None
        self.origin: str | None = None  # where the current trip started
        self.origin_pos: tuple[float, float] | None = None
        self.left_at: float | None = None  # start of the current trip
        self.bearing: float | None = None  # initial heading of the current trip
        self.trend: str | None = None  # closer | away (to home), with hysteresis
        self.speed: float | None = None  # m/s reported by the tracker
        self.speed_t = 0.0
        self.timeline: list[dict[str, Any]] = []  # today and yesterday: stays and trips


class Learner:
    """Places, trips and predictions. Pure Python on a plain dict, so it can replay history in an executor.

    data = {"places": [...], "trips": {pid: [...]}}; zones = {key: (lat, lon, radius, name)}.
    """

    def __init__(self, data: dict[str, Any], zones: dict[str, tuple[float, float, float, str]], tz: tzinfo, learn: bool = True) -> None:
        self.data = data
        self.data.setdefault("places", [])
        self.data.setdefault("trips", {})
        self.zones = zones
        self.tz = tz
        self.learn = learn
        self.changed = False

    # ------------------------------------------------------------------ lookups
    def place(self, key: str | None) -> dict[str, Any] | None:
        if not key or not key.startswith("lp_"):
            return None
        return next((p for p in self.data["places"] if p["id"] == key), None)

    def pos(self, key: str | None) -> tuple[float, float] | None:
        if key in self.zones:
            z = self.zones[key]
            return z[0], z[1]
        p = self.place(key)
        return (p["lat"], p["lon"]) if p else None

    def home(self) -> tuple[float, float] | None:
        return self.pos("home")

    def _local(self, t: float) -> datetime:
        return datetime.fromtimestamp(t, self.tz)

    def match(self, lat: float, lon: float, *, learned_only: bool = False) -> str | None:
        """The zone or place a spot belongs to (zones first)."""
        for key, (zlat, zlon, r, _n) in self.zones.items():
            if dist(lat, lon, zlat, zlon) <= max(r, 50):
                return key
        best: tuple[float, str] | None = None
        for p in self.data["places"]:
            if learned_only and p["visits"] < LEARNED_VISITS and not p.get("name"):
                continue
            d = dist(lat, lon, p["lat"], p["lon"])
            if d <= max(p["r"], 80) + 40 and (best is None or d < best[0]):
                best = (d, p["id"])
        return best[1] if best else None

    def _cluster(self, lat: float, lon: float, t: float) -> str:
        """The learned place of a stay at an unknown spot (a new candidate if nothing is near)."""
        best: tuple[float, dict[str, Any]] | None = None
        for p in self.data["places"]:
            d = dist(lat, lon, p["lat"], p["lon"])
            if d <= max(p["r"], 80) + 60 and (best is None or d < best[0]):
                best = (d, p)
        if best:
            d, p = best
            w = min(p["visits"], 20)
            p["lat"] = round((p["lat"] * w + lat) / (w + 1), 6)
            p["lon"] = round((p["lon"] * w + lon) / (w + 1), 6)
            p["r"] = round(max(60.0, min(250.0, p["r"] * 0.85 + (d + 30) * 0.15)), 1)
            return p["id"]
        p = {"id": "lp_" + uuid.uuid4().hex[:6], "lat": round(lat, 6), "lon": round(lon, 6), "r": 80.0, "visits": 0, "minutes": 0.0, "hours": [0] * 24, "days": [0] * 7, "first": t, "last": t, "name": ""}
        self.data["places"].append(p)
        self._prune_places(t)
        return p["id"]

    def _prune_places(self, now: float) -> None:
        places = self.data["places"]
        keep = [p for p in places if p.get("name") or p["visits"] >= LEARNED_VISITS or now - p.get("last", now) < 30 * 86400]
        if len(keep) > MAX_PLACES:
            keep.sort(key=lambda p: (bool(p.get("name")), p["visits"], p.get("last", 0)), reverse=True)
            keep = keep[:MAX_PLACES]
        self.data["places"] = keep

    # ------------------------------------------------------------------ feeding
    def feed(self, tr: Track, t: float, lat: float | None, lon: float | None, acc: float | None, zone_key: str | None, speed: float | None = None) -> None:
        """One update of the person: the zone Home Assistant says it is in, and its position (if any)."""
        if t < tr.last_t:
            return
        tr.last_t = t
        if speed is not None:
            tr.speed, tr.speed_t = speed, t
        if zone_key != tr.zone:
            if tr.zone is not None:
                # leaving a zone: a stay long enough counts even if no tick confirmed it
                if tr.node != tr.zone and tr.zone_since is not None and t - tr.zone_since >= MIN_STAY:
                    self._arrive(tr, tr.zone, tr.zone_since)
                if tr.node == tr.zone:
                    self._depart(tr, t)
                elif tr.node is None and (tr.left_at is None or (tr.zone_since is not None and t - tr.zone_since >= PASS_THROUGH)):
                    # a short stay (or tracking began here): the way starts at this zone, without recording a trip;
                    # only driving through a zone in less than two minutes keeps the trip that was under way
                    if tr.timeline and tr.timeline[-1]["k"] == "trip" and tr.timeline[-1]["b"] is None:
                        tr.timeline[-1]["b"], tr.timeline[-1]["d"] = tr.zone_since, tr.zone
                    tr.origin, tr.origin_pos, tr.left_at, tr.bearing = tr.zone, self.pos(tr.zone), t, None
                tr.zone, tr.zone_since = None, None
            if zone_key is not None:
                if tr.stay is not None:
                    self._end_stay(tr, t, None)
                tr.stay = None
                tr.zone, tr.zone_since = zone_key, t
                tr.trend = None
        if lat is None or lon is None:
            self.tick(tr, t)
            return
        tr.last = (t, lat, lon)
        good = acc is None or acc <= MAX_ACCURACY
        if good:
            tr.fixes.append((t, lat, lon))
        if zone_key is None and good:
            st = tr.stay
            if st is not None and dist(st["lat"], st["lon"], lat, lon) <= STAY_RADIUS + min(acc or 0, 100):
                n = min(st["n"], 20)
                st["lat"] = (st["lat"] * n + lat) / (n + 1)
                st["lon"] = (st["lon"] * n + lon) / (n + 1)
                st["n"] += 1
                st["last"] = t
            else:
                if st is not None:
                    self._end_stay(tr, t, (lat, lon))
                tr.stay = {"lat": lat, "lon": lon, "n": 1, "since": t, "last": t}
        if tr.left_at is not None and tr.bearing is None and tr.origin_pos and good and dist(tr.origin_pos[0], tr.origin_pos[1], lat, lon) >= 500:
            tr.bearing = round(bearing(tr.origin_pos[0], tr.origin_pos[1], lat, lon))
        self._trend(tr)
        self.tick(tr, t)

    def tick(self, tr: Track, now: float) -> None:
        """Time passed: confirm stays (in a zone, or resting at one spot)."""
        if tr.zone is not None and tr.node != tr.zone and tr.zone_since is not None and now - tr.zone_since >= MIN_STAY:
            self._arrive(tr, tr.zone, tr.zone_since)
        st = tr.stay
        if st is not None and tr.zone is None and tr.node is None:
            rested = st["n"] >= 2 and st["last"] - st["since"] >= 120
            if (now - st["since"] >= MIN_STAY and rested) or now - st["since"] >= 2 * MIN_STAY:
                self._arrive(tr, self._key_for_stay(st), st["since"])

    def _key_for_stay(self, st: dict[str, float]) -> str:
        z = self.match(st["lat"], st["lon"])
        if z and not z.startswith("lp_"):
            return z
        return self._cluster(st["lat"], st["lon"], st["since"]) if self.learn else (z or "?")

    def _end_stay(self, tr: Track, t: float, new_pos: tuple[float, float] | None) -> None:
        """The resting candidate ended (moved away or entered a zone)."""
        st = tr.stay
        if st is None:
            return
        end = st["last"]
        if new_pos is not None:
            # the phone may have been silent while resting: estimate when the person left
            travel = dist(st["lat"], st["lon"], new_pos[0], new_pos[1]) / DRIVE
            end = max(st["last"], min(t, t - travel))
        else:
            end = max(st["last"], t)
        if tr.node is None and end - st["since"] >= MIN_STAY:
            self._arrive(tr, self._key_for_stay(st), st["since"])
        if tr.node is not None and tr.zone is None:
            self._depart(tr, end)
        elif tr.node is None and tr.left_at is None and new_pos is not None:
            # moving without a known start (e.g. right after Home Assistant started): under way from here
            tr.origin, tr.origin_pos, tr.left_at, tr.bearing = None, (st["lat"], st["lon"]), end, None

    def _arrive(self, tr: Track, key: str, at: float) -> None:
        if tr.node == key:
            return
        if tr.node is not None:
            self._depart(tr, at)
        if tr.left_at is not None and self.learn and key != "?":
            dur = (at - tr.left_at) / 60
            if 2 <= dur <= 720:
                o, d = self.pos(tr.origin), self.pos(key)
                lt = self._local(tr.left_at)
                trip = {
                    "o": tr.origin,
                    "d": key,
                    "t": round(tr.left_at),
                    "dur": round(dur, 1),
                    "b": tr.bearing,
                    "km": round(dist(o[0], o[1], d[0], d[1]) / 1000, 2) if o and d else None,
                    "wd": lt.weekday(),
                    "h": round(lt.hour + lt.minute / 60, 2),
                }
                trips = self.data["trips"].setdefault(tr.pid, [])
                trips.append(trip)
                cutoff = at - KEEP_DAYS * 86400
                if len(trips) > MAX_TRIPS or (trips and trips[0]["t"] < cutoff):
                    self.data["trips"][tr.pid] = [x for x in trips if x["t"] >= cutoff][-MAX_TRIPS:]
                self.changed = True
        p = self.place(key)
        if p is not None and self.learn:
            lt = self._local(at)
            p["visits"] += 1
            p["hours"][lt.hour] += 1
            p["days"][lt.weekday()] += 1
            p["last"] = at
            self.changed = True
        if tr.timeline and tr.timeline[-1]["k"] == "trip" and tr.timeline[-1]["b"] is None:
            tr.timeline[-1]["b"] = at
            tr.timeline[-1]["d"] = key
        self._timeline(tr, {"k": "stay", "p": key, "a": at, "b": None})
        tr.node, tr.node_since = key, at
        tr.left_at, tr.bearing, tr.trend = None, None, None

    def _depart(self, tr: Track, at: float) -> None:
        key = tr.node
        if key is None:
            return
        p = self.place(key)
        if p is not None and self.learn and tr.node_since is not None:
            p["minutes"] = round(p.get("minutes", 0) + max(0.0, at - tr.node_since) / 60, 1)
            self.changed = True
        if tr.timeline and tr.timeline[-1]["k"] == "stay" and tr.timeline[-1]["b"] is None:
            tr.timeline[-1]["b"] = at
        self._timeline(tr, {"k": "trip", "o": key, "d": None, "a": at, "b": None})
        tr.origin, tr.origin_pos = key, self.pos(key)
        tr.left_at = at
        tr.bearing = None
        tr.node, tr.node_since = None, None

    def _timeline(self, tr: Track, entry: dict[str, Any]) -> None:
        tr.timeline.append(entry)
        cutoff = entry["a"] - 2 * 86400
        if len(tr.timeline) > 120 or tr.timeline[0]["a"] < cutoff:
            tr.timeline = [e for e in tr.timeline if (e["b"] or entry["a"]) >= cutoff][-120:]

    def _trend(self, tr: Track) -> None:
        """Getting closer to home or moving away (needs 300 m within 15 minutes; keeps the last verdict otherwise)."""
        home = self.home()
        if home is None or tr.zone == "home" or not tr.fixes:
            tr.trend = None
            return
        now = tr.fixes[-1][0]
        ds = [dist(home[0], home[1], f[1], f[2]) for f in tr.fixes if now - f[0] <= 900][-6:]
        if len(ds) < 2:
            return
        # net change over the last few fixes (a turn earlier in the window does not count)
        dnow = ds[-1]
        closer = ds[0] - dnow >= 300
        away = dnow - ds[0] >= 300
        if closer and not away:
            tr.trend = "closer"
        elif away and not closer:
            tr.trend = "away"

    # ------------------------------------------------------------------ reading
    def speed(self, tr: Track, now: float) -> float | None:
        """m/s: the tracker's own value if fresh, else from the fixes of the last 10 minutes."""
        if tr.speed is not None and now - tr.speed_t <= 180 and tr.speed >= 0:
            return tr.speed
        recent = [f for f in tr.fixes if now - f[0] <= 600]
        if len(recent) >= 2 and recent[-1][0] - recent[0][0] >= 60:
            return dist(recent[0][1], recent[0][2], recent[-1][1], recent[-1][2]) / (recent[-1][0] - recent[0][0])
        return None

    def heading(self, tr: Track) -> float | None:
        """Heading now: from a fix at least 300 m back to the newest one."""
        if len(tr.fixes) < 2:
            return None
        _t, lat, lon = tr.fixes[-1]
        for f in reversed(list(tr.fixes)[:-1]):
            if dist(f[1], f[2], lat, lon) >= 300:
                return bearing(f[1], f[2], lat, lon)
        return None

    def status(self, tr: Track, now: float) -> dict[str, Any]:
        """kind: zone | place | stay | moving | unknown; key = zone/place; since."""
        if tr.zone is not None:
            return {"kind": "zone", "key": tr.zone, "since": tr.zone_since}
        if tr.node is not None:
            return {"kind": "place", "key": None if tr.node == "?" else tr.node, "since": tr.node_since}
        st = tr.stay
        v = self.speed(tr, now)
        if st is not None and (v is None or v < 2) and now - st["since"] >= 300 and (st["n"] >= 2 or now - st["since"] >= MIN_STAY):
            return {"kind": "stay", "key": self.match(st["lat"], st["lon"], learned_only=True), "since": st["since"]}
        if tr.last is not None:
            return {"kind": "moving", "key": None, "since": tr.left_at}
        return {"kind": "unknown", "key": None, "since": None}

    def predict(self, tr: Track, now: float, mode: str | None = None) -> dict[str, Any] | None:
        """The likely destination while moving: {destination, probability, eta_min, arrive_at, as_of, basis} or None.
        mode: how the person travels (detect_mode), for the arrival time when the speed is not known.
        The arrival is estimated at the last position (as_of) and counts down from there: the person goes on between
        two positions, so eta_min is what is left now; arrive_at (seconds) lets screens count down by themselves."""
        if tr.zone is not None or tr.node is not None or tr.last is None:
            return None
        _t, lat, lon = tr.fixes[-1] if tr.fixes else tr.last
        start = tr.left_at or now
        lt = self._local(start)
        hour = lt.hour + lt.minute / 60
        weekend = lt.weekday() >= 5
        head = self.heading(tr)
        # estimated where the last position was reported, then counted down to now
        fix_t = min(float(_t), now)
        elapsed = max(0.0, fix_t - start)
        o_pos = tr.origin_pos
        scores: dict[str, float] = {}
        durs: dict[str, list[tuple[float, float, float | None]]] = {}
        total = 0.0
        for trip in self.data["trips"].get(tr.pid, []):
            d_pos = self.pos(trip["d"])
            if d_pos is None:
                continue
            w = 1.0
            if tr.origin:
                w *= 3.0 if trip["o"] == tr.origin else 0.3
            if trip["wd"] == lt.weekday():
                w *= 1.5
            elif (trip["wd"] >= 5) == weekend:
                w *= 1.2
            else:
                w *= 0.5
            dh = abs(trip["h"] - hour) % 24
            dh = min(dh, 24 - dh)
            w *= math.exp(-(dh**2) / (2 * 1.5**2)) + 0.05
            if tr.bearing is not None and trip.get("b") is not None:
                w *= max(0.05, (1 + math.cos(math.radians(angle(tr.bearing, trip["b"])))) / 2) ** 2
            left = dist(lat, lon, d_pos[0], d_pos[1])
            if o_pos is not None and trip["o"] == tr.origin:
                gone = dist(o_pos[0], o_pos[1], lat, lon)
                if gone > 1000 and left > dist(o_pos[0], o_pos[1], d_pos[0], d_pos[1]) + 1000:
                    w *= 0.15  # moving away from that destination
            if head is not None and left > 500:
                w *= max(0.1, (1 + math.cos(math.radians(angle(head, bearing(lat, lon, d_pos[0], d_pos[1]))))) / 2)
            if elapsed > trip["dur"] * 120 + 900:
                w *= 0.3  # far longer under way than that trip took
            if w < 1e-4:
                continue
            scores[trip["d"]] = scores.get(trip["d"], 0.0) + w
            durs.setdefault(trip["d"], []).append((trip["dur"], w if trip["o"] == tr.origin else w * 0.3, trip.get("km")))
            total += w
        v = self.speed(tr, now)
        home = self.home()
        if total < 0.8:
            # hardly anything learned yet: only "getting closer to home" says something
            if home is None or tr.trend != "closer":
                return None
            p = 0.55
            if head is not None and angle(head, bearing(lat, lon, home[0], home[1])) < 45:
                p = 0.7
            return {"destination": "home", "probability": p, **self._arrival(self._eta(lat, lon, home, None, v, elapsed, mode), fix_t, now), "basis": "direction"}
        best = max(scores, key=lambda k: scores[k])
        prob = scores[best] / (total + 0.5)
        if best == "home" and tr.trend == "closer":
            prob = min(0.98, prob + 0.1)
        d_pos = self.pos(best)
        assert d_pos is not None
        return {"destination": best, "probability": round(prob, 2), **self._arrival(self._eta(lat, lon, d_pos, (durs[best], o_pos), v, elapsed, mode), fix_t, now), "basis": "learned"}

    @staticmethod
    def _arrival(eta_fix: int, fix_t: float, now: float) -> dict[str, Any]:
        """The arrival estimated at the last position, counted down to now (at least 1 minute while still on the way)."""
        at = fix_t + eta_fix * 60
        return {"eta_min": max(1, math.ceil((at - now) / 60)), "arrive_at": round(at), "as_of": round(fix_t)}

    def _eta(self, lat: float, lon: float, dest: tuple[float, float], hist: tuple[list[tuple[float, float, float | None]], tuple[float, float] | None] | None, v: float | None, elapsed: float, mode: str | None = None) -> int:
        left = dist(lat, lon, dest[0], dest[1])
        if left < 150:
            return 1
        est: list[float] = []
        if hist and hist[0]:
            items = sorted(hist[0], key=lambda x: x[0])
            half = sum(x[1] for x in items) / 2
            acc = 0.0
            median, km = items[-1][0], items[-1][2]
            for d, w, k in items:
                acc += w
                if acc >= half:
                    median, km = d, k
                    break
            o_pos = hist[1]
            # the whole way: from where this trip started, else as long as such trips usually are
            full = dist(o_pos[0], o_pos[1], dest[0], dest[1]) if o_pos else (km or 0) * 1000
            if full > 300:
                est.append(median * min(1.2, left / full))
            else:
                est.append(max(1.0, median - elapsed / 60))
        if v is not None and v >= 1.5:
            est.append(left * DETOUR / v / 60)
        if not est:
            est.append(left * DETOUR / MODE_SPEED.get(mode or "", DRIVE) / 60)
        return max(1, round(sum(est) / len(est)))

    def typical(self, p: dict[str, Any]) -> dict[str, Any]:
        """Usual days and arrival hour of a learned place."""
        days, hours = p.get("days") or [0] * 7, p.get("hours") or [0] * 24
        work, week = sum(days[:5]), sum(days[5:])
        kind = "workdays" if work >= 3 * max(week, 1) else ("weekend" if week >= 2 * max(work, 1) else "mixed")
        h = max(range(24), key=lambda i: hours[i]) if any(hours) else None
        return {"days": kind, "arrive": f"{h:02d}:00" if h is not None else None, "stay_min": round(p.get("minutes", 0) / max(1, p["visits"]))}


# ---------------------------------------------------------------------------------------------- Home Assistant side
class Places:
    """Core module `core.places`: live tracks of the persons, learning, view, predictions, street names."""

    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._store: Store[dict[str, Any]] = Store(hass, 1, STORAGE_KEY_PLACES)
        self.data: dict[str, Any] = {}
        self.tracks: dict[str, Track] = {}
        self.learner = Learner({}, {}, dt_util.get_default_time_zone())
        self._pid_of: dict[str, str] = {}  # person entity → person id
        self._geo: dict[str, str | None] = {}  # person id → geocoded location sensor
        self._activity: dict[str, str | None] = {}  # person id → the phone's activity sensor
        self._clear_act: dict[str, tuple[float, str]] = {}  # person id → (time, state) of the last clear activity
        self._last: dict[str, tuple[float, float | None, float | None, str]] = {}  # last processed (t, lat, lon, state)
        self._listeners: list[Callable[[str], None]] = []
        self._unsub: list[Callable[[], None]] = []
        self._warm_timer: CALLBACK_TYPE | None = None
        self._view: dict[str, dict[str, Any]] = {}
        self._cache: dict[str, tuple[tuple[float, int], dict[str, Any]]] = {}
        self._street: dict[str, tuple[float, str, int]] = {}  # person → (stay since, name, kind) from Nominatim
        self._nominatim_lock = asyncio.Lock()
        self._nominatim_last = 0.0
        self.stats = {"nominatim_requests": 0, "fixes": 0, "skipped": 0}
        self.warming = False

    # ------------------------------------------------------------------ settings / storage
    @property
    def settings(self) -> dict[str, Any]:
        s = self.data.setdefault("settings", {})
        s.setdefault("learn", True)
        s.setdefault("nominatim", False)
        return s

    async def async_load(self) -> None:
        self.data = await self._store.async_load() or {}
        self.data.setdefault("places", [])
        self.data.setdefault("trips", {})
        self.data.setdefault("geocache", {})
        self.data.setdefault("warm", {})
        self.data.setdefault("timeline", {})
        _ = self.settings

    def save(self) -> None:
        self._store.async_delay_save(self._to_store, 30)

    def _to_store(self) -> dict[str, Any]:
        self.data["timeline"] = {pid: tr.timeline[-60:] for pid, tr in self.tracks.items()}
        return self.data

    async def async_save(self) -> None:
        await self._store.async_save(self._to_store())

    # ------------------------------------------------------------------ lifecycle
    def _zones(self) -> dict[str, tuple[float, float, float, str]]:
        out: dict[str, tuple[float, float, float, str]] = {}
        for st in self.hass.states.async_all("zone"):
            a = st.attributes
            if a.get("latitude") is None or a.get("longitude") is None or a.get("passive"):
                continue
            name = "Zuhause" if st.object_id == "home" else str(a.get("friendly_name") or st.object_id)
            out[st.object_id] = (float(a["latitude"]), float(a["longitude"]), float(a.get("radius") or 100), name)
        if "home" not in out and self.hass.config.latitude is not None:
            out["home"] = (self.hass.config.latitude, self.hass.config.longitude, 100.0, "Zuhause")
        return out

    def start(self) -> None:
        self.stop()
        self.learner = Learner(self.data, self._zones(), dt_util.get_default_time_zone(), bool(self.settings["learn"]))
        persons = self.core.inventory.persons
        self._pid_of = {p["entity_id"]: pid for pid, p in persons.items()}
        self._geo = {pid: self._geocoded_sensor(p["entity_id"]) for pid, p in persons.items()}
        self._activity = {pid: self._activity_sensor(p["entity_id"]) for pid, p in persons.items()}
        stored = self.data.get("timeline", {})
        for pid, p in persons.items():
            if pid not in self.tracks:
                tr = Track(pid)
                tr.timeline = list(stored.get(pid, []))
                self.tracks[pid] = tr
                st = self.hass.states.get(p["entity_id"])
                if st is not None:
                    self._init_track(tr, st)
        for pid in list(self.tracks):
            if pid not in persons:
                self.tracks.pop(pid)
        if self._pid_of:
            self._unsub.append(async_track_state_change_event(self.hass, list(self._pid_of), self._person_changed))
        by_sensor = {e: pid for pid, e in self._activity.items() if e}
        if by_sensor:
            # a new activity (walking → in the car) changes the view of a person on the way
            self._unsub.append(async_track_state_change_event(self.hass, list(by_sensor), callback(lambda ev: self._activity_changed(by_sensor.get(ev.data["entity_id"]), ev.data["new_state"]))))
        self._unsub.append(async_track_time_interval(self.hass, self._tick, timedelta(seconds=60)))
        if self.settings["learn"] and any(pid not in self.data["warm"] for pid in persons):
            # learn from the recorder once, a while after the start (the recorder needs a moment)
            self._warm_timer = async_call_later(self.hass, 120, callback(lambda _now: self.hass.async_create_background_task(self.warm_start(), "house_rules_places_warm")))
        self._refresh_all(push=False)

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()
        if self._warm_timer:
            self._warm_timer()
            self._warm_timer = None

    def _init_track(self, tr: Track, st: State) -> None:
        """After a start: the person is where Home Assistant says, a stay that began before counts as confirmed."""
        key = self._zone_key(st.state)
        if key is False:
            return
        lat, lon = st.attributes.get("latitude"), st.attributes.get("longitude")
        since = st.last_changed.timestamp()
        if key:
            tr.zone, tr.zone_since = key, since
            if time.time() - since >= MIN_STAY:
                tr.node, tr.node_since = key, since
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            tr.last = (st.last_updated.timestamp(), float(lat), float(lon))
            tr.fixes.append(tr.last)
            if not key:
                tr.stay = {"lat": float(lat), "lon": float(lon), "n": 1, "since": st.last_updated.timestamp(), "last": st.last_updated.timestamp()}
        tr.last_t = st.last_updated.timestamp()

    def _zone_key(self, state: str) -> str | None | bool:
        """Zone key of a person state; None = outside the zones; False = not known."""
        if state == STATE_HOME:
            return "home"
        if state == STATE_NOT_HOME:
            return None
        if state in (STATE_UNKNOWN, STATE_UNAVAILABLE, ""):
            return False
        low = state.lower()
        for key, z in self.learner.zones.items():
            if z[3].lower() == low or key == low:
                return key
        return None  # a zone we do not track (passive): outside for us

    def _geocoded_sensor(self, person_entity: str) -> str | None:
        """The companion app's geocoded location sensor on the device of one of the person's trackers."""
        st = self.hass.states.get(person_entity)
        if st is None:
            return None
        reg = er.async_get(self.hass)
        for tracker in st.attributes.get("device_trackers") or []:
            entry = reg.async_get(tracker)
            if not entry or not entry.device_id:
                continue
            for e in er.async_entries_for_device(reg, entry.device_id):
                if e.domain == "sensor" and (e.entity_id.endswith("geocoded_location") or (e.unique_id or "").endswith("geocoded_location")):
                    return e.entity_id
        return None

    def _activity_sensor(self, person_entity: str) -> str | None:
        """The companion app's activity sensor (Android detected_activity, iOS activity) of the person's phone: on the
        device of one of the trackers, else by the usual name next to the tracker."""
        st = self.hass.states.get(person_entity)
        if st is None:
            return None
        reg = er.async_get(self.hass)
        trackers = st.attributes.get("device_trackers") or []
        for tracker in trackers:
            entry = reg.async_get(tracker)
            if not entry or not entry.device_id:
                continue
            for suffix in ("detected_activity", "activity"):
                for e in er.async_entries_for_device(reg, entry.device_id):
                    if e.domain == "sensor" and (e.entity_id.endswith(f"_{suffix}") or (e.unique_id or "").endswith(suffix)):
                        return e.entity_id
        for tracker in trackers:
            base = tracker.split(".", 1)[-1]
            for suffix in ("detected_activity", "activity"):
                if self.hass.states.get(f"sensor.{base}_{suffix}") is not None:
                    return f"sensor.{base}_{suffix}"
        return None

    def _activity_changed(self, pid: str | None, st: State | None) -> None:
        if pid is None:
            return
        if st is not None and st.state not in (STATE_UNKNOWN, STATE_UNAVAILABLE, "") and activity_mode(st.state):
            self._clear_act[pid] = (st.last_updated.timestamp(), st.state)
        self._after(pid)

    def _trip_activity(self, pid: str, tr: Track, now: float, remembered: bool = True) -> str | None:
        """The phone's activity, when it belongs to this trip (changed since shortly before leaving, or reported lately)."""
        sensor = self._activity.get(pid)
        st = self.hass.states.get(sensor) if sensor else None
        since = (tr.left_at - 600) if tr.left_at is not None else now - 900
        if st is not None and st.state not in (STATE_UNKNOWN, STATE_UNAVAILABLE, "") and activity_mode(st.state):
            t = st.last_updated.timestamp()
            if t >= since or now - t <= 900:
                self._clear_act[pid] = (t, st.state)
                return st.state
        # the phone says "Unknown" / "Stationary" in between (iOS often does at traffic lights): the last clear
        # activity of this trip still holds
        last = self._clear_act.get(pid)
        if remembered and last and last[0] >= since:
            return last[1]
        return None

    def _vehicle_along(self, tr: Track, now: float) -> str | None:
        """"car" or "bike" when a vehicle tracker (Hausregeln kind "vehicle") moves along with the person right now."""
        if tr.last is None or now - tr.last[0] > VEHICLE_FRESH:
            return None
        for d in self.core.inventory.devices.values():
            if d.get("kind") != "vehicle" or not str(d.get("entity_id", "")).startswith("device_tracker."):
                continue
            st = self.hass.states.get(d["entity_id"])
            if st is None:
                continue
            lat, lon = st.attributes.get("latitude"), st.attributes.get("longitude")
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or now - st.last_updated.timestamp() > VEHICLE_FRESH:
                continue
            acc = st.attributes.get("gps_accuracy")
            if dist(float(lat), float(lon), tr.last[1], tr.last[2]) <= VEHICLE_NEAR + min(float(acc) if isinstance(acc, (int, float)) else 0.0, 200):
                # an object alarm of kind bike / car (Objekte) knows best, else the name says it
                kind = next((o.get("kind") for o in self.core.data.get("object_alarms", []) if d["entity_id"] in (o.get("sensors") or [])), None)
                if kind in ("bike", "car"):
                    return str(kind)
                return "bike" if BIKE_NAME.search(f"{d.get('vehicle') or ''} {d.get('name') or ''} {d['entity_id']}") else "car"
        return None

    # ------------------------------------------------------------------ updates
    @callback
    def _person_changed(self, event: Event[EventStateChangedData]) -> None:
        st = event.data["new_state"]
        pid = self._pid_of.get(event.data["entity_id"])
        if st is None or pid is None:
            return
        if self._observe(pid, st):
            self._after(pid)

    def _observe(self, pid: str, st: State) -> bool:
        """Feed one person state into the track. False when it was skipped (throttled, unknown, already seen)."""
        tr = self.tracks.get(pid)
        if tr is None:
            return False
        key = self._zone_key(st.state)
        if key is False:
            return False
        t = st.last_updated.timestamp()
        if t <= tr.last_t:
            return False
        a = st.attributes
        lat, lon, acc = a.get("latitude"), a.get("longitude"), a.get("gps_accuracy")
        lat = float(lat) if isinstance(lat, (int, float)) else None
        lon = float(lon) if isinstance(lon, (int, float)) else None
        prev = self._last.get(pid)
        if prev and prev[3] == st.state and lat is not None and prev[1] is not None and prev[2] is not None:
            if dist(prev[1], prev[2], lat, lon or 0.0) < THROTTLE_M and t - prev[0] < THROTTLE_S:
                self.stats["skipped"] += 1
                return False  # GPS updates can be frequent: nothing new
        self._last[pid] = (t, lat, lon, st.state)
        speed = None
        src = self.hass.states.get(str(a.get("source") or ""))
        if src is not None and isinstance(src.attributes.get("speed"), (int, float)):
            speed = float(src.attributes["speed"])
        self.stats["fixes"] += 1
        self.learner.feed(tr, t, lat, lon, float(acc) if isinstance(acc, (int, float)) else None, key, speed)
        return True

    def sync(self, st: State | None) -> dict[str, Any] | None:
        """For the rule conditions: the status of the person of this state (fed first if it is newer)."""
        if st is None:
            return None
        pid = self._pid_of.get(st.entity_id)
        if pid is None:
            return None
        if self._observe(pid, st):
            # tell the listeners afterwards, not from inside a condition check
            self.hass.loop.call_soon(self._after, pid)
        return self.status(pid)

    @callback
    def _after(self, pid: str) -> None:
        self._cache.pop(pid, None)
        old = self._view.get(pid)
        self._view[pid] = self._person_view(pid)
        tr = self.tracks.get(pid)
        new = self._view[pid]
        if tr is not None and new["state"] in ("stay", "place") and not new["place"] and (old is None or old.get("state") != new["state"] or old.get("place")):
            self._stopped(pid, tr)
        if tr is not None and new["state"] in ("stay", "place"):
            self._name_place(pid)
            if self.learner.changed and new.get("place"):
                self._view[pid] = self._person_view(pid)  # the place got its name just now
        if self.learner.changed:
            self.learner.changed = False
            self.save()
        if old != self._view[pid]:
            self.core.push("places")
        for cb in list(self._listeners):
            try:
                cb(self.core.inventory.persons.get(pid, {}).get("entity_id", ""))
            except Exception:  # noqa: BLE001 — one broken listener must not stop the others
                _LOGGER.exception("Hausregeln: Orte-Listener")

    @callback
    def _tick(self, _now: Any = None) -> None:
        now = time.time()
        for pid, tr in self.tracks.items():
            self.learner.tick(tr, now)
            self._after(pid)

    def _refresh_all(self, push: bool = True) -> None:
        self._cache.clear()
        self._view = {pid: self._person_view(pid) for pid in self.tracks}
        if push:
            self.core.push("places")

    def add_listener(self, cb: Callable[[str], None]) -> Callable[[], None]:
        """cb(person entity id) after every processed update and once a minute (time-based conditions)."""
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb) if cb in self._listeners else None

    # ------------------------------------------------------------------ reading
    def pid(self, person: str) -> str | None:
        """Person id from an id, an entity id or "person:<id>"."""
        if person.startswith("person:"):
            person = person[7:]
        if person in self.tracks:
            return person
        return self._pid_of.get(person) or self._pid_of.get(f"person.{person}")

    def status(self, person: str) -> dict[str, Any] | None:
        """{kind, key, since, prediction, trend, distance_home_m, speed}; cached until the next update / minute."""
        pid = self.pid(person)
        tr = self.tracks.get(pid or "")
        if tr is None or pid is None:
            return None
        now = time.time()
        stamp = (tr.last_t, int(now // 60))
        hit = self._cache.get(pid)
        if hit and hit[0] == stamp:
            return hit[1]
        s = self.learner.status(tr, now)
        v = self.learner.speed(tr, now) if s["kind"] == "moving" else None
        if s["kind"] == "moving":
            recent = [f for f in tr.fixes if now - f[0] <= 900]
            vehicle = self._vehicle_along(tr, now)
            # a vehicle tracker moving along beats an activity the phone only reported earlier on this trip
            s["mode"] = detect_mode(v, self._trip_activity(pid, tr, now, remembered=vehicle is None), vehicle, recent)
        else:
            s["mode"] = {"mode": None, "confidence": 0.0, "basis": None}
        s["prediction"] = self.learner.predict(tr, now, s["mode"]["mode"]) if s["kind"] == "moving" else None
        s["trend"] = tr.trend
        home = self.learner.home()
        s["distance_home_m"] = round(dist(home[0], home[1], tr.last[1], tr.last[2])) if home and tr.last and s["kind"] != "zone" else (0 if s.get("key") == "home" else None)
        s["speed"] = v
        self._cache[pid] = (stamp, s)
        return s

    def predict(self, person_id: str) -> dict[str, Any]:
        """Where is this person probably going? {destination, name, eta_min, probability}; destination None when
        not moving or unknown. destination is a zone id ("home", …) or a learned place id ("lp_…")."""
        s = self.status(person_id)
        p = (s or {}).get("prediction")
        if not p:
            return {"destination": None, "name": None, "eta_min": None, "probability": 0.0}
        m = (s or {}).get("mode") or {}
        return {"destination": p["destination"], "name": self.label(p["destination"]), "eta_min": p["eta_min"], "probability": p["probability"], "basis": p.get("basis"), "mode": m.get("mode"), "mode_confidence": m.get("confidence", 0.0)}

    def at(self, person: str, key: str) -> bool:
        """Is the person at this zone or learned place right now?"""
        s = self.status(person)
        if not s:
            return False
        if s["kind"] in ("zone", "place", "stay") and s.get("key") == key:
            return True
        if s["kind"] in ("place", "stay") and key.startswith("lp_"):
            tr = self.tracks.get(self.pid(person) or "")
            p = self.learner.place(key)
            if tr and tr.last and p:
                return dist(p["lat"], p["lon"], tr.last[1], tr.last[2]) <= max(p["r"], 80) + 40
        return False

    def known(self, person: str) -> bool:
        s = self.status(person)
        return bool(s and s["kind"] != "unknown")

    def label(self, key: str | None) -> str:
        """Name of a zone or learned place."""
        if not key:
            return TEXTS["learned"]
        if key in self.learner.zones:
            return self.learner.zones[key][3]
        z = self.hass.states.get(f"zone.{key}")
        if z is not None:
            return "Zuhause" if key == "home" else str(z.attributes.get("friendly_name") or key)
        p = self.learner.place(key)
        if p is not None:
            return place_label(p)
        return key

    def visible(self, key: str | None) -> bool:
        """Zones and learned places (enough visits, or named) are shown by name; candidates are not."""
        if not key or key == "?":
            return False
        p = self.learner.place(key)
        if key.startswith("lp_"):
            return p is not None and (p["visits"] >= LEARNED_VISITS or bool(p.get("name")))
        return True

    def spot(self, pid: str) -> tuple[str, int] | None:
        """(name, kind) of the spot the person is at right now: the companion app's geocoded sensor (only when it
        was updated during this stay – an older one names the previous spot), else a Nominatim answer (if on)."""
        tr = self.tracks.get(pid)
        since = (tr.stay or {}).get("since") if tr else None
        if since is None and tr is not None:
            since = tr.node_since
        sensor = self._geo.get(pid)
        if sensor:
            st = self.hass.states.get(sensor)
            if st is not None and st.state not in (STATE_UNKNOWN, STATE_UNAVAILABLE, "") and (since is None or st.last_updated.timestamp() >= since - 300):
                found = geo_name(st.state, dict(st.attributes))
                if found:
                    return found
        hit = self._street.get(pid)
        if hit and tr and tr.stay and hit[0] == tr.stay["since"]:
            return hit[1], hit[2]
        return None

    def street(self, pid: str) -> str | None:
        """Name of the spot the person rests at (point of interest, else the address, else the town) – see spot()."""
        found = self.spot(pid)
        return found[0] if found else None

    def _name_place(self, pid: str) -> None:
        """The person stays at a learned place (or a candidate): give it the name of the spot, unless the user named
        it; a better kind of name (poi > address > town) replaces a weaker one."""
        tr = self.tracks.get(pid)
        if tr is None:
            return
        key = tr.node if tr.node and tr.node.startswith("lp_") else None
        if key is None and tr.stay is not None and tr.zone is None:
            key = self.learner.match(tr.stay["lat"], tr.stay["lon"], learned_only=False)
        p = self.learner.place(key) if key and key.startswith("lp_") else None
        if p is None or p.get("name"):
            return
        found = self.spot(pid)
        if not found:
            return
        name, kind = found
        if p.get("auto") == name or kind < int(p.get("auto_kind") or 0):
            return
        p["auto"], p["auto_kind"] = name, kind
        self.learner.changed = True

    def _time(self, t: float | None) -> str:
        if not t:
            return ""
        lt = dt_util.as_local(dt_util.utc_from_timestamp(t))
        today = dt_util.now().date()
        s = f"{lt.hour}:{lt.minute:02d}"
        if lt.date() == today:
            return s
        if lt.date() == today - timedelta(days=1):
            return TEXTS["yesterday"].format(time=s)
        return f"{lt.day}.{lt.month}., {s}"

    def _person_view(self, pid: str) -> dict[str, Any]:
        p = self.core.inventory.persons.get(pid, {})
        tr = self.tracks.get(pid)
        s = self.status(pid) or {"kind": "unknown", "key": None, "since": None}
        st = self.hass.states.get(p.get("entity_id", ""))
        kind = s["kind"]
        key = s.get("key") if self.visible(s.get("key")) else None
        street = self.street(pid) if kind in ("stay", "place") and not key else None
        pred = s.get("prediction")
        since = self._time(s.get("since"))
        if kind == "zone":
            line = TEXTS["zone"].format(place=self.label(s["key"]), time=since)
        elif kind in ("place", "stay") and key:
            line = TEXTS["place"].format(place=self.label(key), time=since)
        elif kind in ("place", "stay"):
            line = TEXTS["street"].format(street=street, time=since) if street else TEXTS["stay"].format(time=since)
        elif kind == "moving":
            if pred and pred["probability"] >= 0.5:
                dest = pred["destination"]
                eta = pred.get("eta_min")
                if dest == "home":
                    line = TEXTS["moving_home"].format(eta=eta) if eta else TEXTS["moving_home_noeta"]
                else:
                    line = TEXTS["moving_dest"].format(place=self.label(dest), eta=eta) if eta else TEXTS["moving_dest_noeta"].format(place=self.label(dest))
            else:
                line = TEXTS["moving_since"].format(time=since) if since else TEXTS["moving"]
        else:
            line = TEXTS["unknown"]
        last = tr.last if tr else None
        mode = s.get("mode") or {}
        left = None
        if pred and last:
            d_pos = self.learner.pos(pred["destination"])
            left = round(dist(last[1], last[2], d_pos[0], d_pos[1]) / 1000, 1) if d_pos else None
        return {
            "id": pid,
            "entity_id": p.get("entity_id"),
            "name": p.get("name", pid),
            "picture": st.attributes.get("entity_picture") if st else None,
            "state": kind,
            "place": key,
            "place_name": self.label(key) if key else None,
            "since": dt_util.utc_from_timestamp(s["since"]).isoformat() if s.get("since") else None,
            "line": line,
            "street": street,
            "lat": round(last[1], 5) if last else None,
            "lon": round(last[2], 5) if last else None,
            "speed_kmh": round(s["speed"] * 3.6) if s.get("speed") is not None else None,
            "trend": s.get("trend"),
            "distance_home_km": round(s["distance_home_m"] / 1000, 1) if s.get("distance_home_m") is not None else None,
            "prediction": {**pred, "name": self.label(pred["destination"]), "distance_km": left} if pred else None,
            "mode": mode.get("mode"),
            "mode_confidence": mode.get("confidence", 0.0),
            "mode_basis": mode.get("basis"),
            "updated": dt_util.utc_from_timestamp(last[0]).isoformat() if last else None,
        }

    def learned_view(self) -> list[dict[str, Any]]:
        out = []
        for p in self.data.get("places", []):
            if (p["visits"] < LEARNED_VISITS and not p.get("name")) or p.get("zone"):
                continue
            out.append(
                {
                    "id": p["id"],
                    "name": p.get("name") or "",
                    "label": place_label(p),
                    "auto": p.get("auto"),
                    "lat": p["lat"],
                    "lon": p["lon"],
                    "radius": round(p["r"]),
                    "visits": p["visits"],
                    "street": p.get("street"),
                    "typical": self.learner.typical(p),
                    "last": dt_util.utc_from_timestamp(p["last"]).isoformat() if p.get("last") else None,
                }
            )
        out.sort(key=lambda x: -x["visits"])
        return out

    def view(self) -> dict[str, Any]:
        """Snapshot part `places` (see docs/API.md)."""
        if not self._view or set(self._view) != set(self.tracks):
            self._view = {pid: self._person_view(pid) for pid in self.tracks}
        return {
            "persons": [self._view[pid] for pid in self.tracks if pid in self._view],
            "learned": self.learned_view(),
            "settings": dict(self.settings),
            "stats": {"trips": sum(len(v) for v in self.data.get("trips", {}).values()), "warming": self.warming, "learned_from": self.data.get("warm", {}), "nominatim_requests": self.stats["nominatim_requests"]},
        }

    def person_detail(self, person: str) -> dict[str, Any]:
        """Today's (and yesterday's) timeline of one person plus recent trips."""
        pid = self.pid(person)
        tr = self.tracks.get(pid or "")
        if tr is None or pid is None:
            raise ValueError("Person unbekannt")
        start = dt_util.start_of_local_day().timestamp()
        items = []
        for e in tr.timeline:
            end = e["b"]
            if end is not None and end < start:
                continue
            if e["k"] == "stay":
                items.append({"kind": "stay", "place": e["p"], "name": self.label(e["p"]) if e["p"] != "?" else TEXTS["learned"], "from": _iso(e["a"]), "to": _iso(end)})
            else:
                items.append({"kind": "trip", "from_place": e["o"], "to_place": e.get("d"), "from_name": self.label(e["o"]), "to_name": self.label(e["d"]) if e.get("d") else None, "from": _iso(e["a"]), "to": _iso(end)})
        trips = [
            {"from": self.label(t["o"]) if t["o"] else None, "to": self.label(t["d"]), "start": _iso(t["t"]), "minutes": t["dur"]}
            for t in self.data.get("trips", {}).get(pid, [])[-20:]
        ]
        return {"person": self._view.get(pid) or self._person_view(pid), "timeline": items, "trips": trips[::-1], "prediction": self.predict(pid)}

    # ------------------------------------------------------------------ admin
    def rename(self, place_id: str, name: str) -> dict[str, Any]:
        p = self.learner.place(place_id)
        if p is None:
            raise ValueError("Ort unbekannt")
        p["name"] = name.strip()[:60]
        self.save()
        self._refresh_all()
        self.core.push("rules")
        return p

    def delete(self, place_id: str) -> None:
        p = self.learner.place(place_id)
        if p is None:
            raise ValueError("Ort unbekannt")
        self.data["places"] = [x for x in self.data["places"] if x["id"] != place_id]
        for pid, trips in self.data.get("trips", {}).items():
            self.data["trips"][pid] = [t for t in trips if place_id not in (t["o"], t["d"])]
        self.save()
        self._refresh_all()

    async def to_zone(self, place_id: str, name: str | None, radius: float | None) -> str:
        """Turn a learned place into a Home Assistant zone (zone storage, like Einstellungen → Zonen)."""
        p = self.learner.place(place_id)
        if p is None:
            raise ValueError("Ort unbekannt")
        zname = (name or p.get("name") or "").strip()[:60]
        if not zname:
            raise ValueError("Die Zone braucht einen Namen.")
        try:
            from homeassistant.components.zone import DATA_ZONE_STORAGE_COLLECTION  # noqa: PLC0415

            coll = self.hass.data.get(DATA_ZONE_STORAGE_COLLECTION)
        except ImportError:
            coll = None
        if coll is None:
            raise ValueError("Zonen lassen sich gerade nicht anlegen.")
        item = await coll.async_create_item({"name": zname, "latitude": p["lat"], "longitude": p["lon"], "radius": float(radius or max(100, p["r"])), "icon": "mdi:map-marker", "passive": False})
        # the zone takes over new stays (zones are matched first); the place stays hidden for the trips learned so far
        zid = str(item.get("id") or "")
        p["zone"] = zid
        self.save()
        self._refresh_all()
        return zid

    def set_settings(self, raw: dict[str, Any]) -> dict[str, Any]:
        s = self.settings
        for k in ("learn", "nominatim"):
            if isinstance(raw.get(k), bool):
                s[k] = raw[k]
        self.learner.learn = bool(s["learn"])
        self.save()
        self._refresh_all()
        return dict(s)

    def forget(self) -> None:
        """Delete everything learned (places, trips, timelines, street cache)."""
        self.data["places"] = []
        self.data["trips"] = {}
        self.data["geocache"] = {}
        self.data["warm"] = {}
        for tr in self.tracks.values():
            tr.timeline = []
        self.learner = Learner(self.data, self.learner.zones, self.learner.tz, bool(self.settings["learn"]))
        self.save()
        self._refresh_all()

    # ------------------------------------------------------------------ learning from the recorder
    async def warm_start(self, *, relearn: bool = False, days: int = WARM_DAYS) -> dict[str, Any]:
        """Learn from the recorder's person history (executor, bounded). relearn: start over, keep names."""
        if self.warming:
            return {"ok": False, "error": "busy"}
        self.warming = True
        self.core.push("places")
        try:
            try:
                from homeassistant.components.recorder import get_instance, history  # noqa: PLC0415
            except ImportError:
                return {"ok": False, "error": "no_recorder"}
            persons = {pid: p["entity_id"] for pid, p in self.core.inventory.persons.items() if relearn or pid not in self.data["warm"]}
            if not persons:
                return {"ok": True, "persons": 0}
            rec = get_instance(self.hass)
            end = dt_util.utcnow()
            start = end - timedelta(days=min(days, KEEP_DAYS))
            fixes: dict[str, list[tuple[float, float | None, float | None, float | None, str]]] = {}
            for pid, eid in persons.items():
                rows: list[tuple[float, float | None, float | None, float | None, str]] = []
                t0 = start
                while t0 < end and len(rows) < MAX_REPLAY:
                    t1 = min(end, t0 + timedelta(days=5))
                    try:
                        got = await rec.async_add_executor_job(history.get_significant_states, self.hass, t0, t1, [eid], None, False, False, False, False)
                    except Exception as err:  # noqa: BLE001
                        _LOGGER.debug("Orte lernen %s: %s", eid, err)
                        break
                    for st in got.get(eid, []):
                        if not isinstance(st, State):
                            continue
                        a = st.attributes
                        lat, lon, acc = a.get("latitude"), a.get("longitude"), a.get("gps_accuracy")
                        rows.append((st.last_updated.timestamp(), lat if isinstance(lat, (int, float)) else None, lon if isinstance(lon, (int, float)) else None, acc if isinstance(acc, (int, float)) else None, st.state))
                    t0 = t1
                fixes[pid] = rows[:MAX_REPLAY]
            zones = self.learner.zones
            names = {key: z[3].lower() for key, z in zones.items()}
            old = self.data
            base = {"places": [] if relearn else [dict(p) for p in old.get("places", [])], "trips": {} if relearn else {k: list(v) for k, v in old.get("trips", {}).items()}}
            if relearn:
                for pid in persons:
                    base["trips"].pop(pid, None)
                base["trips"].update({k: v for k, v in old.get("trips", {}).items() if k not in persons})
            tz = dt_util.get_default_time_zone()
            result = await self.hass.async_add_executor_job(_replay, base, zones, names, tz, fixes)
            if relearn:
                # keep the names (and the names of the spot) of places that were learned again at the same spot
                for p in old.get("places", []):
                    if not p.get("name"):
                        if p.get("auto"):
                            near = min(result["places"], key=lambda q: dist(q["lat"], q["lon"], p["lat"], p["lon"]), default=None)
                            if near is not None and dist(near["lat"], near["lon"], p["lat"], p["lon"]) <= 150 and not near.get("auto"):
                                near["auto"], near["auto_kind"] = p["auto"], p.get("auto_kind", GEO_ADDRESS)
                        continue
                    near = min(result["places"], key=lambda q: dist(q["lat"], q["lon"], p["lat"], p["lon"]), default=None)
                    if near is not None and dist(near["lat"], near["lon"], p["lat"], p["lon"]) <= 150 and not near.get("name"):
                        near["name"] = p["name"]
                    elif near is None or dist(near["lat"], near["lon"], p["lat"], p["lon"]) > 150:
                        result["places"].append(p)
            self.data["places"] = result["places"]
            self.data["trips"] = result["trips"]
            for pid in persons:
                self.data["warm"][pid] = end.isoformat()
            self.learner = Learner(self.data, zones, tz, bool(self.settings["learn"]))
            self.save()
            n = sum(len(v) for v in fixes.values())
            _LOGGER.debug("Orte gelernt: %s Positionen, %s Orte, %s Wege", n, len(self.data["places"]), sum(len(v) for v in self.data["trips"].values()))
            return {"ok": True, "persons": len(persons), "fixes": n, "places": len(self.learned_view()), "trips": sum(len(v) for v in self.data["trips"].values())}
        finally:
            self.warming = False
            self._refresh_all()

    # ------------------------------------------------------------------ street names (Nominatim, off by default)
    def _stopped(self, pid: str, tr: Track) -> None:
        """Somebody stopped at an unknown spot: look the street up, if allowed and not known otherwise."""
        if not self.settings.get("nominatim") or self._geo.get(pid) or tr.stay is None:
            return
        st = tr.stay
        key = f"{st['lat']:.4f},{st['lon']:.4f}"  # about 10 m: the exact position never leaves the house
        cache = self.data.setdefault("geocache", {})
        if key in cache:
            n, k = _cached(cache[key])
            self._street[pid] = (st["since"], n, k)
            return
        self.hass.async_create_background_task(self._nominatim(pid, st["since"], st["lat"], st["lon"], key), "house_rules_places_street")

    async def _nominatim(self, pid: str, since: float, lat: float, lon: float, key: str) -> None:
        from aiohttp import ClientError, ClientTimeout  # noqa: PLC0415

        from homeassistant.helpers.aiohttp_client import async_get_clientsession  # noqa: PLC0415

        async with self._nominatim_lock:
            if not self.settings.get("nominatim"):
                return
            cache = self.data.setdefault("geocache", {})
            if key not in cache:
                wait = 1.1 - (time.monotonic() - self._nominatim_last)
                if wait > 0:
                    await asyncio.sleep(wait)  # usage policy: at most one request per second
                self._nominatim_last = time.monotonic()
                self.stats["nominatim_requests"] += 1
                params = {"format": "jsonv2", "lat": f"{lat:.4f}", "lon": f"{lon:.4f}", "zoom": "18", "addressdetails": "1", "accept-language": self.hass.config.language or "de"}
                headers = {"User-Agent": f"roomwise/{VERSION} (Home Assistant custom integration)"}
                try:
                    async with async_get_clientsession(self.hass).get(NOMINATIM_URL, params=params, headers=headers, timeout=ClientTimeout(total=10)) as r:
                        if r.status != 200:
                            return
                        body = await r.json()
                except (ClientError, TimeoutError, ValueError) as err:
                    _LOGGER.debug("Nominatim: %s", err)
                    return
                found = nominatim_name(body if isinstance(body, dict) else {})
                if not found:
                    return
                cache[key] = {"n": found[0], "k": found[1]}
                while len(cache) > 300:
                    cache.pop(next(iter(cache)))
                self.save()
            n, k = _cached(cache[key])
            self._street[pid] = (since, n, k)
        self._cache.pop(pid, None)
        self._after(pid)


def _cached(v: Any) -> tuple[str, int]:
    """A geocache entry: {"n": name, "k": kind}; older entries are a plain street."""
    if isinstance(v, dict):
        return str(v.get("n") or ""), int(v.get("k") or GEO_ADDRESS)
    return str(v), GEO_ADDRESS


def place_label(p: dict[str, Any]) -> str:
    """A learned place's name: the user's, else the name of the spot (geocoded / OpenStreetMap), else "Gelernter Ort"."""
    return p.get("name") or p.get("auto") or p.get("street") or TEXTS["learned"]


def _replay(base: dict[str, Any], zones: dict[str, tuple[float, float, float, str]], names: dict[str, str], tz: tzinfo, fixes: dict[str, list[tuple[float, float | None, float | None, float | None, str]]]) -> dict[str, Any]:
    """Executor job: run the recorded history of every person through a fresh track."""
    learner = Learner(base, zones, tz)
    for pid, rows in fixes.items():
        tr = Track(pid)
        for t, lat, lon, acc, state in rows:
            if state in (STATE_UNKNOWN, STATE_UNAVAILABLE, ""):
                continue
            if state == STATE_HOME:
                key: str | None = "home"
            elif state == STATE_NOT_HOME:
                key = None
            else:
                low = state.lower()
                key = next((k for k, n in names.items() if n == low or k == low), None)
            learner.feed(tr, t, lat, lon, acc, key)
        if rows:
            learner.tick(tr, rows[-1][0])
    learner._prune_places(time.time())  # noqa: SLF001
    return learner.data


# ---------------------------------------------------------------------------------------------- names of places
GEO_POI, GEO_ADDRESS, GEO_TOWN = 3, 2, 1  # how good a name is: a point of interest beats an address beats a town
_HOUSE_NO = re.compile(r"^\d+[a-zA-Z]?(?:\s*[-/]\s*\d+[a-zA-Z]?)?$")


def _attr(attrs: dict[str, Any], *keys: str) -> str:
    """First non-empty attribute of several spellings (iOS "Sub Locality", Android "sub_locality" …)."""
    low = {str(k).lower().replace(" ", "_"): v for k, v in attrs.items()}
    for k in keys:
        v = low.get(k)
        if isinstance(v, (list, tuple)):
            v = next((x for x in v if isinstance(x, str) and x.strip()), None)
        if isinstance(v, str) and v.strip() and v.strip().lower() not in ("none", "null", "unknown", "n/a"):
            return v.strip()
    return ""


def compose_name(poi: str, street: str, number: str, district: str, town: str) -> tuple[str, int] | None:
    """The name of a spot: "<poi> <district or town>" for a point of interest, else "<street no>, <town>", else the
    town. A poi that is only the address (house number, the street, the town) is no poi."""
    road = f"{street} {number}".strip() if street else ""
    where = district or town
    p = poi.strip()
    plain = {x.lower() for x in (street, number, road, f"{number} {street}".strip(), district, town) if x}
    if p and not _HOUSE_NO.match(p) and p.lower() not in plain and not (street and p.lower().startswith(street.lower())):
        if where and where.lower() not in p.lower():
            return f"{p} {where}"[:80], GEO_POI
        return p[:80], GEO_POI
    if road:
        return (f"{road}, {town or district}" if (town or district) else road)[:80], GEO_ADDRESS
    if where:
        return where[:80], GEO_TOWN
    return None


def geo_name(state: str | None, attrs: dict[str, Any]) -> tuple[str, int] | None:
    """Name of the spot from the companion app's geocoded location sensor (state = the full address)."""
    poi = _attr(attrs, "areas_of_interest", "name", "premises", "feature_name")
    found = compose_name(
        poi,
        _attr(attrs, "thoroughfare"),
        _attr(attrs, "sub_thoroughfare"),
        _attr(attrs, "sub_locality"),
        _attr(attrs, "locality", "sub_administrative_area"),
    )
    if found:
        return found
    if state and state.lower() not in ("unknown", "unavailable", "none", ""):
        return _short_address(state), GEO_ADDRESS
    return None


def nominatim_name(body: dict[str, Any]) -> tuple[str, int] | None:
    """Name of the spot from a Nominatim reverse answer (jsonv2 with addressdetails)."""
    addr = body.get("address") or {}
    road = addr.get("road") or addr.get("pedestrian") or addr.get("footway") or addr.get("path") or ""
    town = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("municipality") or ""
    district = addr.get("suburb") or addr.get("city_district") or addr.get("quarter") or addr.get("hamlet") or ""
    return compose_name(str(body.get("name") or ""), road, addr.get("house_number") or "", district if district != town else "", town)


def _iso(t: float | None) -> str | None:
    return dt_util.utc_from_timestamp(t).isoformat() if t else None


def _short_address(text: str) -> str:
    """First line of an address: 'Hauptstraße 12' from 'Hauptstraße 12, 12345 Stadt, Land' or a multi-line one."""
    first = text.replace("\r", "").split("\n")[0].split(",")[0].strip()
    if first.isdigit() and "," in text:
        parts = [x.strip() for x in text.split(",")]
        first = f"{parts[1]} {parts[0]}" if len(parts) > 1 else first
    return first[:80]
