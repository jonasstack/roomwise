"""More ways an alarm reaches people besides the phone app: e-mail, a Telegram call or message and a Signal
message (both through CallMeBot, free for private use, no extra integration needed) and any other notify
service of Home Assistant (e.g. one set up for SMS or Twilio calls).

Passwords and keys stay in Home Assistant's storage; the frontend only learns whether they are set.
"""

from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from aiohttp import ClientError, ClientTimeout

from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .i18n import tr

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

# i18n: complete (texts alarm.ch_* in texts/alarm.json)

EVENTS = ("triggered", "pending", "armed", "disarmed", "test", "repeat")
CALLMEBOT = "https://api.callmebot.com"
SECRET = "\x00unchanged"  # the frontend sends this when a password was not touched


def default_channels() -> dict[str, Any]:
    return {
        "email": {"on": False, "host": "", "port": 587, "security": "starttls", "user": "", "password": "", "sender": "", "to": [], "events": ["triggered", "test"]},
        "telegram": {"on": False, "users": [], "call": True, "text": True, "events": ["triggered", "test"]},
        "signal": {"on": False, "numbers": [], "events": ["triggered", "test"]},
        "services": {"on": False, "list": [], "events": ["triggered", "test"]},
    }


def public(ch: dict[str, Any]) -> dict[str, Any]:
    """Without secrets."""
    out = {k: dict(v) for k, v in ch.items()}
    out["email"]["has_password"] = bool(ch["email"].get("password"))
    out["email"].pop("password", None)
    out["signal"]["numbers"] = [{"phone": n.get("phone", ""), "has_key": bool(n.get("apikey"))} for n in ch["signal"].get("numbers", [])]
    return out


def _events(v: Any) -> list[str] | None:
    return [e for e in v if e in EVENTS] if isinstance(v, list) else None


def save(dst: dict[str, Any], raw: dict[str, Any], services: set[str]) -> None:
    """Takes over what is valid from the frontend."""
    for key, d in default_channels().items():
        dst.setdefault(key, d)
        for k, v in d.items():
            dst[key].setdefault(k, v)
    if isinstance(e := raw.get("email"), dict):
        m = dst["email"]
        for k in ("host", "user", "sender"):
            if isinstance(e.get(k), str):
                m[k] = e[k].strip()[:200]
        if isinstance(e.get("port"), (int, float)):
            m["port"] = int(max(1, min(65535, e["port"])))
        if e.get("security") in ("starttls", "ssl", "none"):
            m["security"] = e["security"]
        if isinstance(e.get("password"), str) and e["password"] != SECRET:
            m["password"] = e["password"][:300]
        if isinstance(e.get("to"), list):
            m["to"] = [str(x).strip() for x in e["to"] if isinstance(x, str) and "@" in x][:10]
    if isinstance(t := raw.get("telegram"), dict):
        m = dst["telegram"]
        if isinstance(t.get("users"), list):
            m["users"] = [("@" + str(u).strip().lstrip("@"))[:64] for u in t["users"] if isinstance(u, str) and u.strip().lstrip("@")][:10]
        for k in ("call", "text"):
            if isinstance(t.get(k), bool):
                m[k] = t[k]
    if isinstance(s := raw.get("signal"), dict) and isinstance(s.get("numbers"), list):
        old = {n.get("phone"): n.get("apikey", "") for n in dst["signal"].get("numbers", [])}
        nums = []
        for n in s["numbers"][:10]:
            if not isinstance(n, dict) or not str(n.get("phone", "")).strip():
                continue
            phone = "".join(ch for ch in str(n["phone"]) if ch.isdigit() or ch == "+")[:20]
            key = n.get("apikey")
            nums.append({"phone": phone, "apikey": old.get(phone, "") if not isinstance(key, str) or key == SECRET else key.strip()[:64]})
        dst["signal"]["numbers"] = nums
    if isinstance(v := raw.get("services"), dict) and isinstance(v.get("list"), list):
        dst["services"]["list"] = [x.removeprefix("notify.") for x in v["list"] if isinstance(x, str) and x.removeprefix("notify.") in services][:10]
    for key in default_channels():
        src = raw.get(key)
        if isinstance(src, dict):
            if isinstance(src.get("on"), bool):
                dst[key]["on"] = src["on"]
            if (ev := _events(src.get("events"))) is not None:
                dst[key]["events"] = ev


# ---------------------------------------------------------------------------------------------- sending
async def send(hass: HomeAssistant, ch: dict[str, Any], event: str, title: str, message: str, link: str | None, image: bytes | None = None, only: str | None = None) -> list[str]:
    """Sends over every channel that is on for this event. → error texts (empty = all fine)."""
    tasks = []
    names = []
    text = f"{title}: {message}"
    for key, fn in (("email", _email), ("telegram", _telegram), ("signal", _signal), ("services", _services)):
        c = ch.get(key) or {}
        if only and key != only:
            continue
        if not only and (not c.get("on") or event not in c.get("events", [])):
            continue
        tasks.append(fn(hass, c, title, message if key == "email" else text, link, image))
        names.append(key)
    results = await asyncio.gather(*tasks, return_exceptions=True)
    errors = []
    for name, res in zip(names, results):
        label = tr(hass, f"alarm.ch_{name}")
        if isinstance(res, Exception):
            _LOGGER.warning("House rules alarm: %s: %s", name, res)
            errors.append(f"{label}: {res}")
        elif res:
            errors.append(f"{label}: {res}")
    return errors


