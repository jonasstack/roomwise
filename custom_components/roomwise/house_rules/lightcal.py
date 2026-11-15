"""Lampen abgleichen: lamps of different makers show "the same" colour differently. Per lamp and reference colour the
user corrects by eye (Licht → Lampen abgleichen) what the lamp has to be sent so that it looks like the others; between
the references the correction is interpolated. Every light setting (rules, light plan, live preview) goes through
`adjust()` right before it becomes a light.turn_on for that lamp – the rules themselves keep their colours.

Stored in core.data["light_cal"]: {entity_id: {"hs": {ref: [hue, sat]}, "k": {ref: kelvin}, "bri": factor}}
  * colour references (hue/saturation of the reference) → the hue/saturation the lamp is sent instead;
  * white references (Kelvin) → the Kelvin the lamp is sent instead;
  * bri: brightness factor (0.3–3, 1 = as asked).
Pure functions on purpose (tested without Home Assistant: tools/testha/test_lightcal.py).
"""

from __future__ import annotations

import math
import re
from typing import Any

from .lightspec import parse_color, to_hs

# reference colours: hue (0-360) and saturation (%) of the "ideal" colour
COLORS: dict[str, tuple[float, float]] = {
    "rot": (0.0, 100.0),
    "orange": (30.0, 100.0),
    "gelb": (55.0, 100.0),
    "gruen": (120.0, 100.0),
    "tuerkis": (175.0, 100.0),
    "blau": (225.0, 100.0),
    "lila": (275.0, 100.0),
    "pink": (320.0, 100.0),
}
# reference whites (Kelvin)
WHITES: dict[str, int] = {"warmweiss": 2700, "neutralweiss": 4000, "kaltweiss": 5500}
REFS = (*COLORS, *WHITES)
_ID = re.compile(r"^light\.[a-z0-9_]{1,80}$")
# below this saturation a colour counts as (nearly) white: no hue correction
_LOW_SAT = 8.0
# saturation of every colour reference (the correction of saturation is a factor against it)
COLORS_SAT = 100.0


def _num(v: Any, lo: float, hi: float) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(x):
        return None
    return max(lo, min(hi, x))


def clean_entry(raw: Any) -> dict[str, Any]:
    """One lamp's corrections from outside → only known references with valid values."""
    out: dict[str, Any] = {"hs": {}, "k": {}, "bri": 1.0}
    if not isinstance(raw, dict):
        return out
    for ref, v in (raw.get("hs") or {}).items() if isinstance(raw.get("hs"), dict) else []:
        if ref in COLORS and isinstance(v, (list, tuple)) and len(v) == 2:
            h, s = _num(v[0], -720, 720), _num(v[1], 0, 100)
            if h is not None and s is not None:
                out["hs"][ref] = [round(h % 360, 1), round(s, 1)]
    for ref, v in (raw.get("k") or {}).items() if isinstance(raw.get("k"), dict) else []:
        k = _num(v, 1000, 12000)
        if ref in WHITES and k is not None:
            out["k"][ref] = int(round(k))
    b = _num(raw.get("bri", 1.0), 0.3, 3.0)
    out["bri"] = round(b, 3) if b is not None else 1.0
    return out


def clean(raw: Any, cur: dict[str, Any] | None = None) -> dict[str, Any]:
    """All lamps: {entity_id: entry}; a lamp set to null (or an empty entry) is forgotten."""
    out = {k: v for k, v in (cur or {}).items() if _ID.match(k)}
    if not isinstance(raw, dict):
        return out
    for e, v in list(raw.items())[:300]:
        if not isinstance(e, str) or not _ID.match(e):
            continue
        if v is None:
            out.pop(e, None)
            continue
        entry = clean_entry(v)
        if entry["hs"] or entry["k"] or entry["bri"] != 1.0:
            out[e] = entry
        else:
            out.pop(e, None)
    return out


def _hue_diff(a: float, b: float) -> float:
    """b − a on the hue circle, −180 … 180"""
    return ((b - a + 180) % 360) - 180


