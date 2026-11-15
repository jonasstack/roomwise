from homeassistant.components.camera import Camera

from . import world
from .vacuum import device


class Point:
    """Like Dreame Vacuum's Point: an object in the state attributes, turned into {x, y, a} by as_dict()"""

    def __init__(self, x, y, a=None):
        self.x, self.y, self.a = x, y, a

    def as_dict(self):
        return {"x": self.x, "y": self.y} if self.a is None else {"x": self.x, "y": self.y, "a": self.a}


async def async_setup_entry(hass, entry, add):
    robots = hass.data["fp_fake"]["robots"]
    add([DreameMap(robots["dreame"]), ValetudoMapData(robots["valetudo"])])


class FakeMap(Camera):
    _attr_has_entity_name = True

    def __init__(self, robot, key):
        super().__init__()
        self.robot = robot
        self._attr_device_info = device(key)
        self.content_type = "image/png"

    async def async_added_to_hass(self):
        self.robot.listeners.append(self._changed)

    def _changed(self):
        self.async_write_ha_state()


class DreameMap(FakeMap):
    """The live map camera as Dreame Vacuum makes it (attribute names and shapes of its MapData.as_dict)"""

    _attr_name = "Map"

    def __init__(self, robot):
        super().__init__(robot, "dreame")
        self._attr_unique_id = "fp_fake_dreame_map_map"
        self.entity_id = "camera.demo_dreame_map"

    def _robot_mm(self):
        x, y, a = self.robot.pos
        rx, ry = world.dreame_xy(x, y)
        return rx, ry, round((-a) % 360)

    @property
    def extra_state_attributes(self):
        rx, ry, a = self._robot_mm()
        cx, cy = world.dreame_xy(*world.DOCK)
        return {
            "charger_position": Point(cx, cy, 90),
            "rooms": world.dreame_rooms(),
            "vacuum_position": Point(rx, ry, a),
            "map_id": 1,
            "saved_map_id": 1,
            "rotation": 0,
            "active_segments": None,
            "is_empty": False,
            "frame_id": 1,
            "calibration_points": world.dreame_calibration(),
            "color_scheme": "Dreame Light",
        }

    async def async_camera_image(self, width=None, height=None):
        rx, ry, _ = self._robot_mm()
        return await self.hass.async_add_executor_job(world.dreame_png, (rx, ry))


class ValetudoMapData(FakeMap):
    """Valetudo's "Map data" camera: a PNG with the ValetudoMap JSON inside; its MQTT topic as Valetudo sets it"""

    _attr_name = "Map data"

    def __init__(self, robot):
        super().__init__(robot, "valetudo")
        self._attr_unique_id = "fp_fake_valetudo_MapData_map-data-hass"
        self.entity_id = "camera.demo_valetudo_map_data"
        # what an MQTT camera keeps of its discovery config (the adapter reads Valetudo's base topic from it)
        self._config = {"topic": "valetudo/demo_robot/MapData/map-data-hass"}

    async def async_camera_image(self, width=None, height=None):
        r = self.robot
        vm = world.valetudo_map(r.pos, list(r.path))
        return await self.hass.async_add_executor_job(world.valetudo_png, vm)
