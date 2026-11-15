"""Fix flows for the hints in Home Assistant's Repairs panel (issues.py): replace a missing or long unavailable
device with another one everywhere Hausregeln uses it."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import data_entry_flow
from homeassistant.components.repairs import ConfirmRepairFlow, RepairsFlow
from homeassistant.core import HomeAssistant
from homeassistant.helpers import selector

from .const import DOMAIN


class ReplaceEntityFlow(RepairsFlow):
    def __init__(self, data: dict[str, Any]) -> None:
        self.entity_id = str(data["entity_id"])
        self.placeholders = {k: str(v) for k, v in data.items() if k in ("entity_id", "used_in", "hours")}

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> data_entry_flow.FlowResult:
        core = self.hass.data.get(DOMAIN)
        errors: dict[str, str] = {}
        if user_input is not None:
            new = str(user_input.get("replacement") or "")
            if core is None:
                return self.async_abort(reason="not_loaded")
            if not new or new == self.entity_id or self.hass.states.get(new) is None:
                errors["replacement"] = "invalid_entity"
            else:
                core.issues.replace_entity(self.entity_id, new)
                return self.async_create_entry(data={})
        domain = self.entity_id.split(".")[0]
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({vol.Required("replacement"): selector.EntitySelector(selector.EntitySelectorConfig(domain=domain))}),
            description_placeholders={"used_in": "", "hours": "", **self.placeholders},
            errors=errors,
        )


async def async_create_fix_flow(hass: HomeAssistant, issue_id: str, data: dict[str, Any] | None) -> RepairsFlow:
    if data and isinstance(data.get("entity_id"), str):
        return ReplaceEntityFlow(data)
    return ConfirmRepairFlow()
