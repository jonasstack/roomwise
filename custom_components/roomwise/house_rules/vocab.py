"""The vocabulary (generated from src/vocabulary.ts at build time) and sentences for clauses, in German or English."""

from __future__ import annotations

import copy
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .i18n import lang_of, num, quote, room_in, tr

if TYPE_CHECKING:
    from .core import HouseRules

# i18n: complete

VOCAB_FILE = Path(__file__).parent / "vocabulary.json"


@lru_cache(maxsize=1)
def vocabulary() -> dict[str, Any]:
    return json.loads(VOCAB_FILE.read_text(encoding="utf-8"))


@lru_cache(maxsize=2)
def _kinds(lang: str) -> dict[str, Any]:
    base = vocabulary()["kinds"]
    over = vocabulary().get("en", {}).get("kinds", {}) if lang == "en" else {}
    if not over:
        return base
    out = copy.deepcopy(base)
    for kid, k in out.items():
        o = over.get(kid)
        if not o:
            continue
        for key in ("label", "plural", "any"):
            if o.get(key):
                k[key] = o[key]
        for v in k.get("verbs", []):
            ov = o.get("verbs", {}).get(v["id"])
            if not ov:
                continue
            v["label"] = ov["label"]
            if ov.get("pl"):
                v["pl"] = ov["pl"]
            else:
                v.pop("pl", None)
            if ov.get("hint"):
                v["hint"] = ov["hint"]
            else:
                v.pop("hint", None)
            for p in v.get("params", []):
                p["label"] = ov.get("params", {}).get(p["key"], p["label"])
    return out


def kinds(lang: str = "de") -> dict[str, Any]:
    """Kinds with their verbs; lang "en" swaps in the English words (same ids)."""
    return _kinds("en" if lang == "en" else "de")


def modes(lang: str = "de") -> dict[str, Any]:
    if lang == "en":
        return vocabulary().get("en", {}).get("modes") or vocabulary()["modes"]
    return vocabulary()["modes"]


def verb(kind: str, verb_id: str, lang: str = "de") -> dict[str, Any] | None:
    for v in kinds(lang).get(kind, {}).get("verbs", []):
        if v["id"] == verb_id:
            return v
    return None


def verbs(kind: str, flavour: str, lang: str = "de") -> list[dict[str, Any]]:
    return [v for v in kinds(lang).get(kind, {}).get("verbs", []) if v["flavour"] == flavour]


def flavour_for(section: str, rule_type: str) -> str:
    if section in ("then", "else"):
        return "action"
    if section == "when":
        return "state" if rule_type == "while" else "event"
    return "state"


_DUR = re.compile(r"^(\d+(?:[.,]\d+)?)\s*([smhd])$")


