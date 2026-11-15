"""Constants of the card part of roomwise."""

from ..const import DOMAIN as INTEGRATION, VERSION  # noqa: F401 — the integration (roomwise) and its version

# the card part's own name: key in hass.data, prefix of its websocket commands (floorplan_card/…), its storage
# files and events – kept from the former companion integration so stored data and the card keep working
DOMAIN = "floorplan_card"
STORAGE_KEY = "floorplan_card"
STORAGE_VERSION = 1

# states that mean "open" for doors and windows
OPEN_STATES = ("on", "open")

EVENT_ENTRY_ALERT = "floorplan_card_entry_alert"
