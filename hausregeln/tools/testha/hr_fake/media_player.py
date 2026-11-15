from homeassistant.components.media_player import MediaPlayerEntity, MediaPlayerEntityFeature as F, MediaPlayerState

from .common import Fake


async def async_setup_entry(hass, entry, add):
    add([FakePlayer(hass, "homepod", "Wohnzimmer HomePod")])


class FakePlayer(Fake, MediaPlayerEntity):
    platform_domain = "media_player"
    _attr_supported_features = F.PLAY | F.PAUSE | F.VOLUME_SET | F.TURN_ON | F.TURN_OFF | F.PLAY_MEDIA

    async def async_play_media(self, media_type, media_id, **kw):
        # announcements (tts.speak) end up here: recorded for the tests
        self.hass.data["hr_fake"]["calls"].append({"service": "media_player.play_media", "data": {"entity_id": self.entity_id, "media_id": str(media_id)}})

    def __init__(self, hass, uid, name):
        super().__init__(hass, uid, name)
        self._attr_state = MediaPlayerState.IDLE
        self._attr_volume_level = 0.3

    async def async_media_play(self):
        self._attr_state = MediaPlayerState.PLAYING
        self.async_write_ha_state()

    async def async_media_pause(self):
        self._attr_state = MediaPlayerState.PAUSED
        self.async_write_ha_state()

    async def async_turn_on(self):
        self._attr_state = MediaPlayerState.IDLE
        self.async_write_ha_state()

    async def async_turn_off(self):
        self._attr_state = MediaPlayerState.OFF
        self.async_write_ha_state()

    async def async_set_volume_level(self, volume):
        self._attr_volume_level = volume
        self.async_write_ha_state()

    def fake_set(self, state, attributes):
        self._attr_state = MediaPlayerState(state)
        if "volume" in attributes:
            self._attr_volume_level = float(attributes["volume"])
        self.async_write_ha_state()
