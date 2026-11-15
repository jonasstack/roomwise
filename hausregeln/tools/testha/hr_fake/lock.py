"""Locks: the test car's (a vehicle part, never a lock of the house unless assigned) and a door lock with a motor."""

from homeassistant.components.lock import LockEntity

from .common import CAR, Fake

# a motor lock needs a moment: "locking" / "unlocking" first, the end state this much later (seconds)
MOTOR = 1.0


async def async_setup_entry(hass, entry, add):
    add([FakeLock(hass, "testauto_verriegelung", "Testauto Verriegelung", CAR), FakeLock(hass, "kellertuer_schloss", "Kellertür Schloss", None, motor=True)])


class FakeLock(Fake, LockEntity):
    platform_domain = "lock"

    def __init__(self, hass, uid, name, device, motor=False):
        super().__init__(hass, uid, name, device)
        self._attr_is_locked = True
        self._motor = motor

    async def _move(self, locked: bool) -> None:
        if not self._motor:
            self._attr_is_locked = locked
            self.async_write_ha_state()
            return
        self._attr_is_locking, self._attr_is_unlocking = locked, not locked
        self.async_write_ha_state()

        def _done():
            self._attr_is_locking = self._attr_is_unlocking = False
            self._attr_is_locked = locked
            self.async_write_ha_state()

        self.hass.loop.call_later(MOTOR, _done)

    async def async_lock(self, **kwargs):
        await self._move(True)

    async def async_unlock(self, **kwargs):
        await self._move(False)

    def fake_set(self, state, attributes):
        self._attr_is_locking = self._attr_is_unlocking = False
        self._attr_is_locked = state == "locked"
        self.async_write_ha_state()
