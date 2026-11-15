"""Offline test of the smart heating maths (heat_model.py): learning the room, setback worth it, guardrails,
ramp and the valve controller against a simulated room. Needs no Home Assistant:
  python3 tools/testha/test_heat_model.py
"""

import importlib.util
import pathlib
import random

spec = importlib.util.spec_from_file_location("heat_model", pathlib.Path(__file__).resolve().parents[3] / "custom_components/roomwise/house_rules/heat_model.py")
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

FAIL = []


def ok(cond, what, extra=""):
    print(("  ok: " if cond else "• FAIL: ") + what, "" if cond else extra)
    if not cond:
        FAIL.append(what)


def room(temp, tout, u, hours, k_l=0.08, k_h=3.0, dt=1 / 60):
    """the 'real' room: integrate dT/dt = k_h·u − k_l·(T − T_out)"""
    t = 0.0
    while t < hours - 1e-9:
        temp += (k_h * u - k_l * (temp - tout)) * dt
        t += dt
    return temp


print("# learn the room from intervals")
rnd = random.Random(4)
m = M.RoomModel.from_dict(None)
temp, tout = 18.0, 4.0
for i in range(40):
    u = 0.0 if i % 2 else rnd.choice([0.4, 0.7, 1.0])
    hours = rnd.choice([0.5, 0.75, 1.0])
    new = room(temp, tout, u, hours)
    # a real sensor rounds to 0.1 °C
    m.add_interval(0, hours, round(temp, 1), round(new, 1), u, tout)
    temp = new if 14 < new < 24 else 18.0
ok(abs(m.k_l - 0.08) < 0.03, f"Wärmeverlust gelernt: k_l {m.k_l:.3f} (echt 0,08)")
ok(abs(m.k_h - 3.0) < 0.8, f"Heizleistung gelernt: k_h {m.k_h:.2f} (echt 3,0)")
ok(m.confidence == 1.0, "Vertrauen voll nach vielen Proben", m.confidence)
before = m.to_dict()
m.add_interval(0, 1, 20, 35, 1.0, 4)  # 15 °C in one hour: nonsense
m.add_interval(0, 1, 20, 18, 1.0, 4)  # valve open but colder: not the room
m.add_interval(0, 0.05, 20, 21, 1.0, 4)  # 3 minutes: too short
ok(m.to_dict()["k_h"] == before["k_h"] and m.to_dict()["n_h"] == before["n_h"], "unplausible Proben werden verworfen")
m2 = M.RoomModel.from_dict(m.to_dict())
ok(m2.k_l == round(m.k_l, 4) and m2.heat.n == m.heat.n, "speichern und laden")

print("\n# predictions")
mm = M.RoomModel(0.08, 3.0)
h = mm.heat_time(18, 21, 5)
sim = room(18, 5, 1.0, h)
ok(abs(sim - 21) < 0.05, f"Aufheizzeit 18 → 21 °C: {h * 60:.0f} Min. passt zur Simulation ({sim:.2f} °C)")
ok(mm.heat_time(18, 60, 5) == 24.0, "unerreichbar → 24 Std.")
ok(abs(mm.steady_valve(21, 5) - 0.08 * 16 / 3) < 1e-9, "Ventil zum Halten aus dem Modell")

print("\n# setback worth it?")
short = M.setback_plan(mm, 21, 17, 5, 0.5, 21, 1.0, 1.0)
long = M.setback_plan(mm, 21, 17, 5, 8, 21, 1.0, 1.0)
ok(not short["worth"], f"30 Min. weg: lohnt nicht ({short['why']})", short)
ok(long["worth"] and long["saved_kh"] > 5 and long["reheat_h"] > 0, f"8 Std. weg: lohnt ({long['saved_kh']} K·h gespart, wieder heizen {long['reheat_h']} Std. vorher)", long)
ok(long["off_h"] + long["reheat_h"] <= 8 + 1e-6, "rechtzeitig wieder warm")
ok(long["low"] >= 17, "nicht unter die Absenktemperatur", long)
picky = M.setback_plan(mm, 21, 17, 5, 1.5, 21, 1.0, 50)
ok(not picky["worth"] and picky["why"] == "spart zu wenig", "Stil mit hoher Schwelle (Komfort) senkt bei kurzer Pause nicht ab", picky)
ok(not M.setback_plan(mm, 21, 21, 5, 8)["worth"], "Absenkung = Komfort → nichts zu tun")

