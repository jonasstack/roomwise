"""Small, robust maths for the smart heating (no Home Assistant imports, so it can be tested on its own).

Room heat model (first order, one per room):
    dT/dt = k_h · u − (k_l + k_d · door + k_w · window) · (T − T_out)
  k_l: how fast the room loses heat to the outside (1/h), k_h: how fast the radiator heats the room with the
  valve fully open (°C/h), u: valve opening 0…1, door / window: the share of the time a door to the rest of the
  home / a window of the room was open (0…1); k_d, k_w: the extra loss through them (1/h; k_d may be negative when
  the door leads to a warmer room). All of them are learned with scalar recursive least squares (with forgetting,
  so the model follows the seasons) from intervals of real room temperatures, starting from the building prior
  (so the very first interval already moves them); samples that make no physical sense are thrown away and the
  estimates stay inside sanity bounds.

Also here: heating styles (Komfort / Eco / Sportlich), the "is a setback worth it" calculation, guardrails,
the setpoint ramp and the PI valve controller (gains from the model, feed-forward learned per outside
temperature).
"""

from __future__ import annotations

import math
import re
from typing import Any

# ---------------------------------------------------------------------------------------------- styles
# threshold: occupancy probability from which a slot counts as "someone is there"
# margin / early: how early to start preheating (factor on the computed heat-up time, plus minutes)
# late: minutes the room may still be warming up after the use began (accepts a slower heat-up, saves preheating)
# depth: how deep to set back (°C below comfort, limited by the guardrail "max. absenken")
# worth_kh: a setback has to save at least this many degree-hours, else comfort is kept
# uncertain: °C below comfort while the learned occupancy is still unsure (confidence below 0.5)
# step / minutes: default setpoint ramp when warming up (0 = jump right away)
# umax: largest valve opening (%) with direct valve control (a thermostat valve passes most of its flow in the first
#   half of its travel: wider only pushes heat into the room faster and overshoots); also the opening preheating is
#   planned with, so it starts earlier and gentler; lam: closed-loop time (h) of the valve controller
# deadband / gap: valve commands only for a change of at least deadband % and at most every gap minutes
# boost: °C above the target while the room is still far too cold (heats faster)
# Since style version 2 "Komfort" is what used to be "Eco"; the new "Eco" saves clearly more.
STYLES: dict[str, dict[str, Any]] = {
    "comfort": {"label": "Komfort", "threshold": 0.5, "margin": 1.0, "early": 0, "late": 0, "depth": 4.0, "worth_kh": 1.0, "uncertain": 0.0, "step": 0.5, "minutes": 15, "umax": 55, "lam": 1.0, "deadband": 8, "gap": 15, "boost": 0.0},
    "eco": {"label": "Eco", "threshold": 0.65, "margin": 0.9, "early": 0, "late": 20, "depth": 6.0, "worth_kh": 0.5, "uncertain": 1.0, "step": 0.5, "minutes": 20, "umax": 45, "lam": 1.25, "deadband": 10, "gap": 20, "boost": 0.0},
    "sport": {"label": "Sportlich", "threshold": 0.4, "margin": 0.9, "early": 0, "late": 0, "depth": 3.0, "worth_kh": 1.5, "uncertain": 0.0, "step": 0.0, "minutes": 0, "umax": 85, "lam": 0.5, "deadband": 4, "gap": 5, "boost": 1.0},
}
STYLE_VERSION = 2


def migrate_style(name: Any, version: Any) -> str:
    """Style of a room saved before the re-scaling: the old "Eco" behaviour is now called "Komfort"."""
    if version != STYLE_VERSION and name == "eco":
        return "comfort"
    return name if name in STYLES else "comfort"


# ---------------------------------------------------------------------------------------------- building inertia
# Prior for the room model until it has learned enough (and for the time plan's preheating): how fast a room heats
# up with the valve fully open (k_h, °C/h), how fast it loses heat (k_l, 1/h) and how long it takes until the room
# temperature reacts at all (lag, h: heavy walls, the screed of a floor heating).
BUILDINGS: dict[str, dict[str, float]] = {
    "unknown": {"k_h": 2.5, "k_l": 0.06, "lag": 0.15},
    "old": {"k_h": 1.6, "k_l": 0.04, "lag": 0.5},
    "partial": {"k_h": 2.0, "k_l": 0.045, "lag": 0.3},
    "new": {"k_h": 2.6, "k_l": 0.035, "lag": 0.2},
    "passive": {"k_h": 1.0, "k_l": 0.012, "lag": 0.3},
    "floor": {"k_h": 0.6, "k_l": 0.015, "lag": 1.5},
}
LEARNED_N = 6  # good samples after which the learned model counts fully


def building(name: Any) -> dict[str, float]:
    return BUILDINGS.get(str(name or ""), BUILDINGS["unknown"])

