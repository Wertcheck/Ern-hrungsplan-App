"""Deterministischer Mock-Provider (nur bei enable_mock_provider=true). Kein Netzwerk."""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from typing import Any

from .base_provider import (
    BaseProvider,
    ModelInfo,
    ProviderEvent,
    ProviderRequest,
    ProviderUnavailable,
    StopEvent,
    TextDelta,
    ToolCall,
    UsageEvent,
)

_MEAL = re.compile(r"date=(\S+)\s*\|\s*meal_id=(\S+)\s*\|[^|\n]*\|\s*recipe_id=(\S+)")
_RECIPE = re.compile(r"^- recipe_id=(\S+)", re.M)


class MockProvider(BaseProvider):
    name = "mock"

    def __init__(self, slow_s: float = 30.0):
        self._slow_s = slow_s

    @classmethod
    def is_configured(cls, settings: Any) -> bool:
        return bool(settings.enable_mock_provider)

    @classmethod
    def from_settings(cls, settings: Any) -> "MockProvider":
        return cls()

    async def stream(self, req: ProviderRequest) -> AsyncIterator[ProviderEvent]:
        last = next((m["content"] for m in reversed(req.messages) if m["role"] == "user"), "").lower()
        if "fehler" in last:
            raise ProviderUnavailable("Mock: simulierter Fehler.")
        in_tokens = (len(req.system) + sum(len(m["content"]) for m in req.messages)) // 4 + 1
        yield UsageEvent(in_tokens, 0)

        call: ToolCall | None = None
        if "tausch" in last and req.tools:
            meal = _MEAL.search(req.system)
            current = meal.group(3) if meal else None
            alt = next((r for r in _RECIPE.findall(req.system) if r != current), None)
            if meal and alt:
                call = ToolCall(
                    name="propose_actions",
                    input={"proposals": [{"type": "swap_meal", "date": meal.group(1), "meal_id": meal.group(2),
                                          "recipe_id": alt, "reason": "Mock-Vorschlag"}]},
                    id="mock-call-1",
                )
        text = "Ich schlage einen Tausch vor. " if call else "Das ist eine Mock-Antwort. "
        out_chars = 0
        for word in text.split(" "):
            if not word:
                continue
            out_chars += len(word) + 1
            yield TextDelta(word + " ")
            await asyncio.sleep(0)
        if "langsam" in last:
            await asyncio.sleep(self._slow_s)
        if call:
            yield call
        yield UsageEvent(in_tokens, out_chars // 4 + 1)
        yield StopEvent("tool_use" if call else "end_turn")

    async def list_models(self) -> list[ModelInfo]:
        return [ModelInfo(id="mock-1", display_name="Mock")]

    async def ping(self) -> str | None:
        return "Mock-Provider aktiv"
