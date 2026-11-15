"""Plans per room for the tabs "Licht" and "Heizung": the snapshot part and saving.

Light is a controller of its own (lightplan.py), heating too (heating.py, since 2026-10-25; before it was a set
of ordinary rules "p_heat_…"). This module puts both into the snapshot, saves them and keeps the habit
suggestion for heating times (occupied times of the last two weeks from the recorder).
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from . import heat_model as hm
from .i18n import tr

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

DAYS = ("all", "workdays", "weekend")


class Plans:
    def __init__(self, core: HouseRules) -> None:
        self.core = core

    # ------------------------------------------------------------------ data
    @property
    def data(self) -> dict[str, dict[str, Any]]:
        d = self.core.data.setdefault("plans", {})
        d.setdefault("light", {})
        d.setdefault("heat", {})
        return d

    def heat(self, rid: str) -> dict[str, Any]:
        return self.core.heating.room(rid)

    def view(self) -> dict[str, Any]:
        lp = self.core.lightplan.view()
        h = self.core.heating
        return {
            "light": lp["plans"],
            # when the Reinschau-Licht may glow (one setting for every room)
            "glow": lp["glow"],
            "heat": h.rooms_view(),
            "heating": h.global_view(),
            "now": {rid: {"light": lp["now"].get(rid), "heat": h.status(rid) or self._heat_now(rid)} for rid in self.core.rooms},
        }

    def _heat_now(self, rid: str) -> dict[str, Any]:
        t = self.heat_target(rid)
        return {"temp": t["temp"], "why": t["why"], "line": "", "mode": "hands_off", "level": "off"}

    def save(self, kind: str, rid: str, raw: dict[str, Any]) -> None:
        if kind == "light":
            self.core.lightplan.save(rid, raw)
            return
        if kind != "heat":
            raise ValueError("Unbekannter Plan")
        self.core.heating.save_room(rid, raw)

    def _day_ok(self, days: str, now: Any) -> bool:
        if days == "all":
            return True
        wd = self.core.checker._workday(now)  # noqa: SLF001 — same rule as "werktags" in sentences
        return wd if days == "workdays" else not wd

    def heat_target(self, rid: str, preheat: bool = False) -> dict[str, Any]:
        """Wanted temperature of a room's heating plan now: {temp, why} (also for rules "nach Heizplan")."""
        return self.core.heating.target(rid, preheat)

    def plan_on(self, kind: str, rid: str) -> bool:
        return bool(self.data[kind].get(rid, {}).get("on"))

    def rules(self) -> list[dict[str, Any]]:
        """No rules any more: light and heating are controllers (kept for core.all_rules)."""
        return []

    # ------------------------------------------------------------------ habits
    async def habits(self, rid: str) -> dict[str, Any]:
        """Suggested heating windows from when the room was occupied in the last 14 days (recorder history)."""
        room = self.core.rooms.get(rid)
        if not room:
            raise ValueError("Unbekannter Raum")
        sensors = [*room["presence"], *room["motion"], *room["zones"]]
        if not sensors:
            return {"windows": [], "note": "Der Raum hat keine Anwesenheits- oder Bewegungsmelder."}
        try:
            from homeassistant.components.recorder import get_instance, history  # noqa: PLC0415
        except ImportError:
            return {"windows": [], "note": "Ohne Verlauf (Recorder) gibt es keine Gewohnheiten."}
        end = dt_util.utcnow()
        start = end - timedelta(days=14)
        hass = self.core.hass
        try:
            states = await get_instance(hass).async_add_executor_job(history.get_significant_states, hass, start, end, sensors, None, True, True, False, True)
        except Exception as err:  # noqa: BLE001 — no history is not an error for the user
            _LOGGER.debug("habits: %s", err)
            return {"windows": [], "note": "Der Verlauf konnte nicht gelesen werden."}
        # occupied intervals (union of all sensors)
        intervals: list[tuple[float, float]] = []
        for eid in sensors:
            seq = states.get(eid) or []
            on_since: float | None = None
            for st in seq:
                t = st.last_changed.timestamp()
                if st.state == "on" and on_since is None:
                    on_since = t
                elif st.state != "on" and on_since is not None:
                    intervals.append((on_since, t))
                    on_since = None
            if on_since is not None:
                intervals.append((on_since, end.timestamp()))
        if not intervals:
            return {"windows": [], "note": "In den letzten 14 Tagen war der Raum nie belegt."}
        slot = 15 * 60
        out = []
        for days in ("workdays", "weekend"):
            counts = [0] * 96
            ndays = 0
            for d in range(14):
                day = dt_util.start_of_local_day(dt_util.now() - timedelta(days=d + 1))
                if self._day_ok(days, day) is False:
                    continue
                ndays += 1
                base = day.timestamp()
                for i in range(96):
                    a, b = base + i * slot, base + (i + 1) * slot
                    if any(x < b and y > a for x, y in intervals):
                        counts[i] += 1
            if not ndays:
                continue
            # real occupancy peaks only (the same rules as the smart heating): a bathroom with visits all day long
            # gets its morning and evening routine, never one window from early morning to late evening; preheating
            # before the window is the time plan's job ("Vorheizen", with the room's heat-up rate)
            probs = [c / ndays for c in counts]
            heating = self.core.heating
            p = heating.room(rid)
            m = heating.smart.model(rid)
            tout = heating.outside()
            comfort = float(p["temps"]["comfort"])
            lead = m.lead(float(p["temps"]["base"]), comfort, tout if tout is not None else 5.0)
            for w in hm.use_windows(probs, ndays, heating.smart.kind(rid), lead):
                a, b = w["a"] * 15, min(24 * 60 - 1, w["z"] * 15)
                out.append({"from": f"{a // 60:02d}:{a % 60:02d}", "to": f"{b // 60:02d}:{b % 60:02d}", "days": days, "temp": comfort, "level": "comfort"})
        if not out:
            return {"windows": [], "note": tr(self.core, "heat.habits_none", n=hm.MIN_DAYS)}
        return {"windows": out[:10], "note": tr(self.core, "heat.habits_found", n=len(intervals))}
