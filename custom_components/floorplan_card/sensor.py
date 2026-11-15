"""One sensor per media device with song recognition: the last recognized song (state "Title – Artist").

Created when a device recognized its first song (and again after a restart from the stored songs), so automations
can use it; the same news also comes as the event floorplan_card_song.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

if TYPE_CHECKING:
    from . import FloorplanData


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    data: FloorplanData = hass.data[DOMAIN]
    known: set[str] = set()

    @callback
    def added(key: str) -> None:
        if key in known or key not in data.songs:
            return
        known.add(key)
        async_add_entities([SongSensor(data, key)])

    for key in list(data.songs):
        added(key)
    data.song_listeners.add(added)
    entry.async_on_unload(lambda: data.song_listeners.discard(added))


class SongSensor(SensorEntity):
    """The last song recognized for one media device of one card"""

    _attr_has_entity_name = True
    _attr_translation_key = "song"
    _attr_icon = "mdi:music-note"
    _attr_should_poll = False

    def __init__(self, data: FloorplanData, key: str) -> None:
        self._data = data
        self._key = key
        song = data.songs[key]
        self._attr_unique_id = "song_" + re.sub(r"[^a-z0-9_]+", "_", key.lower())
        self._attr_translation_placeholders = {"name": str(song.get("name") or song.get("item_id") or "")}

    @property
    def _song(self) -> dict[str, Any]:
        return self._data.songs.get(self._key) or {}

    @property
    def native_value(self) -> str | None:
        s = self._song
        if not s.get("title"):
            return None
        return (f"{s['title']} – {s['artist']}" if s.get("artist") else s["title"])[:255]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        s = self._song
        return {
            "title": s.get("title"),
            "artist": s.get("artist"),
            "album": s.get("album"),
            "recording_id": s.get("recording_id"),
            "score": s.get("score"),
            "recognized_at": s.get("at"),
            "card_id": s.get("card_id"),
            "item_id": s.get("item_id"),
        }

    async def async_added_to_hass(self) -> None:
        @callback
        def changed(key: str) -> None:
            if key == self._key:
                self.async_write_ha_state()

        self._data.song_listeners.add(changed)
        self.async_on_remove(lambda: self._data.song_listeners.discard(changed))
