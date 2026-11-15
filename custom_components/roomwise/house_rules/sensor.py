"""Text sensors: state of the alarm system and the house mode (for triggers and dashboards)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .alarm import STATES
from .const import DOMAIN, MODES
from .core import HouseRules
from .i18n import mode_label, tr
from .switch import device_info

# i18n: complete (names in texts/entities.json; states stay as they are)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    core: HouseRules = hass.data[DOMAIN]
    alarm = AlarmStateSensor(core)
    mode = HouseModeSensor(core)
    core.alarm.add_listener(callback(lambda _s: alarm.hass is not None and alarm.async_write_ha_state()))
    core.entity_hooks["mode_sensor"] = callback(lambda: mode.hass is not None and mode.async_write_ha_state())
    async_add_entities([alarm, mode])
    from .heating_entities import setup_sensors  # noqa: PLC0415

    setup_sensors(core, async_add_entities)


class AlarmStateSensor(SensorEntity):
    _attr_has_entity_name = False
    _attr_icon = "mdi:shield-home-outline"
    _attr_unique_id = "alarm_state"
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = list(STATES)

    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self._attr_name = tr(core, "entity.alarm_state")
        self._attr_device_info = device_info(core)
        self.entity_id = "sensor.alarmanlage_zustand"

    @property
    def available(self) -> bool:
        return self.core.alarm.started and bool(self.core.alarm.config.get("enabled"))

    @property
    def native_value(self) -> str:
        return self.core.alarm.state

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        v = self.core.alarm.view()
        return {"label": v["label"], "mode": v["mode"], "cause": v["cause"], "cause_name": v["cause_name"], "until": v["until"], "silenced": v["silenced"]}


class HouseModeSensor(SensorEntity):
    _attr_has_entity_name = False
    _attr_icon = "mdi:home-switch-outline"
    _attr_unique_id = "house_mode_state"
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = list(MODES)

    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self._attr_name = tr(core, "entity.house_mode_state")
        self._attr_device_info = device_info(core)
        self.entity_id = "sensor.hausmodus"

    @property
    def native_value(self) -> str:
        return self.core.mode

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        ma = self.core.mode_auto
        return {"label": mode_label(self.core, self.core.mode), "automatic_target": ma.target, "automatic_reason": ma.why}
