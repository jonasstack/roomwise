"""Backup and restore (Einstellungen → Sichern und wiederherstellen).

A backup is one versioned JSON file with everything the user set up: rules, groups, rooms, device overrides,
behaviours, light and heating plans, the alarm (without PIN hash, passkeys and channel passwords/keys), the
window warning, features, settings, the automatic house mode, the vacuum pause, the vacation simulation's
settings and the setup state. Never in it: the AI connection (keys), history, the learned daily routine and
runtime state.

Restoring goes through the same checks as the panel: every section is handed to the code that saves it from
the panel (core.sanitize, alarm.save_config, lightplan.save, heating.save_room …), so a backup can never put
anything into the store the panel could not. Before restoring, a preview says what changes and which devices
of the backup do not exist here; each of them can be replaced by a device of this home (remap).
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any

from homeassistant.const import Platform
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util

from . import alarm_channels as channels
from .const import FEATURES, VERSION
from .lightcal import clean as clean_cal
from .versions import MAX_TRASH

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from .core import HouseRules

FORMAT = "house_rules_backup"
BACKUP_VERSION = 1
MAX_BYTES = 2_000_000  # a big home has a few hundred kB; anything far above that is not a backup of ours
MODES = ("merge", "replace")

# order = order of the preview and of restoring (rooms before their plans, features before what they switch)
SECTIONS: dict[str, str] = {
    "rules": "Regeln",
    "groups": "Gruppen",
    "rooms": "Räume",
    "devices": "Geräte-Zuordnung",
    "behaviours": "Raumverhalten",
    "features": "Funktionen",
    "settings": "Wörter und Werte",
    "light": "Lichtpläne",
    "heating": "Heizung",
    "alarm": "Alarmanlage",
    "object_alarms": "Weitere Alarme",
    "window_warning": "Fenster-Warnung",
    "mode_auto": "Automatischer Hausmodus",
    "cleaning": "Saugpause",
    "vacation": "Urlaub",
    "setup": "Einrichtung",
}
# kept by their own sections (alarm.enabled, mode_auto.enabled, cleaning.on)
OWN_FLAG = ("alarm", "mode_auto", "vacuum")
SETTINGS_KEYS = ("eco_temp", "times", "persons_excluded", "phones_excluded", "ui")

# entity ids in stored data; "zone:zone.work" is how rules name a place
ENTITY_RE = re.compile(r"^(zone:)?([a-z][a-z0-9_]*)\.([a-z0-9_]+)$")
EXTRA_DOMAINS = {
    "person",
    "zone",
    "sun",
    "group",
    "automation",
    "script",
    "scene",
    "timer",
    "counter",
    "schedule",
    "input_boolean",
    "input_number",
    "input_select",
    "input_text",
    "input_datetime",
    "input_button",
}


def entity_domains() -> set[str]:
    return {p.value for p in Platform} | EXTRA_DOMAINS


def _copy(o: Any) -> Any:
    return json.loads(json.dumps(o))


# ---------------------------------------------------------------------------------------------- export
def sections_of(core: HouseRules) -> dict[str, Any]:
    """The live data in backup form (also used by the repairs check, issues.py)."""
    d = core.data
    alarm = _copy(core.alarm.config)
    for k in ("code_hash", "devices"):
        alarm.pop(k, None)
    ch = alarm.get("channels") or {}
    if isinstance(ch.get("email"), dict):
        ch["email"]["password"] = ""
    if isinstance(ch.get("signal"), dict):
        ch["signal"]["numbers"] = [{"phone": n.get("phone", ""), "apikey": ""} for n in ch["signal"].get("numbers", []) if isinstance(n, dict)]
    rules = []
    for r in d.get("rules", []):
        r = _copy(r)
        meta = r.get("meta") or {}
        meta.pop("last_run", None)
        rules.append(r)
    features = core.features.view()
    setup = d.get("setup") or {}
    return {
        "rules": rules,
        "groups": _copy(d.get("groups", [])),
        "rooms": _copy(d.get("rooms", {})),
        "devices": _copy(d.get("devices", {})),
        "behaviours": _copy(d.get("behaviours", {})),
        "features": {k: v for k, v in features.items() if k not in OWN_FLAG},
        "settings": _copy({k: v for k, v in d.get("settings", {}).items() if k in SETTINGS_KEYS}),
        "light": _copy(d.get("plans", {}).get("light", {})),
        # when the Reinschau-Licht may glow (one setting for every room)
        "glow": _copy(d.get("glow") or {}),
        # Lampen abgleichen: corrections of colour and brightness per lamp
        "light_cal": _copy(d.get("light_cal") or {}),
        "heating": {"rooms": _copy(d.get("plans", {}).get("heat", {})), "global": _copy(d.get("heating") or {})},
        "alarm": alarm,
        "object_alarms": _copy(d.get("object_alarms", [])),
        "window_warning": _copy(core.window_warning.config),
        "mode_auto": _copy(core.mode_auto.config),
        "cleaning": _copy(core.cleaning.config),
        "vacation": _copy(core.sim.config),
        "setup": _copy({k: setup[k] for k in ("done", "step", "answers") if k in setup}),
        "dismissed": _copy(d.get("dismissed", [])),
    }


def export(core: HouseRules) -> dict[str, Any]:
    return {"format": FORMAT, "version": BACKUP_VERSION, "app_version": VERSION, "created": dt_util.utcnow().isoformat(), "data": sections_of(core)}


# ---------------------------------------------------------------------------------------------- reading
SHAPES: dict[str, type] = {
    "rules": list,
    "groups": list,
    "rooms": dict,
    "devices": dict,
    "behaviours": dict,
    "features": dict,
    "settings": dict,
    "light": dict,
    "glow": dict,
    "light_cal": dict,
    "heating": dict,
    "alarm": dict,
    "object_alarms": list,
    "window_warning": dict,
    "mode_auto": dict,
    "cleaning": dict,
    "vacation": dict,
    "setup": dict,
    "dismissed": list,
}
LIMITS = {"rules": 500, "groups": 100, "rooms": 200, "devices": 5000, "dismissed": 500, "object_alarms": 20}


def parse(raw: Any) -> dict[str, Any]:
    """Checks the file's frame and the type of every section. → its data. ValueError with a sentence for the user."""
    if not isinstance(raw, dict) or raw.get("format") != FORMAT:
        raise ValueError("Diese Datei ist keine Sicherung von Hausregeln.")
    if len(json.dumps(raw)) > MAX_BYTES:
        raise ValueError("Die Datei ist zu groß für eine Sicherung von Hausregeln (höchstens 2 MB).")
    ver = raw.get("version")
    if not isinstance(ver, int) or isinstance(ver, bool) or ver < 1:
        raise ValueError("Die Sicherung hat keine gültige Versionsnummer.")
    if ver > BACKUP_VERSION:
        raise ValueError("Diese Sicherung stammt aus einer neueren Version von Hausregeln. Bitte erst Hausregeln aktualisieren.")
    data = raw.get("data")
    if not isinstance(data, dict):
        raise ValueError("Die Sicherung enthält keine Daten.")
    bad = [SECTIONS.get(k, k) for k, shape in SHAPES.items() if k in data and not isinstance(data[k], shape)]
    if bad:
        raise ValueError("Diese Teile der Sicherung sind beschädigt: " + ", ".join(bad) + ".")
    big = [SECTIONS.get(k, k) for k, n in LIMITS.items() if len(data.get(k) or []) > n]
    if big:
        raise ValueError("Diese Teile der Sicherung sind ungewöhnlich groß: " + ", ".join(big) + ".")
    return {k: data[k] for k in SHAPES if k in data}


