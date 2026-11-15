"""An event entity like a wireless wall switch (its state is the time of the last event)."""

from homeassistant.components.event import EventDeviceClass, EventEntity

from .common import Fake


async def async_setup_entry(hass, entry, add):
    add([FakeEvent(hass, "wandschalter_test", "Wandschalter Test")])


class FakeEvent(Fake, EventEntity):
    platform_domain = "event"
    _attr_device_class = EventDeviceClass.BUTTON
    _attr_event_types = ["single", "double", "long"]

    def fake_set(self, state, attributes):
        """state = the event type (single, double, long)."""
        self._trigger_event(state if state in self._attr_event_types else "single")
        self.async_write_ha_state()
