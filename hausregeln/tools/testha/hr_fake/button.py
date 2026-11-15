"""A button entity (its state is the time of the last press): rules press it, a press counts as a trigger."""

from homeassistant.components.button import ButtonEntity

from .common import Fake


async def async_setup_entry(hass, entry, add):
    add([FakeButton(hass, "test_taste", "Test-Taste")])


class FakeButton(Fake, ButtonEntity):
    platform_domain = "button"

    async def async_press(self) -> None:
        self.hass.data["hr_fake"]["calls"].append({"service": "button.press", "data": {"entity_id": self.entity_id}})

    def fake_set(self, state, attributes):
        # a press at the device (HA's own press handling: new state = now)
        self.hass.async_create_task(self._async_press_action())
