""""Kurz daheim" (smart heating): a usual stay of at most the set hours gets the lower temperature, a long one the
comfort temperature; bathrooms and halls are left alone; the room's setting is checked when saved.
Needs Home Assistant (imports), so it runs inside the test HA container:
    docker exec -i hr-test-ha python3 - < tools/testha/test_short_stay.py
"""

import os
import sys
from datetime import datetime

sys.path.insert(0, os.environ.get("HA_CONFIG_DIR", "/config"))

from custom_components.house_rules import smart_heat as S  # noqa: E402
from custom_components.house_rules.habits import SLOT, SLOTS  # noqa: E402

fails = 0


def ok(c, m, *extra):
    global fails
    if not c:
        fails += 1
    print(("  ok: " if c else "• FAIL: ") + m, *([] if c else extra))


probs = [0.0] * SLOTS
for i in range(7 * 60 // SLOT, 8 * 60 // SLOT):  # 07:00–08:00 breakfast
    probs[i] = 0.8
for i in range(18 * 60 // SLOT, 19 * 60 // SLOT + 2):  # 18:00–19:30 home briefly in the evening
    probs[i] = 0.7
for i in range(9 * 60 // SLOT, 14 * 60 // SLOT):  # 09:00–14:00 working at home
    probs[i] = 0.9

sh = S.SmartHeating.__new__(S.SmartHeating)
sh.day_probs = lambda rid, day: (probs, None)
kinds = {"wz": "normal", "bad": "short"}
sh.kind = lambda rid: kinds[rid]
st = {"threshold": 0.5}
p = {"smart": {"short": {"on": True, "temp": 19.0, "hours": 2.0}}}
at = lambda h, m=0: datetime(2026, 11, 16, h, m)

ok(sh.stay("wz", p, at(18, 30), st) == (18 * 60, 19 * 60 + 30), "Aufenthalt 18:00–19:30 erkannt", sh.stay("wz", p, at(18, 30), st))
ok(sh.short_stay("wz", p, at(18, 30), st) == (19.0, "18:00", "19:30"), "abends 1,5 Std. da → höchstens 19 °C", sh.short_stay("wz", p, at(18, 30), st))
ok(sh.short_stay("wz", p, at(7, 15), st) is not None, "Frühstück (1 Std.) → kurz daheim")
ok(sh.short_stay("wz", p, at(10), st) is None, "5 Std. am Stück → volle Wohlfühltemperatur")
ok(sh.short_stay("wz", p, at(16), st) is None, "niemand da → nicht „kurz daheim“")
ok(sh.short_stay("bad", p, at(7, 15), st) is None, "Bad: eigene kurze Fenster, „kurz daheim“ gilt nicht")
ok(sh.short_stay("wz", {"smart": {"short": {"on": False, "temp": 19.0, "hours": 2.0}}}, at(18, 30), st) is None, "aus → nichts ändert sich")
ok(sh.short_stay("wz", {"smart": {"short": {"on": True, "temp": 19.0, "hours": 1.0}}}, at(18, 30), st) is None, "„bis 1 Std.“: 1,5 Std. sind nicht kurz")

cur = S.default_room()
ok(cur["short"] == {"on": False, "temp": 19.5, "hours": 2.0}, "Standard: aus, 19,5 °C, bis 2 Std.", cur["short"])
c = S.clean_room({"short": {"on": True, "temp": 40, "hours": 9}}, cur)
ok(c["short"] == {"on": True, "temp": 25, "hours": 4}, "Werte werden begrenzt (höchstens 25 °C, 4 Std.)", c["short"])
c = S.clean_room({"short": {"temp": 18.5}}, c)
ok(c["short"]["on"] is True and c["short"]["temp"] == 18.5, "Teiländerung behält den Rest", c["short"])

print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
