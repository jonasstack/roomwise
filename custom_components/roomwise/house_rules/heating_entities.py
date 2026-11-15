"""Entities of the heating controller (heating.py), for dashboards, the floorplan card and other automations.

  sensor.<raum>_heizplan            target temperature of the room, attributes: status line, level, reason, window …
  sensor.<raum>_lueften             ok | lueften | lueftet | fenster_zu | aus, attributes: reason, minutes, humidity, CO₂ …
  binary_sensor.heizung_waermeanforderung   on while any valve is open more than the set limit
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.const import UnitOfTemperature
from homeassistant.core import callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import slugify

from .i18n import tr
from .switch import device_info

# i18n: complete (names in texts/entities.json; states stay as they are)

if TYPE_CHECKING:
    from .core import HouseRules

VENT_STATES = {"ok": "ok", "ventilate": "lueften", "airing": "lueftet", "close_window": "fenster_zu", "off": "aus"}  # i18n-ignore (states, a contract)


def setup_sensors(core: HouseRules, add: AddEntitiesCallback) -> None:
    known: dict[str, tuple[RoomHeatSensor, RoomVentSensor]] = {}

    @callback
    def sync() -> None:
        new: list[SensorEntity] = []
        for rid in core.heating._active_rooms():  # noqa: SLF001
            if rid in known or rid not in core.rooms:
                continue
            pair = (RoomHeatSensor(core, rid), RoomVentSensor(core, rid))
            known[rid] = pair
            new += list(pair)
        if new:
            add(new)

    @callback
    def changed(rid: str | None) -> None:
        for r, pair in known.items():
            if rid is None or r == rid:
                for e in pair:
                    if e.hass is not None:
                        e.async_write_ha_state()

    core.entity_hooks["heating"] = sync
    core.heating.add_listener(changed)
    sync()


def setup_binary(core: HouseRules, add: AddEntitiesCallback) -> None:
    ent = HeatDemand(core)
    core.heating.add_listener(callback(lambda rid: ent.hass is not None and rid is None and ent.async_write_ha_state()))
    add([ent])


class _RoomBase(SensorEntity):
    _attr_has_entity_name = False
    _attr_should_poll = False

    def __init__(self, core: HouseRules, room_id: str) -> None:
        self.core = core
        self._attr_device_info = device_info(core)
        self.room_id = room_id

    @property
    def _room_name(self) -> str:
        room = self.core.rooms.get(self.room_id)
        return room["name"] if room else self.room_id

    @property
    def _status(self) -> dict[str, Any] | None:
        return self.core.heating.status(self.room_id)


class RoomHeatSensor(_RoomBase):
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_icon = "mdi:radiator"

    def __init__(self, core: HouseRules, room_id: str) -> None:
        super().__init__(core, room_id)
        self._attr_unique_id = f"heat_{room_id}"
        room = core.rooms.get(room_id)
        self.entity_id = f"sensor.{slugify(room['name'] if room else room_id)}_heizplan"

    @property
    def name(self) -> str:
        return tr(self.core, "entity.heat_plan", room=self._room_name)

    @property
    def available(self) -> bool:
        return bool(self.core.heating.room(self.room_id)["on"] and self._status)

    @property
    def native_value(self) -> float | None:
        st = self._status or {}
        return st.get("temp") if st.get("mode") != "off" else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self._status or {}
        w = st.get("window") or {}
        return {
            "status": st.get("line"),
            "level": st.get("level"),
            "reason": st.get("why"),
            "until": st.get("until"),
            "heating_off": st.get("mode") == "off",
            "current_temperature": st.get("current"),
            "valve": st.get("valve"),
            "heating": st.get("heating"),
            "reached": st.get("reached"),
            "window": w.get("state"),
            "manual": bool(st.get("manual")),
            "hints": st.get("hints") or [],
        }


class RoomVentSensor(_RoomBase):
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = list(VENT_STATES.values())
    _attr_icon = "mdi:window-open-variant"

    def __init__(self, core: HouseRules, room_id: str) -> None:
        super().__init__(core, room_id)
        self._attr_unique_id = f"vent_{room_id}"
        room = core.rooms.get(room_id)
        self.entity_id = f"sensor.{slugify(room['name'] if room else room_id)}_lueften"

    @property
    def name(self) -> str:
        return tr(self.core, "entity.vent", room=self._room_name)

    @property
    def available(self) -> bool:
        return bool(self._status)

    @property
    def native_value(self) -> str | None:
        v = (self._status or {}).get("vent") or {}
        return VENT_STATES.get(v.get("state", "off"), VENT_STATES["off"])

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        v = (self._status or {}).get("vent") or {}
        return {"reason": v.get("reason"), "minutes": v.get("minutes"), "humidity": v.get("humidity"), "co2": v.get("co2"), "outside": v.get("outside"), "mould_risk": v.get("mould")}


class HeatDemand(BinarySensorEntity):
    _attr_has_entity_name = False
    _attr_icon = "mdi:fire"
    _attr_unique_id = "heat_demand"
    _attr_should_poll = False
    _attr_device_class = BinarySensorDeviceClass.HEAT

    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self._attr_name = tr(core, "entity.heat_demand")
        self._attr_device_info = device_info(core)
        self.entity_id = "binary_sensor.heizung_waermeanforderung"

    @property
    def available(self) -> bool:
        return self.core.heating.enabled()

    @property
    def is_on(self) -> bool:
        return self.core.heating.demand_on

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        h = self.core.heating
        return {"reason": h.demand_why, "summer": h.summer, "outside": h.outside()}
