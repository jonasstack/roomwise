"""Offline test of "Wo ist wer" (places.py): three weeks of a made-up everyday life on fictional coordinates.

Clustering of stays into learned places, trip summaries, destination prediction, arrival time, trend.
Runs inside the test container (Home Assistant installed):
  docker cp tools/testha/test_places.py hr-test-ha:/tmp/ && docker exec hr-test-ha python3 /tmp/test_places.py
"""

import random
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, "/config")
from custom_components.roomwise.house_rules import places as P  # noqa: E402

FAIL = []
TZ = ZoneInfo("Europe/Berlin")


def ok(cond, what, extra=""):
    print(("  ok: " if cond else "• FAIL: ") + what, extra if not cond else "")
    if not cond:
        FAIL.append(what)


# fictional map (the test Home Assistant's home is 52.52 / 13.40)
HOME = (52.52, 13.40)
WORK = (52.60, 13.50)
SPORT = (52.55, 13.30)  # no zone: has to be learned
MARKET = (52.50, 13.45)  # no zone: has to be learned
ZONES = {"home": (HOME[0], HOME[1], 100.0, "Zuhause"), "arbeit": (WORK[0], WORK[1], 300.0, "Arbeit")}
rng = random.Random(7)


def zone_of(lat, lon):
    for key, (zl, zo, r, _n) in ZONES.items():
        if P.dist(lat, lon, zl, zo) <= r:
            return key
    return None


class Sim:
    def __init__(self, learner, pid="alex"):
        self.l = learner
        self.tr = P.Track(pid)
        self.pos = HOME
        self.t = 0.0

    def fix(self, lat, lon, speed=None):
        self.pos = (lat, lon)
        self.l.feed(self.tr, self.t, lat, lon, 15.0, zone_of(lat, lon), speed)

    def stay(self, minutes, every=6):
        """Resting: a fix now and then, a few metres of jitter."""
        end = self.t + minutes * 60
        base = self.pos
        while self.t < end:
            self.fix(base[0] + rng.uniform(-0.0002, 0.0002), base[1] + rng.uniform(-0.0002, 0.0002))
            self.t += every * 60
            self.l.tick(self.tr, self.t)
        self.pos = base
        self.t = end

    def drive(self, dest, minutes, until=None):
        """A fix every ~90 s along a slightly bent line; until = stop after that many minutes (still under way)."""
        a = self.pos
        steps = max(2, int(minutes * 60 / 90))
        v = P.dist(a[0], a[1], dest[0], dest[1]) / (minutes * 60)
        for i in range(1, steps + 1):
            if until is not None and i * minutes / steps > until:
                return
            f = i / steps
            bend = 0.004 * (1 - abs(2 * f - 1))
            self.t += minutes * 60 / steps
            self.fix(a[0] + (dest[0] - a[0]) * f + bend, a[1] + (dest[1] - a[1]) * f, v)


def at(day, hh, mm=0):
    return datetime(2026, 9, 7, tzinfo=TZ).timestamp() + day * 86400 + hh * 3600 + mm * 60  # day 0 = a Monday


def live_day(sim, day):
    wd = (day) % 7
    sim.t = at(day, 0)
    sim.pos = HOME
    if wd < 5:
        sim.stay((7 * 60 + 30 + rng.uniform(-10, 10)) - 0, every=30)
        sim.drive(WORK, 25 + rng.uniform(-3, 3))
        sim.stay(17 * 60 - (sim.t - at(day, 0)) / 60, every=20)
        if wd in (1, 3):
            sim.drive(SPORT, 20 + rng.uniform(-2, 2))
            sim.stay(90, every=7)
            sim.drive(HOME, 15 + rng.uniform(-2, 2))
        else:
            sim.drive(HOME, 25 + rng.uniform(-3, 3))
    elif wd == 5:
        sim.stay(10 * 60, every=30)
        sim.drive(MARKET, 12)
        sim.stay(60, every=8)
        sim.drive(HOME, 12)
    sim.stay(24 * 60 - (sim.t - at(day, 0)) / 60, every=40)


learner = P.Learner({}, ZONES, TZ)
sim = Sim(learner)
for d in range(21):
    live_day(sim, d)

