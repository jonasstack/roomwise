import asyncio

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_COLOR_TEMP_KELVIN,
    ATTR_EFFECT,
    ATTR_HS_COLOR,
    ATTR_RGB_COLOR,
    ATTR_RGBW_COLOR,
    ATTR_RGBWW_COLOR,
    ATTR_WHITE,
    ATTR_XY_COLOR,
    ColorMode,
    LightEntity,
    LightEntityFeature,
)

from .common import Fake

# lamps of every kind (light rules, test-lights.mjs): uid, name, colour modes, effects
LAMPS = (
    ("lampe_rgb", "Lampe RGB", {ColorMode.RGB}, None),
    ("lampe_rgbw", "Lampe RGBW", {ColorMode.RGBW}, None),
    ("lampe_rgbww", "Lampe RGBWW", {ColorMode.RGBWW}, None),
    ("lampe_hs", "Lampe HS", {ColorMode.HS, ColorMode.COLOR_TEMP}, ["colorloop", "candle"]),
    ("lampe_xy", "Lampe XY", {ColorMode.XY}, None),
    ("lampe_ct", "Lampe Weiß", {ColorMode.COLOR_TEMP}, None),
    ("lampe_dim", "Lampe dimmbar", {ColorMode.BRIGHTNESS}, None),
    ("lampe_onoff", "Lampe an/aus", {ColorMode.ONOFF}, None),
    ("lampe_white", "Lampe Weißkanal", {ColorMode.HS, ColorMode.WHITE}, None),
    # a night light that can be red (test-lightplan.mjs: dimming keeps the colour)
    ("nachtlicht_diele", "Nachtlicht Diele", {ColorMode.HS, ColorMode.COLOR_TEMP}, None),
)
_COLOR_ATTRS = ((ATTR_HS_COLOR, ColorMode.HS), (ATTR_RGB_COLOR, ColorMode.RGB), (ATTR_XY_COLOR, ColorMode.XY), (ATTR_RGBW_COLOR, ColorMode.RGBW), (ATTR_RGBWW_COLOR, ColorMode.RGBWW))


async def async_setup_entry(hass, entry, add):
    lights = [FakeLight(hass, u, n) for u, n in (("flurlicht", "Flurlicht"), ("kuechenlicht", "Küchenlicht"), ("badlicht", "Badlicht"), ("sofalicht", "Sofalicht"), ("kleines_licht", "Kleines Licht"))]
    lights += [FakeLight(hass, u, n, modes, effects) for u, n, modes, effects in LAMPS]
    add(lights)


