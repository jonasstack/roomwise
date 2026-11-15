"""Websocket API for the panel and other frontends (e.g. the floorplan card). See docs/API.md."""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any

import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_CONTROL
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.util import dt as dt_util

from . import lightspec, permissions
from .const import API_VERSION, ASSISTANTS, DOMAIN, MODES, VERSION
from .i18n import tr
from .lightpreview import IDLE
from .logic import leaves
from .vocab import vocabulary

# i18n: complete

if TYPE_CHECKING:
    from .core import HouseRules

RULE_ID = vol.All(str, vol.Length(min=1, max=40))
MAX_DISMISSED = 500
MAX_RULE_BYTES = 64_000  # a rule or draft sent by any user (tests, descriptions, the language model)


def _bounded_rule(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise vol.Invalid("expected a dict")
    if len(json.dumps(value, default=str)) > MAX_RULE_BYTES:
        raise vol.Invalid("rule too large")
    return value


RULE = _bounded_rule
PAUSE_MINUTES = vol.All(vol.Coerce(float), vol.Range(min=0, max=366 * 24 * 60))  # at most a year (no inf / nan)


def _core(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> HouseRules | None:
    core = hass.data.get(DOMAIN)
    if core is None:
        connection.send_error(msg["id"], "not_loaded", tr(hass, "home.not_loaded"))
    return core


def _person_of(hass: HomeAssistant, user_id: str | None) -> str | None:
    if not user_id:
        return None
    for st in hass.states.async_all("person"):
        if st.attributes.get("user_id") == user_id:
            return st.object_id
    return None


@callback
def async_register(hass: HomeAssistant) -> None:
    for handler in (
        ws_info,
        ws_subscribe,
        ws_snapshot,
        ws_rule_save,
        ws_rule_delete,
        ws_rule_enable,
        ws_rule_pause,
        ws_rule_run,
        ws_rule_test,
        ws_rule_describe,
        ws_from_text,
        ws_for_entity,
        ws_for_entities,
        ws_mode_set,
        ws_room_save,
        ws_behaviour_set,
        ws_devices_set,
        ws_suggestion_dismiss,
        ws_automation_enable,
        ws_vocabulary,
        ws_history,
        ws_settings_set,
        ws_ui_set,
        ws_glow_set,
        ws_lightcal_get,
        ws_lightcal_set,
        ws_group_save,
        ws_group_delete,
        ws_alarm_arm,
        ws_alarm_disarm,
        ws_alarm_silence,
        ws_alarm_test,
        ws_alarm_config,
        ws_objects_save,
        ws_objects_delete,
        ws_objects_arm,
        ws_objects_disarm,
        ws_objects_test,
        ws_ai_set,
        ws_ai_test,
        ws_rule_entities,
        ws_suggestion_restore,
        ws_rule_run_actions,
        ws_mode_auto_set,
        ws_wakeup_set,
        ws_wakeup_reset,
        ws_sim_view,
        ws_sim_set,
        ws_sim_learn,
        ws_alarm_challenge,
        ws_alarm_register_device,
        ws_alarm_preview_tone,
        ws_alarm_channel_test,
        ws_cleaning_set,
        ws_plan_set,
        ws_plan_habits,
        ws_heating_set,
        ws_heating_do,
        ws_heating_explain,
        ws_heating_plan,
        ws_heating_assistant,
        ws_heating_test,
        ws_ai_review,
        ws_ai_improve,
        ws_features_set,
        ws_setup_save,
        ws_setup_suggest,
        ws_setup_apply,
        ws_window_warning_get,
        ws_window_warning_set,
        ws_window_warning_ack,
        ws_window_warning_import,
        ws_assistant_mark,
        ws_assistant_suggest,
        ws_assistant_apply,
        ws_light_learned,
        ws_light_forget,
        ws_light_preview,
        ws_telemetry_get,
        ws_telemetry_set,
        ws_telemetry_preview,
        ws_telemetry_delete,
        ws_telemetry_send_now,
        ws_telemetry_client,
        ws_backup_export,
        ws_backup_preview,
        ws_backup_restore,
        ws_issues_check,
        ws_places_get,
        ws_places_person,
        ws_places_predict,
        ws_places_name,
        ws_places_delete,
        ws_places_to_zone,
        ws_places_settings,
        ws_places_relearn,
        ws_places_forget,
        ws_permissions,
        ws_roles_get,
        ws_roles_set,
        ws_rule_versions,
        ws_rule_restore_version,
        ws_trash_list,
        ws_trash_restore,
        ws_trash_purge,
        ws_rule_export,
        ws_rule_exported,
    ):
        # every command checks the role of the user first (permissions.py), whatever the frontend shows
        websocket_api.async_register_command(hass, permissions.guard(handler))


def _uid(connection: websocket_api.ActiveConnection) -> str | None:
    return connection.user.id if connection.user else None


def _may_change(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any], *rules: dict[str, Any] | None) -> bool:
    """Rules that switch the alarm or may unlock/disarm: only admins may change them. Sends the error itself."""
    if permissions.is_admin(hass, connection) or not any(permissions.security_rule(r) for r in rules):
        return True
    connection.send_error(msg["id"], "unauthorized", tr(hass, "rel.security_denied"))
    return False


@websocket_api.websocket_command({vol.Required("type"): "house_rules/info"})
@callback
def ws_info(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    connection.send_result(msg["id"], {"version": VERSION, "api": API_VERSION, "loaded": DOMAIN in hass.data})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/subscribe"})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return

    @callback
    def send(data: dict[str, Any]) -> None:
        if data.get("kind") == "snapshot":
            data = {**data, "me": permissions.me(hass, connection.user)}  # the role can change while connected
        connection.send_message(websocket_api.event_message(msg["id"], data))

    connection.subscriptions[msg["id"]] = core.subscribe((id(connection), msg["id"]), send)
    connection.send_result(msg["id"])
    send({"kind": "snapshot", **core.snapshot()})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/snapshot"})
@callback
def ws_snapshot(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], {**core.snapshot(), "me": permissions.me(hass, connection.user)})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/save", vol.Required("rule"): dict})
@websocket_api.async_response
async def ws_rule_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    if not _may_change(hass, connection, msg, msg["rule"], core.rule(str(msg["rule"].get("id") or ""))):
        return
    try:
        rule = await core.save_rule(msg["rule"], _uid(connection))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"rule": rule, "sentence": core.describer.sentence(rule)})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/delete", vol.Required("rule_id"): RULE_ID})
@websocket_api.async_response
async def ws_rule_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    if not _may_change(hass, connection, msg, core.rule(msg["rule_id"])):
        return
    connection.send_result(msg["id"], {"ok": await core.delete_rule(msg["rule_id"], _uid(connection))})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/enable", vol.Required("rule_id"): RULE_ID, vol.Required("enabled"): bool})