print("\n# guardrails")
g = {"max": 22, "min": 16, "occupied_min": 19, "max_setback": 4, "never": {"on": True, "from": "23:00", "to": "05:00"}}
t, why = M.apply_guards(24, g, False, 12 * 60)
ok(t == 22 and why[0]["guard"] == "max", "nie über 22 °C", why)
t, why = M.apply_guards(14, g, False, 12 * 60)
ok(t == 16 and why[0]["guard"] == "min", "nie unter 16 °C", why)
t, why = M.apply_guards(21, g, False, 23 * 60 + 30)
ok(t == 16 and why[0]["guard"] == "never", "nachts nie heizen (über die Untergrenze)", why)
t, why = M.apply_guards(17, g, True, 12 * 60)
ok(t == 19 and why[0]["guard"] == "occupied", "jemand im Raum: mindestens 19 °C", why)
t, why = M.apply_guards(21, g, True, 1 * 60)
ok(t == 19, "jemand im Raum geht vor „nie heizen“", t)
t, why = M.apply_guards(20, g, False, 12 * 60)
ok(t == 20 and not why, "innerhalb der Grenzen: nichts geändert")

print("\n# ramp")
ok(M.ramp(18, 0, 21, 0, 0.5, 15) == 18, "Rampe: am Anfang noch nicht höher")
ok(M.ramp(18, 0, 21, 15 * 60, 0.5, 15) == 18.5, "nach 15 Min. +0,5 °C")
ok(M.ramp(18, 0, 21, 10 * 3600, 0.5, 15) == 21, "nie über das Ziel")
ok(M.ramp(21, 0, 17, 60, 0.5, 15) == 17, "runter sofort")
ok(M.ramp(18, 0, 21, 60, 0, 0) == 21, "Schritt 0 = sofort")
ok(M.ramp_hours(3, 0.5, 15) == 1.5, "Rampe dauert 6 Schritte × 15 Min.")

print("\n# valve controller against the simulated room")
for name in ("comfort", "eco", "sport"):
    st = M.style(name)
    pi = M.ValvePI()
    model = M.RoomModel(0.05, 2.5)  # not learned yet: default model, real room differs
    temp, sent, cmds, last_t, top = 17.0, None, 0, -999.0, 0.0
    t = 0.0
    dt = 2 / 60
    while t < 10:
        u = pi.step(model, st, 21, round(temp, 1), 4, dt)
        pct = round(u * 100)
        # sparse like the real controller: deadband and minimum interval
        if sent is None or (abs(pct - sent) >= st["deadband"] and (t - last_t) * 60 >= st["gap"]) or abs(pct - sent) >= 30:
            sent, last_t = pct, t
            cmds += 1
        temp = room(temp, 4, sent / 100, dt, k_l=0.08, k_h=3.0)
        top = max(top, temp)
        t += dt
    # gentle: the valve opens at most the style's opening, so warming up takes longer (preheating starts earlier)
    ok(abs(temp - 21) < 0.5, f"{st['label']}: Raum 17 → {temp:.2f} °C nach 10 Std.")
    ok(top < 21.3, f"{st['label']}: schießt nicht übers Ziel (höchstens {top:.2f} °C)")
    ok(cmds <= 60, f"{st['label']}: nur {cmds} Ventilbefehle in 10 Std.")
    # Eco's 45 % cannot hold 21 °C in this room: it opens a little more, slowly, instead of staying too cold
    ok(sent <= (st["umax"] if name != "eco" else 60), f"{st['label']}: Ventil höchstens {st['umax']} %{' (mehr nur, wenn der Raum sonst kalt bliebe)' if name == 'eco' else ''}", sent)
ok(bool(pi.bias), "gelernt, wie weit das Ventil bei dieser Außentemperatur offen sein muss", pi.to_dict())

