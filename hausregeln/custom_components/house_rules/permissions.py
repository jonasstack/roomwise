"""Roles in Hausregeln and the check that runs before every websocket command.

Three roles per Home Assistant user:
  * admin    – settings, devices, rooms, heating, light … (Home Assistant admins are always admins here); not what
               needs a real Home Assistant administrator (below),
  * resident – ("Bewohner") create and change rules and plans, use the alarm, switch the house mode; no security
               settings, no settings, no features,
  * guest    – ("Gast") see and use (run a rule, acknowledge the window warning), change nothing.
Default: Home Assistant admins = admin, every other user = resident. Admins change the roles in
Einstellungen → Rollen (stored in data["roles"]: {user_id: role}).

Every websocket command has a minimum role in COMMANDS; websocket.async_register wraps each handler with guard(),
so the check runs on the server, whatever a frontend shows. A command missing from the table needs an admin.

"ha_admin" = only a real Home Assistant administrator, whatever the role here: a user made "Admin" in Hausregeln must
never get more than Home Assistant gives them. That covers the security settings (alarm system, its Face ID devices,
object alarms), what sends data out of the house (AI connection: URLs and keys; diagnostics), switching features,
restoring a backup, changing roles, and everything that changes Home Assistant itself (its automations, zones).
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .i18n import tr

# i18n: complete

if TYPE_CHECKING:
    from homeassistant.auth.models import User
    from homeassistant.components.websocket_api import ActiveConnection

    from .core import HouseRules

ROLES = ("admin", "resident", "guest")
RANK = {"guest": 0, "resident": 1, "admin": 2, "ha_admin": 3}

# minimum role per command (house_rules/…)
COMMANDS: dict[str, str] = {
    # see and use: every role
    "info": "guest",
    "subscribe": "guest",
    "snapshot": "guest",
    "vocabulary": "guest",
    "history": "guest",
    "permissions": "guest",
    "rule/describe": "guest",
    "rule/test": "guest",
    "rule/entities": "guest",
    "rule/run": "guest",
    "rule/versions": "guest",
    "rule/export": "guest",
    "trash/list": "guest",
    "for_entity": "guest",
    "for_entities": "guest",
    "window_warning/get": "guest",
    "window_warning/ack": "guest",
    "alarm/challenge": "guest",
    "telemetry/get": "guest",
    "telemetry/client": "guest",
    "sim/view": "guest",
    "heating/explain": "guest",
    "heating/plan": "guest",
    "plan/habits": "guest",
    "light/learned": "guest",
    "places/get": "guest",
    "places/person": "guest",
    "places/predict": "guest",
    # rules, plans, the house mode and the alarm (with its confirmation): residents
    "rule/save": "resident",
    "rule/delete": "resident",
    "rule/enable": "resident",
    "rule/pause": "resident",
    "rule/run_actions": "resident",
    "rule/restore_version": "resident",
    "trash/restore": "resident",
    "from_text": "resident",
    "ai/review": "resident",
    "ai/improve": "resident",
    "suggestion/dismiss": "resident",
    "mode/set": "resident",
    "plan/set": "resident",
    "ui/set": "resident",  # page layout only (rule groups, order of room tiles), changes nothing that runs
    "glow/set": "resident",  # when the Reinschau-Licht may glow, like the light plans
    "lightcal/get": "resident",  # Lampen abgleichen (lightcal.py): corrections of colour per lamp
    "lightcal/set": "resident",
    "light/preview": "resident",  # live preview while editing a light setting; each lamp also needs HA control rights
    "heating/do": "resident",  # residents only "clear_manual" (room back to its plan), checked in the handler
    "alarm/arm": "resident",
    "alarm/disarm": "resident",
    "alarm/silence": "resident",
    "alarm/register_device": "resident",  # a non-admin also needs the alarm PIN, checked in the handler
    "objects/arm": "resident",  # object alarms ("Weitere Alarme"), like the house alarm
    "objects/disarm": "resident",  # with the house alarm's confirmation, checked in objects.py
    # settings, security, features: admins
    "room/save": "admin",
    "behaviour/set": "admin",
    "devices/set": "admin",
    "settings/set": "admin",
    "group/save": "admin",
    "group/delete": "admin",
    "suggestion/restore": "admin",
    "alarm/test": "admin",
    "alarm/preview_tone": "admin",
    "alarm/channel_test": "admin",
    "mode_auto/set": "admin",
    "wakeup/set": "admin",
    "wakeup/reset": "admin",
    "cleaning/set": "admin",
    "heating/set": "admin",
    "heating/assistant": "admin",
    "heating/test": "admin",
    "sim/set": "admin",
    "sim/learn": "admin",
    "setup/save": "admin",
    "setup/suggest": "admin",
    "setup/apply": "admin",
    "window_warning/set": "admin",
    "window_warning/import": "admin",
    "telemetry/preview": "admin",
    "backup/export": "admin",
    "backup/preview": "admin",
    "issues/check": "admin",
    "roles/get": "admin",
    "rule/exported": "admin",
    "trash/purge": "admin",
    "assistant/mark": "admin",
    "assistant/suggest": "admin",
    "assistant/apply": "admin",
    "light/forget": "admin",
    "places/name": "admin",
    "places/delete": "admin",
    "places/settings": "admin",
    "places/relearn": "admin",
    "places/forget": "admin",
    # only a real Home Assistant admin (never more than Home Assistant allows): security, data leaving the house, roles
    "alarm/config": "ha_admin",  # incl. removing Face ID devices; a user's own device with the PIN: alarm/register_device
    "objects/save": "ha_admin",
    "objects/delete": "ha_admin",
    "objects/test": "ha_admin",
    "ai/set": "ha_admin",  # outbound URL and API key
    "ai/test": "ha_admin",  # connects to any URL from the server
    "telemetry/set": "ha_admin",
    "telemetry/delete": "ha_admin",
    "telemetry/send_now": "ha_admin",
    "features/set": "ha_admin",  # e.g. switches the alarm system off
    "backup/restore": "ha_admin",  # replaces the alarm, roles, AI … in one go
    "roles/set": "ha_admin",
    # changes Home Assistant itself
    "automation/enable": "ha_admin",
    "places/to_zone": "ha_admin",  # creates a zone in Home Assistant
}

# the refusal per role of the asking user (texts/release.json)
DENIED = {"guest": "rel.denied_guest", "resident": "rel.denied_admin", "admin": "rel.denied_admin", "ha_admin": "rel.denied_ha_admin"}


def label(hass: HomeAssistant, role: str) -> str:
    return tr(hass, f"rel.role_{role}")


def stored_role(core: HouseRules | None, user_id: str) -> str | None:
    if core is None:
        return None
    role = (core.data.get("roles") or {}).get(user_id)
    return role if role in ROLES else None


def role_of(hass: HomeAssistant, user: User | None) -> str:
    """The role of a Home Assistant user in Hausregeln."""
    if user is None:
        return "guest"
    if user.is_admin:
        return "admin"
    return stored_role(hass.data.get(DOMAIN), user.id) or "resident"


def allowed(hass: HomeAssistant, user: User | None, need: str) -> bool:
    if need == "ha_admin":
        return bool(user and user.is_admin)
    return RANK[role_of(hass, user)] >= RANK.get(need, RANK["admin"])


def is_admin(hass: HomeAssistant, connection: ActiveConnection) -> bool:
    return role_of(hass, connection.user) == "admin"


def is_ha_admin(connection: ActiveConnection) -> bool:
    """A real Home Assistant administrator (the role in Hausregeln does not matter)."""
    return bool(connection.user and connection.user.is_admin)


def denied_text(hass: HomeAssistant, user: User | None, need: str) -> str:
    return tr(hass, DENIED["ha_admin"] if need == "ha_admin" else DENIED[role_of(hass, user)])


def need_of(command: str) -> str:
    return COMMANDS.get(command.removeprefix(f"{DOMAIN}/"), "admin")


def guard(handler: Callable[..., Any]) -> Callable[..., Any]:
    """Wraps a websocket handler (already decorated with websocket_command): refuses users below its role."""
    command = getattr(handler, "_ws_command", "")
    need = need_of(command)

    @functools.wraps(handler)  # keeps _ws_command / _ws_schema for async_register_command
    def wrapper(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> Any:
        if not allowed(hass, connection.user, need):
            connection.send_error(msg["id"], "unauthorized", denied_text(hass, connection.user, need))
            return None
        return handler(hass, connection, msg)

    return wrapper


def security_rule(rule: dict[str, Any] | None) -> bool:
    """A rule that switches the alarm system or may unlock locks / disarm (option allow_sensitive): admins only."""
    if not rule:
        return False
    if (rule.get("options") or {}).get("allow_sensitive"):
        return True
    return any(str(c.get("subject", "")) == "alarm" for s in ("then", "else") for c in rule.get(s) or [] if isinstance(c, dict))


def me(hass: HomeAssistant, user: User | None) -> dict[str, Any]:
    """What the panel needs to know about the person using it."""
    role = role_of(hass, user)
    ha_admin = bool(user and user.is_admin)
    return {
        "user_id": user.id if user else None,
        "name": (user.name or "") if user else "",
        "role": role,
        "label": label(hass, role),
        "ha_admin": ha_admin,
        "can": {
            "edit_rules": RANK[role] >= RANK["resident"],
            "edit_plans": RANK[role] >= RANK["resident"],
            "use_alarm": RANK[role] >= RANK["resident"],
            "settings": role == "admin",
            "security": ha_admin,  # alarm, object alarms, AI connection, diagnostics, backup restore, roles
            "features": ha_admin,
        },
    }


async def users_view(hass: HomeAssistant, core: HouseRules) -> list[dict[str, Any]]:
    """Every real Home Assistant user with its role (Einstellungen → Rollen)."""
    out = []
    for u in await hass.auth.async_get_users():
        if u.system_generated or not u.is_active:
            continue
        core.users[u.id] = u.name or ""
        role = role_of(hass, u)
        out.append({"id": u.id, "name": u.name or "", "role": role, "label": label(hass, role), "ha_admin": u.is_admin, "fixed": u.is_admin, "owner": u.is_owner})
    return sorted(out, key=lambda x: (not x["ha_admin"], x["name"].lower()))


async def set_role(hass: HomeAssistant, core: HouseRules, user_id: str, role: str) -> None:
    if role not in ROLES:
        raise ValueError(tr(hass, "rel.role_unknown"))
    user = await hass.auth.async_get_user(user_id)
    if user is None or user.system_generated:
        raise ValueError(tr(hass, "rel.user_unknown"))
    if user.is_admin:
        raise ValueError(tr(hass, "rel.ha_admin_fixed"))
    roles = core.data.setdefault("roles", {})
    if role == "resident":
        roles.pop(user_id, None)  # the default
    else:
        roles[user_id] = role
    core.save()
    core.push("all")  # every open panel learns its (new) role with the next snapshot