K_L = (0.005, 0.6)
K_H = (0.2, 12.0)
K_D = (-0.2, 0.6)  # an open door to a warmer room may even bring heat in
K_W = (0.0, 8.0)
DEFAULT_KL = 0.06
# extra loss with an open window until learned (1/h): a window tilted or briefly wide open, about 1 °C in 10 min
# at 15 °C difference to the outside
PRIOR_KW = 0.4


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def style(name: str | None) -> dict[str, Any]:
    return STYLES.get(name or "", STYLES["comfort"])


# ---------------------------------------------------------------------------------------------- estimator
class Rls1:
    """Scalar recursive least squares y = θ·x with forgetting factor and bounds."""

    def __init__(self, theta: float, p: float = 1.0, n: int = 0, lam: float = 0.97, lo: float = -1e9, hi: float = 1e9) -> None:
        self.theta, self.p, self.n, self.lam, self.lo, self.hi = theta, p, n, lam, lo, hi

    def add(self, x: float, y: float) -> None:
        if not (math.isfinite(x) and math.isfinite(y)) or abs(x) < 1e-6:
            return
        k = self.p * x / (self.lam + x * self.p * x)
        self.theta = clamp(self.theta + k * (y - self.theta * x), self.lo, self.hi)
        # keep the covariance from collapsing or exploding (robust against long quiet periods)
        self.p = clamp((self.p - k * x * self.p) / self.lam, 1e-4, 10.0)
        self.n += 1


