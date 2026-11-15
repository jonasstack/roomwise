"""The alarm system.

States: disarmed → arming (exit delay) → armed_<mode> → pending (entry delay, doors only) → triggered.

Every mode (away / night / home) has its own setup: which sensors, delays, loud or silent, which lights,
which extra devices to switch on (cameras, switches, scenes), smart exceptions and when it arms or disarms
by itself. Shared for all modes: who gets messages (with camera picture and buttons that act directly),
announcement, tone and siren, how disarming is confirmed (nothing, PIN, Face ID / Touch ID via passkey).
Nothing is set up after installing: the alarm does nothing until the user configures it.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import secrets
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.const import ATTR_ENTITY_ID, EVENT_HOMEASSISTANT_STARTED, EVENT_HOMEASSISTANT_STOP, STATE_HOME, STATE_ON
from homeassistant.core import CALLBACK_TYPE, Context, CoreState, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_state_change_event, async_track_time_change
from homeassistant.helpers.network import NoURLAvailableError, get_url

from . import alarm_channels as channels
from .i18n import lang_of, mode_label, tr
from .webauthn import BAD_INPUT, WebAuthnError, error_text, parse_registration, verify_assertion

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

# i18n: complete (texts in texts/alarm.json)

MODES = ("away", "night", "home")
# the states of the alarm system (also the options of sensor.alarmanlage_zustand); names: texts alarm.state_<state>
STATES = ("disarmed", "arming", "armed_away", "armed_night", "armed_home", "pending", "triggered")
ACTION_PREFIX = "HR_ALARM_"
MAX_CHALLENGES = 20  # open Face ID / Touch ID challenges at once
SOUNDS_URL = "/house_rules_sounds"
# sound files in sounds/ (ids are file names); names: texts alarm.tone_<id>
TONES = ("sirene", "martinshorn", "evakuierung", "alarm", "piepen", "gong")
DASHBOARD_PATH = "/hausregeln/alarm"
HOUSE_MODES = ("home", "away", "sleep", "vacation", "guests")


def arm_mode_label(where: Any, mode: str | None) -> str:
    """Abwesend / Nacht / Zuhause (Away / Night / Home); empty for no mode."""
    return tr(where, f"alarm.arm_mode_{mode}") if mode in MODES else ""


def state_label(where: Any, state: str) -> str:
    return tr(where, f"alarm.state_{state}") if state in STATES else state


def tone_labels(where: Any) -> dict[str, str]:
    return {t: tr(where, f"alarm.tone_{t}") for t in TONES}


def default_mode(mode: str) -> dict[str, Any]:
    return {
        "sensors": [],
        "entry_delay": 30,
        "exit_delay": 60 if mode == "away" else 0,
        "loud": mode != "home",
        # loud: siren, sound, announcement, lights and extra devices · silent: message and extra devices (e.g. camera recording)
        # notify: only the messages, nothing in the house moves
        "reaction": "loud" if mode != "home" else "silent",
        "lights": {"mode": "flash" if mode == "away" else "on", "entities": []},
        "activate": [],
        "smart": {
            "inside": {"on": mode in ("night", "home"), "seconds": 90},
            "arrival": {"on": True, "minutes": 10, "disarm": False},
        },
        "auto": {
            "arm_on": [],
            "disarm_on": [],
            "arm_at": "",
            "disarm_at": "",
            "only_auto": True,
            "arm_away": False,  # when the chosen persons are all away …
            "away_for": 5,  # … for so many minutes
            "disarm_home": False,  # when one of the chosen persons comes home
        },
    }


def default_config(lang: str = "de") -> dict[str, Any]:
    """lang: the language of the default announcement texts (stored once, then the user's own)."""
    return {
        "version": 2,
        "enabled": False,
        "code_hash": None,
        # how disarming in the app / HA alarm panel is confirmed; "pin" and "device" need a PIN (the fallback)
        "confirm": "none",
        # "Alarm aus" in the phone message (the phone asks for Face ID / its code before it sends it: authenticationRequired)
        "notify_disarm": True,
        "modes": {m: default_mode(m) for m in MODES},
        "notify": {
            "persons": "everyone",  # the alarm itself
            # who gets the other messages: "same" = like the alarm
            "pending_persons": "same",
            "armed_persons": "same",
            "disarmed_persons": "same",
            "test_persons": "same",
            "critical": True,
            "pre_alarm": True,
            "armed": False,
            "disarmed": False,
            # the alarm message again and again until someone switches off
            "repeat": {"on": False, "every": 60, "max": 10, "channels": False},
        },
        "channels": channels.default_channels(),
        # who counts for "away", "came home": "everyone" = the residents (Zuhause → Wer wohnt hier?), a list = a
        # deviation for the alarm only (migrate_presence marks older configs with "v": 2 once checked)
        "presence": {"persons": "everyone"},
        "announce": {"players": [], "pending_text": tr(lang, "alarm.default_pending_text"), "triggered_text": tr(lang, "alarm.default_triggered_text")},
        "sirens": [],
        "sound": {"players": [], "tone": "sirene", "url": "", "volume": 80, "pre_tone": "piepen"},
        "cameras": [],
        "buttons": ["disarm", "silence", "camera"],
        "phone": "",
        "duration": 180,
        "devices": [],
    }


def _hash(code: str) -> str:
    """First format (fast, unsalted). Only read; replaced by _new_hash at the next correct PIN."""
    return hashlib.sha256(("house_rules:" + code).encode()).hexdigest()


PBKDF2_ROUNDS = 120_000
FAILS_FREE = 5  # wrong PINs before a lockout
LOCK_BASE = 30  # s, doubles with every further wrong PIN
LOCK_MAX = 3600
# forgotten PIN / locked out: this file in the config folder resets the lockout (content "pin": also removes the PIN).
# For the command line (Terminal add-on, SSH, docker exec): touch /config/house_rules_pin_reset
RESET_FILE = "house_rules_pin_reset"


def _new_hash(code: str) -> str:
    """Salted and slow (PBKDF2-SHA256). Runs in the executor."""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", str(code).encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2${PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def _verify(code: str, stored: str) -> tuple[bool, bool]:
    """(correct, needs a new hash). Accepts the old format until the next correct PIN."""
    if stored.startswith("pbkdf2$"):
        try:
            _p, rounds, salt, want = stored.split("$")
            dk = hashlib.pbkdf2_hmac("sha256", str(code).encode(), bytes.fromhex(salt), int(rounds))
        except (ValueError, TypeError):
            return False, False
        return secrets.compare_digest(dk.hex(), want), False
    ok = secrets.compare_digest(_hash(str(code)), stored)
    return ok, ok


def migrate(cfg: dict[str, Any]) -> dict[str, Any]:
    """Config from the first version (shared lights, auto mapping) → per mode."""
    if cfg.get("version") == 2:
        return cfg
    new = default_config()
    for k in ("enabled", "code_hash", "notify", "announce", "sirens", "cameras", "buttons", "phone", "duration"):
        if k in cfg:
            new[k] = cfg[k] if not isinstance(new.get(k), dict) else {**new[k], **cfg[k]}
    if isinstance(cfg.get("sound"), dict):
        new["sound"].update({k: v for k, v in cfg["sound"].items() if k in ("players", "url", "volume")})
        if cfg["sound"].get("url"):
            new["sound"]["tone"] = "custom"
    for m in MODES:
        old = (cfg.get("modes") or {}).get(m) or {}
        for k in ("sensors", "entry_delay", "exit_delay"):
            if k in old:
                new["modes"][m][k] = old[k]
        if isinstance(cfg.get("lights"), dict):
            new["modes"][m]["lights"] = {**new["modes"][m]["lights"], **cfg["lights"]}
    auto = cfg.get("auto") or {}
    for house_mode, alarm_mode in (auto.get("arm") or {}).items():
        if alarm_mode in MODES:
            new["modes"][alarm_mode]["auto"]["arm_on"].append(house_mode)
    if auto.get("disarm_on_arrival"):
        for m in MODES:
            new["modes"][m]["auto"]["disarm_on"] = ["home"]
    return new


# After a start of Home Assistant (or of this integration) sensors report odd things for a while: a presence
# sensor goes from "off" (its default) to "on" when it is connected, persons are "unknown". So for this long
# nothing triggers; then the doors and windows are compared with how they were when HA went down.
SETTLE_SECONDS = 60
# alarm messages that only inform (they pass the limits of notify.py); everything else is an alarm and goes out at once
INFO_KINDS = ("armed", "disarmed")
OPENINGS = ("door", "window", "cover", "garage")
NOT_REAL = ("unavailable", "unknown")


class Alarm:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.state = "disarmed"
        self.mode: str | None = None  # away | night | home while arming/armed/pending/triggered
        self.since = time.time()
        self.until: float | None = None  # end of the running delay
        self.cause: str | None = None  # sensor that set it off
        self.bypassed: list[str] = []
        self.by_auto = False
        self.silenced = False
        self.last_exception: dict[str, Any] | None = None
        self._timer: CALLBACK_TYPE | None = None
        self._silence: CALLBACK_TYPE | None = None
        self._unsub: list[Callable[[], None]] = []
        self._sensor_unsub: CALLBACK_TYPE | None = None
        self._time_unsub: list[Callable[[], None]] = []
        self._away_timer: CALLBACK_TYPE | None = None
        self._repeat: CALLBACK_TYPE | None = None
        self._repeat_count = 0
        self._listeners: list[Callable[[str], None]] = []
        self._activated: list[str] = []
        self._challenges: dict[str, float] = {}
        self._fails: dict[str, tuple[int, float]] = {}  # who → (wrong PINs in a row, locked until); kept across restarts
        self._light_task: asyncio.Task[None] | None = None
        # entities exist before the alarm has loaded its state (it starts once HA runs): until then "unavailable",
        # never a wrong "disarmed"
        self.started = False
        # restart safety: last real state of every watched sensor (kept across restarts) and the start-up phase
        self._snap: dict[str, str] = {}
        self._snap_before: dict[str, str] = {}
        self.settling = False
        self._settle_events: set[str] = set()
        self._settle_unsub: CALLBACK_TYPE | None = None

    # ------------------------------------------------------------------ config
    @property
    def config(self) -> dict[str, Any]:
        cfg = self.core.data.get("alarm")
        lang = lang_of(self.core)
        if not isinstance(cfg, dict):
            cfg = default_config(lang)
        elif cfg.get("version") != 2:
            cfg = migrate(cfg)
        self.core.data["alarm"] = cfg
        if cfg.get("confirm", "pin") == "pin" and not cfg.get("code_hash"):
            # "PIN" without a PIN used to mean: no confirmation. Say so honestly (the server never accepts that combination)
            cfg["confirm"] = "none"
        for k, v in default_config(lang).items():
            cfg.setdefault(k, v)
            if isinstance(v, dict) and k != "modes":
                for kk, vv in v.items():
                    cfg[k].setdefault(kk, vv)
        for k, v in channels.default_channels().items():
            cfg["channels"].setdefault(k, v)
            for kk, vv in v.items():
                cfg["channels"][k].setdefault(kk, vv)
        for kk, vv in default_config()["notify"]["repeat"].items():
            cfg["notify"]["repeat"].setdefault(kk, vv)
        for m in MODES:
            mc = cfg["modes"].setdefault(m, default_mode(m))
            if "reaction" not in mc:
                mc["reaction"] = "loud" if mc.get("loud", m != "home") else "silent"
            for k, v in default_mode(m).items():
                mc.setdefault(k, v)
                if isinstance(v, dict):
                    for kk, vv in v.items():
                        mc[k].setdefault(kk, vv)
                        if isinstance(vv, dict):
                            for k3, v3 in vv.items():
                                mc[k][kk].setdefault(k3, v3)
        return cfg

    def public_config(self) -> dict[str, Any]:
        cfg = {k: v for k, v in self.config.items() if k not in ("code_hash", "devices", "channels")}
        cfg["channels"] = channels.public(self.config["channels"])
        cfg["has_code"] = bool(self.config.get("code_hash"))
        cfg["pin_locked"] = sum(1 for who in self._fails if self._locked(who))  # users locked out right now
        cfg["devices"] = [{"id": d["id"], "name": d.get("name", ""), "created": d.get("created")} for d in self.config.get("devices", [])]
        return cfg

    def save_config(self, raw: dict[str, Any]) -> None:
        cfg = self.config
        known = set(self.core.inventory.devices)

        def ents(v: Any, prefixes: tuple[str, ...] = ()) -> list[str]:
            if not isinstance(v, list):
                return []
            return [e for e in v if isinstance(e, str) and (e in known or (prefixes and e.startswith(prefixes)) or self.hass.states.get(e) is not None)][:80]

        # "PIN" and "Face ID / Touch ID" need a PIN (Face ID: as the way out); checked before anything changes
        if "confirm" in raw or "code" in raw or "_hash" in raw:
            new_confirm = raw.get("confirm") if raw.get("confirm") in ("none", "pin", "device") else cfg.get("confirm", "none")
            has_code = bool(raw.get("_hash") or raw.get("code")) if ("code" in raw or "_hash" in raw) else bool(cfg.get("code_hash"))
            if new_confirm in ("pin", "device") and not has_code:
                raise ValueError(tr(self.core, "alarm.err_pin_first"))
        if isinstance(raw.get("enabled"), bool):
            cfg["enabled"] = raw["enabled"]
        if raw.get("confirm") in ("none", "pin", "device"):
            cfg["confirm"] = raw["confirm"]
        if isinstance(raw.get("notify_disarm"), bool):
            cfg["notify_disarm"] = raw["notify_disarm"]
        if isinstance(raw.get("modes"), dict):
            for m in MODES:
                src = raw["modes"].get(m)
                if not isinstance(src, dict):
                    continue
                dst = cfg["modes"][m]
                if "sensors" in src:
                    dst["sensors"] = ents(src["sensors"])
                for key in ("entry_delay", "exit_delay"):
                    if isinstance(src.get(key), (int, float)):
                        dst[key] = int(max(0, min(600, src[key])))
                if isinstance(src.get("loud"), bool):
                    dst["loud"] = src["loud"]
                    dst["reaction"] = "loud" if src["loud"] else ("silent" if dst.get("reaction") == "loud" else dst.get("reaction", "silent"))
                if src.get("reaction") in ("loud", "silent", "notify"):
                    dst["reaction"] = src["reaction"]
                    dst["loud"] = src["reaction"] == "loud"
                if isinstance(src.get("lights"), dict):
                    if src["lights"].get("mode") in ("on", "flash", "red", "none"):
                        dst["lights"]["mode"] = src["lights"]["mode"]
                    if "entities" in src["lights"]:
                        dst["lights"]["entities"] = ents(src["lights"]["entities"], ("light.",))
                if "activate" in src:
                    dst["activate"] = ents(src["activate"], ("camera.", "switch.", "scene.", "script.", "siren.", "input_boolean.", "light."))
                if isinstance(src.get("smart"), dict):
                    for key, (unit, hi) in (("inside", ("seconds", 600)), ("arrival", ("minutes", 120))):
                        s = src["smart"].get(key)
                        if not isinstance(s, dict):
                            continue
                        if isinstance(s.get("on"), bool):
                            dst["smart"][key]["on"] = s["on"]
                        if isinstance(s.get(unit), (int, float)):
                            dst["smart"][key][unit] = int(max(0, min(hi, s[unit])))
                        if key == "arrival" and isinstance(s.get("disarm"), bool):
                            dst["smart"][key]["disarm"] = s["disarm"]
                if isinstance(src.get("auto"), dict):
                    a = src["auto"]
                    for key in ("arm_on", "disarm_on"):
                        if isinstance(a.get(key), list):
                            dst["auto"][key] = [x for x in a[key] if x in HOUSE_MODES]
                    for key in ("arm_at", "disarm_at"):
                        if isinstance(a.get(key), str):
                            dst["auto"][key] = a[key][:5]
                    for key in ("only_auto", "arm_away", "disarm_home"):
                        if isinstance(a.get(key), bool):
                            dst["auto"][key] = a[key]
                    if isinstance(a.get("away_for"), (int, float)):
                        dst["auto"]["away_for"] = int(max(0, min(240, a["away_for"])))
        if isinstance(raw.get("notify"), dict):
            n = raw["notify"]
            for key in ("persons", "pending_persons", "armed_persons", "disarmed_persons", "test_persons"):
                persons = n.get(key)
                if persons == "everyone" or (persons == "same" and key != "persons") or isinstance(persons, list):
                    cfg["notify"][key] = [str(p) for p in persons][:20] if isinstance(persons, list) else persons
            for key in ("critical", "pre_alarm", "armed", "disarmed"):
                if isinstance(n.get(key), bool):
                    cfg["notify"][key] = n[key]
            if isinstance(rep := n.get("repeat"), dict):
                dst_r = cfg["notify"]["repeat"]
                for key in ("on", "channels"):
                    if isinstance(rep.get(key), bool):
                        dst_r[key] = rep[key]
                if isinstance(rep.get("every"), (int, float)):
                    dst_r["every"] = int(max(20, min(1800, rep["every"])))
                if isinstance(rep.get("max"), (int, float)):
                    dst_r["max"] = int(max(1, min(60, rep["max"])))
        if isinstance(raw.get("channels"), dict):
            channels.save(cfg["channels"], raw["channels"], set(self.hass.services.async_services_for_domain("notify")))
        if isinstance(raw.get("presence"), dict):
            persons = raw["presence"].get("persons")
            if persons == "everyone" or isinstance(persons, list):
                cfg["presence"]["persons"] = persons if persons == "everyone" else [str(x) for x in persons if str(x) in self.core.inventory.persons][:20]
        if isinstance(raw.get("announce"), dict):
            a = raw["announce"]
            if "players" in a:
                cfg["announce"]["players"] = ents(a["players"], ("media_player.",))
            for key in ("pending_text", "triggered_text"):
                if isinstance(a.get(key), str):
                    cfg["announce"][key] = a[key][:300]
        if "sirens" in raw:
            cfg["sirens"] = ents(raw["sirens"], ("siren.", "switch.", "input_boolean."))
        if isinstance(raw.get("sound"), dict):
            s = raw["sound"]
            if "players" in s:
                cfg["sound"]["players"] = ents(s["players"], ("media_player.",))
            for key in ("tone", "pre_tone"):
                if s.get(key) in (*TONES, "", "custom"):
                    cfg["sound"][key] = s[key]
            if isinstance(s.get("url"), str):
                cfg["sound"]["url"] = s["url"][:500]
            if isinstance(s.get("volume"), (int, float)):
                cfg["sound"]["volume"] = int(max(0, min(100, s["volume"])))
        if "cameras" in raw:
            cfg["cameras"] = ents(raw["cameras"], ("camera.",))[:10]
        if isinstance(raw.get("buttons"), list):
            cfg["buttons"] = [b for b in raw["buttons"] if b in ("disarm", "silence", "lights", "camera", "call", "open")]
        if isinstance(raw.get("phone"), str):
            cfg["phone"] = "".join(ch for ch in raw["phone"] if ch.isdigit() or ch in "+ ")[:20]
        if isinstance(raw.get("duration"), (int, float)):
            cfg["duration"] = int(max(10, min(1800, raw["duration"])))
        if isinstance(raw.get("_hash"), str):
            cfg["code_hash"] = raw["_hash"]  # made in the executor by the websocket command
        elif "code" in raw:
            code = raw.get("code")
            cfg["code_hash"] = _new_hash(str(code)) if code else None
        if isinstance(raw.get("remove_device"), str):
            cfg["devices"] = [d for d in cfg.get("devices", []) if d["id"] != raw["remove_device"]]
        self.core.save()
        if not cfg.get("enabled") and self.state != "disarmed":
            self.hass.async_create_task(self.disarm(by=tr(self.core, "alarm.by_switched_off"), check=False))
        self.restart()

    def suggested_sensors(self) -> dict[str, list[str]]:
        """A first idea: away = everything, night = doors and windows, home = doors."""
        inv = self.core.inventory
        doors = [d["entity_id"] for d in inv.devices.values() if d["kind"] == "door" and d.get("room")]
        windows = [d["entity_id"] for d in inv.devices.values() if d["kind"] == "window" and d.get("room")]
        motion = [d["entity_id"] for d in inv.devices.values() if d["kind"] in ("motion", "presence") and d.get("room")]
        return {"away": doors + windows + motion, "night": doors + windows, "home": doors}

    # ------------------------------------------------------------------ lifecycle
    def migrate_presence(self) -> None:
        """There used to be two person selections: Zuhause → Wer wohnt hier? (settings.persons_excluded) and the
        alarm's own "Wer zählt als anwesend?". Now the alarm follows the residents ("everyone") and keeps a list
        only as a real deviation. Runs once, as soon as the persons are known: a list that covers every resident
        becomes "everyone", persons who are no residents (any more) are dropped."""
        p = self.config["presence"]
        if p.get("v") == 2:
            return
        sel = p.get("persons", "everyone")
        residents = self.core.inventory.persons
        if isinstance(sel, list) and sel and not residents:
            return  # persons not loaded yet (start of Home Assistant): try again on the next rebuild
        if isinstance(sel, list):
            kept = [x for x in sel if x in residents]
            p["persons"] = "everyone" if residents and set(kept) >= set(residents) else kept
        p["v"] = 2
        self.core.save()

    def start(self, settle: bool = True) -> None:
        """settle=False: switched on while HA runs (feature "alarm"), no start-up phase needed."""
        self.migrate_presence()
        self.stop()
        if not self.config.get("enabled"):
            # feature "alarm" off: nothing listens, nothing triggers, the entities are unavailable
            self.started = True
            self.settling = False
            self._changed()
            return
        self._fails = {
            str(k): (int(v[0]), float(v[1]))
            for k, v in (self.core.data.get("runtime", {}).get("alarm_pin") or {}).items()
            if isinstance(v, list | tuple) and len(v) == 2
        }
        self.hass.async_create_task(self.check_reset_file())
        rt = self.core.data.setdefault("runtime", {}).get("alarm") or {}
        self._snap = {k: v for k, v in (rt.get("snap") or {}).items() if isinstance(v, str)}
        self._snap_before = dict(self._snap)
        if rt.get("state") in ("armed_away", "armed_night", "armed_home", "triggered", "arming", "pending"):
            self.state, self.mode = rt["state"], rt.get("mode") or "away"
            self.since = rt.get("since", time.time())
            self.by_auto = bool(rt.get("by_auto"))
            self.bypassed = [e for e in rt.get("bypassed", []) if isinstance(e, str)]
            self.cause = rt.get("cause")
        if self.state in ("arming", "pending"):
            # a restart during a delay: the delay goes on (at least 30 s, so whoever is at the door can still act)
            left = max(30.0, float(rt.get("until") or 0) - time.time())
            self.until = time.time() + left
            if self.state == "arming":
                self._timer = async_call_later(self.hass, left, self._armed)
            else:
                cause = self.cause
                self._timer = async_call_later(self.hass, left, callback(lambda _now: self.hass.async_create_task(self.trigger(cause))))
        if settle:
            self._settle_start()
        else:
            self.settling = False
            for eid in self._watched():
                st = self.hass.states.get(eid)
                if st and st.state not in NOT_REAL:
                    self._snap[eid] = st.state
        self._unsub.append(self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, self._on_stop))
        # the entities (alarm panel, "scharf" …) exist before this start: show them the restored state
        self.started = True
        self._changed()
        self._unsub.append(self.hass.bus.async_listen("mobile_app_notification_action", self._action))
        self._unsub.append(self.core.engine.on_mode(self._mode_changed))
        self._watch()

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()
        if self._settle_unsub:
            self._settle_unsub()
            self._settle_unsub = None
        if self._sensor_unsub:
            self._sensor_unsub()
            self._sensor_unsub = None
        for u in self._time_unsub:
            u()
        self._time_unsub.clear()
        self._cancel_timer()
        self._stop_repeat()
        self._stop_lights()
        if self._away_timer:
            self._away_timer()
            self._away_timer = None

    # ------------------------------------------------------------------ restart safety
    def _settle_start(self) -> None:
        """Start-up phase: nothing triggers until HA runs and SETTLE_SECONDS have passed."""
        self.settling = True
        self._settle_events.clear()

        @callback
        def later(_e: Any = None) -> None:
            self._settle_unsub = async_call_later(self.hass, SETTLE_SECONDS, self._settled)

        if self.hass.state is CoreState.running:  # "is_running" is already true while HA is still starting
            later()
        else:
            self._settle_unsub = self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, later)

    @callback
    def _settled(self, _now: Any = None) -> None:
        """End of the start-up phase: doors and windows that were closed when HA went down and are open now
        (or were opened during the start-up) count as opened; motion and presence only from now on."""
        self._settle_unsub = None
        self.settling = False
        events, self._settle_events = self._settle_events, set()
        before = self._snap_before
        for eid in self._watched():
            st = self.hass.states.get(eid)
            if st and st.state not in NOT_REAL:
                self._snap[eid] = st.state
        if self.state not in ("armed_away", "armed_night", "armed_home") or not self.mode:
            self._persist()
            return
        mc = self.config["modes"][self.mode]
        opened, same = [], []
        for eid in mc.get("sensors", []):
            if eid in self.bypassed or self.core.inventory.devices.get(eid, {}).get("kind") not in OPENINGS:
                continue
            st = self.hass.states.get(eid)
            now_open = bool(st and st.state == STATE_ON)
            was = before.get(eid)
            if was == "off" and (now_open or eid in events):
                opened.append(eid)
            elif now_open:
                same.append(eid)
        if opened:
            self.core.history.add("alarm", tr(self.core, "alarm.h_restart_opened"), tr(self.core, "alarm.h_restart_opened_why", names=", ".join(self._name(e) for e in opened)), logbook="alarm")
            st = self.hass.states.get(opened[0])
            if st:
                self._handle(opened[0], st)
        else:
            text = tr(self.core, "alarm.h_restart_same_open", names=", ".join(self._name(e) for e in same)) if same else tr(self.core, "alarm.h_restart_same")
            self.core.history.add("alarm", tr(self.core, "alarm.h_restart_checked"), text)
        self._persist()
        self._presence_changed()

    def _watched(self) -> set[str]:
        return {e for m in MODES for e in self.config["modes"][m].get("sensors", [])}

    def _persist(self) -> None:
        rt = self.core.data.setdefault("runtime", {}).setdefault("alarm", {})
        rt["snap"] = dict(self._snap)
        self.core.save()

    @callback
    def _on_stop(self, _e: Any) -> None:
        """HA goes down: remember how every watched sensor is right now."""
        for eid in self._watched():
            st = self.hass.states.get(eid)
            if st and st.state not in NOT_REAL:
                self._snap[eid] = st.state
        self._persist()

    def restart(self) -> None:
        """After a change of the setup or the registries: watch the right sensors. A running countdown stays.
        Switched off (feature "alarm"): stop everything; switched on again: start without a start-up phase."""
        self.migrate_presence()
        if not self.config.get("enabled"):
            if self._unsub:
                self.stop()
            self._changed()
            return
        if not self._unsub:
            self.start(settle=False)
            return
        self._watch()
        self._changed()

    def add_listener(self, cb: Callable[[str], None]) -> Callable[[], None]:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb) if cb in self._listeners else None

    def _cancel_timer(self) -> None:
        if self._timer:
            self._timer()
            self._timer = None

    def _watch(self) -> None:
        if self._sensor_unsub:
            self._sensor_unsub()
            self._sensor_unsub = None
        for u in self._time_unsub:
            u()
        self._time_unsub.clear()
        sensors = set()
        for m in MODES:
            sensors.update(self.config["modes"][m].get("sensors", []))
        if sensors:
            self._sensor_unsub = async_track_state_change_event(self.hass, list(sensors), self._sensor)
        if self._away_timer:
            self._away_timer()
            self._away_timer = None
        if any(self.config["modes"][m]["auto"].get(k) for m in MODES for k in ("arm_away", "disarm_home")):
            people = [p["entity_id"] for p in self.presence_persons()]
            if people:
                self._time_unsub.append(async_track_state_change_event(self.hass, people, callback(lambda _e: self._presence_changed())))
        # time based arming / disarming
        for m in MODES:
            auto = self.config["modes"][m]["auto"]
            for key, fn in (("disarm_at", self._timed_disarm), ("arm_at", self._timed_arm)):
                t = auto.get(key) or ""
                if len(t) == 5 and t[2] == ":" and t[:2].isdigit() and t[3:].isdigit():
                    self._time_unsub.append(
                        async_track_time_change(self.hass, callback(lambda _now, m=m, fn=fn: fn(m)), hour=int(t[:2]), minute=int(t[3:]), second=0)
                    )

    def view(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "label": state_label(self.core, self.state),
            "mode": self.mode,
            "since": self.since,
            "until": self.until,
            "cause": self.cause,
            "cause_name": self._name(self.cause) if self.cause else None,
            "bypassed": self.bypassed,
            "silenced": self.silenced,
            "last_exception": self.last_exception,
            "settling": self.settling,
            "config": self.public_config(),
            "suggested": self.suggested_sensors(),
            "tones": tone_labels(self.core),
            "notify_services": sorted(
                n for n in self.hass.services.async_services_for_domain("notify") if not n.startswith("mobile_app_") and n not in ("notify", "send_message", "persistent_notification")
            ),
            "sounds_url": SOUNDS_URL,
        }

    def _set(self, state: str, mode: str | None = None, until: float | None = None) -> None:
        self.state = state
        if mode is not None or state == "disarmed":
            self.mode = mode
        self.since = time.time()
        self.until = until
        self.core.data.setdefault("runtime", {})["alarm"] = {
            "state": state,
            "mode": self.mode,
            "since": self.since,
            "until": self.until,
            "cause": self.cause,
            "by_auto": self.by_auto,
            "bypassed": self.bypassed,
            "snap": dict(self._snap),
        }
        self.core.save()
        self.hass.bus.async_fire("house_rules_alarm", {"state": state, "mode": self.mode, "cause": self.cause})
        self._changed()

    def _changed(self) -> None:
        for cb in list(self._listeners):
            cb(self.state)
        self.core.push("alarm")

    def _name(self, eid: str | None) -> str:
        if not eid:
            return ""
        d = self.core.inventory.devices.get(eid)
        st = self.hass.states.get(eid)
        return d["name"] if d else (str(st.attributes.get("friendly_name")) if st else eid)

    # ------------------------------------------------------------------ PIN and confirmation
    def _locked(self, who: str) -> float:
        n, until = self._fails.get(who, (0, 0.0))
        return max(0.0, until - time.time())

    def _save_fails(self) -> None:
        self.core.data.setdefault("runtime", {})["alarm_pin"] = {k: list(v) for k, v in self._fails.items()}
        self.core.save()

    async def verify_code(self, code: str | None, who: str) -> str | None:
        """None = correct. Otherwise "no_pin", "wrong_code" or "locked" (after 5 wrong PINs per user a growing lockout)."""
        await self.check_reset_file()
        stored = self.config.get("code_hash")
        if not stored:
            return "no_pin"
        if self._locked(who):
            return "locked"
        ok, upgrade = await self.hass.async_add_executor_job(_verify, str(code or ""), stored) if code else (False, False)
        if not ok:
            n = self._fails.get(who, (0, 0.0))[0] + 1
            lock = min(LOCK_MAX, LOCK_BASE * 2 ** (n - FAILS_FREE)) if n >= FAILS_FREE else 0
            self._fails[who] = (n, time.time() + lock)
            self._save_fails()
            if lock:
                self.core.history.add("alarm", tr(self.core, "alarm.h_pin_locked"), tr(self.core, "alarm.h_pin_locked_why", n=n, who=who, seconds=int(lock)), logbook="alarm")
                self._changed()
            return "wrong_code"
        if self._fails.pop(who, None):
            self._save_fails()
        if upgrade:
            self.config["code_hash"] = await self.hass.async_add_executor_job(_new_hash, str(code))
            self.core.save()
        return None

    def reset_pin(self, *, remove_pin: bool = False, by: str) -> None:
        """Lifts every PIN lockout; remove_pin also deletes the PIN (disarming then needs no confirmation until a new one is set)."""
        self._fails = {}
        self._save_fails()
        if remove_pin and self.config.get("code_hash"):
            self.config["code_hash"] = None
            self.config["confirm"] = "none"
            self.core.save()
            self.core.history.add("alarm", tr(self.core, "alarm.h_pin_removed"), tr(self.core, "alarm.h_pin_removed_why", by=by), logbook="alarm")
        else:
            self.core.history.add("alarm", tr(self.core, "alarm.h_pin_unlocked"), tr(self.core, "alarm.h_by", by=by), logbook="alarm")
        self._changed()

    async def check_reset_file(self) -> bool:
        """The reset file in the config folder (see RESET_FILE): read, act, delete."""
        path = self.hass.config.path(RESET_FILE)

        def read() -> str | None:
            try:
                with open(path, encoding="utf-8") as f:
                    text = f.read(100)
            except OSError:
                return None
            try:
                import os  # noqa: PLC0415

                os.remove(path)
            except OSError as err:
                _LOGGER.warning("House rules: could not delete %s: %s", path, err)
            return text

        text = await self.hass.async_add_executor_job(read)
        if text is None:
            return False
        self.reset_pin(remove_pin=text.strip().lower() in ("pin", "alles", "all"), by=tr(self.core, "alarm.by_reset_file", file=RESET_FILE))
        return True

    async def disarm_confirmed(self, *, who: str, by: str, code: str | None = None, webauthn: dict[str, Any] | None = None, rp_id: str = "") -> dict[str, Any]:
        """Disarm with the confirmation that is set (app, Alarm-Zentrale, HA alarm panel). {ok, error, retry_in?}"""
        await self.check_reset_file()  # first: it may remove the PIN and with it the confirmation
        confirm = self.config.get("confirm", "none")
        if confirm == "device" and webauthn:
            try:
                self.verify_device(webauthn, rp_id)
            except BAD_INPUT as err:
                return {"ok": False, "error": (str(err) if isinstance(err, WebAuthnError) else "") or tr(self.core, "alarm.err_confirm_failed")}
            await self.disarm(by=tr(self.core, "alarm.by_with_device", by=by), check=False)
            return {"ok": True, "error": None}
        if confirm in ("pin", "device"):
            if confirm == "device" and not self.config.get("code_hash") and not code:
                return {"ok": False, "error": "needs_device"}
            err = await self.verify_code(code, who)
            if err:
                return {"ok": False, "error": err, **({"retry_in": int(self._locked(who)) + 1} if err == "locked" or self._locked(who) else {})}
        await self.disarm(by=by, check=False)
        return {"ok": True, "error": None}

    # ------------------------------------------------------------------ arming
    def open_sensors(self, mode: str) -> list[str]:
        sensors = self.config["modes"].get(mode, {}).get("sensors", [])
        return [e for e in sensors if (st := self.hass.states.get(e)) and st.state == STATE_ON and self.core.inventory.devices.get(e, {}).get("kind") in ("door", "window")]

    async def arm(self, mode: str, *, force: bool = False, auto: bool = False, why: str | None = None) -> dict[str, Any]:
        if mode not in MODES:
            return {"ok": False, "error": "unknown_mode"}
        if not self.config.get("enabled"):
            return {"ok": False, "error": "not_set_up"}
        open_ = self.open_sensors(mode)
        if open_ and not force:
            return {"ok": False, "error": "open", "open": [{"entity_id": e, "name": self._name(e)} for e in open_]}
        self.bypassed = open_
        self.by_auto = auto
        for eid in self._watched():
            st = self.hass.states.get(eid)
            if st and st.state not in NOT_REAL:
                self._snap[eid] = st.state
        self.cause = None
        self.silenced = False
        self._cancel_timer()
        delay = self.config["modes"][mode].get("exit_delay", 0)
        names = ", ".join(self._name(e) for e in open_)
        why = why or tr(self.core, "alarm.why_auto" if auto else "alarm.why_hand")
        self.core.history.add(
            "alarm",
            tr(self.core, "alarm.h_armed_in", mode=arm_mode_label(self.core, mode), delay=delay) if delay else tr(self.core, "alarm.h_armed", mode=arm_mode_label(self.core, mode)),
            tr(self.core, "alarm.why_bypassed", why=why, names=names) if names else why,
            logbook="alarm",
        )
        if delay:
            self._set("arming", mode, time.time() + delay)
            self._timer = async_call_later(self.hass, delay, self._armed)
        else:
            self._set(f"armed_{mode}", mode)
            await self._armed_message()
        return {"ok": True, "bypassed": open_}

    @callback
    def _armed(self, _now: Any = None) -> None:
        self._timer = None
        if self.state == "arming" and self.mode:
            self._set(f"armed_{self.mode}")
            self.hass.async_create_task(self._armed_message())

    async def _armed_message(self) -> None:
        if self.config["notify"].get("armed"):
            ctx = self.core.history.new_context("alarm")
            await self._notify(tr(self.core, "alarm.n_armed", mode=arm_mode_label(self.core, self.mode)), ctx, critical=False, title=tr(self.core, "alarm.title"), buttons=["disarm"], kind="armed")

    async def disarm(self, *, by: str | None = None, code: str | None = None, check: bool = True) -> bool:
        """check=True: with the set confirmation (PIN); callers that confirmed themselves pass check=False."""
        by = by or tr(self.core, "alarm.by_hand")
        if check and not (await self.disarm_confirmed(who="disarm", by=by, code=code))["ok"]:
            return False
        if check:
            return True
        was = self.state
        self._cancel_timer()
        self._stop_lights()  # no more blinking once it is off
        if self._silence:
            self._silence()
            self._silence = None
        if was in ("triggered", "pending"):
            await self._sirens(False)
            await self._stop_sound()
        await self._deactivate()
        self.cause = None
        self.bypassed = []
        self.by_auto = False
        self.silenced = False
        self._set("disarmed", None)
        self._stop_repeat()
        if was != "disarmed":
            self.core.history.add("alarm", tr(self.core, "alarm.h_disarmed"), tr(self.core, "alarm.h_by", by=by), logbook="alarm")
            await self._clear_messages()
            if self.config["notify"].get("disarmed"):
                await self._notify(tr(self.core, "alarm.n_disarmed", by=by), self.core.history.new_context("alarm"), critical=False, title=tr(self.core, "alarm.title"), kind="disarmed", tag="house_rules_alarm_info")
        return True

    # ------------------------------------------------------------------ passkeys (Face ID / Touch ID)
    def challenge(self) -> str:
        c = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
        now = time.time()
        # any user may ask for one: only the newest few stay valid, so asking in a loop cannot fill the memory
        live = sorted(((v, k) for k, v in self._challenges.items() if v > now), reverse=True)[: MAX_CHALLENGES - 1]
        self._challenges = {k: v for v, k in live}
        self._challenges[c] = now + 180
        return c

    def _take_challenge(self, client_data: dict[str, Any]) -> None:
        c = client_data.get("challenge", "")
        if self._challenges.pop(c, 0) < time.time():
            raise WebAuthnError("expired")

    def register_device(self, payload: dict[str, Any], name: str, rp_id: str) -> dict[str, Any]:
        client_data = json.loads(base64.urlsafe_b64decode(payload["clientDataJSON"] + "=="))
        try:
            self._take_challenge(client_data)
            cred = parse_registration(payload, rp_id)
        except WebAuthnError as err:
            raise WebAuthnError(error_text(self.core, err)) from err
        cfg = self.config
        cfg.setdefault("devices", []).append({**cred, "name": name[:60], "created": time.time()})
        self.core.save()
        self.core.push("alarm")
        return {"id": cred["id"], "name": name}

    def verify_device(self, payload: dict[str, Any], rp_id: str) -> None:
        client_data = json.loads(base64.urlsafe_b64decode(payload["clientDataJSON"] + "=="))
        try:
            self._take_challenge(client_data)
            dev = next((d for d in self.config.get("devices", []) if d["id"] == payload.get("id")), None)
            if not dev:
                raise WebAuthnError("unknown_device")
            dev["sign_count"] = verify_assertion(payload, dev, rp_id)
        except WebAuthnError as err:
            raise WebAuthnError(error_text(self.core, err)) from err
        self.core.save()

    # ------------------------------------------------------------------ triggering
    def _inside(self, door: str, seconds: int) -> str | None:
        """Someone was just in the room of the door (presence/motion now or within `seconds`): opened from inside."""
        rid = self.core.inventory.room_of(door)
        room = self.core.rooms.get(rid or "")
        if not room:
            return None
        now = time.time()
        for e in (*room["presence"], *room["motion"], *room["zones"]):
            st = self.hass.states.get(e)
            if not st:
                continue
            if st.state == STATE_ON or (st.state == "off" and now - st.last_changed.timestamp() <= seconds):
                return tr(self.core, "alarm.inside", sensor=self._name(e), room=room["name"])
        return None

    def _arrived(self, minutes: int) -> str | None:
        """Someone came home within `minutes` (phone location)."""
        now = time.time()
        for p in self.presence_persons():
            st = self.hass.states.get(p["entity_id"])
            if st and st.state == STATE_HOME and now - st.last_changed.timestamp() <= minutes * 60:
                return tr(self.core, "alarm.arrived", name=p["name"], min=max(1, int((now - st.last_changed.timestamp()) // 60)))
        return None

    @callback
    def _sensor(self, event: Event[EventStateChangedData]) -> None:
        new = event.data["new_state"]
        old = event.data["old_state"]
        if new and new.state not in NOT_REAL and not self.settling:
            # the last real state, kept across restarts (saved with the next save; on shutdown at once)
            if self._snap.get(new.entity_id) != new.state:
                self._snap[new.entity_id] = new.state
                if self.state != "disarmed":
                    self._persist()
        if not new or not old or new.state != STATE_ON or old.state in (STATE_ON, *NOT_REAL):
            # also not when a sensor comes back after a restart: it did not open now, it was open before
            return
        eid = new.entity_id
        if self.settling:
            # start-up phase: a door/window opening is checked at its end, motion and presence do not count
            if self.core.inventory.devices.get(eid, {}).get("kind") in OPENINGS:
                self._settle_events.add(eid)
            return
        if self.state not in ("armed_away", "armed_night", "armed_home") or not self.mode:
            return
        self._handle(eid, new)

    def _handle(self, eid: str, new: Any) -> None:
        """A watched sensor opened / saw something while armed."""
        mc = self.config["modes"][self.mode or "away"]
        if eid not in mc.get("sensors", []) or eid in self.bypassed:
            return
        kind = self.core.inventory.devices.get(eid, {}).get("kind")
        if self.core.cleaning.ignores(eid, new):
            self.core.cleaning.note(eid, tr(self.core, "alarm.cleaning_no_alarm"))
            return
        # smart exceptions: opened from inside, or someone just came home
        smart = mc.get("smart", {})
        reason = None
        if kind == "door" and smart.get("inside", {}).get("on"):
            reason = self._inside(eid, smart["inside"].get("seconds", 90))
        if not reason and smart.get("arrival", {}).get("on"):
            reason = self._arrived(smart["arrival"].get("minutes", 10))
            if reason and smart["arrival"].get("disarm"):
                self.hass.async_create_task(self.disarm(by=tr(self.core, "alarm.by_auto_reason", reason=reason), check=False))
                return
        if reason:
            self.last_exception = {"at": time.time(), "sensor": self._name(eid), "reason": reason}
            self.core.history.add("alarm", tr(self.core, "alarm.h_exception", sensor=self._name(eid)), tr(self.core, "alarm.h_exception_why", reason=reason), entity_id=eid, logbook="alarm")
            self._changed()
            return
        delay = mc.get("entry_delay", 0) if kind == "door" else 0
        self.cause = eid
        if delay:
            self._set("pending", until=time.time() + delay)
            self.hass.async_create_task(self._pending(eid, delay))
            self._timer = async_call_later(self.hass, delay, callback(lambda _now: self.hass.async_create_task(self.trigger(eid))))
        else:
            self.hass.async_create_task(self.trigger(eid))

    async def _pending(self, eid: str, delay: int) -> None:
        ctx = self.core.history.new_context("alarm")
        cfg = self.config
        mc = cfg["modes"].get(self.mode or "away", {})
        tasks = []
        if mc.get("reaction", "loud") == "loud":
            tasks.append(self._announce(cfg["announce"].get("pending_text") or "", ctx))
            tone = cfg["sound"].get("pre_tone")
            if tone:
                tasks.append(self._play(tone, ctx, volume=min(60, cfg["sound"].get("volume", 80))))
        if cfg["notify"].get("pre_alarm", True):
            tasks.append(self._notify(tr(self.core, "alarm.n_pending", sensor=self._name(eid), delay=delay), ctx, critical=False, title=tr(self.core, "alarm.title_pending"), buttons=["disarm", "open"], kind="pending"))
        await asyncio.gather(*tasks, return_exceptions=True)

    async def trigger(self, eid: str | None = None, *, test: bool = False, manual: bool = False) -> None:
        """Sets off the alarm. manual: by a rule or the alarm panel, also when disarmed. test: message and announcement only."""
        self._timer = None
        if not test and not manual and self.state not in ("pending", "armed_away", "armed_night", "armed_home"):
            return
        if not self.config.get("enabled"):
            return
        ctx = self.core.history.new_context("alarm")
        cfg = self.config
        mode = self.mode or "away"
        mc = cfg["modes"].get(mode, default_mode(mode))
        reaction = mc.get("reaction") or ("loud" if mc.get("loud", True) else "silent")
        loud = reaction == "loud"
        cause = self._name(eid) if eid else tr(self.core, "alarm.cause_manual")
        mode_name = arm_mode_label(self.core, self.mode)
        if not test:
            self.cause = eid
            self.silenced = False
            self._set("triggered")
            what = tr(self.core, "alarm.h_alarm" if loud else "alarm.h_alarm_silent" if reaction == "silent" else "alarm.h_alarm_notify")
            self.core.history.add("alarm", what, tr(self.core, "alarm.h_alarm_why", cause=cause, mode=mode_name), entity_id=eid, logbook="alarm")
            await self._stop_sound()
        title = tr(self.core, "alarm.title_test" if test else "alarm.title_alarm" if loud else "alarm.title_silent")
        message = cause if test else tr(self.core, "alarm.n_alarm", cause=cause, mode=mode_name)
        tasks = [self._notify(message, ctx, critical=cfg["notify"].get("critical", True) and not test, title=title, buttons=cfg.get("buttons", []), kind="test" if test else "triggered")]
        if loud or (test and reaction == "loud"):
            tasks.append(self._announce(tr(self.core, "alarm.test_text") if test else cfg["announce"].get("triggered_text", ""), ctx))
        if not test and reaction != "notify":
            tasks.append(self._activate(mc.get("activate", []), ctx))
            if loud:
                tasks += [self._sirens(True), self._play(cfg["sound"].get("tone") or "", ctx)]
                self._start_lights(mc.get("lights", {}), ctx)
            elif reaction == "silent":
                # in between: the lights blink (then stay on), no siren, no sound, no announcement
                lc = dict(mc.get("lights") or {})
                if lc.get("mode", "on") == "on":
                    lc["mode"] = "flash"
                self._start_lights(lc, ctx)
        since = self.since
        await asyncio.gather(*tasks, return_exceptions=True)
        if not test and (self.state != "triggered" or self.since != since):
            return  # meanwhile switched off (or a new alarm): nothing more from this one
        if not test and cfg["notify"]["repeat"].get("on"):
            self._start_repeat(title, message)
        if not test and loud:
            if self._silence:
                self._silence()
            self._silence = async_call_later(
                self.hass, cfg.get("duration", 180), callback(lambda _now: self.hass.async_create_task(self.silence(tr(self.core, "alarm.by_duration"))))
            )

    def _start_lights(self, cfg: dict[str, Any], ctx: Context) -> None:
        """Lights on / blinking as its own task, so switching off can stop the blinking at once."""
        self._stop_lights()
        self._light_task = self.hass.async_create_task(self._lights(cfg, ctx))

    def _stop_lights(self) -> None:
        if self._light_task and not self._light_task.done():
            self._light_task.cancel()
        self._light_task = None

    async def silence(self, by: str | None = None) -> None:
        by = by or tr(self.core, "alarm.by_hand")
        if self._silence:
            self._silence()
            self._silence = None
        await self._sirens(False)
        await self._stop_sound()
        self.silenced = True
        self._changed()
        self.core.history.add("alarm", tr(self.core, "alarm.h_silenced"), tr(self.core, "alarm.h_silenced_why", by=by), logbook="alarm")

    # ------------------------------------------------------------------ what happens
    async def _call(self, domain: str, service: str, entity: str | list[str], data: dict[str, Any], ctx: Context | None) -> None:
        try:
            await self.hass.services.async_call(domain, service, {ATTR_ENTITY_ID: entity, **data}, blocking=True, context=ctx)
        except Exception as err:  # noqa: BLE001 — one device must not stop the alarm
            _LOGGER.warning("House rules alarm: %s.%s for %s: %s", domain, service, entity, err)

    def _phones(self, kind: str = "triggered") -> list[str]:
        n = self.config["notify"]
        sel = n.get("persons", "everyone") if kind in ("triggered", "repeat", "all") else n.get(f"{kind}_persons", "same")
        if sel == "same":
            sel = n.get("persons", "everyone")
        persons = self.core.inventory.persons.values()
        if kind == "all":
            return sorted({ph for p in persons for ph in p["phones"]})
        return [ph for p in persons if sel == "everyone" or p["id"] in sel for ph in p["phones"]]

    def _link(self) -> str | None:
        try:
            return get_url(self.hass, prefer_external=True) + DASHBOARD_PATH
        except NoURLAvailableError:
            return None

    async def _snapshot(self) -> bytes | None:
        cams = self.config.get("cameras") or []
        if not cams:
            return None
        try:
            from homeassistant.components.camera import async_get_image  # noqa: PLC0415

            return (await async_get_image(self.hass, cams[0], timeout=8)).content
        except Exception:  # noqa: BLE001 — no picture is fine
            return None

    async def _notify(
        self, message: str, ctx: Context, *, critical: bool, title: str | None = None, buttons: list[str] | None = None, kind: str = "triggered", tag: str = "house_rules_alarm"
    ) -> None:
        cfg = self.config
        title = title or tr(self.core, "alarm.title")
        extra = asyncio.create_task(self._channels(kind, title, message)) if kind != "repeat" or cfg["notify"]["repeat"].get("channels") else None
        data: dict[str, Any] = {
            "tag": tag,
            "group": "house_rules_alarm",
            "url": DASHBOARD_PATH,  # iOS: tapping the message opens the alarm screen
            "clickAction": DASHBOARD_PATH,  # Android
        }
        if critical:
            data.update({"push": {"interruption-level": "critical", "sound": {"name": "default", "critical": 1, "volume": 1.0}}, "ttl": 0, "priority": "high", "channel": "alarm_stream"})
        cams = cfg.get("cameras") or []
        if cams:
            data["entity_id"] = cams[0]  # iOS: live camera in the message
            data["image"] = f"/api/camera_proxy/{cams[0]}"  # Android: picture
        actions = []
        for b in buttons or []:
            if b == "disarm" and cfg.get("notify_disarm", True):
                if kind == "armed":  # nothing going off: switching off is the only meaning
                    actions.append({"action": f"{ACTION_PREFIX}DISARM_ALL", "title": tr(self.core, "alarm.btn_disarm_all"), "authenticationRequired": True, "destructive": True})
                else:  # asks next: only this alarm, or the whole system
                    actions.append({"action": f"{ACTION_PREFIX}DISARM", "title": tr(self.core, "alarm.btn_disarm"), "authenticationRequired": True, "destructive": True})
            elif b == "silence":
                actions.append({"action": f"{ACTION_PREFIX}SILENCE", "title": tr(self.core, "alarm.btn_silence")})
            elif b == "lights":
                actions.append({"action": f"{ACTION_PREFIX}LIGHTS", "title": tr(self.core, "alarm.btn_lights")})
            elif b == "camera" and cams:
                actions.append({"action": "URI", "title": tr(self.core, "alarm.btn_cameras"), "uri": DASHBOARD_PATH})
            elif b == "open":
                actions.append({"action": "URI", "title": tr(self.core, "alarm.btn_center"), "uri": DASHBOARD_PATH})
            elif b == "call" and cfg.get("phone"):
                actions.append({"action": "URI", "title": tr(self.core, "alarm.btn_call", phone=cfg["phone"]), "uri": f"tel:{cfg['phone'].replace(' ', '')}"})
        if actions:
            data["actions"] = actions[:3]
        if kind in INFO_KINDS:
            # information, not an alarm (armed / disarmed, e.g. by the automatic arming when people come and go):
            # within the limits of notify.py, the newest replaces the last one; real alarms below go out at once
            await self.core.notifier.send("alarm_info", kind, title, message, services=self._phones(kind), tag=tag, data=data, ctx=ctx, blocking=True)
            if extra:
                await extra
            return
        for service in self._phones(kind):
            try:
                await self.hass.services.async_call("notify", service, {"title": title, "message": message, "data": data}, blocking=True, context=ctx)
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("House rules alarm: notification to %s: %s", service, err)
        if extra:
            await extra

    async def _channels(self, kind: str, title: str, message: str) -> list[str]:
        event = "triggered" if kind == "repeat" else kind
        image = await self._snapshot() if event in ("triggered", "test") and self.config["channels"]["email"].get("on") else None
        errors = await channels.send(self.hass, self.config["channels"], event, title, message, self._link(), image)
        for e in errors:
            self.core.history.add("alarm", tr(self.core, "alarm.h_notify_failed"), e)
        return errors

    async def test_channel(self, name: str) -> list[str]:
        """Sends a test over one channel (button in the setup)."""
        return await channels.send(self.hass, self.config["channels"], "test", tr(self.core, "alarm.title_test_channel"), tr(self.core, "alarm.test_text"), self._link(), await self._snapshot() if name == "email" else None, only=name)

    def _start_repeat(self, title: str, message: str) -> None:
        self._stop_repeat()
        rep = self.config["notify"]["repeat"]
        self._repeat_count = 0

        @callback
        def again(_now: Any) -> None:
            if self.state != "triggered" or self._repeat_count >= rep.get("max", 10):
                self._stop_repeat()
                return
            self._repeat_count += 1
            ctx = self.core.history.new_context("alarm")
            self.hass.async_create_task(
                self._notify(tr(self.core, "alarm.n_reminder", message=message, n=self._repeat_count), ctx, critical=self.config["notify"].get("critical", True), title=title, buttons=self.config.get("buttons", []), kind="repeat")
            )

        from datetime import timedelta  # noqa: PLC0415

        from homeassistant.helpers.event import async_track_time_interval  # noqa: PLC0415

        self._repeat = async_track_time_interval(self.hass, again, timedelta(seconds=rep.get("every", 60)))

    def _stop_repeat(self) -> None:
        if self._repeat:
            self._repeat()
            self._repeat = None

    async def _clear_messages(self) -> None:
        for service in self._phones("all"):
            try:
                await self.hass.services.async_call("notify", service, {"message": "clear_notification", "data": {"tag": "house_rules_alarm"}}, blocking=True)
            except Exception:  # noqa: BLE001
                _LOGGER.debug("clear_notification %s failed", service)

    async def _announce(self, text: str, ctx: Context) -> None:
        players = self.config["announce"].get("players") or []
        if not text or not players:
            return
        engines = [s.entity_id for s in self.hass.states.async_all("tts")]
        if not engines:
            return
        engine = next((e for e in engines if "cloud" in e), engines[0])
        await self._call("tts", "speak", engine, {"media_player_entity_id": players, "message": text, "cache": True}, ctx)

    def tone_url(self, tone: str) -> str | None:
        if tone == "custom":
            return self.config["sound"].get("url") or None
        if tone not in TONES:
            return None
        try:
            base = get_url(self.hass, prefer_external=False)
        except NoURLAvailableError:
            base = ""
        return f"{base}{SOUNDS_URL}/{tone}.mp3"

    async def _play(self, tone: str, ctx: Context, volume: int | None = None, players: list[str] | None = None) -> None:
        s = self.config["sound"]
        players = players or s.get("players") or []
        url = self.tone_url(tone)
        if not players or not url:
            return
        await self._call("media_player", "volume_set", players, {"volume_level": (volume if volume is not None else s.get("volume", 80)) / 100}, ctx)
        await self._call("media_player", "play_media", players, {"media_content_id": url, "media_content_type": "music"}, ctx)

    async def preview_tone(self, tone: str, player: str) -> None:
        """Plays a tone on one speaker at a low volume, to choose."""
        ctx = self.core.history.new_context("alarm")
        await self._play(tone, ctx, volume=30, players=[player])

    async def _stop_sound(self) -> None:
        for p in self.config["sound"].get("players", []):
            await self._call("media_player", "media_stop", p, {}, None)

    async def _sirens(self, on: bool) -> None:
        for e in self.config.get("sirens") or []:
            domain = e.split(".")[0]
            await self._call("siren" if domain == "siren" else "homeassistant", "turn_on" if on else "turn_off", e, {}, None)

    async def _activate(self, entities: list[str], ctx: Context) -> None:
        """Extra devices on alarm: cameras (on), switches (e.g. recording), scenes, scripts."""
        self._activated = []
        for e in entities:
            domain = e.split(".")[0]
            if domain in ("scene", "script"):
                await self._call(domain, "turn_on", e, {}, ctx)
            elif domain == "camera":
                await self._call("camera", "turn_on", e, {}, ctx)
            else:
                st = self.hass.states.get(e)
                await self._call("homeassistant", "turn_on", e, {}, ctx)
                if st and st.state != STATE_ON:
                    self._activated.append(e)

    async def _deactivate(self) -> None:
        """Switches off what the alarm switched on (cameras stay on: recordings must not stop)."""
        for e in self._activated:
            await self._call("homeassistant", "turn_off", e, {}, None)
        self._activated = []

    async def _lights(self, cfg: dict[str, Any], ctx: Context) -> None:
        mode = cfg.get("mode", "on")
        if mode == "none":
            return
        lights = cfg.get("entities") or [d["entity_id"] for d in self.core.inventory.devices.values() if d["kind"] == "light"]
        if not lights:
            return
        bright: dict[str, Any] = {"brightness_pct": 100}
        if mode == "red":
            bright["rgb_color"] = [255, 0, 0]
        if mode in ("flash", "red"):
            for _ in range(5):
                await self._call("light", "turn_on", lights, bright, ctx)
                await asyncio.sleep(1.2)
                await self._call("light", "turn_off", lights, {}, ctx)
                await asyncio.sleep(1.2)
        await self._call("light", "turn_on", lights, bright, ctx)

    # ------------------------------------------------------------------ buttons, house mode, times
    @callback
    def _action(self, event: Event) -> None:
        action = str(event.data.get("action") or "")
        if not action.startswith(ACTION_PREFIX):
            return
        self.hass.async_create_task(self._button(action[len(ACTION_PREFIX) :], event.context.user_id))

    async def may_use_buttons(self, user_id: str | None) -> bool:
        """Whether a button event may act. Any phone registered in the companion app can fire this event with
        any content, so only an admin or a person whose phones get the alarm messages counts."""
        if not user_id:
            return False
        user = await self.hass.auth.async_get_user(user_id)
        if user is None or not user.is_active:
            return False
        if user.is_admin:
            return True
        phones = {ph for kind in ("triggered", "pending", "armed") for ph in self._phones(kind)}
        for p in self.core.inventory.persons.values():
            st = self.hass.states.get(p["entity_id"])
            if st and st.attributes.get("user_id") == user_id and phones.intersection(p["phones"]):
                return True
        return False

    async def _button(self, what: str, user_id: str | None) -> None:
        """A button in an alarm message was tapped (see _notify)."""
        if what not in ("DISARM", "DISARM_ALL", "STOP", "SILENCE", "LIGHTS"):
            return
        if not await self.may_use_buttons(user_id):
            self.core.history.add("alarm", tr(self.core, "alarm.h_button_refused"), tr(self.core, "alarm.h_button_refused_why"))
            _LOGGER.warning("Hausregeln Alarm: button %s from user %s ignored (not an alarm recipient)", what, user_id)
            return
        if what in ("DISARM", "DISARM_ALL", "STOP"):
            if not self.config.get("notify_disarm", True):
                self.core.history.add("alarm", tr(self.core, "alarm.h_disarm_refused"), tr(self.core, "alarm.h_disarm_refused_why"))
                return
            # the phone itself asked for Face ID / its code before sending this (authenticationRequired)
            if what == "DISARM":
                await self._ask_how(user_id)
            elif what == "STOP":
                await self.stand_down(tr(self.core, "alarm.by_button"))
            else:
                await self.disarm(by=tr(self.core, "alarm.by_button"), check=False)
        elif what == "SILENCE":
            await self.silence(tr(self.core, "alarm.by_button"))
        elif what == "LIGHTS":
            ctx = self.core.history.new_context("alarm")
            lights = [d["entity_id"] for d in self.core.inventory.devices.values() if d["kind"] == "light"]
            self.core.history.add("alarm", tr(self.core, "alarm.h_lights"), tr(self.core, "alarm.h_by", by=tr(self.core, "alarm.by_button")))
            if lights:
                await self._call("light", "turn_on", lights, {"brightness_pct": 100}, ctx)

    async def _ask_how(self, user_id: str | None) -> None:
        """After "Alarm aus": a second message to whoever tapped it (their phones; unknown: everyone who got the alarm)."""
        if self.state == "disarmed":
            return
        phones = [
            ph
            for p in self.core.inventory.persons.values()
            if user_id and (st := self.hass.states.get(p["entity_id"])) and st.attributes.get("user_id") == user_id
            for ph in p["phones"]
        ] or self._phones()
        running = self.state in ("pending", "triggered")
        data = {
            "tag": "house_rules_alarm",  # replaces the alarm message on that phone
            "group": "house_rules_alarm",
            "url": DASHBOARD_PATH,
            "clickAction": DASHBOARD_PATH,
            "push": {"interruption-level": "time-sensitive"},
            "actions": [
                {"action": f"{ACTION_PREFIX}STOP", "title": tr(self.core, "alarm.btn_stop"), "authenticationRequired": True},
                {"action": f"{ACTION_PREFIX}DISARM_ALL", "title": tr(self.core, "alarm.btn_disarm_full"), "authenticationRequired": True, "destructive": True},
            ],
        }
        message = tr(self.core, "alarm.n_ask_running" if running else "alarm.n_ask_over")
        ctx = self.core.history.new_context("alarm")
        for service in phones:
            try:
                await self.hass.services.async_call("notify", service, {"title": tr(self.core, "alarm.title_ask_how"), "message": message, "data": data}, blocking=True, context=ctx)
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("House rules alarm: notification to %s: %s", service, err)

    async def stand_down(self, by: str | None = None) -> bool:
        """Ends the running alarm or pre-alarm, the system stays armed in its mode (the sensor that set it off
        sets it off again only after it closed and opened again)."""
        by = by or tr(self.core, "alarm.by_hand")
        was = self.state
        if was not in ("pending", "triggered") or not self.mode:
            if was.startswith("armed_"):
                self.core.history.add("alarm", tr(self.core, "alarm.h_no_more"), tr(self.core, "alarm.h_no_more_why", by=by), logbook="alarm")
            return False
        self._cancel_timer()
        self._stop_lights()
        if self._silence:
            self._silence()
            self._silence = None
        self._stop_repeat()
        await self._sirens(False)
        await self._stop_sound()
        if was == "triggered":
            await self._deactivate()
        cause = self._name(self.cause) if self.cause else ""
        self.cause = None
        self.silenced = False
        self._set(f"armed_{self.mode}")
        what = tr(self.core, "alarm.h_pending_ended" if was == "pending" else "alarm.h_alarm_ended")
        self.core.history.add("alarm", what, tr(self.core, "alarm.h_ended_cause", by=by, cause=cause) if cause else tr(self.core, "alarm.h_by", by=by), logbook="alarm")
        await self._clear_messages()
        return True

    def _mode_changed(self, house_mode: str, _ctx: Context | None) -> None:
        if not self.config.get("enabled"):
            return
        label = mode_label(self.core, house_mode)
        armed = self.state in ("arming", "armed_away", "armed_night", "armed_home")
        if armed and self.mode:
            auto = self.config["modes"][self.mode]["auto"]
            if house_mode in auto.get("disarm_on", []) and (self.by_auto or not auto.get("only_auto", True)):
                self.hass.async_create_task(self.disarm(by=tr(self.core, "alarm.by_auto_mode", mode=label), check=False))
                return
        if self.state == "disarmed":
            for m in MODES:
                if house_mode in self.config["modes"][m]["auto"].get("arm_on", []):
                    self.hass.async_create_task(self.arm(m, force=True, auto=True, why=tr(self.core, "alarm.why_auto_mode", mode=label)))
                    return

    # ------------------------------------------------------------------ presence of the chosen persons
    def presence_persons(self) -> list[dict[str, Any]]:
        sel = self.config["presence"].get("persons", "everyone")
        return [p for p in self.core.inventory.persons.values() if sel == "everyone" or p["id"] in sel]

    def _presence_names(self) -> str:
        names = [p["name"] for p in self.presence_persons()]
        if self.config["presence"].get("persons") == "everyone" or len(names) > 3:
            return tr(self.core, "alarm.presence_everyone")
        return f" {tr(self.core, 'common.and')} ".join(names)

    @callback
    def _presence_changed(self) -> None:
        if not self.config.get("enabled"):
            return
        people = self.presence_persons()
        if not people or self.settling:
            return
        states = [self.hass.states.get(p["entity_id"]) for p in people]
        if any(st is None or st.state in NOT_REAL for st in states):
            return  # someone unknown (e.g. right after a restart): decide nothing
        home = [p for p in people if self.core.inventory.person_home(p["id"])]
        if home:
            if self._away_timer:
                self._away_timer()
                self._away_timer = None
            if self.state in ("arming", "armed_away", "armed_night", "armed_home") and self.mode:
                auto = self.config["modes"][self.mode]["auto"]
                if auto.get("disarm_home") and (self.by_auto or not auto.get("only_auto", True)):
                    self.hass.async_create_task(self.disarm(by=tr(self.core, "alarm.by_auto_home", name=home[0]["name"]), check=False))
            return
        if self.state != "disarmed" or self._away_timer:
            return
        for m in MODES:
            auto = self.config["modes"][m]["auto"]
            if not auto.get("arm_away"):
                continue
            wait = int(auto.get("away_for") or 0) * 60
            why = tr(self.core, "alarm.why_auto_away_for", names=self._presence_names(), min=auto.get("away_for")) if wait else tr(self.core, "alarm.why_auto_away", names=self._presence_names())

            @callback
            def go(_now: Any = None, m: str = m, why: str = why) -> None:
                self._away_timer = None
                gone = not any(self.core.inventory.person_home(p["id"]) for p in self.presence_persons())
                if gone and self.state == "disarmed" and self.config.get("enabled"):
                    self.hass.async_create_task(self.arm(m, force=True, auto=True, why=why))

            if wait:
                self._away_timer = async_call_later(self.hass, wait, go)
            else:
                go()
            return

    def _timed_disarm(self, mode: str) -> None:
        auto = self.config["modes"][mode]["auto"]
        if self.mode == mode and self.state in ("arming", "armed_away", "armed_night", "armed_home") and (self.by_auto or not auto.get("only_auto", True)):
            self.hass.async_create_task(self.disarm(by=tr(self.core, "alarm.by_auto_at", time=auto.get("disarm_at")), check=False))

    def _timed_arm(self, mode: str) -> None:
        if self.state == "disarmed" and self.config.get("enabled"):
            self.hass.async_create_task(self.arm(mode, force=True, auto=True, why=tr(self.core, "alarm.why_auto_at", time=self.config["modes"][mode]["auto"].get("arm_at"))))
