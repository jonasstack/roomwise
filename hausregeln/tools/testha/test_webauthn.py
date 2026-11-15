"""Checks webauthn.py with a simulated authenticator (no browser needed). Run: python3 tools/testha/test_webauthn.py"""
import base64, hashlib, importlib.util, json, os, struct, sys

spec = importlib.util.spec_from_file_location("wa", os.path.join(os.path.dirname(__file__), "../../../custom_components/roomwise/house_rules/webauthn.py"))
wa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wa)
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec


def enc(v):
    def head(major, n):
        if n < 24: return bytes([major << 5 | n])
        if n < 256: return bytes([major << 5 | 24, n])
        if n < 65536: return bytes([major << 5 | 25]) + struct.pack(">H", n)
        return bytes([major << 5 | 26]) + struct.pack(">I", n)
    if isinstance(v, bool): return bytes([0xF5 if v else 0xF4])
    if isinstance(v, int): return head(0, v) if v >= 0 else head(1, -1 - v)
    if isinstance(v, bytes): return head(2, len(v)) + v
    if isinstance(v, str): b = v.encode(); return head(3, len(b)) + b
    if isinstance(v, dict): return head(5, len(v)) + b"".join(enc(k) + enc(x) for k, x in v.items())
    raise TypeError(v)


b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
rp = "ha.example.de"
origin = f"https://{rp}"
key = ec.generate_private_key(ec.SECP256R1())
nums = key.public_key().public_numbers()
cred_id = os.urandom(16)
cose = {1: 2, 3: -7, -1: 1, -2: nums.x.to_bytes(32, "big"), -3: nums.y.to_bytes(32, "big")}
rp_hash = hashlib.sha256(rp.encode()).digest()
auth_reg = rp_hash + bytes([0x45]) + struct.pack(">I", 0) + b"\0" * 16 + struct.pack(">H", 16) + cred_id + enc(cose)
cd_reg = json.dumps({"type": "webauthn.create", "challenge": "abc", "origin": origin}).encode()
cred = wa.parse_registration({"attestationObject": b64(enc({"fmt": "none", "attStmt": {}, "authData": auth_reg})), "clientDataJSON": b64(cd_reg)}, rp)
ok = cred["id"] == b64(cred_id) and cred["alg"] == -7
print("  ok: Registrierung" if ok else "• FAIL: Registrierung")


def assertion(count, uv=True, origin_=origin, flip=False):
    auth = rp_hash + bytes([0x05 if uv else 0x01]) + struct.pack(">I", count)
    cd = json.dumps({"type": "webauthn.get", "challenge": "xyz", "origin": origin_}).encode()
    sig = key.sign(auth + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
    if flip: sig = sig[:-1] + bytes([sig[-1] ^ 1])
    return {"id": cred["id"], "authenticatorData": b64(auth), "clientDataJSON": b64(cd), "signature": b64(sig)}


fails = 0
def expect(name, fn, should_pass):
    global fails
    try:
        fn(); passed = True
    except wa.WebAuthnError:
        passed = False
    good = passed == should_pass
    fails += not good
    print(("  ok: " if good else "• FAIL: ") + name)

expect("gültige Bestätigung", lambda: wa.verify_assertion(assertion(1), cred, rp), True)
expect("ohne Face ID (UV) abgelehnt", lambda: wa.verify_assertion(assertion(2, uv=False), cred, rp), False)
expect("andere Adresse abgelehnt", lambda: wa.verify_assertion(assertion(3, origin_="https://evil.de"), cred, rp), False)
expect("gefälschte Signatur abgelehnt", lambda: wa.verify_assertion(assertion(4, flip=True), cred, rp), False)
expect("wiederholter Zähler abgelehnt", lambda: wa.verify_assertion(assertion(5), {**cred, "sign_count": 9}, rp), False)
sys.exit(1 if fails or not ok else 0)
