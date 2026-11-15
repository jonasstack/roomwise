"""Websocket commands the card uses.

  floorplan_card/info                       → version, which cards have a warning on the server
  floorplan_card/entry_alert/set   (admin)  ← resolved warning settings of a card
  floorplan_card/entry_alert/remove (admin)
  floorplan_card/entry_alert/ack            ← a tap on a tablet
  floorplan_card/walks                      → today's checked-off walks of a card's pets
  floorplan_card/walks/done                 ← a walk checked off (any device)
  floorplan_card/walks/undo
  floorplan_card/walks/subscribe            → pushes the walks whenever they change
  floorplan_card/entry_alert/subscribe      → the warning's state, the same on every tablet
  floorplan_card/pets/set           (admin) ← dogs: walk times, presence, reminder settings
  floorplan_card/pets/subscribe             → walk state of the dogs (due / out / next)
  floorplan_card/vacuums/set        (admin) ← the vacuums of a card (piece id, entity, optional map entity)
  floorplan_card/vacuums/subscribe          → where the vacuums are (robot mm), pushed with every new position
  floorplan_card/vacuums/learned            → floor a vacuum has driven over, dock, speed
  floorplan_card/vacuums/path               → the current run's trail
  floorplan_card/vacuums/map                → the vacuum's own map (rooms, walls, dock), robot mm
  floorplan_card/vacuums/info               → where position and map come from (adapter), segments, cleaning
  floorplan_card/vacuums/clean              ← clean segments (rooms) of the vacuum's map
  floorplan_card/vacuums/reset      (admin) ← forget what a vacuum has learned
  floorplan_card/plans/list                 → the shared floor plans (id, name, revision, counts)
  floorplan_card/plans/get                  → one shared plan with its content
  floorplan_card/plans/save        (admin)  ← a new plan or a new revision (conflict when saved elsewhere meanwhile)
  floorplan_card/plans/delete      (admin)
  floorplan_card/plans/subscribe            → pushes the plan on every save (live update of every open card)
  floorplan_card/images/get                 → a trace image (data URL)
  floorplan_card/images/save       (admin)  ← a trace image, resized by the card
  floorplan_card/images/delete     (admin)
  floorplan_card/wifi/get                   → the home's Wi-Fi networks for the QR codes (non-admins: those for everyone)
  floorplan_card/wifi/set           (admin) ← the Wi-Fi networks (replaces the list)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, VERSION
from .plans import PlanError

if TYPE_CHECKING:
    from . import FloorplanData

CARD_ID = vol.All(str, vol.Length(min=1, max=80))
PLAN_ID = vol.All(str, vol.Match(r"^[a-z0-9_]{1,40}$"))
SLOT = vol.Match(r"^\d{2}:\d{2}$")
SIG = vol.All(str, vol.Length(max=200))
ENTITY = vol.All(str, vol.Length(min=1, max=255))


def _data(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> FloorplanData | None:
    data = hass.data.get(DOMAIN)
    if data is None:
        connection.send_error(msg["id"], "not_loaded", "Floorplan card companion is not set up")
    return data


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/info"})
@callback
def ws_info(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    data = hass.data.get(DOMAIN)
    connection.send_result(
        msg["id"],
        {
            "version": VERSION,
            "loaded": data is not None,
            "entry_alert": sorted(k for k, v in (data.cards.items() if data else []) if v.get("entry_alert")),
            "pets": {k: v.get("pets_sig", "") for k, v in (data.cards.items() if data else []) if "pets" in v},
            "vacuums": {k: v.get("vacuums_sig", "") for k, v in (data.cards.items() if data else []) if "vacuums" in v},
            "entry_alert_sig": {k: v.get("entry_alert_sig", "") for k, v in (data.cards.items() if data else []) if v.get("entry_alert")},
            # what this version offers beyond the basics (older cards ignore it)
            "features": ["plans", "images", "wifi"],
        },
    )


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "floorplan_card/entry_alert/set", vol.Required("card_id"): CARD_ID, vol.Required("config"): dict, vol.Optional("sig", default=""): SIG}
)
@callback
def ws_entry_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    data.set_entry_alert(msg["card_id"], msg["config"], msg["sig"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/entry_alert/remove", vol.Required("card_id"): CARD_ID})
@callback
def ws_entry_remove(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    data.remove_entry_alert(msg["card_id"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/entry_alert/ack", vol.Required("card_id"): CARD_ID})
@callback
def ws_entry_ack(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], {"acknowledged": data.acknowledge(msg["card_id"])})


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/walks", vol.Required("card_id"): CARD_ID})
@callback
def ws_walks(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], data.walks_today(msg["card_id"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "floorplan_card/walks/done", vol.Required("card_id"): CARD_ID, vol.Required("pet_id"): CARD_ID, vol.Required("slot"): SLOT}
)
@callback
def ws_walk_done(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    data.walk_done(msg["card_id"], msg["pet_id"], msg["slot"])
    connection.send_result(msg["id"], data.walks_today(msg["card_id"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "floorplan_card/walks/undo", vol.Required("card_id"): CARD_ID, vol.Required("pet_id"): CARD_ID, vol.Required("slot"): SLOT}
)
@callback
def ws_walk_undo(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    data.walk_undo(msg["card_id"], msg["pet_id"], msg["slot"])
    connection.send_result(msg["id"], data.walks_today(msg["card_id"]))


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/walks/subscribe", vol.Required("card_id"): CARD_ID})
@callback
def ws_walks_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    card_id = msg["card_id"]

    @callback
    def changed(cid: str) -> None:
        if cid == card_id:
            connection.send_message(websocket_api.event_message(msg["id"], data.walks_today(card_id)))

    data.walk_listeners.add(changed)
    connection.subscriptions[msg["id"]] = lambda: data.walk_listeners.discard(changed)
    connection.send_result(msg["id"])
    connection.send_message(websocket_api.event_message(msg["id"], data.walks_today(card_id)))


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/entry_alert/subscribe", vol.Required("card_id"): CARD_ID})
@callback
def ws_alert_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The warning's state for every tablet: active, phase, open windows, announcement time"""
    if (data := _data(hass, connection, msg)) is None:
        return
    card_id = msg["card_id"]

    @callback
    def changed(cid: str) -> None:
        if cid == card_id:
            connection.send_message(websocket_api.event_message(msg["id"], data.alert_state(card_id)))

    data.alert_listeners.add(changed)
    connection.subscriptions[msg["id"]] = lambda: data.alert_listeners.discard(changed)
    connection.send_result(msg["id"])
    connection.send_message(websocket_api.event_message(msg["id"], data.alert_state(card_id)))


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "floorplan_card/pets/set", vol.Required("card_id"): CARD_ID, vol.Required("pets"): list, vol.Optional("sig", default=""): SIG}
)
@websocket_api.async_response
async def ws_pets_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    await data.set_pets(msg["card_id"], msg["pets"], msg["sig"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/pets/subscribe", vol.Required("card_id"): CARD_ID})
@callback
def ws_pets_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Walk state of a card's dogs (due / out / next walk), pushed on every change"""
    if (data := _data(hass, connection, msg)) is None:
        return
    card_id = msg["card_id"]

    @callback
    def changed(cid: str) -> None:
        if cid == card_id:
            connection.send_message(websocket_api.event_message(msg["id"], data.pet_states(card_id)))

    data.pet_listeners.add(changed)
    connection.subscriptions[msg["id"]] = lambda: data.pet_listeners.discard(changed)
    connection.send_result(msg["id"])
    connection.send_message(websocket_api.event_message(msg["id"], data.pet_states(card_id)))


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "floorplan_card/vacuums/set", vol.Required("card_id"): CARD_ID, vol.Required("vacuums"): list, vol.Optional("sig", default=""): SIG}
)
@websocket_api.async_response
async def ws_vacuums_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    await data.set_vacuums(msg["card_id"], msg["vacuums"], msg["sig"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/vacuums/subscribe", vol.Required("card_id"): CARD_ID})
@callback
def ws_vacuums_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Where the vacuums are (robot coordinates, mm) — pushed with every new position"""
    if (data := _data(hass, connection, msg)) is None:
        return
    card_id = msg["card_id"]

    @callback
    def changed(cid: str) -> None:
        if cid == card_id:
            connection.send_message(websocket_api.event_message(msg["id"], data.vacuum_states(card_id)))

    data.vacuum_listeners.add(changed)
    connection.subscriptions[msg["id"]] = lambda: data.vacuum_listeners.discard(changed)
    connection.send_result(msg["id"])
    connection.send_message(websocket_api.event_message(msg["id"], data.vacuum_states(card_id)))


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/vacuums/learned", vol.Required("entity"): ENTITY})
@callback
def ws_vacuum_learned(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The floor a vacuum has driven over (cells of 10 cm), its dock and usual speed"""
    if (data := _data(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], data.vacuum_learned(msg["entity"]))


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/vacuums/path", vol.Required("entity"): ENTITY})
@callback
def ws_vacuum_path(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Where the vacuum has cleaned in its current run (robot mm): the trail on the plan"""
    if (data := _data(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], data.vacuum_path(msg["entity"]))


MAP_ENTITY = vol.Match(r"^(camera|image)\.[a-z0-9_]+$")


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/vacuums/map", vol.Required("entity"): ENTITY, vol.Optional("map"): MAP_ENTITY})
@websocket_api.async_response
async def ws_vacuum_map(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The vacuum's own map (Roborock, map camera, Valetudo): floor per room with names, walls, dock — in robot
    millimetres; `map` names a map entity picked in the editor (else the card's setting, else found by itself)"""
    from . import vacuum_adapters

    data = hass.data.get(DOMAIN)
    result = None
    try:
        ad = await vacuum_adapters.get(hass, msg["entity"], msg.get("map") or (data.vacuum_map_entity(msg["entity"]) if data else None))
        result = await ad.map() if ad else None
        if result is not None:
            result = {**result, "adapter": ad.kind}
    except Exception:  # noqa: BLE001 — another version of the vacuum integration: no map, the learned floor still works
        result = None
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/vacuums/info", vol.Required("entity"): ENTITY, vol.Optional("map"): MAP_ENTITY})
@websocket_api.async_response
async def ws_vacuum_info(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Where a vacuum's position and map come from (adapter, map entity, integration), its segments (rooms of its
    own map) and whether the card can have them cleaned; candidates: map entities that may belong to it"""
    from . import vacuum_adapters

    data = hass.data.get(DOMAIN)
    entity = msg["entity"]
    ad = await vacuum_adapters.get(hass, entity, msg.get("map") or (data.vacuum_map_entity(entity) if data else None))
    try:
        info = await ad.info() if ad else {"adapter": None, "source": None, "platform": None, "segments": [], "clean": False}
    except Exception:  # noqa: BLE001
        info = {"adapter": ad.kind if ad else None, "source": ad.source if ad else None, "platform": None, "segments": [], "clean": False}
    connection.send_result(msg["id"], {**info, "candidates": vacuum_adapters.candidates(hass, entity)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "floorplan_card/vacuums/clean",
        vol.Required("entity"): vol.Match(r"^vacuum\.[a-z0-9_]+$"),
        vol.Required("segments"): vol.All([vol.Any(str, int)], vol.Length(min=1, max=50)),
        vol.Optional("repeats", default=1): vol.All(int, vol.Range(min=1, max=3)),
        vol.Optional("map"): MAP_ENTITY,
    }
)
@websocket_api.async_response
async def ws_vacuum_clean(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Clean rooms of the vacuum's own map, the way its integration does it (Dreame / Xiaomi service, Valetudo
    MQTT). Runs as the user who tapped (their context), like any service call from the card."""
    from homeassistant.exceptions import Unauthorized

    from . import vacuum_adapters

    user = connection.user
    if user is not None and not user.permissions.check_entity(msg["entity"], "control"):
        raise Unauthorized(entity_id=msg["entity"])
    data = hass.data.get(DOMAIN)
    ad = await vacuum_adapters.get(hass, msg["entity"], msg.get("map") or (data.vacuum_map_entity(msg["entity"]) if data else None))
    if ad is None or not ad.can_clean():
        connection.send_error(msg["id"], "not_supported", "This vacuum's integration cannot clean single rooms")
        return
    try:
        await ad.clean([str(s) for s in msg["segments"]], msg["repeats"], connection.context(msg))
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "failed", str(err))
        return
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/vacuums/reset", vol.Required("entity"): ENTITY})
@callback
def ws_vacuum_reset(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    data.vacuum_reset(msg["entity"])
    connection.send_result(msg["id"], {"ok": True})


# ---------- shared floor plans ----------


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/plans/list"})
@callback
def ws_plans_list(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], {"plans": data.plans.summaries()})


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/plans/get", vol.Required("plan_id"): PLAN_ID})
@callback
def ws_plans_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    rec = data.plans.get(msg["plan_id"])
    if rec is None:
        connection.send_error(msg["id"], "not_found", "No shared plan with this id")
        return
    connection.send_result(msg["id"], rec)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "floorplan_card/plans/save",
        vol.Optional("plan_id"): PLAN_ID,
        vol.Required("name"): vol.All(str, vol.Length(max=200)),
        vol.Required("plan"): dict,
        vol.Optional("rev"): vol.Any(None, int),
        vol.Optional("force", default=False): bool,
    }
)
@callback
def ws_plans_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    try:
        result = data.plans.save(msg.get("plan_id"), msg["name"], msg["plan"], msg.get("rev"), msg["force"])
    except PlanError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/plans/delete", vol.Required("plan_id"): PLAN_ID})