class RoomModel:
    """Learned heat-up / cool-down behaviour of one room.

    Until a direction has LEARNED_N good samples, its value is blended with the building prior (building type,
    BUILDINGS), so a floor heating starts with a long lead time instead of the radiator default. The lag (time
    until the room reacts) comes from the prior only.
    """

    def __init__(self, k_l: float = DEFAULT_KL, k_h: float = 2.5, n_c: int = 0, n_h: int = 0, p_c: float = 0.05, p_h: float = 1.0, prior: dict[str, float] | None = None, extra: dict[str, Any] | None = None) -> None:
        # built with explicit values (no prior): those values are the prior
        self.prior = prior or {"k_l": k_l, "k_h": k_h, "lag": BUILDINGS["unknown"]["lag"]}
        self.cool = Rls1(clamp(k_l, *K_L), p_c, n_c, 0.98, *K_L)
        self.heat = Rls1(clamp(k_h, *K_H), p_h, n_h, 0.97, *K_H)
        x = extra or {}
        # door and window: no blending with a prior, a small start covariance keeps single samples from jumping
        self.door = Rls1(clamp(float(x.get("k_d", 0.0)), *K_D), float(x.get("p_d", 0.004)), int(x.get("n_d", 0)), 0.98, *K_D)
        self.win = Rls1(clamp(float(x.get("k_w", PRIOR_KW)), *K_W), float(x.get("p_w", 0.004)), int(x.get("n_w", 0)), 0.95, *K_W)

    # -------------------------------------------------------------- persistence
    @classmethod
    def from_dict(cls, d: dict[str, Any] | None, rate: float | None = None, prior: dict[str, float] | None = None) -> RoomModel:
        pr = prior or BUILDINGS["unknown"]
        if not d:
            # warm start from the simple learned heat-up rate (°C/h at about 20 °C inside, 5 °C outside)
            k_h = (rate + pr["k_l"] * 15) if rate else pr["k_h"]
            return cls(pr["k_l"], k_h, prior=pr)
        try:
            return cls(float(d["k_l"]), float(d["k_h"]), int(d.get("n_c", 0)), int(d.get("n_h", 0)), float(d.get("p_c", 0.05)), float(d.get("p_h", 1.0)), prior=pr, extra=d)
        except (KeyError, TypeError, ValueError):
            return cls(pr["k_l"], pr["k_h"], prior=pr)

    def to_dict(self) -> dict[str, Any]:
        return {
            "k_l": round(self.cool.theta, 4),
            "k_h": round(self.heat.theta, 3),
            "n_c": self.cool.n,
            "n_h": self.heat.n,
            "p_c": round(self.cool.p, 5),
            "p_h": round(self.heat.p, 4),
            "k_d": round(self.door.theta, 4),
            "n_d": self.door.n,
            "p_d": round(self.door.p, 5),
            "k_w": round(self.win.theta, 4),
            "n_w": self.win.n,
            "p_w": round(self.win.p, 5),
        }

    @staticmethod
    def _blend(learned: float, n: int, prior: float) -> float:
        w = min(1.0, n / LEARNED_N)
        return w * learned + (1 - w) * prior

    @property
    def k_l(self) -> float:
        return self._blend(self.cool.theta, self.cool.n, self.prior["k_l"])

    @property
    def k_h(self) -> float:
        return self._blend(self.heat.theta, self.heat.n, self.prior["k_h"])

    @property
    def k_d(self) -> float:
        return self.door.theta

    @property
    def k_w(self) -> float:
        return self.win.theta

    def loss(self, door: float = 0.0, window: float = 0.0) -> float:
        """Total loss rate (1/h) with a door / a window open for that share of the time."""
        return max(K_L[0], self.k_l + self.k_d * clamp(door, 0, 1) + self.k_w * clamp(window, 0, 1))

    @property
    def lag(self) -> float:
        return float(self.prior.get("lag", 0.15))

    @property
    def inert(self) -> bool:
        """A very slow room (floor heating, passive house): short setbacks are never worth it."""
        return self.lag >= 1.0 or self.k_l <= 0.02

    @property
    def confidence(self) -> float:
        """0…1: how many good samples back the model."""
        return round(0.5 * min(1.0, self.cool.n / 6) + 0.5 * min(1.0, self.heat.n / 6), 2)

    # -------------------------------------------------------------- learning
    def add_interval(self, t0: float, t1: float, temp0: float, temp1: float, u: float, tout: float, door: float = 0.0, window: float = 0.0) -> str | None:
        """One interval of the room (times in hours, mean valve u, mean outside temperature, share of the time a door
        to the rest of the home / a window was open). Returns what was learned: cool | heat | door | window | None.

        A window interval (open most of the time) may be short – an airing takes minutes – and teaches the extra
        loss of the open window; an interval with the window partly open teaches nothing. A door interval (door
        open at least 30 % of the time, valve closed) teaches the extra loss through the door; heat-up intervals
        take the door into account, cool-down intervals with the door (nearly) closed teach the room itself."""
        dt = t1 - t0
        tm = (temp0 + temp1) / 2
        x = tm - tout
        if not (0 <= tm <= 40) or dt > 6:
            return None
        if window >= 0.8:
            if dt < 1 / 15:
                return None
            rate = (temp1 - temp0) / dt
            if abs(rate) > 40 or x < 3:
                return None
            # whatever the valve and the door did, the rest of the loss is the window's
            y = self.k_h * u - self.loss(door) * x - rate
            self.win.add(x, max(0.0, y))
            return "window"
        if window > 0.05 or dt < 1 / 6:
            return None
        rate = (temp1 - temp0) / dt
        if abs(rate) > 12:
            return None
        if u <= 0.03:
            if x < 3 or rate > 0.2:  # too warm outside to learn anything, or warming without heat (sun, people)
                return None
            if door >= 0.3:
                self.door.add(door * x, -rate - self.k_l * x)
                return "door"
            if door > 0.1:
                return None
            self.cool.add(x, max(0.0, -rate))
            return "cool"
        if u >= 0.15:
            y = rate + self.loss(door) * x
            if y <= 0:
                return None  # valve open but the room cools fast: radiator cold, window open … not the room
            self.heat.add(u, y)
            return "heat"
        return None

    # -------------------------------------------------------------- predictions
    def rate(self, temp: float, tout: float, u: float = 1.0, door: float = 0.0, window: float = 0.0) -> float:
        return self.k_h * u - self.loss(door, window) * (temp - tout)

    def heat_time(self, t0: float, t1: float, tout: float, u: float = 1.0) -> float:
        """Hours to heat from t0 to t1 (24 if it cannot get there)."""
        if t0 >= t1:
            return 0.0
        inf = tout + self.k_h * max(0.05, u) / self.k_l
        if t1 >= inf - 0.05:
            return 24.0
        return min(24.0, math.log((inf - t0) / (inf - t1)) / self.k_l)

    def lead(self, t0: float, t1: float, tout: float, margin: float = 1.0, u: float = 1.0) -> float:
        """Hours from "start heating" to "warm" with the valve open `u`: the lag until the room reacts plus the
        heat-up time. When the room cannot get there with `u` (a cold day), it is planned with the valve fully open."""
        if t0 >= t1 - 0.05:
            return 0.0
        need = self.heat_time(t0, t1, tout, u)
        if need >= 24.0 and u < 1.0:
            need = self.heat_time(t0, t1, tout)
        return min(24.0, self.lag + need * margin)

    def cool_to(self, t0: float, tout: float, hours: float) -> float:
        """Temperature after cooling `hours` with the valve closed."""
        if t0 <= tout:
            return t0
        return tout + (t0 - tout) * math.exp(-self.k_l * hours)

    def steady_valve(self, target: float, tout: float, door: float = 0.0) -> float:
        """Valve opening (0…1) that holds `target` at `tout` (with a door open that share of the time)."""
        return clamp(self.loss(door) * (target - tout) / self.k_h, 0.0, 1.0)