places = learner.data["places"]
learned = [p for p in places if p["visits"] >= P.LEARNED_VISITS]
near = lambda p, x: P.dist(p["lat"], p["lon"], x[0], x[1])  # noqa: E731
sport = next((p for p in learned if near(p, SPORT) < 150), None)
market = next((p for p in learned if near(p, MARKET) < 150), None)
ok(sport is not None and sport["visits"] >= 5, "Sport gelernt (6 Besuche in 3 Wochen)", [(round(near(p, SPORT)), p["visits"]) for p in places])
ok(market is not None and market["visits"] == 3, "Markt gelernt (3 Samstage)", [(round(near(p, MARKET)), p["visits"]) for p in places])
ok(not any(near(p, WORK) < 400 or near(p, HOME) < 200 for p in places), "keine gelernten Orte in Zonen (Arbeit/Zuhause)", places)
ok(len(learned) == 2, "genau zwei gelernte Orte", [(p["id"], p["visits"]) for p in learned])
ok(sport and learner.typical(sport)["days"] == "workdays" and learner.typical(sport)["arrive"] in ("17:00", "16:00"), "typische Zeiten: werktags gegen 17 Uhr", sport and learner.typical(sport))

trips = learner.data["trips"]["alex"]
count = lambda o, d: sum(1 for t in trips if t["o"] == o and t["d"] == d)  # noqa: E731
ok(count("home", "arbeit") == 15, "15 Wege Zuhause → Arbeit", count("home", "arbeit"))
ok(sport and count("arbeit", sport["id"]) == 6 and count(sport["id"], "home") == 6, "6× Arbeit → Sport → Zuhause", sport and (count("arbeit", sport["id"]), count(sport["id"], "home")))
ok(count("arbeit", "home") == 9, "9× Arbeit → Zuhause", count("arbeit", "home"))
w2h = [t["dur"] for t in trips if t["o"] == "arbeit" and t["d"] == "home"]
ok(all(19 <= d <= 31 for d in w2h), "Dauer Arbeit → Zuhause gelernt (22–28 Min.)", w2h)
ok(all(t.get("b") is not None for t in trips), "Startrichtung jedes Wegs bekannt")
ok(not any("lat" in t or "track" in t for t in trips), "keine Spur gespeichert, nur Zusammenfassungen", trips[0])

# --- predictions on day 21 (Monday) … 23
# Monday morning, 6 min after leaving home → work
sim.t = at(21, 7, 30)
sim.pos = HOME
sim.stay(1, every=1)
sim.drive(WORK, 25, until=6)
p = learner.predict(sim.tr, sim.t)
ok(p and p["destination"] == "arbeit" and p["probability"] >= 0.6, "Montagmorgen: wahrscheinlich zur Arbeit", p)
ok(p and 12 <= p["eta_min"] <= 25, "Ankunft Arbeit ca. 19 Min.", p)
st = learner.status(sim.tr, sim.t)
ok(st["kind"] == "moving" and st["since"] == sim.tr.left_at and 120 <= sim.t - st["since"] <= 360, "unterwegs seit dem Verlassen der Zone (3–6 Min.)", (st, sim.t))
sim.drive(WORK, 19)
sim.stay(17 * 60 - (sim.t - at(21, 0)) / 60, every=20)
ok(learner.status(sim.tr, sim.t)["kind"] == "zone" and learner.status(sim.tr, sim.t)["key"] == "arbeit", "bei der Arbeit (Zone)")

# Tuesday 17:00: heading for sport
sim.t = at(22, 17, 0)
sim.pos = WORK
sim.tr.zone, sim.tr.node = "arbeit", "arbeit"
sim.l.feed(sim.tr, sim.t, WORK[0], WORK[1], 15, "arbeit")
sim.drive(SPORT, 20, until=7)
p = learner.predict(sim.tr, sim.t)
ok(p and sport and p["destination"] == sport["id"] and p["probability"] >= 0.5, "Dienstag 17 Uhr Richtung Sport", p)

