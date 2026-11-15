"""The alarm system as a Home Assistant alarm panel (alarm_control_panel.alarmanlage), plus one panel per object alarm
(objects.py: bike, car, garage …), so dashboards and automations can use them."""

from __future__ import annotations

from homeassistant.components.alarm_control_panel import (
    AlarmControlPanelEntity,
    AlarmControlPanelEntityFeature,
    AlarmControlPanelState,
    CodeFormat,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import slugify

from .const import DOMAIN
from .core import HouseRules
from .i18n import tr
from .switch import device_info

# i18n: complete (texts in texts/entities.json)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    core: HouseRules = hass.data[DOMAIN]
    ent = HouseAlarm(core)
    core.alarm.add_listener(callback(lambda _s: ent.hass is not None and ent.async_write_ha_state()))
    async_add_entities([ent])
    known: dict[str, ObjectAlarmPanel] = {}

    @callback
    def sync() -> None:
        ids = {o["id"] for o in core.objects.objects}
        new = [ObjectAlarmPanel(core, oid) for oid in ids if oid not in known]
        for e in new:
            known[e.object_id] = e
        if new:
            async_add_entities(new)
        reg = er.async_get(hass)
        # panels of alarms that no longer exist (deleted while the registry was not saved, restored backup …)
        for e in er.async_entries_for_config_entry(reg, entry.entry_id):
            if e.domain == "alarm_control_panel" and e.unique_id.startswith("object_alarm_") and e.unique_id[13:] not in ids and e.unique_id[13:] not in known:
                reg.async_remove(e.entity_id)
        for oid in [o for o in known if o not in ids]:
            gone = known.pop(oid)
            if gone.entity_id and reg.async_get(gone.entity_id):
                reg.async_remove(gone.entity_id)
        for e in known.values():
            if e.hass is not None:
                e.async_write_ha_state()

    @callback
    def changed(oid: str | None) -> None:
        for k, e in known.items():
            if (oid is None or k == oid) and e.hass is not None:
                e.async_write_ha_state()

    core.entity_hooks["objects"] = sync
    core.objects.add_listener(changed)
    sync()


class HouseAlarm(AlarmControlPanelEntity):
    _attr_has_entity_name = False
    _attr_unique_id = "alarm"
    _attr_should_poll = False
    _attr_code_arm_required = False
    _attr_supported_features = AlarmControlPanelEntityFeature.ARM_AWAY | AlarmControlPanelEntityFeature.ARM_NIGHT | AlarmControlPanelEntityFeature.ARM_HOME | AlarmControlPanelEntityFeature.TRIGGER

    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self._attr_name = tr(core, "entity.alarm")
        self._attr_device_info = device_info(core)
        self.entity_id = "alarm_control_panel.alarmanlage"

    @property
    def available(self) -> bool:
        return self.core.alarm.started and bool(self.core.alarm.config.get("enabled"))

    @property
    def code_format(self) -> CodeFormat | None:
        cfg = self.core.alarm.config
        return CodeFormat.NUMBER if cfg.get("code_hash") and cfg.get("confirm") in ("pin", "device") else None

    @property
    def alarm_state(self) -> AlarmControlPanelState | None:
        return AlarmControlPanelState(self.core.alarm.state)

    @property
    def extra_state_attributes(self) -> dict:
        a = self.core.alarm
        return {"cause": a.cause, "cause_name": a.view()["cause_name"], "bypassed": a.bypassed, "until": a.until}

    async def _arm(self, mode: str) -> None:
        res = await self.core.alarm.arm(mode, force=True)
        if not res.get("ok"):
            raise HomeAssistantError(tr(self.core, "entity.err_arm", error=res.get("error")))

    async def async_alarm_arm_away(self, code: str | None = None) -> None:
        await self._arm("away")

    async def async_alarm_arm_night(self, code: str | None = None) -> None:
        await self._arm("night")

    async def async_alarm_arm_home(self, code: str | None = None) -> None:
        await self._arm("home")

    async def async_alarm_disarm(self, code: str | None = None) -> None:
        """Same confirmation as in the app: PIN when "PIN" / "Face ID" is set (Face ID itself is not possible here)."""
        who = (self._context.user_id if self._context else None) or "ha_alarm_panel"
        res = await self.core.alarm.disarm_confirmed(who=who, by=tr(self.core, "entity.by_ha_panel"), code=code)
        if not res["ok"]:
            errors = {
                "wrong_code": tr(self.core, "entity.err_wrong_code"),
                "locked": tr(self.core, "entity.err_locked", seconds=res.get("retry_in", 30)),
                "no_pin": tr(self.core, "entity.err_no_pin"),
            }
            raise HomeAssistantError(errors.get(res["error"], str(res["error"])))

    async def async_alarm_trigger(self, code: str | None = None) -> None:
        await self.core.alarm.trigger(None, manual=True)


OBJECT_STATES = {
    "disarmed": AlarmControlPanelState.DISARMED,
    "armed": AlarmControlPanelState.ARMED_AWAY,
    "pending": AlarmControlPanelState.PENDING,
    "triggered": AlarmControlPanelState.TRIGGERED,
}


class ObjectAlarmPanel(AlarmControlPanelEntity):
    """One object alarm ("Weitere Alarme"): arm = armed_away, disarm with the house alarm's confirmation."""

    _attr_has_entity_name = False
    _attr_should_poll = False
    _attr_code_arm_required = False
    _attr_supported_features = AlarmControlPanelEntityFeature.ARM_AWAY | AlarmControlPanelEntityFeature.TRIGGER

    def __init__(self, core: HouseRules, object_id: str) -> None:
        self.core = core
        self.object_id = object_id
        self._attr_unique_id = f"object_alarm_{object_id}"
        self._attr_device_info = device_info(core)
        # the entity id comes from the first name ("Alarm Fahrrad" → alarm_control_panel.alarm_fahrrad); renaming keeps it
        self._attr_name = f"Alarm {(core.objects.get(object_id) or {}).get('name', object_id)}"
        eid = f"alarm_control_panel.{slugify(self._attr_name)}"
        reg = er.async_get(core.hass).async_get(eid)
        # two alarms with the same name (or a foreign entity of that id): the object id makes it unique
        taken = (reg is not None and reg.unique_id != self._attr_unique_id) or (reg is None and core.hass.states.get(eid) is not None)
        self.entity_id = f"{eid}_{object_id}" if taken else eid

    @property
    def name(self) -> str:
        return f"Alarm {(self.core.objects.get(self.object_id) or {}).get('name', self.object_id)}"

    @property
    def icon(self) -> str | None:
        return (self.core.objects.get(self.object_id) or {}).get("icon")

    @property
    def available(self) -> bool:
        return self.core.objects.get(self.object_id) is not None

    @property
    def code_format(self) -> CodeFormat | None:
        return CodeFormat.NUMBER if self.core.objects.needs_code(self.object_id) else None

    @property
    def alarm_state(self) -> AlarmControlPanelState | None:
        st = (self.core.objects.state.get(self.object_id) or {}).get("state", "disarmed")
        return OBJECT_STATES.get(st, AlarmControlPanelState.DISARMED)

    @property
    def extra_state_attributes(self) -> dict:
        v = next((o for o in self.core.objects.view() if o["id"] == self.object_id), {})
        return {"object_id": self.object_id, "kind": v.get("kind"), "cause": v.get("cause"), "cause_name": v.get("cause_name"), "sensors": v.get("sensors", [])}

    async def async_alarm_arm_away(self, code: str | None = None) -> None:
        res = await self.core.objects.arm(self.object_id, by=tr(self.core, "entity.by_ha_panel"))
        if not res.get("ok"):
            raise HomeAssistantError(tr(self.core, "entity.err_no_sensors") if res.get("error") == "no_sensors" else str(res.get("error")))

    async def async_alarm_disarm(self, code: str | None = None) -> None:
        """The house alarm's PIN (with its lockout) when the object needs a confirmation."""
        who = (self._context.user_id if self._context else None) or "ha_alarm_panel"
        res = await self.core.objects.disarm_confirmed(self.object_id, who=who, by=tr(self.core, "entity.by_ha_panel"), code=code)
        if not res["ok"]:
            errors = {
                "wrong_code": tr(self.core, "entity.err_wrong_code"),
                "locked": tr(self.core, "entity.err_locked", seconds=res.get("retry_in", 30)),
                "no_pin": tr(self.core, "entity.err_no_pin"),
            }
            raise HomeAssistantError(errors.get(res["error"], str(res["error"])))

    async def async_alarm_trigger(self, code: str | None = None) -> None:
        if (self.core.objects.state.get(self.object_id) or {}).get("state") in ("armed", "pending"):
            await self.core.objects.trigger(self.object_id, None)