def correct_hs(entry: dict[str, Any], h: float, s: float) -> tuple[float, float]:
    """A wanted colour (hue, saturation) → what this lamp is sent: the corrections of the two calibrated references
    around the hue, mixed by how close the hue is to each (around the circle); one reference → its correction alone."""
    refs = [(COLORS[r][0], v) for r, v in (entry.get("hs") or {}).items() if r in COLORS]
    if not refs or s < _LOW_SAT:
        return h, s
    # corrections as offsets: hue offset, saturation factor
    offs = sorted((rh, _hue_diff(rh, v[0]), (v[1] / COLORS_SAT) if COLORS_SAT else 1.0) for rh, v in refs)
    if len(offs) == 1:
        _rh, dh, fs = offs[0]
    else:
        # the neighbours below and above h on the circle
        below = max((o for o in offs if o[0] <= h), default=offs[-1], key=lambda o: o[0])
        above = min((o for o in offs if o[0] > h), default=offs[0], key=lambda o: o[0])
        span = (above[0] - below[0]) % 360 or 360
        t = ((h - below[0]) % 360) / span
        dh = below[1] + (above[1] - below[1]) * t
        fs = below[2] + (above[2] - below[2]) * t
    return round((h + dh) % 360, 1), round(max(0.0, min(100.0, s * fs)), 1)


def correct_kelvin(entry: dict[str, Any], k: float) -> float:
    """A wanted white (Kelvin) → what this lamp is sent: the offsets of the calibrated whites, linear in between,
    the nearest one beyond the ends."""
    pts = sorted((WHITES[r], v - WHITES[r]) for r, v in (entry.get("k") or {}).items() if r in WHITES)
    if not pts:
        return k
    if k <= pts[0][0]:
        off = pts[0][1]
    elif k >= pts[-1][0]:
        off = pts[-1][1]
    else:
        off = pts[0][1]
        for (k0, o0), (k1, o1) in zip(pts, pts[1:], strict=False):
            if k0 <= k <= k1:
                off = o0 + (o1 - o0) * (k - k0) / (k1 - k0)
                break
    return max(1000.0, min(12000.0, k + off))


def adjust(spec: dict[str, Any], entry: dict[str, Any] | None) -> dict[str, Any]:
    """A light setting for one lamp (lightspec, after for_light) with this lamp's calibration applied."""
    if not entry or spec.get("mode") in ("off", "scene"):
        return spec
    out = dict(spec)
    p = parse_color(spec.get("color"))
    if p is not None:
        kind, vals = p
        if kind == "kelvin" and entry.get("k"):
            out["color"] = f"k:{int(round(correct_kelvin(entry, vals[0])))}"
        elif kind not in ("kelvin", "white") and entry.get("hs"):
            h, s = to_hs(kind, vals)
            h2, s2 = correct_hs(entry, h, s)
            if (h2, s2) != (round(h, 1), round(s, 1)):
                out["color"] = f"hs:{h2},{s2}"
    f = float(entry.get("bri") or 1.0)
    if f != 1.0:
        if isinstance(spec.get("bri"), (int, float)):
            out["bri"] = int(max(1, min(255, round(spec["bri"] * f))))
        else:
            b = spec.get("brightness")
            b = float(b) if isinstance(b, (int, float)) else 100.0
            out["brightness"] = int(max(1, min(100, round(b * f))))
    return out


def ref_color(ref: str) -> str:
    """The colour string of a reference (for the live preview: every lamp of the room on it)."""
    if ref in COLORS:
        h, s = COLORS[ref]
        return f"hs:{h},{s}"
    return f"k:{WHITES.get(ref, 2700)}"


class LightCal:
    """The stored calibration and the adjuster the light paths use."""

    def __init__(self, core: Any) -> None:
        self.core = core

    @property
    def data(self) -> dict[str, Any]:
        return self.core.data.setdefault("light_cal", {})

    def view(self) -> dict[str, Any]:
        return {"lights": self.data, "colors": {k: list(v) for k, v in COLORS.items()}, "whites": WHITES}

    def save(self, raw: dict[str, Any]) -> dict[str, Any]:
        self.core.data["light_cal"] = clean(raw, self.data)
        self.core.save()
        return self.view()

    def entry(self, entity_id: str) -> dict[str, Any] | None:
        return self.data.get(entity_id)

    def adjust(self, entity_id: str, spec: dict[str, Any]) -> dict[str, Any]:
        return adjust(spec, self.entry(entity_id))
