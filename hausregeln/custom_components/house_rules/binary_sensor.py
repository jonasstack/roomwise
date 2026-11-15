"""One occupancy sensor per room ("Küche belegt"), combining all sensors given to the room."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import slugify

from .const import DOMAIN
from .core import HouseRules
from .i18n import tr
from .switch import device_info

# i18n: complete (names in texts/entities.json; entity ids stay as they are)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    core: HouseRules = hass.data[DOMAIN]
    known: dict[str, RoomOccupancy] = {}

    @callback
    def sync() -> None:
        ids = set(core.rooms)
        new = [RoomOccupancy(core, rid) for rid in ids if rid not in known]
        for e in new:
            known[e.room_id] = e
        if new:
            async_add_entities(new)
        reg = er.async_get(hass)
        for rid in [r for r in known if r not in ids]:
            ent = known.pop(rid)
            if ent.entity_id and reg.async_get(ent.entity_id):
                reg.async_remove(ent.entity_id)

    core.entity_hooks["rooms"] = sync
    core.room_tracker.add_listener(lambda rid, _o: (e := known.get(rid)) is not None and e.hass is not None and e.async_write_ha_state())
    sync()
    alarm = [
        AlarmState(core, "scharf", tr(core, "entity.alarm_armed"), lambda s: s.startswith("armed_") or s in ("arming", "pending", "triggered"), BinarySensorDeviceClass.SAFETY),
        AlarmState(core, "voralarm", tr(core, "entity.alarm_pending"), lambda s: s == "pending", BinarySensorDeviceClass.SAFETY),
        AlarmState(core, "alarm", tr(core, "entity.alarm_triggered"), lambda s: s == "triggered", BinarySensorDeviceClass.SAFETY),
    ]
    core.alarm.add_listener(callback(lambda _s: [e.async_write_ha_state() for e in alarm if e.hass is not None]))
    ww = WindowWarningSensor(core)
    core.window_warning.add_listener(callback(lambda: ww.hass is not None and ww.async_write_ha_state()))
    async_add_entities([*alarm, ww])
    from .heating_entities import setup_binary  # noqa: PLC0415

    setup_binary(core, async_add_entities)


class WindowWarningSensor(BinarySensorEntity):
    """Fenster-Warnung beim Gehen: on while it warns (until acknowledged or the windows are closed)."""

    _attr_has_entity_name = False
    _attr_icon = "mdi:window-open-variant"
    _attr_unique_id = "window_warning"
    _attr_should_poll = False
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self._attr_name = tr(core, "entity.window_warning")
        self._attr_device_info = device_info(core)
        self.entity_id = "binary_sensor.fenster_warnung"

    @property
    def available(self) -> bool:
        return self.core.feature("window_warning")

    @property
    def is_on(self) -> bool:
        return self.core.window_warning.active

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        v = self.core.window_warning.view()
        return {k: v[k] for k in ("phase", "door", "windows", "names", "deadline", "spoken")}


class AlarmState(BinarySensorEntity):
    """Alarm states as on/off sensors, for triggers in other automations."""

    _attr_has_entity_name = False
    _attr_should_poll = False

    def __init__(self, core: HouseRules, key: str, name: str, test: Any, device_class: BinarySensorDeviceClass) -> None:
        self.core = core
        self._attr_device_info = device_info(core)
        self._test = test
        self._attr_name = name
        self._attr_unique_id = f"alarm_{key}"
        self._attr_device_class = device_class
        self.entity_id = f"binary_sensor.alarmanlage_{key}"

    @property
    def available(self) -> bool:
        return self.core.alarm.started and bool(self.core.alarm.config.get("enabled"))

    @property
    def is_on(self) -> bool:
        return bool(self._test(self.core.alarm.state))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        a = self.core.alarm
        return {"mode": a.mode, "cause": a.cause, "cause_name": a.view()["cause_name"]}


class RoomOccupancy(BinarySensorEntity):
    _attr_has_entity_name = False
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY
    _attr_should_poll = False

    def __init__(self, core: HouseRules, room_id: str) -> None:
        self.core = core
        self._attr_device_info = device_info(core)
        self.room_id = room_id
        self._attr_unique_id = f"room_{room_id}_occupied"
        room = core.rooms.get(room_id)
        self.entity_id = f"binary_sensor.{slugify(room['name'] if room else room_id)}_belegt"

    @property
    def name(self) -> str:
        room = self.core.rooms.get(self.room_id)
        return tr(self.core, "entity.room_occupied", room=room["name"] if room else self.room_id)

    @property
    def available(self) -> bool:
        room = self.core.rooms.get(self.room_id)
        return bool(room and (room["presence"] or room["motion"] or room["door_logic"]))

    @property
    def is_on(self) -> bool:
        return self.core.room_tracker.occupied(self.room_id)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.core.room_tracker.state.get(self.room_id, {})
        return {"since": st.get("since"), "detected_by": st.get("by"), "dark": self.core.room_tracker.is_dark(self.room_id)}
