"""Base for the fake entities."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity


# a car and a bike with GPS trackers (device_tracker.py): their doors, lock and vibration sensor belong to the vehicle
CAR = "Testauto"
BIKE = "Testrad"
VEHICLES = (CAR, BIKE)


class Fake(Entity):
    _attr_should_poll = False

    def __init__(self, hass, uid: str, name: str, device: str | None = None, **attrs: Any) -> None:
        self._attr_unique_id = f"hr_fake_{uid}"
        self._attr_name = name
        self.entity_id = f"{self.platform_domain}.{uid}"
        self._extra: dict[str, Any] = {}
        if device:
            # vehicles of the test (inventory: never parts of the house) come from this manufacturer
            maker = "Testwerk Fahrzeuge" if device in VEHICLES else None
            self._attr_device_info = DeviceInfo(identifiers={("hr_fake", device)}, name=device, manufacturer=maker)
        for k, v in attrs.items():
            setattr(self, f"_attr_{k}", v)
        hass.data["hr_fake"]["entities"][self.entity_id] = self

    platform_domain = "x"

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        return self._extra or None

    def fake_report(self) -> None:
        """The same state reported again (only an attribute like the link quality changes, as Zigbee devices do)."""
        self._extra["linkquality"] = int(self._extra.get("linkquality", 100)) % 200 + 1
        self.async_write_ha_state()

    def fake_set(self, state: str, attributes: dict[str, Any]) -> None:
        raise NotImplementedError
