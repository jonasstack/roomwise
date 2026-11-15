"""Grundriss-Karte (floorplan card) — companion integration.

One HACS package: it serves the card itself (no dashboard resource to add by hand) and runs what has to work
without any tablet:
  * the front door warning (announcement, flashing lights, acknowledged by a switch or a tap on a tablet),
  * walk check-offs of the dogs, shared by every device,
  * shared floor plans (one plan on several dashboards) and the editor's trace images,
  * the home's Wi-Fi networks for the QR codes on the tablets (wifi.py, kept out of the dashboard config).

Everything else is configured from the card's own editor. It creates no automations, helpers or entities.
"""

from __future__ import annotations

from collections.abc import Callable
import datetime as dt
import hashlib
import logging
from pathlib import Path
import re
from typing import Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv, entity_registry as er, issue_registry as ir
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, STORAGE_KEY, STORAGE_VERSION, VERSION
from .entry_alert import EntryAlert, sanitize
from .pets import ACTION_PREFIX, PetTracker, sanitize_pets
from .plans import PlanStore
from .vacuum import VacuumTracker, sanitize_vacuums
from .wifi import WifiStore
from .websocket import async_register_commands

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

FRONTEND_URL = "/floorplan_card_files"
LOADER_URL = "/floorplan_card_loader.js"
FRONTEND_DIR = Path(__file__).parent / "frontend"
# walk check-offs of one day (any user may send them): at most this many pets in all, slots per pet
MAX_WALK_KEYS = 200
MAX_WALK_SLOTS = 48


