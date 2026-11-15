"""Config flow: one click, nothing to fill in (the card configures everything). Options: the AcoustID API key for
song recognition (optional; none is shipped) and, for a self-hosted AcoustID server, its lookup URL."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback

from .const import DOMAIN
from .songs import ACOUSTID_URL, CONF_ACOUSTID_KEY, CONF_ACOUSTID_URL


class FloorplanCardConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set up the companion."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            return self.async_create_entry(title="Floorplan card (Grundriss-Karte)", data={})
        return self.async_show_form(step_id="user")

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return FloorplanCardOptionsFlow()


class FloorplanCardOptionsFlow(OptionsFlow):
    """Song recognition: AcoustID API key (and optionally an own server)."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            key = str(user_input.get(CONF_ACOUSTID_KEY) or "").strip()
            url = str(user_input.get(CONF_ACOUSTID_URL) or "").strip()
            if key and not (6 <= len(key) <= 64 and key.isascii() and key.replace("-", "").replace("_", "").isalnum()):
                errors[CONF_ACOUSTID_KEY] = "invalid_key"
            if url and not url.startswith(("https://", "http://")):
                errors[CONF_ACOUSTID_URL] = "invalid_url"
            if not errors:
                return self.async_create_entry(data={k: v for k, v in ((CONF_ACOUSTID_KEY, key), (CONF_ACOUSTID_URL, url)) if v})
        opts = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Optional(CONF_ACOUSTID_KEY, description={"suggested_value": opts.get(CONF_ACOUSTID_KEY, "")}): str,
                vol.Optional(CONF_ACOUSTID_URL, description={"suggested_value": opts.get(CONF_ACOUSTID_URL, "")}): str,
            }
        )
        # links as placeholders (hassfest: no URLs inside translated texts)
        return self.async_show_form(
            step_id="init",
            data_schema=schema,
            errors=errors,
            description_placeholders={"signup_url": "https://acoustid.org/new-application", "lookup_url": ACOUSTID_URL},
        )
