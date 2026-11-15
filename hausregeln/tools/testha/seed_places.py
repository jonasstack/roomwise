"""Seeds three weeks of made-up person history into the test Home Assistant's recorder (fictional coordinates).

Used by test-places.mjs before `house_rules/places/relearn`. Runs inside the test container:
  docker cp tools/testha/seed_places.py hr-test-ha:/tmp/ && docker exec hr-test-ha python3 /tmp/seed_places.py person.robin_beispiel
Every day: home → work (zone "Arbeit") in the morning, back in the afternoon; every few evenings to a sports ground
(no zone, to be learned). Rows end two hours ago, so they never mix with live ones.
"""

import json
import random
import sqlite3
import sys
import time

DB = "/config/home-assistant_v2.db"
ENTITY = sys.argv[1] if len(sys.argv) > 1 else "person.robin_beispiel"
HOME = (52.52, 13.40)
WORK = (52.60, 13.50)
SPORT = (52.50, 13.52)
rng = random.Random(3)
rows: list[tuple[float, str, float, float]] = []


def drive(t, a, b, minutes):
    steps = max(2, int(minutes / 2))
    for i in range(1, steps + 1):
        f = i / steps
        rows.append((t + minutes * 60 * f, "not_home", a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return t + minutes * 60


def stay(t, where, state, minutes, every):
    end = t + minutes * 60
    while t < end:
        rows.append((t, state, where[0] + rng.uniform(-0.0002, 0.0002), where[1] + rng.uniform(-0.0002, 0.0002)))
        t += every * 60
    return end


now = time.time()
day0 = now - (now % 86400) - 21 * 86400  # 21 days back, midnight UTC
for d in range(21):
    t = day0 + d * 86400
    t = stay(t, HOME, "home", 6 * 60 + 30 + rng.uniform(-20, 20), 60)
    t = drive(t, HOME, WORK, 25 + rng.uniform(-3, 3))
    t = stay(t, WORK, "Arbeit", 8 * 60 + rng.uniform(-20, 20), 30)
    t = drive(t, WORK, HOME, 25 + rng.uniform(-3, 3))
    if d % 4 == 1:
        t = stay(t, HOME, "home", 90, 30)
        t = drive(t, HOME, SPORT, 15)
        t = stay(t, SPORT, "not_home", 60, 6)
        t = drive(t, SPORT, HOME, 15)
    stay(t, HOME, "home", 60, 30)
rows = [r for r in rows if r[0] < now - 7200]

con = sqlite3.connect(DB, timeout=30)
cur = con.cursor()
row = cur.execute("SELECT metadata_id FROM states_meta WHERE entity_id = ?", (ENTITY,)).fetchone()
if row is None:
    cur.execute("INSERT INTO states_meta (entity_id) VALUES (?)", (ENTITY,))
    meta = cur.lastrowid
else:
    meta = row[0]
# start over for this entity (the test may run more than once)
cur.execute("DELETE FROM states WHERE metadata_id = ? AND last_updated_ts < ?", (meta, now - 7200))
cols = {r[1] for r in cur.execute("PRAGMA table_info(states)")}
name = ENTITY.split(".")[1].replace("_", " ").title()
for t, state, lat, lon in rows:
    attrs = json.dumps({"latitude": round(lat, 6), "longitude": round(lon, 6), "gps_accuracy": 10, "source": "device_tracker.handy_robin", "friendly_name": name}, separators=(",", ":"))
    cur.execute("INSERT INTO state_attributes (hash, shared_attrs) VALUES (?, ?)", (rng.getrandbits(31), attrs))
    aid = cur.lastrowid
    values = {"metadata_id": meta, "state": state, "attributes_id": aid, "last_updated_ts": t, "last_changed_ts": t, "last_reported_ts": t, "origin_idx": 0}
    use = {k: v for k, v in values.items() if k in cols}
    cur.execute(f"INSERT INTO states ({', '.join(use)}) VALUES ({', '.join('?' * len(use))})", tuple(use.values()))  # noqa: S608
con.commit()
con.close()
print(json.dumps({"rows": len(rows), "metadata_id": meta}))
