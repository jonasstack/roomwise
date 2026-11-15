"""One person selection: the alarm follows "Wer wohnt hier?" and keeps its own list only as a deviation. Checks the
one-time migration of the old separate alarm selection (needs Home Assistant, so it runs inside the test HA container):
    docker exec -i hr-test-ha python3 - < tools/testha/test_presence.py
"""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG_DIR", "/config"))  # CI: a folder whose custom_components/ holds house_rules
from custom_components.house_rules.alarm import Alarm, default_config  # noqa: E402

fails = 0


def ok(c, m):
    global fails
    fails += not c
    print("  ok:" if c else "• FAIL:", m)


def alarm_with(presence, residents):
    """An alarm on a fake core: `residents` = ids of the persons that count (inventory.persons)."""
    cfg = default_config()
    cfg["presence"] = presence
    saved = []
    core = SimpleNamespace(
        data={"alarm": cfg},
        inventory=SimpleNamespace(persons={pid: {"id": pid, "entity_id": f"person.{pid}", "name": pid} for pid in residents}),
        save=lambda: saved.append(1),
    )
    return Alarm(SimpleNamespace(), core), saved


a, saved = alarm_with({"persons": ["alex", "kim"]}, ["alex", "kim"])
a.migrate_presence()
p = a.config["presence"]
ok(p["persons"] == "everyone" and p.get("v") == 2 and saved, "alte Liste mit allen Bewohnern → folgt „Wer wohnt hier?“")

a, _ = alarm_with({"persons": ["alex"]}, ["alex", "kim"])
a.migrate_presence()
ok(a.config["presence"]["persons"] == ["alex"], "echte Abweichung bleibt als Ausnahme für die Alarmanlage")

a, _ = alarm_with({"persons": ["alex", "gast"]}, ["alex", "kim"])
a.migrate_presence()
ok(a.config["presence"]["persons"] == ["alex"], "Personen, die keine Bewohner (mehr) sind, fallen heraus")

a, saved = alarm_with({"persons": ["alex"]}, [])
a.migrate_presence()
ok(a.config["presence"].get("v") is None and not saved, "Personen noch nicht geladen (Start von HA): wartet, ändert nichts")

a, _ = alarm_with({"persons": "everyone"}, ["alex"])
a.migrate_presence()
ok(a.config["presence"] == {"persons": "everyone", "v": 2}, "„alle“ bleibt „wie die Bewohner“")

a, _ = alarm_with({"persons": ["alex"], "v": 2}, ["alex", "kim"])
a.migrate_presence()
ok(a.config["presence"]["persons"] == ["alex"], "läuft nur einmal: spätere Abweichung bleibt")

ok("v" not in default_config()["presence"], "Vorgabe ohne Markierung (sonst würde das Auffüllen alte Daten als umgestellt markieren)")

print("alles ok" if not fails else f"{fails} FEHLER")
sys.exit(1 if fails else 0)
