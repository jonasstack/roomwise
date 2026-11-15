"""English sentence → rule draft without a language model: the English sibling of parse.py.

Same rule model, same steps, same device matching (inherited from SentenceParser); only the words differ:
1. Qualifiers anywhere become limits ("at night", "on weekdays", "between 10 pm and 6 am", "if it's dark", "unless we're on vacation").
   "only if …" and "unless …" parts become conditions in "only" ("unless" negated).
2. Fixed triggers are taken out ("at 7 am", "at sunset", "30 minutes before sunrise", "on motion in the hallway").
3. The rest is split into the condition ("when …", also after the action: "Turn on the light when …") and the actions.
4. Every part is matched against the real house: device names, rooms, persons, kinds ("light", "heating").
   What a part says it does ("opens", "is on", "to 20 percent") decides which kinds of devices fit.
5. Words that were not understood are reported.

    detect_language(text, fallback) → "de" | "en"
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from .parse import ACTORS, GENERIC_TOKENS, OPENABLE, PERSON_KINDS, SWITCHABLE, Part, SentenceParser, Subject
from .vocab import vocabulary

if TYPE_CHECKING:
    from .core import HouseRules

# i18n: data (the English parser: English words on purpose)


def fold_en(s: str) -> str:
    """Lower case, umlauts folded (device names may be German), same length as the input."""
    return s.lower().translate(str.maketrans({"ä": "a", "ö": "o", "ü": "u", "ß": "s", "&": " ", "-": " ", "_": " ", "/": " ", "’": "'", "‘": "'"}))


# ---------------------------------------------------------------------------------------------- language
EN_HINTS = {
    "when", "whenever", "while", "if", "unless", "the", "turn", "switch", "set", "is", "are", "then", "on", "off", "for", "minutes",
    "minute", "hours", "someone", "somebody", "everyone", "everybody", "nobody", "opens", "closes", "open", "light", "lights", "door",
    "window", "at", "after", "before", "only", "any", "all", "home", "leaves", "arrives", "comes", "goes", "send", "notify", "me",
    "it", "dim", "heating", "and", "of", "to", "room", "night", "morning", "evening", "weekdays", "dark", "please",
}
DE_HINTS = {
    "wenn", "solange", "sobald", "falls", "dann", "und", "der", "die", "das", "den", "dem", "ist", "sind", "mach", "mache", "schalte",
    "schalt", "aus", "minuten", "uhr", "jemand", "alle", "allen", "niemand", "keiner", "nur", "licht", "tur", "fenster", "auf", "geht",
    "kommt", "im", "nach", "heizung", "bitte", "einschalten", "ausschalten", "nachts", "abends", "morgens", "werktags", "dunkel", "zu",
    "wird", "ein", "eine", "einen", "sonst", "mir", "mich", "ich", "wir",
}


def detect_language(text: str, fallback: str = "de") -> str:
    """Which language a rule sentence is written in: by its small words; a tie goes to the fallback (the user's language)."""
    words = re.findall(r"[a-z']+", fold_en(text))
    en = sum(1 for w in words if w in EN_HINTS)
    de = sum(1 for w in words if w in DE_HINTS)
    # "an" and "in" exist in both languages and are not counted
    if en > de:
        return "en"
    if de > en:
        return "de"
    return "en" if fallback == "en" else "de"


# ---------------------------------------------------------------------------------------------- words
# kind words; longer phrases first ("motion sensor" before "motion", "door lock" before "door")
KIND_WORDS: list[tuple[str, str]] = [
    ("temperature sensor", "temperature"), ("thermometer", "temperature"), ("temperature", "temperature"),
    ("motion sensors", "motion"), ("motion sensor", "motion"), ("motion detector", "motion"), ("motion", "motion"), ("movement", "motion"),
    ("water sensor", "leak"), ("leak sensor", "leak"), ("water leak", "leak"), ("leak", "leak"), ("flood", "leak"),
    ("light sensor", "illuminance"), ("light level", "illuminance"), ("brightness", "illuminance"), ("illuminance", "illuminance"),
    ("lights", "light"), ("light", "light"), ("lamps", "light"), ("lamp", "light"), ("lighting", "light"),
    ("heating", "climate"), ("heaters", "climate"), ("heater", "climate"), ("radiators", "climate"), ("radiator", "climate"),
    ("thermostats", "climate"), ("thermostat", "climate"), ("air conditioning", "climate"),
    ("windows", "window"), ("window", "window"),
    ("door lock", "lock"), ("locks", "lock"), ("lock", "lock"),
    ("doors", "door"), ("door", "door"),
    ("blinds", "cover"), ("blind", "cover"), ("shutters", "cover"), ("shutter", "cover"), ("curtains", "cover"), ("curtain", "cover"),
    ("awning", "cover"), ("covers", "cover"),
    ("robot vacuum", "vacuum"), ("vacuum cleaner", "vacuum"), ("vacuum", "vacuum"), ("robot", "vacuum"), ("hoover", "vacuum"),
    ("air purifier", "purifier"), ("purifier", "purifier"),
    ("fans", "fan"), ("fan", "fan"),
    ("outlets", "outlet"), ("outlet", "outlet"), ("sockets", "outlet"), ("socket", "outlet"), ("plugs", "outlet"), ("plug", "outlet"),
    ("speakers", "media"), ("speaker", "media"), ("music", "media"), ("radio", "media"), ("tv", "media"), ("television", "media"), ("telly", "media"),
    ("water", "leak"),
]
KIND_WORDSET = {w for w, _k in KIND_WORDS} | {"water", "moves"}
# single words that end like a kind word but are none ("highlight", "spotlight" is a light, "daylight" is not)
NOT_KIND = {"daylight", "sunlight", "highlight", "twilight", "moonlight"}
TV_WORDS = ("tv", "television", "telly")
TV_NAMES = re.compile(r"\btv\b|television|fernseh|samsung|lg |bravia|apple tv|monitor")
PLURAL_KIND = {
    "lights", "lamps", "heaters", "radiators", "thermostats", "windows", "locks", "doors", "blinds", "shutters", "curtains", "covers",
    "fans", "outlets", "sockets", "plugs", "speakers", "motion sensors",
}

MODE_WORDS = [
    (r"sleep\w*|bedtime|night mode", "sleep"),
    (r"vacation|holidays?", "vacation"),
    (r"away|absent", "away"),
    (r"guests?|visitors?|party", "guests"),
    (r"home|normal", "home"),
]

STOP = set(
    """
    when whenever while if unless then and or the a an of to in on at is are be been being was were it its it's this that these
    those for from with by as also only but not no any some all every each everyone everybody someone somebody anyone anybody nobody
    one me my mine i i'm we we're us our you he she they them his her their there here so just again still more up down out into
    onto over under minute minutes min mins hour hours hr hrs second seconds sec secs day days than longer o'clock oclock am pm
    degrees degree percent house home has have had do does did will would should can could make makes turn turns switch set get gets
    got goes going go please now right immediately automatically soon once after before already yet too very really whole entire
    left back off
    """.split()
)

GENERIC = GENERIC_TOKENS | {
    "light", "lights", "lamp", "sensor", "door", "window", "heating", "outlet", "switch", "contact", "motion", "presence", "occupancy",
    "temperature", "level", "plug", "socket", "smart", "outdoor", "outside", "indoor", "inside", "strip", "power", "main", "ceiling", "room",
}
SYNONYMS = {"couch": "sofa", "lounge": "living", "hall": "hallway", "entrance": "hallway", "desk lamp": "desk", "stove": "hob"}

NUMBERS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "ten": 10, "fifteen": 15, "twenty": 20, "thirty": 30}
NUM = r"\d+|an?|one|two|three|four|five|ten|fifteen|twenty|thirty|half an?|half a"
UNIT = r"seconds?|secs?|minutes?|mins?|hours?|hrs?|days?"
CLOCK = r"(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|o'?clock|h)?"


def _hm(h: str, m: str | None, suffix: str | None) -> str:
    hour = int(h)
    suf = (suffix or "").replace(".", "")
    if suf == "pm" and hour < 12:
        hour += 12
    if suf == "am" and hour == 12:
        hour = 0
    return f"{hour % 24:02d}:{m or '00'}"


def _dur(num: str, unit: str) -> str:
    if num.startswith("half"):
        return "30m" if unit.startswith(("hour", "hr")) else "30s"
    n = NUMBERS.get(num) or int(num)
    u = "s" if unit.startswith("sec") else "h" if unit.startswith(("hour", "hr")) else "d" if unit.startswith("day") else "m"
    return f"{n}{u}"