@websocket_api.async_response
async def ws_rule_enable(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    if not _may_change(hass, connection, msg, core.rule(msg["rule_id"])):
        return
    await core.set_enabled(msg["rule_id"], msg["enabled"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command(
    {vol.Required("type"): "house_rules/rule/pause", vol.Required("rule_id"): RULE_ID, vol.Optional("until"): vol.Any(None, vol.All(str, vol.Length(max=40))), vol.Optional("minutes"): PAUSE_MINUTES}
)
@websocket_api.async_response
async def ws_rule_pause(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    if not _may_change(hass, connection, msg, core.rule(msg["rule_id"])):
        return
    until: float | None = None
    if msg.get("minutes"):
        until = time.time() + msg["minutes"] * 60
    elif msg.get("until"):
        ts = dt_util.parse_datetime(msg["until"])
        until = ts.timestamp() if ts else None
    await core.pause_rule(msg["rule_id"], until)
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/run", vol.Required("rule_id"): RULE_ID})
@websocket_api.async_response
async def ws_rule_run(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    if not permissions.is_admin(hass, connection) and core.sensitive(msg["rule_id"]):
        connection.send_error(msg["id"], "unauthorized", tr(core, "home.rule_run_sensitive"))
        return
    hass.async_create_task(core.engine.run_now(msg["rule_id"]))
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/test", vol.Required("rule"): RULE})
@callback
def ws_rule_test(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    rule = msg["rule"]
    for s in ("when", "and", "then", "only"):
        rule.setdefault(s, [])
    connection.send_result(msg["id"], core.engine.test(rule))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/describe", vol.Required("rule"): RULE})
@callback
def ws_rule_describe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    rule = msg["rule"]
    for s in ("when", "and", "then", "only"):
        rule.setdefault(s, [])
    connection.send_result(
        msg["id"],
        {"sentence": core.describer.sentence(rule), "clauses": {s: [core.describer.clause(c, "then" if s == "else" else s) for c in rule.get(s, [])] for s in ("when", "and", "then", "only", "else")}},
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "house_rules/from_text", vol.Required("text"): vol.All(str, vol.Length(min=1, max=400)), vol.Optional("language"): vol.All(str, vol.Length(max=12))}
)
@websocket_api.async_response
async def ws_from_text(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    # the sentence may be German or English; "language" (the user's) decides when it could be either
    result = await core.text.draft(msg["text"], _person_of(hass, connection.user.id if connection.user else None), msg.get("language"))
    d = core.describer
    old, d.lang_override = d.lang_override, result["language"]
    try:
        result["sentence"] = d.sentence(result["rule"])
    finally:
        d.lang_override = old
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "house_rules/for_entity", vol.Required("entity_id"): str})
@callback
def ws_for_entity(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.for_entity(msg["entity_id"]))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/for_entities", vol.Required("entity_ids"): vol.All([str], vol.Length(max=1000))})
@callback
def ws_for_entities(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.for_entities(msg["entity_ids"]))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/mode/set", vol.Required("mode"): vol.In(MODES)})
@websocket_api.async_response
async def ws_mode_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    from homeassistant.core import Context  # noqa: PLC0415

    await core.set_mode(msg["mode"], Context(user_id=connection.user.id if connection.user else None))
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/room/save", vol.Required("room"): dict})
@websocket_api.async_response
async def ws_room_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        await core.save_room(msg["room"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/behaviour/set", vol.Required("behaviour"): str, vol.Required("on"): bool})
@websocket_api.async_response
async def ws_behaviour_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    await core.set_behaviour(msg["behaviour"], msg["on"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/devices/set", vol.Required("changes"): [dict]})
@websocket_api.async_response
async def ws_devices_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    await core.set_devices(msg["changes"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/suggestion/dismiss", vol.Required("suggestion_id"): vol.All(str, vol.Length(min=1, max=80))})
@callback
def ws_suggestion_dismiss(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    if msg["suggestion_id"] not in core.data["dismissed"]:
        # any user may hide a suggestion: keep the list bounded (the oldest fall out)
        core.data["dismissed"] = [*core.data["dismissed"], msg["suggestion_id"]][-MAX_DISMISSED:]
        core.save()
    core.push("suggestions")
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/automation/enable", vol.Required("entity_id"): str, vol.Required("enabled"): bool})
@websocket_api.async_response
async def ws_automation_enable(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    if not msg["entity_id"].startswith("automation."):
        connection.send_error(msg["id"], "invalid", tr(core, "home.no_automation"))
        return
    await hass.services.async_call("automation", "turn_on" if msg["enabled"] else "turn_off", {"entity_id": msg["entity_id"]}, blocking=True, context=connection.context(msg))
    core._automations_changed()
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/vocabulary"})
@callback
def ws_vocabulary(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    connection.send_result(msg["id"], vocabulary())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/history", vol.Optional("entity_id"): str, vol.Optional("limit", default=100): vol.All(int, vol.Range(min=1, max=400))})
@callback
def ws_history(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.history.recent(msg["limit"], msg.get("entity_id")))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/settings/set", vol.Required("settings"): dict})
@callback
def ws_settings_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    if "ollama" in msg["settings"] and not (connection.user and connection.user.is_admin):
        # the language model's address is an outbound URL: only a real Home Assistant administrator (as ai/set)
        connection.send_error(msg["id"], "unauthorized", tr(hass, "rel.denied_ha_admin"))
        return
    core.save_settings(msg["settings"])
    core.push("all")
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/ui/set", vol.Required("ui"): dict})
@callback
def ws_ui_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Page layout of the panel (ui_layout.py): residents may arrange it, it changes nothing that runs."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.save_settings({"ui": msg["ui"]})
    core.push("all")
    connection.send_result(msg["id"], {"ok": True})


# ---------------------------------------------------------------------- own groups ("Gruppen")
@websocket_api.websocket_command({vol.Required("type"): "house_rules/group/save", vol.Required("group"): dict})
@websocket_api.async_response
async def ws_group_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        group = await core.save_group(msg["group"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"group": group})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/group/delete", vol.Required("group_id"): str})
@websocket_api.async_response
async def ws_group_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    await core.delete_group(msg["group_id"])
    connection.send_result(msg["id"], {"ok": True})


# ---------------------------------------------------------------------- alarm system
@websocket_api.websocket_command(
    {vol.Required("type"): "house_rules/alarm/arm", vol.Required("mode"): vol.In(["away", "night", "home"]), vol.Optional("force", default=False): bool}
)
@websocket_api.async_response
async def ws_alarm_arm(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], await core.alarm.arm(msg["mode"], force=msg["force"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "house_rules/alarm/disarm", vol.Optional("code"): vol.Any(None, str), vol.Optional("webauthn"): dict, vol.Optional("rp_id"): str}
)
@websocket_api.async_response
async def ws_alarm_disarm(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Disarm. How it must be confirmed is set in the alarm (confirm: none / pin / device = Face ID / Touch ID, PIN as fallback)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    user = connection.user.name if connection.user else None
    who = connection.user.id if connection.user else "unknown"
    res = await core.alarm.disarm_confirmed(who=who, by=tr(core, "home.by_hand_user", user=user) if user else tr(core, "home.by_hand"), code=msg.get("code"), webauthn=msg.get("webauthn"), rp_id=msg.get("rp_id") or "")
    connection.send_result(msg["id"], res)


@websocket_api.websocket_command({vol.Required("type"): "house_rules/alarm/challenge"})
@callback
def ws_alarm_challenge(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """A one-time challenge for Face ID / Touch ID, plus the ids of the set-up devices."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(
        msg["id"],
        {"challenge": core.alarm.challenge(), "credentials": [d["id"] for d in core.alarm.config.get("devices", [])], "user": connection.user.id if connection.user else "user"},
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "house_rules/alarm/register_device", vol.Required("payload"): dict, vol.Required("name"): str, vol.Required("rp_id"): str, vol.Optional("code"): vol.Any(None, str)}
)
@websocket_api.async_response
async def ws_alarm_register_device(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Sets up this phone/tablet for Face ID / Touch ID (passkey). A registered device can disarm the alarm, so only
    a Home Assistant admin may register one freely; anyone else (also an "Admin" in Hausregeln) only with the alarm
    PIN (checked here, before anything is stored)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    from .webauthn import BAD_INPUT, WebAuthnError  # noqa: PLC0415

    if not permissions.is_ha_admin(connection):
        if not msg.get("code") or await core.alarm.verify_code(msg.get("code"), connection.user.id if connection.user else "unknown"):
            connection.send_error(msg["id"], "unauthorized", tr(core, "home.passkey_unauthorized"))
            return
    try:
        res = core.alarm.register_device(msg["payload"], msg["name"], msg["rp_id"])
    except BAD_INPUT as err:
        connection.send_error(msg["id"], "invalid", (str(err) if isinstance(err, WebAuthnError) else "") or tr(core, "home.passkey_failed"))
        return
    connection.send_result(msg["id"], res)


@websocket_api.websocket_command({vol.Required("type"): "house_rules/alarm/preview_tone", vol.Required("tone"): str, vol.Required("player"): str})
@websocket_api.async_response
async def ws_alarm_preview_tone(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Plays a tone quietly on one speaker."""
    if (core := _core(hass, connection, msg)) is None:
        return
    await core.alarm.preview_tone(msg["tone"], msg["player"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/alarm/silence"})
@websocket_api.async_response
async def ws_alarm_silence(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    await core.alarm.silence()
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/alarm/test"})
@websocket_api.async_response
async def ws_alarm_test(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Probealarm: message (not critical) and announcement only, no siren, no sound, no lights."""
    if (core := _core(hass, connection, msg)) is None:
        return
    await core.alarm.trigger(None, test=True)
    core.history.add("alarm", tr(core, "home.test_alarm"), tr(core, "home.test_alarm_why"))
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/alarm/config", vol.Required("config"): dict})
@websocket_api.async_response
async def ws_alarm_config(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    from .alarm import _new_hash  # noqa: PLC0415

    raw = {k: v for k, v in msg["config"].items() if k != "_hash"}
    if raw.get("code"):
        raw["_hash"] = await hass.async_add_executor_job(_new_hash, str(raw.pop("code")))  # slow hash off the event loop
    try:
        core.alarm.save_config(raw)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], core.alarm.view())


# ---------------------------------------------------------------------- object alarms ("Weitere Alarme", objects.py)
@websocket_api.websocket_command({vol.Required("type"): "house_rules/objects/save", vol.Required("object"): dict})
@callback
def ws_objects_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        obj = core.objects.save(msg["object"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"ok": True, "id": obj["id"], "objects": core.objects.view()})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/objects/delete", vol.Required("object_id"): vol.All(str, vol.Length(max=40))})
@websocket_api.async_response
async def ws_objects_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    await core.objects.delete(msg["object_id"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/objects/arm", vol.Required("object_id"): vol.All(str, vol.Length(max=40))})
@websocket_api.async_response
async def ws_objects_arm(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    user = connection.user.name if connection.user else None
    connection.send_result(msg["id"], await core.objects.arm(msg["object_id"], by=tr(core, "home.by_hand_user", user=user) if user else tr(core, "home.by_hand")))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "house_rules/objects/disarm",
        vol.Required("object_id"): vol.All(str, vol.Length(max=40)),
        vol.Optional("only_alarm", default=False): bool,
        vol.Optional("code"): vol.Any(None, str),
        vol.Optional("webauthn"): dict,
        vol.Optional("rp_id"): str,
    }
)
@websocket_api.async_response
async def ws_objects_disarm(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Disarm one object alarm (only_alarm: end the running alarm, stay armed), confirmed like the house alarm."""
    if (core := _core(hass, connection, msg)) is None:
        return
    user = connection.user.name if connection.user else None
    who = connection.user.id if connection.user else "unknown"
    res = await core.objects.disarm_confirmed(
        msg["object_id"], who=who, by=tr(core, "home.by_hand_user", user=user) if user else tr(core, "home.by_hand"), code=msg.get("code"), webauthn=msg.get("webauthn"), rp_id=msg.get("rp_id") or "", only_alarm=msg["only_alarm"]
    )
    connection.send_result(msg["id"], res)


@websocket_api.websocket_command({vol.Required("type"): "house_rules/objects/test", vol.Required("object_id"): vol.All(str, vol.Length(max=40))})
@websocket_api.async_response
async def ws_objects_test(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Probealarm of one object: only the message, no siren, no lights."""
    if (core := _core(hass, connection, msg)) is None:
        return
    await core.objects.trigger(msg["object_id"], None, test=True)
    connection.send_result(msg["id"], {"ok": True})


# ---------------------------------------------------------------------- language model connection
@websocket_api.websocket_command({vol.Required("type"): "house_rules/ai/set", vol.Required("ai"): dict})
@callback
def ws_ai_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        core.ai.save(msg["ai"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    core.push("ai")
    hass.async_create_background_task(core.text.warmup(), "house_rules_ai_warmup")
    connection.send_result(msg["id"], core.ai.public())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/ai/test", vol.Optional("ai", default={}): dict})
@websocket_api.async_response
async def ws_ai_test(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    result = await core.ai.test(msg["ai"])
    core.push("ai")
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/entities", vol.Required("rule"): RULE})
@callback
def ws_rule_entities(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The devices a rule (or draft) reads and switches, per part, with placeholders resolved: for highlighting on a plan."""
    if (core := _core(hass, connection, msg)) is None:
        return
    res = core.checker.res
    rule = msg["rule"]
    out: dict[str, list[dict[str, Any]]] = {}
    for section in ("when", "and", "then", "only", "else"):
        items = []
        for c in [x for y in rule.get(section) or [] for x in leaves(y)]:
            subject = str(c.get("subject", ""))
            ents: list[str] = []
            if subject.endswith("@same"):
                for room in core.rooms:
                    ents += res.entities(subject, room)
            else:
                ents = res.entities(subject)
            room = subject[5:] if subject.startswith("room:") else None
            items.append({"subject": subject, "entities": list(dict.fromkeys(ents)), "room": room})
        out[section] = items
    connection.send_result(msg["id"], out)


@websocket_api.websocket_command({vol.Required("type"): "house_rules/suggestion/restore"})
@callback
def ws_suggestion_restore(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Shows hidden suggestions again."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.data["dismissed"] = []
    core.save()
    core.push("suggestions")
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/run_actions", vol.Required("rule"): dict, vol.Optional("index"): vol.Coerce(int)})
@websocket_api.async_response
async def ws_rule_run_actions(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Runs the steps of a rule (or draft) for real, without trigger and conditions. index = only this step.
    "im selben Raum" means every room here. Waits are skipped when a single step is tested."""
    if (core := _core(hass, connection, msg)) is None:
        return
    if not _may_change(hass, connection, msg, msg["rule"]):
        return
    rule = dict(msg["rule"])
    rule.setdefault("id", "test")
    rule.setdefault("name", "Test")
    steps = list(rule.get("then") or [])
    if "index" in msg:
        if not 0 <= msg["index"] < len(steps):
            connection.send_error(msg["id"], "invalid", tr(core, "home.no_such_step"))
            return
        steps = [steps[msg["index"]]]
        if steps[0].get("subject") == "wait":
            connection.send_result(msg["id"], {"done": [tr(core, "home.wait_skipped")]})
            return
    rule["then"] = steps
    rule["options"] = {**(rule.get("options") or {}), "manual_pause": ""}
    same = any(str(c.get("subject", "")).endswith("@same") for c in steps)
    rooms = list(core.rooms) if same else [None]
    ctx = core.history.new_context(str(rule["id"]))
    done: list[str] = []
    from .actions import StopRun  # noqa: PLC0415

    for room in rooms:
        try:
            result = await core.executor.run(rule, ctx, room, room)
        except StopRun as stop:
            result = stop.args[0] if stop.args else []
        done += [d["text"] + (f" ({core.rooms[room]['name']})" if room else "") for d in result if d.get("entities") or not same]
    core.history.add("rule", tr(core, "home.test_done", what=", ".join(done))[:300] if done else tr(core, "home.test_nothing"), tr(core, "home.test_why"), rule=rule if core.rule(str(rule["id"])) else None)
    connection.send_result(msg["id"], {"done": done})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/mode_auto/set", vol.Required("mode"): str, vol.Required("config"): dict})
@callback
def ws_mode_auto_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Automatic house mode: mode = "sleep"/"away"/"guests"/"vacation" with {on, when, for}, or "_enabled" with {enabled}."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.mode_auto.save(msg["mode"], msg["config"])
    core.push("mode_auto")
    connection.send_result(msg["id"], core.mode_auto.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/wakeup/set", vol.Required("config"): dict})
@callback
def ws_wakeup_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Aufstehen erkennen (wakeup.py): { on, action: direct/ask, feedback, beds: [entity ids], rooms: [room ids] }."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.wakeup.save(msg["config"])
    core.push("mode_auto")
    connection.send_result(msg["id"], core.mode_auto.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/wakeup/reset"})
@callback
def ws_wakeup_reset(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Forgets what the wakeup detection learned (the settings stay)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.wakeup.reset()
    connection.send_result(msg["id"], core.mode_auto.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/ai/review", vol.Required("rule"): RULE})
@websocket_api.async_response
async def ws_ai_review(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The connected model looks over a rule (or draft): {verdict, summary, notes, improved?, improved_sentence?}."""
    if (core := _core(hass, connection, msg)) is None:
        return
    from .ai import AiError  # noqa: PLC0415

    rule = msg["rule"]
    for s in ("when", "and", "then", "only"):
        rule.setdefault(s, [])
    try:
        connection.send_result(msg["id"], await core.text.review(rule))
    except AiError as err:
        connection.send_error(msg["id"], "ai", str(err))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/ai/improve", vol.Required("text"): vol.All(str, vol.Length(min=1, max=400)), vol.Required("rule"): RULE})
@websocket_api.async_response
async def ws_ai_improve(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The connected model checks a draft from from_text: {changed, rule?, sentence?, note?, model}."""
    if (core := _core(hass, connection, msg)) is None:
        return
    from .ai import AiError  # noqa: PLC0415

    try:
        result = await core.text.improve(msg["text"], msg["rule"], _person_of(hass, connection.user.id if connection.user else None))
    except AiError as err:
        connection.send_error(msg["id"], "ai", str(err))
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "house_rules/alarm/channel_test", vol.Required("channel"): vol.In(["email", "telegram", "signal", "services"])})
@websocket_api.async_response
async def ws_alarm_channel_test(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    errors = await core.alarm.test_channel(msg["channel"])
    connection.send_result(msg["id"], {"ok": not errors, "errors": errors})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/cleaning/set", vol.Required("config"): dict})
@callback
def ws_cleaning_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    core.cleaning.save(msg["config"])
    connection.send_result(msg["id"], core.cleaning.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/glow/set", vol.Required("glow"): dict})
@callback
def ws_glow_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Reinschau-Licht: when it may glow at all (one setting for every room)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.lightplan.save_glow_global(msg["glow"])
    core.push("plans")
    connection.send_result(msg["id"], {"glow": core.lightplan.glow_global})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/lightcal/get"})
@callback
def ws_lightcal_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Lampen abgleichen: the corrections per lamp and the reference colours (lightcal.py)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.lightcal.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/lightcal/set", vol.Required("lights"): dict})
@callback
def ws_lightcal_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Lampen abgleichen: {entity_id: {hs: {ref: [h, s]}, k: {ref: kelvin}, bri} or null to forget}; merged."""
    if (core := _core(hass, connection, msg)) is None:
        return
    view = core.lightcal.save(msg["lights"])
    core.lightplan.schedule_all()
    connection.send_result(msg["id"], view)


@websocket_api.websocket_command({vol.Required("type"): "house_rules/plan/set", vol.Required("kind"): vol.In(["light", "heat"]), vol.Required("room"): str, vol.Required("plan"): dict})
@websocket_api.async_response
async def ws_plan_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        await core.save_plan(msg["kind"], msg["room"], msg["plan"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], core.plans.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/plan/habits", vol.Required("room"): str})
@websocket_api.async_response
async def ws_plan_habits(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        connection.send_result(msg["id"], await core.plans.habits(msg["room"]))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/heating/set", vol.Required("config"): dict})
@callback
def ws_heating_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """House-wide heating settings (heating.py): outside thermometer, summer, heat demand, valve exercise, reminders."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.heating.save_global(msg["config"])
    core.push("plans")
    connection.send_result(msg["id"], core.plans.view())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "house_rules/heating/do",
        vol.Required("action"): vol.In(["exercise", "clear_manual", "takeover", "shadow", "accept_proposal", "reset_learning"]),
        vol.Optional("room"): str,
        vol.Optional("proposal"): str,
    }
)
@callback
def ws_heating_do(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """exercise: valve exercise now; clear_manual: room back to its plan; takeover: a smart room ends its shadow mode;
    shadow: shadow mode again; accept_proposal: a heating proposal becomes a fixed time; reset_learning: forget what
    the room learned (habits, heat model, valve controller)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    act = msg["action"]
    if act != "clear_manual" and not permissions.is_admin(hass, connection):
        connection.send_error(msg["id"], "unauthorized", tr(hass, permissions.DENIED["resident"]))
        return
    smart = core.heating.smart
    try:
        if act == "exercise":
            core.heating.exercise()
        elif act == "accept_proposal":
            smart.accept(msg.get("proposal") or "")
            core.push("suggestions")
            core.push("plans")
        elif msg.get("room") in core.rooms:
            rid = msg["room"]
            if act == "clear_manual":
                core.heating.clear_manual(rid)
            elif act == "takeover":
                smart.takeover(rid)
            elif act == "shadow":
                smart.restart_shadow(rid)
            elif act == "reset_learning":
                smart.reset(rid)
            core.push("plans")
        else:
            raise ValueError(tr(hass, "home.unknown_room"))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/heating/explain", vol.Required("room"): str})
@websocket_api.async_response
async def ws_heating_explain(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """"So denkt deine Heizung": today's plan, learned week, last decisions, forecast, guardrails, shadow mode, cost."""
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        connection.send_result(msg["id"], await core.heating.smart.explain(msg["room"]))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/heating/plan", vol.Required("room"): str})
@callback
def ws_heating_plan(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The learned plan of a room ("Zeiten" of an intelligent room): today and tomorrow with reasons and how sure,
    learned comfort and airing windows, lead time of the room."""
    if (core := _core(hass, connection, msg)) is None:
        return
    if msg["room"] not in core.rooms:
        connection.send_error(msg["id"], "invalid", tr(hass, "home.unknown_room"))
        return
    connection.send_result(msg["id"], core.heating.smart.plan_view(msg["room"]))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/heating/assistant"})
@websocket_api.async_response
async def ws_heating_assistant(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Heating assistant: rooms with thermostats, writable valves, room areas, energy source and price."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], await core.heating.smart.assistant())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "house_rules/heating/test",
        vol.Required("action"): vol.In(["factor", "seed", "model", "setback", "tick", "startup"]),
        vol.Optional("room"): str,
        vol.Optional("key"): str,
        vol.Optional("value"): vol.Coerce(float),
        vol.Optional("intervals"): [[vol.Coerce(float)]],
        vol.Optional("days"): [str],
        vol.Optional("k_l"): vol.Coerce(float),
        vol.Optional("k_h"): vol.Coerce(float),
        vol.Optional("n"): int,
        vol.Optional("minutes"): vol.Coerce(float),
        vol.Optional("comfort"): vol.Coerce(float),
        vol.Optional("setback"): vol.Coerce(float),
        vol.Optional("tout"): vol.Coerce(float),
        vol.Optional("current"): vol.Coerce(float),
        vol.Optional("style"): str,
    }
)
@callback
def ws_heating_test(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """For automatic tests of the smart heating (admin only): factor = learning and valve control run N times faster
    (in memory, back to 1 on restart); seed = learn habits from intervals; model = set a room's heat model;
    setback = the "is a setback worth it" calculation; tick = run the smart heating's tick now; startup = the start-up
    phase (core.starting) ends in `value` seconds (0 = over now)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    from datetime import date  # noqa: PLC0415

    from . import heat_model as hm  # noqa: PLC0415

    smart = core.heating.smart
    act = msg["action"]
    out: dict[str, Any] = {"ok": True}
    if act == "factor":
        smart.set_factor(msg.get("value", 1.0))
        out["factor"] = smart.factor
    elif act == "seed":
        days = [date.fromisoformat(d) for d in msg.get("days", [])]
        out["days"] = smart.habits.ingest(msg.get("key") or msg.get("room") or "", [(a[0], a[1]) for a in msg.get("intervals", []) if len(a) == 2], days)
        smart._sugg = None  # noqa: SLF001
        smart.forget(None)
        core.heating.schedule_all(0.1)
    elif act == "model":
        rid = msg.get("room") or ""
        n = msg.get("n", 10)
        smart.d["models"][rid] = {"k_l": msg.get("k_l", 0.06), "k_h": msg.get("k_h", 2.5), "n_c": n, "n_h": n, "p_c": 0.01, "p_h": 0.1}
        smart.forget(rid)
        core.heating.schedule_all(0.1)
    elif act == "setback":
        m = smart.model(msg.get("room") or "")
        st = hm.style(msg.get("style"))
        out = hm.setback_plan(m, msg.get("comfort", 21.0), msg.get("setback", 17.0), msg.get("tout", 5.0), msg.get("minutes", 60) / 60, msg.get("current"), st["margin"], st["worth_kh"])
    elif act == "tick":
        smart.tick()
    elif act == "startup":
        from .core import STARTUP_SECONDS  # noqa: PLC0415

        core.started_at = time.time() - STARTUP_SECONDS + max(0.0, msg.get("value", 0.0))
        out["starting"] = core.starting()
    connection.send_result(msg["id"], out)


@websocket_api.websocket_command({vol.Required("type"): "house_rules/sim/view", vol.Optional("day"): str})
@callback
def ws_sim_view(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Vacation "look lived-in": what was learned and the simulated timeline of a day (default: today)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    from datetime import date  # noqa: PLC0415

    try:
        day = date.fromisoformat(msg["day"]) if msg.get("day") else None
    except ValueError:
        day = None
    connection.send_result(msg["id"], core.sim.view(day))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/sim/set", vol.Required("config"): dict})
@callback
def ws_sim_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """{smart, people (0 = like the residents), morning, night}."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.sim.save_config(msg["config"])
    for rid in core.rooms:
        core.lightplan.schedule(rid, 0.1)
    connection.send_result(msg["id"], core.sim.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/sim/learn"})
@websocket_api.async_response
async def ws_sim_learn(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Learn again now (normally every night)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    await core.sim.learn()
    connection.send_result(msg["id"], core.sim.view())


# ---------------------------------------------------------------------- features ("Funktionen") and setup wizard
@websocket_api.websocket_command({vol.Required("type"): "house_rules/features/set", vol.Required("features"): dict})
@websocket_api.async_response
async def ws_features_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Switch parts of Hausregeln on/off: { alarm, light, heating, vacation, mode_auto, vacuum, ai, behaviours }. Answer: all features."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], await core.features.set(msg["features"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "house_rules/setup/save", vol.Optional("step"): str, vol.Optional("answers"): dict, vol.Optional("done"): bool, vol.Optional("restart"): bool}
)
@callback
def ws_setup_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Progress of the setup wizard (resume later): step, answers (merged), done; restart = run it again."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.setup.save({k: msg[k] for k in ("step", "answers", "done", "restart") if k in msg}))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/setup/suggest"})
@callback
def ws_setup_suggest(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """What the wizard proposes from the real home: residents, rooms with sensor candidates, alarm sensors, sirens,
    vacuums, example rules, whether the floor plan card is installed."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.setup.suggest())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/setup/apply", vol.Required("step"): vol.In(["rooms", "light", "vacation", "modes"]), vol.Optional("data", default={}): dict})
@websocket_api.async_response
async def ws_setup_apply(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Composite wizard steps: rooms (sensors for many rooms at once), light (a first light rule per room),
    vacation (look lived-in in every light room), modes (house mode basics)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        connection.send_result(msg["id"], await core.setup.apply(msg["step"], msg["data"]))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))


# ---------------------------------------------------------------------- Fenster-Warnung beim Gehen
@websocket_api.websocket_command({vol.Required("type"): "house_rules/window_warning/get"})
@callback
def ws_window_warning_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """{ on, active, phase, door, windows, names, since, deadline, spoken, config, doors, suggested_doors }"""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.window_warning.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/window_warning/set", vol.Required("config"): dict})
@callback
def ws_window_warning_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    core.window_warning.save(msg["config"])
    connection.send_result(msg["id"], core.window_warning.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/window_warning/ack"})
@callback
def ws_window_warning_ack(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Acknowledge (any user, e.g. a tap on the wall tablet). {ok: false} when nothing was to acknowledge."""
    if (core := _core(hass, connection, msg)) is None:
        return
    user = connection.user.name if connection.user else None
    connection.send_result(msg["id"], {"ok": core.window_warning.acknowledge(tr(core, "home.by_hand_user", user=user) if user else tr(core, "home.by_hand"))})


@websocket_api.websocket_command(
    {vol.Required("type"): "house_rules/window_warning/import", vol.Required("entry_alert"): dict, vol.Required("openings"): [dict], vol.Optional("source", default="Grundriss-Karte"): str}
)
@callback
def ws_window_warning_import(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Take over the floor plan card's front door warning once: its `entry_alert` and the plan's openings
    ({id, type, entity, name}); the panel reads them from the dashboard (read only). Answer: the new view."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.window_warning.import_card(msg["entry_alert"], msg["openings"], msg["source"][:80])
    connection.send_result(msg["id"], core.window_warning.view())


# ---------------------------------------------------------------------- feature assistants (assistants.py)
@websocket_api.websocket_command(
    {vol.Required("type"): "house_rules/assistant/mark", vol.Required("feature"): vol.In(ASSISTANTS), vol.Optional("done"): bool, vol.Optional("dismissed"): bool}
)
@callback
def ws_assistant_mark(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Only the "set up" flag of a feature: done (finished or skipped) / dismissed (closed with "später").
    Answer: all assistants {feature: {done, dismissed, configured, at}}."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.assistants.mark(msg["feature"], msg.get("done"), msg.get("dismissed")))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/assistant/suggest", vol.Required("feature"): vol.In(ASSISTANTS)})
@callback
def ws_assistant_suggest(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """What the assistant of a feature proposes from the real home (detected devices, current values)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.assistants.suggest(msg["feature"]))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/assistant/apply", vol.Required("feature"): vol.In(ASSISTANTS), vol.Required("answers"): dict})
@websocket_api.async_response
async def ws_assistant_apply(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Set the feature up from the answers in one go (switches the feature on) and mark it done."""
    if (core := _core(hass, connection, msg)) is None:
        return
    if msg["feature"] == "alarm" and not permissions.is_ha_admin(connection):
        # writes the alarm configuration (PIN, sensors, recipients) like alarm/config
        connection.send_error(msg["id"], "unauthorized", permissions.denied_text(hass, connection.user, "ha_admin"))
        return
    try:
        connection.send_result(msg["id"], await core.assistants.apply(msg["feature"], msg["answers"]))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/light/learned", vol.Required("room"): str})
@callback
def ws_light_learned(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Intelligent light of a room: per time of day and light what was learned, number of examples, agreement."""
    if (core := _core(hass, connection, msg)) is None:
        return
    rid = msg["room"]
    if rid not in core.rooms:
        connection.send_error(msg["id"], "invalid", tr(hass, "home.unknown_room"))
        return
    p = core.lightplan.plan(rid)
    lights = p["smart"]["lights"] or core.lightplan.room_lights(rid)
    connection.send_result(msg["id"], core.lightlearn.learned(rid, p["smart"], lights))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "house_rules/light/preview",
        vol.Required("action"): vol.In(("start", "apply", "keep", "stop")),
        vol.Optional("session"): str,
        vol.Optional("lights"): [str],
        vol.Optional("settings"): {str: dict},
        vol.Optional("restore", default=True): bool,
    }
)
@websocket_api.async_response
async def ws_light_preview(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Live preview of a light setting (lightpreview.py): start {lights} → {session, idle}; apply {session, settings:
    {entity_id: light setting}} → {failed}; keep {session} (still there); stop {session, restore}. Lights only, each
    checked against the user's Home Assistant rights to control it; the session ends with the connection."""
    if (core := _core(hass, connection, msg)) is None:
        return
    lp = core.lightpreview
    uid = _uid(connection)
    if msg["action"] == "start":
        user = connection.user
        for e in msg.get("lights") or []:
            st = hass.states.get(e)
            name = str(st.attributes.get("friendly_name", e)) if st else e
            if not lightspec.is_lightlike(e):
                connection.send_error(msg["id"], "invalid", tr(hass, "light.preview_not_light", name=name))
                return
            if user is None or not user.permissions.check_entity(e, POLICY_CONTROL):
                connection.send_error(msg["id"], "unauthorized", tr(hass, "light.preview_denied", name=name))
                return
        try:
            s = lp.start(uid, msg.get("lights") or [])
        except OverflowError:
            connection.send_error(msg["id"], "busy", tr(hass, "light.preview_busy"))
            return
        # the tab closes / the connection drops: lamps back right away
        key = msg["id"]
        connection.subscriptions[key] = lambda: hass.async_create_task(lp.stop(s.id, restore=True))
        s.detach = lambda: connection.subscriptions.pop(key, None)
        connection.send_result(msg["id"], {"session": s.id, "idle": IDLE, "lights": s.lights})
        return
    s = lp.get(msg.get("session") or "", uid)
    if s is None:
        connection.send_error(msg["id"], "not_found", tr(hass, "light.preview_gone"))
        return
    if msg["action"] == "apply":
        connection.send_result(msg["id"], {"failed": await lp.apply(s, msg.get("settings") or {})})
    elif msg["action"] == "keep":
        lp.keep(s)
        connection.send_result(msg["id"], {"ok": True})
    else:
        await lp.stop(s.id, restore=msg["restore"])
        connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/light/forget", vol.Required("room"): str})
@callback
def ws_light_forget(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Forget what the intelligent light learned in a room (starts again from the starting values)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.lightlearn.forget(msg["room"])
    core.lightplan.schedule(msg["room"], 0.1)
    connection.send_result(msg["id"], {"ok": True})


# ---------------------------------------------------------------------- anonymous diagnostics (opt-in, telemetry.py, PRIVACY.md)
@websocket_api.websocket_command({vol.Required("type"): "house_rules/telemetry/get"})
@callback
def ws_telemetry_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """{ on, available, asked, last_report, next_report, errors_pending, privacy_url, last_result, install_id (admins) }"""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.telemetry.view(permissions.is_admin(hass, connection)))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/telemetry/set", vol.Required("on"): bool})
@websocket_api.async_response
async def ws_telemetry_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Opt in / out. On = a new random install id; off = forget it and delete the server data (best effort)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    if msg["on"] and not core.telemetry.available:
        connection.send_error(msg["id"], "not_available", tr(hass, "home.telemetry_unavailable"))
        return
    connection.send_result(msg["id"], await core.telemetry.set_on(msg["on"]))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/telemetry/preview"})
@websocket_api.async_response
async def ws_telemetry_preview(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Exactly what would be sent next: { available, endpoint, report, errors }."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], await core.telemetry.preview())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/telemetry/delete"})
@websocket_api.async_response
async def ws_telemetry_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """ "Meine Daten löschen": { ok, deleted, retry? | error: not_available }; a new id from now on."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], await core.telemetry.delete_remote())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/telemetry/send_now"})
@websocket_api.async_response
async def ws_telemetry_send_now(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Send the report (and due errors) now instead of waiting for the week: { ok, error? }."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], await core.telemetry.send_now())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "house_rules/telemetry/client",
        **{vol.Optional(k): vol.Any(str, int, float) for k in ("browser", "engine", "engine_version", "webgl", "gpu", "tier", "profile", "view", "screen", "cores")},
    }
)
@callback
def ws_telemetry_client(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """A floor plan card reports its browser family and performance tier (any user). { accepted }: false while off."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], {"accepted": core.telemetry.client(msg)})


# ---------------------------------------------------------------------- backup and restore (backup.py)
@websocket_api.websocket_command({vol.Required("type"): "house_rules/backup/export"})
@callback
def ws_backup_export(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Everything set up, as one versioned object (the panel offers it as a .json download). No secrets."""
    if (core := _core(hass, connection, msg)) is None:
        return
    from .backup import export  # noqa: PLC0415

    connection.send_result(msg["id"], export(core))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/backup/preview", vol.Required("backup"): dict, vol.Optional("remap", default={}): dict})
@callback
def ws_backup_preview(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """What a restore would change: { sections: [...], missing: [{entity_id, used_in, candidates}], alarm_armed, notes }"""
    if (core := _core(hass, connection, msg)) is None:
        return
    from .backup import clean_mapping, parse, preview  # noqa: PLC0415

    try:
        data = parse(msg["backup"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    result = preview(core, data, clean_mapping(hass, msg["remap"]))
    result["created"] = msg["backup"].get("created")
    result["app_version"] = msg["backup"].get("app_version")
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "house_rules/backup/restore",
        vol.Required("backup"): dict,
        vol.Required("mode"): vol.In(["merge", "replace"]),
        vol.Optional("sections"): [str],
        vol.Optional("remap", default={}): dict,
    }
)
@websocket_api.async_response
async def ws_backup_restore(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Restore: merge (backup wins for the same rule/group/room, the rest stays) or replace (exactly the backup).
    Answer: { ok, sections, skipped: [sentences], notes: [sentences] }"""
    if (core := _core(hass, connection, msg)) is None:
        return
    from .backup import clean_mapping, parse, restore  # noqa: PLC0415

    try:
        data = parse(msg["backup"])
        result = await restore(core, data, msg["mode"], msg.get("sections"), clean_mapping(hass, msg["remap"]), connection.user.id if connection.user else None)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], result)


# ---------------------------------------------------------------------- hints in the Repairs panel (issues.py)
@websocket_api.websocket_command({vol.Required("type"): "house_rules/issues/check"})
@websocket_api.async_response
async def ws_issues_check(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Check for problems now (normally after changes and every 30 min). Answer: [{id, key, placeholders}]"""
    if (core := _core(hass, connection, msg)) is None:
        return
    found = await core.issues.check()
    connection.send_result(msg["id"], [{"id": k, "key": v["key"], "placeholders": v["placeholders"]} for k, v in found.items()])


# ---------------------------------------------------------------------- roles (permissions.py)
@websocket_api.websocket_command({vol.Required("type"): "house_rules/permissions"})
@callback
def ws_permissions(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The role of the person asking: { user_id, name, role, label, ha_admin, can: {...} }"""
    connection.send_result(msg["id"], permissions.me(hass, connection.user))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/roles/get"})
@websocket_api.async_response
async def ws_roles_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Every Home Assistant user with its role: { users: [{id, name, role, label, ha_admin, fixed, owner}], roles }"""
    if (core := _core(hass, connection, msg)) is None:
        return
    roles = [{"id": r, "label": permissions.label(hass, r)} for r in permissions.ROLES]
    # automation_users: every user incl. the ones HA made itself – which are other automation systems (Node-RED …)
    connection.send_result(msg["id"], {"users": await permissions.users_view(hass, core), "roles": roles, "automation_users": await core.automation_users_view()})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/roles/set", vol.Required("user_id"): vol.All(str, vol.Length(min=1, max=64)), vol.Required("role"): vol.In(permissions.ROLES)})
@websocket_api.async_response
async def ws_roles_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        await permissions.set_role(hass, core, msg["user_id"], msg["role"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"users": await permissions.users_view(hass, core)})


# ---------------------------------------------------------------------- rule history and trash (versions.py)
@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/versions", vol.Required("rule_id"): RULE_ID})
@callback
def ws_rule_versions(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Newest first: [{id, at, by, by_name, kind, changes, summary, sentence, current}]"""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.versions.list(msg["rule_id"]))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/restore_version", vol.Required("rule_id"): RULE_ID, vol.Required("version"): vol.All(str, vol.Length(min=1, max=20))})
@websocket_api.async_response
async def ws_rule_restore_version(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    version = core.versions.get(msg["rule_id"], msg["version"])
    if not _may_change(hass, connection, msg, core.rule(msg["rule_id"]), version["rule"] if version else None):
        return
    try:
        rule = await core.restore_version(msg["rule_id"], msg["version"], _uid(connection))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"rule": rule, "sentence": core.describer.sentence(rule)})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/trash/list"})
@callback
def ws_trash_list(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Deleted rules of the last 30 days, newest first: [{id, name, deleted, deleted_by, deleted_by_name, until, sentence, rule}]"""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.versions.trash_view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/trash/restore", vol.Required("rule_id"): RULE_ID})
@websocket_api.async_response
async def ws_trash_restore(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Brings a deleted rule back ("Rückgängig" right after deleting, or from the trash). Answer: { rule, sentence }"""
    if (core := _core(hass, connection, msg)) is None:
        return
    entry = next((t for t in core.versions.trash() if t.get("id") == msg["rule_id"]), None)
    if not _may_change(hass, connection, msg, entry):
        return
    try:
        rule = await core.restore_from_trash(msg["rule_id"], _uid(connection))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"rule": rule, "sentence": core.describer.sentence(rule)})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/trash/purge", vol.Optional("rule_id"): RULE_ID})
@callback
def ws_trash_purge(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Delete for good: one rule from the trash, or (without rule_id) the whole trash. Answer: { removed }"""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], {"removed": core.versions.purge_trash(msg.get("rule_id") or "*")})


# ---------------------------------------------------------------------- export as a Home Assistant automation (export.py)
@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/export", vol.Optional("rule_id"): RULE_ID, vol.Optional("rule"): dict})
@callback
def ws_rule_export(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """A rule (saved, by rule_id; or a draft) as automation: { id, automation, yaml, notes: [sentence], complete }"""
    if (core := _core(hass, connection, msg)) is None:
        return
    from .export import export  # noqa: PLC0415

    rule = core.rule(msg["rule_id"]) if msg.get("rule_id") else msg.get("rule")
    if not rule:
        connection.send_error(msg["id"], "invalid", tr(core, "rel.rule_missing"))
        return
    rule = {"id": "draft", "name": tr(core, "export.rule"), **rule}
    for s in ("when", "and", "then", "only"):
        rule.setdefault(s, [])
    connection.send_result(msg["id"], export(core, rule))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/rule/exported", vol.Required("rule_id"): RULE_ID, vol.Required("automation_id"): vol.All(str, vol.Length(min=1, max=80))})
@websocket_api.async_response
async def ws_rule_exported(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """After the panel created the automation (Home Assistant's config API): switch the rule off here (not deleted)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        rule = await core.mark_exported(msg["rule_id"], msg["automation_id"], _uid(connection))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"rule": rule})


# ---------------------------------------------------------------------- Wo ist wer (places.py)
@websocket_api.websocket_command({vol.Required("type"): "house_rules/places/get"})
@callback
def ws_places_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """{ persons, learned, settings, stats } – the same as the snapshot part `places`."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.places.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/places/person", vol.Required("person_id"): str})
@callback
def ws_places_person(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """One person: today's timeline (stays and trips), the last trips, the prediction."""
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        connection.send_result(msg["id"], core.places.person_detail(msg["person_id"]))
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/places/predict", vol.Required("person_id"): str})
@callback
def ws_places_predict(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """{ destination, name, eta_min, probability, basis } – destination None when not moving."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.places.predict(msg["person_id"]))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/places/name", vol.Required("place_id"): str, vol.Required("name"): vol.All(str, vol.Length(max=60))})
@callback
def ws_places_name(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        core.places.rename(msg["place_id"], msg["name"])
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))
        return
    connection.send_result(msg["id"], core.places.view())


@websocket_api.websocket_command({vol.Required("type"): "house_rules/places/delete", vol.Required("place_id"): str})
@callback
def ws_places_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        core.places.delete(msg["place_id"])
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))
        return
    connection.send_result(msg["id"], core.places.view())


@websocket_api.websocket_command(
    {vol.Required("type"): "house_rules/places/to_zone", vol.Required("place_id"): str, vol.Optional("name"): vol.All(str, vol.Length(max=60)), vol.Optional("radius"): vol.All(vol.Coerce(float), vol.Range(min=20, max=5000))}
)
@websocket_api.async_response
async def ws_places_to_zone(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Turn a learned place into a Home Assistant zone. Answer: { zone_id }."""
    if (core := _core(hass, connection, msg)) is None:
        return
    try:
        zid = await core.places.to_zone(msg["place_id"], msg.get("name"), msg.get("radius"))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"zone_id": zid})


@websocket_api.websocket_command({vol.Required("type"): "house_rules/places/settings", vol.Optional("learn"): bool, vol.Optional("nominatim"): bool})
@callback
def ws_places_settings(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """learn: learn places and trips (default on); nominatim: street names from OpenStreetMap (default off)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], core.places.set_settings({k: msg[k] for k in ("learn", "nominatim") if k in msg}))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/places/relearn", vol.Optional("days", default=30): vol.All(int, vol.Range(min=1, max=60))})
@websocket_api.async_response
async def ws_places_relearn(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Learn again from the recorder history (names of places found again are kept)."""
    if (core := _core(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], await core.places.warm_start(relearn=True, days=msg["days"]))


@websocket_api.websocket_command({vol.Required("type"): "house_rules/places/forget"})
@callback
def ws_places_forget(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Delete everything learned: places, trips, timelines, cached street names."""
    if (core := _core(hass, connection, msg)) is None:
        return
    core.places.forget()
    connection.send_result(msg["id"], core.places.view())