# ---------------------------------------------------------------------------------------------- entities
def _label(core: HouseRules, data: dict[str, Any], path: tuple[Any, ...]) -> str:
    """Where in the data an entity is used, for people: „Regel „Flurlicht““, „Heizplan Bad“ …"""
    rooms = core.rooms
    root = path[0]

    def room(rid: Any) -> str:
        return str(rooms.get(rid, {}).get("name") or rid)

    if root == "rules" and len(path) > 1:
        r = data["rules"][path[1]] if isinstance(path[1], int) and path[1] < len(data["rules"]) else {}
        return f"Regel „{r.get('name') or r.get('id') or '?'}“"
    if root == "groups" and len(path) > 1:
        g = data["groups"][path[1]] if isinstance(path[1], int) and path[1] < len(data["groups"]) else {}
        return f"Gruppe „{g.get('name') or '?'}“"
    if root == "rooms" and len(path) > 1:
        return f"Raum {room(path[1])}"
    if root == "light" and len(path) > 1:
        return f"Lichtplan {room(path[1])}"
    if root == "heating" and len(path) > 2 and path[1] == "rooms":
        return f"Heizplan {room(path[2])}"
    return SECTIONS.get(root, str(root))


def collect(core: HouseRules, data: dict[str, Any], skip: tuple[str, ...] = ("setup", "dismissed")) -> dict[str, list[str]]:
    """Every entity id in the data → where it is used (labels, in order)."""
    domains = entity_domains()
    out: dict[str, list[str]] = {}

    def hit(s: str, path: tuple[Any, ...]) -> None:
        m = ENTITY_RE.match(s)
        if not m or m.group(2) not in domains:
            return
        eid = f"{m.group(2)}.{m.group(3)}"
        where = out.setdefault(eid, [])
        label = _label(core, data, path)
        if label not in where:
            where.append(label)

    def walk(o: Any, path: tuple[Any, ...]) -> None:
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(k, str):
                    hit(k, path)
                walk(v, (*path, k))
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, (*path, i))
        elif isinstance(o, str):
            hit(o, path)

    for key, value in data.items():
        if key not in skip:
            walk(value, (key,))
    return out


