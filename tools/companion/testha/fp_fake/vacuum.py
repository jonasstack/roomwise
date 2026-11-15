from homeassistant.components.vacuum import StateVacuumEntity, VacuumActivity, VacuumEntityFeature as F
from homeassistant.helpers.device_registry import DeviceInfo

NAMES = {"dreame": "Demo Dreame", "valetudo": "Demo Valetudo"}


def device(key: str) -> DeviceInfo:
    return DeviceInfo(identifiers={("fp_fake", key)}, name=NAMES[key], manufacturer="Demo", model=f"{key}-like test robot")


async def async_setup_entry(hass, entry, add):
    robots = hass.data["fp_fake"]["robots"]
    add([FakeVacuum(robots[k], k) for k in ("dreame", "valetudo")])


class FakeVacuum(StateVacuumEntity):
    """A robot of the demo flat; no CLEAN_AREA, so the card offers the rooms of its own map"""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_supported_features = F.START | F.PAUSE | F.STOP | F.RETURN_HOME | F.STATE

    def __init__(self, robot, key):
        self.robot = robot
        self._attr_unique_id = f"fp_fake_{key}"
        self._attr_device_info = device(key)
        self.entity_id = f"vacuum.demo_{key}"

    async def async_added_to_hass(self):
        self.robot.listeners.append(self._changed)

    def _changed(self):
        self.async_write_ha_state()

    @property
    def activity(self):
        return VacuumActivity(self.robot.state)

    async def async_start(self):
        self.robot.set("cleaning")

    async def async_pause(self):
        self.robot.set("paused")

    async def async_stop(self, **kw):
        self.robot.set("paused")

    async def async_return_to_base(self, **kw):
        self.robot.set("docked")
