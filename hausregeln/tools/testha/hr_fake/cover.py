"""A roller shutter with travel time: "opening" / "closing" while it moves, the position follows step by step."""

from homeassistant.components.cover import ATTR_POSITION, CoverDeviceClass, CoverEntity, CoverEntityFeature as F

from .common import Fake

# seconds for the whole way (0 → 100 %); the position is reported every STEP seconds on the way
TRAVEL = 2.0
STEP = 0.25


async def async_setup_entry(hass, entry, add):
    add([FakeCover(hass, "rollladen_test", "Rollladen Test")])


class FakeCover(Fake, CoverEntity):
    platform_domain = "cover"
    _attr_device_class = CoverDeviceClass.SHUTTER
    _attr_supported_features = F.OPEN | F.CLOSE | F.SET_POSITION | F.STOP

    def __init__(self, hass, uid, name):
        super().__init__(hass, uid, name)
        self._pos = 100
        self._target: int | None = None
        self._timer = None

    @property
    def current_cover_position(self):
        return self._pos

    @property
    def is_closed(self):
        return self._pos == 0

    @property
    def is_opening(self):
        return self._target is not None and self._target > self._pos

    @property
    def is_closing(self):
        return self._target is not None and self._target < self._pos

    def _go(self, target: int) -> None:
        if self._timer:
            self._timer.cancel()
        self._target = target
        self.async_write_ha_state()
        self._timer = self.hass.loop.call_later(STEP, self._tick)

    def _tick(self) -> None:
        self._timer = None
        if self._target is None:
            return
        step = round(100 * STEP / TRAVEL)
        if abs(self._target - self._pos) <= step:
            self._pos, self._target = self._target, None
        else:
            self._pos += step if self._target > self._pos else -step
            self._timer = self.hass.loop.call_later(STEP, self._tick)
        self.async_write_ha_state()

    async def async_open_cover(self, **kw):
        self._go(100)

    async def async_close_cover(self, **kw):
        self._go(0)

    async def async_set_cover_position(self, **kw):
        self._go(int(kw[ATTR_POSITION]))

    async def async_stop_cover(self, **kw):
        if self._timer:
            self._timer.cancel()
        self._target = None
        self.async_write_ha_state()

    def fake_set(self, state, attributes):
        """state "open" / "closed" or a position in percent (at the shutter's own switch: it moves there)."""
        target = 100 if state == "open" else 0 if state == "closed" else int(float(state))
        if attributes.get("instant"):
            self._pos, self._target = target, None
            self.async_write_ha_state()
        else:
            self._go(target)
