"""Where a robot vacuum's position and map come from — one adapter per kind of integration, found on its own.

* `roborock` — the core Roborock integration: `roborock.get_vacuum_current_position` and its parsed map.
* `map_camera` — the map camera convention of the Xiaomi Vacuum Map Card (Dreame Vacuum, Xiaomi Cloud Map
  Extractor and others): a camera / image entity with `calibration_points`, `vacuum_position`, `rooms` …
* `valetudo` — Valetudo's "Map data" camera (MQTT): the whole map as JSON inside a PNG.

The map entity is found by itself: an entity of the vacuum's own device first, then one whose name matches, then
the only map camera there is. The admin can pick another one in the card's editor. Segment (room) cleaning is
offered only where the integration has a way to do it; everything else stays read-only.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any
import zlib

from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .vacuum_formats import calibration, charger_of, map_from_image, path_of, point, rooms_of, valetudo_json, valetudo_map, valetudo_summary

_LOGGER = logging.getLogger(__name__)

CACHE = "floorplan_card_vacuum_adapters"
RETRY = 60  # s before a vacuum without an adapter is looked at again (integrations may load late)
MAP_DOMAINS = ("camera", "image")
# words that say nothing about which robot a map belongs to
GENERIC = {"vacuum", "robot", "map", "camera", "image", "saugroboter", "sauger", "karte", "live", "data", "rendered", "cleaner", "the"}
VALETUDO_TOPIC = re.compile(r"/MapData/map-data(-hass)?$")


def _has_attrs(hass: HomeAssistant, eid: str) -> bool:
    """A map camera of the Xiaomi Vacuum Map Card convention: usable calibration"""
    st = hass.states.get(eid)
    return bool(st and calibration(st.attributes.get("calibration_points")))


async def entity_image(hass: HomeAssistant, eid: str) -> bytes | None:
    """The current picture of a camera or image entity"""
    try:
        if eid.startswith("camera."):
            from homeassistant.components.camera import async_get_image

            return (await async_get_image(hass, eid, timeout=10)).content
        if eid.startswith("image."):
            comp = hass.data.get("entity_components", {}).get("image")
            ent = comp.get_entity(eid) if comp else None
            return await ent.async_image() if ent else None
    except Exception:  # noqa: BLE001 — no picture right now
        return None
    return None


def _entity_object(hass: HomeAssistant, eid: str) -> Any:
    comp = hass.data.get("entity_components", {}).get(eid.split(".", 1)[0])
    return comp.get_entity(eid) if comp else None


def _tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", s.lower()) if len(t) > 1 and t not in GENERIC}


def candidates(hass: HomeAssistant, entity: str) -> list[str]:
    """Map entities that may belong to the vacuum, best first: same device, then a matching name, then any
    camera / image with calibration points"""
    reg = er.async_get(hass)
    ent = reg.async_get(entity)
    out: list[tuple[float, str]] = []
    seen: set[str] = set()

    def score(eid: str) -> float:
        st = hass.states.get(eid)
        s = 0.0
        if st is not None:
            a = st.attributes
            if calibration(a.get("calibration_points")):
                s += 2
            if a.get("vacuum_position") is not None:
                s += 4
            # Dreame: saved maps (map_index > 0) and the Wi-Fi map are not the live one
            if isinstance(a.get("map_index"), int) and a.get("map_index") > 0:
                s -= 3
        if "saved" in eid or "wifi" in eid:
            s -= 2
        if "map_data" in eid:
            s += 1
        return s

    if ent and ent.device_id:
        for e in er.async_entries_for_device(reg, ent.device_id):
            if e.domain in MAP_DOMAINS and not e.disabled_by and e.entity_id not in seen:
                seen.add(e.entity_id)
                out.append((100 + score(e.entity_id), e.entity_id))
    names = _tokens(entity.split(".", 1)[1])
    st = hass.states.get(entity)
    if st is not None:
        names |= _tokens(str(st.attributes.get("friendly_name", "")))
    if ent and ent.device_id:
        dev = dr.async_get(hass).async_get(ent.device_id)
        if dev is not None:
            names |= _tokens(dev.name_by_user or dev.name or "")
    def other_robot(eid: str) -> bool:
        """a map entity on the device of another vacuum belongs to that one"""
        e = reg.async_get(eid)
        return bool(e and e.device_id and any(x.domain == "vacuum" and x.entity_id != entity for x in er.async_entries_for_device(reg, e.device_id)))

    maps = [s for s in hass.states.async_all(MAP_DOMAINS) if s.entity_id not in seen and not other_robot(s.entity_id)]
    calibrated = [s for s in maps if calibration(s.attributes.get("calibration_points"))]
    for s in maps:
        common = names & (_tokens(s.object_id) | _tokens(str(s.attributes.get("friendly_name", ""))))
        if common:
            seen.add(s.entity_id)
            out.append((50 + len(common) + score(s.entity_id), s.entity_id))
    if len(calibrated) == 1 and calibrated[0].entity_id not in seen:
        out.append((10 + score(calibrated[0].entity_id), calibrated[0].entity_id))
    out.sort(key=lambda x: -x[0])
    return [eid for _, eid in out]


class Adapter:
    """Position, map, segments of one vacuum (robot millimetres)"""

    kind = ""

    def __init__(self, hass: HomeAssistant, entity: str, source: str | None = None) -> None:
        self.hass = hass
        self.entity = entity
        self.source = source

    @property
    def platform(self) -> str | None:
        ent = er.async_get(self.hass).async_get(self.entity)
        return ent.platform if ent else None

    def alive(self) -> bool:
        return self.source is None or self.hass.states.get(self.source) is not None

    async def position(self) -> tuple[float, float] | None:
        return None

    async def map(self) -> dict[str, Any] | None:
        return None

    async def maps(self) -> list[dict[str, Any]]:
        """Every map of the robot (a house: one per floor): {id, name, current, map}; most robots have one"""
        m = await self.map()
        return [{"id": "current", "name": None, "current": True, "map": m}] if m else []

    def map_select(self) -> str | None:
        """An entity that switches the robot's map (select), if the integration has one"""
        return None

    async def segments(self) -> list[dict[str, Any]]:
        return []

    def run_path(self) -> list[tuple[float, float]]:
        return []

    def can_clean(self) -> bool:
        return False

    async def clean(self, ids: list[str], repeats: int = 1, context: Context | None = None) -> None:
        raise NotImplementedError

    async def info(self) -> dict[str, Any]:
        segs = await self.segments()
        return {"adapter": self.kind, "source": self.source, "platform": self.platform, "segments": segs, "clean": bool(segs) and self.can_clean()}


