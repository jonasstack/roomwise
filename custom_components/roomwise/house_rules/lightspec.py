"""How a light should look, like Home Assistant's light.turn_on, for any lamp.

A light setting ("action") is a small dict that the light plan, its variants and the house rule step
"light: set" share:

    {
      "mode": "on" | "off" | "scene",
      "brightness": 1-100 (%),            "bri": 1-255 (exact, wins over brightness),
      "color": one colour string (below), "effect": a name from the lamp's effect_list,
      "transition": seconds (fade),       "flash": "short" | "long",
      "scene": "scene.x" (mode "scene"),
      "per_light": {entity_id: {...the same keys without per_light/scene}}  (each lamp its own)
    }

Colour strings (one string, so old rules stay as they are):
    "kerze" | "warm" | "neutral" | "kalt"  presets      "k:3200"         colour temperature in Kelvin
    "#ff8800"                              RGB          "rgbw:255,120,0,40"   "rgbww:255,120,0,20,60"
    "hs:30,100" (hue 0-360, saturation %)  "xy:0.55,0.4"  "white" (white channel)  "none" (keep the colour)

The lamp's `supported_color_modes` decide what is sent: the exact mode when it has it, else a sensible
conversion (any colour lamp gets the colour in its own mode, a white-only lamp gets the nearest colour
temperature, an on/off lamp just goes on). Pure Python on purpose (tested without Home Assistant:
tools/testha/test_lightspec.py).
"""

from __future__ import annotations

import colorsys
import math
import re
from typing import Any

COLOR_K = {"kerze": 2200, "warm": 2700, "neutral": 4000, "kalt": 5500}
COLOR_MODES = ("hs", "rgb", "rgbw", "rgbww", "xy")
# light features (LightEntityFeature)
FEATURE_EFFECT = 4
FEATURE_FLASH = 8
FEATURE_TRANSITION = 32

_HEX = re.compile(r"#[0-9a-fA-F]{6}")
_NUMS = re.compile(r"(rgbw|rgbww|hs|xy):(-?[\d.]+(?:,-?[\d.]+)*)")
_ARITY = {"rgbw": 4, "rgbww": 5, "hs": 2, "xy": 2}


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def parse_color(v: Any) -> tuple[str, tuple[float, ...]] | None:
    """A colour string → (kind, values): ("kelvin", (k,)), ("rgb", (r, g, b)), ("rgbw", …), ("rgbww", …),
    ("hs", (h, s)), ("xy", (x, y)), ("white", ()), or None (no colour / keep it)."""
    s = str(v or "").strip().lower()
    if s in COLOR_K:
        return ("kelvin", (COLOR_K[s],))
    if s == "white":
        return ("white", ())
    if re.fullmatch(r"k:\d{4,5}", s):
        return ("kelvin", (_clamp(int(s[2:]), 1000, 12000),))
    if _HEX.fullmatch(s):
        return ("rgb", (int(s[1:3], 16), int(s[3:5], 16), int(s[5:7], 16)))
    m = _NUMS.fullmatch(s)
    if m:
        kind, nums = m.group(1), [float(x) for x in m.group(2).split(",")]
        if len(nums) != _ARITY[kind]:
            return None
        if kind in ("rgbw", "rgbww"):
            return (kind, tuple(_clamp(round(x), 0, 255) for x in nums))
        if kind == "hs":
            return ("hs", (nums[0] % 360, _clamp(nums[1], 0, 100)))
        return ("xy", (_clamp(nums[0], 0, 1), _clamp(nums[1], 0, 1)))
    return None


def color_ok(v: Any) -> bool:
    """A colour the light settings understand (see the module text); "none" = keep the lamp's colour."""
    return str(v or "").strip().lower() == "none" or parse_color(v) is not None


def kelvin(v: Any) -> int | None:
    p = parse_color(v)
    return int(p[1][0]) if p and p[0] == "kelvin" else None


def rgb(v: Any) -> tuple[int, int, int] | None:
    p = parse_color(v)
    return (int(p[1][0]), int(p[1][1]), int(p[1][2])) if p and p[0] == "rgb" else None


# ---------------------------------------------------------------------------------------------- conversions
def kelvin_to_rgb(k: float) -> tuple[int, int, int]:
    """Colour of a white light of this temperature (Tanner Helland's fit, good enough for lamps)."""
    t = _clamp(k, 1000, 40000) / 100
    r = 255 if t <= 66 else 329.698727446 * ((t - 60) ** -0.1332047592)
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * ((t - 60) ** -0.0755148492)
    b = 255 if t >= 66 else (0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307)
    return (round(_clamp(r, 0, 255)), round(_clamp(g, 0, 255)), round(_clamp(b, 0, 255)))


