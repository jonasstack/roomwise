"""Offline test bench for text → rule: a stand-in for the integration built from a snapshot (rooms, devices, persons),
so the parser and the model can be tried against a real inventory without Home Assistant.

    python3 -I tools/texteval/harness.py SNAPSHOT.json CASES.json [--ai URL MODEL] [--only N] [--strict]

English: python3 -I tools/texteval/harness.py tools/texteval/house-en.json tools/texteval/cases-en.json --strict
(a neutral example house; the language of each sentence is detected, --strict exits with 1 if a case fails)
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import re
import sys
import time
import types
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3] / "custom_components" / "roomwise" / "house_rules"
STATE_HOME = "home"


def load_package(ai_url: str | None, ai_model: str | None):
    pkg = types.ModuleType("house_rules")
    pkg.__path__ = [str(ROOT)]
    sys.modules["house_rules"] = pkg

    def load(name: str):
        spec = importlib.util.spec_from_file_location(f"house_rules.{name}", ROOT / f"{name}.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f"house_rules.{name}"] = mod
        spec.loader.exec_module(mod)
        return mod

    vocab = load("vocab")
    # the model call without aiohttp / Home Assistant
    ai = types.ModuleType("house_rules.ai")

    class AiError(Exception):
        pass

    async def complete(core, system, user, schema=None, timeout=90):
        body = {
            "model": ai_model,
            "stream": False,
            "keep_alive": "30m",
            "options": {"temperature": 0, "num_predict": 600, "num_ctx": 8192},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "format": schema or "json",
        }
        req = urllib.request.Request(f"{ai_url}/api/chat", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})

        def go():
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())

        data = await asyncio.get_running_loop().run_in_executor(None, go)
        txt = data["message"]["content"]
        core.last_raw = txt
        m = re.search(r"\{.*\}", txt, re.S)
        return json.loads(m.group(0)) if m else {}

    ai.AiError = AiError
    ai.complete = complete
    sys.modules["house_rules.ai"] = ai
    llm = load("llm")
    return vocab, llm


class Inventory:
    def __init__(self, snap):
        self.devices = {d["entity_id"]: d for d in snap["devices"]}
        self.persons = {p["id"]: p for p in snap["persons"]}

    def in_room(self, kind, room):
        return [d["entity_id"] for d in self.devices.values() if d["kind"] == kind and (room is None or d["room"] == room)]

    def room_of(self, eid):
        d = self.devices.get(eid)
        return d["room"] if d else None

    def person_home(self, pid):
        return bool(self.persons.get(pid, {}).get("home"))

    def person_where(self, pid):
        return self.persons.get(pid, {}).get("where", "unbekannt")


PLACEHOLDER = re.compile(r"^(any|all):([a-z_]+)(?:@([a-z0-9_*]+))?$")


class Res:
    def __init__(self, core):
        self.core = core

    def kind_of(self, subject):
        m = PLACEHOLDER.match(subject)
        if m:
            return m.group(2)
        for prefix, kind in (("room:", "room"), ("zone:", "zone"), ("person:", "person"), ("notify:", "notify"), ("rule:", "rule")):
            if subject.startswith(prefix):
                return kind
        if subject in ("time", "sun", "mode", "wait", "alarm"):
            return subject
        dev = self.core.inventory.devices.get(subject)
        return dev["kind"] if dev else subject.split(".")[0]

    def entities(self, subject, room=None, scope=None):
        return [subject] if "." in subject else []


class Core:
    def __init__(self, snap, vocab, ai_on):
        self.inventory = Inventory(snap)
        self.rooms = {r["id"]: r for r in snap["rooms"]}
        self.groups = snap.get("groups", [])
        self.mode = "home"
        self.checker = types.SimpleNamespace(res=Res(self))
        self.describer = vocab.Describer(self)
        self.ai = types.SimpleNamespace(connected=ai_on, config={"provider": "ollama", "model": "?"})
        self.last_raw = ""
        self.hass = types.SimpleNamespace(states=types.SimpleNamespace(get=lambda e: None))
        self._zones = snap.get("zones", [])

    def zones(self):
        return self._zones

    def group(self, gid):
        return next((g for g in self.groups if g["id"] == gid), None)

    def rule(self, rid):
        return None

    def rules(self):
        return []

    def mode_label(self, m):
        return m


# ---------------------------------------------------------------------------------------------- checks
def match(c, spec):
    """spec: {"subject": "regex", "verb": "id|id2", "...": value}"""
    for k, want in spec.items():
        have = c.get(k)
        if k in ("subject", "verb"):
            if not re.fullmatch(want, str(have or "")):
                return False
        elif isinstance(want, (int, float)) and not isinstance(want, bool):
            try:
                if abs(float(have) - want) > 0.01:
                    return False
            except (TypeError, ValueError):
                return False
        elif str(have) != str(want):
            return False
    return True


def check(rule, exp):
    """exp: {"type": "when", "when": [spec…], "and": [...], "then": [...], "only": [...]} — every spec must be found; with
    "exact": true no extra clauses are allowed in the listed sections."""
    problems = []
    if "type" in exp and rule.get("type") != exp["type"]:
        problems.append(f"type {rule.get('type')} statt {exp['type']}")
    for sec in ("when", "and", "then", "only", "else", "cond"):
        if sec == "cond":
            # a condition may sit in "and" or in "only"
            if "cond" not in exp and "and" in exp and "only" in exp:
                continue
            have = [] if ("and" in exp or "only" in exp) else list(rule.get("and") or []) + list(rule.get("only") or [])
        elif sec in ("and", "only") and sec not in exp:
            continue
        elif sec not in exp:
            continue
        else:
            have = list(rule.get(sec) or [])
        for spec in exp.get(sec, []):
            hit = next((c for c in have if match(c, spec)), None)
            if hit is None:
                problems.append(f"{sec}: fehlt {spec}")
            else:
                have.remove(hit)
        if exp.get("exact", True) and have:
            problems.append(f"{sec}: zu viel {[(c['subject'], c['verb']) for c in have]}")
    return problems


def short(rule):
    out = []
    for sec in ("when", "and", "then", "only", "else"):
        for c in rule.get(sec) or []:
            extra = {k: v for k, v in c.items() if k not in ("subject", "verb")}
            out.append(f"{sec}:{c['subject']}/{c['verb']}{json.dumps(extra, ensure_ascii=False) if extra else ''}")
    return f"[{rule.get('type')}] " + "  ".join(out)


async def main():
    args = sys.argv[1:]
    snap = json.load(open(args[0]))
    cases = json.load(open(args[1]))
    ai = None
    if "--ai" in args:
        i = args.index("--ai")
        ai = (args[i + 1], args[i + 2])
    only = None
    if "--only" in args:
        only = {int(x) for x in args[args.index("--only") + 1].split(",")}
    vocab, llm = load_package(*(ai or (None, None)))
    core = Core(snap, vocab, bool(ai))
    t2r = llm.TextToRule(core)
    mode = "ai" if ai else "basic"
    good = 0
    total = 0
    report = []
    for n, case in enumerate(cases, 1):
        if only and n not in only:
            continue
        total += 1
        text, exp = case["text"], case["expect"]
        t0 = time.time()
        d = await t2r.draft(text, case.get("me"))
        rule, unsure = d["rule"], d["unsure"]
        note = ""
        if ai and ("--ai-always" in args or not d.get("sure")):
            res = await t2r.improve(text, rule, case.get("me")) if hasattr(t2r, "improve") else {}
            if res.get("rule"):
                rule = res["rule"]
                unsure = res.get("unsure", [])
            note = res.get("note", "")
        problems = check(rule, exp)
        ok = not problems
        good += ok
        line = f"{'OK ' if ok else 'XX '}{n:2d} {text}  ({time.time() - t0:.1f}s)"
        print(line)
        if not ok:
            print("      ist:", short(rule))
            print("      satz:", core.describer.sentence(rule))
            for p in problems:
                print("      -", p)
            if unsure:
                print("      unsicher:", unsure)
            if note:
                print("      note:", note)
        report.append({"n": n, "text": text, "ok": ok, "rule": rule, "problems": problems})
    print(f"\n{mode}: {good}/{total} richtig")
    Path(ROOT.parents[1], ".cache").mkdir(exist_ok=True)
    json.dump(report, open(Path(ROOT.parents[1], ".cache", f"texteval-{mode}.json"), "w"), ensure_ascii=False, indent=1)
    if "--strict" in args and good < total:
        sys.exit(1)


asyncio.run(main())