async def _get(hass: HomeAssistant, url: str) -> str | None:
    try:
        async with async_get_clientsession(hass).get(url, timeout=ClientTimeout(total=25)) as r:
            body = (await r.text())[:300]
            if r.status != 200:
                return tr(hass, "alarm.ch_status", status=r.status)
            low = body.lower()
            if "error" in low or "not authorized" in low or "not allowed" in low or "invalid" in low:
                return tr(hass, "alarm.ch_callmebot_error")
            return None
    except (ClientError, TimeoutError) as err:
        return tr(hass, "alarm.ch_unreachable", error=err.__class__.__name__)


async def _telegram(hass: HomeAssistant, c: dict[str, Any], title: str, text: str, link: str | None, image: bytes | None) -> str | None:
    errors = []
    voice = tr(hass, "alarm.ch_call_voice")
    for user in c.get("users", []):
        u = quote(user)
        if c.get("call", True):
            err = await _get(hass, f"{CALLMEBOT}/start.php?source=HA&user={u}&text={quote(text[:250])}&lang={voice}&rpt=2")
            if err:
                errors.append(tr(hass, "alarm.ch_call_failed", user=user, error=err))
        if c.get("text", True):
            err = await _get(hass, f"{CALLMEBOT}/text.php?source=HA&user={u}&text={quote(text + (' ' + link if link else ''))}")
            if err:
                errors.append(tr(hass, "alarm.ch_message_failed", user=user, error=err))
    return "; ".join(errors) or (None if c.get("users") else tr(hass, "alarm.ch_no_telegram"))


async def _signal(hass: HomeAssistant, c: dict[str, Any], title: str, text: str, link: str | None, image: bytes | None) -> str | None:
    errors = []
    for n in c.get("numbers", []):
        if not n.get("apikey"):
            errors.append(tr(hass, "alarm.ch_no_key", phone=n.get("phone")))
            continue
        err = await _get(hass, f"{CALLMEBOT}/signal/send.php?phone={quote(n['phone'])}&apikey={quote(n['apikey'])}&text={quote(text + (' ' + link if link else ''))}")
        if err:
            errors.append(f"{n.get('phone')}: {err}")
    return "; ".join(errors) or (None if c.get("numbers") else tr(hass, "alarm.ch_no_number"))


async def _services(hass: HomeAssistant, c: dict[str, Any], title: str, text: str, link: str | None, image: bytes | None) -> str | None:
    errors = []
    for s in c.get("list", []):
        try:
            await hass.services.async_call("notify", s, {"title": title, "message": text + (f"\n{link}" if link else "")}, blocking=True)
        except Exception as err:  # noqa: BLE001 — one service must not stop the others
            errors.append(f"{s}: {err}")
    return "; ".join(errors) or (None if c.get("list") else tr(hass, "alarm.ch_no_service"))


async def _email(hass: HomeAssistant, c: dict[str, Any], title: str, text: str, link: str | None, image: bytes | None) -> str | None:
    if not c.get("host") or not c.get("to"):
        return tr(hass, "alarm.ch_no_mail")
    msg = EmailMessage()
    msg["Subject"] = tr(hass, "alarm.ch_mail_subject", title=title)
    msg["From"] = c.get("sender") or c.get("user") or "hausregeln@localhost"
    msg["To"] = ", ".join(c["to"])
    link_line = tr(hass, "alarm.ch_mail_link", link=link) if link else ""
    footer = tr(hass, "alarm.ch_mail_footer")
    msg.set_content(f"{text}\n\n{link_line}\n\n{footer}")
    if image:
        msg.add_attachment(image, maintype="image", subtype="jpeg", filename=tr(hass, "alarm.ch_attachment"))

    def go() -> None:
        ctx = ssl.create_default_context()
        port = int(c.get("port") or 587)
        if c.get("security") == "ssl":
            server: smtplib.SMTP = smtplib.SMTP_SSL(c["host"], port, context=ctx, timeout=25)
        else:
            server = smtplib.SMTP(c["host"], port, timeout=25)
            if c.get("security", "starttls") == "starttls":
                server.starttls(context=ctx)
        try:
            if c.get("user"):
                server.login(c["user"], c.get("password", ""))
            server.send_message(msg)
        finally:
            try:
                server.quit()
            except smtplib.SMTPException:
                pass

    try:
        await hass.async_add_executor_job(go)
    except (smtplib.SMTPException, OSError) as err:
        return str(err)[:200] or err.__class__.__name__
    return None
