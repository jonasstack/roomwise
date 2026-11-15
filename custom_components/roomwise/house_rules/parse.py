"""German sentence → rule draft without a language model.

How it works:
1. Qualifiers anywhere in the sentence become limits ("nachts", "werktags", "zwischen 22 und 6 Uhr", "wenn es dunkel ist").
2. Fixed triggers are taken out ("um 7 Uhr", "bei Sonnenuntergang", "bei Bewegung im Flur").
3. The rest is split into the condition ("wenn …", also after the action: "Licht an, wenn …") and the actions.
4. Every part is matched against the real house: device names (also compounds like "Küchentür" = door in the
   kitchen), rooms, persons, kinds ("Licht", "Heizung"). What a part says it does ("geht auf", "ist an",
   "auf 20 Prozent") decides which kinds of devices fit, so a lamp called "Küchentür" is not taken for a door.
5. Words that were not understood are reported, so the caller knows how sure the draft is.
"""

from __future__ import annotations

# i18n: data (the German parser; English: parse_en.py)

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .vocab import kinds as vocab_kinds, vocabulary

if TYPE_CHECKING:
    from .core import HouseRules


def fold(s: str) -> str:
    """Lower case without umlauts, same length as the input (positions stay valid)."""
    return s.lower().translate(str.maketrans({"ä": "a", "ö": "o", "ü": "u", "ß": "s", "&": " ", "-": " ", "_": " ", "/": " "}))


# ---------------------------------------------------------------------------------------------- words
# kind words; the last part of a compound decides ("Küchenlicht" = light in the kitchen)
KIND_SUFFIXES: list[tuple[str, str]] = [
    ("temperatursensor", "temperature"),
    ("temperatur", "temperature"),
    ("thermometer", "temperature"),
    ("bewegungsmelder", "motion"),
    ("bewegungssensor", "motion"),
    ("bewegung", "motion"),
    ("wassermelder", "leak"),
    ("wassersensor", "leak"),
    ("wasserleck", "leak"),
    ("leck", "leak"),
    ("wasser", "leak"),
    ("helligkeit", "illuminance"),
    ("lichtsensor", "illuminance"),
    ("beleuchtung", "light"),
    ("lichter", "light"),
    ("licht", "light"),
    ("lampen", "light"),
    ("lampe", "light"),
    ("leuchten", "light"),
    ("leuchte", "light"),
    ("heizungen", "climate"),
    ("heizung", "climate"),
    ("heizkorper", "climate"),
    ("thermostat", "climate"),
    ("klimaanlage", "climate"),
    ("fenster", "window"),
    ("turschloss", "lock"),
    ("schloss", "lock"),
    ("turen", "door"),
    ("ture", "door"),
    ("tur", "door"),
    ("rollladen", "cover"),
    ("rolladen", "cover"),
    ("rollos", "cover"),
    ("rollo", "cover"),
    ("jalousien", "cover"),
    ("jalousie", "cover"),
    ("markise", "cover"),
    ("staubsauger", "vacuum"),
    ("saugroboter", "vacuum"),
    ("sauger", "vacuum"),
    ("luftreiniger", "purifier"),
    ("ventilator", "fan"),
    ("steckdosen", "outlet"),
    ("steckdose", "outlet"),
    ("lautsprecher", "media"),
    ("musik", "media"),
    ("radio", "media"),
    ("fernseher", "media"),
    ("glotze", "media"),
    ("fernsehen", "media"),
]
KIND_WORDSET = {suf for suf, _k in KIND_SUFFIXES} | {"wasser", "bewegt"}
# words that end like a kind word but are none
NOT_KIND = {"natur", "uhr", "tour", "abitur", "frisur", "kultur", "temperatur", "reparatur", "tastatur", "figur"}
TV_WORDS = ("fernseher", "fernsehen", "tv", "glotze")
TV_NAMES = re.compile(r"\btv\b|fernseh|television|samsung|lg |bravia|apple tv|monitor")

PERSON_KINDS = {"zone", "presence"}
OPENABLE = {"door", "window", "cover"}
SWITCHABLE = {"light", "switch", "outlet", "fan", "purifier", "media", "climate", "group", "script", "input_boolean"}
ACTORS = {"light", "switch", "outlet", "fan", "purifier", "climate", "cover", "media", "vacuum", "script", "lock", "group"}

MODE_WORDS = [
    (r"schlaf\w*|nachtruhe|nacht\b", "sleep"),
    (r"urlaub\w*|ferien", "vacation"),
    (r"abwesend|\bweg\b|unterwegs", "away"),
    (r"gast\w*|besuch", "guests"),
    (r"zuhause|daheim|normal", "home"),
]

STOP = set(
    """
    wenn dann und oder die der das den dem des ein eine einen einem einer eines es ist sind wird werden wurde im in ins am an
    auf zu zum zur mit fur von vom bei bitte mal nur aber auch noch wieder mehr sich soll sollen sollte mach mache machen schalte
    schalt schalten ich mir mich uns wir jemand jeder alle allen alles man da dort hier so sobald solange falls immer jedes jeden
    jede jeder mal ihn sie ihm ihr es er uhr minuten minute stunden stunde sekunden sekunde min std sek tage tag als langer uber
    unter grad prozent bis um ab nach vor zwischen etwas einfach gerade direkt sofort automatisch hat haben habe hast bin bist
    sein seine meine mein unsere unser ganz ganze ganzen haus hause wohnung zuhause daheim nicht kein keine keiner niemand
    nichts mehr wieder bitte gleich danach anschliesend anschliessend nein also dabei belegt frei leer sitzt steht liegt sitze stehe liege
    """.split()
)


@dataclass
class Part:
    """A piece of the sentence with the positions it covers in the folded text."""

    text: str  # folded
    start: int
    used: list[bool] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.used:
            self.used = [False] * len(self.text)

    def find(self, pattern: str, take: bool = True) -> re.Match[str] | None:
        m = re.search(pattern, self.text)
        if m and take:
            self.mark(m.start(), m.end())
        return m

    def mark(self, a: int, b: int) -> None:
        for i in range(max(0, a), min(len(self.used), b)):
            self.used[i] = True

    def leftover(self, stop: set[str] | None = None) -> list[str]:
        stop = STOP if stop is None else stop
        out = []
        for m in re.finditer(r"[a-z0-9]+", self.text):
            if not any(self.used[m.start() : m.end()]) and m.group(0) not in stop and len(m.group(0)) > 2 and not m.group(0).isdigit():
                out.append(m.group(0))
        return out


@dataclass
class Subject:
    subject: str
    kind: str
    room: str | None = None
    device: dict[str, Any] | None = None


