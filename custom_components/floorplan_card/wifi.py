"""Wi-Fi networks for the QR codes on the tablets (a tap on a router in the plan).

The networks of the home (name, SSID, password, encryption, hidden) live here, in their own storage file, and not
in the dashboard config: a dashboard's YAML can be read by everyone who may open the dashboard (and ends up in
exports and screenshots of the editor). Only admins change them. Whoever may open the popup on a tablet sees the
QR code anyway, so signed-in users can read the networks marked for everyone; networks marked "admins only" go to
admins alone. Passwords never go into diagnostics or the log.

  floorplan_card.wifi   {"networks": [{"id", "name", "ssid", "password", "security", "hidden", "admins_only"}]}
"""

from __future__ import annotations

import re
import secrets
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

WIFI_KEY = "floorplan_card.wifi"
STORE_VERSION = 1
MAX_NETWORKS = 10
MAX_NAME = 60
SECURITY = ("wpa", "wpa2", "wpa3", "nopass")
ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
HEX64_RE = re.compile(r"^[0-9A-Fa-f]{64}$")


class WifiError(Exception):
    """A request the store refuses: `code` goes to the websocket error (never the password)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def clean_network(net: Any, taken: set[str]) -> dict[str, Any]:
    """One network checked the way a phone would refuse it: SSID 1–32 bytes, WPA passphrase 8–63 characters
    (or 64 hex digits), no password for an open network."""
    if not isinstance(net, dict):
        raise WifiError("invalid", "every network must be an object")
    ssid = net.get("ssid")
    if not isinstance(ssid, str) or not 1 <= len(ssid.encode()) <= 32:
        raise WifiError("invalid", "the SSID must be 1 to 32 bytes")
    security = net.get("security", "wpa2")
    if security not in SECURITY:
        raise WifiError("invalid", f"security must be one of {', '.join(SECURITY)}")
    password = net.get("password") or ""
    if not isinstance(password, str):
        raise WifiError("invalid", "the password must be text")
    if security == "nopass":
        password = ""
    elif not (8 <= len(password) <= 63 or HEX64_RE.match(password)) or any(ord(c) < 32 for c in password):
        raise WifiError("invalid_password", f"the password of {ssid!r} must have 8 to 63 characters")
    nid = net.get("id")
    if not isinstance(nid, str) or not ID_RE.match(nid) or nid in taken:
        nid = f"net_{secrets.token_hex(4)}"
    name = net.get("name")
    return {
        "id": nid,
        "name": (name.strip()[:MAX_NAME] if isinstance(name, str) else "") or ssid,
        "ssid": ssid,
        "password": password,
        "security": security,
        "hidden": bool(net.get("hidden")),
        "admins_only": bool(net.get("admins_only")),
    }


class WifiStore:
    """The home's Wi-Fi networks (one list for every card: it is the home's Wi-Fi, not a plan's)."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, WIFI_KEY)
        self.networks: list[dict[str, Any]] = []

    async def async_load(self) -> None:
        self.networks = ((await self._store.async_load()) or {}).get("networks", [])

    def visible(self, admin: bool) -> list[dict[str, Any]]:
        """What a user may see (and so scan): everything for admins, the networks for everyone otherwise."""
        keys = ("id", "name", "ssid", "password", "security", "hidden") + (("admins_only",) if admin else ())
        return [{k: n.get(k) for k in keys} for n in self.networks if admin or not n.get("admins_only")]

    def set(self, networks: Any) -> int:
        if not isinstance(networks, list):
            raise WifiError("invalid", "networks must be a list")
        if len(networks) > MAX_NETWORKS:
            raise WifiError("too_many", f"at most {MAX_NETWORKS} networks")
        taken: set[str] = set()
        clean = []
        for net in networks:
            n = clean_network(net, taken)
            taken.add(n["id"])
            clean.append(n)
        self.networks = clean
        self._store.async_delay_save(lambda: {"networks": self.networks}, 1)
        return len(clean)

    def summary(self) -> dict[str, Any]:
        """For diagnostics: counts only (no names, SSIDs or passwords)"""
        return {"networks": len(self.networks), "admins_only": sum(1 for n in self.networks if n.get("admins_only"))}

    async def async_remove(self) -> None:
        await self._store.async_remove()