class FakeLight(Fake, LightEntity):
    platform_domain = "light"
    # like a Zigbee lamp: the service call returns at once, the lamp reports its new state this much later (seconds)
    _latency = 0.0
    _call_latency = 0.0  # like Zigbee/Hue: the service call only returns once the lamp has answered
    _bri_offset = 0  # like a lamp that reports its brightness its own way (always this much off)
    _steps = False  # like a Matter/Zigbee lamp that reports the steps of a fade (halfway first, then the end)
    _attr_supported_color_modes = {ColorMode.COLOR_TEMP}
    _attr_color_mode = ColorMode.COLOR_TEMP
    _attr_min_color_temp_kelvin = 2000
    _attr_max_color_temp_kelvin = 6500

    def __init__(self, hass, uid, name, modes=None, effects=None):
        super().__init__(hass, uid, name)
        self._attr_is_on = False
        self._attr_brightness = 255
        self._attr_color_temp_kelvin = 3000
        self.last_kw: dict = {}
        self.call_log: list[dict] = []  # the last calls (tests: power up in the colour, how often the plan sent)
        self.n_calls = 0
        if uid == "kuechenlicht":
            # like a WiZ RGBW bulb: white tones and colours (HA turns rgb_color into rgbw_color)
            self._attr_supported_color_modes = {ColorMode.COLOR_TEMP, ColorMode.RGBW}
            self._attr_rgbw_color = (255, 255, 255, 0)
        if modes:
            self._attr_supported_color_modes = set(modes)
            first = next((m for m in (ColorMode.HS, ColorMode.RGB, ColorMode.XY, ColorMode.RGBW, ColorMode.RGBWW, ColorMode.COLOR_TEMP, ColorMode.BRIGHTNESS, ColorMode.ONOFF) if m in modes))
            self._attr_color_mode = first
            self._attr_hs_color, self._attr_rgb_color, self._attr_xy_color = (30.0, 80.0), (255, 160, 60), (0.5, 0.4)
            self._attr_rgbw_color, self._attr_rgbww_color = (255, 160, 60, 0), (255, 160, 60, 0, 0)
            if ColorMode.BRIGHTNESS not in modes and ColorMode.ONOFF in modes:
                self._attr_brightness = None
            if effects:
                self._attr_effect_list = list(effects)
                self._attr_effect = "off"
            self._attr_supported_features = LightEntityFeature.EFFECT | LightEntityFeature.FLASH | LightEntityFeature.TRANSITION if effects else LightEntityFeature.TRANSITION

    @property
    def extra_state_attributes(self):
        # what the last call asked for (tests read it: transition, flash)
        if not self.last_kw and not self.call_log:
            return None
        plain = lambda kw: {k: (list(v) if isinstance(v, tuple) else v) for k, v in kw.items()}  # noqa: E731
        return {"last_call": plain(self.last_kw), "calls": [plain(c) for c in self.call_log[-8:]], "n_calls": self.n_calls}

    async def async_turn_on(self, **kw):
        if self._call_latency:
            await asyncio.sleep(self._call_latency)
        self.last_kw = dict(kw)
        self._log("turn_on", kw)
        was_on, before = self._attr_is_on, self._attr_brightness
        self._attr_is_on = True
        if ATTR_BRIGHTNESS in kw and self._attr_brightness is not None:
            self._attr_brightness = max(1, min(255, kw[ATTR_BRIGHTNESS] + self._bri_offset))
        if ATTR_COLOR_TEMP_KELVIN in kw:
            self._attr_color_temp_kelvin = kw[ATTR_COLOR_TEMP_KELVIN]
            self._attr_color_mode = ColorMode.COLOR_TEMP
        for attr, mode in _COLOR_ATTRS:
            if attr in kw:
                setattr(self, f"_attr_{attr}", tuple(kw[attr]))
                self._attr_color_mode = mode
        if ATTR_WHITE in kw:
            self._attr_brightness = kw[ATTR_WHITE]
            self._attr_color_mode = ColorMode.WHITE
        if ATTR_EFFECT in kw:
            self._attr_effect = kw[ATTR_EFFECT]
        fade = float(kw.get("transition") or 0)
        if self._steps and fade and self._attr_brightness is not None:
            # a fade reports its steps: halfway now, the end when the fade is over
            end = self._attr_brightness
            self._attr_brightness = max(1, ((before or 0) if was_on else 0) + end) // 2
            self._report()
            self.hass.loop.call_later(fade, self._finish, end)
            return
        self._report()

    def _log(self, service, kw):
        self.call_log = [*self.call_log[-7:], {"service": service, **kw}]
        self.n_calls += 1

    def _finish(self, bri):
        self._attr_brightness = bri
        self.async_write_ha_state()

    async def async_turn_off(self, **kw):
        if self._call_latency:
            await asyncio.sleep(self._call_latency)
        self.last_kw = dict(kw)
        self._log("turn_off", kw)
        self._attr_is_on = False
        self._report()

    def _report(self):
        if self._latency:
            self.hass.loop.call_later(self._latency, self.async_write_ha_state)
        else:
            self.async_write_ha_state()

    def fake_set(self, state, attributes):
        if "latency" in attributes:
            self._latency = float(attributes["latency"] or 0)
        if "call_latency" in attributes:
            self._call_latency = float(attributes["call_latency"] or 0)
        if "bri_offset" in attributes:
            self._bri_offset = int(attributes["bri_offset"] or 0)
        if "steps" in attributes:
            self._steps = bool(attributes["steps"])
        if attributes.get("clear_calls"):
            self.call_log, self.n_calls, self.last_kw = [], 0, {}
        if "brightness" in attributes:
            self._attr_brightness = int(attributes["brightness"])
        self._attr_is_on = state == "on"
        # set at the device: brightness and colour (e.g. a red night light)
        if isinstance(attributes.get("brightness"), (int, float)) and self._attr_brightness is not None:
            self._attr_brightness = int(attributes["brightness"])
        if isinstance(attributes.get("hs_color"), list) and ColorMode.HS in self._attr_supported_color_modes:
            self._attr_hs_color = tuple(attributes["hs_color"])
            self._attr_color_mode = ColorMode.HS
        if isinstance(attributes.get("color_temp_kelvin"), (int, float)) and ColorMode.COLOR_TEMP in self._attr_supported_color_modes:
            self._attr_color_temp_kelvin = int(attributes["color_temp_kelvin"])
            self._attr_color_mode = ColorMode.COLOR_TEMP
        self.async_write_ha_state()
