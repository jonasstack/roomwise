"""One door for every phone message of Hausregeln ("Benachrichtigungen"): how often, which kinds, to whom, how loud.

Every part that writes to a phone (ventilation reminders, window warning, alarm info, rule messages, "tell me when
it ran") asks here first. Per kind there is a minimum gap per occasion and person, a daily maximum per person and a
switch; quiet hours hold back or silence what is not urgent; a person can switch kinds off for themselves. The same
occasion always carries the same tag, so a new message replaces the old one on the phone instead of piling up, and
calm kinds arrive without sound ("passive" on iOS, a low channel that alerts once on Android).

Real alarms (house or object alarm triggered, pre-alarm, the reminders while it goes off) never pass through the
limits: they go out at once, see alarm.py.

What was sent when is kept in the store (runtime.notify), so a restart or a changed setting does not start the
counting again.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any

from homeassistant.core import Context
from homeassistant.util import dt as dt_util

from .i18n import tr

if TYPE_CHECKING:
    from .core import HouseRules

# i18n: complete

_LOGGER = logging.getLogger(__name__)

# kind → defaults: on, gap (minutes between two messages of the same occasion to one person), daily (per person)
# quiet: what happens during the quiet hours – "hold" (not sent), "silent" (sent without sound), "normal"
KINDS: dict[str, dict[str, Any]] = {
    "vent": {"on": True, "gap": 120, "daily": 3, "quiet": "hold", "calm": True},
    "window": {"on": True, "gap": 15, "daily": 8, "quiet": "silent", "calm": False},
    "alarm_info": {"on": True, "gap": 5, "daily": 10, "quiet": "silent", "calm": True},
    "rule": {"on": True, "gap": 1, "daily": 30, "quiet": "normal", "calm": False},
    "rule_report": {"on": True, "gap": 30, "daily": 10, "quiet": "hold", "calm": True},
    "wakeup": {"on": True, "gap": 0, "daily": 3, "quiet": "silent", "calm": True},  # "Aufstehen erkannt – stimmt das?" (wakeup.py)
}
DEFAULTS: dict[str, Any] = {"quiet": {"on": True, "from": "22:00", "to": "07:00"}}
KEEP_DAYS = 2  # gaps longer than this do not exist; older entries are dropped


def _hm(value: Any) -> int | None:
    try:
        h, m = str(value).split(":")[:2]
        return (int(h) % 24) * 60 + int(m) % 60
    except (ValueError, AttributeError):
        return None


def _clean_time(value: Any, default: str) -> str:
    m = _hm(value)
    return f"{m // 60:02d}:{m % 60:02d}" if m is not None else default


def _num(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        return max(lo, min(hi, float(value)))
    except (TypeError, ValueError):
        return default


class Notifier:
    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self.hass = core.hass

    # ------------------------------------------------------------------ settings
    @property
    def config(self) -> dict[str, Any]:
        raw = self.core.data.get("settings", {}).get("notifications") or {}
        kinds_raw = raw.get("kinds") if isinstance(raw.get("kinds"), dict) else {}
        kinds = {}
        for k, d in KINDS.items():
            r = kinds_raw.get(k) if isinstance(kinds_raw.get(k), dict) else {}
            kinds[k] = {"on": bool(r.get("on", d["on"])), "gap": _num(r.get("gap", d["gap"]), d["gap"], 0, 1440), "daily": int(_num(r.get("daily", d["daily"]), d["daily"], 0, 100))}
        q = raw.get("quiet") if isinstance(raw.get("quiet"), dict) else {}
        persons_raw = raw.get("persons") if isinstance(raw.get("persons"), dict) else {}
        persons = {str(pid): {"off": [k for k in (p.get("off") or []) if k in KINDS]} for pid, p in persons_raw.items() if isinstance(p, dict)}
        return {
            "kinds": kinds,
            "quiet": {"on": bool(q.get("on", DEFAULTS["quiet"]["on"])), "from": _clean_time(q.get("from"), DEFAULTS["quiet"]["from"]), "to": _clean_time(q.get("to"), DEFAULTS["quiet"]["to"])},
            "persons": persons,
        }

    def clean(self, raw: Any) -> dict[str, Any]:
        """Settings as they are stored (from Einstellungen → Benachrichtigungen); unknown keys are dropped."""
        cur = self.config
        if not isinstance(raw, dict):
            return cur
        if isinstance(raw.get("kinds"), dict):
            for k, v in raw["kinds"].items():
                if k in KINDS and isinstance(v, dict):
                    c = cur["kinds"][k]
                    cur["kinds"][k] = {"on": bool(v.get("on", c["on"])), "gap": _num(v.get("gap", c["gap"]), c["gap"], 0, 1440), "daily": int(_num(v.get("daily", c["daily"]), c["daily"], 0, 100))}
        if isinstance(q := raw.get("quiet"), dict):
            c = cur["quiet"]
            cur["quiet"] = {"on": bool(q.get("on", c["on"])), "from": _clean_time(q.get("from", c["from"]), c["from"]), "to": _clean_time(q.get("to", c["to"]), c["to"])}
        if isinstance(ps := raw.get("persons"), dict):
            cur["persons"] = {str(pid)[:60]: {"off": [k for k in (p.get("off") or []) if k in KINDS]} for pid, p in list(ps.items())[:30] if isinstance(p, dict)}
        return cur

    def quiet_now(self) -> bool:
        q = self.config["quiet"]
        if not q["on"]:
            return False
        a, z = _hm(q["from"]) or 0, _hm(q["to"]) or 0
        now = dt_util.now()
        m = now.hour * 60 + now.minute
        return a <= m < z if a <= z else (m >= a or m < z)

    # ------------------------------------------------------------------ memory (kept in the store)
    @property
    def _mem(self) -> dict[str, Any]:
        mem = self.core.data.setdefault("runtime", {}).setdefault("notify", {})
        mem.setdefault("last", {})
        today = dt_util.now().date().isoformat()
        if mem.get("day") != today:
            mem["day"] = today
            mem["count"] = {}
        mem.setdefault("count", {})
        return mem

    def reset(self) -> None:
        """Forgets what was sent (gaps and today's counts start again)."""
        self.core.data.setdefault("runtime", {})["notify"] = {}
        self.core.save()

    def _prune(self, mem: dict[str, Any]) -> None:
        if len(mem["last"]) < 300:
            return
        old = time.time() - KEEP_DAYS * 86400
        mem["last"] = {k: v for k, v in mem["last"].items() if v.get("t", 0) > old}

    # ------------------------------------------------------------------ sending
    def recipients(self, persons: list[str] | None = None, services: list[str] | None = None) -> list[tuple[str, str]]:
        """(who, service) pairs: every phone of the persons, and extra services (counted for their owner if known)."""
        inv = self.core.inventory
        out: list[tuple[str, str]] = []
        for pid in persons or []:
            p = inv.persons.get(pid)
            for svc in (p or {}).get("phones", []):
                out.append((pid, svc))
        for svc in services or []:
            owner = next((pid for pid, p in inv.persons.items() if svc in p.get("phones", [])), svc)
            out.append((owner, svc))
        seen: set[str] = set()
        return [x for x in out if not (x[1] in seen or seen.add(x[1]))]

    def allowed(self, kind: str, key: str, who: str, message: str | None = None, now: float | None = None) -> str | None:
        """Why a message must not go out now (a short code), or None."""
        cfg = self.config
        k = cfg["kinds"].get(kind)
        if k is None:
            return None
        if not k["on"]:
            return "kind_off"
        if kind in cfg["persons"].get(who, {}).get("off", []):
            return "person_off"
        if KINDS[kind]["quiet"] == "hold" and self.quiet_now():
            return "quiet"
        mem = self._mem
        now = now or time.time()
        last = mem["last"].get(f"{kind}|{key}|{who}")
        if last and now - last["t"] < k["gap"] * 60:
            return "gap"
        if last and k["gap"] and message is not None and last.get("m") == message and now - last["t"] < 60:
            return "same"  # the very same text again within a minute (a sensor that bounces)
        # daily 0 = no daily limit
        if k["daily"] and mem["count"].get(f"{kind}|{who}", 0) >= k["daily"]:
            return "daily"
        return None

    def _note(self, kind: str, key: str, who: str, message: str) -> None:
        mem = self._mem
        mem["last"][f"{kind}|{key}|{who}"] = {"t": time.time(), "m": message[:120]}
        mem["count"][f"{kind}|{who}"] = mem["count"].get(f"{kind}|{who}", 0) + 1
        self._prune(mem)
        self.core.save()

    def delivery(self, kind: str, tag: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        """The data block for the companion app: replace by tag, group by kind, calm kinds and quiet hours silent."""
        out: dict[str, Any] = {"tag": tag, "group": f"house_rules_{kind}", **(data or {})}
        spec = KINDS.get(kind, {})
        silent = spec.get("calm") or (spec.get("quiet") == "silent" and self.quiet_now())
        if silent:
            # iOS: no sound, no lighting up; Android: an own quiet channel, a replaced message does not alert again
            push = dict(out.get("push") or {})
            push.setdefault("interruption-level", "passive")
            out["push"] = push
            out.setdefault("channel", tr(self.core, "notify.channel_calm"))
            out.setdefault("importance", "low")
        out.setdefault("alert_once", True)
        return out

    async def send(
        self,
        kind: str,
        key: str,
        title: str,
        message: str,
        *,
        persons: list[str] | None = None,
        services: list[str] | None = None,
        tag: str | None = None,
        data: dict[str, Any] | None = None,
        ctx: Context | None = None,
        blocking: bool = False,
    ) -> list[str]:
        """Sends to every recipient the limits allow. Returns the services that got it."""
        tag = tag or f"house_rules_{kind}_{key}"
        payload = self.delivery(kind, tag, data)
        sent: list[str] = []
        held: list[str] = []
        for who, svc in self.recipients(persons, services):
            why = self.allowed(kind, key, who, message)
            if why:
                held.append(why)
                continue
            self._note(kind, key, who, message)
            try:
                await self.hass.services.async_call("notify", svc, {"title": title, "message": message, "data": payload}, blocking=blocking, context=ctx)
                sent.append(svc)
            except Exception as err:  # noqa: BLE001 — one phone that fails must not stop the others
                _LOGGER.warning("House rules: notification to %s failed: %s", svc, err)
        if held and not sent:
            _LOGGER.debug("House rules: %s message %s held back (%s)", kind, key, ", ".join(sorted(set(held))))
        return sent

    def view(self) -> dict[str, Any]:
        """For the panel: the settings, the defaults per kind and how many went out today per kind."""
        mem = self._mem
        today: dict[str, int] = {}
        for k, n in mem["count"].items():
            kind = k.split("|", 1)[0]
            today[kind] = today.get(kind, 0) + n
        return {**self.config, "defaults": {k: {x: v[x] for x in ("on", "gap", "daily")} for k, v in KINDS.items()}, "today": today, "quiet_now": self.quiet_now()}
