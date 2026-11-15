"""Config flow: one click, nothing to fill in, one entry (the card and Hausregeln are set up in their own UI)."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN


class RoomwiseConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set up roomwise."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            return self.async_create_entry(title="roomwise", data={})
        return self.async_show_form(step_id="user")
