"""Live preview of a light setting ("Live an der Lampe" in the panel), run by the integration.

The panel opens a session (start), sends the setting per lamp while it is edited (apply, the panel throttles to one
call per lamp every ~150 ms) and ends it (stop: put the lamps back, or leave them as they are). The integration:
  * sends exactly what a rule would send (lightspec.service_data: the lamp's colour mode, 0-255 or %, the white
    channel), only without fade and flash so the preview shows the result at once,
  * calls with its own context, marked "preview": the light plan does not count it as "by hand" (no pause, nothing
    learned by the intelligent light), the history does not log every step,
  * holds the light plan off the touched lamps while the session runs and GRACE seconds after it ended,
  * remembers each lamp right before it first changes it and puts back exactly those lamps,
  * ends a session by itself (lamps back) after IDLE seconds without apply/keep, or when the panel's connection
    closes – a closed tab never leaves lamps in a preview.
"Leave as is" (stop without restore) counts as a change by hand for the light plan: it leaves the lamps alone as if a
person had set them (but nothing is learned from it).
Lights only (light.*); every lamp is checked against the user's Home Assistant rights (control) at the start.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from homeassistant.core import CALLBACK_TYPE, Context, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later

from . import lightspec
from .actions import call_together

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

IDLE = 180  # seconds without apply/keep: the session ends by itself, lamps back
GRACE = 5  # seconds after the end in which the light plan still keeps its hands off
MAX_SESSIONS = 20
MAX_LIGHTS = 40
PREVIEW = "preview"  # the "rule id" of preview contexts in the history (history.ours)
_NO_EFFECT = ("off", "none", "None")


@dataclass
class Session:
    id: str
    user_id: str | None
    lights: list[str]
    # lamp → (state, attributes) right before the preview first changed it
    before: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict)
    sent: dict[str, str] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    timer: CALLBACK_TYPE | None = None
    # called when the session ends (forgets the connection's clean-up)
    detach: Callable[[], None] | None = None
    last: float = field(default_factory=time.time)


class LightPreview:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self.sessions: dict[str, Session] = {}
        # lamp → held until (time.time()); inf while a session has touched it
        self._held: dict[str, float] = {}
        self._ctx: dict[str, float] = {}

    # ------------------------------------------------------------------ for the light plan
    def holds(self, entity_id: str) -> bool:
        """The light plan leaves this lamp alone (a preview runs on it, or ended a moment ago)."""
        until = self._held.get(entity_id)
        if until is None:
            return False
        if until < time.time():
            self._held.pop(entity_id, None)
            return False
        return True

    def is_preview(self, ctx: Context | None) -> bool:
        return bool(ctx and (ctx.id in self._ctx or (ctx.parent_id is not None and ctx.parent_id in self._ctx)))

    def _context(self) -> Context:
        ctx = self.core.history.new_context(PREVIEW)
        now = time.time()
        self._ctx[ctx.id] = now
        if len(self._ctx) > 500:
            self._ctx = {k: t for k, t in self._ctx.items() if now - t < 3600}
        return ctx

    # ------------------------------------------------------------------ sessions
    def start(self, user_id: str | None, lights: list[str]) -> Session:
        if len(self.sessions) >= MAX_SESSIONS:
            raise OverflowError
        s = Session(secrets.token_hex(8), user_id, list(dict.fromkeys(lights))[:MAX_LIGHTS])
        self.sessions[s.id] = s
        self._arm(s)
        return s

    def get(self, sid: str, user_id: str | None) -> Session | None:
        s = self.sessions.get(sid)
        return s if s and s.user_id == user_id else None

    def _arm(self, s: Session) -> None:
        s.last = time.time()
        if s.timer:
            s.timer()

        @callback
        def idle(_now: Any) -> None:
            s.timer = None
            if s.id in self.sessions:
                _LOGGER.debug("Live preview %s ended by itself (no update for %s s)", s.id, IDLE)
                self.hass.async_create_task(self.stop(s.id, restore=True))

        s.timer = async_call_later(self.hass, IDLE, idle)

    def keep(self, s: Session) -> None:
        self._arm(s)

    async def apply(self, s: Session, settings: dict[str, dict[str, Any]]) -> list[str]:
        """Show these settings now (lamp → light setting); returns the lamps that failed."""
        self._arm(s)
        calls: list[tuple[str, str, str, dict[str, Any]]] = []
        async with s.lock:
            if s.id not in self.sessions:
                return []
            for e, raw in settings.items():
                if e not in s.lights:
                    continue
                spec = lightspec.clean_action({"color": "none", **raw})  # no colour given: keep the lamp's
                if spec.get("mode") == "scene":
                    continue
                st = self.hass.states.get(e)
                if st is None or st.state in ("unavailable", "unknown"):
                    continue
                if spec["mode"] == "off":
                    call = ("light", "turn_off", e, {})
                else:
                    # as the rules would send it (with the lamp's correction) – while calibrating ("raw") exactly as given
                    data = lightspec.service_data(st.attributes, spec if raw.get("raw") else self.core.lightcal.adjust(e, spec))
                    data.pop("transition", None)
                    data.pop("flash", None)
                    call = ("light", "turn_on", e, data)
                key = repr(call)
                if s.sent.get(e) == key:
                    continue
                s.sent[e] = key
                if e not in s.before:
                    s.before[e] = (st.state, dict(st.attributes))
                self._held[e] = float("inf")
                calls.append(call)
            if not calls:
                return []
            failed: list[str] = []
            for ids, err in await call_together(self.hass, calls, self._context()):
                if err:
                    failed.extend(ids)
                    for e in ids:
                        s.sent.pop(e, None)
                    _LOGGER.debug("Live preview %s: %s", ", ".join(ids), err)
            return failed

    def _back(self, e: str, state: str, attrs: dict[str, Any]) -> tuple[str, str, str, dict[str, Any]] | None:
        """The call that puts a lamp back the way it was (lightspec.snapshot: colour mode and colour exactly)."""
        if state == "off":
            return ("light", "turn_off", e, {})
        if state != "on":
            return None
        cur = self.hass.states.get(e)
        if cur is None or cur.state in ("unavailable", "unknown"):
            return None
        data = lightspec.service_data(attrs, lightspec.snapshot(state, attrs))
        data.pop("transition", None)
        # an effect the preview started ends with the lamp's own "no effect" entry
        eff = attrs.get("effect")
        if "effect" not in data and isinstance(eff, str) and eff in _NO_EFFECT and eff in (attrs.get("effect_list") or []):
            data["effect"] = eff
        return ("light", "turn_on", e, data)

    async def stop(self, sid: str, *, restore: bool = True) -> None:
        s = self.sessions.pop(sid, None)
        if s is None:
            return
        if s.timer:
            s.timer()
            s.timer = None
        if s.detach:
            s.detach()
            s.detach = None
        async with s.lock:
            touched = list(s.before)
            until = time.time() + GRACE
            for e in touched:
                # another session may still run on the lamp
                if not any(e in o.before for o in self.sessions.values()):
                    self._held[e] = until
            if restore:
                calls = [c for e, (state, attrs) in s.before.items() if (c := self._back(e, state, attrs))]
                if calls:
                    for ids, err in await call_together(self.hass, calls, self._context()):
                        if err:
                            _LOGGER.warning("Live preview: %s not put back: %s", ", ".join(ids), err)
            elif touched:
                # left as shown: for the light plan like a change by hand (nothing is learned from it)
                self.core.lightplan.mark_manual(touched)
        if touched:
            self.hass.loop.call_later(GRACE + 0.5, self.core.lightplan.schedule_all)

    async def stop_all(self) -> None:
        for sid in list(self.sessions):
            await self.stop(sid, restore=True)