class FloorplanData:
    """Stored settings per card (by its card_id) and the running warnings."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.cards: dict[str, dict[str, Any]] = {}
        # "card_id|pet_id" → {"date": "YYYY-MM-DD", "slots": [...]}
        self.walks: dict[str, dict[str, Any]] = {}
        self.alerts: dict[str, EntryAlert] = {}
        self.trackers: dict[str, PetTracker] = {}
        # reminders already sent today: "card_id" → pet id → {...}
        self.reminded: dict[str, dict[str, Any]] = {}
        self.walk_listeners: set[Callable[[str], None]] = set()
        self.alert_listeners: set[Callable[[str], None]] = set()
        self.pet_listeners: set[Callable[[str], None]] = set()
        self.vacuums: dict[str, VacuumTracker] = {}
        # robot coordinates the vacuums taught us: entity → {...}
        self.learned: dict[str, Any] = {}
        # the current run's trail per vacuum entity (kept across restarts: a tablet loading mid-run shows it all)
        self.paths: dict[str, Any] = {}
        self.vacuum_listeners: set[Callable[[str], None]] = set()
        # shared floor plans and trace images (own storage files)
        self.plans = PlanStore(hass)
        # the home's Wi-Fi networks (QR codes on the tablets; own storage file)
        self.wifi = WifiStore(hass)
        self.entry: ConfigEntry | None = None
        self._unsub_action: Callable[[], None] | None = None

    async def async_load(self) -> None:
        data = await self.store.async_load() or {}
        await self.plans.async_load()
        await self.wifi.async_load()
        self.cards = data.get("cards", {})
        self.walks = data.get("walks", {})
        self.reminded = data.get("reminded", {})
        self.learned = data.get("learned", {})
        self.paths = data.get("paths", {})
        # "songs" of the former song recognition (removed) is dropped with the next save
        for card_id, card in self.cards.items():
            if card.get("entry_alert"):
                self._arm(card_id, card["entry_alert"])
            if card.get("pets"):
                await self._track(card_id, card["pets"])
            if card.get("vacuums"):
                await self._track_vacuums(card_id, card["vacuums"])
        # "Done" in a phone notification
        self._unsub_action = self.hass.bus.async_listen("mobile_app_notification_action", self._notification_action)

    def _save(self) -> None:
        self.store.async_delay_save(self.stored, 5)

    def stored(self) -> dict[str, Any]:
        return {"cards": self.cards, "walks": self.walks, "reminded": self.reminded, "learned": self.learned, "paths": self.paths}

    def _arm(self, card_id: str, cfg: dict[str, Any]) -> None:
        old = self.alerts.pop(card_id, None)
        if old:
            old.stop()
        alert = EntryAlert(self.hass, card_id, cfg, self._alert_changed)
        alert.start()
        self.alerts[card_id] = alert

    @callback
    def _alert_changed(self, card_id: str) -> None:
        for listener in list(self.alert_listeners):
            listener(card_id)

    def alert_state(self, card_id: str) -> dict[str, Any] | None:
        alert = self.alerts.get(card_id)
        return alert.state if alert else None

    # ---------- walks: state, reminders ----------

    async def _track(self, card_id: str, pets: list[dict[str, Any]]) -> None:
        old = self.trackers.pop(card_id, None)
        if old:
            old.stop()
        if not pets:
            return
        tracker = PetTracker(
            self.hass,
            card_id,
            pets,
            lambda pid: set(self.walks_today(card_id).get(pid, [])),
            self._pets_changed,
            self.reminded.setdefault(card_id, {}),
            self._save,
        )
        self.trackers[card_id] = tracker
        await tracker.async_start()

    @callback
    def _pets_changed(self, card_id: str) -> None:
        for listener in list(self.pet_listeners):
            listener(card_id)

    async def set_pets(self, card_id: str, pets: Any, sig: str) -> None:
        clean = sanitize_pets(pets)
        card = self.cards.setdefault(card_id, {})
        card["pets"] = clean
        card["pets_sig"] = sig
        await self._track(card_id, clean)
        self._save()

    def pet_states(self, card_id: str) -> dict[str, Any] | None:
        tracker = self.trackers.get(card_id)
        return tracker.states if tracker else None

    # ---------- robot vacuums ----------

    async def _track_vacuums(self, card_id: str, vacs: list[dict[str, Any]]) -> None:
        old = self.vacuums.pop(card_id, None)
        if old:
            old.stop()
        if not vacs:
            return
        tracker = VacuumTracker(self.hass, card_id, vacs, self.learned, self._save, self._vacuums_changed, self.paths)
        self.vacuums[card_id] = tracker
        await tracker.async_start()

    @callback
    def _vacuums_changed(self, card_id: str) -> None:
        for listener in list(self.vacuum_listeners):
            listener(card_id)

    async def set_vacuums(self, card_id: str, vacs: Any, sig: str) -> None:
        clean = sanitize_vacuums(vacs)
        card = self.cards.setdefault(card_id, {})
        card["vacuums"] = clean
        card["vacuums_sig"] = sig
        await self._track_vacuums(card_id, clean)
        self._save()

    def vacuum_states(self, card_id: str) -> dict[str, Any] | None:
        tracker = self.vacuums.get(card_id)
        return tracker.states if tracker else None

    def vacuum_learned(self, entity: str) -> dict[str, Any]:
        for tracker in self.vacuums.values():
            if any(v["entity"] == entity for v in tracker.vacuums):
                return tracker.learned(entity)
        return {"res": 100, "cells": [], "dock": None, "speed": None, "runs": 0}

    def vacuum_path(self, entity: str) -> dict[str, Any] | None:
        for tracker in self.vacuums.values():
            if any(v["entity"] == entity for v in tracker.vacuums):
                return tracker.path(entity)
        return None

    def vacuum_map_entity(self, entity: str) -> str | None:
        """The map entity picked for a vacuum in a card's editor (None: found automatically)"""
        for tracker in self.vacuums.values():
            for v in tracker.vacuums:
                if v["entity"] == entity and v.get("map"):
                    return v["map"]
        return None

    def vacuum_reset(self, entity: str) -> None:
        self.learned.pop(entity, None)
        self._save()

    @callback
    def _notification_action(self, event: Any) -> None:
        action = str(event.data.get("action", ""))
        if not action.startswith(f"{ACTION_PREFIX}|"):
            return
        parts = action.split("|")
        # any phone of the companion app can send this event with any content: same limits as the websocket command
        if len(parts) == 4 and all(0 < len(p) <= 80 for p in parts[1:3]) and re.fullmatch(r"\d{2}:\d{2}", parts[3]):
            self.walk_done(parts[1], parts[2], parts[3])

    # ---------- front door warning ----------

    def set_entry_alert(self, card_id: str, cfg: dict[str, Any], sig: str = "") -> None:
        clean = sanitize(cfg)
        self.cards.setdefault(card_id, {})["entry_alert"] = clean
        self.cards[card_id]["entry_alert_sig"] = sig
        self._arm(card_id, clean)
        self._save()

    def remove_entry_alert(self, card_id: str) -> None:
        alert = self.alerts.pop(card_id, None)
        if alert:
            alert.stop()
        if card_id in self.cards:
            self.cards[card_id].pop("entry_alert", None)
            self.cards[card_id].pop("entry_alert_sig", None)
            if not self.cards[card_id]:
                del self.cards[card_id]
        self._save()

    def acknowledge(self, card_id: str) -> bool:
        alert = self.alerts.get(card_id)
        if not alert or not alert.active:
            return False
        alert.acknowledge()
        return True

    # ---------- walks ----------

    def _today(self) -> str:
        return dt_util.now().date().isoformat()

    def walks_today(self, card_id: str) -> dict[str, list[str]]:
        today = self._today()
        out: dict[str, list[str]] = {}
        for key, v in self.walks.items():
            cid, _, pet = key.partition("|")
            if cid == card_id and v.get("date") == today:
                out[pet] = list(v.get("slots", []))
        return out

    def walk_done(self, card_id: str, pet_id: str, slot: str) -> None:
        today = self._today()
        key = f"{card_id}|{pet_id}"
        # old days are dropped
        for k in [k for k, v in self.walks.items() if v.get("date") != today]:
            del self.walks[k]
        if key not in self.walks and len(self.walks) >= MAX_WALK_KEYS:
            return  # any user can check off walks: the store stays small
        cur = self.walks.get(key) or {"date": today, "slots": []}
        if slot not in cur["slots"] and len(cur["slots"]) < MAX_WALK_SLOTS:
            cur["slots"] = sorted([*cur["slots"], slot])
        self.walks[key] = cur
        self._save()
        for listener in list(self.walk_listeners):
            listener(card_id)
        if card_id in self.trackers:
            self.trackers[card_id].evaluate()

    def walk_undo(self, card_id: str, pet_id: str, slot: str) -> None:
        cur = self.walks.get(f"{card_id}|{pet_id}")
        if cur and slot in cur.get("slots", []):
            cur["slots"] = [s for s in cur["slots"] if s != slot]
            self._save()
            for listener in list(self.walk_listeners):
                listener(card_id)
            if card_id in self.trackers:
                self.trackers[card_id].evaluate()

    def shutdown(self) -> None:
        for alert in self.alerts.values():
            alert.stop()
        self.alerts.clear()
        for tracker in self.trackers.values():
            tracker.stop()
        self.trackers.clear()
        for vt in self.vacuums.values():
            vt.stop()
        self.vacuums.clear()
        if self._unsub_action:
            self._unsub_action()


