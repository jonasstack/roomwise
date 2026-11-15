"""Connection to a language model: Ollama (own server, e.g. a VPS) or a cloud API with a key.

For now only the connection: choose a provider, enter URL/key, test it (lists the models), pick a model.
Writing rules from text with the model comes in the next step; until then the simple parser is used.
The key is kept in the integration's storage and never sent back to the browser (only its last 4 characters).
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from aiohttp import ClientError, ClientTimeout

from homeassistant.helpers.aiohttp_client import async_get_clientsession

if TYPE_CHECKING:
    from .core import HouseRules

TIMEOUT = ClientTimeout(total=15)

PROVIDERS: dict[str, dict[str, Any]] = {
    "ollama": {"label": "Ollama", "needs_url": True, "needs_key": False, "url": "http://", "hint": "Eigener Server, z. B. dein VPS: http://adresse:11434"},
    "gemini": {"label": "Google Gemini", "needs_url": False, "needs_key": True, "hint": "Schlüssel aus Google AI Studio"},
    "openai": {"label": "OpenAI (ChatGPT)", "needs_url": False, "needs_key": True, "hint": "Schlüssel von platform.openai.com"},
    "anthropic": {"label": "Anthropic (Claude)", "needs_url": False, "needs_key": True, "hint": "Schlüssel aus der Claude Console"},
    "mistral": {"label": "Mistral", "needs_url": False, "needs_key": True, "hint": "Schlüssel von console.mistral.ai"},
    "openai_compatible": {
        "label": "OpenAI-kompatibel",
        "needs_url": True,
        "needs_key": True,
        "url": "https://",
        "hint": "Z. B. OpenRouter (https://openrouter.ai/api/v1), Groq, LM Studio",
    },
}


class AiConnection:
    def __init__(self, core: HouseRules) -> None:
        self.core = core

    @property
    def config(self) -> dict[str, Any]:
        return self.core.data.setdefault("ai", {"provider": "none"})

    def public(self) -> dict[str, Any]:
        c = self.config
        key = c.get("key") or ""
        return {
            "provider": c.get("provider", "none"),
            "url": c.get("url", ""),
            "model": c.get("model", ""),
            "has_key": bool(key),
            "key_hint": f"…{key[-4:]}" if len(key) >= 8 else ("gesetzt" if key else ""),
            "status": c.get("status"),
            "checked": c.get("checked"),
            "providers": {k: {kk: vv for kk, vv in v.items()} for k, v in PROVIDERS.items()},
        }

    @property
    def connected(self) -> bool:
        """Usable right now: the feature "ai" is on and a connection is set up."""
        return self.core.feature("ai") and self.configured

    @property
    def configured(self) -> bool:
        """A provider and model are chosen (and a key where one is needed)."""
        c = self.config
        p = c.get("provider", "none")
        if p == "none" or not c.get("model"):
            return False
        return not (PROVIDERS.get(p, {}).get("needs_key") and p != "openai_compatible" and not c.get("key"))

    def save(self, raw: dict[str, Any]) -> None:
        c = self.config
        provider = raw.get("provider", c.get("provider", "none"))
        if provider not in PROVIDERS and provider != "none":
            raise ValueError("Unbekannter Anbieter")
        if provider != c.get("provider"):
            c.clear()
        c["provider"] = provider
        if isinstance(raw.get("url"), str):
            c["url"] = raw["url"].strip().rstrip("/")[:300]
        if isinstance(raw.get("model"), str):
            c["model"] = raw["model"].strip()[:120]
        if isinstance(raw.get("key"), str) and raw["key"].strip():
            c["key"] = raw["key"].strip()[:400]
        if raw.get("key") is None and "key" in raw:
            c.pop("key", None)
        self.core.save()

    async def test(self, raw: dict[str, Any]) -> dict[str, Any]:
        """Tries the connection with the given values (stored key if none given). Lists the models."""
        c = self.config
        provider = raw.get("provider") or c.get("provider", "none")
        if provider not in PROVIDERS:
            return {"ok": False, "error": "Bitte einen Anbieter wählen."}
        same = provider == c.get("provider")
        url = (raw.get("url") or (c.get("url") if same else "") or "").strip().rstrip("/")
        # the stored key only goes to the stored address: a test against another address needs the key typed in again
        reuse = same and (not PROVIDERS[provider]["needs_url"] or url == (c.get("url") or "").strip().rstrip("/"))
        key = (raw.get("key") or (c.get("key") if reuse else "") or "").strip()
        spec = PROVIDERS[provider]
        if spec["needs_url"] and not url.startswith(("http://", "https://")):
            return {"ok": False, "error": "Bitte die Adresse mit http:// oder https:// angeben."}
        if spec["needs_key"] and not key and provider != "openai_compatible":
            return {"ok": False, "error": "Bitte einen API-Schlüssel eingeben."}
        session = async_get_clientsession(self.core.hass)
        try:
            models = await self._models(session, provider, url, key)
        except ClientError as err:
            return self._result(same, False, f"Keine Verbindung: {err.__class__.__name__}")
        except TimeoutError:
            return self._result(same, False, "Keine Antwort (Zeitüberschreitung).")
        except PermissionError:
            return self._result(same, False, "Schlüssel abgelehnt.")
        except ValueError as err:
            return self._result(same, False, str(err))
        return self._result(same, True, None, sorted(set(models)))

    def _result(self, same: bool, ok: bool, error: str | None, models: list[str] | None = None) -> dict[str, Any]:
        if same:
            self.config["status"] = "ok" if ok else "error"
            self.config["checked"] = time.time()
            self.core.save()
        return {"ok": ok, "error": error, "models": models or []}

    async def _models(self, session: Any, provider: str, url: str, key: str) -> list[str]:
        async def get(u: str, headers: dict[str, str] | None = None) -> Any:
            async with session.get(u, headers=headers or {}, timeout=TIMEOUT) as resp:
                if resp.status in (401, 403):
                    raise PermissionError
                if resp.status != 200:
                    raise ValueError(f"Antwort {resp.status} vom Anbieter.")
                return await resp.json(content_type=None)

        if provider == "ollama":
            data = await get(f"{url}/api/tags")
            return [m.get("name") for m in data.get("models", []) if m.get("name")]
        if provider == "gemini":
            data = await get("https://generativelanguage.googleapis.com/v1beta/models", {"x-goog-api-key": key})
            return [
                str(m.get("name", "")).removeprefix("models/")
                for m in data.get("models", [])
                if "generateContent" in (m.get("supportedGenerationMethods") or [])
            ]
        if provider == "anthropic":
            data = await get("https://api.anthropic.com/v1/models?limit=100", {"x-api-key": key, "anthropic-version": "2023-06-01"})
            return [m.get("id") for m in data.get("data", []) if m.get("id")]
        base = {"openai": "https://api.openai.com/v1", "mistral": "https://api.mistral.ai/v1"}.get(provider, url)
        data = await get(f"{base}/models", {"Authorization": f"Bearer {key}"} if key else {})
        ids = [m.get("id") for m in data.get("data", []) if m.get("id")]
        if provider == "openai":
            ids = [i for i in ids if i.startswith(("gpt", "o1", "o3", "o4", "chatgpt"))] or ids
        return ids


# ---------------------------------------------------------------------- using the model
GEN_TIMEOUT = ClientTimeout(total=90)


class AiError(Exception):
    """The language model could not answer (shown to the user)."""


def _json_from(text: str) -> dict[str, Any]:
    """The first JSON object in a model answer (some wrap it in ``` or add a sentence)."""
    import json  # noqa: PLC0415

    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        t = t[t.find("{") :]
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end < start:
        raise AiError("Die KI hat kein gültiges Ergebnis geliefert.")
    try:
        return json.loads(t[start : end + 1])
    except ValueError as err:
        raise AiError("Die KI hat kein gültiges Ergebnis geliefert.") from err


async def complete(core: HouseRules, system: str, user: str, schema: dict[str, Any] | None = None, timeout: float = 90) -> dict[str, Any]:
    """Asks the connected model and returns its JSON answer."""
    if not core.ai.connected:
        raise AiError("Keine KI angebunden." if not core.ai.configured else "Die KI-Anbindung ist ausgeschaltet (Einstellungen → Funktionen).")
    c = core.ai.config
    provider, model, key, url = c.get("provider", "none"), c.get("model", ""), c.get("key", ""), (c.get("url") or "").rstrip("/")
    if provider == "none" or not model:
        raise AiError("Keine KI angebunden.")
    session = async_get_clientsession(core.hass)
    to = ClientTimeout(total=timeout)
    hint = "\nAntworte ausschließlich mit einem JSON-Objekt, ohne weiteren Text."
    try:
        if provider == "ollama":
            # keep the model loaded: Ollama then reuses the unchanged start of the prompt (much faster)
            body = {
                "model": model,
                "stream": False,
                "keep_alive": "30m",
                "options": {"temperature": 0, "num_predict": 600, "num_ctx": 8192},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            }
            body["format"] = schema or "json"
            async with session.post(f"{url}/api/chat", json=body, timeout=to) as r:
                if r.status != 200:
                    raise AiError(f"Ollama antwortet mit {r.status}.")
                return _json_from((await r.json(content_type=None))["message"]["content"])
        if provider == "gemini":
            body = {
                "systemInstruction": {"parts": [{"text": system + hint}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
            }
            u = f"https://generativelanguage.googleapis.com/v1beta/models/{quote(model, safe='')}:generateContent"
            async with session.post(u, json=body, headers={"x-goog-api-key": key}, timeout=to) as r:
                if r.status != 200:
                    raise AiError(f"Gemini antwortet mit {r.status}.")
                data = await r.json(content_type=None)
                return _json_from(data["candidates"][0]["content"]["parts"][0]["text"])
        if provider == "anthropic":
            body = {"model": model, "max_tokens": 2048, "temperature": 0, "system": system + hint, "messages": [{"role": "user", "content": user}]}
            headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
            async with session.post("https://api.anthropic.com/v1/messages", json=body, headers=headers, timeout=to) as r:
                if r.status != 200:
                    raise AiError(f"Anthropic antwortet mit {r.status}.")
                data = await r.json(content_type=None)
                return _json_from("".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"))
        base = {"openai": "https://api.openai.com/v1", "mistral": "https://api.mistral.ai/v1"}.get(provider, url)
        body = {
            "model": model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": system + hint}, {"role": "user", "content": user}],
        }
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        async with session.post(f"{base}/chat/completions", json=body, headers=headers, timeout=to) as r:
            if r.status != 200:
                raise AiError(f"Die KI antwortet mit {r.status}.")
            data = await r.json(content_type=None)
            return _json_from(data["choices"][0]["message"]["content"])
    except TimeoutError as err:
        raise AiError("Die KI hat zu lange gebraucht.") from err
    except ClientError as err:
        raise AiError(f"Keine Verbindung zur KI ({err.__class__.__name__}).") from err
    except (KeyError, IndexError, TypeError) as err:
        raise AiError("Unerwartete Antwort der KI.") from err
