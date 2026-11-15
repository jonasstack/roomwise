"""Song recognition for media devices that cannot report what they play (infrared).

A wall tablet the owner picked listens for a few seconds, computes the Chromaprint fingerprint in the browser and
sends only that fingerprint and the duration here (websocket floorplan_card/song/lookup). This module asks AcoustID
with the API key from the integration's options (none is shipped), picks the best match and keeps the last song
per media device. Nothing else is stored: no audio ever reaches the server, no fingerprint is kept.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

ACOUSTID_URL = "https://api.acoustid.org/v2/lookup"
CONF_ACOUSTID_KEY = "acoustid_key"
CONF_ACOUSTID_URL = "acoustid_url"
# a match below this score is a guess, not a song
MIN_SCORE = 0.5
# one device asks at most this often (s); all devices together keep AcoustID's limit of 3 requests per second
DEVICE_GAP = 20.0
GLOBAL_GAP = 0.4
# the last song of at most this many devices
MAX_SONGS = 200
TIMEOUT = aiohttp.ClientTimeout(total=15)


class SongError(Exception):
    """A lookup that could not be made; `code` goes to the card as the websocket error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def best_match(body: dict[str, Any]) -> dict[str, Any] | None:
    """The best recording with a title in an AcoustID answer (meta=recordings releasegroups), or None."""
    best: dict[str, Any] | None = None
    for res in body.get("results") or []:
        try:
            score = float(res.get("score") or 0)
        except (TypeError, ValueError):
            continue
        if score < MIN_SCORE or (best and score <= best["score"]):
            continue
        for rec in res.get("recordings") or []:
            title = str(rec.get("title") or "").strip()
            if not title:
                continue
            artist = "".join(f"{a.get('name', '')}{a.get('joinphrase') or ''}" for a in rec.get("artists") or [] if isinstance(a, dict)).strip()
            groups = rec.get("releasegroups") or []
            album = str(groups[0].get("title") or "").strip() if groups and isinstance(groups[0], dict) else ""
            best = {"title": title[:200], "artist": artist[:200] or None, "album": album[:200] or None, "recording_id": str(rec.get("id") or "")[:64] or None, "score": round(score, 3)}
            break
    return best


class SongLookup:
    """Asks AcoustID, one request at a time, with gaps per device and overall."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._lock = asyncio.Lock()
        self._last: dict[str, float] = {}
        self._last_any = 0.0

    async def lookup(self, key: str, api_key: str, url: str, fingerprint: str, duration: int) -> dict[str, Any] | None:
        now = time.monotonic()
        if now - self._last.get(key, -DEVICE_GAP) < DEVICE_GAP:
            raise SongError("too_often", "This device was looked up a moment ago")
        self._last[key] = now
        async with self._lock:
            wait = GLOBAL_GAP - (time.monotonic() - self._last_any)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_any = time.monotonic()
            session = async_get_clientsession(self.hass)
            form = {"client": api_key, "format": "json", "meta": "recordings releasegroups compress", "duration": str(duration), "fingerprint": fingerprint}
            try:
                async with session.post(url, data=form, timeout=TIMEOUT) as resp:
                    body = await resp.json(content_type=None)
            except (aiohttp.ClientError, TimeoutError, ValueError) as err:
                raise SongError("lookup_failed", f"AcoustID not reachable: {type(err).__name__}") from err
        if not isinstance(body, dict):
            raise SongError("lookup_failed", "Unexpected answer from AcoustID")
        if body.get("status") != "ok":
            error = body.get("error") if isinstance(body.get("error"), dict) else {}
            # AcoustID error 4: invalid API key
            if error.get("code") == 4:
                raise SongError("invalid_key", "AcoustID refused the API key")
            raise SongError("lookup_failed", str(error.get("message") or "AcoustID error")[:200])
        return best_match(body)