class RoborockAdapter(Adapter):
    """The core Roborock integration (a service for the position, the map from its runtime data)"""

    kind = "roborock"

    async def position(self) -> tuple[float, float] | None:
        if not self.hass.services.has_service("roborock", "get_vacuum_current_position"):
            return None
        try:
            res = await self.hass.services.async_call("roborock", "get_vacuum_current_position", {}, target={"entity_id": self.entity}, blocking=True, return_response=True)
        except Exception:  # noqa: BLE001 — repositioning, no map yet, offline: keep the last position
            return None
        return point((res or {}).get(self.entity)) if isinstance(res, dict) else None

    async def map(self) -> dict[str, Any] | None:
        from .vacuum import roborock_map

        return await roborock_map(self.hass, self.entity)

    async def maps(self) -> list[dict[str, Any]]:
        from .vacuum import roborock_maps

        return await roborock_maps(self.hass, self.entity) or []

    def map_select(self) -> str | None:
        from .vacuum import roborock_map_select

        return roborock_map_select(self.hass, self.entity)


def _ids(ids: list[str]) -> list[int | str]:
    return [int(i) if str(i).lstrip("-").isdigit() else i for i in ids]


class MapCameraAdapter(Adapter):
    """A map camera with calibration points (Dreame Vacuum, Xiaomi Cloud Map Extractor, …), robot mm"""

    kind = "map_camera"

    def _attrs(self) -> dict[str, Any]:
        st = self.hass.states.get(self.source or "")
        return dict(st.attributes) if st else {}

    async def position(self) -> tuple[float, float] | None:
        return point(self._attrs().get("vacuum_position"))

    async def map(self) -> dict[str, Any] | None:
        attrs = self._attrs()
        cal = calibration(attrs.get("calibration_points"))
        if cal is None:
            return None
        image = await entity_image(self.hass, self.source or "")
        return await self.hass.async_add_executor_job(map_from_image, image, cal, rooms_of(attrs), charger_of(attrs))

    async def segments(self) -> list[dict[str, Any]]:
        return [{"id": rid, "name": r["name"]} for rid, r in rooms_of(self._attrs()).items()]

    def run_path(self) -> list[tuple[float, float]]:
        return path_of(self._attrs())

    def _method(self) -> tuple[str, str] | None:
        """How this robot's integration cleans segments: its own `vacuum_clean_segment` service (Dreame Vacuum,
        Xiaomi Miio), else `vacuum.send_command app_segment_clean` (Xiaomi Miio)"""
        plat = self.platform
        if plat and self.hass.services.has_service(plat, "vacuum_clean_segment"):
            return (plat, "vacuum_clean_segment")
        if plat == "xiaomi_miio" and self.hass.services.has_service("vacuum", "send_command"):
            return ("vacuum", "send_command")
        return None

    def can_clean(self) -> bool:
        return self._method() is not None

    async def clean(self, ids: list[str], repeats: int = 1, context: Context | None = None) -> None:
        method = self._method()
        if method is None:
            raise NotImplementedError
        domain, service = method
        if service == "send_command":
            data: dict[str, Any] = {"command": "app_segment_clean", "params": _ids(ids)}
        else:
            data = {"segments": _ids(ids)}
            if repeats > 1:
                data["repeats"] = repeats
        await self.hass.services.async_call(domain, service, data, target={"entity_id": self.entity}, blocking=True, context=context)


