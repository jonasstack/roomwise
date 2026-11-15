"""Fenster-Warnung beim Gehen (feature "window_warning").

A door (usually the front door) opens while windows are still open: the warning starts. Optionally only when the
last resident may be leaving (at most one counting resident at home) and after a short delay. Lights flash red
three times and return to how they were (scene snapshot), the floor plan card marks the open windows. Somebody
acknowledges it (a tap on the card / in the panel, `house_rules/window_warning/ack`, or any change of an
`ack_entity`); otherwise after `timeout` seconds an announcement is spoken on the alarm's speakers (one general
sentence, all windows, or one window after another: the next once the previous is closed) and, if wanted, a
message goes to the phones of the chosen persons. It ends when acknowledged or all windows are closed.

The same warning existed in the floor plan card (entry_alert); `import_card()` takes over its settings once.
State for the card: snapshot/update part `window_warning`, event `house_rules_window_warning`,
`binary_sensor.fenster_warnung`.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.const import STATE_ON
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.util import dt as dt_util

from .i18n import join_list, lang_of, tr

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

# i18n: complete (texts in texts/warning.json)

EVENT = "house_rules_window_warning"
OPEN = {STATE_ON, "open", "opening"}
NOT_REAL = {"unavailable", "unknown"}
LINGER = 5  # s the open windows stay marked after acknowledging
FLASHES = 3
FLASH_ON = 0.7
FLASH_OFF = 0.55
COLOR_MODES = {"hs", "rgb", "rgbw", "rgbww", "xy"}
TEXT_KINDS = ("general", "all", "single")


def default_texts(lang: str = "de") -> dict[str, str]:
    """The announcement texts until the user writes own ones; {fenster}/{windows} = window names, {anzahl}/{count} = how many."""
    names = "{fenster}" if lang == "de" else "{windows}"
    return {k: tr(lang, f"warning.text_{k}", windows=names) for k in TEXT_KINDS}


def default_config(lang: str = "de") -> dict[str, Any]:
    return {
        "doors": [],  # doors that start it (empty: suggested front door)
        "windows": "all",  # "all" = every window (also new ones) or a list in the order of announcing
        "only_last": False,  # only when at most one resident is at home (the last one may be leaving)
        "delay": 0,  # s after the door opened before it starts
        "timeout": 30,  # s until the announcement / message without acknowledgement
        "blink": True,  # the floor plan card lets the open windows pulse red
        "lights": {"mode": "red", "entities": []},  # none | red (3× red, colourless ones bright) | flash (bright)
        "ack_entity": "",
        "announce": {"mode": "all", "players": [], "tts": "", "language": "", "texts": default_texts(lang)},  # players empty = the alarm's speakers
        "notify": {"on": False, "persons": "everyone"},
        "users": [],  # floor plan card: only these HA users' devices speak / flash (empty: all)
        "imported": None,
    }


class WindowWarning:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.active = False
        self.phase: str | None = None  # alarm (until acknowledged) | linger (acknowledged, still marked)
        self.door: str | None = None
        self.since: float | None = None
        self.deadline: float | None = None
        self.spoken = False
        self.current: str | None = None
        self.flashing = False
        self._unsub: list[Callable[[], None]] = []
        self._timer: CALLBACK_TYPE | None = None
        self._delay: CALLBACK_TYPE | None = None
        self._linger: CALLBACK_TYPE | None = None
        self._flash_abort = False
        self._listeners: list[Callable[[], None]] = []

    # ------------------------------------------------------------------ config
    @property
    def config(self) -> dict[str, Any]:
        lang = lang_of(self.core)
        cfg = self.core.data.setdefault("window_warning", default_config(lang))
        d = default_config(lang)
        for k, v in d.items():
            cfg.setdefault(k, v)
        for k in ("lights", "announce", "notify"):
            cfg[k] = {**d[k], **(cfg[k] if isinstance(cfg[k], dict) else {})}
        cfg["announce"]["texts"] = {**default_texts(lang), **(cfg["announce"].get("texts") or {})}
        return cfg

    def suggested_doors(self) -> list[str]:
        """Front door first: a door whose name says so, else doors in a hallway, else all doors."""
        devs = [d for d in self.core.inventory.devices.values() if d["kind"] == "door"]
        # whole words only: "Front left door" (a car) is no front door; vehicles are not in the inventory at all
        front = [d["entity_id"] for d in devs if re.search(r"haust(ü|ue)r|wohnungst(ü|ue)r|eingang|front ?door|entrance|main door", d["name"].lower())]  # i18n-ignore
        if front:
            return front[:2]
        hall = [d["entity_id"] for d in devs if d.get("room") and any(w in (self.core.rooms.get(d["room"], {}).get("name", "").lower()) for w in ("flur", "diele", "eingang", "hall", "entrance"))]
        return hall[:2] or [d["entity_id"] for d in devs][:1]

    def doors(self) -> list[str]:
        return self.config["doors"] or self.suggested_doors()

    def windows(self) -> list[str]:
        w = self.config["windows"]
        if w == "all" or not isinstance(w, list):
            return [d["entity_id"] for d in self.core.inventory.devices.values() if d["kind"] == "window"]
        return [e for e in w if self.hass.states.get(e) is not None]

    def save(self, raw: dict[str, Any]) -> None:
        cfg = self.config
        ok = lambda e: isinstance(e, str) and "." in e  # noqa: E731
        if isinstance(raw.get("doors"), list):
            cfg["doors"] = [e for e in raw["doors"] if ok(e)][:10]
        if raw.get("windows") == "all" or isinstance(raw.get("windows"), list):
            cfg["windows"] = "all" if raw["windows"] == "all" else [e for e in raw["windows"] if ok(e)][:60]
        for k in ("only_last", "blink"):
            if isinstance(raw.get(k), bool):
                cfg[k] = raw[k]
        if isinstance(raw.get("delay"), (int, float)):
            cfg["delay"] = int(max(0, min(300, raw["delay"])))
        if isinstance(raw.get("timeout"), (int, float)):
            cfg["timeout"] = int(max(0, min(600, raw["timeout"])))
        if "ack_entity" in raw:
            cfg["ack_entity"] = raw["ack_entity"] if ok(raw.get("ack_entity")) else ""
        if isinstance(li := raw.get("lights"), dict):
            cfg["lights"] = {
                "mode": li.get("mode") if li.get("mode") in ("none", "red", "flash") else cfg["lights"]["mode"],
                "entities": [e for e in li.get("entities", cfg["lights"]["entities"]) if isinstance(e, str) and e.startswith("light.")][:40],
            }
        if isinstance(a := raw.get("announce"), dict):
            cur = cfg["announce"]
            cfg["announce"] = {
                "mode": a.get("mode") if a.get("mode") in ("none", "general", "all", "sequential") else cur["mode"],
                "players": [e for e in a.get("players", cur["players"]) if isinstance(e, str) and e.startswith("media_player.")][:10],
                "tts": a["tts"] if isinstance(a.get("tts"), str) and (not a["tts"] or a["tts"].startswith("tts.")) else cur["tts"],
                "language": str(a.get("language", cur["language"]) or "")[:10],
                "texts": {k: str((a.get("texts") or {}).get(k) or cur["texts"].get(k) or default_texts(lang_of(self.core))[k])[:300] for k in TEXT_KINDS},
            }
        if isinstance(n := raw.get("notify"), dict):
            p = n.get("persons", cfg["notify"]["persons"])
            cfg["notify"] = {"on": bool(n.get("on", cfg["notify"]["on"])), "persons": "everyone" if p == "everyone" else [str(x) for x in p if isinstance(x, str)][:20] if isinstance(p, list) else "everyone"}
        if isinstance(raw.get("users"), list):
            cfg["users"] = [str(x) for x in raw["users"] if isinstance(x, str)][:20]
        if isinstance(raw.get("imported"), dict):
            cfg["imported"] = {"from": str(raw["imported"].get("from") or "")[:80], "at": dt_util.utcnow().isoformat()}
        self.core.save()
        self.start()

    def import_card(self, entry: dict[str, Any], openings: list[dict[str, Any]], source: str) -> dict[str, Any]:
        """Takes over the floor plan card's front door warning (card key `entry_alert`; doors and windows are
        opening ids of the plan, resolved here to their contact sensors). Read from the dashboard by the panel."""
        by_id = {o.get("id"): o for o in openings if isinstance(o, dict)}
        ent = lambda oid: (by_id.get(oid) or {}).get("entity")  # noqa: E731
        wins = [o for o in openings if isinstance(o, dict) and o.get("type") == "window" and isinstance(o.get("entity"), str)]
        order = [ent(i) for i in entry.get("order") or [] if ent(i)]
        win_ents = list(dict.fromkeys(order + [o["entity"] for o in wins]))
        all_windows = {d["entity_id"] for d in self.core.inventory.devices.values() if d["kind"] == "window"}
        mode = entry.get("mode") if entry.get("mode") in ("none", "general", "all", "sequential") else "all"
        raw: dict[str, Any] = {
            "doors": [e for e in [ent(entry.get("door"))] if e],
            # the plan's windows are all windows (and no special order): keep "all", so new windows count too
            "windows": "all" if set(win_ents) == all_windows and not order else win_ents,
            "blink": entry.get("blink", True) is not False,
            "timeout": entry.get("timeout", 30),
            "ack_entity": entry.get("ack_entity") or "",
            "lights": {"mode": "red" if entry.get("flash_lights") else "none", "entities": entry.get("flash_lights") or []},
            "announce": {
                "mode": mode,
                "players": [entry["media_player"]] if isinstance(entry.get("media_player"), str) else [],
                "tts": entry.get("tts_entity") or "",
                "language": entry.get("tts_language") or "",
                "texts": {k: entry.get(f"text_{k}") or default_texts(lang_of(self.core))[k] for k in TEXT_KINDS},
            },
            "users": entry.get("announce_users") or [],
            "imported": {"from": source},
        }
        self.save(raw)
        return self.config

    # ------------------------------------------------------------------ runtime
    def start(self) -> None:
        """(Re)subscribe. A running warning goes on (e.g. a registry change while it warns); switched off = stopped."""
        if not self.core.feature("window_warning"):
            self.stop()
            self._changed()
            return  # switched off: nothing listens
        self._unlisten()
        doors = self.doors()
        if doors:
            self._unsub.append(async_track_state_change_event(self.hass, doors, self._door))
        wins = self.windows()
        if wins:
            self._unsub.append(async_track_state_change_event(self.hass, wins, self._window))
        ack = self.config["ack_entity"]
        if ack:
            self._unsub.append(async_track_state_change_event(self.hass, [ack], self._ack_changed))
        self._changed()

    def _unlisten(self) -> None:
        for u in self._unsub:
            u()
        self._unsub.clear()

    def stop(self) -> None:
        self._unlisten()
        if self._delay:
            self._delay()
            self._delay = None
        self._end(notify=False)

    def add_listener(self, cb: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb) if cb in self._listeners else None

    def _open(self) -> list[str]:
        return [e for e in self.windows() if (st := self.hass.states.get(e)) is not None and st.state in OPEN]

    def _name(self, eid: str) -> str:
        d = self.core.inventory.devices.get(eid)
        st = self.hass.states.get(eid)
        return d["name"] if d else str(st.attributes.get("friendly_name") or eid) if st else eid

    def view(self) -> dict[str, Any]:
        cfg = self.config
        open_ = self._open() if self.active else []
        return {
            "on": self.core.feature("window_warning"),
            "active": self.active,
            "phase": self.phase if self.active else None,
            "door": self.door if self.active else None,
            "windows": open_,
            "names": [self._name(e) for e in open_],
            "since": self.since if self.active else None,
            "deadline": self.deadline if self.active and self.phase == "alarm" and not self.spoken else None,
            "spoken": self.spoken,
            "config": cfg,
            "doors": self.doors(),
            "suggested_doors": self.suggested_doors(),
            # windows it watches now, and every window it could watch (to put one back)
            "window_entities": self.windows(),
            "window_candidates": [d["entity_id"] for d in self.core.inventory.devices.values() if d["kind"] == "window"],
        }

    def _changed(self) -> None:
        state = {k: v for k, v in self.view().items() if k not in ("config", "suggested_doors", "window_entities", "window_candidates")}
        self.hass.bus.async_fire(EVENT, state)
        for cb in list(self._listeners):
            cb()
        self.core.push("window_warning")

    @callback
    def _door(self, event: Event[EventStateChangedData]) -> None:
        old, new = event.data["old_state"], event.data["new_state"]
        # only a real "closed → open" (not after a restart / unavailable)
        if old is None or new is None or old.state in OPEN or old.state in NOT_REAL or new.state not in OPEN:
            return
        if self.config["only_last"]:
            home = [p for p in self.core.residents() if p["counts"] and p["tracked"] and p["state"] == "home"]
            if len(home) > 1:
                return  # others stay at home: nobody needs a warning
        door = event.data["entity_id"]
        delay = self.config["delay"]
        if delay:
            if self._delay:
                self._delay()
            self._delay = async_call_later(self.hass, delay, callback(lambda _n: self._begin(door)))
        else:
            self._begin(door)

    @callback
    def _window(self, _event: Event[EventStateChangedData]) -> None:
        if not self.active:
            return
        wins = self._open()
        if not wins:
            self._end()
            return
        if self.phase == "alarm" and self.spoken and self.config["announce"]["mode"] == "sequential" and self.current and self.current not in wins:
            self.current = wins[0]
            self.hass.async_create_task(self._speak(self._text("single", [wins[0]])))
        self._changed()

    @callback
    def _ack_changed(self, event: Event[EventStateChangedData]) -> None:
        old, new = event.data["old_state"], event.data["new_state"]
        if new is None or new.state in NOT_REAL or (old is not None and old.state == new.state):
            return
        self.acknowledge(tr(self.core, "warning.by_switch"))

    def _begin(self, door: str) -> None:
        self._delay = None
        wins = self._open()
        if not wins:
            return
        self._end(notify=False)
        self.active, self.phase, self.door, self.since = True, "alarm", door, time.time()
        self.spoken, self.current = False, None
        cfg = self.config
        if cfg["lights"]["mode"] != "none" and cfg["lights"]["entities"]:
            self._flash_abort = False
            self.hass.async_create_background_task(self._flash(), "house_rules window warning flash")
        timeout = cfg["timeout"]
        self.deadline = time.time() + timeout
        self._timer = async_call_later(self.hass, timeout, self._timeout)
        self.core.history.add("alarm", tr(self.core, "warning.title"), tr(self.core, "warning.h_started", door=self._name(door), windows=self._join([self._name(e) for e in wins])), logbook="window_warning")
        self._changed()

    def acknowledge(self, by: str | None = None) -> bool:
        """Tap on the card / panel or the acknowledge switch: off; the open windows stay marked a few seconds."""
        by = by or tr(self.core, "warning.by_hand")
        if not self.active or self.phase != "alarm":
            return False
        self._flash_abort = True
        if self._timer:
            self._timer()
            self._timer = None
        self.phase, self.current = "linger", None
        self._linger = async_call_later(self.hass, LINGER, callback(lambda _n: self._end()))
        self.core.history.add("alarm", tr(self.core, "warning.h_acknowledged"), tr(self.core, "warning.h_by", by=by), logbook="window_warning")
        self._changed()
        return True

    def _end(self, notify: bool = True) -> None:
        was = self.active
        self.active, self.phase, self.deadline, self.spoken, self.current, self.door, self.since = False, None, None, False, None, None, None
        self._flash_abort = True
        for attr in ("_timer", "_linger"):
            if t := getattr(self, attr):
                t()
                setattr(self, attr, None)
        if was and notify:
            self._changed()

    # ------------------------------------------------------------------ announcement and message
    def _join(self, names: list[str]) -> str:
        return join_list(self.core, names)

    def _text(self, kind: str, wins: list[str]) -> str:
        tpl = self.config["announce"]["texts"].get(kind) or default_texts(lang_of(self.core))[kind]
        names = self._join([self._name(e) for e in wins])
        # the German and the English placeholders work in either language
        return tpl.replace("{fenster}", names).replace("{windows}", names).replace("{anzahl}", str(len(wins))).replace("{count}", str(len(wins)))

    @callback
    def _timeout(self, _now: Any) -> None:
        self._timer = None
        if not self.active or self.phase != "alarm":
            return
        wins = self._open()
        if not wins:
            self._end()
            return
        self.spoken = True
        mode = self.config["announce"]["mode"]
        if mode in ("general", "all"):
            self.hass.async_create_task(self._speak(self._text(mode, wins)))
        elif mode == "sequential":
            self.current = wins[0]
            self.hass.async_create_task(self._speak(self._text("single", [wins[0]])))
        if self.config["notify"]["on"]:
            self.hass.async_create_task(self._message(self._text("all", wins)))
        self._changed()

    async def _speak(self, message: str) -> None:
        a = self.config["announce"]
        players = a["players"] or self.core.alarm.config["announce"].get("players") or []
        engines = [s.entity_id for s in self.hass.states.async_all("tts")]
        tts = a["tts"] or next((e for e in engines if "cloud" in e), engines[0] if engines else "")
        if not message or not players or not tts:
            return
        self.core.history.add("alarm", tr(self.core, "warning.h_announce"), tr(self.core, "warning.h_announce_why", message=message, players=", ".join(self._name(p) for p in players)))
        data: dict[str, Any] = {"media_player_entity_id": players, "message": message, "cache": True}
        if a["language"]:
            data["language"] = a["language"]
        try:
            await self.hass.services.async_call("tts", "speak", data, target={"entity_id": tts}, blocking=False, context=self.core.history.new_context("window_warning"))
        except Exception:  # noqa: BLE001 — a failing speaker must not break the warning
            _LOGGER.warning("Window warning: announcement failed", exc_info=True)

    async def _message(self, text: str) -> None:
        """To the chosen people within the limits of notify.py (one message per departure replaces the last one)."""
        sel = self.config["notify"]["persons"]
        persons = [p["id"] for p in self.core.inventory.persons.values() if sel == "everyone" or p["id"] in sel]
        await self.core.notifier.send("window", "warning", tr(self.core, "warning.n_title"), text, persons=persons, tag="house_rules_window_warning", data={"url": "/hausregeln"})

    # ------------------------------------------------------------------ lights
    async def _call(self, service: str, data: dict[str, Any], entities: list[str], ctx: Any) -> None:
        try:
            await self.hass.services.async_call("light", service, data, target={"entity_id": entities}, blocking=True, context=ctx)
        except Exception:  # noqa: BLE001
            _LOGGER.warning("Window warning: light.%s failed", service, exc_info=True)

    async def _flash(self) -> None:
        """Three times red (colourless lights bright), then everything back as it was (scene snapshot)."""
        cfg = self.config["lights"]
        lights = [e for e in cfg["entities"] if self.hass.states.get(e)]
        if not lights:
            return
        color = [e for e in lights if cfg["mode"] == "red" and COLOR_MODES & set((self.hass.states.get(e).attributes.get("supported_color_modes") or []))]  # type: ignore[union-attr]
        plain = [e for e in lights if e not in color]
        ctx = self.core.history.new_context("window_warning")
        scene_id = "house_rules_window_warning"
        self.flashing = True
        snap = True
        try:
            await self.hass.services.async_call("scene", "create", {"scene_id": scene_id, "snapshot_entities": lights}, blocking=True, context=ctx)
        except Exception:  # noqa: BLE001
            snap = False
        try:
            for _ in range(FLASHES):
                if self._flash_abort:
                    break
                if color:
                    await self._call("turn_on", {"rgb_color": [255, 0, 0], "brightness": 255, "transition": 0}, color, ctx)
                if plain:
                    await self._call("turn_on", {"brightness": 255, "transition": 0}, plain, ctx)
                await asyncio.sleep(FLASH_ON)
                await self._call("turn_off", {"transition": 0}, lights, ctx)
                if self._flash_abort:
                    break
                await asyncio.sleep(FLASH_OFF)
        finally:
            if snap:
                try:
                    await self.hass.services.async_call("scene", "turn_on", {"entity_id": f"scene.{scene_id}", "transition": 0}, blocking=True, context=ctx)
                except Exception:  # noqa: BLE001
                    _LOGGER.debug("restore failed")
            self.flashing = False
            self.core.lightplan.schedule_all()