print("\n# styles re-scaled (style version 2)")
co, eco, sp = M.style("comfort"), M.style("eco"), M.style("sport")
ok(co["threshold"] == 0.5 and co["depth"] == 4.0 and co["worth_kh"] == 1.0 and co["umax"] == 55, "Komfort = das frühere Eco (Ventil sanfter: höchstens 55 %)", co)
ok(eco["threshold"] > co["threshold"] and eco["depth"] > co["depth"] and eco["worth_kh"] < co["worth_kh"], "Eco: seltener Komfort, tiefer und öfter absenken", eco)
ok(eco["late"] > 0 and eco["margin"] < co["margin"] and eco["uncertain"] > 0 and eco["umax"] < co["umax"], "Eco: später vorheizen, kühler wenn unsicher, langsamer aufheizen", eco)
ok(sp["step"] == 0 and sp["boost"] > 0 and sp["umax"] == 85, "Sportlich bleibt schnell", sp)
ok(M.migrate_style("eco", None) == "comfort" and M.migrate_style("comfort", None) == "comfort" and M.migrate_style("sport", 1) == "sport", "alte Einstellungen: Eco → Komfort (gleiches Verhalten), der Rest bleibt")
ok(M.migrate_style("eco", M.STYLE_VERSION) == "eco", "neue Eco-Wahl bleibt Eco")

print("\n# building inertia as a prior")
leads = {b: M.RoomModel.from_dict(None, prior=M.building(b)).lead(18, 21, 5) for b in ("new", "partial", "old", "floor")}
ok(leads["floor"] > leads["old"] > leads["partial"] > leads["new"], "Vorlauf 18 → 21 °C: Fußbodenheizung > Altbau > teilsaniert > Neubau " + ", ".join(f"{k} {v * 60:.0f} Min." for k, v in leads.items()))
ok(leads["floor"] >= 6 and leads["old"] >= 2.5, "Fußbodenheizung braucht Stunden, Altbau deutlich länger als die Voreinstellung", leads)
ok(M.RoomModel.from_dict(None, prior=M.building("floor")).lag == 1.5, "Fußbodenheizung: reagiert erst nach 1,5 Std.")
learned = {"k_l": 0.08, "k_h": 4.0, "p_c": 0.01, "p_h": 0.1}
m0 = M.RoomModel.from_dict({**learned, "n_c": 0, "n_h": 0}, prior=M.building("old"))
m3 = M.RoomModel.from_dict({**learned, "n_c": 3, "n_h": 3}, prior=M.building("old"))
m6 = M.RoomModel.from_dict({**learned, "n_c": 6, "n_h": 6}, prior=M.building("old"))
ok(abs(m0.k_h - 1.6) < 1e-9 and abs(m3.k_h - 2.8) < 1e-9 and abs(m6.k_h - 4.0) < 1e-9, f"bis genug gelernt ist, zählt die Bauweise mit: k_h {m0.k_h} → {m3.k_h:.1f} → {m6.k_h}")
ok(m6.to_dict()["k_h"] == 4.0, "gespeichert wird nur das Gelernte")
floor = M.RoomModel.from_dict(None, prior=M.building("floor"))
new = M.RoomModel.from_dict(None, prior=M.building("new"))
sf = M.setback_plan(floor, 21, 17, 5, 5, 21, 1.0, 1.0)
sn = M.setback_plan(new, 21, 17, 5, 5, 21, 1.0, 1.0)
ok(not sf["worth"] and sf.get("inert"), f"Fußbodenheizung, 5 Std. Pause: Absenken lohnt nicht ({sf['why']})", sf)
ok(sn["worth"], f"Neubau mit Heizkörpern, 5 Std. Pause: lohnt ({sn['saved_kh']} K·h)", sn)
ok(floor.inert and not new.inert, "träge Räume werden erkannt")


def day_probs(days):
    """fraction of days with activity per quarter hour, smoothed like habits.py (0.6 / 0.2 / 0.2)"""
    raw = [sum(d[s] for d in days) / len(days) for s in range(96)]
    return [0.6 * raw[s] + 0.2 * raw[max(0, s - 1)] + 0.2 * raw[min(95, s + 1)] for s in range(96)]


def old_habits(probs):
    """the algorithm before (plans.py): ≥ 40 % of the days, gaps up to 30 min closed, 30 min earlier"""
    busy = [p >= 0.4 for p in probs]
    out, i = [], 0
    while i < 96:
        if not busy[i]:
            i += 1
            continue
        j = i
        while j < 96 and (busy[j] or (j + 2 < 96 and (busy[j + 1] or busy[j + 2]))):
            j += 1
        if j - i >= 2:
            out.append((max(0, i * 15 - 30), j * 15))
        i = j + 1
    return out


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


