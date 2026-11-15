"""Anthropic-Adapter (offizielles SDK, AsyncAnthropic, messages.stream)."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from typing import Any

import anthropic

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

_MODEL_RE = re.compile(r"^claude-(?:(opus|sonnet|haiku|fable|mythos)-)(\d+)(?:-(\d{1,2}))?(?!\d)")


def rejects_sampling_params(model: str) -> bool:
    """True fuer Claude-5.x-Familien (und Opus/Sonnet 4.6+): temperature/top_p/top_k fuehren zu 400."""
    m = _MODEL_RE.match(model or "")
    if not m:
        return False
    family, major, minor = m.group(1), int(m.group(2)), int(m.group(3) or 0)
    if family in ("fable", "mythos") or major >= 5:
        return True
    return major == 4 and minor >= 6


def _usage_tokens(u: Any) -> tuple[int, int]:
    def g(name: str) -> int:
        v = getattr(u, name, None)
        return int(v) if isinstance(v, (int, float)) else 0

    inp = g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens")
    return inp, g("output_tokens")


class AnthropicProvider(BaseProvider):
    name = "anthropic"

    def __init__(self, api_key: str = "", *, client: Any = None, timeout_s: float = 60.0):
        self._client = client or anthropic.AsyncAnthropic(api_key=api_key, timeout=timeout_s, max_retries=1)

    @classmethod
    def is_configured(cls, settings: Any) -> bool:
        return settings.has_key("anthropic")

    @classmethod
    def from_settings(cls, settings: Any) -> "AnthropicProvider":
        return cls(settings.anthropic_api_key.get_secret_value(), timeout_s=settings.request_timeout_s)

    def _kwargs(self, req: ProviderRequest) -> dict[str, Any]:
        kw: dict[str, Any] = {
            "model": req.model,
            "max_tokens": req.max_output_tokens,
            "system": req.system,
            "messages": [{"role": m["role"], "content": m["content"]} for m in req.messages],
            "timeout": req.timeout_s,
        }
        if req.tools:
            kw["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.parameters} for t in req.tools
            ]  # kein tool_choice: nur "auto"
        if req.temperature is not None and not rejects_sampling_params(req.model):
            kw["temperature"] = req.temperature
        return kw

    async def stream(self, req: ProviderRequest) -> AsyncIterator[ProviderEvent]:
        kwargs = self._kwargs(req)
        yielded = False
        while True:
            try:
                async with self._client.messages.stream(**kwargs) as stream:
                    async for event in stream:
                        etype = getattr(event, "type", None)
                        if etype == "content_block_delta":
                            delta = event.delta
                            if getattr(delta, "type", None) == "text_delta" and delta.text:
                                yielded = True
                                yield TextDelta(delta.text)
                        elif etype == "message_start":
                            i, o = _usage_tokens(event.message.usage)
                            yielded = True
                            yield UsageEvent(i, o)
                        elif etype == "message_delta":
                            usage = getattr(event, "usage", None)
                            if usage is not None:
                                i, o = _usage_tokens(usage)
                                if o:
                                    yielded = True
                                    yield UsageEvent(i, o)
                    final = await stream.get_final_message()
                break
            except Exception as exc:
                if (
                    not yielded
                    and "temperature" in kwargs
                    and isinstance(exc, anthropic.BadRequestError)
                    and sdk_errors.mentions_temperature(exc)
                ):
                    kwargs.pop("temperature")
                    continue
                raise sdk_errors.map_sdk_error(exc, anthropic) from None

        for block in final.content:
            if getattr(block, "type", None) == "tool_use":
                yield ToolCall(name=block.name, input=dict(block.input or {}), id=getattr(block, "id", None))
        i, o = _usage_tokens(final.usage)
        yield UsageEvent(i, o)
        if final.stop_reason == "refusal":
            raise ProviderRefusal()
        yield StopEvent(final.stop_reason or "end_turn")

    async def list_models(self) -> list[ModelInfo]:
        try:
            out: list[ModelInfo] = []
            async for m in self._client.models.list(limit=100):
                out.append(ModelInfo(id=m.id, display_name=getattr(m, "display_name", None)))
            return out
        except Exception as exc:
            raise sdk_errors.map_sdk_error(exc, anthropic) from None

    async def ping(self) -> str | None:
        try:
            await self._client.models.list(limit=1)
        except Exception as exc:
            raise sdk_errors.map_sdk_error(exc, anthropic) from None
        return None
