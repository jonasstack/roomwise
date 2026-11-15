from homeassistant.config_entries import ConfigFlow


class FakeFlow(ConfigFlow, domain="hr_fake"):
    VERSION = 1

    async def async_step_import(self, data):
        return self.async_create_entry(title="Testgeräte", data={})
