from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass

from .common import CAR, Fake


async def async_setup_entry(hass, entry, add):
    T = dict(device_class=SensorDeviceClass.TEMPERATURE, native_unit_of_measurement="°C")
    add([
        FakeSensor(hass, "lux_flur", "Helligkeit Flur", 10, device_class=SensorDeviceClass.ILLUMINANCE, native_unit_of_measurement="lx"),
        FakeSensor(hass, "lux_diele", "Helligkeit Diele", 500, device_class=SensorDeviceClass.ILLUMINANCE, native_unit_of_measurement="lx"),
        FakeSensor(hass, "temp_bad", "Temperatur Bad", 21.0, **T),
        # heating tests
        FakeSensor(hass, "temp_wohnzimmer", "Temperatur Wohnzimmer", 21.0, **T),
        FakeSensor(hass, "temp_aussen", "Außentemperatur", 5.0, **T),
        FakeSensor(hass, "feuchte_bad", "Luftfeuchte Bad", 50.0, device_class=SensorDeviceClass.HUMIDITY, native_unit_of_measurement="%"),
        FakeSensor(hass, "co2_wohnzimmer", "CO2 Wohnzimmer", 600.0, device_class=SensorDeviceClass.CO2, native_unit_of_measurement="ppm"),
        FakeSensor(hass, "heizung_wohnzimmer_ventil", "Heizung Wohnzimmer Ventilposition", 0.0, "Thermostat Wohnzimmer", native_unit_of_measurement="%"),
        # like the companion app's geocoded location (same device as device_tracker.handy_robin)
        FakeText(hass, "handy_robin_geocoded_location", "Handy Robin Geocoded Location", "Unknown", "Handy Robin"),
        # like the companion app's activity sensor on Android (in_vehicle / on_bicycle / on_foot / still …)
        FakeText(hass, "handy_robin_detected_activity", "Handy Robin Detected Activity", "still", "Handy Robin"),
        # a gas meter for the heating cost estimate (energy dashboard)
        FakeSensor(hass, "demo_auto_kilometerstand", "Demo-Auto Kilometerstand", 12345.0, "Demo-Auto", device_class=SensorDeviceClass.DISTANCE, native_unit_of_measurement="km"),
        FakeSensor(hass, "demo_auto_reichweite", "Demo-Auto Reichweite", 300.0, "Demo-Auto", device_class=SensorDeviceClass.DISTANCE, native_unit_of_measurement="km"),
        FakeSensor(hass, "gaszaehler", "Gaszähler", 1000.0, device_class=SensorDeviceClass.GAS, native_unit_of_measurement="m³", state_class=SensorStateClass.TOTAL_INCREASING),
        # the test car (vehicle detection by its sensors and tracker)
        FakeSensor(hass, "testauto_reichweite", "Testauto Reichweite", 420.0, CAR, device_class=SensorDeviceClass.DISTANCE, native_unit_of_measurement="km"),
        FakeSensor(hass, "testauto_kilometerstand", "Testauto Kilometerstand", 12345.0, CAR, device_class=SensorDeviceClass.DISTANCE, native_unit_of_measurement="km"),
    ])


class FakeSensor(Fake, SensorEntity):
    platform_domain = "sensor"

    def __init__(self, hass, uid, name, value, device=None, **kw):
        super().__init__(hass, uid, name, device, **kw)
        self._attr_native_value = value

    def fake_set(self, state, attributes):
        def report():
            self._attr_native_value = float(state)
            self.async_write_ha_state()

        # like a Zigbee light sensor that reports late: the new value only after this many seconds
        if attributes.get("latency"):
            self.hass.loop.call_later(float(attributes["latency"]), report)
        else:
            report()


class FakeText(Fake, SensorEntity):
    platform_domain = "sensor"

    def __init__(self, hass, uid, name, value, device=None, **kw):
        super().__init__(hass, uid, name, device, **kw)
        self._attr_native_value = value

    def fake_set(self, state, attributes):
        self._attr_native_value = state
        self.async_write_ha_state()