def exists(hass: HomeAssistant, entity_id: str) -> bool:
    return hass.states.get(entity_id) is not None or er.async_get(hass).async_get(entity_id) is not None


def remap(o: Any, mapping: dict[str, str]) -> Any:
    """A copy with entity ids replaced (values and keys, also inside "zone:…")."""
    if not mapping:
        return o

    def one(s: str) -> str:
        if s in mapping:
            return mapping[s]
        if s.startswith("zone:") and s[5:] in mapping:
            return "zone:" + mapping[s[5:]]
        return s

    if isinstance(o, dict):
        return {(one(k) if isinstance(k, str) else k): remap(v, mapping) for k, v in o.items()}
    if isinstance(o, list):
        return [remap(v, mapping) for v in o]
    if isinstance(o, str):
        return one(o)
    return o


def clean_mapping(hass: HomeAssistant, raw: Any) -> dict[str, str]:
    """{old: new} from the frontend: only entity ids, the new one must exist here."""
    if not isinstance(raw, dict):
        return {}
    domains = entity_domains()
    out = {}
    for old, new in list(raw.items())[:500]:
        if not (isinstance(old, str) and isinstance(new, str) and old != new):
            continue
        mo, mn = ENTITY_RE.match(old), ENTITY_RE.match(new)
        if mo and mn and not mo.group(1) and not mn.group(1) and mo.group(2) in domains and exists(hass, new):
            out[old] = new
    return out


def candidates(core: HouseRules, entity_id: str, limit: int = 40) -> list[dict[str, str]]:
    """Devices of this home that could stand in for a missing one: same domain, the most similar name first."""
    hass = core.hass
    domain, _, obj = entity_id.partition(".")
    words = set(re.split(r"[_\W]+", obj)) - {""}
    out = []
    for st in hass.states.async_all(domain):
        name = str(st.attributes.get("friendly_name") or st.object_id)
        score = len(words & (set(re.split(r"[_\W]+", st.object_id)) | set(re.split(r"\W+", name.lower()))))
        out.append((-score, name.lower(), {"entity_id": st.entity_id, "name": name}))
    out.sort(key=lambda x: (x[0], x[1]))
    return [x[2] for x in out[:limit]]


# ---------------------------------------------------------------------------------------------- preview
def _count(v: Any) -> int:
    return len(v) if isinstance(v, (list, dict)) else 0


def preview(core: HouseRules, data: dict[str, Any], mapping: dict[str, str] | None = None) -> dict[str, Any]:
    """What a restore would change, section by section, and which devices are missing here."""
    data = remap(data, mapping or {})
    cur = sections_of(core)
    rooms_here = set(core.rooms)
    out = []
    for key, label in SECTIONS.items():
        if key not in data:
            continue
        v = data[key]
        item: dict[str, Any] = {"key": key, "label": label}
        if key in ("rules", "groups"):
            ids_here = {x.get("id") for x in cur[key]}
            incoming = [x for x in v if isinstance(x, dict)]
            same = sum(1 for x in incoming if x.get("id") in ids_here)
            item |= {"incoming": len(incoming), "current": len(cur[key]), "new": len(incoming) - same, "same": same, "only_here": len(ids_here - {x.get("id") for x in incoming})}
        elif key in ("rooms", "light"):
            item |= {"incoming": _count(v), "current": _count(cur[key]), "unknown_rooms": sorted(str(r) for r in v if r not in rooms_here)}
        elif key == "heating":
            hr = v.get("rooms") if isinstance(v.get("rooms"), dict) else {}
            item |= {"incoming": len(hr), "current": _count(cur["heating"]["rooms"]), "unknown_rooms": sorted(str(r) for r in hr if r not in rooms_here)}
        elif key in ("devices", "behaviours"):
            item |= {"incoming": _count(v), "current": _count(cur[key])}
        else:
            item["changed"] = v != cur.get(key)
        out.append(item)
    used = collect(core, data)
    missing = [{"entity_id": e, "used_in": where[:6], "candidates": candidates(core, e)} for e, where in sorted(used.items()) if not exists(core.hass, e)]
    alarm_note = None
    if "alarm" in data and isinstance(data["alarm"], dict) and data["alarm"].get("confirm") in ("pin", "device") and not core.alarm.config.get("code_hash"):
        alarm_note = "Die Sicherung verlangt zum Ausschalten der Alarmanlage eine PIN. PINs werden nicht gesichert: Bitte danach unter „Alarmanlage“ eine neue PIN festlegen."
    return {"sections": out, "missing": missing, "alarm_armed": core.alarm.state != "disarmed", "notes": [n for n in (alarm_note,) if n]}