# ---------------------------------------------------------------------------------------------- decisions
def setback_plan(m: RoomModel, comfort: float, setback: float, tout: float, absence_h: float, current: float | None = None, margin: float = 1.0, worth_kh: float = 1.0) -> dict[str, Any]:
    """Is setting back during an absence of `absence_h` hours worth it?

    The room cools with the valve closed (not below `setback`) and must be back at `comfort` when the absence
    ends, so reheating starts in time (lag of the room plus heat-up time). Saved = degree-hours below comfort
    (the heat a room loses is proportional to how warm it is, so fewer degree-hours = less energy); the lag phase
    counts only half (the heat goes into walls or screed first). Worth it when the room can drop by at least
    0.5 °C and the saving reaches `worth_kh`. Slow rooms (floor heating, passive house) rarely pass this.
    """
    start = comfort if current is None else min(comfort, current)
    out = {"worth": False, "low": round(start, 1), "saved_kh": 0.0, "reheat_h": 0.0, "off_h": 0.0, "absence_h": round(absence_h, 2), "why": ""}
    if setback >= comfort - 0.2:
        out.update(why="keine Absenkung eingestellt", code="none")
        return out
    if absence_h <= 0.25:
        out.update(why="zu kurz", code="short")
        return out
    step = 1 / 12
    best: tuple[float, float, float, float] | None = None  # off_h, low, reheat_h, saved
    t = 0.0
    saved_cool = 0.0
    temp = start
    while t <= absence_h + 1e-9:
        heat = m.heat_time(temp, comfort, tout) * margin
        lag = m.lag if temp < comfort - 0.05 else 0.0
        reheat = heat + lag
        if t + reheat <= absence_h:
            saved = saved_cool + (comfort - temp) * (heat / 2 + lag / 2)
            best = (t, temp, reheat, saved)
        nxt = max(setback, m.cool_to(temp, tout, step))
        saved_cool += (comfort - (temp + nxt) / 2) * step
        temp = nxt
        t += step
    if best is None:
        out["why"] = "Aufheizen dauert länger als die Pause"
        out["code"] = "too_slow"
        return out
    off_h, low, reheat, saved = best
    out.update(low=round(low, 1), saved_kh=round(saved, 2), reheat_h=round(reheat, 2), off_h=round(off_h, 2))
    drop = comfort - low  # time spent noticeably below comfort (a room that is cold already counts too)
    if drop < 0.5:
        out["why"] = "der Raum kühlt in der Zeit kaum ab"
        out["code"] = "no_drop"
    elif saved < worth_kh:
        out["why"] = "spart zu wenig"
        out["code"] = "too_little"
    else:
        out["worth"] = True
        out["why"] = "lohnt sich"
        out["code"] = "worth"
    if not out["worth"] and m.inert:
        out["inert"] = True
    return out


def apply_guards(temp: float, g: dict[str, Any], occupied: bool, minute: int) -> tuple[float, list[dict[str, Any]]]:
    """Guardrails always win over the smart logic: never-heat window, at least X with someone in the room,
    never above / below. Returns the temperature and what each guardrail changed."""
    out: list[dict[str, Any]] = []

    def change(key: str, new: float) -> None:
        nonlocal temp
        if abs(new - temp) >= 0.05:
            out.append({"guard": key, "wanted": round(temp, 1), "got": round(new, 1)})
            temp = new

    nv = g.get("never") or {}
    if nv.get("on") and in_window(minute, nv.get("from"), nv.get("to")) and temp > g["min"]:
        change("never", float(g["min"]))
    if occupied and g.get("occupied_min") is not None and temp < float(g["occupied_min"]):
        change("occupied", float(g["occupied_min"]))
    if temp > float(g["max"]):
        change("max", float(g["max"]))
    if temp < float(g["min"]):
        change("min", float(g["min"]))
    return temp, out


def hm(s: Any) -> int | None:
    try:
        h, m = str(s).split(":")[:2]
        return (int(h) % 24) * 60 + int(m) % 60
    except (ValueError, AttributeError):
        return None


def in_window(minute: int, a: Any, z: Any) -> bool:
    a0, z0 = hm(a), hm(z)
    if a0 is None or z0 is None or a0 == z0:
        return False
    return a0 <= minute < z0 if a0 < z0 else (minute >= a0 or minute < z0)


