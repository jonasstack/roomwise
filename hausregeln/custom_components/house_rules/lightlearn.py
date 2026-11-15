"""Intelligent light (Licht → Raum → "Intelligent"): learns per room what the residents like and does it by itself.

Learning: every time a person changes a light of the room (app, wall switch, voice), the setting counts as one
example: when (time of day, workday or weekend), on or off, brightness, white tone, how many residents are home and
how bright it is outside (the room's light sensor, else the sun). Quick corrections within 20 seconds replace the
previous example; switching off right before leaving the room (the room is empty within two minutes) does not
count. Kept per light as a short list (the newest 150 examples), only in this Home Assistant (storage key
house_rules.light_learn), never sent anywhere.

Deciding (only while someone is in the room): every light gets what was set at a similar time in a similar
situation (examples weighted by closeness in time of day, age, daylight, company and weekday) blended with the
room's starting values per time of day (from the assistant). Few examples: mostly the starting values; many:
mostly what was learned. It only switches off what it switched on itself, and changes a light it already set
only on a clear difference (no creeping every minute).

Guardrails always win over what was learned: never brighter than …, at night ("nachts" of the house) at most … %
and only warm white, stay off while … (conditions, e.g. the TV runs). The room's own light rules are hard rules on
top: the planner gives the intelligent part only the lights no rule decided right now.

Shadow first: in "Probelauf" (mode "shadow") nothing is switched; the light view shows "so hätte ich geschaltet"
and how often that matched what the people then did by hand. Mode "on" acts.
"""

from __future__ import annotations

import math
import time
from typing import TYPE_CHECKING, Any

from homeassistant.const import STATE_ON
from homeassistant.core import HomeAssistant, State
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import STORAGE_KEY_LIGHT, STORAGE_VERSION

if TYPE_CHECKING:
    from .core import HouseRules

KEEP = 150  # examples per light
MERGE_S = 20  # a new change within this time replaces the previous example (dimming in steps, not on ↔ off)
LEAVE_S = 120  # "off" and the room empty within this time: leaving, not a wish
HALF_LIFE_DAYS = 30
SIGMA_MIN = 75  # how far in time of day an example still counts (gaussian)
PRIOR = 1.5  # weight of the starting values against the examples
SLOT_IDS = ("morning", "day", "evening", "late", "night")
SLOT_LABELS = {"morning": "morgens", "day": "tagsüber", "evening": "abends", "late": "spätabends", "night": "nachts"}
COLOR_K = {"kerze": 2200, "warm": 2700, "neutral": 4000, "kalt": 5500}
WARM_K = 2700


def default_slots() -> list[dict[str, Any]]:
    return [
        {"id": "morning", "from": "06:00", "brightness": 70, "color": "neutral"},
        {"id": "day", "from": "10:00", "brightness": 100, "color": "neutral"},
        {"id": "evening", "from": "18:00", "brightness": 80, "color": "warm"},
        {"id": "late", "from": "21:30", "brightness": 45, "color": "warm"},
        {"id": "night", "from": "23:30", "brightness": 10, "color": "kerze"},
    ]


def default_smart() -> dict[str, Any]:
    return {
        "mode": "off",  # off | shadow ("Probelauf": only shows what it would do) | on
        "lights": [],  # empty = all lights of the room
        "only_dark": True,  # only on when the room is dark (light sensor, else the sun)
        "slots": default_slots(),  # starting values per time of day
        "guards": {"max": 100, "night_max": 30, "night_warm": True, "off_while": []},
    }


def _hm(s: Any) -> int | None:
    try:
        h, m = str(s).split(":")[:2]
        return (int(h) % 24) * 60 + int(m) % 60
    except (ValueError, AttributeError):
        return None


def _num(v: Any, d: float, lo: float, hi: float) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return d


