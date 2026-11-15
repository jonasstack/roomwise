"""Rule history ("Verlauf einer Regel") and the trash ("Papierkorb").

Every saved change of a rule keeps a version: who, when, what changed, and the rule as it was then (the last 20
per rule, in their own store house_rules.versions). An earlier version can be restored; that is a new version
itself. Deleted rules go to the trash (core.data["trash"]) and can be brought back for 30 days; "Rückgängig"
right after deleting uses the same way.
"""

from __future__ import annotations

import time
import uuid
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .i18n import lang_of, tr

# i18n: complete

if TYPE_CHECKING:
    from .core import HouseRules

STORE_KEY = "house_rules.versions"
MAX_PER_RULE = 20
TRASH_DAYS = 30
MAX_TRASH = 200
# what makes up a rule's content (switching it on/off, pausing, run times are not a new version)
CONTENT = ("name", "type", "when", "and", "then", "only", "else", "options")
PARTS = ("name", "type", "when", "conditions", "then", "else", "options")

# one sentence per changed part / kind of version: texts/release.json (rel.v_change_<part>, rel.v_kind_<kind>)


def content(rule: dict[str, Any]) -> dict[str, Any]:
    return {k: rule[k] for k in CONTENT if k in rule}


def changed_parts(old: dict[str, Any] | None, new: dict[str, Any]) -> list[str]:
    if old is None:
        return []
    parts = []
    for p in PARTS:
        keys = ("and", "only") if p == "conditions" else (p,)
        if any((old.get(k) or None) != (new.get(k) or None) for k in keys):
            parts.append(p)
    return parts


def local_time(where: Any, iso: str) -> str:
    ts = dt_util.parse_datetime(iso) if iso else None
    if not ts:
        return ""
    t = dt_util.as_local(ts)
    return f"{t:%d.%m.%Y, %H:%M}" if lang_of(where) == "de" else f"{t:%Y-%m-%d %H:%M}"


