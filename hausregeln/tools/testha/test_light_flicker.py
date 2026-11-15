"""Lamps do not flicker from Hausregeln's calls (lightplan.send_gate, lightspec.same_colour / roughly):
a lamp that reacted but reports the setting a little differently (rounded brightness, another colour mode, still in
its fade) gets no second call; a lost call is repeated; nothing within MIN_GAP; see-sawing wishes (A → B → A) wait;
a brightness change of a lamp already in the right colour leaves the colour out. Needs Home Assistant (imports):
    docker run --rm -v $PWD/custom_components:/config/custom_components:ro -v $PWD/hausregeln/tools:/t:ro \\
      ghcr.io/home-assistant/home-assistant:stable python3 /t/testha/test_light_flicker.py
"""

import datetime as D
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.environ.get("HA_CONFIG", "/config"))

from custom_components.roomwise.house_rules import lightspec as S  # noqa: E402
from custom_components.roomwise.house_rules.lightplan import FLAP_WINDOW, MAX_SENDS, MIN_GAP, RESEND_WAIT, consume_once, send_gate  # noqa: E402

fails = 0


def ok(c, m, *extra):
    global fails
    if not c:
        fails += 1
    print(("  ok: " if c else "  FEHLER: ") + m, *(extra if not c else ()))


T0 = 1_000_000.0


def st(state, t, changed=None, **attrs):
    base = {"supported_color_modes": ["color_temp"], "color_mode": "color_temp", "supported_features": 32}
    ts = D.datetime.fromtimestamp(t, D.timezone.utc)
    return SimpleNamespace(state=state, attributes={**base, **attrs}, last_updated=ts, last_changed=D.datetime.fromtimestamp(changed if changed is not None else t, D.timezone.utc))


def s40(**x):
    return {"mode": "on", "brightness": 40, "color": "k:2700", **x}


lamp = "light.a"

print("Gerundete Helligkeit, andere Meldung: kein zweiter Aufruf")
sent: dict = {}
go, _ = send_gate(sent, lamp, s40(), st("on", T0 - 100, brightness=200, color_temp_kelvin=4000), T0)
ok(go, "erster Aufruf geht raus")
# the lamp reacted (state updated after the call): 40 % reported as 92 (36 %), white tone 2900 – close, not "matches"
after = st("on", T0 + 0.8, brightness=92, color_temp_kelvin=2900)
go, wait = send_gate(sent, lamp, s40(), after, T0 + RESEND_WAIT + 0.1)
ok(not go and wait is None, "reagiert, nur etwas anders gemeldet → nicht noch einmal", sent)
go, _ = send_gate(sent, lamp, s40(), after, T0 + 30)
ok(not go, "auch später nicht")

print("Verlorener Aufruf: wiederholen, höchstens MAX_SENDS")
sent = {}
silent = st("on", T0 - 100, brightness=200, color_temp_kelvin=4000)
n = 0
t = T0
for _i in range(6):
    go, wait = send_gate(sent, lamp, s40(), silent, t)
    n += go
    t += RESEND_WAIT + 0.2
ok(n == MAX_SENDS, f"keine Reaktion → {MAX_SENDS}× gesendet", n)

print("Mitten im Übergang: keine Wiederholung")
sent = {}
go, _ = send_gate(sent, lamp, s40(transition=6), st("on", T0 - 50, brightness=255), T0, 6)
mid = st("on", T0 + 2, brightness=180)
go2, wait = send_gate(sent, lamp, s40(transition=6), mid, T0 + 3)
ok(go and not go2 and bool(wait) and wait > 4, "wartet das Ende des Übergangs ab", wait)

print("Reagiert, aber weit daneben (Aufruf halb angekommen): noch einmal")
sent = {}
send_gate(sent, lamp, s40(), st("off", T0 - 50), T0)
half = st("on", T0 + 0.5, brightness=13)  # only the power-up step arrived
go, _ = send_gate(sent, lamp, s40(), half, T0 + RESEND_WAIT + 0.2)
ok(go, "nur 5 % statt 40 % → noch einmal")

print("Nicht im Sekundentakt, Hin und Her gedämpft")
sent = {}
A, B = s40(), {"mode": "on", "bri": 25, "color": "none"}
go_a, _ = send_gate(sent, lamp, A, st("on", T0 - 50, brightness=255), T0)
go_b, wait_b = send_gate(sent, lamp, B, st("on", T0 + 0.3, brightness=102), T0 + 0.5)
ok(go_a and not go_b and bool(wait_b) and abs(wait_b - (MIN_GAP - 0.5)) < 0.01, "neuer Wunsch 0,5 s danach wartet bis MIN_GAP", wait_b)
go_b, _ = send_gate(sent, lamp, B, st("on", T0 + 0.3, brightness=102), T0 + MIN_GAP + 0.1)
ok(go_b, "danach geht er raus")
go_a2, wait_a2 = send_gate(sent, lamp, A, st("on", T0 + 2, brightness=25), T0 + MIN_GAP + 2)
ok(not go_a2 and bool(wait_a2), "gleich wieder A (Hin und Her) → wartet das Fenster ab", wait_a2)
go_a3, _ = send_gate(sent, lamp, A, st("on", T0 + 2, brightness=25), T0 + FLAP_WINDOW + 0.1)
ok(go_a3, "nach dem Fenster wieder A")
sent = {}
send_gate(sent, lamp, A, st("on", T0 - 50, brightness=255), T0)
go_off, _ = send_gate(sent, lamp, {"mode": "off"}, st("on", T0 + 0.2, brightness=102), T0 + 0.3)
ok(go_off, "Ausschalten wartet nie")

print("Nur die Helligkeit, wenn die Farbe schon stimmt")
on_warm = {"brightness": 200, "color_mode": "color_temp", "color_temp_kelvin": 2702, "supported_color_modes": ["color_temp"], "supported_features": 32}
ok(S.same_colour("on", on_warm, s40()), "an, schon 2700 K → gleiche Farbe")
ok(not S.same_colour("on", {**on_warm, "color_temp_kelvin": 4000}, s40()), "4000 K → andere Farbe")
ok(not S.same_colour("off", on_warm, s40()), "aus → Farbe mitschicken")
ok(not S.same_colour("on", on_warm, {"mode": "on", "bri": 25, "color": "none"}), "ohne Farbe → nichts zu sparen")
ok(S.roughly("on", {"brightness": 92}, s40()) and not S.roughly("on", {"brightness": 13}, s40()), "ungefähr erreicht: 36 % ja, 5 % nein")

print("„Danach: Aus“ ist einmalig, kein bleibendes Ziel")
off = {"mode": "off", "why": "Regel vorbei", "once": True}
ev = {lamp: (off, "r1")}
ok(not consume_once(ev, lamp, {"mode": "off"}) and lamp in ev, "ein anderes Ergebnis erreicht → bleibt")
ok(consume_once(ev, lamp, off) and lamp not in ev, "erreicht → erledigt (später von Hand an bleibt an)")
ev = {lamp: (off, "r1")}
ok(consume_once(ev, lamp) and lamp not in ev, "Lampe von Hand gehalten → erledigt, von Hand gewinnt")
when = {"mode": "on", "brightness": 80}
ev = {lamp: (when, "w1")}
ok(not consume_once(ev, lamp, when) and lamp in ev, "Ergebnis einer „Wenn“-Regel bleibt das letzte Ergebnis")

print(f"\n{'ALLES OK' if not fails else f'{fails} FEHLER'}")
sys.exit(1 if fails else 0)
