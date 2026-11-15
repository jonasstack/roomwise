"""Doing things: the "then" part of a rule, plus remembering and restoring device states."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import TYPE_CHECKING, Any

from homeassistant.const import ATTR_ENTITY_ID, STATE_OFF, STATE_ON, STATE_UNAVAILABLE
from homeassistant.core import Context, Event, HomeAssistant, State, callback

from .conditions import Resolver
from .i18n import quote, tr
from . import logic
from .lightspec import for_light, matches, power_up, service_data
from .vocab import seconds

if TYPE_CHECKING:
    from .core import HouseRules

# i18n: complete

_LOGGER = logging.getLogger(__name__)

# colour values as stored in rules (German words, the vocabulary's default) and their English names
COLORS: dict[str, dict[str, Any]] = {
    "warmweiß": {"color_temp_kelvin": 2700},  # i18n-ignore
    "neutralweiß": {"color_temp_kelvin": 4000},  # i18n-ignore
    "kaltweiß": {"color_temp_kelvin": 6000},  # i18n-ignore
    "rot": {"rgb_color": [255, 40, 30]},
    "orange": {"rgb_color": [255, 140, 20]},
    "grün": {"rgb_color": [40, 220, 70]},  # i18n-ignore
    "blau": {"rgb_color": [30, 90, 255]},
    "lila": {"rgb_color": [170, 60, 255]},
}
COLORS.update(
    {
        "warm white": COLORS["warmweiß"],  # i18n-ignore
        "neutral white": COLORS["neutralweiß"],  # i18n-ignore
        "cool white": COLORS["kaltweiß"],  # i18n-ignore
        "red": COLORS["rot"],
        "green": COLORS["grün"],  # i18n-ignore
        "blue": COLORS["blau"],
        "purple": COLORS["lila"],
    }
)

NIGHT_LIGHT = {"brightness_pct": 10, "color_temp_kelvin": 2200}
# seconds between "on in the new colour, very dim" and "up to the brightness" (call_together)
POWER_UP_PAUSE = 0.3


class StopRun(Exception):
    """A step decided that the rest of the rule should not run (e.g. "Nein" on a question)."""


async def call_together(hass: HomeAssistant, calls: list[tuple[str, str, str, dict[str, Any]]], ctx: Context | None) -> list[tuple[list[str], BaseException | None]]:
    """Switches devices at the same time instead of one after another: calls (domain, service, entity, data) with the
    same service and the same settings become ONE service call for all their entities (Zigbee/Hue groups and the
    integrations then switch them together), the different ones run side by side. A device that fails neither delays
    nor stops the others. A lamp that is off and gets a colour first goes on in that colour, very dim and without a
    fade, and only then to its brightness (lightspec.power_up: no white flash before the colour) – all in the same
    context, so it stays one command. Returns (entities, error or None) for each call made."""
    first: list[tuple[str, str, str, dict[str, Any]]] = []
    second: list[tuple[str, str, str, dict[str, Any]]] = []
    before: dict[str, str] = {}  # the lamps' context before the first step (who set them last)
    for domain, service, entity_id, data in calls:
        if domain == "light" and service == "turn_on":
            st = hass.states.get(entity_id)
            pre, data = power_up(st.state if st else None, st.attributes if st else None, data)
            if pre is not None:
                first.append((domain, service, entity_id, pre))
                before[entity_id] = st.context.id if st else ""
        second.append((domain, service, entity_id, data))

    def grouped(cs: list[tuple[str, str, str, dict[str, Any]]]) -> list[tuple[tuple[str, str, str], list[str], dict[str, Any]]]:
        groups: dict[tuple[str, str, str], tuple[list[str], dict[str, Any]]] = {}
        for domain, service, entity_id, data in cs:
            ids = groups.setdefault((domain, service, json.dumps(data, sort_keys=True, default=str)), ([], data))[0]
            if entity_id not in ids:
                ids.append(entity_id)
        return [(key, ids, data) for key, (ids, data) in groups.items()]

    async def one(domain: str, service: str, ids: list[str], data: dict[str, Any]) -> None:
        await hass.services.async_call(domain, service, {ATTR_ENTITY_ID: ids if len(ids) > 1 else ids[0], **data}, blocking=True, context=ctx)

    out: list[tuple[list[str], BaseException | None]] = []
    failed: set[str] = set()
    if first:
        items = grouped(first)
        results = await asyncio.gather(*(one(key[0], key[1], ids, data) for key, ids, data in items), return_exceptions=True)
        for (_key, ids, _data), r in zip(items, results, strict=True):
            if isinstance(r, BaseException):
                out.append((ids, r))
                failed.update(ids)
        await asyncio.sleep(POWER_UP_PAUSE)  # the lamps take the colour before the fade starts
        for _d, _s, entity_id, _data in first:
            # someone else set the lamp in the meantime (a button, a person): that is newer, no second step
            st = hass.states.get(entity_id)
            if st and st.context.id != before.get(entity_id) and (ctx is None or st.context.id != ctx.id):
                failed.add(entity_id)
    items = grouped([c for c in second if c[2] not in failed])
    results = await asyncio.gather(*(one(key[0], key[1], ids, data) for key, ids, data in items), return_exceptions=True)
    out += [(ids, r if isinstance(r, BaseException) else None) for (_key, ids, _data), r in zip(items, results, strict=True)]
    return out


def snapshot(state: State | None) -> dict[str, Any] | None:
    """What is needed to put a device back the way it was."""
    if state is None:
        return None
    domain = state.domain
    a = state.attributes
    snap: dict[str, Any] = {"state": state.state}
    if domain == "light" and state.state == STATE_ON:
        snap["brightness"] = a.get("brightness")
        mode = a.get("color_mode")
        if mode == "color_temp" and a.get("color_temp_kelvin"):
            snap["color_temp_kelvin"] = a.get("color_temp_kelvin")
        elif a.get("hs_color") and mode not in (None, "brightness", "onoff", "color_temp"):
            snap["hs_color"] = a.get("hs_color")
    elif domain == "climate":
        snap["temperature"] = a.get("temperature")
        snap["preset_mode"] = a.get("preset_mode")
    elif domain == "cover":
        snap["position"] = a.get("current_position")
    elif domain == "media_player":
        snap["volume"] = a.get("volume_level")
    return snap


class Executor:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.res = Resolver(core)
        # pending "for 5 minutes" reverts: (rule_id, entity) → (timer handle, snapshot)
        self._reverts: dict[tuple[str, str], tuple[asyncio.TimerHandle, dict[str, Any] | None]] = {}

    # ------------------------------------------------------------------ restore
    async def restore(self, entity_id: str, snap: dict[str, Any] | None, ctx: Context) -> None:
        if not snap:
            return
        st = self.hass.states.get(entity_id)
        if not st:
            return
        domain = entity_id.split(".")[0]
        call = self._call
        try:
            if domain == "light":
                if light := self._light_back(entity_id, snap):
                    await call(*light, ctx)
            elif domain in ("switch", "fan", "input_boolean", "siren", "humidifier", "automation", "camera"):
                if snap["state"] in (STATE_ON, STATE_OFF) and st.state != snap["state"]:
                    await call("homeassistant", "turn_on" if snap["state"] == STATE_ON else "turn_off", entity_id, {}, ctx)
            elif domain == "climate":
                if snap["state"] and st.state != snap["state"]:
                    await call("climate", "set_hvac_mode", entity_id, {"hvac_mode": snap["state"]}, ctx)
                if snap.get("temperature") is not None and snap["state"] != STATE_OFF:
                    await call("climate", "set_temperature", entity_id, {"temperature": snap["temperature"]}, ctx)
            elif domain == "cover":
                if snap.get("position") is not None:
                    await call("cover", "set_cover_position", entity_id, {"position": snap["position"]}, ctx)
                elif snap["state"] in ("open", "closed"):
                    await call("cover", "open_cover" if snap["state"] == "open" else "close_cover", entity_id, {}, ctx)
            elif domain == "media_player":
                if snap["state"] == "playing" and st.state != "playing":
                    await call("media_player", "media_play", entity_id, {}, ctx)
                if snap.get("volume") is not None and st.attributes.get("volume_level") != snap["volume"]:
                    await call("media_player", "volume_set", entity_id, {"volume_level": snap["volume"]}, ctx)
            elif domain in ("select", "input_select") and snap["state"] and st.state != snap["state"]:
                await call(domain, "select_option", entity_id, {"option": snap["state"]}, ctx)
            elif domain in ("number", "input_number") and snap["state"] and st.state != snap["state"]:
                await call(domain, "set_value", entity_id, {"value": float(snap["state"])}, ctx)
        except Exception as err:  # noqa: BLE001 — a device that fails must not stop the others
            _LOGGER.warning("House rules: %s could not be put back: %s", entity_id, err)

    def _light_back(self, entity_id: str, snap: dict[str, Any]) -> tuple[str, str, str, dict[str, Any]] | None:
        """The call that puts a lamp back (None: it already is)."""
        st = self.hass.states.get(entity_id)
        if snap["state"] == STATE_OFF:
            return ("light", "turn_off", entity_id, {}) if st and st.state != STATE_OFF else None
        return ("light", "turn_on", entity_id, {k: snap[k] for k in ("brightness", "color_temp_kelvin", "hs_color") if snap.get(k) is not None})

    async def restore_many(self, snaps: dict[str, dict[str, Any] | None], ctx: Context) -> None:
        """Puts several devices back at the same time: lamps with the same settings in one call, the rest side by side."""
        lights = [c for e, s in snaps.items() if s and e.startswith("light.") and self.hass.states.get(e) and (c := self._light_back(e, s))]
        for ids, err in await call_together(self.hass, lights, ctx):
            if err:
                _LOGGER.warning("House rules: %s could not be put back: %s", ", ".join(ids), err)
        await asyncio.gather(*(self.restore(e, s, ctx) for e, s in snaps.items() if not e.startswith("light.")))

    async def _call(self, domain: str, service: str, entity_id: str | list[str], data: dict[str, Any], ctx: Context) -> None:
        await self.hass.services.async_call(domain, service, {ATTR_ENTITY_ID: entity_id, **data}, blocking=True, context=ctx)

    # ------------------------------------------------------------------ targets
    def targets(self, rule: dict[str, Any], clause: dict[str, Any], room: str | None, scope: str | None) -> list[str]:
        ents = self.res.entities(clause["subject"], room, scope)
        pause = rule.get("options", {}).get("manual_pause", "1h")
        if not pause:
            return ents
        out = []
        for e in ents:
            manual = self.core.history.manual.get(e)
            if manual:
                if pause == "room_empty":
                    r = self.core.inventory.room_of(e)
                    if r and self.core.room_tracker.occupied(r) and self.core.room_tracker.changed_at(r) < manual[0]:
                        continue
                elif time.time() - manual[0] < (seconds(pause) or 0):
                    continue
            out.append(e)
        return out

    # ------------------------------------------------------------------ run
    async def run(self, rule: dict[str, Any], ctx: Context, room: str | None, scope: str | None, *, snapshots: dict[str, Any] | None = None, only_changes: bool = False) -> list[dict[str, Any]]:
        """Runs the steps in order. Returns what was done: [{text, entities}]. snapshots collects states before changes.
        only_changes: leave devices alone that are already as the step wants (the check after a restart)."""
        done: list[dict[str, Any]] = []
        for clause in rule.get("then", []):
            if clause.get("subject") == "logic":
                # if / choose / repeat / parallel / wait until / wait for / set / stop (logic.py)
                try:
                    done += await logic.step(self, rule, clause, ctx, room, scope, snapshots, only_changes)
                except StopRun as stop:
                    raise StopRun(done + (stop.args[0] if stop.args else [])) from None
                continue
            clause = logic.resolve(clause)  # "$trigger", "$name": values from what set the rule off
            subject = clause.get("subject", "")
            verb = clause.get("verb", "")
            text = self.core.describer.clause(clause, "then")
            if subject == "wait":
                if verb == "wait_until_empty":
                    await self._wait_empty(rule, room)
                else:
                    await asyncio.sleep(seconds(clause.get("for")) or 0)
                continue
            if subject.startswith("notify:"):
                ok = await self._notify(rule, clause, ctx)
                done.append({"text": text, "entities": []})
                if not ok:
                    done.append({"text": tr(self.core, "engine.answer_no"), "entities": []})
                    raise StopRun(done)
                continue
            if subject == "mode":
                if snapshots is not None and "mode" not in snapshots:
                    snapshots["mode"] = {"state": self.core.mode}
                await self.core.set_mode(clause.get("mode", "home"), ctx)
                done.append({"text": text, "entities": []})
                continue
            if subject == "alarm":
                alarm = self.core.alarm
                if verb in ("arm_away", "arm_night", "arm_home"):
                    await alarm.arm(verb[4:], force=True, auto=True)
                elif verb == "disarm":
                    if not rule.get("options", {}).get("allow_sensitive"):
                        done.append({"text": tr(self.core, "engine.not_allowed", text=text), "entities": []})
                        continue
                    await alarm.disarm(by=tr(self.core, "engine.by_rule", name=quote(self.core, str(rule.get("name")))), check=False)
                elif verb == "trigger":
                    await alarm.trigger(None, manual=True)
                done.append({"text": text, "entities": []})
                continue
            if subject.startswith("rule:"):
                rid = subject[5:]
                if verb == "run":
                    self.hass.async_create_task(self.core.engine.run_now(rid, parent=ctx))
                elif verb == "pause":
                    until = time.time() + (seconds(clause.get("for")) or 3600)
                    await self.core.pause_rule(rid, until)
                done.append({"text": text, "entities": []})
                continue

            all_ents = self.res.entities(subject, room, scope)
            ents = self.targets(rule, clause, room, scope)
            if only_changes:
                ents = [e for e in ents if not self.already(clause, e)]
                all_ents = [e for e in all_ents if e in ents or not self.already(clause, e)]
            left_alone = [e for e in all_ents if e not in ents]
            if left_alone:
                names = ", ".join(self.core.inventory.devices.get(e, {}).get("name", e) for e in left_alone[:4])
                done.append({"text": tr(self.core, "engine.left_alone", text=text, names=names), "entities": [], "skipped": True})
            # Home Assistant quietly skips unavailable devices in a service call: say so instead of "done"
            gone = [e for e in ents if (s := self.hass.states.get(e)) is None or s.state == STATE_UNAVAILABLE]
            if gone:
                ents = [e for e in ents if e not in gone]
                names = ", ".join(self.core.inventory.devices.get(e, {}).get("name", e) for e in gone[:4])
                done.append({"text": tr(self.core, "engine.unreachable", text=text, names=names), "entities": [], "skipped": True})
            if not ents:
                continue
            kind = self.res.kind_of(subject)
            if kind == "lock" and verb == "unlock" and not rule.get("options", {}).get("allow_sensitive"):
                done.append({"text": tr(self.core, "engine.not_allowed", text=text), "entities": []})
                continue
            revert = seconds(clause.get("for")) if verb not in ("boost",) else None
            before = {e: snapshot(self.hass.states.get(e)) for e in ents}
            if snapshots is not None:
                for e, s in before.items():
                    snapshots.setdefault(e, s)
            try:
                await self._device(kind, verb, clause, ents, ctx)
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("House rules: %s failed: %s", text, err)
                done.append({"text": tr(self.core, "engine.failed", text=text), "entities": ents})
                continue
            done.append({"text": text, "entities": ents})
            if verb == "boost":
                revert = seconds(clause.get("for")) or 1800
            if revert:
                for e in ents:
                    self._schedule_revert(rule["id"], e, before[e], revert)
        return done

    def already(self, clause: dict[str, Any], entity_id: str) -> bool:
        """Is the device already the way this step wants it? (Only for plain states; anything else: no.)"""
        st = self.hass.states.get(entity_id)
        if st is None or st.state in ("unavailable", "unknown"):
            return False
        verb = clause.get("verb")
        domain = entity_id.split(".")[0]
        a = st.attributes
        if domain == "climate":
            if verb == "turn_off":
                return st.state == STATE_OFF
            if verb == "turn_on":
                return st.state != STATE_OFF
            if verb in ("set_temp", "eco") and st.state != STATE_OFF and not clause.get("plan"):
                want = float(self.core.data.get("settings", {}).get("eco_temp", 17)) if verb == "eco" else float(clause.get("temperature", 21))
                return a.get("temperature") is not None and abs(float(a["temperature"]) - want) < 0.05
            return False
        if domain == "cover":
            return (verb == "open" and st.state == "open") or (verb == "close" and st.state == "closed")
        if domain == "lock":
            return verb == "lock" and st.state == "locked"
        if verb == "turn_off":
            return st.state in (STATE_OFF, "standby", "idle") if domain == "media_player" else st.state == STATE_OFF
        if verb == "turn_on" and domain != "light":
            return st.state not in (STATE_OFF, "standby")
        if verb == "set" and domain == "light":
            s = for_light(clause.get("light") or {}, entity_id) or {}
            return s.get("mode") != "scene" and matches(st.state, a, self.core.lightcal.adjust(entity_id, s))
        if verb in ("turn_on", "dim") and domain == "light":
            if st.state != STATE_ON:
                return False
            if clause.get("brightness") is None and verb == "turn_on":
                return True
            return abs((a.get("brightness") or 0) / 2.55 - float(clause.get("brightness", 50))) <= 3
        return False

    def _schedule_revert(self, rule_id: str, entity_id: str, snap: dict[str, Any] | None, delay: float, since: float | None = None) -> None:
        key = (rule_id, entity_id)
        old = self._reverts.pop(key, None)
        if old:
            old[0].cancel()
            snap = old[1]  # keep the state from before the first run
        since = since or time.time()
        # kept in the store too: a restart in between must not leave the device on for good (see resume_reverts)
        stored = self.core.data.setdefault("runtime", {}).setdefault("reverts", {})
        stored[f"{rule_id}|{entity_id}"] = {"at": time.time() + delay, "since": since, "snap": snap}
        self.core.save()

        def _fire() -> None:
            self._reverts.pop(key, None)
            stored.pop(f"{rule_id}|{entity_id}", None)
            self.core.save()
            manual = self.core.history.manual.get(entity_id)
            if manual and manual[0] > since:
                return  # someone changed it by hand meanwhile: leave it
            ctx = self.core.history.new_context(rule_id)
            self.hass.async_create_task(self.restore(entity_id, snap, ctx))

        handle = self.hass.loop.call_later(delay, _fire)
        self._reverts[key] = (handle, snap)

    def resume_reverts(self) -> None:
        """After a start: the timed steps that were still running go on (or end at once if their time is over)."""
        for key, r in list(self.core.data.get("runtime", {}).get("reverts", {}).items()):
            rule_id, _, entity_id = key.partition("|")
            if (rule_id, entity_id) not in self._reverts and isinstance(r, dict):
                self._schedule_revert(rule_id, entity_id, r.get("snap"), max(5.0, float(r.get("at", 0)) - time.time()), float(r.get("since", 0)) or None)

    def cancel_reverts(self, rule_id: str) -> None:
        stored = self.core.data.get("runtime", {}).get("reverts", {})
        for key in [k for k in self._reverts if k[0] == rule_id]:
            self._reverts.pop(key)[0].cancel()
            stored.pop(f"{key[0]}|{key[1]}", None)

    async def _device(self, kind: str, verb: str, clause: dict[str, Any], ents: list[str], ctx: Context) -> None:
        call = self._call
        by_domain: dict[str, list[str]] = {}
        for e in ents:
            by_domain.setdefault(e.split(".")[0], []).append(e)

        # the kinds of devices side by side, so a lamp on a switch and a light go on together
        async def one(domain: str, ids: list[str]) -> None:
            if verb == "press":
                await call(domain if domain in ("button", "input_button") else "button", "press", ids, {}, ctx)
                return
            if verb == "activate":
                await call("scene", "turn_on", ids, {}, ctx)
                return
            if verb == "select":
                svc_dom = domain if domain in ("select", "input_select") else "select"
                await call(svc_dom, "select_option", ids, {"option": str(clause.get("state", ""))}, ctx)
                return
            if verb == "set_value":
                await call(domain if domain in ("number", "input_number") else "number", "set_value", ids, {"value": clause.get("value", 0)}, ctx)
                return
            if verb == "set_text":
                await call("input_text", "set_value", ids, {"value": str(clause.get("state", ""))}, ctx)
                return
            if verb == "trigger" and domain == "automation":
                await call("automation", "trigger", ids, {}, ctx)
                return
            if verb in ("turn_on", "turn_off", "toggle") and domain != "light" and domain != "climate" and domain != "media_player":
                svc = {"turn_on": "turn_on", "turn_off": "turn_off", "toggle": "toggle"}[verb]
                await call("script" if domain == "script" else "homeassistant", svc, ids, {}, ctx)
            elif domain == "light" and verb == "set":
                await self._light_set(clause.get("light") or {}, ids, ctx)
            elif domain == "light":
                if verb == "turn_off":
                    await call("light", "turn_off", ids, {}, ctx)
                elif verb == "toggle":
                    await call("light", "toggle", ids, {}, ctx)
                elif verb == "blink":
                    await self._blink(ids, ctx)
                else:
                    data: dict[str, Any] = {}
                    if verb == "dim" or clause.get("brightness") is not None:
                        data["brightness_pct"] = int(clause.get("brightness", 50))
                    if verb == "color":
                        data.update(COLORS.get(str(clause.get("color", "warmweiß")).lower(), {}))  # i18n-ignore
                    if clause.get("night_dim") and self.core.checker.holds({"subject": "time", "verb": "night"})[0]:
                        data.update(NIGHT_LIGHT)
                    if "brightness_pct" in data and any(k in data for k in ("rgb_color", "color_temp_kelvin")):
                        # a colour: lamps that are off power up in it (call_together), all at the same time
                        errors = [err for _ids, err in await call_together(self.hass, [("light", "turn_on", e, data) for e in ids], ctx) if err]
                        if errors:
                            raise errors[0]
                    else:
                        await call("light", "turn_on", ids, data, ctx)
            elif domain == "climate":
                if verb == "turn_off":
                    await call("climate", "set_hvac_mode", ids, {"hvac_mode": "off"}, ctx)
                elif verb == "turn_on":
                    for e in ids:
                        st = self.hass.states.get(e)
                        modes = (st.attributes.get("hvac_modes") if st else None) or []
                        mode = "heat" if "heat" in modes else next((m for m in modes if m != "off"), None)
                        if mode and st and st.state == STATE_OFF:
                            await call("climate", "set_hvac_mode", e, {"hvac_mode": mode}, ctx)
                elif verb in ("set_temp", "eco", "boost"):
                    if verb == "eco":
                        temp = float(self.core.data.get("settings", {}).get("eco_temp", 17))
                    elif verb == "boost":
                        temp = None
                    else:
                        temp = float(self.core.plans.heat_target(str(clause["plan"]), bool(clause.get("preheat")))["temp"]) if clause.get("plan") else float(clause.get("temperature", 21))
                    for e in ids:
                        st = self.hass.states.get(e)
                        if st and st.state == STATE_OFF:
                            modes = st.attributes.get("hvac_modes") or []
                            mode = "heat" if "heat" in modes else next((m for m in modes if m != "off"), None)
                            if mode:
                                await call("climate", "set_hvac_mode", e, {"hvac_mode": mode}, ctx)
                        t = temp if temp is not None else float((st.attributes.get("temperature") if st else 20) or 20) + 3
                        await call("climate", "set_temperature", e, {"temperature": t}, ctx)
            elif domain == "cover":
                if verb == "open":
                    await call("cover", "open_cover", ids, {}, ctx)
                elif verb == "close":
                    await call("cover", "close_cover", ids, {}, ctx)
                elif verb == "position":
                    await call("cover", "set_cover_position", ids, {"position": int(clause.get("position", 30))}, ctx)
            elif domain == "media_player":
                if verb == "pause":
                    playing = [e for e in ids if (st := self.hass.states.get(e)) and st.state == "playing"]
                    if playing:
                        await call("media_player", "media_pause", playing, {}, ctx)
                elif verb == "play":
                    await call("media_player", "media_play", ids, {}, ctx)
                elif verb == "volume":
                    await call("media_player", "volume_set", ids, {"volume_level": max(0, min(1, int(clause.get("volume", 20)) / 100))}, ctx)
                elif verb == "turn_off":
                    await call("media_player", "turn_off", ids, {}, ctx)
                elif verb == "turn_on":
                    await call("media_player", "turn_on", ids, {}, ctx)
                elif verb == "announce":
                    await self._announce(ids, str(clause.get("message", "")), ctx)
            elif domain == "vacuum":
                if verb in ("start", "clean_rooms"):
                    await call("vacuum", "start", ids, {}, ctx)
                elif verb == "dock":
                    await call("vacuum", "return_to_base", ids, {}, ctx)
            elif domain == "lock":
                if verb in ("lock", "unlock"):
                    await call("lock", verb, ids, {}, ctx)
            elif domain == "script" and verb == "run":
                await call("script", "turn_on", ids, {}, ctx)

        errors = [r for r in await asyncio.gather(*(one(d, ids) for d, ids in by_domain.items()), return_exceptions=True) if isinstance(r, BaseException)]
        if errors:
            raise errors[0]

    async def _light_set(self, spec: dict[str, Any], ids: list[str], ctx: Context) -> None:
        """A light setting (lightspec.py): each lamp in its own colour mode, its own part of per_light – all switched
        at the same time (call_together)."""
        calls: list[tuple[str, str, str, dict[str, Any]]] = []
        for e in ids:
            s = for_light(spec, e) or {}
            if s.get("mode") == "off":
                calls.append(("light", "turn_off", e, {k: s[k] for k in ("transition",) if isinstance(s.get(k), (int, float))}))
            elif s.get("mode") == "scene":
                if s.get("scene"):
                    calls.append(("scene", "turn_on", s["scene"], {}))
            else:
                st = self.hass.states.get(e)
                # this lamp's own correction (Lampen abgleichen, lightcal.py) right before it becomes a call
                calls.append(("light", "turn_on", e, service_data(st.attributes if st else None, self.core.lightcal.adjust(e, s))))
        errors = [err for _ids, err in await call_together(self.hass, calls, ctx) if err]
        if errors:
            raise errors[0]

    async def _blink(self, ids: list[str], ctx: Context) -> None:
        # slow enough for Wi-Fi and Zigbee lamps (they need about a second to follow)
        before = {e: snapshot(self.hass.states.get(e)) for e in ids}
        for _ in range(3):
            await self._call("light", "turn_on", ids, {"brightness_pct": 100}, ctx)
            await asyncio.sleep(1.2)
            await self._call("light", "turn_off", ids, {}, ctx)
            await asyncio.sleep(1.2)
        await self.restore_many(before, ctx)

    async def _announce(self, players: list[str], message: str, ctx: Context) -> None:
        engines = [s.entity_id for s in self.hass.states.async_all("tts")]
        if not engines or not message:
            return
        engine = next((e for e in engines if "cloud" in e), engines[0])
        await self.hass.services.async_call(
            "tts", "speak", {ATTR_ENTITY_ID: engine, "media_player_entity_id": players, "message": message, "cache": True}, blocking=True, context=ctx
        )

    async def _wait_empty(self, rule: dict[str, Any], room: str | None) -> None:
        rid = room or next((c["subject"][5:] for s in ("when", "and") for c in rule.get(s, []) if c.get("subject", "").startswith("room:")), None)
        if not rid:
            return
        tracker = self.core.room_tracker
        if not tracker.occupied(rid):
            return
        done = asyncio.Event()

        def _cb(r: str, occupied: bool) -> None:
            if r == rid and not occupied:
                done.set()

        remove = tracker.add_listener(_cb)
        try:
            await asyncio.wait_for(done.wait(), timeout=4 * 3600)
        except TimeoutError:
            pass
        finally:
            remove()

    # ------------------------------------------------------------------ notifications
    def phones(self, subject: str) -> list[str]:
        pid = subject[7:]
        inv = self.core.inventory
        if pid == "everyone":
            return [ph for p in inv.persons.values() for ph in p["phones"]]
        p = inv.persons.get(pid)
        return list(p["phones"]) if p else []

    async def _notify(self, rule: dict[str, Any], clause: dict[str, Any], ctx: Context) -> bool:
        """Sends the message. For a question waits for the answer; returns False on "Nein"/no answer."""
        verb = clause.get("verb", "send")
        message = str(clause.get("message") or rule.get("name") or tr(self.core, "app.name"))
        title = rule.get("name") or tr(self.core, "app.name")
        services = self.phones(clause["subject"])
        if not services:
            _LOGGER.info("House rules: no phone found for %s", clause["subject"])
            return verb != "ask"
        if verb == "send":
            # a plain message of a rule: within the limits of notify.py (the same text again within a minute, a daily
            # maximum, the person's own choice); the next message of the rule replaces this one on the phone
            pid = clause["subject"][7:]
            persons = list(self.core.inventory.persons) if pid == "everyone" else [pid]
            await self.core.notifier.send("rule", f"{rule['id']}:{message[:40]}", title, message, persons=persons, tag=f"house_rules_{rule['id']}", ctx=ctx, blocking=True)
            return True
        # questions (they wait for an answer) and alarm messages of rules go out at once
        data: dict[str, Any] = {"tag": f"house_rules_{rule['id']}"}
        answer_ids: dict[str, bool] = {}
        if verb == "alarm":
            data.update({"push": {"interruption-level": "critical", "sound": {"name": "default", "critical": 1, "volume": 1.0}}, "ttl": 0, "priority": "high", "channel": "alarm_stream"})
        if verb == "ask":
            token = uuid.uuid4().hex[:8]
            yes, no = f"HR_{token}_YES", f"HR_{token}_NO"
            answer_ids = {yes: True, no: False}
            data["actions"] = [{"action": yes, "title": tr(self.core, "engine.yes")}, {"action": no, "title": tr(self.core, "engine.no")}]
        for service in services:
            try:
                await self.hass.services.async_call("notify", service, {"title": title, "message": message, "data": data}, blocking=True, context=ctx)
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("House rules: notification to %s failed: %s", service, err)
        if verb != "ask":
            return True
        result = asyncio.get_running_loop().create_future()

        @callback
        def _answer(event: Event) -> None:
            action = event.data.get("action")
            if action in answer_ids and not result.done():
                result.set_result(answer_ids[action])

        remove = self.hass.bus.async_listen("mobile_app_notification_action", _answer)
        try:
            return bool(await asyncio.wait_for(result, timeout=float(seconds(clause.get("timeout")) or 900)))
        except TimeoutError:
            return False
        finally:
            remove()