# Wednesday 17:00: heading home, halfway
learner2_trips = len(learner.data["trips"]["alex"])
sim.t = at(23, 17, 0)
sim.tr = P.Track("alex")
sim.pos = WORK
sim.l.feed(sim.tr, sim.t - 4 * 3600, WORK[0], WORK[1], 15, "arbeit")
sim.l.tick(sim.tr, sim.t)
sim.l.feed(sim.tr, sim.t, WORK[0], WORK[1], 15, "arbeit")
sim.drive(HOME, 25, until=12.5)
p = learner.predict(sim.tr, sim.t)
ok(p and p["destination"] == "home" and p["probability"] >= 0.6, "Mittwoch 17 Uhr: wahrscheinlich nach Hause", p)
ok(p and 8 <= p["eta_min"] <= 17, "halber Weg: ca. 12 Min. bis zuhause", p)
ok(sim.tr.trend == "closer", "kommt näher", sim.tr.trend)
ok(len(learner.data["trips"]["alex"]) == learner2_trips, "unterwegs: noch kein Weg gespeichert")
sim.drive(HOME, 12.5)
sim.stay(15, every=5)
ok(learner.status(sim.tr, sim.t)["key"] == "home" and len(learner.data["trips"]["alex"]) == learner2_trips + 1, "angekommen: ein Weg mehr")
tl = sim.tr.timeline
ok([e["k"] for e in tl[-3:]] == ["stay", "trip", "stay"] and tl[-2]["o"] == "arbeit" and tl[-2]["d"] == "home" and tl[-1]["b"] is None, "Tagesverlauf: Arbeit → Weg → Zuhause", tl[-3:])

# --- nothing learned yet: only the direction says something
fresh = P.Learner({}, ZONES, TZ)
s2 = Sim(fresh, "sam")
s2.t = at(0, 12)
s2.pos = (52.60, 13.30)
s2.fix(*s2.pos)
s2.drive(HOME, 20, until=8)
p = fresh.predict(s2.tr, s2.t)
ok(p and p["destination"] == "home" and p["basis"] == "direction" and 0.5 <= p["probability"] <= 0.75, "ohne Gelerntes: Richtung Zuhause", p)
s2.t += 1
s3 = Sim(P.Learner({}, ZONES, TZ), "kim")
s3.t = at(0, 12)
s3.pos = (52.53, 13.41)
s3.fix(*s3.pos)
s3.drive((52.60, 13.30), 20, until=8)
ok(s3.l.predict(s3.tr, s3.t) is None and s3.tr.trend == "away", "entfernt sich: keine Vorhersage", (s3.l.predict(s3.tr, s3.t), s3.tr.trend))

# one stay at an unknown spot: candidate, not a learned place
one = [p for p in fresh.data["places"]]
s2.drive((52.51, 13.38), 3)
s2.stay(30, every=5)
s2.drive(HOME, 5)
ok(len(fresh.data["places"]) == len(one) + 1 and fresh.data["places"][-1]["visits"] == 1, "einmal angehalten: nur Kandidat (1 Besuch)", fresh.data["places"])

# a silent phone while resting: stay is confirmed on departure
s4 = Sim(P.Learner({}, ZONES, TZ), "lou")
s4.t = at(1, 9)
s4.pos = (52.45, 13.35)
s4.fix(*s4.pos)
s4.t += 3600  # an hour without a fix
s4.drive(HOME, 15)
s4.stay(15)
ok(len(s4.l.data["places"]) == 1 and s4.l.data["trips"]["lou"][-1]["d"] == "home", "stummes Handy beim Warten: Aufenthalt erkannt", (s4.l.data["places"], s4.l.data["trips"]))

ok(P._short_address("Hauptstraße 12, 12345 Musterstadt, Deutschland") == "Hauptstraße 12", "Adresse kürzen (Komma)")
ok(P._short_address("Musterweg 3\n12345 Musterstadt\nDeutschland") == "Musterweg 3", "Adresse kürzen (Zeilen)")

# --- how somebody travels
D = P.detect_mode
ok(D(None, "in_vehicle")["mode"] == "car" and D(None, "in_vehicle")["basis"] == "activity", "Android in_vehicle → Auto")
ok(D(4.0, "on_bicycle")["mode"] == "bike" and D(None, "Cycling")["mode"] == "bike", "Fahrrad (Android/iOS)")
ok(D(1.2, "walking")["mode"] == "walk" and D(None, "Walking")["mode"] == "walk" and D(2.5, "running")["mode"] == "walk", "zu Fuß (walking/Walking/running)")
ok(D(None, "Automotive")["mode"] == "car", "iOS Automotive → Auto")
ok(D(None, "still")["mode"] is None and D(None, "Stationary")["mode"] is None and D(None, None)["mode"] is None, "still / Stationary / nichts: unterwegs ohne Art")
ok(D(20.0, "walking")["mode"] == "car" and D(20.0, "walking")["basis"] == "speed", "Aktivität passt nicht zum Tempo (72 km/h, 'walking'): Tempo zählt")
ok(D(12.0, None, "bike")["mode"] == "bike" and D(12.0, None, "bike")["basis"] == "vehicle", "Fahrzeug-Tracker fährt mit → dessen Art")
ok(D(1.2)["mode"] == "walk" and D(4.0)["mode"] is None and D(15.0)["mode"] == "car", "nur das Tempo (ohne Verlauf): 4 km/h zu Fuß, 14 km/h unklar (kein „Rad“ geraten), 54 km/h Auto")