# negation of a state ("unless any window is open" = "only if every window is closed")
NEGATE = {
    "is_open": "is_closed", "is_closed": "is_open", "is_on": "is_off", "is_off": "is_on", "is_home": "is_away", "is_away": "is_home",
    "is_occupied": "is_empty", "is_empty": "is_occupied", "is": "is_not", "is_not": "is", "is_down": "is_up", "is_up": "is_down",
    "is_active": "is_clear", "is_clear": "is_active", "is_free": "is_occupied", "is_armed": "is_disarmed", "is_disarmed": "is_armed",
    "in_zone": "not_in_zone", "not_in_zone": "in_zone", "is_dark": "is_bright", "is_bright": "is_dark",
}


class EnglishSentenceParser(SentenceParser):
    def __init__(self, core: HouseRules, me: str | None = None) -> None:
        super().__init__(core, me)
        self.stop = STOP
        self.kind_words = KIND_WORDSET
        self.generic = GENERIC
        self.synonyms = SYNONYMS
        self.default_announce = "Hello"
        self.said_skip = ("on", "over", "through", "via", "loud", "loudly", "saying", "say", "announce")
        self.room_words = {fold_en(r["name"]): r for r in self.rooms}
        self.person_words = {fold_en(p["name"]).split(" ")[0]: p for p in self.inv.persons.values() if p.get("name")}
        self.devices = []
        for d in self.inv.devices.values():
            n = fold_en(d["name"]).strip()
            self.devices.append((d, n, re.findall(r"[a-z0-9]+", n)))
        self._late: str | None = None
        self.hint_room: dict[str, Any] | None = None
        self.lang = "en"
        # the words of room names ("living room") never name a device on their own
        self.roomish_extra = {w for n in self.room_words for w in re.findall(r"[a-z0-9]+", n)}

    # ------------------------------------------------------------------ main
    def parse(self, text: str) -> tuple[dict[str, Any], list[str], list[str]]:
        original = text
        t = fold_en(text)
        rule: dict[str, Any] = {"type": "when", "when": [], "and": [], "then": [], "only": []}
        whole = Part(t, 0)

        message = None
        if mq := re.search(r"[“\"]([^”\"]+)[”\"]", original):
            message = mq.group(1).strip()
            whole.mark(mq.start(), mq.end())
            t = t[: mq.start()] + " " * (mq.end() - mq.start()) + t[mq.end() :]
            whole.text = t

        if re.search(r"\b(while|as long as)\b", t):
            rule["type"] = "while"

        has_time_trigger = bool(re.search(rf"\bat {CLOCK}", t) and re.search(r"\bat \d{1,2}(?:[:.]\d{2}|\s*(?:am|pm|a\.m\.|p\.m\.|o'?clock|h)\b)", t)) and not re.search(r"\bbetween \d", t)
        rule["only"] += self._qualifiers(whole, has_time_trigger)
        t = self._blank(whole)
        # "only if …" / "unless …": conditions that limit the rule
        only_parts: list[tuple[Part, bool]] = []
        for m in list(re.finditer(r"\b(?:but )?(only (?:if|when|while)|unless|except (?:when|if))\b([^,;]*)", t)):
            if re.search(r"[a-z]{2,}", m.group(2)):
                only_parts.append((Part(m.group(2), m.start(2)), m.group(1).startswith(("unless", "except"))))
            t = t[: m.start()] + " " * (m.end() - m.start()) + t[m.end() :]
        whole.text = t
        whole.used = [False] * len(t)
        triggers = self._fixed_triggers(whole, rule["type"] == "while")
        t = self._blank(whole)

        act_else = None
        if (m := re.search(r"[,;]?\s*\b(otherwise|or else|else)\b", t)) and re.search(r"[a-z]{2,}", t[m.end() :]):
            act_else = Part(t[m.end() :], m.end())
            t = t[: m.start()] + " " * (len(t) - m.start())
            rule["type"] = "while"
        cond, act = self._split(t)
        # "…, play music, and when it is empty again, turn it off"
        if act_else is None and (
            m := re.search(
                r"[,;]?\s*\b(?:and )?(?:when|once|as soon as|if) (?:it|he|she|they|the room|the \w+) (?:is |are |gets |becomes |goes )?(?:empty|free|clear|closed|shut|away|gone|over|off)(?: again)?\b\s*(?:,|then)?",
                act.text,
            )
        ) and re.search(r"[a-z]{2,}", act.text[m.end() :]):
            act_else = Part(act.text[m.end() :], act.start + m.end())
            act = Part(act.text[: m.start()], act.start)
            rule["type"] = "while"
        names = "|".join(re.escape(w) for w in self.person_words if len(w) >= 3)
        if names and (m := re.search(rf"\b({names})\s*(?:,|and|&)\s*({names})\b(?:\s*(?:,|and)\s*({names})\b)*", cond.text)):
            cond.text = cond.text[: m.start()] + "everyone".ljust(m.end() - m.start()) + cond.text[m.end() :]
            self.unsure.append("Several people named: I took “everyone”.")
        self.hint_room = self._room_in(act.text)
        cond_parts = self._pieces(cond, r",|\band\b|\bor\b") if cond.text.strip() else []
        cond_or = [bool(re.search(r"\bor\s*$", t[max(0, p.start - 5) : p.start])) for p in cond_parts]

        trigger_taken = bool(triggers)
        rule["when"] += triggers
        state_type = rule["type"] == "while"
        last_state: dict[str, Any] | None = None
        for i, p in enumerate(cond_parts):
            if not re.search(r"[a-z]{2,}", p.text):
                continue
            as_event = not state_type and (not trigger_taken or cond_or[i])
            c = self._condition(p, "event" if as_event else "state", cond_parts)
            if not c:
                self.leftover += p.leftover(self.stop)
                continue
            if not as_event and cond_or[i] and last_state is not None:
                last_state.setdefault("or", []).append(c)
            elif state_type and not rule["when"]:
                rule["when"].append(c)
                last_state = c
            elif as_event:
                rule["when"].append(c)
                trigger_taken = True
            else:
                rule["and"].append(c)
                last_state = c
            self.leftover += p.leftover(self.stop)

        for part, negated in only_parts:
            last_only: dict[str, Any] | None = None
            for p in self._pieces(part, r",|\band\b|\bor\b"):
                if not re.search(r"[a-z]{2,}", p.text):
                    continue
                c = self._condition(p, "state", [])
                if not c:
                    self.leftover += p.leftover(self.stop)
                    continue
                if negated:
                    neg = NEGATE.get(c["verb"])
                    if neg is None:
                        self.unsure.append("“Unless …” could not be turned around for this part, please check it.")
                    else:
                        c["verb"] = neg
                        if c["subject"] == "person:someone" and neg in ("is_away", "is_home"):
                            c["subject"] = "person:everyone"
                        elif c["subject"].startswith("any:") and neg in ("is_closed", "is_off", "is_empty", "is_clear"):
                            c["subject"] = "all:" + c["subject"][4:]
                is_or = bool(re.search(r"\bor\s*$", part.text[max(0, p.start - part.start - 5) : p.start - part.start]))
                if is_or and last_only is not None and not negated:
                    last_only.setdefault("or", []).append(c)
                else:
                    rule["only"].append(c)
                    last_only = c
                self.leftover += p.leftover(self.stop)

        trig = rule["when"][0] if rule["when"] else None
        rule["then"] = self._actions(act, trig, message, original, rule)
        if act_else is not None:
            rule["else"] = self._actions(act_else, trig, None, original, rule, fallback=self._last_subjects)

        # "Turn off the kitchen light after 10 minutes when nobody is there": the delay belongs to "empty"
        if trig and trig.get("verb") in ("empty", "free_for", "empty_for") and self._late:
            trig["verb"] = "empty_for" if trig["subject"].startswith("room:") else "free_for"
            trig["for"] = self._late
            rule["then"] = [c for c in rule["then"] if c.get("verb") != "wait"]

        if not rule["when"]:
            self.unsure.append("When should it happen?")
        if not rule["then"]:
            self.unsure.append("What should happen then?")
        self._same_room(rule)
        return rule, list(dict.fromkeys(self.unsure)), list(dict.fromkeys(self.leftover))

    # ------------------------------------------------------------------ helpers
    def _split(self, t: str) -> tuple[Part, Part]:
        """→ (condition, action)"""
        m = re.search(
            r"\b(whenever|every time|each time|as soon as|as long as|while|when|once|if|after(?!\s+(?:\d|an?\b|one|two|three|five|ten|fifteen|twenty|thirty|half|sunset|sunrise|dark|that)))\b",
            t,
        )
        if not m:
            arrow = re.search(r"\s*(→|->|=>|:|⇒)\s*", t)
            if arrow:
                return Part(t[: arrow.start()], 0), Part(t[arrow.end() :], arrow.end())
            return Part("", 0), Part(t, 0)
        before = t[: m.start()]
        after_start = m.end()
        after = t[after_start:]
        if re.search(r"[a-z]{3,}", before) and [w for w in re.findall(r"[a-z']+", before) if w not in STOP]:
            # action first: "Turn off the hallway light when nobody is there for 5 minutes"
            return Part(after, after_start), Part(before, 0)
        cut = re.search(r",|\bthen\b", after)
        if cut:
            return Part(after[: cut.start()], after_start), Part(after[cut.end() :], after_start + cut.end())
        # no comma: the action starts with its verb ("When the door opens turn on the light")
        for v in re.finditer(r"\b(turn|switch|set|dim|send|notify|tell|text|announce|say|start|stop|pause|play|resume|lock|unlock|raise|lower|arm|disarm|run|activate|flash|blink|make|put|let|close|open|boost)\b", after):
            if re.search(r"\b(is|are|gets|get|been|be|was|were|being|left)\s*$", after[: v.start()]):
                continue
            if v.start() > 0 and re.search(r"[a-z]{3,}", after[: v.start()]):
                return Part(after[: v.start()], after_start), Part(after[v.start() :], after_start + v.start())
        return Part(after, after_start), Part("", len(t))

    # ------------------------------------------------------------------ qualifiers (only …)
    def _qualifiers(self, p: Part, time_trigger: bool) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        t = p.text
        if m := p.find(rf"\b(?:between|from) {CLOCK} (?:and|to|until|till|through) {CLOCK}"):
            s1, s2 = m.group(3), m.group(6)
            if not s1 and s2 in ("am", "a.m.") and int(m.group(1)) > int(m.group(4)):
                s1 = "pm"
            elif not s1 and s2 in ("pm", "p.m."):
                s1 = "pm" if int(m.group(1)) <= int(m.group(4)) else None
            out.append({"subject": "time", "verb": "between", "from": _hm(m.group(1), m.group(2), s1), "to": _hm(m.group(4), m.group(5), s2)})
        if m := p.find(r"\b(?:after|from|later than) (\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)(?![a-z])|\b(?:after|later than) (\d{1,2})[:.](\d{2})\b"):
            h, mi, suf = (m.group(1), m.group(2), m.group(3)) if m.group(1) else (m.group(4), m.group(5), None)
            out.append({"subject": "time", "verb": "between", "from": _hm(h, mi, suf), "to": "23:59"})
        if m := p.find(r"\b(?:before|until|till|earlier than) (\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)(?![a-z])|\b(?:before|until|earlier than) (\d{1,2})[:.](\d{2})\b"):
            h, mi, suf = (m.group(1), m.group(2), m.group(3)) if m.group(1) else (m.group(4), m.group(5), None)
            out.append({"subject": "time", "verb": "between", "from": "00:00", "to": _hm(h, mi, suf)})
        p.find(r"\b(every|each)\s+(day|morning|evening|night|week)\b|\bdaily\b")
        if m := p.find(r"\b(?:(unless|except) )?(?:at night|during the night|overnight|at nighttime|nightly)\b"):
            out.append({"subject": "time", "verb": "night"} if not m.group(1) else {"subject": "time", "verb": "between", "from": "06:00", "to": "22:00"})
        for pat, verb in ((r"\b(in the evenings?|evenings|at evening|tonight)\b", "evening"), (r"\b(in the mornings?|mornings|early in the morning)\b", "morning")):
            m = re.search(pat, p.text)
            if m:
                p.mark(m.start(), m.end())
                if not time_trigger:
                    out.append({"subject": "time", "verb": verb})
        if p.find(r"\b(on weekdays|weekdays|on workdays|workdays|on working days|during the week|monday (?:to|through|till|until) friday|mondays? (?:to|through) fridays?|mon ?(?:to|through)? ?fri)\b"):
            out.append({"subject": "time", "verb": "workdays"})
        if p.find(r"\b(on (?:the )?weekends?|at (?:the )?weekends?|weekends|on saturdays? and sundays?)\b"):
            out.append({"subject": "time", "verb": "weekend"})
        dark = r"(?:(?:and |but )?(?:only )?(?:if|when|while) |(unless) )?it(?:'s| is) (?:already |still )?dark(?: outside)?\b|\bafter dark\b|\bin the dark\b|\bwhen dark\b"
        light = r"(?:(?:and |but )?(?:only )?(?:if|when|while) |(unless) )?it(?:'s| is) (?:still )?(?:light|bright|daytime)(?: outside)?\b|\bduring the day(?:time)?\b|\bin daylight\b"
        # "after sunset" next to another trigger is a limit ("When the front door opens after sunset …"), on its own it is the trigger
        if re.search(r"\b(when|whenever|while|if|as soon as|once)\b", t):
            dark += r"|\bafter sunset\b|\bbefore sunrise\b"
            light += r"|\bafter sunrise\b|\bbefore sunset\b"
        if m := p.find(rf"\b{dark}"):
            out.append({"subject": "sun", "verb": "is_up" if m.group(1) else "is_down"})
        if m := p.find(rf"\b{light}"):
            out.append({"subject": "sun", "verb": "is_down" if m.group(1) else "is_up"})
        if m := p.find(r"\b(unless|except (?:when|if)|but not|not) (?:when |if |while )?(?:we(?:'re| are) |i(?:'m| am) |everyone is )?(?:on|in) (?:vacation|holidays?)(?: mode)?|\b(?:(?:when |while |if )?(?:we(?:'re| are) |i(?:'m| am) )?(?:on|in)|during) (?:vacation|holidays?)(?: mode)?\b"):
            out.append({"subject": "mode", "verb": "is_not" if m.group(1) else "is", "mode": "vacation"})
        return out

    # ------------------------------------------------------------------ fixed triggers
    def _fixed_triggers(self, p: Part, state: bool) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if state:
            return out
        for m in list(re.finditer(rf"\bat {CLOCK}(?![a-z])", p.text)):
            if not m.group(2) and not m.group(3):
                continue
            p.mark(m.start(), m.end())
            out.append({"subject": "time", "verb": "at", "time": _hm(m.group(1), m.group(2), m.group(3))})
        for word, verb in (("sunset|sundown|dusk", "sets"), ("sunrise|dawn", "rises")):
            if m := p.find(rf"\b({NUM})\s*({UNIT}) (before|after) (?:{word})\b"):
                d = _dur(m.group(1), m.group(2))
                out.append({"subject": "sun", "verb": verb, "offset": ("-" if m.group(3) == "before" else "") + d})
                continue
            go = "sets|goes down" if verb == "sets" else "rises|comes up"
            if p.find(rf"\b(?:at|after|on|with) (?:{word})\b|\b(?:the )?sun (?:{go})\b|\b(?:{word})\b"):
                out.append({"subject": "sun", "verb": verb})
        # "as soon as it gets dark" without a room: the sun
        m = re.search(r"\bit(?:'s| is)? (?:gets|getting|becomes|goes) dark\b|\bit gets dark\b", p.text)
        if m and not self._room_in(p.text[m.end() : m.end() + 30]) and not self._room_in(p.text[max(0, m.start() - 25) : m.start()]):
            p.mark(m.start(), m.end())
            out.append({"subject": "sun", "verb": "sets"})
        # "on motion in the hallway …": a trigger phrase without "when"
        m = re.search(r"\b(?:on|upon|with) (motion|movement|presence)\b(?:\s+in (?:the )?(\w+(?: room)?))?", p.text)
        if m and not re.search(r"\b(when|whenever|if|as soon as|once)\b", p.text):
            sub = Part(m.group(0)[m.group(0).index(m.group(1)) :], p.start + m.start() + m.group(0).index(m.group(1)))
            c = self._condition(sub, "event", [])
            if c:
                p.mark(m.start(), m.end())
                out.append(c)
        return out

    # ------------------------------------------------------------------ kind words
    def _kind_word(self, p: Part) -> tuple[str, str, dict[str, Any] | None, re.Match[str]] | None:
        """'kitchen lights' → ('light', 'lights', room Kitchen); the first kind word (phrase) in the part."""
        best = None
        for phrase, kind in KIND_WORDS:
            for m in re.finditer(rf"(?<![a-z]){re.escape(phrase)}(?![a-z])", p.text):
                if any(p.used[m.start() : m.end()]):
                    continue
                if best is None or m.start() < best[3].start() or (m.start() == best[3].start() and len(phrase) > len(best[1])):
                    best = (kind, phrase, None, m)
                break
        if best is None:
            # one-word compounds: "nightlight", "floorlamp"
            for m in re.finditer(r"[a-z]+", p.text):
                w = m.group(0)
                if w in NOT_KIND or any(p.used[m.start() : m.end()]):
                    continue
                for suf, kind in (("lights", "light"), ("light", "light"), ("lamp", "light"), ("lamps", "light")):
                    if w.endswith(suf) and len(w) > len(suf) + 2:
                        best = (kind, w, None, m)
                        break
                if best:
                    break
        if best is None:
            return None
        kind, phrase, _r, m = best
        room = self._room_in(p.text[max(0, m.start() - 30) : m.start()])
        return kind, phrase, room, m

    def _room_in(self, text: str) -> dict[str, Any] | None:
        for name, r in sorted(self.room_words.items(), key=lambda x: -len(x[0])):
            stem = name[:-1] if name.endswith("e") and len(name) > 4 else name
            if re.search(rf"\b{re.escape(stem)}", text):
                return r
        return None

    def _room_words_pattern(self, room: dict[str, Any]) -> str:
        n = fold_en(room["name"])
        return re.escape(n[:-1] if n.endswith("e") and len(n) > 4 else n) + r"\w*"

    # ------------------------------------------------------------------ conditions
    def _condition(self, p: Part, role: str, siblings: list[Part]) -> dict[str, Any] | None:
        t = p.text
        state = role == "state"
        dur = self._duration(p)

        # house mode
        if re.search(r"\b(house )?mode\b", t) or re.search(r"\b(?:the )?house (?:is |goes |changes |switches )?(?:to |into |in )?(?:sleep|vacation|away|guest|home)", t):
            p.find(r"\b(house )?mode\b")
            for pat, mode in MODE_WORDS:
                if p.find(rf"\b(?:to |into |in |is )?(?:{pat})\b"):
                    neg = bool(p.find(r"\bnot\b|\bisn't\b"))
                    p.find(r"\b(changes|switches|goes|is|becomes|turns|set|the house)\b")
                    if state:
                        return {"subject": "mode", "verb": "is_not" if neg else "is", "mode": mode}
                    return {"subject": "mode", "verb": "changes_to", "mode": mode}
        # alarm system
        if re.search(r"\balarm( system)?\b", t) and re.search(r"goes off|went off|is triggered|triggered|sounds|disarmed|armed|turned off|switched off", t):
            p.find(r"\b(the )?alarm( system)?\b")
            if p.find(r"goes off|went off|is triggered|triggered|sounds"):
                return {"subject": "alarm", "verb": "is_triggered" if state else "triggered"}
            if p.find(r"disarmed|turned off|switched off"):
                return {"subject": "alarm", "verb": "is_disarmed" if state else "disarmed"}
            p.find(r"\barmed\b")
            return {"subject": "alarm", "verb": "is_armed" if state else "armed"}

        open_w = re.search(r"\b(opens|opened|gets opened|is open|are open|open|left open|stands open)\b", t)
        close_w = re.search(r"\b(closes|closed|gets closed|is closed|are closed|shuts|shut)\b", t)
        on_w = re.search(r"\b(turns on|turned on|switched on|switches on|comes on|is on|are on|on|starts|started|running|runs)\b", t)
        off_w = re.search(r"\b(turns off|turned off|switched off|switches off|goes off|is off|are off|off|stops|stopped)\b", t)
        sit_w = re.search(r"\b(sits?|sitting|sat|lies|lying|lays|stands|standing|goes to bed|go to bed|gets into bed|in bed|on the sofa|on the couch|at the desk)\b", t)
        enter_w = re.search(r"\b(enters?|entering|entered|comes? in|comes? into|walks? in|walks? into|goes? into|steps? into|into)\b", t)
        empty_w = re.search(r"\b(nobody|no one|noone|empty|vacant|no person)\b", t)
        person_w = re.search(
            r"\b(comes? home|coming home|gets? home|getting home|arrives?(?: home)?|arriving|returns?(?: home)?|back home|leaves?|leaving|left|goes? out|going out|gone|heads? out|is away|are away|away|out of the house|drives? off|on (?:the|their|his|her|my|our) way home|heading home|heads? home|home|here)\b",
            t,
        )

        people = self._persons(p)
        everyone = re.search(r"\b(everyone|everybody|all of us|we|nobody|no one|all)\b", t)
        someone = re.search(r"\b(someone|somebody|anyone|anybody|a person)\b", t)
        me = re.search(r"\b(i|me|i'm)\b", t)

        devs = self._device_hits(p, None)
        kw = self._kind_word(p)
        room = self._room_in(t)
        if not room and not kw and self.hint_room and (enter_w or (empty_w and not re.search(r"\b(home|in the house|in the flat|in the apartment)\b", t))):
            room = self.hint_room

        if p.find(r"\b(the )?(house|flat|apartment|home)\s+(is\s+)?empty\b"):
            return {"subject": "person:everyone", "verb": "is_away" if state else "leaves"}
        if re.search(r"\b(we|everyone|everybody)\b.*\b(go(?:es)? to (?:bed|sleep)|are asleep|is asleep|sleep)\b", t):
            p.find(r"\b(we|everyone|everybody)\b")
            p.find(r"\b(go(?:es)? to (?:bed|sleep)|are asleep|is asleep|sleep)\b")
            return {"subject": "mode", "verb": "is" if state else "changes_to", "mode": "sleep"}
        if sit_w and not open_w:
            zhits = [h for h in self._device_hits(p, PERSON_KINDS) if h[0] >= 20]
            if zhits:
                _score, d, span = zhits[0]
                p.mark(*span)
                p.mark(sit_w.start(), sit_w.end())
                for m in (someone, me, everyone):
                    if m:
                        p.mark(m.start(), m.end())
                if empty_w:
                    p.mark(empty_w.start(), empty_w.end())
                return self._presence(d, state, bool(empty_w), dur)

        zone_c = self._zone_clause(p, people, me, state)
        if zone_c:
            return zone_c
        # phrases about where somebody is going (vocabulary PHRASES.en: "probably coming home", "home in 10 minutes" …)
        phrase_c = self._phrase(p, people, me, everyone, someone, state)
        if phrase_c:
            return phrase_c
        homeish = re.search(r"\bhome\b", t)
        if person_w and not (enter_w and room and not homeish) and not (empty_w and room) and not (devs and devs[0][0] >= 40 and not people and not me and not someone and not everyone):
            who = None
            if people:
                who = f"person:{people[0][0]}"
                p.mark(people[0][1].start(), people[0][1].end())
            elif me and self.me:
                who = f"person:{self.me}"
                p.mark(me.start(), me.end())
            elif everyone:
                who = "person:everyone"
                p.mark(everyone.start(), everyone.end())
            elif someone:
                who = "person:someone"
                p.mark(someone.start(), someone.end())
            elif me:
                who = "person:someone"
                p.mark(me.start(), me.end())
                self.unsure.append("Who is “I”? I took “someone”.")
            if who and (km := re.search(r"(?:more than|over|further than|farther than)?\s*(\d+)\s*(km|kilometers?|kilometres?|miles?)\b", t)):
                p.mark(km.start(), km.end())
                p.mark(person_w.start(), person_w.end())
                p.find(r"\b(from|away from)\s+(home|the house)\b")
                p.find(r"\b(away|is|are|am)\b")
                p.find(r"\b(away|is|are|am)\b")
                dist = int(km.group(1))
                if km.group(2).startswith("mile"):
                    dist = round(dist * 1.609)
                return {"subject": who, "verb": "is_far" if state else "far_from", "distance": dist, "zone": "home", **({"for": dur} if dur else {})}
            if who:
                p.mark(person_w.start(), person_w.end())
                for _ in range(3):
                    p.find(r"\b(the house|the flat|home|back|is|are|am|has|have|anymore|any more|there)\b")
                leave = re.search(r"\b(leaves?|leaving|left|goes? out|going out|gone|heads? out|away|out of the house|drives? off)\b", t) or (everyone and re.search(r"\b(nobody|no one)\b", t))
                if re.search(r"\bon (?:the|their|his|her|my|our) way home\b|\bheading home\b|\bheads? home\b", t):
                    return {"subject": who, "verb": "is_near" if state else "coming_home"}
                if re.search(r"\b(comes? home|coming home|gets? home|getting home|arrives?|arriving|returns?|back home)\b", t):
                    return {"subject": who, "verb": "is_home" if state else "arrives"}
                if leave and not re.search(r"\bnot away\b", t):
                    if everyone and re.search(r"\b(nobody|no one)\b", t) and not re.search(r"\b(leaves?|left|goes? out|away)\b", t):
                        return {"subject": "person:everyone", "verb": "is_away" if state else "leaves"}
                    return {"subject": who, "verb": "is_away" if state else "leaves"}
                if re.search(r"\b(nobody|no one)\b|\bnot (?:at )?home\b|\bisn't home\b|\baren't home\b", t):
                    return {"subject": "person:everyone" if who in ("person:everyone", "person:someone") else who, "verb": "is_away" if state else "leaves"}
                return {"subject": who, "verb": "is_home" if state else "arrives"}

        # temperature with a number
        if (num := re.search(r"(-?\d{1,3}(?:[.,]\d)?)\s*(?:degrees?|°c?|°f?)", t)) and ((kw and kw[0] == "temperature") or re.search(r"warm|cold|hot|temperature", t)):
            above = bool(re.search(r"\b(above|over|more than|warmer|hotter|rises|exceeds|higher than|greater than|goes up)\b", t))
            target_room = (kw[2] if kw else None) or room
            sensor = self._pick_sensor("temperature", target_room, p)
            if sensor:
                p.mark(num.start(), num.end())
                p.find(r"\b(above|below|under|over|more than|less than|warmer than|colder than|rises|falls|drops|exceeds|higher than|lower than|goes up|goes down)\b")
                p.find(r"\b(temperature\w*|warm|cold|hot|it|gets|is)\b")
                p.find(r"\b(temperature\w*|warm|cold|hot|it|gets|is)\b")
                if target_room:
                    p.find(rf"\b(?:in )?(?:the )?{self._room_words_pattern(target_room)}")
                value = float(num.group(1).replace(",", "."))
                if state:
                    if above:
                        self.unsure.append("“Warmer than …” does not exist as a condition yet, only as a trigger.")
                        return None
                    return {"subject": sensor, "verb": "is_below", "value": value}
                return {"subject": sensor, "verb": "above" if above else "below", "value": value}
        if re.search(r"\bdark\b|\bbright\b", t):
            target_room = room or (kw[2] if kw else None)
            dark = bool(re.search(r"\bdark\b", t))
            if target_room:
                sensor = self._pick_sensor("illuminance", target_room, p)
                for _ in range(3):
                    p.find(r"\b(it|it's|gets|is|becomes|dark|bright|getting)\b")
                p.find(rf"\b(?:in )?(?:the )?{self._room_words_pattern(target_room)}")
                if state:
                    return {"subject": f"room:{target_room['id']}", "verb": "is_dark" if dark else "is_bright"}
                if sensor and dark:
                    return {"subject": sensor, "verb": "below", "value": target_room.get("dark_below") or 80}
                return {"subject": "sun", "verb": "sets" if dark else "rises"}
            for _ in range(3):
                p.find(r"\b(it|it's|gets|is|becomes|dark|bright|outside|getting)\b")
            if state:
                return {"subject": "sun", "verb": "is_down" if dark else "is_up"}
            return {"subject": "sun", "verb": "sets" if dark else "rises"}

        allowed: set[str] | None = None
        # "Robbie starts": a well-named robot vacuum or speaker, not something switched on
        named = devs[0][1]["kind"] if devs and devs[0][0] >= 40 else None
        if open_w or close_w:
            allowed = OPENABLE | {"lock"}
        elif re.search(r"\b(water|wet|leak\w*|flood\w*)\b", t):
            allowed = {"leak"}
        elif re.search(r"\b(motion|movement|moves|moving)\b", t):
            allowed = {"motion", "presence", "zone"}
        elif re.search(r"\b(is heating|are heating|starts heating|heats|start heating)\b", t):
            allowed = {"climate"}
        elif re.search(r"\b(done|finished|finishes|cleaned|vacuumed|is cleaning)\b", t):
            allowed = {"vacuum"}
        elif re.search(r"\b(unlocked|locked)\b", t):
            allowed = {"lock"}
        elif re.search(r"\b(playing|plays|music)\b", t):
            allowed = {"media"}
        elif (on_w or off_w) and named not in ("vacuum", "media", "climate", "script"):
            allowed = SWITCHABLE

        hits = self._device_hits(p, allowed)
        if kw and kw[0] == "media" and kw[1] in TV_WORDS:
            hits = [h for h in self._device_hits(p, {"media"}) if TV_NAMES.search(fold_en(h[1]["name"]))] or [
                (30, d, (kw[3].start(), kw[3].end())) for d, n, _t in self.devices if d["kind"] == "media" and TV_NAMES.search(n)
            ]
        if hits and hits[0][0] >= 25:
            _s, d, span = hits[0]
            p.mark(*span)
            if kw:
                p.mark(kw[3].start(), kw[3].end())
            return self._device_condition(d, p, state, dur, open_w, close_w, on_w, off_w)

        if kw and (allowed is None or kw[0] in allowed or (kw[0] == "light" and allowed == SWITCHABLE)):
            kind, word, kroom, m = kw
            p.mark(m.start(), m.end())
            target_room = kroom or room or (self.hint_room if not re.search(r"\b(any|all|every|an?)\b", t) else None)
            if target_room:
                p.find(rf"\b(?:in |of )?(?:the )?{self._room_words_pattern(target_room)}")
            cand = self._of_kind(kind, target_room)
            p.find(r"\b(an?|any|one of the|the|all|every|each)\b")
            many = bool(re.search(r"\b(all|every|each)\b", t))
            in_room = bool(target_room and self.inv.in_room(kind, target_room["id"]))
            if len(cand) == 1 and not many and not re.search(r"\b(an?|any)\b", t) and not (in_room and kind in ("window", "door")):
                return self._device_condition(cand[0], p, state, dur, open_w, close_w, on_w, off_w)
            subject = f"{'all' if many else 'any'}:{kind}" + (f"@{target_room['id']}" if target_room and self.inv.in_room(kind, target_room["id"]) else "")
            if target_room and not self.inv.in_room(kind, target_room["id"]) and cand:
                return self._device_condition(cand[0], p, state, dur, open_w, close_w, on_w, off_w)
            if not cand and not self.inv.in_room(kind, None):
                self.unsure.append(f"No device of the kind “{word}” found.")
            return self._placeholder_condition(subject, kind, p, state, dur, open_w, close_w, on_w, off_w)

        if room:
            p.find(rf"\b(?:in |into |in to )?(?:the )?{self._room_words_pattern(room)}")
            for m in (someone, everyone, me):
                if m:
                    p.mark(m.start(), m.end())
            p.find(r"\b(enters?|entering|entered|comes?|walks?|goes?|steps?|in|into|is|are|there|anymore|any more|empty|nobody|no one)\b")
            p.find(r"\b(is|there|anymore|any more|nobody|no one|empty|in)\b")
            p.find(r"\b(is|there|anymore|any more|nobody|no one|empty|in)\b")
            if empty_w:
                if state:
                    return {"subject": f"room:{room['id']}", "verb": "is_empty"}
                return {"subject": f"room:{room['id']}", "verb": "empty_for" if dur else "empty", **({"for": dur} if dur else {})}
            return {"subject": f"room:{room['id']}", "verb": "is_occupied" if state else "entered"}

        if everyone and re.search(r"\b(home|here|there)\b", t):
            p.mark(everyone.start(), everyone.end())
            p.find(r"\b(home|here|there)\b")
            away = bool(re.search(r"\b(nobody|no one|not)\b", t))
            return {"subject": "person:everyone", "verb": ("is_away" if away else "is_home") if state else ("leaves" if away else "arrives")}
        if someone and re.search(r"\b(home|here|there)\b", t):
            p.mark(someone.start(), someone.end())
            p.find(r"\b(home|here|there)\b")
            return {"subject": "person:someone", "verb": "is_home" if state else "arrives"}
        if hits:
            _s, d, span = hits[0]
            p.mark(*span)
            return self._device_condition(d, p, state, dur, open_w, close_w, on_w, off_w)
        return None

    def _zone_clause(self, p: Part, people: list[tuple[str, re.Match[str]]], me: re.Match[str] | None, state: bool) -> dict[str, Any] | None:
        """'Alex leaves work' → leaves_zone with the zone 'Work'."""
        if not self.zones:
            return None
        names = set(self.person_words)
        pid = people[0][0] if people else (self.me if me else None)
        best = None
        for z in self.zones:
            if z.get("id") == "home":
                continue
            toks = [w for w in re.findall(r"[a-z0-9]+", fold_en(z.get("name", ""))) if w not in names and len(w) >= 3 and w not in STOP]
            for w in toks:
                if m := re.search(rf"\b{re.escape(w)}\b", p.text):
                    score = 1 + (2 if pid and pid.split("_")[0] in fold_en(z.get("name", "")) else 0)
                    if not best or score > best[0]:
                        best = (score, z, m)
        if not best:
            return None
        _s, z, m = best
        leave = re.search(r"\b(leaves?|leaving|left|drives? (?:off|away) from|departs?|heads? out of)\b", p.text)
        arrive = re.search(r"\b(arrives?(?: at)?|arriving|reaches|gets? to|comes? to|is at|is in|at)\b", p.text)
        if not (leave or arrive or state):
            return None
        p.mark(m.start(), m.end())
        who = f"person:{pid}" if pid else "person:someone"
        if people:
            p.mark(people[0][1].start(), people[0][1].end())
        elif me:
            p.mark(me.start(), me.end())
        p.find(r"\b(the|from|to|at|in)\b")
        if leave:
            p.mark(leave.start(), leave.end())
            return {"subject": who, "verb": "not_in_zone" if state else "leaves_zone", "zone": z["id"]}
        if arrive:
            p.mark(arrive.start(), arrive.end())
        return {"subject": who, "verb": "in_zone" if state else "enters_zone", "zone": z["id"]}

    def _phrase(self, p: Part, people: list[tuple[str, re.Match[str]]], me: re.Match[str] | None, everyone: re.Match[str] | None, someone: re.Match[str] | None, state: bool) -> dict[str, Any] | None:
        """A person clause from the data-driven English phrases of the vocabulary."""
        for ph in vocabulary().get("phrases", {}).get("en", []):
            m = re.search(ph["re"], p.text)
            if not m:
                continue
            if people:
                who = f"person:{people[0][0]}"
                p.mark(people[0][1].start(), people[0][1].end())
            elif me and self.me:
                who = f"person:{self.me}"
                p.mark(me.start(), me.end())
            elif everyone:
                who = "person:everyone"
                p.mark(everyone.start(), everyone.end())
            elif someone or me:
                hit = someone or me
                assert hit is not None
                who = "person:someone"
                p.mark(hit.start(), hit.end())
                if not someone:
                    self.unsure.append("Who is “I”? I took “someone”.")
            else:
                continue
            p.mark(m.start(), m.end())
            p.find(r"\b(is|are|am|will|be|has|have|been)\b")
            p.find(r"\b(is|are|am|will|be|has|have|been)\b")
            out: dict[str, Any] = {"subject": who, "verb": ph["state"] if state else ph["event"], **(ph.get("params") or {})}
            if ph.get("number") and (n := re.search(r"\d+", m.group(0))):
                value = int(n.group(0))
                if re.search(r"\b(hours?|hrs?)\b", m.group(0)):
                    value *= 60
                out[ph["number"]] = value
            return out
        return None

    def _placeholder_condition(self, subj: str, kind: str, p: Part, state: bool, dur: str | None, open_w: Any, close_w: Any, on_w: Any, off_w: Any) -> dict[str, Any]:
        t = p.text
        for m in (open_w, close_w, on_w, off_w):
            if m:
                p.mark(m.start(), m.end())
        p.find(r"\b(is|are|gets|get|stays|stay|remains|left|longer|for|more than|over|than|been|has|have)\b")
        p.find(r"\b(is|are|gets|get|stays|stay|remains|left|longer|for|more than|over|than|been|has|have)\b")
        c: dict[str, Any] = {"subject": subj}
        closing = bool(close_w) and not open_w
        if kind in OPENABLE and kind != "cover":
            if state:
                c["verb"] = "is_closed" if closing else "is_open"
            elif dur and not closing:
                c["verb"], c["for"] = "open_for", dur
            else:
                c["verb"] = "closes" if closing else "opens"
        elif kind in ("light", "switch", "outlet", "fan", "purifier", "group", "input_boolean"):
            off = bool(off_w) and not on_w
            if state:
                c["verb"] = "is_off" if off else "is_on"
            elif dur and not off:
                c["verb"], c["for"] = "on_for", dur
            else:
                c["verb"] = "turns_off" if off else "turns_on"
        elif kind == "media":
            if state:
                c["verb"] = "is_playing" if re.search(r"\b(playing|plays|music|running)\b", t) else "is_on"
            elif p.find(r"\b(stops|stopped|ends|pauses|paused|turns off|off)\b"):
                c["verb"] = "stops"
            elif p.find(r"\b(plays|playing|starts playing|starts|begins)\b"):
                c["verb"] = "starts_playing"
            else:
                c["verb"] = "turns_on"
        elif kind == "motion":
            p.find(r"\b(motion|movement|detected|detects|sees|moves|is)\b")
            if re.search(r"\bno (?:motion|movement)\b|\bclear\b|\bquiet\b|\bstill\b", t):
                c["verb"] = "is_clear" if state else "clear_for"
                if not state:
                    c["for"] = dur or "5m"
                p.find(r"\b(no|clear|quiet|still)\b")
            else:
                c["verb"] = "is_active" if state else "detected"
        elif kind in ("presence", "zone"):
            free = bool(re.search(r"\b(free|empty|nobody|no one|leaves?|left|clear)\b", t))
            return self._presence({"entity_id": subj.removeprefix("zone:"), "kind": kind}, state, free, dur)
        elif kind == "leak":
            p.find(r"\b(water|wet|leak\w*|detects|detected|reports|flood\w*)\b")
            p.find(r"\b(water|wet|leak\w*|detects|detected|reports|flood\w*)\b")
            c["verb"] = "is_wet" if state else "wet"
        elif kind == "climate":
            p.find(r"\b(heats|heating|starts|begins|is)\b")
            p.find(r"\b(heats|heating|starts|begins|is)\b")
            c["verb"] = "is_heating" if state else "starts_heating"
        elif kind == "vacuum":
            if p.find(r"\b(done|finished|finishes|cleaned|vacuumed|back|docked)\b") or not state:
                c["verb"] = "is_docked" if state else ("starts" if re.search(r"\b(starts|started|begins|leaves|is cleaning|cleans)\b", t) and not re.search(r"done|finish", t) else "done")
            else:
                c["verb"] = "is_docked"
        elif kind == "lock":
            c["verb"] = "is_locked" if state else "unlocked"
            p.find(r"\b(unlocked|locked)\b")
        elif kind == "cover":
            c["verb"] = "is_open" if state else ("closes" if closing or p.find(r"\b(goes down|lowers|lowered)\b") else "opens")
            p.find(r"\b(goes up|raises|raised)\b")
        elif kind in ("temperature", "illuminance"):
            c["verb"] = "is_below" if state else "below"
        else:
            c["verb"] = "is_on" if state else "turns_on"
        return c

    def _duration(self, p: Part) -> str | None:
        m = p.find(rf"(?:(?:longer|more) than|over|for|after|since|at least)?\s*({NUM})\s*({UNIT})\b|\b(\d+)(s|m|h)\b")
        if not m:
            return None
        if m.group(3):
            return f"{m.group(3)}{m.group(4)}"
        return _dur(m.group(1), m.group(2))

    def _pick_sensor(self, kind: str, room: dict[str, Any] | None, p: Part) -> str | None:
        hits = [h for h in self._device_hits(p, {kind}) if h[0] >= 30]
        if hits:
            p.mark(*hits[0][2])
            return hits[0][1]["entity_id"]
        cand = self._of_kind(kind, room)
        if room and room.get("lux") and kind == "illuminance":
            return room["lux"]

        def rank(d: dict[str, Any]) -> int:
            n = fold_en(d["name"])
            return (5 if re.search(r"temperature sensor|thermometer|temperatursensor", n) else 0) + (3 if re.search(r"light|licht", n) else 0) - (
                6 if re.search(r"outdoor|outside|heating|thermostat|ausen|aussen|heizung", n) else 0
            )

        cand.sort(key=lambda d: -rank(d))
        return cand[0]["entity_id"] if cand else None

    def _of_kind(self, kind: str, room: dict[str, Any] | None) -> list[dict[str, Any]]:
        devs = [d for d, _n, _t in self.devices if d["kind"] == kind]
        if not room:
            return devs
        rid = room["id"]
        rn = fold_en(room["name"])
        stem = rn[:-1] if rn.endswith("e") and len(rn) > 4 else rn
        inside = [d for d in devs if d.get("room") == rid]
        named = [d for d in devs if not d.get("room") and re.search(rf"\b{re.escape(stem)}", fold_en(d["name"]))]
        return inside + named

    # ------------------------------------------------------------------ actions
    def _actions(
        self, act: Part, trig: dict[str, Any] | None, message: str | None, original: str, rule: dict[str, Any], fallback: list[Subject] | None = None
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        self._last_subjects = []
        if not act.text.strip():
            return out
        pieces = self._pieces(act, r",|\band then\b|\bthen\b|\band\b|\bafterwards\b|\bafter that\b")
        parsed: list[tuple[Part, list[Subject], str | None, dict[str, Any]]] = []
        trig_dev = self.inv.devices.get(trig["subject"]) if trig else None
        trig_room = self._room_of_clause(trig) if trig else None
        for p in pieces:
            verb, extra = self._action_verb(p)
            self._want = extra.pop("want", None)
            subjects = self._action_subjects(p, verb, trig_dev, trig_room)
            self._want = None
            parsed.append((p, subjects, verb, extra))
        # English puts the verb first: parts without a verb take the one before ("turn on the hall light and the kitchen light")
        for i, (p, subs, verb, extra) in enumerate(parsed):
            if verb is None and subs:
                prev = next(((v, e) for _p, _s, v, e in reversed(parsed[:i]) if v), None) or next(((v, e) for _p, _s, v, e in parsed[i + 1 :] if v), None)
                if prev:
                    parsed[i] = (p, subs, prev[0], {k: v for k, v in prev[1].items() if k not in ("delay",)})
        last: list[Subject] = list(fallback or [])
        for p, subs, verb, extra in parsed:
            if not subs and verb and verb not in ("send", "alarm", "ask", "wait", "set_mode", "announce_any"):
                subs = last or ([Subject(trig_dev["entity_id"], trig_dev["kind"], trig_dev.get("room"), trig_dev)] if trig_dev and trig_dev["kind"] in ACTORS else [])
            if verb == "wait":
                out.append({"subject": "wait", "verb": "wait", "for": extra["for"]})
                if extra.get("then") and last:
                    for s in last:
                        c = self._action_clause(s, extra["then"], {}, p)
                        if c:
                            out.append(c)
                continue
            if verb in ("send", "alarm", "ask"):
                out.append(self._notify(p, verb, message, rule))
                continue
            if verb == "set_mode":
                out.append({"subject": "mode", "verb": "set", "mode": extra["mode"]})
                continue
            if verb in ("arm_away", "arm_night", "arm_home", "disarm"):
                out.append({"subject": "alarm", "verb": verb})
                continue
            if not verb:
                if subs:
                    self.unsure.append(f"What should happen with “{self.core.describer.subject(subs[0].subject)['label']}”? I took “turn on”.")
                    verb = "turn_on"
                else:
                    self.leftover += p.leftover(self.stop)
                    continue
            if extra.get("delay") and subs:
                out.append({"subject": "wait", "verb": "wait", "for": extra["delay"]})
            for s in subs:
                c = self._action_clause(s, verb, extra, p, message, original)
                if c:
                    out.append(c)
            if subs:
                last = subs
                self._last_subjects = subs
            self.leftover += p.leftover(self.stop)
        return out

    def _action_verb(self, p: Part) -> tuple[str | None, dict[str, Any]]:
        t = p.text
        extra: dict[str, Any] = {}
        m = p.find(rf"\b(?:after|in) ({NUM})\s*({UNIT})\b")
        if m:
            dur = _dur(m.group(1), m.group(2))
            self._late = dur
            rest = Part(t[: m.start()] + " " * (m.end() - m.start()) + t[m.end() :], 0)
            things = (self._device_hits(rest, ACTORS) and self._device_hits(rest, ACTORS)[0][0] >= 25) or self._kind_word(rest)
            if things:
                # "turn off the kitchen light after 10 minutes": wait, then switch
                extra["delay"] = dur
            else:
                # "… and turn it off again after 5 minutes": wait, then the same things
                p.find(r"\b(again|it|them|back)\b")
                p.find(r"\b(again|it|them|back)\b")
                off = bool(p.find(r"\b(turn|switch|shut)?\s*(?:it |them )?off\b"))
                p.find(r"\b(turn|switch|on)\b")
                p.find(r"\bon\b")
                return "wait", {"for": dur, "then": "turn_off" if off or not re.search(r"\bon\b", t) else "turn_on"}
        if m := p.find(rf"\bfor ({NUM})\s*({UNIT})\b"):
            extra["for"] = _dur(m.group(1), m.group(2))
        notify = re.search(r"\b(notify|notification|message|text|tell|inform|alert|ping|push|let (?:me|us|\w+) know|send|warn\w*|ask)\b", t)
        robot = [h for h in self._device_hits(p, {"vacuum"}) if h[0] >= 25]
        if notify and not robot and not re.search(r"\b(dock|base|station|vacuum|robot|hoover)\b", t) and not re.search(r"\b(say|announce)\b.*\b(on|over|through|via)\b", t):
            p.find(r"\b(a |an )?(message|notification|text|push notification)\b")
            p.find(r"\b(send|notify|text|tell|inform|ping|push|let|know)\b")
            p.find(r"\b(send|notify|text|tell|inform|ping|push|let|know)\b")
            if p.find(r"\b(warn\w*|alert loudly|urgent\w*|critical)\b") or p.find(r"\balert\b"):
                return "alarm", extra
            if p.find(r"\bask\w*\b"):
                return "ask", extra
            return "send", extra
        if re.search(r"\b(house )?mode\b", t) or re.search(r"\bset the house to\b|\bput the house (?:in|into|to)\b", t):
            for pat, mode in MODE_WORDS:
                if p.find(rf"\b(?:to |into |in )?(?:{pat})\b"):
                    p.find(r"\b(house )?mode\b")
                    p.find(r"\b(set|switch|change|put|turn|the house)\b")
                    return "set_mode", {"mode": mode}
        if re.search(r"\balarm( system)?\b", t):
            p.find(r"\b(the )?alarm( system)?\b")
            if p.find(r"\b(disarm|turn off|switch off|deactivate|off)\b"):
                return "disarm", extra
            if p.find(r"\b(arm|turn on|switch on|activate|on)\b"):
                p.find(r"\b(for the night|at night|night|away|home|stay)\b")
                return ("arm_night" if re.search(r"night", t) else "arm_home" if re.search(r"\b(home|stay)\b", t) else "arm_away"), extra
        if m := p.find(r"\b(?:to |at )?(\d{1,3})\s*(?:%|percent)"):
            extra["percent"] = int(m.group(1))
        if m := p.find(r"\b(?:to |at )?(\d{1,2}(?:[.,]\d)?)\s*(?:degrees?|°c?)"):
            extra["temperature"] = float(m.group(1).replace(",", "."))
            p.find(r"\b(set|turn|put|heat|change)\b")
            return "set_temp", extra
        if m := p.find(r"\bvolume (?:to |at )?(\d{1,3})"):
            extra["volume"] = int(m.group(1))
            p.find(r"\b(set|turn|change|the)\b")
            return "volume", extra
        if p.find(r"\b(say|announce|speak|read out|broadcast)\b"):
            return "announce", extra
        if p.find(r"\b(bright|brighter|light up)\b"):
            p.find(r"\b(make|it)\b")
            return "turn_on", {**extra, "want": "light"}
        if p.find(r"\b(dark|darker)\b"):
            p.find(r"\b(make|it)\b")
            return "turn_off", {**extra, "want": "light"}
        if re.search(r"\b(warm|warmer|cozy|cosy)\b", t) and not re.search(r"\bwarm up\b", t):
            p.find(r"\b(warm|warmer|cozy|cosy)\b")
            for _ in range(3):
                p.find(r"\b(make|sure|it|is|gets|that|nice|and)\b")
            return "set_temp", {**extra, "want": "climate", "temperature": 21}
        if re.search(r"heating|heater|thermostat|radiator", t) and p.find(r"\b(turn down|lower|reduce|down)\b"):
            return "eco", extra
        if re.search(r"heating|heater|thermostat|radiator", t) and p.find(r"\b(turn up|warm up|crank up|up|boost)\b"):
            return "boost", extra
        if p.find(r"\b(eco|setback|economy|save energy|energy saving)\b"):
            p.find(r"\b(set|put|to|mode)\b")
            return "eco", extra
        if p.find(r"\b(boost|warm up|heat up)\b"):
            return "boost", extra
        if p.find(r"\block\b"):
            return "lock", extra
        if p.find(r"\bunlock\b"):
            return "unlock", extra
        if p.find(r"\b(pause|stop)\b"):
            return "pause", extra
        if p.find(r"\b(play|resume|continue)\b"):
            return "play", extra
        if p.find(r"\b(lower|close|shut|down)\b"):
            return "close", extra
        if p.find(r"\b(raise|open|up)\b"):
            return "open", extra
        if p.find(r"\b(dock|return (?:to )?(?:its )?(?:base|dock|station)|back to (?:its )?(?:base|dock|station)|go home|to (?:its )?(?:dock|base|station)|recharge)\b"):
            p.find(r"\b(send|the|it)\b")
            return "dock", extra
        if p.find(r"\b(vacuum|hoover|clean|start cleaning|send out)\b") or (robot and p.find(r"\b(send|out|go)\b")):
            return "start", extra
        if p.find(r"\b(toggle)\b"):
            return "toggle", extra
        if p.find(r"\b(turn off|switch off|shut off|power off|turn \w+(?: \w+)? off|switch \w+(?: \w+)? off|deactivate|off)\b"):
            p.find(r"\b(everything|it|them)\b")
            p.find(r"\b(turn|switch|shut)\b")
            p.find(r"\boff\b")
            p.find(r"\bagain\b")
            return "turn_off", extra
        if p.find(r"\b(turn on|switch on|power on|activate|start|on)\b"):
            p.find(r"\b(turn|switch)\b")
            p.find(r"\bagain\b")
            return "turn_on", extra
        if extra.get("percent") is not None:
            p.find(r"\b(dim|set|turn)\b")
            return "dim", extra
        if p.find(r"\b(flash\w*|blink\w*)\b"):
            return "blink", extra
        if p.find(r"\b(run|execute|trigger)\b"):
            return "run", extra
        return None, extra

    def _action_subjects(self, p: Part, verb: str | None, trig_dev: dict[str, Any] | None, trig_room: str | None) -> list[Subject]:
        t = p.text
        if verb in ("send", "alarm", "ask", "set_mode", "wait", "arm_away", "arm_night", "arm_home", "disarm"):
            return []
        p.find(r"\b(dim|set|turn|switch|make|put|let)\b")
        want: set[str] | None = ACTORS
        if self._want:
            want = {self._want}
        elif verb in ("dim", "blink") or (verb is None and re.search(r"percent|%", t)):
            want = {"light", "group"}
        elif verb in ("set_temp", "eco", "boost"):
            want = {"climate"}
        elif verb in ("play", "pause", "volume", "announce"):
            want = {"media"}
        elif verb in ("open", "close"):
            want = {"cover"}
        elif verb in ("start", "dock"):
            want = {"vacuum"}
        elif verb in ("lock", "unlock"):
            want = {"lock"}
        if re.search(r"\b(it|them|that|this one|the same)\b", t) and trig_dev and trig_dev["kind"] in ACTORS and not self._device_hits(p, want):
            p.find(r"\b(it|them|that|this one|the same)\b")
            return [Subject(trig_dev["entity_id"], trig_dev["kind"], trig_dev.get("room"), trig_dev)]
        kw = self._kind_word(p)
        except_m = re.search(r"\b(?:except|but not|apart from|other than)\b", t)
        if kw and except_m and kw[3].start() < except_m.start() and re.search(r"\b(all|every)\b", t[: except_m.start()]):
            # "all lights except the bedroom light": every light but the named ones, as single devices
            kind = kw[0]
            p.mark(0, len(t))
            rest = Part(t[except_m.end() :], 0)
            skip = {h[1]["entity_id"] for h in self._device_hits(rest, {kind}) if h[0] >= 25}
            skip_room = self._room_in(rest.text)
            if skip_room and not skip:
                skip = {d["entity_id"] for d in self._of_kind(kind, skip_room)}
            room = kw[2] or self._room_in(t[: except_m.start()])
            keep = [d for d in self._of_kind(kind, room) if d["entity_id"] not in skip]
            if skip and keep:
                return [Subject(d["entity_id"], kind, d.get("room"), d) for d in keep[:12]]
            self.unsure.append("“Except …”: I could not tell which devices to leave out.")
        if (
            not kw
            and want is not None
            and len(want) <= 2
            and (wk := next(iter(want - {"group"}), None)) in ("light", "climate", "media")
            and not [h for h in self._device_hits(p, want) if h[0] >= 25]
        ):
            room = self._room_in(t) or (self.rooms_by_id.get(trig_room) if trig_room else None)
            if room:
                p.find(rf"\b(?:in |the )*{self._room_words_pattern(room)}")
                named = self._of_kind(wk, room)
                if self.inv.in_room(wk, room["id"]):
                    return [Subject(f"all:{wk}@{room['id']}", wk, room["id"])]
                if named:
                    return [Subject(named[0]["entity_id"], wk, named[0].get("room"), named[0])]
            if wk in ("climate", "light"):
                return [Subject(f"all:{wk}", wk)]
        hits = [h for h in self._device_hits(p, want) if h[0] >= 25]
        if hits:
            top = hits[0][0]
            chosen = [h for h in hits if h[0] == top][:3]
            room = self._room_in(t)
            if len(chosen) > 1 and room:
                chosen = [h for h in chosen if h[1].get("room") == room["id"]] or chosen[:1]
            if len(chosen) > 1:
                chosen = chosen[:1]
            out = []
            for _s, d, span in chosen:
                p.mark(*span)
                out.append(Subject(d["entity_id"], d["kind"], d.get("room"), d))
            if kw and kw[0] == out[0].kind:
                p.mark(kw[3].start(), kw[3].end())
            p.find(r"\bthe\b")
            return out
        if kw:
            kind, word, kroom, m = kw
            if kind in ("motion", "temperature", "illuminance", "leak", "window", "door"):
                kind = {"window": "cover"}.get(kind, kind)
                if kind not in ACTORS:
                    return []
            if want is not None and kind not in want and not (verb in ("turn_on", "turn_off", "toggle", None) and kind in ACTORS):
                if verb == "announce" or verb in ("play", "pause", "volume"):
                    kind = "media"
                else:
                    return []
            p.mark(m.start(), m.end())
            room = kroom or self._room_in(t)
            if room:
                p.find(rf"\b(?:in |on |the )*{self._room_words_pattern(room)}")
            all_word = bool(p.find(r"\b(all|every|each)(?: of)?(?: the)?\b"))
            many = all_word or word in PLURAL_KIND
            p.find(r"\b(the|an?)\b")
            if kind == "media" and word in TV_WORDS:
                tv = [d for d, n, _t in self.devices if d["kind"] == "media" and TV_NAMES.search(n) and (not room or d.get("room") == room["id"])]
                if tv:
                    return [Subject(tv[0]["entity_id"], "media", tv[0].get("room"), tv[0])]
            if kind in ("vacuum", "purifier", "fan", "lock"):
                cand = self._of_kind(kind, room)
                if cand:
                    return [Subject(cand[0]["entity_id"], kind, cand[0].get("room"), cand[0])]
            if room:
                if self.inv.in_room(kind, room["id"]):
                    return [Subject(f"all:{kind}@{room['id']}", kind, room["id"])]
                cand = self._of_kind(kind, room)
                if cand:
                    return [Subject(cand[0]["entity_id"], kind, cand[0].get("room"), cand[0])]
                self.unsure.append(f"No device of the kind “{word}” is assigned to {room['name']} yet.")
                return [Subject(f"all:{kind}@{room['id']}", kind, room["id"])]
            if all_word or (many and not trig_room):
                return [Subject(f"all:{kind}", kind)]
            if trig_room and self.inv.in_room(kind, trig_room):
                return [Subject(f"all:{kind}@{trig_room}", kind, trig_room)]
            if re.search(r"\bsame room\b", t):
                p.find(r"\b(in )?(the )?same room\b")
                return [Subject(f"all:{kind}@same", kind)]
            if many:
                return [Subject(f"all:{kind}", kind)]
            cand = self._of_kind(kind, None)
            if len(cand) == 1:
                return [Subject(cand[0]["entity_id"], kind, cand[0].get("room"), cand[0])]
            self.unsure.append(f"Which device is meant by “{word}”? I took all of them in the house.")
            return [Subject(f"all:{kind}", kind)]
        if re.search(r"\beverything\b", t) and verb in ("turn_on", "turn_off"):
            p.find(r"\beverything\b")
            self.unsure.append("“Everything”: I took all lights.")
            return [Subject("all:light", "light")]
        if verb in ("start", "dock"):
            cand = self._of_kind("vacuum", None)
            if cand:
                return [Subject(cand[0]["entity_id"], "vacuum", cand[0].get("room"), cand[0])]
        if verb == "announce":
            room = self._room_in(t)
            if room and self.inv.in_room("media", room["id"]):
                p.find(rf"\b(?:in |on |the )*{self._room_words_pattern(room)}")
                return [Subject(f"all:media@{room['id']}", "media", room["id"])]
        return []

    def _notify(self, p: Part, verb: str, message: str | None, rule: dict[str, Any]) -> dict[str, Any]:
        t = p.text
        to = "notify:everyone"
        people = self._persons(p)
        if people:
            to = f"notify:{people[0][0]}"
            p.mark(people[0][1].start(), people[0][1].end())
        elif re.search(r"\b(me|my phone|i)\b", t):
            p.find(r"\b(me|my phone)\b")
            if self.me:
                to = f"notify:{self.me}"
            else:
                self.unsure.append("Who is “me”? The notification goes to everyone.")
        p.find(r"\b(everyone|everybody|all|us|to)\b")
        p.find(r"\b(a|an|on|the|phone|phones|push|via|by)\b")
        p.find(r"\b(a|an|on|the|phone|phones|push|via|by)\b")
        return {"subject": to, "verb": verb, "message": message or ""}
