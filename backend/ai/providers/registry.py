"""Name -> Provider-Klasse. Neuer Provider = eine Datei + eine Zeile hier."""

from __future__ import annotations

from typing import Any

from .anthropic_provider import AnthropicProvider
from .base_provider import BaseProvider
from .mock_provider import MockProvider
from .openai_provider import OpenAIProvider

PROVIDERS: dict[str, type[BaseProvider]] = {
    "openai": OpenAIProvider,
    "anthropic": AnthropicProvider,
    "mock": MockProvider,
}


def is_configured(name: str, settings: Any) -> bool:
    cls = PROVIDERS.get(name)
    return bool(cls and cls.is_configured(settings))


def create_provider(name: str, settings: Any) -> BaseProvider:
    return PROVIDERS[name].from_settings(settings)
