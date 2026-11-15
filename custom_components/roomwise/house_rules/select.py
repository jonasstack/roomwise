"""The house mode (Zuhause, Weg, Schlafen, Urlaub, Gäste) as a select entity."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, MODES
from .core import HouseRules
from .i18n import tr
from .switch import device_info

# i18n: complete (name in texts/entities.json)
# The options are a contract (automations set select.hausmodus to "Urlaub"): fixed, in every language.
OPTIONS = {"home": "Zuhause", "away": "Weg", "sleep": "Schlafen", "vacation": "Urlaub", "guests": "Gäste"}  # i18n-ignore
LABEL_TO_MODE = {v: k for k, v in OPTIONS.items()}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    core: HouseRules = hass.data[DOMAIN]
    ent = HouseModeSelect(core)
    core.entity_hooks["mode"] = callback(lambda: ent.hass and ent.async_write_ha_state())
    async_add_entities([ent])


class HouseModeSelect(SelectEntity):
    _attr_has_entity_name = False
    _attr_icon = "mdi:home-switch-outline"
    _attr_unique_id = "house_mode"
    _attr_should_poll = False
    _attr_options = [OPTIONS[m] for m in MODES]

    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self._attr_name = tr(core, "entity.house_mode")
        self._attr_device_info = device_info(core)
        self.entity_id = "select.hausmodus"

    @property
    def current_option(self) -> str:
        return OPTIONS[self.core.mode]

    async def async_select_option(self, option: str) -> None:
        mode = LABEL_TO_MODE.get(option, option)
        await self.core.set_mode(mode, self._context or Context())
        self.async_write_ha_state()
