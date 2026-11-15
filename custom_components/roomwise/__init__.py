"""roomwise: the floor plan card and Hausregeln in one integration.

One HACS package, one config entry (nothing to fill in). It holds two parts:
  * card/        the card's server side (formerly the companion integration `floorplan_card`): serves the card to
                 every dashboard, front door warning, walks, robot vacuum, shared plans, Wi-Fi QR codes,
  * house_rules/ Hausregeln (formerly the integration `house_rules`): rules, rooms, house mode, light and heating
                 plans, alarm, the sidebar panel and the entities (switch, select, binary_sensor, sensor,
                 alarm_control_panel – the platform files here hand over to it).
Both keep their websocket commands (floorplan_card/…, house_rules/…), events and storage files, so the card, the
panel and stored data work as before. Installations of the two old integrations are taken over (migrate.py).
"""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from . import card, house_rules
from .const import DOMAIN
from .migrate import async_prepare

_LOGGER = logging.getLogger(__name__)
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if not await async_prepare(hass, entry):
        return True  # an old integration is still installed: nothing runs, Settings → Repairs says what to do
    hass.data[DOMAIN] = entry.entry_id
    await card.async_setup_entry(hass, entry)
    await house_rules.async_setup_entry(hass, entry)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if hass.data.pop(DOMAIN, None) is None:
        return True  # never started
    ok = await house_rules.async_unload_entry(hass, entry)
    await card.async_unload_entry(hass, entry)
    return ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """roomwise is deleted (not only disabled or reloaded): both parts remove what they stored."""
    await card.async_remove_entry(hass, entry)
    await house_rules.async_remove_entry(hass, entry)
