from homeassistant.components.binary_sensor import BinarySensorDeviceClass as C, BinarySensorEntity

from .common import BIKE, CAR, Fake

SENSORS = [
    ("haustuer", "Haustürsensor Tür", C.DOOR, None),
    ("fenster_kueche", "Fenstersensor Küche Tür", C.DOOR, None),
    ("fenster_bad", "Fenstersensor Bad Tür", C.DOOR, None),
    ("badtuer", "Türsensor Bad", C.DOOR, None),
    ("praesenz_flur", "Anwesenheitssensor Flur", C.OCCUPANCY, None),
    # a hall with two doors and its own presence sensor (test-lightplan.mjs)
    ("praesenz_diele", "Anwesenheit Diele", C.OCCUPANCY, None),
    ("zimmertuer_diele_a", "Zimmertür Diele A", C.DOOR, None),
    ("zimmertuer_diele_b", "Zimmertür Diele B", C.DOOR, None),
    ("fp2_alles", "Küche Alles", C.OCCUPANCY, "FP2 Küche"),
    ("fp2_kochfeld", "Kochfeld", C.OCCUPANCY, "FP2 Küche"),
    ("fp2_essbereich", "Essbereich", C.OCCUPANCY, "FP2 Küche"),
    ("wasser_kueche", "Wassermelder Küche", C.MOISTURE, None),
    ("bewegung_wohnzimmer", "Bewegung Wohnzimmer", C.MOTION, None),
    ("fenster_wohnzimmer", "Fenster Wohnzimmer", C.WINDOW, None),
    # vehicles: "front left door" once made a car door the suggested front door of the house
    ("testauto_tuer", "Testauto Front left door", C.DOOR, CAR),
    ("testauto_fenster", "Testauto Fenster hinten", C.WINDOW, CAR),
    ("testauto_bewegung", "Testauto Innenraum Bewegung", C.MOTION, CAR),
    ("testrad_erschuetterung", "Testrad Erschütterung", C.VIBRATION, BIKE),
    # a sensor of the garage, for an object alarm and a manual device
    ("garage_erschuetterung", "Erschütterung Garage", C.VIBRATION, None),
    # a car (odometer + range on the same device): its doors and windows never belong to the house
    ("demo_auto_tuer_vorne_links", "Front left door", C.DOOR, "Demo-Auto"),
    ("demo_auto_fenster", "Demo-Auto Fenster", C.WINDOW, "Demo-Auto"),
]


async def async_setup_entry(hass, entry, add):
    add([FakeBinary(hass, u, n, dev, device_class=dc) for u, n, dc, dev in SENSORS])


class FakeBinary(Fake, BinarySensorEntity):
    platform_domain = "binary_sensor"

    def __init__(self, hass, uid, name, device, **kw):
        super().__init__(hass, uid, name, device, **kw)
        self._attr_is_on = False

    def fake_set(self, state, attributes):
        self._attr_is_on = state == "on"
        self.async_write_ha_state()
