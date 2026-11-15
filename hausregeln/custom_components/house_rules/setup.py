"""Features ("Funktionen") and the setup wizard ("Einrichtung").

Features: one on/off per part of Hausregeln. Off = the backend really stops it (no listeners, no actions,
its entities unavailable) and the panel hides it. Three features keep the flag they always had (one source
of truth, older frontends keep working): alarm = alarm.config.enabled (also switch.alarmanlage_aktiv),
mode_auto = mode_auto.enabled, vacuum = cleaning.on. All others live in data["settings"]["features"].

    core.feature("heating")   → bool   (use this; never read the stored dict directly)
    core.features.add_listener(cb)     cb(features: dict) after every change (e.g. a heating controller)

Setup wizard: its progress lives in data["setup"] = {done, step, answers, migrated?}; the panel opens it
by itself while done is false (fresh install). Composite steps (assign many rooms at once, a first light
rule per room, vacation in every light room) go through apply(); everything else uses the normal commands.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.util import dt as dt_util

from .const import FEATURES, FEATURES_FRESH, FEATURES_NEW

if TYPE_CHECKING:
    from .core import HouseRules

_LOGGER = logging.getLogger(__name__)

STEPS = ("welcome", "people", "rooms", "rules", "features", "alarm", "windows", "light", "heating", "vacation", "vacuum", "ai", "tablet", "glow", "diagnostics", "done")


class Features:
    def __init__(self, core: HouseRules) -> None:
        self.core = core
        self._listeners: list[Callable[[dict[str, bool]], None]] = []

    # ------------------------------------------------------------------ data
    @property
    def _stored(self) -> dict[str, bool]:
        return self.core.data.setdefault("settings", {}).setdefault("features", {})

    def migrate(self, fresh: bool) -> None:
        """First start with this version. Fresh install: the minimal set (the wizard sets the rest).
        Existing install: everything stays as it was (nothing that ran before stops)."""
        s = self.core.data.setdefault("settings", {})
        if "features" in s:
            for k in FEATURES:
                s["features"].setdefault(k, FEATURES_FRESH[k] if fresh or k in FEATURES_NEW else True)
            return
        if fresh:
            s["features"] = {k: v for k, v in FEATURES_FRESH.items() if k not in ("alarm", "mode_auto", "vacuum")}
        else:
            # "behaviours": only read once more by behaviours.migrate (the room behaviours of that time ran)
            s["features"] = {"light": True, "heating": True, "vacation": True, "behaviours": True, "ai": self.core.ai.configured, "window_warning": False}
        setup = self.core.data.setdefault("setup", {})
        setup.setdefault("done", not fresh)
        if not fresh:
            setup.setdefault("migrated", True)

    def get(self, name: str) -> bool:
        if name == "alarm":
            return bool(self.core.alarm.config.get("enabled"))
        if name == "mode_auto":
            return bool(self.core.mode_auto.config.get("enabled", True))
        if name == "vacuum":
            return bool(self.core.cleaning.config.get("on"))
        return bool(self._stored.get(name, False))

    def view(self) -> dict[str, bool]:
        return {k: self.get(k) for k in FEATURES}

    def add_listener(self, cb: Callable[[dict[str, bool]], None]) -> Callable[[], None]:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb) if cb in self._listeners else None

    # ------------------------------------------------------------------ switching
    async def set(self, changes: dict[str, Any]) -> dict[str, bool]:
        core = self.core
        changed: set[str] = set()
        for name, raw in changes.items():
            if name not in FEATURES or not isinstance(raw, bool) or self.get(name) == raw:
                continue
            changed.add(name)
            if name == "alarm":
                patch: dict[str, Any] = {"enabled": raw}
                cfg = core.alarm.config
                if raw and not any(cfg["modes"][m].get("sensors") for m in cfg["modes"]):
                    # first time on: the sensors of the rooms as a start (same as "Einrichten" in the alarm area)
                    sug = core.alarm.suggested_sensors()
                    patch["modes"] = {m: {**cfg["modes"][m], "sensors": sug.get(m, [])} for m in cfg["modes"]}
                core.alarm.save_config(patch)
            elif name == "mode_auto":
                core.mode_auto.save("_enabled", {"enabled": raw})
            elif name == "vacuum":
                patch = {"on": raw}
                if raw and not core.cleaning.config.get("vacuums"):
                    patch["vacuums"] = [s.entity_id for s in core.hass.states.async_all("vacuum") if core.inventory.usable(s.entity_id)][:5]
                core.cleaning.save(patch)
            else:
                self._stored[name] = raw
        if not changed:
            return self.view()
        core.save()
        self.apply(changed)
        return self.view()

    def apply(self, changed: set[str] | None = None) -> None:
        """Start or stop what depends on the features."""
        core = self.core
        changed = changed or set(FEATURES)
        if changed & {"light", "vacation"}:
            core.lightplan.start()  # stops itself when "light" is off
            core.sim.start()  # stops itself when "vacation" or "light" is off
            core.sim.tick()
        if changed & {"light", "heating"}:
            core.engine.start()  # heating-plan rules come and go
            core.push("plans")
        if "window_warning" in changed:
            core.window_warning.start()  # stops itself when off
        if "ai" in changed and self.get("ai"):
            core.hass.async_create_background_task(core.text.warmup(), "house_rules_ai_warmup")
        if "ai" in changed:
            core.push("ai")
        for hook in core.entity_hooks.values():
            hook()
        core.push("features")
        core.push("settings")
        view = self.view()
        for cb in list(self._listeners):
            try:
                cb(view)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("feature listener failed")


# ---------------------------------------------------------------------- setup wizard
class Setup:
    def __init__(self, core: HouseRules) -> None:
        self.core = core

    @property
    def data(self) -> dict[str, Any]:
        d = self.core.data.setdefault("setup", {"done": False})
        d.setdefault("answers", {})
        return d

    def floorplan(self) -> bool:
        """Is the floor plan card (part of roomwise) installed? Its integration serves the card."""
        return "floorplan_card" in self.core.hass.config.components

    def view(self) -> dict[str, Any]:
        d = self.data
        return {"done": bool(d.get("done")), "step": d.get("step") or "welcome", "answers": d.get("answers", {}), "migrated": bool(d.get("migrated")), "floorplan": self.floorplan(), "steps": list(STEPS), "assistants": self.core.assistants.view()}

    def save(self, raw: dict[str, Any]) -> dict[str, Any]:
        d = self.data
        if raw.get("step") in STEPS:
            d["step"] = raw["step"]
        if isinstance(raw.get("answers"), dict):
            for k, v in list(raw["answers"].items())[:40]:
                if isinstance(k, str) and isinstance(v, (str, int, float, bool, type(None), list, dict)):
                    d["answers"][k[:40]] = v
        if isinstance(raw.get("done"), bool):
            d["done"] = raw["done"]
            if raw["done"]:
                d["finished"] = dt_util.utcnow().isoformat()
                d["step"] = "done"
        if raw.get("restart"):
            # from the start: earlier answers (e.g. a dashboard made then) no longer apply
            d["done"] = False
            d["step"] = "welcome"
            d["answers"] = {}
        self.core.save()
        self.core.push("setup")
        return self.view()

    # ------------------------------------------------------------------ suggestions from the real home
    def suggest(self) -> dict[str, Any]:
        core = self.core
        inv = core.inventory
        devs = inv.devices
        hass = core.hass

        def dev(eid: str) -> dict[str, Any]:
            d = devs.get(eid, {})
            return {"entity_id": eid, "name": d.get("name", eid), "kind": d.get("kind"), "room": d.get("room")}

        rooms = []
        for rid, r in core.rooms.items():
            loose = [d for d in devs.values() if d["kind"] in ("presence", "motion") and not d["room"] and d.get("room_guess") == rid]
            rooms.append(
                {
                    "id": rid,
                    "name": r["name"],
                    "icon": r["icon"],
                    "presence": r["presence"],
                    "motion": r["motion"],
                    # sensors of this kind in the room (HA area / device class) + sensors without a room whose name fits
                    "candidates": [dev(e) for e in dict.fromkeys(inv.in_room("presence", rid) + inv.in_room("motion", rid))] + [{**dev(d["entity_id"]), "guess": True} for d in loose],
                    "lights": inv.in_room("light", rid),
                    "climate": inv.in_room("climate", rid),
                    "doors": r["doors"],
                    "door_logic": r["door_logic"],
                }
            )
        sug = core.alarm.suggested_sensors()
        extra = lambda domain: [{"entity_id": s.entity_id, "name": str(s.attributes.get("friendly_name") or s.entity_id)} for s in hass.states.async_all(domain) if inv.usable(s.entity_id)]  # noqa: E731
        sirens = extra("siren") + [{"entity_id": d["entity_id"], "name": d["name"]} for d in devs.values() if d["kind"] in ("switch", "outlet") and "sirene" in d["name"].lower()]
        return {
            "residents": core.residents(),
            "persons": inv.persons_view(),
            "rooms": rooms,
            "alarm": {
                "away": [dev(e) for e in sug.get("away", [])],
                "night": sug.get("night", []),
                "home": sug.get("home", []),
                "sirens": sirens,
                "players": extra("media_player"),
                "cameras": extra("camera"),
            },
            "vacuums": extra("vacuum"),
            "window_warning": {
                "doors": [dev(e) for e in core.window_warning.suggested_doors()],
                "windows": [dev(d["entity_id"]) for d in devs.values() if d["kind"] == "window"],
                "lights": [dev(e) for e in inv.in_room("light", None)],
            },
            "examples": self.examples(),
            "floorplan": self.floorplan(),
            "features": core.features.view(),
        }

    def examples(self) -> list[dict[str, Any]]:
        """2–3 rules from the real devices, to show how rules work and adopt with one tap."""
        core = self.core
        inv = core.inventory
        out: list[dict[str, Any]] = []

        def rule(name: str, why: str, **parts: Any) -> dict[str, Any]:
            r = {
                "id": "r_" + uuid.uuid4().hex[:6],
                "name": name,
                "type": parts.pop("type", "when"),
                "when": parts.pop("when", []),
                "and": parts.pop("and", []),
                "then": parts.pop("then", []),
                "only": parts.pop("only", []),
                "enabled": True,
                "options": {"manual_pause": ""},
                "meta": {"origin": "suggestion"},
            }
            return {"id": f"ex_{len(out)}", "title": name, "why": why, "rule": r, "sentence": core.describer.sentence(r)}

        rooms = list(core.rooms.items())
        # 1) a door and a light in the same room: light on when it opens in the dark
        for rid, r in rooms:
            doors, lights = inv.in_room("door", rid), inv.in_room("light", rid)
            if doors and lights:
                out.append(
                    rule(
                        f"Licht an, wenn {inv.devices[doors[0]]['name']} aufgeht",
                        "Ein Auslöser (Wenn), eine Bedingung (Und) und eine Aktion (Dann) mit „für 5 Min.“: danach geht es von selbst wieder aus.",
                        when=[{"subject": doors[0], "verb": "opens"}],
                        **{"and": [{"subject": "sun", "verb": "is_down"}]},
                        then=[{"subject": lights[0], "verb": "turn_on", "for": "5m"}],
                    )
                )
                break
        # 2) a window and a heating in one room: while open, heating off (and back afterwards)
        if any(inv.in_room("window", rid) and inv.in_room("climate", rid) for rid, _r in rooms):
            out.append(
                rule(
                    "Heizung aus, solange ein Fenster offen ist",
                    "Eine Solange-Regel: gilt, solange es stimmt, und stellt danach alles zurück. „im selben Raum“ gilt für jeden Raum.",
                    type="while",
                    when=[{"subject": "any:window", "verb": "is_open", "for": "1m"}],
                    then=[{"subject": "all:climate@same", "verb": "turn_off"}],
                )
            )
        # 3) any door while nobody is home: a message
        if inv.in_room("door", None) and inv.persons:
            out.append(
                rule(
                    "Nachricht, wenn eine Tür aufgeht und niemand da ist",
                    "Platzhalter: „irgendeine Tür“ umfasst auch Türen, die du später einbaust.",
                    when=[{"subject": "any:door", "verb": "opens"}],
                    **{"and": [{"subject": "person:everyone", "verb": "is_away"}]},
                    then=[{"subject": "notify:everyone", "verb": "send", "message": "Eine Tür ist aufgegangen, obwohl niemand zuhause ist."}],
                )
            )
        # fallback: a light at sunset
        lights = inv.in_room("light", None)
        if len(out) < 3 and lights:
            out.append(
                rule(
                    f"{inv.devices[lights[0]]['name']} bei Sonnenuntergang an",
                    "Ein Zeitpunkt als Auslöser: jeden Tag, wenn die Sonne untergeht.",
                    when=[{"subject": "sun", "verb": "sets"}],
                    then=[{"subject": lights[0], "verb": "turn_on"}],
                )
            )
        return out[:3]

    # ------------------------------------------------------------------ composite steps
    async def apply(self, step: str, raw: dict[str, Any]) -> dict[str, Any]:
        core = self.core
        if step == "rooms":
            # [{id, presence: [...], motion: [...]}]: sensors without a room get the room (kept in Hausregeln only)
            moves = []
            known = core.inventory.devices
            stored = core.data.setdefault("rooms", {})
            for r in raw.get("rooms") or []:
                if not isinstance(r, dict) or r.get("id") not in core.rooms:
                    continue
                cfg = stored.setdefault(r["id"], {})
                for key in ("presence", "motion"):
                    if isinstance(r.get(key), list):
                        ents = [e for e in r[key] if isinstance(e, str) and e in known][:40]
                        cfg[key] = ents
                        moves += [{"entity_id": e, "room": r["id"]} for e in ents if not known[e]["room"]]
            if moves:
                await core.set_devices(moves)  # rebuilds rooms too
            else:
                core.save()
                core._restart_rooms()  # noqa: SLF001
            return {"ok": True, "rooms": len(raw.get("rooms") or [])}
        if step == "light":
            # a first light rule for each chosen room: on while someone is there and it is dark, off when empty
            done = []
            for rid in raw.get("rooms") or []:
                if rid not in core.rooms or not core.inventory.in_room("light", rid):
                    continue
                plan = core.lightplan.plan(rid)
                rules = plan["rules"] or [
                    {
                        "name": "Licht, wenn jemand da ist",
                        "kind": "while",
                        "when": [{"subject": f"room:{rid}", "verb": "is_occupied"}, {"subject": f"room:{rid}", "verb": "is_dark"}],
                        "action": {"mode": "on", "brightness": 80, "color": "warm"},
                        "after": "off",
                    }
                ]
                core.lightplan.save(rid, {"on": True, "rules": rules})
                done.append(rid)
            core.engine.start()
            core.push("plans")
            return {"ok": True, "rooms": done}
        if step == "vacation":
            # look lived-in in every room with light rules
            done = []
            for rid in core.rooms:
                if core.plans.plan_on("light", rid):
                    v = core.lightplan.plan(rid)["vacation"]
                    core.lightplan.save(rid, {"vacation": {**v, "on": True}})
                    done.append(rid)
            core.sim.save_config({"smart": True})
            core.push("plans")
            return {"ok": True, "rooms": done}
        if step == "modes":
            # house mode basics: {away, sleep, vacation} on/off with the default conditions
            for m in ("away", "sleep", "vacation"):
                if isinstance(raw.get(m), bool):
                    core.mode_auto.save(m, {"on": raw[m]})
            core.push("mode_auto")
            return {"ok": True}
        raise ValueError("Unbekannter Schritt")
