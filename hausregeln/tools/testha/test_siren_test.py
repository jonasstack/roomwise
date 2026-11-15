"""Live test of the alarm sound (alarm.siren_test): the tone on the chosen speakers at the volume, sirens with
volume_level / duration (or switched off by itself), at most 10 s, then the backend stops it; "Stopp" ends it at once,
the speakers get their volume back; the volume follows live; never an alarm – no message, no extra devices, the state
stays. Needs Home Assistant (imports): run inside a HA container with custom_components mounted, e.g.
    docker run --rm -v "$(pwd)/custom_components:/config/custom_components:ro" -v "$(pwd)/hausregeln/tools:/t:ro" \\
      ghcr.io/home-assistant/home-assistant:stable python3 /t/testha/test_siren_test.py
"""

import asyncio
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG", "/config"))

import custom_components.roomwise.house_rules.alarm as A  # noqa: E402

fails = 0


def ok(c, m, *extra):
    global fails
    if not c:
        fails += 1
    print(("  ok: " if c else "  FEHLER: ") + m, *(extra if not c else ()))


class Services:
    def __init__(self):
        self.calls = []

    async def async_call(self, domain, service, data, blocking=True, context=None):
        self.calls.append((domain, service, dict(data)))


def st(state="idle", **attrs):
    return SimpleNamespace(state=state, attributes=attrs)


states = {
    "media_player.kueche": st("idle", volume_level=0.25),
    "media_player.flur": st("idle", volume_level=0.4),
    "siren.innen": st("off", supported_features=4 | 8 | 16),  # tones, volume, duration
    "siren.alt": st("off", supported_features=0),
    "switch.sirene_garage": st("off"),
}
later = []


class Hass:
    def __init__(self):
        self.services = Services()
        self.states = SimpleNamespace(get=lambda e: states.get(e))
        self.config = SimpleNamespace(language="de")
        self.bus = SimpleNamespace(async_fire=lambda *a, **k: None)

    def async_create_task(self, coro):
        return asyncio.ensure_future(coro)


hass = Hass()
history = []
notified = []
cfg = A.default_config("de")
cfg["sound"].update({"players": ["media_player.kueche", "media_player.flur"], "tone": "sirene", "volume": 80})
cfg["sirens"] = ["siren.innen", "siren.alt", "switch.sirene_garage"]
core = SimpleNamespace(
    hass=hass,
    data={"alarm": cfg},
    history=SimpleNamespace(new_context=lambda _n: None, add=lambda *a, **k: history.append(a)),
    push=lambda _what: None,
    save=lambda: None,
)


def call_later(_hass, delay, cb):
    item = (delay, cb)
    later.append(item)
    return lambda: later.remove(item) if item in later else None


A.async_call_later = call_later  # the timer: remembered, fired by hand

alarm = A.Alarm.__new__(A.Alarm)
alarm.hass = hass
alarm.core = core
alarm.state = "disarmed"
alarm._listeners = []
alarm._test = None
alarm._test_unsub = None
alarm.tone_url = lambda tone: f"http://ha/house_rules_sounds/{tone}.mp3"


async def _never(*a, **k):
    notified.append(a)


alarm._notify = _never
alarm._announce = _never
alarm._activate = _never


def calls(domain=None, service=None):
    return [c for c in hass.services.calls if (domain is None or c[0] == domain) and (service is None or c[1] == service)]


