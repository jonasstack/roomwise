"""Object alarms ("Weitere Alarme"): small alarm systems besides the house alarm.

A bike, a car, the garage, the garden shed, a second building: each object has its own sensors (vibration,
contact, motion, a car's own alarm, a lock, a GPS tracker that leaves its place while armed), is armed and
disarmed on its own (by hand, together with the house alarm, or by the house mode) and has its own reaction
(message with buttons to chosen persons, optional sirens, lights and camera picture).

States: disarmed → armed → pending (only with an entry delay) → triggered. Disarming uses the confirmation of
the house alarm (PIN with its lockout, Face ID / Touch ID) unless the object is set to need none. The house alarm
(alarm.py) is not changed by any of this; its helpers (service calls, PIN check, links) are reused.
Entities: one alarm_control_panel per object (alarm_control_panel.py). Event: house_rules_object_alarm.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, STATE_ON
from homeassistant.core import CALLBACK_TYPE, Context, CoreState, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.util.location import distance

from .alarm import DASHBOARD_PATH, NOT_REAL, SETTLE_SECONDS
from .const import MODES
from .i18n import tr
from .webauthn import WebAuthnError

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

# i18n: complete (texts in texts/objects.json)

EVENT = "house_rules_object_alarm"
# own prefix: the house alarm reacts to every action starting with "HR_ALARM_"
ACTION_PREFIX = "HR_OBJ_"
# kind → icon (the default name is the text obj.kind_<kind>)
OBJECT_KINDS: dict[str, str] = {
    "bike": "mdi:bicycle",
    "car": "mdi:car",
    "garage": "mdi:garage",
    "shed": "mdi:greenhouse",
    "building": "mdi:home-city-outline",
    "other": "mdi:shield-outline",
}
ARMED = ("armed", "pending", "triggered")
# states of sensors that report something (vibration sensors as "sensor" with the last action, car alarms …)
REPORTS = {"vibration", "vibrate", "vibrating", "tilt", "drop", "triggered", "alarm", "tamper", "tampered", "motion", "detected", "moving", "shock", "on", "open"}
MOVE_METERS = 150  # a tracker that moves this far while armed sets it off (GPS jitter stays below)
OID = re.compile(r"^o_[a-z0-9]{4,12}$")


def default_object(kind: str = "other", where: Any = None) -> dict[str, Any]:
    kind = kind if kind in OBJECT_KINDS else "other"
    return {
        "id": "",
        "name": tr(where, f"obj.kind_{kind}"),
        "kind": kind,
        "icon": OBJECT_KINDS[kind],
        "sensors": [],  # vibration, contact, motion, car alarm, lock, GPS tracker …
        "delay": 0,  # s until the alarm after a sensor reported (time to disarm, e.g. garage door)
        "confirm": True,  # disarming needs the house alarm's confirmation (PIN / Face ID), if it has one
        "auto": {"with_alarm": False, "arm_on": [], "disarm_on": []},  # with the house alarm; house modes
        "notify": {"persons": "everyone", "critical": True},
        "sirens": [],
        "lights": [],
        "camera": "",
        "duration": 120,  # s the sirens sound
    }


class ObjectAlarms:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.state: dict[str, dict[str, Any]] = {}  # id → {state, since, cause, by_auto, until, pos}
        self.settling = False
        self._unsub: list[Callable[[], None]] = []
        self._sensor_unsub: CALLBACK_TYPE | None = None
        self._settle_unsub: CALLBACK_TYPE | None = None
        self._timers: dict[str, CALLBACK_TYPE] = {}
        self._silence: dict[str, CALLBACK_TYPE] = {}
        self._listeners: list[Callable[[str | None], None]] = []
        self._house_state = "disarmed"

    # ------------------------------------------------------------------ config
    @property
    def objects(self) -> list[dict[str, Any]]:
        objs = self.core.data.setdefault("object_alarms", [])
        for o in objs:
            d = default_object(o.get("kind", "other"), self.core)
            for k, v in d.items():
                o.setdefault(k, v)
                if isinstance(v, dict) and isinstance(o[k], dict):
                    for kk, vv in v.items():
                        o[k].setdefault(kk, vv)
        return objs

    def get(self, oid: str) -> dict[str, Any] | None:
        return next((o for o in self.objects if o["id"] == oid), None)

    def save(self, raw: dict[str, Any]) -> dict[str, Any]:
        """Creates or changes one object alarm. Raises ValueError for what cannot be saved."""
        oid = str(raw.get("id") or "")
        obj = self.get(oid) if oid else None
        if obj is None:
            if len(self.objects) >= 20:
                raise ValueError(tr(self.core, "obj.err_max"))
            obj = default_object(str(raw.get("kind") or "other"), self.core)
            obj["id"] = oid if OID.match(oid) else "o_" + uuid.uuid4().hex[:6]
            self.objects.append(obj)
        ent = lambda v, prefixes=(): [e for e in v if isinstance(e, str) and "." in e and (not prefixes or e.startswith(prefixes))][:30] if isinstance(v, list) else []  # noqa: E731
        if raw.get("kind") in OBJECT_KINDS:
            obj["kind"] = raw["kind"]
        if "name" in raw:
            name = str(raw.get("name") or "").strip()[:40]
            if not name:
                raise ValueError(tr(self.core, "obj.err_name"))
            obj["name"] = name
        if isinstance(raw.get("icon"), str) and re.match(r"^mdi:[a-z0-9-]{1,60}$", raw["icon"]):
            obj["icon"] = raw["icon"]
        if "sensors" in raw:
            obj["sensors"] = ent(raw["sensors"])
        if "sirens" in raw:
            obj["sirens"] = ent(raw["sirens"], ("siren.", "switch.", "input_boolean."))
        if "lights" in raw:
            obj["lights"] = ent(raw["lights"], ("light.",))
        if "camera" in raw:
            obj["camera"] = raw["camera"] if isinstance(raw["camera"], str) and raw["camera"].startswith("camera.") else ""
        if isinstance(raw.get("confirm"), bool):
            obj["confirm"] = raw["confirm"]
        for key, hi in (("delay", 300), ("duration", 1800)):
            if isinstance(raw.get(key), (int, float)) and not isinstance(raw[key], bool):
                obj[key] = int(max(0 if key == "delay" else 10, min(hi, raw[key])))
        if isinstance(a := raw.get("auto"), dict):
            if isinstance(a.get("with_alarm"), bool):
                obj["auto"]["with_alarm"] = a["with_alarm"]
            for key in ("arm_on", "disarm_on"):
                if isinstance(a.get(key), list):
                    obj["auto"][key] = [m for m in a[key] if m in MODES]
        if isinstance(n := raw.get("notify"), dict):
            p = n.get("persons")
            if p == "everyone" or isinstance(p, list):
                obj["notify"]["persons"] = p if p == "everyone" else [str(x) for x in p][:20]
            if isinstance(n.get("critical"), bool):
                obj["notify"]["critical"] = n["critical"]
        self.core.save()
        self._watch()
        self._changed(obj["id"])
        self._entities()
        return obj

    async def delete(self, oid: str) -> None:
        if self.state.get(oid, {}).get("state") in ARMED:
            await self.disarm(oid, by=tr(self.core, "obj.by_deleted"))
        self.core.data["object_alarms"] = [o for o in self.objects if o["id"] != oid]
        self.state.pop(oid, None)
        self._persist()
        self._watch()
        self._changed(None)
        self._entities()

    # ------------------------------------------------------------------ lifecycle
    def start(self, settle: bool = True) -> None:
        self.stop()
        rt = self.core.data.setdefault("runtime", {}).get("objects") or {}
        self.state = {o["id"]: dict(rt.get(o["id"]) or {"state": "disarmed", "since": time.time()}) for o in self.objects}
        for oid, s in self.state.items():
            if s.get("state") == "pending":
                # a restart during the entry delay: the delay goes on (at least 30 s)
                left = max(30.0, float(s.get("until") or 0) - time.time())
                s["until"] = time.time() + left
                self._timers[oid] = async_call_later(self.hass, left, callback(lambda _n, oid=oid: self.hass.async_create_task(self.trigger(oid, self.state[oid].get("cause")))))
        self._house_state = self.core.alarm.state
        self._unsub.append(self.core.alarm.add_listener(self._house_alarm))
        self._unsub.append(self.core.engine.on_mode(self._mode_changed))
        self._unsub.append(self.hass.bus.async_listen("mobile_app_notification_action", self._action))
        if settle:
            # like the house alarm: right after a start, sensors report odd things for a while
            self.settling = True

            @callback
            def later(_e: Any = None) -> None:
                self._settle_unsub = async_call_later(self.hass, SETTLE_SECONDS, self._settled)

            if self.hass.state is CoreState.running:
                later()
            else:
                self._settle_unsub = self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, later)
        self._watch()
        self._changed(None)

    @callback
    def _settled(self, _now: Any = None) -> None:
        self._settle_unsub = None
        self.settling = False
        self._changed(None)

    def stop(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()
        for u in (self._sensor_unsub, self._settle_unsub, *self._timers.values(), *self._silence.values()):
            if u:
                u()
        self._sensor_unsub = self._settle_unsub = None
        self._timers.clear()
        self._silence.clear()

    def _watch(self) -> None:
        if self._sensor_unsub:
            self._sensor_unsub()
            self._sensor_unsub = None
        sensors = {e for o in self.objects for e in o["sensors"]}
        if sensors and self._unsub:
            self._sensor_unsub = async_track_state_change_event(self.hass, list(sensors), self._sensor)

    def add_listener(self, cb: Callable[[str | None], None]) -> Callable[[], None]:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb) if cb in self._listeners else None

    def _changed(self, oid: str | None) -> None:
        for cb in list(self._listeners):
            cb(oid)
        self.core.push("objects")

    def _entities(self) -> None:
        hook = self.core.entity_hooks.get("objects")
        if hook:
            hook()

    def _persist(self) -> None:
        self.core.data.setdefault("runtime", {})["objects"] = {k: v for k, v in self.state.items() if self.get(k)}
        self.core.save()

    def _set(self, oid: str, state: str, **extra: Any) -> None:
        s = self.state.setdefault(oid, {})
        s.update({"state": state, "since": time.time(), "until": None, **extra})
        if state == "disarmed":
            s.update({"cause": None, "by_auto": False, "pos": {}})
        self._persist()
        self.hass.bus.async_fire(EVENT, {"id": oid, "state": state, "cause": s.get("cause")})
        self._changed(oid)

    # ------------------------------------------------------------------ view
    def _name(self, eid: str | None) -> str:
        return self.core.alarm._name(eid)  # noqa: SLF001 — the same names as the house alarm

    def view(self) -> list[dict[str, Any]]:
        out = []
        for o in self.objects:
            s = self.state.get(o["id"]) or {"state": "disarmed"}
            st = s.get("state", "disarmed")
            out.append(
                {
                    **o,
                    "state": st,
                    "label": tr(self.core, f"obj.state_{st}"),
                    "since": s.get("since"),
                    "until": s.get("until"),
                    "cause": s.get("cause"),
                    "cause_name": self._name(s.get("cause")) if s.get("cause") else None,
                    "by_auto": bool(s.get("by_auto")),
                    "open": [e for e in o["sensors"] if self._is_open(e)],
                    "settling": self.settling,  # start-up phase: no sensor counts yet
                }
            )
        return out

    def _is_open(self, eid: str) -> bool:
        st = self.hass.states.get(eid)
        if not st:
            return False
        if eid.startswith("lock."):
            return st.state in ("unlocked", "open", "opening")
        return eid.split(".")[0] in ("binary_sensor", "input_boolean") and st.state == STATE_ON

    # ------------------------------------------------------------------ arming and disarming
    async def arm(self, oid: str, *, by: str = "", auto: bool = False) -> dict[str, Any]:
        obj = self.get(oid)
        if not obj:
            return {"ok": False, "error": "unknown"}
        if not obj["sensors"]:
            return {"ok": False, "error": "no_sensors"}
        pos = {}
        for e in obj["sensors"]:
            st = self.hass.states.get(e)
            if st and e.startswith("device_tracker."):
                pos[e] = {"zone": st.state, "lat": st.attributes.get("latitude"), "lon": st.attributes.get("longitude")}
        self._cancel(oid)
        self._set(oid, "armed", cause=None, by_auto=auto, pos=pos)
        self.core.history.add("alarm", tr(self.core, "obj.h_armed", name=obj["name"]), tr(self.core, "obj.h_by", by=by or tr(self.core, "obj.by_hand")))
        return {"ok": True}

    async def disarm(self, oid: str, *, by: str = "") -> bool:
        """Without a check: callers confirmed (disarm_confirmed) or act by themselves (automatic)."""
        obj = self.get(oid)
        s = self.state.get(oid) or {}
        if not obj or s.get("state", "disarmed") == "disarmed":
            return False
        was = s.get("state")
        self._cancel(oid)
        if was == "triggered":
            await self._sirens(obj, False)
        self._set(oid, "disarmed")
        self.core.history.add("alarm", tr(self.core, "obj.h_disarmed", name=obj["name"]), tr(self.core, "obj.h_by", by=by or tr(self.core, "obj.by_hand")))
        await self._clear(obj)
        return True

    async def stand_down(self, oid: str, *, by: str = "") -> bool:
        """Ends the running alarm, the object stays armed."""
        obj = self.get(oid)
        s = self.state.get(oid) or {}
        if not obj or s.get("state") not in ("pending", "triggered"):
            return False
        self._cancel(oid)
        await self._sirens(obj, False)
        self._set(oid, "armed", cause=None)
        self.core.history.add("alarm", tr(self.core, "obj.h_stood_down", name=obj["name"]), tr(self.core, "obj.h_by", by=by or tr(self.core, "obj.by_hand")))
        await self._clear(obj)
        return True

    async def silence(self, oid: str, *, by: str = "") -> None:
        obj = self.get(oid)
        if not obj:
            return
        if t := self._silence.pop(oid, None):
            t()
        await self._sirens(obj, False)
        self.core.history.add("alarm", tr(self.core, "obj.h_silenced", name=obj["name"]), tr(self.core, "obj.h_silenced_why", by=by or tr(self.core, "obj.by_hand")))

    async def disarm_confirmed(
        self, oid: str, *, who: str, by: str, code: str | None = None, webauthn: dict[str, Any] | None = None, rp_id: str = "", only_alarm: bool = False
    ) -> dict[str, Any]:
        """Disarm (only_alarm: end the running alarm, stay armed) with the house alarm's confirmation: same PIN,
        same lockout per user, same passkeys. {ok, error, retry_in?}"""
        obj = self.get(oid)
        if not obj:
            return {"ok": False, "error": "unknown"}
        alarm = self.core.alarm
        await alarm.check_reset_file()
        confirm = alarm.config.get("confirm", "none") if obj.get("confirm", True) else "none"
        act = self.stand_down if only_alarm else self.disarm
        if confirm == "device" and webauthn:
            try:
                alarm.verify_device(webauthn, rp_id)
            except (WebAuthnError, KeyError, ValueError) as err:
                return {"ok": False, "error": str(err) or tr(self.core, "obj.failed")}
            await act(oid, by=tr(self.core, "obj.by_device", by=by))
            return {"ok": True, "error": None}
        if confirm in ("pin", "device"):
            if confirm == "device" and not alarm.config.get("code_hash") and not code:
                return {"ok": False, "error": "needs_device"}
            err = await alarm.verify_code(code, who)
            if err:
                locked = alarm._locked(who)  # noqa: SLF001
                return {"ok": False, "error": err, **({"retry_in": int(locked) + 1} if err == "locked" or locked else {})}
        await act(oid, by=by)
        return {"ok": True, "error": None}

    def needs_code(self, oid: str) -> bool:
        obj = self.get(oid)
        cfg = self.core.alarm.config
        return bool(obj and obj.get("confirm", True) and cfg.get("code_hash") and cfg.get("confirm") in ("pin", "device"))

    def _cancel(self, oid: str) -> None:
        for timers in (self._timers, self._silence):
            if t := timers.pop(oid, None):
                t()

    # ------------------------------------------------------------------ sensors
    def _fired(self, oid: str, eid: str, old: Any, new: Any) -> bool:
        """Did this change report something while armed?"""
        domain = eid.split(".")[0]
        if domain == "device_tracker":
            pos = (self.state.get(oid) or {}).get("pos", {}).get(eid) or {}
            if pos.get("zone") not in (None, *NOT_REAL, "not_home") and new.state != pos.get("zone"):
                return True  # left the place where it was armed
            lat, lon = new.attributes.get("latitude"), new.attributes.get("longitude")
            if None not in (lat, lon, pos.get("lat"), pos.get("lon")):
                d = distance(pos["lat"], pos["lon"], lat, lon)
                return d is not None and d > MOVE_METERS
            return False
        if domain == "lock":
            return new.state in ("unlocked", "open", "opening") and old.state not in ("unlocked", "open", "opening")
        if domain == "alarm_control_panel":
            return new.state == "triggered" and old.state != "triggered"
        if domain == "event":
            return new.state != old.state  # a new event (timestamp)
        if domain in ("sensor", "select", "input_select", "input_text"):
            return new.state.lower() in REPORTS and new.state != old.state
        return new.state == STATE_ON and old.state != STATE_ON

    @callback
    def _sensor(self, event: Event[EventStateChangedData]) -> None:
        new, old = event.data["new_state"], event.data["old_state"]
        if not new or not old or new.state in NOT_REAL or old.state in NOT_REAL or self.settling:
            return
        eid = new.entity_id
        for o in self.objects:
            s = self.state.get(o["id"]) or {}
            if eid not in o["sensors"] or s.get("state") != "armed":
                continue
            if not self._fired(o["id"], eid, old, new):
                continue
            if self.core.cleaning.ignores(eid, new):
                self.core.cleaning.note(eid, tr(self.core, "obj.no_alarm"))
                continue
            oid = o["id"]
            if o["delay"]:
                self._set(oid, "pending", cause=eid, until=time.time() + o["delay"])
                self.hass.async_create_task(self._notify(o, tr(self.core, "obj.n_pending", sensor=self._name(eid), seconds=o["delay"]), tr(self.core, "obj.n_pending_title"), critical=False, buttons=["disarm"]))
                self._timers[oid] = async_call_later(self.hass, o["delay"], callback(lambda _n, oid=oid, eid=eid: self.hass.async_create_task(self.trigger(oid, eid))))
            else:
                self.hass.async_create_task(self.trigger(oid, eid))

    async def trigger(self, oid: str, eid: str | None = None, *, test: bool = False) -> None:
        obj = self.get(oid)
        if not obj:
            return
        self._timers.pop(oid, None)
        s = self.state.get(oid) or {}
        if not test and s.get("state") not in ("armed", "pending"):
            return
        cause = self._name(eid) if eid else tr(self.core, "obj.cause_manual")
        if not test:
            self._set(oid, "triggered", cause=eid)
            self.core.history.add("alarm", tr(self.core, "obj.h_triggered", name=obj["name"]), tr(self.core, "obj.h_by", by=cause), entity_id=eid)
        title = tr(self.core, "obj.n_test_title" if test else "obj.n_title", name=obj["name"])
        await self._notify(obj, cause, title, critical=obj["notify"].get("critical", True) and not test, buttons=["disarm", "silence", "camera"])
        if test:
            return
        ctx = self.core.history.new_context("alarm")
        await self._sirens(obj, True)
        if obj["lights"]:
            await self.core.alarm._call("light", "turn_on", obj["lights"], {"brightness_pct": 100}, ctx)  # noqa: SLF001
        if obj["sirens"]:
            self._silence[oid] = async_call_later(self.hass, obj["duration"], callback(lambda _n: self.hass.async_create_task(self.silence(oid, by=tr(self.core, "obj.by_duration")))))

    async def _sirens(self, obj: dict[str, Any], on: bool) -> None:
        for e in obj["sirens"]:
            domain = e.split(".")[0]
            await self.core.alarm._call("siren" if domain == "siren" else "homeassistant", "turn_on" if on else "turn_off", e, {}, None)  # noqa: SLF001

    # ------------------------------------------------------------------ messages (like the house alarm's)
    def _phones(self, obj: dict[str, Any], user_id: str | None = None) -> list[str]:
        persons = list(self.core.inventory.persons.values())
        if user_id:
            mine = [ph for p in persons if (st := self.hass.states.get(p["entity_id"])) and st.attributes.get("user_id") == user_id for ph in p["phones"]]
            if mine:
                return mine
        sel = obj["notify"].get("persons", "everyone")
        return [ph for p in persons if sel == "everyone" or p["id"] in sel for ph in p["phones"]]

    def _tag(self, obj: dict[str, Any]) -> str:
        return f"house_rules_object_{obj['id']}"

    async def _send(self, obj: dict[str, Any], title: str, message: str, data: dict[str, Any], phones: list[str]) -> None:
        ctx = self.core.history.new_context("alarm")
        for service in phones:
            try:
                await self.hass.services.async_call("notify", service, {"title": title, "message": message, "data": data}, blocking=True, context=ctx)
            except Exception as err:  # noqa: BLE001 — one phone must not stop the others
                _LOGGER.warning("Hausregeln Objekt-Alarm: Nachricht an %s: %s", service, err)

    async def _notify(self, obj: dict[str, Any], message: str, title: str, *, critical: bool, buttons: list[str]) -> None:
        data: dict[str, Any] = {"tag": self._tag(obj), "group": "house_rules_alarm", "url": DASHBOARD_PATH, "clickAction": DASHBOARD_PATH}
        if critical:
            data.update({"push": {"interruption-level": "critical", "sound": {"name": "default", "critical": 1, "volume": 1.0}}, "ttl": 0, "priority": "high", "channel": "alarm_stream"})
        cam = obj.get("camera")
        if cam:
            data["entity_id"] = cam  # iOS: live camera in the message
            data["image"] = f"/api/camera_proxy/{cam}"  # Android: picture
        actions = []
        for b in buttons:
            if b == "disarm" and self.core.alarm.config.get("notify_disarm", True):
                actions.append({"action": f"{ACTION_PREFIX}DISARM:{obj['id']}", "title": tr(self.core, "obj.b_disarm"), "authenticationRequired": True, "destructive": True})
            elif b == "silence" and obj["sirens"]:
                actions.append({"action": f"{ACTION_PREFIX}SILENCE:{obj['id']}", "title": tr(self.core, "obj.b_silence")})
            elif b == "camera" and cam:
                actions.append({"action": "URI", "title": tr(self.core, "obj.b_camera"), "uri": DASHBOARD_PATH})
        if actions:
            data["actions"] = actions[:3]
        await self._send(obj, title, message, data, self._phones(obj))

    async def _ask_how(self, obj: dict[str, Any], user_id: str | None) -> None:
        """After "Alarm aus": like the house alarm, a second message asks whether only this alarm stops or the object is disarmed."""
        s = self.state.get(obj["id"]) or {}
        if s.get("state", "disarmed") == "disarmed":
            return
        running = s.get("state") in ("pending", "triggered")
        data = {
            "tag": self._tag(obj),
            "group": "house_rules_alarm",
            "url": DASHBOARD_PATH,
            "clickAction": DASHBOARD_PATH,
            "push": {"interruption-level": "time-sensitive"},
            "actions": [
                {"action": f"{ACTION_PREFIX}STOP:{obj['id']}", "title": tr(self.core, "obj.b_stop"), "authenticationRequired": True},
                {"action": f"{ACTION_PREFIX}DISARMALL:{obj['id']}", "title": tr(self.core, "obj.b_disarm_all"), "authenticationRequired": True, "destructive": True},
            ],
        }
        message = tr(self.core, "obj.ask_running" if running else "obj.ask_over", name=obj["name"])
        await self._send(obj, tr(self.core, "obj.ask_title"), message, data, self._phones(obj, user_id))

    async def _clear(self, obj: dict[str, Any]) -> None:
        for service in sorted({ph for p in self.core.inventory.persons.values() for ph in p["phones"]}):
            try:
                await self.hass.services.async_call("notify", service, {"message": "clear_notification", "data": {"tag": self._tag(obj)}}, blocking=True)
            except Exception:  # noqa: BLE001
                _LOGGER.debug("clear_notification %s failed", service)

    @callback
    def _action(self, event: Event) -> None:
        action = str(event.data.get("action") or "")
        if not action.startswith(ACTION_PREFIX) or ":" not in action:
            return
        what, oid = action[len(ACTION_PREFIX) :].split(":", 1)
        obj = self.get(oid)
        if obj and what in ("DISARM", "STOP", "DISARMALL", "SILENCE"):
            self.hass.async_create_task(self._button(obj, what, event.context.user_id))

    async def _may_use(self, obj: dict[str, Any], user_id: str | None) -> bool:
        """Any phone of the companion app can fire the button event with any content: only an admin or a person
        whose phones get this alarm's messages may act (like the house alarm)."""
        if not user_id:
            return False
        user = await self.hass.auth.async_get_user(user_id)
        if user is None or not user.is_active:
            return False
        if user.is_admin:
            return True
        phones = set(self._phones(obj))
        return any(
            (st := self.hass.states.get(p["entity_id"])) is not None and st.attributes.get("user_id") == user_id and phones.intersection(p["phones"])
            for p in self.core.inventory.persons.values()
        )

    async def _button(self, obj: dict[str, Any], what: str, user_id: str | None) -> None:
        oid = obj["id"]
        if not await self._may_use(obj, user_id):
            self.core.history.add("alarm", tr(self.core, "obj.h_button_refused", name=obj["name"]), tr(self.core, "obj.h_button_refused_why"))
            _LOGGER.warning("Hausregeln object alarm: button %s from user %s ignored (not a recipient)", what, user_id)
            return
        by = tr(self.core, "obj.by_button")
        if what == "SILENCE":
            await self.silence(oid, by=by)
            return
        if not self.core.alarm.config.get("notify_disarm", True):
            self.core.history.add("alarm", tr(self.core, "obj.h_disarm_refused", name=obj["name"]), tr(self.core, "obj.h_disarm_refused_why"))
            return
        # the phone itself asked for Face ID / its code before sending this (authenticationRequired)
        if what == "DISARM":
            await self._ask_how(obj, user_id)
        elif what == "STOP":
            await self.stand_down(oid, by=by)
        else:
            await self.disarm(oid, by=by)

    # ------------------------------------------------------------------ automatic: with the house alarm, by house mode
    def _house_alarm(self, state: str) -> None:
        before, self._house_state = self._house_state, state
        if state == before:
            return
        armed_now = state.startswith("armed_")
        for o in self.objects:
            if not o["auto"].get("with_alarm"):
                continue
            s = self.state.get(o["id"]) or {}
            if armed_now and not before.startswith("armed_") and before not in ("pending", "triggered") and s.get("state", "disarmed") == "disarmed" and o["sensors"]:
                self.hass.async_create_task(self.arm(o["id"], by=tr(self.core, "obj.by_with_alarm"), auto=True))
            elif state == "disarmed" and s.get("state") in ARMED and s.get("by_auto"):
                self.hass.async_create_task(self.disarm(o["id"], by=tr(self.core, "obj.by_alarm_off")))

    def _mode_changed(self, house_mode: str, _ctx: Context | None) -> None:
        label = tr(self.core, f"mode.{house_mode}")
        for o in self.objects:
            s = self.state.get(o["id"]) or {}
            if house_mode in o["auto"].get("disarm_on", []) and s.get("state") in ARMED and s.get("by_auto"):
                self.hass.async_create_task(self.disarm(o["id"], by=tr(self.core, "obj.by_mode", mode=label)))
            elif house_mode in o["auto"].get("arm_on", []) and s.get("state", "disarmed") == "disarmed" and o["sensors"]:
                self.hass.async_create_task(self.arm(o["id"], by=tr(self.core, "obj.by_mode", mode=label), auto=True))