class LoaderView(HomeAssistantView):
    """Tiny loader, never cached: it imports the card with a version of the file's current state, so an
    update reaches every dashboard on its next load (no restart, no stale browser cache)."""

    url = LOADER_URL
    name = "floorplan_card:loader"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        js = FRONTEND_DIR / "floorplan-card.js"
        try:
            st = await request.app["hass"].async_add_executor_job(js.stat)
            ver = hashlib.sha1(f"{st.st_mtime_ns}:{st.st_size}".encode(), usedforsecurity=False).hexdigest()[:10]  # cache buster only
        except OSError:
            ver = VERSION
        body = f'import("{FRONTEND_URL}/floorplan-card.js?v={ver}");\n'
        return web.Response(text=body, content_type="text/javascript", headers={"Cache-Control": "no-cache"})


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the card from this package and load it on every dashboard (once per start)"""
    if hass.data.get(f"{DOMAIN}_frontend"):
        return
    present = await hass.async_add_executor_job((FRONTEND_DIR / "floorplan-card.js").is_file)
    if not present:
        # a broken install: say so in Settings → Repairs (the dashboards would only show "custom element doesn't exist")
        _LOGGER.warning("No bundled card found in %s", FRONTEND_DIR)
        ir.async_create_issue(hass, DOMAIN, "frontend_missing", is_fixable=False, severity=ir.IssueSeverity.ERROR, translation_key="frontend_missing")
        return
    ir.async_delete_issue(hass, DOMAIN, "frontend_missing")
    from homeassistant.components.frontend import add_extra_js_url
    from homeassistant.components.http import StaticPathConfig

    await hass.http.async_register_static_paths([StaticPathConfig(FRONTEND_URL, str(FRONTEND_DIR), False)])
    hass.http.register_view(LoaderView())
    add_extra_js_url(hass, LOADER_URL)
    hass.data[f"{DOMAIN}_frontend"] = True


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    async_register_commands(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    data = FloorplanData(hass)
    data.entry = entry
    await data.async_load()
    hass.data[DOMAIN] = data
    await _async_register_frontend(hass)
    # the song sensors of the former song recognition (removed): their registry entries would stay "unavailable"
    ent_reg = er.async_get(hass)
    for ent in er.async_entries_for_config_entry(ent_reg, entry.entry_id):
        if ent.domain == "sensor":
            ent_reg.async_remove(ent.entity_id)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    data: FloorplanData | None = hass.data.pop(DOMAIN, None)
    if data:
        data.shutdown()
        await data.store.async_save(data.stored())
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """The integration is deleted (not only disabled or reloaded): nothing of it stays behind.

    Removes the stored settings (warnings, walks, vacuum maps, shared plans and trace images, Wi-Fi networks), the hints in Settings → Repairs, the loader that
    puts the card on every dashboard, and dashboard resources that point to the card files this integration
    served (added by hand in earlier versions; they would only fail to load now). Dashboards keep their cards:
    they show "custom element doesn't exist" until the card is removed or the integration installed again."""
    await Store(hass, STORAGE_VERSION, STORAGE_KEY).async_remove()
    from .plans import IMAGES_KEY, PLANS_KEY, STORE_VERSION  # noqa: PLC0415 — shared plans and trace images go too

    from .wifi import WIFI_KEY  # noqa: PLC0415 — and the Wi-Fi networks with their passwords

    for key in (PLANS_KEY, IMAGES_KEY, WIFI_KEY):
        await Store(hass, STORE_VERSION, key).async_remove()
    reg = ir.async_get(hass)
    for domain, issue_id in [k for k in reg.issues if k[0] == DOMAIN]:
        ir.async_delete_issue(hass, domain, issue_id)
    if hass.data.pop(f"{DOMAIN}_frontend", None):
        from homeassistant.components.frontend import remove_extra_js_url

        remove_extra_js_url(hass, LOADER_URL)
    removed = await _remove_card_resources(hass)
    _LOGGER.info("Floorplan card companion removed (dashboard resources removed: %s)", removed)


async def _remove_card_resources(hass: HomeAssistant) -> int:
    """Dashboard resources (storage mode) whose URL points to files of this integration."""
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None) if lovelace is not None else None
    if resources is None and isinstance(lovelace, dict):
        resources = lovelace.get("resources")
    if resources is None or not hasattr(resources, "async_delete_item"):
        return 0  # YAML mode or an unknown layout: nothing we may change
    try:
        if not getattr(resources, "loaded", True):
            await resources.async_load()
            resources.loaded = True
        ours = [r for r in resources.async_items() if str(r.get("url", "")).split("?")[0].startswith((FRONTEND_URL + "/", LOADER_URL))]
        for r in ours:
            await resources.async_delete_item(r["id"])
    except Exception as err:  # noqa: BLE001 — removing the integration must not fail over a resource
        _LOGGER.warning("Could not remove the card's dashboard resource: %s", err)
        return 0
    return len(ours)


__all__ = ["FloorplanData", "VERSION", "dt", "callback"]