def kelvin_of(color: Any) -> int | None:
    s = str(color or "")
    if s in COLOR_K:
        return COLOR_K[s]
    if s.startswith("k:") and s[2:].isdigit():
        return max(1500, min(9000, int(s[2:])))
    return None


def color_ok(v: Any) -> bool:
    s = str(v or "")
    return s in COLOR_K or (s.startswith("k:") and s[2:].isdigit() and len(s) == 6)


def clean_smart(raw: Any, cur: dict[str, Any], sanitize: Any) -> dict[str, Any]:
    """Sanitised smart settings of a room (raw from the panel, cur = what is stored)."""
    if not isinstance(raw, dict):
        return cur
    out = {**default_smart(), **cur}
    if raw.get("mode") in ("off", "shadow", "on"):
        out["mode"] = raw["mode"]
    if isinstance(raw.get("lights"), list):
        out["lights"] = [e for e in raw["lights"] if isinstance(e, str) and e.startswith("light.")][:40]
    if isinstance(raw.get("only_dark"), bool):
        out["only_dark"] = raw["only_dark"]
    if isinstance(raw.get("slots"), list):
        by_id = {s.get("id"): s for s in raw["slots"] if isinstance(s, dict)}
        slots = []
        for d in default_slots():
            s = {**d, **next((x for x in out["slots"] if x.get("id") == d["id"]), {})}
            src = by_id.get(d["id"]) or {}
            if _hm(src.get("from")) is not None:
                m = _hm(src["from"]) or 0
                s["from"] = f"{m // 60:02d}:{m % 60:02d}"
            if "brightness" in src:
                s["brightness"] = int(_num(src["brightness"], d["brightness"], 1, 100))
            if color_ok(src.get("color")):
                s["color"] = str(src["color"])
            slots.append(s)
        out["slots"] = slots
    if isinstance(g := raw.get("guards"), dict):
        cg = {**default_smart()["guards"], **out.get("guards", {})}
        out["guards"] = {
            "max": int(_num(g.get("max", cg["max"]), 100, 5, 100)),
            "night_max": int(_num(g.get("night_max", cg["night_max"]), 30, 1, 100)),
            "night_warm": bool(g.get("night_warm", cg["night_warm"])),
            "off_while": [c for c in (sanitize(x) for x in (g.get("off_while") if isinstance(g.get("off_while"), list) else cg["off_while"])[:10]) if c],
        }
    return out


