"""What exists in the home: devices (sorted into kinds and rooms), rooms (HA areas) and people.

Built from the entity, device and area registries; the user's corrections are stored by the integration
(data["devices"], one central place for every part of Hausregeln) and never written back into Home Assistant:
  kind / room      another kind or room than detected
  hidden           "nicht verwenden": the entity counts nowhere (alarm, window warning, heating, light …)
  name / icon      an own name and mdi icon
  manual           added by hand (any entity, also helpers or templates), with kind, room, name and icon
Entities of vehicles (cars, e-bikes, GPS trackers) are never doors, windows or sensors of the house: their
tracker becomes one device of the kind "vehicle", the rest is listed as vehicle parts until the user assigns
one explicitly.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from homeassistant.const import STATE_HOME, STATE_NOT_HOME, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er
from homeassistant.util import slugify

from .const import IGNORED_PLATFORMS
from .i18n import tr

if TYPE_CHECKING:
    from .core import HouseRules

FEMININE = ("küche", "diele", "garage", "toilette", "terrasse", "werkstatt", "waschküche", "galerie", "loggia", "sauna", "kammer", "ankleide", "bibliothek")


def room_in(name: str) -> str:
    """'im Flur', 'in der Küche' — a guess, good for most German room names."""
    low = name.lower()
    if low.endswith(FEMININE) or re.search(r"(e|ung|ei|heit|keit|statt)$", low):
        return f"in der {name}"
    return f"im {name}"


ROOM_DEFAULT_ICONS = {
    "küche": "mdi:stove",
    "bad": "mdi:shower",
    "wc": "mdi:toilet",
    "schlaf": "mdi:bed-king-outline",
    "wohn": "mdi:sofa-outline",
    "flur": "mdi:door",
    "diele": "mdi:door",
    "büro": "mdi:desk",
    "arbeit": "mdi:desk",
    "kind": "mdi:teddy-bear",
    "garten": "mdi:flower-outline",
    "balkon": "mdi:balcony",
    "terrasse": "mdi:balcony",
    "keller": "mdi:stairs-down",
    "garage": "mdi:garage",
    "ess": "mdi:silverware-fork-knife",
}


def _room_icon(name: str, icon: str | None) -> str:
    if icon:
        return icon
    low = name.lower()
    for key, ic in ROOM_DEFAULT_ICONS.items():
        if key in low:
            return ic
    return "mdi:floor-plan"


# integrations of cars, e-bikes and GPS trackers: everything on such a device belongs to a vehicle (same list as the
# floor plan card, src/vehicles.ts, plus e-bikes and trackers)
VEHICLE_PLATFORMS = frozenset(
    {
        "mbapi2020", "mercedes_me", "smart", "hello_smart", "smart_hashtag", "tesla", "tesla_custom", "tesla_fleet", "teslemetry",
        "tessie", "bmw_connected_drive", "bmw_cardata", "mini_connected", "cardata", "volkswagencarnet", "volkswagen_we_connect_id",
        "weconnect", "audiconnect", "skodaconnect", "myskoda", "seatconnect", "cupra_we_connect", "kia_uvo", "hyundai_kia_connect",
        "renault", "polestar", "polestar_api", "volvooncall", "volvo", "volvo_cars", "ford", "fordpass", "mazda", "nissan_leaf",
        "toyota", "lexus", "subaru", "porscheconnect", "psa_car_controller", "stellantis_vehicles", "opel", "peugeot", "citroen",
        "jlrincontrol", "mg_saic", "saic_ismart", "byd", "zeekr", "lynk_co", "fiat", "honda", "rivian", "lucid", "nio", "xpeng",
        "vanmoof", "cowboy", "bosch_ebike", "niu", "georide", "invoxia", "traccar", "traccar_server", "trackimo",
    }
)  # fmt: skip
# device manufacturers that only build vehicles (exact, lower case)
VEHICLE_MAKERS = frozenset(
    {
        "mercedes-benz", "mercedes", "bmw", "mini", "volkswagen", "vw", "audi", "skoda", "škoda", "seat", "cupra", "porsche", "tesla",
        "kia", "hyundai", "renault", "dacia", "polestar", "volvo", "volvo cars", "ford", "opel", "vauxhall", "peugeot", "citroën",
        "citroen", "toyota", "lexus", "nissan", "mazda", "subaru", "fiat", "jeep", "alfa romeo", "mg", "byd", "smart", "jaguar",
        "land rover", "mitsubishi", "suzuki", "nio", "xpeng", "zeekr", "lynk & co", "rivian", "lucid", "vanmoof", "cowboy",
    }
)  # fmt: skip
# trackers of phones and people (companion app & co.): never vehicles
PHONE_PLATFORMS = frozenset(
    {"mobile_app", "companion", "ios", "android", "life360", "owntracks", "icloud", "icloud3", "gpslogger", "google_maps", "locative", "geofency"}
)
PHONE_MODEL = re.compile(r"iphone|ipad|pixel|galaxy|\bsm-|android|watch|phone|handy|smartphone|tablet|oneplus|xiaomi|huawei", re.I)  # i18n-ignore
# values only a vehicle reports (on the normalised name: lowercase, "_" between words, umlauts spelled out)
CAR_VALUE = re.compile(
    r"odometer|mileage|kilometerstand|km_stand|fuel_level|fuel_range|tank_level|tankinhalt|kraftstoff|range_electric|electric_range"
    r"|reichweite|(^|_)range($|_)|state_of_charge|tire_pressure|tyre_pressure|reifendruck|charging_port|charge_port|ladeklappe"
    r"|sunroof|schiebedach|tailgate|heckklappe|kofferraum|(^|_)trunk($|_)|frunk|park_brake|parkbremse|ignition|zuendung"
)


def norm_name(s: str) -> str:
    s = s.lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


ICON_RE = re.compile(r"^mdi:[a-z0-9-]{1,60}$")


def classify(entity_id: str, state: State | None, name: str) -> tuple[str | None, str | None]:
    """(kind, hint): kind for Hausregeln, hint = what HA says when the name suggests something else."""
    domain = entity_id.split(".")[0]
    dc = (state.attributes.get("device_class") if state else None) or ""
    low = name.lower()
    if domain == "light":
        return "light", None
    if domain == "switch":
        return ("outlet" if dc == "outlet" or "steckdose" in low or "plug" in low else "switch"), None
    if domain == "fan":
        return ("purifier" if re.search(r"luftreinig|purifier|dyson|air", low) else "fan"), None
    if domain in ("climate",):
        return "climate", None
    if domain == "cover":
        return "cover", None
    if domain == "media_player":
        return "media", None
    if domain == "vacuum":
        return "vacuum", None
    if domain == "lock":
        return "lock", None
    if domain == "script":
        return "script", None
    if domain == "input_boolean":
        return "switch", None
    if domain == "binary_sensor":
        if dc in ("door", "garage_door", "opening", "window"):
            says = "window" if dc == "window" else "door"
            named = "window" if "fenster" in low else ("door" if re.search(r"tür|tuer|door|tor\b", low) and dc == "window" else None)
            if named and named != says:
                return named, says
            return says, None
        if dc in ("motion", "moving"):
            return "motion", None
        if dc in ("occupancy", "presence"):
            return "presence", None
        if dc == "moisture":
            return "leak", None
        return None, None
    if domain == "sensor":
        if dc == "temperature":
            return "temperature", None
        if dc == "illuminance":
            return "illuminance", None
    return None, None


class Inventory:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.devices: dict[str, dict[str, Any]] = {}
        self.areas: dict[str, dict[str, Any]] = {}
        self.persons: dict[str, dict[str, Any]] = {}
        self.excluded: dict[str, dict[str, Any]] = {}  # "nicht verwenden" (by the user)
        self.vehicle_parts: dict[str, dict[str, Any]] = {}  # doors, locks … of vehicles, not of the house
        self.vehicles: dict[str, dict[str, Any]] = {}  # device id → {name, why}

    # ------------------------------------------------------------------ build
    def rebuild(self) -> None:
        hass = self.hass
        ent_reg = er.async_get(hass)
        dev_reg = dr.async_get(hass)
        area_reg = ar.async_get(hass)
        overrides: dict[str, dict[str, Any]] = self.core.data.get("devices", {})

        self.areas = {a.id: {"id": a.id, "name": a.name, "icon": _room_icon(a.name, a.icon), "in": room_in(a.name)} for a in area_reg.async_list_areas()}
        area_names = sorted(((a["name"].lower(), aid) for aid, a in self.areas.items()), key=lambda x: -len(x[0]))
        self.vehicles = self._vehicles(ent_reg, dev_reg)

        devices: dict[str, dict[str, Any]] = {}
        excluded: dict[str, dict[str, Any]] = {}
        parts: dict[str, dict[str, Any]] = {}
        occupancy_by_device: dict[str, list[str]] = {}
        for state in hass.states.async_all():
            eid = state.entity_id
            entry = ent_reg.async_get(eid)
            ov = overrides.get(eid, {})
            manual = bool(ov.get("manual") and ov.get("kind"))
            # trackers are "diagnostic" in Home Assistant, but the tracker of a vehicle is the vehicle itself
            category = entry.entity_category if entry and not eid.startswith("device_tracker.") else None
            if entry and (entry.disabled_by or ((entry.hidden_by or category or entry.platform in IGNORED_PLATFORMS) and not manual)):
                continue
            name = state.attributes.get("friendly_name") or eid
            auto_kind, hint = classify(eid, state, name)
            kind = auto_kind
            vehicle = self.vehicles.get(entry.device_id) if entry and entry.device_id else None
            if vehicle and not ov.get("kind"):
                if eid.startswith("device_tracker."):
                    kind = auto_kind = "vehicle"
                elif kind:
                    # a car door is no door of the house: listed as part of the vehicle until the user assigns it
                    parts[eid] = {"entity_id": eid, "name": name, "kind": kind, "vehicle": vehicle["name"], "reason": "vehicle"}
                    continue
            if ov.get("kind"):
                kind, hint = ov["kind"], None
            area = entry.area_id if entry else None
            if not area and entry and entry.device_id:
                dev = dev_reg.async_get(entry.device_id)
                area = dev.area_id if dev else None
            if kind and ov.get("hidden"):
                excluded[eid] = {"entity_id": eid, "name": ov.get("name") or name, "kind": kind, "room": ov.get("room") or area, "reason": "user"}
                continue
            if not kind:
                continue
            guess = None
            low = name.lower()
            # groups ("Alle Lampen außer Flur"), scripts, phones, cars and services usually belong to no room
            dev_entry = dev_reg.async_get(entry.device_id) if entry and entry.device_id else None
            likely_none = bool(
                isinstance(state.attributes.get("entity_id"), list)
                or eid.startswith("script.")
                or vehicle
                or (entry and entry.platform in ("mobile_app", "group", "template"))
                or (dev_entry and dev_entry.entry_type is not None)
                or re.search(r"\b(alle|außer|ausser)\b", low)
            )
            if not area and not likely_none:
                guess = next((aid for n, aid in area_names if n and re.search(rf"(?<!außer )(?<!ausser ){re.escape(n)}", low)), None)
            room = ov.get("room") or area
            d: dict[str, Any] = {"entity_id": eid, "name": ov.get("name") or name, "kind": kind, "room": room}
            if hint:
                d["kind_hint"] = hint
            if not room and guess:
                d["room_guess"] = guess
            if not room and (ov.get("no_room") or likely_none):
                d["no_room"] = "set" if ov.get("no_room") else "likely"
            # what was detected, when the user changed it (panel: "Erkannt als … – geändert")
            if ov.get("kind") and ov["kind"] != auto_kind:
                d["auto_kind"] = auto_kind
            if ov.get("room") and ov["room"] != area:
                d["auto_room"] = area
            if ov.get("name") and ov["name"] != name:
                d["auto_name"] = name
            if ov.get("icon"):
                d["icon"] = ov["icon"]
            if manual:
                d["manual"] = True
            if vehicle:
                d["vehicle"] = vehicle["name"]
            devices[eid] = d
            if kind == "presence" and not ov.get("kind") and entry and entry.device_id:
                occupancy_by_device.setdefault(entry.device_id, []).append(eid)

        # multi-zone presence sensors (Aqara FP2 & co.): one sensor covers the room, the others are zones
        for ids in occupancy_by_device.values():
            if len(ids) < 3:
                continue
            ids.sort()
            main = next((e for e in ids if re.search(r"alles|ganz|gesamt|whole|all\b", devices[e]["name"].lower())), ids[0])
            for e in ids:
                if e != main:
                    devices[e]["kind"] = "zone"
        self.devices = devices
        self.excluded = excluded
        self.vehicle_parts = parts
        self._rebuild_persons()

    def _vehicles(self, ent_reg: er.EntityRegistry, dev_reg: dr.DeviceRegistry) -> dict[str, dict[str, Any]]:
        """Devices that are vehicles or move with one (cars, e-bikes, GPS trackers): device id → {name, why}.

        A known car / e-bike / tracker integration, a manufacturer that only builds vehicles, a GPS tracker that
        belongs to no person and is no phone, a location tracker with one typical car value, or two car values
        (odometer, range, fuel, tyre pressure, state of charge …). Phones never count. Same core rule as the floor plan
        card (src/vehicles.ts)."""
        person_trackers = {t for s in self.hass.states.async_all("person") for t in (s.attributes.get("device_trackers") or [])}
        by_dev: dict[str, list[er.RegistryEntry]] = {}
        for e in ent_reg.entities.values():
            if e.device_id and not e.disabled_by:
                by_dev.setdefault(e.device_id, []).append(e)
        out: dict[str, dict[str, Any]] = {}
        for did, ents in by_dev.items():
            platforms = {e.platform for e in ents}
            if platforms & PHONE_PLATFORMS or platforms & IGNORED_PLATFORMS:
                continue
            dev = dev_reg.async_get(did)
            if not dev:
                continue
            name = dev.name_by_user or dev.name or ""
            maker = (dev.manufacturer or "").strip().lower()
            trackers = [e for e in ents if e.domain == "device_tracker"]
            values = 0
            for e in ents:
                if e.domain == "device_tracker":
                    continue
                st = self.hass.states.get(e.entity_id)
                label = (st.attributes.get("friendly_name") if st else None) or e.name or e.original_name or ""
                if CAR_VALUE.search(norm_name(f"{e.translation_key or ''} {e.entity_id.split('.', 1)[1]} {label}")):
                    values += 1
            gps = [
                e
                for e in trackers
                if e.entity_id not in person_trackers
                and (st := self.hass.states.get(e.entity_id)) is not None
                and (st.attributes.get("source_type") == "gps" or "latitude" in st.attributes)
            ]
            why = None
            if platforms & VEHICLE_PLATFORMS:
                why = "integration"
            elif maker in VEHICLE_MAKERS:
                why = "manufacturer"
            elif PHONE_MODEL.search(f"{dev.model or ''} {name}"):
                why = None
            elif (trackers and values >= 1) or values >= 2:
                why = "values"
            elif gps:
                why = "tracker"
            if why:
                out[did] = {"name": name or tr(self.core, "obj.vehicle"), "why": why}
        return out

    def _rebuild_persons(self) -> None:
        hass = self.hass
        ent_reg = er.async_get(hass)
        dev_reg = dr.async_get(hass)
        excluded = set(self.core.data.get("settings", {}).get("persons_excluded", []))
        phones_off = set(self.core.data.get("settings", {}).get("phones_excluded", []))
        persons: dict[str, dict[str, Any]] = {}
        firsts: dict[str, int] = {}
        states = [s for s in hass.states.async_all("person") if s.attributes.get("device_trackers") and s.entity_id not in excluded]
        for s in states:
            first = str(s.attributes.get("friendly_name") or s.object_id).split(" ")[0]
            firsts[first] = firsts.get(first, 0) + 1
        for s in states:
            full = str(s.attributes.get("friendly_name") or s.object_id)
            first = full.split(" ")[0]
            phones: list[str] = []
            for tracker in s.attributes.get("device_trackers", []):
                entry = ent_reg.async_get(tracker)
                if not entry or entry.platform != "mobile_app" or not entry.device_id:
                    continue
                dev = dev_reg.async_get(entry.device_id)
                if not dev:
                    continue
                service = f"mobile_app_{slugify(dev.name_by_user or dev.name or '')}"
                if hass.services.has_service("notify", service):
                    phones.append(service)
            if not phones:
                # no companion-app tracker: a notify service named after the person ("mobile_app_iphone_von_alex")
                slug = slugify(first)
                phones = sorted(n for n in hass.services.async_services_for_domain("notify") if n.startswith("mobile_app_") and slug and slug in n)
            # phones the user switched off ("nicht verwenden"): found, but no message goes there
            found = phones
            phones = [ph for ph in found if ph not in phones_off]
            persons[s.object_id] = {
                "id": s.object_id,
                "entity_id": s.entity_id,
                "name": first if firsts[first] == 1 else full,
                "phones": phones,
                "phone": phones[0] if phones else None,
                "phones_found": found,
            }
        self.persons = persons

    # ------------------------------------------------------------------ helpers
    def person_home(self, pid: str) -> bool:
        p = self.persons.get(pid)
        st = self.hass.states.get(p["entity_id"]) if p else None
        return bool(st and st.state == STATE_HOME)

    def person_where(self, pid: str) -> str:
        p = self.persons.get(pid)
        st = self.hass.states.get(p["entity_id"]) if p else None
        if not st or st.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
            return "unbekannt"
        if st.state == STATE_HOME:
            return "Zuhause"
        if st.state == STATE_NOT_HOME:
            return "Unterwegs"
        return st.state

    def persons_view(self) -> list[dict[str, Any]]:
        return [
            {
                "id": p["id"],
                "name": p["name"],
                "home": self.person_home(p["id"]),
                "where": self.person_where(p["id"]),
                "phone": p["phone"],
                "phones": p["phones"],
                "phones_found": p["phones_found"],
                "entity_id": p["entity_id"],
            }
            for p in self.persons.values()
        ]

    def usable(self, entity_id: str) -> bool:
        """False for what the user excluded and for parts of vehicles: no feature may pick these by itself."""
        return entity_id not in self.excluded and entity_id not in self.vehicle_parts

    def unused_view(self) -> list[dict[str, Any]]:
        """Excluded devices and vehicle parts, for the panel (to use them again or assign them)."""
        return [*self.excluded.values(), *self.vehicle_parts.values()]

    def in_room(self, kind: str, room: str | None) -> list[str]:
        return [d["entity_id"] for d in self.devices.values() if d["kind"] == kind and (room is None or d["room"] == room)]

    def room_of(self, entity_id: str) -> str | None:
        d = self.devices.get(entity_id)
        return d["room"] if d else None
