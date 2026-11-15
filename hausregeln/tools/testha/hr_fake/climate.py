from homeassistant.components.climate import ClimateEntity, ClimateEntityFeature, HVACAction, HVACMode
from homeassistant.const import UnitOfTemperature

from .common import Fake

# heizung_kueche reports its valve as attribute valve_position (like Z2M / Tuya TRVs),
# heizung_bad as pi_heating_demand (Danfoss Ally / Bosch), heizung_wohnzimmer has a separate valve sensor
# and a calibration number on the same device (see sensor.py / number.py); heizung_buero is like a Sonoff TRVZB:
# no valve reading, but writable valve_opening_degree / valve_closing_degree numbers (number.py), and its room
# temperature can come from the thermal room model (thermal.py)
VALVE_ATTR = {"heizung_kueche": "valve_position", "heizung_bad": "pi_heating_demand"}


async def async_setup_entry(hass, entry, add):
    add([
        FakeClimate(hass, "heizung_kueche", "Heizung Küche"),
        FakeClimate(hass, "heizung_bad", "Heizung Bad"),
        FakeClimate(hass, "heizung_wohnzimmer", "Heizung Wohnzimmer", "Thermostat Wohnzimmer"),
        FakeClimate(hass, "heizung_buero", "Heizung Büro", "Thermostat Büro"),
    ])


class FakeClimate(Fake, ClimateEntity):
    platform_domain = "climate"
    _attr_hvac_modes = [HVACMode.OFF, HVACMode.HEAT]
    _attr_supported_features = ClimateEntityFeature.TARGET_TEMPERATURE | ClimateEntityFeature.TURN_OFF | ClimateEntityFeature.TURN_ON
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_target_temperature_step = 0.5
    _attr_min_temp = 5
    _attr_max_temp = 30

    def __init__(self, hass, uid, name, device=None):
        super().__init__(hass, uid, name, device)
        self._uid = uid
        self._attr_hvac_mode = HVACMode.HEAT
        self._attr_target_temperature = 21.0
        self._attr_current_temperature = 20.0
        self._valve = 0
        self._window_open = None
        self._action = None
        self._sim = None  # (valve %, open) while the thermal room model drives this thermostat

    def sim_update(self, temp, valve, is_open):
        """From the thermal room model: room temperature, valve; True when something changed."""
        new = (valve, is_open)
        if self._attr_current_temperature == temp and self._sim == new:
            return False
        self._attr_current_temperature = temp
        self._sim = new
        return True

    @property
    def hvac_action(self):
        if self._action:
            return HVACAction(self._action)
        if self._sim is not None and self._attr_hvac_mode != HVACMode.OFF:
            return HVACAction.HEATING if self._sim[1] else HVACAction.IDLE
        if self._attr_hvac_mode == HVACMode.OFF:
            return HVACAction.OFF
        return HVACAction.HEATING if (self._attr_target_temperature or 0) > (self._attr_current_temperature or 0) + 0.2 else HVACAction.IDLE

    @property
    def extra_state_attributes(self):
        out = {}
        if self._uid in VALVE_ATTR:
            out[VALVE_ATTR[self._uid]] = self._valve
        if self._window_open is not None:
            out["window_open"] = self._window_open
        if self._sim is not None:
            out["sim_valve"] = self._sim[0]
        return out

    # like a battery thermostat (Zigbee, sleepy): it takes a new target at once, but reports it this much later (seconds)
    _latency = 0.0

    def _report(self):
        if self._latency:
            self.hass.loop.call_later(self._latency, self.async_write_ha_state)
        else:
            self.async_write_ha_state()

    async def async_set_hvac_mode(self, hvac_mode):
        self._attr_hvac_mode = hvac_mode
        self._report()

    async def async_set_temperature(self, **kw):
        self._attr_target_temperature = kw["temperature"]
        self._report()

    async def async_turn_off(self):
        await self.async_set_hvac_mode(HVACMode.OFF)

    async def async_turn_on(self):
        await self.async_set_hvac_mode(HVACMode.HEAT)

    def fake_set(self, state, attributes):
        """state = hvac mode; attributes: temperature, current_temperature, valve, window_open, hvac_action, latency"""
        if "latency" in attributes:
            self._latency = float(attributes["latency"] or 0)
        self._attr_hvac_mode = HVACMode(state)
        if "temperature" in attributes:
            self._attr_target_temperature = attributes["temperature"]
        if "current_temperature" in attributes:
            self._attr_current_temperature = attributes["current_temperature"]
        if "valve" in attributes:
            self._valve = attributes["valve"]
        if "window_open" in attributes:
            self._window_open = attributes["window_open"]
        if "hvac_action" in attributes:
            self._action = attributes["hvac_action"]
        self.async_write_ha_state()
