"""Anonymous diagnostics ("Diagnosedaten"): opt-in, off by default, see PRIVACY.md at the repository root.

What it does while switched on (Einstellungen → Diagnosedaten, or the last step of the setup wizard):
  * once a week a bundle of counts goes to the roomwise diagnostics server (ENDPOINT): versions, language,
    unit system, entities per domain / device class, integration platforms with counts, capability shapes
    (e.g. a thermostat's hvac modes and step), which roomwise features are on, how many rules and plans exist,
    and which browsers / graphics tiers the floor plan cards ran on (reported by the cards, counted per day);
  * errors raised inside roomwise code: exception type and our own stack frames (file:line function), never
    the message (it may contain names). At most MAX_ERRORS_PER_DAY reports a day, each error once a day.

Never sent: entity ids, names, areas, zones, persons, coordinates, IP addresses, tokens, free text. The report
is built only from enumerations and counts, and a last guard (`_scrub`) drops any value that equals an entity id
or a name of this home before anything leaves the house. `preview()` shows exactly what would be sent.

Until the owner deploys the server, ENDPOINT is empty: the switch shows "noch nicht verfügbar" and nothing is sent.
Sending uses Home Assistant's own HTTP client with short timeouts and fails silently.

Errors are also kept locally (last few, in memory) for the diagnostics download (diagnostics.py), on or off.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
import hashlib
import logging
import platform
import re
import time
import traceback
from datetime import timedelta
from typing import TYPE_CHECKING, Any
import uuid

import aiohttp

from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import VERSION

if TYPE_CHECKING:
    from datetime import datetime

    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

# The diagnostics server (telemetry/worker in the repository). Empty = not deployed yet: nothing is sent.
# The owner sets it once after `wrangler deploy`, e.g. "https://roomwise-telemetry.<account>.workers.dev".
ENDPOINT = ""
PRIVACY_URL = "https://github.com/jonasstack/roomwise/blob/main/PRIVACY.md"

SCHEMA = 1
STORAGE_KEY = "house_rules.telemetry"
REPORT_EVERY = 7 * 86400
MAX_ERRORS_PER_DAY = 10
MAX_FRAMES = 25
RECENT_LOCAL = 20
TIMEOUT = aiohttp.ClientTimeout(total=15)
OUR_PACKAGES = ("roomwise", "house_rules", "floorplan_card")
# roomwise/house_rules/… and roomwise/card/… (the two parts, reported under their own names as before the merge),
# the integration's own files (roomwise/migrate.py …) and the folders of the former integrations
_OUR_PATH = re.compile(r"[\\/]custom_components[\\/](?:roomwise[\\/](house_rules|card)|(house_rules|floorplan_card))[\\/](.+)$")


def _part(m: re.Match[str]) -> str:
    """"house_rules/core.py" / "floorplan_card/vacuum.py" for a path matched by _OUR_PATH"""
    name = m.group(1) or m.group(2)
    return f"{'floorplan_card' if name == 'card' else name}/{m.group(3).replace(chr(92), '/')}"

# what a card may report about the browser it runs in (house_rules/telemetry/client); anything else is dropped
CLIENT_FIELDS: dict[str, tuple[str, ...] | None] = {
    "browser": ("chrome", "edge", "firefox", "safari", "samsung", "opera", "ha_app", "fully", "other"),
    "engine": ("blink", "gecko", "webkit", "other"),
    "engine_version": None,  # major version, int 0–999
    "webgl": ("none", "webgl1", "webgl2"),
    "gpu": ("adreno", "mali", "powervr", "apple", "intel", "nvidia", "amd", "software", "other", "unknown"),
    "tier": ("fast", "ok", "slow", "very_slow", "2d"),
    "profile": ("high", "eco"),
    "view": ("2d", "3d"),
    "screen": ("phone", "tablet", "desktop"),
    "cores": ("1-2", "3-4", "5-8", "9+", "unknown"),
}
SHAPE_DOMAINS = ("climate", "light", "cover", "media_player", "vacuum", "lock", "fan", "alarm_control_panel", "valve", "water_heater", "humidifier")


def _device_classes() -> set[str]:
    """Every device class Home Assistant itself knows (others are counted as "other": they could be free text)."""
    out: set[str] = set()
    for mod, name in (
        ("binary_sensor", "BinarySensorDeviceClass"),
        ("sensor", "SensorDeviceClass"),
        ("cover", "CoverDeviceClass"),
        ("media_player", "MediaPlayerDeviceClass"),
        ("switch", "SwitchDeviceClass"),
        ("button", "ButtonDeviceClass"),
        ("number", "NumberDeviceClass"),
        ("valve", "ValveDeviceClass"),
        ("humidifier", "HumidifierDeviceClass"),
        ("event", "EventDeviceClass"),
        ("update", "UpdateDeviceClass"),
    ):
        try:
            module = __import__(f"homeassistant.components.{mod}", fromlist=[name])
            out |= {str(v.value) for v in getattr(module, name)}
        except (ImportError, AttributeError):
            continue
    return out


def _enum_values(mod: str, name: str) -> set[str]:
    try:
        module = __import__(f"homeassistant.components.{mod}", fromlist=[name])
        return {str(v.value) for v in getattr(module, name)}
    except (ImportError, AttributeError):
        return set()


def _day(ts: float | None = None) -> str:
    return dt_util.utc_from_timestamp(ts if ts is not None else time.time()).strftime("%Y-%m-%d")


def our_frames(tb: Any) -> list[str]:
    """Stack frames inside roomwise code only, as "house_rules/core.py:123 rebuild" (no paths, no values)."""
    out = []
    for fr in traceback.extract_tb(tb):
        m = _OUR_PATH.search(fr.filename or "")
        if m:
            out.append(f"{_part(m)}:{fr.lineno} {fr.name}"[:160])
    return out[-MAX_FRAMES:]


class _ErrorHandler(logging.Handler):
    """Sees every ERROR record of Home Assistant; keeps only those whose traceback runs through roomwise code."""

    def __init__(self, sink: Callable[[str, list[str]], None]) -> None:
        super().__init__(logging.ERROR)
        self._sink = sink

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if record.exc_info and record.exc_info[1] is not None:
                frames = our_frames(record.exc_info[2])
                if frames:
                    self._sink(type(record.exc_info[1]).__name__[:80], frames)
                return
            # an error we log ourselves without exception: only where it was logged (the message may contain names)
            m = _OUR_PATH.search(record.pathname or "")
            if m:
                self._sink("LoggedError", [f"{_part(m)}:{record.lineno} {record.funcName}"[:160]])
        except Exception:  # noqa: BLE001 - a logging handler must never raise
            pass


class Telemetry:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._store: Store[dict[str, Any]] = Store(hass, 1, STORAGE_KEY)
        self.data: dict[str, Any] = {}
        self.recent: list[dict[str, Any]] = []  # local only (diagnostics download)
        self._handler = _ErrorHandler(self._error)
        self._unsubs: list[Callable[[], None]] = []
        self._sending = False
        self.last_result: str | None = None

    # ------------------------------------------------------------------ lifecycle
    async def async_load(self) -> None:
        self.data = await self._store.async_load() or {}
        self.data.setdefault("on", False)
        self.data.setdefault("clients", {})
        self.data.setdefault("errors", {})
        self.data.setdefault("pending_delete", [])
        logging.getLogger().addHandler(self._handler)

    def start(self) -> None:
        """Timers (once Home Assistant runs): hourly check whether the weekly report or errors are due."""
        self.stop_timers()
        self._unsubs.append(async_track_time_interval(self.hass, self._tick, timedelta(hours=1), name="house_rules telemetry"))
        self._unsubs.append(async_call_later(self.hass, 300, self._tick))

    def stop_timers(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()

    async def async_stop(self) -> None:
        self.stop_timers()
        logging.getLogger().removeHandler(self._handler)
        await self._store.async_save(self.data)

    def _save(self) -> None:
        self._store.async_delay_save(lambda: self.data, 5)

    # ------------------------------------------------------------------ state
    @property
    def available(self) -> bool:
        return bool(ENDPOINT)

    @property
    def on(self) -> bool:
        return bool(self.data.get("on"))

    def view(self, admin: bool = False) -> dict[str, Any]:
        last = self.data.get("last_report") or 0
        out: dict[str, Any] = {
            "on": self.on,
            "available": self.available,
            "asked": bool(self.data.get("asked")),
            "last_report": dt_util.utc_from_timestamp(last).isoformat() if last else None,
            "next_report": dt_util.utc_from_timestamp(last + REPORT_EVERY).isoformat() if self.on and last else None,
            "errors_pending": len([e for e in self.data["errors"].values() if e.get("count")]) if self.on else 0,
            "privacy_url": PRIVACY_URL,
            "last_result": self.last_result,
        }
        if admin:
            out["install_id"] = self.data.get("install_id") if self.on else None
        return out

    async def set_on(self, on: bool) -> dict[str, Any]:
        self.data["asked"] = True
        if on == self.on:
            self._save()
            return self.view(True)
        old = self.data.get("install_id")
        if on:
            # a fresh random id every time: nothing links it to an earlier opt-in
            self.data.update(on=True, install_id=str(uuid.uuid4()), last_report=0, clients={}, errors={}, sent={})
        else:
            self.data.update(on=False, install_id=None, clients={}, errors={}, sent={})
            if old and self.available:
                # switching off also deletes what the server has (retried hourly when offline)
                self.data["pending_delete"] = [*self.data["pending_delete"], old][-5:]
        self._save()
        if not on:
            self.hass.async_create_background_task(self._retry_deletes(), "house_rules_telemetry_delete")
        return self.view(True)

    async def delete_remote(self) -> dict[str, Any]:
        """ "Meine Daten löschen": delete everything under the current id on the server; a new id from now on."""
        old = self.data.get("install_id")
        if not self.available:
            return {"ok": False, "error": "not_available"}
        if not old:
            return {"ok": True, "deleted": False}
        ok = await self._delete(old)
        if not ok:
            self.data["pending_delete"] = [*self.data["pending_delete"], old][-5:]
        if self.on:
            self.data.update(install_id=str(uuid.uuid4()), last_report=0, clients={}, errors={}, sent={})
        self._save()
        return {"ok": ok, "deleted": ok, "retry": not ok}

    # ------------------------------------------------------------------ what cards report
    def client(self, raw: dict[str, Any]) -> bool:
        """A floor plan card reports its browser and performance tier (counted per day, sent with the weekly report)."""
        if not self.on:
            return False
        rec: dict[str, Any] = {}
        for k, allowed in CLIENT_FIELDS.items():
            v = raw.get(k)
            if allowed is None:
                rec[k] = int(v) if isinstance(v, (int, float)) and 0 <= v < 1000 else 0
            else:
                rec[k] = v if v in allowed else (allowed[-1] if k in ("gpu", "cores") else "other" if "other" in allowed else allowed[0])
        key = "|".join(f"{k}={rec[k]}" for k in CLIENT_FIELDS)
        day = self.data["clients"].setdefault(_day(), {})
        if len(day) < 50 or key in day:
            day[key] = min(9999, day.get(key, 0) + 1)
        # keep a week and a bit
        for d in sorted(self.data["clients"])[:-8]:
            del self.data["clients"][d]
        self._save()
        return True

    # ------------------------------------------------------------------ errors
    def _error(self, exc_type: str, frames: list[str]) -> None:
        # may run in any thread (executor jobs log too): hand over to the event loop
        if self.hass.loop.is_running():
            self.hass.loop.call_soon_threadsafe(self._error_in_loop, exc_type, frames)

    @callback
    def _error_in_loop(self, exc_type: str, frames: list[str]) -> None:
        fp = hashlib.sha256((exc_type + "|" + "|".join(re.sub(r":\d+ ", " ", f) for f in frames)).encode()).hexdigest()[:24]
        now = time.time()
        rec = next((r for r in self.recent if r["fingerprint"] == fp), None)
        if rec:
            rec.update(count=rec["count"] + 1, last=now, frames=frames)
        else:
            self.recent.append({"fingerprint": fp, "type": exc_type, "frames": frames, "count": 1, "first": now, "last": now})
            self.recent = self.recent[-RECENT_LOCAL:]
        if not self.on:
            return
        errs = self.data["errors"]
        e = errs.get(fp)
        if e is None:
            if len(errs) >= 50:
                return
            e = errs[fp] = {"type": exc_type, "frames": frames, "count": 0}
        e["count"] += 1
        e["frames"] = frames
        self._save()

    def _error_payloads(self) -> list[dict[str, Any]]:
        today = _day()
        out = []
        for fp, e in self.data["errors"].items():
            if not e.get("count") or e.get("sent_day") == today:
                continue
            out.append(
                {
                    "schema": SCHEMA,
                    "install_id": self.data.get("install_id") or "",
                    "fingerprint": fp,
                    "type": e["type"],
                    "frames": e["frames"],
                    "count": min(int(e["count"]), 100000),
                    "versions": {"roomwise": VERSION, "ha": HA_VERSION},
                }
            )
        return out

    # ------------------------------------------------------------------ the report
    async def build_report(self) -> dict[str, Any]:
        hass = self.hass
        core = self.core
        ents = er.async_get(hass)
        devices = dr.async_get(hass)
        known_dc = _device_classes()
        hvac = _enum_values("climate", "HVACMode")
        color_modes = _enum_values("light", "ColorMode")

        domains: Counter[str] = Counter()
        dclasses: Counter[str] = Counter()
        platforms: dict[str, Counter[str]] = {}
        shapes: Counter[tuple[str, str, str]] = Counter()
        public = await self._public_platforms({e.platform for e in ents.entities.values()})
        for st in hass.states.async_all():
            d = st.domain
            domains[d] += 1
            reg = ents.async_get(st.entity_id)
            plat = public.get(reg.platform, "custom") if reg else "unregistered"
            platforms.setdefault(d, Counter())[plat] += 1
            dc = st.attributes.get("device_class")
            if isinstance(dc, str):
                dclasses[f"{d}:{dc if dc in known_dc else 'other'}"] += 1
            if d in SHAPE_DOMAINS:
                shapes[(d, plat, self._shape(st, hvac, color_modes, reg, devices))] += 1

        hr_rules = core.rules()
        plans = core.data.get("plans", {})
        report: dict[str, Any] = {
            "schema": SCHEMA,
            "install_id": self.data.get("install_id") or "",
            "period_days": 7,
            "versions": {
                "roomwise": VERSION,
                "house_rules": VERSION,
                "floorplan_card": self._floorplan_version(),
                "ha": HA_VERSION,
                "python": ".".join(platform.python_version_tuple()[:2]),
            },
            "ha": {
                "language": str(hass.config.language or "")[:10],
                "unit_system": "metric" if getattr(hass.config.units, "_name", "metric") == "metric" else "us_customary",
                "installation": await self._installation(),
            },
            "entities": {"domains": dict(domains), "device_classes": dict(dclasses)},
            "platforms": {d: dict(c) for d, c in platforms.items()},
            "shapes": [{"domain": d, "platform": p, "shape": s, "count": n} for (d, p, s), n in shapes.most_common(300)],
            "features": core.features.view(),
            "roomwise": self._roomwise(),
            "counts": {
                "rules": len(hr_rules),
                "rules_while": sum(1 for r in hr_rules if r.get("type") == "while"),
                "rules_from_text": sum(1 for r in hr_rules if r.get("meta", {}).get("origin") == "text"),
                "groups": len(core.data.get("groups", [])),
                "rooms": len(core.rooms),
                "light_plans": sum(1 for p in plans.get("light", {}).values() if isinstance(p, dict) and p.get("on")),
                "heat_plans": sum(1 for p in plans.get("heat", {}).values() if isinstance(p, dict) and p.get("on")),
                "ha_automations": len(hass.states.async_entity_ids("automation")),
                "areas": len(ar.async_get(hass).areas),
                "persons": len(hass.states.async_entity_ids("person")),
            },
            "clients": self._clients(),
        }
        return self._scrub(report, set(domains) | {p for c in platforms.values() for p in c})

    def _shape(self, st: Any, hvac: set[str], color_modes: set[str], reg: Any, devices: Any) -> str:
        """The capabilities of one entity as a short string of standard values only (no names)."""
        a = st.attributes
        parts = [f"sf={int(a.get('supported_features') or 0)}"]
        d = st.domain
        if d == "climate":
            modes = sorted(m for m in (a.get("hvac_modes") or []) if m in hvac)
            parts.append("hvac=" + ",".join(modes))
            if isinstance(a.get("target_temp_step"), (int, float)):
                parts.append(f"step={float(a['target_temp_step']):g}")
            parts.append(f"presets={min(len(a.get('preset_modes') or []), 20)}")
            if "current_temperature" in a:
                parts.append("cur")
            try:
                src = self.core.heating._valve_source(st.entity_id)  # noqa: SLF001
            except Exception:  # noqa: BLE001
                src = None
            if src:
                parts.append("valve=" + (src if src.startswith("attr:") else "entity:" + src.split(".")[0]))
        elif d == "light":
            parts.append("cm=" + ",".join(sorted(m for m in (a.get("supported_color_modes") or []) if m in color_modes)))
            parts.append(f"effects={min(len(a.get('effect_list') or []), 50)}")
        elif d == "vacuum":
            parts.append(f"fan={min(len(a.get('fan_speed_list') or []), 20)}")
        elif d in ("fan", "humidifier"):
            parts.append(f"presets={min(len(a.get('preset_modes') or a.get('available_modes') or []), 20)}")
        elif d == "alarm_control_panel":
            parts.append(f"code={1 if a.get('code_arm_required') else 0}")
        if d in ("cover", "media_player", "valve") and isinstance(a.get("device_class"), str):
            parts.append(f"dc={a['device_class'][:30]}" if re.fullmatch(r"[a-z_]{1,30}", a["device_class"]) else "dc=other")
        return ";".join(parts)[:200]

    async def _public_platforms(self, names: set[str]) -> dict[str, str]:
        """Integration names as they may be reported: built-in ones and published custom ones (a GitHub link in
        their manifest, e.g. from HACS). A private custom integration is reported only as "custom"."""
        from homeassistant.loader import async_get_integrations  # noqa: PLC0415

        out: dict[str, str] = {}
        found = await async_get_integrations(self.hass, [n for n in names if n])
        for name, integ in found.items():
            if isinstance(integ, Exception):
                continue
            if integ.is_built_in:
                out[name] = name
                continue
            m = integ.manifest
            links = f"{m.get('documentation') or ''} {m.get('issue_tracker') or ''}"
            if "https://github.com/" in links and m.get("version") and re.fullmatch(r"[a-z0-9_]{2,50}", name):
                out[name] = name
        return out

    async def _installation(self) -> str:
        try:
            from homeassistant.helpers.system_info import async_get_system_info  # noqa: PLC0415

            info = await async_get_system_info(self.hass)
            kind = str(info.get("installation_type") or "unknown")
            return kind[:40] if kind in ("Home Assistant OS", "Home Assistant Container", "Home Assistant Supervised", "Home Assistant Core") else "other"
        except Exception:  # noqa: BLE001
            return "unknown"

    def _floorplan_version(self) -> str | None:
        if self.hass.data.get("floorplan_card") is None:
            return None
        try:
            from ..card.const import VERSION as FP  # noqa: PLC0415

            return str(FP)[:30]
        except Exception:  # noqa: BLE001
            return "unknown"

    def _roomwise(self) -> dict[str, Any]:
        """Which roomwise parts are in use (floor plan card companion: cards, warning, dogs, robot vacuum adapters)."""
        out: dict[str, Any] = {"floorplan_card": self.hass.data.get("floorplan_card") is not None, "cards": 0, "entry_alert": False, "pets": 0, "vacuum_adapters": {}}
        fp = self.hass.data.get("floorplan_card")
        cards = getattr(fp, "cards", None)
        if isinstance(cards, dict):
            ents = er.async_get(self.hass)
            adapters: Counter[str] = Counter()
            out["cards"] = len(cards)
            for card in cards.values():
                if not isinstance(card, dict):
                    continue
                out["entry_alert"] = out["entry_alert"] or bool(card.get("entry_alert"))
                out["pets"] += len(card.get("pets") or [])
                for v in card.get("vacuums") or []:
                    reg = ents.async_get(v.get("entity", "")) if isinstance(v, dict) else None
                    adapters[reg.platform if reg and reg.platform == "roborock" else "other"] += 1
            out["vacuum_adapters"] = dict(adapters)
        out["pets"] = min(out["pets"], 50)
        return out

    def _clients(self) -> list[dict[str, Any]]:
        total: Counter[str] = Counter()
        cutoff = _day(time.time() - 7 * 86400)
        for day, keys in self.data["clients"].items():
            if day > cutoff:
                total.update(keys)
        out = []
        for key, n in total.most_common(50):
            rec: dict[str, Any] = dict(p.split("=", 1) for p in key.split("|"))
            rec["engine_version"] = int(rec.get("engine_version") or 0)
            rec["count"] = n
            out.append(rec)
        return out

    def _identifiers(self) -> set[str]:
        """Strings of this home that must never leave it: entity ids, names of devices, areas, persons, zones, users."""
        hass = self.hass
        out: set[str] = set(hass.states.async_entity_ids())
        out |= {e.entity_id for e in er.async_get(hass).entities.values()}
        for a in ar.async_get(hass).areas.values():
            out |= {a.id, a.name}
        for d in dr.async_get(hass).devices.values():
            out |= {x for x in (d.name, d.name_by_user) if x}
        for st in hass.states.async_all(("person", "zone")):
            out |= {st.object_id, str(st.attributes.get("friendly_name") or "")}
        for st in hass.states.async_all():
            fn = st.attributes.get("friendly_name")
            if isinstance(fn, str):
                out.add(fn)
        out |= {n for n in self.core.users.values() if n}
        out.add(str(hass.config.location_name or ""))
        # words the report itself is built from (domains, platforms …) are not identifying
        return {x for x in out if isinstance(x, str) and len(x) >= 3 and x not in _vocabulary()}

    def _scrub(self, payload: dict[str, Any], allowed: set[str] | None = None) -> dict[str, Any]:
        """Last guard: drop any key or value that is an entity id or a name of this home (defense in depth).
        `allowed`: words of the report itself (domains, public integration names) that are not identifying."""
        ids = self._identifiers() - (allowed or set())
        entity_like = re.compile(r"\b[a-z_]+\.[a-z0-9_]+\b")

        def bad(s: str) -> bool:
            if s in ids:
                return True
            return any(m.group(0) in ids for m in entity_like.finditer(s))

        def walk(x: Any) -> Any:
            if isinstance(x, dict):
                return {k: walk(v) for k, v in x.items() if not (isinstance(k, str) and bad(k))}
            if isinstance(x, list):
                return [walk(v) for v in x]
            if isinstance(x, str) and bad(x):
                return "?"
            return x

        return walk(payload)

    # ------------------------------------------------------------------ preview / sending
    async def preview(self) -> dict[str, Any]:
        """Exactly what would be sent next: the weekly report and the error reports due."""
        report = await self.build_report()
        if not self.on:
            report["install_id"] = "(neue zufällige Kennung beim Einschalten)"
        return {"available": self.available, "endpoint": ENDPOINT or None, "report": report, "errors": self._scrub({"e": self._error_payloads()})["e"] if self.on else []}

    async def _tick(self, _now: datetime | None = None) -> None:
        await self._retry_deletes()
        if not (self.on and self.available) or self._sending:
            return
        if time.time() - (self.data.get("last_report") or 0) >= REPORT_EVERY:
            await self.send_report()
        await self.send_errors()

    async def send_now(self) -> dict[str, Any]:
        if not self.on:
            return {"ok": False, "error": "off"}
        if not self.available:
            return {"ok": False, "error": "not_available"}
        ok = await self.send_report()
        await self.send_errors()
        return {"ok": ok}

    async def send_report(self) -> bool:
        self._sending = True
        try:
            report = await self.build_report()
            ok = await self._post("/v1/report", report)
            if ok:
                self.data["last_report"] = time.time()
                self.data["clients"] = {}
                self._save()
            return ok
        finally:
            self._sending = False

    async def send_errors(self) -> int:
        sent = self.data.setdefault("sent", {})
        today = _day()
        if sent.get("day") != today:
            sent.update(day=today, errors=0)
        n = 0
        for p in self._error_payloads():
            if sent["errors"] >= MAX_ERRORS_PER_DAY:
                break
            p = self._scrub(p)
            if not await self._post("/v1/error", p):
                break
            e = self.data["errors"][p["fingerprint"]]
            e.update(count=0, sent_day=today)
            sent["errors"] += 1
            n += 1
        if n:
            self._save()
        return n

    async def _post(self, path: str, payload: dict[str, Any]) -> bool:
        if not ENDPOINT:
            return False
        try:
            session = async_get_clientsession(self.hass)
            async with session.post(ENDPOINT.rstrip("/") + path, json=payload, timeout=TIMEOUT) as resp:
                self.last_result = f"{path} {resp.status}"
                return resp.status < 300
        except Exception as err:  # noqa: BLE001 - diagnostics must never disturb the home
            self.last_result = f"{path} {type(err).__name__}"
            _LOGGER.debug("telemetry: %s not sent (%s)", path, type(err).__name__)
            return False

    async def _delete(self, install_id: str) -> bool:
        if not ENDPOINT:
            return False
        try:
            session = async_get_clientsession(self.hass)
            async with session.delete(f"{ENDPOINT.rstrip('/')}/v1/install/{install_id}", timeout=TIMEOUT) as resp:
                self.last_result = f"delete {resp.status}"
                return resp.status < 300 or resp.status == 404
        except Exception as err:  # noqa: BLE001
            self.last_result = f"delete {type(err).__name__}"
            return False

    async def _retry_deletes(self) -> None:
        pend = list(self.data.get("pending_delete") or [])
        if not pend or not self.available:
            return
        left = [i for i in pend if not await self._delete(i)]
        if left != pend:
            self.data["pending_delete"] = left
            self._save()


async def forget_install(hass: HomeAssistant) -> None:
    """Removing the integration: ask the server to delete what it has of this install (best effort, only if
    diagnostics were ever on), then delete the local file."""
    store: Store[dict[str, Any]] = Store(hass, 1, STORAGE_KEY)
    data = await store.async_load() or {}
    ids = [i for i in [data.get("install_id"), *(data.get("pending_delete") or [])] if i]
    if ids and ENDPOINT:
        t = Telemetry(hass, None)  # type: ignore[arg-type]  # only its HTTP helper is used, no core needed
        for i in ids:
            await t._delete(i)  # noqa: SLF001
    await store.async_remove()


_VOCAB: set[str] | None = None


def _vocabulary() -> set[str]:
    """Words the report may contain anyway (so a device called e.g. "light" does not blank the report)."""
    global _VOCAB  # noqa: PLW0603
    if _VOCAB is None:
        words = set(SHAPE_DOMAINS) | {v for vals in CLIENT_FIELDS.values() if vals for v in vals}
        words |= _device_classes() | _enum_values("climate", "HVACMode") | _enum_values("light", "ColorMode")
        words |= {"custom", "unregistered", "metric", "us_customary", "other", "unknown"}
        _VOCAB = words
    return _VOCAB