def trip(mps):
    """fixes 60 s apart going north with these speeds (m/s)"""
    out, lat = [(0.0, 52.0, 13.0)], 52.0
    for i, v in enumerate(mps, 1):
        lat += v * 60 / 111320
        out.append((i * 60.0, lat, 13.0))
    return out


city = trip([4, 7, 2, 13, 5, 14, 3, 8])  # Stadtverkehr: Ampeln, Schnitt ≈ 20 km/h, kurz über 45 km/h
ok(D(7.0, None, None, city)["mode"] == "car", "Auto in der Stadt (Schnitt 20 km/h, Spitze > 40) → Auto, nicht Rad", D(7.0, None, None, city))
bike = trip([4.5, 5.2, 4.8, 6.0, 5.5, 4.2])  # 15–22 km/h gleichmäßig
ok(D(5.0, None, None, bike)["mode"] == "bike", "gleichmäßig 15–22 km/h, nie schneller → Rad", D(5.0, None, None, bike))
walk = trip([1.3, 1.4, 1.2, 1.5])
ok(D(1.3, None, None, walk)["mode"] == "walk", "1,4 m/s → zu Fuß")
stop = trip([4.5, 0.5, 5.0, 0.4, 6.0])  # Rad mit Ampelstopps
ok(D(3.0, None, None, stop)["mode"] == "bike", "Rad mit Ampelstopps, nie über 30 km/h → Rad", D(3.0, None, None, stop))
mixed = trip([2.0, 9.0, 1.5])  # zu wenig, um es zu sagen
ok(D(4.0, None, None, mixed)["mode"] is None, "zu wenig gleichmäßige Abschnitte: unklar statt Rad", D(4.0, None, None, mixed))
jump = trip([1.3, 1.4, 30.0, 1.2])  # ein GPS-Sprung
ok(D(1.3, None, None, jump)["mode"] == "walk", "ein einzelner GPS-Sprung macht kein Auto", D(1.3, None, None, jump))
ok(D(1.2)["confidence"] < D(1.2, "walking")["confidence"], "Tempo allein ist unsicherer als der Handy-Sensor")
line = [(i * 60.0, 52.0 + i * 0.025, 13.0) for i in range(8)]  # ~2.8 km/min straight north = 167 km/h
ok(D(46.0, None, None, line)["mode"] == "transit", "sehr schnell und schnurgerade: Bahn", D(46.0, None, None, line))
zig = [(i * 60.0, 52.0 + i * 0.025, 13.0 + (0.03 if i % 2 else 0)) for i in range(8)]
ok(D(46.0, None, None, zig)["mode"] == "car", "sehr schnell, aber kurvig: Auto")
ok(D(46.0, "in_vehicle", None, line)["mode"] == "transit" and D(46.0, "in_vehicle", "car", line)["mode"] == "car", "in_vehicle + Bahnstrecke: Bahn, außer das eigene Auto fährt mit")
# the arrival time follows the mode when no speed is known
w = P.Learner({}, ZONES, TZ)
s5 = Sim(w, "pat")
s5.t = at(2, 10)
s5.pos = (52.53, 13.40)
w.feed(s5.tr, s5.t - 900, 52.535, 13.40, 15, None)
w.feed(s5.tr, s5.t, 52.53, 13.40, 15, None)
s5.tr.trend = "closer"
s5.tr.left_at = s5.t - 900
pw, pc = w.predict(s5.tr, s5.t, "walk"), w.predict(s5.tr, s5.t, "car")
ok(pw and pc and pw["eta_min"] > 2 * pc["eta_min"], "zu Fuß dauert der Heimweg länger als mit dem Auto", (pw, pc))
# between two positions the person goes on: the arrival counts down from the last one
p0 = w.predict(s5.tr, s5.t, "walk")
p5 = w.predict(s5.tr, s5.t + 300, "walk")
ok(p0 and p5 and p5["arrive_at"] == p0["arrive_at"] and p5["eta_min"] == p0["eta_min"] - 5 and p5["as_of"] == round(s5.t), "5 Min. ohne neue Position: Ankunft gleich, Restzeit 5 Min. weniger", (p0, p5))
pl = w.predict(s5.tr, s5.t + 3 * 3600, "walk")
ok(pl and pl["eta_min"] == 1, "Ankunftszeit vorbei, noch unterwegs: 1 Min. (gleich da)", pl)

