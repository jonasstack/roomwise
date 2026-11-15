"""Front door warning, run by the server.

When the front door opens while windows are open: the configured lights flash red three times and return to
how they were, and after a timeout without acknowledgement an announcement is spoken (general, all windows in
one sentence, or one window after another — the next once the previous is closed). Acknowledged by the
configured switch / button (any state change) or by a tap on a tablet showing the card. The warning ends when
it is acknowledged or all windows are closed.

The card sends a resolved configuration (entity ids, window names in checking order, final texts with the
placeholders {fenster} and {anzahl}, the TTS language) — nothing here depends on the dashboard.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import logging
import time
from typing import Any

from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later, async_track_state_change_event

from .const import EVENT_ENTRY_ALERT, OPEN_STATES

_LOGGER = logging.getLogger(__name__)

LINGER = 5  # s the open windows stay marked after acknowledging
FLASHES = 3
FLASH_ON = 0.7
FLASH_OFF = 0.55


def house_rules_warns(hass: HomeAssistant) -> bool:
    """Hausregeln (same roomwise package) runs its own "Fenster-Warnung beim Gehen": then it replaces this
    warning. Its entity is available exactly while that feature is on (found by unique id, so renaming it is fine)."""
    entity_id = er.async_get(hass).async_get_entity_id("binary_sensor", "house_rules", "window_warning")
    state = hass.states.get(entity_id) if entity_id else None
    return state is not None and state.state not in ("unavailable", "unknown")


class EntryAlert:
    """One card's front door warning."""

    def __init__(self, hass: HomeAssistant, card_id: str, cfg: dict[str, Any], on_change: Callable[[str], None] | None = None) -> None:
        self.hass = hass
        self.card_id = card_id
        self.cfg = cfg
        self._on_change = on_change
        self.active = False
        # 'alarm' (until acknowledged) or 'linger' (acknowledged: windows stay marked a few seconds)
        self.phase: str | None = None
        self.deadline: float | None = None
        self._linger: CALLBACK_TYPE | None = None
        self.spoken = False
        self.current: str | None = None
        self._unsubs: list[CALLBACK_TYPE] = []
        self._timer: CALLBACK_TYPE | None = None
        self._flash_task: asyncio.Task | None = None
        self._flash_abort = False

    # ---------- setup ----------

    @property
    def windows(self) -> list[dict[str, str]]:
        return [w for w in self.cfg.get("windows", []) if w.get("e")]

    def start(self) -> None:
        door = self.cfg.get("door")
        if not door:
            return
        self._unsubs.append(async_track_state_change_event(self.hass, [door], self._door_changed))
        wins = [w["e"] for w in self.windows]
        if wins:
            self._unsubs.append(async_track_state_change_event(self.hass, wins, self._window_changed))
        ack = self.cfg.get("ack_entity")
        if ack:
            self._unsubs.append(async_track_state_change_event(self.hass, [ack], self._ack_changed))

    def stop(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        self._end()

    # ---------- state ----------

    def _open_windows(self) -> list[dict[str, str]]:
        out = []
        for w in self.windows:
            st = self.hass.states.get(w["e"])
            if st is not None and st.state in OPEN_STATES:
                out.append(w)
        return out

    @property
    def state(self) -> dict[str, Any]:
        """What every card shows: the same on all tablets"""
        return {
            "active": self.active,
            "phase": self.phase if self.active else None,
            "windows": [w["e"] for w in self._open_windows()] if self.active else [],
            "deadline": int(self.deadline * 1000) if self.active and self.phase == "alarm" and self.deadline and not self.spoken else None,
            "spoken": self.spoken,
        }

    def _notify(self) -> None:
        self.hass.bus.async_fire(EVENT_ENTRY_ALERT, {"card_id": self.card_id, **self.state})
        if self._on_change:
            self._on_change(self.card_id)

    @callback
    def _door_changed(self, event: Event[EventStateChangedData]) -> None:
        old = event.data["old_state"]
        new = event.data["new_state"]
        # only a real "closed → open" (not after a restart / unavailable)
        if old is None or new is None or old.state in OPEN_STATES or old.state in ("unavailable", "unknown"):
            return
        if new.state in OPEN_STATES:
            self._begin()

    @callback
    def _window_changed(self, event: Event[EventStateChangedData]) -> None:
        if not self.active:
            return
        wins = self._open_windows()
        if not wins:
            self._end()
            return
        if self.phase != "alarm":
            self._notify()
            return
        # one after another: the current window was closed → announce the next one
        if self.spoken and self.cfg.get("mode") == "sequential" and self.current and all(w["e"] != self.current for w in wins):
            self.current = wins[0]["e"]
            self.hass.async_create_task(self._speak(self._text("single", [wins[0]])))
        self._notify()

    @callback
    def _ack_changed(self, event: Event[EventStateChangedData]) -> None:
        old = event.data["old_state"]
        new = event.data["new_state"]
        if new is None or (old is not None and old.state == new.state):
            return
        self.acknowledge()

    def _begin(self) -> None:
        if house_rules_warns(self.hass):
            return
        wins = self._open_windows()
        if not wins:
            return
        self._end(notify=False)
        self.active = True
        self.phase = "alarm"
        self.spoken = False
        self.current = None
        lights = self.cfg.get("flash_color", []) + self.cfg.get("flash_plain", [])
        if lights:
            self._flash_abort = False
            self._flash_task = self.hass.async_create_background_task(self._flash(), f"floorplan_card flash {self.card_id}")
        timeout = max(0, float(self.cfg.get("timeout", 30)))
        self.deadline = time.time() + timeout
        self._timer = async_call_later(self.hass, timeout, self._timeout)
        self._notify()

    def acknowledge(self) -> None:
        """Switch / button or a tap on a tablet: the warning is off; open windows stay marked for a few seconds"""
        if not self.active or self.phase != "alarm":
            return
        self._flash_abort = True
        if self._timer:
            self._timer()
            self._timer = None
        self.phase = "linger"
        self.current = None
        self._linger = async_call_later(self.hass, LINGER, self._linger_done)
        self._notify()

    @callback
    def _linger_done(self, _now: Any) -> None:
        self._linger = None
        self._end()

    def _end(self, notify: bool = True) -> None:
        was = self.active
        self.active = False
        self.phase = None
        self.deadline = None
        if self._linger:
            self._linger()
            self._linger = None
        self.spoken = False
        self.current = None
        self._flash_abort = True
        if self._timer:
            self._timer()
            self._timer = None
        if was and notify:
            self._notify()

    # ---------- announcement ----------

    @callback
    def _timeout(self, _now: Any) -> None:
        self._timer = None
        if not self.active or self.phase != "alarm":
            return
        wins = self._open_windows()
        if not wins:
            self._end()
            return
        self.spoken = True
        mode = self.cfg.get("mode", "all")
        if mode == "general":
            self.hass.async_create_task(self._speak(self._text("general", wins)))
        elif mode == "all":
            self.hass.async_create_task(self._speak(self._text("all", wins)))
        elif mode == "sequential":
            self.current = wins[0]["e"]
            self.hass.async_create_task(self._speak(self._text("single", [wins[0]])))
        self._notify()

    def _text(self, kind: str, wins: list[dict[str, str]]) -> str:
        texts = self.cfg.get("texts", {})
        tpl = texts.get(kind) or ""
        names = [w.get("n") or w["e"] for w in wins]
        and_word = self.cfg.get("and", " und ")
        joined = f"{', '.join(names[:-1])}{and_word}{names[-1]}" if len(names) > 1 else (names[0] if names else "")
        return tpl.replace("{fenster}", joined).replace("{anzahl}", str(len(wins)))

    async def _speak(self, message: str) -> None:
        tts = self.cfg.get("tts_entity")
        player = self.cfg.get("media_player")
        if not tts or not player or not message:
            return
        data: dict[str, Any] = {"media_player_entity_id": player, "message": message, "cache": True}
        if self.cfg.get("language"):
            data["language"] = self.cfg["language"]
        try:
            await self.hass.services.async_call("tts", "speak", data, target={"entity_id": tts}, blocking=False)
        except Exception:  # noqa: BLE001 — a failing speaker must not break the warning
            _LOGGER.warning("Front door warning: announcement failed", exc_info=True)

    # ---------- lights ----------

    async def _call(self, domain: str, service: str, data: dict[str, Any], entities: list[str] | None = None) -> None:
        try:
            await self.hass.services.async_call(domain, service, data, target={"entity_id": entities} if entities else None, blocking=True)
        except Exception:  # noqa: BLE001
            _LOGGER.warning("Front door warning: %s.%s failed", domain, service, exc_info=True)

    async def _flash(self) -> None:
        """Flash red three times at full brightness, then everything back as it was (scene snapshot)"""
        color: list[str] = self.cfg.get("flash_color", [])
        plain: list[str] = self.cfg.get("flash_plain", [])
        lights = color + plain
        scene_id = f"floorplan_card_{self.card_id}_lights".lower()
        snap = True
        try:
            await self.hass.services.async_call("scene", "create", {"scene_id": scene_id, "snapshot_entities": lights}, blocking=True)
        except Exception:  # noqa: BLE001
            snap = False
            _LOGGER.warning("Front door warning: could not remember the lights", exc_info=True)
        try:
            for _ in range(FLASHES):
                if self._flash_abort:
                    break
                if color:
                    await self._call("light", "turn_on", {"rgb_color": [255, 0, 0], "brightness": 255, "transition": 0}, color)
                if plain:
                    await self._call("light", "turn_on", {"brightness": 255, "transition": 0}, plain)
                await asyncio.sleep(FLASH_ON)
                await self._call("light", "turn_off", {"transition": 0}, lights)
                if self._flash_abort:
                    break
                await asyncio.sleep(FLASH_OFF)
        finally:
            if snap:
                await self._call("scene", "turn_on", {"transition": 0}, [f"scene.{scene_id}"])


def sanitize(cfg: dict[str, Any]) -> dict[str, Any]:
    """Keep only what the warning uses (the card sends it, the store keeps it)"""
    strs = lambda v: [x for x in (v or []) if isinstance(x, str)]  # noqa: E731
    out: dict[str, Any] = {
        "door": cfg.get("door") if isinstance(cfg.get("door"), str) else None,
        "windows": [{"e": w["e"], "n": str(w.get("n") or w["e"])} for w in cfg.get("windows", []) if isinstance(w, dict) and isinstance(w.get("e"), str)],
        "ack_entity": cfg.get("ack_entity") if isinstance(cfg.get("ack_entity"), str) else None,
        "timeout": float(cfg.get("timeout", 30)),
        "mode": cfg.get("mode") if cfg.get("mode") in ("none", "general", "all", "sequential") else "all",
        "tts_entity": cfg.get("tts_entity") if isinstance(cfg.get("tts_entity"), str) else None,
        "media_player": cfg.get("media_player") if isinstance(cfg.get("media_player"), str) else None,
        "language": cfg.get("language") if isinstance(cfg.get("language"), str) else None,
        "texts": {k: str(v) for k, v in (cfg.get("texts") or {}).items() if k in ("general", "all", "single")},
        "and": str(cfg.get("and", " und ")),
        "flash_color": strs(cfg.get("flash_color")),
        "flash_plain": strs(cfg.get("flash_plain")),
    }
    return out


__all__ = ["EntryAlert", "sanitize", "Callable"]