def ramp(prev: float | None, prev_t: float | None, target: float, now: float, step: float, minutes: float) -> float:
    """Setpoint ramp when warming up: at most `step` °C every `minutes` (times in seconds). Lower right away."""
    if prev is None or prev_t is None or step <= 0 or minutes <= 0 or target <= prev:
        return target
    steps = int((now - prev_t) // (minutes * 60))
    if steps <= 0:
        return prev
    return min(target, prev + steps * step)


def ramp_hours(delta: float, step: float, minutes: float) -> float:
    if step <= 0 or minutes <= 0 or delta <= 0:
        return 0.0
    return math.ceil(delta / step - 1e-9) * minutes / 60


# ---------------------------------------------------------------------------------------------- valve controller
def bucket(tout: float) -> str:
    """Outside temperature in 4 °C buckets: the learned feed-forward valve opening per bucket."""
    return str(int(math.floor(clamp(tout, -20, 24) / 4) * 4))


# the room temperature over the target that shuts the valve, and how long ahead the controller looks (h)
OVERSHOOT = 0.2
TREND_H = 0.5


class ValvePI:
    """PI controller for the room temperature through the valve opening (0…1).

    Gains from the room model (IMC tuning: Kp = 1/(k_h·λ), Ti = 1/k_l with the style's closed-loop time λ),
    feed-forward = the valve opening that held the room in the past at this outside temperature and door state
    (learned), else what the model says. Anti-windup at the limits. Acts from the first minute: the gains and the
    feed-forward come from the building prior until the room model has learned more.

    A radiator keeps heating after its valve closed and a room warms on for a while: the controller looks ahead by
    the room's lag (the temperature trend of the last half hour), so it closes before the target instead of after
    it. Warmer than the target by OVERSHOOT: the valve shuts and the learned opening for this weather comes down a
    little (it was too much). It learns the opening only while the room is steady at its target (not while it is
    still warming up – that opening would be too wide for holding the temperature).
    """

    def __init__(self, state: dict[str, Any] | None = None) -> None:
        s = state or {}
        self.i = float(s.get("i", 0.0))
        self.bias: dict[str, float] = {str(k): float(v) for k, v in (s.get("bias") or {}).items()}
        self.slope = float(s.get("s", 0.0))
        self.last: float | None = float(s["tp"]) if s.get("tp") is not None else None
        self.last_t: float | None = float(s["tt"]) if s.get("tt") is not None else None
        self.extra = float(s.get("x", 0.0))
        self.u_last = float(s.get("u", 0.0))

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"i": round(self.i, 4), "bias": {k: round(v, 3) for k, v in self.bias.items()}, "s": round(self.slope, 3), "x": round(self.extra, 3), "u": round(self.u_last, 3)}
        if self.last is not None:
            out["tp"] = round(self.last, 2)
        if self.last_t is not None:
            out["tt"] = round(self.last_t)
        return out

    def _trend(self, temp: float, dt_h: float, now: float | None) -> None:
        """Temperature trend (°C/h), smoothed over about half an hour (the sensor moves in 0.1 °C steps). `now`
        (seconds): the controller may have paused (window, by hand) – the trend then starts again."""
        if now is not None:
            if self.last_t is not None and now - self.last_t > 3600:
                self.last, self.slope = None, 0.0
            elif self.last_t is not None:
                dt_h = (now - self.last_t) / 3600
            self.last_t = now
        if self.last is not None and dt_h > 0:
            raw = clamp((temp - self.last) / dt_h, -10.0, 10.0)
            a = clamp(dt_h / (TREND_H + dt_h), 0.0, 1.0)
            self.slope += a * (raw - self.slope)
        self.last = temp

    def step(self, m: RoomModel, st: dict[str, Any], target: float, temp: float, tout: float, dt_h: float, door: float = 0.0, now: float | None = None) -> float:
        kp = clamp(1.0 / (m.k_h * st["lam"]), 0.05, 2.0)
        # the integral corrects what the feed-forward got wrong (people, sun, a door, a wrong learned opening) within
        # an hour or two – not within the room's cooling time (days in a well insulated room: it never corrected)
        ki = kp / clamp(1.0 + 2 * m.lag, 1.0, 3.0)
        self._trend(temp, dt_h, now)
        b0 = bucket(tout)
        # an open door needs its own feed-forward (key "4d"); until learned: the closed-door value plus what the model
        # says the door costs
        b = b0 + "d" if door >= 0.5 else b0
        ff = self.bias.get(b)
        if ff is None:
            ff = self.bias.get(b0, m.steady_valve(target, tout))
            if b != b0:
                ff = clamp(ff + m.steady_valve(target, tout, door) - m.steady_valve(target, tout), 0.0, 1.0)
        now_e = target - temp
        if now_e <= -OVERSHOOT:
            # too warm: shut; no integral pushing it open again later, the learned opening was too wide
            self.i = min(self.i, 0.0)
            if b in self.bias:
                # towards what the room model says holds the room (not to zero: the warmth of people and sun passes)
                floor = min(self.bias[b], m.steady_valve(target, tout, door))
                self.bias[b] = max(0.0, self.bias[b] - (self.bias[b] - floor) * 0.3 * clamp(dt_h, 0, 0.5))
            self.u_last = 0.0
            return 0.0
        # look ahead: where the room will be once what is in the radiator has arrived; a room that is cooling gets the
        # valve opened before it is too cold (half as far ahead: falling is slower to turn round than rising)
        hor = clamp(m.lag + 0.25, 0.25, 1.0)
        ahead = temp + self.slope * (hor if self.slope > 0 else hor / 2)
        e = target - ahead
        # the style's limit never keeps the room from holding its target on a cold day: the learned opening may need
        # more, and a room that stays clearly too cold although the valve is at the limit gets a little more every hour
        umax = max(st["umax"] / 100, min(1.0, ff * 1.25))
        h = clamp(dt_h, 0, 0.5)
        if now_e > 0.3 and self.slope < 0.3 and self.u_last >= umax + self.extra - 0.01:  # too cold, valve at the limit
            self.extra = min(1.0 - umax, self.extra + 0.4 * h)
        elif now_e < 0.1:
            self.extra = max(0.0, self.extra - 0.3 * h)
        umax = min(1.0, umax + self.extra)
        di = ki * e * h
        u = ff + kp * e + self.i + di
        if (u > umax and e > 0) or (u < 0 and e < 0):
            di = 0.0  # anti-windup: do not integrate further into the limit
        self.i = clamp(self.i + di, -1.0, 1.0)
        u = clamp(ff + kp * e + self.i, 0.0, umax)
        if now_e < 0:
            # already warmer than wanted: at most what holds the room, less the warmer it is (shut at OVERSHOOT)
            u = min(u, ff * (1 + now_e / OVERSHOOT))
        self.u_last = u
        if abs(now_e) < OVERSHOOT and abs(self.slope) < 0.15 and 0 < u < umax:
            # learn how far the valve must open at this outside temperature; move the integral the other way so u stays
            # slowly (a quarter per hour): the warmth of an evening with people and TV is no new opening for the weather
            old = self.bias.get(b, ff)
            new = old + min(0.05, 0.25 * h) * (u - old)
            self.bias[b] = new
            self.i = clamp(self.i - (new - old), -1.0, 1.0)
        return u