# ---------------------------------------------------------------------------------------------- restore
async def restore(core: HouseRules, data: dict[str, Any], mode: str, sections: list[str] | None, mapping: dict[str, str], user_id: str | None = None) -> dict[str, Any]:  # noqa: C901 — one step per section
    if mode not in MODES:
        raise ValueError("Unbekannte Art der Wiederherstellung.")
    data = remap(data, mapping)
    want = [k for k in SECTIONS if k in data and (sections is None or k in sections)]
    if "dismissed" in data and (sections is None or "rules" in sections):
        want.append("dismissed")
    if "alarm" in want and core.alarm.state != "disarmed":
        raise ValueError("Die Alarmanlage ist gerade scharf. Bitte erst ausschalten, dann wiederherstellen.")
    replace = mode == "replace"
    skipped: list[str] = []
    notes: list[str] = []
    d = core.data
    rooms_here = core.rooms

    def room_name(rid: str) -> str:
        return str(rooms_here.get(rid, {}).get("name") or rid)

    if "rules" in want:
        incoming = []
        for raw in data["rules"]:
            try:
                rule = core.sanitize(raw, user_id)
            except (ValueError, TypeError, AttributeError, KeyError):
                skipped.append(f"Regel „{(raw or {}).get('name', '?') if isinstance(raw, dict) else '?'}“ ist unvollständig")
                continue
            rule["meta"]["imported"] = dt_util.utcnow().isoformat()
            incoming.append(rule)
        ids = {r["id"] for r in incoming}
        before = {r["id"]: r for r in core.rules()}
        for rule in incoming:
            core.versions.record(rule, user_id, "import", before=before.get(rule["id"]))
        if replace:
            gone = [r for r in core.rules() if r["id"] not in ids]
            # replaced rules stay restorable from the trash, like deleted ones
            d["trash"] = ([{**r, "deleted": dt_util.utcnow().timestamp()} for r in gone] + d.get("trash", []))[:MAX_TRASH]
            d["rules"] = incoming
        else:
            by_id = {r["id"]: r for r in incoming}
            kept = [by_id.pop(r["id"], r) for r in core.rules()]
            d["rules"] = [r for r in incoming if r["id"] in by_id] + kept

    if "groups" in want:
        incoming = []
        for raw in data["groups"]:
            try:
                incoming.append(core.clean_group(raw))
            except ValueError:
                skipped.append("Eine Gruppe ohne Namen")
        if replace:
            d["groups"] = incoming
        else:
            by_id = {g["id"]: g for g in incoming}
            kept = [by_id.pop(g["id"], g) for g in d.get("groups", [])]
            d["groups"] = kept + [g for g in incoming if g["id"] in by_id]

    if "rooms" in want:
        if replace:
            d["rooms"] = {}
        for rid, cfg in data["rooms"].items():
            if rid not in rooms_here or not isinstance(cfg, dict):
                skipped.append(f"Raum „{rid}“ gibt es hier nicht")
                continue
            core.room_patch({**cfg, "id": rid})

    if "devices" in want:
        if replace:
            d["devices"] = {}
        changes = [{**cfg, "entity_id": eid} for eid, cfg in data["devices"].items() if isinstance(cfg, dict)]
        core.device_patch(changes)

    if "behaviours" in want:
        known = {b["id"] for b in core.behaviours_known()}
        clean = {k: bool(v) for k, v in data["behaviours"].items() if k in known and isinstance(v, bool)}
        d["behaviours"] = clean if replace else {**d.get("behaviours", {}), **clean}

    if "features" in want:
        await core.features.set({k: v for k, v in data["features"].items() if k in FEATURES and k not in OWN_FLAG and isinstance(v, bool)})

    if "settings" in want:
        core.save_settings(data["settings"], rebuild=False)

    if "light" in want and isinstance(data.get("glow"), dict) and data["glow"]:
        d["glow"] = data["glow"]
    if "light" in want and isinstance(data.get("light_cal"), dict):
        # lamps that do not exist here are left out (their corrections belong to that lamp)
        cal = clean_cal({k: v for k, v in data["light_cal"].items() if exists(core.hass, k)}, {} if replace else d.get("light_cal"))
        if cal:
            d["light_cal"] = cal
    if "light" in want:
        store = d.setdefault("plans", {}).setdefault("light", {})
        if replace:
            store.clear()
        for rid, plan in data["light"].items():
            if rid not in rooms_here or not isinstance(plan, dict):
                skipped.append(f"Lichtplan für „{rid}“: den Raum gibt es hier nicht")
                continue
            store.pop(rid, None)
            core.lightplan.save(rid, plan)

    if "heating" in want:
        h = data["heating"]
        store = d.setdefault("plans", {}).setdefault("heat", {})
        if replace:
            store.clear()
            d["heating"] = {}
        for rid, plan in (h.get("rooms") or {}).items() if isinstance(h.get("rooms"), dict) else []:
            if rid not in rooms_here or not isinstance(plan, dict):
                skipped.append(f"Heizplan für „{rid}“: den Raum gibt es hier nicht")
                continue
            store.pop(rid, None)
            # plans of the first version (before the controller) are migrated first; save_room checks every field
            core.heating.save_room(rid, plan if plan.get("v") == 2 else core.heating._migrate(plan))  # noqa: SLF001
        if isinstance(h.get("global"), dict):
            core.heating.save_global(h["global"])

    if "alarm" in want:
        raw = {k: v for k, v in data["alarm"].items() if k not in ("code_hash", "devices", "_hash", "code", "remove_device")}
        if isinstance(raw.get("channels"), dict):
            # passwords and keys are never in a backup: keep the ones set here
            ch = _copy(raw["channels"])
            if isinstance(ch.get("email"), dict):
                ch["email"]["password"] = channels.SECRET
            if isinstance(ch.get("signal"), dict) and isinstance(ch["signal"].get("numbers"), list):
                ch["signal"]["numbers"] = [{**n, "apikey": channels.SECRET} for n in ch["signal"]["numbers"] if isinstance(n, dict)]
            raw["channels"] = ch
        if raw.get("confirm") in ("pin", "device") and not core.alarm.config.get("code_hash"):
            raw["confirm"] = "none"
            notes.append("Die Alarmanlage braucht eine neue PIN (PINs werden nicht gesichert). Bis dahin ist zum Ausschalten keine Bestätigung nötig.")
        core.alarm.save_config(raw)

    if "object_alarms" in want:
        # same id = the same alarm again (its state here stays); the checks of objects.save apply
        if replace:
            keep = {o.get("id") for o in data["object_alarms"] if isinstance(o, dict)}
            for o in [o for o in core.objects.objects if o["id"] not in keep]:
                await core.objects.delete(o["id"])
        for obj in data["object_alarms"]:
            if isinstance(obj, dict):
                try:
                    core.objects.save(obj)
                except ValueError as err:
                    skipped.append(f"Weiterer Alarm „{obj.get('name', '')}“: {err}")

    if "window_warning" in want:
        core.window_warning.save(data["window_warning"])

    if "mode_auto" in want:
        ma = data["mode_auto"]
        if isinstance(ma.get("enabled"), bool):
            core.mode_auto.save("_enabled", {"enabled": ma["enabled"]})
        for m, cfg in (ma.get("modes") or {}).items() if isinstance(ma.get("modes"), dict) else []:
            if isinstance(cfg, dict):
                core.mode_auto.save(m, cfg)

    if "cleaning" in want:
        core.cleaning.save(data["cleaning"])

    if "vacation" in want:
        core.sim.save_config(data["vacation"])

    if "setup" in want:
        s = data["setup"]
        core.setup.save({k: s[k] for k in ("step", "answers", "done") if k in s})

    if "dismissed" in want:
        incoming = [str(x)[:80] for x in data["dismissed"] if isinstance(x, str)]
        d["dismissed"] = incoming if replace else list(dict.fromkeys([*d.get("dismissed", []), *incoming]))

    core.save()
    core.rebuild_now()
    if hook := core.entity_hooks.get("rules"):
        hook()
    names = [SECTIONS[k] for k in want if k in SECTIONS]
    core.history.add("manual", "Sicherung wiederhergestellt", ("Ersetzt: " if replace else "Zusammengeführt: ") + ", ".join(names) + ".")
    core.push("all")
    return {"ok": True, "sections": [k for k in want if k in SECTIONS], "skipped": skipped, "notes": notes}