print("\n# bathroom: short windows before the usual use, not 06:00–22:00")
rnd = random.Random(7)
days = []
for d in range(15):  # three working weeks of a household of three: showers in the morning, the evening routine,
    # and the usual short visits all day long (motion sensor on for 3–8 min each)
    visits = [(6 * 60 + 30 + rnd.randint(-5, 5), 25), (7 * 60 + rnd.randint(0, 10), 15)]
    if rnd.random() < 0.75:
        visits.append((21 * 60 + 30 + rnd.randint(-10, 10), 20))
    visits += [(rnd.randint(7 * 60, 22 * 60 + 30), rnd.randint(3, 8)) for _ in range(rnd.randint(12, 16))]
    row = [0] * 96
    for start, minutes in visits:
        for s in range(start // 15, min(96, (start + minutes - 1) // 15 + 1)):
            row[s] = 1
    days.append(row)
raw = [sum(d[s] for d in days) / len(days) for s in range(96)]
old = old_habits(raw)
ok(any(b - a >= 180 for a, b in old), "Ursache nachgestellt: der alte Vorschlag (≥ 40 % je Viertelstunde, Lücken bis 30 Min. geschlossen) macht daraus " + ", ".join(f"{hhmm(a)}–{hhmm(b)}" for a, b in old))
ok(sum(1 for p in raw[28:90] if p >= 0.4) < 31, "… obwohl tagsüber die meisten Viertelstunden unter 40 % liegen (nur kurze Besuche)")
probs = day_probs(days)
ws = M.use_windows(probs, 15, "short", 1.0)
ws_raw = M.use_windows(raw, 15, "short", 1.0)
ok(ws_raw and all(w["z"] - w["a"] <= 7 for w in ws_raw) and not any(40 <= w["a"] <= 80 for w in ws_raw), "auch aus dem Verlauf (ungeglättet, wie „Aus Gewohnheiten vorschlagen“): nur kurze Fenster " + ", ".join(f"{hhmm(w['a'] * 15)}–{hhmm(w['z'] * 15)}" for w in ws_raw), ws_raw)
txt = ", ".join(f"{hhmm(w['a'] * 15)}–{hhmm(w['z'] * 15)}" for w in ws)
ok(1 <= len(ws) <= 3, f"Bad: kurze Fenster {txt}", ws)
ok(all(w["z"] - w["a"] <= 7 for w in ws) and sum(w["z"] - w["a"] for w in ws) <= 16, "jedes höchstens 1¾ Std., zusammen höchstens 4 Std.", ws)
ok(any(w["a"] <= 27 and w["z"] >= 28 for w in ws), "morgens zum Duschen (06:30–07:15)", txt)
ok(any(w["a"] <= 87 and w["z"] >= 86 for w in ws), "abends (21:30)", txt)
ok(not any(40 <= w["a"] <= 80 for w in ws), "tagsüber nichts (nur kurze Besuche)", txt)
ok(M.use_windows(probs, 3, "short", 1.0) == [], "zu wenig Tage gelernt: kein Fenster (Mindestsicherheit)")
ok(M.use_windows(probs, 15, "pass", 1.0) == [], "Flur: nie Komfort-Fenster aus Vorbeigehen")
ok(M.room_kind("Bad") == "short" and M.room_kind("Gäste-WC") == "short" and M.room_kind("Flur oben") == "pass" and M.room_kind("Wohnzimmer") == "normal", "Raumart nach dem Namen")

print("\n# room kind (Raumart) from the Home Assistant area")
D = M.detect_room_kind
ok(D("Bathroom")["kind"] == "short" and D("Hallway")["kind"] == "pass" and D("Treppenhaus")["kind"] == "pass" and D("Living room")["kind"] == "normal", "Name deutsch und englisch")
r = D("Raum 3", "mdi:shower")
ok(r == {"kind": "short", "source": "icon", "detail": "mdi:shower"}, "Symbol mdi:shower: kurz genutzt (Name sagt nichts)", r)
ok(D("Raum 4", "mdi:bathtub")["kind"] == "short" and D("Raum 5", "mdi:toilet")["kind"] == "short", "Symbole Badewanne und Toilette")
ok(D("Raum 6", "mdi:stairs")["kind"] == "pass" and D("Raum 7", "mdi:door")["kind"] == "pass", "Symbole Treppe und Tür: Durchgang")
ok(D("Raum 8", "mdi:sofa")["source"] == "default", "anderes Symbol: kein Hinweis")
ok(D("Gästezimmer", "mdi:toilet")["source"] == "icon", "Symbol vor dem Namen (vom Nutzer gewählt)")
r = D("Raum 9", None, [{"name": "Durchgang", "icon": None}])
ok(r["kind"] == "pass" and r["source"] == "label", "Label „Durchgang“", r)
ok(D("Bad", "mdi:shower", [{"name": "Wichtig", "icon": "mdi:stairs"}])["kind"] == "pass", "Label (mit Symbol) vor allem anderen")
r = D("Raum 10", None, [], ["Licht Decke", "sensor.dusche_feuchte"])
ok(r["kind"] == "short" and r["source"] == "devices", "Gerät im Raum (Duschsensor, auch als Entitäts-ID)", r)
ok(D("Raum 11", None, [], ["light.bad_spiegel"])["kind"] == "short", "Entitäts-ID mit „bad“ als Wort")
ok(D("Raum 12", None, [], ["Spülmaschine", "Kloster-Bild"])["kind"] == "normal", "„Spülmaschine“ / „Kloster“ sind kein WC")
ok(D("Küche", None, [], ["Handtuchwärmer"])["kind"] == "normal", "klarer Name (Küche) schlägt schwache Hinweise")
r = D("Raum 13", None, [], [], 3)
ok(r["kind"] == "short" and r["source"] == "humidity", "Luftfeuchte steigt an 3 Tagen schnell: Bad", r)
ok(D("Raum 13", None, [], [], 2)["kind"] == "normal", "… an 2 Tagen noch nicht")
t0 = 1_700_000_000
short_visits = [[t0 + i * 8 * 3600, 6 + (i % 4)] for i in range(20)]
r = D("Raum 14", visits=short_visits)
ok(r["kind"] == "short" and r["source"] == "usage", "gelernt: nur kurze Besuche → kurz genutzt", r)
ok(D("Raum 15", visits=[[t0 + i * 4 * 3600, 0.5] for i in range(30)])["kind"] == "pass", "gelernt: nur ein paar Sekunden → Durchgang")
ok(D("Raum 16", visits=[[t0 + i * 8 * 3600, 6 + (i % 3) * 60] for i in range(20)])["kind"] == "normal", "lange Besuche dabei → normal")
ok(D("Raum 17", visits=short_visits[:10])["source"] == "default", "zu wenige Besuche: noch nichts gelernt")
ok(M.humid_rise([(0, 50.0), (300, 52.0)], 600, 63.0) and not M.humid_rise([(0, 50.0)], 600, 55.0) and not M.humid_rise([(0, 40.0)], 2000, 60.0), "schneller Anstieg der Luftfeuchte erkannt (und nur innerhalb von 15 Minuten)")

print("\n# normal room and slow rooms")
liv = [[1 if 68 <= s < 88 else 0 for s in range(96)] for _ in range(15)]
ws = M.use_windows(day_probs(liv), 15, "normal", 1.0)
ok(len(ws) == 1 and ws[0]["a"] == 68 and ws[0]["z"] == 88, f"Wohnzimmer 17–22 Uhr → ein Fenster {[(hhmm(w['a'] * 15), hhmm(w['z'] * 15)) for w in ws]}")
two = [[1 if (26 <= s < 32 or 40 <= s < 48) else 0 for s in range(96)] for _ in range(15)]
fast = M.use_windows(day_probs(two), 15, "normal", 0.5)
slow = M.use_windows(day_probs(two), 15, "normal", 3.0)
ok(len(fast) == 2, "schneller Raum: zwei Fenster mit Pause dazwischen", fast)
ok(len(slow) == 1 and slow[0]["joined"], "träger Raum (3 Std. Vorlauf): am Stück, die kurze Pause lohnt kein Absenken", slow)
sparse = [[1 if (s == 30 and d % 2) else 0 for s in range(96)] for d in range(15)]
ok(M.use_windows(day_probs(sparse), 15, "normal", 2.0) == [], "selten und kurz: lohnt das Aufheizen nicht (Kosten/Nutzen)")

print("\n# airing")
air = [[1 if s == 28 and rnd.random() < 0.85 else 0 for s in range(96)] for _ in range(15)]
aw = M.airing_windows(day_probs(air), 15)
ok(len(aw) == 1 and aw[0]["a"] <= 28 < aw[0]["z"], f"morgens um 07:00 wird meist gelüftet → {[(hhmm(w['a'] * 15), hhmm(w['z'] * 15)) for w in aw]}")
ok(M.airing_windows(day_probs(air), 2) == [], "zu wenig Tage: noch nichts gelernt")
ok(M.airing_pattern([[0, 1, 420, 6], [0, 1, 425, 8], [0, 0, 480, 10], [0, 1, 410, 5]])["kind"] == "stoss", "kurz und weit offen: Stoßlüften")
ok(M.airing_pattern([[0, 1, 420, 90], [0, 1, 425, 120], [0, 0, 480, 60]])["kind"] == "tilt", "stundenlang offen: gekipptes Fenster")
ok(M.airing_pattern([[0, 1, 420, 6]])["kind"] is None, "zu wenig Öffnungen: noch kein Muster")

print("\n# doors and windows in the room model")


def room2(temp, tout, u, hours, door=0.0, window=0.0, k_l=0.08, k_h=3.0, k_d=0.12, k_w=1.5, dt=1 / 120):
    """the 'real' room with a door to a cooler hall and a window: extra loss (k_d·door + k_w·window)·(T − T_out)"""
    t = 0.0
    while t < hours - 1e-9:
        temp += (k_h * u - (k_l + k_d * door + k_w * window) * (temp - tout)) * dt
        t += dt
    return temp


rnd = random.Random(7)
m = M.RoomModel.from_dict(None)
ok(m.door.n == 0 and m.k_d == 0 and m.k_w == M.PRIOR_KW, "ohne Daten: Tür kostet nichts, Fenster nach Vorwissen", m.to_dict())
temp, tout = 19.0, 3.0
for i in range(80):
    door = 1.0 if i % 3 == 1 else 0.0
    u = 0.0 if i % 2 else rnd.choice([0.4, 0.7, 1.0])
    hours = rnd.choice([0.5, 0.75])
    new = room2(temp, tout, u, hours, door)
    m.add_interval(0, hours, round(temp, 1), round(new, 1), u, tout, door, 0.0)
    temp = new if 15 < new < 24 else 19.0
    if i % 5 == 0:
        # an airing: window wide open for 6–10 minutes, valve closed
        mins = rnd.choice([6, 8, 10])
        new = room2(temp, tout, 0.0, mins / 60, 0.0, 1.0)
        m.add_interval(0, mins / 60, round(temp, 1), round(new, 1), 0.0, tout, 0.0, 1.0)
        temp = new if new > 15 else 19.0
ok(abs(m.k_l - 0.08) < 0.03, f"Raum selbst trotz Tür richtig: k_l {m.k_l:.3f} (echt 0,08)")
ok(abs(m.k_d - 0.12) < 0.05 and m.door.n >= 5, f"Tür offen gelernt: zusätzlich {m.k_d:.3f}/Std. (echt 0,12) aus {m.door.n} Proben")
ok(abs(m.k_w - 1.5) < 0.5 and m.win.n >= 5, f"Fenster offen gelernt: {m.k_w:.2f}/Std. (echt 1,5) aus {m.win.n} kurzen Lüftungen")
ok(abs(m.k_h - 3.0) < 0.8, f"Heizleistung mit Tür im Modell: k_h {m.k_h:.2f} (echt 3,0)")
ok(m.rate(20, 3, 0.0, door=1.0) < m.rate(20, 3, 0.0) - 1.0, "Vorhersage: mit offener Tür kühlt der Raum schneller")
ok(m.steady_valve(21, 3, door=1.0) > m.steady_valve(21, 3) + 0.2, f"mit offener Tür braucht es mehr Ventil ({m.steady_valve(21, 3, door=1.0):.2f} statt {m.steady_valve(21, 3):.2f})")
m3 = M.RoomModel.from_dict(m.to_dict())
ok(m3.k_d == round(m.k_d, 4) and m3.win.n == m.win.n, "Tür und Fenster speichern und laden")
old = M.RoomModel.from_dict({"k_l": 0.07, "k_h": 2.0, "n_c": 3, "n_h": 3})
ok(old.k_d == 0 and old.k_w == M.PRIOR_KW and old.heat.n == 3, "altes gespeichertes Modell ohne Tür/Fenster lädt weiter")
w0 = m.to_dict()
ok(m.add_interval(0, 0.03, 20, 19, 0.0, 3, 0.0, 1.0) is None, "Fenster unter 4 Min.: zu kurz")
ok(m.add_interval(0, 0.5, 20, 19, 0.0, 3, 0.0, 0.5) is None, "Fenster nur halb der Zeit offen: nichts gelernt")
ok(m.to_dict()["n_w"] == w0["n_w"] and m.to_dict()["n_c"] == w0["n_c"], "dabei nichts verändert")

print("\n# valve controller from the first minute, with a door")
for door_share in (0.0, 1.0):
    st = M.style("comfort")
    pi = M.ValvePI()
    mdl = M.RoomModel.from_dict(None, prior=M.building("partial"))  # nothing learned: building prior only
    first = pi.step(mdl, st, 21, 17.0, 3, 0.0)
    ok(first > 0.3, f"erster Schritt ohne Lernen: Ventil gleich {round(first * 100)} % offen")
    pi = M.ValvePI()
    temp, t, dt = 17.0, 0.0, 2 / 60
    s0, us = (0.0, temp), 0.0
    while t < 12:
        u = pi.step(mdl, st, 21, round(temp, 1), 8, dt, door_share)
        temp = room2(temp, 8, u, dt, door_share, k_h=4.0)
        t += dt
        us += u * dt
        # learns online like the real tick: an interval every 30 min
        if t - s0[0] >= 0.5:
            mdl.add_interval(0, t - s0[0], round(s0[1], 1), round(temp, 1), us / (t - s0[0]), 8, door_share)
            s0, us = (t, temp), 0.0
    ok(abs(temp - 21) < 0.6, f"Tür {'offen' if door_share else 'zu'}: Raum 17 → {temp:.2f} °C nach 12 Std. (Ventilsteuerung ab Minute 1)")

# with the door learned (model m above): the controller opens further as soon as the door opens, before the room cools
pa, pb = M.ValvePI(), M.ValvePI()
ua = pa.step(m, M.style("comfort"), 21, 21.0, 12, 0.0, 0.0)
ub = pb.step(m, M.style("comfort"), 21, 21.0, 12, 0.0, 1.0)
ok(ub > ua + 0.15, f"Tür geht auf: Ventil sofort weiter auf ({round(ua * 100)} → {round(ub * 100)} %), noch bevor es kalt wird")
ok("12d" in pb.bias and "12" not in pb.bias, "Vorsteuerwert für „Tür offen“ getrennt gelernt", pb.to_dict())

print("\n# no overshoot: a radiator keeps heating after the valve closed, people and the TV warm the room too")


def lagged(hours, gains, start=18.0, target=21.0, k_h=1.5, k_l=0.02, tout=6.0, pi=None):
    """old building, radiator output follows the valve with half an hour of lag; `gains` °C/h from people, TV, sun"""
    st = M.style("comfort")
    pi = pi or M.ValvePI()
    mdl = M.RoomModel.from_dict({"k_l": k_l, "k_h": k_h, "n_c": 50, "n_h": 50, "p_c": 0.0001, "p_h": 0.05}, prior=M.building("old"))
    temp, q, t, dt, reach, top = start, 0.0, 0.0, 1 / 60, None, -99.0
    while t < hours:
        u = pi.step(mdl, st, target, round(temp, 1), tout, dt, 0.0, t * 3600)
        q += (k_h * u - q) * dt / 0.5
        temp += (q + gains - k_l * (temp - tout)) * dt
        if reach is None and temp >= target - 0.2:
            reach = t
        if reach is not None:
            top = max(top, temp)
        t += dt
    return reach, top - target, temp, pi


reach, over, end, _pi = lagged(10, 0.0)
ok(reach is not None and reach < 8 and over < 0.15, f"träger Heizkörper: warm nach {reach and round(reach, 1)} Std., höchstens {over:+.2f} °C übers Ziel")
reach, over, end, _pi = lagged(10, 0.2)
ok(over < 0.3, f"mit Wärme von Leuten und Fernseher: höchstens {over:+.2f} °C übers Ziel")
pi = M.ValvePI({"i": 0.0, "bias": {"4": 0.4}})
mdl = M.RoomModel.from_dict({"k_l": 0.02, "k_h": 1.5, "n_c": 50, "n_h": 50, "p_c": 0.0001, "p_h": 0.05})
u = pi.step(mdl, M.style("comfort"), 21, 21.4, 5, 0.25, 0.0, 0.0)
ok(u == 0 and pi.bias["4"] < 0.4, f"0,4 °C zu warm: Ventil zu, gelernte Öffnung kleiner ({pi.bias['4']:.3f})")
pi = M.ValvePI()
for k in range(12):  # warming up 1 °C/h, 0.5 °C below the target
    u_up = pi.step(mdl, M.style("comfort"), 21, 20.0 + k * 0.05, 5, 1 / 20, 0.0, k * 180.0)
pi2 = M.ValvePI()
for k in range(12):  # steady 0.5 °C below the target
    u_flat = pi2.step(mdl, M.style("comfort"), 21, 20.45, 5, 1 / 20, 0.0, k * 180.0)
ok(u_up < u_flat, f"schaut voraus: steigt die Temperatur schon, öffnet es weniger ({round(u_up * 100)} % statt {round(u_flat * 100)} %)")
ok("4" not in pi.bias, "während des Aufheizens wird keine Ventilöffnung gelernt", pi.to_dict())
back = M.ValvePI(pi.to_dict())
ok(abs(back.slope - pi.slope) < 0.01 and back.last == pi.last, "Trend wird gespeichert", back.to_dict())

print("\n# counter-steers: the living room that overshot (learned opening too wide, people and the TV)")


def living(bias, gains, hours=8):
    """learned living room: k_h 1.51, k_l 0.016, outside 8 °C, radiator lag 30 min, target 22 °C"""
    st, pi = M.style("comfort"), M.ValvePI({"i": 0.0, "bias": {"8": bias}})
    mdl = M.RoomModel.from_dict({"k_l": 0.0162, "k_h": 1.511, "n_c": 133, "n_h": 45, "p_c": 0.00014, "p_h": 0.06}, prior=M.building("old"))
    temp, q, t, dt, top, low, valve_h = 22.0, 1.511 * 0.13, 0.0, 1 / 60, 22.0, 22.0, 0.0
    while t < hours:
        u = pi.step(mdl, st, 22, round(temp, 1), 8, dt, 0.0, t * 3600)
        q += (1.511 * u - q) * dt / 0.5
        temp += (q + gains(t) - 0.0162 * (temp - 8)) * dt
        top, low, valve_h, t = max(top, temp), min(low, temp), valve_h + u * dt, t + dt
    return top, low, valve_h, pi


top, low, valve_h, pi = living(0.34, lambda t: 0.25 if 1 < t < 6 else 0.0)
ok(top < 22.45, f"Lernwert zu hoch, dazu Leute und Fernseher: höchstens {top:.2f} °C (vorher bis 23,2 °C)")
ok(valve_h < 0.5, f"dabei nur {valve_h:.2f} Ventil-Stunden (vorher 0,96)")
ok(0.1 < pi.bias["8"] < 0.25, f"die zu weite Öffnung wird verlernt, Richtung dessen, was den Raum hält ({pi.bias['8']:.2f} statt 0,34)")
top, low, valve_h, pi = living(0.13, lambda t: -0.35 if 1 < t < 3 else 0.0)
ok(low > 21.6, f"Kälte durch offene Tür: fällt nur auf {low:.2f} °C (vorher 21,4 °C) – das Ventil geht früher und weiter auf")
ok(top < 22.2, f"und schießt danach nicht über ({top:.2f} °C)")

print("\n# gentle preheating starts earlier")
mdl = M.RoomModel.from_dict({"k_l": 0.02, "k_h": 1.5, "n_c": 50, "n_h": 50, "p_c": 0.0001, "p_h": 0.05}, prior=M.building("old"))
full, gentle = mdl.lead(19, 21, 5), mdl.lead(19, 21, 5, u=0.55)
ok(gentle > full + 0.5, f"Vorheizen 19 → 21 °C mit höchstens 55 % Ventil: {gentle * 60:.0f} statt {full * 60:.0f} Min. vorher anfangen")
cold = M.RoomModel.from_dict({"k_l": 0.08, "k_h": 1.5, "n_c": 50, "n_h": 50, "p_c": 0.0001, "p_h": 0.05})
ok(cold.lead(18, 21, -10, u=0.55) == cold.lead(18, 21, -10), "kalter Tag: schafft es mit 55 % nicht – dann mit ganz offenem Ventil geplant")

print(f"\n{'%d FEHLER' % len(FAIL) if FAIL else 'alles ok'}")
raise SystemExit(1 if FAIL else 0)