# ---------------------------------------------------------------------------------------------- usage windows
# Room kinds: a bathroom is used in short bursts (morning and evening routine), a hall is only passed through.
# threshold / lift: a quarter hour counts as "in use" when its probability reaches the threshold AND lies `lift`
#   above the room's usual background (the median of the day), so scattered short visits never add up to a window
# gap: gaps of up to this many quarter hours are closed; min / max: window length in quarter hours (a short-use
#   room never gets a comfort window longer than `max`, a longer busy stretch is cut to its strongest part)
# after: quarter hours it stays warm after the usual use; weight: how much being warm is worth (a cold bathroom
#   after the shower hurts more than a cool office); total: at most this many quarter hours per day
KINDS: dict[str, dict[str, float] | None] = {
    "normal": {"threshold": 0.5, "lift": 0.2, "gap": 2, "min": 4, "max": 64, "after": 0, "weight": 1.0, "total": 96},
    "short": {"threshold": 0.35, "lift": 0.25, "gap": 1, "min": 1, "max": 6, "after": 1, "weight": 2.0, "total": 16},
    "pass": None,
}
AIRING = {"threshold": 0.3, "lift": 0.15, "gap": 1, "min": 1, "max": 8, "after": 0, "weight": 1.0, "total": 24}
MIN_DAYS = 5  # learned days before a window counts (minimum confidence)
WORTH = 0.4  # value / cost of a comfort window at least this (value = probability × hours × weight, cost = hours + lead up to 1 h)
# ---------------------------------------------------------------------------------------------- room kind ("Raumart")
# Rooms are Home Assistant areas. Their kind is detected from (strongest first): the area's labels, its icon, its
# name, the devices in it, quick humidity rises (a shower) and the learned visits (only ever short ones). Parts of
# words on purpose: German compounds ("Gäste-WC", "Badezimmer", "Treppenhaus").
SHORT_NAME = ("bad", "bath", "dusch", "shower", "wc", "toilet", "klo", "restroom", "lavatory", "washroom", "powder room")
PASS_NAME = ("flur", "diele", "gang", "hall", "treppe", "eingang", "corridor", "stair", "entrance", "foyer", "windfang", "vorraum", "landing")
# a name that clearly says "a room to stay in": weaker hints (devices, humidity, visits) never change it
NORMAL_NAME = ("wohn", "schlaf", "küche", "kueche", "kitchen", "living", "bedroom", "büro", "buero", "office", "arbeit", "kinder", "esszimmer", "dining", "lounge")
# Material Design icons a user picks for an area in Home Assistant (exact names, "mdi:" prefix)
SHORT_ICONS = frozenset({"mdi:shower", "mdi:shower-head", "mdi:bathtub", "mdi:bathtub-outline", "mdi:toilet", "mdi:paper-roll", "mdi:paper-roll-outline", "mdi:human-male-female"})
PASS_ICONS = frozenset({"mdi:stairs", "mdi:stairs-up", "mdi:stairs-down", "mdi:stairs-box", "mdi:door", "mdi:door-open", "mdi:door-closed", "mdi:door-sliding", "mdi:door-sliding-open", "mdi:coat-rack"})
# labels may also name the kind itself
SHORT_LABEL = (*SHORT_NAME, "kurz genutzt", "short use", "nasszelle")
PASS_LABEL = (*PASS_NAME, "durchgang", "passage")
# devices in the room: a shower, a toilet, a towel radiator … (whole words where a part would mislead:
# "Spülmaschine" is no toilet flush, "Klo" not "Kloster")
SHORT_DEVICE = re.compile(r"dusch|shower|toilet|\bwc\b|\bklo\b|bidet|badewanne|bathtub|handtuch|towel|\bbad\b|badezimmer|bathroom|badlüfter|badluefter")
PASS_DEVICE = re.compile(r"treppe|stair")
KINDS_ORDER = ("normal", "short", "pass")
HUMID_RISE = 10.0  # %-points within HUMID_MINUTES …
HUMID_MINUTES = 15
HUMID_DAYS = 3  # … on at least this many different days: a shower or a bath
VISITS_MIN = 15  # learned visits before the usage pattern counts


