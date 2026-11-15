"""Config flow: one click, nothing to fill in, one entry (the card and Hausregeln are set up in their own UI).

Are the folders of the earlier integrations still there (HACS leaves `floorplan_card` behind when updating from
0.1.0-beta.3 or earlier), a step first offers to move them away and restart (migrate.py) – otherwise roomwise
would be added but not start."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from . import migrate
from .const import DOMAIN


class RoomwiseConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set up roomwise."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if await migrate.old_folders(self.hass):
            return await self.async_step_old_folders()
        if user_input is not None:
            return self.async_create_entry(title="roomwise", data={})
        return self.async_show_form(step_id="user")

    async def async_step_old_folders(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """The old folders are still there: move them away (nothing is deleted), add roomwise, restart"""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                await migrate.move_old_folders(self.hass)
            except OSError:
                errors["base"] = "move_failed"
            else:
                if user_input.get("restart", True):
                    migrate.restart_soon(self.hass)
                else:
                    migrate.restart_hint(self.hass)
                return self.async_create_entry(title="roomwise", data={})
        folders = ", ".join(f"`custom_components/{d}`" for d in await migrate.old_folders(self.hass)) or "–"
        return self.async_show_form(
            step_id="old_folders",
            data_schema=vol.Schema({vol.Optional("restart", default=True): bool}),
            description_placeholders={"folders": folders},
            errors=errors,
        )