class LightLearner:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY_LIGHT)
        self.data: dict[str, Any] = {"rooms": {}}

    async def async_load(self) -> None:
        self.data = (await self._store.async_load()) or {"rooms": {}}
        self.data.setdefault("rooms", {})

    async def async_save_now(self) -> None:
        await self._store.async_save(self.data)

    def _save(self) -> None:
        self._store.async_delay_save(lambda: self.data, 60)

    def _room(self, rid: str) -> dict[str, Any]:
        r = self.data["rooms"].setdefault(rid, {})
        r.setdefault("lights", {})
        r.setdefault("agree", [])
        return r

    def forget(self, rid: str) -> None:
        self.data["rooms"].pop(rid, None)
        self._save()

    # ------------------------------------------------------------------ situation
    def people_home(self) -> int:
        return sum(1 for p in self.core.residents() if p["counts"] and p["state"] == "home")

    def daylight(self, rid: str) -> int:
        """0 dark, 1 dusk, 2 bright: from the room's light sensor, else the sun's elevation."""
        room = self.core.rooms.get(rid) or {}
        st = self.hass.states.get(room["lux"]) if room.get("lux") else None
        try:
            lux = float(st.state) if st else None
        except ValueError:
            lux = None
        if lux is not None:
            limit = float(room.get("dark_below") or 80)
            return 0 if lux < limit else 1 if lux < 4 * limit else 2
        sun = self.hass.states.get("sun.sun")
        elev = sun.attributes.get("elevation") if sun else None
        if isinstance(elev, (int, float)):
            return 0 if elev < -2 else 1 if elev < 8 else 2
        return 0 if sun and sun.state == "below_horizon" else 2

    # ------------------------------------------------------------------ learning
    @staticmethod
    def setting(st: State | None) -> tuple[int, int, int]:
        """(on, brightness %, kelvin or 0) of a light state."""
        if st is None or st.state != STATE_ON:
            return 0, 0, 0
        b = st.attributes.get("brightness")
        bri = max(1, round(float(b) / 2.55)) if isinstance(b, (int, float)) else 100
        k = st.attributes.get("color_temp_kelvin") if st.attributes.get("color_mode") in ("color_temp", None) else None
        return 1, bri, int(k) if isinstance(k, (int, float)) else 0

    def observe(self, rid: str, eid: str, st: State | None, wanted: dict[str, Any] | None) -> None:
        """A person changed a light of a room with intelligent light: one example (and how it compares with
        what the intelligent part wanted at that moment)."""
        on, bri, k = self.setting(st)
        now = time.time()
        t = int(now)
        room = self._room(rid)
        lst = room["lights"].setdefault(eid, [])
        local = dt_util.now()
        # [seconds since epoch, minute of the day, weekend, on, brightness %, kelvin, residents home, daylight 0–2]
        sample = [t, local.hour * 60 + local.minute, int(local.weekday() >= 5), on, bri, k, self.people_home(), self.daylight(rid)]
        # dimming in steps is one wish; switching off right after setting it is another (e.g. leaving, see room_left)
        if lst and t - lst[-1][0] <= MERGE_S and lst[-1][3] == on:
            lst[-1] = sample
            if room["agree"] and room["agree"][-1][2] == eid:
                room["agree"].pop()
        else:
            lst.append(sample)
        del lst[:-KEEP]
        if wanted is not None:
            room["agree"].append([t, int(self.matches(wanted, on, bri, k)), eid])
            del room["agree"][:-40]
        self._save()

    @staticmethod
    def matches(wanted: dict[str, Any], on: int, bri: int, k: int) -> bool:
        if wanted.get("mode") != "on":
            return not on
        if not on:
            return False
        if abs(int(wanted.get("brightness") or 0) - bri) > 20:
            return False
        wk = int(wanted.get("kelvin") or 0)
        return not (wk and k and abs(wk - k) > 700)

    def room_left(self, rid: str) -> None:
        """The room became empty: "off" examples of the last two minutes were leaving, not a wish."""
        room = self.data["rooms"].get(rid)
        if not room:
            return
        cut = int(time.time() - LEAVE_S)
        changed = False
        for eid, lst in room["lights"].items():
            if lst and lst[-1][3] == 0 and lst[-1][0] >= cut:
                lst.pop()
                changed = True
                if room["agree"] and room["agree"][-1][2] == eid and room["agree"][-1][0] >= cut:
                    room["agree"].pop()
        if changed:
            self._save()

    # ------------------------------------------------------------------ estimating
    def _estimate(self, samples: list[list[int]], minute: int, weekend: int | None, people: int | None, daylight: int | None, span: tuple[int, int] | None = None) -> tuple[float, float, float, float, float]:
        """Weighted examples for a situation: (weight, weight on, Σ brightness·w, Σ kelvin·w, weight with kelvin).
        span (from, to in minutes of the day): every example inside counts fully instead of closeness to `minute`."""
        now_t = time.time()
        w_all = w_on = s_b = s_k = w_k = 0.0
        for t, m, we, on, bri, k, ppl, day in samples:
            if span is not None:
                a, b = span
                w = 1.0 if ((a <= m < b) if a < b else (m >= a or m < b)) else 0.0
            else:
                dm = abs(m - minute)
                dm = min(dm, 1440 - dm)
                w = math.exp(-0.5 * (dm / SIGMA_MIN) ** 2)
            w *= 0.5 ** ((now_t - t) / (HALF_LIFE_DAYS * 86400))
            if daylight is not None:
                w *= (1.0, 0.5, 0.25)[min(2, abs(day - daylight))]
            if people is not None:
                w *= 1.0 if (ppl > 1) == (people > 1) else 0.7
            if weekend is not None:
                w *= 1.0 if we == weekend else 0.8
            if w < 0.02:
                continue
            w_all += w
            if on:
                w_on += w
                s_b += w * bri
                if k:
                    s_k += w * k
                    w_k += w
        return w_all, w_on, s_b, s_k, w_k

    @staticmethod
    def slot_at(smart: dict[str, Any], minute: int) -> dict[str, Any]:
        slots = sorted(smart.get("slots") or default_slots(), key=lambda s: _hm(s.get("from")) or 0)
        cur = slots[-1]  # before the first start of the day: the last slot of yesterday
        for s in slots:
            if (_hm(s.get("from")) or 0) <= minute:
                cur = s
        return cur

    def scene(self, rid: str, eid: str, smart: dict[str, Any], minute: int, *, weekend: int | None, people: int | None, daylight: int | None, dark: bool | None, span: tuple[int, int] | None = None) -> dict[str, Any]:
        """What this light should be in this situation: {on, brightness, kelvin, learned (weight), slot, prior}."""
        slot = self.slot_at(smart, minute)
        prior_on = 1.0 if (dark is None or dark or not smart.get("only_dark", True)) else 0.0
        prior_b = float(slot.get("brightness") or 80)
        prior_k = float(kelvin_of(slot.get("color")) or WARM_K)
        samples = ((self.data["rooms"].get(rid) or {}).get("lights") or {}).get(eid) or []
        w, w_on, s_b, s_k, w_k = self._estimate(samples, minute, weekend, people, daylight, span)
        p_on = (PRIOR * prior_on + w_on) / (PRIOR + w)
        bri = (PRIOR * prior_b + s_b) / (PRIOR + w_on)
        k = (PRIOR * prior_k + s_k) / (PRIOR + w_k)
        return {
            "on": p_on >= 0.5,
            "p_on": round(p_on, 2),
            "brightness": int(max(1, min(100, 5 * round(bri / 5)))),
            "kelvin": int(100 * round(k / 100)),
            "learned": round(w, 1),
            "slot": slot["id"],
            "prior": {"brightness": int(prior_b), "kelvin": int(prior_k)},
        }

    # ------------------------------------------------------------------ deciding (called by the light planner)
    def decide(self, rid: str, smart: dict[str, Any], lights: list[str], state: dict[str, State | None], owned: set[str]) -> dict[str, dict[str, Any]]:
        """Per light while someone is in the room: {mode on/off/keep, brightness, color, kelvin, why: [...]}.
        Guardrails are applied last; "off" and small corrections only for lights it switched on itself (owned)."""
        checker = self.core.checker
        now = dt_util.now()
        minute = now.hour * 60 + now.minute
        weekend = int(now.weekday() >= 5)
        people = self.people_home()
        daylight = self.daylight(rid)
        dark = checker.holds({"subject": f"room:{rid}", "verb": "is_dark"}, rid, rid)[0]
        g = {**default_smart()["guards"], **(smart.get("guards") or {})}
        a, b = checker.window("night")
        night = checker._in_window(a, b, now)  # noqa: SLF001 — the house's own "nachts"
        off_by = next((c for c in g["off_while"] if checker.holds(c, rid, rid)[0]), None)
        out: dict[str, dict[str, Any]] = {}
        for e in lights:
            sc = self.scene(rid, e, smart, minute, weekend=weekend, people=people, daylight=daylight, dark=dark)
            label = SLOT_LABELS.get(sc["slot"], sc["slot"])
            n = round(sc["learned"])
            if n >= 1:
                why = [f"Gelernt: {label} hier meist {sc['brightness']} %, {sc['kelvin']} K (aus {n} Einstellungen von Hand)."]
            else:
                why = [f"Startwert für {label}: {sc['brightness']} %, {sc['kelvin']} K (noch nichts gelernt)."]
            want: dict[str, Any] = {"mode": "on", "brightness": sc["brightness"], "kelvin": sc["kelvin"]}
            if not sc["on"]:
                want = {"mode": "off"}
                why.append("Nicht dunkel genug." if not dark and smart.get("only_dark", True) and n < 1 else f"Um diese Zeit ist es hier meist aus ({round((1 - sc['p_on']) * 100)} %).")
            # guardrails win
            if off_by is not None:
                want = {"mode": "off"}
                why.append(f"Bleibt aus: {self.core.describer.clause(off_by, 'and')}.")
            if want["mode"] == "on":
                if want["brightness"] > g["max"]:
                    want["brightness"] = g["max"]
                    why.append(f"Begrenzt: nie heller als {g['max']} %.")
                if night and want["brightness"] > g["night_max"]:
                    want["brightness"] = g["night_max"]
                    why.append(f"Begrenzt: nachts höchstens {g['night_max']} %.")
                if night and g["night_warm"] and want["kelvin"] > WARM_K:
                    want["kelvin"] = WARM_K
                    why.append("Begrenzt: nachts nur warmweiß.")
                want["color"] = f"k:{want['kelvin']}"
            out[e] = {**want, "why": why}
            # what to really do: off only what it switched on itself; small differences are left alone
            st = state.get(e)
            on, cur_b, cur_k = self.setting(st)
            if want["mode"] == "off":
                act = "off" if on and e in owned else "keep"
            elif not on:
                act = "on"
            elif e not in owned:
                act = "keep"  # on by someone else: leave it (a person, a rule)
            else:
                over = cur_b > want["brightness"] + 3 or (night and g["night_warm"] and cur_k > WARM_K + 150)
                act = "on" if over or abs(cur_b - want["brightness"]) >= 10 or (cur_k and abs(cur_k - want["kelvin"]) >= 400) else "keep"
            out[e]["act"] = act
        return out

    # ------------------------------------------------------------------ view
    def agreement(self, rid: str) -> dict[str, int]:
        lst = (self.data["rooms"].get(rid) or {}).get("agree") or []
        return {"n": len(lst), "same": sum(1 for x in lst if x[1])}

    def samples(self, rid: str) -> int:
        return sum(len(v) for v in ((self.data["rooms"].get(rid) or {}).get("lights") or {}).values())

    def learned(self, rid: str, smart: dict[str, Any], lights: list[str]) -> dict[str, Any]:
        """Per time-of-day slot and light the learned scene (daylight and company not considered)."""
        slots = sorted(smart.get("slots") or default_slots(), key=lambda s: _hm(s.get("from")) or 0)
        out = []
        for i, s in enumerate(slots):
            a = _hm(s["from"]) or 0
            b = _hm(slots[(i + 1) % len(slots)]["from"]) or 0
            span = (b - a) % 1440 or 1440
            mid = (a + span // 2) % 1440
            per = {e: self.scene(rid, e, smart, mid, weekend=None, people=None, daylight=None, dark=None, span=(a, b)) for e in lights}
            out.append({"id": s["id"], "label": SLOT_LABELS.get(s["id"], s["id"]), "from": s["from"], "to": slots[(i + 1) % len(slots)]["from"], "lights": per})
        lights_data = (self.data["rooms"].get(rid) or {}).get("lights") or {}
        recent = sorted(({"entity_id": e, "at": x[0], "on": bool(x[3]), "brightness": x[4], "kelvin": x[5]} for e, lst in lights_data.items() for x in lst[-5:]), key=lambda r: -r["at"])[:5]
        return {"slots": out, "samples": self.samples(rid), "agree": self.agreement(rid), "recent": recent}
