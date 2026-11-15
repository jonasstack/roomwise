"""GPS trackers: phones for the "Wo ist wer" tests and the test car and bike (vehicle detection, object alarms).
hr_fake/set with attributes latitude, longitude, gps_accuracy, speed."""

from homeassistant.components.device_tracker import SourceType, TrackerEntity

from .common import BIKE, CAR, Fake

# fictional start: the test Home Assistant's home (configuration.yaml)
HOME = (52.52, 13.40)


async def async_setup_entry(hass, entry, add):
    add(
        [
            FakeTracker(hass, "handy_robin", "Handy Robin", "Handy Robin"),
            FakeTracker(hass, "handy_kim", "Handy Kim", "Handy Kim"),
            FakeTracker(hass, "testauto", "Testauto", CAR),
            FakeTracker(hass, "testrad", "Testrad", BIKE),
        ]
    )


class FakeTracker(Fake, TrackerEntity):
    platform_domain = "device_tracker"

    def __init__(self, hass, uid, name, device=None):
        super().__init__(hass, uid, name, device)
        self._lat, self._lon, self._acc, self._speed = HOME[0], HOME[1], 10, None

    @property
    def device_info(self):
        # HA's tracker base class creates no device; real car integrations attach their tracker to the car's device
        return getattr(self, "_attr_device_info", None)

    @property
    def source_type(self):
        return SourceType.GPS

    @property
    def latitude(self):
        return self._lat

    @property
    def longitude(self):
        return self._lon

    @property
    def location_accuracy(self):
        return self._acc

    @property
    def extra_state_attributes(self):
        return {"speed": self._speed} if self._speed is not None else {}

    def fake_set(self, state, attributes):
        # the state follows from the position (zones); `state` is ignored
        self._lat = float(attributes.get("latitude", self._lat))
        self._lon = float(attributes.get("longitude", self._lon))
        self._acc = int(attributes.get("gps_accuracy", self._acc))
        self._speed = attributes.get("speed")
        self.async_write_ha_state()
