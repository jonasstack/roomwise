"""HouseRules: holds everything together (data, inventory, rooms, engine, history, live updates)."""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from collections.abc import Callable
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_CALL_SERVICE, EVENT_HOMEASSISTANT_STARTED, EVENT_SERVICE_REGISTERED, EVENT_SERVICE_REMOVED
from homeassistant.core import CALLBACK_TYPE, Context, CoreState, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .actions import Executor
from .ai import AiConnection
from .alarm import Alarm
from .objects import ObjectAlarms
from .behaviours import behaviour_list, migrate as migrate_behaviours
from .conditions import Checker
from .const import API_VERSION, IGNORED_PLATFORMS, MODES, STORAGE_KEY, STORAGE_VERSION, VERSION
from .i18n import mode_label, quote, tr
from .engine import Engine
from .history import ACTUATOR_KINDS, History
from .issues import Issues
from .inventory import Inventory
from .llm import TextToRule
from .cleaning import Cleaning
from .lightplan import LightPlanner
from .lightlearn import LightLearner
from .lightcal import LightCal
from .lightpreview import LightPreview
from .lightspec import clean_action
from . import logic
from .assistants import Assistants
from .simulate import Simulator
from .plans import Plans
from .places import Places
from .heating import HeatingController
from .window_warning import WindowWarning
from .ui_layout import RULE_GROUP, clean_ui
from .modes import ModeAuto
from .wakeup import WakeUp
from .native import Native
from .notify import Notifier
from .rooms import PRESENCE_DOMAINS, RoomTracker, clean_dark
from .suggest import suggestions
from .telemetry import Telemetry
from .setup import Features, Setup
from .versions import Versions
from .vocab import Describer, seconds

_LOGGER = logging.getLogger(__name__)
# names of users other automation systems log in as (suggested as "automation" in Einstellungen → Rollen)
AUTOMATION_USER_RE = re.compile(r"node[\s_-]*red|appdaemon|pyscript|supervisor|iobroker|openhab|homey|automation|automatisierung|\bsystem\b")

# after a start: how long changes by others are not "by hand", then everything is checked once (see starting)
STARTUP_SECONDS = 120

# i18n: complete

PARAM_KEYS = {
    *("plan", "preheat", "state", "distance", "zone", "for", "offset", "brightness", "temperature", "value", "time", "from", "to", "mode", "message"),
    *("color", "volume", "position", "rooms", "night_dim", "timeout"),
    # advanced logic (logic.py): trigger id, HA events, numbers between, weekdays
    *("id", "event_type", "event_data", "min", "max", "days"),
}
RULE_ID = re.compile(r"^[a-z0-9_]{3,40}$")
KIND_TAGS = {
    "light": "light",
    "climate": "heating",
    "person": "presence",
    "room": "presence",
    "zone": "presence",
    "presence": "presence",
    "motion": "presence",
    "leak": "safety",
    "lock": "safety",
    "media": "media",
    "vacuum": "cleaning",
    "outlet": "energy",
}


@callback
def _is_notify(data: Any) -> bool:
    return data.get("domain") == "notify"


