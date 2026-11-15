"""Clean removal: what Hausregeln leaves behind when the integration is deleted (async_remove_entry).

Only on deleting – disabling or reloading keeps everything. Home Assistant itself removes the entities and the
device of the config entry; async_unload_entry already removed the panel and the actions. Here:
  * every storage file of Hausregeln (rules, history, habits, smart heating, diagnostics, rule versions),
  * the hints in Settings → Repairs,
  * the server data of the anonymous diagnostics (if they were ever on, best effort),
  * the messages Hausregeln left on phones (alarm, window warning; by their tag, silently).
Hausregeln registers no notification categories, helpers or dashboard resources, so there is nothing more.
"""

from __future__ import annotations

import logging

from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.storage import Store

from .const import INTEGRATION, STORAGE_KEY, STORAGE_KEY_HISTORY, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)

# every Store of Hausregeln (key, version); telemetry is handled by telemetry.forget_install
STORES = (
    (STORAGE_KEY, STORAGE_VERSION),
    (STORAGE_KEY_HISTORY, STORAGE_VERSION),
    ("house_rules.habits", 1),
    ("house_rules.smart_heat", 1),
    ("house_rules.versions", 1),
)
PHONE_TAGS = ("house_rules_alarm", "house_rules_window_warning")


async def remove_everything(hass: HomeAssistant) -> list[str]:
    """Returns what was removed (for the log)."""
    from .telemetry import forget_install  # noqa: PLC0415

    done: list[str] = []
    for key, version in STORES:
        store: Store = Store(hass, version, key)
        await store.async_remove()
        done.append(key)
    try:
        await forget_install(hass)
        done.append("house_rules.telemetry")
    except Exception as err:  # noqa: BLE001 — removal must go on
        _LOGGER.debug("telemetry not removed: %s", err)
    reg = ir.async_get(hass)
    for domain, issue_id in [k for k in reg.issues if k[0] == INTEGRATION]:
        ir.async_delete_issue(hass, domain, issue_id)
        done.append(f"repairs:{issue_id}")
    for service in hass.services.async_services_for_domain("notify"):
        if not service.startswith("mobile_app_"):
            continue
        for tag in PHONE_TAGS:
            try:
                await hass.services.async_call("notify", service, {"message": "clear_notification", "data": {"tag": tag}}, blocking=False)
            except Exception:  # noqa: BLE001
                _LOGGER.debug("could not clear %s on %s", tag, service)
    return done