class Versions:
    def __init__(self, hass: HomeAssistant, core: HouseRules) -> None:
        self.hass = hass
        self.core = core
        self._store: Store[dict[str, Any]] = Store(hass, 1, STORE_KEY)
        self.rules: dict[str, list[dict[str, Any]]] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.rules = data.get("rules", {}) if isinstance(data.get("rules"), dict) else {}
        self.purge_trash(save=False)

    def _save(self) -> None:
        self._store.async_delay_save(lambda: {"rules": self.rules}, 10)

    async def async_flush(self) -> None:
        await self._store.async_save({"rules": self.rules})

    # ------------------------------------------------------------------ versions
    def record(self, rule: dict[str, Any], user_id: str | None, kind: str = "edit", *, before: dict[str, Any] | None = None, restored_from: str | None = None) -> None:
        """After a rule was saved: keep its new state as a version (unless nothing in its content changed)."""
        rid = rule["id"]
        versions = self.rules.setdefault(rid, [])
        if not versions and before is not None:
            # a rule from before the history existed: its old state is the first version
            meta = before.get("meta") or {}
            versions.append({"id": uuid.uuid4().hex[:8], "at": meta.get("created") or "", "by": meta.get("created_by"), "kind": "before", "changes": [], "rule": content(before)})
        new = content(rule)
        prev = versions[-1]["rule"] if versions else None
        changes = changed_parts(prev, new)
        if prev is not None and not changes and kind in ("edit", "import"):
            return
        if prev is None and kind == "edit":
            kind = "create"
        entry: dict[str, Any] = {"id": uuid.uuid4().hex[:8], "at": dt_util.utcnow().isoformat(), "by": user_id, "kind": kind, "changes": changes, "rule": new}
        if restored_from:
            entry["restored_from"] = restored_from
        versions.append(entry)
        del versions[:-MAX_PER_RULE]
        self._save()

    def summary(self, v: dict[str, Any]) -> str:
        if v["kind"] == "restore":
            src = next((x for x in self.rules.get(v.get("rule_id", ""), []) if x["id"] == v.get("restored_from")), None)
            when = local_time(self.core, src["at"]) if src else ""
            return tr(self.core, "rel.v_restored_from", when=when) if when else tr(self.core, "rel.v_restored")
        if v["kind"] == "edit" and v.get("changes"):
            return " ".join(tr(self.core, f"rel.v_change_{c}") for c in v["changes"] if c in PARTS)
        return tr(self.core, f"rel.v_kind_{v['kind']}")

    def list(self, rid: str) -> list[dict[str, Any]]:
        """Newest first: {id, at, by, by_name, kind, changes, summary, sentence, current}."""
        versions = self.rules.get(rid, [])
        out = []
        for i, v in enumerate(reversed(versions)):
            v = {**v, "rule_id": rid}
            out.append(
                {
                    "id": v["id"],
                    "at": v["at"],
                    "by": v.get("by"),
                    "by_name": self.core.users.get(v.get("by") or "", "") if v.get("by") else "",
                    "kind": v["kind"],
                    "changes": v.get("changes", []),
                    "summary": self.summary(v),
                    "sentence": self.core.describer.sentence({**v["rule"], "id": rid}),
                    "current": i == 0,
                }
            )
        return out

    def get(self, rid: str, vid: str) -> dict[str, Any] | None:
        return next((v for v in self.rules.get(rid, []) if v["id"] == vid), None)

    def forget(self, rid: str) -> None:
        if self.rules.pop(rid, None) is not None:
            self._save()

    def rename(self, old: str, new: str) -> None:
        if old in self.rules:
            self.rules[new] = self.rules.pop(old)
            self._save()

    # ------------------------------------------------------------------ trash
    def trash(self) -> list[dict[str, Any]]:
        return self.core.data.setdefault("trash", [])

    def to_trash(self, rule: dict[str, Any], user_id: str | None) -> None:
        self.core.data["trash"] = ([{**rule, "deleted": time.time(), "deleted_by": user_id}] + self.trash())[:MAX_TRASH]

    def purge_trash(self, rid: str | None = None, *, save: bool = True) -> int:
        """Drops trash entries older than 30 days (or this one rule / everything when asked); their versions go too."""
        cutoff = time.time() - TRASH_DAYS * 86400
        keep, gone = [], []
        for t in self.trash():
            old = float(t.get("deleted") or 0) < cutoff
            (gone if old or rid == "*" or t.get("id") == rid else keep).append(t)
        if not gone:
            return 0
        self.core.data["trash"] = keep
        living = {r["id"] for r in self.core.rules()} | {t["id"] for t in keep}
        for t in gone:
            if t["id"] not in living:
                self.rules.pop(t["id"], None)
        self._save()
        if save:
            self.core.save()
        return len(gone)

    def trash_view(self) -> list[dict[str, Any]]:
        self.purge_trash()
        out = []
        for t in self.trash():
            deleted = float(t.get("deleted") or 0)
            rule = {k: v for k, v in t.items() if k not in ("deleted", "deleted_by")}
            out.append(
                {
                    "id": t["id"],
                    "name": t.get("name", ""),
                    "deleted": dt_util.utc_from_timestamp(deleted).isoformat() if deleted else None,
                    "deleted_by": t.get("deleted_by"),
                    "deleted_by_name": self.core.users.get(t.get("deleted_by") or "", "") if t.get("deleted_by") else "",
                    "until": dt_util.utc_from_timestamp(deleted + TRASH_DAYS * 86400).isoformat() if deleted else None,
                    "sentence": self.core.describer.sentence(rule),
                    "rule": rule,
                }
            )
        return out

    def take_from_trash(self, rid: str) -> dict[str, Any] | None:
        """Removes the newest trash entry of this rule and returns the rule (without the trash fields)."""
        trash = self.trash()
        i = next((n for n, t in enumerate(trash) if t.get("id") == rid), None)
        if i is None:
            return None
        entry = trash.pop(i)
        return {k: v for k, v in entry.items() if k not in ("deleted", "deleted_by")}
