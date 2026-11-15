"""Hausregeln: simple, understandable automations written as sentences.

Sets up the engine, the websocket API, the sidebar panel ("Hausregeln") and the entities
(a switch per rule, the house mode, an occupancy sensor per room).
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import voluptuous as vol

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import Unauthorized
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.service import async_register_admin_service
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN, FRONTEND_URL, PANEL_JS, PANEL_URL_PATH, PLATFORMS, VERSION
from .core import HouseRules
from .i18n import tr
from .permissions import allowed
from .websocket import PAUSE_MINUTES, async_register

_LOGGER = logging.getLogger(__name__)
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
FRONTEND_DIR = Path(__file__).parent / "frontend"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    async_register(hass)
    return True


async def _register_frontend(hass: HomeAssistant) -> None:
    key = f"{DOMAIN}_static"
    if not hass.data.get(key):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(FRONTEND_URL, str(FRONTEND_DIR), False), StaticPathConfig("/house_rules_sounds", str(Path(__file__).parent / "sounds"), True)]
        )
        hass.data[key] = True
    js = FRONTEND_DIR / PANEL_JS

    def _stamp() -> int:
        try:
            return int(js.stat().st_mtime)
        except OSError:
            return int(time.time())

    stamp = await hass.async_add_executor_job(_stamp)  # file system: off the event loop
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name="house-rules-panel",
        sidebar_title=tr(hass, "app.name"),
        sidebar_icon="mdi:home-lightning-bolt-outline",
        module_url=f"{FRONTEND_URL}/{PANEL_JS}?v={VERSION}-{stamp}",
        embed_iframe=False,
        require_admin=False,
        config={"version": VERSION},
    )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    from .i18n import texts  # noqa: PLC0415
    from .vocab import vocabulary  # noqa: PLC0415

    await hass.async_add_executor_job(vocabulary)  # read the JSON files once, off the event loop
    await hass.async_add_executor_job(texts)
    core = HouseRules(hass, entry)
    hass.data[DOMAIN] = core
    await core.async_start()
    await _register_frontend(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    async def _check(call: ServiceCall, need: str) -> None:
        """The actions follow the roles too (a call from an automation or script has no user)."""
        if call.context.user_id:
            user = await hass.auth.async_get_user(call.context.user_id)
            if user is not None and not allowed(hass, user, need):
                raise Unauthorized(context=call.context, permission=need)

    async def _run(call: ServiceCall) -> None:
        await _check(call, "guest")
        if call.context.user_id and core.sensitive(call.data["rule_id"]):
            user = await hass.auth.async_get_user(call.context.user_id)
            if not allowed(hass, user, "admin"):
                raise Unauthorized(context=call.context, permission="admin")
        await core.engine.run_now(call.data["rule_id"], parent=call.context)

    async def _pause(call: ServiceCall) -> None:
        await _check(call, "resident")
        minutes = float(call.data.get("minutes", 60))
        await core.pause_rule(call.data["rule_id"], time.time() + minutes * 60 if minutes else None)

    hass.services.async_register(DOMAIN, "run", _run, schema=vol.Schema({vol.Required("rule_id"): cv.string}))
    hass.services.async_register(DOMAIN, "pause", _pause, schema=vol.Schema({vol.Required("rule_id"): cv.string, vol.Optional("minutes", default=60): PAUSE_MINUTES}))

    async def _reset_pin(call: ServiceCall) -> None:
        core.alarm.reset_pin(remove_pin=call.data.get("remove_pin", False), by="Über die Aktion house_rules.reset_alarm_pin")

    # admins only (Entwicklerwerkzeuge → Aktionen, or the REST API with a token from the command line)
    async_register_admin_service(hass, DOMAIN, "reset_alarm_pin", _reset_pin, schema=vol.Schema({vol.Optional("remove_pin", default=False): cv.boolean}))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    core: HouseRules | None = hass.data.pop(DOMAIN, None)
    if core:
        await core.async_stop()
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    for svc in ("run", "pause", "reset_alarm_pin"):
        hass.services.async_remove(DOMAIN, svc)
    return ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """The integration is deleted (not only disabled or reloaded): remove what it stored (uninstall.py)."""
    from .uninstall import remove_everything  # noqa: PLC0415

    removed = await remove_everything(hass)
    _LOGGER.info("Hausregeln removed: %s", ", ".join(removed))