async def main():
    print("Test starten")
    r = await alarm.siren_test(5, 60)
    ok(r["ok"] and r["until"] > 0, "läuft", r)
    vs = calls("media_player", "volume_set")
    ok(vs and abs(vs[0][2]["volume_level"] - 0.6) < 1e-9 and set(vs[0][2]["entity_id"]) == {"media_player.kueche", "media_player.flur"}, "Lautsprecher auf 60 %", vs)
    ok(any(c[2].get("media_content_id", "").endswith("/sirene.mp3") for c in calls("media_player", "play_media")), "spielt den Alarmton", calls("media_player"))
    inn = [c for c in calls("siren", "turn_on") if c[2]["entity_id"] == "siren.innen"]
    ok(inn and inn[0][2].get("volume_level") == 0.6 and inn[0][2].get("duration") == 5, "Sirene mit volume_level und duration", inn)
    alt = [c for c in calls("siren", "turn_on") if c[2]["entity_id"] == "siren.alt"]
    ok(alt and "volume_level" not in alt[0][2] and "duration" not in alt[0][2], "Sirene ohne Fähigkeiten: nur an", alt)
    ok(any(c[2]["entity_id"] == "switch.sirene_garage" for c in calls("homeassistant", "turn_on")), "Schalter-Sirene an", calls("homeassistant"))
    ok(later and later[0][0] == 5, "Stopp-Timer im Backend nach 5 s", later)
    ok(alarm._test and alarm._test["volume"] == 60, "Zustand des Tests gemerkt", alarm._test)
    ok(not notified, "keine Nachricht, keine Durchsage, keine Zusatzgeräte", notified)
    ok(alarm.state == "disarmed", "Alarmzustand unverändert", alarm.state)
    ok(history and "getestet" in history[-1][1], "Verlauf: Sirene getestet", history)

    print("Lautstärke live")
    hass.services.calls.clear()
    await alarm.siren_test(5, 90)
    ok(abs(calls("media_player", "volume_set")[0][2]["volume_level"] - 0.9) < 1e-9, "Lautsprecher folgen auf 90 %", calls("media_player"))
    ok(not calls("media_player", "play_media"), "kein Neustart des Tons", calls("media_player"))
    ok([c for c in calls("siren", "turn_on") if c[2]["entity_id"] == "siren.innen"][0][2] == {"entity_id": "siren.innen", "volume_level": 0.9}, "Sirene folgt", calls("siren"))
    ok(len(later) == 1, "Zeit läuft weiter (kein zweiter Timer)", later)

    print("Zeit um")
    hass.services.calls.clear()
    _delay, cb = later.pop(0)  # fired: HA forgets a timer once it ran
    cb(None)
    for _ in range(5):
        await asyncio.sleep(0)
    ok({c[2]["entity_id"] for c in calls("media_player", "media_stop")} == {"media_player.kueche", "media_player.flur"}, "Lautsprecher gestoppt", calls("media_player"))
    back = {c[2]["entity_id"]: c[2]["volume_level"] for c in calls("media_player", "volume_set")}
    ok(back == {"media_player.kueche": 0.25, "media_player.flur": 0.4}, "vorige Lautstärke zurück", back)
    ok({c[2]["entity_id"] for c in calls("siren", "turn_off")} == {"siren.innen", "siren.alt"} and calls("homeassistant", "turn_off"), "Sirenen aus", calls())
    ok(alarm._test is None and not later, "Test vorbei", alarm._test, later)

    print("Stopp sofort, höchstens 10 s")
    await alarm.siren_test(60, 50)
    ok(later and later[-1][0] == 10, "länger als 10 s angefragt: 10 s", later)
    hass.services.calls.clear()
    await alarm.siren_test_stop()
    ok(alarm._test is None and not later and calls("media_player", "media_stop"), "Stopp beendet alles, Timer weg", later)

    print("Während eines Alarms kein Test")
    alarm.state = "triggered"
    r = await alarm.siren_test(5, 50)
    ok(r == {"ok": False, "error": "alarm"} and alarm._test is None, "abgelehnt", r)
    alarm.state = "disarmed"

    print("Nichts gewählt")
    saved = (cfg["sound"]["players"], cfg["sirens"])
    cfg["sound"]["players"], cfg["sirens"] = [], []
    r = await alarm.siren_test(5, 50)
    ok(r == {"ok": False, "error": "nothing"}, "abgelehnt", r)
    cfg["sound"]["players"], cfg["sirens"] = saved

    print("Ein echter Alarm übernimmt")
    await alarm.siren_test(5, 50)
    alarm._test_drop()
    ok(alarm._test is None and not later, "Test verworfen ohne Zurückstellen", later)


asyncio.run(main())
print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
