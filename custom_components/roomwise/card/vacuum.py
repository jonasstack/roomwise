"""Robot vacuums, run by the server.

While a vacuum cleans or drives home, its position is read about every two seconds and pushed to every card.
Where it comes from depends on the robot's integration (`vacuum_adapters`): Roborock's position service, the map
camera of Dreame Vacuum / Xiaomi Cloud Map Extractor & co. (attributes with calibration points), or Valetudo's map
data — always in the robot's own coordinates (mm). Over time the server learns where the vacuum can drive: every
cell (10 cm) it has passed counts as free floor — furniture legs, boxes or anything else not drawn in the plan
stay "never visited", so the cards can keep the vacuum out of them when they have to guess between two positions.
It also learns the usual speed, the dock position and how often its integration reports a new position.
Everything is in the robot's own coordinates; the card lays them onto the plan with the transform the admin
set (or found automatically), so a new alignment never loses what was learned.
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import Callable
import logging
import math
import time
from typing import Any

from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_state_change_event

from . import vacuum_adapters

_LOGGER = logging.getLogger(__name__)

POLL = 2.0  # s between two position reads while the vacuum is moving (a service call to the robot)
POLL_MAP = 1.0  # s between two looks at a map entity (only reads what its integration already has)
CELL = 100  # mm: resolution of the learned free floor
MAX_CELLS = 40000
MOVING = ("cleaning", "returning")
# part of one run: a pause or the way home does not start a new one
IN_RUN = ("cleaning", "paused", "returning")
PATH_STEP = 30  # mm between two points of the current run's path
PATH_MAX = 6000
# numbers the positions for the cards (they ignore anything not newer than what they have): counts on from the
# time of start, across trackers, so a card open while its vacuums are set again or Home Assistant restarts still
# takes the new ones
SEQ = itertools.count(int(time.time() * 1000))


class VacuumTracker:
    """One card's vacuums"""

    def __init__(self, hass: HomeAssistant, card_id: str, vacuums: list[dict[str, Any]], learned: dict[str, Any], save: Callable[[], None], on_change: Callable[[str], None], paths: dict[str, Any] | None = None) -> None:
        self.hass = hass
        self.card_id = card_id
        self.vacuums = vacuums
        self._learned = learned  # entity → {"cells": {"x,y": n}, "dock": [x, y], "speed": mm/s, "runs": n}
        self._save = save
        self._on_change = on_change
        self.states: dict[str, dict[str, Any]] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._last: dict[str, tuple[float, float, float]] = {}
        self._unsub: CALLBACK_TYPE | None = None
        # where each vacuum has cleaned in the current run (robot mm), shown as a trail on the cards; stored with
        # the rest, so it survives a restart of Home Assistant in the middle of a run
        self._paths: dict[str, dict[str, Any]] = paths if paths is not None else {}

    async def async_start(self) -> None:
        ents = [v["entity"] for v in self.vacuums]
        if ents:
            self._unsub = async_track_state_change_event(self.hass, ents, self._changed)
        for v in self.vacuums:
            st = self.hass.states.get(v["entity"])
            self.states[v["id"]] = {"entity": v["entity"], "state": st.state if st else None, "x": None, "y": None, "t": None, "seq": 0, "run": int(self._paths.get(v["entity"], {}).get("run", 0))}
            if self._learned.get(v["entity"], {}).get("iv"):
                self.states[v["id"]]["iv"] = self._learned[v["entity"]]["iv"]
            await self._read(v)
            self._follow(v)

    def stop(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None
        for task in self._tasks.values():
            task.cancel()
        self._tasks.clear()

    @callback
    def _changed(self, event: Event[EventStateChangedData]) -> None:
        new = event.data["new_state"]
        if new is None:
            return
        for v in self.vacuums:
            if v["entity"] != new.entity_id:
                continue
            self.states[v["id"]]["state"] = new.state
            old = event.data["old_state"]
            path = self._paths.get(v["entity"])
            # coming back from "unavailable" (a restart, Wi-Fi gone) in the middle of a run is not a new run
            resumed = (old is None or old.state in ("unavailable", "unknown")) and path is not None and time.time() * 1000 - int(path.get("last", path.get("start", 0))) < 2 * 3600 * 1000
            if new.state == "cleaning" and (old is None or old.state not in IN_RUN) and not resumed:
                # a new run: its trail starts empty
                run = int(self._paths.get(v["entity"], {}).get("run", 0)) + 1
                self._paths[v["entity"]] = {"run": run, "pts": [], "start": int(time.time() * 1000)}
                self.states[v["id"]]["run"] = run
                self._save()
            if old is not None and old.state in MOVING and new.state not in MOVING:
                # a run ended (docked / paused / error): one more position, count the run
                learned = self._learned.setdefault(v["entity"], {})
                learned["runs"] = int(learned.get("runs", 0)) + 1
                self.hass.async_create_task(self._read(v))
                # a map entity may follow the vacuum's state a moment later (its last position, the dock)
                @callback
                def again(_now: Any, v: dict[str, Any] = v) -> None:
                    self.hass.async_create_task(self._read(v))

                for delay in (3, 10):
                    async_call_later(self.hass, delay, again)
            self._follow(v)
            self._on_change(self.card_id)

    def _follow(self, v: dict[str, Any]) -> None:
        moving = (self.states[v["id"]].get("state") in MOVING)
        task = self._tasks.get(v["id"])
        if moving and (task is None or task.done()):
            self._tasks[v["id"]] = self.hass.async_create_background_task(self._poll(v), f"floorplan_card vacuum {v['entity']}")
        elif not moving and task and not task.done():
            task.cancel()

    async def _poll(self, v: dict[str, Any]) -> None:
        while self.states[v["id"]].get("state") in MOVING:
            started = time.monotonic()
            await self._read(v)
            ad = await vacuum_adapters.get(self.hass, v["entity"], v.get("map"))
            pause = POLL if ad is None or ad.kind == "roborock" else POLL_MAP
            await asyncio.sleep(max(0.3, pause - (time.monotonic() - started)))

    async def adapter(self, v: dict[str, Any]) -> vacuum_adapters.Adapter | None:
        return await vacuum_adapters.get(self.hass, v["entity"], v.get("map"))

    async def _read(self, v: dict[str, Any]) -> None:
        ad = await self.adapter(v)
        if ad is None:
            return
        pos = await ad.position()
        if pos is None:
            return
        x, y = float(pos[0]), float(pos[1])
        now = time.time()
        st = self.states[v["id"]]
        st["adapter"] = ad.kind
        if ad.kind != "roborock" and st.get("x") == x and st.get("y") == y:
            # a map entity changes only when its integration has news: the same position is no new sample
            if st.get("state") == "docked":
                self._learned.setdefault(v["entity"], {})["dock"] = [x, y]
            return
        # how often the integration reports a new position while moving (the cards wait that long when they show
        # the vacuum a little behind)
        if st.get("state") in MOVING and st.get("t") and ad.kind != "roborock":
            gap = now * 1000 - st["t"]
            if 300 < gap < 20000:
                st["iv"] = round(gap if not st.get("iv") else st["iv"] * 0.8 + gap * 0.2)
                self._learned.setdefault(v["entity"], {})["iv"] = st["iv"]
        self._learn(v["entity"], x, y, now)
        if st.get("state") == "cleaning":
            self._trail(v, x, y)
        st.update({"x": x, "y": y, "t": int(now * 1000), "seq": next(SEQ)})
        if st.get("state") == "docked":
            self._learned.setdefault(v["entity"], {})["dock"] = [x, y]
        self._on_change(self.card_id)

    def _learn(self, entity: str, x: float, y: float, now: float) -> None:
        learned = self._learned.setdefault(entity, {})
        cells: dict[str, int] = learned.setdefault("cells", {})
        last = self._last.get(entity)
        self._last[entity] = (x, y, now)
        steps = [(x, y)]
        if last and now - last[2] < 8:
            dist = math.hypot(x - last[0], y - last[1])
            dt = now - last[2]
            # the path in between was driven too (straight enough over two seconds)
            n = int(dist // (CELL / 2))
            steps = [(last[0] + (x - last[0]) * k / (n + 1), last[1] + (y - last[1]) * k / (n + 1)) for k in range(1, n + 2)]
            if dt > 0.5 and dist > 20:
                speed = dist / dt
                old = float(learned.get("speed", speed))
                learned["speed"] = round(old * 0.95 + min(speed, 600) * 0.05, 1)
        for px, py in steps:
            key = f"{int(px // CELL)},{int(py // CELL)}"
            if key in cells or len(cells) < MAX_CELLS:
                cells[key] = min(9999, cells.get(key, 0) + 1)
        self._save()

    def _trail(self, v: dict[str, Any], x: float, y: float) -> None:
        path = self._paths.get(v["entity"])
        if path is None:
            # already cleaning when the server started: a run of its own from here
            path = self._paths[v["entity"]] = {"run": 1, "pts": [], "start": int(time.time() * 1000)}
            self.states[v["id"]]["run"] = 1
        pts: list[list[int]] = path["pts"]
        if pts and math.hypot(x - pts[-1][0], y - pts[-1][1]) < PATH_STEP:
            return
        pts.append([round(x), round(y)])
        path["last"] = int(time.time() * 1000)
        if len(pts) > PATH_MAX:
            # long runs: every other point of the older half
            half = len(pts) // 2
            path["pts"] = pts[:half:2] + pts[half:]

    def path(self, entity: str) -> dict[str, Any] | None:
        """The current (or last) run's trail: run number, start (ms), points (robot mm). When the vacuum's map
        has the run's path itself (Map Extractor, Valetudo) and it is longer than what was recorded here (the
        server started in the middle of a run), that one."""
        p = self._paths.get(entity)
        if not p:
            return None
        pts = p["pts"]
        v = next((v for v in self.vacuums if v["entity"] == entity), None)
        cache = self.hass.data.get(vacuum_adapters.CACHE, {}).get((entity, v.get("map") if v else None))
        ad = cache[0] if cache else None
        if ad is not None and self.states.get(v["id"] if v else "", {}).get("state") in IN_RUN:
            own = ad.run_path()
            if len(own) > len(pts):
                pts = [[round(x), round(y)] for x, y in own[-PATH_MAX:]]
        return {"run": p["run"], "start": p["start"], "pts": pts}

    def learned(self, entity: str) -> dict[str, Any]:
        learned = self._learned.get(entity, {})
        return {
            "res": CELL,
            "cells": [[int(k.split(",")[0]), int(k.split(",")[1]), n] for k, n in learned.get("cells", {}).items()],
            "dock": learned.get("dock"),
            "speed": learned.get("speed"),
            "runs": learned.get("runs", 0),
        }


def sanitize_vacuums(vacs: Any) -> list[dict[str, Any]]:
    out = []
    for v in vacs if isinstance(vacs, list) else []:
        if isinstance(v, dict) and isinstance(v.get("id"), str) and isinstance(v.get("entity"), str) and v["entity"].startswith("vacuum."):
            # a map entity picked by hand in the editor (else found automatically)
            m = v.get("map")
            out.append({"id": v["id"], "entity": v["entity"], **({"map": m} if isinstance(m, str) and m.split(".", 1)[0] in vacuum_adapters.MAP_DOMAINS else {})})
    return out


def _roborock_home(hass: HomeAssistant, entity: str) -> tuple[Any, Any] | None:
    """(home trait, maps trait) of the Roborock coordinator that runs this vacuum"""
    from homeassistant.helpers import entity_registry as er

    reg = er.async_get(hass).async_get(entity)
    if reg is None or reg.platform != "roborock" or not reg.config_entry_id:
        return None
    entry = hass.config_entries.async_get_entry(reg.config_entry_id)
    runtime = getattr(entry, "runtime_data", None)
    try:
        coords = list(runtime.values()) if hasattr(runtime, "values") else list(runtime or [])
    except TypeError:
        coords = []
    for co in coords:
        duid = str(getattr(co, "duid", "") or "")
        if len(coords) > 1 and duid and duid not in (reg.unique_id or ""):
            continue
        api = getattr(co, "properties_api", None)
        home = getattr(api, "home", None)
        if home is not None:
            return home, getattr(api, "maps", None)
    return None


def _current_flag(home: Any, maps: Any) -> Any:
    flag = getattr(maps, "current_map", None) if maps is not None else None
    if flag is not None:
        return flag
    # older library: the content that knows where the robot is
    for k, mc in (getattr(home, "home_map_content", None) or {}).items():
        if mc is not None and getattr(getattr(mc, "map_data", None), "vacuum_position", None) is not None:
            return k
    return None


async def _content_points(hass: HomeAssistant, content: Any, names: dict[str, str]) -> dict[str, Any] | None:
    if content is None or getattr(content, "map_data", None) is None or not getattr(content, "image_content", None):
        return None
    md = content.map_data
    try:
        cal = md.calibration()
    except Exception:  # noqa: BLE001
        return None
    if not cal or len(cal) < 3:
        return None
    rooms_mm = {str(k): (r.x0, r.y0, r.x1, r.y1) for k, r in (md.rooms or {}).items()}
    charger = [md.charger.x, md.charger.y] if getattr(md, "charger", None) is not None else None
    return await hass.async_add_executor_job(map_points, content.image_content, cal, rooms_mm, names, charger)


def _room_names(info: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    for r in getattr(info, "rooms", None) or []:
        sid = getattr(r, "segment_id", None)
        name = getattr(r, "raw_name", None) or None
        if sid is not None and name:
            out[str(sid)] = str(name)
    return out


async def roborock_map(hass: HomeAssistant, entity: str) -> dict[str, Any] | None:
    """The vacuum's own map in robot coordinates (mm): floor per room (with names), walls, dock — the map the
    robot uses right now.

    Read from the Roborock integration's parsed map (image + calibration). Lets the card lay the map onto the
    plan from the start — rooms of the same name, walls onto walls — including the plan's scale.
    """
    found = _roborock_home(hass, entity)
    if found is None:
        return None
    home, maps = found
    contents = getattr(home, "home_map_content", None) or {}
    flag = _current_flag(home, maps)
    content = contents.get(flag) if flag is not None else None
    if content is None:
        # no flag known: the one that knows where the robot is, else any with a picture
        for mc in contents.values():
            if mc is None or getattr(mc, "map_data", None) is None or not getattr(mc, "image_content", None):
                continue
            if content is None or getattr(mc.map_data, "vacuum_position", None) is not None:
                content = mc
    if content is None:
        return None
    names: dict[str, str] = {}
    info = (getattr(home, "home_map_info", None) or {}).get(flag) if flag is not None else None
    names.update(_room_names(info))
    if not names:
        try:
            res = await hass.services.async_call("roborock", "get_maps", {}, target={"entity_id": entity}, blocking=True, return_response=True)
            for m in (res or {}).get(entity, {}).get("maps", []):
                if flag is None or str(m.get("flag")) == str(flag):
                    for k, v in (m.get("rooms") or {}).items():
                        names[str(k)] = str(v)
        except Exception:  # noqa: BLE001
            pass
    return await _content_points(hass, content, names)


async def roborock_maps(hass: HomeAssistant, entity: str) -> list[dict[str, Any]] | None:
    """Every map the robot keeps (a house: one per floor), each with its name, whether it is the one in use, and
    its floor and walls when the integration holds them. The Roborock library loads all maps once when it starts
    (it switches through them); a map it could not load (the robot was busy) comes without geometry."""
    found = _roborock_home(hass, entity)
    if found is None:
        return None
    home, maps = found
    infos = getattr(home, "home_map_info", None) or {}
    contents = getattr(home, "home_map_content", None) or {}
    current = _current_flag(home, maps)
    flags = list(dict.fromkeys([*infos.keys(), *contents.keys()]))
    if not flags:
        one = await roborock_map(hass, entity)
        return [{"id": "current", "name": None, "current": True, "map": one}] if one else []
    out: list[dict[str, Any]] = []
    for flag in flags:
        info = infos.get(flag)
        try:
            geo = await _content_points(hass, contents.get(flag), _room_names(info))
        except Exception:  # noqa: BLE001 — one map that does not parse leaves the others
            geo = None
        out.append({"id": str(flag), "name": getattr(info, "name", None) or None, "current": flag == current, "map": geo})
    return out


def roborock_map_select(hass: HomeAssistant, entity: str) -> str | None:
    """The integration's "selected map" select of this vacuum (switches the robot's map)"""
    from homeassistant.helpers import entity_registry as er

    reg = er.async_get(hass)
    vac = reg.async_get(entity)
    if vac is None or not vac.device_id:
        return None
    for e in er.async_entries_for_device(reg, vac.device_id):
        if e.domain == "select" and e.platform == "roborock" and str(e.unique_id).startswith("selected_map"):
            return e.entity_id
    return None


def map_points(image: bytes, cal: list[dict[str, Any]], rooms_mm: dict[str, tuple], names: dict[str, str], charger: list | None) -> dict[str, Any] | None:
    """Floor per room and walls of a rendered Roborock map, in robot millimetres (runs in the executor)"""
    from io import BytesIO

    from PIL import Image

    # pixel ↔ mm from the three calibration points (affine)
    (v0, v1, v2) = [(c["vacuum"]["x"], c["vacuum"]["y"]) for c in cal[:3]]
    (p0, p1, p2) = [(c["map"]["x"], c["map"]["y"]) for c in cal[:3]]
    # forward: px = a*x + b*y + c
    det = (v1[0] - v0[0]) * (v2[1] - v0[1]) - (v2[0] - v0[0]) * (v1[1] - v0[1])
    if not det:
        return None

    def solve(q0: float, q1: float, q2: float) -> tuple[float, float, float]:
        a = ((q1 - q0) * (v2[1] - v0[1]) - (q2 - q0) * (v1[1] - v0[1])) / det
        b = ((q2 - q0) * (v1[0] - v0[0]) - (q1 - q0) * (v2[0] - v0[0])) / det
        return a, b, q0 - a * v0[0] - b * v0[1]

    ax, bx, cx = solve(p0[0], p1[0], p2[0])
    ay, by, cy = solve(p0[1], p1[1], p2[1])
    idet = ax * by - bx * ay
    if not idet:
        return None

    def to_mm(px: float, py: float) -> tuple[int, int]:
        dx, dy = px - cx, py - cy
        return round((by * dx - bx * dy) / idet), round((-ay * dx + ax * dy) / idet)

    def to_px(x: float, y: float) -> tuple[float, float]:
        return ax * x + bx * y + cx, ay * x + by * y + cy

    im = Image.open(BytesIO(image)).convert("RGB")
    w, h = im.size
    px = im.load()
    mm_per_px = abs(1 / (ax or 1e-9)) if abs(ax) > abs(bx) else abs(1 / (bx or 1e-9))
    floor_step = max(1, round(100 / mm_per_px))
    wall_step = max(1, round(50 / mm_per_px))
    counts: dict[tuple[int, int, int], int] = {}
    for j in range(0, h, 2):
        for i in range(0, w, 2):
            c = px[i, j]
            counts[c] = counts.get(c, 0) + 1
    background = max(counts, key=counts.get)
    wall = (93, 109, 126)
    if wall not in counts:
        # darkest frequent grey
        greys = [c for c, n in counts.items() if n > 200 and max(c) - min(c) < 45 and c != background]
        wall = min(greys, key=sum) if greys else wall
    # room colours: the colour most of each room's box is painted in
    room_color: dict[tuple[int, int, int], str] = {}
    for rid, (x0, y0, x1, y1) in rooms_mm.items():
        ia, ja = to_px(x0, y0)
        ib, jb = to_px(x1, y1)
        local: dict[tuple[int, int, int], int] = {}
        for j in range(int(max(0, min(ja, jb))), int(min(h, max(ja, jb))), 3):
            for i in range(int(max(0, min(ia, ib))), int(min(w, max(ia, ib))), 3):
                c = px[i, j]
                if c in (background, wall) or c in room_color or sum(c) > 700:
                    continue
                local[c] = local.get(c, 0) + 1
        if local:
            room_color[max(local, key=local.get)] = rid
    rooms: dict[str, list[list[int]]] = {rid: [] for rid in rooms_mm}
    for j in range(0, h, floor_step):
        for i in range(0, w, floor_step):
            rid = room_color.get(px[i, j])
            if rid is not None:
                rooms[rid].append(list(to_mm(i, j)))
    walls: list[list[int]] = []
    for j in range(0, h, wall_step):
        for i in range(0, w, wall_step):
            if px[i, j] == wall:
                walls.append(list(to_mm(i, j)))
    return {
        "rooms": [{"id": rid, "name": names.get(rid), "pts": pts} for rid, pts in rooms.items() if pts],
        "walls": walls,
        "charger": charger,
        "floor_res": round(floor_step * mm_per_px),
        "wall_res": round(wall_step * mm_per_px),
    }

