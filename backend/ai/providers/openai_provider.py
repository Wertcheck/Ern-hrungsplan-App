"""OpenAI-Adapter (offizielles SDK, AsyncOpenAI, Chat Completions mit Streaming)."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import openai

from . import sdk_errors
from .base_provider import (
    BaseProvider,
    ModelInfo,
    ProviderEvent,
    ProviderRefusal,
    ProviderRequest,
    StopEvent,
    TextDelta,
    ToolCall,
    UsageEvent,
)

log = logging.getLogger(__name__)

_NON_CHAT = ("embedding", "whisper", "tts", "dall-e", "moderation", "davinci", "babbage", "image", "audio", "realtime", "transcribe")


class OpenAIProvider(BaseProvider):
    name = "openai"

    def __init__(self, api_key: str = "", *, client: Any = None, timeout_s: float = 60.0):
        self._client = client or openai.AsyncOpenAI(api_key=api_key, timeout=timeout_s, max_retries=1)

    @classmethod
    def is_configured(cls, settings: Any) -> bool:
        return settings.has_key("openai")

    @classmethod
    def from_settings(cls, settings: Any) -> "OpenAIProvider":
        return cls(settings.openai_api_key.get_secret_value(), timeout_s=settings.request_timeout_s)

    def _kwargs(self, req: ProviderRequest) -> dict[str, Any]:
        kw: dict[str, Any] = {
            "model": req.model,
            "messages": [{"role": "system", "content": req.system}]
            + [{"role": m["role"], "content": m["content"]} for m in req.messages],
            "stream": True,
            "stream_options": {"include_usage": True},
            "max_completion_tokens": req.max_output_tokens,
            "timeout": req.timeout_s,
        }
        if req.tools:
            kw["tools"] = [
                {"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}
                for t in req.tools
            ]
        if req.temperature is not None:
            kw["temperature"] = req.temperature
        return kw

    async def _open(self, kwargs: dict[str, Any]) -> Any:
        while True:
            try:
                return await self._client.chat.completions.create(**kwargs)
            except Exception as exc:
                if (
                    "temperature" in kwargs
                    and isinstance(exc, openai.BadRequestError)
                    and sdk_errors.mentions_temperature(exc)
                ):
                    kwargs.pop("temperature")  # genau ein Retry ohne temperature
                    continue
                raise sdk_errors.map_sdk_error(exc, openai) from None

    async def stream(self, req: ProviderRequest) -> AsyncIterator[ProviderEvent]:
        resp = await self._open(self._kwargs(req))
        calls: dict[int, dict[str, str]] = {}
        finish: str | None = None
        refusal = False
        try:
            try:
                async for chunk in resp:
                    usage = getattr(chunk, "usage", None)
                    if usage is not None:
                        yield UsageEvent(int(usage.prompt_tokens or 0), int(usage.completion_tokens or 0))
                    for choice in chunk.choices or []:
                        d = choice.delta
                        if d is not None:
                            if getattr(d, "content", None):
                                yield TextDelta(d.content)
                            if getattr(d, "refusal", None):
                                refusal = True
                            for tc in getattr(d, "tool_calls", None) or []:
                                slot = calls.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                                if getattr(tc, "id", None):
                                    slot["id"] = tc.id
                                fn = getattr(tc, "function", None)
                                if fn is not None:
                                    if getattr(fn, "name", None) and not slot["name"]:
                                        slot["name"] = fn.name
                                    if getattr(fn, "arguments", None):
                                        slot["args"] += fn.arguments
                        if getattr(choice, "finish_reason", None):
                            finish = choice.finish_reason
            except Exception as exc:
                raise sdk_errors.map_sdk_error(exc, openai) from None
        finally:
            close = getattr(resp, "close", None)
            if close is not None:
                try:
                    await close()
                except Exception:
                    pass

        for idx in sorted(calls):
            c = calls[idx]
            try:
                args = json.loads(c["args"] or "{}")
            except ValueError:
                log.warning("Ungueltige Tool-Argumente vom Anbieter verworfen")
                continue
            if c["name"] and isinstance(args, dict):
                yield ToolCall(name=c["name"], input=args, id=c["id"] or None)
        if refusal or finish == "content_filter":
            raise ProviderRefusal()
        yield StopEvent(finish or "stop")

    async def list_models(self) -> list[ModelInfo]:
        try:
            page = await self._client.models.list()
            ids = sorted({m.id async for m in page})
        except Exception as exc:
            raise sdk_errors.map_sdk_error(exc, openai) from None
        return [ModelInfo(id=i) for i in ids if not any(x in i.lower() for x in _NON_CHAT)]

    async def ping(self) -> str | None:
        try:
            await self._client.models.list()
        except Exception as exc:
            raise sdk_errors.map_sdk_error(exc, openai) from None
        return None
