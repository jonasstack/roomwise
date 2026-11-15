"""Diagnostics download of roomwise: the card part and Hausregeln, each pseudonymized by its own part."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .card.diagnostics import async_get_config_entry_diagnostics as card_diagnostics
from .const import VERSION
from .house_rules.diagnostics import async_get_config_entry_diagnostics as rules_diagnostics


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    return {"roomwise": VERSION, "card": await card_diagnostics(hass, entry), "house_rules": await rules_diagnostics(hass, entry)}