@callback
def ws_plans_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], {"deleted": data.plans.delete(msg["plan_id"])})


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/plans/subscribe", vol.Required("plan_id"): PLAN_ID})
@callback
def ws_plans_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The plan now and after every save; `{"id", "deleted": true}` when it is gone"""
    if (data := _data(hass, connection, msg)) is None:
        return
    plan_id = msg["plan_id"]

    def current() -> dict[str, Any]:
        return data.plans.get(plan_id) or {"id": plan_id, "deleted": True}

    @callback
    def changed(pid: str) -> None:
        if pid == plan_id:
            connection.send_message(websocket_api.event_message(msg["id"], current()))

    data.plans.listeners.add(changed)
    connection.subscriptions[msg["id"]] = lambda: data.plans.listeners.discard(changed)
    connection.send_result(msg["id"])
    connection.send_message(websocket_api.event_message(msg["id"], current()))


# ---------- trace images (editor) ----------


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/images/get", vol.Required("image_id"): PLAN_ID})
@callback
def ws_images_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    img = data.plans.image(msg["image_id"])
    if img is None:
        connection.send_error(msg["id"], "not_found", "No image with this id")
        return
    connection.send_result(msg["id"], {k: img[k] for k in ("id", "data", "width", "height")})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "floorplan_card/images/save",
        vol.Required("data"): str,
        vol.Optional("width"): vol.All(int, vol.Range(min=0, max=20000)),
        vol.Optional("height"): vol.All(int, vol.Range(min=0, max=20000)),
    }
)
@callback
def ws_images_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    try:
        result = data.plans.add_image(msg["data"], msg.get("width"), msg.get("height"))
    except PlanError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/images/delete", vol.Required("image_id"): PLAN_ID})
@callback
def ws_images_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if (data := _data(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], {"deleted": data.plans.delete_image(msg["image_id"])})


# ---------- Wi-Fi (QR codes on the tablets) ----------


@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/wifi/get"})
@callback
def ws_wifi_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Any signed-in user: whoever may open the popup on a tablet sees the QR code anyway. Admins also get the
    networks marked "admins only"."""
    if (data := _data(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], {"networks": data.wifi.visible(bool(connection.user and connection.user.is_admin))})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "floorplan_card/wifi/set", vol.Required("networks"): list})
@callback
def ws_wifi_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    from .wifi import WifiError

    if (data := _data(hass, connection, msg)) is None:
        return
    try:
        count = data.wifi.set(msg["networks"])
    except WifiError as err:
        connection.send_error(msg["id"], err.code, str(err))
        return
    connection.send_result(msg["id"], {"networks": count})


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    for cmd in (ws_info, ws_entry_set, ws_entry_remove, ws_entry_ack, ws_walks, ws_walk_done, ws_walk_undo, ws_walks_subscribe, ws_alert_subscribe, ws_pets_set, ws_pets_subscribe, ws_vacuums_set, ws_vacuums_subscribe, ws_vacuum_learned, ws_vacuum_reset, ws_vacuum_map, ws_vacuum_path, ws_vacuum_info, ws_vacuum_clean,
        ws_plans_list, ws_plans_get, ws_plans_save, ws_plans_delete, ws_plans_subscribe, ws_images_get, ws_images_save, ws_images_delete,
        ws_wifi_get, ws_wifi_set,
    ):
        websocket_api.async_register_command(hass, cmd)
