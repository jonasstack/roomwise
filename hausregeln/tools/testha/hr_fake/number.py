from homeassistant.components.number import NumberEntity
from homeassistant.const import PERCENTAGE, EntityCategory, UnitOfTemperature

from .common import Fake


async def async_setup_entry(hass, entry, add):
    # like Zigbee2MQTT: the thermostat's temperature calibration on the same device
    add([
        FakeNumber(hass, "heizung_wohnzimmer_local_temperature_calibration", "Heizung Wohnzimmer Kalibrierung", "Thermostat Wohnzimmer"),
        # like a Sonoff TRVZB (Zigbee2MQTT): how far the valve opens when the thermostat opens / closes when it closes
        FakeValve(hass, "heizung_buero_valve_opening_degree", "Heizung Büro Valve opening degree", "Thermostat Büro"),
        FakeValve(hass, "heizung_buero_valve_closing_degree", "Heizung Büro Valve closing degree", "Thermostat Büro"),
    ])


class FakeNumber(Fake, NumberEntity):
    platform_domain = "number"
    _attr_native_min_value = -5
    _attr_native_max_value = 5
    _attr_native_step = 0.1
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, hass, uid, name, device):
        super().__init__(hass, uid, name, device)
        self._attr_native_value = 0.0

    async def async_set_native_value(self, value):
        self._attr_native_value = value
        self.async_write_ha_state()

    def fake_set(self, state, attributes):
        self._attr_native_value = float(state)
        self.async_write_ha_state()


class FakeValve(Fake, NumberEntity):
    platform_domain = "number"
    _attr_native_min_value = 0
    _attr_native_max_value = 100
    _attr_native_step = 1
    _attr_native_unit_of_measurement = PERCENTAGE

    def __init__(self, hass, uid, name, device):
        super().__init__(hass, uid, name, device)
        self._attr_native_value = 100.0
        self._attr_available = True

    async def async_set_native_value(self, value):
        self.hass.data["hr_fake"]["calls"].append({"service": "number.set_value", "data": {"entity_id": self.entity_id, "value": value}})
        self._attr_native_value = value
        self.async_write_ha_state()

    def fake_set(self, state, attributes):
        """'unavailable' takes it away (radio gone), a number sets it."""
        if state == "unavailable":
            self._attr_available = False
        else:
            self._attr_available = True
            self._attr_native_value = float(state)
        self.async_write_ha_state()