class HouseRules:
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.data: dict[str, Any] = {}
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.inventory = Inventory(hass, self)
        self.room_tracker = RoomTracker(hass, self)
        self.history = History(hass, self)
        self.describer = Describer(self)
        self.checker = Checker(self)
        self.executor = Executor(hass, self)
        self.engine = Engine(hass, self)
        self.native = Native(hass, self)
        self.text = TextToRule(self)
        self.alarm = Alarm(hass, self)
        self.objects = ObjectAlarms(hass, self)
        self.mode_auto = ModeAuto(hass, self)
        self.wakeup = WakeUp(hass, self)
        self.cleaning = Cleaning(hass, self)
        self.plans = Plans(self)
        self.heating = HeatingController(hass, self)
        self.lightplan = LightPlanner(hass, self)
        self.lightlearn = LightLearner(hass, self)
        self.lightpreview = LightPreview(hass, self)
        # Lampen abgleichen: per lamp corrections of colour and brightness (lightcal.py)
        self.lightcal = LightCal(self)
        self.sim = Simulator(hass, self)
        self.ai = AiConnection(self)
        self.window_warning = WindowWarning(hass, self)
        self.places = Places(hass, self)
        self.features = Features(self)
        self.setup = Setup(self)
        self.assistants = Assistants(self)
        self.telemetry = Telemetry(hass, self)
        self.issues = Issues(hass, self)
        self.versions = Versions(hass, self)
        self.notifier = Notifier(self)
        self.users: dict[str, str] = {}
        # start-up phase (see starting): when the parts began, and the check at its end
        self.started_at: float | None = None
        self._startup_unsub: CALLBACK_TYPE | None = None
        self._subscribers: dict[tuple[int, int], Callable[[dict[str, Any]], None]] = {}
        self._pending: set[str] = set()
        self._flush: CALLBACK_TYPE | None = None
        self._rebuild_timer: CALLBACK_TYPE | None = None
        self._phones_timer: CALLBACK_TYPE | None = None
        self._unsubs: list[Callable[[], None]] = []
        self._history_unsub: CALLBACK_TYPE | None = None
        self.entity_hooks: dict[str, Callable[[], None]] = {}
        self._automations: list[dict[str, Any]] | None = None

    # ------------------------------------------------------------------ properties
    @property
    def rooms(self) -> dict[str, dict[str, Any]]:
        return self.room_tracker.rooms

    @property
    def mode(self) -> str:
        return self.data.get("mode", "home")

    def mode_label(self, mode: str) -> str:
        return mode_label(self, mode)

    def feature(self, name: str) -> bool:
        """Is this part of Hausregeln switched on (Einstellungen → Funktionen)? See setup.py / const.FEATURES."""
        return self.features.get(name)

    def rules(self) -> list[dict[str, Any]]:
        return self.data.setdefault("rules", [])

    def all_rules(self) -> list[dict[str, Any]]:
        # heating plans only while the feature "heating" is on
        return self.rules() + (self.plans.rules() if self.feature("heating") else [])

    def rule(self, rid: str) -> dict[str, Any] | None:
        return next((r for r in self.all_rules() if r["id"] == rid), None)

    def sensitive(self, rid: str) -> bool:
        """The rule may unlock locks or disarm the alarm (option allow_sensitive): only admins may start it by hand,
        since starting by hand skips its trigger and conditions."""
        rule = self.rule(rid)
        return bool(rule and (rule.get("options") or {}).get("allow_sensitive"))

    def group(self, gid: str) -> dict[str, Any] | None:
        return next((g for g in self.data.get("groups", []) if g["id"] == gid), None)

    def clean_group(self, raw: dict[str, Any]) -> dict[str, Any]:
        """A group as it is stored: checked id, name, icon, members (also used when restoring a backup)."""
        gid = str(raw.get("id") or "")
        if not re.match(r"^g_[a-z0-9_]{2,30}$", gid):
            gid = "g_" + uuid.uuid4().hex[:6]
        name = str(raw.get("name") or "").strip()[:60]
        if not name:
            raise ValueError(tr(self, "home.group_needs_name"))
        members = [e for e in raw.get("members", []) if isinstance(e, str) and "." in e][:100] if isinstance(raw.get("members"), list) else []
        return {"id": gid, "name": name, "icon": str(raw.get("icon") or "group")[:40], "members": members, "match": "all" if raw.get("match") == "all" else "any"}

    async def save_group(self, raw: dict[str, Any]) -> dict[str, Any]:
        """Own groups ("Gruppen") like "Heizung" or "Fernseher": a name, an icon and devices."""
        group = self.clean_group(raw)
        gid = group["id"]
        groups = self.data.setdefault("groups", [])
        i = next((n for n, g in enumerate(groups) if g["id"] == gid), None)
        if i is None:
            groups.append(group)
        else:
            groups[i] = group
        self.save()
        self.engine.start()
        self.push("groups")
        self.push("rules")
        return group

    async def delete_group(self, gid: str) -> None:
        self.data["groups"] = [g for g in self.data.get("groups", []) if g["id"] != gid]
        self.save()
        self.engine.start()
        self.push("groups")

    def zones(self) -> list[dict[str, Any]]:
        out = []
        for st in self.hass.states.async_all("zone"):
            a = st.attributes
            out.append(
                {
                    "id": st.object_id,
                    "entity_id": st.entity_id,
                    "name": tr(self, "mode.home") if st.object_id == "home" else str(a.get("friendly_name") or st.object_id),
                    "icon": a.get("icon") or ("mdi:home" if st.object_id == "home" else "mdi:map-marker"),
                    "radius": a.get("radius"),
                    "passive": bool(a.get("passive")),
                    "persons": list(a.get("persons") or []),
                }
            )
        out.sort(key=lambda z: (z["id"] != "home", z["name"]))
        return out

    # ------------------------------------------------------------------ lifecycle
    async def async_start(self) -> None:
        stored = await self._store.async_load()
        self.data = stored or {}
        self.data.setdefault("rules", [])
        self.data.setdefault("rooms", {})
        self.data.setdefault("behaviours", {})
        self.data.setdefault("devices", {})
        self.data.setdefault("settings", {"eco_temp": 17})
        self.data.setdefault("dismissed", [])
        self.data.setdefault("trash", [])
        self.data.setdefault("runtime", {})
        self.data.setdefault("groups", [])
        if self.data.get("mode") not in MODES:
            self.data["mode"] = "home"
        # features + setup wizard: fresh install = minimal set and the wizard opens; existing = everything stays
        self.features.migrate(fresh=stored is None)
        await self.history.async_load()
        await self.places.async_load()
        await self.lightlearn.async_load()
        await self.heating.smart.async_load()
        await self.telemetry.async_load()
        await self.versions.async_load()
        for user in await self.hass.auth.async_get_users():
            self.users[user.id] = user.name or ""

        if self.hass.state is CoreState.running:
            await self._go()
        else:

            async def _started(_e: Event) -> None:
                # fired once: removing it again on unload would log an error
                if unsub in self._unsubs:
                    self._unsubs.remove(unsub)
                await self._go()

            unsub = self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _started)
            self._unsubs.append(unsub)

    async def _go(self) -> None:
        """Starts once Home Assistant is running (all entities exist)."""
        self.started_at = time.time()
        self._startup_unsub = async_call_later(self.hass, STARTUP_SECONDS, self._startup_done)
        self._unsubs.append(lambda: self._startup_unsub() if self._startup_unsub else None)
        self.inventory.rebuild()
        self.cleaning.start()
        self._unsubs.append(self.cleaning.add_listener(self.room_tracker.reevaluate))
        self.room_tracker.start()
        # the room behaviours of older versions become ordinary rules (once; needs the rooms, before the engine)
        if made := migrate_behaviours(self):
            _LOGGER.info("Hausregeln: %s room behaviour(s) turned into rules", made)
        # before the engine: rules about places read the tracks the places module keeps
        self.places.start()
        self.engine.start()
        self.executor.resume_reverts()
        self.alarm.start()
        self.objects.start()
        self.mode_auto.start()
        self.wakeup.start()
        self.lightplan.start()
        self.heating.start()
        self.window_warning.start()
        self.sim.start()
        self.telemetry.start()
        self.issues.start()
        self.hass.async_create_background_task(self.text.warmup(), "house_rules_ai_warmup")
        bus = self.hass.bus
        self._unsubs += [
            bus.async_listen("automation_triggered", self.history.automation_triggered),
            bus.async_listen(EVENT_CALL_SERVICE, self.history.service_called),
            bus.async_listen("automation_reloaded", self._automations_changed),
            bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, self._registry_changed),
            # phones (notify services of the companion app) often come after the start: find them again
            bus.async_listen(EVENT_SERVICE_REGISTERED, self._notify_changed, event_filter=_is_notify),
            bus.async_listen(EVENT_SERVICE_REMOVED, self._notify_changed, event_filter=_is_notify),
            bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, self._registry_changed),
            bus.async_listen(ar.EVENT_AREA_REGISTRY_UPDATED, self._registry_changed),
        ]
        self._track_history()
        persons = [p["entity_id"] for p in self.inventory.persons.values()]
        if persons:
            self._unsubs.append(async_track_state_change_event(self.hass, persons, self._person_changed))
        for hook in self.entity_hooks.values():
            hook()
        self.push("all")

    def starting(self) -> bool:
        """The start-up phase: Home Assistant (or Hausregeln) started less than STARTUP_SECONDS ago. Devices come back
        one by one and other automations (e.g. flows that run once at every start) switch things: changes in this
        time are not "by hand" – the heating, the light plan and the rules put them right instead of keeping them."""
        return self.started_at is None or time.time() - self.started_at < STARTUP_SECONDS

    @callback
    def _startup_done(self, _now: Any = None) -> None:
        """End of the start-up phase: look at everything as it is now and react, not only to the next change."""
        self._startup_unsub = None
        self.heating.schedule_all(0.2)
        self.lightplan.schedule_all()
        self.room_tracker.reevaluate()
        self.hass.async_create_task(self.engine.recheck())
        self.history.add("rule", tr(self, "home.h_startup_checked"), tr(self, "home.h_startup_checked_why"))

    def _track_history(self) -> None:
        """Changes by hand or by HA automations are logged for switchable devices only: listen to exactly those
        entities instead of every state change of the house (a busy power meter costs nothing then)."""
        if self._history_unsub:
            self._history_unsub()
            self._history_unsub = None
        # (vacuums too: "cleaned today" must know about every run, also one started in the robot's app)
        ents = [e for e, d in self.inventory.devices.items() if d.get("kind") in ACTUATOR_KINDS or d.get("kind") == "vacuum"]
        if ents:
            self._history_unsub = async_track_state_change_event(self.hass, ents, self.history.state_changed)

    async def async_stop(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()
        if self._phones_timer:
            self._phones_timer()
            self._phones_timer = None
        if self._history_unsub:
            self._history_unsub()
            self._history_unsub = None
        self.alarm.stop()
        self.objects.stop()
        self.mode_auto.stop()
        # live previews of the panel: lamps back before the integration goes (bounded, never blocks an unload)
        try:
            await asyncio.wait_for(self.lightpreview.stop_all(), 5)
        except Exception:  # noqa: BLE001 — unloading must go on
            _LOGGER.debug("Live preview: lamps not all put back on unload", exc_info=True)
        self.wakeup.stop()
        self.lightplan.stop()
        self.heating.stop()
        self.window_warning.stop()
        self.sim.stop()
        self.issues.stop()
        self.cleaning.stop()
        self.engine.stop()
        self.room_tracker.stop()
        self.places.stop()
        await self.places.async_save()
        await self.heating.smart.async_stop()
        await self.telemetry.async_stop()
        await self.versions.async_flush()
        await self.history.async_flush()
        await self._store.async_save(self.data)
        await self.lightlearn.async_save_now()

    def save(self) -> None:
        self._store.async_delay_save(lambda: self.data, 5)
        if self.issues._unsubs:  # noqa: SLF001 — running: look for problems again after changes
            self.issues.schedule()

    # sections of the store that name devices (backup.py, issues.py); never runtime or history
    ENTITY_SECTIONS = ("rules", "groups", "rooms", "devices", "plans", "heating", "alarm", "object_alarms", "window_warning", "mode_auto", "cleaning", "sim")

    def replace_entities(self, mapping: dict[str, str]) -> None:
        """Puts other devices in place of these everywhere they are used (Repairs: a device was replaced)."""
        from .backup import remap  # noqa: PLC0415

        for key in self.ENTITY_SECTIONS:
            if key in self.data:
                self.data[key] = remap(self.data[key], mapping) if key != "sim" else {**self.data[key], "config": remap(self.data[key].get("config", {}), mapping)}
        self.history.add("manual", tr(self, "home.device_replaced"), ", ".join(f"{a} → {b}" for a, b in mapping.items()))
        self.save()
        self.rebuild_now()

    # ------------------------------------------------------------------ registry changes
    @callback
    def _registry_changed(self, _event: Event) -> None:
        if self._rebuild_timer:
            self._rebuild_timer()
        self._rebuild_timer = async_call_later(self.hass, 3, self._rebuild)

    @callback
    def _notify_changed(self, _event: Event) -> None:
        """A notify service came or went: the persons' phones again (debounced, no full rebuild)."""
        if self._phones_timer:
            self._phones_timer()

        @callback
        def later(_now: Any) -> None:
            self._phones_timer = None
            self.inventory._rebuild_persons()  # noqa: SLF001
            self.push("persons")

        self._phones_timer = async_call_later(self.hass, 2, later)

    def rebuild_now(self) -> None:
        if self._rebuild_timer:
            self._rebuild_timer()
        self._rebuild()

    def residents(self) -> list[dict[str, Any]]:
        """Every person of Home Assistant and whether it counts as a resident (for "alle", "jemand", the alarm)."""
        excluded = set(self.data.get("settings", {}).get("persons_excluded", []))
        out = []
        for st in self.hass.states.async_all("person"):
            out.append(
                {
                    "entity_id": st.entity_id,
                    "name": str(st.attributes.get("friendly_name") or st.object_id),
                    "counts": st.entity_id not in excluded,
                    "tracked": bool(st.attributes.get("device_trackers")),
                    "state": st.state,
                }
            )
        return sorted(out, key=lambda p: p["name"].lower())

    @callback
    def _rebuild(self, _now: Any = None) -> None:
        self._rebuild_timer = None
        self.inventory.rebuild()
        self.room_tracker.stop()
        self.room_tracker.start()
        self.places.start()
        self.engine.start()
        self.alarm.restart()
        self.mode_auto.start()
        self.wakeup.start()
        self.lightplan.start()
        self.heating.start()
        self.window_warning.start()
        self._track_history()
        for hook in self.entity_hooks.values():
            hook()
        self.issues.schedule()
        self.push("all")

    @callback
    def _automations_changed(self, _event: Event | None = None) -> None:
        self._automations = None
        self.push("automations")

    def automations(self) -> list[dict[str, Any]]:
        if self._automations is None:
            self._automations = self.native.list()
        return self._automations

    # ------------------------------------------------------------------ house mode
    async def set_mode(self, mode: str, ctx: Context | None = None) -> None:
        if mode not in MODES or mode == self.mode:
            return
        if not (ctx and self.history.is_ours(ctx)):
            self.mode_auto.manual()
        old = self.mode
        self.data["mode"] = mode
        # by a person (app, dashboard, voice): ending or restarting "Schlafen" teaches the wakeup detection
        self.wakeup.mode_set(old, mode, by_hand=bool(ctx and ctx.user_id and not self.history.is_ours(ctx) and not self.automation_user(ctx.user_id)))
        self.save()
        self.engine.mode_changed(mode, ctx)
        for key in ("mode", "mode_sensor"):
            if hook := self.entity_hooks.get(key):
                hook()
        self.history.add("rule" if ctx and self.history.is_ours(ctx) else "manual", tr(self, "home.mode_changed", mode=self.mode_label(mode)), self._mode_why(ctx), rule=self.rule(self.history.ours.get(ctx.id, "")) if ctx else None)
        self.push("mode")
        self.sim.tick()

    def _mode_why(self, ctx: Context | None) -> str:
        if ctx and ctx.id in self.history.ours:
            r = self.rule(self.history.ours[ctx.id])
            return tr(self, "home.by_rule", name=quote(self, r["name"])) if r else tr(self, "home.by_a_rule")
        if ctx and ctx.user_id and not self.automation_user(ctx.user_id):
            return tr(self, "home.by_hand_user", user=self.users.get(ctx.user_id, tr(self, "home.app")))
        return tr(self, "home.automatic")

    # ------------------------------------------------------------------ users that are automations
    @staticmethod
    def suggested_automation(name: str) -> bool:
        """A user that other automation systems log in as (Node-RED, AppDaemon, add-ons via the Supervisor …)."""
        n = (name or "").lower()
        return bool(AUTOMATION_USER_RE.search(n)) and "cloud" not in n  # the cloud user: voice assistants, a person

    def automation_user(self, user_id: str | None) -> bool:
        """Changes by this Home Assistant user come from another automation system, not from a person
        (Einstellungen → Rollen; unset = the suggestion by name)."""
        if not user_id:
            return False
        own = (self.data.get("settings", {}).get("automation_users") or {}).get(user_id)
        if isinstance(own, bool):
            return own
        return self.suggested_automation(self.users.get(user_id, ""))

    async def automation_users_view(self) -> list[dict[str, Any]]:
        """Every active user, also the ones Home Assistant made itself (add-ons call as "Supervisor")."""
        out = []
        for u in await self.hass.auth.async_get_users():
            if not u.is_active:
                continue
            self.users[u.id] = u.name or ""
            out.append({"id": u.id, "name": u.name or "", "system": u.system_generated, "suggested": self.suggested_automation(u.name or ""), "automation": self.automation_user(u.id)})
        return sorted(out, key=lambda x: (not x["automation"], not x["suggested"], x["system"], x["name"].lower()))

    @callback
    def _person_changed(self, event: Event[EventStateChangedData]) -> None:
        self.push("persons")
        self.push("zones")

    async def auto_mode(self, mode: str, why: str) -> None:
        """Mode change by the automatic house mode (modes.py)."""
        if mode not in MODES or mode == self.mode:
            return
        ctx = Context()
        old = self.mode
        self.data["mode"] = mode
        self.wakeup.mode_set(old, mode, by_hand=False)
        self.save()
        self.engine.mode_changed(mode, ctx)
        for key in ("mode", "mode_sensor"):
            if hook := self.entity_hooks.get(key):
                hook()
        self.history.add("rule", tr(self, "home.mode_changed", mode=self.mode_label(mode)), tr(self, "home.auto_mode_why", why=why), logbook="mode")
        self.push("mode")
        self.sim.tick()

    # ------------------------------------------------------------------ rules
    def sanitize_clause(self, c: Any) -> dict[str, Any] | None:
        """One part of a rule: subject, verb and known values (also used by the light plan's situations)."""
        clause = self.sanitize_clause
        if not isinstance(c, dict) or not isinstance(c.get("subject"), str) or not isinstance(c.get("verb"), str):
            return None
        if c["subject"] == "logic":
            return logic.clean(clause, c)  # groups and blocks (and/or/not, if, choose, repeat …)
        out: dict[str, Any] = {"subject": c["subject"][:200], "verb": c["verb"][:40]}
        if isinstance(c.get("light"), dict):
            out["light"] = clean_action(c["light"])  # a light setting: colour, effect, each lamp its own (lightspec.py)
        for k, v in c.items():
            if k in PARAM_KEYS and isinstance(v, (str, int, float, bool)) and v != "":
                out[k] = v[:500] if isinstance(v, str) else v
        if isinstance(c.get("or"), list):
            # "… oder …": alternatives for a condition (one level)
            alts = [a for a in (clause({k: v for k, v in x.items() if k != "or"}) for x in c["or"][:6] if isinstance(x, dict)) if a]
            if alts:
                out["or"] = alts
        return out

    def sanitize(self, raw: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ValueError(tr(self, "home.rule_missing"))
        rid = str(raw.get("id") or "")
        if not RULE_ID.match(rid) or rid.startswith("b_"):
            rid = "r_" + uuid.uuid4().hex[:6]
        old = next((r for r in self.rules() if r["id"] == rid), None)

        clause = self.sanitize_clause

        rule: dict[str, Any] = {
            "id": rid,
            "name": str(raw.get("name") or "").strip()[:120] or tr(self, "home.new_rule"),
            "type": "while" if raw.get("type") == "while" else "when",
        }
        for s in ("when", "and", "then", "only"):
            items = raw.get(s) if isinstance(raw.get(s), list) else []
            rule[s] = [c for c in (clause(x) for x in items[:20]) if c]
        if isinstance(raw.get("group"), str) and RULE_GROUP.match(raw["group"]):
            # own group on the rules page ("Abendroutine"); only for the layout, see clean_ui
            rule["group"] = raw["group"]
        if rule["type"] == "while" and isinstance(raw.get("else"), list):
            # "Wechselnd": steps for when it no longer holds (instead of putting things back)
            rule["else"] = [c for c in (clause(x) for x in raw["else"][:20]) if c]
        if not rule["when"] or not rule["then"]:
            raise ValueError(tr(self, "home.rule_incomplete"))
        rule["enabled"] = bool(raw.get("enabled", True))
        until = raw.get("paused_until")
        rule["paused_until"] = until if isinstance(until, str) and dt_util.parse_datetime(until) else None
        opts = raw.get("options") if isinstance(raw.get("options"), dict) else {}
        rule["options"] = {
            "cooldown": str(opts.get("cooldown") or "") if seconds(opts.get("cooldown")) or opts.get("cooldown") in ("", None) else "",
            "manual_pause": str(opts.get("manual_pause") or ""),
            "notify_me": bool(opts.get("notify_me")),
            "allow_sensitive": bool(opts.get("allow_sensitive")),
            "ai_check": bool(opts.get("ai_check")),
            # while rules: put back what was changed when it no longer holds (default on)
            "restore": bool(opts.get("restore", True)),
        }
        if opts.get("mode") in logic.RUN_MODES and opts["mode"] != "single":
            # set off again while it still runs: restart / queued / parallel (logic.launch), at most "max" at once
            rule["options"]["mode"] = opts["mode"]
            try:
                rule["options"]["max"] = max(1, min(100, int(opts.get("max") or 10)))
            except (TypeError, ValueError):
                rule["options"]["max"] = 10
        meta_in = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
        meta = dict(old.get("meta", {})) if old else {"created": dt_util.utcnow().isoformat(), "created_by": user_id}
        meta["origin"] = meta.get("origin") or (meta_in.get("origin") if meta_in.get("origin") in ("user", "suggestion", "text", "room", "import") else "user")
        if isinstance(meta_in.get("replaces"), list):
            meta["replaces"] = [str(x) for x in meta_in["replaces"] if isinstance(x, str)][:10]
        rule["meta"] = meta
        tags: set[str] = set()
        for s in ("when", "and", "then", "only", "else"):
            for c in rule.get(s, []):
                kind = self.checker.res.kind_of(c["subject"])
                if kind in KIND_TAGS:
                    tags.add(KIND_TAGS[kind])
                if c["verb"] == "alarm":
                    tags.add("safety")
                if kind == "window" and any(self.checker.res.kind_of(t["subject"]) == "climate" for t in rule["then"]):
                    tags.add("heating")
        rule["tags"] = sorted(tags)
        return rule

    async def save_rule(self, raw: dict[str, Any], user_id: str | None = None, *, kind: str = "edit", restored_from: str | None = None) -> dict[str, Any]:
        """Saves a rule (new or changed) and keeps the new state as a version (versions.py)."""
        rule = self.sanitize(raw, user_id)
        rules = self.rules()
        i = next((n for n, r in enumerate(rules) if r["id"] == rule["id"]), None)
        before = rules[i] if i is not None else None
        if i is None:
            rules.insert(0, rule)
        else:
            rules[i] = rule
        self.versions.record(rule, user_id, kind, before=before, restored_from=restored_from)
        if rule["meta"].get("origin") == "suggestion":
            sid = raw.get("suggestion") or (raw.get("meta") or {}).get("suggestion")
            if isinstance(sid, str):
                self.data["dismissed"].append(sid)
        self.save()
        await self.engine.reload(rule)
        if hook := self.entity_hooks.get("rules"):
            hook()
        self.push("rules")
        self.push("suggestions")
        return rule

    async def delete_rule(self, rid: str, user_id: str | None = None) -> bool:
        """Moves a rule to the trash (restorable for 30 days, versions.py)."""
        rule = next((r for r in self.rules() if r["id"] == rid), None)
        if not rule:
            return False
        if not self.versions.rules.get(rid):
            self.versions.record(rule, rule.get("meta", {}).get("created_by"), "before")
        self.data["rules"] = [r for r in self.rules() if r["id"] != rid]
        self.versions.to_trash(rule, user_id)
        self.save()
        await self.engine.reload(None, rid)
        if hook := self.entity_hooks.get("rules"):
            hook()
        self.push("rules")
        return True

    async def restore_from_trash(self, rid: str, user_id: str | None = None) -> dict[str, Any]:
        """Brings a deleted rule back. If a rule with its id exists meanwhile, it comes back under a new id."""
        rule = self.versions.take_from_trash(rid)
        if rule is None:
            raise ValueError(tr(self, "rel.not_in_trash"))
        if any(r["id"] == rule["id"] for r in self.rules()):
            new_id = "r_" + uuid.uuid4().hex[:6]
            rule = {**rule, "id": new_id}
        rule["meta"] = {**rule.get("meta", {}), "restored": dt_util.utcnow().isoformat()}
        self.rules().insert(0, rule)
        self.versions.record(rule, user_id, "trash_restore")
        self.save()
        await self.engine.reload(rule)
        if hook := self.entity_hooks.get("rules"):
            hook()
        self.push("rules")
        return rule

    async def restore_version(self, rid: str, vid: str, user_id: str | None = None) -> dict[str, Any]:
        """Puts an earlier version of a rule back (as a new version; on/off and run times stay)."""
        current = next((r for r in self.rules() if r["id"] == rid), None)
        version = self.versions.get(rid, vid)
        if current is None:
            raise ValueError(tr(self, "rel.rule_gone"))
        if version is None:
            raise ValueError(tr(self, "rel.version_gone"))
        raw = {**{k: v for k, v in current.items() if k not in ("else",)}, **version["rule"], "id": rid, "enabled": current.get("enabled", True), "paused_until": current.get("paused_until")}
        return await self.save_rule(raw, user_id, kind="restore", restored_from=vid)

    async def mark_exported(self, rid: str, automation_id: str, user_id: str | None = None) -> dict[str, Any]:
        """The rule now lives on as a Home Assistant automation: switch it off here (it stays, can be switched on again)."""
        rule = next((r for r in self.rules() if r["id"] == rid), None)
        if rule is None:
            raise ValueError(tr(self, "rel.rule_missing"))
        rule.setdefault("meta", {})["exported"] = {"automation_id": automation_id[:80], "at": dt_util.utcnow().isoformat(), "by": user_id}
        rule["enabled"] = False
        self.save()
        await self.engine.reload(rule)
        if hook := self.entity_hooks.get("rules"):
            hook()
        self.push("rules")
        self.history.add("manual", tr(self, "rel.h_exported", name=quote(self, str(rule.get("name")))), tr(self, "rel.h_exported_why"), rule=rule)
        return rule

    async def set_enabled(self, rid: str, enabled: bool) -> None:
        rule = next((r for r in self.rules() if r["id"] == rid), None)
        if not rule or rule.get("enabled", True) == enabled:
            return
        rule["enabled"] = enabled
        self.save()
        await self.engine.reload(rule)
        if hook := self.entity_hooks.get("rules"):
            hook()
        self.push("rules")

    async def pause_rule(self, rid: str, until: float | None) -> None:
        rule = next((r for r in self.rules() if r["id"] == rid), None)
        if not rule:
            return
        rule["paused_until"] = dt_util.utc_from_timestamp(until).isoformat() if until else None
        self.save()
        await self.engine.reload(rule)
        self.push("rules")

    def rule_ran(self, rid: str) -> None:
        rule = next((r for r in self.rules() if r["id"] == rid), None)
        runs = self.data["runtime"].setdefault("runs", {}).setdefault(rid, [])
        now = time.time()
        runs.append(now)
        self.data["runtime"]["runs"][rid] = [t for t in runs if now - t < 7 * 86400][-500:]
        if rule:
            rule.setdefault("meta", {})["last_run"] = dt_util.utcnow().isoformat()
            self.push("rules")
        self.save()

    def mark_cleaned(self, entity_id: str) -> None:
        self.data["runtime"].setdefault("cleaned", {})[entity_id] = dt_util.now().date().isoformat()
        self.save()

    async def notify_admins(self, rule: dict[str, Any], what: str, why: str) -> None:
        """ "Tell me when it ran": to the person who made the rule (else everyone), within the limits of notify.py."""
        creator = rule.get("meta", {}).get("created_by")
        persons = [p for p in self.inventory.persons.values() if creator and (st := self.hass.states.get(p["entity_id"])) and st.attributes.get("user_id") == creator]
        targets = persons or list(self.inventory.persons.values())
        await self.notifier.send("rule_report", rule["id"], rule.get("name") or tr(self, "app.name"), f"{what}\n{why}", persons=[p["id"] for p in targets], tag=f"house_rules_ran_{rule['id']}")

    # ------------------------------------------------------------------ rooms, devices, behaviours
    async def save_room(self, raw: dict[str, Any]) -> None:
        if raw.get("id") not in self.rooms:
            raise ValueError(tr(self, "home.room_unknown"))
        self.room_patch(raw)
        self.save()
        self._restart_rooms()

    def presence_candidates(self, query: str = "", ids: list[str] | None = None) -> list[dict[str, Any]]:
        """Sensors a room can take by hand as presence / motion (websocket entities/search): every binary_sensor,
        input_boolean and sensor counting people or targets – with name, state, area and what they look like
        (presence / motion by device class or name). `ids`: exactly these (for sensors already chosen)."""
        from .inventory import norm_name, presence_kind

        ent_reg, dev_reg = er.async_get(self.hass), dr.async_get(self.hass)
        areas = {a.id: a.name for a in ar.async_get(self.hass).async_list_areas()}
        q = norm_name(query) if query else ""
        out: list[dict[str, Any]] = []
        states = [s for i in (ids or []) if (s := self.hass.states.get(i))] if ids else self.hass.states.async_all(("binary_sensor", "input_boolean", "sensor"))
        for st in states:
            eid = st.entity_id
            reg = ent_reg.async_get(eid)
            if reg and reg.platform in IGNORED_PLATFORMS:
                continue  # Hausregeln's own "… belegt" would make a room its own sensor
            dc = str(st.attributes.get("device_class") or "")
            name = str(st.attributes.get("friendly_name") or eid)
            dev = self.inventory.devices.get(eid)
            kind = dev["kind"] if dev and dev.get("kind") in ("presence", "motion") else ("motion" if dc in ("motion", "moving") else "presence" if dc in ("occupancy", "presence") else presence_kind(eid, name, dc))
            if not ids:
                if eid.startswith("sensor."):
                    # a sensor only when it counts people / targets (a number) and its name says so
                    if kind is None:
                        continue
                    try:
                        float(st.state)
                    except ValueError:
                        continue
                if dc in ("battery", "connectivity", "problem", "update", "tamper") and not q:
                    continue
                if q and q not in norm_name(f"{name} {eid}"):
                    continue
            area_id = (reg.area_id if reg else None) or ((d.area_id if (d := dev_reg.async_get(reg.device_id)) else None) if reg and reg.device_id else None)
            out.append({"entity_id": eid, "name": name, "state": st.state, "unit": st.attributes.get("unit_of_measurement"), "room": area_id, "room_name": areas.get(area_id or ""), "kind": kind, "device_class": dc or None})
        # what looks like presence / motion first, then by name
        out.sort(key=lambda x: (x["kind"] is None, x["name"].lower()))
        return out[:60]

    def room_patch(self, raw: dict[str, Any]) -> None:
        """Takes over the valid settings of a room (no save, no restart; also used when restoring a backup)."""
        stored = self.data["rooms"].setdefault(raw["id"], {})
        known = set(self.inventory.devices)
        for key in ("presence", "motion", "doors", "zones", "door_pulse"):
            if isinstance(raw.get(key), list):
                # presence / motion: also any sensor of Home Assistant chosen by hand (no fitting class, not found)
                def ok(e: Any, key: str = key) -> bool:
                    if not isinstance(e, str):
                        return False
                    if e in known:
                        return True
                    if key not in ("presence", "motion") or not e.startswith(PRESENCE_DOMAINS) or self.hass.states.get(e) is None:
                        return False
                    # never Hausregeln's own entities ("Bad belegt" as the Bad's sensor would hold it forever)
                    reg = er.async_get(self.hass).async_get(e)
                    return not (reg and reg.platform in IGNORED_PLATFORMS)

                stored[key] = [e for e in raw[key] if ok(e)][:40]
        if "lux" in raw and (raw["lux"] is None or raw["lux"] in known):
            stored["lux"] = raw["lux"]
        for key, lo, hi in (("dark_below", 0, 100000), ("empty_after", 0, 240), ("door_pulse_for", 0, 600)):
            if isinstance(raw.get(key), (int, float)) and not isinstance(raw[key], bool):
                stored[key] = max(lo, min(hi, raw[key]))
        if isinstance(raw.get("dark"), dict):
            # dark signal: sun limit, evening window, hysteresis, when the lux value counts (rooms.py)
            stored["dark"] = clean_dark(raw["dark"], stored.get("dark"))
        if isinstance(raw.get("door_logic"), bool):
            stored["door_logic"] = raw["door_logic"]
        if isinstance(raw.get("behaviours"), dict):
            stored["behaviours"] = {k: bool(v) for k, v in raw["behaviours"].items() if isinstance(k, str) and v is not None}
        if isinstance(raw.get("in"), str) and raw["in"].strip():
            stored["in"] = raw["in"].strip()[:40]

    def _restart_rooms(self) -> None:
        self.room_tracker.stop()
        self.room_tracker.start()
        self.engine.start()
        if hook := self.entity_hooks.get("rooms"):
            hook()
        self.push("rooms")
        self.push("occupancy")

    async def save_plan(self, kind: str, rid: str, plan: dict[str, Any]) -> None:
        self.plans.save(kind, rid, plan)
        self.engine.start()
        if kind == "heat":
            # the heating controller (heating.py) applies the plan right away
            await self.heating.evaluate(rid)
        self.push("plans")

    async def set_behaviour(self, bid: str, on: bool) -> None:
        self.data["behaviours"][bid] = bool(on)
        self.save()
        self.engine.start()
        self.push("behaviours")
        self.push("suggestions")

    async def set_devices(self, changes: list[dict[str, Any]]) -> None:
        self.device_patch(changes)
        self.save()
        self._rebuild()

    KINDS_OK = frozenset(
        {"light", "window", "door", "motion", "presence", "zone", "climate", "cover", "media", "switch", "outlet", "fan", "purifier", "leak", "temperature", "illuminance", "lock", "vacuum", "script", "vehicle"}
    )

    def device_patch(self, changes: list[dict[str, Any]]) -> None:
        """The central override store per device (no save, no rebuild; also used when restoring a backup):
        kind, room, hidden ("nicht verwenden"), no_room, name, icon, manual (added by hand); reset = back to
        what was detected (a manual device is removed). Every part of Hausregeln reads it through the inventory."""
        from .inventory import ICON_RE  # noqa: PLC0415

        devs = self.data["devices"]
        for c in changes[:5000]:
            eid = c.get("entity_id")
            if not isinstance(eid, str) or "." not in eid:
                continue
            if c.get("reset"):
                devs.pop(eid, None)
                continue
            entry = devs.setdefault(eid, {})
            if c.get("kind") in self.KINDS_OK:
                entry["kind"] = c["kind"]
            elif "kind" in c and c["kind"] is None:
                entry.pop("kind", None)
            if "room" in c and (c["room"] is None or c["room"] in self.inventory.areas):
                entry["room"] = c["room"]
            for key in ("hidden", "manual"):
                if isinstance(c.get(key), bool):
                    entry[key] = c[key]
            if isinstance(c.get("no_room"), bool):
                entry["no_room"] = c["no_room"]
                if c["no_room"]:
                    entry.pop("room", None)
            if "name" in c:
                entry["name"] = str(c["name"] or "").strip()[:60]
            if "icon" in c:
                entry["icon"] = str(c["icon"] or "") if ICON_RE.match(str(c["icon"] or "")) else ""
            for key in ("hidden", "manual", "no_room", "name", "icon", "room"):
                if key in entry and not entry[key]:
                    entry.pop(key)
            if not entry:
                devs.pop(eid, None)

    def behaviours_known(self) -> list[dict[str, Any]]:
        return behaviour_list(self)

    def save_settings(self, new: dict[str, Any], rebuild: bool = True) -> None:
        """Words and values used by rules (Einstellungen): eco temperature, times of day, who counts as resident."""
        s = self.data.setdefault("settings", {})
        if isinstance(new.get("auto_mode"), bool):
            self.mode_auto.save("_enabled", {"enabled": new["auto_mode"]})
        if isinstance(new.get("eco_temp"), (int, float)) and not isinstance(new["eco_temp"], bool):
            s["eco_temp"] = max(5, min(25, new["eco_temp"]))
        if isinstance(new.get("times"), dict):
            s["times"] = {
                k: [int(v[0]) % 24, int(v[1]) % 24]
                for k, v in new["times"].items()
                if k in ("night", "morning", "evening") and isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v)
            }
        if isinstance(new.get("notifications"), dict):
            # Einstellungen → Benachrichtigungen (notify.py)
            s["notifications"] = self.notifier.clean(new["notifications"])
            if new["notifications"].get("reset") is True:
                self.notifier.reset()  # "count again from zero" (also used by the tests)
        if isinstance(new.get("ollama"), dict):
            o = new["ollama"]
            s["ollama"] = {"url": str(o.get("url") or "")[:200], "model": str(o.get("model") or "")[:80], "enabled": bool(o.get("enabled", True))}
        if isinstance(new.get("automation_users"), dict):
            # {user_id: true/false}: these users are automations (Node-RED …) / are persons; missing = the suggestion
            s["automation_users"] = {str(k)[:64]: v for k, v in list(new["automation_users"].items())[:50] if isinstance(v, bool)}
        if isinstance(new.get("ui"), dict):
            # page layout of the panel: rule groups, order and hidden room tiles per page (no effect on what runs)
            s["ui"] = clean_ui({**s.get("ui", {}), **new["ui"]})
        changed = False
        if isinstance(new.get("persons_excluded"), list):
            s["persons_excluded"] = [str(x) for x in new["persons_excluded"] if str(x).startswith("person.")][:20]
            changed = True
        if isinstance(new.get("phones_excluded"), list):
            # notify services of found phones that get no messages (alarm, window warning, reminders)
            s["phones_excluded"] = [str(x)[:80] for x in new["phones_excluded"] if isinstance(x, str) and x][:40]
            changed = True
        self.save()
        if changed and rebuild:
            self.rebuild_now()

    # ------------------------------------------------------------------ live updates to the panel / card
    def subscribe(self, key: tuple[int, int], send: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self._subscribers[key] = send
        return lambda: self._subscribers.pop(key, None)

    def push(self, kind: str, payload: Any = None) -> None:
        if not self._subscribers:
            return
        if kind == "history" and payload is not None:
            for send in list(self._subscribers.values()):
                send({"kind": "history_add", "entry": payload})
            return
        self._pending.add(kind)
        if self._flush is None:
            self._flush = async_call_later(self.hass, 0.25, self._do_flush)

    @callback
    def _do_flush(self, _now: Any = None) -> None:
        self._flush = None
        kinds = self._pending
        self._pending = set()
        if "all" in kinds:
            msg = {"kind": "snapshot", **self.snapshot()}
        else:
            msg = {"kind": "update"}
            for k in kinds:
                msg.update(self._part(k))
        for send in list(self._subscribers.values()):
            send(msg)

    def _part(self, kind: str) -> dict[str, Any]:
        if kind in ("rules", "active"):
            return {"rules": self.rules_view(), "active": self.engine.active_map()}
        if kind in ("rooms", "occupancy"):
            return {"rooms": list(self.rooms.values()), "occupancy": self.room_tracker.view(), "today": {r: self.history.today(r) for r in self.rooms}}
        if kind == "mode":
            return {"mode": self.mode}
        if kind == "persons":
            return {"persons": self.inventory.persons_view(), "residents": self.residents()}
        if kind == "behaviours":
            return {"behaviours": behaviour_list(self), "rooms": list(self.rooms.values())}
        if kind == "suggestions":
            return {"suggestions": suggestions(self, self.automations())}
        if kind == "automations":
            return {"automations": self.automations(), "suggestions": suggestions(self, self.automations())}
        if kind == "devices":
            return {"devices": list(self.inventory.devices.values()), "devices_unused": self.inventory.unused_view()}
        if kind == "groups":
            return {"groups": self.data.get("groups", [])}
        if kind == "zones":
            return {"zones": self.zones()}
        if kind == "alarm":
            return {"alarm": self.alarm.view()}
        if kind == "objects":
            return {"objects": self.objects.view()}
        if kind == "ai":
            return {"ai": self.ai.public()}
        if kind == "mode_auto":
            return {"mode_auto": self.mode_auto.view()}
        if kind == "cleaning":
            return {"cleaning": self.cleaning.view()}
        if kind == "plans":
            return {"plans": self.plans.view()}
        if kind in ("features", "settings"):
            return {"features": self.features.view(), "settings": self.settings_view()}
        if kind == "setup":
            return {"setup": self.setup.view()}
        if kind == "window_warning":
            return {"window_warning": self.window_warning.view()}
        if kind == "places":
            return {"places": self.places.view()}
        return {}

    def settings_view(self) -> dict[str, Any]:
        return {k: v for k, v in self.data.get("settings", {}).items() if k != "ollama"} | {"ai_connected": self.ai.connected, "features": self.features.view(), "notifications": self.notifier.view()}

    def rules_view(self) -> list[dict[str, Any]]:
        runs = self.data["runtime"].get("runs", {})
        now = time.time()
        return [
            {
                **r,
                "sentence": self.describer.sentence(r),
                "meta": {**r.get("meta", {}), "runs_week": sum(1 for t in runs.get(r["id"], []) if now - t < 7 * 86400)},
            }
            for r in self.rules()
        ]

    def snapshot(self) -> dict[str, Any]:
        return {
            "version": VERSION,
            "api": API_VERSION,
            "mode": self.mode,
            # the start-up phase after a start (see starting): changes by others do not count as by hand yet
            "starting": self.starting(),
            "rules": self.rules_view(),
            "active": self.engine.active_map(),
            "rooms": list(self.rooms.values()),
            "occupancy": self.room_tracker.view(),
            "today": {r: self.history.today(r) for r in self.rooms},
            "devices": list(self.inventory.devices.values()),
            "devices_unused": self.inventory.unused_view(),
            "objects": self.objects.view(),
            "persons": self.inventory.persons_view(),
            "automations": self.automations(),
            "history": self.history.recent(150),
            "suggestions": suggestions(self, self.automations()),
            "behaviours": behaviour_list(self),
            "groups": self.data.get("groups", []),
            "zones": self.zones(),
            "alarm": self.alarm.view(),
            "ai": self.ai.public(),
            "mode_auto": self.mode_auto.view(),
            "cleaning": self.cleaning.view(),
            "residents": self.residents(),
            "plans": self.plans.view(),
            "settings": self.settings_view(),
            "features": self.features.view(),
            "setup": self.setup.view(),
            "window_warning": self.window_warning.view(),
            "places": self.places.view(),
        }

    def for_entity(self, entity_id: str) -> dict[str, Any]:
        """Which rules start / check / switch a device, plus HA automations and recent history."""
        dev = self.inventory.devices.get(entity_id)
        return {
            **self._uses(entity_id),
            "automations": [a for a in self.automations() if any(u["entity_id"] == entity_id for u in a["uses"])],
            "history": self.history.recent(10, entity_id),
            "device": dev,
            "subject": f"zone:{entity_id}" if dev and dev["kind"] == "zone" else entity_id,
            "kind": self.checker.res.kind_of(entity_id),
        }

    def for_entities(self, entity_ids: list[str]) -> dict[str, dict[str, list[str]]]:
        """The same for many devices at once, without history: rule ids and automation entity ids."""
        autos: dict[str, list[str]] = {}
        for a in self.automations():
            for u in a["uses"]:
                autos.setdefault(u["entity_id"], []).append(a["entity_id"])
        return {e: {**self._uses(e), "automations": sorted(set(autos.get(e, [])))} for e in dict.fromkeys(entity_ids)}

    def _uses(self, entity_id: str) -> dict[str, list[str]]:
        dev = self.inventory.devices.get(entity_id)
        out: dict[str, list[str]] = {"starts": [], "checks": [], "switches": []}
        for r in self.rules():
            for section, key in (("when", "starts"), ("and", "checks"), ("only", "checks"), ("then", "switches"), ("else", "switches")):
                for c in [x for y in r.get(section, []) for x in logic.leaves(y)]:
                    subj = c["subject"]
                    hit = subj in (entity_id, f"zone:{entity_id}")
                    if not hit and subj.startswith("group:"):
                        hit = entity_id in (self.group(subj[6:]) or {}).get("members", [])
                    if not hit and dev and subj.startswith(("any:", "all:")):
                        m = re.match(r"^(any|all):([a-z_]+)(?:@([a-z0-9_]+))?$", subj)
                        hit = bool(m and m.group(2) == dev["kind"] and (not m.group(3) or m.group(3) == "same" or m.group(3) == dev["room"]))
                    if hit and r["id"] not in out[key]:
                        out[key].append(r["id"])
        return out
