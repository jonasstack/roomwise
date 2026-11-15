"""Repairs of roomwise: the fix flows of Hausregeln (house_rules/repairs.py), and the two of the switch from the
earlier integrations (migrate.py):
  * old_integrations: the old folders are still there – "Fix" moves them away (nothing is deleted) and restarts
  * restart_needed: they are gone, Home Assistant still has to restart – "Fix" restarts."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import data_entry_flow
from homeassistant.components.repairs import RepairsFlow
from homeassistant.core import HomeAssistant

from . import migrate
from .house_rules.repairs import async_create_fix_flow as _house_rules_fix_flow


class OldFoldersFlow(RepairsFlow):
    """Move the old integration folders out of custom_components, then (if wanted) restart"""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> data_entry_flow.FlowResult:
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
                return self.async_create_entry(data={})
        folders = ", ".join(f"`custom_components/{d}`" for d in await migrate.old_folders(self.hass)) or "–"
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({vol.Optional("restart", default=True): bool}),
            description_placeholders={"folders": folders},
            errors=errors,
        )


class RestartFlow(RepairsFlow):
    """Only the restart that is still missing"""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> data_entry_flow.FlowResult:
        if user_input is not None:
            migrate.restart_soon(self.hass)
            return self.async_create_entry(data={})
        return self.async_show_form(step_id="init", data_schema=vol.Schema({}))


async def async_create_fix_flow(hass: HomeAssistant, issue_id: str, data: dict[str, Any] | None) -> RepairsFlow:
    if issue_id == migrate.ISSUE:
        return OldFoldersFlow()
    if issue_id == migrate.RESTART_ISSUE:
        return RestartFlow()
    return await _house_rules_fix_flow(hass, issue_id, data)
