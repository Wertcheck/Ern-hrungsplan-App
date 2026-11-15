"""Provider-neutrales Interface, Ereignisse und Fehlerklassen."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, ClassVar


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class ProviderRequest:
    model: str
    system: str
    messages: list[dict[str, str]]
    tools: list[ToolSpec] = field(default_factory=list)
    max_output_tokens: int = 1024
    temperature: float | None = None
    timeout_s: float = 60.0


@dataclass
class TextDelta:
    text: str


@dataclass
class ToolCall:
    name: str
    input: dict[str, Any]
    id: str | None = None


@dataclass
class UsageEvent:
    """Kumulative Token-Zahlen (der zuletzt gelieferte Wert gilt)."""

    input_tokens: int
    output_tokens: int


@dataclass
class StopEvent:
    reason: str


ProviderEvent = TextDelta | ToolCall | UsageEvent | StopEvent


@dataclass
class ModelInfo:
    id: str
    display_name: str | None = None


class ProviderError(Exception):
    code: str = "provider_error"

    def __init__(self, message: str, *, code: str | None = None, retryable: bool = False):
        super().__init__(message)
        if code:
            self.code = code
        self.message = message
        self.retryable = retryable


class AuthError(ProviderError):
    code = "provider_auth_error"

    def __init__(self, message: str = "Authentifizierung beim KI-Anbieter fehlgeschlagen (Schluessel pruefen).", **kw):
        super().__init__(message, retryable=False, **kw)


class RateLimitError(ProviderError):
    code = "provider_rate_limited"

    def __init__(self, message: str = "Das Anfragelimit des KI-Anbieters ist erreicht. Bitte spaeter erneut versuchen.", *, retryable: bool = True, **kw):
        super().__init__(message, retryable=retryable, **kw)


class ProviderUnavailable(ProviderError):
    code = "provider_unavailable"

    def __init__(self, message: str = "Der KI-Anbieter ist voruebergehend nicht erreichbar.", **kw):
        super().__init__(message, retryable=True, **kw)


class ProviderTimeout(ProviderError):
    code = "provider_timeout"

    def __init__(self, message: str = "Zeitueberschreitung bei der Anfrage an den KI-Anbieter.", **kw):
        super().__init__(message, retryable=True, **kw)


class BadRequestError(ProviderError):
    code = "provider_bad_request"

    def __init__(self, message: str = "Der KI-Anbieter hat die Anfrage abgelehnt.", **kw):
        super().__init__(message, retryable=False, **kw)


class ProviderRefusal(ProviderError):
    code = "provider_refusal"

    def __init__(self, message: str = "Der KI-Anbieter hat die Antwort aus Sicherheitsgruenden verweigert.", **kw):
        super().__init__(message, retryable=False, **kw)


class BaseProvider(ABC):
    name: ClassVar[str]

    @classmethod
    @abstractmethod
    def is_configured(cls, settings: Any) -> bool: ...

    @classmethod
    @abstractmethod
    def from_settings(cls, settings: Any) -> "BaseProvider": ...

    @abstractmethod
    def stream(self, request: ProviderRequest) -> AsyncIterator[ProviderEvent]:
        """Async-Generator: liefert Ereignisse; schliesst bei aclose() den SDK-Stream."""

    @abstractmethod
    async def list_models(self) -> list[ModelInfo]: ...

    @abstractmethod
    async def ping(self) -> str | None:
        """Verbindungstest ohne Token-Verbrauch (models.list). Liefert optional Detailtext."""