def _word(text: str, words: tuple[str, ...]) -> str | None:
    t = (text or "").lower()
    return next((w for w in words if w in t), None)


def kind_by_name(name: str) -> str | None:
    """short | pass | normal (only when the name clearly says so) | None (nothing to go by)."""
    if _word(name, SHORT_NAME):
        return "short"
    if _word(name, PASS_NAME):
        return "pass"
    if _word(name, NORMAL_NAME):
        return "normal"
    return None


def kind_by_icon(icon: str | None) -> str | None:
    i = (icon or "").strip().lower()
    return "short" if i in SHORT_ICONS else "pass" if i in PASS_ICONS else None


def visit_stats(visits: list[list[float]]) -> dict[str, float] | None:
    """[[end time (s), minutes]] → {n, median, p90, per_day (minutes)} or None without enough visits."""
    mins = sorted(float(v[1]) for v in visits if isinstance(v, (list, tuple)) and len(v) == 2)
    if len(mins) < VISITS_MIN:
        return None
    ends = [float(v[0]) for v in visits]
    days = max(1.0, (max(ends) - min(ends)) / 86400)
    return {"n": len(mins), "median": mins[len(mins) // 2], "p90": mins[min(len(mins) - 1, int(len(mins) * 0.9))], "per_day": sum(mins) / days}


def kind_by_visits(visits: list[list[float]]) -> str | None:
    """Only ever short visits: a passage (a minute or two) or a short-use room (a quarter of an hour, a bath at most);
    a room people stay in has long visits or a lot of time per day."""
    st = visit_stats(visits)
    if not st:
        return None
    if st["median"] <= 2 and st["p90"] <= 6 and st["per_day"] <= 45:
        return "pass"
    if st["median"] <= 12 and st["p90"] <= 35 and st["per_day"] <= 90:
        return "short"
    return "normal"


def detect_room_kind(
    name: str,
    icon: str | None = None,
    labels: list[dict[str, str | None]] | None = None,
    devices: list[str] | None = None,
    humid_days: int = 0,
    visits: list[list[float]] | None = None,
) -> dict[str, str]:
    """The kind of a room and why: {kind: normal|short|pass, source: label|icon|name|devices|humidity|usage|default,
    detail: what matched}. `labels`: [{name, icon}] of the area; `devices`: names / entity ids in the area;
    `humid_days`: days with a quick humidity rise; `visits`: [[end time, minutes]] of the learned visits."""
    for lb in labels or []:
        nm = str(lb.get("name") or "")
        k = kind_by_icon(lb.get("icon")) or ("short" if _word(nm, SHORT_LABEL) else "pass" if _word(nm, PASS_LABEL) else None)
        if k:
            return {"kind": k, "source": "label", "detail": nm or str(lb.get("icon") or "")}
    if k := kind_by_icon(icon):
        return {"kind": k, "source": "icon", "detail": str(icon)}
    by_name = kind_by_name(name)
    if by_name:
        return {"kind": by_name, "source": "name", "detail": name}
    for d in devices or []:
        low = re.sub(r"[_.]", " ", d.lower())  # entity ids: "light.bad_decke" → "light bad decke"
        if SHORT_DEVICE.search(low):
            return {"kind": "short", "source": "devices", "detail": d}
        if PASS_DEVICE.search(low):
            return {"kind": "pass", "source": "devices", "detail": d}
    if humid_days >= HUMID_DAYS:
        return {"kind": "short", "source": "humidity", "detail": str(humid_days)}
    by_use = kind_by_visits(visits or [])
    if by_use in ("short", "pass"):
        st = visit_stats(visits or []) or {}
        return {"kind": by_use, "source": "usage", "detail": f"{st.get('median', 0):.0f}"}
    return {"kind": "normal", "source": "default", "detail": ""}


def humid_rise(samples: list[tuple[float, float]], now: float, value: float) -> bool:
    """A quick rise of the humidity (a shower): `value` at least HUMID_RISE above the lowest sample of the last
    HUMID_MINUTES. `samples`: [(time s, %)]."""
    recent = [v for t, v in samples if now - t <= HUMID_MINUTES * 60]
    return bool(recent) and value - min(recent) >= HUMID_RISE


def room_kind(name: str) -> str:
    """normal | short (bathroom, shower, WC: used in short bursts) | pass (hall, stairs: only passed through) – by
    the name only (where nothing else is known; the smart heating uses detect_room_kind)."""
    return kind_by_name(name) or "normal"


def peaks(probs: list[float], k: dict[str, float]) -> list[tuple[int, int, float]]:
    """Windows of real use in a day of quarter-hour probabilities: [(first slot, end slot, mean probability)]."""
    if not probs:
        return []
    # background = the median of the waking hours (06:00–23:00): scattered short visits all day lift it, the night does
    # not pull it down, and a room that is used only in its windows has a background of about 0
    day = sorted(probs[24:92]) if len(probs) == 96 else sorted(probs)
    base = day[len(day) // 2]
    level = max(float(k["threshold"]), min(0.9, base + float(k["lift"])))
    runs: list[list[int]] = []
    for i, p in enumerate(probs):
        if p < level:
            continue
        if runs and i - runs[-1][1] <= int(k["gap"]):
            runs[-1][1] = i + 1
        else:
            runs.append([i, i + 1])
    out: list[tuple[int, int, float]] = []
    mx = int(k["max"])
    for a, z in runs:
        if z - a < int(k["min"]):
            continue
        if z - a > mx:
            # too long for this kind of room: keep its strongest part
            best = max(range(a, z - mx + 1), key=lambda s: sum(probs[s : s + mx]))
            a, z = best, best + mx
        out.append((a, z, round(sum(probs[a:z]) / (z - a), 3)))
    return out


def use_windows(probs: list[float], days: int, kind: str, lead_h: float) -> list[dict[str, Any]]:
    """Comfort windows worth heating for: real occupancy peaks with enough learned days, cut to the kind of room,
    checked for cost and benefit. A very slow room (lead of hours) joins windows that lie close together, a
    setback in between would never pay off. [{a, z (slots), mean, joined}]"""
    k = KINDS.get(kind)
    if not k or days < MIN_DAYS:
        return []
    out: list[dict[str, Any]] = []
    for a, z, mean in peaks(probs, k):
        z = min(len(probs), z + int(k["after"]))
        hours = (z - a) / 4
        # the heat-up counts at most one hour: a slow room is not left cold, its windows are joined below instead
        if mean * hours * float(k["weight"]) / (hours + min(1.0, lead_h)) < WORTH:
            continue
        out.append({"a": a, "z": z, "mean": mean, "joined": False})
    # slow rooms: two windows with a short pause in between become one
    if lead_h >= 2.0:
        joined: list[dict[str, Any]] = []
        for w in out:
            if joined and (w["a"] - joined[-1]["z"]) / 4 < 2 * lead_h:
                last = joined[-1]
                n0, n1 = last["z"] - last["a"], w["z"] - w["a"]
                last.update(z=w["z"], mean=round((last["mean"] * n0 + w["mean"] * n1) / (n0 + n1), 3), joined=True)
            else:
                joined.append(dict(w))
        out = joined
    # at most `total` quarter hours a day, the most certain windows first
    total = int(k["total"])
    if sum(w["z"] - w["a"] for w in out) > total:
        keep: list[dict[str, Any]] = []
        used = 0
        for w in sorted(out, key=lambda x: -x["mean"]):
            if used + (w["z"] - w["a"]) <= total:
                keep.append(w)
                used += w["z"] - w["a"]
        out = sorted(keep, key=lambda x: x["a"])
    return out


def airing_windows(probs: list[float], days: int) -> list[dict[str, Any]]:
    """Usual airing times from the quarter-hour probabilities that a window of the room is open."""
    if days < MIN_DAYS:
        return []
    return [{"a": a, "z": z, "mean": mean} for a, z, mean in peaks(probs, AIRING)]


def airing_pattern(events: list[list[float]]) -> dict[str, Any]:
    """How a room is aired, from [timestamp, workday 1/0, start minute, minutes open]:
    stoss = mostly short and wide open (Stoßlüften, 2–20 min), tilt = mostly open for a long time (a tilted window
    costs a lot of heat), mixed. None until there are at least 3 openings."""
    durs = sorted(float(e[3]) for e in events if len(e) >= 4)
    if len(durs) < 3:
        return {"kind": None, "n": len(durs), "median_min": None}
    med = durs[len(durs) // 2]
    stoss = sum(1 for d in durs if 2 <= d <= 20) / len(durs)
    long = sum(1 for d in durs if d > 45) / len(durs)
    kind = "stoss" if stoss >= 0.6 else "tilt" if long >= 0.5 else "mixed"
    return {"kind": kind, "n": len(durs), "median_min": round(med), "stoss_share": round(stoss, 2)}
