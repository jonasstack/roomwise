from homeassistant.components.switch import SwitchDeviceClass, SwitchEntity

from .common import Fake


async def async_setup_entry(hass, entry, add):
    add([FakeSwitch(hass, "wasserkocher", "Wasserkocher", device_class=SwitchDeviceClass.OUTLET), FakeSwitch(hass, "tablet_bildschirm", "Tablet Bildschirm"), FakeSwitch(hass, "sirene", "Sirene Flur"), FakeSwitch(hass, "heizkessel", "Heizkessel")])


class FakeSwitch(Fake, SwitchEntity):
    platform_domain = "switch"

    def __init__(self, hass, uid, name, **kw):
        super().__init__(hass, uid, name, **kw)
        self._attr_is_on = False

    async def async_turn_on(self, **kw):
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kw):
        self._attr_is_on = False
        self.async_write_ha_state()

    def fake_set(self, state, attributes):
        self._attr_is_on = state == "on"
        self.async_write_ha_state()
