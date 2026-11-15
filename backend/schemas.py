"""Request-Schemas der API."""

from __future__ import annotations

import re
import unicodedata
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints, field_validator, model_validator

from .services.nutrition_context import NutritionContext


def _clean_multiline(v):
    if isinstance(v, str):
        return "".join(c for c in v if c in "\n\t" or unicodedata.category(c) not in ("Cc", "Cf"))
    return v


Content = Annotated[str, BeforeValidator(_clean_multiline), StringConstraints(min_length=1, max_length=8000)]
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@\-]{0,99}$")


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: Content


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[ChatMessage] = Field(min_length=1, max_length=60)
    context: NutritionContext | None = None
    provider: Literal["openai", "anthropic", "mock"] | None = None
    model: str | None = None
    temperature: float | None = Field(None, ge=0, le=2)
    max_output_tokens: int | None = Field(None, ge=1, le=1_000_000)
    tools_enabled: bool = True

    @field_validator("model")
    @classmethod
    def _model(cls, v):
        if v is None or not v.strip():
            return None
        v = v.strip()
        if not _MODEL_RE.match(v):
            raise ValueError("Ungueltige Modell-ID")
        return v

    @model_validator(mode="after")
    def _last_is_user(self):
        if self.messages[-1].role != "user":
            raise ValueError("Die letzte Nachricht muss vom Nutzer stammen")
        return self


class TestRequest(BaseModel):
    __test__ = False
    model_config = ConfigDict(extra="forbid")
    provider: Literal["openai", "anthropic", "mock"]
