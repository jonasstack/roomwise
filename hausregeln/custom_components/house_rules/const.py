"""Constants for Hausregeln."""

DOMAIN = "house_rules"
VERSION = "0.1.0-beta.2"
API_VERSION = 1

STORAGE_KEY = "house_rules"
STORAGE_KEY_HISTORY = "house_rules.history"
# intelligent light: learned examples per light (lightlearn.py), kept apart from the main data
STORAGE_KEY_LIGHT = "house_rules.light_learn"
STORAGE_VERSION = 1

PANEL_URL_PATH = "hausregeln"
FRONTEND_URL = "/house_rules_static"
PANEL_JS = "house-rules-panel.js"

EVENT_FIRED = "house_rules_fired"
# a line in Home Assistant's logbook (logbook.py): alarm, window warning, heating and light plan decisions …
EVENT_LOGBOOK = "house_rules_logbook"

MODES = ["home", "away", "sleep", "vacation", "guests"]
# German names, kept for older callers; use i18n.mode_label() for the language of Home Assistant
MODE_LABELS = {"home": "Zuhause", "away": "Weg", "sleep": "Schlafen", "vacation": "Urlaub", "guests": "Gäste"}  # i18n-ignore

# Features ("Funktionen", Einstellungen → Funktionen): each part of Hausregeln can be switched off; off = really
# stopped (no listeners, no actions, entities unavailable) and hidden in the panel. Read with core.feature(name),
# react to changes with core.features.add_listener(cb). Stored in data["settings"]["features"] (alarm, mode_auto
# and vacuum keep their own flags: alarm.config.enabled, mode_auto.enabled, cleaning.on). See setup.py, docs/API.md.
#   "heating": the heating part (heating plans/controller). A heating controller must check
#              core.feature("heating") before it acts and stop its listeners when it turns False.
# ("behaviours", the room behaviours, is gone since the redesign: behaviours.migrate made them ordinary rules)
FEATURES = ("alarm", "light", "heating", "vacation", "mode_auto", "vacuum", "ai", "window_warning")
# added later: off for existing installs too (they have nothing set up for it)
FEATURES_NEW = ("window_warning",)
# a fresh install starts minimal; the setup wizard switches on what is wanted (existing installs keep everything)
FEATURES_FRESH = {"alarm": False, "light": False, "heating": False, "vacation": False, "mode_auto": True, "vacuum": False, "ai": False, "window_warning": False}

# features with their own small assistant (Licht, Alarm, Fenster-Warnung …; heating has its own): "set up" flag
# per feature in data["setup"]["assistants"], see assistants.py
ASSISTANTS = ("light", "alarm", "window_warning", "vacation", "vacuum", "mode_auto")

PLATFORMS = ["switch", "select", "binary_sensor", "sensor", "alarm_control_panel"]

# entity platforms that never show up as devices (browser tabs, cars …)
IGNORED_PLATFORMS = {"browser_mod", "house_rules"}
