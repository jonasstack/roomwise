from homeassistant.config_entries import ConfigFlow


class FakeFlow(ConfigFlow, domain="fp_fake"):
    VERSION = 1

    async def async_step_import(self, data):
        return self.async_create_entry(title="Demo-Saugroboter", data={})
