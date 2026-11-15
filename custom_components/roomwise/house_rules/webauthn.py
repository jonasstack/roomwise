"""Minimal WebAuthn (passkeys) for confirming with Face ID / Touch ID / fingerprint.

Registration with attestation "none": we only need the credential id and its public key.
Assertion: checks challenge, origin, relying party, user presence + verification and the signature.
Supports ES256 (-7, what Apple and Android use) and RS256 (-257, Windows Hello).
"""

from __future__ import annotations

import base64
import hashlib
import json
import struct
from typing import Any
from urllib.parse import urlparse

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

# i18n: complete (texts alarm.webauthn_<code> in texts/alarm.json)


class WebAuthnError(Exception):
    """Something about the confirmation is not right (shown to the user): a code, made readable by error_text()."""


def error_text(where: Any, err: Exception) -> str:
    """The text for a WebAuthnError code in the language of Home Assistant (anything else as it is)."""
    from .i18n import texts, tr  # noqa: PLC0415 — imported late: the module also runs on its own (tools/testha/test_webauthn.py)

    code = str(err)
    return tr(where, f"alarm.webauthn_{code}") if f"alarm.webauthn_{code}" in texts()["de"] else code


# what a broken or hostile payload can raise while it is parsed: all mean "not confirmed", never a crash
BAD_INPUT = (WebAuthnError, KeyError, ValueError, TypeError, IndexError, AttributeError, struct.error, RecursionError)


def b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


# ---------------------------------------------------------------------- CBOR (just what authenticators send)
def _cbor(data: bytes, pos: int = 0) -> tuple[Any, int]:
    first = data[pos]
    major, info = first >> 5, first & 0x1F
    pos += 1
    if info < 24:
        val = info
    elif info == 24:
        val = data[pos]
        pos += 1
    elif info == 25:
        val = struct.unpack(">H", data[pos : pos + 2])[0]
        pos += 2
    elif info == 26:
        val = struct.unpack(">I", data[pos : pos + 4])[0]
        pos += 4
    elif info == 27:
        val = struct.unpack(">Q", data[pos : pos + 8])[0]
        pos += 8
    else:
        raise WebAuthnError("format")
    if major == 0:
        return val, pos
    if major == 1:
        return -1 - val, pos
    if major == 2:
        return data[pos : pos + val], pos + val
    if major == 3:
        return data[pos : pos + val].decode(), pos + val
    if major == 4:
        out = []
        for _ in range(val):
            item, pos = _cbor(data, pos)
            out.append(item)
        return out, pos
    if major == 5:
        m = {}
        for _ in range(val):
            k, pos = _cbor(data, pos)
            v, pos = _cbor(data, pos)
            m[k] = v
        return m, pos
    if major == 7:
        return {20: False, 21: True, 22: None}.get(info), pos
    raise WebAuthnError("format")


def _client_data(payload: dict[str, Any], kind: str, rp_id: str) -> bytes:
    raw = b64d(payload["clientDataJSON"])
    cd = json.loads(raw)
    if cd.get("type") != kind:
        raise WebAuthnError("type")
    host = urlparse(cd.get("origin", "")).hostname
    if host != rp_id:
        raise WebAuthnError("origin")
    return raw


def _auth_data(auth: bytes, rp_id: str) -> tuple[int, int]:
    if len(auth) < 37 or auth[:32] != hashlib.sha256(rp_id.encode()).digest():
        raise WebAuthnError("rp")
    flags = auth[32]
    if not flags & 0x01 or not flags & 0x04:
        raise WebAuthnError("user")
    return flags, struct.unpack(">I", auth[33:37])[0]


def parse_registration(payload: dict[str, Any], rp_id: str) -> dict[str, Any]:
    """New passkey of a device → {id, alg, public_key (PEM), sign_count, rp_id}."""
    _client_data(payload, "webauthn.create", rp_id)
    att, _ = _cbor(b64d(payload["attestationObject"]))
    auth: bytes = att["authData"]
    flags, count = _auth_data(auth, rp_id)
    if not flags & 0x40:
        raise WebAuthnError("no_key")
    pos = 37 + 16
    (cred_len,) = struct.unpack(">H", auth[pos : pos + 2])
    pos += 2
    cred_id = auth[pos : pos + cred_len]
    pos += cred_len
    cose, _ = _cbor(auth, pos)
    alg = cose.get(3)
    if cose.get(1) == 2 and alg == -7:
        key = ec.EllipticCurvePublicNumbers(int.from_bytes(cose[-2], "big"), int.from_bytes(cose[-3], "big"), ec.SECP256R1()).public_key()
    elif cose.get(1) == 3 and alg == -257:
        key = rsa.RSAPublicNumbers(int.from_bytes(cose[-2], "big"), int.from_bytes(cose[-1], "big")).public_key()
    else:
        raise WebAuthnError("unsupported")
    pem = key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    return {"id": b64e(cred_id), "alg": alg, "public_key": pem, "sign_count": count, "rp_id": rp_id}


def verify_assertion(payload: dict[str, Any], cred: dict[str, Any], rp_id: str) -> int:
    """Checks a Face ID / Touch ID confirmation. Returns the new signature counter."""
    if cred.get("rp_id") and cred["rp_id"] != rp_id:
        raise WebAuthnError("other_rp")
    raw = _client_data(payload, "webauthn.get", rp_id)
    auth = b64d(payload["authenticatorData"])
    _flags, count = _auth_data(auth, rp_id)
    signed = auth + hashlib.sha256(raw).digest()
    key = serialization.load_pem_public_key(cred["public_key"].encode())
    sig = b64d(payload["signature"])
    try:
        if isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(sig, signed, ec.ECDSA(hashes.SHA256()))
        elif isinstance(key, rsa.RSAPublicKey):
            key.verify(sig, signed, padding.PKCS1v15(), hashes.SHA256())
        else:
            raise WebAuthnError("unknown_key")
    except InvalidSignature as err:
        raise WebAuthnError("invalid") from err
    old = int(cred.get("sign_count") or 0)
    if count and old and count <= old:
        raise WebAuthnError("replay")
    return count