def rgb_to_hs(r: float, g: float, b: float) -> tuple[float, float]:
    h, s, _v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return (round(h * 360, 1), round(s * 100, 1))


def hs_to_rgb(h: float, s: float) -> tuple[int, int, int]:
    r, g, b = colorsys.hsv_to_rgb((h % 360) / 360, _clamp(s, 0, 100) / 100, 1)
    return (round(r * 255), round(g * 255), round(b * 255))


def _lin(c: float) -> float:
    c /= 255
    return ((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92


def _srgb_xy(r: float, g: float, b: float) -> tuple[float, float]:
    """sRGB → CIE 1931 xy with the sRGB primaries (only to estimate the nearest white: xy_to_kelvin)."""
    lr, lg, lb = _lin(r), _lin(g), _lin(b)
    x = lr * 0.4124 + lg * 0.3576 + lb * 0.1805
    y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722
    z = lr * 0.0193 + lg * 0.1192 + lb * 0.9505
    tot = x + y + z
    return (x / tot, y / tot) if tot else (0.3127, 0.329)


def rgb_to_xy(r: float, g: float, b: float) -> tuple[float, float]:
    """RGB → xy exactly like Home Assistant (homeassistant.util.color.color_RGB_to_xy: "Wide RGB D65", 3 decimals),
    so a colour sent as xy looks the same as the same colour sent as rgb_color (HA converts that one itself)."""
    lr, lg, lb = _lin(r), _lin(g), _lin(b)
    x = lr * 0.664511 + lg * 0.154324 + lb * 0.162028
    y = lr * 0.283881 + lg * 0.668433 + lb * 0.047685
    z = lr * 0.000088 + lg * 0.072310 + lb * 0.986039
    tot = x + y + z
    if tot == 0:
        return (0.3127, 0.329)  # black: the white point (Home Assistant answers 0, 0, which no lamp shows)
    return (round(x / tot, 3), round(y / tot, 3))


def xy_to_rgb(x: float, y: float) -> tuple[int, int, int]:
    """CIE xy at full brightness → RGB exactly like Home Assistant (color_xy_to_RGB, the inverse "Wide RGB D65")."""
    y = max(y, 1e-11)
    big_x, big_y, big_z = x / y, 1.0, (1 - x - y) / y
    r = big_x * 1.656492 - big_y * 0.354851 - big_z * 0.255038
    g = -big_x * 0.707196 + big_y * 1.655397 + big_z * 0.036152
    b = big_x * 0.051713 - big_y * 0.121364 + big_z * 1.011530
    rgb = [12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055 for c in (r, g, b)]
    rgb = [max(0.0, c) for c in rgb]
    m = max(rgb)
    if m > 1:
        rgb = [c / m for c in rgb]
    return (int(rgb[0] * 255), int(rgb[1] * 255), int(rgb[2] * 255))


def rgb_to_rgbw(r: float, g: float, b: float) -> tuple[int, int, int, int]:
    """The white part goes to the white channel; the rest stays as bright as before (like Home Assistant)."""
    w = min(r, g, b)
    rest = (r - w, g - w, b - w)
    top, now = max(r, g, b), max(*rest, w)
    f = top / now if now else 0
    return (round(rest[0] * f), round(rest[1] * f), round(rest[2] * f), round(w * f))


def rgbw_to_rgb(r: float, g: float, b: float, w: float) -> tuple[int, int, int]:
    top = max(r, g, b, w)
    out = (r + w, g + w, b + w)
    m = max(out)
    f = top / m if m else 0
    return (round(out[0] * f), round(out[1] * f), round(out[2] * f))


def rgb_to_rgbww(r: float, g: float, b: float) -> tuple[int, int, int, int, int]:
    """White part split evenly between the cold and the warm white channel."""
    rr, gg, bb, w = rgb_to_rgbw(r, g, b)
    return (rr, gg, bb, w // 2 + w % 2, w // 2)


def rgbww_to_rgb(r: float, g: float, b: float, cw: float, ww: float) -> tuple[int, int, int]:
    cold, warm = kelvin_to_rgb(6500), kelvin_to_rgb(2700)
    out = [(r, g, b)[i] + cw * cold[i] / 255 + ww * warm[i] / 255 for i in range(3)]
    top = max(r, g, b, cw, ww)
    m = max(out)
    f = top / m if m else 0
    return (round(out[0] * f), round(out[1] * f), round(out[2] * f))


def xy_to_kelvin(x: float, y: float) -> float:
    """Correlated colour temperature (McCamy); meaningful near white, used to choose the nearest white."""
    n = (x - 0.3320) / ((0.1858 - y) or 1e-6)
    return 449 * n**3 + 3525 * n**2 + 6823.3 * n + 5520.33


def to_rgb(kind: str, vals: tuple[float, ...]) -> tuple[int, int, int]:
    if kind == "rgb":
        return (int(vals[0]), int(vals[1]), int(vals[2]))
    if kind == "rgbw":
        return rgbw_to_rgb(*vals)
    if kind == "rgbww":
        return rgbww_to_rgb(*vals)
    if kind == "hs":
        return hs_to_rgb(*vals)
    if kind == "xy":
        return xy_to_rgb(*vals)
    if kind == "kelvin":
        return kelvin_to_rgb(vals[0])
    return (255, 255, 255)


def to_hs(kind: str, vals: tuple[float, ...]) -> tuple[float, float]:
    return (float(vals[0]), float(vals[1])) if kind == "hs" else rgb_to_hs(*to_rgb(kind, vals))


# ---------------------------------------------------------------------------------------------- settings
_ACTION_KEYS = ("mode", "brightness", "bri", "color", "effect", "transition", "flash", "scene")


def _num(v: Any, d: float | None, lo: float, hi: float) -> float | None:
    if isinstance(v, str) and v.startswith("$"):
        return v  # type: ignore[return-value]  # a value from the trigger or a variable (logic.resolve)
    try:
        return _clamp(float(v), lo, hi)
    except (TypeError, ValueError):
        return d


def clean_action(a: Any, default_color: str = "warm", *, nested: bool = False) -> dict[str, Any]:
    """A light setting from outside (websocket, rule file) → only known keys with valid values.
    nested = the setting of one lamp inside per_light (no scene, no further per_light; missing keys = as for all)."""
    a = a if isinstance(a, dict) else {}
    out: dict[str, Any] = {}
    if not nested or "mode" in a:
        modes = ("on", "off") if nested else ("on", "off", "scene")
        out["mode"] = a.get("mode") if a.get("mode") in modes else "on"
    if not nested or "brightness" in a:
        b = _num(a.get("brightness", 70), 70, 1, 100)
        out["brightness"] = b if isinstance(b, str) else int(round(b or 70))
    if a.get("bri") not in (None, ""):
        b = _num(a["bri"], None, 1, 255)
        if b is not None:
            out["bri"] = b if isinstance(b, str) else int(round(b))
    if not nested or "color" in a:
        c = str(a.get("color") or "").strip().lower()
        out["color"] = c if color_ok(c) else default_color
    if isinstance(a.get("effect"), str) and a["effect"].strip():
        out["effect"] = a["effect"].strip()[:60]
    if a.get("transition") not in (None, ""):
        t = _num(a["transition"], None, 0, 3600)
        if t is not None:
            out["transition"] = t if isinstance(t, str) else round(float(t), 1)
    if a.get("flash") in ("short", "long"):
        out["flash"] = a["flash"]
    if not nested and out.get("mode") == "scene":
        sc = a.get("scene")
        out["scene"] = sc[:200] if isinstance(sc, str) and sc.startswith("scene.") else ""
    if not nested and isinstance(a.get("per_light"), dict):
        per = {e: clean_action(v, default_color, nested=True) for e, v in list(a["per_light"].items())[:40] if isinstance(e, str) and e.startswith("light.") and isinstance(v, dict)}
        per = {e: v for e, v in per.items() if v}
        if per:
            out["per_light"] = per
    return out


def for_light(spec: dict[str, Any] | None, entity_id: str) -> dict[str, Any] | None:
    """The setting for one lamp: its own part of per_light over the common one."""
    if not spec:
        return spec
    own = (spec.get("per_light") or {}).get(entity_id)
    if not own and "per_light" not in spec:
        return spec
    out = {k: v for k, v in spec.items() if k != "per_light"}
    if own:
        out.update(own)
    return out


class Caps:
    """What a lamp can do, from its state attributes."""

    def __init__(self, attrs: dict[str, Any] | None) -> None:
        a = attrs or {}
        self.modes: set[str] = {str(m) for m in (a.get("supported_color_modes") or [])}
        self.color_mode = str(a.get("color_mode") or "")
        self.features = int(a.get("supported_features") or 0)
        self.effects: list[str] = [str(e) for e in (a.get("effect_list") or [])]
        self.min_k = int(a.get("min_color_temp_kelvin") or 2000)
        self.max_k = int(a.get("max_color_temp_kelvin") or 6500)
        if not self.modes:
            # old integrations without colour modes: brightness if they report one
            self.modes = {"brightness"} if a.get("brightness") is not None else {"onoff"}

    @property
    def color(self) -> bool:
        return any(m in self.modes for m in COLOR_MODES)

    @property
    def ct(self) -> bool:
        return "color_temp" in self.modes

    @property
    def dimmable(self) -> bool:
        return self.modes != {"onoff"}

    def best_color_mode(self, want: str) -> str | None:
        if want in self.modes:
            return want
        for m in ("hs", "rgb", "xy", "rgbww", "rgbw"):
            if m in self.modes:
                return m
        return None


def color_data(caps: Caps, color: Any) -> dict[str, Any]:
    """The colour part of light.turn_on for this lamp (empty: keep the colour / it has none)."""
    p = parse_color(color)
    if p is None:
        return {}
    kind, vals = p
    if kind == "white":
        if "white" in caps.modes:
            return {"white": True}
        if caps.ct:
            return {"color_temp_kelvin": int(_clamp(4000, caps.min_k, caps.max_k))}
        if caps.color:
            kind, vals = "kelvin", (4000,)
        else:
            return {}
    if kind == "kelvin":
        if caps.ct:
            return {"color_temp_kelvin": int(_clamp(vals[0], caps.min_k, caps.max_k))}
        if not caps.color:
            return {}
        kind, vals = "rgb", kelvin_to_rgb(vals[0])
    # a colour
    mode = caps.best_color_mode(kind)
    if mode is None:
        if caps.ct:
            # white-only lamp: the nearest white (reds/oranges warm, blues cold)
            k = xy_to_kelvin(*_srgb_xy(*to_rgb(kind, vals)))
            return {"color_temp_kelvin": int(_clamp(k, caps.min_k, caps.max_k))}
        return {}
    if mode == kind:
        if kind == "hs":
            return {"hs_color": [round(vals[0], 1), round(vals[1], 1)]}
        if kind == "xy":
            return {"xy_color": [round(vals[0], 4), round(vals[1], 4)]}
        return {f"{kind}_color": [int(v) for v in vals]}
    c = to_rgb(kind, vals)
    if mode == "hs":
        return {"hs_color": list(to_hs(kind, vals))}
    if mode == "rgb":
        return {"rgb_color": list(c)}
    if mode == "xy":
        return {"xy_color": list(rgb_to_xy(*c))}
    if mode == "rgbw":
        return {"rgbw_color": list(rgb_to_rgbw(*c))}
    return {"rgbww_color": list(rgb_to_rgbww(*c))}


def _bri255(spec: dict[str, Any]) -> int:
    if isinstance(spec.get("bri"), (int, float)):
        return int(_clamp(spec["bri"], 1, 255))
    b = spec.get("brightness")
    return int(round(_clamp(float(b if isinstance(b, (int, float)) else 100), 1, 100) * 2.55))


def service_data(attrs: dict[str, Any] | None, spec: dict[str, Any]) -> dict[str, Any]:
    """Data for light.turn_on (without entity_id) that this lamp understands."""
    caps = Caps(attrs)
    data: dict[str, Any] = {}
    if caps.dimmable:
        if isinstance(spec.get("bri"), (int, float)):
            data["brightness"] = _bri255(spec)
        else:
            b = spec.get("brightness")
            data["brightness_pct"] = int(_clamp(float(b if isinstance(b, (int, float)) else 100), 1, 100))
    col = color_data(caps, spec.get("color"))
    if col.get("white"):
        # white mode: the brightness goes into "white" (Home Assistant's way for the white channel)
        data.pop("brightness_pct", None)
        data.pop("brightness", None)
        col = {"white": _bri255(spec)}
    data.update(col)
    eff = spec.get("effect")
    if eff and eff in caps.effects:
        data["effect"] = eff
    if isinstance(spec.get("transition"), (int, float)) and (caps.features & FEATURE_TRANSITION):
        data["transition"] = spec["transition"]
    if spec.get("flash") in ("short", "long") and (caps.features & FEATURE_FLASH):
        data["flash"] = spec["flash"]
    return data


def _hs_close(have: Any, want: tuple[float, float], hue_tol: float = 10, sat_tol: float = 12) -> bool:
    """Two colours as hue/saturation, with room for rounding (hue does not matter for an almost white colour)."""
    try:
        h, s = float(have[0]), float(have[1])
    except (TypeError, ValueError, IndexError):
        return False
    dh = abs(h - want[0]) % 360
    return (min(dh, 360 - dh) <= hue_tol or (want[1] <= 10 and s <= 10)) and abs(s - want[1]) <= sat_tol


def same_hs(a: Any, b: Any) -> bool:
    """Two reported colours (hs_color or None) are the same within rounding."""
    if not a or not b:
        return not a and not b
    return _hs_close(a, (float(b[0]), float(b[1])), 2, 2)


def _xy_close(have: Any, want: tuple[float, float], tol: float = 0.03) -> bool:
    try:
        return abs(float(have[0]) - want[0]) <= tol and abs(float(have[1]) - want[1]) <= tol
    except (TypeError, ValueError, IndexError):
        return False


def matches(state: str | None, attrs: dict[str, Any] | None, spec: dict[str, Any]) -> bool:
    """Is the lamp already the way the setting wants it? (Small differences count as the same: lamps round, and many
    report another colour mode than the one they were sent – a Matter lamp asked for a white tone may report it as
    xy, a Zigbee lamp asked for hs may report xy. Home Assistant gives every colour lamp's colour as hs, rgb and xy,
    so the colour is compared in the setting's own kind, else as hue/saturation.)"""
    on = state == "on"
    if spec.get("mode") == "off":
        return not on
    if not on:
        return False
    a = attrs or {}
    caps = Caps(a)
    want_col = color_data(caps, spec.get("color"))
    if caps.dimmable and a.get("brightness") is not None and "white" not in want_col and abs(int(a["brightness"]) - _bri255(spec)) > 8:
        return False
    mode = caps.color_mode
    if "color_temp_kelvin" in want_col:
        want_k = int(want_col["color_temp_kelvin"])
        if mode == "color_temp" or not mode:
            have = a.get("color_temp_kelvin")
            # lamps work in mired: the step between two values grows with the temperature
            if have is not None and abs(int(have) - want_k) > max(150, want_k * 0.05):
                return False
        elif mode == "white" or not _hs_close(a.get("hs_color"), rgb_to_hs(*kelvin_to_rgb(want_k)), 8, 10):
            # reported as a colour: the same white tone counts, a real colour does not
            return False
    elif any(k in want_col for k in ("hs_color", "rgb_color", "xy_color", "rgbw_color", "rgbww_color")):
        if mode == "white":
            return False
        key = next(k for k in ("hs_color", "rgb_color", "xy_color", "rgbw_color", "rgbww_color") if k in want_col)
        kind = key[:-6]
        want = tuple(float(v) for v in want_col[key])
        native = a.get(key)
        if mode == kind and native and len(native) == len(want):
            # the lamp reports the same colour mode: compare its own values first (Home Assistant's conversions to
            # hs differ from ours, e.g. its xy → rgb uses another gamut)
            tol = 0.01 if kind == "xy" else 3 if kind == "hs" else 8
            diffs = [abs(float(h) - w) for h, w in zip(native, want, strict=True)]
            if kind == "hs":
                diffs[0] = min(diffs[0] % 360, 360 - diffs[0] % 360)  # hue goes round
            same = all(d <= tol for d in diffs)
        else:
            # another colour mode (or a white tone): Home Assistant's own conversion of the lamp's colour into the
            # wanted kind
            same = (kind == "xy" and _xy_close(a.get("xy_color"), (want[0], want[1]))) or (kind == "hs" and _hs_close(a.get("hs_color"), (want[0], want[1]), 5, 6))
        # else as hue/saturation (lamps clip colours to their gamut and round): close enough is the same colour
        if not same and not _hs_close(a.get("hs_color"), to_hs(kind, want)):
            return False
    elif "white" in want_col and mode and mode != "white":
        return False
    eff = spec.get("effect")
    return not (eff and eff in caps.effects and a.get("effect") != eff)


# a lamp that is off and gets a colour: first on at this brightness (0-255) in the new colour without a fade, then
# up to the wanted brightness with the wanted fade (else many lamps first light up in their last colour)
POWER_UP_BRI = 13
_COLOR_KEYS = ("hs_color", "rgb_color", "xy_color", "rgbw_color", "rgbww_color", "color_temp_kelvin")


def power_up(state: str | None, attrs: dict[str, Any] | None, data: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """light.turn_on data for a lamp that is off → (first call or None, second call).

    Many lamps (Zigbee, Wi-Fi, Matter) power up in the colour they had last and only then go over to the new one:
    a white flash before the orange. So a lamp that is off and gets a colour is first switched on in that colour at
    a very low brightness without a fade, then brought to the wanted brightness with the wanted fade. A target that
    dim anyway is one call without a fade (a fade from "off" to almost nothing only flickers)."""
    if state == "on" or not any(k in data for k in _COLOR_KEYS):
        return None, data
    if "brightness" in data:
        target = int(data["brightness"])
    elif "brightness_pct" in data:
        target = round(float(data["brightness_pct"]) * 2.55)
    else:
        return None, data  # not dimmable: nothing to fade
    if data.get("effect") or data.get("flash"):
        return None, data  # an effect or a flash decides the look itself
    fade = {"transition": 0} if Caps(attrs).features & FEATURE_TRANSITION else {}
    colour = {k: v for k, v in data.items() if k in _COLOR_KEYS}
    if target <= POWER_UP_BRI:
        return None, {**colour, "brightness": max(1, target), **fade}
    # the second call names the colour again: a no-op for the lamp, but right even if it missed the first one
    return {**colour, "brightness": POWER_UP_BRI, **fade}, data


def color_of(attrs: dict[str, Any] | None) -> str:
    """The lamp's colour right now as a colour string (to put it back later); "none" if it has none."""
    a = attrs or {}
    mode = str(a.get("color_mode") or "")
    if mode == "color_temp" and a.get("color_temp_kelvin"):
        return f"k:{int(a['color_temp_kelvin'])}"
    if mode == "rgbw" and a.get("rgbw_color"):
        return "rgbw:" + ",".join(str(int(x)) for x in a["rgbw_color"])
    if mode == "rgbww" and a.get("rgbww_color"):
        return "rgbww:" + ",".join(str(int(x)) for x in a["rgbww_color"])
    if mode == "xy" and a.get("xy_color"):
        return "xy:" + ",".join(f"{float(x):.4f}" for x in a["xy_color"])
    if mode in ("hs", "rgb") and a.get("hs_color"):
        if mode == "rgb" and a.get("rgb_color"):
            r, g, b = (int(x) for x in a["rgb_color"])
            return f"#{r:02x}{g:02x}{b:02x}"
        return "hs:" + ",".join(f"{float(x):g}" for x in a["hs_color"])
    if mode == "white":
        return "white"
    return "none"


def snapshot(state: str | None, attrs: dict[str, Any] | None) -> dict[str, Any]:
    """The lamp as a light setting (to put it back exactly, colour and effect included)."""
    a = attrs or {}
    if state != "on":
        return {"mode": "off"}
    out: dict[str, Any] = {"mode": "on", "color": color_of(a)}
    if a.get("brightness") is not None:
        out["bri"] = int(a["brightness"])
        out["brightness"] = max(1, round(int(a["brightness"]) / 2.55))
    if a.get("effect") and a.get("effect") not in ("none", "off", "None"):
        out["effect"] = str(a["effect"])
    return out


def light_text(lang: str, spec: Any) -> str:
    """A light setting in a few words: "60 %, warm, Effekt „candle“" (per lamp: "each lamp its own")."""
    from .i18n import tr  # noqa: PLC0415

    s = spec if isinstance(spec, dict) else {}
    if s.get("mode") == "off":
        return tr(lang, "light.off")
    if s.get("mode") == "scene":
        return tr(lang, "light.scene", scene=s.get("scene") or "…")
    parts = [f"{s['brightness']} %" if isinstance(s.get("brightness"), (int, float)) and not isinstance(s.get("bri"), (int, float)) else f"{s['bri']}/255" if isinstance(s.get("bri"), (int, float)) else str(s.get("brightness") or "")]
    c = str(s.get("color") or "none")
    if c in COLOR_K:
        parts.append(tr(lang, f"light.color_{c}"))
    elif c.startswith("k:"):
        parts.append(f"{c[2:]} K")
    elif c not in ("none", ""):
        parts.append(tr(lang, "light.color", color=c))
    if s.get("effect"):
        parts.append(tr(lang, "light.effect", effect=s["effect"]))
    if isinstance(s.get("transition"), (int, float)) and s["transition"]:
        parts.append(tr(lang, "light.transition", n=s["transition"]))
    if s.get("per_light"):
        parts.append(tr(lang, "light.per_light"))
    return ", ".join(x for x in parts if x)
