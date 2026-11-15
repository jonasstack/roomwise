"""Texts the integration writes itself (history, status lines, notifications, announcements, sentences) in German or English.

The texts live per area in texts/<area>.json, both languages side by side: {"de": {"key": "…"}, "en": {"key": "…"}}.
The language is the one of Home Assistant (hass.config.language): German for "de*", English for everything else.
A key missing in English falls back to German, a missing key comes back as the key itself (never an empty text).
tools/i18n-check.mjs checks that both languages have the same keys and placeholders and that every key is used.

    tr(core, "alarm.pin_locked", n=3, seconds=60)        # placeholders like str.format: "… {n} …"
    trn(core, "alarm.sensors", 2)                         # "alarm.sensors_one" / "alarm.sensors_other", {n} filled in
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

TEXTS_DIR = Path(__file__).parent / "texts"
LANGS = ("de", "en")


@lru_cache(maxsize=1)
def texts() -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {lang: {} for lang in LANGS}
    for f in sorted(TEXTS_DIR.glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        for lang in LANGS:
            out[lang].update(data.get(lang, {}))
    return out


def norm_lang(language: str | None) -> str:
    return "de" if (language or "de").lower().startswith("de") else "en"


def lang_of(where: Any) -> str:
    """The language for an object that knows Home Assistant: hass, the core (has .hass), a language code, or None (German)."""
    if where is None:
        return "de"
    if isinstance(where, str):
        return norm_lang(where)
    hass = getattr(where, "hass", where)
    config = getattr(hass, "config", None)
    return norm_lang(getattr(config, "language", None))


class _Keep(dict):
    """Unknown placeholders stay visible instead of raising."""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def tr(where: Any, key: str, /, **params: Any) -> str:
    lang = lang_of(where)
    t = texts()
    s = t[lang].get(key) or t["de"].get(key) or key
    try:
        return s.format_map(_Keep(params))
    except (ValueError, IndexError):
        return s


def trn(where: Any, key: str, n: float, /, **params: Any) -> str:
    """Singular/plural by n."""
    return tr(where, f"{key}_{'one' if n == 1 else 'other'}", n=num(where, n), **params)


def num(where: Any, value: float, digits: int | None = None) -> str:
    """21.5 → "21,5" (German) / "21.5" (English); whole numbers without decimals unless digits is given."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return str(value)
    s = f"{v:.{digits}f}" if digits is not None else (str(int(v)) if v == int(v) else f"{round(v, 2)}")
    return s.replace(".", ",") if lang_of(where) == "de" else s


def deg(where: Any, value: float) -> str:
    """Temperature: "21,5 °C" / "21.5 °C"."""
    try:
        return f"{num(where, round(float(value), 1))} °C"
    except (TypeError, ValueError):
        return f"{value} °C"


def join_list(where: Any, items: list[str], word: str = "and") -> str:
    """"A, B und C" / "A, B and C"; word="or" for "oder"/"or"."""
    items = [str(i) for i in items if i]
    if len(items) <= 1:
        return items[0] if items else ""
    last = tr(where, f"common.{word}")
    return f"{', '.join(items[:-1])} {last} {items[-1]}"


def quote(where: Any, s: str) -> str:
    """„Name“ / “Name”"""
    return f"„{s}“" if lang_of(where) == "de" else f"“{s}”"


def clock(where: Any, hhmm: str) -> str:
    """A "HH:MM" time in a sentence: "7:00 Uhr" / "7:00"."""
    return tr(where, "common.clock", time=hhmm)


def room_in(where: Any, room: dict[str, Any] | None, fallback: str = "") -> str:
    """'in der Küche' (German phrase of the room, can be corrected by the user) / 'in the Kitchen'."""
    if not room:
        return fallback
    name = str(room.get("name") or "")
    if lang_of(where) == "de":
        return str(room.get("in") or f"im {name}")
    low = name.lower()
    return f"in {name}" if low.startswith(("the ", "my ", "our ")) or "'s " in low or low.endswith("'s") else f"in the {name}"


def mode_label(where: Any, mode: str) -> str:
    """House mode name: Zuhause / Home …"""
    return tr(where, f"mode.{mode}") if f"mode.{mode}" in texts()["de"] else mode