class ValetudoAdapter(Adapter):
    """Valetudo's "Map data" camera: the map JSON inside a PNG (cm → mm)"""

    kind = "valetudo"

    def __init__(self, hass: HomeAssistant, entity: str, source: str | None = None) -> None:
        super().__init__(hass, entity, source)
        self._crc: int | None = None
        self._vm: dict[str, Any] | None = None
        self._sum: dict[str, Any] = {}

    async def _load(self) -> dict[str, Any] | None:
        """Read the picture; parse it only when it changed (a checksum is cheap, the JSON is not)"""
        data = await entity_image(self.hass, self.source or "")
        if not data:
            return self._vm
        crc = zlib.crc32(data)
        if crc != self._crc:
            vm = valetudo_json(data)
            if vm is not None:
                self._crc, self._vm, self._sum = crc, vm, valetudo_summary(vm)
        return self._vm

    async def position(self) -> tuple[float, float] | None:
        await self._load()
        r = self._sum.get("robot")
        return (r[0] * 10, r[1] * 10) if r else None

    async def map(self) -> dict[str, Any] | None:
        vm = await self._load()
        return await self.hass.async_add_executor_job(valetudo_map, vm) if vm else None

    async def segments(self) -> list[dict[str, Any]]:
        if self._vm is None:
            await self._load()
        return list(self._sum.get("segments") or [])

    def run_path(self) -> list[tuple[float, float]]:
        return [(x * 10, y * 10) for x, y in self._sum.get("path") or []]

    def _base(self) -> str | None:
        """Valetudo's MQTT topic of this robot (`<prefix>/<identifier>`), from the camera's own topic"""
        for eid in (self.source, self.entity):
            cfg = getattr(_entity_object(self.hass, eid or ""), "_config", None)
            if not isinstance(cfg, dict):
                continue
            for key in ("topic", "command_topic", "state_topic"):
                t = cfg.get(key)
                if isinstance(t, str) and "/" in t:
                    if VALETUDO_TOPIC.search(t):
                        return VALETUDO_TOPIC.sub("", t)
                    if key == "command_topic" and t.endswith("/BasicControlCapability/operation/set"):
                        return t[: -len("/BasicControlCapability/operation/set")]
        return None

    def can_clean(self) -> bool:
        return self.hass.services.has_service("mqtt", "publish") and self._base() is not None

    async def clean(self, ids: list[str], repeats: int = 1, context: Context | None = None) -> None:
        base = self._base()
        if base is None:
            raise NotImplementedError
        payload = json.dumps({"segment_ids": [str(i) for i in ids], "iterations": max(1, min(4, repeats)), "customOrder": True})
        await self.hass.services.async_call("mqtt", "publish", {"topic": f"{base}/MapSegmentationCapability/clean/set", "payload": payload}, blocking=True, context=context)


async def _valetudo(hass: HomeAssistant, eid: str) -> bool:
    return eid.startswith("camera.") and valetudo_json(await entity_image(hass, eid)) is not None


async def detect(hass: HomeAssistant, entity: str, map_entity: str | None = None) -> Adapter | None:
    """The adapter for a vacuum (None: no position available)"""
    ent = er.async_get(hass).async_get(entity)
    platform = ent.platform if ent else None
    if ent is None and hass.states.get(entity) is None:
        return None
    if map_entity and hass.states.get(map_entity) is not None:
        if _has_attrs(hass, map_entity):
            return MapCameraAdapter(hass, entity, map_entity)
        if await _valetudo(hass, map_entity):
            return ValetudoAdapter(hass, entity, map_entity)
    roborock = hass.services.has_service("roborock", "get_vacuum_current_position")
    if roborock and (platform == "roborock" or ent is None):
        return RoborockAdapter(hass, entity)
    # best candidate first; Valetudo only for pictures that may be its map data (no need to fetch every camera)
    for k, eid in enumerate(candidates(hass, entity)):
        if _has_attrs(hass, eid):
            return MapCameraAdapter(hass, entity, eid)
        if k < 6 and ("map" in eid or platform == "mqtt") and await _valetudo(hass, eid):
            return ValetudoAdapter(hass, entity, eid)
    return None


async def get(hass: HomeAssistant, entity: str, map_entity: str | None = None, fresh: bool = False) -> Adapter | None:
    """The vacuum's adapter, remembered (looked at again when its map entity is gone, or a minute after none
    was found)"""
    cache: dict[tuple[str, str | None], tuple[Adapter | None, float]] = hass.data.setdefault(CACHE, {})
    key = (entity, map_entity or None)
    hit = cache.get(key)
    now = time.monotonic()
    if not fresh and hit is not None and (hit[0].alive() if hit[0] else now - hit[1] < RETRY):
        return hit[0]
    try:
        ad = await detect(hass, entity, map_entity)
    except Exception:  # noqa: BLE001 — a strange entity must not stop the rest
        _LOGGER.debug("vacuum adapter for %s", entity, exc_info=True)
        ad = None
    cache[key] = (ad, now)
    return ad
