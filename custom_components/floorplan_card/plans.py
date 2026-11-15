"""Shared floor plans and trace images.

A floor plan normally lives inside the card's config on one dashboard. Shared, it lives here instead: several
cards (on any dashboard) reference it by id (`plan: <id>`), editing it from any of them updates all, and every
open card follows a save live. Trace images (a photo or scan of a floor plan to draw rooms on in the editor)
are kept here too, resized by the card, so the dashboard config stays small.

Both live in their own storage files (not in the companion's main one, which changes with every walk check-off):
  floorplan_card.plans   {"plans": {id: {"id", "name", "rev", "updated", "plan": {...}}}}
  floorplan_card.images  {"images": {id: {"id", "data": "data:image/…;base64,…", "width", "height", "bytes", "created"}}}
"""

from __future__ import annotations

from collections.abc import Callable
import json
import re
import secrets
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

PLANS_KEY = "floorplan_card.plans"
IMAGES_KEY = "floorplan_card.images"
STORE_VERSION = 1

# the parts of a card config that make up the plan (everything else — title, height, view, users … — stays per card)
PLAN_KEYS = ("floors", "north", "wall_width", "wall_height", "back_wall_height", "wall_color", "grid", "entry_alert")
MAX_PLAN_BYTES = 1_500_000
MAX_PLANS = 30
MAX_FLOORS = 20
MAX_NAME = 80
# a data URL; the card resizes before uploading (long side ≤ 2400 px, JPEG/WebP)
MAX_IMAGE_BYTES = 1_500_000
MAX_IMAGES = 40
MAX_IMAGES_TOTAL = 24_000_000
ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")


class PlanError(Exception):
    """A request the store refuses: `code` goes to the websocket error."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _new_id(prefix: str, taken: dict[str, Any]) -> str:
    while True:
        pid = f"{prefix}_{secrets.token_hex(4)}"
        if pid not in taken:
            return pid


def clean_plan(plan: Any) -> dict[str, Any]:
    """Only the plan's own keys; checks the frame (the card fills in the rest)."""
    if not isinstance(plan, dict):
        raise PlanError("invalid", "plan must be an object")
    floors = plan.get("floors")
    if not isinstance(floors, list) or not floors:
        raise PlanError("invalid", "plan needs at least one floor")
    if len(floors) > MAX_FLOORS:
        raise PlanError("invalid", f"at most {MAX_FLOORS} floors")
    if not all(isinstance(f, dict) for f in floors):
        raise PlanError("invalid", "every floor must be an object")
    out = {k: plan[k] for k in PLAN_KEYS if k in plan and plan[k] is not None}
    size = len(json.dumps(out, separators=(",", ":")))
    if size > MAX_PLAN_BYTES:
        raise PlanError("too_large", f"plan is {size} bytes, at most {MAX_PLAN_BYTES}")
    return out


def summary(rec: dict[str, Any]) -> dict[str, Any]:
    floors = rec["plan"].get("floors") or []
    return {
        "id": rec["id"],
        "name": rec["name"],
        "rev": rec["rev"],
        "updated": rec["updated"],
        "floors": len(floors),
        "rooms": sum(len(f.get("rooms") or []) for f in floors),
    }


class PlanStore:
    """Shared plans (with live listeners) and trace images."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._plans_store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, PLANS_KEY)
        self._images_store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, IMAGES_KEY)
        self.plans: dict[str, dict[str, Any]] = {}
        self.images: dict[str, dict[str, Any]] = {}
        # called with the plan id after every save / delete
        self.listeners: set[Callable[[str], None]] = set()

    async def async_load(self) -> None:
        self.plans = ((await self._plans_store.async_load()) or {}).get("plans", {})
        self.images = ((await self._images_store.async_load()) or {}).get("images", {})

    def _save_plans(self) -> None:
        self._plans_store.async_delay_save(lambda: {"plans": self.plans}, 2)

    def _save_images(self) -> None:
        self._images_store.async_delay_save(lambda: {"images": self.images}, 2)

    @callback
    def _changed(self, plan_id: str) -> None:
        for listener in list(self.listeners):
            listener(plan_id)

    # ---------- plans ----------

    def summaries(self) -> list[dict[str, Any]]:
        return sorted((summary(p) for p in self.plans.values()), key=lambda s: s["name"].casefold())

    def get(self, plan_id: str) -> dict[str, Any] | None:
        return self.plans.get(plan_id)

    def save(self, plan_id: str | None, name: str, plan: Any, rev: int | None = None, force: bool = False) -> dict[str, Any]:
        """New plan (no id) or a new revision. `rev`: the revision the editor started from — another save in
        between is a conflict unless `force`."""
        content = clean_plan(plan)
        name = (name or "").strip()[:MAX_NAME] or "Grundriss"
        cur = self.plans.get(plan_id) if plan_id else None
        if plan_id and not ID_RE.match(plan_id):
            raise PlanError("invalid", "bad plan id")
        if cur is None:
            if len(self.plans) >= MAX_PLANS:
                raise PlanError("too_many", f"at most {MAX_PLANS} shared plans")
            plan_id = plan_id or _new_id("plan", self.plans)
            new_rev = 1
        else:
            if rev is not None and rev != cur["rev"] and not force:
                raise PlanError("conflict", f"plan was saved elsewhere (revision {cur['rev']}, yours {rev})")
            new_rev = cur["rev"] + 1
        rec = {"id": plan_id, "name": name, "rev": new_rev, "updated": dt_util.utcnow().isoformat(), "plan": content}
        self.plans[plan_id] = rec
        self._save_plans()
        self._changed(plan_id)
        return summary(rec)

    def delete(self, plan_id: str) -> bool:
        if self.plans.pop(plan_id, None) is None:
            return False
        self._save_plans()
        self._changed(plan_id)
        return True

    # ---------- trace images ----------

    def image(self, image_id: str) -> dict[str, Any] | None:
        return self.images.get(image_id)

    def add_image(self, data: str, width: int | None = None, height: int | None = None) -> dict[str, Any]:
        if not isinstance(data, str) or not DATA_URL_RE.match(data):
            raise PlanError("invalid", "image must be a PNG, JPEG or WebP data URL")
        size = len(data)
        if size > MAX_IMAGE_BYTES:
            raise PlanError("too_large", f"image is {size} bytes, at most {MAX_IMAGE_BYTES}")
        if len(self.images) >= MAX_IMAGES or sum(i.get("bytes", 0) for i in self.images.values()) + size > MAX_IMAGES_TOTAL:
            raise PlanError("too_many", "no room for more trace images — remove unused ones first")
        image_id = _new_id("img", self.images)
        self.images[image_id] = {
            "id": image_id,
            "data": data,
            "width": int(width or 0),
            "height": int(height or 0),
            "bytes": size,
            "created": dt_util.utcnow().isoformat(),
        }
        self._save_images()
        return {"id": image_id, "bytes": size}

    def delete_image(self, image_id: str) -> bool:
        if self.images.pop(image_id, None) is None:
            return False
        self._save_images()
        return True
