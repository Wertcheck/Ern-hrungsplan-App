"""Abbildung von SDK-Ausnahmen (openai / anthropic) auf ProviderError. Kein Provider-Import."""

from __future__ import annotations

import asyncio
from types import ModuleType

from ...security import redact
from .base_provider import (
    AuthError,
    BadRequestError,
    ProviderError,
    ProviderTimeout,
    ProviderUnavailable,
    RateLimitError,
)


def exc_message(exc: BaseException, limit: int = 200) -> str:
    raw = getattr(exc, "message", None) or str(exc)
    return redact(raw)[:limit]


def map_sdk_error(exc: BaseException, sdk: ModuleType) -> ProviderError:
    if isinstance(exc, ProviderError):
        return exc
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return ProviderTimeout()
    if isinstance(exc, sdk.APITimeoutError):  # Unterklasse von APIConnectionError -> zuerst pruefen
        return ProviderTimeout()
    if isinstance(exc, sdk.APIConnectionError):
        return ProviderUnavailable("Verbindung zum KI-Anbieter fehlgeschlagen.")
    if isinstance(exc, (sdk.AuthenticationError, sdk.PermissionDeniedError)):
        return AuthError()
    if isinstance(exc, sdk.RateLimitError):
        if "insufficient_quota" in str(exc).lower() or "billing" in str(exc).lower():
            return RateLimitError("Kontingent/Guthaben beim KI-Anbieter erschoepft.", retryable=False)
        return RateLimitError()
    if isinstance(exc, (sdk.BadRequestError, sdk.NotFoundError, sdk.UnprocessableEntityError)):
        return BadRequestError(f"Anfrage abgelehnt: {exc_message(exc)}")
    if isinstance(exc, sdk.APIStatusError):
        status = getattr(exc, "status_code", 0) or 0
        if status == 408:
            return ProviderTimeout()
        if status >= 500:
            return ProviderUnavailable()
        return BadRequestError(f"Anfrage abgelehnt (HTTP {status}).")
    return ProviderError("Unerwarteter Fehler beim KI-Anbieter.", code="provider_error", retryable=False)


def mentions_temperature(exc: BaseException) -> bool:
    return "temperature" in (getattr(exc, "message", None) or str(exc)).lower()
