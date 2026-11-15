"""From a German sentence to a rule draft.

With Ollama: the model only chooses from lists (subjects as readable names, verbs as ids), enforced
by a JSON schema ("structured outputs"). That keeps even a 1B model inside valid rules. The result is
checked and repaired; whatever cannot be placed is reported back as "unsure".
Without Ollama (or if it fails): a small rule-based parser for common German phrases.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import TYPE_CHECKING, Any

from .i18n import lang_of, tr
from .vocab import flavour_for, kinds, verb as find_verb, verbs

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

SECTIONS = ("when", "and", "then", "only", "else")
DOMAIN_KINDS = {
    "binary_sensor", "sensor", "number", "input_number", "select", "input_select", "input_text", "button", "input_button", "scene",
    "input_boolean", "siren", "humidifier", "water_heater", "automation", "camera", "device_tracker", "event", "media_player", "entity",
}


def _norm(s: str) -> str:
    return s.lower().replace("ß", "ss")


class TextToRule:
    def __init__(self, core: HouseRules) -> None:
        self.core = core

    # ------------------------------------------------------------------ settings
    def catalogue(self, text: str, me: str | None = None) -> dict[str, str]:
        """Readable name → subject. Only what the text could mean, to keep the list short for small models."""
        from .parse import Part, SentenceParser, fold  # noqa: PLC0415

        core = self.core
        inv = core.inventory
        k = kinds()
        cat: dict[str, str] = {}

        def add(label: str, subject: str) -> None:
            if subject in cat.values():
                return
            while label in cat:
                label += " *"
            cat[label] = subject

        for kind in ("window", "door", "motion", "leak"):
            add(k[kind]["any"].capitalize(), f"any:{kind}")
        for kind in ("light", "climate", "window", "cover", "media"):
            if inv.in_room(kind, None):
                add(f"Alle {k[kind]['plural']} im Haus", f"all:{kind}")
        add("Jemand (irgendeine Person)", "person:someone")
        add("Alle Personen", "person:everyone")
        add("Uhrzeit", "time")
        add("Sonne", "sun")
        add("Hausmodus", "mode")
        add("Alarmanlage", "alarm")
        add("Warten", "wait")
        add("Nachricht an alle Handys", "notify:everyone")
        for p in inv.persons.values():
            add(f"Person {p['name']}", f"person:{p['id']}")
            add(f"Nachricht an {p['name']}", f"notify:{p['id']}")
        for rid, room in core.rooms.items():
            add(f"Raum {room['name']} (jemand da / leer / dunkel)", f"room:{rid}")
            for kind in ("light", "climate", "window", "door", "media", "cover"):
                if inv.in_room(kind, rid):
                    many = kind in ("light", "climate", "media", "cover")
                    label = f"Alle {k[kind]['plural']} {room['in']}" if many else f"{k[kind]['any'].capitalize()} {room['in']}"
                    add(label, f"{'all' if many else 'any'}:{kind}@{rid}")
        # devices: the best matches for every word of the sentence
        parser = SentenceParser(core, me)
        t = fold(text)
        scored: dict[str, tuple[int, dict[str, Any]]] = {}
        for m in re.finditer(r"[a-z0-9]{3,}", t):
            for score, d, _span in parser._device_hits(Part(m.group(0), 0), None)[:4]:
                if score >= 20 and score > scored.get(d["entity_id"], (0, d))[0]:
                    scored[d["entity_id"]] = (score, d)
        for score, d, _span in parser._device_hits(Part(t, 0), None)[:10]:
            scored.setdefault(d["entity_id"], (score, d))
        for _s, d in sorted(scored.values(), key=lambda x: -x[0])[:30]:
            room = core.rooms.get(d.get("room") or "", {}).get("name")
            label = f"{d['name']} ({k.get(d['kind'], {}).get('label', d['kind'])}{', ' + room if room else ''})"
            add(label, d["entity_id"] if d["kind"] != "zone" else f"zone:{d['entity_id']}")
        return cat

    # ------------------------------------------------------------------ main
    def language(self, text: str, language: str | None = None) -> str:
        """The language of a sentence (German or English); a sentence that could be either goes to the user's language."""
        from .parse_en import detect_language  # noqa: PLC0415

        return detect_language(text, lang_of(language) if language else lang_of(self.core))

    async def draft(self, text: str, me: str | None = None, language: str | None = None) -> dict[str, Any]:
        """Rule draft from a sentence, right away (simple parser). With a connected model the editor then asks improve()."""
        text = text.strip()[:400]
        lang = self.language(text, language)
        rule, unsure, unknown = self.analyse(text, me, lang)
        if unknown:
            unsure = [*unsure, tr(lang, "text.not_understood", words=", ".join(unknown[:6]))]
        return {"rule": rule, "unsure": unsure, "unknown": unknown, "sure": not unsure, "source": "basic", "ai": self.core.ai.connected, "language": lang}

    async def improve(self, text: str, draft: dict[str, Any], me: str | None = None) -> dict[str, Any]:
        """The connected model fills the gaps of the parser's draft (only asked when the parser was unsure)."""
        from .ai import complete  # noqa: PLC0415

        cat = self.catalogue(text, me)
        names = {v: k for k, v in cat.items()}
        for sec in SECTIONS:
            for c in draft.get(sec) or []:
                if c.get("subject") and c["subject"] not in names:
                    label = self.describer_label(c["subject"])
                    while label in cat:
                        label += " *"
                    cat[label] = c["subject"]
                    names[c["subject"]] = label
        draft_json = {
            "type": draft.get("type", "when"),
            **{sec: [{**{k: v for k, v in c.items() if k != "subject"}, "subject": names[c["subject"]]} for c in draft.get(sec) or [] if c.get("subject")] for sec in SECTIONS},
        }
        asked = text
        if me and (p := self.core.inventory.persons.get(me)):
            asked = re.sub(r"\b(ich|mich|mir|mein|meine)\b", p["name"], text, flags=re.I)
        lang = self.language(text)
        _rule, notes, unknown = self.analyse(text, me, lang)
        user = (
            "Dinge (subject NUR aus dieser Liste, genau so geschrieben):\n- "
            + "\n- ".join(cat.keys())
            + f"\n\nSatz: {asked}\n\nEntwurf der eingebauten Erkennung: {self.core.describer.sentence(draft) or '(leer)'}\n{json.dumps(draft_json, ensure_ascii=False)}\n"
            + (f"Nicht verstanden: {', '.join(unknown)}\n" if unknown else "")
            + (f"Unsicher: {'; '.join(notes)}\n" if notes else "")
            + "\nBehalte, was am Entwurf stimmt. Ergänze oder korrigiere nur, was fehlt oder falsch ist. Gib die vollständige Regel als JSON zurück."
        )
        # no JSON schema with the name list: on a small server without GPU that makes the model very slow; names are matched afterwards
        raw = await complete(self.core, self.prompt(), user, None, timeout=180)
        rule, unsure = self.repair(raw, cat, text)
        model = self.core.ai.config.get("model")
        if not rule["when"] or not rule["then"]:
            return {"changed": False, "note": tr(lang, "text.ai_unsure"), "model": model}
        same = all(
            [(c["subject"], c["verb"]) for c in rule.get(s, [])] == [(c.get("subject"), c.get("verb")) for c in draft.get(s) or []] for s in SECTIONS
        ) and rule["type"] == draft.get("type", "when")
        rule["id"] = draft.get("id") or rule["id"]
        rule["name"] = draft.get("name") or rule["name"]
        rule["options"] = draft.get("options") or rule["options"]
        for c in rule["then"]:
            if c["subject"].startswith("notify:") and not c.get("message"):
                c["message"] = self._message(rule, lang)
        return {"changed": not same, "rule": rule, "sentence": self.core.describer.sentence(rule), "unsure": unsure, "model": model}

    async def warmup(self) -> None:
        """Loads the model and its fixed instructions once, so the first real question is faster."""
        from .ai import AiError, complete  # noqa: PLC0415

        if not self.core.ai.connected or self.core.ai.config.get("provider") != "ollama":
            return
        try:
            await complete(self.core, self.prompt(), 'Antworte nur mit {"ok": true}.', None, timeout=300)
        except AiError:
            pass

    def describer_label(self, subject: str) -> str:
        info = self.core.describer.subject(subject)
        return str(info["label"])[:1].upper() + str(info["label"])[1:]

    # ------------------------------------------------------------------ review and guard
    def _context(self, rule: dict[str, Any]) -> str:
        """What the model needs to judge a rule: the devices it uses with room and state, rooms, people, time, other rules."""
        from homeassistant.util import dt as dt_util  # noqa: PLC0415

        core = self.core
        res = core.checker.res
        lines = [f"Jetzt: {dt_util.now():%A %H:%M}, Hausmodus {core.mode_label(core.mode)}."]
        ents: list[str] = []
        for s in SECTIONS:
            for c in rule.get(s) or []:
                ents += res.entities(str(c.get("subject", "")), None, None) if not str(c.get("subject", "")).endswith("@same") else []
        for e in list(dict.fromkeys(ents))[:30]:
            d = core.inventory.devices.get(e, {})
            st = core.hass.states.get(e)
            room = core.rooms.get(d.get("room") or "", {}).get("name", "ohne Raum")
            lines.append(f"- {e}: {d.get('name', e)} ({d.get('kind', '?')}, {room}), Zustand {st.state if st else 'fehlt'}")
        occ = core.room_tracker.view()
        lines.append("Räume: " + ", ".join(f"{r['name']} ({'belegt' if occ.get(rid, {}).get('occupied') else 'leer'})" for rid, r in core.rooms.items()))
        lines.append("Personen: " + ", ".join(f"{p['name']}: {core.inventory.person_where(p['id'])}" for p in core.inventory.persons.values()))
        others = [core.describer.sentence(r) for r in core.rules() if r["id"] != rule.get("id")][:20]
        if others:
            lines.append("Andere Regeln:\n" + "\n".join(f"- {o}" for o in others))
        return "\n".join(lines)

    async def review(self, rule: dict[str, Any]) -> dict[str, Any]:
        """The model looks over a rule: does it do what it says, conflicts, safety, improvements."""
        from .ai import complete  # noqa: PLC0415

        system = (
            "Du bist ein erfahrener Smart-Home-Berater und prüfst eine Hausregel für Home Assistant. "
            "Achte auf: tut die Regel, was ihr Satz sagt; fehlende Bedingungen (z. B. Licht am Tag, Schleifen, zu häufiges Auslösen); "
            "Konflikte mit anderen Regeln; Sicherheit (Schlösser, Alarm, Heizung); nicht erreichbare Geräte. "
            'Antworte als JSON: {"verdict": "ok" | "hinweis" | "problem", "summary": "ein Satz", "notes": ["kurze, konkrete Hinweise auf ' + tr(self.core, "text.answer_language") + '"], '
            '"improved": null oder eine verbesserte Regel im selben Format (type, when, and, then, only), nur wenn sie wirklich besser ist}.'
        )
        user = f"Regel als Satz: {self.core.describer.sentence(rule)}\nRegel als JSON: {json.dumps({k: rule.get(k) for k in ('type', 'when', 'and', 'then', 'only', 'options')}, ensure_ascii=False)}\n\n{self._context(rule)}"
        raw = await complete(self.core, system, user, None, timeout=90)
        out: dict[str, Any] = {
            "verdict": raw.get("verdict") if raw.get("verdict") in ("ok", "hinweis", "problem") else "hinweis",
            "summary": str(raw.get("summary") or "")[:300],
            "notes": [str(n)[:300] for n in (raw.get("notes") or []) if n][:8],
            "model": self.core.ai.config.get("model"),
        }
        imp = raw.get("improved")
        if isinstance(imp, dict) and imp.get("when") and imp.get("then"):
            try:
                cand = self.core.sanitize({**rule, **{k: imp.get(k, rule.get(k)) for k in ("type", "when", "and", "then", "only")}})
                cand["id"] = rule.get("id") or cand["id"]
                out["improved"] = cand
                out["improved_sentence"] = self.core.describer.sentence(cand)
            except ValueError:
                pass
        return out

    async def guard(self, rule: dict[str, Any], why: str) -> tuple[bool, str]:
        """Right before a rule runs: does it make sense now? (option "KI schaut vor dem Ausführen drüber")"""
        from .ai import complete  # noqa: PLC0415

        system = (
            "Eine Hausregel will gerade ausgeführt werden. Entscheide mit gesundem Menschenverstand, ob das jetzt sinnvoll ist "
            "(z. B. kein Licht mitten am Tag, keine Nachricht, wenn alle sowieso zuhause sind). Im Zweifel: ausführen. "
            'Antworte als JSON: {"run": true | false, "reason": "kurzer Grund auf ' + tr(self.core, "text.answer_language") + '"}.'
        )
        user = f"Regel: {self.core.describer.sentence(rule)}\nAusgelöst, weil: {why}\n\n{self._context(rule)}"
        raw = await complete(self.core, system, user, {"type": "object", "properties": {"run": {"type": "boolean"}, "reason": {"type": "string"}}, "required": ["run", "reason"]}, timeout=25)
        return bool(raw.get("run", True)), str(raw.get("reason") or "")[:200]

    def _message(self, rule: dict[str, Any], lang: str | None = None) -> str:
        """A message in plain past tense from the trigger: 'Haustür ist aufgegangen.' / 'Front door has opened.'"""
        lang = lang or lang_of(self.core)
        if not rule["when"]:
            return tr(lang, "text.triggered")
        c = rule["when"][0]
        d = self.core.describer
        old, d.lang_override = d.lang_override, lang
        try:
            subj = d.subject(c["subject"])
            label = subj["label"]
            if c["verb"] in PAST_VERBS:
                text = f"{label} {tr(lang, f'past.{c["verb"]}_{"other" if subj["plural"] else "one"}')}"
            else:
                text = d.clause(c, "when")
        finally:
            d.lang_override = old
        return text[:1].upper() + text[1:] + "."


    def _new(self, text: str) -> dict[str, Any]:
        short = re.sub(r"^\s*(wenn|solange|sobald|falls|whenever|when|while|as soon as|if)\s+", "", text, flags=re.I).split(",")[0].strip()
        short = short[:1].upper() + short[1:]
        if len(short) > 44:
            short = short[:44].rsplit(" ", 1)[0] + " …"
        return {
            "id": "r_" + uuid.uuid4().hex[:6],
            "name": short or text[:44],
            "type": "when",
            "when": [],
            "and": [],
            "then": [],
            "only": [],
            "enabled": True,
            "options": {"manual_pause": "1h"},
            "meta": {"origin": "text"},
        }

    def prompt(self, cat: dict[str, str] | None = None, compact: bool = False) -> str:
        """The fixed instructions (always the same text, so the model server can keep them cached)."""
        k = kinds()
        lines = []
        for kind, kd in k.items():
            if kind in DOMAIN_KINDS:
                continue
            vs = [f"{v['id']} ({v['flavour'][0]}: {re.sub(r'{\w+}', '…', v['label'])})" for v in kd["verbs"]]
            lines.append(f"- {kd['label']}: " + ", ".join(vs))
        return (
            "Du baust aus einem deutschen Satz eine Hausregel für ein Smart Home als JSON.\n"
            "Eine Regel hat: type ('when' = wenn etwas passiert, 'while' = solange etwas gilt), "
            "when (Auslöser), and (zusätzliche Bedingungen), then (Aktionen der Reihe nach), only (Zeit-, Sonnen- oder Modus-Grenzen), "
            "else (nur bei 'while': Aktionen, sobald es nicht mehr gilt, z. B. 'belegt: an, sonst: aus').\n"
            "Jeder Teil ist {subject, verb} und optional: for ('5m', '1h', '30s'), message, brightness (Prozent), temperature (°C), "
            "value (Grenzwert), time ('19:00'), from/to (Zeitraum), mode (home, away, sleep, vacation, guests), zone.\n"
            "subject wählst du NUR aus der Liste der Dinge in der Anfrage. verb muss zur Art des Dings passen:\n"
            "e = Ereignis (für when bei type 'when'), s = Zustand (für and, only und when bei type 'while'), a = Aktion (für then).\n"
            "Bedeutungen: 'weg sind/verlassen' = leaves bzw. is_away, 'heimkommen' = arrives, 'werktags' = workdays, 'nachts' = night, "
            "'dunkel' = Sonne is_down, 'Glotze/Fernseher' = ein Fernseher, 'hell machen' = Licht an, 'warm' = Heizung set_temp 21.\n"
            "Ein Gerät, dessen Name nach etwas anderem klingt, ist trotzdem seine Art: eine Lampe namens 'Küchentür' ist ein Licht, kein Türsensor.\n"
            "Verben je Art:\n"
            + "\n".join(lines)
            + "\n\nBeispiel: Satz 'Wenn die Glotze läuft, Sofalampe auf 20%' →\n"
            '{"type":"when","when":[{"subject":"Fernseher Wohnzimmer (Lautsprecher/TV, Wohnzimmer)","verb":"turns_on"}],"and":[],'
            '"then":[{"subject":"Sofalampe (Licht, Wohnzimmer)","verb":"dim","brightness":20}],"only":[]}\n'
            "Beispiel: Satz 'Nachts Flurlicht auf 10 %, wenn jemand in den Flur kommt' →\n"
            '{"type":"when","when":[{"subject":"Raum Flur (jemand da / leer / dunkel)","verb":"entered"}],"and":[],'
            '"then":[{"subject":"Flurlicht (Licht)","verb":"dim","brightness":10}],"only":[{"subject":"Uhrzeit","verb":"night"}]}\n'
            '\nAntwortformat: {"type":"when","when":[{"subject":"…","verb":"…"}],"and":[],"then":[…],"only":[]}'
        )

    def schema(self, cat: dict[str, str]) -> dict[str, Any]:
        all_verbs = sorted({v["id"] for kd in kinds().values() for v in kd["verbs"]})
        clause = {
            "type": "object",
            "properties": {
                "subject": {"type": "string", "enum": list(cat.keys())},
                "verb": {"type": "string", "enum": all_verbs},
                "for": {"type": "string"},
                "message": {"type": "string"},
                "brightness": {"type": "integer"},
                "temperature": {"type": "number"},
                "time": {"type": "string"},
                "mode": {"type": "string", "enum": list(vocab_modes())},
                "value": {"type": "number"},
                "from": {"type": "string"},
                "to": {"type": "string"},
                "zone": {"type": "string"},
                "position": {"type": "integer"},
            },
            "required": ["subject", "verb"],
        }
        arr = {"type": "array", "items": clause}
        return {
            "type": "object",
            "properties": {"type": {"type": "string", "enum": ["when", "while"]}, "when": arr, "and": arr, "then": arr, "only": arr, "else": arr},
            "required": ["type", "when", "and", "then", "only"],
        }

    @staticmethod
    def _match_name(name: str, cat: dict[str, str]) -> str | None:
        """The model wrote a name a little differently ("Küchenlicht" for "Küchenlicht (Licht, Küche)"): the closest one."""
        n = _norm(name).strip()
        if not n:
            return None
        if n in cat.values():
            return n  # it gave the subject itself
        for label, subj in cat.items():
            low = _norm(label)
            if low == n or low.split(" (")[0] == n.split(" (")[0]:
                return subj
        hits = [(len(_norm(label)), subj) for label, subj in cat.items() if n.split(" (")[0] in _norm(label)]
        return min(hits)[1] if hits else None

    def repair(self, raw: dict[str, Any], cat: dict[str, str], text: str) -> tuple[dict[str, Any], list[str]]:
        """Maps names back to subjects and fixes verbs that do not fit the thing or the part of the rule."""
        rule = self._new(text)
        rule["type"] = "while" if raw.get("type") == "while" else "when"
        unsure: list[str] = []
        res = self.core.checker.res
        for s in SECTIONS:
            if s == "else" and (rule["type"] != "while" or not raw.get("else")):
                continue
            rule.setdefault(s, [])
            for c in raw.get(s) or []:
                if not isinstance(c, dict):
                    continue
                subject = cat.get(str(c.get("subject"))) or self._match_name(str(c.get("subject") or ""), cat)
                if not subject:
                    unsure.append(tr(self.core, "text.not_found", name=c.get("subject")))
                    continue
                kind = res.kind_of(subject)
                want = flavour_for(s, rule["type"])
                v = find_verb(kind, str(c.get("verb")))
                if not v or v["flavour"] != want:
                    options = verbs(kind, want)
                    if not options:
                        # e.g. a time limit put into "when": move it to "only"
                        if s == "when" and verbs(kind, "state"):
                            options = verbs(kind, "state")
                            s2 = "only"
                        else:
                            unsure.append(tr(self.core, "text.verb_mismatch", name=c.get("subject"), verb=c.get("verb")))
                            continue
                    else:
                        s2 = s
                    v = next((o for o in options if o["id"].startswith(str(c.get("verb"))[:4])), options[0])
                    if s2 != s:
                        rule[s2].append({"subject": subject, "verb": v["id"]})
                        continue
                clause: dict[str, Any] = {"subject": subject, "verb": v["id"]}
                for key in ("for", "message", "brightness", "temperature", "time", "mode", "value", "from", "to", "zone", "position"):
                    if c.get(key) not in (None, "", 0) or (key == "brightness" and c.get(key) == 0):
                        clause[key] = c[key]
                if clause.get("for") and not re.match(r"^\d+(\.\d+)?[smhd]$", str(clause["for"])):
                    clause.pop("for")
                rule[s].append(clause)
        if not rule["when"]:
            unsure.append(tr(self.core, "text.when_missing"))
        if not rule["then"]:
            unsure.append(tr(self.core, "text.then_missing"))
        return rule, unsure

    # ------------------------------------------------------------------ simple parser
    def basic(self, text: str, me: str | None = None) -> tuple[dict[str, Any], list[str]]:
        rule, unsure, _unknown = self.analyse(text, me, self.language(text))
        return rule, unsure

    def analyse(self, text: str, me: str | None = None, lang: str | None = None) -> tuple[dict[str, Any], list[str], list[str]]:
        """The rule-based parser (parse.py, English: parse_en.py): → (rule, unsure notes, words it did not understand)."""
        from .parse import SentenceParser  # noqa: PLC0415
        from .parse_en import EnglishSentenceParser  # noqa: PLC0415

        lang = lang or self.language(text)
        rule = self._new(text)
        parser = EnglishSentenceParser(self.core, me) if lang == "en" else SentenceParser(self.core, me)
        parts, unsure, unknown = parser.parse(text)
        rule.update(parts)
        for c in rule["then"]:
            if c["subject"].startswith("notify:") and not c.get("message"):
                c["message"] = self._message(rule, lang)
        return rule, unsure, unknown


# triggers with a past-tense message for notifications ("Haustür ist aufgegangen.", texts/text.json past.*)
PAST_VERBS = {"opens", "closes", "turns_on", "turns_off", "detected", "occupied", "wet", "arrives", "leaves", "coming_home", "entered", "empty", "done", "unlocked"}


def vocab_modes() -> list[str]:
    from .vocab import vocabulary  # noqa: PLC0415

    return list(vocabulary()["modes"].keys())
