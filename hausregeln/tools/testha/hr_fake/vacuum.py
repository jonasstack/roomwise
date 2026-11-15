from homeassistant.components.vacuum import StateVacuumEntity, VacuumActivity, VacuumEntityFeature as F

from .common import Fake


async def async_setup_entry(hass, entry, add):
    add([FakeVacuum(hass, "robo", "Robo"), FakeVacuum(hass, "robo_oben", "Robo oben")])


class FakeVacuum(Fake, StateVacuumEntity):
    platform_domain = "vacuum"
    _attr_supported_features = F.START | F.RETURN_HOME | F.STATE

    def __init__(self, hass, uid, name):
        super().__init__(hass, uid, name)
        self._attr_activity = VacuumActivity.DOCKED

    async def async_start(self):
        self._attr_activity = VacuumActivity.CLEANING
        self.async_write_ha_state()

    async def async_return_to_base(self, **kw):
        self._attr_activity = VacuumActivity.DOCKED
        self.async_write_ha_state()

    def fake_set(self, state, attributes):
        self._attr_activity = VacuumActivity(state)
        self.async_write_ha_state()