# ---------------------------------------------------------------- names of places (made-up spots only)
print("Ortsnamen statt „Gelernter Ort“")
G = P.geo_name
ios_poi = {"Name": "Stadthalle", "Areas Of Interest": ["Stadthalle"], "Thoroughfare": "Beispielweg", "Sub Thoroughfare": "3", "Locality": "Musterstadt", "Sub Locality": "Nordviertel", "Postal Code": "12345"}
ok(G("Beispielweg 3\n12345 Musterstadt", ios_poi) == ("Stadthalle Nordviertel", P.GEO_POI), "iOS Ort von Interesse: „<Name> <Ortsteil>“", G("", ios_poi))
ios_shop = {"Name": "Supermarkt Sonnenschein", "Areas Of Interest": "N/A", "Thoroughfare": "Beispielweg", "Sub Thoroughfare": "8", "Locality": "Musterstadt"}
ok(G("", ios_shop) == ("Supermarkt Sonnenschein Musterstadt", P.GEO_POI), "Geschäft ohne Ortsteil: „<Name> <Ort>“", G("", ios_shop))
ios_addr = {"Name": "Beispielweg 12", "Thoroughfare": "Beispielweg", "Sub Thoroughfare": "12", "Locality": "Musterstadt", "Areas Of Interest": "N/A"}
ok(G("", ios_addr) == ("Beispielweg 12, Musterstadt", P.GEO_ADDRESS), "nur Adresse (Name = Straße): „<Straße Nr>, <Ort>“", G("", ios_addr))
android = {"feature_name": "12", "thoroughfare": "Beispielweg", "sub_thoroughfare": "12", "locality": "Musterstadt", "postal_code": "12345"}
ok(G("Beispielweg 12, 12345 Musterstadt, Deutschland", android) == ("Beispielweg 12, Musterstadt", P.GEO_ADDRESS), "Android (feature_name = Hausnummer): Adresse", G("", android))
ok(G("", {"Locality": "Musterstadt"}) == ("Musterstadt", P.GEO_TOWN), "nur der Ort")
ok(G("Beispielweg 12, 12345 Musterstadt", {}) == ("Beispielweg 12", P.GEO_ADDRESS), "ohne Attribute: erste Zeile der Adresse")
ok(G("unknown", {}) is None, "nichts bekannt: kein Name")
ok(G("", {"Name": "Musterstadt", "Locality": "Musterstadt"}) == ("Musterstadt", P.GEO_TOWN), "Name = Ort ist kein Ort von Interesse")
N = P.nominatim_name
ok(N({"name": "Stadthalle", "address": {"road": "Beispielweg", "house_number": "3", "suburb": "Nordviertel", "town": "Musterstadt"}}) == ("Stadthalle Nordviertel", P.GEO_POI), "OpenStreetMap: Ort von Interesse mit Ortsteil")
ok(N({"name": "", "address": {"road": "Beispielweg", "house_number": "3", "town": "Musterstadt"}}) == ("Beispielweg 3, Musterstadt", P.GEO_ADDRESS), "OpenStreetMap: Adresse")
ok(N({"name": "Beispielweg", "address": {"road": "Beispielweg", "city": "Musterstadt"}}) == ("Beispielweg, Musterstadt", P.GEO_ADDRESS), "OpenStreetMap: Straße als Name ist keine Sehenswürdigkeit")
ok(P.place_label({"name": "Training", "auto": "Stadthalle Nordviertel"}) == "Training", "Name von Hand gewinnt")
ok(P.place_label({"auto": "Stadthalle Nordviertel", "street": "Beispielweg 3"}) == "Stadthalle Nordviertel", "Ortsname vor Straße")
ok(P.place_label({}) == "Gelernter Ort", "nichts bekannt: „Gelernter Ort“")
ok(P._cached("Beispielweg 3") == ("Beispielweg 3", P.GEO_ADDRESS) and P._cached({"n": "X", "k": 3}) == ("X", 3), "alter Zwischenspeicher (nur Straße) bleibt lesbar")

