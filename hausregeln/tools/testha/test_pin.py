"""PIN hashing of the alarm (needs Home Assistant, so it runs inside the test HA container):
    docker exec -i hr-test-ha python3 - < tools/testha/test_pin.py
"""

import hashlib
import os
import sys

sys.path.insert(0, os.environ.get("HA_CONFIG_DIR", "/config"))  # CI: a folder whose custom_components/ holds house_rules
from custom_components.house_rules.alarm import _hash, _new_hash, _verify  # noqa: E402

fails = 0


def ok(c, m):
    global fails
    fails += not c
    print("  ok:" if c else "• FAIL:", m)


h = _new_hash("1234")
parts = h.split("$")
ok(parts[0] == "pbkdf2" and int(parts[1]) >= 100_000 and len(bytes.fromhex(parts[2])) == 16, "neues Format: PBKDF2-SHA256, ≥100 000 Runden, 16 Byte Salz")
ok(_new_hash("1234") != h, "gleiche PIN → anderer Hash (Salz)")
ok(_verify("1234", h) == (True, False), "neues Format: richtige PIN, kein Umbau nötig")
ok(_verify("1235", h) == (False, False), "neues Format: falsche PIN")
old = hashlib.sha256(b"house_rules:1234").hexdigest()
ok(old == _hash("1234"), "altes Format wie bisher")
ok(_verify("1234", old) == (True, True), "altes Format wird noch angenommen und soll umgebaut werden")
ok(_verify("0000", old) == (False, False), "altes Format: falsche PIN")
ok(_verify("1234", "pbkdf2$x$y$z") == (False, False), "kaputter Hash → falsch, kein Absturz")
print("alles ok" if not fails else f"{fails} FEHLER")
sys.exit(1 if fails else 0)
