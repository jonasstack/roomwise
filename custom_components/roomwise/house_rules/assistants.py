"""Feature assistants: a short assistant per feature (Licht, Alarmanlage, Fenster-Warnung, Urlaub, Saugroboter-Pause,
Hausmodus automatisch). The heating has an assistant of its own (heating part).

Per feature a "set up" flag in data["setup"]["assistants"][feature] = {done, at, dismissed}. The panel opens an
assistant by itself the first time the feature's area is opened while the feature is on, not set up, not put off
("später") and nothing is configured yet (`configured`: an existing setup counts, e.g. rooms with light rules).

    suggest(feature) → what the assistant proposes from the real home (detected devices, current values)
    apply(feature, answers) → sets everything up in one go through the normal parts, marks it done
    mark(feature, done=…, dismissed=…) → only the flag ("Überspringen", "später")

See docs/API.md (house_rules/assistant/*).
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from .const import ASSISTANTS
from .lightlearn import default_slots, kelvin_of

if TYPE_CHECKING:
    from .core import HouseRules

AUTO_MARK = "as_"  # light rules made by the assistant (replaced when it runs again; own rules stay)


class Assistants:
    def __init__(self, core: HouseRules) -> None:
        self.core = core

    @property
    def data(self) -> dict[str, dict[str, Any]]:
        return self.core.data.setdefault("setup", {"done": False}).setdefault("assistants", {})

    # ------------------------------------------------------------------ flags
    def configured(self, name: str) -> bool:
        """Is something set up already (also without the assistant)? Then it does not open by itself."""
        core = self.core
        if name == "light":
            return any(p.get("on") and (p.get("rules") or (p.get("smart") or {}).get("mode", "off") != "off") for p in core.lightplan.store.values())
        if name == "alarm":
            return any(m.get("sensors") for m in core.alarm.config["modes"].values())
        if name == "window_warning":
            cfg = core.window_warning.config
            return bool(cfg.get("doors") or cfg.get("imported"))
        if name == "vacation":
            return any((p.get("vacation") or {}).get("on") for p in core.lightplan.store.values())
        if name == "vacuum":
            return bool(core.cleaning.config.get("vacuums"))
        if name == "mode_auto":
            setup = core.data.get("setup") or {}
            return bool(setup.get("migrated") or "modes" in (setup.get("answers") or {}))
        return False

    def view(self) -> dict[str, dict[str, Any]]:
        out = {}
        for name in ASSISTANTS:
            d = self.data.get(name) or {}
            out[name] = {"done": bool(d.get("done")), "dismissed": bool(d.get("dismissed")), "configured": self.configured(name), "at": d.get("at")}
        return out

    def mark(self, name: str, done: bool | None = None, dismissed: bool | None = None) -> dict[str, dict[str, Any]]:
        if name not in ASSISTANTS:
            raise ValueError("Unbekannte Funktion")
        d = self.data.setdefault(name, {})
        if done is not None:
            d["done"] = done
            d["at"] = dt_util.utcnow().isoformat() if done else None
        if dismissed is not None:
            d["dismissed"] = dismissed
        self.core.save()
        self.core.push("setup")
        return self.view()

    # ------------------------------------------------------------------ suggestions from the real home
    def _dev(self, eid: str) -> dict[str, Any]:
        d = self.core.inventory.devices.get(eid) or {}
        st = self.core.hass.states.get(eid)
        name = d.get("name") or (str(st.attributes.get("friendly_name")) if st else eid)
        return {"entity_id": eid, "name": name, "kind": d.get("kind"), "room": d.get("room")}

    def _states(self, domain: str) -> list[dict[str, Any]]:
        return [{"entity_id": s.entity_id, "name": str(s.attributes.get("friendly_name") or s.entity_id)} for s in self.core.hass.states.async_all(domain)]

    def suggest(self, name: str) -> dict[str, Any]:
        core = self.core
        inv = core.inventory
        if name not in ASSISTANTS:
            raise ValueError("Unbekannte Funktion")
        out: dict[str, Any] = {"feature": name, "on": core.feature(name), "state": self.view()[name], "persons": inv.persons_view()}
        if name == "light":
            rooms = []
            for rid, r in core.rooms.items():
                lights = inv.in_room("light", rid)
                if not lights:
                    continue
                p = core.lightplan.plan(rid)
                lt = []
                for e in lights:
                    st = core.hass.states.get(e)
                    modes = (st.attributes.get("supported_color_modes") or []) if st else []
                    lt.append({**self._dev(e), "white": "color_temp" in modes, "color": any(m in modes for m in ("hs", "rgb", "rgbw", "rgbww", "xy"))})
                rooms.append(
                    {
                        "id": rid,
                        "name": r["name"],
                        "in": r.get("in"),
                        "lights": lt,
                        "presence": [self._dev(e) for e in [*r["presence"], *r["motion"], *r.get("zones", [])]],
                        "door_logic": bool(r.get("door_logic")),
                        "lux": self._dev(r["lux"]) if r.get("lux") else None,
                        "media": [self._dev(e) for e in inv.in_room("media", rid)],
                        "plan_on": p["on"],
                        "rules": len([x for x in p["rules"] if not str(x["id"]).startswith(AUTO_MARK)]),
                        "smart": p["smart"]["mode"],
                    }
                )
            a, b = core.checker.window("night")
            out.update({"rooms": rooms, "night": [a, b], "slots": default_slots(), "learned": {rid: core.lightlearn.samples(rid) for rid in core.rooms}})
        elif name == "alarm":
            sug = core.alarm.suggested_sensors()
            cfg = core.alarm.config
            sirens = self._states("siren") + [{"entity_id": d["entity_id"], "name": d["name"]} for d in inv.devices.values() if d["kind"] in ("switch", "outlet") and "sirene" in d["name"].lower()]
            out.update(
                {
                    "sensors": [self._dev(e) for e in sug.get("away", [])],
                    "night": sug.get("night", []),
                    "home": sug.get("home", []),
                    "sirens": sirens,
                    "players": self._states("media_player"),
                    "cameras": self._states("camera"),
                    "current": {
                        "modes": {m: cfg["modes"][m]["sensors"] for m in cfg["modes"]},
                        "entry_delay": cfg["modes"]["away"]["entry_delay"],
                        "exit_delay": cfg["modes"]["away"]["exit_delay"],
                        "has_code": bool(cfg.get("code_hash")),
                        "notify_disarm": bool(cfg.get("notify_disarm", True)),
                        "persons": cfg["notify"]["persons"],
                        "sirens": cfg["sirens"],
                    },
                }
            )
        elif name == "window_warning":
            ww = core.window_warning
            doors = [self._dev(d["entity_id"]) for d in inv.devices.values() if d["kind"] == "door"]
            out.update(
                {
                    "doors": doors,
                    "suggested": ww.suggested_doors(),
                    "windows": [self._dev(e) for e in ww.windows()],
                    "players": self._states("media_player"),
                    "current": {k: ww.config[k] for k in ("doors", "only_last", "delay", "timeout", "lights", "announce", "notify")},
                }
            )
        elif name == "vacation":
            sim = core.sim
            rooms = []
            for rid, r in core.rooms.items():
                if not inv.in_room("light", rid):
                    continue
                p = core.lightplan.plan(rid)
                rooms.append({"id": rid, "name": r["name"], "lights": len(inv.in_room("light", rid)), "plan_on": p["on"], "vacation": p["vacation"]["on"]})
            model = sim.data.get("model") or {}
            out.update({"rooms": rooms, "config": sim.config, "days": model.get("days", 0), "residents": len([p for p in core.residents() if p["counts"]]), "light_on": core.feature("light")})
        elif name == "vacuum":
            cfg = core.cleaning.config
            vacs = self._states("vacuum")
            out.update(
                {
                    "vacuums": vacs,
                    "sensors": [self._dev(d["entity_id"]) for d in inv.devices.values() if d["kind"] in ("motion", "presence", "zone")],
                    "current": {"vacuums": cfg["vacuums"] or [v["entity_id"] for v in vacs][:5], "sensors": cfg["sensors"], "after": cfg["after"]},
                }
            )
        elif name == "mode_auto":
            cfg = core.mode_auto.config
            a, b = core.checker.window("night")
            wake = core.wakeup.view()
            out.update(
                {
                    "current": {m: {"on": v["on"], "for": v.get("for", "")} for m, v in cfg["modes"].items()},
                    "night": [a, b],
                    "residents": [p for p in core.residents() if p["counts"]],
                    # "Aufstehen erkennen": suggested on as soon as there is a bed sensor
                    "wakeup": {"on": wake["on"], "beds": [x["name"] for x in wake["found_beds"]]},
                }
            )
        return out

    # ------------------------------------------------------------------ apply
    async def apply(self, name: str, raw: dict[str, Any]) -> dict[str, Any]:
        if name not in ASSISTANTS:
            raise ValueError("Unbekannte Funktion")
        fn = getattr(self, f"_apply_{name}")
        result = await fn(raw if isinstance(raw, dict) else {})
        self.mark(name, done=True, dismissed=False)
        return {"ok": True, **(result or {})}

    async def _apply_light(self, raw: dict[str, Any]) -> dict[str, Any]:
        core = self.core
        smart = raw.get("mode") != "rules"
        slots = raw.get("slots") if isinstance(raw.get("slots"), list) else default_slots()
        guards = raw.get("guards") if isinstance(raw.get("guards"), dict) else {}
        empty = raw.get("empty") if isinstance(raw.get("empty"), dict) else {}
        tv_off = bool(raw.get("tv_off"))
        done = []
        await core.features.set({"light": True})
        for rid in raw.get("rooms") or []:
            if rid not in core.rooms or not core.inventory.in_room("light", rid):
                continue
            p = core.lightplan.plan(rid)
            tv = [{"subject": e, "verb": "is_on"} for e in core.inventory.in_room("media", rid)][:1]
            off_while = [*(guards.get("off_while") or []), *(tv if tv_off else [])]
            g = {"max": guards.get("max", 100), "night_max": guards.get("night_max", 30), "night_warm": guards.get("night_warm", True), "off_while": off_while}
            own = [x for x in p["rules"] if not str(x["id"]).startswith(AUTO_MARK)]
            patch: dict[str, Any] = {"on": True, "manual": raw.get("manual") if raw.get("manual") in ("room_empty", "30m", "none") else p["manual"]}
            if empty:
                patch["empty"] = {**p["empty"], **{k: v for k, v in empty.items() if k in ("mode", "delay", "dim", "dim_for")}}
            if smart:
                patch["smart"] = {"mode": "on" if raw.get("active") else "shadow", "only_dark": bool(raw.get("only_dark", True)), "slots": slots, "guards": g}
                patch["rules"] = own
            else:
                patch["smart"] = {"mode": "off", "slots": slots, "guards": g}
                patch["rules"] = self._light_rules(rid, slots, g, bool(raw.get("only_dark", True))) + own
            core.lightplan.save(rid, patch)
            done.append(rid)
        core.engine.start()
        core.push("plans")
        return {"rooms": done}

    def _light_rules(self, rid: str, slots: list[dict[str, Any]], g: dict[str, Any], only_dark: bool) -> list[dict[str, Any]]:
        """"Eigene Regeln": the answers as light rules of the room (one "Solange" rule with a variant per time of
        day, guardrails already applied, plus "nie an, solange …" for the conditions that keep the light off)."""
        core = self.core
        a, b = core.checker.window("night")

        def at_night(m: int) -> bool:
            return a * 60 <= m < b * 60 if a <= b else (m >= a * 60 or m < b * 60)

        ordered = sorted(slots, key=lambda s: str(s.get("from") or "00:00"))

        def look(s: dict[str, Any]) -> dict[str, Any]:
            m = int(str(s.get("from") or "00:00")[:2]) * 60 + int(str(s.get("from") or "00:00")[3:5])
            bri = min(int(s.get("brightness") or 80), int(g.get("max") or 100))
            color = str(s.get("color") or "warm")
            if at_night(m):
                bri = min(bri, int(g.get("night_max") or 100))
                if g.get("night_warm") and (kelvin_of(color) or 0) > 2700:
                    color = "warm"
            return {"mode": "on", "brightness": max(1, bri), "color": color}

        when = [{"subject": f"room:{rid}", "verb": "is_occupied"}]
        if only_dark:
            when.append({"subject": f"room:{rid}", "verb": "is_dark"})
        variants = []
        for i, s in enumerate(ordered):
            nxt = ordered[(i + 1) % len(ordered)]
            variants.append({"id": uuid.uuid4().hex[:6], "when": [{"subject": "time", "verb": "between", "from": s["from"], "to": nxt["from"]}], **look(s)})
        rules = [
            {
                "id": f"{AUTO_MARK}{uuid.uuid4().hex[:6]}",
                "name": "Licht, wenn jemand da ist",
                "kind": "while",
                "when": when,
                "lights": [],
                "action": look(ordered[0]) if ordered else {"mode": "on", "brightness": 80, "color": "warm"},
                "variants": variants,
                "after": "others",
                "follow_empty": True,
            }
        ]
        if g.get("off_while"):
            rules.append({"id": f"{AUTO_MARK}{uuid.uuid4().hex[:6]}", "name": "Bleibt aus", "kind": "never_on", "when": g["off_while"][:1], "lights": [], "action": {"mode": "on", "brightness": 50, "color": "warm"}})
        return rules

    async def _apply_alarm(self, raw: dict[str, Any]) -> dict[str, Any]:
        core = self.core
        cfg = core.alarm.config
        known = set(core.inventory.devices)
        sensors = [e for e in raw.get("sensors") or [] if e in known]
        sug = core.alarm.suggested_sensors()
        chosen = set(sensors)
        lights = core.inventory.in_room("light", None)

        def mode(m: str, ents: list[str]) -> dict[str, Any]:
            src = cfg["modes"][m]
            out: dict[str, Any] = {"sensors": ents, "entry_delay": int(raw.get("entry_delay", src["entry_delay"])), "exit_delay": int(raw.get("exit_delay", src["exit_delay"])) if m == "away" else 0}
            if isinstance(raw.get("flash"), bool):
                out["lights"] = {"mode": "flash" if raw["flash"] else "none", "entities": lights if raw["flash"] else []}
            if m == "away":
                out["auto"] = {"arm_away": bool(raw.get("arm_away")), "away_for": 5, "disarm_home": bool(raw.get("disarm_home"))}
            return out

        patch: dict[str, Any] = {
            "enabled": True,
            "modes": {
                "away": mode("away", sensors),
                "night": mode("night", [e for e in (raw.get("night") if isinstance(raw.get("night"), list) else sug.get("night", [])) if e in chosen]),
                "home": mode("home", [e for e in (raw.get("home") if isinstance(raw.get("home"), list) else sug.get("home", [])) if e in chosen]),
            },
        }
        persons = raw.get("persons")
        if persons == "everyone" or isinstance(persons, list):
            patch["notify"] = {"persons": persons}
        if isinstance(raw.get("sirens"), list):
            patch["sirens"] = raw["sirens"]
        if isinstance(raw.get("notify_disarm"), bool):
            patch["notify_disarm"] = raw["notify_disarm"]
            patch["buttons"] = ["disarm", "silence", "camera"] if raw["notify_disarm"] else ["silence", "camera"]
        code = raw.get("code")
        if isinstance(code, str) and code.strip():
            from .alarm import _new_hash  # noqa: PLC0415

            patch["_hash"] = await core.hass.async_add_executor_job(_new_hash, code.strip())  # slow hash off the event loop
            patch["confirm"] = "pin"
        if not cfg["enabled"]:
            await core.features.set({"alarm": True})
        core.alarm.save_config(patch)
        core.push("alarm")
        return {"sensors": len(sensors)}

    async def _apply_window_warning(self, raw: dict[str, Any]) -> dict[str, Any]:
        core = self.core
        await core.features.set({"window_warning": True})
        doors = [e for e in raw.get("doors") or [] if isinstance(e, str)]
        rooms = {core.inventory.room_of(d) for d in doors} - {None}
        lights = [e for r in rooms for e in core.inventory.in_room("light", r)]
        cur = core.window_warning.config
        patch: dict[str, Any] = {"doors": doors, "windows": "all"}
        if isinstance(raw.get("only_last"), bool):
            patch["only_last"] = raw["only_last"]
        if isinstance(raw.get("lights"), bool):
            patch["lights"] = {"mode": "red" if raw["lights"] and lights else "none", "entities": lights}
        if isinstance(raw.get("announce"), bool):
            patch["announce"] = {**cur["announce"], "mode": "all" if raw["announce"] else "none"}
        if isinstance(raw.get("notify"), bool):
            patch["notify"] = {"on": raw["notify"], "persons": "everyone"}
        if isinstance(raw.get("timeout"), (int, float)):
            patch["timeout"] = raw["timeout"]
        core.window_warning.save(patch)
        core.push("window_warning")
        return {"doors": len(doors)}

    async def _apply_vacation(self, raw: dict[str, Any]) -> dict[str, Any]:
        core = self.core
        await core.features.set({"vacation": True, "light": True})
        done = []
        for rid in raw.get("rooms") or []:
            if rid not in core.rooms:
                continue
            p = core.lightplan.plan(rid)
            patch: dict[str, Any] = {"vacation": {**p["vacation"], "on": True}}
            if isinstance(raw.get("brightness"), (int, float)):
                patch["vacation"]["brightness"] = raw["brightness"]
            if isinstance(raw.get("end"), str) and len(raw["end"]) == 5:
                patch["vacation"]["end"] = raw["end"]  # fixed times (not learned): from sunset until about …
            if not p["on"]:
                # the plan was off: switched on only for the vacation, everyday life stays as it was
                patch["on"] = True
                if not p["rules"]:
                    patch["empty"] = {**p["empty"], "mode": "keep"}
                    patch["manual"] = "none"
            core.lightplan.save(rid, patch)
            done.append(rid)
        sim: dict[str, Any] = {"smart": bool(raw.get("smart", True))}
        for k in ("morning", "night"):
            if isinstance(raw.get(k), bool):
                sim[k] = raw[k]
        if isinstance(raw.get("people"), int):
            sim["people"] = raw["people"]
        if isinstance(raw.get("never"), dict):
            n = raw["never"]
            sim["dark"] = {"never": bool(n.get("on")), "never_from": n.get("from", "09:00"), "never_to": n.get("to", "16:00")}
        core.sim.save_config(sim)
        core.push("plans")
        return {"rooms": done}

    async def _apply_vacuum(self, raw: dict[str, Any]) -> dict[str, Any]:
        core = self.core
        patch: dict[str, Any] = {"on": True}
        for k in ("vacuums", "sensors", "after"):
            if k in raw:
                patch[k] = raw[k]
        core.cleaning.save(patch)
        core.features.apply({"vacuum"})
        return {"vacuums": len(core.cleaning.config["vacuums"])}

    async def _apply_mode_auto(self, raw: dict[str, Any]) -> dict[str, Any]:
        core = self.core
        core.mode_auto.save("_enabled", {"enabled": True})
        for m in ("away", "sleep", "vacation", "guests"):
            v = raw.get(m)
            if isinstance(v, bool):
                core.mode_auto.save(m, {"on": v})
            elif isinstance(v, dict):
                core.mode_auto.save(m, {k: x for k, x in v.items() if k in ("on", "for", "when")})
        if isinstance(raw.get("wakeup"), bool):
            core.wakeup.save({"on": raw["wakeup"]})
        core.features.apply({"mode_auto"})
        core.push("mode_auto")
        return {}
