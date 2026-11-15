"""One switch per rule: on = the rule is active. Lets dashboards, voice and other automations switch rules."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import slugify

from .const import DOMAIN
from .core import HouseRules
from .i18n import mode_label, tr

# i18n: complete (entity names in texts/entities.json; entity ids and states stay as they are)


def device_info(where: Any) -> DeviceInfo:
    """The one device all entities of Hausregeln belong to, named in the language of Home Assistant."""
    name = tr(where, "entity.device_name")
    return DeviceInfo(identifiers={(DOMAIN, "house_rules")}, name=name, manufacturer=name, model=tr(where, "entity.device_model"))


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    core: HouseRules = hass.data[DOMAIN]
    known: dict[str, RuleSwitch] = {}

    @callback
    def sync() -> None:
        ids = {r["id"] for r in core.rules()}
        new = [RuleSwitch(core, rid) for rid in ids if rid not in known]
        for e in new:
            known[e.rule_id] = e
        if new:
            async_add_entities(new)
        reg = er.async_get(hass)
        for rid in [r for r in known if r not in ids]:
            ent = known.pop(rid)
            if ent.entity_id and reg.async_get(ent.entity_id):
                reg.async_remove(ent.entity_id)
        for ent in known.values():
            if ent.hass:
                ent.async_write_ha_state()

    core.entity_hooks["rules"] = sync
    sync()
    master = AlarmEnabled(core)
    core.alarm.add_listener(callback(lambda _s: master.hass is not None and master.async_write_ha_state()))
    modes = [ModeSwitch(core, m) for m in ("sleep", "away", "vacation", "guests")]
    core.engine.on_mode(callback(lambda _m, _c: [e.async_write_ha_state() for e in modes if e.hass is not None]))
    async_add_entities([master, *modes])


MODE_ICONS = {"sleep": "mdi:bed-clock", "away": "mdi:walk", "vacation": "mdi:airplane", "guests": "mdi:account-group"}
MODE_IDS = {"sleep": "schlafen", "away": "weg", "vacation": "urlaub", "guests": "gaeste"}  # entity ids (a contract, not shown)


class ModeSwitch(SwitchEntity):
    """The house mode as on/off, e.g. switch.hausmodus_schlafen: on while the house sleeps; on = sleep, off = home."""

    _attr_has_entity_name = False
    _attr_should_poll = False

    def __init__(self, core: HouseRules, mode: str) -> None:
        self.core = core
        self.mode = mode
        self._attr_device_info = device_info(core)
        self._attr_name = tr(core, "entity.house_mode_switch", mode=mode_label(core, mode))
        self._attr_icon = MODE_ICONS[mode]
        self._attr_unique_id = f"house_mode_{mode}"
        self.entity_id = f"switch.hausmodus_{MODE_IDS[mode]}"

    @property
    def is_on(self) -> bool:
        return self.core.mode == self.mode

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.core.set_mode(self.mode, self._context or Context())
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        if self.core.mode == self.mode:
            await self.core.set_mode("home", self._context or Context())
        self.async_write_ha_state()


class AlarmEnabled(SwitchEntity):
    """Main switch of the alarm system: off = disarmed and does nothing."""

    _attr_has_entity_name = False
    _attr_icon = "mdi:shield-home-outline"
    _attr_unique_id = "alarm_enabled"
    _attr_should_poll = False

    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self._attr_device_info = device_info(core)
        self._attr_name = tr(core, "entity.alarm_enabled")
        self.entity_id = "switch.alarmanlage_aktiv"

    @property
    def is_on(self) -> bool:
        return bool(self.core.alarm.config.get("enabled"))

    async def async_turn_on(self, **kwargs: Any) -> None:
        self.core.alarm.save_config({"enabled": True})
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        # armed, counting down or in alarm: switching off would disarm without the confirmation (PIN / Face ID)
        if self.core.alarm.state != "disarmed":
            raise HomeAssistantError(tr(self.core, "entity.err_armed_off"))
        self.core.alarm.save_config({"enabled": False})
        self.async_write_ha_state()


class RuleSwitch(SwitchEntity):
    _attr_has_entity_name = False
    _attr_icon = "mdi:script-text-play-outline"

    def __init__(self, core: HouseRules, rule_id: str) -> None:
        self.core = core
        self._attr_device_info = device_info(core)
        self.rule_id = rule_id
        self._attr_unique_id = f"rule_{rule_id}"
        rule = next((r for r in core.rules() if r["id"] == rule_id), None)
        # (cut to 60 characters: never ending in "_", Home Assistant rejects such an entity id)
        self.entity_id = f"switch.hausregel_{slugify(rule['name'] if rule else rule_id)[:60].rstrip('_') or rule_id}"
        self._attr_should_poll = False

    @property
    def _rule(self) -> dict[str, Any] | None:
        return next((r for r in self.core.rules() if r["id"] == self.rule_id), None)

    @property
    def name(self) -> str:
        r = self._rule
        return tr(self.core, "entity.rule", name=r["name"] if r else self.rule_id)

    @property
    def available(self) -> bool:
        return self._rule is not None

    @property
    def is_on(self) -> bool:
        r = self._rule
        return bool(r and r.get("enabled", True))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        r = self._rule or {}
        return {
            "rule_id": self.rule_id,
            "sentence": self.core.describer.sentence(r) if r else "",
            "type": r.get("type"),
            "last_run": r.get("meta", {}).get("last_run"),
            "paused_until": r.get("paused_until"),
            "active": self.core.engine.is_active(self.rule_id),
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.core.set_enabled(self.rule_id, True)
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.core.set_enabled(self.rule_id, False)
        self.async_write_ha_state()