# a person stays at a learned place: the place takes over the name of the spot
from types import SimpleNamespace  # noqa: E402


class FakeState:
    def __init__(self, state, attrs, t):
        self.state, self.attributes = state, attrs
        self.last_updated = SimpleNamespace(timestamp=lambda: t)


def places_with(learner, geo_state, tasks):
    pl = object.__new__(P.Places)
    pl.learner = learner
    pl.tracks = {}
    pl._geo = {"pat": "sensor.phone_geocoded_location" if geo_state else None}
    pl._street = {}
    pl.data = {"settings": {"learn": True, "nominatim": False}, "geocache": {}}
    states = {"sensor.phone_geocoded_location": geo_state} if geo_state else {}
    pl.hass = SimpleNamespace(states=SimpleNamespace(get=states.get), async_create_background_task=lambda *a, **k: tasks.append(a))
    return pl


L2 = P.Learner({}, ZONES, TZ)
s6 = Sim(L2, "pat")
spot = (52.555, 13.31)
for i in range(4):  # three visits make it a learned place, the fourth is now
    s6.t = at(10 + i, 17)
    s6.pos = HOME
    s6.fix(*HOME)
    s6.stay(30)
    s6.drive(spot, 15)
    s6.stay(60)
    if i < 3:
        s6.drive(HOME, 15)
        s6.stay(30)
key = s6.tr.node
place = L2.place(key)
ok(bool(key and key.startswith("lp_") and place), "gelernter Ort entsteht", key)
tasks = []
pl = places_with(L2, FakeState("Beispielweg 3", ios_poi, s6.t), tasks)
pl.tracks = {"pat": s6.tr}
pl._name_place("pat")
ok(place.get("auto") == "Stadthalle Nordviertel" and P.place_label(place) == "Stadthalle Nordviertel", "Besuch: der Ort heißt wie der Ort von Interesse", place.get("auto"))
pl.hass.states.get("sensor.phone_geocoded_location").attributes = ios_addr
pl._name_place("pat")
ok(place.get("auto") == "Stadthalle Nordviertel", "eine bloße Adresse ersetzt keinen besseren Namen", place.get("auto"))
place["name"] = "Training"
pl.hass.states.get("sensor.phone_geocoded_location").attributes = ios_shop
pl._name_place("pat")
ok(P.place_label(place) == "Training" and place.get("auto") == "Stadthalle Nordviertel", "Name von Hand: nichts wird überschrieben")
place.pop("name")
old = places_with(L2, FakeState("Beispielweg 3", ios_shop, s6.tr.node_since - 3600), tasks)
old.tracks = {"pat": s6.tr}
old._name_place("pat")
ok(place.get("auto") == "Stadthalle Nordviertel", "Sensor von vor dem Besuch (anderer Ort) benennt nichts")
# in a zone the zone's name counts, the spot's name changes nothing
s6.drive(HOME, 15)
s6.stay(30)
before = dict(place)
pl.hass.states.get("sensor.phone_geocoded_location").attributes = ios_shop
pl._name_place("pat")
ok(s6.tr.node == "home" and pl.label("home") == "Zuhause" and place == before, "in einer Zone gilt der Zonenname, kein Ort wird umbenannt", s6.tr.node)
# OpenStreetMap off: no request
off = places_with(L2, None, tasks)
s7 = Sim(L2, "pat")
s7.tr.stay = {"lat": 52.7, "lon": 13.7, "n": 3, "since": s6.t, "last": s6.t + 600}
off.tracks = {"pat": s7.tr}
off._stopped("pat", s7.tr)
ok(not tasks, "OpenStreetMap aus: keine Anfrage ins Internet")
off.data["settings"]["nominatim"] = True
off._stopped("pat", s7.tr)
ok(len(tasks) == 1, "OpenStreetMap an, Handy ohne Ortsnamen: eine Anfrage")
withgeo = places_with(L2, FakeState("x", ios_poi, s6.t), tasks)
withgeo.data["settings"]["nominatim"] = True
withgeo._stopped("pat", s7.tr)
ok(len(tasks) == 1, "Handy liefert Ortsnamen: OpenStreetMap wird nicht gefragt")

print(f"\n{len(FAIL)} Fehler" if FAIL else "\nalles ok")
sys.exit(1 if FAIL else 0)