def seconds(value: Any) -> float | None:
    """'30s' / '5m' / '1h' / '1d' → seconds."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = _DUR.match(str(value).strip())
    if not m:
        return None
    n = float(m.group(1).replace(",", "."))
    return n * {"s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)]


def format_duration(value: Any, lang: str = "de") -> str:
    m = _DUR.match(str(value or "").strip())
    if not m:
        return str(value or "")
    n = m.group(1).replace(".", ",") if lang == "de" else m.group(1).replace(",", ".")
    unit = m.group(2) if m.group(2) != "d" else ("d_one" if n == "1" else "d_other")
    return tr(lang, f"dur.{unit}", n=n)


def format_offset(value: Any, lang: str = "de") -> str:
    s = str(value or "0m")
    if re.match(r"^[-+]?0[smh]?$", s):
        return ""
    return tr(lang, "dur.before" if s.startswith("-") else "dur.after", d=format_duration(s.lstrip("+-"), lang))


# light colors as stored in rules (German words) → English names
EN_COLORS = {"warmweiß": "warm white", "neutralweiß": "neutral white", "kaltweiß": "cool white", "rot": "red", "grün": "green", "blau": "blue", "lila": "purple"}  # i18n-ignore


def _lc_first(s: str) -> str:
    """'Lights' → 'lights' inside an English sentence (not 'HA automations')."""
    return s[0].lower() + s[1:] if re.match(r"^[A-Z][a-z]", s) else s


class Describer:
    """Sentence parts, the same as the frontend's describe.ts, in the language of Home Assistant (or the one asked for)."""

    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self.lang_override: str | None = None

    @property
    def lang(self) -> str:
        return self.lang_override or lang_of(self.core)

    def subject(self, subject: str) -> dict[str, Any]:
        lang = self.lang
        k = kinds(lang)
        core = self.core

        def room_phrase(r: str | None) -> str | None:
            if r is None:
                return None
            if r == "same":
                return tr(lang, "describe.same_room")
            room = core.rooms.get(r)
            return room_in(lang, room, r)

        m = re.match(r"^(any|all):([a-z_]+)(?:@([a-z0-9_]+))?$", subject)
        if m:
            kd = k.get(m.group(2), k["switch"])
            plural = _lc_first(kd["plural"]) if lang == "en" else kd["plural"]
            base = kd["any"] if m.group(1) == "any" else tr(lang, "describe.all", plural=plural)
            where = room_phrase(m.group(3))
            return {"label": f"{base} {where}" if where else base, "kind": m.group(2), "plural": m.group(1) == "all"}
        if subject.startswith("room:"):
            room = core.rooms.get(subject[5:])
            return {"label": room["name"] if room else subject[5:], "kind": "room", "plural": False}
        if subject.startswith("zone:"):
            dev = core.inventory.devices.get(subject[5:])
            return {"label": dev["name"] if dev else subject[5:], "kind": "zone", "plural": False}
        if subject.startswith("person:"):
            pid = subject[7:]
            if pid == "someone":
                return {"label": tr(lang, "describe.someone"), "kind": "person", "plural": False}
            if pid == "everyone":
                return {"label": tr(lang, "describe.everyone"), "kind": "person", "plural": True}
            p = core.inventory.persons.get(pid)
            return {"label": p["name"] if p else pid, "kind": "person", "plural": False}
        if subject.startswith("notify:"):
            pid = subject[7:]
            p = core.inventory.persons.get(pid)
            return {"label": tr(lang, "describe.to_everyone") if pid == "everyone" else (p["name"] if p else pid), "kind": "notify", "plural": False}
        if subject.startswith("group:"):
            g = core.group(subject[6:])
            return {"label": g["name"] if g else tr(lang, "describe.deleted_group"), "kind": core.checker.res.kind_of(subject), "plural": False}
        if subject == "alarm":
            return {"label": tr(lang, "describe.alarm"), "kind": "alarm", "plural": False}
        if subject.startswith("rule:"):
            r = core.rule(subject[5:])
            return {"label": quote(lang, r["name"]) if r else tr(lang, "describe.deleted_rule"), "kind": "rule", "plural": False}
        if subject in k and not k[subject].get("placeholder"):
            label = tr(lang, "describe.the_sun") if subject == "sun" else tr(lang, "describe.mode") if subject == "mode" and lang == "en" else k[subject]["label"]
            return {"label": label, "kind": subject, "plural": False}
        dev = core.inventory.devices.get(subject)
        if dev:
            return {"label": dev["name"], "kind": dev["kind"], "plural": False}
        kind = core.checker.res.kind_of(subject)
        st = core.hass.states.get(subject) if "." in subject else None
        if st:
            return {"label": str(st.attributes.get("friendly_name") or subject), "kind": kind, "plural": False}
        return {"label": subject.split(".")[-1], "kind": kind if "." in subject else "switch", "plural": False, "missing": True}

    def _fill(self, label: str, clause: dict[str, Any], kind: str, verb_id: str) -> str:
        lang = self.lang
        v = verb(kind, verb_id, lang) or {}
        specs = {p["key"]: p for p in v.get("params", [])}

        def rep(m: re.Match[str]) -> str:
            key = m.group(1)
            if key == "s":
                return m.group(0)
            spec = specs.get(key, {})
            val = clause.get(key, spec.get("default"))
            t = spec.get("type")
            if t == "duration":
                return format_duration(val, lang)
            if t == "percent":
                return f"{val} %"
            if t == "light":
                from .lightspec import light_text  # noqa: PLC0415

                return light_text(lang, val)
            if t == "temperature":
                return f"{str(val).replace('.', ',')} °C" if lang == "de" else f"{num(lang, val)} °C"
            if t == "number":
                unit = "min" if lang == "en" and spec.get("unit") == "Min." else spec.get("unit")
                return f"{val}{' ' + unit if unit else ''}"
            if t == "mode":
                return modes(lang).get(str(val), {}).get("label", str(val))
            if t == "color" and lang == "en":
                return EN_COLORS.get(str(val).lower(), str(val))
            if t == "zone":
                if str(val).startswith("lp_") and getattr(self.core, "places", None):
                    return self.core.places.label(str(val))  # a learned place
                z = self.core.hass.states.get(f"zone.{val}")
                return tr(lang, "describe.home_zone") if val == "home" else (str(z.attributes.get("friendly_name")) if z else str(val))
            if t == "text":
                s = str(val or "")
                return s[:42] + "…" if len(s) > 44 else (s or "…")
            return str(val if val is not None else "…")

        return re.sub(r"\{(\w+)\}", rep, label)

    def clause(self, clause: dict[str, Any], section: str) -> str:
        lang = self.lang
        if clause.get("subject") == "logic":
            from .logic import describe  # noqa: PLC0415

            return describe(self, clause, section)
        subj = self.subject(clause.get("subject", ""))
        kd = kinds(lang).get(subj["kind"], {})
        v = verb(subj["kind"], clause.get("verb", ""), lang)
        label = (v.get("pl") if subj["plural"] and v.get("pl") else v["label"]) if v else clause.get("verb", "")
        if clause.get("plan") and clause.get("verb") == "set_temp":
            label = tr(lang, "describe.by_heat_plan_preheat" if clause.get("preheat") else "describe.by_heat_plan")
        elif clause.get("plan") and clause.get("verb") == "turn_on":
            label = tr(lang, "describe.by_light_plan")
        text = self._fill(label, clause, subj["kind"], clause.get("verb", ""))
        mods: list[str] = []
        off = format_offset(clause.get("offset"), lang)
        if off:
            mods.append(off)
        has_for_param = any(p["key"] == "for" for p in (v or {}).get("params", []))
        if clause.get("for") and not has_for_param:
            mods.append(tr(lang, "describe.for" if section == "then" else "describe.since", d=format_duration(clause["for"], lang)))
        if section == "then" and clause.get("brightness") is not None and clause.get("verb") == "turn_on":
            mods.append(f"{clause['brightness']} %")
        hide = section in (kd.get("hide_subject") or [])
        # "{s}" marks where the subject goes (English actions: "turn on {s}"); without it the subject comes first
        if "{s}" in text:
            out = text.replace("{s}", "" if hide else subj["label"])
            out = re.sub(r"\s+", " ", " ".join([out, *mods])).strip()
        else:
            parts = ([] if hide else [subj["label"]]) + [text] + mods
            out = " ".join(p for p in parts if p)
        if clause.get("or"):
            out = "(" + f" {tr(lang, 'join.or')} ".join([out, *(self.clause(c, section) for c in clause["or"])]) + ")"
        return out

    def joiner(self, rule: dict[str, Any], section: str, i: int) -> str:
        lang = self.lang
        if section == "when":
            if i == 0:
                return tr(lang, "join.while" if rule.get("type") == "while" else "join.when")
            return tr(lang, "join.and" if rule.get("type") == "while" else "join.or")
        if section == "and":
            return tr(lang, "join.and")
        if section == "only":
            return tr(lang, "join.only" if i == 0 else "join.and")
        if i == 0:
            return tr(lang, "join.then")
        prev = rule["then"][i - 1] if i - 1 < len(rule["then"]) else {}
        return tr(lang, "join.after" if prev.get("subject") == "wait" else "join.and")

    def sentence(self, rule: dict[str, Any]) -> str:
        lang = self.lang
        parts: list[str] = []
        for section in ("when", "and", "then", "only"):
            for i, c in enumerate(rule.get(section, [])):
                j = self.joiner(rule, section, i)
                if parts and section != "when":
                    j = j.lower()
                if section == "then" and i == 0 and parts:
                    parts[-1] += ","
                    if lang == "en":
                        # "When the door opens, turn on the light."
                        j = ""
                if section == "only" and i == 0 and parts and lang == "en":
                    parts[-1] += ","
                parts.append(f"{j} {self.clause(c, section)}".strip())
        if rule.get("type") == "while" and rule.get("else"):
            parts[-1] += ","
            parts.append(tr(lang, "join.else") + " " + f" {tr(lang, 'join.and')} ".join(self.clause(c, "then") for c in rule["else"]))
        s = " ".join(parts) + "."
        return s[:1].upper() + s[1:]