class SentenceParser:
    def __init__(self, core: HouseRules, me: str | None = None) -> None:
        self.core = core
        self.inv = core.inventory
        self.me = me if me in self.inv.persons else None
        self.rooms = list(core.rooms.values())
        self.room_words = {fold(r["name"]): r for r in self.rooms}
        self.person_words = {fold(p["name"]).split(" ")[0]: p for p in self.inv.persons.values() if p.get("name")}
        self.devices = []
        for d in self.inv.devices.values():
            n = fold(d["name"]).strip()
            self.devices.append((d, n, re.findall(r"[a-z0-9]+", n)))
        try:
            self.zones = core.zones()
        except Exception:  # noqa: BLE001 — zones are a nice extra
            self.zones = []
        self.unsure: list[str] = []
        self.leftover: list[str] = []
        self.lang = "de"  # phrases of the vocabulary (PHRASES in src/vocabulary.ts)
        self.rooms_by_id = {r["id"]: r for r in self.rooms}
        self._last_subjects: list[Subject] = []
        self._want: str | None = None
        # word lists the device matching uses; the English parser (parse_en.py) brings its own
        self.stop = STOP
        self.kind_words = KIND_WORDSET
        self.generic = GENERIC_TOKENS
        self.synonyms = SYNONYMS
        self.default_announce = "Hallo"
        self.said_skip = ("uber", "durch", "per", "laut")
        self.roomish_extra: set[str] = set()

    # ------------------------------------------------------------------ main
    def parse(self, text: str) -> tuple[dict[str, Any], list[str], list[str]]:
        """→ (rule parts, unsure notes, words that were not understood)"""
        original = text
        t = fold(text)
        rule: dict[str, Any] = {"type": "when", "when": [], "and": [], "then": [], "only": []}
        whole = Part(t, 0)

        # a quoted message
        message = None
        if mq := re.search(r"[„\"“'‚]([^“”\"'‘]+)[“”\"'‘]", original):
            message = mq.group(1).strip()
            whole.mark(mq.start(), mq.end())
            t = t[: mq.start()] + " " * (mq.end() - mq.start()) + t[mq.end() :]
            whole.text = t

        if re.search(r"\bso ?lange\b", t):
            rule["type"] = "while"

        has_time_trigger = bool(re.search(r"\bum \d{1,2}(?:[:.]\d{2})?(?: ?uhr)?\b(?! herum)", t)) and not re.search(r"zwischen \d", t)
        rule["only"] += self._qualifiers(whole, has_time_trigger)
        t = self._blank(whole)
        triggers = self._fixed_triggers(whole, rule["type"] == "while")
        t = self._blank(whole)

        # "…, Licht an, sonst aus": one rule for both ("Wechselnd")
        act_else = None
        if (m := re.search(r"[,;]?\s*\b(sonst|ansonsten|andernfalls)\b", t)) and re.search(r"[a-z]{2,}", t[m.end() :]):
            act_else = Part(t[m.end() :], m.end())
            t = t[: m.start()] + " " * (len(t) - m.start())
            rule["type"] = "while"
        cond, act = self._split(t)
        # "…, Musik an, und wenn es wieder frei ist, aus"
        if act_else is None and (
            m := re.search(
                r"[,;]?\s*\b(?:und )?(?:wenn|sobald|falls) (?:es |er |sie |der raum |das \w+ |die \w+ )?(?:wieder |dann )?(?:frei|leer|niemand mehr da|keiner mehr da|nicht mehr \w+|weg|zu|geschlossen)\b(?: ist| wird| sind)?\s*(?:,|dann)?",
                act.text,
            )
        ) and re.search(r"[a-z]{2,}", act.text[m.end() :]):
            act_else = Part(act.text[m.end() :], act.start + m.end())
            act = Part(act.text[: m.start()], act.start)
            rule["type"] = "while"
        names = "|".join(re.escape(w) for w in self.person_words if len(w) >= 3)
        if names and (m := re.search(rf"\b({names})\s*(?:,|und|&)\s*({names})\b(?:\s*(?:,|und)\s*({names})\b)*", cond.text)):
            # several named persons: all of them; "alle" is the closest we have
            cond.text = cond.text[: m.start()] + "alle".ljust(m.end() - m.start()) + cond.text[m.end() :]
            self.unsure.append("Mehrere Personen genannt: Ich habe „alle“ genommen.")
        self.hint_room = self._room_in(act.text)
        pre = []  # conditions found in the action part (e.g. "Licht aus, wenn …" was already split)
        cond_parts = self._pieces(cond, r",|\bund\b|\bsowie\b|\boder\b") if cond.text.strip() else []
        cond_or = [bool(re.search(r"^\s*oder\b", t[p.start - 5 : p.start + 1])) for p in cond_parts]

        # when / and
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
                self.leftover += p.leftover()
                continue
            if not as_event and cond_or[i] and last_state is not None:
                # "… oder …" between conditions: one of them is enough
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
            self.leftover += p.leftover()
        rule["and"] += pre

        # then
        trig = rule["when"][0] if rule["when"] else None
        rule["then"] = self._actions(act, trig, message, original, rule)
        if act_else is not None:
            rule["else"] = self._actions(act_else, trig, None, original, rule, fallback=self._last_subjects)

        # "Licht in der Küche nach 10 Minuten aus, wenn niemand mehr da ist": the delay belongs to "empty"
        if trig and trig.get("verb") in ("empty", "free_for", "empty_for") and getattr(self, "_late", None):
            trig["verb"] = "empty_for" if trig["subject"].startswith("room:") else "free_for"
            trig["for"] = self._late
            rule["then"] = [c for c in rule["then"] if c.get("verb") != "wait"]

        if not rule["when"]:
            self.unsure.append("Wann soll es passieren?")
        if not rule["then"]:
            self.unsure.append("Was soll dann passieren?")
        self._same_room(rule)
        return rule, list(dict.fromkeys(self.unsure)), list(dict.fromkeys(self.leftover))

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _blank(part: Part) -> str:
        """Used characters become spaces, so later steps do not see them again."""
        t = "".join(" " if u else ch for ch, u in zip(part.text, part.used))
        return t

    def _pieces(self, part: Part | str, sep: str) -> list[Part]:
        text = part.text if isinstance(part, Part) else part
        base = part.start if isinstance(part, Part) else 0
        out = []
        pos = 0
        for m in re.finditer(sep, text):
            out.append(Part(text[pos : m.start()], base + pos))
            pos = m.end()
        out.append(Part(text[pos:], base + pos))
        return [p for p in out if p.text.strip()]

    def _split(self, t: str) -> tuple[Part, Part]:
        """→ (condition, action)"""
        m = re.search(r"\b(immer wenn|jedes mal wenn|wenn|sobald|falls|sowie|so ?lange|nachdem)\b", t)
        if not m:
            arrow = re.search(r"\s*(→|->|=>|:|⇒)\s*", t)
            if arrow:
                return Part(t[: arrow.start()], 0), Part(t[arrow.end() :], arrow.end())
            return Part("", 0), Part(t, 0)
        before = t[: m.start()]
        after_start = m.end()
        after = t[after_start:]
        if re.search(r"[a-z]{3,}", before) and [w for w in re.findall(r"[a-z]+", before) if w not in STOP]:
            # action first: "Licht im Flur aus, wenn 5 Minuten niemand da ist"
            return Part(after, after_start), Part(before, 0)
        # condition first: up to "dann" or the first comma, else after the verb at the end of the condition
        cut = re.search(r",|\bdann\b", after)
        if cut:
            return Part(after[: cut.start()], after_start), Part(after[cut.end() :], after_start + cut.end())
        verb_end = re.search(
            r"\b(\w+(?:geht|gehe|gehen|kommt|komme|kommen|macht|steht|stehe|sitzt|liegt|wird|ist|sind|bin|meldet|erkannt|verlasst|verlasse|verlassen|betritt|startet|lauft|beginnt|wechselt|steigt|fallt|sinkt|endet|heizt|fertig|offen|zu|aus|an))\b",
            after,
        )
        if verb_end:
            # the condition ends with its verb; the action follows
            return Part(after[: verb_end.end()], after_start), Part(after[verb_end.end() :], after_start + verb_end.end())
        return Part(after, after_start), Part("", len(t))

    # ------------------------------------------------------------------ qualifiers (only …)
    def _qualifiers(self, p: Part, time_trigger: bool) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []

        def hm(h: str, m: str | None) -> str:
            return f"{int(h) % 24:02d}:{m or '00'}"

        if m := p.find(r"\b(?:zwischen|von) (\d{1,2})(?:[:.](\d{2}))?(?: ?uhr)? (?:und|bis) (\d{1,2})(?:[:.](\d{2}))?(?: ?uhr)?"):
            out.append({"subject": "time", "verb": "between", "from": hm(m.group(1), m.group(2)), "to": hm(m.group(3), m.group(4))})
        if m := p.find(r"\b(?:nach|ab|spater als) (\d{1,2})(?:[:.](\d{2}))? ?uhr"):
            out.append({"subject": "time", "verb": "between", "from": hm(m.group(1), m.group(2)), "to": "23:59"})
        if m := p.find(r"\b(?:vor|bis|fruher als) (\d{1,2})(?:[:.](\d{2}))? ?uhr"):
            out.append({"subject": "time", "verb": "between", "from": "00:00", "to": hm(m.group(1), m.group(2))})
        if p.find(r"\b(nachts|in der nacht|uber nacht)\b"):
            out.append({"subject": "time", "verb": "night"})
        for pat, verb in ((r"\b(abends|am abend)\b", "evening"), (r"\b(morgens|am morgen|fruh)\b", "morning")):
            m = re.search(pat, p.text)
            if m:
                p.mark(m.start(), m.end())
                if not time_trigger:
                    out.append({"subject": "time", "verb": verb})
        p.find(r"\b(jeden|jede|jedem)\s+(tag|morgen|abend|nacht|woche)\b|\btaglich\b")
        if p.find(r"\b(werktags|wochentags|an werktagen|unter der woche|montags? bis freitags?|mo ?bis ?fr|mo fr)\b"):
            out.append({"subject": "time", "verb": "workdays"})
        if p.find(r"\b(am wochenende|wochenends|an wochenenden|samstags? und sonntags?)\b"):
            out.append({"subject": "time", "verb": "weekend"})
        if p.find(r"\b(?:und )?(?:(?:nur )?(?:wenn|falls|sofern) )?es (?:drausen |schon |noch )?dunkel ist\b|\bbei dunkelheit\b|\bim dunkeln\b|\bwenn dunkel\b"):
            out.append({"subject": "sun", "verb": "is_down"})
        if p.find(r"\b(?:und )?(?:(?:nur )?(?:wenn|falls) )?es (?:drausen )?hell ist\b|\btagsuber\b|\bam tag\b"):
            out.append({"subject": "sun", "verb": "is_up"})
        if m := p.find(r"\b(nicht|ausser|auser) (?:wenn wir |wenn ich )?(?:im|in den) urlaub\w*|\b(?:wenn wir |wenn ich )?(?:im|in den) urlaub\w*(?: sind| bin)?"):
            out.append({"subject": "mode", "verb": "is_not" if m.group(1) else "is", "mode": "vacation"})
        p.find(r"\baber nur\b|\bnur\b|\baber\b")
        return out

    # ------------------------------------------------------------------ fixed triggers
    def _fixed_triggers(self, p: Part, state: bool) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if state:
            return out
        for m in list(re.finditer(r"\bum (\d{1,2})(?:[:.](\d{2}))?(?: ?uhr)?\b", p.text)):
            if not m.group(2) and "uhr" not in m.group(0):
                continue
            p.mark(m.start(), m.end())
            out.append({"subject": "time", "verb": "at", "time": f"{int(m.group(1)) % 24:02d}:{m.group(2) or '00'}"})
        if p.find(r"\b(bei|zum|nach|mit) sonnenuntergang\b|\b(die )?sonne untergeht\b|\bsonnenuntergang\b"):
            out.append({"subject": "sun", "verb": "sets"})
        if p.find(r"\b(bei|zum|nach|mit) sonnenaufgang\b|\b(die )?sonne aufgeht\b|\bsonnenaufgang\b"):
            out.append({"subject": "sun", "verb": "rises"})
        # "sobald es dunkel wird" without a room: the sun
        m = re.search(r"\bes (?:drausen )?dunkel wird\b", p.text)
        if m and not self._room_in(p.text[m.end() : m.end() + 30]) and not self._room_in(p.text[max(0, m.start() - 25) : m.start()]):
            p.mark(m.start(), m.end())
            out.append({"subject": "sun", "verb": "sets"})
        # "bei offenem Fenster im Schlafzimmer …"
        m = re.search(r"\bbei (offenem|offener|offenen|geoffnetem|geoffneter|geoffneten) (\w+)((?:\s+(?:im|in der|in dem)\s+\w+)?)", p.text)
        if m and not re.search(r"\b(wenn|sobald|falls)\b", p.text):
            sub = Part(f"{m.group(2)}{m.group(3)} offen", 0)
            c = self._condition(sub, "event", [])
            if c:
                p.mark(m.start(), m.end())
                out.append(c)
        # "bei Bewegung im Flur …": a trigger phrase without "wenn"
        m = re.search(r"\bbei (bewegung|anwesenheit|offnen|aufgehen)\b(?:\s+(?:im|in der|in dem|am|an der)\s+(\w+))?", p.text)
        if m and not re.search(r"\b(wenn|sobald|falls)\b", p.text):
            sub = Part(m.group(0)[4:], p.start + m.start() + 4)
            c = self._condition(sub, "event", [])
            if c:
                p.mark(m.start(), m.end())
                out.append(c)
        return out

    # ------------------------------------------------------------------ rooms, persons, devices
    def _room_in(self, text: str) -> dict[str, Any] | None:
        best = None
        for name, r in sorted(self.room_words.items(), key=lambda x: -len(x[0])):
            stem = name[:-1] if name.endswith("e") and len(name) > 4 else name
            if re.search(rf"\b{re.escape(stem)}", text):
                best = r
                break
        return best

    def _room_of_word(self, word: str) -> dict[str, Any] | None:
        for name, r in sorted(self.room_words.items(), key=lambda x: -len(x[0])):
            stem = name[:-1] if name.endswith("e") and len(name) > 4 else name
            if len(stem) >= 3 and word.startswith(stem):
                return r
        return None

    def _kind_word(self, p: Part) -> tuple[str, str, dict[str, Any] | None, re.Match[str]] | None:
        """'küchenlicht' → ('light', 'kuchenlicht', room Küche); first kind word in the part."""
        for m in re.finditer(r"[a-z]+", p.text):
            w = m.group(0)
            if w in NOT_KIND or any(p.used[m.start() : m.end()]):
                continue
            for suf, kind in KIND_SUFFIXES:
                if w.endswith(suf) and not (suf == "tur" and w.endswith(("temperatur", "natur", "uhr"))):
                    prefix = w[: -len(suf)]
                    room = self._room_of_word(prefix) if prefix else None
                    if prefix and not room and kind == "door" and prefix not in ("haus", "eingangs", "wohnungs", "terrassen", "balkon", "garten", "keller", "neben", "hinter", "vorder"):
                        # "Schlafzimmertür" handled by the room, "Haustür" by the device name
                        pass
                    return kind, w, room, m
        return None

    def _persons(self, p: Part) -> list[tuple[str, re.Match[str]]]:
        out = []
        for w, person in self.person_words.items():
            if len(w) >= 3 and (m := re.search(rf"\b{re.escape(w)}s?\b", p.text)):
                out.append((person["id"], m))
        return out

    def _device_hits(self, p: Part, allowed: set[str] | None) -> list[tuple[int, dict[str, Any], tuple[int, int]]]:
        """Devices named in the part, best first: whole name, a word of the name, or a compound."""
        words = [(m.group(0), m.start(), m.end()) for m in re.finditer(r"[a-z0-9]+", p.text) if not any(p.used[m.start() : m.end()])]
        roomish = set(self.room_words) | {n[:-1] for n in self.room_words} | set(self.person_words) | self.roomish_extra
        hits = []
        text = p.text
        for d, name, tokens in self.devices:
            if allowed is not None and d["kind"] not in allowed:
                continue
            if not name:
                continue
            best = 0
            span = (0, 0)
            # the whole name as a phrase
            if len(name) >= 3 and (m := re.search(rf"(?<![a-z0-9]){re.escape(name)}(?![a-z0-9])", text)):
                if not any(p.used[m.start() : m.end()]) and name not in roomish:
                    best, span = 100 + len(name), (m.start(), m.end())
            if not best:
                for w, a, b in words:
                    if w in self.stop or len(w) < 3 or w in roomish:
                        continue
                    for tok in tokens:
                        if tok in roomish or len(tok) < 3:
                            continue
                        score = 0
                        if w == tok:
                            score = 40 + len(w) if tok not in self.generic else 8
                        elif len(w) >= 5 and tok.startswith(w) and w not in self.kind_words:
                            score = 30 + len(w)  # "haustur" → "haustursensor"
                        elif len(tok) >= 5 and w.startswith(tok) and tok not in self.generic:
                            score = 25 + len(tok)  # "schlafzimmerlampen" → "schlafzimmerlampe"
                        elif len(w) >= 5 and tok.endswith(w) and w not in self.kind_words:
                            score = 26 + len(w)  # "kocher" → "wasserkocher"
                        elif len(w) == 4 and tok.startswith(w) and len(tok) <= 13 and w not in self.kind_words:
                            score = 20  # "bett" → "bettumrandung"
                        elif self.synonyms.get(w) == tok or _same_place(w, tok):
                            score = 28  # "esstisch" → "essbereich", "couch" → "sofa"
                        if score > best:
                            best, span = score, (a, b)
            if best:
                # a name that has more words than were mentioned is a weaker match ("Steckdose Sofalicht" for "Sofalicht")
                extra = len([t for t in tokens if t not in text and t not in roomish]) if best < 100 else 0
                hits.append((best - 6 * extra, d, span))
        hits.sort(key=lambda h: -h[0])
        return [h for h in hits if h[0] > 0]

    # ------------------------------------------------------------------ conditions
    def _condition(self, p: Part, role: str, siblings: list[Part]) -> dict[str, Any] | None:
        t = p.text
        state = role == "state"
        dur = self._duration(p)

        # house mode
        if re.search(r"\b(haus)?modus\b", t):
            p.find(r"\b(haus)?modus\b")
            for pat, mode in MODE_WORDS:
                if p.find(rf"\b(?:auf |zu |in )?(?:{pat})"):
                    neg = bool(p.find(r"\bnicht\b"))
                    p.find(r"\b(wechselt|wird|ist|geht|springt|umschaltet|schaltet)\b")
                    if state:
                        return {"subject": "mode", "verb": "is_not" if neg else "is", "mode": mode}
                    return {"subject": "mode", "verb": "changes_to", "mode": mode}
        # alarm system
        if re.search(r"\balarm(anlage)?\b", t) and re.search(r"auslost|ausgelost|losgeht|los geht|scharf|unscharf|ausgeschaltet", t):
            p.find(r"\b(die )?alarm(anlage)?\b")
            if p.find(r"auslost|ausgelost|losgeht|los geht"):
                return {"subject": "alarm", "verb": "is_triggered" if state else "triggered"}
            if p.find(r"unscharf|ausgeschaltet"):
                return {"subject": "alarm", "verb": "is_disarmed" if state else "disarmed"}
            p.find(r"scharf\w*")
            return {"subject": "alarm", "verb": "is_armed" if state else "armed"}

        open_w = re.search(r"\b(aufgeht|auf geht|aufgemacht|geoffnet|offnet|offen|auf ist|aufsteht|auf steht|aufreist|aufgerissen)\b", t)
        close_w = re.search(r"\b(zugeht|zu geht|zugemacht|geschlossen|schliest|zu ist|zu\b|zufallt)", t)
        on_w = re.search(r"\b(angeht|an geht|angeschaltet|eingeschaltet|anschaltet|einschaltet|an ist|an\b|lauft|laufen|startet|gestartet|anspringt)", t)
        off_w = re.search(r"\b(ausgeht|aus geht|ausgeschaltet|ausschaltet|abschaltet|aus ist|aus\b)", t)
        sit_w = re.search(r"\b(sitzt|sitze|sitzen|steht|stehe|stehen|liegt|liege|liegen|legt sich|lege mich|setzt sich|setze mich|gehe ins bett|geht ins bett|gehen ins bett|ins bett|im bett|auf dem|auf der|am|an der|vor dem|vor der)\b", t)
        enter_w = re.search(r"\b(betritt|betrete|betreten|reinkommt|rein kommt|hereinkommt|reingeht|rein geht|kommt in|komme in|ins|in die|in den|in das)\b", t)
        empty_w = re.search(r"\b(niemand|keiner|leer|verlassen ist|keine person)\b", t)
        person_w = re.search(r"\b(heimkomm\w*|heim komm\w*|nach hause komm\w*|nachhause komm\w*|zuruckkomm\w*|zuruck komm\w*|ankomm\w*|heimkehr\w*|verlass\w*|weggeh\w*|weg geh\w*|gehen|gehe|geht|gegangen|weg|aus dem haus|losfahr\w*|unterwegs|heimweg|auf dem weg nach hause|zuhause|daheim|da\b|hier\b|nach hause)", t)

        # persons and "everyone / someone"
        people = self._persons(p)
        everyone = re.search(r"\b(alle|wir|niemand|keiner|keine person|alle personen|jeder)\b", t)
        someone = re.search(r"\b(jemand|einer|eine person|irgendwer|irgendjemand)\b", t)
        me = re.search(r"\b(ich|mich|mir)\b", t)

        devs = self._device_hits(p, None)
        kw = self._kind_word(p)
        room = self._room_in(t)
        if not room and not kw and getattr(self, "hint_room", None) and (enter_w or (empty_w and not re.search(r"zuhause|daheim|im haus|in der wohnung", t))):
            # "Licht im Flur aus, wenn niemand mehr da ist": the room of the action
            room = self.hint_room

        if m := p.find(r"\b(die |das )?(bude|wohnung|haus|hutte)\s+(ist\s+)?leer\b"):
            return {"subject": "person:everyone", "verb": "is_away" if state else "leaves"}
        if re.search(r"\b(wir|alle)\b.*\b(schlafen|ins bett)\b", t):
            p.find(r"\b(wir|alle)\b")
            p.find(r"\b(schlafen|ins bett)\b")
            p.find(r"\b(gehen|sind|liegen)\b")
            return {"subject": "mode", "verb": "is" if state else "changes_to", "mode": "sleep"}
        # someone sits on the sofa / goes to bed: a zone or presence sensor
        if sit_w and not open_w:
            zhits = [h for h in self._device_hits(p, PERSON_KINDS) if h[0] >= 20]
            if zhits:
                score, d, span = zhits[0]
                p.mark(*span)
                p.mark(sit_w.start(), sit_w.end())
                for m in (someone, me, everyone):
                    if m:
                        p.mark(m.start(), m.end())
                free = bool(empty_w)
                if empty_w:
                    p.mark(empty_w.start(), empty_w.end())
                return self._presence(d, state, free, dur)

        # a person moves (comes home, leaves, …)
        zone_c = self._zone_clause(p, people, me, state)
        if zone_c:
            return zone_c
        # phrases about where somebody is going (vocabulary PHRASES: "wahrscheinlich nach Hause", "in 10 Min. zuhause" …)
        phrase_c = self._phrase(p, people, me, everyone, someone, state)
        if phrase_c:
            return phrase_c
        if person_w and not (enter_w and room and not re.search(r"nach hause|heim", t)) and not (empty_w and room) and not (devs and devs[0][0] >= 40 and not people and not me and not someone and not everyone):
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
                self.unsure.append("Wer ist „ich“? Ich habe „jemand“ genommen.")
            if who and (km := re.search(r"(?:mehr als|uber|weiter als)?\s*(\d+)\s*(?:km|kilometer)\b", t)):
                # "alle mehr als 100 km weg": far from home (e.g. the vacation mode)
                p.mark(km.start(), km.end())
                p.mark(person_w.start(), person_w.end())
                p.find(r"\b(von|vom)\s+(zuhause|daheim|zu hause|hause)\b")
                p.find(r"\b(weg|entfernt|sind|ist|bin)\b")
                p.find(r"\b(weg|entfernt|sind|ist|bin)\b")
                return {"subject": who, "verb": "is_far" if state else "far_from", "distance": int(km.group(1)), "zone": "home", **({"for": dur} if dur else {})}
            if who:
                p.mark(person_w.start(), person_w.end())
                p.find(r"\b(das haus|die wohnung|zuhause|daheim|nach hause|heim|zuruck|mehr|sind|ist|bin|haben|hat)\b")
                p.find(r"\b(das haus|die wohnung|zuhause|daheim|nach hause|heim|zuruck|mehr|sind|ist|bin|haben|hat)\b")
                p.find(r"\b(das haus|die wohnung|zuhause|daheim|nach hause|heim|zuruck|mehr|sind|ist|bin|haben|hat)\b")
                leave = re.search(r"verlass|weggeh|weg geh|gehen|gehe\b|geht\b|gegangen|\bweg\b|aus dem haus|losfahr|unterwegs", t) or (
                    everyone and re.search(r"niemand|keiner", t)
                )
                if re.search(r"heimweg|auf dem weg nach hause|unterwegs nach hause", t):
                    return {"subject": who, "verb": "is_near" if state else "coming_home"}
                if re.search(r"heimkomm|heim komm|nach hause komm|nachhause komm|zuruckkomm|zuruck komm|ankomm|heimkehr|kommt nach hause|komme nach hause", t):
                    return {"subject": who, "verb": "is_home" if state else "arrives"}
                if leave and not re.search(r"\bnicht weg\b", t):
                    if everyone and re.search(r"niemand|keiner", t) and not re.search(r"verlass|geh|weg", t):
                        return {"subject": "person:everyone", "verb": "is_away" if state else "leaves"}
                    return {"subject": who, "verb": "is_away" if state else "leaves"}
                if re.search(r"niemand|keiner|nicht (zuhause|daheim|da)", t):
                    return {"subject": "person:everyone" if who in ("person:everyone", "person:someone") else who, "verb": "is_away" if state else "leaves"}
                return {"subject": who, "verb": "is_home" if state else "arrives"}

        # temperature / brightness with a number
        if (num := re.search(r"(-?\d{1,3}(?:[.,]\d)?) ?(?:grad|°)", t)) and (kw and kw[0] == "temperature" or re.search(r"warm|kalt|heis|temperatur", t)):
            above = bool(re.search(r"uber|mehr als|warmer|heiser|steigt|hoher|groser", t))
            target_room = (kw[2] if kw else None) or room
            sensor = self._pick_sensor("temperature", target_room, p)
            if sensor:
                p.mark(num.start(), num.end())
                p.find(r"\b(uber|unter|mehr als|weniger als|warmer als|kalter als|steigt|fallt|sinkt|hoher als|niedriger als)\b")
                p.find(r"\b(temperatur\w*|warm|kalt|heis)\b")
                if target_room:
                    p.find(rf"\b{re.escape(fold(target_room['name'])[:4])}\w*")
                value = float(num.group(1).replace(",", "."))
                if state:
                    if above:
                        self.unsure.append("„Wärmer als …“ als Bedingung gibt es noch nicht, nur als Auslöser.")
                        return None
                    return {"subject": sensor, "verb": "is_below", "value": value}
                return {"subject": sensor, "verb": "above" if above else "below", "value": value}
        if re.search(r"\bdunkel\b|\bhell\b", t):
            target_room = room or (kw[2] if kw else None)
            dark = "dunkel" in t
            if target_room:
                sensor = self._pick_sensor("illuminance", target_room, p)
                p.find(r"\b(es|wird|ist|dunkel|hell)\b")
                p.find(r"\b(es|wird|ist|dunkel|hell)\b")
                p.find(r"\b(es|wird|ist|dunkel|hell)\b")
                if target_room:
                    p.find(rf"\b(im|in der)?\s*{re.escape(fold(target_room['name'])[:4])}\w*")
                if state:
                    return {"subject": f"room:{target_room['id']}", "verb": "is_dark"}
                if sensor and dark:
                    return {"subject": sensor, "verb": "below", "value": target_room.get("dark_below") or 80}
                return {"subject": "sun", "verb": "sets" if dark else "rises"}
            p.find(r"\b(es|wird|ist|dunkel|hell|drausen)\b")
            p.find(r"\b(es|wird|ist|dunkel|hell|drausen)\b")
            if state:
                return {"subject": "sun", "verb": "is_down" if dark else "is_up"}
            return {"subject": "sun", "verb": "sets" if dark else "rises"}

        # which kinds fit what the part says
        allowed: set[str] | None = None
        if open_w or close_w:
            allowed = OPENABLE | {"lock"}
        elif re.search(r"\b(wasser|nass|feucht|leck|wasserleck|uberschwemm\w*)\b|wassermelder|wassersensor", t):
            allowed = {"leak"}
        elif re.search(r"bewegung|bewegt", t):
            allowed = {"motion", "presence", "zone"}
        elif re.search(r"\bheiz(t|en)\b|zu heizen|heizt", t):
            allowed = {"climate"}
        elif re.search(r"fertig|beendet|gesaugt|saugt", t):
            allowed = {"vacuum"}
        elif re.search(r"aufgeschlossen|abgeschlossen|entriegelt|verriegelt", t):
            allowed = {"lock"}
        elif re.search(r"spielt|abgespielt|musik", t):
            allowed = {"media"}
        elif on_w or off_w:
            allowed = SWITCHABLE

        # a named device
        hits = self._device_hits(p, allowed)
        if kw and kw[0] == "media" and kw[1] in TV_WORDS:
            hits = [h for h in self._device_hits(p, {"media"}) if TV_NAMES.search(fold(h[1]["name"]))] or [
                (30, d, (kw[3].start(), kw[3].end())) for d, n, _t in self.devices if d["kind"] == "media" and TV_NAMES.search(n)
            ]
        if hits and hits[0][0] >= 25:
            _s, d, span = hits[0]
            p.mark(*span)
            # the kind word that belongs to the name ("Haustür" → door) is used, too
            if kw:
                p.mark(kw[3].start(), kw[3].end())
            return self._device_condition(d, p, state, dur, open_w, close_w, on_w, off_w)

        # a kind word, maybe with a room: "ein Fenster im Bad", "die Küchentür"
        if kw and (allowed is None or kw[0] in allowed or (kw[0] == "light" and allowed == SWITCHABLE)):
            kind, word, kroom, m = kw
            p.mark(m.start(), m.end())
            target_room = kroom or room or (getattr(self, "hint_room", None) if not re.search(r"\b(irgend\w*|alle|eine?)\b", t) else None)
            if target_room:
                p.find(rf"\b(?:im|in der|in dem|in)\s+{re.escape(fold(target_room['name'])[:4])}\w*") or p.find(rf"\b{re.escape(fold(target_room['name'])[:4])}\w*")
            cand = self._of_kind(kind, target_room)
            p.find(r"\b(ein|eine|einer|irgendein|irgendeine|irgendeiner|das|die|der|alle)\b")
            many = bool(re.search(r"\balle\b", t))
            in_room = bool(target_room and self.inv.in_room(kind, target_room["id"]))
            if len(cand) == 1 and not many and not re.search(r"\b(ein|eine|irgendein\w*)\b", t) and not (in_room and kind in ("window", "door")):
                return self._device_condition(cand[0], p, state, dur, open_w, close_w, on_w, off_w)
            subject = f"{'all' if many else 'any'}:{kind}" + (f"@{target_room['id']}" if target_room and self.inv.in_room(kind, target_room["id"]) else "")
            if target_room and not self.inv.in_room(kind, target_room["id"]) and cand:
                return self._device_condition(cand[0], p, state, dur, open_w, close_w, on_w, off_w)
            if not cand and not self.inv.in_room(kind, None):
                self.unsure.append(f"Kein Gerät der Art „{word}“ gefunden.")
            return self._placeholder_condition(subject, kind, p, state, dur, open_w, close_w, on_w, off_w)

        # a room: someone comes in, nobody there
        if room:
            p.find(rf"\b(?:im|in der|in dem|in die|in den|ins|in)?\s*{re.escape(fold(room['name'])[:4])}\w*")
            for m in (someone, everyone, me):
                if m:
                    p.mark(m.start(), m.end())
            p.find(r"\b(betritt|betrete|betreten|reinkommt|rein kommt|hereinkommt|reingeht|rein geht|kommt|komme|ist|sind|da|mehr|leer|niemand|keiner)\b")
            p.find(r"\b(ist|da|mehr|niemand|keiner|leer)\b")
            p.find(r"\b(ist|da|mehr|niemand|keiner|leer)\b")
            if empty_w:
                if state:
                    return {"subject": f"room:{room['id']}", "verb": "is_empty"}
                return {"subject": f"room:{room['id']}", "verb": "empty_for" if dur else "empty", **({"for": dur} if dur else {})}
            return {"subject": f"room:{room['id']}", "verb": "is_occupied" if state else "entered"}

        # nobody / everyone at home without a verb we know
        if everyone and re.search(r"zuhause|daheim|\bda\b", t):
            p.mark(everyone.start(), everyone.end())
            p.find(r"zuhause|daheim|\bda\b")
            away = bool(re.search(r"niemand|keiner|nicht", t))
            return {"subject": "person:everyone", "verb": ("is_away" if away else "is_home") if state else ("leaves" if away else "arrives")}
        if someone and re.search(r"zuhause|daheim|\bda\b", t):
            p.mark(someone.start(), someone.end())
            p.find(r"zuhause|daheim|\bda\b")
            return {"subject": "person:someone", "verb": "is_home" if state else "arrives"}
        if hits:
            _s, d, span = hits[0]
            p.mark(*span)
            return self._device_condition(d, p, state, dur, open_w, close_w, on_w, off_w)
        return None

    def _phrase(self, p: Part, people: list[tuple[str, re.Match[str]]], me: re.Match[str] | None, everyone: re.Match[str] | None, someone: re.Match[str] | None, state: bool) -> dict[str, Any] | None:
        """A person clause from the data-driven phrases of the vocabulary (one list per language)."""
        for ph in vocabulary().get("phrases", {}).get(self.lang, []):
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
                who = "person:someone"
                hit = someone or me
                assert hit is not None
                p.mark(hit.start(), hit.end())
                if not someone:
                    self.unsure.append("Wer ist „ich“? Ich habe „jemand“ genommen.")
            else:
                continue
            p.mark(m.start(), m.end())
            p.find(r"\b(ist|sind|bin|bist|kommt|kommen|komme|wird|werden|sich)\b")
            out: dict[str, Any] = {"subject": who, "verb": ph["state"] if state else ph["event"], **(ph.get("params") or {})}
            if ph.get("number") and (n := re.search(r"\d+", m.group(0))):
                value = int(n.group(0))
                if re.search(r"\b(std|stunde)", m.group(0)):
                    value *= 60
                out[ph["number"]] = value
            return out
        return None

    def _zone_clause(self, p: Part, people: list[tuple[str, re.Match[str]]], me: re.Match[str] | None, state: bool) -> dict[str, Any] | None:
        """'Sam verlässt die Arbeit' → leaves_zone with the zone 'Sam Arbeit'."""
        if not self.zones:
            return None
        names = set(self.person_words)
        pid = people[0][0] if people else (self.me if me else None)
        best = None
        for z in self.zones:
            if z.get("id") == "home":
                continue
            toks = [w for w in re.findall(r"[a-z0-9]+", fold(z.get("name", ""))) if w not in names and len(w) >= 3]
            for w in toks:
                if m := re.search(rf"\b{re.escape(w)}\b", p.text):
                    score = 1 + (2 if pid and pid.split("_")[0] in fold(z.get("name", "")) else 0)
                    if not best or score > best[0]:
                        best = (score, z, m)
        if not best:
            return None
        _s, z, m = best
        leave = re.search(r"verlass\w*|weggeh\w*|losfahr\w*|geht von|fahrt von|los\b", p.text)
        arrive = re.search(r"ankomm\w*|erreich\w*|kommt (an|in|bei|zur)|ist (bei|in|auf|im|an)", p.text)
        if not (leave or arrive or state):
            return None
        p.mark(m.start(), m.end())
        who = f"person:{pid}" if pid else "person:someone"
        if people:
            p.mark(people[0][1].start(), people[0][1].end())
        elif me:
            p.mark(me.start(), me.end())
        p.find(r"\b(die|der|das|von|zur|zum|bei|in|im)\b")
        if leave:
            p.mark(leave.start(), leave.end())
            return {"subject": who, "verb": "not_in_zone" if state else "leaves_zone", "zone": z["id"]}
        if arrive:
            p.mark(arrive.start(), arrive.end())
        return {"subject": who, "verb": "in_zone" if state else "enters_zone", "zone": z["id"]}

    def _presence(self, d: dict[str, Any], state: bool, free: bool, dur: str | None) -> dict[str, Any]:
        subj = f"zone:{d['entity_id']}" if d["kind"] == "zone" else d["entity_id"]
        if state:
            return {"subject": subj, "verb": "is_free" if free else "is_occupied"}
        if free:
            return {"subject": subj, "verb": "free_for", "for": dur or "5m"}
        return {"subject": subj, "verb": "occupied", **({"for": dur} if dur else {})}

    def _device_condition(self, d: dict[str, Any], p: Part, state: bool, dur: str | None, open_w: Any, close_w: Any, on_w: Any, off_w: Any) -> dict[str, Any]:
        kind = d["kind"]
        subj = f"zone:{d['entity_id']}" if kind == "zone" else d["entity_id"]
        return self._placeholder_condition(subj, kind, p, state, dur, open_w, close_w, on_w, off_w)

    def _placeholder_condition(self, subj: str, kind: str, p: Part, state: bool, dur: str | None, open_w: Any, close_w: Any, on_w: Any, off_w: Any) -> dict[str, Any]:
        t = p.text
        for m in (open_w, close_w, on_w, off_w):
            if m:
                p.mark(m.start(), m.end())
        p.find(r"\b(wird|ist|sind|steht|stehen|bleibt|langer|seit|mehr als|uber|als)\b")
        p.find(r"\b(wird|ist|sind|steht|stehen|bleibt|langer|seit|mehr als|uber|als)\b")
        c: dict[str, Any] = {"subject": subj}
        closing = bool(close_w) and not open_w
        if kind in OPENABLE:
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
                c["verb"] = "is_playing" if re.search(r"spielt|lauft|musik", t) else "is_on"
            elif p.find(r"\b(stoppt|aufhort|endet|pausiert|ausgeht|aus)\b"):
                c["verb"] = "stops"
            elif p.find(r"\b(spielt|abspielt|abgespielt|lauft|anfangt|beginnt|startet)\b"):
                c["verb"] = "starts_playing"
            else:
                c["verb"] = "turns_on"
        elif kind == "motion":
            p.find(r"\b(bewegung|bewegt|erkannt|gemeldet|meldet|ist)\b")
            if re.search(r"keine bewegung|nicht bewegt|ruhig", t):
                c["verb"] = "is_clear" if state else "clear_for"
                if not state:
                    c["for"] = dur or "5m"
            else:
                c["verb"] = "is_active" if state else "detected"
        elif kind in ("presence", "zone"):
            free = bool(re.search(r"frei|leer|niemand|keiner|verlass", t))
            return self._presence({"entity_id": subj.removeprefix("zone:"), "kind": kind}, state, free, dur)
        elif kind == "leak":
            p.find(r"\b(wasser|nass|feucht|meldet|erkannt|gemeldet|leck)\b")
            p.find(r"\b(wasser|nass|feucht|meldet|erkannt|gemeldet|leck)\b")
            c["verb"] = "is_wet" if state else "wet"
        elif kind == "climate":
            p.find(r"\b(heizt|heizen|zu heizen|anfangt|beginnt|startet)\b")
            p.find(r"\b(heizt|heizen|zu heizen|anfangt|beginnt|startet)\b")
            c["verb"] = "is_heating" if state else "starts_heating"
        elif kind == "vacuum":
            if p.find(r"\b(fertig|beendet|gesaugt|zuruck)\b") or not state:
                c["verb"] = "is_docked" if state else ("starts" if p.find(r"\b(startet|beginnt|losfahrt|lost|saugt)\b") and "fertig" not in t else "done")
            else:
                c["verb"] = "is_docked"
        elif kind == "lock":
            c["verb"] = "is_locked" if state else "unlocked"
            p.find(r"\b(aufgeschlossen|entriegelt|abgeschlossen|verriegelt)\b")
        elif kind == "cover":
            c["verb"] = "is_open" if state else ("closes" if closing else "opens")
        elif kind == "temperature":
            c["verb"] = "is_below" if state else "below"
        elif kind == "illuminance":
            c["verb"] = "is_below" if state else "below"
        else:
            c["verb"] = "is_on" if state else "turns_on"
        return c

    def _duration(self, p: Part) -> str | None:
        m = p.find(r"(?:(?:langer|mehr) als|uber|seit|fur|nach)?\s*(\d+|einem|einer?|zwei|drei|funf|zehn|halbe)\s*(sekunden?|sek|minuten?|min|stunden?|std|tage?n?)\b")
        if not m:
            return None
        n = {"ein": 1, "eine": 1, "einer": 1, "einem": 1, "zwei": 2, "drei": 3, "funf": 5, "zehn": 10}.get(m.group(1))
        if m.group(1) == "halbe":
            return "30m"
        num = n or int(m.group(1))
        unit = m.group(2)
        u = "s" if unit.startswith("sek") else "h" if unit.startswith(("stund", "std")) else "d" if unit.startswith("tag") else "m"
        return f"{num}{u}"

    def _pick_sensor(self, kind: str, room: dict[str, Any] | None, p: Part) -> str | None:
        hits = [h for h in self._device_hits(p, {kind}) if h[0] >= 30]
        if hits:
            p.mark(*hits[0][2])
            return hits[0][1]["entity_id"]
        cand = self._of_kind(kind, room)
        if room and room.get("lux") and kind == "illuminance":
            return room["lux"]

        def rank(d: dict[str, Any]) -> int:
            n = fold(d["name"])
            return (5 if "temperatursensor" in n or "thermometer" in n else 0) + (3 if "licht" in n or "light" in n else 0) - (6 if re.search(r"ausen|aussen|heizung|physisch|local", n) else 0)

        cand.sort(key=lambda d: -rank(d))
        return cand[0]["entity_id"] if cand else None

    def _of_kind(self, kind: str, room: dict[str, Any] | None) -> list[dict[str, Any]]:
        """Devices of a kind in a room: by the room setting, else by the room in the name ('Küche Türsensor')."""
        devs = [d for d, _n, _t in self.devices if d["kind"] == kind]
        if not room:
            return devs
        rid = room["id"]
        rn = fold(room["name"])
        stem = rn[:-1] if rn.endswith("e") and len(rn) > 4 else rn
        inside = [d for d in devs if d.get("room") == rid]
        named = [d for d in devs if not d.get("room") and re.search(rf"\b{re.escape(stem)}", fold(d["name"]))]
        return inside + named

    # ------------------------------------------------------------------ actions
    def _actions(
        self, act: Part, trig: dict[str, Any] | None, message: str | None, original: str, rule: dict[str, Any], fallback: list[Subject] | None = None
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        self._last_subjects = []
        if not act.text.strip():
            return out
        pieces = self._pieces(act, r",|\bund\b|\bdann\b|\banschliesend\b|\banschliessend\b|\bdanach\b|\bsowie\b")
        parsed: list[tuple[Part, list[Subject], str | None, dict[str, Any]]] = []
        trig_dev = self.inv.devices.get(trig["subject"]) if trig else None
        trig_room = self._room_of_clause(trig) if trig else None
        for p in pieces:
            verb, extra = self._action_verb(p)
            self._want = extra.pop("want", None)
            subjects = self._action_subjects(p, verb, trig_dev, trig_room)
            self._want = None
            parsed.append((p, subjects, verb, extra))
        # German puts "an"/"aus" last: parts without a verb take the next one, parts without a thing the one before
        for i, (p, subs, verb, extra) in enumerate(parsed):
            if verb is None and subs:
                nxt = next(((v, e) for _p, _s, v, e in parsed[i + 1 :] if v), None)
                if nxt:
                    parsed[i] = (p, subs, nxt[0], dict(nxt[1]))
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
                    self.unsure.append(f"Was soll mit „{self.core.describer.subject(subs[0].subject)['label']}“ passieren? Ich habe „einschalten“ genommen.")
                    verb = "turn_on"
                else:
                    self.leftover += p.leftover()
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
            self.leftover += p.leftover()
        return out

    def _room_of_clause(self, c: dict[str, Any]) -> str | None:
        s = c.get("subject", "")
        if s.startswith("room:"):
            return s[5:]
        if m := re.match(r"^(any|all):[a-z_]+@([a-z0-9_]+)$", s):
            return m.group(2)
        d = self.inv.devices.get(s.removeprefix("zone:"))
        return d.get("room") if d else None

    def _action_verb(self, p: Part) -> tuple[str | None, dict[str, Any]]:
        t = p.text
        extra: dict[str, Any] = {}
        if m := p.find(r"\bnach (\d+|einer|zwei|drei|funf|zehn)\s*(sekunden?|sek|minuten?|min|stunden?|std)\b"):
            n = {"einer": 1, "zwei": 2, "drei": 3, "funf": 5, "zehn": 10}.get(m.group(1)) or int(m.group(1))
            unit = m.group(2)
            dur = f"{n}{'s' if unit.startswith('sek') else 'h' if unit.startswith(('stund', 'std')) else 'm'}"
            self._late = dur
            rest = re.sub(r"\bwieder\b", " ", t[m.end() :])
            before = Part(t[: m.start()], 0)
            if (self._device_hits(before, ACTORS) and self._device_hits(before, ACTORS)[0][0] >= 25) or self._kind_word(before):
                # "Licht in der Küche nach 10 Minuten aus": wait, then switch
                extra["delay"] = dur
                m = None
        if m and re.search(r"\baus\b|ausschalt|ausmach", rest := re.sub(r"\bwieder\b", " ", t[m.end() :])) and not self._device_hits(Part(rest, 0), None) and not self._kind_word(Part(rest, 0)):
                p.find(r"\bwieder\b")
                p.find(r"\baus\b|ausschalt\w*|ausmach\w*")
                return "wait", {"for": dur, "then": "turn_off"}
        if m and not re.search(r"[a-z]{3,}", re.sub(r"\b(wieder|aus|an)\b", "", rest)):
                p.find(r"\bwieder\b")
                p.find(r"\baus\b|\ban\b")
                return "wait", {"for": dur, "then": "turn_off" if "aus" in rest else "turn_on"}
        if m := p.find(r"\b(?:fur|fuer)\s+(\d+)\s*(minuten?|min|stunden?|std|sekunden?)\b"):
            unit = m.group(2)
            extra["for"] = f"{m.group(1)}{'s' if unit.startswith('sek') else 'h' if unit.startswith(('stund', 'std')) else 'm'}"
        if re.search(r"\b(nachricht|bescheid|benachrichtig\w*|schick\w*|schreib\w*|informier\w*|push\w*|melde mir|sag mir|sag uns|sage mir|warn\w*|frag\w*)\b", t) and not re.search(
            r"\bsag\w*\b.*\b(uber|auf|im|in der|durch)\b", t
        ):
            p.find(r"\b(eine |ne )?(nachricht|bescheid|benachrichtigung)\b")
            p.find(r"\b(schick\w*|schreib\w*|sende\w*|gib\w*|benachrichtig\w*|informier\w*|push\w*|melde|sag\w*)\b")
            if p.find(r"\b(warn\w*|alarm\w*|dringend\w*)\b"):
                return "alarm", extra
            if p.find(r"\bfrag\w*\b"):
                return "ask", extra
            return "send", extra
        if re.search(r"\balarm\b\s+(?:an|fur|auf)\s+(?:alle|allen|mich|mir|uns|die handys|das handy|\w+s handy)", t) or re.search(r"\b(warn\w*)\b", t):
            p.find(r"\b(alarm|warn\w*)\b")
            p.find(r"\bwarn\w*\b")
            return "alarm", extra
        if re.search(r"\b(haus)?modus\b", t):
            for pat, mode in MODE_WORDS:
                if p.find(rf"\b(?:auf |zu |in )?(?:{pat})"):
                    p.find(r"\b(haus)?modus\b")
                    p.find(r"\b(setz\w*|stell\w*|schalt\w*|wechsel\w*)\b")
                    return "set_mode", {"mode": mode}
        if re.search(r"\balarm(anlage)?\b", t):
            p.find(r"\b(die )?alarm(anlage)?\b")
            if p.find(r"\b(unscharf|aus|ausschalten|deaktivier\w*)\b"):
                return "disarm", extra
            if p.find(r"\b(scharf|an|einschalten|aktivier\w*)\b"):
                return "arm_night" if re.search(r"nacht", t) else "arm_home" if re.search(r"zuhause", t) else "arm_away", extra
        if m := p.find(r"\bauf (\d{1,3}) ?(?:%|prozent)"):
            extra["percent"] = int(m.group(1))
        if m := p.find(r"\bauf (\d{1,2}(?:[.,]\d)?) ?(?:grad|°)"):
            extra["temperature"] = float(m.group(1).replace(",", "."))
            p.find(r"\b(stell\w*|setz\w*|heiz(?!ung)\w*|regel\w*|dreh\w*)\b")
            return "set_temp", extra
        if m := p.find(r"\blautstarke (?:auf )?(\d{1,3})"):
            extra["volume"] = int(m.group(1))
            return "volume", extra
        if p.find(r"\b(sag\w*|durchsag\w*|ansag\w*|ankundig\w*|sprich|sprech\w*|vorles\w*)\b"):
            return "announce", extra
        if p.find(r"\b(hell|heller|licht machen)\b"):
            p.find(r"\b(mach\w*|s)\b")
            return "turn_on", {**extra, "want": "light"}
        if p.find(r"\b(dunkel|finster)\b"):
            p.find(r"\b(mach\w*|s)\b")
            return "turn_off", {**extra, "want": "light"}
        if re.search(r"\b(warm|warmer|kuschelig)\b", t):
            p.find(r"\b(warm|warmer|kuschelig)\b")
            p.find(r"\b(sorg\w*|dafur|dass|es|ist|wird|mach\w*)\b")
            p.find(r"\b(sorg\w*|dafur|dass|es|ist|wird|mach\w*)\b")
            p.find(r"\b(sorg\w*|dafur|dass|es|ist|wird|mach\w*)\b")
            return "set_temp", {**extra, "want": "climate", "temperature": 21}
        if re.search(r"heizung|thermostat", t) and p.find(r"\b(runter|herunter|kleiner|niedriger|absenken)\b"):
            return "eco", extra
        if re.search(r"heizung|thermostat", t) and p.find(r"\b(hoch|rauf|hochdrehen|aufdrehen|warmer)\b"):
            return "boost", extra
        if p.find(r"\b(spar\w*|eco|absenk\w*|nachtabsenkung)\b"):
            return "eco", extra
        if p.find(r"\b(boost|aufheiz\w*)\b"):
            return "boost", extra
        if p.find(r"\b(abschliesen|abschliessen|abschlies\w*|zusperr\w*|verriegel\w*|absperr\w*)\b"):
            return "lock", extra
        if p.find(r"\b(aufschlies\w*|entriegel\w*|aufsperr\w*)\b"):
            return "unlock", extra
        if p.find(r"\b(pausier\w*|pause|anhalt\w*|stopp\w*|stop)\b"):
            return "pause", extra
        if p.find(r"\b(spiel\w*|abspiel\w*|play)\b"):
            return "play", extra
        if p.find(r"\b(runter|herunter|schlies\w*|zumach\w*)\b"):
            return "close", extra
        if p.find(r"\b(hoch|herauf|rauf|offne\w*|aufmach\w*)\b"):
            return "open", extra
        if p.find(r"\b(saug\w*|putz\w*|reinig\w*|losschick\w*|losfahr\w*|los)\b"):
            return "start", extra
        if p.find(r"\b(zuruck|zur basis|zur station|laden|docken)\b"):
            return "dock", extra
        if p.find(r"\b(umschalt\w*|toggle\w*|wechsel\w*)\b"):
            return "toggle", extra
        if p.find(r"\b(ausschalt\w*|ausmach\w*|abschalt\w*|ausknips\w*|aus)\b"):
            p.find(r"\b(alles|damit)\b")
            p.find(r"\b(mach\w*|schalt\w*)\b")
            p.find(r"\bwieder\b")
            return "turn_off", extra
        if p.find(r"\b(einschalt\w*|anschalt\w*|anmach\w*|anknips\w*|an|ein|starte\w*|start)\b"):
            p.find(r"\b(mach\w*|schalt\w*)\b")
            p.find(r"\bwieder\b")
            return "turn_on", extra
        if extra.get("percent") is not None:
            return "dim", extra
        if p.find(r"\b(blink\w*)\b"):
            return "blink", extra
        if p.find(r"\b(fuhr\w*|lauf\w*) .* aus\b|\bausfuhr\w*"):
            return "run", extra
        return None, extra

    def _action_subjects(self, p: Part, verb: str | None, trig_dev: dict[str, Any] | None, trig_room: str | None) -> list[Subject]:
        t = p.text
        if verb in ("send", "alarm", "ask", "set_mode", "wait", "arm_away", "arm_night", "arm_home", "disarm"):
            return []
        want: set[str] | None = ACTORS
        if self._want:
            want = {self._want}
        elif verb in ("dim", "blink") or (verb is None and re.search(r"prozent|%", t)):
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
        # "ihn", "sie", "es": the thing from the condition
        if re.search(r"\b(ihn|ihm|es|sie|damit|den|das teil)\b", t) and trig_dev and trig_dev["kind"] in ACTORS and not self._device_hits(p, want):
            p.find(r"\b(ihn|ihm|es|sie|damit|das teil)\b")
            return [Subject(trig_dev["entity_id"], trig_dev["kind"], trig_dev.get("room"), trig_dev)]
        kw = self._kind_word(p)
        if (
            not kw
            and want is not None
            and len(want) <= 2
            and (wk := next(iter(want - {"group"}), None)) in ("light", "climate", "media")
            and not [h for h in self._device_hits(p, want) if h[0] >= 25]
        ):
            # "Flur hell machen" = the light in the hall, "warm" = the heating
            room = self._room_in(t) or (self.rooms_by_id.get(trig_room) if trig_room else None)
            if room:
                p.find(rf"\b(?:im|in der|in dem|in|den|die|das)?\s*{re.escape(fold(room['name'])[:4])}\w*")
                named = [d for d in self._of_kind(wk, room)]
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
            # the same name for several devices: only those that fit the room, if any
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
                p.find(rf"\b(?:im|in der|in dem|in|auf dem|auf der)?\s*{re.escape(fold(room['name'])[:4])}\w*")
            many = bool(p.find(r"\balle[n]?\b")) or word.endswith(("en", "er")) and word not in ("fenster", "lautsprecher", "luftreiniger", "fernseher", "sauger", "staubsauger")
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
                self.unsure.append(f"{room['in'][:1].upper()}{room['in'][1:]} ist noch kein Gerät der Art „{word}“ zugeordnet.")
                return [Subject(f"all:{kind}@{room['id']}", kind, room["id"])]
            if many and re.search(r"\balle[n]?\b", t) or (many and not trig_room):
                return [Subject(f"all:{kind}", kind)]
            if trig_room:
                if trig_room and self.inv.in_room(kind, trig_room):
                    rid = trig_room
                    return [Subject(f"all:{kind}@{rid}", kind, rid)]
            if many:
                return [Subject(f"all:{kind}", kind)]
            cand = self._of_kind(kind, None)
            if len(cand) == 1:
                return [Subject(cand[0]["entity_id"], kind, cand[0].get("room"), cand[0])]
            self.unsure.append(f"Welches Gerät ist mit „{word}“ gemeint? Ich habe alle im Haus genommen.")
            return [Subject(f"all:{kind}", kind)]
        if re.search(r"\balles\b", t) and verb in ("turn_on", "turn_off"):
            p.find(r"\balles\b")
            self.unsure.append("„Alles“: Ich habe alle Lichter genommen.")
            return [Subject("all:light", "light")]
        if verb in ("start", "dock"):
            cand = self._of_kind("vacuum", None)
            if cand:
                return [Subject(cand[0]["entity_id"], "vacuum", cand[0].get("room"), cand[0])]
        if verb == "announce":
            room = self._room_in(t)
            if room and self.inv.in_room("media", room["id"]):
                p.find(rf"\b(?:im|in der|in dem|in)?\s*{re.escape(fold(room['name'])[:4])}\w*")
                return [Subject(f"all:media@{room['id']}", "media", room["id"])]
        return []

    def _action_clause(self, s: Subject, verb: str, extra: dict[str, Any], p: Part, message: str | None = None, original: str = "") -> dict[str, Any] | None:
        kind = s.kind
        v = verb
        if kind == "climate":
            v = {"turn_on": "set_temp", "dim": "set_temp"}.get(v, v)
            if v not in ("set_temp", "eco", "turn_off", "boost"):
                v = "turn_off" if v == "turn_off" else "set_temp"
        elif kind == "media":
            v = {"turn_on": "play", "start": "play", "stop": "pause"}.get(v, v)
            if v == "turn_off" and s.subject.startswith("all:"):
                v = "pause"
            if v not in ("play", "pause", "volume", "announce", "turn_off"):
                v = "play"
        elif kind == "cover":
            v = {"turn_on": "open", "turn_off": "close"}.get(v, v)
            if extra.get("percent") is not None:
                v = "position"
            if v not in ("open", "close", "position"):
                v = "open"
        elif kind == "vacuum":
            v = {"turn_on": "start", "turn_off": "dock", "play": "start"}.get(v, v)
            if v not in ("start", "dock"):
                v = "start"
        elif kind == "script":
            v = "run"
        elif kind == "lock":
            v = v if v in ("lock", "unlock") else ("lock" if v == "turn_off" else "unlock")
        elif kind in ("light", "group"):
            if extra.get("percent") is not None and v in ("turn_on", "dim", None):
                v = "dim"
            if v not in ("turn_on", "turn_off", "toggle", "dim", "blink", "color"):
                v = "turn_on" if v not in ("pause",) else "turn_off"
        else:
            if v not in ("turn_on", "turn_off", "toggle"):
                v = "turn_off" if v in ("pause", "close", "dock") else "turn_on"
        c: dict[str, Any] = {"subject": s.subject, "verb": v}
        if v == "dim":
            c["brightness"] = extra.get("percent", 50)
        if v == "set_temp":
            c["temperature"] = extra.get("temperature", 21)
        if v == "position":
            c["position"] = extra.get("percent", 50)
        if v == "volume":
            c["volume"] = extra.get("volume", 30)
        if v == "announce":
            c["message"] = message or self._said(p, original) or self.default_announce
        if extra.get("for") and v in ("turn_on", "dim", "boost", "open"):
            c["for"] = extra["for"]
        return c

    def _said(self, p: Part, original: str) -> str:
        """What is left of an announcement part: 'sag im Flur über das Wandtablet Willkommen' → 'Willkommen'."""
        words = []
        for m in re.finditer(r"[a-z0-9]+", p.text):
            if any(p.used[m.start() : m.end()]) or m.group(0) in self.stop or m.group(0) in self.said_skip:
                continue
            a, b = p.start + m.start(), p.start + m.end()
            words.append(original[a:b])
            p.mark(m.start(), m.end())
        return " ".join(words).strip().capitalize() if words else ""

    def _notify(self, p: Part, verb: str, message: str | None, rule: dict[str, Any]) -> dict[str, Any]:
        t = p.text
        to = "notify:everyone"
        people = self._persons(p)
        if people:
            to = f"notify:{people[0][0]}"
            p.mark(people[0][1].start(), people[0][1].end())
        elif re.search(r"\b(mir|mich)\b", t):
            p.find(r"\b(mir|mich)\b")
            if self.me:
                to = f"notify:{self.me}"
            else:
                self.unsure.append("Wer ist „mir“? Die Nachricht geht an alle.")
        p.find(r"\b(allen|alle|uns|an)\b")
        p.find(r"\b(eine|ne|per|aufs|auf das|handy|telefon|push)\b")
        c: dict[str, Any] = {"subject": to, "verb": verb, "message": message or ""}
        return c

    def _same_room(self, rule: dict[str, Any]) -> None:
        """'Licht an' after a trigger in a room: that room."""
        for c in rule["then"]:
            if c["subject"].endswith("@same") and not any(x["subject"].startswith(("any:", "room:")) for x in rule["when"]):
                c["subject"] = c["subject"][:-5]


SYNONYMS = {"couch": "sofa", "esstisch": "essbereich", "herd": "kochfeld", "eingang": "flur", "schreibtischlampe": "schreibtisch"}
PLACE_PARTS = ("tisch", "bereich", "platz", "ecke", "zone", "seite", "feld")


def _same_place(a: str, b: str) -> bool:
    """'esstisch' and 'essbereich': same first part, both a place."""
    for pa in PLACE_PARTS:
        if a.endswith(pa) and len(a) > len(pa) + 2:
            head = a[: -len(pa)]
            return any(b == head + pb for pb in PLACE_PARTS if pb != pa)
    return False


GENERIC_TOKENS = {
    "licht", "lampe", "sensor", "tur", "fenster", "heizung", "steckdose", "schalter", "kontakt", "contact", "presence", "motion",
    "light", "level", "temperatur", "temperature", "belegung", "alles", "physisch", "smart", "extern", "aussen", "ausen", "innen",
    "leiste", "steckdosenleiste", "socket", "plug", "bridge", "all", "occupancy", "person", "beleuchtungsstarke", "lichtsensor",
    "musik", "assistant", "mini", "pro", "max", "series", "core", "home", "homepod", "tablet",
}


def whole_leftover(p: Part) -> list[str]:
    return p.leftover()


def kinds_known() -> dict[str, Any]:
    return vocab_kinds()
