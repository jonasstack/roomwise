"""From the two earlier integrations to roomwise (up to 0.1.0-beta.2 the card's companion `floorplan_card` and
Hausregeln `house_rules` were installed separately).

On every setup of the roomwise entry:
  * Is one of the old integrations still installed (its folder in custom_components/)? Then roomwise does not
    start at all – both would answer the same websocket commands, read the same storage files and switch the same
    lights. A hint in Settings → Repairs offers to fix it: the old folders are moved (not deleted) to
    <config>/roomwise-alte-ordner/, then Home Assistant restarts (repairs.py; the config flow offers the same when
    roomwise is added). The old integration entries are never deleted here: deleting those runs their uninstall,
    which deletes the stored settings. HACS leaves the old `floorplan_card` folder behind when updating from
    0.1.0-beta.3 or earlier, so this is the usual case.
  * Folders gone, but an old integration still loaded (no restart yet): nothing starts either, a hint offers the
    restart.
  * Old folders gone, old entries still there: their entities move to roomwise with entity id and unique id
    unchanged (automations, dashboards and history keep working), their device too; then the old entries are
    removed – their integration can no longer be loaded, so nothing of theirs runs on removal and the stored
    settings stay. The storage files are shared anyway (same keys: house_rules*, floorplan_card*).
"""

from __future__ import annotations

import logging
import os
import shutil
from datetime import datetime

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er, issue_registry as ir

from .const import DOMAIN, OLD_DOMAINS

_LOGGER = logging.getLogger(__name__)
ISSUE = "old_integrations"
RESTART_ISSUE = "restart_needed"
# where the old folders go (inside the config folder, outside custom_components – nothing loads them there)
ARCHIVE = "roomwise-alte-ordner"


def _folder(hass: HomeAssistant, domain: str) -> str:
    return hass.config.path("custom_components", domain)


async def _installed(hass: HomeAssistant) -> list[str]:
    """The old integrations whose folder is still there"""
    def check() -> list[str]:
        return [d for d in OLD_DOMAINS if os.path.isdir(_folder(hass, d))]

    return await hass.async_add_executor_job(check)


async def old_folders(hass: HomeAssistant) -> list[str]:
    """For the config flow: the old integrations whose folder is still there"""
    return await _installed(hass)


def _loaded(hass: HomeAssistant) -> list[str]:
    """Old integrations still running from before (their folder was removed, Home Assistant not restarted yet)"""
    return [d for d in OLD_DOMAINS if d in hass.config.components]


async def move_old_folders(hass: HomeAssistant) -> list[str]:
    """Moves the old folders to <config>/roomwise-alte-ordner/<domain>-<time>/ – nothing is deleted. Returns where
    they went. Raises OSError when a folder cannot be moved (no write permission …); what was moved stays moved."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    def move() -> list[str]:
        done = []
        for d in OLD_DOMAINS:
            src = _folder(hass, d)
            if not os.path.isdir(src):
                continue
            dest = hass.config.path(ARCHIVE, f"{d}-{stamp}")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.move(src, dest)
            done.append(dest)
        return done

    moved = await hass.async_add_executor_job(move)
    if moved:
        _LOGGER.warning("roomwise moved the old integration folder(s) to %s – restart Home Assistant", ", ".join(moved))
        ir.async_delete_issue(hass, DOMAIN, ISSUE)
    return moved


def restart_hint(hass: HomeAssistant) -> None:
    """The old folders are gone, Home Assistant still has to restart: a hint with a restart button"""
    ir.async_create_issue(hass, DOMAIN, RESTART_ISSUE, is_fixable=True, severity=ir.IssueSeverity.WARNING, translation_key=RESTART_ISSUE)


def restart_soon(hass: HomeAssistant) -> None:
    """Restart Home Assistant once the dialog that asked for it has closed"""
    async def go() -> None:
        await hass.services.async_call("homeassistant", "restart", blocking=False)

    hass.loop.call_later(1, lambda: hass.async_create_task(go()))


async def async_prepare(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """True: roomwise may start (nothing old left, or just taken over). False: an old integration is still
    installed – nothing starts, the hint in Repairs says what to do."""
    if installed := await _installed(hass):
        folders = ", ".join(f"`custom_components/{d}`" for d in installed)
        ir.async_create_issue(
            hass, DOMAIN, ISSUE, is_fixable=True, severity=ir.IssueSeverity.ERROR, translation_key=ISSUE, translation_placeholders={"folders": folders}
        )
        _LOGGER.warning("roomwise does not start: the old integration(s) %s are still installed – fix it in Settings → Repairs", ", ".join(installed))
        return False
    ir.async_delete_issue(hass, DOMAIN, ISSUE)
    if loaded := _loaded(hass):
        restart_hint(hass)
        _LOGGER.warning("roomwise does not start yet: %s still runs from before – restart Home Assistant", ", ".join(loaded))
        return False
    ir.async_delete_issue(hass, DOMAIN, RESTART_ISSUE)
    old = [e for d in OLD_DOMAINS for e in hass.config_entries.async_entries(d)]
    if not old:
        return True
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    moved: list[str] = []
    for o in old:
        # the device first: an entity may only point to a device of its config entry
        for dev in dr.async_entries_for_config_entry(dev_reg, o.entry_id):
            dev_reg.async_update_device(dev.id, add_config_entry_id=entry.entry_id)
        for ent in er.async_entries_for_config_entry(ent_reg, o.entry_id):
            if ent.platform != "house_rules":
                continue  # the card part never had entities that live on (the former song sensors go with the entry)
            if ent_reg.async_get_entity_id(ent.domain, DOMAIN, ent.unique_id):
                continue  # already there (a second run)
            try:
                ent_reg.async_update_entity_platform(ent.entity_id, DOMAIN, new_config_entry_id=entry.entry_id)
                moved.append(ent.entity_id)
            except ValueError as err:
                _LOGGER.warning("roomwise could not take over %s: %s", ent.entity_id, err)
    for o in old:
        await hass.config_entries.async_remove(o.entry_id)
    _LOGGER.info("roomwise took over %s from %s (%d entities)", ", ".join(o.domain for o in old), ", ".join(o.title for o in old), len(moved))
    persistent_notification.async_create(
        hass,
        (
            "roomwise hat die früheren Integrationen „Grundriss-Karte“ und „Hausregeln“ übernommen: "
            f"Einstellungen, Regeln und {len(moved)} Entitäten (mit denselben Entitäts-IDs). Es ist nichts weiter zu tun."
        )
        if hass.config.language == "de"
        else (
            'roomwise took over the earlier integrations "Floorplan card" and "Hausregeln": settings, rules and '
            f"{len(moved)} entities (with the same entity ids). Nothing else to do."
        ),
        title="roomwise",
        notification_id="roomwise_migrated",
    )
    return True
